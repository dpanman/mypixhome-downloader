// Build step: produce app/vendor/app.bundle.js — a single self-contained ESM
// module that includes React, ReactDOM, htm, and all app/src/ code. The
// generated bundle is what app/index.html loads, so the static site has zero
// runtime CDN dependencies.
//
// Run: `node bundle.mjs` (requires esbuild + the deps in package.json).

import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('./app/vendor', { recursive: true });

await build({
  entryPoints: ['./app/src/main.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: './app/vendor/app.bundle.js',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

console.log('built app/vendor/app.bundle.js');
