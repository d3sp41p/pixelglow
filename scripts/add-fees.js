// Simulate creator fees arriving in the pool wallet on devnet. Usage: npm run fees -- [SOL, default 0.2]
// On mainnet this is not needed: point the pump.fun creator-fee recipient at the pool wallet instead.
import { address, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { config } from '../config.js';
import { loadOrCreateKey, rpc, sendInstructions, solBalance, waitForConfirmation } from '../server/solana.js';

const sol = Number(process.argv[2] || 0.2);
const pool = await loadOrCreateKey('pool');
const authority = await loadOrCreateKey('mint-authority');
const amount = lamports(BigInt(Math.round(sol * 1e9)));

if ((await solBalance(authority.address)) > sol * 1e9 + 0.01e9) {
  const sig = await sendInstructions(authority.signer, [getTransferSolInstruction({ source: authority.signer, destination: address(pool.address), amount })]);
  console.log(`Sent ${sol} SOL of "fees" to the pool ${pool.address}\n  ${sig}`);
} else {
  const sig = await rpc.requestAirdrop(address(pool.address), amount, { commitment: 'confirmed' }).send();
  const r = await waitForConfirmation(sig);
  console.log(r.ok ? `Airdropped ${sol} SOL of "fees" to the pool ${pool.address}` : `Airdrop failed: ${JSON.stringify(r.err)}`);
}
console.log(`Pool balance: ${(await solBalance(pool.address)) / 1e9} SOL (${config.CLUSTER})`);
process.exit(0);
