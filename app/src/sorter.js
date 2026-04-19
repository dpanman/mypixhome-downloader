import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { buildImageUrl } from './api.js';
import { createDownloadQueue, supportsFileSystemAccess, pickDirectory } from './download.js';

const html = htm.bind(React.createElement);

// --------------------------------------------------------------------------
// Grouping
// --------------------------------------------------------------------------

// Split photos (sorted by shotTime asc) into burst groups.
//   • split when gap between consecutive photos > gapSec
//   • soft-split when a group reaches softMaxSize (only if gap > miniSec, so
//     we don't chop up a continuous action run)
// Returns [{startIdx, endIdx, startTime, endTime, count, durationSec}]
function groupPhotos(photos, { gapSec = 30, softMaxSize = 250, miniSec = 2 } = {}) {
  if (!photos.length) return [];
  const groups = [];
  let start = 0;
  for (let i = 1; i <= photos.length; i++) {
    const atEnd = i === photos.length;
    const prevT = photos[i - 1].shotTime || 0;
    const nextT = atEnd ? Infinity : (photos[i].shotTime || 0);
    const gap = nextT - prevT;
    const size = i - start;
    const splitHere =
      atEnd ||
      gap > gapSec ||
      (size >= softMaxSize && gap >= miniSec);
    if (splitHere) {
      const g = {
        startIdx: start,
        endIdx: i - 1,
        startTime: photos[start].shotTime || 0,
        endTime: photos[i - 1].shotTime || 0,
        count: i - start,
      };
      g.durationSec = Math.max(0, g.endTime - g.startTime);
      groups.push(g);
      start = i;
    }
  }
  return groups;
}

