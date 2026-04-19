// Helper shared by exif.test.mjs and flow.mjs: builds a minimal JPEG whose
// APP1 Exif segment carries a Make / Model / BodySerialNumber, exactly what
// parseExif reads. Keeping the builder here avoids duplicating the byte-level
// TIFF layout in two places.

export function buildExifJpeg({ make, model, serial }) {
  const makeBytes = Buffer.from(String(make) + '\0', 'ascii');
  const modelBytes = Buffer.from(String(model) + '\0', 'ascii');
  const serialBytes = Buffer.from(String(serial) + '\0', 'ascii');

  // TIFF (little-endian) layout: 8-byte header | IFD0 (3 entries) | ExifIFD
  // (1 entry) | value pool. Values ≤ 4 bytes are stored inline in the entry's
  // value/offset slot; longer values live in the pool with the slot holding
  // their offset.
  const IFD0_OFF = 8;
  const IFD0_SIZE = 2 + 3 * 12 + 4;                   // 42
  const EXIF_IFD_OFF = IFD0_OFF + IFD0_SIZE;          // 50
  const EXIF_IFD_SIZE = 2 + 1 * 12 + 4;               // 18
  const POOL_OFF = EXIF_IFD_OFF + EXIF_IFD_SIZE;      // 68

  const pool = [];
  let poolCursor = POOL_OFF;
  function place(bytes) {
    if (bytes.length <= 4) return { inline: bytes };
    const off = poolCursor;
    pool.push({ off, bytes });
    poolCursor += bytes.length;
    return { off };
  }
  const mk = place(makeBytes);
  const md = place(modelBytes);
  const sn = place(serialBytes);

  const tiff = Buffer.alloc(poolCursor);
  tiff[0] = 0x49; tiff[1] = 0x49;
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(IFD0_OFF, 4);

  function writeEntry(off, tag, type, count, val) {
    tiff.writeUInt16LE(tag, off);
    tiff.writeUInt16LE(type, off + 2);
    tiff.writeUInt32LE(count, off + 4);
    if (val.inline) {
      for (let i = 0; i < 4; i++) tiff[off + 8 + i] = i < val.inline.length ? val.inline[i] : 0;
    } else {
      tiff.writeUInt32LE(val.off, off + 8);
    }
  }

  tiff.writeUInt16LE(3, IFD0_OFF);
  writeEntry(IFD0_OFF + 2 + 0 * 12, 0x010f, 2, makeBytes.length, mk);
  writeEntry(IFD0_OFF + 2 + 1 * 12, 0x0110, 2, modelBytes.length, md);
  writeEntry(IFD0_OFF + 2 + 2 * 12, 0x8769, 4, 1, { off: EXIF_IFD_OFF });
  tiff.writeUInt32LE(0, IFD0_OFF + 2 + 3 * 12);

  tiff.writeUInt16LE(1, EXIF_IFD_OFF);
  writeEntry(EXIF_IFD_OFF + 2, 0xa431, 2, serialBytes.length, sn);
  tiff.writeUInt32LE(0, EXIF_IFD_OFF + 2 + 12);

  for (const { off, bytes } of pool) bytes.copy(tiff, off);

  const exifHeader = Buffer.from('Exif\0\0', 'binary');
  const app1Payload = Buffer.concat([exifHeader, tiff]);
  const app1Len = app1Payload.length + 2;
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]),
    app1Payload,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}
