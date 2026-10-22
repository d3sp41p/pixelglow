// Give a wallet test $GLOW on devnet. Usage: npm run mint -- <wallet> [amount, default 1,000,000]
import { address } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { config } from '../config.js';
import { loadOrCreateKey, sendInstructions } from '../server/solana.js';

const [wallet, amountArg] = process.argv.slice(2);
if (!wallet || !config.GLOW_MINT) { console.error('Usage: npm run mint -- <wallet> [amount]   (run `npm run setup` first)'); process.exit(1); }
const amount = Number(amountArg || 1_000_000);

const authority = await loadOrCreateKey('mint-authority');
const mint = address(config.GLOW_MINT), owner = address(wallet);
const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const sig = await sendInstructions(authority.signer, [
  getCreateAssociatedTokenIdempotentInstruction({ payer: authority.signer, ata, owner, mint }),
  getMintToInstruction({ mint, token: ata, mintAuthority: authority.signer, amount: BigInt(Math.round(amount * 1e6)) }),
]);
console.log(`Minted ${amount.toLocaleString('en-US')} test $GLOW to ${wallet}\n  ${sig}`);
process.exit(0);
