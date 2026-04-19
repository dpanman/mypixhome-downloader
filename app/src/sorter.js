import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { buildImageUrl } from './api.js';
import { buildGalleryUrl, parseGalleryUrl } from './parser.js';
import { createDownloadQueue } from './download.js';
import { HowItWorksModal } from './how-it-works.js';

const html = htm.bind(React.createElement);

// --------------------------------------------------------------------------
// Grouping — bucket by camera first, then split on shot-time gap within a
// single camera. Clocks aren't assumed to be synced across cameras, so mixing
// photos from different bodies into one time-based session would be wrong.
//
// Camera identity is read from the filename prefix (e.g. `CA9A9999.JPG` →
// `CA9A`). EXIF-derived labels (make / model / body serial) come from an
// enrichment pass and are only used to decorate the bucket in the UI.
// --------------------------------------------------------------------------

export const DEFAULT_GAP_SEC = 30;
export const GAP_OPTIONS = [5, 10, 15, 30, 45, 60];
const MAX_CHUNK = 1000;

// Extract the camera-identifying prefix from a filename.
//   'CA9A9999.JPG' → 'CA9A'
//   'IMG_9999.JPG' → 'IMG_'
//   '838A0042.JPG' → '838A'
//   'foo.jpg'      → 'foo'
// Designed to be stable across the trailing numeric run cameras append to
// each shot. Falls back to the whole stem when there's no numeric tail.
export function extractCameraPrefix(name) {
  if (!name) return '';
  const stem = String(name).split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
  const m = stem.match(/^(.*?)(\d{3,})$/);
  return (m ? m[1] : stem) || '';
}

export function groupPhotos(photos, gapSec = DEFAULT_GAP_SEC) {
  if (!photos.length) return [];

  // --- 1. Bucket photos by camera (filename prefix).
  //
  // We preserve the order in which each camera first appears in the sorted
  // `photos[]`, so the sidebar lists camera A (the one that shot first) at
  // the top and camera B below it, never interleaving.
  const buckets = new Map();  // cameraKey → array of photo indices
  for (let i = 0; i < photos.length; i++) {
    const key = extractCameraPrefix(photos[i].contentName) || '?';
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(i);
  }

  // --- 2. For each bucket (camera), sort its indices by shot time, then
  // split on shot-time gaps larger than `gapSec`. This keeps clock drift
  // between bodies from collapsing their sessions into one.
  const groups = [];
  for (const [cameraKey, rawIndices] of buckets) {
    const ordered = rawIndices.slice().sort(
      (a, b) => (photos[a].shotTime || 0) - (photos[b].shotTime || 0),
    );

    const sessions = [];
    let cur = [];
    for (let k = 0; k < ordered.length; k++) {
      const i = ordered[k];
      if (cur.length === 0) { cur.push(i); continue; }
      const prev = cur[cur.length - 1];
      const gap = (photos[i].shotTime || 0) - (photos[prev].shotTime || 0);
      if (gap > gapSec) {
        sessions.push(cur);
        cur = [];
      }
      cur.push(i);
    }
    if (cur.length) sessions.push(cur);

    // Force-chop oversize sessions so the grid stays fast.
    const chopped = [];
    for (const s of sessions) {
      if (s.length <= MAX_CHUNK) { chopped.push(s); continue; }
      for (let k = 0; k < s.length; k += MAX_CHUNK) {
        chopped.push(s.slice(k, k + MAX_CHUNK));
      }
    }

    for (const indices of chopped) {
      const startT = photos[indices[0]].shotTime || 0;
      const endT = photos[indices[indices.length - 1]].shotTime || 0;
      groups.push({
        cameraKey,
        indices,
        startIdx: indices[0],
        endIdx: indices[indices.length - 1],
        startTime: startT,
        endTime: endT,
        count: indices.length,
        durationSec: Math.max(0, endT - startT),
      });
    }
  }

  return groups;
}

