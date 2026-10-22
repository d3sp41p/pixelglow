// Demo traffic: a few scripted players with real sessions grow territories with real devnet transactions,
// so the board and the live feed move while you show the site. Every click costs the relayer one network fee.
// Usage: npm run bots -- <server url> [players=3] [seconds=60] [clicks per second per player=2]
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction, getUtf8Encoder, partiallySignTransaction, signBytes } from '@solana/kit';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildClaimTransaction, sessionMessage } from '../shared/claim.js';
import { sleep } from '../server/solana.js';

const [BASE = 'http://localhost:8787', nArg = '3', secArg = '60', rateArg = '2'] = process.argv.slice(2);
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.message); return j;
};
const cfg = await api('/api/config');
const mintScript = fileURLToPath(new URL('./mint-to.js', import.meta.url));

async function player(k) {
  const wallet = await generateKeyPair(), session = await generateKeyPair();
  const w = await getAddressFromPublicKey(wallet.publicKey), sAddr = await getAddressFromPublicKey(session.publicKey);
  execFileSync(process.execPath, ['--no-warnings', mintScript, w, '20000'], { stdio: 'ignore' });
  const expires = Math.floor(Date.now() / 1000) + 3600, nonce = crypto.randomUUID();
  const sig = await signBytes(wallet.privateKey, getUtf8Encoder().encode(sessionMessage({ wallet: w, session: sAddr, expires, nonce })));
  await api('/api/session', { wallet: w, session: sAddr, expires, nonce, signature: getBase58Decoder().decode(sig) });
  const p = { w, sAddr, session, c: 1 + ((k * 5) % cfg.palette.length), x: 20 + Math.random() * 160, y: 15 + Math.random() * 80, ok: 0, fail: 0 };
  console.log(`bot ${k + 1}: ${w}`);
  return p;
}

async function click(p) {
  // a random walk around its home, so each bot grows a blob rather than noise
  p.x = Math.max(0, Math.min(cfg.cols - 1, p.x + (Math.random() * 6 - 3)));
  p.y = Math.max(0, Math.min(cfg.rows - 1, p.y + (Math.random() * 6 - 3)));
  const { blockhash, lastValidBlockHeight } = await api('/api/config');
  let tx = buildClaimTransaction({ relayer: cfg.relayer, session: p.sAddr, blockhash, lastValidBlockHeight, x: p.x | 0, y: p.y | 0, c: p.c });
  tx = await partiallySignTransaction([p.session], tx);
  try { await api('/api/claim', { tx: getBase64EncodedWireTransaction(tx) }); p.ok++; } catch { p.fail++; }
}

const bots = [];
for (let k = 0; k < +nArg; k++) bots.push(await player(k));
const until = Date.now() + +secArg * 1000, gap = 1000 / +rateArg;
console.log(`clicking for ${secArg}s…`);
await Promise.all(bots.map(async (p) => { while (Date.now() < until) { click(p); await sleep(gap * (0.5 + Math.random())); } }));
await sleep(3000);
console.log(bots.map((p, k) => `bot ${k + 1}: ${p.ok} landed, ${p.fail} failed`).join('\n'));
process.exit(0);
