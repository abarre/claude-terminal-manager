import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** The extension host: Node, CommonJS, with `vscode` provided by the host. */
const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.cjs',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
}

/** The panel webview: a browser IIFE, no Node builtins, no `vscode` module. */
const webview = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview.js',
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
}

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extension),
    esbuild.context(webview),
  ])
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[esbuild] watching')
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)])
}