// --------------------------------------------------------------------------
// Time helpers (shotTime is seconds-since-epoch)
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
function fmtTZ() {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).format(new Date());
    const m = s.match(/([A-Z]{2,5})$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// Parse "21:30" / "9:30 PM" / "21:30:15" → seconds since midnight, or null.
function parseHMS(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  const ap = (m[4] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

// --------------------------------------------------------------------------
// Top-level component
// --------------------------------------------------------------------------

export function Sorter({ parsed, photos, onReset, onRefetch }) {
  const groups = useMemo(() => groupPhotos(photos), [photos]);

  const [selected, setSelected] = useState(() => new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState(null);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);

  const [jumpVal, setJumpVal] = useState('');
  const [jumpErr, setJumpErr] = useState('');

  const [queue, setQueue] = useState(null);
  const [, setQueueTick] = useState(0);
  const queueRef = useRef(null);

  const gridScrollRef = useRef(null);
  const sidebarRef = useRef(null);

  // Per-group selected counts.
  const groupSelCounts = useMemo(() => {
    const counts = new Array(groups.length).fill(0);
    for (const i of selected) {
      let lo = 0, hi = groups.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = groups[mid];
        if (i < g.startIdx) hi = mid - 1;
        else if (i > g.endIdx) lo = mid + 1;
        else { counts[mid]++; break; }
      }
    }
    return counts;
  }, [groups, selected]);

  // ----- selection ops ---------------------------------------------------

  const toggleOne = useCallback((i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const selectRange = useCallback((a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let j = lo; j <= hi; j++) next.add(j);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setSelected(new Set()), []);

  const selectAllInGroup = useCallback((gIdx) => {
    const g = groups[gIdx];
    if (!g) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (let j = g.startIdx; j <= g.endIdx; j++) next.add(j);
      return next;
    });
  }, [groups]);

  const unselectGroup = useCallback((gIdx) => {
    const g = groups[gIdx];
    if (!g) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (let j = g.startIdx; j <= g.endIdx; j++) next.delete(j);
      return next;
    });
  }, [groups]);

  // ----- click handler ---------------------------------------------------

  const handleCellClick = useCallback((pIdx, e) => {
    if (e.shiftKey && lastClickedIdx != null) {
      selectRange(lastClickedIdx, pIdx);
    } else {
      toggleOne(pIdx);
    }
    setLastClickedIdx(pIdx);
  }, [lastClickedIdx, selectRange, toggleOne]);

  // ----- keyboard shortcuts ----------------------------------------------

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        // Ctrl/Cmd-A selects the currently-viewed group, not the whole library.
        e.preventDefault();
        selectAllInGroup(activeGroupIdx);
      } else if (e.key === 'Escape') {
        clearAll();
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
  }, [activeGroupIdx, groups.length, selectAllInGroup, clearAll]);

  // ----- scroll sidebar active row into view -----------------------------

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const row = el.querySelector(`[data-g="${activeGroupIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    // Reset scroll of main grid on group change.
    if (gridScrollRef.current) gridScrollRef.current.scrollTop = 0;
  }, [activeGroupIdx]);

  // ----- jump-to-time ----------------------------------------------------

  const jumpToTime = useCallback(() => {
    const secs = parseHMS(jumpVal);
    if (secs == null) {
      setJumpErr('Use HH:MM');
      setTimeout(() => setJumpErr(''), 2000);
      return;
    }
    let bestIdx = -1;
    for (let i = 0; i < groups.length; i++) {
      const d = new Date(groups[i].startTime * 1000);
      const local = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      if (local >= secs) { bestIdx = i; break; }
    }
    if (bestIdx === -1) bestIdx = groups.length - 1;
    setActiveGroupIdx(bestIdx);
  }, [jumpVal, groups]);

  // ----- download --------------------------------------------------------

  const startDownload = useCallback(async () => {
    if (selected.size === 0) return;
    const arr = Array.from(selected).sort((a, b) => a - b).map((i) => photos[i]);
    let dirHandle = null;
    if (supportsFileSystemAccess()) {
      try { dirHandle = await pickDirectory(); } catch { dirHandle = null; }
    }
    const q = createDownloadQueue({
      photos: arr,
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

  // ----- derived ---------------------------------------------------------

  const totalPhotos = photos.length;
  const selectedCount = selected.size;
  const totalBounds = useMemo(() => {
    if (!photos.length) return { min: 0, max: 0 };
    return {
      min: photos[0].shotTime || 0,
      max: photos[photos.length - 1].shotTime || 0,
    };
  }, [photos]);
  const activeGroup = groups[activeGroupIdx];

  // ----- render ----------------------------------------------------------

  return html`
    <div class="sorter">
      <${TopBar}
        totalPhotos=${totalPhotos}
        groupCount=${groups.length}
        selectedCount=${selectedCount}
        jumpVal=${jumpVal}
        jumpErr=${jumpErr}
        onJumpChange=${setJumpVal}
        onJump=${jumpToTime}
        onSelectAllInGroup=${() => selectAllInGroup(activeGroupIdx)}
        onUnselectGroup=${() => unselectGroup(activeGroupIdx)}
        onClearAll=${clearAll}
        onDownload=${startDownload}
        hasQueue=${!!queue}
        onReset=${onReset}
        onRefetch=${onRefetch}
      />
      <${Timeline}
        bounds=${totalBounds}
        activeGroup=${activeGroup}
        groups=${groups}
        onSeek=${setActiveGroupIdx}
      />
      <div class="sorter-body">
        <${GroupList}
          sidebarRef=${sidebarRef}
          photos=${photos}
          groups=${groups}
          groupSelCounts=${groupSelCounts}
          activeGroupIdx=${activeGroupIdx}
          onJump=${setActiveGroupIdx}
        />
        <${PhotoGrid}
          gridScrollRef=${gridScrollRef}
          photos=${photos}
          group=${activeGroup}
          selected=${selected}
          onCellClick=${handleCellClick}
        />
      </div>
      ${queue ? html`<${DownloadPanel} queue=${queue} onClose=${closeQueue} />` : null}
    </div>
  `;
}

// --------------------------------------------------------------------------
// TopBar
// --------------------------------------------------------------------------

function TopBar({
  totalPhotos, groupCount, selectedCount,
  jumpVal, jumpErr, onJumpChange, onJump,
  onSelectAllInGroup, onUnselectGroup, onClearAll,
  onDownload, hasQueue, onReset, onRefetch,
}) {
  const submit = (e) => { e && e.preventDefault(); onJump(); };
  return html`
    <header class="topbar2">
      <div class="stats">
        <strong>${totalPhotos.toLocaleString()}</strong> photos ·
        <strong>${groupCount.toLocaleString()}</strong> groups ·
        <strong>${selectedCount.toLocaleString()}</strong> selected
      </div>
      <div class="spacer"></div>
      <form class="jump" onSubmit=${submit}>
        <input type="text"
               placeholder="Jump to time (e.g. 21:30)"
               value=${jumpVal}
               onChange=${(e) => onJumpChange(e.target.value)}
               title=${jumpErr || 'Scroll to HH:MM'} />
      </form>
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
// Timeline
// --------------------------------------------------------------------------

function Timeline({ bounds, activeGroup, groups, onSeek }) {
  const span = Math.max(1, bounds.max - bounds.min);
  const dotPct = activeGroup
    ? ((activeGroup.startTime - bounds.min) / span) * 100
    : 0;
  const trackRef = useRef(null);
  const onTrackClick = (e) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetT = bounds.min + pct * span;
    let bestIdx = 0, bestDelta = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const d = Math.abs(groups[i].startTime - targetT);
      if (d < bestDelta) { bestDelta = d; bestIdx = i; }
    }
    onSeek(bestIdx);
  };
  return html`
    <div class="timeline">
      <span class="t-label">Time →</span>
      <div class="t-track" ref=${trackRef} onClick=${onTrackClick}>
        ${groups.map((g, i) => {
          const leftPct = ((g.startTime - bounds.min) / span) * 100;
          return html`<div class="t-tick" key=${i} style=${{ left: `${leftPct}%` }}></div>`;
        })}
        <div class="t-dot" style=${{ left: `${dotPct}%` }}></div>
      </div>
      <span class="t-range">
        ${activeGroup ? fmtDateTime(activeGroup.startTime) : fmtDateTime(bounds.max)} ${fmtTZ()}
      </span>
    </div>
  `;
}

