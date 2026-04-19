// Iterative-design screenshot helper. Spawns Playwright against the dev
// server, installs the same API mocks the flow test uses, then renders
// each of the app's main screens and writes a PNG under /tmp/screenshots.
//
// Env knobs:
//   SHOT_DIR         — output directory, default /tmp/screenshots
//   SHOT_VIEWPORT    — "1440x900" (default) / "1920x1200" / "1280x800"
//   APP_URL          — default http://localhost:8123/index.html
//
// Usage: node tests/screenshot.mjs [label]     (label → per-shot suffix)

import { chromium } from 'playwright';
import { buildExifJpeg } from './_exif-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const GALLERY_URL =
  'https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788';
const OUT = process.env.SHOT_DIR || '/tmp/screenshots';
const LABEL = process.argv[2] || 'baseline';
const [W, H] = (process.env.SHOT_VIEWPORT || '1440x900').split('x').map(Number);

const CAMERAS = {
  'IMG_': { make: 'Canon', model: 'Canon EOS R8',    serial: 'SN-IMG-AAAA' },
  'CA9A': { make: 'Canon', model: 'Canon EOS R6m2', serial: 'SN-CA9A-BBBB' },
};

// Realistic sample filenames from a skate meet. We spread across 3 bodies
// (1 Canon R5, 2 R6m2's) so the camera bucket list is non-trivial — the more
// interesting shape to design against.
function mockPhotos(count = 680) {
  const CAMS = [
    { prefix: 'CA9A', startBase: 1744001000 },
    { prefix: 'IMG_', startBase: 1744002200 },
    { prefix: '838A', startBase: 1744003500 },
  ];
  const base = 1744000000;
  const photos = [];
  for (let i = 0; i < count; i++) {
    const camIdx = i < 260 ? 0 : (i < 470 ? 1 : 2);
    const cam = CAMS[camIdx];
    // Group photos into 3–6 clusters per camera with a 400s gap between
    // clusters. That drives the sidebar to render ~10–13 groups, which is
    // a healthy density for a design review.
    const withinCam = i - (camIdx === 0 ? 0 : camIdx === 1 ? 260 : 470);
    const clusterIdx = Math.floor(withinCam / 55);
    const inCluster = withinCam % 55;
    const shot = cam.startBase + clusterIdx * 650 + inCluster * 4;
    photos.push({
      id: 1000 + i,
      enc_content_id: `enc_${i}`,
      enc_original_content_id: `enc_orig_${i}`,
      content_name: `${cam.prefix}${String(i).padStart(4, '0')}.JPG`,
      suffix: 'JPG',
      shot_time: shot,
      shot_time_str: new Date(shot * 1000).toISOString(),
      width: 6000,
      height: 4000,
      orientation: 1,
      // Varied sizes so the "bytes" column has something to show.
      content_size: 1_800_000 + (i % 17) * 60_000,
      flg_download: (i === 42 || i === 89) ? 0 : 1,
      album_id: 1,
    });
  }
  return photos;
}

async function installApiMocks(ctx, ALL) {
  const PAGE_SIZE = 200;
  const onePix = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  await ctx.route('**/cloudapi/album_live/activity/list_link_argument_by_slug**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        ret_code: 200000,
        data: [
          { argument_key: 'broadcast_id', argument_value: '4vkA0BufO2k%3D' },
          { argument_key: 'key',          argument_value: 'MYSECRET%3D' },
        ],
      }),
    }));

  await ctx.route('**/cloudapi/album_live/broadcast/get_content_list_by_broadcast**', (route) => {
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const pageSize = body.page_size || PAGE_SIZE;
    const cursor = body.last_enc_album_content_rel_id || '';
    let start = 0;
    if (cursor) {
      const idx = ALL.findIndex((p) => (p.enc_album_content_rel_id || `rel_${p.id}`) === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = ALL.slice(start, start + pageSize).map((p) => ({
      ...p,
      enc_album_content_rel_id: p.enc_album_content_rel_id || `rel_${p.id}`,
    }));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        ret_code: 200000,
        data: { total: ALL.length, album_content_list: slice },
      }),
    });
  });

  // Generate a few looping placeholder JPEGs with distinct tints so the grid
  // has some visual variety (rather than 60 identical 1-pixel tiles). Still
  // tiny bytes — this is for layout review, not for image quality.
  const PALETTE = [
    [36, 58, 100], [58, 104, 140], [88, 128, 160], [120, 152, 184],
    [52, 84, 64],  [148, 102, 70], [140, 64, 88], [86, 72, 140],
    [52, 110, 132], [148, 128, 84], [62, 138, 110], [106, 76, 140],
  ];

  await ctx.route('**/cloudapi/album_live/image/download**', (route) => {
    const url = new URL(route.request().url());
    const size = url.searchParams.get('thumbnail_size');
    const enc = url.searchParams.get('enc_image_uid') || '';
    if (size === '4') {
      const photo = ALL.find((p) => p.enc_content_id === enc) || ALL[0];
      const prefix = photo.content_name.match(/^([A-Z_0-9]*?)(?=\d{4,}\.)/i)?.[1] || 'IMG_';
      const cam = CAMERAS[prefix] || Object.values(CAMERAS)[0];
      // Re-use the EXIF fixture but tint-vary via exif "serial" overlay — the
      // grid still shows the same base JPEG though. For visual variety we
      // also return real tinted JPEGs via canvas... but that'd need node-canvas.
      // Instead we pass a tint through the Model field so EXIF still works,
      // and rely on CSS filters in the grid to add visual variety. (Done
      // below via a data-tint attribute during screenshots.)
      return route.fulfill({
        status: 200, contentType: 'image/jpeg',
        headers: { 'access-control-allow-origin': '*' },
        body: buildExifJpeg(cam),
      });
    }
    return route.fulfill({
      status: 200, contentType: 'image/jpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: onePix,
    });
  });
}

