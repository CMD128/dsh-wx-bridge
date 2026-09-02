// Wrap the tsdown CJS client output into the DSH client bundle format:
// a classic script that registers its factory with window.__ModuleLoader__.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const candidates = ['lib/client.cjs', 'lib/client.js']
const source = candidates.find((path) => existsSync(path))
if (!source) {
  console.error('wrap-client: no tsdown output found at lib/client.cjs')
  process.exit(1)
}
const bundled = readFileSync(source, 'utf8')
if (bundled.includes('__ModuleLoader__')) {
  console.error('wrap-client: output already wrapped?')
  process.exit(1)
}

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-chatops",
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
