// Everything that talks to Solana: keys, RPC, blockhash, holder checks, sending and confirming.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  address, appendTransactionMessageInstructions, createKeyPairFromBytes, createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair, createSolanaRpc, createSolanaRpcSubscriptions, createTransactionMessage, getAddressFromPublicKey,
  getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import { config } from '../config.js';

export const rpc = createSolanaRpc(config.RPC_URL);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- keys (solana-keygen JSON format: 64 bytes, secret seed + public key) ----
// On a host without our key files (Render) the key comes from an env var: RELAYER_KEY, POOL_KEY, …
// holding either the 64-number JSON array of a key file or the base58 private key Phantom exports.
const keyBytes = (text) => {
  const t = text.trim();
  const bytes = t.startsWith('[') ? new Uint8Array(JSON.parse(t)) : new Uint8Array(getBase58Encoder().encode(t));
  if (bytes.length !== 64) throw new Error(`a private key must be 64 bytes, got ${bytes.length}`);
  return bytes;
};
export async function loadOrCreateKey(name) {
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_KEY`, fromEnv = process.env[envName];
  if (fromEnv) {
    let keyPair;
    try { keyPair = await createKeyPairFromBytes(keyBytes(fromEnv)); }
    catch (e) { throw new Error(`${envName} is not a valid Solana private key (${e.message})`); }
    const signer = await createSignerFromKeyPair(keyPair);
    return { keyPair, signer, address: signer.address };
  }
  const file = join(config.KEYS_DIR, `${name}.json`);
  if (!existsSync(file) && config.CLUSTER !== 'devnet') {
    // never invent a money key on a real network: its owner must create it and hand it over
    throw new Error(`${envName} is not set. On ${config.CLUSTER} the ${name} wallet must be created by its owner and its private key put in ${envName}.`);
  }
  if (!existsSync(file)) {
    mkdirSync(config.KEYS_DIR, { recursive: true });
    const seed = webcrypto.getRandomValues(new Uint8Array(32));
    const kp = await createKeyPairFromPrivateKeyBytes(seed, true);
    const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
    writeFileSync(file, JSON.stringify([...seed, ...pub]));
  }
  const keyPair = await createKeyPairFromBytes(new Uint8Array(JSON.parse(readFileSync(file, 'utf8'))));
  const signer = await createSignerFromKeyPair(keyPair);
  return { keyPair, signer, address: signer.address };
}

export const addressOf = (publicKey) => getAddressFromPublicKey(publicKey);

// ---- blockhash: refreshed in the background so every click can be built instantly ----
export const chain = { blockhash: null, lastValidBlockHeight: 0, cuPrice: config.MIN_PRIORITY_MICROLAMPORTS };
export async function refreshBlockhash() {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  chain.blockhash = value.blockhash;
  chain.lastValidBlockHeight = Number(value.lastValidBlockHeight);
  // Priority price: 75th percentile of what recent blocks charged, kept within our bounds.
  try {
    const fees = (await rpc.getRecentPrioritizationFees().send()).map((f) => Number(f.prioritizationFee)).sort((x, y) => x - y);
    const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
    chain.cuPrice = Math.min(config.MAX_PRIORITY_MICROLAMPORTS, Math.max(config.MIN_PRIORITY_MICROLAMPORTS, p75));
  } catch {}
  return chain;
}

// ---- $GLOW holdings, cached briefly ----
const holdCache = new Map(); // wallet -> { amount, t }
let mintDecimals = null;
export async function glowBalance(wallet, maxAgeMs = 30_000) {
  if (!config.GLOW_MINT) return 0;
  const hit = holdCache.get(wallet);
  if (hit && Date.now() - hit.t < maxAgeMs) return hit.amount;
  if (config.NATIVE_GATE()) {
    let amount;
    try { amount = Number((await rpc.getBalance(address(wallet), { commitment: 'confirmed' }).send()).value) / 1e9; }
    catch (e) { if (hit && Date.now() - hit.t < 10 * 60_000) return hit.amount; throw e; }
    holdCache.set(wallet, { amount, t: Date.now() });
    return amount;
  }
  let value;
  try {
    ({ value } = await rpc.getTokenAccountsByOwner(address(wallet), { mint: address(config.GLOW_MINT) }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send());
  } catch (e) {
    if (hit && Date.now() - hit.t < 10 * 60_000) return hit.amount; // RPC busy: a recent answer is good enough
    throw e;
  }
  let raw = 0n, decimals = mintDecimals ?? 0;
  for (const acc of value) {
    const amt = acc.account.data.parsed.info.tokenAmount;
    raw += BigInt(amt.amount); decimals = amt.decimals; mintDecimals = decimals;
  }
  const amount = Number(raw) / 10 ** decimals;
  holdCache.set(wallet, { amount, t: Date.now() });
  return amount;
}
export const isHolder = async (wallet, maxAgeMs) => config.MIN_HOLD <= 0 || (await glowBalance(wallet, maxAgeMs)) >= config.MIN_HOLD;
// For clicks: a balance seen in the last 10 minutes answers at once, and a fresh one is fetched in the background.
const refreshing = new Set();
export async function isHolderFast(wallet) {
  if (config.MIN_HOLD <= 0) return true;
  const hit = holdCache.get(wallet);
  if (!hit || Date.now() - hit.t > 10 * 60_000) return isHolder(wallet);
  if (Date.now() - hit.t > 30_000 && !refreshing.has(wallet)) {
    refreshing.add(wallet);
    glowBalance(wallet, 0).catch(() => {}).finally(() => refreshing.delete(wallet));
  }
  return hit.amount >= config.MIN_HOLD;
}

// ---- sending and confirming ----
// Dispatcher: every endpoint has its own send rate (free plans allow ~1 sendTransaction a second). Each send goes to an
// endpoint with room left, round-robin; when all are full it waits for the first free slot instead of being refused.
// A rate-limit answer puts that endpoint on a 1 s cool-down and the send moves to the next one.
const hostOf = (u) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return 'rpc'; } };
const endpoints = [
  { url: config.RPC_URL, rpc, rps: config.SEND_RPS },
  ...config.SEND_RPC_URLS.map(({ url, rps }) => ({ url, rpc: createSolanaRpc(url), rps })),
].map((e, k) => ({ ...e, cur: e.rps, name: `${k}:${hostOf(e.url)}`, tokens: 1, at: Date.now(), coolUntil: 0 }));
// Counters for /api/stats, so slow clicks can be traced to the endpoint that refused them.
export const diag = { send: endpoints.map((e) => ({ endpoint: e.name, rps: e.rps, now: e.rps, ok: 0, limited: 0, failed: 0 })), queuedMs: 0, poll429: 0, pollFailed: 0, wsFailed: 0, lastErrors: [] };
const noteErr = (where, e) => { const m = `${where}: ${(e.context?.__code ?? '')} ${e.message}`.slice(0, 220); if (!diag.lastErrors.includes(m)) { diag.lastErrors.unshift(m); diag.lastErrors.length = Math.min(diag.lastErrors.length, 6); } };
const refill = (e, now) => { e.tokens = Math.min(Math.max(1, e.cur), e.tokens + ((now - e.at) / 1000) * e.cur); e.at = now; };
let rr = 0;
function takeSlot(avoid) {
  const now = Date.now();
  for (let k = 0; k < endpoints.length; k++) {
    const i = (rr + k) % endpoints.length, e = endpoints[i];
    refill(e, now);
    if (e.name === avoid && endpoints.length > 1) continue;
    if (now >= e.coolUntil && e.tokens >= 1) { e.tokens -= 1; rr = i + 1; return i; }
  }
  return -1;
}
// Minified builds of the SDK hide the text, so look at the HTTP status too.
const isRateLimit = (e) => e?.context?.statusCode === 429 || /429|rate.?limit|too many/i.test(e?.message || '');
// Returns the endpoint name that accepted the transaction.
export async function sendWire(base64Wire, avoid = null) {
  const t0 = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < endpoints.length + 2; attempt++) {
    let i;
    while ((i = takeSlot(avoid)) < 0) {
      if (Date.now() - t0 > 4000) throw lastErr || new Error('all RPC endpoints are at their send limit');
      await sleep(25);
    }
    diag.queuedMs = Math.max(diag.queuedMs * 0.9, Date.now() - t0); // decaying peak of time spent waiting for a slot
    const e = endpoints[i], d = diag.send[i];
    try {
      await e.rpc.sendTransaction(base64Wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
      d.ok++;
      e.cur = Math.min(e.rps, e.cur + 0.05 * e.rps); d.now = +e.cur.toFixed(2); // creep back up to the configured rate
      return e.name;
    } catch (err) {
      // Any refusal: rest this endpoint for a second and hand the transaction to the next one.
      lastErr = err; noteErr(e.name, err);
      if (isRateLimit(err)) { d.limited++; e.cur = Math.max(0.25, e.cur / 2); d.now = +e.cur.toFixed(2); } else d.failed++;
      e.coolUntil = Date.now() + 1000; e.tokens = 0; avoid = e.name;
    }
  }
  throw lastErr;
}

// Waiting for a transaction: a WebSocket signature subscription (fast, cheap on rate limits), with one batched
// status poll as a safety net that backs off when the RPC says 429. 'processed' = it is in a block,
// 'confirmed' = a supermajority voted for that block.
export const rpcSubscriptions = createSolanaRpcSubscriptions(config.RPC_WS_URL);
const RANK = { processed: 1, confirmed: 2, finalized: 3 };
const pending = new Map(); // key "sig|commitment" -> { sig, rank, resolve, t0, timeoutMs }
export function waitForConfirmation(signature, timeoutMs = 60_000, commitment = 'confirmed') {
  const key = signature + '|' + commitment;
  return new Promise((resolve) => {
    const abort = new AbortController();
    const keepAlive = setTimeout(() => {}, timeoutMs + 5000); // holds the process open while we wait
    const done = (r) => { if (!pending.has(key)) return; pending.delete(key); clearTimeout(keepAlive); abort.abort(); resolve(r); };
    pending.set(key, { sig: signature, rank: RANK[commitment], resolve: done, t0: Date.now(), timeoutMs });
    (async () => {
      try {
        const notes = await rpcSubscriptions.signatureNotifications(signature, { commitment }).subscribe({ abortSignal: abort.signal });
        for await (const n of notes) { done(n.value.err ? { ok: false, err: n.value.err } : { ok: true, slot: Number(n.context.slot) }); break; }
      } catch (e) { if (!abort.signal.aborted) { diag.wsFailed++; console.warn('[confirm] subscription failed, polling instead:', e.message); } }
    })();
  });
}
// One batched request for everything pending, every 400 ms while anything is pending (≈2.5 req/s at most).
const POLL_MS = 400;
let pollDelay = POLL_MS;
async function pollStatuses() {
  const waiting = [...pending.values()].filter((p) => Date.now() - p.t0 > 300);
  const sigs = [...new Set(waiting.map((p) => p.sig))].slice(0, 256);
  if (sigs.length) {
    try {
      const { value } = await rpc.getSignatureStatuses(sigs).send();
      const bySig = new Map(sigs.map((s, k) => [s, value[k]]));
      for (const p of waiting) {
        const st = bySig.get(p.sig);
        if (!st) continue;
        if (st.err) p.resolve({ ok: false, err: st.err });
        else if ((RANK[st.confirmationStatus] || 0) >= p.rank) p.resolve({ ok: true, slot: Number(st.slot) });
      }
      pollDelay = POLL_MS;
    } catch (e) {
      pollDelay = Math.min(1600, pollDelay * 2); // back off, but never so far that a click waits seconds for its answer
      if (/429/.test(e.message)) diag.poll429++; else { diag.pollFailed++; console.warn('[confirm] status poll failed:', e.message); }
    }
  }
  for (const [, p] of pending) if (Date.now() - p.t0 > p.timeoutMs) p.resolve({ ok: false, err: 'timeout' });
  setTimeout(pollStatuses, pollDelay).unref(); // never keeps a script alive on its own
}
pollStatuses();

// The current slot, from one subscription: lets each claim report how many slots it took to land.
export const slotNow = { slot: 0, at: 0 };
(async function trackSlots() {
  try {
    const notes = await rpcSubscriptions.slotNotifications().subscribe({ abortSignal: new AbortController().signal });
    for await (const n of notes) { slotNow.slot = Number(n.slot); slotNow.at = Date.now(); }
  } catch (e) { console.warn('[slots] subscription ended:', e.message); }
  setTimeout(trackSlots, 3000).unref();
})();

// Build, sign with the given signers, send and wait. Used for payouts and setup scripts.
export async function sendInstructions(feePayer, instructions) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await sendWire(getBase64EncodedWireTransaction(tx));
  const res = await waitForConfirmation(sig, 90_000);
  if (!res.ok) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.err, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return sig;
}

export async function solBalance(addr) {
  const { value } = await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send();
  return Number(value);
}

export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}${config.CLUSTER === 'mainnet-beta' ? '' : `?cluster=${config.CLUSTER}`}`;