// Summarize cameras for rendering headers / stats. Reads the filename prefix
// (authoritative bucket key) and merges in EXIF-derived labels from
// `cameraMeta` when available.
//   returns [{ key, count, meta?: { make, model, serial } }, …]
// Order matches the order cameras first appear in the (shot-time sorted)
// photo list — i.e. the order groups will be rendered in.
export function summarizeCameras(photos, cameraMeta = {}) {
  const order = [];
  const counts = new Map();
  for (const p of photos) {
    const key = extractCameraPrefix(p.contentName) || '?';
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return order.map((key) => ({
    key,
    count: counts.get(key) || 0,
    meta: cameraMeta[key] || null,
  }));
}

// --------------------------------------------------------------------------
// Per-camera shot-time correction.
//
// Some cameras were set to the wrong timezone at the event, so their recorded
// shot_time lands hours off from wall-clock. The fix is applied at display
// time keyed off EXIF BodySerialNumber: the raw photos[] and the IndexedDB
// cache are untouched, but groupPhotos / the grid / the lightbox all see the
// corrected time. Re-sorting after shifting keeps the cross-camera first-
// appearance order (which drives sidebar order) consistent with the new clock.
// --------------------------------------------------------------------------

export const CAMERA_TIME_SHIFTS_BY_SERIAL = {
  '172021004429': 10 * 3600,   // +10h — camera set to a timezone 10h behind
  '132022001097': -2 * 3600,   // −2h
  '132021002918': -2 * 3600,   // −2h
};

export function applyCameraTimeShifts(photos, cameraMeta) {
  if (!photos || photos.length === 0) return photos || [];
  const shiftByPrefix = new Map();
  for (const prefix of Object.keys(cameraMeta || {})) {
    const serial = cameraMeta[prefix] && cameraMeta[prefix].serial;
    if (!serial) continue;
    const shift = CAMERA_TIME_SHIFTS_BY_SERIAL[serial];
    if (shift) shiftByPrefix.set(prefix, shift);
  }
  if (shiftByPrefix.size === 0) return photos;
  const adjusted = photos.map((p) => {
    const prefix = extractCameraPrefix(p.contentName) || '?';
    const shift = shiftByPrefix.get(prefix);
    if (!shift) return p;
    return { ...p, shotTime: (p.shotTime || 0) + shift };
  });
  adjusted.sort((a, b) => (a.shotTime || 0) - (b.shotTime || 0));
  return adjusted;
}

// --------------------------------------------------------------------------
// Time + byte helpers
// --------------------------------------------------------------------------

function fmtDateTime(t) {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${M}/${D} ${hh}:${mm}:${ss}`;
}
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
function fmtClock(t) {
  if (!t) return '';
  const d = new Date(t * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// --------------------------------------------------------------------------
// Top-level component
// --------------------------------------------------------------------------

export function Sorter({ parsed, photos: rawPhotos, cameraMeta, onRefetch, onChangeSource }) {
  const [gapSec, setGapSec] = useState(DEFAULT_GAP_SEC);
  // Collapse cameraMeta into a canonical key that only changes when the
  // *effective* set of time-shifts changes. EXIF probes add entries to
  // cameraMeta as each camera is identified — most of those additions don't
  // need a shift (e.g. serial not in CAMERA_TIME_SHIFTS_BY_SERIAL, or the
  // probe failed). Without this, every probe-completion would invalidate the
  // photos useMemo → groups recompute → the whole grid re-renders, which
  // cancels pending thumbnail loads and makes the grid look broken until
  // EXIF finishes.
  const shiftKey = useMemo(() => {
    if (!cameraMeta) return '';
    const parts = [];
    for (const prefix of Object.keys(cameraMeta).sort()) {
      const serial = cameraMeta[prefix] && cameraMeta[prefix].serial;
      const shift = serial ? CAMERA_TIME_SHIFTS_BY_SERIAL[serial] : 0;
      if (shift) parts.push(`${prefix}:${shift}`);
    }
    return parts.join('|');
  }, [cameraMeta]);
  // Apply per-camera time-shift corrections (by EXIF body serial) before any
  // downstream work — grouping, selection, and rendering all key off the
  // corrected clock. rawPhotos stays identity-stable so the cache isn't
  // polluted with shifted times.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const photos = useMemo(
    () => applyCameraTimeShifts(rawPhotos, cameraMeta || {}),
    [rawPhotos, shiftKey],
  );
  const groups = useMemo(() => groupPhotos(photos, gapSec), [photos, gapSec]);
  const cameras = useMemo(
    () => summarizeCameras(photos, cameraMeta || {}),
    [photos, cameraMeta],
  );

  // Selection is a Set<photo.id> (numeric). lastClickedIdx is a ref (not
  // state) because tracking the anchor for shift-click range selection
  // shouldn't force the grid to re-render — it'd churn hundreds of memoized
  // cells on every single click.
  const [selected, setSelected] = useState(() => new Set());
  const lastClickedIdxRef = useRef(null);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);

  // Reset active group when the grouping changes so the sidebar stays in sync.
  useEffect(() => { setActiveGroupIdx(0); }, [gapSec]);

  // Lightbox: index within the active group, or null for closed.
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const [queue, setQueue] = useState(null);
  const [, setQueueTick] = useState(0);
  const queueRef = useRef(null);

  // Photos staged for download, awaiting the user's acknowledgement of the
  // "allow multiple downloads" reminder. null when no modal is showing.
  const [pendingDownload, setPendingDownload] = useState(null);

  // Help modal toggle.
  const [helpOpen, setHelpOpen] = useState(false);
  // Change-source dialog toggle — lifted here (instead of inside GalleryPill)
  // so the fixed-positioned scrim isn't trapped by topbar's backdrop-filter.
  const [changeSourceOpen, setChangeSourceOpen] = useState(false);

  const gridScrollRef = useRef(null);
  const sidebarRef = useRef(null);

  // Per-group selected counts.
  const groupSelCounts = useMemo(() => {
    const counts = new Array(groups.length).fill(0);
    for (let g = 0; g < groups.length; g++) {
      let c = 0;
      for (const idx of groups[g].indices) {
        if (selected.has(photos[idx].id)) c++;
      }
      counts[g] = c;
    }
    return counts;
  }, [groups, selected, photos]);

  // ----- selection ops ---------------------------------------------------

  // Selection ops skip photos with downloadable=false so the selected count
  // never includes shots the user can't actually download.
  const toggleOne = useCallback((photoId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId); else next.add(photoId);
      return next;
    });
  }, []);

  // Shift-click range: if the TARGET (clicked) photo is currently unselected,
  // the whole range becomes selected; if the target is already selected,
  // the whole range becomes deselected. Matches the original selector.
  // Reading `selected` via the functional-setState form keeps this callback
  // identity-stable across selection changes so memoized cells don't
  // re-render when their selection state hasn't changed.
  const selectRange = useCallback((fromPhotoIdx, toPhotoIdx) => {
    const lo = Math.min(fromPhotoIdx, toPhotoIdx);
    const hi = Math.max(fromPhotoIdx, toPhotoIdx);
    setSelected((prev) => {
      const targetSelected = prev.has(photos[toPhotoIdx].id);
      const next = new Set(prev);
      for (let j = lo; j <= hi; j++) {
        const p = photos[j];
        if (!p.downloadable) continue;
        if (targetSelected) next.delete(p.id); else next.add(p.id);
      }
      return next;
    });
  }, [photos]);

  const clearAll = useCallback(() => setSelected(new Set()), []);

  const selectAllInGroup = useCallback((gIdx) => {
    const g = groups[gIdx];
    if (!g) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const j of g.indices) {
        const p = photos[j];
        if (p.downloadable) next.add(p.id);
      }
      return next;
    });
  }, [groups, photos]);

  const unselectGroup = useCallback((gIdx) => {
    const g = groups[gIdx];
    if (!g) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const j of g.indices) next.delete(photos[j].id);
      return next;
    });
  }, [groups, photos]);

  // ----- click handler ---------------------------------------------------

  const handleCellClick = useCallback((pIdx, e) => {
    const photo = photos[pIdx];
    if (!photo.downloadable) return;
    const anchor = lastClickedIdxRef.current;
    if (e.shiftKey && anchor != null) {
      selectRange(anchor, pIdx);
    } else {
      toggleOne(photo.id);
    }
    lastClickedIdxRef.current = pIdx;
  }, [selectRange, toggleOne, photos]);

  const openLightbox = useCallback((withinIdx) => setLightboxIdx(withinIdx), []);

  // ----- keyboard shortcuts ----------------------------------------------

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Lightbox-specific keys take priority.
      if (lightboxIdx !== null) {
        const g = groups[activeGroupIdx];
        if (!g) return;
        if (e.key === 'Escape') { e.preventDefault(); setLightboxIdx(null); return; }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setLightboxIdx((i) => (i > 0 ? i - 1 : g.indices.length - 1));
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setLightboxIdx((i) => (i < g.indices.length - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          const pIdx = g.indices[lightboxIdx];
          toggleOne(photos[pIdx].id);
          return;
        }
        return;
      }

      // Ctrl/Cmd+A — select all downloadable photos in the active group.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAllInGroup(activeGroupIdx);
        return;
      }

      if (e.key === 'Escape') {
        clearAll();
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveGroupIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveGroupIdx(Math.max(0, groups.length - 1));
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        if (activeGroupIdx < groups.length - 1) {
          e.preventDefault();
          setActiveGroupIdx((i) => Math.min(groups.length - 1, i + 1));
        }
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        if (activeGroupIdx > 0) {
          e.preventDefault();
          setActiveGroupIdx((i) => Math.max(0, i - 1));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeGroupIdx, groups, lightboxIdx, photos, toggleOne, clearAll, selectAllInGroup]);

  // ----- scroll sidebar row into view on group change --------------------

  useEffect(() => {
    const el = sidebarRef.current;
    if (el) {
      const row = el.querySelector(`[data-g="${activeGroupIdx}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
    if (gridScrollRef.current) gridScrollRef.current.scrollTop = 0;
    setLightboxIdx(null);
  }, [activeGroupIdx]);

  // ----- download --------------------------------------------------------

  const startDownload = useCallback(() => {
    if (selected.size === 0) return;
    // Preserve chronological order. Double-check downloadable here in case a
    // non-downloadable id snuck into the selection via a stale cache.
    const arr = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (selected.has(p.id) && p.downloadable) arr.push(p);
    }
    if (arr.length === 0) return;
    // Stage the selection behind the Allow-downloads modal. The queue only
    // starts after the user acknowledges Chrome's multi-download prompt.
    setPendingDownload(arr);
  }, [selected, photos]);

  const confirmDownload = useCallback(() => {
    const arr = pendingDownload;
    if (!arr || arr.length === 0) { setPendingDownload(null); return; }
    const q = createDownloadQueue({
      photos: arr,
      parsed,
      concurrency: 3,
      launchStaggerMs: 100,
      batchIdleMs: 300,
      onUpdate: () => setQueueTick((t) => t + 1),
    });
    queueRef.current = q;
    setQueue(q);
    setPendingDownload(null);
    q.start();
  }, [pendingDownload, parsed]);

  const cancelPendingDownload = useCallback(() => setPendingDownload(null), []);

  const closeQueue = useCallback(() => {
    if (queueRef.current) queueRef.current.cancel();
    queueRef.current = null;
    setQueue(null);
  }, []);

  // Cancel any in-flight queue when Sorter unmounts (e.g. user clicks Start over).
  useEffect(() => () => {
    if (queueRef.current) queueRef.current.cancel();
  }, []);

  // ----- derived ---------------------------------------------------------

  const totalPhotos = photos.length;
  const selectedCount = selected.size;
  const activeGroup = groups[activeGroupIdx];

  // ----- render ----------------------------------------------------------

  const activeCamera = activeGroup ? cameras.find((c) => c.key === activeGroup.cameraKey) : null;

  return html`
    <div class="sorter">
      <${TopBar}
        parsed=${parsed}
        onOpenChangeSource=${() => setChangeSourceOpen(true)}
        totalPhotos=${totalPhotos}
        groupCount=${groups.length}
        cameraCount=${cameras.length}
        selectedCount=${selectedCount}
        gapSec=${gapSec}
        onGapChange=${setGapSec}
        onSelectAllInGroup=${() => selectAllInGroup(activeGroupIdx)}
        onUnselectGroup=${() => unselectGroup(activeGroupIdx)}
        onClearAll=${clearAll}
        onDownload=${startDownload}
        hasQueue=${!!queue}
        onOpenHelp=${() => setHelpOpen(true)}
        onRefetch=${onRefetch}
      />
      <div class="sorter-body">
        <${GroupList}
          sidebarRef=${sidebarRef}
          parsed=${parsed}
          photos=${photos}
          groups=${groups}
          groupSelCounts=${groupSelCounts}
          cameras=${cameras}
          activeGroupIdx=${activeGroupIdx}
          onJump=${setActiveGroupIdx}
        />
        <${PhotoGrid}
          gridScrollRef=${gridScrollRef}
          parsed=${parsed}
          photos=${photos}
          group=${activeGroup}
          activeCamera=${activeCamera}
          activeGroupIdx=${activeGroupIdx}
          groupCount=${groups.length}
          selectedInGroup=${groupSelCounts[activeGroupIdx] || 0}
          selected=${selected}
          onCellClick=${handleCellClick}
          onCellOpen=${openLightbox}
          onPrevGroup=${() => setActiveGroupIdx((i) => Math.max(0, i - 1))}
          onNextGroup=${() => setActiveGroupIdx((i) => Math.min(groups.length - 1, i + 1))}
        />
      </div>
      ${lightboxIdx !== null && activeGroup ? html`
        <${Lightbox}
          parsed=${parsed}
          photo=${photos[activeGroup.indices[lightboxIdx]]}
          current=${lightboxIdx + 1}
          total=${activeGroup.indices.length}
          isSelected=${selected.has(photos[activeGroup.indices[lightboxIdx]].id)}
          onPrev=${() => setLightboxIdx((i) => (i > 0 ? i - 1 : activeGroup.indices.length - 1))}
          onNext=${() => setLightboxIdx((i) => (i < activeGroup.indices.length - 1 ? i + 1 : 0))}
          onToggle=${() => toggleOne(photos[activeGroup.indices[lightboxIdx]].id)}
          onClose=${() => setLightboxIdx(null)}
        />
      ` : null}
      ${pendingDownload ? html`
        <${AllowDownloadsModal}
          count=${pendingDownload.length}
          onConfirm=${confirmDownload}
          onCancel=${cancelPendingDownload}
        />
      ` : null}
      ${queue ? html`<${DownloadPanel} queue=${queue} onClose=${closeQueue} />` : null}
      ${helpOpen ? html`<${HowItWorksModal} onClose=${() => setHelpOpen(false)} />` : null}
      ${changeSourceOpen ? html`
        <${ChangeSourceDialog}
          currentUrl=${parsed ? buildGalleryUrl(parsed) : ''}
          onClose=${() => setChangeSourceOpen(false)}
          onSubmit=${(raw) => { setChangeSourceOpen(false); onChangeSource(raw); }}
        />
      ` : null}
    </div>
  `;
}

