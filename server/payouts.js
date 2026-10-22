// Epoch payouts (spec §2). All creator fees land in the pool wallet and belong to holders.
// The pool is not emptied at once: every EPOCH_SEC it pays out DRIP_RATE of what it holds, split by
// time-weighted live pixels, so rewards keep flowing evenly between busy and quiet trading.
// Optional: HOLDER_SHARE < 1 forwards that cut of each new inflow to TREASURY_ADDRESS first.
import { address, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { config } from '../config.js';
import { glowBalance, rpc, sendInstructions, solBalance } from './solana.js';

const RENT_EXEMPT_MIN = 890_880;   // a brand-new system account must receive at least this much
const TRANSFERS_PER_TX = 18;       // stays well under the 1232-byte transaction limit

// The reward pool is everything in the pool wallet except its own reserve and dust already owed to wallets.
export const rewardPoolOf = (bal, accrued) =>
  Math.max(0, bal - config.POOL_RESERVE_LAMPORTS - Object.values(accrued).reduce((a, b) => a + b, 0));

// Pure epoch maths: who gets what this epoch, and what stays owed. Lamports are integers throughout.
export function planEpoch({ rewardPool, dripRate, twa, accrued, existing, dust = config.DUST_LAMPORTS }) {
  const budget = Math.floor(rewardPool * dripRate);
  const sum = Object.values(twa).reduce((a, b) => a + b, 0);
  const nextAccrued = { ...accrued }, pay = [];
  if (sum === 0 || budget === 0) return { budget, pay, nextAccrued };
  for (const [w, v] of Object.entries(twa)) {
    const amt = Math.floor(budget * v / sum) + (accrued[w] || 0);
    if (amt < dust || (!existing.has(w) && amt < RENT_EXEMPT_MIN)) { nextAccrued[w] = amt; continue; }
    pay.push([w, amt]); delete nextAccrued[w];
  }
  return { budget, pay, nextAccrued };
}

export class Payouts {
  constructor(pool, board, state = {}, gasPayer = pool) {
    this.pool = pool; this.board = board; this.gasPayer = gasPayer;
    this.epoch = state.epoch ?? 1;
    this.epochEnd = state.epochEnd ?? Date.now() / 1000 + config.EPOCH_SEC;
    this.lastPoolBalance = state.lastPoolBalance ?? null; // balance after the previous epoch, to see new inflows
    this.accrued = state.accrued ?? {};                    // wallet -> lamports below the dust threshold (§2.6)
    this.totalPaid = state.totalPaid ?? 0;
    this.totalIn = state.totalIn ?? 0;                     // all fees that ever arrived
    this.history = state.history ?? [];                    // last epochs, newest first
    this.paidTo = state.paidTo ?? {};                      // wallet -> [{ epoch, lamports, sig }]
    this.running = false;
  }

  toJSON() {
    const { epoch, epochEnd, lastPoolBalance, accrued, totalPaid, totalIn, history, paidTo } = this;
    return { epoch, epochEnd, lastPoolBalance, accrued, totalPaid, totalIn, history, paidTo };
  }

  // pool: the whole reward pool now; next: what the coming payout will distribute.
  async currentPool() {
    const bal = await solBalance(this.pool.address);
    if (this.lastPoolBalance === null) this.lastPoolBalance = bal;
    const pool = rewardPoolOf(bal, this.accrued);
    return { bal, pool, next: Math.floor(pool * config.DRIP_RATE) };
  }

  // Estimated payout for one wallet if the epoch closed now.
  async estimate(wallet) {
    const { pool, next } = await this.currentPool().catch(() => ({ pool: 0, next: 0 }));
    const { mine, total } = this.board.twaSoFar(wallet);
    const share = total > 0 ? mine / total : 0;
    return { pool, share, lamports: Math.floor(next * share) + (this.accrued[wallet] || 0) };
  }

  async send(transfers) { // [[destination, lamports]] from the pool, gas paid by the relayer
    return sendInstructions(this.gasPayer.signer, transfers.map(([w, amt]) =>
      getTransferSolInstruction({ source: this.pool.signer, destination: address(w), amount: lamports(BigInt(amt)) })));
  }

  async run(onDone) {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    const report = { epoch, t: Math.floor(Date.now() / 1000), pool: 0, budget: 0, holders: 0, paid: 0, treasury: 0, inflow: 0, sigs: [], payouts: [] };
    try {
      const twaAll = this.board.closeEpoch();              // { wallet: avg live pixels over the epoch }
      let bal = await solBalance(this.pool.address);
      if (this.lastPoolBalance === null) this.lastPoolBalance = bal;
      report.inflow = Math.max(0, bal - this.lastPoolBalance);
      this.totalIn += report.inflow;

      // Optional treasury cut of the new fees, taken before anything is distributed.
      const cut = Math.floor(report.inflow * (1 - config.HOLDER_SHARE));
      if (cut > 0 && config.TREASURY_ADDRESS) {
        try { await this.send([[config.TREASURY_ADDRESS, cut]]); report.treasury = cut; bal -= cut; }
        catch (e) { console.error('[payout] treasury forward failed:', e.message); }
      }

      // Eligibility at payout time: still holds the minimum (§2.5).
      const twa = {};
      for (const [w, v] of Object.entries(twaAll)) {
        try { if ((await glowBalance(w, 0)) >= config.MIN_HOLD) twa[w] = v; } catch (e) { console.warn('[payout] balance check failed', w, e.message); }
      }

      const rewardPool = rewardPoolOf(bal, this.accrued);
      report.pool = rewardPool;
      const existing = Object.keys(twa).length ? await this.existingAccounts(Object.keys(twa)) : new Set();
      const plan = planEpoch({ rewardPool, dripRate: config.DRIP_RATE, twa, accrued: this.accrued, existing });
      report.budget = plan.budget;
      this.accrued = plan.nextAccrued;

      for (let i = 0; i < plan.pay.length; i += TRANSFERS_PER_TX) {
        const batch = plan.pay.slice(i, i + TRANSFERS_PER_TX);
        try {
          const sig = await this.send(batch);
          report.sigs.push(sig);
          for (const [w, amt] of batch) {
            this.totalPaid += amt; report.paid += amt; report.holders++;
            report.payouts.push({ wallet: w, lamports: amt, sig });
            (this.paidTo[w] ||= []).unshift({ epoch, lamports: amt, sig });
            this.paidTo[w].length = Math.min(this.paidTo[w].length, 50);
          }
        } catch (e) {
          console.error('[payout] batch failed, keeping it owed:', e.message);
          for (const [w, amt] of batch) this.accrued[w] = amt;
        }
      }
      this.lastPoolBalance = await solBalance(this.pool.address);
    } catch (e) {
      console.error('[payout] epoch failed:', e);
      report.error = e.message;
    } finally {
      this.history.unshift(report); this.history.length = Math.min(this.history.length, 50);
      this.epoch++; this.epochEnd = Date.now() / 1000 + config.EPOCH_SEC;
      this.running = false;
      onDone?.(report);
    }
  }

  async existingAccounts(wallets) {
    const out = new Set();
    for (let i = 0; i < wallets.length; i += 100) {
      const chunk = wallets.slice(i, i + 100);
      const { value } = await rpc.getMultipleAccounts(chunk.map((w) => address(w)), { encoding: 'base64', commitment: 'confirmed' }).send();
      value.forEach((acc, k) => { if (acc && Number(acc.lamports) > 0) out.add(chunk[k]); });
    }
    return out;
  }
}
