// CLINIC_API_FIX_V1 — документы Telegram с ТЕКУЩИМИ логотипом и названием.
//
// doc_branding.settings — это копия, снятая в момент сохранения «Документов»:
// дизайнер хранит объект настроек целиком, вместе с тем, что подставила тогда
// «Компания» (clinicName, logoUrl, адрес…). Клиника потом меняет логотип и
// название в «Компании» (doc_settings), браузер печатает уже новые
// (applyCompanyBranding() кладёт их сверху), а PDF в Telegram брал старый
// логотип из копии: logoMark() предпочитает logoUrl, и копия его не отдавала.
//
// Проверяется то, что пациент получит: настройки, с которыми собирается PDF,
// и сам HTML листа.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getClinicBySlug } from '../rpc/clinic.js';
import { buildSheetHtml } from '../../../public/js/shared/doc-render.js';
import { loadServerDocSettings } from './render.js';

const LOGO_OLD = 'data:image/png;base64,T0xETE9HT0FBQQ==';      // A — копия в doc_branding
const LOGO_NEW = 'data:image/png;base64,TkVXTE9HT0JCQg==';      // B — нынешний в «Компании»
const LOGO_DESIGNER = 'data:image/png;base64,REVTSUdORVJE';     // свой логотип дизайнера

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
  assert.equal(s.address, 'Новый адрес');
  assert.equal(s.phone, '+998 71 111 11 11');
  assert.equal(s.email, 'new@clinic.uz');
  assert.equal(s.license, 'NEW-2');
  assert.equal(s.accent, '#2255aa');
  // Оформление — по-прежнему дизайнера.
  assert.equal(s.fontPair, 'serif');
  assert.equal(s.density, 'airy');
  assert.equal(s.footerNote, 'Подвал дизайнера');

  const html = buildSheetHtml({ type: 'conclusion', s, data: {} });
  assert.ok(html.includes(LOGO_NEW), 'в листе нет нового логотипа');
  assert.ok(!html.includes(LOGO_OLD), 'в листе остался старый логотип');
  assert.ok(html.includes('Новая'), 'в листе нет нового названия');
  assert.ok(!html.includes('Старая'), 'в листе осталось старое название');
  db.close();
});

test('свой логотип дизайнера — отдельное поле: копия логотипа «Компании» его не перекрывает', () => {
  // «Компания» без логотипа: печатается тот, что загрузили в «Документах»,
  // а не логотип, который был у «Компании» на момент сохранения.
  const db = seed({ copy: { ...OLD_COPY, logoDataUrl: LOGO_DESIGNER }, company: { logo_data_url: '' } });
  const s = loadServerDocSettings(db);
  assert.equal(printedLogo(s), LOGO_DESIGNER);
  db.close();

  // «Компания» с логотипом: печатается её логотип, а свой логотип дизайнера
  // не затирается — он вернётся, если логотип в «Компании» убрать.
  const db2 = seed({ copy: { ...OLD_COPY, logoDataUrl: LOGO_DESIGNER } });
  const s2 = loadServerDocSettings(db2);
  assert.equal(printedLogo(s2), LOGO_NEW);
  assert.equal(s2.logoDataUrl, LOGO_DESIGNER, 'логотип дизайнера затёрт логотипом «Компании»');
  db2.close();
});

test('ручной режим «Документов» (не из «Компании»): реквизиты дизайнера, как и при печати в браузере', () => {
  const copy = { ...OLD_COPY, useCompanyIdentity: false, clinicName: 'Своё имя', logoDataUrl: LOGO_DESIGNER };
  const db = seed({ copy });
  const s = loadServerDocSettings(db);
  assert.equal(s.clinicName, 'Своё имя');
  assert.equal(s.address, 'Старый адрес');
  assert.equal(printedLogo(s), LOGO_DESIGNER);
  db.close();
});

test('реквизиты сверху — ровно те, что кладёт applyCompanyBranding() в браузере', async () => {
  // Окружение браузера — ровно то, что нужно doc-settings.js при импорте.
  const store = new Map([['admin.lang', 'ru']]);
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
  globalThis.document = {
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), createTextNode: () => ({}),
    head: { appendChild() {} }, body: { appendChild() {}, children: [] }, documentElement: {},
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
  };
  globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: null }), headers: { getSetCookie: () => [] } });
  const { applyCompanyBranding } = await import('../../../public/js/admin/views/doc-settings.js?v=noqr1');

  const cases = [
    { copy: OLD_COPY, company: {} },
    { copy: { ...OLD_COPY, logoDataUrl: LOGO_DESIGNER }, company: { logo_data_url: '' } },
    { copy: OLD_COPY, company: { clinic_name: '', address: '', phone: '', email: '', license: '', accent_color: '' } },
    { copy: { ...OLD_COPY, useCompanyIdentity: false, logoDataUrl: LOGO_DESIGNER }, company: {} },
  ];
  const FIELDS = ['clinicName', 'address', 'phone', 'email', 'web', 'taxId', 'license', 'legalName', 'accent', 'logoUrl', 'logoDataUrl'];
  for (const [i, { copy, company }] of cases.entries()) {
    const db = seed({ copy, company });
    const server = loadServerDocSettings(db);
    globalThis.window.CLINIC = getClinicBySlug(db);
    // В браузере на вход applyCompanyBranding() идёт та же копия из doc_branding.
    const browser = applyCompanyBranding({ ...copy });
    for (const k of FIELDS) {
      assert.deepEqual(server[k] ?? null, browser[k] ?? null, `случай ${i + 1}: поле ${k} расходится с печатью в браузере`);
    }
    db.close();
  }
});
