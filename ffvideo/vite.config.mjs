import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { textTemplateAssets } from '../scripts/text-assets.mjs';
import { ttsRuntimeAssets } from '../scripts/tts-assets.mjs';
import { asrRuntimeAssets } from '../scripts/asr-assets.mjs';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue(), textTemplateAssets(), ttsRuntimeAssets(), asrRuntimeAssets()],
  publicDir: false,
  worker: { format: 'es' },
  build: { outDir: 'dist/web', target: 'es2022', sourcemap: false },
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: Object.fromEntries(['/ffapi', '/api', '/tts-models', '/asr-models', '/vision-models', '/project-resources'].map(path => [path, {
      target: process.env.FFVIDEO_SERVER || 'http://127.0.0.1:4320', changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', req => req.removeHeader('origin')); }
    }]))
  }
});
