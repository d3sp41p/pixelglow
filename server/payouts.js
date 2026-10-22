// Epoch payouts (spec §2): every EPOCH_SEC the pool wallet's new SOL (creator fees) plus any carryover is split:
// HOLDER_SHARE to holders by time-weighted live pixels, the rest forwarded to the treasury. Pushed automatically.
import { address, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { config } from '../config.js';
import { glowBalance, rpc, sendInstructions, solBalance } from './solana.js';

const RENT_EXEMPT_MIN = 890_880;   // a brand-new system account must receive at least this much
const TRANSFERS_PER_TX = 18;       // stays well under the 1232-byte transaction limit

export class Payouts {
  constructor(pool, board, state = {}) {
    this.pool = pool; this.board = board;
    this.epoch = state.epoch ?? 1;
    this.epochEnd = state.epochEnd ?? Date.now() / 1000 + config.EPOCH_SEC;
    this.lastPoolBalance = state.lastPoolBalance ?? null; // lamports after the previous payout
    this.carry = state.carry ?? 0;                         // lamports carried when nobody held ground (§2.6)
    this.accrued = state.accrued ?? {};                    // wallet -> lamports below the dust threshold (§2.6)
    this.totalPaid = state.totalPaid ?? 0;
    this.history = state.history ?? [];                    // last epochs, newest first
    this.paidTo = state.paidTo ?? {};                      // wallet -> [{ epoch, lamports, sig }]
    this.running = false;
  }

  toJSON() {
    const { epoch, epochEnd, lastPoolBalance, carry, accrued, totalPaid, history, paidTo } = this;
    return { epoch, epochEnd, lastPoolBalance, carry, accrued, totalPaid, history, paidTo };
  }

  // Lamports that arrived in the pool wallet since the last payout, plus carryover.
  async currentPool() {
    const bal = await solBalance(this.pool.address);
    if (this.lastPoolBalance === null) this.lastPoolBalance = bal; // first run: only count fees from now on
    return { bal, pool: Math.max(0, bal - this.lastPoolBalance) + this.carry };
  }

  // Estimated payout for one wallet if the epoch closed now.
  async estimate(wallet) {
    const { pool } = await this.currentPool().catch(() => ({ pool: 0 }));
    const { mine, total } = this.board.twaSoFar(wallet);
    const share = total > 0 ? mine / total : 0;
    return { pool, share, lamports: Math.floor(pool * config.HOLDER_SHARE * share) + (this.accrued[wallet] || 0) };
  }

  async run(onDone) {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    const report = { epoch, t: Math.floor(Date.now() / 1000), pool: 0, holders: 0, paid: 0, treasury: 0, carried: 0, sigs: [], payouts: [] };
    try {
      const twa = this.board.closeEpoch();                 // { wallet: avg live pixels over the epoch }
      const { bal, pool } = await this.currentPool();
      report.pool = pool;

      // Eligibility at payout time: still holds the minimum $GLOW (§2.5).
      const eligible = {};
      for (const [w, v] of Object.entries(twa)) {
        try { if ((await glowBalance(w, 0)) >= config.MIN_HOLD) eligible[w] = v; } catch (e) { console.warn('[payout] balance check failed', w, e.message); }
      }
      const sum = Object.values(eligible).reduce((a, b) => a + b, 0);

      if (sum === 0 || pool === 0) {
        this.carry = pool;                                  // nobody held ground: the pool rolls over (§2.6)
        report.carried = pool;
      } else {
        const holderPart = Math.floor(pool * config.HOLDER_SHARE);
        const treasuryPart = pool - holderPart;
        // Owed to wallets not paid this round stays untouched in the pool wallet.
        const owedElsewhere = Object.entries(this.accrued).reduce((a, [w, v]) => a + (w in eligible ? 0 : v), 0);
        const spendable = Math.max(0, bal - config.POOL_RESERVE_LAMPORTS - owedElsewhere);

        // Each wallet's cut plus anything accrued earlier.
        const due = Object.entries(eligible).map(([w, v]) => [w, Math.floor(holderPart * v / sum) + (this.accrued[w] || 0)]);
        const existing = await this.existingAccounts(due.map(([w]) => w));
        const pay = [];
        for (const [w, amt] of due) {
          if (amt < config.DUST_LAMPORTS || (!existing.has(w) && amt < RENT_EXEMPT_MIN)) { this.accrued[w] = amt; continue; }
          pay.push([w, amt]);
        }
        const total = pay.reduce((a, [, amt]) => a + amt, 0), remainder = {};
        if (total > spendable) { // never dip into the gas reserve; scale down and keep the rest owed
          const k = spendable / total;
          for (const p of pay) { const owed = p[1] - Math.floor(p[1] * k); p[1] -= owed; remainder[p[0]] = owed; }
        }

        for (let i = 0; i < pay.length; i += TRANSFERS_PER_TX) {
          const batch = pay.slice(i, i + TRANSFERS_PER_TX).filter(([, a]) => a > 0);
          if (!batch.length) continue;
          try {
            const sig = await sendInstructions(this.pool.signer, batch.map(([w, amt]) =>
              getTransferSolInstruction({ source: this.pool.signer, destination: address(w), amount: lamports(BigInt(amt)) })));
            report.sigs.push(sig);
            for (const [w, amt] of batch) {
              if (remainder[w] > 0) this.accrued[w] = remainder[w]; else delete this.accrued[w];
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

        if (config.TREASURY_ADDRESS && treasuryPart > 0) {
          try {
            await sendInstructions(this.pool.signer, [getTransferSolInstruction({ source: this.pool.signer, destination: address(config.TREASURY_ADDRESS), amount: lamports(BigInt(treasuryPart)) })]);
            report.treasury = treasuryPart;
          } catch (e) { console.error('[payout] treasury forward failed:', e.message); }
        } else report.treasury = treasuryPart; // stays in the pool wallet, not counted as new fees next epoch
        this.carry = 0;
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

  totalAccrued() { return Object.values(this.accrued).reduce((a, b) => a + b, 0); }

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
