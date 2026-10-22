// One-time devnet setup: keys for the relayer, pool and mint authority, devnet SOL, and a test $GLOW mint.
// Only the mint authority needs devnet SOL (one faucet request); it then funds the relayer and the pool.
// Usage: npm run setup
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, generateKeyPairSigner, lamports } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getInitializeMint2Instruction, getMintSize, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { config } from '../config.js';
import { loadOrCreateKey, rpc, sendInstructions, sleep, solBalance, waitForConfirmation } from '../server/solana.js';

if (config.CLUSTER !== 'devnet') { console.error('setup-devnet only runs against devnet.'); process.exit(1); }

const relayer = await loadOrCreateKey('relayer');
const pool = await loadOrCreateKey('pool');
const authority = await loadOrCreateKey('mint-authority');
const SOL = 1e9;

async function airdrop(who, sol) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sig = await rpc.requestAirdrop(address(who), lamports(BigInt(sol * SOL)), { commitment: 'confirmed' }).send();
      const r = await waitForConfirmation(sig, 60_000);
      if (r.ok) return true;
    } catch (e) { console.log(`  airdrop attempt ${attempt} refused: ${e.message.split('\n')[0]}`); }
    await sleep(4000 * attempt);
  }
  return false;
}

console.log(`mint authority ${authority.address}`);
let have = await solBalance(authority.address);
if (have < 0.5 * SOL) {
  console.log('  asking the devnet faucet for 1 SOL…');
  if (!(await airdrop(authority.address, 1))) {
    console.log(`\nThe public faucet is rate-limited right now. Send devnet SOL (1 or more) to:\n\n  ${authority.address}\n\nat https://faucet.solana.com (sign in with GitHub for a higher limit), then run \`npm run setup\` again.`);
    process.exit(1);
  }
  have = await solBalance(authority.address);
}
console.log(`  balance ${have / SOL} SOL`);

// Fund the relayer (pays every claim's network fee) and the pool (gas reserve for payouts).
for (const [name, who, want] of [['relayer', relayer, 0.2], ['pool', pool, 0.1]]) {
  const bal = await solBalance(who.address);
  if (bal >= want * SOL * 0.5) { console.log(`${name.padEnd(8)} ${who.address}  ${bal / SOL} SOL`); continue; }
  await sendInstructions(authority.signer, [getTransferSolInstruction({ source: authority.signer, destination: address(who.address), amount: lamports(BigInt(want * SOL)) })]);
  console.log(`${name.padEnd(8)} ${who.address}  +${want} SOL`);
}

const metaFile = join(config.KEYS_DIR, 'devnet.json');
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
if (meta.mint) {
  console.log(`\n$GLOW mint already exists: ${meta.mint}`);
} else {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await sendInstructions(authority.signer, [
    getCreateAccountInstruction({ payer: authority.signer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority.address }),
  ]);
  meta.mint = mint.address; meta.decimals = 6;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`\nCreated test $GLOW mint: ${mint.address}`);
}
console.log('\nNext: give your wallet test $GLOW with `npm run mint -- <your wallet address>`, then `npm run dev`.');
process.exit(0);
