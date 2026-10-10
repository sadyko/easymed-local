// CLINIC_PROFILE_V1 — PNG для тестов логотипов: сигнатура и чанки настоящие,
// CRC нулевые (clinic-logo-rules.js их не проверяет), картинки внутри нет.
// colorType: 6 — RGBA, 4 — серый+альфа, 2 — RGB (без прозрачности), 3 — палитра.
function chunk(type, data = Buffer.alloc(0)) {
  const c = Buffer.alloc(12 + data.length);
  c.writeUInt32BE(data.length, 0);
  c.write(type, 4, 'ascii');
  data.copy(c, 8);
  return c;
}
export function fakePng(w, h, { colorType = 6, trns = false, pad = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(trns ? [chunk('tRNS', Buffer.from([0, 0]))] : []),
    chunk('IDAT', Buffer.alloc(1 + pad)),
    chunk('IEND'),
  ]);
}
export const pngDataUrl = (buf) => 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
