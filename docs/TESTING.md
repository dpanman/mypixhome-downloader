# Testing

The suite is intentionally dependency-light: three `node` asserter scripts
for pure logic plus one Playwright script for the full UI flow. No mocha /
jest / vitest — the test runner is literally `node tests/…`.

## Run it

```
npm install --ignore-scripts        # esbuild + playwright
npx playwright install chromium     # once; the flow test needs it
node bundle.mjs                     # builds app/vendor/app.bundle.js
npm run serve &                     # serves app/ at localhost:8123
npm test                            # all four scripts
```

`npm test` runs:

1. `tests/parser.test.mjs` — URL validation.
2. `tests/grouping.test.mjs` — camera bucketing + time-gap split +
   per-camera time-shift.
3. `tests/exif.test.mjs` — TIFF walker reads Make/Model/BodySerialNumber.
4. `tests/flow.mjs` — Playwright end-to-end against a mocked
   `cloud.zno.com`.

The flow test assumes the dev server is running on `localhost:8123`.
Override with `APP_URL=…` if you run the server elsewhere.

## What each test file covers

### `parser.test.mjs` — 15 cases

Happy paths (trailing slash / no trailing slash / uppercase → lowercase /
hash suffix ignored) plus all the rejection paths: empty string,
non-URL, wrong protocol, wrong host, wrong path, missing or non-numeric
`storeId`, slug with leading hyphen, slug with special chars. Plus one
assertion on `galleryKey` stability.

### `grouping.test.mjs` — 46 cases

Loads `groupPhotos`, `extractCameraPrefix`, `summarizeCameras`,
`applyCameraTimeShifts`, and the constants (`DEFAULT_GAP_SEC`,
`GAP_OPTIONS`, `CAMERA_TIME_SHIFTS_BY_SERIAL`) out of `sorter.js` by
extracting a substring of the source file and evaluating it via
`data:text/javascript;base64,…`. This avoids having to stub React / htm /
`api.js` / `download.js` for what is pure logic.

The extraction regex (`GROUPING_BLOCK_RE`) matches from
`export const DEFAULT_GAP_SEC` to the `// Time + byte helpers` separator.
If you refactor `sorter.js`, either keep that separator comment where it
is or move the grouping helpers into their own file (and simplify the
test).

Coverage:

- Empty / singleton lists.
- Gap boundary behavior (`> gapSec`, not `>=`).
- `MAX_CHUNK` = 1000 force-chops oversize sessions.
- `extractCameraPrefix` for Canon / Nikon / fallback patterns.
- Camera-first grouping with heavily interleaved timestamps; assertion
  that groups never interleave across cameras.
- `summarizeCameras` preserves first-appearance order and merges in EXIF.
- All three `CAMERA_TIME_SHIFTS_BY_SERIAL` entries.
- `applyCameraTimeShifts` is a no-op for empty/unknown/failed EXIF, shifts
  only matching cameras, re-sorts by corrected time, and does not mutate
  input.

### `exif.test.mjs` — 7 cases

Uses `tests/_exif-fixture.mjs#buildExifJpeg` to synthesize a minimal JPEG
containing an APP1 Exif segment with Make (`0x010F`), Model (`0x0110`),
and BodySerialNumber (`0xA431` in the Exif sub-IFD). Verifies:

- Values longer than 4 bytes are read from the pool.
- Values ≤ 4 bytes are read from the inline slot.
- Non-JPEG input returns `null`.
- JPEG without an APP1 Exif segment returns `null`.
- `Uint8Array` and `ArrayBuffer` inputs both work.
- `formatCameraLabel` renders as `"Model · Serial"`.

The same fixture is reused by `flow.mjs` so the mocked `/image/download`
returns thumbnails that pass real EXIF parsing — the EXIF probe is
exercised end-to-end.

### `flow.mjs` — 34 checks

Playwright + headless Chromium. Installs route handlers that mock the
three cloud.zno.com endpoints from in-memory photo records, boots the
real app at `localhost:8123`, and drives it with real clicks / keyboard
events. Key scenarios:

- Landing render + inline error on bad URL.
- Happy-path load → sorter; topbar stats ("420 photos · 2 cameras · 7
  groups · 0 selected").
- EXIF probe: sidebar renders two camera sections with the correct
  make/model/serial surfaced from the mocked Exif JPEGs.
- Grouping invariant: all of camera A's groups appear before any of
  camera B's.
- Grid: 60 cells in the active group.
- Click / shift-click / Ctrl+A / Esc selection flows.
- Non-downloadable cells refuse selection.
- ArrowDown / Home / End group navigation.
- Lightbox opens on double-click, Space toggles selection, Esc closes.
- Full download flow: Select all → reminder modal → queue → items
  complete. The mocked CDN returns a 1-px GIF for full-size requests.
- Image URLs never include `storeId`; always include `thumbnail_size` +
  `enc_image_uid`.
- Gap selector has the expected options, defaults to 30, and clicking
  a sidebar row replaces the grid (no overlap).
- `?site=<url>` deep-link auto-loads; source bar shows the gallery URL;
  address bar stays in sync.
- Change-source dialog opens + cancels cleanly.
- Help modal opens + closes cleanly.
- No page errors throughout the run.

If anything fails, run the browser in headed mode by editing
`chromium.launch()` → `chromium.launch({ headless: false, slowMo: 250 })`
in `flow.mjs`. Network mocks are at the top of the file; mutate them to
reproduce specific CDN edge cases.

## Design-iteration screenshots (not in `npm test`)

`tests/screenshot.mjs` produces PNGs for every major screen (landing,
loading, idle sorter, selection, second camera, lightbox, allow-downloads
modal, download panel, change-source, help). Run it after a visual
change:

```
node tests/screenshot.mjs before   # or any label; files land in /tmp/screenshots
# make CSS / component changes
node bundle.mjs
node tests/screenshot.mjs after
# compare /tmp/screenshots/*-before.png vs *-after.png
```

Override the viewport via `SHOT_VIEWPORT=1920x1200`. Each photo gets a
deterministic hue tint injected at render time so the grid has visual
variety even though the mocked JPEGs are tiny.

## Live-API diagnosis (not in `npm test`)

`tests/inspect-real.mjs` is a one-off inspector that loads the real
MyPixhome gallery in Chromium and dumps every `cloud.zno.com` request +
response body. Use it if the app breaks in production to diff current
API behavior against `docs/API.md`:

```
node tests/inspect-real.mjs
# or with a different gallery:
node tests/inspect-real.mjs 'https://<host>.mypixhome.com/instant-gallery/<slug>/?storeId=<id>'
```

Requires internet access and will hit MyPixhome's real CDN — use
sparingly.

## Adding a test

- **New URL-parsing edge case** — add one line to `parser.test.mjs`.
- **New grouping behavior** — add to `grouping.test.mjs`. If the new
  helper lives outside the grouping block, export it and adjust
  `GROUPING_BLOCK_RE` (or refactor the grouping helpers into their own
  file, which is the cleaner long-term move).
- **New EXIF tag** — extend `parseTiff` in `exif.js`, then add a case
  to `exif.test.mjs` that builds a fixture containing the tag.
- **New UI behavior** — add to `flow.mjs`. Keep selectors rooted on
  semantic class names (`.sorter`, `.topbar2`, `.cell2`, `.group-row`,
  `.dl-panel2`); these are deliberately stable. The topbar stats row
  specifically requires four `<strong>` tags as direct children of
  `.stats` — the flow test selects `.stats strong:nth-of-type(4)` to
  read the selection count.
