import { build as buildWeb } from 'vite';
import { build as bundle } from 'esbuild';
import { rm, cp, mkdir, copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await buildWeb({ configFile: join(root, 'vite.config.mjs') });
await cp(join(root, 'assets/samples'), join(dist, 'samples'), { recursive: true });
// The registry JSON is bundled, while the controlled graphics read local
// fixture files relative to dist/bin. Ship both examples and those resources.
await cp(join(root, 'templates'), join(dist, 'templates'), { recursive: true });
await bundle({ entryPoints: [join(root, 'bin/ffvideo.mjs')], outdir: join(dist, 'bin'),
  outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  minify: true, sourcemap: false, sourcesContent: false, legalComments: 'none' });
await chmod(join(dist, 'bin/ffvideo.mjs'), 0o755);
await mkdir(join(dist, 'licenses'), { recursive: true });
await copyFile(join(root, 'LICENSE'), join(dist, 'licenses/ffvideo-MIT.txt'));
await copyFile(new URL('../../node_modules/mediabunny/LICENSE', import.meta.url), join(dist, 'licenses/Mediabunny-MPL-2.0.txt'));
await copyFile(new URL('../../node_modules/gsap/dist/gsap.min.js', import.meta.url), join(dist, 'gsap-runtime.js'));
// A plugin host copies only its plugin root into the installation cache. Keep
// every runtime dependency inside that root; no global executable or npm fetch.
for (const product of ['codex', 'claude']) {
  const source = join(root, 'plugins', product);
  try {
    await readFile(join(source, product === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json'));
    const destination = join(dist, 'plugins', product);
    await cp(source, destination, { recursive: true });
    await copyFile(join(root, 'LICENSE'), join(destination, 'LICENSE'));
    await cp(join(root, 'skills'), join(destination, 'skills'), { recursive: true });
    await cp(join(root, 'templates'), join(destination, 'templates'), { recursive: true });
    const runtime = join(destination, 'runtime');
    await mkdir(join(runtime, 'dist'), { recursive: true });
    const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(runtime, 'package.json'), JSON.stringify({
      name: packageInfo.name, version: packageInfo.version, type: 'module',
      private: true, license: packageInfo.license, engines: packageInfo.engines
    }, null, 2) + '\n');
    await copyFile(join(root, 'LICENSE'), join(runtime, 'LICENSE'));
    for (const component of ['bin', 'web', 'samples', 'licenses', 'templates'])
      await cp(join(dist, component), join(runtime, 'dist', component), { recursive: true });
    await copyFile(join(dist, 'gsap-runtime.js'), join(runtime, 'dist/gsap-runtime.js'));
    const pluginRoot = product === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}';
    await writeFile(join(destination, '.mcp.json'), JSON.stringify({ mcpServers: { ffvideo: {
      command: 'node', args: [pluginRoot + '/runtime/dist/bin/ffvideo.mjs', '--mcp', '--port', '0']
    } } }, null, 2) + '\n');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.stderr.write('ffvideo built in ' + dist + '\n');
