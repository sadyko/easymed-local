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
function stripAutoPrint(html) {
  return html.replace(/<script>[\s\S]*?window\.print\(\)[\s\S]*?<\/script>/g, '');
}

// Настройки бренда для рендера — серверный аналог loadDocSettings().
//
// В браузере настройки живут в localStorage и подтягиваются из doc_branding;
// у сервера localStorage нет, поэтому собираем то же самое напрямую из таблиц.
// doc_branding (дизайнер) главнее doc_settings (реквизиты клиники) — тот же
// порядок, что и в applyCompanyBranding() на клиенте.
export function loadServerDocSettings(db) {
  let brand = {};
  try {
    const row = db.prepare('SELECT settings FROM doc_branding ORDER BY company_id LIMIT 1').get();
    if (row && row.settings) brand = JSON.parse(row.settings) || {};
  } catch { /* нет таблицы или битый JSON — идём с реквизитами клиники */ }

  const c = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
  const s = {
    clinicName: 'Easy-Med',
    ink: '#0b1418', paperBg: '#ffffff', paperSize: 'A4', language: 'ru',
    ...brand,
  };
  // Реквизиты клиники перекрывают дизайнерские заглушки, но только если реально
  // заполнены: пустое поле в doc_settings не должно стирать настройку дизайнера.
  const overlay = {
    clinicName: c.clinic_name, address: c.address, phone: c.phone, email: c.email,
    license: c.license, logoDataUrl: c.logo_data_url, accent: c.accent_color,
  };
  for (const [k, v] of Object.entries(overlay)) if (v) s[k] = v;
  if (!s.variant || typeof s.variant !== 'object') s.variant = {};
  return s;
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-pdf-'));
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ }
  }
}