// --------------------------------------------------------------------------
// AllowDownloadsModal — full-screen reminder that Chrome will prompt for
// permission to download multiple files. If the user doesn't click Allow,
// only the first file lands and the rest silently drop, which is the
// most common "downloads didn't work" failure mode.
// --------------------------------------------------------------------------

function AllowDownloadsModal({ count, onConfirm, onCancel }) {
  return html`
    <div class="allow-modal modal-scrim" role="dialog" aria-modal="true">
      <div class="allow-card modal-card">
        <div class="allow-banner">
          <span class="ab-icon">!</span>
          One more step: watch for your browser's download prompt
        </div>
        <div class="allow-body">
          <div class="allow-headline">
            <span class="allow-count">${count.toLocaleString()}</span>
            ${count === 1 ? 'photo ready to save' : 'photos ready to save'}
          </div>
          <div class="allow-sub">
            The browser is about to spawn many simultaneous downloads. Chrome
            (and most others) will ask you to approve the batch once.
          </div>
          <div class="allow-note">
            Look for <em>Allow site to download multiple files?</em> at the top
            of the window and click <strong>Allow</strong>. If you miss it or
            choose Block, only the first file saves — the rest fail silently
            even though the panel shows "done".
          </div>
        </div>
        <div class="allow-actions">
          <button onClick=${onCancel}>Cancel</button>
          <button class="allow-modal-go allow-go primary" onClick=${onConfirm} autoFocus>
            Got it — start downloading →
          </button>
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// GalleryPill — compact breadcrumb showing the current source gallery.
// Keeps the `.source-bar` + `.source-link` + `.source-change` class names so
// end-to-end tests (which key off those hooks) still pass.
// --------------------------------------------------------------------------

// Stateless — just renders the pill + trigger. The modal itself is
// rendered at the Sorter's root so the topbar's `backdrop-filter` doesn't
// trap its `position: fixed` scrim inside the blurred stacking context.
function GalleryPill({ parsed, onOpenChangeSource }) {
  if (!parsed) return null;
  const url = buildGalleryUrl(parsed);
  const host = parsed.domain.replace(/\.mypixhome\.com$/, '');
  const slug = parsed.slug;
  return html`
    <div class="source-bar">
      <a class="source-link gallery-pill"
         href=${url}
         target="_blank"
         rel="noopener noreferrer"
         title=${url}>
        <span class="host-dot"></span>
        <span class="host-txt">${host}</span>
        <span class="sep">/</span>
        <span class="slug-txt">${slug}</span>
      </a>
      <button class="source-change icon-btn"
              onClick=${onOpenChangeSource}
              title="Load a different gallery">
        ⇄
      </button>
    </div>
  `;
}

function ChangeSourceDialog({ currentUrl, onClose, onSubmit }) {
  const [raw, setRaw] = useState(currentUrl || '');
  const [error, setError] = useState('');

  const submit = (e) => {
    e && e.preventDefault();
    const v = raw.trim();
    if (!v) { setError('Paste a MyPixhome gallery URL.'); return; }
    const res = parseGalleryUrl(v);
    if (!res.ok) { setError(res.error); return; }
    onSubmit(v);
  };

  // Close on Escape for quick dismissal.
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  return html`
    <div class="change-source-modal modal-scrim" role="dialog" aria-modal="true" onClick=${onClose}>
      <div class="change-source-card modal-card" onClick=${(e) => e.stopPropagation()}>
        <div class="change-source-title">Load a different gallery</div>
        <div class="change-source-sub">
          Paste a MyPixhome link — the current gallery stays cached and you can
          swap back to it any time.
        </div>
        <form class="change-source-form" onSubmit=${submit}>
          <input type="url"
                 value=${raw}
                 onChange=${(e) => setRaw(e.target.value)}
                 placeholder="https://<photographer>.mypixhome.com/instant-gallery/…"
                 autoFocus />
          <div class="change-source-actions">
            <button type="button" onClick=${onClose}>Cancel</button>
            <button type="submit" class="primary">Load gallery</button>
          </div>
        </form>
        ${error ? html`<div class="change-source-error">${error}</div>` : null}
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// TopBar
// --------------------------------------------------------------------------

function TopBar({
  parsed, onOpenChangeSource,
  totalPhotos, groupCount, cameraCount, selectedCount,
  gapSec, onGapChange,
  onSelectAllInGroup, onUnselectGroup, onClearAll,
  onDownload, hasQueue, onOpenHelp, onRefetch,
}) {
  return html`
    <header class="topbar2">
      <div class="tb-left">
        <div class="tb-brand">
          <span class="tb-brand-glyph"></span>
          <span class="tb-brand-label">Gallery Sorter</span>
        </div>
        <${GalleryPill} parsed=${parsed} onOpenChangeSource=${onOpenChangeSource} />
        <div class="tb-left-spacer"></div>
        <div class="tb-left-icons">
          <button class="icon-btn" onClick=${onRefetch}
                  title="Clear cache and refetch all photos">↻</button>
          <button class="help-btn"
                  onClick=${onOpenHelp}
                  title="How this tool works">?</button>
        </div>
      </div>

      <!--
        Stats row — four value pills.
        The end-to-end test selects \`.topbar2 .stats strong:nth-of-type(4)\`
        to read the selected count, so the four <strong> tags MUST stay direct
        children of \`.stats\` in this order: photos, cameras, groups, selected.
        The labels sit as text nodes after each strong so \`textContent\` matches
        patterns like "420 photos" / "2 cameras" cleanly.
      -->
      <div class="stats tb-stats" role="group" aria-label="Gallery stats">
        <span class="tb-stat accent"><span class="dot"></span></span>
        <strong>${totalPhotos.toLocaleString()}</strong>
        <span class="tb-lbl">${' '}photos</span>
        <span class="tb-sep">·</span>
        <span class="tb-stat cyan"><span class="dot"></span></span>
        <strong>${(cameraCount || 0).toLocaleString()}</strong>
        <span class="tb-lbl">${' '}${cameraCount === 1 ? 'camera' : 'cameras'}</span>
        <span class="tb-sep">·</span>
        <span class="tb-stat neutral"><span class="dot"></span></span>
        <strong>${groupCount.toLocaleString()}</strong>
        <span class="tb-lbl">${' '}groups</span>
        <span class="tb-sep">·</span>
        <span class="tb-stat ok"><span class="dot"></span></span>
        <strong class=${selectedCount ? 'sel-live' : ''}>${selectedCount.toLocaleString()}</strong>
        <span class="tb-lbl">${' '}selected</span>
      </div>

      <div class="tb-actions">
        <label class="gap-picker" title="Split groups on shot-time gaps larger than this">
          <span class="gp-label">Gap</span>
          <select value=${String(gapSec)} onChange=${(e) => onGapChange(Number(e.target.value))}>
            ${GAP_OPTIONS.map((s) => html`<option key=${s} value=${String(s)}>${s}s</option>`)}
          </select>
        </label>
        <button onClick=${onSelectAllInGroup} title="Select every downloadable photo in the active group (Ctrl/⌘+A)">
          Select all in group
        </button>
        <button onClick=${onUnselectGroup} title="Drop just this group's selections">Unselect group</button>
        <button class="danger" onClick=${onClearAll} disabled=${selectedCount === 0} title="Clear selection across all groups (Esc)">
          Clear all
        </button>
        <button class="primary download-btn"
                onClick=${onDownload}
                disabled=${selectedCount === 0 || hasQueue}>
          Download <span class="count">${selectedCount}</span>
        </button>
      </div>
    </header>
  `;
}

// --------------------------------------------------------------------------
// Thumbnail — resilient <img> wrapper for grid + sidebar cells.
//
// The CDN occasionally drops connections when the grid asks for dozens of
// thumbnails at once; before this wrapper existed, any single failure left
// the cell blank forever. We now retry up to THUMB_MAX_RETRIES times with
// exponential backoff and cache-busting query params before rendering a
// clickable placeholder the user can tap to retry manually.
//
// The component is intentionally keyed on `src` so that when a slot is
// recycled for a different photo (e.g. the user clicks a sidebar group and
// the grid now shows different cells in the same DOM positions), retry
// state resets cleanly for the new photo.
// --------------------------------------------------------------------------

const THUMB_MAX_RETRIES = 3;
const THUMB_RETRY_BASE_MS = 500;

function Thumbnail({ src, alt, className, draggable }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef(null);

  // Reset when the src changes (different photo got recycled into this slot).
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [src]);

  // Clean up any pending retry when the component unmounts.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Append a cache-buster on retries so the browser actually refetches
  // instead of replaying a cached error response. The server ignores unknown
  // query params on /image/download, so `_r=N` is a no-op on the wire.
  const actualSrc = attempt > 0
    ? `${src}${src.includes('?') ? '&' : '?'}_r=${attempt}`
    : src;

  const onError = () => {
    if (attempt >= THUMB_MAX_RETRIES) {
      setFailed(true);
      return;
    }
    const delay = THUMB_RETRY_BASE_MS * (1 << attempt);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setAttempt((a) => a + 1);
    }, delay);
  };

  const manualRetry = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setFailed(false);
    setAttempt((a) => a + 1);
  };

  if (failed) {
    return html`
      <div class=${(className ? className + ' ' : '') + 'thumb-broken'}
           role="button"
           tabIndex=${0}
           title="Thumbnail didn't load — click to try again"
           onClick=${manualRetry}>
        <span class="thumb-broken-icon">↻</span>
      </div>
    `;
  }

  return html`<img src=${actualSrc}
                   alt=${alt || ''}
                   class=${className}
                   loading="lazy"
                   decoding="async"
                   draggable=${draggable}
                   onError=${onError} />`;
}

