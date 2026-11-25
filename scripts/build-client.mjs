import { build } from 'esbuild'

// The client bundle pulls src/domain/distill-plan.js in through
// distill-confirm.js (Desk reviews tab, Task 3.2). That domain module's only
// Node builtin is `createHash`, used exclusively by fingerprintHash() — a
// Host-side computation (§12.1 fingerprints are persisted by distill-host,
// never computed in the browser). Stub it so esbuild can bundle for the
// browser; invoking the stub throws instead of silently mis-fingerprinting.
const nodeCryptoStub = {
  name: 'node-crypto-browser-stub',
  setup(build) {
    build.onResolve({ filter: /^node:crypto$/ }, () => ({
      path: 'node-crypto-stub',
      namespace: 'node-crypto-stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'node-crypto-stub' }, () => ({
      contents: [
        'export const createHash = () => {',
        '  throw new Error("node:crypto is not available in the browser client bundle")',
        '}',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'client.js',
  legalComments: 'none',
  plugins: [nodeCryptoStub],
})
