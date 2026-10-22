// Offline checks: TWA accounting, session signatures, and that the relayer refuses anything but a claim.
// Run: MIN_HOLD=0 npm test   (MIN_HOLD=0 so holder checks pass without a mint)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountRole, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, generateKeyPair,
  getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction, getUtf8Encoder, partiallySignTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signBytes, address, lamports, createNoopSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { Board } from '../server/board.js';
import { Relay } from '../server/relay.js';
import { buildClaimTransaction, MEMO_PROGRAM, sessionMessage } from '../shared/claim.js';

const BH = { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 100 };

test('TWA: holding longer earns more, overwritten pixels stop counting', () => {
  const b = new Board(); b.epochStart = 0;
  b.apply(0, 0, 1, 'A', 0); b.apply(1, 0, 1, 'A', 0);   // A holds 2 pixels from t=0
  b.apply(0, 0, 2, 'B', 50);                            // B takes one of them at t=50
  b.apply(5, 5, 2, 'B', 99);                            // B adds one right before the end (sniping)
  const twa = b.closeEpoch(100);
  // A: 2 px for 50s + 1 px for 50s = 150 px·s / 100 s = 1.5 ; B: 1 px for 50s + 1 px for 1s = 51/100 = 0.51
  assert.equal(twa.A, 1.5); assert.equal(twa.B, 0.51);
  assert.equal(b.livePixels('A'), 1); assert.equal(b.livePixels('B'), 2);
  const again = b.closeEpoch(200);                      // next epoch starts from the live counts
  assert.equal(again.A, 1); assert.equal(again.B, 2);
});

test('Board survives a save/load round trip', () => {
  const b = new Board(); b.apply(3, 4, 7, 'A'); b.apply(9, 9, 2, 'B');
  const c = Board.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
  assert.equal(c.livePixels('A'), 1); assert.equal(c.colors[4 * 200 + 3], 7); assert.equal(c.live, 2);
});

async function setup() {
  const relayerKp = await generateKeyPair(), walletKp = await generateKeyPair(), sessionKp = await generateKeyPair();
  const relayer = { keyPair: relayerKp, address: await getAddressFromPublicKey(relayerKp.publicKey) };
  const wallet = await getAddressFromPublicKey(walletKp.publicKey), session = await getAddressFromPublicKey(sessionKp.publicKey);
  const relay = new Relay(relayer);
  const expires = Math.floor(Date.now() / 1000) + 3600, nonce = 'n-' + Math.random();
  const sig = await signBytes(walletKp.privateKey, getUtf8Encoder().encode(sessionMessage({ wallet, session, expires, nonce })));
  return { relay, relayer, wallet, session, sessionKp, walletKp, expires, nonce, signature: getBase58Decoder().decode(sig) };
}

test('sessions: valid signature opens one, replay and forgery are refused', async () => {
  const s = await setup();
  const r = await s.relay.openSession({ wallet: s.wallet, session: s.session, expires: s.expires, nonce: s.nonce, signature: s.signature });
  assert.equal(r.wallet, s.wallet);
  await assert.rejects(s.relay.openSession({ wallet: s.wallet, session: s.session, expires: s.expires, nonce: s.nonce, signature: s.signature }), /already used/);
  await assert.rejects(s.relay.openSession({ wallet: s.wallet, session: s.session, expires: s.expires, nonce: 'other', signature: s.signature }), /does not match/);
});

