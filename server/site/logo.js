// WEBSITE_V1 (SITE_CLINIC_LOGO_V1, владелец 2026-11-25: «what about logo in here») —
// логотип сайта = логотип из «Компании». До этого шапка показывала logo.webp,
// перенесённый из Chilla: у каждой клиники на сайте стоял чужой знак рядом с её
// собственным названием. Нет логотипа в «Компании» — нет картинки, только имя.
//
// Источника два, в том же порядке, что у остальной программы: файл квадратного
// логотипа (clinic-logos/square), а без него — печатная копия logo_data_url
// (она одна и есть у клиники, не менявшей логотип с тех пор, и у филиала).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LOGO_BUCKET } from '../../public/js/shared/clinic-logo-rules.js';

// Только растр: SVG мог бы нести скрипт на публичный адрес.
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/;
// Путь пишет экран «Компания», но читаем мы его на публичном адресе — только
// точная форма square/<имя>.png, без права выйти из папки.
const SQUARE = /^square\/[A-Za-z0-9_-]+\.png$/;

function row(db) {
  try { return db.prepare('SELECT logo_square_path, logo_data_url FROM doc_settings WHERE id = 1').get() || {}; }
  catch { return {}; }
}

/** { type, bytes } или null. */
export function clinicLogo(db, storageDir) {
  const r = row(db);
  const rel = String(r.logo_square_path || '').trim();
  if (storageDir && SQUARE.test(rel)) {
    try { return { type: 'image/png', bytes: fs.readFileSync(path.join(storageDir, LOGO_BUCKET, ...rel.split('/'))) }; }
    catch { /* файла нет — печатная копия ниже */ }
  }
  const m = DATA_URL.exec(String(r.logo_data_url || '').trim());
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  return bytes.length ? { type: m[1], bytes } : null;
}

/** Адрес для разметки; версия в адресе — новый логотип виден сразу, мимо кэша браузера. '' — логотипа нет. */
export function clinicLogoUrl(db, storageDir) {
  const l = clinicLogo(db, storageDir);
  return l ? `/media/logo?v=${createHash('sha1').update(l.bytes).digest('hex').slice(0, 10)}` : '';
}
