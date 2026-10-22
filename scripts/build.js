// Bundles the browser client into public/app.js.
// PIXELGLOW_API = the server's public URL when the site is hosted apart from it (Vercel → Railway); empty for local dev.
import { build } from 'esbuild';

const api = (process.env.PIXELGLOW_API || '').trim();
await build({
  entryPoints: ['client/app.js'], bundle: true, format: 'esm', target: 'es2022', minify: true,
  outfile: 'public/app.js', define: { API_BASE: JSON.stringify(api) }, logLevel: 'info',
});
console.log(api ? `client talks to ${api}` : 'client talks to its own origin');
