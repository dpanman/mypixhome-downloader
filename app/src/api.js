// Client for the MyPixhome / cloud.zno.com public endpoints.
//
// Verified 2026-04 that all three endpoints below respond cross-origin with
// Access-Control-Allow-Origin:* (or equivalent) when called with credentials:'omit'.
//
// Endpoint map
//   Step A  GET  <API_BASE>/activity/list_link_argument_by_slug       → resolve slug → broadcast_id
//   Step B  POST <API_BASE>/broadcast/get_content_list_by_broadcast    → paginated photo list
//   Step C  GET  <CDN_BASE>/image/download?enc_image_uid=…&thumbnail_size=N
//            N = 1  original full-resolution (≈ 2-5 MB)
//            N = 4  ~90-130 KB thumbnail (used by the grid)
//
// Notes:
//  • argument_value in Step A's response is already URL-encoded — decode once.
//  • ret_code 200000 means success; anything else is an error we surface to the user.
//  • All requests include the 5 "common" query-string params; without these the
//    server returns 500000 System Error.

const API_BASE = 'https://cloud.zno.com/cloudapi/album_live';
const COMMON_QS = {
  businessLine: 'SAAS',
  platform: 'PWA',
  languageCode: 'en',
  countryCode: 'US',
};

const THUMBNAIL_FULL = 1;     // full-resolution original
const THUMBNAIL_PREVIEW = 4;  // grid preview (~90-130 KB)

function commonQs(storeId) {
  const u = new URLSearchParams(COMMON_QS);
  u.set('storeId', String(storeId));
  return u.toString();
}

async function jsonCall(url, init = {}) {
  const res = await fetch(url, { credentials: 'omit', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.ret_code !== 200000) {
    const msg = body.ret_msg || `API error ${body.ret_code}`;
    throw new Error(msg);
  }
  return body;
}

// --- Step A -------------------------------------------------------------

export async function resolveBroadcast(parsed) {
  const qs = new URLSearchParams({
    ...COMMON_QS,
    storeId: parsed.storeId,
    domain_name: parsed.domain,
    url_slug: parsed.slug,
  });
  const url = `${API_BASE}/activity/list_link_argument_by_slug?${qs}`;
  const body = await jsonCall(url);

  const data = Array.isArray(body.data) ? body.data : [];
  const hit = data.find((x) => x.argument_key === 'broadcast_id');
  const encBroadcastId = hit ? decodeURIComponent(hit.argument_value) : null;

  if (!encBroadcastId) {
    throw new Error(
      "We couldn't find this gallery. Double-check the URL — the event-slug part is case-sensitive."
    );
  }
  return { encBroadcastId };
}

// --- Step B -------------------------------------------------------------

// Normalize a raw API photo record into a stable app-level shape.
// shotTime is always stored as seconds-since-epoch, regardless of whether the
// API returned seconds or milliseconds. Many MyPixhome galleries return ms;
// we normalize so downstream grouping / formatting can assume one unit.
// enc_*_id values come URL-encoded from the JSON response (same quirk as
// broadcast_id — see docs/API.md §Lessons-learned). Decode once here so
// URLSearchParams doesn't double-encode when we stuff them into the image URL.
function decodeEnc(v) {
  if (typeof v !== 'string' || !v) return v || null;
  try { return decodeURIComponent(v); } catch { return v; }
}

function normalizePhoto(raw) {
  let t = raw.shot_time || raw.create_time || 0;
  if (t > 1e12) t = Math.floor(t / 1000);  // ms → s
  return {
    id: raw.id,
    encContentId: decodeEnc(raw.enc_content_id),
    encOriginalContentId: decodeEnc(raw.enc_original_content_id),
    contentName: raw.content_name || '',
    suffix: (raw.suffix || 'jpg').replace(/^\./, '').toLowerCase(),
    shotTime: t,
    shotTimeStr: raw.shot_time_str || '',
    width: raw.width || 0,
    height: raw.height || 0,
    orientation: raw.orientation || 1,
    contentSize: raw.content_size || 0,
    downloadable: raw.flg_download !== 0,  // undefined/1 → true
    albumId: raw.album_id,
  };
}

// Fetch one page of photos. The server ignores `page_num` and always returns
// the same first slice, so we use cursor-based pagination keyed off the
// trailing photo's relation id + shot-time string (matches the live SPA).
//
// Returns { total, photos, lastRelId, lastShotTimeStr }.
// If `photos` is empty or shorter than `pageSize`, there are no more pages.
export async function fetchPhotoPage(parsed, encBroadcastId, cursor, pageSize) {
  const url = `${API_BASE}/broadcast/get_content_list_by_broadcast?${commonQs(parsed.storeId)}`;
  const relId = (cursor && cursor.lastRelId) || '';
  const body = await jsonCall(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enc_broadcast_id: encBroadcastId,
      last_enc_album_content_rel_id: relId,
      last_shot_time: (cursor && cursor.lastShotTimeStr) || '',
      last_repeat_album_content_rel_id: relId,
      page_size: pageSize,
      order_by: 'create_time',
      is_asc: false,
    }),
  });

  const raw = (body.data && body.data.album_content_list) || [];
  const photos = raw.map(normalizePhoto);
  const tail = raw[raw.length - 1];
  return {
    total: body.data ? body.data.total || 0 : 0,
    photos,
    lastRelId: tail ? decodeEnc(tail.enc_album_content_rel_id) : '',
    lastShotTimeStr: tail ? (tail.shot_time_str || '') : '',
  };
}

