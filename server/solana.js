// Everything that talks to Solana: keys, RPC, blockhash, holder checks, sending and confirming.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  address, appendTransactionMessageInstructions, createKeyPairFromBytes, createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair, createSolanaRpc, createSolanaRpcSubscriptions, createTransactionMessage, getAddressFromPublicKey,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import { config } from '../config.js';

export const rpc = createSolanaRpc(config.RPC_URL);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- keys (solana-keygen JSON format: 64 bytes, secret seed + public key) ----
// On a host without our key files (Railway) the key comes from an env var: RELAYER_KEY, POOL_KEY, …
// holding the same 64-number JSON array as the key file.
export async function loadOrCreateKey(name) {
  const fromEnv = process.env[`${name.toUpperCase().replace(/-/g, '_')}_KEY`];
  if (fromEnv) {
    const keyPair = await createKeyPairFromBytes(new Uint8Array(JSON.parse(fromEnv)));
    const signer = await createSignerFromKeyPair(keyPair);
    return { keyPair, signer, address: signer.address };
  }
  mkdirSync(config.KEYS_DIR, { recursive: true });
  const file = join(config.KEYS_DIR, `${name}.json`);
  if (!existsSync(file)) {
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
export const chain = { blockhash: null, lastValidBlockHeight: 0 };
export async function refreshBlockhash() {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  chain.blockhash = value.blockhash;
  chain.lastValidBlockHeight = Number(value.lastValidBlockHeight);
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

// ---- sending and confirming ----
export async function sendWire(base64Wire) {
  return rpc.sendTransaction(base64Wire, { encoding: 'base64', skipPreflight: true, maxRetries: 3n }).send();
}

// Confirmation: a WebSocket signature subscription per transaction (fast, cheap on rate limits),
// with one batched status poll as a safety net that backs off when the RPC says 429.
export const rpcSubscriptions = createSolanaRpcSubscriptions(config.RPC_WS_URL);
const pending = new Map(); // signature -> { resolve, t0, timeoutMs }
export function waitForConfirmation(signature, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const abort = new AbortController();
    const keepAlive = setTimeout(() => {}, timeoutMs + 5000); // holds the process open while we wait
    const done = (r) => { if (!pending.has(signature)) return; pending.delete(signature); clearTimeout(keepAlive); abort.abort(); resolve(r); };
    pending.set(signature, { resolve: done, t0: Date.now(), timeoutMs });
    (async () => {
      try {
        const notes = await rpcSubscriptions.signatureNotifications(signature, { commitment: 'confirmed' }).subscribe({ abortSignal: abort.signal });
        for await (const n of notes) { done(n.value.err ? { ok: false, err: n.value.err } : { ok: true, slot: Number(n.context.slot) }); break; }
      } catch (e) { if (!abort.signal.aborted) console.warn('[confirm] subscription failed, polling instead:', e.message); }
    })();
  });
}
// One batched request for everything pending, every 400 ms while anything is pending (≈2.5 req/s at most).
const POLL_MS = 400;
let pollDelay = POLL_MS;
async function pollStatuses() {
  const sigs = [...pending.keys()].filter((s) => Date.now() - pending.get(s).t0 > 300).slice(0, 256);
  if (sigs.length) {
    try {
      const { value } = await rpc.getSignatureStatuses(sigs).send();
      value.forEach((st, k) => {
        const p = pending.get(sigs[k]);
        if (!p) return;
        if (st && st.err) p.resolve({ ok: false, err: st.err });
        else if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) p.resolve({ ok: true, slot: Number(st.slot) });
      });
      pollDelay = POLL_MS;
    } catch (e) { pollDelay = Math.min(8000, pollDelay * 2); if (!/429/.test(e.message)) console.warn('[confirm] status poll failed:', e.message); }
  }
  for (const [, p] of pending) if (Date.now() - p.t0 > p.timeoutMs) p.resolve({ ok: false, err: 'timeout' });
  setTimeout(pollStatuses, pollDelay).unref(); // never keeps a script alive on its own
}
pollStatuses();

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
