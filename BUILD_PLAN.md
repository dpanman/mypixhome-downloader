# Standalone MyPixhome Gallery Downloader — Build Plan

**Goal:** Ship a static, zero-backend web app that anyone (non-technical parents at ice-skating events) can visit, paste a MyPixhome gallery URL into, and use to browse, filter, select, and bulk-download full-resolution photos of their skater. The app hosts on GitHub Pages, uses no cookies, no server proxy, no login, and no manual token copying.

---

## 1. Problem recap

MyPixhome is the SaaS photo-gallery product that Chicago Star Photography uses. A gallery URL looks like:

```
https://<photographer-subdomain>.mypixhome.com/instant-gallery/<event-slug>/?storeId=<id>
```

The official web UI mixes in store/shopping-cart flows, has no bulk-download, and no "filter to only my skater" workflow. We've already built a bookmarklet that hijacks the live SPA to do this, but it requires running injected JS inside the live site and isn't shippable to normal users.

The breakthrough (captured at the end of the prior session): **every API call the SPA needs is CORS-fully-open and accepts `credentials: 'omit'`**, so a static gh-pages site can talk to the MyPixhome backend (`cloud.zno.com`) directly.

---

## 2. API recipe — the crack

All three calls below were verified from `example.com` with `fetch(…, {credentials: 'omit'})` and returned real data.

### Step A — Resolve slug → broadcast token

```
GET https://cloud.zno.com/cloudapi/album_live/activity/list_link_argument_by_slug
    ?businessLine=SAAS
    &platform=PWA
    &storeId={storeId}
    &languageCode=en
    &countryCode=US
    &domain_name={fullSubdomainHost}
    &url_slug={eventSlug}
```

Response:

```json
{
  "ret_code": 200000,
  "ret_msg": "",
  "timestamp": 1776494382977,
  "data": [
    {"argument_key": "broadcast_id", "argument_value": "4vkA0BufO2k%3D"},
    {"argument_key": "key",          "argument_value": "451Bjcj6qfrsphptIRIu57uZ6roKzbRHQo1kT0vjdCY%3D"}
  ]
}
```

`argument_value` arrives URL-encoded — client must `decodeURIComponent` before re-use.

### Step B — Fetch paginated photos

```
POST https://cloud.zno.com/cloudapi/album_live/broadcast/get_content_list_by_broadcast
     ?businessLine=SAAS
     &platform=PWA
     &storeId={storeId}
     &languageCode=en
     &countryCode=US
Content-Type: application/json

{
  "enc_broadcast_id": "4vkA0BufO2k=",
  "page_num": 1,
  "page_size": 200
}
```

Response data shape:

```json
{
  "ret_code": 200000,
  "data": {
    "total": 23646,
    "last_search_time": "...",
    "album_content_list": [
      {
        "id": ...,
        "enc_content_id": "...",
        "content_name": "...",
        "shot_time": 1744...,
        "shot_time_str": "...",
        "width": 6000,
        "height": 4000,
        "orientation": 1,
        "resolution_type": ...,
        "content_size": ...,
        "flg_download": ...,
        "enc_original_content_id": "..."
      }
      // ... up to page_size items
    ]
  }
}
```

Paginate until cumulative list length ≥ `total`. 200 per page × ~120 pages for a 23k gallery = ~2 minutes walltime on a good connection.

### Step C — Download full-resolution file

The CDN URL pattern was already established in the bookmarklet. It takes `enc_content_id` (or `enc_original_content_id` for a truly-original vs. web-sized) plus storeId-scoped CDN base, and returns a real JPEG with permissive CORS (tested: 207 KB image, 200 OK from `example.com`, no cookies sent). Port that exact URL builder unchanged from the existing bookmarklet code.

---

## 3. Architecture

Single-page static app. No build tooling strictly required — but using Vite + React + TypeScript keeps the code maintainable and matches the bookmarklet's component shape. Tailwind is optional; plain CSS modules are fine.

