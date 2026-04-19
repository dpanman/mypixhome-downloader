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

// Extract the exported grouping helpers + their constants from the module
// source. We evaluate just the snippet. This keeps the test hermetic.
// The grouping block spans the three exports (extractCameraPrefix,
// groupPhotos, summarizeCameras) and ends right before the Time/byte
// helpers separator.
const GROUPING_BLOCK_RE =
  /export const DEFAULT_GAP_SEC[\s\S]*?^\}\n\n(?=\/\/ -{10,}\n\/\/ Time \+ byte helpers)/m;
const match = src.match(GROUPING_BLOCK_RE);
if (!match) {
  console.error('could not locate grouping block in sorter.js');
  process.exit(2);
}

const mod = await import('data:text/javascript;base64,' +
  Buffer.from(match[0]).toString('base64')
);
const { groupPhotos, DEFAULT_GAP_SEC, GAP_OPTIONS, extractCameraPrefix, summarizeCameras } = mod;

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

// ---- camera-aware bucketing ---------------------------------------------

// extractCameraPrefix: the filename pattern Canon uses, Nikon's IMG_, etc.
eq(extractCameraPrefix('CA9A9999.JPG'), 'CA9A', 'prefix CA9A');
eq(extractCameraPrefix('IMG_0042.jpg'), 'IMG_', 'prefix IMG_');
eq(extractCameraPrefix('838A0001.JPG'), '838A', 'prefix 838A');
eq(extractCameraPrefix('plainfile.png'), 'plainfile', 'prefix plain (no numeric tail)');
eq(extractCameraPrefix(''), '', 'empty name → empty prefix');

// Helper that attaches a filename.
const cph = (t, name) => ({ shotTime: t, contentName: name });

// Two cameras with heavily interleaved timestamps must NOT be merged even
// when the time gap within each stream is tiny. Camera A shoots at
// t=100,101,102 and Camera B at t=100.5,101.5 — a naive time-only group
// would collapse all 5 into one session. With the camera-first pass, each
// bucket is its own group.
const mixed = [
  cph(100.0, 'CA9A0001.JPG'),
  cph(100.5, 'IMG_0001.JPG'),
  cph(101.0, 'CA9A0002.JPG'),
  cph(101.5, 'IMG_0002.JPG'),
  cph(102.0, 'CA9A0003.JPG'),
];
const gMix = groupPhotos(mixed, 30);
eq(gMix.length, 2, 'interleaved cameras → 2 groups');
eq(gMix[0].cameraKey, 'CA9A', 'first group is CA9A (shot first)');
eq(gMix[1].cameraKey, 'IMG_', 'second group is IMG_');
eq(gMix[0].count, 3, 'CA9A has 3 photos');
eq(gMix[1].count, 2, 'IMG_ has 2 photos');

// Groups are NEVER interleaved: all of camera A's groups come before any of
// camera B's. Also, time-gap within a single camera still splits groups.
const within = [
  cph(100, 'A0001.JPG'),
  cph(101, 'A0002.JPG'),
  cph(500, 'A0003.JPG'),   // 399s gap → new A-group
  cph(102, 'B0001.JPG'),   // B's clock is behind (different camera!)
  cph(103, 'B0002.JPG'),
];
const gWithin = groupPhotos(within, 30);
eq(gWithin.length, 3, 'camera A has 2 groups, camera B has 1 group');
eq(gWithin[0].cameraKey, 'A', 'first group is camera A');
eq(gWithin[1].cameraKey, 'A', 'second group is also camera A (no interleave)');
eq(gWithin[2].cameraKey, 'B', 'third group is camera B');

// summarizeCameras preserves appearance order and merges in EXIF meta.
const cams = summarizeCameras(mixed, {
  'CA9A': { make: 'Canon', model: 'Canon EOS R6m2', serial: '172021004429' },
});
eq(cams.length, 2, 'summarizeCameras returns 2 entries');
eq(cams[0].key, 'CA9A', 'first camera key is CA9A');
eq(cams[0].count, 3, 'CA9A count');
truthy(cams[0].meta && cams[0].meta.serial === '172021004429', 'CA9A has EXIF meta');
eq(cams[1].key, 'IMG_', 'second camera key is IMG_');
eq(cams[1].meta, null, 'IMG_ meta not yet probed → null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
