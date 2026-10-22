// Sessions (§1.3) and the relayer that co-signs claims as fee payer.
// The relayer signs ONLY a transaction that matches the claim template exactly, so it can never be
// tricked into paying for anything else or moving its own funds.
import {
  getAddressFromPublicKey, getBase64EncodedWireTransaction, getBase64Encoder, getBase58Encoder,
  getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, getUtf8Decoder, getUtf8Encoder, partiallySignTransaction, verifySignature,
} from '@solana/kit';
import { config } from '../config.js';
import { CLAIM_CU_LIMIT, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, parseMemo, sessionMessage } from '../shared/claim.js';
import { isHolder, isHolderFast } from './solana.js';

export class ClaimError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export class Relay {
  constructor(relayer) {
    this.relayer = relayer;                 // { keyPair, address }
    this.sessions = new Map();              // session address -> { wallet, expires }
    this.nonces = new Set();
    this.buckets = new Map();               // wallet -> { tokens, t } rate limit
    this.day = new Date().toISOString().slice(0, 10); this.dayCount = 0;
  }

  // The wallet signed sessionMessage(...) once; from now on the session key signs every claim.
  async openSession({ wallet, session, expires, nonce, signature }) {
    const now = Date.now() / 1000;
    if (!wallet || !session || !signature || !nonce) throw new ClaimError('bad_request', 'Missing fields.');
    if (!(expires > now && expires <= now + config.SESSION_TTL_SEC + 120)) throw new ClaimError('bad_expiry', 'Session expiry is out of range.');
    if (this.nonces.has(nonce)) throw new ClaimError('replay', 'This session request was already used.');
    let sig;
    try { sig = getBase58Encoder().encode(signature); } catch { throw new ClaimError('bad_signature', 'Signature is not base58.'); }
    const ok = await verifySignature(await getPublicKeyFromAddress(wallet), sig,
      getUtf8Encoder().encode(sessionMessage({ wallet, session, expires, nonce })));
    if (!ok) throw new ClaimError('bad_signature', 'The wallet signature does not match.');
    this.nonces.add(nonce);
    this.sessions.set(session, { wallet, expires });
    return { wallet, session, expires, holder: await isHolder(wallet, 0).catch(() => null) };
  }

  sessionWallet(session) {
    const s = this.sessions.get(session);
    if (!s) return null;
    if (s.expires < Date.now() / 1000) { this.sessions.delete(session); return null; }
    return s.wallet;
  }

  rateOk(wallet) {
    const now = Date.now() / 1000, cap = config.MAX_CLAIMS_PER_SEC;
    const b = this.buckets.get(wallet) || { tokens: cap, t: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.t) * cap); b.t = now;
    if (b.tokens < 1) { this.buckets.set(wallet, b); return false; }
    b.tokens -= 1; this.buckets.set(wallet, b); return true;
  }

  // Validate a partially signed claim, add the fee-payer signature, return what to send.
  async coSign(base64Wire) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.dayCount = 0; }
    if (this.dayCount >= config.RELAYER_DAILY_TX_CAP) throw new ClaimError('cap', 'The daily pixel budget is used up. Try again tomorrow.');

    let tx, msg;
    try {
      tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64Wire));
      msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    } catch { throw new ClaimError('malformed', 'Could not decode the transaction.'); }

    // Exactly: [relayer (fee payer), session (readonly signer), then only the memo and compute budget programs].
    // One memo instruction signed by the session; at most one unit limit and one unit price, both capped,
    // because the relayer pays for them.
    const a = msg.staticAccounts, h = msg.header, ix = msg.instructions;
    const programs = a.slice(2);
    let shapeOk = msg.version === 'legacy' && a[0] === this.relayer.address && h.numSignerAccounts === 2 && h.numReadonlySignerAccounts === 1
      && h.numReadonlyNonSignerAccounts === programs.length && programs.includes(MEMO_PROGRAM)
      && programs.every((p) => p === MEMO_PROGRAM || p === COMPUTE_BUDGET_PROGRAM) && new Set(programs).size === programs.length;
    let memoIx = null, seen = new Set();
    for (const i of shapeOk ? ix : []) {
      const prog = a[i.programAddressIndex], d = i.data || new Uint8Array();
      if (prog === MEMO_PROGRAM && !memoIx && i.accountIndices?.length === 1 && i.accountIndices[0] === 1) { memoIx = i; continue; }
      if (prog === COMPUTE_BUDGET_PROGRAM && !(i.accountIndices?.length) && !seen.has(d[0])) {
        seen.add(d[0]);
        const n = d.reduce((v, b, k) => (k ? v + BigInt(b) * 256n ** BigInt(k - 1) : v), 0n);
        if (d[0] === 2 && d.length === 5 && n <= BigInt(CLAIM_CU_LIMIT)) continue;               // unit limit
        if (d[0] === 3 && d.length === 9 && n <= BigInt(config.MAX_PRIORITY_MICROLAMPORTS)) continue; // unit price
      }
      shapeOk = false;
    }
    if (!shapeOk || !memoIx) throw new ClaimError('shape', 'Not an a/place claim.');

    const session = a[1];
    const claim = parseMemo(getUtf8Decoder().decode(memoIx.data), config.COLS, config.ROWS, config.PALETTE.length);
    if (!claim) throw new ClaimError('memo', 'Bad pixel coordinates or colour.');

    const sessionSig = tx.signatures[session];
    if (!sessionSig || !(await verifySignature(await getPublicKeyFromAddress(session), sessionSig, tx.messageBytes)))
      throw new ClaimError('unsigned', 'The session key did not sign this claim.');

    if (!config.GLOW_MINT) throw new ClaimError('not_launched', 'Drawing opens the moment a/place launches.');
    const wallet = this.sessionWallet(session);
    if (!wallet) throw new ClaimError('no_session', 'Session expired. Sign in again.');
    let holder;
    try { holder = await isHolderFast(wallet); } catch { throw new ClaimError('rpc_busy', 'The network is busy. Try again in a moment.'); }
    if (!holder) throw new ClaimError('not_holder', `Hold at least ${config.MIN_HOLD.toLocaleString('en-US')} ${config.TOKEN_SYMBOL} to draw.`);
    if (!this.rateOk(wallet)) throw new ClaimError('rate', 'Slow down a little.');

    const signed = await partiallySignTransaction([this.relayer.keyPair], tx);
    this.dayCount++;
    return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed), wallet, ...claim };
  }
}

export { getAddressFromPublicKey };
