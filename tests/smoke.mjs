// Playwright smoke test — loads the app in headless Chrome, captures console
// + network errors, and verifies the landing page renders. Run with:
//   node tests/smoke.mjs
// (http-server must be serving ./app on localhost:8123.)

import { chromium } from 'playwright';

const URL_UNDER_TEST = process.env.APP_URL || 'http://localhost:8123/index.html';

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on('console', (msg) => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message + (err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : ''));
  });
  page.on('requestfailed', (req) => {
    requestFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 20000 });

  // Let React mount.
  await page.waitForTimeout(500);

  const root = await page.$('#root');
  const rootHtml = root ? await root.innerHTML() : '(no root)';

  const hasLanding = await page.$('.landing');
  const h1Text = await page.$eval('h1', (e) => e.textContent).catch(() => null);
  const classAttrIsReal = await page.$eval('.landing', (e) => e.getAttribute('class')).catch(() => null);

  console.log('=== Console ===');
  for (const m of consoleMsgs) {
    if (m.type === 'error' || m.type === 'warning' || /error|fail|warn/i.test(m.text)) {
      console.log(`[${m.type}] ${m.text}`);
    }
  }
  console.log('=== Page errors ===');
  for (const e of pageErrors) console.log(e);
  console.log('=== Request failures ===');
  for (const f of requestFailures) console.log(f);

  console.log('=== DOM ===');
  console.log('h1 text:', JSON.stringify(h1Text));
  console.log('.landing found:', !!hasLanding);
  console.log('.landing class attr:', JSON.stringify(classAttrIsReal));
  console.log('root innerHTML (first 500):', rootHtml.slice(0, 500));

  await browser.close();

  const fatal = pageErrors.length > 0 || !hasLanding || h1Text !== 'Gallery Sorter';
  if (fatal) {
    console.error('\nFAIL: landing did not render correctly.');
    process.exit(1);
  }
  console.log('\nPASS: landing rendered.');
}

main().catch((e) => {
  console.error('Harness crash:', e);
  process.exit(2);
});
