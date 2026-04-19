// End-to-end flow test with mocked cloud.zno.com API.
// Covers: URL paste, paginated fetch, grouping, click/shift-click selection,
// non-downloadable handling, Ctrl/Cmd+A, lightbox, jump-to-time, download,
// reset, and image URL query-param correctness.

import { chromium } from 'playwright';
import { buildExifJpeg } from './_exif-fixture.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';

const GALLERY_URL = 'https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788';

// Two mock cameras so the camera-bucketing logic has something to bucket.
// Camera A (IMG_) owns the first 4 clusters (240 photos), camera B (CA9A)
// owns the last 3 (180 photos). Cluster structure / per-cluster count is
// unchanged so existing navigation asserts still hold.
const CAMERAS = {
  'IMG_': { make: 'Canon', model: 'Canon EOS R8', serial: 'SN-IMG-AAAA' },
  'CA9A': { make: 'Canon', model: 'Canon EOS R6m2', serial: 'SN-CA9A-BBBB' },
};

function mockPhotos(count = 420) {
  const base = 1744000000;
  const photos = [];
  for (let i = 0; i < count; i++) {
    const cluster = Math.floor(i / 60);
    const within = i % 60;
    const shot = base + cluster * 300 + within * 3;
    const prefix = cluster < 4 ? 'IMG_' : 'CA9A';
    photos.push({
      id: 1000 + i,
      enc_content_id: `enc_${i}`,
      enc_original_content_id: `enc_orig_${i}`,
      content_name: `${prefix}${String(i).padStart(4, '0')}.JPG`,
      suffix: 'JPG',
      shot_time: shot,
      shot_time_str: new Date(shot * 1000).toISOString(),
      width: 6000,
      height: 4000,
      orientation: 1,
      content_size: 2_500_000,
      flg_download: i === 17 ? 0 : 1,
      album_id: 1,
    });
  }
  return photos;
}

async function installApiMocks(ctx, ALL) {
  const PAGE_SIZE = 200;
  const imageCalls = [];
  const onePix = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  await ctx.route('**/cloudapi/album_live/activity/list_link_argument_by_slug**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        ret_code: 200000,
        data: [
          { argument_key: 'broadcast_id', argument_value: '4vkA0BufO2k%3D' },
          { argument_key: 'key',          argument_value: 'MYSECRET%3D' },
        ],
      }),
    })
  );

  await ctx.route('**/cloudapi/album_live/broadcast/get_content_list_by_broadcast**', (route) => {
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const pageSize = body.page_size || PAGE_SIZE;
    // Cursor-based pagination: advance past whichever record matches
    // last_enc_album_content_rel_id. Empty cursor = start from 0.
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
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        ret_code: 200000,
        data: { total: ALL.length, album_content_list: slice },
      }),
    });
  });

  // Image endpoint: for preview calls (thumbnail_size=4 — used by the EXIF
  // probe and the grid) we return a valid JPEG whose APP1 segment encodes
  // this photo's camera. That way the probe parses back the right make /
  // model / serial per prefix. Full-resolution calls (size=1) keep returning
  // the 1-pixel GIF — they drive the download-queue progress test and don't
  // need real bytes.
  await ctx.route('**/cloudapi/album_live/image/download**', (route) => {
    const url = new URL(route.request().url());
    imageCalls.push(route.request().url());
    const size = url.searchParams.get('thumbnail_size');
    const enc = url.searchParams.get('enc_image_uid') || '';
    if (size === '4') {
      // Work out which camera this enc belongs to.
      const photo = ALL.find((p) => p.enc_content_id === enc) || ALL[0];
      const prefix = photo.content_name.match(/^([A-Z_0-9]*?)(?=\d{4,}\.)/i)?.[1] || 'IMG_';
      const cam = CAMERAS[prefix] || Object.values(CAMERAS)[0];
      return route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'access-control-allow-origin': '*' },
        body: buildExifJpeg(cam),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: onePix,
    });
  });

  return { imageCalls };
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
}

