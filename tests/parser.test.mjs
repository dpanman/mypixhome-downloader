// Unit tests for parseGalleryUrl. Run with `node tests/parser.test.mjs`.
// No test framework — tiny assert-only harness so we don't need a toolchain.

import { parseGalleryUrl, galleryKey } from '../app/src/parser.js';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  (ok ? pass++ : fail++, console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`));
  if (!ok) console.log(`     actual:   ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`);
}
function truthy(v, name) { (v ? pass++ : fail++, console.log(`${v ? 'OK  ' : 'FAIL'} ${name}`)); }

// Valid URLs.
eq(parseGalleryUrl('https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788'),
  { ok: true, domain: 'chicago-star-photography.mypixhome.com', slug: 'southport-spring-classic', storeId: '8788' },
  'happy path (trailing slash)');

eq(parseGalleryUrl('https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic?storeId=8788'),
  { ok: true, domain: 'chicago-star-photography.mypixhome.com', slug: 'southport-spring-classic', storeId: '8788' },
  'happy path (no trailing slash)');

eq(parseGalleryUrl('https://X.mypixhome.com/instant-gallery/SOUTHPORT-SPRING-classic/?storeId=12'),
  { ok: true, domain: 'x.mypixhome.com', slug: 'southport-spring-classic', storeId: '12' },
  'case-insensitive domain + slug lowercased');

truthy(parseGalleryUrl('https://x.mypixhome.com/instant-gallery/test/?storeId=1#/h_2026_04_12_04').ok,
  'hash suffix is ignored');

// Invalid URLs.
truthy(!parseGalleryUrl('').ok, 'empty string rejected');
truthy(!parseGalleryUrl('   ').ok, 'whitespace rejected');
truthy(!parseGalleryUrl('not a url').ok, 'non-URL rejected');
truthy(!parseGalleryUrl('ftp://x.mypixhome.com/instant-gallery/foo/?storeId=1').ok, 'ftp protocol rejected');
truthy(!parseGalleryUrl('https://example.com/instant-gallery/foo/?storeId=1').ok, 'non-mypixhome host rejected');
truthy(!parseGalleryUrl('https://x.mypixhome.com/other/foo/?storeId=1').ok, 'wrong path rejected');
truthy(!parseGalleryUrl('https://x.mypixhome.com/instant-gallery/foo/').ok, 'missing storeId rejected');
truthy(!parseGalleryUrl('https://x.mypixhome.com/instant-gallery/foo/?storeId=abc').ok, 'non-numeric storeId rejected');
truthy(!parseGalleryUrl('https://x.mypixhome.com/instant-gallery/-bad/?storeId=1').ok, 'slug with leading hyphen rejected');
truthy(!parseGalleryUrl('https://x.mypixhome.com/instant-gallery/%21foo/?storeId=1').ok, 'slug with special char rejected');

// galleryKey deterministic.
eq(
  galleryKey({ domain: 'a.mypixhome.com', slug: 's1', storeId: '42' }),
  'a.mypixhome.com|s1|42',
  'galleryKey shape',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
