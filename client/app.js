// Pixelglow client: live board, wallet connect, one-time session key, one click = one claim transaction.
import { getWallets } from '@wallet-standard/app';
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction, getUtf8Encoder, partiallySignTransaction } from '@solana/kit';
import { buildClaimTransaction, sessionMessage } from '../shared/claim.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const sol = (lamports, d = 4) => (lamports / 1e9).toFixed(d);
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
const mmss = (s) => { s = Math.max(0, Math.ceil(s)); return String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
// Where the server lives. Empty = same origin (local dev); on Vercel it is the Railway URL, set at build time.
const API = (typeof API_BASE !== 'undefined' ? API_BASE : '').replace(/\/$/, '');
const LIVE_URL = API ? API.replace(/^http/, 'ws') + '/live' : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live';
const api = async (path, body) => {
  const r = await fetch(API + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || 'Request failed'), { code: j.error });
  return j;
};

const cfg = await api('/api/config');
const { cols: COLS, rows: ROWS, palette: PALETTE } = cfg;
const N = COLS * ROWS, SCALE = 5;
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const EMPTY = [css('--px-a'), css('--px-b')];
const RIVALS = [css('--rival-1'), css('--rival-2'), css('--rival-3'), css('--rival-4')];
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}${cfg.cluster === 'mainnet-beta' ? '' : `?cluster=${cfg.cluster}`}`;

const me = { wallet: null, account: null, provider: null, session: null, keyPair: null, expires: 0, holder: null, glow: null, tx: 0 };
const chain = { blockhash: cfg.blockhash, lastValidBlockHeight: cfg.lastValidBlockHeight };
let sel = 1, stats = null;

// ---------------- board ----------------
const cv = $('cv'), ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
const inner = $('pixinner');
const colors = new Uint8Array(N), mine = new Uint8Array(N), pending = new Map(); // cell -> previous colour
function paint(i) { const x = i % COLS, y = (i / COLS) | 0, c = colors[i]; ctx.fillStyle = c ? PALETTE[c - 1] : EMPTY[(x + y) & 1]; ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE); }
async function loadBoard() {
  const b = await api('/api/board' + (me.wallet ? `?wallet=${me.wallet}` : ''));
  colors.set(Uint8Array.from(atob(b.colors), (ch) => ch.charCodeAt(0)));
  mine.fill(0);
  if (b.mine) { const bits = Uint8Array.from(atob(b.mine), (ch) => ch.charCodeAt(0)); for (let k = 0; k < N; k++) if (bits[k >> 3] & (1 << (k & 7))) mine[k] = 1; }
  for (let i = 0; i < N; i++) paint(i);
  if (!flist.querySelector('.frow')) [...(b.recent || [])].reverse().forEach(feedClaim);
  (b.recent || []).forEach((p) => noteMs(p.ms));
  onStats(b); renderMine();
}

// ---------------- palette ----------------
const palEl = $('palette');
PALETTE.forEach((c, i) => {
  const b = document.createElement('button'); b.className = 'sw'; b.style.background = c;
  b.setAttribute('aria-pressed', i + 1 === sel); b.setAttribute('aria-label', 'Colour ' + c);
  b.onclick = () => { sel = i + 1; [...palEl.children].forEach((ch) => ch.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); renderTerritory(); };
  palEl.appendChild(b);
});

// ---------------- feed ----------------
const flist = $('flist');
function pushRow(html, cls = '', cell = null) {
  $('fempty')?.remove();
  const el = document.createElement('div'); el.className = 'frow ' + cls; el.innerHTML = html;
  if (cell !== null) el.dataset.i = cell;
  flist.prepend(el); while (flist.children.length > 30) flist.lastChild.remove();
}
function feedClaim(p) {
  const x = p.i % COLS, y = (p.i / COLS) | 0, you = p.w === me.wallet;
  pushRow(`<i style="background:${PALETTE[p.c - 1]}"></i><span class="op">${you ? 'you' : short(p.w)}</span><a class="sig" href="${explorer(p.sig)}" target="_blank" rel="noopener">claim(${x}, ${y}) <span>${short(p.sig)}</span></a><span class="ms">${p.ms} ms</span>`, you ? 'mine' : '', p.i);
}
// Where a transaction landed: a ring that expands from the pixel, so everyone sees the board being hit.
const placeAt = (el, i) => { el.style.left = ((i % COLS) / COLS * 100) + '%'; el.style.top = (((i / COLS) | 0) / ROWS * 100) + '%'; };
function ping(i) {
  if (inner.querySelectorAll('.ping').length > 60) return;
  const el = document.createElement('span'); el.className = 'ping'; placeAt(el, i);
  inner.appendChild(el); setTimeout(() => el.remove(), 750);
}
// Hovering a row in the feed points at its pixel on the board.
const mark = $('mark');
flist.addEventListener('mouseover', (e) => { const r = e.target.closest('.frow[data-i]'); if (r) { placeAt(mark, +r.dataset.i); mark.classList.add('on'); } });
flist.addEventListener('mouseleave', () => mark.classList.remove('on'));

// ---------------- numbers ----------------
function renderMine() {
  let n = 0; for (let k = 0; k < N; k++) n += mine[k];
  $('g-mine').textContent = fmt(n);
  $('g-mytx').textContent = fmt(me.tx);
}
function renderTerritory() {
  if (!stats) return;
  const live = stats.live || 0, myN = mine.reduce((a, b) => a + b, 0);
  const rows = stats.top.filter((e) => e.wallet !== me.wallet).slice(0, 4).map((e, k) => ({ nm: short(e.wallet), c: e.pixels, col: e.color ? PALETTE[e.color - 1] : RIVALS[k] }));
  if (me.wallet) rows.push({ nm: 'You', c: myN, col: PALETTE[sel - 1], you: 1 });
  rows.sort((a, b) => b.c - a.c);
  const rest = Math.max(0, live - rows.reduce((a, r) => a + r.c, 0));
  $('tbar').innerHTML = rows.map((r) => `<span style="flex-grow:${r.c};background:${r.col}"></span>`).join('') + (rest ? `<span style="flex-grow:${rest};background:${css('--surface-2')}"></span>` : '');
  $('tleg').innerHTML = (rows.length ? rows : [{ nm: 'Nobody yet', c: 0, col: css('--surface-2') }]).map((r) =>
    `<span class="${r.you ? 'you' : ''}"><i style="background:${r.col}"></i>${r.nm} <b>${live ? (r.c / live * 100).toFixed(1) : '0.0'}%</b></span>`).join('')
    + (rest ? `<span><i style="background:${css('--surface-2')}"></i>Others <b>${(rest / live * 100).toFixed(1)}%</b></span>` : '');
}
// ---------------- lower sections: payout history, measured speed, token ----------------
const msSeen = [];
function noteMs(ms) {
  if (!ms) return;
  msSeen.push(ms); if (msSeen.length > 40) msSeen.shift();
  const sorted = [...msSeen].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  $('race-ms').textContent = med >= 1000 ? (med / 1000).toFixed(1) + ' s' : med + ' ms';
  $('race-live').dataset.ms = med;
}
let lastHistory = [];
function renderHistory(h) {
  if (h) lastHistory = h;
  const rows = lastHistory.filter((e) => e.pool > 0 || e.paid > 0).slice(0, 7);
  // the epoch in progress is always the first row, so the table is never empty
  const now = stats ? `<tr class="cur"><td>#${stats.epoch} <span>now</span></td><td class="n">${sol(stats.pool || 0, 4)} SOL</td><td class="n">~${sol(stats.next || 0, 4)} SOL</td><td class="n">${stats.players || 0}</td><td>in progress</td></tr>` : '';
  $('hist').innerHTML = `<table><thead><tr><th>Epoch</th><th class="n">Pool</th><th class="n">Paid out</th><th class="n">Holders</th><th>Transaction</th></tr></thead><tbody>${now}${rows.map((e) =>
    `<tr><td>#${e.epoch}</td><td class="n">${sol(e.pool, 4)} SOL</td><td class="n">${e.paid ? sol(e.paid, 4) + ' SOL' : '—'}</td><td class="n">${e.holders || 0}</td><td>${
      e.sigs && e.sigs[0] ? `<a href="${explorer(e.sigs[0])}" target="_blank" rel="noopener">${short(e.sigs[0])} ↗</a>`  : e.paid ? '—' : 'nobody on the board'}</td></tr>`).join('')}</tbody></table>`;
}
async function loadHistory() { try { renderHistory((await api('/api/stats')).history); } catch {} }
const live = $('faq-live');
if (live) live.textContent = cfg.cluster === 'mainnet-beta'
  ? `Yes, on Solana mainnet. Every pixel and every payout is a real transaction you can open in the explorer.${cfg.mint.toUpperCase() === 'SOL' ? ' Until $GLOW launches, holding ' + fmt(cfg.minHold) + ' SOL is the ticket.' : ''}`
  : 'It runs on Solana devnet with a test $GLOW while the token launches. Every pixel and every payout is a real transaction you can open in the explorer.';
