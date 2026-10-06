// CLINIC_API_FIX_V1 — документы Telegram с ТЕКУЩИМИ логотипом и названием и
// без старых заготовок — тем же правилом, что печать в браузере.
//
// doc_branding.settings — это копия, снятая в момент сохранения «Документов»:
// дизайнер хранит объект настроек целиком, вместе с тем, что подставила тогда
// «Компания» (clinicName, logoUrl, адрес…), и со старыми заготовками
// поставщика у клиник, сохранявших «Документы» давно. Само правило «реквизиты
// клиники поверх оформления» и чистка заготовок живут в одном модуле
// public/js/shared/company-branding.js (его тесты — рядом с ним); здесь —
// что пациент получает в PDF и что оба пути (браузер и сервер) идут через
// этот модуль, а не через свои копии.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getClinicBySlug } from '../rpc/clinic.js';
import { buildSheetHtml } from '../../../public/js/shared/doc-render.js';
import { resolveDocSettings, overlayCompanyBranding, LEGACY_DEFAULTS, LEGACY_TAGLINE } from '../../../public/js/shared/company-branding.js';
import { loadServerDocSettings, SERVER_DOC_BASE } from './render.js';

const LOGO_OLD = 'data:image/png;base64,T0xETE9HT0FBQQ==';      // A — копия в doc_branding
const LOGO_NEW = 'data:image/png;base64,TkVXTE9HT0JCQg==';      // B — нынешний в «Компании»

// Копия, которую сохранили «Документы», когда клиника называлась «Старая».
const OLD_COPY = {
  clinicName: 'Старая', address: 'Старый адрес', phone: '+998 71 000 00 00',
  email: 'old@clinic.uz', license: 'OLD-1', accent: '#111111', logoUrl: LOGO_OLD,
  useCompanyIdentity: true, fontPair: 'serif', density: 'airy', footerNote: 'Подвал дизайнера',
};

function seed({ copy = OLD_COPY, company = {} } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO doc_branding (company_id, settings) VALUES (1, ?)').run(JSON.stringify(copy));
  const c = {
    clinic_name: 'Новая', address: 'Новый адрес', phone: '+998 71 111 11 11', email: 'new@clinic.uz',
    license: 'NEW-2', logo_data_url: LOGO_NEW, accent_color: '#2255aa', ...company,
  };
  db.prepare(`UPDATE doc_settings SET clinic_name = ?, address = ?, phone = ?, email = ?, license = ?,
              logo_data_url = ?, accent_color = ? WHERE id = 1`)
    .run(c.clinic_name, c.address, c.phone, c.email, c.license, c.logo_data_url, c.accent_color);
  return db;
}

// Логотип, который реально напечатается: тот же выбор, что у logoMark().
const printedLogo = (s) => s.logoUrl || s.logoDataUrl || null;

test('после смены в «Компании» PDF получает новые логотип и название, не копию из «Документов»', () => {
  const db = seed();
  const s = loadServerDocSettings(db);
  assert.equal(printedLogo(s), LOGO_NEW, 'печатается старый логотип из копии doc_branding');
  assert.equal(s.clinicName, 'Новая');
  // Оформление — по-прежнему дизайнера.
  assert.equal(s.fontPair, 'serif');
  assert.equal(s.footerNote, 'Подвал дизайнера');

  const html = buildSheetHtml({ type: 'conclusion', s, data: {} });
  assert.ok(html.includes(LOGO_NEW), 'в листе нет нового логотипа');
  assert.ok(!html.includes(LOGO_OLD), 'в листе остался старый логотип');
  assert.ok(html.includes('Новая'), 'в листе нет нового названия');
  assert.ok(!html.includes('Старая'), 'в листе осталось старое название');
  db.close();
});

test('старые заготовки поставщика в сохранённых «Документах» в PDF не попадают — как и на бумаге', () => {
  // Клиника сохраняла «Документы» давно: в копии телефон, почта и подвал
  // поставщика, прежний подзаголовок и английский язык бланка. В «Компании»
  // телефона и почты нет — пустое поле копию не стирает, поэтому чистка нужна
  // и серверу.
  const copy = { ...OLD_COPY, phone: LEGACY_DEFAULTS.phone, email: LEGACY_DEFAULTS.email,
    footerNote: LEGACY_DEFAULTS.footerNote, tagline: LEGACY_TAGLINE, language: 'en' };
  const db = seed({ copy, company: { phone: '', email: '' } });
  const s = loadServerDocSettings(db);
  assert.equal(s.phone, '');
  assert.equal(s.email, '');
  assert.equal(s.footerNote, '');
  assert.equal(s.tagline, '');
  assert.equal(s.language, 'ru');

  const html = buildSheetHtml({ type: 'conclusion', s, data: {} });
  for (const legacy of [LEGACY_DEFAULTS.phone, LEGACY_DEFAULTS.email, LEGACY_TAGLINE, 'Thank you for choosing our clinic']) {
    assert.ok(!html.includes(legacy), 'в PDF напечаталась заготовка поставщика: ' + legacy);
  }
  db.close();
});

test('оба пути идут через общий модуль: сервер и браузер дают ровно его результат', async () => {
  const copy = { ...OLD_COPY, phone: LEGACY_DEFAULTS.phone, tagline: LEGACY_TAGLINE, language: 'en', variant: { lab: 'compact' } };
  const db = seed({ copy, company: { phone: '' } });
  const clinic = getClinicBySlug(db);

  // Сервер: настройки для PDF — весь объект — это resolveDocSettings() его входа.
  assert.deepEqual(loadServerDocSettings(db), resolveDocSettings({ ...SERVER_DOC_BASE, ...copy }, clinic));

  // Браузер — ровно то, что нужно doc-settings.js при импорте.
  const store = new Map([['admin.lang', 'ru'], ['easymed:doc-settings:v1', JSON.stringify(copy)]]);
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
  globalThis.document = {
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), createTextNode: () => ({}),
    head: { appendChild() {} }, body: { appendChild() {}, children: [] }, documentElement: {},
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
  };
  globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; }, CLINIC: clinic };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: null }), headers: { getSetCookie: () => [] } });
  const { loadDocSettings, applyCompanyBranding, DEFAULT_DOC_SETTINGS } = await import('../../../public/js/admin/views/doc-settings.js?v=noqr1');

  // Печать в браузере: весь объект — resolveDocSettings() её входа.
  assert.deepEqual(loadDocSettings(), resolveDocSettings({ ...DEFAULT_DOC_SETTINGS, ...copy }, clinic));
  // Тумблер «Данные клиники из раздела «Компания»» в «Документах» — тот же overlay.
  assert.deepEqual(applyCompanyBranding({ ...copy }), overlayCompanyBranding({ ...copy }, clinic));
  globalThis.window.CLINIC = null;
  assert.deepEqual(applyCompanyBranding({ ...copy }), overlayCompanyBranding({ ...copy }, null));
  db.close();
});