// --------------------------------------------------------------------------
// GroupList — 320px sidebar, 56×56 square thumbs from group's MIDDLE photo
// --------------------------------------------------------------------------

function GroupList({ sidebarRef, parsed, photos, groups, groupSelCounts, cameras, activeGroupIdx, onJump }) {
  const camByKey = new Map((cameras || []).map((c) => [c.key, c]));
  const camStats = new Map();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const s = camStats.get(g.cameraKey) || { photos: 0, selected: 0 };
    s.photos += g.count;
    s.selected += groupSelCounts[i] || 0;
    camStats.set(g.cameraKey, s);
  }

  // Partition groups into camera sections so each sticky header is scoped to
  // its own section; without the wrapper, siblings all latch onto top:0 and
  // stack on top of each other.
  const sections = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const last = sections[sections.length - 1];
    if (!last || last.cameraKey !== g.cameraKey) {
      sections.push({ cameraKey: g.cameraKey, items: [{ g, i }] });
    } else {
      last.items.push({ g, i });
    }
  }

  return html`
    <aside class="group-list" ref=${sidebarRef}>
      ${sections.map((sec) => {
        const cam = camByKey.get(sec.cameraKey) || { key: sec.cameraKey, count: 0, meta: null };
        const st = camStats.get(sec.cameraKey) || { photos: 0, selected: 0 };
        return html`
          <section class="cam-section" key=${`cam-${sec.cameraKey}`}>
            <${CameraHeader} camera=${cam} stats=${st} />
            ${sec.items.map(({ g, i }) => {
              const midIdx = g.indices[Math.floor(g.indices.length / 2)];
              const mid = photos[midIdx];
              const selCount = groupSelCounts[i] || 0;
              const active = i === activeGroupIdx;
              const cls = ['group-row'];
              if (active) cls.push('active');
              return html`
                <div key=${`g-${i}`}
                     data-g=${i}
                     class=${cls.join(' ')}
                     onClick=${() => onJump(i)}>
                  <div class="thumb">
                    <${Thumbnail} src=${buildImageUrl(mid, parsed, 'preview')}
                                  alt="" />
                  </div>
                  <div class="meta">
                    <div class="time">
                      ${fmtTime(g.startTime)}
                      <span class="tm-sep">–</span>
                      ${fmtTime(g.endTime)}
                    </div>
                    <div class="sub">
                      <span>${g.count} photos</span>
                      <span class="sep-bullet">·</span>
                      <span class="dur-chip">${fmtDuration(g.durationSec)}</span>
                    </div>
                  </div>
                  <div class=${`badge ${selCount > 0 ? 'sel' : (active ? 'active-tot' : '')}`}>
                    ${selCount > 0 ? selCount : g.count}
                  </div>
                </div>
              `;
            })}
          </section>
        `;
      })}
    </aside>
  `;
}

