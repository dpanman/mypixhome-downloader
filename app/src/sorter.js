import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { buildImageUrl } from './api.js';
import { buildGalleryUrl, parseGalleryUrl } from './parser.js';
import { createDownloadQueue } from './download.js';

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

export function Sorter({ parsed, photos, cameraMeta, onReset, onRefetch, onChangeSource }) {
  const [gapSec, setGapSec] = useState(DEFAULT_GAP_SEC);
  const groups = useMemo(() => groupPhotos(photos, gapSec), [photos, gapSec]);
  const cameras = useMemo(
    () => summarizeCameras(photos, cameraMeta || {}),
    [photos, cameraMeta],
  );

  // Selection is a Set<photo.id> (numeric). lastClickedIdx is an index into
  // the flat photos[] array, used for shift-click range selection.
  const [selected, setSelected] = useState(() => new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState(null);
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
  const selectRange = useCallback((fromPhotoIdx, toPhotoIdx) => {
    const lo = Math.min(fromPhotoIdx, toPhotoIdx);
    const hi = Math.max(fromPhotoIdx, toPhotoIdx);
    const targetSelected = selected.has(photos[toPhotoIdx].id);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let j = lo; j <= hi; j++) {
        const p = photos[j];
        if (!p.downloadable) continue;
        if (targetSelected) next.delete(p.id); else next.add(p.id);
      }
      return next;
    });
  }, [selected, photos]);

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
    if (e.shiftKey && lastClickedIdx != null) {
      selectRange(lastClickedIdx, pIdx);
    } else {
      toggleOne(photo.id);
    }
    setLastClickedIdx(pIdx);
  }, [lastClickedIdx, selectRange, toggleOne, photos]);

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

  return html`
    <div class="sorter">
      <${SourceBar} parsed=${parsed} onChangeSource=${onChangeSource} />
      <${TopBar}
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
        onReset=${onReset}
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
          selected=${selected}
          onCellClick=${handleCellClick}
          onCellOpen=${(withinIdx) => setLightboxIdx(withinIdx)}
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
    <div class="allow-modal" role="dialog" aria-modal="true">
      <div class="allow-modal-card">
        <div class="allow-modal-icon">⚠️</div>
        <div class="allow-modal-title">
          Click <u>Allow</u> when your browser asks
        </div>
        <div class="allow-modal-headline">
          About to download <strong>${count.toLocaleString()}</strong>
          ${count === 1 ? ' photo' : ' photos'}.
        </div>
        <div class="allow-modal-body">
          Chrome will pop up
          <em>"Allow site to download multiple files?"</em>
          at the top of the window.
          <br /><br />
          If you click <strong>Block</strong> — or ignore the prompt — only
          the first photo will save. The rest will silently fail even though
          this panel says "done".
        </div>
        <div class="allow-modal-actions">
          <button class="allow-modal-cancel" onClick=${onCancel}>Cancel</button>
          <button class="allow-modal-go primary" onClick=${onConfirm} autoFocus>
            Got it — start downloading
          </button>
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// SourceBar — slim strip that shows the gallery URL we're pulling from.
// The "Change source" button opens a dialog where the user can paste a new
// MyPixhome link without going back to the landing screen.
// --------------------------------------------------------------------------

function SourceBar({ parsed, onChangeSource }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!parsed) return null;
  const url = buildGalleryUrl(parsed);
  return html`
    <div class="source-bar">
      <span class="source-label">Source:</span>
      <a class="source-link"
         href=${url}
         target="_blank"
         rel="noopener noreferrer"
         title=${url}>${url}</a>
      <button class="source-change"
              onClick=${() => setDialogOpen(true)}>
        Change source
      </button>
      ${dialogOpen ? html`
        <${ChangeSourceDialog}
          currentUrl=${url}
          onClose=${() => setDialogOpen(false)}
          onSubmit=${(raw) => { setDialogOpen(false); onChangeSource(raw); }}
        />
      ` : null}
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
    <div class="change-source-modal" role="dialog" aria-modal="true" onClick=${onClose}>
      <div class="change-source-card" onClick=${(e) => e.stopPropagation()}>
        <div class="change-source-title">Load a different gallery</div>
        <form class="change-source-form" onSubmit=${submit}>
          <input type="url"
                 value=${raw}
                 onChange=${(e) => setRaw(e.target.value)}
                 placeholder="https://<name>.mypixhome.com/instant-gallery/…"
                 autoFocus />
          <div class="change-source-actions">
            <button type="button" onClick=${onClose}>Cancel</button>
            <button type="submit" class="primary">Load</button>
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
  totalPhotos, groupCount, cameraCount, selectedCount,
  gapSec, onGapChange,
  onSelectAllInGroup, onUnselectGroup, onClearAll,
  onDownload, hasQueue, onReset, onRefetch,
}) {
  return html`
    <header class="topbar2">
      <div class="stats">
        <strong>${totalPhotos.toLocaleString()}</strong> photos ·
        <strong>${(cameraCount || 0).toLocaleString()}</strong> ${cameraCount === 1 ? 'camera' : 'cameras'} ·
        <strong>${groupCount.toLocaleString()}</strong> groups ·
        <strong>${selectedCount.toLocaleString()}</strong> selected
      </div>
      <div class="spacer"></div>
      <label class="gap-picker" title="Split groups on shot-time gaps larger than this">
        Gap
        <select value=${String(gapSec)} onChange=${(e) => onGapChange(Number(e.target.value))}>
          ${GAP_OPTIONS.map((s) => html`<option key=${s} value=${String(s)}>${s}s</option>`)}
        </select>
      </label>
      <button onClick=${onSelectAllInGroup}>Select all in group</button>
      <button onClick=${onUnselectGroup}>Unselect group</button>
      <button class="danger" onClick=${onClearAll} disabled=${selectedCount === 0}>
        Clear all
      </button>
      <button class="primary"
              onClick=${onDownload}
              disabled=${selectedCount === 0 || hasQueue}>
        Download selected (${selectedCount})
      </button>
      <div class="topbar-divider"></div>
      <button class="ghost" onClick=${onRefetch} title="Clear cache and refetch">↻</button>
      <button class="ghost" onClick=${onReset} title="Load a different gallery">✕</button>
    </header>
  `;
}

