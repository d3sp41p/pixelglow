// Pixelglow server: static site + read-only API + claim relayer + live board over WebSocket + epoch payouts.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { isAddress } from '@solana/kit';
import { config } from '../config.js';
import { Board } from './board.js';
import { ClaimError, Relay } from './relay.js';
import { Payouts } from './payouts.js';
import { chain, diag, slotNow, explorerTx, glowBalance, loadOrCreateKey, refreshBlockhash, sendWire, solBalance, waitForConfirmation } from './solana.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const STATE_FILE = join(config.DATA_DIR, 'state.json');
const CLAIMS_LOG = join(config.DATA_DIR, 'claims.jsonl');
mkdirSync(config.DATA_DIR, { recursive: true });

if (!config.GLOW_MINT) console.warn('[!] GLOW_MINT is not set: run `npm run setup` (devnet) or set GLOW_MINT. Holder checks will fail.');

// ---- state ----
const relayer = await loadOrCreateKey('relayer');
const pool = await loadOrCreateKey('pool');
const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const board = saved.board ? Board.fromJSON(saved.board) : new Board();
const relay = new Relay(relayer);
for (const [s, v] of Object.entries(saved.sessions || {})) relay.sessions.set(s, v);
const payouts = new Payouts(pool, board, saved.payouts, relayer);
const stats = { txTotal: saved.txTotal || 0, recent: [] }; // recent: confirmation timestamps for tx/s
const lastClaims = saved.lastClaims || []; // newest first, for the feed on page load

function save() {
  const sessions = Object.fromEntries([...relay.sessions].filter(([, v]) => v.expires > Date.now() / 1000));
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ board: board.toJSON(), payouts: payouts.toJSON(), sessions, txTotal: stats.txTotal, lastClaims }));
  renameSync(tmp, STATE_FILE);
}
setInterval(save, 10_000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

// ---- live channel ----
const clients = new Set();
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of clients) if (ws.readyState === 1) ws.send(s); };
let pxQueue = [];
setInterval(() => { if (pxQueue.length) { broadcast({ t: 'px', list: pxQueue }); pxQueue = []; } }, 50);

function globalStats() {
  const now = Date.now();
  stats.recent = stats.recent.filter((t) => now - t < 5000);
  return {
    t: 'stats', live: board.live, players: board.top(1e9).length, txTotal: stats.txTotal, tps: +(stats.recent.length / 5).toFixed(1),
    epoch: payouts.epoch, epochEnd: payouts.epochEnd, totalPaid: payouts.totalPaid, pool: lastPool, next: nextPayout, dripPerDay: config.DRIP_PER_DAY,
    top: board.top(5),
  };
}
let lastPool = 0, nextPayout = 0;
// On the very first start this fixes the pool's starting balance: only SOL arriving after it counts as fees.
try { ({ pool: lastPool, next: nextPayout } = await payouts.currentPool()); } catch (e) { console.warn('[pool] first balance read failed:', e.message); }
setInterval(async () => { try { ({ pool: lastPool, next: nextPayout } = await payouts.currentPool()); } catch {} }, 30_000);
setInterval(() => broadcast(globalStats()), 1000);

// ---- blockhash for clients ----
async function blockhashLoop() {
  try { await refreshBlockhash(); broadcast({ t: 'bh', blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight, cuPrice: chain.cuPrice }); }
  catch (e) { console.warn('[bh]', e.message); }
  setTimeout(blockhashLoop, 15_000);
}
await blockhashLoop();

// ---- epochs ----
setInterval(() => {
  if (Date.now() / 1000 >= payouts.epochEnd && !payouts.running) {
    payouts.run((report) => {
      console.log(`[epoch ${report.epoch}] in ${report.inflow / 1e9} SOL, pool ${report.pool / 1e9}, paid ${report.paid / 1e9} SOL to ${report.holders}`);
      broadcast({ t: 'epoch', ...report, epochEnd: payouts.epochEnd });
      save();
    });
  }
}, 1000);

// ---- claims ----
// The pixel is shown as soon as its transaction is in a block ('processed'); confirmation follows in the background
// and the pixel is put back if it never comes.
const lat = { land: [], confirm: [] }; // recent timings in ms
const traces = []; // per-claim breakdown of the last claims, newest first
const noteLat = (k, ms) => { lat[k].push(ms); if (lat[k].length > 200) lat[k].shift(); };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((p, q) => p - q); return s[s.length >> 1]; };
async function claim(wire) {
  const t0 = Date.now();
  const c = await relay.coSign(wire);
  const tr = { sign: Date.now() - t0, send: null, via: null, sends: 1, slotAtSend: slotNow.slot, slots: null, land: null, confirm: null };
  // First send now; re-send from 0.5 s while it is not in a block yet (most claims land in ~0.3 s, so this costs
  // few extra calls and rescues the ones a leader dropped), and never let one rate-limited send fail the click.
  let via = null; // the endpoint that took the first send; re-sends go elsewhere
  sendWire(c.wire).then((name) => { via = name; tr.via = name; tr.send = Date.now() - t0; tr.slotAtSend = slotNow.slot; }, (e) => console.warn('[claim] send failed, will retry:', e.message));
  let resend = null;
  const startResend = setTimeout(() => { resend = setInterval(() => { tr.sends++; sendWire(c.wire, via).catch(() => {}); }, 600); }, 500);
  const stopResend = () => { clearTimeout(startResend); if (resend) clearInterval(resend); };
  const confirmed = waitForConfirmation(c.signature, 30_000, 'confirmed');
  const landed = await Promise.race([waitForConfirmation(c.signature, 30_000, 'processed'), confirmed]);
  stopResend();
  if (!landed.ok) throw new ClaimError('failed', 'The transaction did not land. Try again.');
  const ms = Date.now() - t0;
  noteLat('land', ms);
  tr.land = ms; tr.slots = landed.slot && tr.slotAtSend ? landed.slot - tr.slotAtSend : null;
  traces.unshift(tr); traces.length = Math.min(traces.length, 20);
  const prev = board.apply(c.x, c.y, c.c, c.wallet);
  stats.txTotal++; stats.recent.push(Date.now());
  const px = { i: c.y * config.COLS + c.x, c: c.c, w: c.wallet, sig: c.signature, ms };
  pxQueue.push(px); lastClaims.unshift(px); lastClaims.length = Math.min(lastClaims.length, 14);
  confirmed.then((res) => {
    if (res.ok) {
      noteLat('confirm', Date.now() - t0); tr.confirm = Date.now() - t0;
      appendFileSync(CLAIMS_LOG, JSON.stringify({ t: Date.now(), sig: c.signature, slot: res.slot, w: c.wallet, x: c.x, y: c.y, c: c.c }) + '\n');
    } else if (board.restore(prev.cell, c.wallet, { owner: prev.prevOwner, color: prev.prevColor })) {
      console.warn('[claim] did not confirm, pixel restored:', c.signature, JSON.stringify(res.err));
      pxQueue.push({ i: prev.cell, c: board.colors[prev.cell], w: prev.prevOwner || '', revert: true });
    }
  });
  return { signature: c.signature, ms, x: c.x, y: c.y, c: c.c };
}

