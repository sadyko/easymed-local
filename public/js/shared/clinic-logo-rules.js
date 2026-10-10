// CLINIC_PROFILE_V1 — ЛОГОТИПЫ КЛИНИКИ: что принимается. Чистый модуль: его
// спрашивают экран «Компания» до отправки и хранилище (routes/storage.js)
// после — браузер обойти можно, curl проверку не спрашивает.
//
// Два логотипа, оба — PNG с прозрачностью (решение владельца, 2026-10-06):
// квадратный — шапка программы, печать, карточки у партнёров; вертикальный —
// страница клиники у партнёров. SVG не принимается: хранилище не отдаёт его
// внутри страницы (V3120_FIX M6), а партнёры ждут растр.

export const LOGO_BUCKET = 'clinic-logos';
export const LOGO_KINDS = Object.freeze(['square', 'portrait']);
export const MAX_LOGO_BYTES = 1024 * 1024;
export const MAX_LOGO_MB = 1;
export const LOGO_MIN_SIDE = 256;
export const LOGO_MAX_SIDE = 2048;
export const SQUARE_TOLERANCE = 0.02;
// Печатная копия квадратного (doc_settings.logo_data_url) — те же пределы, что
// у единственного логотипа до шага 3 (views/documents-settings.js: 220 px,
// 90 000 знаков): размер бланков, localStorage и справочника филиалов не растёт.
export const PRINT_COPY_SIDE = 220;
export const PRINT_COPY_MAX_CHARS = 90000;

export const LOGO_TEMPLATES = Object.freeze({
  empty:       'Файл пустой — загружать нечего.',
  tooLarge:    'Логотип {got} МБ — это больше предела в {max} МБ. Сохраните PNG поменьше.',
  notPng:      'Логотип — только PNG с прозрачным фоном.',
  opaque:      'У этого PNG нет прозрачности: фон будет виден белым прямоугольником. Сохраните логотип с прозрачным фоном.',
  badSize:     'Логотип {w}×{h} px. Нужно от {min} до {max} px по каждой стороне.',
  notSquare:   'Квадратный логотип {w}×{h} px — стороны должны быть равны.',
  notPortrait: 'Вертикальный логотип {w}×{h} px — высота должна быть больше ширины.',
});

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (b, o) => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const ascii4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** { width, height, hasAlpha } из заголовка PNG; null — это не PNG. */
export function pngInfo(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (b.length < 33) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
  if (ascii4(b, 12) !== 'IHDR') return null;
  const width = u32(b, 16), height = u32(b, 20), colorType = b[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  // Палитра и RGB прозрачны только с чанком tRNS — он стоит до первого IDAT.
  for (let o = 8; !hasAlpha && o + 8 <= b.length;) {
    const len = u32(b, o), type = ascii4(b, o + 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { width, height, hasAlpha };
}

const fail = (code, template, params = {}) => ({ code, template, params });

/** null — годится; иначе { code, template, params } (перевод шаблона, подстановка потом). */
export function logoRefusal({ kind, name, bytes }) {
  const size = bytes ? bytes.length : 0;
  if (!size) return fail('file_empty', LOGO_TEMPLATES.empty);
  if (size > MAX_LOGO_BYTES) {
    return fail('file_too_large', LOGO_TEMPLATES.tooLarge, { got: (size / (1024 * 1024)).toFixed(1), max: String(MAX_LOGO_MB) });
  }
  const info = /\.png$/i.test(String(name || '')) ? pngInfo(bytes) : null;
  if (!info) return fail('logo_not_png', LOGO_TEMPLATES.notPng);
  if (!info.hasAlpha) return fail('logo_not_transparent', LOGO_TEMPLATES.opaque);
  const { width: w, height: h } = info;
  const dims = { w: String(w), h: String(h) };
  if (Math.min(w, h) < LOGO_MIN_SIDE || Math.max(w, h) > LOGO_MAX_SIDE) {
    return fail('logo_bad_size', LOGO_TEMPLATES.badSize, { ...dims, min: String(LOGO_MIN_SIDE), max: String(LOGO_MAX_SIDE) });
  }
  if (kind === 'square' && Math.abs(w - h) > Math.max(w, h) * SQUARE_TOLERANCE) return fail('logo_not_square', LOGO_TEMPLATES.notSquare, dims);
  if (kind === 'portrait' && !(h > w)) return fail('logo_not_portrait', LOGO_TEMPLATES.notPortrait, dims);
  return null;
}

/** Квадратная ли PNG-картинка в data URL (печатная копия) — для знака в шапке программы. */
export function isSquarePngDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  let bytes;
  try { bytes = typeof Buffer !== 'undefined' ? Buffer.from(m[1].slice(0, 64), 'base64') : Uint8Array.from(atob(m[1].slice(0, 64)), (c) => c.charCodeAt(0)); }
  catch { return false; }
  const info = pngInfo(bytes);
  return !!info && Math.abs(info.width - info.height) <= Math.max(info.width, info.height) * SQUARE_TOLERANCE;
}
