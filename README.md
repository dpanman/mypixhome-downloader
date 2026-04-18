# Gallery Sorter

A small, zero-backend web app for pulling your photos out of a MyPixhome
instant-gallery quickly. Built for skating parents at Illinois Lake Shore / UICC
events — paste the photographer's gallery link, filter by time, pick the shots
of your skater, bulk-download the originals.

Everything happens in your browser. No account, no server, no photos uploaded
anywhere.

## Try it

1. Go to `https://<your-username>.github.io/<this-repo>/` (once deployed — see
   *Deploy* below).
2. Paste a MyPixhome link, e.g.
   `https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788`.
3. The photos load in a grid, sorted by shot time.
4. Drag the time slider to narrow down to your skater's session.
5. Click to select, Shift+click for a range, Ctrl/⌘+A for everything visible.
6. Hit *Download*. On Chrome/Edge you'll pick a folder once and all files land
   there with their original filenames. On Firefox/Safari they go through the
   browser's normal download manager.

## How it works

The MyPixhome SaaS galleries are served by `cloud.zno.com`, which exposes three
public endpoints that respond with open CORS headers when called with
`credentials: 'omit'`. The app uses them directly:

- `activity/list_link_argument_by_slug` — resolves the URL slug to an encrypted
  broadcast id.
- `broadcast/get_content_list_by_broadcast` — paginated photo list (200/page,
  fetched with 4-way concurrency).
- `image/download?enc_image_uid=…&thumbnail_size=N` — actual image bytes. `N=4`
  for grid previews (~100 KB), `N=1` for full-resolution originals.

The photo list is cached in IndexedDB so revisits are instant; the app checks
the `total` count on page 1 in the background and invalidates the cache if new
photos have appeared.

Downloads use the File System Access API on Chromium (one folder pick, silent
writes) and fall back to anchor-click object URLs on Firefox/Safari.

## Project layout

```
app/
  index.html             — entry + importmap (React, htm from esm.sh CDN)
  src/
    main.js              — React mount
    app.js               — phase state machine (landing/loading/sorter/error)
    parser.js            — URL → {domain, slug, storeId}
    api.js               — the three cloud.zno.com endpoints
    cache.js             — IndexedDB photo-list cache
    download.js          — two-tier download queue
    sorter.js            — grid + filter bar + selection + download panel
    styles.css           — dark theme
.github/workflows/pages.yml   — GitHub Pages deploy
BUILD_PLAN.md            — full design doc
README.md                — this file
```

Nothing is bundled or transpiled — everything is ES modules loaded straight
from an importmap. Open `app/index.html` locally with any static file server:

```
cd app
python3 -m http.server 8080
# → http://localhost:8080
```

## Deploy (GitHub Pages)

1. Push this repo to GitHub.
2. In the repo's *Settings → Pages*, set **Source** to "GitHub Actions".
3. Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the
   `app/` directory as the site root.

## Caveats

- MyPixhome could change their API or tighten CORS at any time. If the app
  breaks, the diagnosis lives in `BUILD_PLAN.md` §9 (edge cases); the most
  common fallback is routing requests through a tiny Cloudflare Worker.
- Very large galleries (> 20k photos) load 200 photos per request. For the
  23k-photo Southport Spring Classic gallery, full load is ~12 seconds.
- This is a fan-made tool. Not affiliated with MyPixhome or any photographer.
  Please respect the photographer's rights and the terms of your gallery link.

## License

MIT.