// Fetches the full photo list sequentially using the cursor from each
// response. Reports progress and dedupes by photo id in case the server
// ever replays a record at a page boundary. Cancellable via AbortSignal.
export async function fetchAllPhotos(parsed, encBroadcastId, opts = {}) {
  const pageSize = opts.pageSize || 1000;
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;

  const all = [];
  const seen = new Set();
  let cursor = { lastRelId: '', lastShotTimeStr: '' };
  let total = 0;

  // Safety cap so a misbehaving server can't spin forever.
  for (let step = 0; step < 500; step++) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    const page = await fetchPhotoPage(parsed, encBroadcastId, cursor, pageSize);
    total = page.total || total;

    let added = 0;
    for (const ph of page.photos) {
      if (seen.has(ph.id)) continue;
      seen.add(ph.id);
      all.push(ph);
      added++;
    }
    onProgress(all.length, total);

    // Stop when the server can't advance us (no new rows) or we have them all.
    if (added === 0) break;
    if (all.length >= total && total > 0) break;
    cursor = {
      lastRelId: page.lastRelId || '',
      lastShotTimeStr: page.lastShotTimeStr || '',
    };
  }

  // Sort by shot_time ascending for stable UI ordering.
  all.sort((a, b) => (a.shotTime || 0) - (b.shotTime || 0));
  return all;
}

// --- Step C -------------------------------------------------------------

// Build the /image/download URL. This endpoint ONLY takes enc_image_uid +
// thumbnail_size — adding the 5 common JSON-API params makes the server
// return garbled bytes / the wrong image.
export function buildImageUrl(photo, size = 'preview') {
  const thumb = size === 'full' ? THUMBNAIL_FULL : THUMBNAIL_PREVIEW;
  const qs = new URLSearchParams({
    enc_image_uid: photo.encContentId,
    thumbnail_size: String(thumb),
  });
  return `${API_BASE}/image/download?${qs}`;
}

// Fetch the raw bytes of a thumbnail (size='preview' by default). Used by
// the EXIF camera-identification pass — thumbnails retain the APP1 segment
// from the original file, so they're sufficient for reading Make / Model /
// BodySerialNumber while weighing only ~90 KB.
export async function fetchImageBuffer(photo, size = 'preview') {
  const url = buildImageUrl(photo, size);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.arrayBuffer();
}

// Build a user-friendly filename for a download.
export function buildDownloadFilename(photo) {
  const name = (photo.contentName || `photo-${photo.id}`).replace(/[\\/:*?"<>|]/g, '_');
  if (/\.[a-z0-9]{2,4}$/i.test(name)) return name;
  return `${name}.${photo.suffix || 'jpg'}`;
}
