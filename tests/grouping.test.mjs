// Unit tests for the pure grouping algorithm (no browser needed).
// Loads groupPhotos directly from sorter.js. sorter.js imports from 'react',
// 'htm', './api.js', './download.js' — all of which pull 'react'/'htm'. To
// keep the import lightweight, we stub those modules via a tiny import-map-
// style loader shim by setting up a loader that redirects 'react' and 'htm' to
// lightweight stubs. Simpler: just copy the exported function into a standalone
// module at test time via Node's dynamic import.

// Read the function out of the source file by sourcing it — avoids the full
// React/htm dep graph while still testing the real code.
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.resolve('app/src/sorter.js'),
  'utf-8',
);

// Extract the exported groupPhotos + its constants from the module source.
// We evaluate just the snippet. This keeps the test hermetic.
const GROUPING_BLOCK_RE =
  /export const DEFAULT_GAP_SEC[\s\S]*?^\}/m;
const match = src.match(GROUPING_BLOCK_RE);
if (!match) {
  console.error('could not locate grouping block in sorter.js');
  process.exit(2);
}

const mod = await import('data:text/javascript;base64,' +
  Buffer.from(match[0]).toString('base64')
);
const { groupPhotos, DEFAULT_GAP_SEC, GAP_OPTIONS } = mod;

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  (ok ? pass++ : fail++, console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`));
  if (!ok) console.log(`     actual:   ${JSON.stringify(a)}\n     expected: ${JSON.stringify(b)}`);
}
function truthy(v, name) { (v ? pass++ : fail++, console.log(`${v ? 'OK  ' : 'FAIL'} ${name}`)); }

// Defaults.
eq(DEFAULT_GAP_SEC, 30, 'default gap is 30s');
eq(GAP_OPTIONS.includes(5) && GAP_OPTIONS.includes(60), true, '5s and 60s options exist');

// Helper.
const ph = (t) => ({ shotTime: t });

// Empty list → no groups.
eq(groupPhotos([], 30).length, 0, 'empty photos → 0 groups');

// Single photo → 1 group.
eq(groupPhotos([ph(100)], 30).length, 1, 'single photo → 1 group');

// Contiguous cluster, all within gap → 1 group.
const cluster = Array.from({ length: 10 }, (_, i) => ph(100 + i * 3));
const g1 = groupPhotos(cluster, 30);
eq(g1.length, 1, 'contiguous <gap → 1 group');
eq(g1[0].count, 10, 'group has 10 photos');

// Gap of 60s with default 30s → 2 groups.
const atBoundary = [ph(100), ph(160), ph(163)];
eq(groupPhotos(atBoundary, 30).length, 2, '60s gap splits at 30s threshold');

// Same input at 60s threshold (gap > gapSec, not >=) → 1 group.
eq(groupPhotos(atBoundary, 60).length, 1, '60s gap does NOT split at 60s threshold');

// Short threshold chops fine-grained.
const pairs = Array.from({ length: 20 }, (_, i) => ph(100 + i * 10));
eq(groupPhotos(pairs, 5).length, 20, '5s threshold chops 10s-spaced photos into singletons');
eq(groupPhotos(pairs, 30).length, 1, '30s threshold keeps 10s-spaced photos together');

// MAX_CHUNK: 1500 identical-gap photos → chunks of 1000 (2 groups).
const big = Array.from({ length: 1500 }, (_, i) => ph(100 + i));
const gb = groupPhotos(big, 5);
eq(gb.length, 2, '1500 photos with no gap → 2 chunks (MAX 1000)');
eq(gb[0].count, 1000, 'first chunk = 1000');
eq(gb[1].count, 500, 'second chunk = 500');

// Group metadata is correct.
const mg = groupPhotos([ph(100), ph(110), ph(125)], 30);
eq(mg[0].startTime, 100, 'group startTime');
eq(mg[0].endTime, 125, 'group endTime');
eq(mg[0].durationSec, 25, 'group duration');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
