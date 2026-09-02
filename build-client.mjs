/**
 * 构建 client 插件：esbuild 把 client-src/index.jsx 打包为 CJS，再 wrap 成
 * window.__ModuleLoader__ 格式（DSH web shell 在 /plugins/dsh-wechat/client.js 提供）。
 * 参考 dsh-chatops scripts/wrap-client.mjs。
 */
import { build } from 'esbuild'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// 插件注册 id 动态取自 package.json 的 name——改名后无需改构建脚本。
const pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['client-src/index.jsx'],
  outfile: 'lib/client.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  minify: false,
  logLevel: 'info',
})

const source = 'lib/client.cjs'
const bundled = readFileSync(source, 'utf8')
if (bundled.includes('__ModuleLoader__')) {
  console.error('wrap-client: output already wrapped?')
  process.exit(1)
}

const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkgName)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${bundled}
		return module.exports;
	}
});
`

writeFileSync('lib/client.js', wrapped)
console.log(`wrap-client: wrapped ${source} -> lib/client.js (${wrapped.length} bytes)`)