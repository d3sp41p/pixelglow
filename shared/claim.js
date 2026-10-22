// Shared by the browser and the server: how a claim transaction looks.
// A claim is one legacy transaction with one Memo instruction, optionally preceded by the two
// Compute Budget instructions (unit limit, unit price) that get it into the next block:
//   fee payer  = the project's relayer (pays the network fee)
//   signer     = the player's session key (proves who clicked)
//   memo       = "pg1:<x>,<y>,<color>"
import {
  AccountRole, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage,
  getUtf8Encoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const CLAIM_CU_LIMIT = 30_000; // a claim uses 19,100–20,600 compute units on mainnet (memo with one signer)
const le = (n, bytes) => { const out = new Uint8Array(bytes); let v = BigInt(n); for (let i = 0; i < bytes; i++) { out[i] = Number(v & 255n); v >>= 8n; } return out; };
const cuLimitIx = (units) => ({ programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, ...le(units, 4)]) });
const cuPriceIx = (microLamports) => ({ programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, ...le(microLamports, 8)]) });
export const MEMO_PREFIX = 'pg1:';

export const encodeMemo = (x, y, c) => `${MEMO_PREFIX}${x},${y},${c}`;

export function parseMemo(text, cols, rows, colors) {
  if (!text.startsWith(MEMO_PREFIX)) return null;
  const m = /^(\d{1,3}),(\d{1,3}),(\d{1,2})$/.exec(text.slice(MEMO_PREFIX.length));
  if (!m) return null;
  const x = +m[1], y = +m[2], c = +m[3];
  if (x >= cols || y >= rows || c < 1 || c > colors) return null;
  return { x, y, c };
}

export function buildClaimTransaction({ relayer, session, blockhash, lastValidBlockHeight, x, y, c, cuPrice = 0 }) {
  const ix = {
    programAddress: MEMO_PROGRAM,
    accounts: [{ address: session, role: AccountRole.READONLY_SIGNER }],
    data: getUtf8Encoder().encode(encodeMemo(x, y, c)),
  };
  const msg = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(relayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    (m) => (cuPrice > 0 ? appendTransactionMessageInstruction(cuPriceIx(cuPrice), appendTransactionMessageInstruction(cuLimitIx(CLAIM_CU_LIMIT), m)) : m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  return compileTransaction(msg);
}

// The text the player's wallet signs once to authorise a session key (§1.3).
export const sessionMessage = ({ wallet, session, expires, nonce }) =>
  `Pixelglow session\n\nI allow this session key to claim pixels for my wallet. It cannot move funds.\n\nwallet: ${wallet}\nsession: ${session}\nexpires: ${new Date(expires * 1000).toISOString()}\nnonce: ${nonce}`;