test('relayer co-signs a real claim and refuses everything else', async () => {
  const s = await setup();
  await s.relay.openSession({ wallet: s.wallet, session: s.session, expires: s.expires, nonce: s.nonce, signature: s.signature });
  const wire = async (tx, kps = [s.sessionKp]) => getBase64EncodedWireTransaction(await partiallySignTransaction(kps, tx));

  const ok = await s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: s.session, ...BH, x: 12, y: 34, c: 5 })));
  assert.deepEqual([ok.x, ok.y, ok.c, ok.wallet], [12, 34, 5, s.wallet]);

  // with a priority fee (what the site sends now) it still passes; above the cap it does not
  const fast = await s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: s.session, ...BH, x: 3, y: 4, c: 2, cuPrice: 50_000 })));
  assert.deepEqual([fast.x, fast.y], [3, 4]);
  await assert.rejects(s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: s.session, ...BH, x: 3, y: 4, c: 2, cuPrice: 10_000_000 }))), /Not an a\/place claim/);
  // out-of-range pixel
  await assert.rejects(s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: s.session, ...BH, x: 200, y: 0, c: 1 }))), /coordinates/);
  // someone else as fee payer
  const other = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
  await assert.rejects(s.relay.coSign(await wire(buildClaimTransaction({ relayer: other, session: s.session, ...BH, x: 1, y: 1, c: 1 }))), /Not an a\/place claim/);
  // not signed by the session key
  await assert.rejects(s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: s.session, ...BH, x: 1, y: 1, c: 1 }), [])), /did not sign/);
  // unknown session
  const stranger = await generateKeyPair(), strangerAddr = await getAddressFromPublicKey(stranger.publicKey);
  await assert.rejects(s.relay.coSign(await wire(buildClaimTransaction({ relayer: s.relayer.address, session: strangerAddr, ...BH, x: 1, y: 1, c: 1 }), [stranger])), /Session expired/);
  // drain attempt: transfer from the relayer smuggled in next to a memo
  const drain = pipe(createTransactionMessage({ version: 'legacy' }), (m) => setTransactionMessageFeePayer(s.relayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BH.blockhash, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: MEMO_PROGRAM, accounts: [{ address: s.session, role: AccountRole.READONLY_SIGNER }], data: getUtf8Encoder().encode('pg1:1,1,1') }, m),
    (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(s.relayer.address), destination: address(s.session), amount: lamports(1_000_000_000n) }), m));
  await assert.rejects(s.relay.coSign(await wire(compileTransaction(drain))), /Not an a\/place claim/);
});

test('payouts: each epoch drips a share of the pool, by time-weighted pixels, and nothing is lost', async () => {
  const { planEpoch } = await import('../server/payouts.js');
  const SOL = 1e9, all = new Set(['A', 'B', 'C']);
  // epoch 1: 1 SOL in the pool, 20% drips: A held 3x what B held, C held a tiny bit
  let p = planEpoch({ rewardPool: 1 * SOL, dripRate: 0.2, twa: { A: 300, B: 100, C: 0.2 }, accrued: {}, existing: all, dust: 500_000 });
  assert.equal(p.budget, 0.2 * SOL);
  const paid = Object.fromEntries(p.pay);
  assert.ok(Math.abs(paid.A - 0.15 * SOL) < 1_000_000 && Math.abs(paid.B - 0.05 * SOL) < 1_000_000);
  assert.ok(!('C' in paid) && p.nextAccrued.C > 0);               // C's cut is dust: owed, not lost
  // nobody on the board: nothing leaves, the pool simply waits
  p = planEpoch({ rewardPool: 0.8 * SOL, dripRate: 0.2, twa: {}, accrued: {}, existing: all });
  assert.equal(p.pay.length, 0);
  // over many epochs with steady holders the whole pool reaches them
  // (the wallet balance keeps what is owed as dust apart, exactly like rewardPoolOf does)
  let wallet = 1 * SOL, accrued = {}, out = 0;
  for (let e = 0; e < 60; e++) {
    const owed = Object.values(accrued).reduce((x, y) => x + y, 0);
    const q = planEpoch({ rewardPool: wallet - owed, dripRate: 0.2, twa: { A: 1 }, accrued, existing: all, dust: 500_000 });
    const s = q.pay.reduce((x, [, y]) => x + y, 0); out += s; wallet -= s; accrued = q.nextAccrued;
  }
  assert.ok(out > 0.999 * SOL, `paid ${out}`);
  assert.ok(wallet < 500_000 * 5, `left ${wallet}`);                  // only a dust-sized tail waits for the next fees
  // a new wallet with no SOL account only gets paid once its cut covers the rent-exempt minimum
  p = planEpoch({ rewardPool: 0.004 * SOL, dripRate: 0.2, twa: { N: 1 }, accrued: {}, existing: new Set(), dust: 500_000 });
  assert.equal(p.pay.length, 0); assert.equal(p.nextAccrued.N, 800_000);
});