// ---- read-only wallet view (§1.4, §3.2.6) ----
async function walletView(w) {
  const est = await payouts.estimate(w);
  let glow = null; try { glow = await glowBalance(w); } catch {}
  const paid = payouts.paidTo[w] || [];
  return {
    wallet: w, glow, holder: glow !== null && glow >= config.MIN_HOLD,
    livePixels: board.livePixels(w), claims: board.totalClaims(w), share: est.share,
    estPayout: est.lamports, accrued: payouts.accrued[w] || 0,
    earned: paid.reduce((a, p) => a + p.lamports, 0), payouts: paid.slice(0, 10),
    epochEnd: payouts.epochEnd,
  };
}

// ---- http ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// The site may be served from another origin (Vercel); no cookies are used, so a plain allow-list is enough.
const cors = (req) => {
  const origin = req.headers.origin || '', list = config.ALLOWED_ORIGINS;
  const ok = list.includes('*') || list.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return ok && origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(res.req) }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (d) => { s += d; if (s.length > 10_000) { bad(new ClaimError('too_large', 'Request too large.')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { bad(new ClaimError('bad_json', 'Bad JSON.')); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors(req), 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  try {
    if (p === '/api/config') return json(res, 200, {
      cluster: config.CLUSTER, relayer: relayer.address, pool: pool.address, mint: config.GLOW_MINT, symbol: config.TOKEN_SYMBOL,
      cols: config.COLS, rows: config.ROWS, palette: config.PALETTE, epochSec: config.EPOCH_SEC,
      holderShare: config.HOLDER_SHARE, dripPerDay: config.DRIP_PER_DAY, dripPerEpoch: config.DRIP_RATE, minHold: config.MIN_HOLD, sessionTtl: config.SESSION_TTL_SEC,
      blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight, cuPrice: chain.cuPrice,
    });
    if (p === '/api/board') {
      const w = url.searchParams.get('wallet');
      return json(res, 200, {
        colors: Buffer.from(board.colors).toString('base64'),
        mine: w && isAddress(w) ? Buffer.from(board.mineBits(w)).toString('base64') : null,
        recent: lastClaims,
        ...globalStats(),
      });
    }
    if (p === '/api/stats') return json(res, 200, { ...globalStats(), latency: { landMs: median(lat.land), confirmMs: median(lat.confirm), slowest: Math.max(0, ...lat.land), samples: lat.land.length }, diag, traces, slot: slotNow, history: payouts.history.slice(0, 10).map(({ payouts: _, ...h }) => h) });
    if (p.startsWith('/api/wallet/')) {
      const w = decodeURIComponent(p.slice('/api/wallet/'.length));
      if (!isAddress(w)) return json(res, 400, { error: 'bad_address', message: 'That is not a Solana address.' });
      return json(res, 200, await walletView(w));
    }
    if (p === '/api/session' && req.method === 'POST') return json(res, 200, await relay.openSession(await readBody(req)));
    if (p === '/api/claim' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await claim(b.tx)); }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

    // static files
    const file = normalize(join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(normalize(PUBLIC)) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  } catch (e) {
    if (e instanceof ClaimError) return json(res, 400, { error: e.code, message: e.message });
    console.error(e);
    json(res, 500, { error: 'server', message: 'Something went wrong on our side.' });
  }
});

const wss = new WebSocketServer({ server, path: '/live' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'bh', blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight, cuPrice: chain.cuPrice }));
  ws.send(JSON.stringify(globalStats()));
  ws.on('close', () => clients.delete(ws));
});

server.listen(config.PORT, async () => {
  console.log(`Pixelglow on http://localhost:${config.PORT}  (${config.CLUSTER})`);
  console.log(`  relayer ${relayer.address}  ${(await solBalance(relayer.address).catch(() => 0)) / 1e9} SOL`);
  console.log(`  pool    ${pool.address}  ${(await solBalance(pool.address).catch(() => 0)) / 1e9} SOL`);
  console.log(`  mint    ${config.GLOW_MINT || '(not set)'}   epoch ${config.EPOCH_SEC}s`);
  console.log(`  tx log  ${explorerTx('<signature>')}`);
});