// --------------------------------------------------------------------------
// GroupList (left sidebar)
// --------------------------------------------------------------------------

function GroupList({ sidebarRef, photos, groups, groupSelCounts, activeGroupIdx, onJump }) {
  return html`
    <aside class="group-list" ref=${sidebarRef}>
      ${groups.map((g, i) => {
        const first = photos[g.startIdx];
        const selCount = groupSelCounts[i] || 0;
        const allSelected = selCount === g.count;
        const cls = ['group-row'];
        if (i === activeGroupIdx) cls.push('active');
        return html`
          <div key=${i}
               data-g=${i}
               class=${cls.join(' ')}
               onClick=${() => onJump(i)}>
            <div class="thumb">
              <img src=${buildImageUrl(first, 'preview')}
                   alt="" loading="lazy" decoding="async" />
            </div>
            <div class="meta">
              <div class="time">${fmtDateTime(g.startTime)}</div>
              <div class="sub">${g.count} photos · ${fmtDuration(g.durationSec)}</div>
            </div>
            ${selCount > 0 ? html`
              <div class=${`badge ${allSelected ? 'all' : 'some'}`}>
                ${selCount}
              </div>
            ` : null}
          </div>
        `;
      })}
    </aside>
  `;
}

// --------------------------------------------------------------------------
// PhotoGrid — renders ONLY the active group's photos, numbered #1..#N
// --------------------------------------------------------------------------

function PhotoGrid({ gridScrollRef, photos, group, selected, onCellClick }) {
  if (!group) {
    return html`<div class="grid-scroll2" ref=${gridScrollRef}></div>`;
  }
  const indices = [];
  for (let i = group.startIdx; i <= group.endIdx; i++) indices.push(i);
  return html`
    <div class="grid-scroll2" ref=${gridScrollRef}>
      <div class="grid2">
        ${indices.map((pIdx) => {
          const photo = photos[pIdx];
          const numInGroup = pIdx - group.startIdx + 1;
          const isSel = selected.has(pIdx);
          const cls = ['cell2'];
          if (isSel) cls.push('selected');
          if (!photo.downloadable) cls.push('disabled');
          return html`
            <div key=${photo.id}
                 class=${cls.join(' ')}
                 onClick=${(e) => onCellClick(pIdx, e)}
                 title=${photo.contentName}>
              <img src=${buildImageUrl(photo, 'preview')}
                   alt=${photo.contentName}
                   loading="lazy" decoding="async" draggable="false" />
              <div class="num-label">#${numInGroup}</div>
              <div class="sel-dot">${isSel ? '✓' : ''}</div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// DownloadPanel (floating)
// --------------------------------------------------------------------------

function DownloadPanel({ queue, onClose }) {
  const state = queue.state;
  const summary = queue.summary();
  const done = summary.done || 0;
  const err = summary.error || 0;
  const total = state.items.length;
  const finished = !state.running && !summary.active && !summary.pending;

  return html`
    <div class="dl-panel2">
      <div class="dl-hdr">
        <strong>Download Manager</strong>
        <span class="dl-count">${done}/${total}</span>
        <div class="spacer"></div>
        ${state.running
          ? html`<button class="ghost" onClick=${() => queue.pause()}>Stop</button>`
          : finished
            ? null
            : html`<button class="ghost" onClick=${() => queue.start()}>Resume</button>`}
        <button class="ghost" onClick=${onClose}>${finished ? 'Close' : '_'}</button>
      </div>
      <div class="dl-body">
        ${state.items.map((it, idx) => {
          const s = it.status;
          const cls = `dl-row st-${s}`;
          return html`
            <div class=${cls} key=${it.photo.id}>
              <span class="fn" title=${it.photo.contentName}>
                ${it.photo.contentName || `photo-${it.photo.id}`}
              </span>
              <span class="sz">${fmtBytes(it.bytes)}</span>
              <span class="st">
                ${s === 'done' ? 'done'
                  : s === 'error' ? html`
                      <a href="#"
                         onClick=${(e) => { e.preventDefault(); queue.retry(idx); }}
                         title=${it.error || ''}>retry</a>`
                  : s === 'active' ? '…'
                  : 'idle'}
              </span>
            </div>
          `;
        })}
      </div>
      <div class="dl-status">
        ${err ? `${err} failed` : state.running ? 'downloading…' : finished ? 'done' : 'idle'}
      </div>
    </div>
  `;
}