**Tech stack (proposed):**
- Vite + React + TypeScript
- Tailwind (or one CSS file)
- No backend, no env vars, no API keys
- Deployed via `gh-pages` branch or GitHub Pages from `/docs`

**Runtime dependencies (browser):**
- `fetch` (native)
- `IndexedDB` (to cache photo lists so users don't re-paginate on reload)
- `showSaveFilePicker` / `File System Access API` when available (for bulk save to a folder) with fallback to per-file `<a download>` or a ZIP.

**App states:**

```
[Landing] --paste URL--> [Parsing] --OK--> [Loading photos] --OK--> [Selector]
                              |                   |                      |
                              v                   v                      v
                          [Error]            [Partial + retry]      [Download Manager]
```

---

## 4. Step-by-step implementation plan

Each numbered step is a discrete commit/PR-sized unit.

### 4.1 Project scaffolding
- `npm create vite@latest skater-gallery -- --template react-ts`
- Strip starter styling; add a `src/api/` folder, `src/components/` folder, `src/lib/` folder.
- Add a simple tailwind setup OR a single `src/app.css`.
- Add `.github/workflows/pages.yml` for auto-deploy.
- Smoke test: `npm run dev` loads a "hello" page at localhost.

### 4.2 URL parser
**File:** `src/lib/parseGalleryUrl.ts`

```ts
export interface ParsedGallery {
  domain: string;   // e.g. chicago-star-photography.mypixhome.com
  slug: string;     // e.g. southport-spring-classic
  storeId: string;  // e.g. 8788
}
export function parseGalleryUrl(input: string): ParsedGallery | { error: string };
```

Accepts raw `https://…` URL. Parses host, path, query. Rejects anything that isn't `*.mypixhome.com/instant-gallery/<slug>/` (with optional trailing slash, hash, query).

Unit tests for: trailing hash (`#/h_2026_…`), missing `storeId`, malformed URL, wrong hostname.

### 4.3 API client
**File:** `src/api/mypixhome.ts`

```ts
export interface Photo {
  id: number;
  encContentId: string;
  encOriginalContentId: string | null;
  contentName: string;
  shotTime: number;
  shotTimeStr: string;
  width: number;
  height: number;
  orientation: number;
  suffix: string;
  downloadable: boolean; // from flg_download
}

export async function resolveBroadcast(p: ParsedGallery): Promise<{ encBroadcastId: string; key: string }>;
export async function fetchPhotos(
  p: ParsedGallery,
  encBroadcastId: string,
  opts: { pageSize?: number; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }
): Promise<Photo[]>;
export function buildDownloadUrl(photo: Photo, p: ParsedGallery, kind: 'original' | 'web'): string;
```

Internally:
- `BASE = 'https://cloud.zno.com/cloudapi/album_live'`
- `COMMON_QS = { businessLine:'SAAS', platform:'PWA', languageCode:'en', countryCode:'US' }`
- Always `credentials: 'omit'`.
- Throw on `ret_code !== 200000`.
- `decodeURIComponent(argument_value)` when extracting `broadcast_id` and `key`.
- Pagination loop with `Promise` concurrency cap of ~4 simultaneous pages.

### 4.4 Photo cache (IndexedDB)
**File:** `src/lib/photoCache.ts`

Cache key = `${domain}|${slug}|${storeId}`. Store photo array + timestamp + `total`. Eviction: if `fetchPhotos` sees `total !== cached.total`, invalidate and refetch. Serve stale-while-revalidate: show cached list immediately, refresh in background.

### 4.5 Photo grid selector
**File:** `src/components/PhotoGrid.tsx`

Port the existing bookmarklet selector's keyboard/mouse interactions:
- Virtualized grid (use `@tanstack/react-virtual` or hand-rolled — 23k items is too many DOM nodes).
- Click to toggle select.
- Shift-click for range-select.
- Arrow-key nav + `Space` to toggle.
- `Ctrl/Cmd+A` = select all in current time filter.
- Each thumbnail shows shot time (`shotTimeStr`) + orientation badge.
- Selected count + dedupe badge in header.

### 4.6 Time-window filter slider
**File:** `src/components/TimeSlider.tsx`

Histogram of shot times (bin by minute or 5-min). Double-handled range slider. Filters visible photos to those in range. Slider handles should snap to actual photo times for usability.

This mirrors the behavior in the existing bookmarklet.

### 4.7 Download manager
**File:** `src/components/DownloadManager.tsx`

- Input: selected photos.
- Concurrency: 4 parallel downloads (configurable).
- Queue with states: `pending | in-flight | done | error | skipped`.
- Pause / resume / clear buttons.
- Retry on error with backoff.
- Total progress (bytes + count).

**Save strategy (two tiers):**

**Tier 1 — File System Access API (Chromium):**
- Request a directory handle once (`showDirectoryPicker({mode:'readwrite'})`).
- For each file, `await dir.getFileHandle(name, {create: true})` → `writable.write(blob)` → `close()`.
- Use `content_name` or a sanitized variant as filename.

**Tier 2 — ZIP fallback (Firefox, Safari):**
- Use `fflate` or `jszip` to build a ZIP in-memory.
- Call `saveAs(blob, 'skater-photos.zip')` at the end.
- Downside: memory use — need to warn the user if selection > ~2 GB.

Detect capability: `'showDirectoryPicker' in window ? tier1 : tier2`.

### 4.8 Landing page
**File:** `src/components/Landing.tsx`

- Single big URL input.
- "Paste your gallery URL" helper text with an example.
- Parse-on-change with inline error.
- Button "Load photos" → goes to loading state.
- Small copy below explaining that nothing is uploaded and everything stays in the browser.

### 4.9 Error handling / observability
- Central error boundary around the app.
- On API error, show the actual `ret_msg` plus a "Retry" button.
- Network errors: detect offline and show appropriate message.
- Console logging behind a `?debug=1` flag only.

### 4.10 Privacy / safety copy
On the landing page and footer:
- "All processing happens in your browser. No account needed."
- "We don't send your URL or photos to any server other than MyPixhome's own servers."
- "This is a fan-made tool, not affiliated with MyPixhome or any photographer."
- Link to the repo.

### 4.11 Deploy
- GitHub Actions workflow that builds and pushes to `gh-pages`.
- Custom domain optional.

---

## 5. Edge cases & risks

### 5.1 `broadcast_id` URL encoding subtleties
The `argument_value` comes double-encoded in the JSON string (`%3D` in a JSON string = the characters `%3D`, which the server treats as URL-encoded `=`). When sending it back in the POST body, decode once (`decodeURIComponent`) so the body has the plain base64 value ending in `=`. Confirmed working with `"4vkA0BufO2k="`.

### 5.2 `flg_download = 0` photos
Some photos have downloads disabled per the server. Respect this in the UI — grey them out, show a lock icon, skip them in the download queue. The bookmarklet code already has handling for this; port it.

### 5.3 Slug with special characters
URL slugs are expected to be lowercase-hyphenated, but validate: if the user pastes a URL with uppercase or encoded characters in the slug, normalize before sending.

### 5.4 Galleries with auth/password
Some MyPixhome galleries are password-protected (the `activity/validate_password` endpoint exists in the bundle). Out of scope for v1 — detect and show "password-protected galleries aren't supported yet."

### 5.5 API rate limits
Observed none during the bookmarklet work. Stay polite: max 4 concurrent list-pages, max 4 concurrent downloads, a small 50 ms jitter between requests. If the server starts 429-ing, add exponential backoff.

### 5.6 Memory with 23k+ photos
The full response is big (~30 MB JSON). Keep only the fields `Photo` declares — not the raw response object. Free the raw response immediately.

### 5.7 Server-side API change
If MyPixhome changes the endpoint path or required params, the app breaks. Mitigation: centralize all endpoint strings in one `src/api/endpoints.ts` and pin the API version with a short test page that pings the three endpoints with a known-good test gallery, so breakage surfaces loudly.

### 5.8 CORS policy tightening
If cloud.zno.com tightens CORS to gate on Origin headers, the app stops working from github.io. The current state is "Access-Control-Allow-Origin: *"-equivalent, verified via credentialed vs. non-credentialed fetch. Mitigation path: host a minimal Cloudflare Worker that proxies the two JSON endpoints and the CDN download. That's about 40 lines of code. Keep the option open but don't ship it until needed.

### 5.9 Copyright / terms of service
The photos are the photographer's work. This tool lets buyers download what they've already been given access to via the gallery URL — same surface area as the photographer's own "download" button. Still: add prominent language that the app is for personal use by people who have legitimate access to the gallery, and that users should respect the photographer's rights.

---

## 6. File structure (final)

```
skater-gallery/
  .github/workflows/pages.yml
  public/
    favicon.ico
  src/
    main.tsx
    App.tsx
    app.css (or tailwind)
    api/
      endpoints.ts
      mypixhome.ts
    lib/
      parseGalleryUrl.ts
      photoCache.ts
      sanitize.ts
      downloadDirHandle.ts
    components/
      Landing.tsx
      LoadingPhotos.tsx
      PhotoGrid.tsx
      TimeSlider.tsx
      DownloadManager.tsx
      ErrorBoundary.tsx
      Footer.tsx
    hooks/
      usePhotos.ts
      useSelection.ts
      useDownloadQueue.ts
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  README.md
```

---

## 7. Testing plan

### 7.1 Manual test cases
1. Paste the known-good URL (`chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788`) — expect 23,646 photos loaded.
2. Paste a URL without `?storeId=` — expect friendly error.
3. Paste a non-MyPixhome URL — expect friendly error.
4. Paste a URL with a slug that doesn't exist — expect "gallery not found."
5. Select 5 photos → download → confirm files land on disk with correct names.
6. Select 500 photos → download → confirm queue pauses/resumes correctly.
7. Reload browser mid-load — confirm cached photos show instantly.
8. Go offline mid-load — confirm graceful error.

### 7.2 Automated
- Unit tests for `parseGalleryUrl`.
- Mock-fetch integration test for `resolveBroadcast` + `fetchPhotos` using fixtures captured from the real API.
- Lint + typecheck in CI.

### 7.3 Cross-browser matrix
- Chrome / Edge (File System Access API — primary)
- Firefox (ZIP fallback)
- Safari (ZIP fallback)
- Mobile Safari / Chrome (smoke test — probably works but thumbnails may be heavy)

---

## 8. Rollout

1. Private repo + gh-pages site at unlisted URL. Test with one real gallery.
2. Share with one trusted other skating family. Gather feedback.
3. Public the repo with MIT license; add clear disclaimers.
4. Optional: short Loom walkthrough.

---

## 9. Future enhancements (post-v1)

- Face detection / face embeddings so users can type a bib number or upload one reference photo to pre-filter.
- Auto-burst grouping (cluster shots within N seconds into sets and let users select by group).
- EXIF preservation on downloaded files.
- Lightweight sharing: "here's my selection" URL that encodes selected `enc_content_id`s (not a proxy — user still downloads client-side).
- PWA / install-to-homescreen for faster reopening.

---

## 10. Estimated effort

- Scaffolding + URL parser + API client: 0.5 day.
- Grid + selection + time slider: 1 day.
- Download manager with both save tiers: 0.5 – 1 day.
- Polish, error handling, deploy: 0.5 day.
- **Total: ~3 days of focused work.**

Most of the heavy lifting (the SPA reverse-engineering) is already done and captured in sections 2 and 5 above.

---

## 11. Known-good test fixture

Keep this in the repo (e.g. `src/api/__fixtures__/southport.json`) for offline regression testing:

- Input URL: `https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788`
- Expected `broadcast_id`: `4vkA0BufO2k=` (14 chars URL-encoded)
- Expected `total`: 23,646
- First-page photo count: 200
- Sample photo field `content_name` format: camera-original filenames.

When that fixture stops matching, the API has changed.
