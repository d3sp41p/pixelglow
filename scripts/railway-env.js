// Prints the environment variables the Railway server needs, ready to paste into Railway → Variables → Raw Editor.
// Writes them to railway.env (git-ignored). These are PRIVATE KEYS: paste them only into Railway.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const key = (n) => readFileSync(join(config.KEYS_DIR, `${n}.json`), 'utf8').trim();
const site = process.argv[2] || 'https://<your-project>.vercel.app';
const lines = [
  `CLUSTER=${config.CLUSTER}`,
  `RPC_URL=${config.RPC_URL}`,
  `RPC_WS_URL=${config.RPC_WS_URL}`,
  `GLOW_MINT=${config.GLOW_MINT}`,
  `RELAYER_KEY=${key('relayer')}`,
  `POOL_KEY=${key('pool')}`,
  `DATA_DIR=/data`,
  `ALLOWED_ORIGINS=${site}`,
];
writeFileSync('railway.env', lines.join('\n') + '\n');
console.log('Wrote railway.env (keep it private). Variables:', lines.map((l) => l.split('=')[0]).join(', '));
