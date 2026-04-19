// Reproduction test: clicking a sidebar group should REPLACE the grid cells,
// not append. Captures cell data-* before and after, asserts full swap.

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
      width: 6000, height: 4000, orientation: 1, content_size: 0,
      flg_download: 1, album_id: 1,
    });
  }
  return photos;
}

const onePix = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function main() {
  const ALL = mockPhotos();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const imageUrls = [];

  await ctx.route('**/list_link_argument_by_slug**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ ret_code: 200000, data: [
      { argument_key: 'broadcast_id', argument_value: 'B%3D' },
    ]}),
  }));
  await ctx.route('**/get_content_list_by_broadcast**', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const start = ((body.page_num || 1) - 1) * (body.page_size || 200);
    return r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        ret_code: 200000,
        data: { total: ALL.length, album_content_list: ALL.slice(start, start + (body.page_size || 200)) },
      }),
    });
  });
  await ctx.route('**/image/download**', (r) => {
    imageUrls.push(r.request().url());
    return r.fulfill({
      status: 200, contentType: 'image/jpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: onePix,
    });
  });

  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.fill('.landing input[type="url"]', GALLERY_URL);
  await page.click('.landing button.primary');
  await page.waitForSelector('.sorter');
  await page.waitForTimeout(300);

  // Capture cells before and after.
  const collect = () => page.$$eval('.cell2', (els) => els.map((e) => ({
    title: e.getAttribute('title'),
    num: e.querySelector('.num-label')?.textContent,
  })));

  const group0 = await collect();
  console.log('group 0 cell count:', group0.length);
  console.log('  first cell title:', group0[0]?.title, 'num:', group0[0]?.num);
  console.log('  last cell title: ', group0[group0.length - 1]?.title);

  // Click group 1 in sidebar.
  const rows = await page.$$('.group-row');
  console.log('sidebar rows:', rows.length);
  await rows[1].click();
  await page.waitForTimeout(400);

  const group1 = await collect();
  console.log('\nafter click sidebar row 1:');
  console.log('cell count:', group1.length);
  console.log('  first cell title:', group1[0]?.title, 'num:', group1[0]?.num);
  console.log('  last cell title: ', group1[group1.length - 1]?.title);

  // Check image URL query format.
  const sample = imageUrls.slice(0, 3);
  console.log('\nsample image URLs:');
  for (const u of sample) console.log('  ', u);

  // Assertions.
  const overlap = group0.filter((a) => group1.some((b) => a.title === b.title)).length;
  console.log('\noverlap (same cells after switch):', overlap);
  const appendBug = group1.length > group0.length && overlap === group0.length;
  console.log('append bug detected:', appendBug);
  const replaceOk = overlap === 0;
  console.log('proper replace:', replaceOk);

  // Also check the active group highlighted in sidebar.
  const activeIdx = await page.$eval('.group-row.active', (e) => e.getAttribute('data-g'));
  console.log('active sidebar idx:', activeIdx);

  await browser.close();
  if (!replaceOk) { console.log('\nFAIL: grid did not replace on group click'); process.exit(1); }
  console.log('\nPASS');
}

main().catch((e) => { console.error(e); process.exit(2); });
