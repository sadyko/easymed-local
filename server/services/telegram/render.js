// TELEGRAM_BOT_V1 — HTML → PDF силами уже установленного Chrome.
//
// Никакого puppeteer: у Chrome есть собственный ключ --print-to-pdf, а Chrome
// (или Edge) на клинической машине уже стоит. Проект остаётся на трёх
// зависимостях, и не нужно тянуть 300 МБ Chromium на компьютер регистратуры,
// у которой интернет может быть по мобильному модему.
//
// HTML собирает public/js/shared/doc-render.js — ТОТ ЖЕ модуль, которым
// печатает браузер. Поэтому PDF в Telegram не может разъехаться с тем, что
// клиника печатает на бумаге: это один и тот же код и одни и те же настройки
// бренда.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSheetHtml } from '../../../public/js/shared/doc-render.js';
import { resolveDocSettings } from '../../../public/js/shared/company-branding.js';   // CLINIC_API_FIX_V1 — одно правило с печатью в браузере
import { getClinicBySlug } from '../rpc/clinic.js';   // CLINIC_API_FIX_V1 — та же запись клиники, что window.CLINIC

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

// Порядок важен: сначала обычные места установки Chrome, потом Edge, который
// на Windows есть всегда. Первый существующий и выигрывает.
function candidatePaths() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    // На случай, если сервер однажды поедет на Linux-коробку.
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

let _cached = null;
export function findChrome(override = '') {
  if (override && fs.existsSync(override)) return override;
  if (_cached && fs.existsSync(_cached)) return _cached;
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) { _cached = p; return p; }
  }
  return '';
}

export class RenderError extends Error {}

// Скрипт автопечати нужен окну браузера и мешает --print-to-pdf: он вызывает
// window.print() внутри headless-процесса. Вырезаем — на вид документа это не
// влияет, печать инициирует сам Chrome ключом командной строки.
// PRINT_AUTO_V1 — экспорт для проверки: шаблон вырезает и скрипт общего
// помощника печати (public/js/shared/print-auto.js), не только обёртки.
export function stripAutoPrint(html) {
  return html.replace(/<script>[\s\S]*?window\.print\(\)[\s\S]*?<\/script>/g, '');
}

// CLINIC_API_FIX_V1 — заготовки под сохранёнными настройками «Документов»
// (экспорт — для проверки, что сервер идёт через общий модуль).
export const SERVER_DOC_BASE = Object.freeze({
  clinicName: 'Easy-Med',
  ink: '#0b1418', paperBg: '#ffffff', paperSize: 'A4', language: 'ru',
});

// Настройки бренда для рендера — серверный аналог loadDocSettings().
//
// В браузере настройки живут в localStorage и подтягиваются из doc_branding;
// у сервера localStorage нет, поэтому собираем то же самое напрямую из таблиц.
// Оформление (шрифт, плотность, подвал…) — из doc_branding (дизайнер),
// реквизиты клиники — из «Компании» сверху: то же правило, что и в
// loadDocSettings() на клиенте.
export function loadServerDocSettings(db) {
  let brand = {};
  try {
    const row = db.prepare('SELECT settings FROM doc_branding ORDER BY company_id LIMIT 1').get();
    if (row && row.settings) brand = JSON.parse(row.settings) || {};
  } catch { /* нет таблицы или битый JSON — идём с реквизитами клиники */ }

  // CLINIC_API_FIX_V1 — чистка старых заготовок и «Компания» сверху — тем же
  // общим модулем, что и печать в браузере (shared/company-branding.js).
  // doc_branding — копия, снятая при сохранении «Документов»: в ней лежат и
  // название, и logoUrl, которые «Компания» подставила ТОГДА, и заготовки
  // поставщика у давно сохранявших клиник. Запись клиники — та же, что видит
  // браузер в window.CLINIC.
  const s = resolveDocSettings({ ...SERVER_DOC_BASE, ...brand }, getClinicBySlug(db));
  // CLINIC_PROFILE_V1 — в PDF не уходит логотип, которого Chrome не достанет.
  // Chrome печатает из file://: путь без схемы (/api/storage/…) он не откроет
  // (вход, другой источник), и в PDF встал бы битый квадрат. Печатная копия
  // квадратного логотипа — data URL всегда (Р4); это замок на будущее.
  // Ревью (сравнение PDF до/после): встроенный data URL любого типа и полный
  // адрес http(s):// печатаются, как печатались до шага 3.
  for (const k of ['logoUrl', 'logoDataUrl']) if (s[k] && !/^(?:data:|https?:\/\/)/i.test(String(s[k]))) s[k] = null;
  return s;
}

// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md,
// раздел 3, п. 11) — временные папки рендера не копятся в %TEMP%. Chrome на
// Windows отпускает свой профиль не сразу (crashpad и GPU-процесс доживают
// сотни миллисекунд), и одна попытка rmSync падала EBUSY молча: в %TEMP%
// копились папки easymed-pdf-* с профилем Chrome на несколько мегабайт.
export const PDF_TMP_PREFIX = 'easymed-pdf-';
const PDF_TMP_STALE_MS = 24 * 60 * 60 * 1000;
const PDF_TMP_RETRY_LATER_MS = 30_000;

function laterUnref(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * Удалить временную папку рендера С ПОВТОРАМИ, НЕ БЛОКИРУЯ поток (async, в
 * запросе не ждётся): сначала сам rm повторяет
 * (maxRetries — EBUSY/EPERM/ENOTEMPTY на Windows), не вышло — ещё одна
 * попытка через полминуты на таймере, который не держит программу. Не вышло и
 * тогда — папку подберёт уборка при следующем запуске (sweepStalePdfDirs).
 * Никогда не бросает. true — удалена сразу.
 */
export async function removePdfTempDir(dir, { rmImpl = fs.promises.rm, laterMs = PDF_TMP_RETRY_LATER_MS, schedule = laterUnref } = {}) {
  const attempt = async () => {
    try { await rmImpl(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; }
    catch { return false; }
  };
  if (await attempt()) return true;
  schedule(() => attempt().then((ok) => {
    if (!ok) console.warn('[telegram] временная папка PDF не удалилась — её уберёт следующий запуск:', dir);
  }), laterMs);
  return false;
}

/**
 * При запуске: папки easymed-pdf-* старше суток в %TEMP% удаляются. Сутки —
 * чтобы не тронуть папку рендера, который идёт прямо сейчас (рендер длится
 * секунды). Только папки и только с нашим началом имени. Возвращает число
 * удалённых; никогда не бросает.
 */
export function sweepStalePdfDirs({ base = os.tmpdir(), maxAgeMs = PDF_TMP_STALE_MS, now = Date.now(), rmImpl = fs.rmSync } = {}) { // один раз при старте — синхронно, с малыми повторами
  let names;
  try { names = fs.readdirSync(base); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PDF_TMP_PREFIX)) continue;
    const full = path.join(base, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      rmImpl(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed++;
    } catch { /* занята — уберётся в следующий раз */ }
  }
  if (removed) console.log('[telegram] убраны старые временные папки PDF:', removed);
  return removed;
}

// Собрать PDF. Возвращает Buffer.
//
// Каждый рендер идёт в собственном временном каталоге вместе с
// --user-data-dir: без отдельного профиля второй Chrome может присоединиться
// к уже запущенному процессу пользователя и не напечатать ничего.
export async function renderPdf(db, { type, data, title = null, idLine = null, settings = null, chromePath = '', timeoutMs = 45000 } = {}) {
  const exe = findChrome(chromePath);
  if (!exe) {
    throw new RenderError('На сервере не найден Chrome или Edge — без него документ не собрать в PDF. Укажите путь к chrome.exe в настройках бота.');
  }

  const s = settings || loadServerDocSettings(db);
  const html = stripAutoPrint(buildSheetHtml({ type, s, data, title, idLine }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PDF_TMP_PREFIX));
  const htmlPath = path.join(dir, 'doc.html');
  const pdfPath = path.join(dir, 'doc.pdf');
  fs.writeFileSync(htmlPath, html, 'utf8');

  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    '--no-pdf-header-footer',
    // Документ самодостаточен (логотип — data:URL), но вёрстке нужно время
    // «устояться»; виртуальное время не заставляет ждать реальные секунды.
    '--virtual-time-budget=3000',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
        // Chrome умеет напечатать PDF и всё равно выйти с ненулевым кодом,
        // поэтому решает наличие файла, а не код возврата.
        if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0) return resolve();
        reject(new RenderError('Не удалось собрать PDF: ' + ((err && err.message) || 'Chrome не создал файл')));
      });
      child.on('error', (e) => reject(new RenderError('Не удалось запустить Chrome: ' + e.message)));
    });
    return fs.readFileSync(pdfPath);
  } finally {
    removePdfTempDir(dir);
  }
}