test('payouts: 20% of the pool a day keeps paying for weeks after trading stops', async () => {
  const { planEpoch } = await import('../server/payouts.js');
  const SOL = 1e9, perEpoch = 1 - Math.pow(0.8, 600 / 86_400), epochsPerDay = 144, all = new Set(['A']);
  let pool = 0, accrued = {};
  const daily = [];
  for (let day = 1; day <= 21; day++) {
    let paidToday = 0;
    for (let e = 0; e < epochsPerDay; e++) {
      if (day <= 7) pool += (10 * SOL) / epochsPerDay;          // 10 SOL of fees a day for a week, then nothing
      const owed = Object.values(accrued).reduce((x, y) => x + y, 0);
      const q = planEpoch({ rewardPool: pool - owed, dripRate: perEpoch, twa: { A: 1 }, accrued, existing: all, dust: 500_000 });
      const s = q.pay.reduce((x, [, y]) => x + y, 0); pool -= s; paidToday += s; accrued = q.nextAccrued;
    }
    daily.push(+(paidToday / SOL).toFixed(2));
  }
  console.log('# paid per day (SOL):', daily.join(' '));
  assert.ok(daily[0] > 0.8 && daily[0] < 1.3);                  // day 1: ~1 SOL out of 10 in
  assert.ok(daily[6] > 6 && daily[6] < 9);                      // day 7: ~8 SOL as the cushion builds
  assert.ok(daily[7] > 5 && daily[13] > 1.5 && daily[20] > 0.3); // trading stopped, payouts carry on for weeks
});

test('a claim that never confirms puts the pixel back, unless it moved on', () => {
  const b = new Board(); b.epochStart = 0;
  b.apply(1, 1, 3, 'A', 0);
  const r = b.apply(1, 1, 5, 'B', 10);                    // B paints over A, then B's tx fails
  assert.ok(b.restore(r.cell, 'B', { owner: r.prevOwner, color: r.prevColor }, 11));
  assert.equal(b.livePixels('A'), 1); assert.equal(b.livePixels('B'), 0); assert.equal(b.colors[r.cell], 3);
  const r2 = b.apply(2, 2, 5, 'B', 12); b.apply(2, 2, 7, 'C', 13); // C took it meanwhile: leave it alone
  assert.equal(b.restore(r2.cell, 'B', { owner: r2.prevOwner, color: r2.prevColor }, 14), false);
  assert.equal(b.livePixels('C'), 1);
});

test('launch watcher: picks the mint from a real pump.fun create, ignores other wallets and trades', async () => {
  const { findLaunchedMint } = await import('../server/launch.js');
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pump-create.json', import.meta.url), 'utf8'));
  const dev = fx.tx.transaction.message.accountKeys[0].pubkey;
  assert.equal(findLaunchedMint(fx.tx, dev), fx.mint);                       // the dev's own launch
  assert.equal(findLaunchedMint(fx.tx, 'So11111111111111111111111111111111111111112'), null); // somebody else's
  const trade = structuredClone(fx.tx);
  trade.meta.logMessages = trade.meta.logMessages.map((l) => l.replace(/Instruction: CreateV2$/, 'Instruction: Buy'));
  assert.equal(findLaunchedMint(trade, dev), null);                          // a buy is not a launch
  const failed = structuredClone(fx.tx); failed.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(findLaunchedMint(failed, dev), null);                         // a failed create is not a launch
});
