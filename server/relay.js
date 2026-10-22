// Sessions (§1.3) and the relayer that co-signs claims as fee payer.
// The relayer signs ONLY a transaction that matches the claim template exactly, so it can never be
// tricked into paying for anything else or moving its own funds.
import {
  getAddressFromPublicKey, getBase64EncodedWireTransaction, getBase64Encoder, getBase58Encoder,
  getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, getUtf8Decoder, getUtf8Encoder, partiallySignTransaction, verifySignature,
} from '@solana/kit';
import { config } from '../config.js';
import { MEMO_PROGRAM, parseMemo, sessionMessage } from '../shared/claim.js';
import { isHolder } from './solana.js';

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

    // Exactly: [relayer (fee payer), session (readonly signer), memo program], one memo instruction.
    const a = msg.staticAccounts, h = msg.header, ix = msg.instructions;
    const shapeOk = msg.version === 'legacy' && a.length === 3 && a[0] === this.relayer.address && a[2] === MEMO_PROGRAM
      && h.numSignerAccounts === 2 && h.numReadonlySignerAccounts === 1 && h.numReadonlyNonSignerAccounts === 1
      && ix.length === 1 && ix[0].programAddressIndex === 2 && ix[0].accountIndices?.length === 1 && ix[0].accountIndices[0] === 1;
    if (!shapeOk) throw new ClaimError('shape', 'Not a Pixelglow claim.');

    const session = a[1];
    const claim = parseMemo(getUtf8Decoder().decode(ix[0].data), config.COLS, config.ROWS, config.PALETTE.length);
    if (!claim) throw new ClaimError('memo', 'Bad pixel coordinates or colour.');

    const sessionSig = tx.signatures[session];
    if (!sessionSig || !(await verifySignature(await getPublicKeyFromAddress(session), sessionSig, tx.messageBytes)))
      throw new ClaimError('unsigned', 'The session key did not sign this claim.');

    const wallet = this.sessionWallet(session);
    if (!wallet) throw new ClaimError('no_session', 'Session expired. Sign in again.');
    let holder;
    try { holder = await isHolder(wallet); } catch { throw new ClaimError('rpc_busy', 'The network is busy. Try again in a moment.'); }
    if (!holder) throw new ClaimError('not_holder', `Hold at least ${config.MIN_HOLD.toLocaleString('en-US')} $GLOW to draw.`);
    if (!this.rateOk(wallet)) throw new ClaimError('rate', 'Slow down a little.');

    const signed = await partiallySignTransaction([this.relayer.keyPair], tx);
    this.dayCount++;
    return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed), wallet, ...claim };
  }
}

export { getAddressFromPublicKey };
