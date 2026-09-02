import { defineConfig } from 'tsdown'

// Two build halves:
//  - host:   ESM bundle at package root (main: index.js); @deepseek-ai/* and
//            channel SDKs stay external (profile provides / lazy-loaded).
//  - client: ONE CJS browser bundle at lib/client.js, wrapped by
//            scripts/wrap-client.mjs into the window.__ModuleLoader__ format
//            the web shell serves at /plugins/dsh-chatops/client.js.
export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    format: ['esm'],
    platform: 'node',
    outDir: '.',
    // The bundle lands at the package root (main: index.js), so cleaning the
    // outDir would mean cleaning the package itself — always off.
    clean: false,
    // Emit index.js (not index.mjs) to match package.json "main".
    fixedExtension: false,
    minify: false,
    sourcemap: false,
    external: [/^@deepseek-ai\//, 'wechaty', /^wechaty-puppet-/, 'qrcode-terminal', 'qrcode', '@larksuiteoapi/node-sdk', 'dingtalk-stream', '@wecom/aibot-node-sdk'],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    outDir: 'lib',
    clean: false,
    minify: false,
    sourcemap: false,
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', /^@deepseek-ai\//],
  },
])
