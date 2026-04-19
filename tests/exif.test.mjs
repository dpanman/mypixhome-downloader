// Unit tests for the EXIF parser. Builds a tiny but valid JPEG that contains
// an APP1 Exif segment with Make / Model / BodySerialNumber, then asserts
// parseExif reads them back. This avoids needing a real JPEG fixture on disk
// and exercises the byte-level IFD walk end to end.

import { parseExif, formatCameraLabel } from '../app/src/exif.js';
import { buildExifJpeg } from './_exif-fixture.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  (ok ? pass++ : fail++, console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`));
  if (!ok) console.log(`     actual:   ${JSON.stringify(a)}\n     expected: ${JSON.stringify(b)}`);
}

// Happy path
{
  const jpeg = buildExifJpeg({
    make: 'Canon',
    model: 'Canon EOS R6m2',
    serial: '172021004429',
  });
  const info = parseExif(jpeg);
  eq(info, { make: 'Canon', model: 'Canon EOS R6m2', serial: '172021004429' },
    'parses Make/Model/BodySerialNumber from APP1');
  eq(formatCameraLabel(info), 'Canon EOS R6m2 · 172021004429',
    'formatCameraLabel joins model + serial');
}

// Serial fits inline (<=4 bytes) — exercises the no-offset code path.
{
  const jpeg = buildExifJpeg({ make: 'X', model: 'Y', serial: 'SN1' });
  const info = parseExif(jpeg);
  eq(info, { make: 'X', model: 'Y', serial: 'SN1' },
    'ASCII values that fit inline are read correctly');
}

// Not a JPEG → null.
eq(parseExif(Buffer.from([0x00, 0x01, 0x02, 0x03])), null, 'non-JPEG input → null');

// JPEG without any APP1 Exif segment → null.
{
  const noExif = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  eq(parseExif(noExif), null, 'JPEG without APP1 Exif → null');
}

// Accepts Uint8Array and ArrayBuffer.
{
  const jpeg = buildExifJpeg({ make: 'A', model: 'B', serial: 'C' });
  const ab = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  eq(parseExif(new Uint8Array(jpeg)), { make: 'A', model: 'B', serial: 'C' },
    'accepts Uint8Array');
  eq(parseExif(ab), { make: 'A', model: 'B', serial: 'C' },
    'accepts ArrayBuffer');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