if (cfg.mint && cfg.mint.toUpperCase() !== 'SOL') $('mint-addr').innerHTML = `<a href="https://explorer.solana.com/address/${cfg.mint}${cfg.cluster === 'mainnet-beta' ? '' : '?cluster=' + cfg.cluster}" target="_blank" rel="noopener">${cfg.mint}</a>`;

function onStats(s) {
  stats = s;
  $('s-pool').innerHTML = sol(s.pool || 0, 3) + '<small>SOL</small>';
  $('s-next').innerHTML = sol(s.next || 0, 4) + '<small>SOL</small>';
  $('s-paid').innerHTML = sol(s.totalPaid || 0, 3) + '<small>SOL</small>';
  $('s-total').textContent = fmt(s.live || 0);
  $('s-players').textContent = fmt(s.players || 0);
  renderHistory();
  $('spd').textContent = (s.tps || 0) + ' tx/s';
  $('txtotal').textContent = fmt(s.txTotal || 0);
  renderTerritory();
}
setInterval(() => { if (stats) { const t = mmss(stats.epochEnd - Date.now() / 1000); $('g-next').textContent = t; $('hist-next').textContent = 'next in ' + t; } }, 250);

async function refreshWallet() {
  if (!me.wallet) return;
  try {
    const v = await api('/api/wallet/' + me.wallet);
    me.holder = v.holder; me.glow = v.glow;
    $('g-estpay').textContent = sol(v.estPayout);
    $('g-share').textContent = (v.share * 100).toFixed(1) + '%';
    $('g-earned').textContent = sol(v.earned, 3);
    me.tx = Math.max(me.tx, v.claims); renderMine(); renderCta();
  } catch {}
}
setInterval(refreshWallet, 5000);

