#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { startFfvideo, defaultDataDir } from '../server/index.mjs';
import { serveMcp } from '../server/mcp.mjs';
import { openPreview } from '../../bin/open-preview.mjs';
import { createHostConfig } from '../hosts/config.mjs';
const root = fileURLToPath(new URL(existsSync(new URL('../package.json', import.meta.url)) ? '../' : '../../', import.meta.url));
const options = { dataDir: defaultDataDir(), staticDir: join(root, 'dist/web'), samplesDir: join(root, 'dist/samples'), roots: [], providerOptions: {} };
let mcp = false, open = false, channels = false, host = 'generic', printConfig;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('ffvideo — local personal video feed\n\nffvideo [--open] [--mcp] [--port 4320] [--data-dir DIR]\n  --host generic|codex|claude|codebuddy|workbuddy|qoder\n  --channels                 Explicit Claude/CodeBuddy channel push opt-in\n  --provider agent|codex|command   agent uses the connected MCP host; codex runs a separate background recipe worker\n  --speech native|browser     macOS installed speech or shared Kokoro browser speech\n  --codex-command PATH --model MODEL\n  --generator-command-config FILE   JSON {command,args}; receives JSON stdin, returns one recipe JSON\n  --codex-bridge-url ws://127.0.0.1:PORT --thread-id ID   Explicit connection to a running host thread\n  --print-host-config HOST    Print configuration only, do not change user settings\n  --listen-host HOST --public-url HTTPS_URL   Remote transport configuration\n  FFVIDEO_MCP_TOKEN protects remote MCP; models are never downloaded automatically.\n');
      process.exit(0);
    }
    if (arg === '--mcp') { mcp = true; continue; } if (arg === '--open') { open = true; continue; }
    if (arg === '--channels') { channels = true; continue; }
    if (!['--data-dir', '--port', '--root', '--host', '--provider', '--speech', '--codex-command', '--model', '--generator-command-config', '--codex-bridge-url', '--thread-id', '--print-host-config', '--listen-host', '--public-url'].includes(arg) || !args[i + 1]) throw new Error('Unknown or incomplete option: ' + arg);
    const value = args[++i];
    if (arg === '--data-dir') options.dataDir = resolve(value);
    if (arg === '--root') options.roots.push(resolve(value));
    if (arg === '--port') { options.port = Number(value); if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port'); }
    if (arg === '--host') host = value;
    if (arg === '--provider') options.provider = value;
    if (arg === '--speech') { if (!['native', 'browser'].includes(value)) throw new Error('Invalid speech backend'); options.speech = value; }
    if (arg === '--codex-command') options.providerOptions.command = value;
    if (arg === '--model') options.providerOptions.model = value;
    if (arg === '--generator-command-config') { const config = JSON.parse(await readFile(resolve(value), 'utf8')); if (typeof config.command !== 'string' || !Array.isArray(config.args) || !config.args.every(a => typeof a === 'string')) throw new Error('Generator config must have command and args'); Object.assign(options.providerOptions, config); }
    if (arg === '--codex-bridge-url') { options.bridgeOptions ||= {}; options.bridgeOptions.url = value; }
    if (arg === '--thread-id') { options.bridgeOptions ||= {}; options.bridgeOptions.threadId = value; }
    if (arg === '--print-host-config') printConfig = value;
    if (arg === '--listen-host') options.host = value;
    if (arg === '--public-url') options.publicUrl = value;
  }
  if (printConfig) { process.stdout.write(JSON.stringify(createHostConfig(printConfig, { directory: options.dataDir,
    command: process.execPath, args: [resolve(process.argv[1]), '--mcp'], channels, url: options.publicUrl ? options.publicUrl.replace(/\/$/, '') + '/mcp' : undefined }), null, 2) + '\n'); process.exit(0); }
  // A standalone viewer has no MCP agent to claim its queue. Saved and explicit
  // choices take precedence over the new-library browser default.
  const server = await startFfvideo({ ...options, defaultProvider: mcp ? 'agent' : 'codex' });
  process.stderr.write('ffvideo: ' + server.url + '\n');
  if (open) {
    const viewer = new URL(server.viewerUrl);
    if (options.publicUrl && process.env.FFVIDEO_MCP_TOKEN) viewer.searchParams.set('token', process.env.FFVIDEO_MCP_TOKEN);
    await openPreview(viewer.href);
  }
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); };
  process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
  if (mcp) {
    server.setAgentConnected(true);
    await serveMcp(server.mcpHandler, { store: server.store, channels, host });
    await close();
  }
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