// --------------------------------------------------------------------------
// GroupList — 320px sidebar, 56×56 square thumbs from group's MIDDLE photo
// --------------------------------------------------------------------------

function GroupList({ sidebarRef, parsed, photos, groups, groupSelCounts, cameras, activeGroupIdx, onJump }) {
  // Index cameras by key for the header rows.
  const camByKey = new Map((cameras || []).map((c) => [c.key, c]));
  // Per-camera totals (photos + currently selected).
  const camStats = new Map();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const s = camStats.get(g.cameraKey) || { photos: 0, selected: 0 };
    s.photos += g.count;
    s.selected += groupSelCounts[i] || 0;
    camStats.set(g.cameraKey, s);
  }

  // Partition groups into camera sections so each sticky header is scoped to
  // its own section. Without the wrapper, all `.cam-header`s share the same
  // scroll parent and pile up at top:0 — the first section appears to fill
  // the sidebar and the second header is hidden behind it.
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
              const cls = ['group-row'];
              if (i === activeGroupIdx) cls.push('active');
              return html`
                <div key=${`g-${i}`}
                     data-g=${i}
                     class=${cls.join(' ')}
                     onClick=${() => onJump(i)}>
                  <div class="thumb">
                    <img src=${buildImageUrl(mid, parsed, 'preview')}
                         alt="" loading="lazy" decoding="async" />
                  </div>
                  <div class="meta">
                    <div class="time">${fmtDateTime(g.startTime)}</div>
                    <div class="sub">${g.count} photos · ${fmtDuration(g.durationSec)}</div>
                  </div>
                  <div class=${`badge ${selCount > 0 ? 'sel' : 'tot'}`}>
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
  return html`
    <div class="cam-header" title=${serial ? `Body serial: ${serial}` : ''}>
      <div class="cam-header-top">
        <span class="cam-icon">📷</span>
        <span class="cam-label">${label}</span>
      </div>
      <div class="cam-header-sub">
        ${serial
          ? html`<span class="cam-serial">SN ${serial}</span>`
          : (loading
              ? html`<span class="cam-serial loading">reading EXIF…</span>`
              : html`<span class="cam-serial">file prefix ${camera.key}${failed ? ' · no EXIF' : ''}</span>`)}
        <span class="cam-count">
          ${stats.photos.toLocaleString()} photos${stats.selected ? ` · ${stats.selected} sel` : ''}
        </span>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// PhotoGrid — active group only, numbered #1..#N
