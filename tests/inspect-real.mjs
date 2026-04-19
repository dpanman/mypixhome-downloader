// Visit the real MyPixhome gallery in Chrome and dump every network request
// so we can confirm what the actual image URL format looks like (and which
// API endpoints / params the live site uses).
//
// Run locally (requires internet):
//   npm install --ignore-scripts
//   npx playwright install chromium
//   PLAYWRIGHT_BROWSERS_PATH=... node tests/inspect-real.mjs
//
// Optional: pass a different URL as the first arg.
//
// This does NOT run in the automated test suite — it's a one-off inspector.

import { chromium } from 'playwright';

const URL = process.argv[2] ||
  'https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const apiCalls = [];    // JSON API
  const imgCalls = [];    // image bytes
  const allUrls = [];

  page.on('request', (req) => {
    const u = req.url();
    allUrls.push({ method: req.method(), url: u });
    if (/cloud\.zno\.com\/cloudapi/.test(u)) {
      apiCalls.push({
        method: req.method(),
        url: u,
        postData: req.postData() || null,
      });
    }
    if (/image\/download|\.jpg(\?|$)|\.jpeg(\?|$)|\.webp(\?|$)|\.png(\?|$)/i.test(u)) {
      imgCalls.push({ method: req.method(), url: u, resourceType: req.resourceType() });
    }
  });

  page.on('response', async (res) => {
    const u = res.url();
    if (/cloud\.zno\.com\/cloudapi/.test(u) && res.headers()['content-type']?.includes('json')) {
      try {
        const body = await res.json();
        const keys = Object.keys(body.data || {}).slice(0, 8);
        let sample = null;
        if (body.data && Array.isArray(body.data.album_content_list)) {
          sample = body.data.album_content_list[0];
        } else if (Array.isArray(body.data)) {
          sample = body.data.slice(0, 4);
        }
        apiCalls.at(-1).response = {
          status: res.status(),
          ret_code: body.ret_code,
          data_keys: keys,
          sample,
        };
      } catch {}
    }
  });

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('navigation error:', e.message);
  }
  // Let the SPA boot, fetch photos, and paint thumbnails.
  await page.waitForTimeout(12000);

  console.log('\n=== All cloud.zno.com cloudapi calls ===');
  for (const c of apiCalls) {
    console.log(`\n${c.method} ${c.url}`);
    if (c.postData) console.log(`  body: ${c.postData.slice(0, 400)}`);
    if (c.response) {
      console.log(`  <- ${c.response.status} ret_code=${c.response.ret_code} data_keys=${JSON.stringify(c.response.data_keys)}`);
      if (c.response.sample) {
        console.log('  sample:', JSON.stringify(c.response.sample, null, 2).slice(0, 1200));
      }
    }
  }

  console.log('\n=== First 10 image requests ===');
  for (const c of imgCalls.slice(0, 10)) {
    console.log(`${c.method} [${c.resourceType}] ${c.url}`);
  }

  console.log(`\nTotal requests seen: ${allUrls.length} (api: ${apiCalls.length}, image: ${imgCalls.length})`);

  await browser.close();
}

main().catch((e) => { console.error('crash:', e); process.exit(2); });
