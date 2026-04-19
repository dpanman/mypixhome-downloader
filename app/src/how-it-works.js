// Educational "how this tool works" panel, rendered both inline on the
// Landing screen and inside a modal opened from the Help (?) button in the
// sorter's top bar. Two exports: the plain content and a modal wrapper.

import React, { useEffect } from 'react';
import htm from 'htm';

const html = htm.bind(React.createElement);

export function HowItWorksContent() {
  return html`
    <div class="how-it-works">
      <h2>How this tool works</h2>
      <p class="hiw-lede">
        Everything runs in your browser. No account, no server, nothing uploaded.
        The app just calls the MyPixhome photo CDN directly, filters the response,
        and streams downloads straight to your computer.
      </p>

      <section class="hiw-section">
        <h3>1. Source images</h3>
        <p>
          MyPixhome gallery pages (<code>https://&lt;photographer&gt;.mypixhome.com/instant-gallery/&lt;event-slug&gt;/?storeId=&lt;n&gt;</code>)
          are backed by <code>cloud.zno.com</code>, which exposes three public
          endpoints with open CORS headers:
        </p>
        <ul>
          <li>
            <code>activity/list_link_argument_by_slug</code> — resolves the
            URL slug to an encrypted broadcast id.
          </li>
          <li>
            <code>broadcast/get_content_list_by_broadcast</code> — paginated
            photo list. We walk it with cursor-based paging; the server
            silently ignores <code>page_num</code>, so the only way to get
            beyond page 1 is to echo back the tail of the previous response.
          </li>
          <li>
            <code>image/download?enc_image_uid=…&amp;thumbnail_size=N</code>
            — actual image bytes, keyed by an encrypted per-photo id.
          </li>
        </ul>
        <p>
          The full photo list for a gallery is cached in your browser's
          IndexedDB so re-opening the same link is instant. A background
          probe checks if the gallery's total has changed and invalidates
          the cache if new photos have appeared.
        </p>
      </section>

      <section class="hiw-section">
        <h3>2. Thumbnails vs. full-resolution originals</h3>
        <p>
          The CDN exposes the same photo at several sizes via the
          <code>thumbnail_size</code> parameter. Two matter:
        </p>
        <ul>
          <li>
            <strong><code>thumbnail_size=4</code></strong> — grid preview,
            roughly 90–130 KB. Fast enough to fetch a whole group at once.
            The grid, the sidebar thumbnails, and the lightbox's first frame
            all use this.
          </li>
          <li>
            <strong><code>thumbnail_size=1</code></strong> — full-resolution
            original, typically 2–5 MB. Only fetched when you actually
            download — we never pull full-res just to show a preview.
          </li>
        </ul>
        <p>
          Thumbnails keep the JPEG's APP1 Exif segment intact, which is what
          makes the next step possible without downloading the full file.
        </p>
      </section>

      <section class="hiw-section">
        <h3>3. Bucketing by camera (EXIF body serial)</h3>
        <p>
          At big events there are usually several photographers shooting on
          different cameras, on different rinks or courts, with clocks that
          aren't synced to each other. Grouping purely by shot-time mixes
          their sessions into one blob and makes picking your skater's shots
          impossible.
        </p>
        <p>
          The sorter groups in two passes:
        </p>
        <ol>
          <li>
            <strong>Camera bucket</strong> — every photo's filename carries
            a 3- or 4-char prefix assigned by the camera body
            (<code>CA9A9999.JPG</code>, <code>IMG_0042.jpg</code>,
            <code>838A0001.JPG</code>). Different bodies produce different
            prefixes, so the prefix works as a zero-cost bucket key even
            before any image bytes load.
          </li>
          <li>
            <strong>EXIF enrichment</strong> — for each prefix, the app
            downloads a single <code>thumbnail_size=4</code> sample and
            parses the APP1 Exif segment with a minimal inline TIFF walker.
            It reads <em>Make</em> (tag 0x010F), <em>Model</em> (0x0110), and
            the authoritative distinguishing mark: <em>BodySerialNumber</em>
            (0xA431 inside the Exif sub-IFD). Two Canon R6m2 bodies at the
            same event show as two buckets because their serials differ.
          </li>
          <li>
            <strong>Time-gap splitting within a bucket</strong> — within a
            single camera, the group list splits whenever two consecutive
            shots are more than <em>gap-seconds</em> apart. Groups from
            camera A never interleave with camera B's — the sidebar walks
            camera A's time-grouped sessions, then camera B's, then C's.
          </li>
        </ol>
        <p>
          Each section header in the sidebar shows the camera's make + model
          and the body serial it identified, which you can cross-reference
          to decide "this is the photographer by the boards, that's the one
          on the landing side."
        </p>
      </section>

      <section class="hiw-section">
        <h3>4. Download manager</h3>
        <p>
          When you click <strong>Download selected</strong>, the app
          assembles a queue in chronological order and pipes up to
          <strong>3 concurrent</strong> downloads into your browser's
          built-in Downloads folder. Each file uses its original name
          from the CDN, including the camera's filename prefix, so
          shots from different bodies are still trivially separable
          after the fact.
        </p>
        <p>
          Because the browser is about to spawn many simultaneous saves,
          Chrome pops up <em>"Allow site to download multiple files?"</em>
          at the top of the window. If you miss or block that prompt,
          <strong>only the first photo saves</strong> and the rest
          silently drop — even though the queue panel shows them as
          completed. The big yellow modal before the queue starts is a
          reminder to catch the prompt. You only need to allow once per
          gallery domain.
        </p>
        <p>
          Failed rows show an inline retry link. The panel is draggable
          and collapsible — stash it in a corner while you keep browsing
          groups.
        </p>
      </section>

    </div>
  `;
}

export function HowItWorksModal({ onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return html`
    <div class="help-modal" role="dialog" aria-modal="true" onClick=${onClose}>
      <div class="help-modal-card" onClick=${(e) => e.stopPropagation()}>
        <button class="help-modal-close" onClick=${onClose} title="Close (Esc)">×</button>
        <${HowItWorksContent} />
      </div>
    </div>
  `;
}
