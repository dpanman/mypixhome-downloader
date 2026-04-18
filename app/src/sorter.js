import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { buildImageUrl } from './api.js';
import { createDownloadQueue, supportsFileSystemAccess, pickDirectory } from './download.js';

const html = htm.bind(React.createElement);

// --------------------------------------------------------------------------
// Public component
// --------------------------------------------------------------------------

export function Sorter({ parsed, photos, onReset, onRefetch }) {
  // Photos are already sorted by shotTime ascending (see api.js fetchAllPhotos).
  // Compute the time range once.
  const timeBounds = useMemo(() => {
    if (!photos.length) return { min: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const p of photos) {
      const t = p.shotTime || 0;
      if (!t) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 0;
    return { min, max };
  }, [photos]);

  // Time filter window (inclusive). Defaults to full range.
  const [tRange, setTRange] = useState(() => [timeBounds.min, timeBounds.max]);

  // When photos change, reset the slider to the full range.
  useEffect(() => {
    setTRange([timeBounds.min, timeBounds.max]);
  }, [timeBounds.min, timeBounds.max]);

  // Which photo indices pass the filter — an ordered list.
  const visibleIdx = useMemo(() => {
    const out = [];
    for (let i = 0; i < photos.length; i++) {
      const t = photos[i].shotTime || 0;
      if (t >= tRange[0] && t <= tRange[1]) out.push(i);
    }
    return out;
  }, [photos, tRange]);

  // Selected photo indices (into the full photos array). Use a Set for perf.
  const [selected, setSelected] = useState(() => new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState(null);
  const [focusedIdx, setFocusedIdx] = useState(null);

  // Download queue (null until the user presses Download).
  const [queue, setQueue] = useState(null);
  const [queueTick, setQueueTick] = useState(0);
  const queueRef = useRef(null);

  // ----- selection helpers ------------------------------------------------

  const toggleOne = useCallback((i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const selectRange = useCallback((fromVisibleIdx, toVisibleIdx) => {
    const lo = Math.min(fromVisibleIdx, toVisibleIdx);
    const hi = Math.max(fromVisibleIdx, toVisibleIdx);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let j = lo; j <= hi; j++) next.add(visibleIdx[j]);
      return next;
    });
  }, [visibleIdx]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selectAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visibleIdx) next.add(i);
      return next;
    });
  }, [visibleIdx]);

  const invertVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visibleIdx) {
        if (next.has(i)) next.delete(i); else next.add(i);
      }
      return next;
    });
  }, [visibleIdx]);

  // Remove any selections that fall outside the currently-visible window
  // when the filter tightens? No — we keep them sticky so the user can
  // slide back later and still see them.

  // ----- click handler ----------------------------------------------------

  const handleCellClick = useCallback((photoIdx, e) => {
    // Find this photo's position within the visible list, for shift-range.
    const vIdx = visibleIdx.indexOf(photoIdx);
    if (e.shiftKey && lastClickedIdx != null) {
      const vLast = visibleIdx.indexOf(lastClickedIdx);
      if (vIdx !== -1 && vLast !== -1) {
        selectRange(vLast, vIdx);
      } else {
        toggleOne(photoIdx);
      }
    } else {
      toggleOne(photoIdx);
    }
    setLastClickedIdx(photoIdx);
    setFocusedIdx(photoIdx);
  }, [visibleIdx, lastClickedIdx, toggleOne, selectRange]);

  // ----- keyboard navigation ---------------------------------------------

  useEffect(() => {
    const onKey = (e) => {
      // Ignore if an input is focused.
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Ctrl/Cmd + A → select all visible
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAllVisible();
        return;
      }
      // Esc → clear selection
      if (e.key === 'Escape') {
        clearSelection();
        return;
      }
      // Arrow nav within visible set
      if (!visibleIdx.length) return;
      const currentVIdx = focusedIdx == null ? 0 : Math.max(0, visibleIdx.indexOf(focusedIdx));
      const cols = getGridCols();
      let nextV = currentVIdx;
      if (e.key === 'ArrowRight') nextV = Math.min(visibleIdx.length - 1, currentVIdx + 1);
      else if (e.key === 'ArrowLeft') nextV = Math.max(0, currentVIdx - 1);
      else if (e.key === 'ArrowDown') nextV = Math.min(visibleIdx.length - 1, currentVIdx + cols);
      else if (e.key === 'ArrowUp') nextV = Math.max(0, currentVIdx - cols);
      else if (e.key === ' ' || e.key === 'Enter') {
        if (focusedIdx != null) {
          e.preventDefault();
          toggleOne(focusedIdx);
        }
        return;
      } else {
        return;
      }
      e.preventDefault();
      const nextPhotoIdx = visibleIdx[nextV];
      setFocusedIdx(nextPhotoIdx);
      // Auto-scroll focused cell into view.
      requestAnimationFrame(() => {
        const cell = document.querySelector(`[data-pidx="${nextPhotoIdx}"]`);
        if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleIdx, focusedIdx, selectAllVisible, clearSelection, toggleOne]);

  // ----- download ---------------------------------------------------------

  const startDownload = useCallback(async () => {
    if (selected.size === 0) return;
    const selectedPhotos = [];
    for (const i of selected) selectedPhotos.push(photos[i]);
    selectedPhotos.sort((a, b) => (a.shotTime || 0) - (b.shotTime || 0));

    let dirHandle = null;
    if (supportsFileSystemAccess()) {
      try {
        dirHandle = await pickDirectory();
      } catch {
        // User cancelled the picker; treat as "browser downloads" fallback.
        dirHandle = null;
      }
    }

    const q = createDownloadQueue({
      photos: selectedPhotos,
      dirHandle,
      concurrency: 4,
      onUpdate: () => setQueueTick((t) => t + 1),
    });
    queueRef.current = q;
    setQueue(q);
    q.start();
  }, [selected, photos]);

  const closeQueue = useCallback(() => {
    if (queueRef.current) queueRef.current.cancel();
    queueRef.current = null;
    setQueue(null);
  }, []);

  // ----- render -----------------------------------------------------------

  const totalPhotos = photos.length;
  const visibleCount = visibleIdx.length;
  const selectedCount = selected.size;

  return html`
    <div class="app">
      <${TopBar}
        parsed=${parsed}
        totalPhotos=${totalPhotos}
        onReset=${onReset}
        onRefetch=${onRefetch}
      />
      <${FilterBar}
        timeBounds=${timeBounds}
        tRange=${tRange}
        onChange=${setTRange}
        visibleCount=${visibleCount}
        totalPhotos=${totalPhotos}
        selectedCount=${selectedCount}
      />
      <${PhotoGrid}
        photos=${photos}
        visibleIdx=${visibleIdx}
        selected=${selected}
        focusedIdx=${focusedIdx}
        onCellClick=${handleCellClick}
      />
      <${BottomBar}
        selectedCount=${selectedCount}
        visibleCount=${visibleCount}
        onSelectAllVisible=${selectAllVisible}
        onInvert=${invertVisible}
        onClearSelection=${clearSelection}
        onDownload=${startDownload}
        hasQueue=${!!queue}
      />
      ${queue ? html`<${DownloadPanel} queue=${queue} tick=${queueTick} onClose=${closeQueue} />` : null}
    </div>
  `;
}

// --------------------------------------------------------------------------
// Top bar
// --------------------------------------------------------------------------

function TopBar({ parsed, totalPhotos, onReset, onRefetch }) {
  return html`
    <header class="topbar">
      <div class="title">Gallery Sorter</div>
      <div class="gallery-meta" title=${`${parsed.domain}/instant-gallery/${parsed.slug}`}>
        ${parsed.slug} · ${totalPhotos.toLocaleString()} photos
      </div>
      <div class="actions">
        <button onClick=${onRefetch} title="Clear cache and refetch">Refetch</button>
        <button onClick=${onReset}>New gallery</button>
      </div>
    </header>
  `;
}

// --------------------------------------------------------------------------
// Filter bar — dual-range time slider
// --------------------------------------------------------------------------

function FilterBar({ timeBounds, tRange, onChange, visibleCount, totalPhotos, selectedCount }) {
  const hasRange = timeBounds.max > timeBounds.min;
  const onLo = (e) => {
    const v = Number(e.target.value);
    onChange([Math.min(v, tRange[1]), tRange[1]]);
  };
  const onHi = (e) => {
    const v = Number(e.target.value);
    onChange([tRange[0], Math.max(v, tRange[0])]);
  };
  const reset = () => onChange([timeBounds.min, timeBounds.max]);

  return html`
    <div class="filterbar">
      <div class="count">
        <strong>${visibleCount.toLocaleString()}</strong> of ${totalPhotos.toLocaleString()} visible
        · <strong>${selectedCount.toLocaleString()}</strong> selected
      </div>
      ${hasRange ? html`
        <div class="slider-wrap">
          <span>${formatTime(tRange[0])}</span>
          <input type="range" min=${timeBounds.min} max=${timeBounds.max} step="1"
            value=${tRange[0]} onInput=${onLo} />
          <input type="range" min=${timeBounds.min} max=${timeBounds.max} step="1"
            value=${tRange[1]} onInput=${onHi} />
          <span>${formatTime(tRange[1])}</span>
          <button class="ghost" onClick=${reset} title="Reset time filter">Reset</button>
        </div>
      ` : null}
    </div>
  `;
}

function formatTime(t) {
  if (!t) return '—';
  // API returns seconds since epoch (13-digit = ms, 10-digit = s).
  const ms = t > 1e12 ? t : t * 1000;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.toLocaleDateString()} ${hh}:${mm}`;
}

function formatTimeShort(t) {
  if (!t) return '';
  const ms = t > 1e12 ? t : t * 1000;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// --------------------------------------------------------------------------
// Photo grid — virtualization-lite via loading="lazy"
// --------------------------------------------------------------------------

function PhotoGrid({ photos, visibleIdx, selected, focusedIdx, onCellClick }) {
  return html`
    <div class="grid-scroll">
      <div class="grid">
        ${visibleIdx.map((pIdx) => {
          const photo = photos[pIdx];
          const isSel = selected.has(pIdx);
          const isFocus = focusedIdx === pIdx;
          const cls = ['cell'];
          if (isSel) cls.push('selected');
          if (isFocus) cls.push('focused');
          if (!photo.downloadable) cls.push('disabled');
          return html`
            <div key=${photo.id}
                 class=${cls.join(' ')}
                 data-pidx=${pIdx}
                 onClick=${(e) => onCellClick(pIdx, e)}
                 title=${photo.contentName}>
              <img src=${buildImageUrl(photo, 'preview')}
                   alt=${photo.contentName}
                   loading="lazy"
                   decoding="async"
                   draggable="false" />
              <div class="tick">✓</div>
              <div class="time-label">${formatTimeShort(photo.shotTime)}</div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Bottom bar
// --------------------------------------------------------------------------

function BottomBar({ selectedCount, visibleCount, onSelectAllVisible, onInvert, onClearSelection, onDownload, hasQueue }) {
  return html`
    <div class="bottombar">
      <span class="selected-count">${selectedCount.toLocaleString()} selected</span>
      <button onClick=${onSelectAllVisible} disabled=${visibleCount === 0}>
        Select all visible
      </button>
      <button onClick=${onInvert} disabled=${visibleCount === 0}>Invert</button>
      <button onClick=${onClearSelection} disabled=${selectedCount === 0}>Clear</button>
      <div style=${{ flex: 1 }}></div>
      <span style=${{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
        <span class="kbd">Click</span> toggle · <span class="kbd">Shift+Click</span> range ·
        <span class="kbd">Ctrl/⌘+A</span> all visible · <span class="kbd">Esc</span> clear
      </span>
      <button class="primary" onClick=${onDownload} disabled=${selectedCount === 0 || hasQueue}>
        Download ${selectedCount > 0 ? selectedCount.toLocaleString() : ''}
      </button>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Download panel (floating)
// --------------------------------------------------------------------------

function DownloadPanel({ queue, tick, onClose }) {
  // Re-read state on every tick.
  const state = queue.state;
  const summary = queue.summary();
  const done = summary.done || 0;
  const err = summary.error || 0;
  const active = summary.active || 0;
  const pending = summary.pending || 0;
  const total = state.items.length;
  const pct = total ? Math.round(((done + err) / total) * 100) : 0;
  const finished = !state.running && active === 0 && pending === 0;

  return html`
    <div class="dl-panel">
      <div class="hdr">
        <strong>Downloading</strong>
        <span style=${{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          ${done}/${total} · ${pct}% ${err ? html`· <span class="st-error">${err} failed</span>` : null}
        </span>
      </div>
      <div class="body">
        ${state.items.map((it, idx) => {
          const s = it.status;
          const cls = `st-${s}`;
          return html`
            <div class="row" key=${it.photo.id}>
              <span title=${it.photo.contentName} style=${{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                marginRight: '6px', flex: 1
              }}>${it.photo.contentName || `photo-${it.photo.id}`}</span>
              <span class=${cls}>
                ${s === 'done' ? '✓' :
                  s === 'error' ? html`<span title=${it.error || ''}>✗ retry</span>` :
                  s === 'active' ? '…' :
                  '·'}
              </span>
              ${s === 'error' ? html`
                <button class="ghost"
                        style=${{ padding: '0 4px', marginLeft: '4px' }}
                        onClick=${() => queue.retry(idx)}>↻</button>
              ` : null}
            </div>
          `;
        })}
      </div>
      <div class="footer">
        ${!finished ? html`
          ${state.running
            ? html`<button onClick=${() => queue.pause()}>Pause</button>`
            : html`<button class="primary" onClick=${() => queue.start()}>Resume</button>`}
          <button class="danger" onClick=${() => { queue.cancel(); }}>Cancel</button>
        ` : html`
          <span style=${{ color: 'var(--ok)', alignSelf: 'center', flex: 1 }}>
            Done — ${done} saved${err ? `, ${err} failed` : ''}
          </span>
        `}
        <div style=${{ flex: 1 }}></div>
        <button onClick=${onClose}>${finished ? 'Close' : 'Hide'}</button>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function getGridCols() {
  const grid = document.querySelector('.grid');
  if (!grid) return 1;
  const style = window.getComputedStyle(grid);
  const cols = style.gridTemplateColumns.split(' ').filter(Boolean).length;
  return cols || 1;
}
