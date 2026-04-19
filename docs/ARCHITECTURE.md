# Architecture

The app is a single-page static site that talks directly to MyPixhome's CDN
(`cloud.zno.com`). No build-time secrets, no runtime backend, no auth. Served
from GitHub Pages.

## Module map

```
main.js          mounts <App/> into #root
app.js           top-level state machine + EXIF-probe effect
  phases: landing → loading → sorter → error
parser.js        parseGalleryUrl / galleryKey / buildGalleryUrl
api.js           cloud.zno.com client + image-URL builder + EXIF fetch
cache.js         IndexedDB store for photo lists
exif.js          inline TIFF walker → { make, model, serial }
sorter.js        the entire sorter UI (TopBar, GroupList, PhotoGrid, Cell,
                 Thumbnail, Lightbox, DownloadPanel, + grouping helpers)
download.js      batched download queue
how-it-works.js  explainer panel + modal
```

Single bundle per deploy: `bundle.mjs` runs esbuild over `app/src/main.js`
and emits `app/vendor/app.bundle.js` (minified ESM, ~190 KB with React +
ReactDOM + htm).

## Phase state machine (app.js)

```
  landing ──(submit)──▶ loading ──▶ sorter ◀─(change-source)─┐
     │                    │            │                      │
     │                    ▼            ▼                      │
     │                  error ─(retry)─┘                      │
     └──────────────────────────────────────────(reset)───────┘
```

`App` owns four slices of state that persist across phase transitions:

- `parsed` — `{domain, slug, storeId}` from `parseGalleryUrl`.
- `photos` — normalized photo records from `fetchAllPhotos`.
- `cameraMeta` — keyed by filename prefix, populated by the EXIF probe.
- `progress` — `{loaded, total}` for the loading screen.

An `AbortController` lives in a ref so `reset` / `changeSource` can cancel
an in-flight paginated fetch.

## Data flow — "paste URL → grid rendering"

1. **Parse** (`parser.js`) — validate host, extract `slug` + `storeId`.
2. **Cache lookup** (`cache.js`) — if we have a cached list for
   `galleryKey(parsed)`, render immediately from it and schedule a
   background refresh.
3. **Resolve** (`api.js#resolveBroadcast`) — `GET list_link_argument_by_slug`
   returns the encrypted `broadcast_id` (URL-decoded once before use).
4. **Paginate** (`api.js#fetchAllPhotos`) — loop
   `POST get_content_list_by_broadcast` using cursor-based paging until the
   server stops advancing or we reach `total`. Each record is normalized
   (`normalizePhoto`): enc ids URL-decoded, `shot_time` coerced to seconds.
5. **Cache write** (`cache.js#saveCache`) — persist the full normalized
   list.
6. **EXIF enrichment** (`app.js` effect) — for each camera prefix we
   haven't labelled yet, fetch up to 5 thumbnail samples and run
   `parseExif`. First sample with a readable APP1 segment wins; on total
   failure we still record `{failed: true}` so the UI shows a real
   fallback instead of spinning on "reading EXIF…" forever. The probe is
   delayed 800 ms so grid thumbnails aren't starved during initial render.
7. **Group + render** (`sorter.js`) — `applyCameraTimeShifts` → `groupPhotos`
   produces `{cameraKey, indices, startTime, …}[]`; the Sorter renders the
   TopBar, the per-camera sidebar, and the grid for the active group.

## Key invariants

- **`enc_*_id` values are URL-decoded exactly once.** The API returns them
  pre-encoded (`%3D` in JSON strings). `decodeEnc` in `api.js` handles it;
  `URLSearchParams` handles the re-encoding when we stuff them back into
  image URLs. Double-encoding here was the nastiest bug of the first build.
- **`/image/download` receives ONLY `enc_image_uid` + `thumbnail_size`.**
  Adding the 5 common JSON-API params makes the server return garbled bytes
  or the wrong image. The flow test asserts this (`image URLs omit
  storeId`). Don't "generalize" by routing it through the same helper.
- **`shotTime` is always seconds.** `normalizePhoto` divides by 1000 when
  the API returns ms. All downstream code (grouping, formatting) assumes
  seconds.
- **Grouping bucket order = first-appearance order in the sorted photo
  array.** The sidebar lists camera A above camera B iff A shot before B.
  `summarizeCameras` preserves this order; tests assert it.
- **`rawPhotos` is never mutated.** Per-camera time-shift correction
  produces a new array in `applyCameraTimeShifts`; the cache keeps original
  timestamps so cache hits don't compound the shift.
- **`/image/download?thumbnail_size=4` keeps the APP1 Exif segment**, which
  is what makes the EXIF probe cheap. If the CDN starts re-encoding
  previews, the probe falls back gracefully (`failed: true`) but the
  make/model/serial labels disappear.
- **Selection is always `Set<photo.id>`**, never an index set — indices
  shift when `gapSec` changes, but photo ids are stable across regroupings.
- **The download queue serializes into browser download prompts.** Chrome
  asks once per origin whether to "Allow multiple downloads"; if the user
  misses it, only the first file lands. The `AllowDownloadsModal` exists
  purely to warn them before we spawn the batch.

## Per-camera clock correction

Some photographers' cameras are set to wrong timezones at events, so raw
`shot_time` lands hours off wall-clock. `CAMERA_TIME_SHIFTS_BY_SERIAL` in
`sorter.js` is a hardcoded table keyed by EXIF `BodySerialNumber`. The shift
is applied at display time (never to the cached list). A memoized
`shiftKey` derived from the active cameraMeta keeps `photos` referentially
stable when EXIF probes complete for cameras that don't need a shift — without
that, the grid would flicker every time a probe finished.

To add a new camera shift: append a `'serial': secondsOffset` entry to the
table. The corresponding unit test lives in `tests/grouping.test.mjs`.

## Performance notes

- `React.memo` on `Cell` + stable callbacks from `useCallback` keep grid
  renders cheap when only one cell's `isSel` flips.
- `MAX_CHUNK = 1000` in `groupPhotos` force-chops oversize sessions so no
  single active group renders more than 1000 `<img>` elements.
- `Thumbnail` retries up to 3× with exponential backoff + a cache-busting
  `_r=N` param. Without retries the CDN's occasional 503s left permanent
  blank cells.
- Photos are fetched 1000 per page. On a 23k-photo gallery this is ~24
  requests and ~12 s of walltime end-to-end.

## File-by-file (what each module owns, what it doesn't)

| Module | Owns | Doesn't |
| --- | --- | --- |
| `parser.js` | URL validation, slug normalization | Networking |
| `api.js` | HTTP shape, photo normalization, image URL | Caching, UI |
| `cache.js` | IndexedDB persistence | Invalidation policy (owned by `app.js`) |
| `exif.js` | JPEG/TIFF byte walk | Network, UI |
| `download.js` | Queue pacing, blob → anchor handoff | Selection, UI |
| `sorter.js` | Grouping algorithm, all sorter UI | API calls (all go through `api.js`) |
| `how-it-works.js` | Explainer + help-modal | Everything else |
| `app.js` | Phase machine, cache orchestration, EXIF probe scheduling | Rendering the sorter itself |
