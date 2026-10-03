import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFfvideo } from '../server/index.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await startFfvideo({ dataDir: process.env.FFVIDEO_DATA_DIR,
  staticDir: root + 'dist/web', samplesDir: root + 'assets/samples' });
const vite = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)), '--config', root + 'vite.config.mjs'],
  { stdio: 'inherit', env: { ...process.env, FFVIDEO_SERVER: server.url } });
let closing = false;
async function close() { if (closing) return; closing = true; vite.kill(); await server.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close); vite.on('exit', close);
