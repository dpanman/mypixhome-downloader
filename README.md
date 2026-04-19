# Gallery Sorter

A small, zero-backend web app for bulk-downloading your skater's photos from a
MyPixhome instant gallery. Built for parents at Illinois Lake Shore / UICC
events — paste the photographer's gallery link, let the app bucket the photos
by camera and session, pick the shots you want, and save the originals.

Everything runs in the browser. No account, no server, nothing uploaded.

## Try it

1. Visit the deployed site (`https://<your-username>.github.io/<this-repo>/`
   once Pages is turned on — see *Deploy* below).
2. Paste a MyPixhome gallery link, e.g.
   `https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788`.
3. The app paginates the full photo list from the MyPixhome CDN, caches it
   locally, then opens the **Sorter** view:
   - **Sidebar** — a section per camera (make + model + body serial read from
     EXIF), each split into time-gap sessions.
   - **Grid** — the photos in the currently-selected session, each cell
     labelled with its in-group number, filename, clock time, and size.
4. Click a cell to toggle, shift-click to select a range, or press
   `Ctrl/⌘+A` to select every downloadable photo in the active group.
5. Hit **Download**. A one-time reminder explains the browser's
   *"Allow multiple downloads?"* prompt; click Allow and the queue runs to
   completion, saving files to your default Downloads folder with their
   original filenames.

Keyboard: `↑/↓` or `PgUp/PgDn` move between groups, `Home/End` jump to the
first/last, `Esc` clears selection, double-click a cell to open the lightbox
(`←/→` to page, `Space` to toggle select, `Esc` to close).

### Shareable / deep links

Prepend `?site=<gallery-url>` to the app URL and it auto-loads that gallery:

```
https://<your-username>.github.io/<this-repo>/?site=https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788
```

The address bar stays in sync with the currently-loaded gallery, and the
source gallery URL is shown as a clickable breadcrumb in the top bar. Use the
`⇄` button next to it to paste a new URL without losing cached galleries.

## How it works

The MyPixhome SaaS galleries are backed by `cloud.zno.com`, which exposes three
public endpoints that respond cross-origin when called with
`credentials: 'omit'`:

- `activity/list_link_argument_by_slug` — resolves the event slug to an
  encrypted `broadcast_id`.
- `broadcast/get_content_list_by_broadcast` — paginated photo list. The
  server ignores `page_num`, so the app uses cursor-based paging keyed off
  the trailing record's `enc_album_content_rel_id`.
- `image/download?enc_image_uid=…&thumbnail_size=N` — actual image bytes.
  `N=4` is a ~90–130 KB preview (used in the grid); `N=1` is the full-
  resolution original (fetched only when you actually download).

The full photo list is cached in IndexedDB keyed by `domain|slug|storeId`.
Re-opening the same gallery is instant; a background probe checks whether
`total` has moved and invalidates the cache if new photos have appeared.

Because several photographers usually shoot the same event on different
cameras (sometimes with desynced clocks), the Sorter **buckets by camera
first, then splits on time gap within a camera**:

1. Photos are bucketed by the 3-4 char **filename prefix** (Canon
   `CA9A9999.JPG` → `CA9A`; Nikon `IMG_0042.jpg` → `IMG_`).
2. For each bucket, an **EXIF probe** downloads a single thumbnail and reads
   *Make* (tag `0x010F`), *Model* (`0x0110`), and *BodySerialNumber*
   (`0xA431` inside the Exif sub-IFD). Two Canon R6m2 bodies at the same
   event show as two sections because their serials differ.
3. Within each camera, sessions split wherever two consecutive shots are
   more than the configurable **Gap** (5s–60s, defaulting to 30s).

Downloads are handed off to the browser's download manager via an
anchor-click on an object URL — same code path on every browser. Files land
in the user's default Downloads folder; no folder picker, no File System
Access API prompts.

## Project layout

```
app/
  index.html             — entry for app/; loads the single bundled ESM module
  src/
    main.js              — React mount
    app.js               — phase state machine (landing/loading/sorter/error)
    parser.js            — URL → {domain, slug, storeId}
    api.js               — cloud.zno.com endpoints + image URL builder
    cache.js             — IndexedDB photo-list cache (stale-while-revalidate)
    download.js          — batched download queue (3×, 100ms/300ms pacing)
    exif.js              — minimal inline TIFF walker for Make/Model/Serial
    sorter.js            — topbar, sidebar, grid, lightbox, download panel
    how-it-works.js      — explainer panel (landing) + modal (help button)
    styles.css           — dark theme
  vendor/
    app.bundle.js        — GENERATED: React + ReactDOM + htm + app/src/*
bundle.mjs               — esbuild build step (produces app.bundle.js)
index.html               — duplicate of app/index.html so Pages can serve the
                            repo root via the branch deployment mode
tests/
  parser.test.mjs        — unit: URL parsing
  grouping.test.mjs      — unit: camera bucketing + time-gap split + time-shift
  exif.test.mjs          — unit: TIFF walker
  flow.mjs               — Playwright end-to-end with mocked cloud.zno.com
  _exif-fixture.mjs      — shared: build a minimal JPEG with APP1 Exif
  screenshot.mjs         — design-iteration helper (generates PNGs under /tmp)
  inspect-real.mjs       — one-off: dump live gallery's network calls
docs/
  ARCHITECTURE.md        — module map, data flow, key invariants
  API.md                 — cloud.zno.com endpoint recipe + lessons learned
  TESTING.md             — how to run, extend, and debug the test suite
CLAUDE.md                — orientation for future Claude Code sessions
```

## Build & run locally

```
npm install --ignore-scripts            # esbuild + playwright only
npx playwright install chromium         # for the flow test
npm run build                           # emits app/vendor/app.bundle.js
npm run serve                           # serves app/ on http://localhost:8123
```

Run the test suite:

```
npm test                                # parser + grouping + exif + flow
```

The flow test needs the dev server running on `localhost:8123`. See
`docs/TESTING.md` for more detail.

## Deploy (GitHub Pages)

1. Push this repo to GitHub.
2. In the repo's *Settings → Pages*, set **Source** to "GitHub Actions".
3. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the
   build and publishes `app/` as the site root.

## Caveats

- MyPixhome could change its API or tighten CORS at any time. If that happens
  the diagnosis lives in `docs/API.md`; the likely mitigation is a tiny
  Cloudflare Worker that proxies the three endpoints.
- The EXIF camera-identification probe relies on thumbnails keeping the APP1
  segment. If the CDN starts stripping it, we fall back to filename-prefix
  bucketing without make/model/serial labels.
- This is a fan-made tool. Not affiliated with MyPixhome or any photographer.
  Please respect the photographer's rights and the terms of the gallery you
  were given access to.
