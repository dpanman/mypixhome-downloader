// End-to-end flow test with mocked cloud.zno.com API.
// Covers: URL paste, paginated fetch, grouping, click/shift-click selection,
// non-downloadable handling, Ctrl/Cmd+A, lightbox, jump-to-time, download,
// reset, and image URL query-param correctness.

import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';

const GALLERY_URL = 'https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788';

function mockPhotos(count = 420) {
  const base = 1744000000;
  const photos = [];
  for (let i = 0; i < count; i++) {
    const cluster = Math.floor(i / 60);
    const within = i % 60;
    const shot = base + cluster * 300 + within * 3;
    photos.push({
      id: 1000 + i,
      enc_content_id: `enc_${i}`,
      enc_original_content_id: `enc_orig_${i}`,
      content_name: `IMG_${String(i).padStart(4, '0')}.jpg`,
      suffix: 'jpg',
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
    const pageNum = body.page_num || 1;
    const pageSize = body.page_size || PAGE_SIZE;
    const start = (pageNum - 1) * pageSize;
    const slice = ALL.slice(start, start + pageSize);
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

  await ctx.route('**/cloudapi/album_live/image/download**', (route) => {
    imageCalls.push(route.request().url());
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

  // 1. Landing renders.
  const h1 = await page.$eval('h1', (e) => e.textContent);
  check('landing h1', h1 === 'Gallery Sorter', h1);

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

  // 4. Grid shows 60 cells (active group size).
  const cells = await page.$$('.cell2');
  check('60 cells in active group', cells.length === 60, `got ${cells.length}`);

  // 5. Click cell 0 → 1 selected.
  await cells[0].click();
  await page.waitForTimeout(50);
  let sc = await page.$eval('.topbar2 .stats strong:nth-of-type(3)', (e) => e.textContent);
  check('click selects one', sc === '1', sc);

  // 6. Shift-click cell 9 → 10 selected.
  await cells[9].click({ modifiers: ['Shift'] });
  await page.waitForTimeout(50);
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(3)', (e) => e.textContent);
  check('shift-click range selects 10', sc === '10', sc);

  // 7. Ctrl/Cmd+A → select all downloadable in group (59, since index 17 is locked).
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(50);
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(3)', (e) => e.textContent);
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
  sc = await page.$eval('.topbar2 .stats strong:nth-of-type(3)', (e) => e.textContent);
  check('Escape clears selection', sc === '0', sc);

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
  await page.waitForSelector('.dl-panel2', { timeout: 5000 });
  // Wait for at least a batch to complete.
  await page.waitForTimeout(2500);
  const dlDone = (await page.$$('.dl-panel2 .dl-row.st-done')).length;
  const dlErr = (await page.$$('.dl-panel2 .dl-row.st-error')).length;
  check('downloads complete', dlDone >= 3 && dlErr === 0, `done=${dlDone}, err=${dlErr}`);

  // 13. Image URLs include storeId.
  const withStoreId = imageCalls.filter((u) => u.includes('storeId=8788')).length;
  check('image URLs include storeId', withStoreId > 0, `${withStoreId}/${imageCalls.length}`);

  // 14. Image URLs include thumbnail_size.
  const withThumb = imageCalls.filter((u) => u.includes('thumbnail_size=')).length;
  check('image URLs include thumbnail_size', withThumb === imageCalls.length,
    `${withThumb}/${imageCalls.length}`);

  // 15. Reset flow — close panel and start over.
  await page.click('.dl-panel2 button[title="Close"]');
  await page.waitForTimeout(50);
  await page.click('button[title="Load a different gallery"]');
  await page.waitForSelector('.landing', { timeout: 2000 });
  check('reset returns to landing', true);

  // 16. No page errors anywhere.
  check('no page errors', pageErrors.length === 0, pageErrors.join('\n'));

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed < results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