// ---------------- live channel ----------------
function connectLive() {
  const ws = new WebSocket(LIVE_URL);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'bh') { chain.blockhash = m.blockhash; chain.lastValidBlockHeight = m.lastValidBlockHeight; }
    else if (m.t === 'stats') onStats(m);
    else if (m.t === 'px') {
      for (const p of m.list) {
        pending.delete(p.i); colors[p.i] = p.c; mine[p.i] = p.w === me.wallet ? 1 : 0; paint(p.i);
        if (p.w === me.wallet) toastAt(p.i, `✓ ${p.ms} ms`);
        feedClaim(p); ping(p.i); noteMs(p.ms);
      }
      renderMine();
    } else if (m.t === 'epoch') {
      const mineP = me.wallet && m.payouts.find((p) => p.wallet === me.wallet);
      pushRow(`<i style="background:var(--glow)"></i><span class="op">payout</span><span class="sig">Epoch ${m.epoch} · ${m.holders} holders paid</span><span class="ms">${mineP ? '+' + sol(mineP.lamports) + ' SOL' : sol(m.paid, 3) + ' SOL'}</span>`, 'payout');
      flash('g-estpay'); flash('g-earned'); refreshWallet(); loadHistory();
    }
  };
  ws.onclose = () => setTimeout(connectLive, 1500);
}
function flash(id) { const p = $(id); p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash'); }

// ---------------- wallet + session ----------------
const IDB = 'pixelglow', STORE = 'session';
const idb = () => new Promise((ok, bad) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
async function idbGet(k) { const db = await idb(); return new Promise((ok) => { const r = db.transaction(STORE).objectStore(STORE).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((ok) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = ok; t.onerror = ok; }); }

const usable = (w) => w.features['standard:connect'] && w.features['solana:signMessage'] && w.chains.some((c) => c.startsWith('solana:'));
const listWallets = () => getWallets().get().filter(usable);

async function chooseWallet() {
  const ws = listWallets();
  if (ws.length <= 1) return ws[0] || null;
  return new Promise((resolve) => {
    const dlg = $('wallets');
    dlg.querySelector('ul').innerHTML = ws.map((w, k) => `<li><button data-k="${k}"><img src="${w.icon}" alt="" width="28" height="28">${w.name}</button></li>`).join('');
    dlg.querySelectorAll('button[data-k]').forEach((b) => b.onclick = () => { dlg.close(); resolve(ws[+b.dataset.k]); });
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

async function connect() {
  const w = await chooseWallet();
  if (!w) { setStatus('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.', 'err'); return false; }
  const { accounts } = await w.features['standard:connect'].connect();
  const acc = accounts[0];
  if (!acc) return false;
  me.provider = w; me.account = acc; me.wallet = acc.address;
  const saved = await idbGet(me.wallet);
  if (saved && saved.expires > Date.now() / 1000 + 60) Object.assign(me, { keyPair: saved.keyPair, session: saved.session, expires: saved.expires });
  else Object.assign(me, { keyPair: null, session: null, expires: 0 });
  renderNav(); await loadBoard(); await refreshWallet(); renderCta();
  return true;
}

// The only wallet popup: sign one message that authorises a fresh session key (§1.3).
async function startSession() {
  if (!me.wallet && !(await connect())) return;
  if (me.session) return;
  const keyPair = await generateKeyPair();
  const session = await getAddressFromPublicKey(keyPair.publicKey);
  const expires = Math.floor(Date.now() / 1000) + cfg.sessionTtl;
  const nonce = crypto.randomUUID();
  const message = getUtf8Encoder().encode(sessionMessage({ wallet: me.wallet, session, expires, nonce }));
  setStatus('Confirm the one-time message in your wallet.');
  const [out] = await me.provider.features['solana:signMessage'].signMessage({ account: me.account, message });
  const signature = getBase58Decoder().decode(out.signature);
  const r = await api('/api/session', { wallet: me.wallet, session, expires, nonce, signature });
  Object.assign(me, { keyPair, session, expires, holder: r.holder });
  await idbSet(me.wallet, { keyPair, session, expires });
  setStatus(r.holder ? 'Session started. Every click now signs itself.' : `Session started, but this wallet holds less than ${fmt(cfg.minHold)} ${cfg.symbol}.`, r.holder ? '' : 'err');
  renderCta();
}

function renderNav() {
  const b = $('connect');
  b.innerHTML = me.wallet ? `<span class="px"></span>${short(me.wallet)}` : '<span class="px"></span>Connect wallet';
}
function renderCta() {
  const b = $('cta');
  if (!me.wallet) b.innerHTML = '<span class="px"></span>Connect wallet to play';
  else if (me.holder === false) b.innerHTML = `<span class="px"></span>Get ${cfg.symbol} to play`;
  else if (!me.session) b.innerHTML = '<span class="px"></span>Sign once to start';
  else b.innerHTML = `<span class="px"></span>Session active · ${Math.max(1, Math.round((me.expires - Date.now() / 1000) / 3600))} h left`;
  b.dataset.state = !me.wallet ? 'connect' : me.holder === false ? 'buy' : !me.session ? 'session' : 'ready';
}
const statusEl = $('status');
function setStatus(text, kind = '') { statusEl.textContent = text; statusEl.className = 'status ' + kind; }

async function guarded(fn) {
  try { await fn(); } catch (e) { setStatus(e.message || String(e), 'err'); }
}
$('connect').addEventListener('click', (e) => { e.preventDefault(); guarded(me.wallet ? startSession : connect); });
$('cta').addEventListener('click', (e) => {
  const st = $('cta').dataset.state;
  if (st === 'buy') return; // follows its href to the buy section
  e.preventDefault();
  if (st === 'connect') guarded(async () => { if (await connect() && me.holder !== false) await startSession(); });
  else if (st === 'session') guarded(startSession);
});

// ---------------- claiming ----------------
const hov = $('hov'), coord = $('coord');
function cellAt(ev) {
  const r = cv.getBoundingClientRect();
  return [Math.max(0, Math.min(COLS - 1, Math.floor((ev.clientX - r.left) / r.width * COLS))), Math.max(0, Math.min(ROWS - 1, Math.floor((ev.clientY - r.top) / r.height * ROWS)))];
}
function toastAt(i, text) {
  const x = i % COLS, y = (i / COLS) | 0, t = document.createElement('span');
  t.className = 'toast'; t.textContent = text; t.style.left = ((x + 0.5) / COLS * 100) + '%'; t.style.top = (y / ROWS * 100) + '%';
  inner.appendChild(t); setTimeout(() => t.remove(), 950);
}
cv.addEventListener('pointermove', (ev) => { const [x, y] = cellAt(ev); hov.style.transform = `translate(${x * 100}%,${y * 100}%)`; coord.textContent = `x ${x} · y ${y}`; });
cv.addEventListener('click', async (ev) => {
  const [x, y] = cellAt(ev), i = y * COLS + x;
  if (!me.session) { setStatus(me.wallet ? 'Sign once to start claiming.' : 'Connect a wallet to claim pixels.', 'err'); $('cta').classList.remove('nudge'); void $('cta').offsetWidth; $('cta').classList.add('nudge'); return; }
  if (!chain.blockhash) return setStatus('Waiting for the network…', 'err');
  if (!pending.has(i)) pending.set(i, colors[i]);
  colors[i] = sel; paint(i); // optimistic; the confirmed state arrives over the live channel
  try {
    let tx = buildClaimTransaction({ relayer: cfg.relayer, session: me.session, blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight, x, y, c: sel });
    tx = await partiallySignTransaction([me.keyPair], tx);
    const r = await api('/api/claim', { tx: getBase64EncodedWireTransaction(tx) });
    me.tx++; renderMine();
    if (statusEl.classList.contains('err')) setStatus('');
    return r;
  } catch (e) {
    if (pending.has(i)) { colors[i] = pending.get(i); pending.delete(i); paint(i); }
    if (e.code === 'no_session') { Object.assign(me, { session: null, keyPair: null, expires: 0 }); renderCta(); }
    if (e.code === 'not_holder') { me.holder = false; renderCta(); }
    setStatus(e.message, 'err');
  }
});
$('zoom').addEventListener('click', (e) => {
  const box = $('pixbox'), on = box.classList.toggle('zoom');
  e.currentTarget.setAttribute('aria-pressed', on); e.currentTarget.textContent = on ? 'Fit board' : 'Zoom 3×';
  if (on) setTimeout(() => { box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2; box.scrollTop = (box.scrollHeight - box.clientHeight) / 2; }, 360);
});

// ---------------- check any wallet, read-only (§1.4) ----------------
const form = $('checkf'), addr = $('addr'), res = $('res');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = addr.value.trim();
  const fail = (msg) => { res.className = 'res err'; res.textContent = msg; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); addr.focus(); };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return fail(a ? 'That doesn’t look like a Solana address.' : 'Paste a wallet address first.');
  try {
    const v = await api('/api/wallet/' + a);
    res.className = 'res';
    res.innerHTML = `${short(a)} holds <b>${fmt(v.livePixels)} live pixels</b>, ${(v.share * 100).toFixed(2)}% of this epoch so far: about ${sol(v.estPayout)} SOL at the next payout. Earned so far: ${sol(v.earned, 3)} SOL.`
      + (v.holder ? '' : ` It holds ${v.glow === null ? 'an unknown amount of' : fmt(v.glow)} ${cfg.symbol}, under the ${fmt(cfg.minHold)} needed to be paid.`);
  } catch (err) { fail(err.message); }
});

// ---------------- start ----------------
renderNav(); renderCta();
await loadBoard();
connectLive();
loadHistory();
// Reconnect silently if the wallet already trusts this site.
for (const w of listWallets()) {
  if (w.accounts.length) { me.provider = w; me.account = w.accounts[0]; me.wallet = w.accounts[0].address;
    const saved = await idbGet(me.wallet);
    if (saved && saved.expires > Date.now() / 1000 + 60) Object.assign(me, saved);
    renderNav(); await loadBoard(); await refreshWallet(); renderCta(); break; }
}