// --------------------------------------------------------------------------

function PhotoGrid({ gridScrollRef, parsed, photos, group, selected, onCellClick, onCellOpen }) {
  if (!group) {
    return html`<div class="grid-scroll2" ref=${gridScrollRef}></div>`;
  }
  return html`
    <div class="grid-scroll2" ref=${gridScrollRef}>
      <div class="grid2">
        ${group.indices.map((pIdx, withinIdx) => {
          const photo = photos[pIdx];
          const isSel = selected.has(photo.id);
          const cls = ['cell2'];
          if (isSel) cls.push('selected');
          if (!photo.downloadable) cls.push('disabled');
          return html`
            <div key=${photo.id}
                 class=${cls.join(' ')}
                 onClick=${(e) => onCellClick(pIdx, e)}
                 onDoubleClick=${() => onCellOpen(withinIdx)}
                 title=${photo.contentName}>
              <img src=${buildImageUrl(photo, parsed, 'preview')}
                   alt=${photo.contentName}
                   loading="lazy" decoding="async" draggable="false" />
              <div class="num-label">#${withinIdx + 1}</div>
              <div class="sel-dot">${isSel ? '✓' : ''}</div>
              <div class="meta-overlay">
                <div class="m-name">${photo.contentName || `photo-${photo.id}`}</div>
                <div class="m-sub">
                  <span class="m-time">${fmtClock(photo.shotTime)}</span>
                  <span class="m-size">${fmtBytes(photo.contentSize)}</span>
                </div>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Lightbox — full-res overlay opened on double-click
// --------------------------------------------------------------------------

function Lightbox({ parsed, photo, current, total, isSelected, onPrev, onNext, onToggle, onClose }) {
  return html`
    <div class="lightbox" onClick=${onClose}>
      <div class="lb-inner" onClick=${(e) => e.stopPropagation()}>
        <img src=${buildImageUrl(photo, parsed, 'full')} alt=${photo.contentName} />
        <div class="lb-info">
          <span class="lb-count">${current} / ${total}</span>
          <span class="lb-name">${photo.contentName}</span>
          <div class="spacer"></div>
          <button class=${isSelected ? 'primary' : ''} onClick=${onToggle}>
            ${isSelected ? '✓ Selected' : 'Select'} (space)
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
    <div class=${`dl-panel2 ${collapsed ? 'collapsed' : ''}`} ref=${dragRef} style=${style}>
      <div class="dl-hdr" onMouseDown=${onMouseDown}>
        <strong>Download Manager</strong>
        <span class="dl-count">
          ${done}/${total}${err ? html` · <span class="dl-err">${err} failed</span>` : null}
        </span>
        <div class="spacer"></div>
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
        <div class="dl-hint">
          Files save to your browser's Downloads folder. If Chrome asks to
          allow multiple downloads, click <strong>Allow</strong> — otherwise
          only the first file lands.
        </div>
        <div class="dl-body">
          ${state.items.map((it, idx) => {
            const s = it.status;
            const label =
              s === 'pending' ? 'queued'
              : s === 'active' ? (it.bytes ? 'saving…' : 'fetching…')
              : s === 'done' ? 'done'
              : s === 'error' ? 'failed'
              : s === 'cancelled' ? 'stopped'
              : s;
            const cls = `dl-row st-${s} ${idx % 2 ? 'odd' : 'even'}`;
            return html`
              <div class=${cls} key=${it.photo.id}>
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
        <div class="dl-progress">
          <div class="fill" style=${{ width: pct + '%' }}></div>
        </div>
      ` : null}
    </div>
  `;
}
