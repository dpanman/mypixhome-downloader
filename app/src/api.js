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
const CDN_BASE = 'https://cloud.zno.com/cloudapi/album_live';  // same host — CORS-open
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
  const find = (k) => {
    const hit = data.find((x) => x.argument_key === k);
    return hit ? decodeURIComponent(hit.argument_value) : null;
  };
  const encBroadcastId = find('broadcast_id');
  const key = find('key');

  if (!encBroadcastId) {
    throw new Error(
      "We couldn't find this gallery. Double-check the URL — the event-slug part is case-sensitive."
    );
  }
  return { encBroadcastId, key };
}

// --- Step B -------------------------------------------------------------

// Normalize a raw API photo record into a stable app-level shape.
// shotTime is always stored as seconds-since-epoch, regardless of whether the
// API returned seconds or milliseconds. Many MyPixhome galleries return ms;
// we normalize so downstream grouping / formatting can assume one unit.
function normalizePhoto(raw) {
  let t = raw.shot_time || raw.create_time || 0;
  if (t > 1e12) t = Math.floor(t / 1000);  // ms → s
  return {
    id: raw.id,
    encContentId: raw.enc_content_id,
    encOriginalContentId: raw.enc_original_content_id || null,
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

export async function fetchPhotoPage(parsed, encBroadcastId, pageNum, pageSize) {
  const url = `${API_BASE}/broadcast/get_content_list_by_broadcast?${commonQs(parsed.storeId)}`;
  const body = await jsonCall(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enc_broadcast_id: encBroadcastId,
      page_num: pageNum,
      page_size: pageSize,
    }),
  });
  const list = (body.data && body.data.album_content_list) || [];
  return {
    total: body.data ? body.data.total || 0 : 0,
    photos: list.map(normalizePhoto),
  };
}

// Fetches the full photo list, paginating with the given page size and
// reporting progress back to the caller. Cancellable via AbortSignal.
export async function fetchAllPhotos(parsed, encBroadcastId, opts = {}) {
  const pageSize = opts.pageSize || 200;
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;

  // Fetch page 1 to learn total.
  const first = await fetchPhotoPage(parsed, encBroadcastId, 1, pageSize);
  const total = first.total;
  const all = first.photos.slice();
  onProgress(all.length, total);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1) return all;

  // Fetch remaining pages with a small concurrency cap.
  const concurrency = 4;
  const queue = [];
  for (let p = 2; p <= pages; p++) queue.push(p);

  async function worker() {
    while (queue.length) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const p = queue.shift();
      const { photos } = await fetchPhotoPage(parsed, encBroadcastId, p, pageSize);
      for (const ph of photos) all.push(ph);
      onProgress(all.length, total);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Sort by shot_time ascending for stable UI ordering.
  all.sort((a, b) => (a.shotTime || 0) - (b.shotTime || 0));
  return all;
}

// --- Step C -------------------------------------------------------------

// Build the /image/download URL. The server is strict about the 5 common
// query-string params — without storeId it returns 500000 System Error, even
// for image bytes. parsed is optional for backwards compat but should always
// be passed; callers that skip it will still get a URL but it may 5xx.
export function buildImageUrl(photo, parsedOrSize, maybeSize) {
  // Overloaded: (photo, size) for legacy callers, (photo, parsed, size) for new ones.
  let parsed = null, size;
  if (typeof parsedOrSize === 'string') {
    size = parsedOrSize;
  } else {
    parsed = parsedOrSize || null;
    size = maybeSize || 'preview';
  }
  const thumb = size === 'full' ? THUMBNAIL_FULL : THUMBNAIL_PREVIEW;
  const qs = new URLSearchParams(parsed ? { ...COMMON_QS, storeId: String(parsed.storeId) } : {});
  qs.set('enc_image_uid', photo.encContentId);
  qs.set('thumbnail_size', String(thumb));
  return `${CDN_BASE}/image/download?${qs}`;
}

// Build a user-friendly filename for a download.
export function buildDownloadFilename(photo) {
  const name = (photo.contentName || `photo-${photo.id}`).replace(/[\\/:*?"<>|]/g, '_');
  if (/\.[a-z0-9]{2,4}$/i.test(name)) return name;
  return `${name}.${photo.suffix || 'jpg'}`;
}
