// Launch watcher: before $GLOW exists the board is read-only. Given the dev wallet (DEV_WALLET), the server watches its
// transactions and, the moment it creates a token on pump.fun, takes that token as $GLOW and opens the board.
// The mint is saved next to the board state, so a restart keeps it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address } from '@solana/kit';
import { config } from '../config.js';
import { rpc, rpcSubscriptions, sleep } from './solana.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATE_LOG = /^Program log: Instruction: Create(V\d+)?$/;
const keyOf = (k) => (typeof k === 'string' ? k : k.pubkey);

// A pump.fun "create" signed by the dev wallet: returns the new mint, or null. Takes a jsonParsed transaction.
export function findLaunchedMint(tx, dev) {
  if (!tx || tx.meta?.err) return null;
  const msg = tx.transaction.message;
  const signers = msg.accountKeys.filter((k) => typeof k !== 'string' && k.signer).map(keyOf);
  if (!signers.includes(dev)) return null;
  const logs = tx.meta?.logMessages || [];
  if (!logs.some((l) => l.startsWith(`Program ${PUMP_PROGRAM} invoke`))) return null;
  if (!logs.some((l) => CREATE_LOG.test(l))) return null; // Create, CreateV2, … — not a buy or a sell
  const all = [...msg.instructions, ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions)];
  for (const ix of all) {
    if (ix.parsed && /^initializeMint2?$/.test(ix.parsed.type) && ix.parsed.info?.mint) return ix.parsed.info.mint;
  }
  return null;
}

// Two ways to see the launch, so a burst of transactions from the launch tool can never hide it
// (J7 sent ~600 from the dev wallet within 8 s of the create):
//  - live: a log subscription delivers every transaction that mentions the dev wallet as it confirms;
//  - scan: every few seconds, all signatures since the newest one already seen (paged, no size limit),
//    read oldest first, so the create, which comes before the burst, is found first.
export class LaunchWatcher {
  constructor(onLaunch) {
    this.file = join(config.DATA_DIR, 'launch.json');
    this.onLaunch = onLaunch;
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    // Only launches after the watch began count, so an old token in the dev wallet's history is never picked up.
    if (this.state.watchFrom == null) this.state.watchFrom = Math.floor(Date.now() / 1000) - 600;
    if (this.state.wallet !== config.DEV_WALLET) { // a new dev wallet starts fresh: new window, nothing seen yet
      this.state = { watchFrom: Math.floor(Date.now() / 1000) - 600, wallet: config.DEV_WALLET, newest: null };
    }
    this.seen = new Set();
    this.abort = new AbortController();
    this.status = { lastCheck: null, lastError: null, checks: 0, live: false, scanned: 0 }; // shown in /api/stats
  }

  save() { writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }

  // The token chosen at launch, if any (an explicit GLOW_MINT always wins).
  get mint() { return this.state.mint || null; }
  launched() { return !!(this.state.mint || config.GLOW_MINT); }

  async start() {
    if (this.launched() || !config.DEV_WALLET) return;
    this.save();
    console.log(`[launch] watching ${config.DEV_WALLET} for a pump.fun launch`);
    this.listen();
    while (!this.launched()) {
      try { await this.check(); this.status.lastCheck = new Date().toISOString(); this.status.checks++; this.status.lastError = null; }
      catch (e) { this.status.lastError = e.message.slice(0, 160); console.warn('[launch] check failed:', e.message); }
      await sleep(config.LAUNCH_POLL_MS);
    }
  }

  async listen() {
    while (!this.launched()) {
      try {
        const notes = await rpcSubscriptions.logsNotifications({ mentions: [address(config.DEV_WALLET)] }, { commitment: 'confirmed' })
          .subscribe({ abortSignal: this.abort.signal });
        this.status.live = true;
        for await (const n of notes) {
          const v = n.value, logs = v.logs || [];
          if (v.err || !logs.some((l) => l.startsWith(`Program ${PUMP_PROGRAM} invoke`)) || !logs.some((l) => CREATE_LOG.test(l))) continue;
          await this.inspect(v.signature, 'live').catch((e) => console.warn('[launch] live inspect failed:', e.message));
          if (this.launched()) return;
        }
      } catch (e) { if (this.abort.signal.aborted) return; console.warn('[launch] log subscription dropped:', e.message); }
      this.status.live = false;
      await sleep(2000);
    }
  }

  // Fetch one transaction and launch if it is the dev wallet's pump.fun create.
  async inspect(signature, via) {
    if (this.seen.has(signature) || this.launched()) return;
    let tx = null;
    for (let k = 0; k < 6 && !tx; k++) {
      // version 1 transactions are live on mainnet; asking for at most 0 makes the RPC refuse them
      tx = await rpc.getTransaction(signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).send();
      if (!tx) await sleep(400);
    }
    if (!tx) return; // not visible yet; the scan will come back to it
    this.seen.add(signature);
    const mint = findLaunchedMint(tx, config.DEV_WALLET);
    if (!mint || this.launched()) return;
    this.state = { ...this.state, mint, sig: signature, via, at: new Date().toISOString() };
    this.save();
    this.abort.abort();
    console.log(`[launch] a/place launched: ${mint} (${signature}, seen by ${via})`);
    this.onLaunch(mint);
  }

  async check() {
    const dev = address(config.DEV_WALLET), newest = this.state.newest;
    let all = [], before;
    for (let page = 0; page < 50; page++) {
      const opts = { limit: newest ? 1000 : 50, commitment: 'confirmed' };
      if (newest) opts.until = newest;
      if (before) opts.before = before;
      const sigs = await rpc.getSignaturesForAddress(dev, opts).send();
      all = all.concat(sigs);
      if (!newest || sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    for (const s of [...all].reverse()) { // oldest first
      if (this.launched()) return;
      if (s.err || (s.blockTime && Number(s.blockTime) < this.state.watchFrom)) continue;
      try { await this.inspect(s.signature, 'scan'); }
      catch (e) {
        if (e?.context?.statusCode === 429 || /429|too many/i.test(e.message || '')) throw e; // rate limited: retry this batch later
        this.seen.add(s.signature); // unreadable for another reason: skip it rather than stall the scan
        console.warn('[launch] skipped', s.signature, e.message);
      }
      this.status.scanned++;
    }
    if (all.length) { this.state.newest = all[0].signature; this.save(); } // only once everything up to it was read
  }
}
