// End-to-end check on devnet with two scripted players going through the same API the browser uses:
// mint test $GLOW, sign a session once, claim pixels (real transactions), overwrite each other, then wait for a payout.
// Usage: start the server with a short epoch (EPOCH_SEC=60 npm start), then: npm run e2e -- [http://localhost:8787]
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction, getUtf8Encoder, partiallySignTransaction, signBytes } from '@solana/kit';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildClaimTransaction, sessionMessage } from '../shared/claim.js';
import { sleep } from '../server/solana.js';

const BASE = process.argv[2] || 'http://localhost:8787';
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.message}`); return j;
};
const cfg = await api('/api/config');
const mintScript = fileURLToPath(new URL('./mint-to.js', import.meta.url));

async function player(name, glow) {
  const wallet = await generateKeyPair(), session = await generateKeyPair();
  const p = { name, wallet: await getAddressFromPublicKey(wallet.publicKey), sessionAddr: await getAddressFromPublicKey(session.publicKey), session };
  if (glow) execFileSync(process.execPath, ['--no-warnings', mintScript, p.wallet, String(glow)], { stdio: 'inherit' });
  const expires = Math.floor(Date.now() / 1000) + 3600, nonce = crypto.randomUUID();
  const sig = await signBytes(wallet.privateKey, getUtf8Encoder().encode(sessionMessage({ wallet: p.wallet, session: p.sessionAddr, expires, nonce })));
  const r = await api('/api/session', { wallet: p.wallet, session: p.sessionAddr, expires, nonce, signature: getBase58Decoder().decode(sig) });
  console.log(`${name}: wallet ${p.wallet}, session opened, holder=${r.holder}`);
  return p;
}

async function claim(p, x, y, c) {
  const { blockhash, lastValidBlockHeight } = await api('/api/config');
  let tx = buildClaimTransaction({ relayer: cfg.relayer, session: p.sessionAddr, blockhash, lastValidBlockHeight, x, y, c });
  tx = await partiallySignTransaction([p.session], tx);
  return api('/api/claim', { tx: getBase64EncodedWireTransaction(tx) });
}

const alice = await player('alice', 50_000);
const bob = await player('bob', 50_000);
const carol = await player('carol', 0); // holds nothing: must be refused

// Alice claims a 4x2 block, in parallel like fast clicking.
const t0 = Date.now();
const res = await Promise.all([...Array(8)].map((_, k) => claim(alice, 10 + (k % 4), 10 + (k >> 2), 1)));
console.log(`alice: 8 claims confirmed in ${Date.now() - t0} ms total, per-claim ${res.map((r) => r.ms).join(', ')} ms`);
console.log(`  first: https://explorer.solana.com/tx/${res[0].signature}?cluster=${cfg.cluster}`);

// Bob paints over two of them.
for (const [x, y] of [[10, 10], [11, 10]]) { const r = await claim(bob, x, y, 7); console.log(`bob: took (${x},${y}) in ${r.ms} ms`); }

try { await claim(carol, 50, 50, 3); console.log('carol: UNEXPECTED: claim accepted'); process.exitCode = 1; }
catch (e) { console.log(`carol: refused as expected (${e.message})`); }

const a = await api('/api/wallet/' + alice.wallet), b = await api('/api/wallet/' + bob.wallet);
console.log(`alice: ${a.livePixels} live pixels, share ${(a.share * 100).toFixed(1)}%   bob: ${b.livePixels} live pixels, share ${(b.share * 100).toFixed(1)}%`);
if (a.livePixels !== 6 || b.livePixels !== 2) { console.log('UNEXPECTED live pixel counts'); process.exitCode = 1; }

// Wait for the epoch to close and check that both were paid on-chain.
const { epochEnd } = await api('/api/stats');
const wait = Math.max(0, epochEnd * 1000 - Date.now()) + 20_000;
console.log(`waiting ${Math.round(wait / 1000)} s for the epoch payout…`);
await sleep(wait);
const a2 = await api('/api/wallet/' + alice.wallet), b2 = await api('/api/wallet/' + bob.wallet);
for (const [n, v] of [['alice', a2], ['bob', b2]]) {
  const last = v.payouts[0];
  console.log(`${n}: earned ${v.earned / 1e9} SOL, accrued ${v.accrued / 1e9} SOL` + (last ? `  https://explorer.solana.com/tx/${last.sig}?cluster=${cfg.cluster}` : ''));
}
const s = await api('/api/stats');
console.log('last epoch:', JSON.stringify(s.history[0]));
process.exit(process.exitCode || 0);
