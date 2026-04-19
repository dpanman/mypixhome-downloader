// Minimal JPEG/EXIF parser for camera identification.
//
// Returns { make, model, serial } from the first APP1 Exif segment. We only
// need three tags, so we walk the IFD0 + ExifIFD directly without depending
// on an external library (saves ~40 KB of bundle and one more moving part).
//
//   Tag 0x010F  Make                           (IFD0,    ASCII)
//   Tag 0x0110  Model                          (IFD0,    ASCII)
//   Tag 0x8769  ExifIFDPointer                 (IFD0,    long)
//   Tag 0xA431  BodySerialNumber               (ExifIFD, ASCII)   EXIF 2.3+
//
// Input: ArrayBuffer | Uint8Array | plain array of bytes.
// Output: { make, model, serial } with '' for missing fields, or null if the
// buffer isn't a JPEG / has no readable EXIF.

export function parseExif(input) {
  const data = toUint8(input);
  if (!data || data.length < 20) return null;
  if (data[0] !== 0xff || data[1] !== 0xd8) return null; // Not JPEG (no SOI)

  // Scan for the APP1 segment that starts with "Exif\0\0".
  let off = 2;
  while (off + 4 < data.length) {
    if (data[off] !== 0xff) return null;
    const marker = data[off + 1];
    // SOS (0xda) — compressed data starts, no more metadata segments.
    if (marker === 0xda) return null;
    // Standalone markers (no length field).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const segLen = (data[off + 2] << 8) | data[off + 3];
    if (marker === 0xe1) {
      // APP1 — confirm "Exif\0\0".
      const b = off + 4;
      if (data[b] === 0x45 && data[b + 1] === 0x78 && data[b + 2] === 0x69 &&
          data[b + 3] === 0x66 && data[b + 4] === 0x00 && data[b + 5] === 0x00) {
        return parseTiff(data, b + 6);
      }
    }
    off += 2 + segLen;
  }
  return null;
}

function toUint8(x) {
  if (!x) return null;
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (Array.isArray(x)) return new Uint8Array(x);
  return null;
}

function parseTiff(all, base) {
  if (base + 8 > all.length) return null;
  const b0 = all[base], b1 = all[base + 1];
  const little = b0 === 0x49 && b1 === 0x49;
  const big = b0 === 0x4d && b1 === 0x4d;
  if (!little && !big) return null;

  const dv = new DataView(all.buffer, all.byteOffset + base, all.length - base);
  const magic = dv.getUint16(2, little);
  if (magic !== 0x002a) return null;
  const ifd0Off = dv.getUint32(4, little);

  const ifd0 = readIfd(dv, ifd0Off, little);
  if (!ifd0) return null;

  const make = asciiOf(dv, ifd0[0x010f], little);
  const model = asciiOf(dv, ifd0[0x0110], little);

  let serial = '';
  const exifPtr = ifd0[0x8769];
  if (exifPtr) {
    // value field contains the sub-IFD offset (type LONG, count 1)
    const subOff = dv.getUint32(exifPtr.valOff, little);
    const exif = readIfd(dv, subOff, little);
    if (exif && exif[0xa431]) serial = asciiOf(dv, exif[0xa431], little);
  }

  return { make: (make || '').trim(), model: (model || '').trim(), serial: (serial || '').trim() };
}

function readIfd(dv, off, little) {
  if (off + 2 > dv.byteLength) return null;
  const count = dv.getUint16(off, little);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, little);
    const type = dv.getUint16(e + 2, little);
    const cnt = dv.getUint32(e + 4, little);
    entries[tag] = { type, count: cnt, valOff: e + 8 };
  }
  return entries;
}

// Read an ASCII-type field. Values <= 4 bytes are inline in the entry, longer
// values are at the offset stored in the value-field (little/big endian).
function asciiOf(dv, entry, little) {
  if (!entry) return '';
  const total = entry.count;
  let start;
  if (total <= 4) {
    start = entry.valOff;
  } else {
    start = dv.getUint32(entry.valOff, little);
  }
  if (start < 0 || start >= dv.byteLength) return '';
  const bytes = [];
  for (let i = 0; i < total; i++) {
    const k = start + i;
    if (k >= dv.byteLength) break;
    const b = dv.getUint8(k);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode.apply(null, bytes);
}

// Build a short, human-friendly camera label out of EXIF bits.
//   { make: 'Canon', model: 'Canon EOS R6m2', serial: 'MQ0568088' }
//     → 'Canon EOS R6m2 · MQ0568088'
// Model often already contains the make, so we don't double it up.
export function formatCameraLabel(info) {
  if (!info) return '';
  const model = info.model || '';
  const make = info.make || '';
  const head = model || make || '';
  const serial = info.serial ? ` · ${info.serial}` : '';
  return head + serial;
}
