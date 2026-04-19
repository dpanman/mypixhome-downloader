# CLAUDE.md

Orientation for Claude Code sessions on this repo.

## What this is

A zero-backend web app that paginates a MyPixhome instant gallery, buckets
the photos by camera (EXIF body serial) and shot-time gaps, and bulk-
downloads originals to the user's Downloads folder. Deployed to GitHub
Pages. Single bundle; React + htm; no TypeScript; no routing; no backend.

The target user is a non-technical parent at a skating event. The
primary workflow is: *paste URL → see your skater's camera/session → click
to select → download*. Anything beyond that is scope creep.

## Orientation in 60 seconds

Read these first, in order, when you pick up a new task:

1. `README.md` — product surface + layout.
2. `docs/ARCHITECTURE.md` — module map, data flow, invariants.
3. `docs/API.md` — cloud.zno.com endpoint recipe.
4. `docs/TESTING.md` — how to run and extend tests.

Everything else is code.

## Repo map

```
app/src/*.js       — all source (seven small modules + a big sorter.js)
app/vendor/*.js    — GENERATED; do not edit by hand
app/styles.css     — single dark-theme CSS file
tests/*.mjs        — node + playwright; zero test framework
bundle.mjs         — esbuild build
.github/workflows/ — Pages deploy
docs/              — ARCHITECTURE, API, TESTING
```

## Essential commands

```
npm install --ignore-scripts      # once
npx playwright install chromium   # once, for flow test
node bundle.mjs                   # rebuild after any src change
npm run serve                     # serves app/ on :8123
npm test                          # 4 test scripts; needs server up
```

The flow test depends on the local dev server and on the bundle being
fresh — always rebuild after code changes before running `npm test`.

## When the user asks you to change code

- **Source files are in `app/src/`, not in the bundle.** Edit the source
  and rerun `node bundle.mjs`. The generated bundle at
  `app/vendor/app.bundle.js` is large, minified, and must not be
  hand-edited.
- **`index.html` and `app/index.html` are a matched pair.** The root one
  lets GitHub Pages serve from the repo root when deployed from a
  branch; the `app/` one is used when deployed as an Actions artifact
  (the default now). Keep cache-bust query strings (`?v=…`) in sync.
- **Don't add build tooling.** No TypeScript, no bundler config beyond
  `bundle.mjs`, no CSS preprocessor, no component library. The point of
  the project is that a single `node bundle.mjs` produces the site.
- **Don't pull in more dependencies** unless the task really needs it.
  Current runtime deps: React, ReactDOM, htm, fflate. Dev deps:
  esbuild, playwright. Anything you add ships to every user.

## Conventions to preserve

- **JS modules, not TS.** If you find yourself wanting types, write a
  JSDoc block instead.
- **`htm` for templates**, not JSX. The tagged-template syntax (`html\`…\``)
  means no JSX transpilation step. Don't reach for `React.createElement`
  directly except in `main.js`.
- **Semantic class names are load-bearing for tests.** `.sorter`,
  `.topbar2 .stats`, `.cell2`, `.group-row`, `.dl-panel2`,
  `.source-bar .source-link`, `.cam-header .cam-label` — the flow test
  keys off these. If you rename, update the test.
- **Each invariant in `docs/ARCHITECTURE.md#key-invariants` has a test
  that guards it.** Don't quietly break one to fix something else.
- **Selection is `Set<photo.id>`.** Indices are not stable across
  regrouping (gap changes, EXIF-driven time shifts).
- **No mutations of `rawPhotos`**. Per-camera time shifts produce a
  fresh array; the cache holds raw values.

## Where things tend to hide

- **`sorter.js` is ~1200 lines** because it holds the grouping algorithm
  AND the full sorter UI AND a couple of modal dialogs. Use the banner
  comments (`// -------- TopBar ---------`, etc.) to navigate.
- **`grouping.test.mjs` extracts source text from `sorter.js`** via a
  regex that matches a comment separator. Moving the grouping code into
  its own file is a fine refactor — just update the test.
- **EXIF probe sequencing is delicate.** The 800 ms start delay in
  `app.js` and the idempotent probe-per-prefix logic exist because
  probes competing with grid thumbnails used to leave broken cells.
  Don't "simplify" the delays without testing under real-CDN load.
- **`CAMERA_TIME_SHIFTS_BY_SERIAL` in `sorter.js`** is a hardcoded table
  of known-wrong camera clocks. Adding entries is safe; the probe and
  the tests already expect this pattern.
- **Dynamic imports: none left.** `app.js` used to `await import('./api.js')`
  inside `refreshInBackground`; that's now a normal top-level import.

## Red flags / things that will break if you touch them wrong

1. **Routing the `/image/download` endpoint through the common-QS
   helper.** It must receive only `enc_image_uid` + `thumbnail_size`.
   Adding `storeId=…` returns garbled bytes. Test
   `flow.mjs` #13 guards this.
2. **Re-encoding `enc_*_id` values.** They come URL-encoded in JSON,
   `decodeEnc` decodes once, URLSearchParams re-encodes once. Skipping
   or doubling this yields 404s on the CDN.
3. **Pagination with `page_num`.** The server ignores it. Use
   cursor-based paging (`last_enc_album_content_rel_id`) or you'll
   fetch page 1 forever.
4. **Mutating cached photo records.** The cache key is
   `domain|slug|storeId` and records are reused across sessions; mutate
   once and the bug compounds on every reload.
5. **Revoking blob URLs too early in `download.js`.** The anchor click
   is synchronous but the browser's file write is not. We hold object
   URLs for 60 s before revoking — don't shorten that.

## Style notes

- Prefer editing over writing new files.
- Do not add comments that restate what the code does; the existing
  comments either encode a hard-won lesson ("don't do X, because Y") or
  mark an invariant ("must stay in this order because the test selects
  …"). Preserve both kinds.
- No emojis in code or docs unless the user explicitly asks.
- Match the existing two-space indent, single quotes, trailing-commas-
  everywhere style.

## Common asks — quick pointers

| Ask | Where to look |
| --- | --- |
| "Fix the URL parsing for X" | `app/src/parser.js` + `tests/parser.test.mjs` |
| "Group by 20 seconds by default" | `DEFAULT_GAP_SEC` in `sorter.js` |
| "Add camera shift for serial Z" | `CAMERA_TIME_SHIFTS_BY_SERIAL` in `sorter.js`, then `grouping.test.mjs` |
| "CDN started returning 503" | `Thumbnail` retry logic in `sorter.js`; download retry in `download.js` |
| "Support password-protected galleries" | Out of scope today; `activity/validate_password` is the endpoint — see `docs/API.md` |
| "Add a new EXIF tag" | `parseTiff` in `app/src/exif.js` + `exif.test.mjs` |
| "Change download pacing" | `DEFAULT_*` constants at the top of `download.js` |
| "Deploy broke" | `.github/workflows/pages.yml`; output goes to `./app/` |
