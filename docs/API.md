# cloud.zno.com API recipe

MyPixhome galleries are served by `cloud.zno.com/cloudapi/album_live`. Three
endpoints cover everything the app needs, all CORS-open when called with
`credentials: 'omit'`.

Common query params that every JSON endpoint requires (missing any of these
returns `ret_code: 500000` System Error):

```
businessLine=SAAS
platform=PWA
storeId=<n>
languageCode=en
countryCode=US
```

The image endpoint (`/image/download`) is different — see below.

All JSON responses follow `{ ret_code, ret_msg, timestamp, data }`.
`ret_code === 200000` means success; anything else surfaces to the user.

---

## Step A — resolve slug → broadcast id

```
GET /cloudapi/album_live/activity/list_link_argument_by_slug
    ?<common>
    &domain_name=<host.mypixhome.com>
    &url_slug=<event-slug>
```

Response:

```json
{
  "ret_code": 200000,
  "data": [
    {"argument_key": "broadcast_id", "argument_value": "4vkA0BufO2k%3D"},
    {"argument_key": "key",          "argument_value": "451Bj…%3D"}
  ]
}
```

`argument_value` arrives URL-encoded. **Call `decodeURIComponent` exactly
once** before passing the broadcast id to Step B. The `key` value exists but
the SPA doesn't appear to use it; the app ignores it.

---

## Step B — paginated photo list

```
POST /cloudapi/album_live/broadcast/get_content_list_by_broadcast?<common>
Content-Type: application/json

{
  "enc_broadcast_id": "<decoded broadcast_id>",
  "last_enc_album_content_rel_id": "",
  "last_shot_time": "",
  "last_repeat_album_content_rel_id": "",
  "page_size": 1000,
  "order_by": "create_time",
  "is_asc": false
}
```

Response data shape:

```json
{
  "data": {
    "total": 23646,
    "last_search_time": "...",
    "album_content_list": [
      {
        "id": 1234,
        "enc_content_id": "…%3D",
        "enc_original_content_id": "…%3D",
        "enc_album_content_rel_id": "…",
        "content_name": "CA9A9999.JPG",
        "suffix": "JPG",
        "shot_time": 1744000000,
        "shot_time_str": "2025-04-07T13:55:12",
        "width": 6000, "height": 4000, "orientation": 1,
        "content_size": 2500000,
        "flg_download": 1
      },
      ...
    ]
  }
}
```

**Cursor-based pagination.** The server silently ignores any `page_num` /
`page_number` param — the only way to advance past the first page is to
echo back the last record's `enc_album_content_rel_id` as
`last_enc_album_content_rel_id` AND `last_repeat_album_content_rel_id` (the
app sends the same value in both). `last_shot_time` is the tail record's
`shot_time_str`. Pass all blank on the first request.

Stop when either `album_content_list` is shorter than `page_size` or the
cumulative count ≥ `total`. The app also dedupes by `id` in case the server
ever replays a record at a boundary, and has a hard safety cap of 500
iterations.

`shot_time` may be returned in seconds OR milliseconds depending on the
gallery. `normalizePhoto` coerces to seconds by dividing by 1000 when the
value is > 10¹² (anything past year ~2001 in ms is post-2286 in s — safe).

---

## Step C — image download

```
GET /cloudapi/album_live/image/download?enc_image_uid=<enc_content_id>&thumbnail_size=<N>
```

No other query params. No auth. `N = 4` returns a ~90–130 KB preview
suitable for the grid; `N = 1` returns the full-resolution original (2–5
MB). Other sizes exist but aren't useful for this app.

**Do NOT send the 5 common JSON-API params to `/image/download`.** With
them, the server returns garbled bytes or the wrong image. `flow.mjs`
asserts that no outgoing image URL contains `storeId=`.

Thumbnails (N=4) keep the JPEG's APP1 Exif segment intact, which is what
makes the EXIF camera-identification probe in `app.js` possible without
downloading full-res.

---

## Lessons learned (carry these forward)

- **Enc-id values are double-encoded across the wire.** JSON strings carry
  `%3D`; URLSearchParams will re-encode to `%253D` if you stuff them in
  without decoding. `decodeEnc` (in `api.js`) decodes once, and we let
  URLSearchParams handle the outbound encoding exactly once. Test 13/14 of
  `flow.mjs` guards against a regression.
- **`flg_download == 0` photos exist.** The server marks some photos
  non-downloadable. The UI disables them, selection skips them, and the
  queue double-checks at dequeue time in case a stale cache lets one slip
  through.
- **Password-protected galleries** use `activity/validate_password`. Out of
  scope — surfacing the error text from `ret_code` is the closest we get.
- **Observed no rate limits** at 4× concurrency. The app is polite anyway:
  download queue is 3-wide with a 100 ms stagger and a 300 ms idle between
  batches. If the CDN starts 429-ing, add exponential backoff in
  `download.js#downloadOne`.

## If the API changes

- All endpoint strings live in `app/src/api.js` — grep for `API_BASE`.
- The easiest live-inspection tool is `tests/inspect-real.mjs`: it opens
  the real MyPixhome SPA in headless Chrome and dumps every cloud.zno.com
  request with its payload. Diff its output against this doc when
  something breaks.
- If CORS tightens, the fallback is a Cloudflare Worker that proxies the
  three endpoints. Keep it a last resort — it adds infra to a project
  whose whole point is *no* infra.