// --------------------------------------------------------------------------
// CameraHeader — section header in the sidebar. Shows make/model and body
// serial when EXIF has been probed; falls back to the filename prefix until
// then. This is the primary "distinguishing feature" surface the user sees.
// --------------------------------------------------------------------------

function CameraHeader({ camera, stats }) {
  const meta = camera.meta;
  const hasName = meta && (meta.model || meta.make);
  const label = hasName ? (meta.model || meta.make) : `Camera ${camera.key}`;
  const serial = meta && meta.serial;
  const failed = meta && meta.failed;
  const loading = !meta;
  const camSvg = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
  return html`
    <div class="cam-header" title=${serial ? `Body serial: ${serial}` : ''}>
      <div class="cam-header-top">
        <span class="cam-icon">${camSvg}</span>
        <span class="cam-label">${label}</span>
      </div>
      <div class="cam-header-sub">
        ${serial
          ? html`<span class="cam-serial"><span class="cam-serial-icon"></span>SN ${serial}</span>`
          : (loading
              ? html`<span class="cam-serial loading">reading EXIF…</span>`
              : html`<span class="cam-serial"><span class="cam-serial-icon"></span>prefix ${camera.key}${failed ? ' · no EXIF' : ''}</span>`)}
        <span class="cam-count">
          ${stats.photos.toLocaleString()} photos${stats.selected ? html` · <span class="cc-sel">${stats.selected} selected</span>` : ''}
        </span>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// PhotoGrid — active group only, numbered #1..#N
// --------------------------------------------------------------------------

function PhotoGrid({
  gridScrollRef, parsed, photos, group, activeCamera,
  activeGroupIdx, groupCount, selectedInGroup,
  selected, onCellClick, onCellOpen,
  onPrevGroup, onNextGroup,
}) {
  if (!group) {
    return html`
      <div class="grid-scroll grid-scroll2" ref=${gridScrollRef}>
        <div class="grid-empty">
          <div class="ge-icon">◦</div>
          <div>No groups — paste a gallery link to begin.</div>
        </div>
      </div>
    `;
  }
  const camLabel = activeCamera?.meta?.model
    || activeCamera?.meta?.make
    || `Camera ${group.cameraKey}`;
  return html`
    <div class="grid-scroll grid-scroll2" ref=${gridScrollRef}>
      <div class="grid-head">
        <div class="gh-title">
          <span class="gh-camera" title=${activeCamera?.meta?.serial ? `Body serial: ${activeCamera.meta.serial}` : ''}>
            <span class="dot"></span>
            ${camLabel}
          </span>
          <span class="gh-when">
            ${fmtDateTime(group.startTime)}
            <span style=${{ color: 'var(--text-faint)', margin: '0 6px' }}>→</span>
            ${fmtTime(group.endTime)}
          </span>
        </div>
        <span class="gh-sub">
          <span>${group.count} photos</span>
          <span class="dot"></span>
          <span>${fmtDuration(group.durationSec)}</span>
          ${selectedInGroup > 0 ? html`
            <span class="dot"></span>
            <span style=${{ color: 'var(--ok)' }}>${selectedInGroup} selected</span>
          ` : null}
        </span>
        <span class="gh-spacer"></span>
        <span class="gh-sub" style=${{ color: 'var(--text-faint)' }}>
          Group <strong style=${{ color: 'var(--text)' }}>${activeGroupIdx + 1}</strong> / ${groupCount}
        </span>
        <span class="gh-actions">
          <button class="gh-nav-btn" onClick=${onPrevGroup}
                  disabled=${activeGroupIdx === 0}
                  title="Previous group (↑)">‹</button>
          <button class="gh-nav-btn" onClick=${onNextGroup}
                  disabled=${activeGroupIdx >= groupCount - 1}
                  title="Next group (↓)">›</button>
        </span>
      </div>
      <div class="grid grid2">
        ${group.indices.map((pIdx, withinIdx) => {
          const photo = photos[pIdx];
          return html`<${Cell}
            key=${photo.id}
            photo=${photo}
            parsed=${parsed}
            pIdx=${pIdx}
            withinIdx=${withinIdx}
            isSel=${selected.has(photo.id)}
            onClick=${onCellClick}
            onOpen=${onCellOpen}
          />`;
        })}
      </div>
    </div>
  `;
}

// Memoized cell — the grid can hold up to 1000 of these, so skipping
// re-renders when a cell's own props haven't changed is a huge win. The
// most common trigger for a whole-grid re-render used to be a selection
// toggle: every cell saw a new handler + new `selected` Set, even the
// ones that were neither selected nor deselected. With stable callbacks
// and React.memo, only the cells whose `isSel` flipped re-render.
const Cell = React.memo(function Cell({
  photo, parsed, pIdx, withinIdx, isSel, onClick, onOpen,
}) {
  const cls = ['cell', 'cell2'];
  if (isSel) cls.push('selected');
  if (!photo.downloadable) cls.push('disabled');
  const handleClick = (e) => onClick(pIdx, e);
  const handleDouble = () => onOpen(withinIdx);
  return html`
    <div class=${cls.join(' ')}
         onClick=${handleClick}
         onDoubleClick=${handleDouble}
         title=${photo.contentName}>
      <${Thumbnail} src=${buildImageUrl(photo, parsed, 'preview')}
                    alt=${photo.contentName}
                    draggable=${false} />
      <div class="num-label">#${withinIdx + 1}</div>
      <div class="sel-check">✓</div>
      <div class="meta-overlay">
        <div class="m-name">${photo.contentName || `photo-${photo.id}`}</div>
        <div class="m-sub">
          <span class="m-time">${fmtClock(photo.shotTime)}</span>
          <span class="m-size">${fmtBytes(photo.contentSize)}</span>
        </div>
      </div>
    </div>
  `;
});

// --------------------------------------------------------------------------
// Lightbox — full-res overlay opened on double-click
// --------------------------------------------------------------------------

function Lightbox({ parsed, photo, current, total, isSelected, onPrev, onNext, onToggle, onClose }) {
  return html`
    <div class="lightbox" onClick=${onClose}>
      <div class="lb-inner" onClick=${(e) => e.stopPropagation()}>
        <img src=${buildImageUrl(photo, parsed, 'full')} alt=${photo.contentName} />
        <div class="lb-info">
          <span class="lb-count"><strong>${current}</strong> / ${total}</span>
          <span class="lb-name">${photo.contentName}</span>
          <span class="lb-meta-chip">
            <span class="dot"></span>
            ${fmtClock(photo.shotTime)}
          </span>
          <span class="lb-meta-chip">${fmtBytes(photo.contentSize) || '—'}</span>
          <div class="spacer"></div>
          <button class=${isSelected ? 'primary' : ''} onClick=${onToggle}>
            ${isSelected ? '✓ Selected' : 'Select'} · <span class="kbd">Space</span>
          </button>
        </div>
        <button class="lb-nav prev" onClick=${onPrev} title="Previous (←)">‹</button>
        <button class="lb-nav next" onClick=${onNext} title="Next (→)">›</button>
        <button class="lb-close" onClick=${onClose} title="Close (Esc)">×</button>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// DownloadPanel — 520px floating panel, draggable by title bar, collapsible
// --------------------------------------------------------------------------

function DownloadPanel({ queue, onClose }) {
  const [pos, setPos] = useState({ x: null, y: null });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef(null);

  const state = queue.state;
  const summary = queue.summary();
  const done = summary.done || 0;
  const err = summary.error || 0;
  const total = state.items.length;
  const finished = !state.running && !summary.active && !summary.pending;
  const pct = total ? Math.round(((done + err) / total) * 100) : 0;

  const onMouseDown = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const el = dragRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX)),
        y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const style = pos.x != null
    ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' }
    : null;

  return html`
    <div class=${`dl-panel dl-panel2 ${collapsed ? 'collapsed' : ''}`} ref=${dragRef} style=${style}>
      <div class="dl-hdr" onMouseDown=${onMouseDown}>
        <span class="dl-hdr-title">
          <span class="dl-icon">↓</span>
          Download manager
        </span>
        <span class="dl-count">
          <strong style=${{ color: 'var(--text)' }}>${done}</strong>
          <span class="dl-sep">/</span> ${total}
          ${err ? html` <span class="dl-sep">·</span> <span class="dl-err">${err} failed</span>` : null}
        </span>
        <div class="dl-spacer"></div>
        ${state.running
          ? html`<button class="ghost" onClick=${() => queue.pause()}>Stop</button>`
          : finished
            ? null
            : html`<button class="ghost" onClick=${() => queue.start()}>Resume</button>`}
        <button class="ghost" onClick=${() => setCollapsed((c) => !c)}
                title=${collapsed ? 'Expand' : 'Collapse'}>
          ${collapsed ? '▴' : '▾'}
        </button>
        <button class="ghost" onClick=${onClose} title="Close">×</button>
      </div>
      ${!collapsed ? html`
        <div class="dl-meta">
          <div class="dl-progress">
            <div class="fill" style=${{ width: pct + '%' }}></div>
          </div>
          <div class="dl-progress-sub">
            <span>${summary.active || 0} active · ${summary.pending || 0} queued</span>
            <span class="dl-pct">${pct}%</span>
          </div>
        </div>
        <div class="dl-hint">
          <span class="dh-icon">!</span>
          <span>Files save to your browser's Downloads folder. If the browser
          prompts to <strong>Allow multiple downloads</strong>, click Allow —
          otherwise only the first file lands.</span>
        </div>
        <div class="dl-body">
          ${state.items.map((it, idx) => {
            const s = it.status;
            const label =
              s === 'pending' ? 'queued'
              : s === 'active' ? (it.bytes ? 'saving' : 'fetching')
              : s === 'done' ? 'done'
              : s === 'error' ? 'failed'
              : s === 'cancelled' ? 'stopped'
              : s;
            return html`
              <div class=${`dl-row st-${s}`} key=${it.photo.id}>
                <span class="dot-state"></span>
                <span class="fn" title=${it.photo.contentName}>
                  ${it.photo.contentName || `photo-${it.photo.id}`}
                </span>
                <span class="sz">${fmtBytes(it.bytes)}</span>
                <span class="st">
                  ${s === 'error' ? html`
                    <a href="#"
                       onClick=${(e) => { e.preventDefault(); queue.retry(idx); }}
                       title=${it.error || ''}>${label} ↻</a>
                  ` : label}
                </span>
              </div>
            `;
          })}
        </div>
      ` : null}
    </div>
  `;
}
