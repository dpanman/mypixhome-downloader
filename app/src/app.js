import React, { useState, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { parseGalleryUrl, galleryKey, buildGalleryUrl } from './parser.js';
import { resolveBroadcast, fetchAllPhotos, fetchImageBuffer } from './api.js';
import { readCache, saveCache, clearCache } from './cache.js';
import { parseExif } from './exif.js';
import { Sorter, extractCameraPrefix } from './sorter.js';
import { HowItWorksContent } from './how-it-works.js';

const html = htm.bind(React.createElement);

// --- Shareable URL support -------------------------------------------------
// The app accepts `?site=<gallery-url>` in its own query string so the gallery
// auto-loads on visit. Note: because the embedded URL itself contains a `?`
// (for `?storeId=…`), the browser parses `storeId` as a top-level param too.
// Either form works — we always reconstruct from `site` + `storeId` if needed.

function readSiteFromLocation() {
  try {
    const loc = new URL(window.location.href);
    let site = loc.searchParams.get('site') || '';
    if (!site) return '';
    // If `storeId` landed as a top-level param because of the nested `?`,
    // fold it back onto the site URL.
    const storeId = loc.searchParams.get('storeId');
    if (storeId && !/[?&]storeId=/i.test(site)) {
      site += (site.includes('?') ? '&' : '?') + 'storeId=' + storeId;
    }
    return site;
  } catch {
    return '';
  }
}

function syncLocation(parsed) {
  try {
    const target = parsed
      ? `${window.location.pathname}?site=${buildGalleryUrl(parsed)}`
      : window.location.pathname;
    window.history.replaceState(null, '', target);
  } catch {
    // history API failure is non-fatal — the app still works.
  }
}

// App-level state machine:
//   'landing'  — user pastes URL
//   'loading'  — fetching broadcast + photos
//   'sorter'   — grid + selection + download
//   'error'    — unrecoverable error with retry
export function App() {
  const [phase, setPhase] = useState('landing');
  const [parsed, setParsed] = useState(null);
  const [broadcast, setBroadcast] = useState(null);  // { encBroadcastId, key }
  const [photos, setPhotos] = useState([]);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [err, setErr] = useState(null);
  const [initialRaw, setInitialRaw] = useState('');
  // cameraMeta: filename-prefix → { make, model, serial } discovered from EXIF.
  const [cameraMeta, setCameraMeta] = useState({});
  const abortRef = useRef(null);
  // Prefixes we've already *successfully* labeled. Ref (not state) because it
  // only guards network duplication — rendering is driven by cameraMeta.
  const exifLabeledRef = useRef(new Set());

  const beginLoad = useCallback(async (nextParsed, preferCache = true) => {
    syncLocation(nextParsed);
    setParsed(nextParsed);
    setPhase('loading');
    setErr(null);
    setProgress({ loaded: 0, total: 0 });

    const key = galleryKey(nextParsed);

    // Try cache first for instant UI.
    if (preferCache) {
      const cached = await readCache(key);
      if (cached && Array.isArray(cached.photos) && cached.photos.length > 0) {
        setPhotos(cached.photos);
        setBroadcast({ encBroadcastId: cached.encBroadcastId });
        setPhase('sorter');
        // Background refresh; if total matches we skip, otherwise invalidate+refetch.
        refreshInBackground(nextParsed, cached);
        return;
      }
    }

    // No cache — fetch fresh.
    try {
      const bcast = await resolveBroadcast(nextParsed);
      setBroadcast(bcast);
      const ctl = new AbortController();
      abortRef.current = ctl;
      const fetched = await fetchAllPhotos(nextParsed, bcast.encBroadcastId, {
        pageSize: 1000,
        signal: ctl.signal,
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      });
      setPhotos(fetched);
      await saveCache(key, fetched, fetched.length, bcast.encBroadcastId);
      setPhase('sorter');
    } catch (e) {
      setErr(e.message || String(e));
      setPhase('error');
    }
  }, []);

  const refreshInBackground = async (nextParsed, cached) => {
    try {
      const bcast = await resolveBroadcast(nextParsed);
      // Only do a full refetch if total differs (cheap: one-page probe).
      const { fetchPhotoPage } = await import('./api.js');
      const first = await fetchPhotoPage(nextParsed, bcast.encBroadcastId, null, 1);
      if (first.total !== cached.total) {
        const fresh = await fetchAllPhotos(nextParsed, bcast.encBroadcastId, { pageSize: 1000 });
        setPhotos(fresh);
        await saveCache(galleryKey(nextParsed), fresh, fresh.length, bcast.encBroadcastId);
      }
      setBroadcast(bcast);
    } catch {
      // Silent — we already have cached photos.
    }
  };

  const reset = () => {
    if (abortRef.current) abortRef.current.abort();
    exifLabeledRef.current = new Set();
    syncLocation(null);
    setPhase('landing');
    setParsed(null);
    setBroadcast(null);
    setPhotos([]);
    setCameraMeta({});
    setProgress({ loaded: 0, total: 0 });
    setErr(null);
  };

  const forceRefetch = async () => {
    if (!parsed) return;
    await clearCache(galleryKey(parsed));
    beginLoad(parsed, /* preferCache */ false);
  };

  // Auto-load when the page was opened with ?site=<gallery-url>.
  useEffect(() => {
    const siteRaw = readSiteFromLocation();
    if (!siteRaw) return;
    const res = parseGalleryUrl(siteRaw);
    if (res.ok) {
      beginLoad(res);
    } else {
      // Invalid URL in the address bar — prefill Landing so the user sees
      // exactly what was passed and can edit it.
      setInitialRaw(siteRaw);
    }
  }, [beginLoad]);

  // When photos land, probe thumbnails per filename-prefix to read EXIF
  // (make / model / body serial) and label each camera bucket. Not every
  // individual photo in a prefix has a well-formed EXIF — some thumbnails
  // come back re-encoded by the CDN with the APP1 segment stripped, so we
  // try up to PROBES_PER_PREFIX samples before giving up. On total failure
  // we still record a concrete result so the UI shows a real fallback
  // instead of staying on "reading EXIF…" forever.
  //
  // The probe does NOT abort on re-render: parseExif is idempotent, extra
  // fetches are harmless, and a half-finished probe that later got aborted
  // would otherwise leave its prefix stuck in the "reading EXIF…" state.
  useEffect(() => {
    if (phase !== 'sorter' || !parsed || photos.length === 0) return;
    let cancelled = false;
    const PROBES_PER_PREFIX = 5;

    // For each prefix we haven't already labeled, keep a handful of samples
    // (different photos) so a stripped-EXIF thumbnail doesn't doom the whole
    // camera.
    const labeled = exifLabeledRef.current;
    const samples = new Map();
    for (const p of photos) {
      const prefix = extractCameraPrefix(p.contentName) || '?';
      if (labeled.has(prefix)) continue;
      const arr = samples.get(prefix);
      if (!arr) samples.set(prefix, [p]);
      else if (arr.length < PROBES_PER_PREFIX) arr.push(p);
    }
    if (samples.size === 0) return;

    (async () => {
      for (const [prefix, list] of samples) {
        if (cancelled) return;
        if (labeled.has(prefix)) continue;     // another effect beat us to it
        let info = null;
        for (const sample of list) {
          if (cancelled) return;
          try {
            const buf = await fetchImageBuffer(sample, 'preview');
            if (cancelled) return;
            const parsed = parseExif(buf);
            if (parsed && (parsed.make || parsed.model || parsed.serial)) {
              info = parsed;
              break;
            }
          } catch {
            // Try the next sample.
          }
        }
        if (cancelled) return;
        labeled.add(prefix);
        setCameraMeta((prev) => ({
          ...prev,
          [prefix]: info || { make: '', model: '', serial: '', failed: true },
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [phase, parsed, photos]);

  if (phase === 'landing') {
    return html`<${Landing} onSubmit=${beginLoad} initialRaw=${initialRaw} />`;
  }
  if (phase === 'loading') {
    return html`<${Loading} parsed=${parsed} progress=${progress} onCancel=${reset} />`;
  }
  if (phase === 'error') {
    return html`<${ErrorScreen} err=${err} parsed=${parsed} onRetry=${() => beginLoad(parsed)} onReset=${reset} />`;
  }
  // Swap to a new gallery URL without going back to the landing screen.
  // Invoked from the Source bar's "Change source" dialog. Clears per-gallery
  // state (photos, camera meta, EXIF labels) so the new gallery starts fresh.
  const changeSource = async (raw) => {
    const res = parseGalleryUrl(raw);
    if (!res.ok) return;                  // dialog handles its own validation
    if (abortRef.current) abortRef.current.abort();
    exifLabeledRef.current = new Set();
    setBroadcast(null);
    setPhotos([]);
    setCameraMeta({});
    setProgress({ loaded: 0, total: 0 });
    setErr(null);
    await beginLoad(res);
  };

  return html`<${Sorter}
    parsed=${parsed}
    photos=${photos}
    cameraMeta=${cameraMeta}
    onReset=${reset}
    onRefetch=${forceRefetch}
    onChangeSource=${changeSource}
  />`;
}

// ------- Landing -------

function Landing({ onSubmit, initialRaw }) {
  const [raw, setRaw] = useState(initialRaw || '');
  const [error, setError] = useState('');

  // If we arrived with an invalid ?site=… the raw URL is prefilled — show the
  // validator's message immediately so the user knows why it didn't auto-load.
  useEffect(() => {
    if (!initialRaw) return;
    const res = parseGalleryUrl(initialRaw);
    if (!res.ok) setError(res.error);
  }, [initialRaw]);

  const submit = (e) => {
    e && e.preventDefault();
    const res = parseGalleryUrl(raw);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError('');
    onSubmit(res);
  };

  return html`
    <div class="landing">
      <h1>Gallery Sorter</h1>
      <p class="subtitle">
        Paste your MyPixhome gallery link. Filter by time, pick the shots you want, download the originals.
      </p>
      <form class="url-form" onSubmit=${submit}>
        <input
          type="url"
          placeholder="https://<name>.mypixhome.com/instant-gallery/…"
          value=${raw}
          onChange=${(e) => setRaw(e.target.value)}
          autoFocus
        />
        <button type="submit" class="primary">Load</button>
      </form>
      <div class="error">${error}</div>
      <div class="example">
        e.g. https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788
      </div>
      <${HowItWorksContent} />
    </div>
  `;
}

// ------- Loading -------

function Loading({ parsed, progress, onCancel }) {
  const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
  return html`
    <div class="loading">
      <h2>Loading photos…</h2>
      <div class="progress-bar"><div class="fill" style=${{ width: pct + '%' }}></div></div>
      <div class="stats">
        ${progress.total
          ? `${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()} (${pct}%)`
          : 'Resolving gallery…'}
      </div>
      <div class="stats" style=${{ marginTop: '1rem' }}>${parsed?.slug}</div>
      <div style=${{ marginTop: '2rem' }}>
        <button onClick=${onCancel}>Cancel</button>
      </div>
    </div>
  `;
}

// ------- Error screen -------

function ErrorScreen({ err, parsed, onRetry, onReset }) {
  return html`
    <div class="landing">
      <h1>Something went wrong</h1>
      <div class="banner-error">${err}</div>
      <div style=${{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
        <button onClick=${onRetry} class="primary">Try again</button>
        <button onClick=${onReset}>Start over</button>
      </div>
      ${parsed ? html`<div class="example" style=${{ marginTop: '1rem' }}>
        Gallery: ${parsed.domain}/instant-gallery/${parsed.slug}
      </div>` : null}
    </div>
  `;
}