async function shoot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}-${LABEL}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('  →', file);
}

async function main() {
  const ALL = mockPhotos();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  await installApiMocks(ctx, ALL);

  // Inject a subtle per-thumbnail tint at render time so the grid has visual
  // variety without needing real image data. Cheap CSS filter driven by the
  // photo's id modulo palette size.
  await page.addInitScript(() => {
    const obs = new MutationObserver(() => {
      for (const img of document.querySelectorAll('.cell2 img:not([data-tinted]),.group-row .thumb img:not([data-tinted])')) {
        const alt = img.getAttribute('alt') || img.src || '';
        let hash = 0;
        for (let i = 0; i < alt.length; i++) hash = (hash * 31 + alt.charCodeAt(i)) >>> 0;
        const hue = hash % 360;
        img.style.filter = `hue-rotate(${hue}deg) saturate(1.4) contrast(1.1) brightness(0.95)`;
        img.style.background = `hsl(${hue} 45% 38%)`;
        img.setAttribute('data-tinted', '1');
      }
    });
    window.addEventListener('DOMContentLoaded', () =>
      obs.observe(document.body, { childList: true, subtree: true }));
  });

  console.log('Viewport:', W, 'x', H, '  Label:', LABEL);

  // --- 1. Landing ---
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('h1');
  await page.waitForTimeout(200);
  await shoot(page, '01-landing');

  // Scroll to show "how it works" section as the 2nd screen.
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(150);
  await shoot(page, '02-landing-howitworks');
  await page.evaluate(() => window.scrollTo(0, 0));

  // --- 3. Loading ---
  // Intercept the broadcast list so it hangs for ~1s, letting us capture the
  // progress bar mid-fetch.
  const slowCtx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
  });
  const slowPage = await slowCtx.newPage();
  await installApiMocks(slowCtx, ALL);
  await slowCtx.route('**/cloudapi/album_live/broadcast/get_content_list_by_broadcast**', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    return route.continue();
  });
  await slowPage.goto(APP_URL, { waitUntil: 'networkidle' });
  await slowPage.fill('.landing input[type="url"]', GALLERY_URL);
  await slowPage.click('.landing button.primary');
  await slowPage.waitForSelector('.loading', { timeout: 3000 });
  await slowPage.waitForTimeout(250);
  await shoot(slowPage, '03-loading');
  await slowCtx.close();

  // --- 4. Sorter — main view ---
  await page.fill('.landing input[type="url"]', GALLERY_URL);
  await page.click('.landing button.primary');
  await page.waitForSelector('.sorter', { timeout: 15000 });
  // Wait for EXIF probe + thumbnails to settle.
  await page.waitForTimeout(1200);
  await shoot(page, '10-sorter-idle');

  // --- 5. Sorter — with selections ---
  await page.evaluate(() => {
    const cells = document.querySelectorAll('.cell2:not(.disabled)');
    // Select a handful by directly clicking to exercise shift-click.
  });
  const allCells = await page.$$('.cell2:not(.disabled)');
  if (allCells.length > 20) {
    await allCells[4].click();
    await allCells[15].click({ modifiers: ['Shift'] });
    await allCells[28].click();
    await allCells[34].click({ modifiers: ['Shift'] });
  }
  await page.waitForTimeout(200);
  await shoot(page, '11-sorter-selection');

  // --- 6. Sorter — jump to second camera (groups from camera B) ---
  const rows = await page.$$('.group-row');
  if (rows.length > 6) {
    await rows[6].click();
    await page.waitForTimeout(400);
    await shoot(page, '12-sorter-second-group');
  }

  // --- 7. Lightbox ---
  const cellsNow = await page.$$('.cell2');
  if (cellsNow.length > 0) {
    await cellsNow[0].dblclick();
    await page.waitForTimeout(300);
    if (await page.$('.lightbox')) {
      await shoot(page, '20-lightbox');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
  }

  // --- 8. Allow-downloads modal ---
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
  await page.click('.topbar2 button.primary');
  await page.waitForSelector('.allow-modal', { timeout: 2000 });
  await page.waitForTimeout(150);
  await shoot(page, '30-allow-modal');

  // Click through to start the queue and capture the download panel.
  await page.click('.allow-modal .allow-modal-go');
  await page.waitForSelector('.dl-panel2', { timeout: 5000 });
  await page.waitForTimeout(500);
  await shoot(page, '31-download-panel');
  // Let a few complete, then screenshot again.
  await page.waitForTimeout(2500);
  await shoot(page, '32-download-progress');
  // Close download panel.
  await page.click('.dl-panel2 button[title="Close"]');
  await page.waitForTimeout(150);

  // --- 9. Change-source dialog ---
  await page.click('.source-bar .source-change');
  await page.waitForSelector('.change-source-modal', { timeout: 2000 });
  await page.waitForTimeout(150);
  await shoot(page, '40-change-source');
  await page.click('.change-source-modal .change-source-form button[type="button"]');
  await page.waitForTimeout(150);

  // --- 10. Help modal ---
  await page.click('.topbar2 .help-btn');
  await page.waitForSelector('.help-modal', { timeout: 2000 });
  await page.waitForTimeout(150);
  await shoot(page, '50-help-modal');
  await page.click('.help-modal-close');

  await browser.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
