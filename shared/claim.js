// Shared by the browser and the server: how a claim transaction looks.
// A claim is one legacy transaction with exactly one Memo instruction:
//   fee payer  = the project's relayer (pays the network fee)
//   signer     = the player's session key (proves who clicked)
//   memo       = "pg1:<x>,<y>,<color>"
import {
  AccountRole, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage,
  getUtf8Encoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
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

export function buildClaimTransaction({ relayer, session, blockhash, lastValidBlockHeight, x, y, c }) {
  const ix = {
    programAddress: MEMO_PROGRAM,
    accounts: [{ address: session, role: AccountRole.READONLY_SIGNER }],
    data: getUtf8Encoder().encode(encodeMemo(x, y, c)),
  };
  const msg = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(relayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  return compileTransaction(msg);
}

// The text the player's wallet signs once to authorise a session key (§1.3).
export const sessionMessage = ({ wallet, session, expires, nonce }) =>
  `Pixelglow session\n\nI allow this session key to claim pixels for my wallet. It cannot move funds.\n\nwallet: ${wallet}\nsession: ${session}\nexpires: ${new Date(expires * 1000).toISOString()}\nnonce: ${nonce}`;
