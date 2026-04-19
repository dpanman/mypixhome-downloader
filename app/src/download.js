// Download queue.
//
// Strategy (v1):
//   The image CDN sets CORS-open headers only on cloud.zno.com's /image/download,
//   so we CAN fetch() bytes cross-origin. We use two download tiers:
//
//     • Tier 1 — File System Access API (Chromium): user picks a folder once,
//       we write each file with its real contentName. Silent, fast.
//     • Tier 2 — Anchor downloads: fallback for Firefox/Safari. Browser's own
//       download manager handles it; filenames come from Content-Disposition
//       or we use URL.createObjectURL over fetched blob to force a filename.
//
// Both tiers use a concurrency cap so we don't DoS the server and so the browser
// doesn't freeze.

import { buildImageUrl, buildDownloadFilename } from './api.js';

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LAUNCH_STAGGER_MS = 100;  // delay between starting each download
const DEFAULT_BATCH_IDLE_MS = 300;      // rest after a full batch finishes

export function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// Open the folder picker. Chrome restricts the File System Access API from
// certain "sensitive" folders — the home directory, Program Files, Windows
// system folders, ~/Library on macOS — and if the user navigates into one
// it surfaces a native "Can't open this folder — contains system files"
// dialog. Opening in Downloads by default keeps users away from those
// blocked locations, and the stable `id` makes Chrome reopen the same
// folder on subsequent downloads so picking happens once per session.
export async function pickDirectory() {
  // eslint-disable-next-line no-undef
  return await window.showDirectoryPicker({
    id: 'mypixhome-downloader',
    mode: 'readwrite',
    startIn: 'downloads',
  });
}

// Sanitize filename to avoid collisions when multiple photos share a name.
function uniqueName(name, takenSet) {
  let candidate = name;
  let i = 1;
  while (takenSet.has(candidate.toLowerCase())) {
    const m = name.match(/^(.*?)(\.[a-z0-9]{2,4})?$/i);
    const stem = m ? m[1] : name;
    const ext = m && m[2] ? m[2] : '';
    candidate = `${stem} (${i})${ext}`;
    i++;
  }
  takenSet.add(candidate.toLowerCase());
  return candidate;
}

// Create a queue runner. Returns an object with start/pause/resume/cancel and
// a reactive-ish state object the caller can poll.
export function createDownloadQueue({
  photos,
  parsed = null,
  dirHandle = null,
  concurrency = DEFAULT_CONCURRENCY,
  launchStaggerMs = DEFAULT_LAUNCH_STAGGER_MS,
  batchIdleMs = DEFAULT_BATCH_IDLE_MS,
  onUpdate = () => {},
}) {
  const state = {
    items: photos.map((p) => ({ photo: p, status: 'pending', error: null, bytes: 0 })),
    active: 0,
    concurrency,
    launchStaggerMs,
    batchIdleMs,
    running: false,
    cancelled: false,
    startedAt: null,
    finishedAt: null,
    mode: dirHandle ? 'folder' : 'browser',
    dirHandle,
    batchCount: 0,
  };

  const taken = new Set();

  const emit = () => onUpdate(state);

  async function downloadOne(item) {
    item.status = 'active';
    emit();
    try {
      const url = buildImageUrl(item.photo, parsed, 'full');
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      item.bytes = blob.size;

      const name = uniqueName(buildDownloadFilename(item.photo), taken);

      if (state.mode === 'folder' && state.dirHandle) {
        const fh = await state.dirHandle.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        // Browser-download fallback: objectURL + anchor click.
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Release the object URL after a short delay so the browser has time
        // to start the download.
        setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
      }

      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = String(err.message || err);
    }
    emit();
  }

  // Batched runner: launch up to `concurrency` items at a time, staggered by
  // `launchStaggerMs`. When the batch drains, rest for `batchIdleMs` before
  // the next one. Matches the original Skater Selector pacing (3 / 100 / 300).
  async function run() {
    while (state.running && !state.cancelled) {
      const pending = state.items.filter((i) => i.status === 'pending');
      if (pending.length === 0) {
        if (state.active === 0) {
          state.running = false;
          state.finishedAt = Date.now();
          emit();
          return;
        }
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }
      // Start a batch of up to `concurrency` downloads.
      const batch = pending.slice(0, state.concurrency);
      const batchPromises = [];
      for (let i = 0; i < batch.length; i++) {
        if (!state.running || state.cancelled) break;
        const item = batch[i];
        state.active++;
        emit();
        batchPromises.push(
          downloadOne(item).finally(() => { state.active--; emit(); })
        );
        if (i < batch.length - 1) {
          await new Promise((r) => setTimeout(r, state.launchStaggerMs));
        }
      }
      // Wait for this batch to finish, then idle before the next.
      await Promise.all(batchPromises);
      state.batchCount++;
      if (state.running && !state.cancelled) {
        await new Promise((r) => setTimeout(r, state.batchIdleMs));
      }
    }
  }

  return {
    state,
    start() {
      if (state.running) return;
      state.running = true;
      state.cancelled = false;
      if (!state.startedAt) state.startedAt = Date.now();
      emit();
      run();
    },
    pause() {
      state.running = false;
      emit();
    },
    cancel() {
      state.cancelled = true;
      state.running = false;
      emit();
    },
    retry(idx) {
      const i = state.items[idx];
      if (i && i.status === 'error') {
        i.status = 'pending';
        i.error = null;
        emit();
        if (!state.running) this.start();
      }
    },
    summary() {
      const s = { done: 0, error: 0, pending: 0, active: 0, bytes: 0 };
      for (const i of state.items) {
        s[i.status] = (s[i.status] || 0) + 1;
        if (i.status === 'done') s.bytes += i.bytes;
      }
      return s;
    },
  };
}
