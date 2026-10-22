// Pixelglow configuration. Every economic number here is a recommendation from the spec (pixelglow_TZ.md §2)
// and must be confirmed with the client before mainnet. Change values here, not in code.
// Any key can be overridden with an environment variable of the same name (e.g. EPOCH_SEC=60 for a quick demo).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

export const config = {
  // ---- network ----
  CLUSTER: env('CLUSTER', 'devnet'),
  RPC_URL: env('RPC_URL', 'https://api.devnet.solana.com'),
  RPC_WS_URL: env('RPC_WS_URL', 'wss://api.devnet.solana.com'),
  // Extra endpoints every claim is also sent to, in parallel (comma-separated). Default: the public endpoint of the cluster.
  SEND_RPC_URLS: env('SEND_RPC_URLS', env('CLUSTER', 'devnet') === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : '').split(',').map((s) => s.trim()).filter(Boolean),
  PORT: num('PORT', 8787),
  // Sites allowed to call the API from a browser, comma-separated (e.g. https://pixelglow.vercel.app). '*' = any.
  ALLOWED_ORIGINS: env('ALLOWED_ORIGINS', '*').split(',').map((s) => s.trim()).filter(Boolean),

  // ---- token ----
  // Filled in by `npm run setup` on devnet. On mainnet: the real $GLOW mint.
  // 'SOL' = gate by the wallet's own SOL balance instead of a token (handy for testing before $GLOW exists).
  GLOW_MINT: env('GLOW_MINT', ''),
  TOKEN_SYMBOL: env('TOKEN_SYMBOL', ''),        // shown in messages; defaults to SOL or $GLOW
  MIN_HOLD: num('MIN_HOLD', 10_000),             // whole $GLOW a wallet must hold to draw and to be paid (§2.5)

  // ---- board ----
  COLS: 200,
  ROWS: 112,
  PALETTE: ['#14f195', '#0fb5a8', '#19a7f3', '#3d6bff', '#8a5cff', '#d14bff', '#ff4fa3', '#ff4766', '#ff7a2e', '#ffb627', '#d6ff2e', '#7027ff'],

  // ---- economy (§2) ----
  EPOCH_SEC: num('EPOCH_SEC', 600),              // 10 minutes (§2.3)
  HOLDER_SHARE: num('HOLDER_SHARE', 1.0),        // share of every fee that goes into the holders' reward pool (1 = all of it)
  // Share of the reward pool paid out per day, spread evenly over every epoch. What is not paid yet stays in the
  // pool as a cushion, so payouts carry on when trading slows. 0.20 = 20% of the pool a day.
  DRIP_PER_DAY: num('DRIP_PER_DAY', 0.20),
  DUST_LAMPORTS: num('DUST_LAMPORTS', 500_000),  // 0.0005 SOL: smaller payouts accrue to the next epoch (§2.6)
  POOL_RESERVE_LAMPORTS: num('POOL_RESERVE_LAMPORTS', 1_000_000), // kept in the pool wallet so it stays rent-exempt; payout gas is paid by the relayer
  TREASURY_ADDRESS: env('TREASURY_ADDRESS', ''), // where the (1 - HOLDER_SHARE) cut of new fees goes; empty = it stays in the pool

  // ---- sessions & relayer (§1.3, fee payer = project) ----
  SESSION_TTL_SEC: num('SESSION_TTL_SEC', 24 * 3600),
  MAX_CLAIMS_PER_SEC: num('MAX_CLAIMS_PER_SEC', 20),          // per wallet, generous: speed is the point (§2.6)
  // Priority fee per compute unit for claims, picked from recent network fees and kept inside these bounds.
  // 22,000 units × 50,000 µ-lamports = 1,100 lamports (+11% on the 10,000 base fee); the cap is the most the relayer will pay.
  MIN_PRIORITY_MICROLAMPORTS: num('MIN_PRIORITY_MICROLAMPORTS', 10_000),
  MAX_PRIORITY_MICROLAMPORTS: num('MAX_PRIORITY_MICROLAMPORTS', 200_000),
  RELAYER_DAILY_TX_CAP: num('RELAYER_DAILY_TX_CAP', 200_000), // ≈ 2 SOL/day: a claim has 2 signatures = 10,000 lamports

  // ---- files ----
  // devnet keys live in keys/, every other cluster in keys/<cluster>/ so they can never be mixed up
  KEYS_DIR: env('KEYS_DIR', fileURLToPath(new URL(env('CLUSTER', 'devnet') === 'devnet' ? './keys/' : `./keys/${env('CLUSTER', 'devnet')}/`, import.meta.url))),
  DATA_DIR: env('DATA_DIR', fileURLToPath(new URL('./data/', import.meta.url))),
};

// `npm run setup` writes the devnet mint here so it does not have to be copied by hand.
config.NATIVE_GATE = () => config.GLOW_MINT.toUpperCase() === 'SOL';
if (!config.GLOW_MINT && config.CLUSTER === 'devnet') {
  try { config.GLOW_MINT = JSON.parse(readFileSync(join(config.KEYS_DIR, 'devnet.json'), 'utf8')).mint || ''; } catch {}
}
if (!config.TOKEN_SYMBOL) config.TOKEN_SYMBOL = config.NATIVE_GATE() ? 'SOL' : '$GLOW';
// Per-epoch share that compounds to DRIP_PER_DAY over a day: 1 - (1 - daily)^(epoch / day). 20%/day at 10 min ≈ 0.155%.
config.DRIP_RATE = 1 - Math.pow(1 - config.DRIP_PER_DAY, config.EPOCH_SEC / 86_400);
if (process.env.DRIP_RATE) console.warn('[config] DRIP_RATE is no longer used and is ignored; set DRIP_PER_DAY instead.');
