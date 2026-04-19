import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import htm from 'htm';
import { buildImageUrl } from './api.js';
import { createDownloadQueue, supportsFileSystemAccess, pickDirectory } from './download.js';

const html = htm.bind(React.createElement);

// --------------------------------------------------------------------------
// Grouping — split on shot-time gap larger than `gapSec`. Any group that ends
// up with more than MAX_CHUNK photos is force-chopped so the grid stays usable.
// --------------------------------------------------------------------------

export const DEFAULT_GAP_SEC = 30;
export const GAP_OPTIONS = [5, 10, 15, 30, 45, 60];
const MAX_CHUNK = 1000;

export function groupPhotos(photos, gapSec = DEFAULT_GAP_SEC) {
  if (!photos.length) return [];

  // Split into sessions on gap > gapSec.
  const sessions = [];
  let cur = [0];
  for (let i = 1; i < photos.length; i++) {
    const gap = (photos[i].shotTime || 0) - (photos[i - 1].shotTime || 0);
    if (gap > gapSec) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) sessions.push(cur);

  // Force-chop oversize sessions so we don't render 10k cells in one group.
  const groups = [];
  for (const s of sessions) {
    if (s.length <= MAX_CHUNK) { groups.push(s); continue; }
    for (let k = 0; k < s.length; k += MAX_CHUNK) {
      groups.push(s.slice(k, k + MAX_CHUNK));
    }
  }

  return groups.map((indices) => {
    const startT = photos[indices[0]].shotTime || 0;
    const endT = photos[indices[indices.length - 1]].shotTime || 0;
    return {
      indices,
      startIdx: indices[0],
      endIdx: indices[indices.length - 1],
      startTime: startT,
      endTime: endT,
      count: indices.length,
      durationSec: Math.max(0, endT - startT),
    };
  });
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

// Parse HH:MM, HHMM, or HH → minutes since midnight (local), else null.
function parseHMS(input) {
  if (!input) return null;
  const s = String(input).trim();
  let h, m;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [a, b] = s.split(':');
    h = +a; m = +b;
  } else if (/^\d{4}$/.test(s)) {
    h = +s.slice(0, 2); m = +s.slice(2);
  } else if (/^\d{1,2}$/.test(s)) {
    h = +s; m = 0;
  } else {
    return null;
  }
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// --------------------------------------------------------------------------
// Top-level component
// --------------------------------------------------------------------------

export function Sorter({ parsed, photos, onReset, onRefetch }) {
  const [gapSec, setGapSec] = useState(DEFAULT_GAP_SEC);
  const groups = useMemo(() => groupPhotos(photos, gapSec), [photos, gapSec]);

  // Selection is a Set<photo.id> (numeric). lastClickedIdx is an index into
  // the flat photos[] array, used for shift-click range selection.
  const [selected, setSelected] = useState(() => new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState(null);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);

  // Reset active group when the grouping changes so the sidebar stays in sync.
  useEffect(() => { setActiveGroupIdx(0); }, [gapSec]);

  const [jumpVal, setJumpVal] = useState('');
  const [jumpErr, setJumpErr] = useState('');

  // Lightbox: index within the active group, or null for closed.
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const [queue, setQueue] = useState(null);
  const [, setQueueTick] = useState(0);
  const queueRef = useRef(null);

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

  // ----- jump-to-time ----------------------------------------------------

  const jumpToTime = useCallback(() => {
    const minutes = parseHMS(jumpVal);
    if (minutes == null) {
      setJumpErr('HH:MM, HHMM, or HH');
      setTimeout(() => setJumpErr(''), 2000);
      return;
    }
    let bestIdx = 0, bestDelta = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const d = new Date(groups[i].startTime * 1000);
      const local = d.getHours() * 60 + d.getMinutes();
      const delta = Math.abs(local - minutes);
      if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }
    setActiveGroupIdx(bestIdx);
  }, [jumpVal, groups]);

  // ----- download --------------------------------------------------------

  const startDownload = useCallback(async () => {
    if (selected.size === 0) return;
    // Preserve chronological order. Double-check downloadable here in case a
    // non-downloadable id snuck into the selection via a stale cache.
    const arr = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (selected.has(p.id) && p.downloadable) arr.push(p);
    }
    if (arr.length === 0) return;
    let dirHandle = null;
    if (supportsFileSystemAccess()) {
      try { dirHandle = await pickDirectory(); } catch { dirHandle = null; }
    }
    const q = createDownloadQueue({
      photos: arr,
      parsed,
      dirHandle,
      concurrency: 3,
      launchStaggerMs: 100,
      batchIdleMs: 300,
      onUpdate: () => setQueueTick((t) => t + 1),
    });
    queueRef.current = q;
    setQueue(q);
    q.start();
  }, [selected, photos, parsed]);

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
      <${TopBar}
        totalPhotos=${totalPhotos}
        groupCount=${groups.length}
        selectedCount=${selectedCount}
        gapSec=${gapSec}
        onGapChange=${setGapSec}
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
        groups=${groups}
        activeGroupIdx=${activeGroupIdx}
        onSeek=${setActiveGroupIdx}
      />
      <div class="sorter-body">
        <${GroupList}
          sidebarRef=${sidebarRef}
          parsed=${parsed}
          photos=${photos}
          groups=${groups}
          groupSelCounts=${groupSelCounts}
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
      ${queue ? html`<${DownloadPanel} queue=${queue} onClose=${closeQueue} />` : null}
    </div>
  `;
}

// --------------------------------------------------------------------------
// TopBar
// --------------------------------------------------------------------------

function TopBar({
  totalPhotos, groupCount, selectedCount,
  gapSec, onGapChange,
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
      <label class="gap-picker" title="Split groups on shot-time gaps larger than this">
        Gap
        <select value=${String(gapSec)} onChange=${(e) => onGapChange(Number(e.target.value))}>
          ${GAP_OPTIONS.map((s) => html`<option key=${s} value=${String(s)}>${s}s</option>`)}
        </select>
      </label>
      <form class="jump" onSubmit=${submit}>
        <input type="text"
               placeholder="Jump to time (HH:MM)"
               value=${jumpVal}
               onChange=${(e) => onJumpChange(e.target.value)}
               title=${jumpErr || 'HH:MM, HHMM, or HH'} />
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
// Timeline — native <input type="range"> over the group index
// --------------------------------------------------------------------------

function Timeline({ groups, activeGroupIdx, onSeek }) {
  const g = groups[activeGroupIdx];
  const first = groups[0];
  const last = groups[groups.length - 1];
  return html`
    <div class="timeline">
      <span class="t-edge">${first ? fmtTime(first.startTime) : '—'}</span>
      <input class="t-slider"
             type="range"
             min="0"
             max=${Math.max(0, groups.length - 1)}
             value=${activeGroupIdx}
             onInput=${(e) => onSeek(Number(e.target.value))}
             onChange=${(e) => onSeek(Number(e.target.value))} />
      <span class="t-edge">${last ? fmtTime(last.startTime) : '—'}</span>
      <span class="t-now">${g ? fmtDateTime(g.startTime) : '—'}</span>
    </div>
  `;
}

// --------------------------------------------------------------------------
// GroupList — 320px sidebar, 56×56 square thumbs from group's MIDDLE photo
// --------------------------------------------------------------------------

function GroupList({ sidebarRef, parsed, photos, groups, groupSelCounts, activeGroupIdx, onJump }) {
  return html`
    <aside class="group-list" ref=${sidebarRef}>
      ${groups.map((g, i) => {
        const midIdx = g.indices[Math.floor(g.indices.length / 2)];
        const mid = photos[midIdx];
        const selCount = groupSelCounts[i] || 0;
        const cls = ['group-row'];
        if (i === activeGroupIdx) cls.push('active');
        return html`
          <div key=${i}
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
    </aside>
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