async function main() {
  const ALL = mockPhotos();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const { imageCalls } = await installApiMocks(ctx, ALL);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });

  // 1. Landing renders. The headline copy is not load-bearing for the app
  // to work — a present, non-empty <h1> plus the "Gallery Sorter" brand mark
  // is enough to confirm the landing screen mounted.
  const h1 = await page.$eval('h1', (e) => e.textContent.trim());
  const brand = await page.$eval('.landing-mark', (e) => e.textContent.trim());
  check('landing h1 present', h1.length > 0, h1);
  check('landing brand mark', /gallery\s*sorter/i.test(brand), brand);

  // 2. Bad URL gives friendly error, doesn't advance phase.
  await page.fill('.landing input[type="url"]', 'https://example.com/nope');
  await page.click('.landing button.primary');
  await page.waitForTimeout(100);
  const errText = await page.$eval('.landing .error', (e) => e.textContent).catch(() => '');
  check('bad URL shows inline error', errText.includes('mypixhome'), errText);

  // 3. Happy path.
  await page.fill('.landing input[type="url"]', GALLERY_URL);
  await page.click('.landing button.primary');
  await page.waitForSelector('.sorter', { timeout: 15000 });
  await page.waitForTimeout(300);

  const stats = await page.$eval('.topbar2 .stats', (e) => e.textContent);
  check('topbar shows 420 photos', stats.includes('420'), stats.replace(/\s+/g, ' ').trim());
  check('topbar shows 2 cameras', /\b2\s*cameras/.test(stats), stats.replace(/\s+/g, ' ').trim());

  // 3b. Sidebar renders one camera header per body — both with the EXIF
  //     make/model visible and the body serial surfaced. The EXIF probe
  //     is deferred ~800ms after the grid mounts so initial thumbnail
  //     requests aren't starved; wait on the label actually appearing
  //     rather than a fixed sleep.
  const camHeaders = await page.$$('.cam-header');
  check('sidebar has 2 camera headers', camHeaders.length === 2, `got ${camHeaders.length}`);
  await page.waitForFunction(() => {
    const labels = Array.from(document.querySelectorAll('.cam-header .cam-label'))
      .map((e) => e.textContent.trim());
    return labels.includes('Canon EOS R8') && labels.includes('Canon EOS R6m2');
  }, { timeout: 10000 }).catch(() => {});
  const camLabels = await page.$$eval('.cam-header .cam-label', (els) => els.map((e) => e.textContent.trim()));
  check('camera headers list R8 and R6m2',
    camLabels.includes('Canon EOS R8') && camLabels.includes('Canon EOS R6m2'),
    camLabels.join(' | '));
  const serials = await page.$$eval('.cam-header .cam-serial', (els) => els.map((e) => e.textContent.trim()));
  check('body serials show SN-IMG-AAAA and SN-CA9A-BBBB (via EXIF)',
    serials.some((s) => s.includes('SN-IMG-AAAA')) && serials.some((s) => s.includes('SN-CA9A-BBBB')),
    serials.join(' | '));

  // 3c. Groups never interleave: within .group-list, all IMG_ groups must
  //     appear before any CA9A groups (camera A shot first).
  const groupOrder = await page.$$eval('.group-list .group-row', (els) =>
    els.map((e) => Number(e.getAttribute('data-g'))));
  check('groups rendered in camera-then-time order', groupOrder.every((v, i) => i === 0 || v === groupOrder[i - 1] + 1),
    groupOrder.join(','));

  // 4. Grid shows 60 cells (active group size).
  const cells = await page.$$('.cell2');
  check('60 cells in active group', cells.length === 60, `got ${cells.length}`);

  // 5. Click cell 0 → 1 selected.
  await cells[0].click();
  await page.waitForTimeout(50);
  let sc = await page.$eval('.topbar2 .stats strong:nth-of-type(4)', (e) => e.textContent);
  check('click selects one', sc === '1', sc);

  // 6. Shift-click cell 9 → 10 selected.
  await cells[9].click({ modifiers: ['Shift'] });
  await page.waitForTimeout(50);
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(4)', (e) => e.textContent);
  check('shift-click range selects 10', sc === '10', sc);

  // 7. Ctrl/Cmd+A → select all downloadable in group (59, since index 17 is locked).
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(50);
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(4)', (e) => e.textContent);
  check('Ctrl+A selects all downloadable in group', sc === '59', sc);

  // 8. Clicking the disabled cell must NOT select it.
  const locked = await page.$('.cell2.disabled');
  const lockedBefore = await page.$$('.cell2.disabled.selected');
  await locked?.click();
  await page.waitForTimeout(50);
  const lockedAfter = await page.$$('.cell2.disabled.selected');
  check('locked cell not selectable', lockedBefore.length === 0 && lockedAfter.length === 0);

  // 9. Escape clears selection.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(4)', (e) => e.textContent);
  check('Escape clears selection', sc === '0', sc);

  // 9b. Shift-click must not leak across groups. Anchor in group 0 (camera
  //     IMG_), jump to a CA9A group, shift-click — the anchor belongs to a
  //     different group so this should behave as a plain toggle, NOT paint a
  //     range across every interleaved photo in the flat array.
  {
    const cellsG0 = await page.$$('.cell2');
    await cellsG0[2].click();                           // anchor in group 0
    await page.waitForTimeout(30);
    const sidebarRowsX = await page.$$('.group-row');
    await sidebarRowsX[4].click();                      // jump to first CA9A group
    await page.waitForTimeout(200);
    const cellsG4 = await page.$$('.cell2');
    await cellsG4[3].click({ modifiers: ['Shift'] });   // shift-click in group 4
    await page.waitForTimeout(50);
    sc = await page.$eval('.topbar2 .stats strong:nth-of-type(4)', (e) => e.textContent);
    // Expected: 2 selected (the anchor from group 0, plus the shift-click
    // fell through to a toggle in group 4). Without the cross-group guard
    // every flat index between them would be selected — hundreds of cells.
    check('shift-click does not leak across groups', sc === '2', sc);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(30);
    // Return to group 0 for the rest of the flow.
    const sidebarRowsBack = await page.$$('.group-row');
    await sidebarRowsBack[0].click();
    await page.waitForTimeout(200);
  }

  // 10. Arrow-down navigates to next group.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  const activeG = await page.$eval('.group-row.active', (e) => e.getAttribute('data-g'));
  check('ArrowDown advances active group', activeG === '1', `active data-g=${activeG}`);

  // 11. Lightbox opens on double-click and responds to Space.
  const firstCell = (await page.$$('.cell2'))[0];
  await firstCell.dblclick();
  await page.waitForTimeout(200);
  // Sometimes dblclick fires as two singles when very fast — retry via keyboard.
  if (!(await page.$('.lightbox'))) {
    await firstCell.dblclick({ delay: 80 });
    await page.waitForTimeout(200);
  }
  const lbExists = !!(await page.$('.lightbox'));
  if (!lbExists) {
    console.log('lightbox did not open, skipping dependent checks');
  }
  if (lbExists) {
    await page.keyboard.press(' ');
    await page.waitForTimeout(50);
    const lbSelected = await page.$('.lightbox .lb-info .primary');
    check('lightbox Space toggles selection', !!lbSelected);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    const lbGone = await page.$('.lightbox');
    check('lightbox closes on Escape', !lbGone);
  } else {
    check('lightbox opens on dblclick', false, 'lightbox never opened');
  }

  // Reset back for download test.
  await page.keyboard.press('Home');
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);

  // 12. "Select all in group" button + Download flow.
  await page.click('.topbar2 button:has-text("Select all in group")');
  await page.waitForTimeout(50);
  await page.click('.topbar2 button.primary');
  // Download button now opens a reminder modal; confirm it first.
  await page.waitForSelector('.allow-modal', { timeout: 2000 });
  check('download modal appears', true);
  await page.click('.allow-modal .allow-modal-go');
  await page.waitForSelector('.dl-panel2', { timeout: 5000 });
  // Wait for at least a batch to complete.
  await page.waitForTimeout(2500);
  const dlDone = (await page.$$('.dl-panel2 .dl-row.st-done')).length;
  const dlErr = (await page.$$('.dl-panel2 .dl-row.st-error')).length;
  check('downloads complete', dlDone >= 3 && dlErr === 0, `done=${dlDone}, err=${dlErr}`);

  // 13. Image URLs must NOT include storeId / common JSON-API params (the
  // /image/download endpoint returns garbled bytes if we send them).
  const withStoreId = imageCalls.filter((u) => u.includes('storeId=')).length;
  check('image URLs omit storeId', withStoreId === 0, `${withStoreId}/${imageCalls.length}`);

  // 14. Image URLs include thumbnail_size + enc_image_uid.
  const wellFormed = imageCalls.filter(
    (u) => u.includes('thumbnail_size=') && u.includes('enc_image_uid='),
  ).length;
  check('image URLs well-formed', wellFormed === imageCalls.length,
    `${wellFormed}/${imageCalls.length}`);

  // 15a. Gap selector lists the expected options and defaults to 30.
  const gapOptions = await page.$$eval('.topbar2 .gap-picker option', (els) =>
    els.map((e) => e.value));
  check('gap selector options', JSON.stringify(gapOptions) === JSON.stringify(['5', '10', '15', '30', '45', '60']),
    gapOptions.join(','));
  const gapValue = await page.$eval('.topbar2 .gap-picker select', (e) => e.value);
  check('gap defaults to 30', gapValue === '30', gapValue);

  // Changing gap to 60 merges clusters; our mock has 123s between clusters so
  // groups should stay the same (7). Switching to 5 keeps them too (intra-
  // cluster gap is 3s, below both thresholds). We just verify the value
  // propagated to the select.
  await page.selectOption('.topbar2 .gap-picker select', '5');
  await page.waitForTimeout(100);
  const newGap = await page.$eval('.topbar2 .gap-picker select', (e) => e.value);
  check('gap selector updates value', newGap === '5', newGap);

  // Click sidebar row 2 and verify cells REPLACE (titles don't overlap with row 0).
  const firstCells = await page.$$eval('.cell2', (els) => els.map((e) => e.getAttribute('title')));
  const sidebarRows = await page.$$('.group-row');
  if (sidebarRows.length > 2) {
    await sidebarRows[2].click();
    await page.waitForTimeout(200);
    const secondCells = await page.$$eval('.cell2', (els) => els.map((e) => e.getAttribute('title')));
    const overlap = firstCells.filter((t) => secondCells.includes(t)).length;
    check('grid replaces (no overlap) on sidebar click', overlap === 0,
      `overlap=${overlap}, first=${firstCells.length}, second=${secondCells.length}`);
  }

  // Reset gap back to default for consistency.
  await page.selectOption('.topbar2 .gap-picker select', '30');
  await page.waitForTimeout(200);

  // 15b. Close the download panel before moving on.
  await page.click('.dl-panel2 button[title="Close"]');
  await page.waitForTimeout(50);

  // 16. ?site= auto-load. Visiting the app with the gallery URL in the query
  //     string skips the landing screen entirely.
  const deepLink = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'site=' + GALLERY_URL;
  await page.goto(deepLink, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('.sorter', { timeout: 15000 });
  check('?site= deep link auto-loads sorter', true);

  // 17. Source bar shows the gallery URL as a clickable link.
  const srcHref = await page.$eval('.source-bar .source-link', (e) => e.getAttribute('href'));
  check('source bar shows gallery URL', srcHref === GALLERY_URL, srcHref);

  // 18. Address bar reflects the current gallery (syncs on load).
  const urlNow = page.url();
  check('address bar contains ?site=', urlNow.includes('site=' + encodeURI(GALLERY_URL).replace(/\?/g, '?')) || urlNow.includes('site=' + GALLERY_URL),
    urlNow);

  // 19. "Change source" button in the SourceBar opens a modal where the user
  //     can paste a new URL without going back to the landing screen.
  await page.click('.source-bar .source-change');
  await page.waitForSelector('.change-source-modal', { timeout: 2000 });
  check('change-source modal opens', true);
  await page.click('.change-source-modal .change-source-form button[type="button"]');
  await page.waitForTimeout(100);
  const modalGone = !(await page.$('.change-source-modal'));
  check('cancel closes change-source modal', modalGone);

  // 20. Help button opens the "How this tool works" modal.
  await page.click('.topbar2 .help-btn');
  await page.waitForSelector('.help-modal', { timeout: 2000 });
  const helpVisible = !!(await page.$('.help-modal .how-it-works h2'));
  check('help modal shows how-it-works content', helpVisible);
  await page.click('.help-modal-close');
  await page.waitForTimeout(100);
  const helpGone = !(await page.$('.help-modal'));
  check('close button dismisses help modal', helpGone);

  // 21. No page errors anywhere.
  check('no page errors', pageErrors.length === 0, pageErrors.join('\n'));

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed < results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
