import React, { useState, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { parseGalleryUrl, galleryKey, buildGalleryUrl } from './parser.js';
import { resolveBroadcast, fetchAllPhotos } from './api.js';
import { readCache, saveCache, clearCache } from './cache.js';
import { Sorter } from './sorter.js';

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
  const abortRef = useRef(null);

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
    syncLocation(null);
    setPhase('landing');
    setParsed(null);
    setBroadcast(null);
    setPhotos([]);
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

  if (phase === 'landing') {
    return html`<${Landing} onSubmit=${beginLoad} initialRaw=${initialRaw} />`;
  }
  if (phase === 'loading') {
    return html`<${Loading} parsed=${parsed} progress=${progress} onCancel=${reset} />`;
  }
  if (phase === 'error') {
    return html`<${ErrorScreen} err=${err} parsed=${parsed} onRetry=${() => beginLoad(parsed)} onReset=${reset} />`;
  }
  return html`<${Sorter} parsed=${parsed} photos=${photos} onReset=${reset} onRefetch=${forceRefetch} />`;
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
      <div class="privacy-note">
        Everything happens in your browser. Your photos aren't uploaded or stored anywhere
        outside your own computer. This is a fan-made tool — not affiliated with MyPixhome
        or any photographer. Please respect the photographer's rights.
      </div>
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
