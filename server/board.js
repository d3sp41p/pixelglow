// The canvas state the indexer keeps (architecture B, spec §3.1): who owns each pixel, in which colour,
// and each wallet's live-pixel count integrated over time for the epoch (time-weighted average, §2.4).
import { config } from '../config.js';

const N = config.COLS * config.ROWS;

export class Board {
  constructor() {
    this.colors = new Uint8Array(N);   // 0 = empty, 1..12 = palette
    this.owners = new Uint32Array(N);  // 0 = empty, otherwise wallet index + 1
    this.wallets = [];                 // index -> address
    this.index = new Map();            // address -> index
    this.counts = [];                  // live pixels per wallet index
    this.acc = [];                     // pixel-seconds this epoch per wallet index
    this.last = [];                    // last time acc was brought up to date
    this.claims = [];                  // total confirmed claims per wallet index
    this.epochStart = Date.now() / 1000;
    this.live = 0;
  }

  idx(wallet) {
    let i = this.index.get(wallet);
    if (i === undefined) {
      i = this.wallets.length;
      this.wallets.push(wallet); this.index.set(wallet, i);
      this.counts.push(0); this.acc.push(0); this.last.push(this.epochStart); this.claims.push(0);
    }
    return i;
  }

  // Bring one wallet's integral up to time t before its count changes.
  touch(i, t) { this.acc[i] += this.counts[i] * (t - this.last[i]); this.last[i] = t; }

  apply(x, y, c, wallet, t = Date.now() / 1000) {
    const cell = y * config.COLS + x, w = this.idx(wallet), prev = this.owners[cell];
    this.claims[w]++;
    if (prev === w + 1) { this.colors[cell] = c; return { cell, prevOwner: wallet }; }
    if (prev) { const p = prev - 1; this.touch(p, t); this.counts[p]--; } else this.live++;
    this.touch(w, t); this.counts[w]++;
    this.owners[cell] = w + 1; this.colors[cell] = c;
    return { cell, prevOwner: prev ? this.wallets[prev - 1] : null };
  }

  // Time-weighted average live pixels so far this epoch, for one wallet and for everyone.
  twaSoFar(wallet, t = Date.now() / 1000) {
    const span = Math.max(1, t - this.epochStart);
    let total = 0;
    for (let i = 0; i < this.wallets.length; i++) total += this.acc[i] + this.counts[i] * (t - this.last[i]);
    const i = this.index.get(wallet);
    const mine = i === undefined ? 0 : this.acc[i] + this.counts[i] * (t - this.last[i]);
    return { mine: mine / span, total: total / span };
  }

  // Close the epoch: returns { wallet: avgLivePixels } and starts a fresh integral.
  closeEpoch(t = Date.now() / 1000) {
    const span = Math.max(1, t - this.epochStart), out = {};
    for (let i = 0; i < this.wallets.length; i++) {
      this.touch(i, t);
      if (this.acc[i] > 0) out[this.wallets[i]] = this.acc[i] / span;
      this.acc[i] = 0;
    }
    this.epochStart = t;
    return out;
  }

  livePixels(wallet) { const i = this.index.get(wallet); return i === undefined ? 0 : this.counts[i]; }
  totalClaims(wallet) { const i = this.index.get(wallet); return i === undefined ? 0 : this.claims[i]; }

  top(n) {
    return this.wallets.map((w, i) => ({ wallet: w, pixels: this.counts[i] }))
      .filter((e) => e.pixels > 0).sort((a, b) => b.pixels - a.pixels).slice(0, n);
  }

  // Pixels owned by one wallet, as a bitset for the client to mark "yours".
  mineBits(wallet) {
    const bits = new Uint8Array(Math.ceil(N / 8)), i = this.index.get(wallet);
    if (i === undefined) return bits;
    for (let k = 0; k < N; k++) if (this.owners[k] === i + 1) bits[k >> 3] |= 1 << (k & 7);
    return bits;
  }

  toJSON() {
    return {
      colors: Buffer.from(this.colors).toString('base64'),
      owners: Buffer.from(this.owners.buffer).toString('base64'),
      wallets: this.wallets, acc: this.acc, last: this.last, claims: this.claims, epochStart: this.epochStart,
    };
  }

  static fromJSON(j) {
    const b = new Board();
    b.colors = new Uint8Array(Buffer.from(j.colors, 'base64'));
    b.owners = new Uint32Array(new Uint8Array(Buffer.from(j.owners, 'base64')).buffer);
    b.wallets = j.wallets; b.wallets.forEach((w, i) => b.index.set(w, i));
    b.counts = b.wallets.map(() => 0);
    for (let k = 0; k < N; k++) if (b.owners[k]) { b.counts[b.owners[k] - 1]++; b.live++; }
    b.acc = j.acc; b.last = j.last; b.claims = j.claims || b.wallets.map(() => 0); b.epochStart = j.epochStart;
    return b;
  }
}
