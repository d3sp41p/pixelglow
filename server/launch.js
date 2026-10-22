// Launch watcher: before $GLOW exists the board is read-only. Given the dev wallet (DEV_WALLET), the server watches its
// transactions and, the moment it creates a token on pump.fun, takes that token as $GLOW and opens the board.
// The mint is saved next to the board state, so a restart keeps it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address } from '@solana/kit';
import { config } from '../config.js';
import { rpc, sleep } from './solana.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const keyOf = (k) => (typeof k === 'string' ? k : k.pubkey);

// A pump.fun "create" signed by the dev wallet: returns the new mint, or null. Takes a jsonParsed transaction.
export function findLaunchedMint(tx, dev) {
  if (!tx || tx.meta?.err) return null;
  const msg = tx.transaction.message;
  const signers = msg.accountKeys.filter((k) => typeof k !== 'string' && k.signer).map(keyOf);
  if (!signers.includes(dev)) return null;
  const logs = tx.meta?.logMessages || [];
  if (!logs.some((l) => l.startsWith(`Program ${PUMP_PROGRAM} invoke`))) return null;
  if (!logs.some((l) => /^Program log: Instruction: Create(V\d+)?$/.test(l))) return null; // Create, CreateV2, … — not a buy or a sell
  const all = [...msg.instructions, ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions)];
  for (const ix of all) {
    if (ix.parsed && /^initializeMint2?$/.test(ix.parsed.type) && ix.parsed.info?.mint) return ix.parsed.info.mint;
  }
  return null;
}

export class LaunchWatcher {
  constructor(onLaunch) {
    this.file = join(config.DATA_DIR, 'launch.json');
    this.onLaunch = onLaunch;
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    // Only launches after the watch began count, so an old token in the dev wallet's history is never picked up.
    if (this.state.watchFrom == null) this.state.watchFrom = Math.floor(Date.now() / 1000) - 600;
    this.seen = new Set();
    this.status = { lastCheck: null, lastError: null, checks: 0 }; // shown in /api/stats
  }

  save() { writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }

  // The token chosen at launch, if any (an explicit GLOW_MINT always wins).
  get mint() { return this.state.mint || null; }

  async start() {
    if (config.GLOW_MINT || this.state.mint || !config.DEV_WALLET) return;
    this.save();
    console.log(`[launch] watching ${config.DEV_WALLET} for a pump.fun launch`);
    while (!this.state.mint && !config.GLOW_MINT) {
      await sleep(config.LAUNCH_POLL_MS);
      try { await this.check(); this.status.lastCheck = new Date().toISOString(); this.status.checks++; this.status.lastError = null; }
      catch (e) { this.status.lastError = e.message.slice(0, 160); console.warn('[launch] check failed:', e.message); }
    }
  }

  async check() {
    const sigs = await rpc.getSignaturesForAddress(address(config.DEV_WALLET), { limit: 25, commitment: 'confirmed' }).send();
    for (const s of [...sigs].reverse()) { // oldest first
      if (this.seen.has(s.signature)) continue;
      this.seen.add(s.signature);
      if (s.err || (s.blockTime && Number(s.blockTime) < this.state.watchFrom)) continue;
      const tx = await rpc.getTransaction(s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).send();
      const mint = findLaunchedMint(tx, config.DEV_WALLET);
      if (mint) {
        this.state = { ...this.state, mint, sig: s.signature, at: new Date().toISOString() };
        this.save();
        console.log(`[launch] a/place launched: ${mint} (${s.signature})`);
        this.onLaunch(mint);
        return;
      }
    }
  }
}
