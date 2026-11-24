// WEBSITE_V1, этап 2 — настройки сайта: лицензия (402), строка прав «Веб-сайт»
// (просмотр читает, изменение пишет), проверки Chilla, «Сайт включён» и защита
// от потерянного обновления (перенос website-settings-lost-update.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { websiteSettingsGet, websiteSettingsSave, hasWebsiteModule } from './website.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { setDataDir } from '../control/config.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { getSettings } from '../../site/content.js';
import { createSiteController, registerSiteController } from '../../site/controller.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOC = { id: 2, role: 'doctor', extra_roles: [] };
const yes = () => true;
const opt = { hasModule: yes, refresh: () => 0 };

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
function grant(db, role, lvl) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions || '{}') : {};
  perms.grants = { ...(perms.grants || {}), commerce_website: lvl };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const get = (db, user = ADMIN) => websiteSettingsGet(db, {}, user, opt);
const save = (db, settings, extra = {}, user = ADMIN, o = opt) => websiteSettingsSave(db, { settings, ...extra }, user, o);

test('без модуля website — 402 module_missing на чтении и записи, даже у администратора', () => {
  const db = fresh();
  for (const fn of [() => websiteSettingsGet(db, {}, ADMIN, { hasModule: () => false }),
    () => websiteSettingsSave(db, { settings: {} }, ADMIN, { hasModule: () => false, refresh: () => 0 })]) {
    assert.throws(fn, (e) => e.status === 402 && e.code === 'module_missing' && /Веб-сайт/.test(e.message));
  }
});

test('модуль берётся из лицензии клиники (по умолчанию, через getRpc)', () => {
  const db = fresh();
  setDataDir(licensedDataDir({ modules: [] }));
  assert.equal(hasWebsiteModule(db), false);
  assert.throws(() => getRpc('website_settings_get')(db, {}, ADMIN), (e) => e.status === 402);
  setDataDir(licensedDataDir({ modules: ['website'] }));
  assert.equal(hasWebsiteModule(db), true);
  assert.deepEqual(getRpc('website_settings_get')(db, {}, ADMIN).settings, {});
});

test('права: без строки — только администратор; «Просмотр» читает и не пишет; «Изменение» пишет', () => {
  const db = fresh();
  assert.throws(() => get(db, DOC), (e) => e.status === 403 && /Веб-сайт/.test(e.message));
  grant(db, 'doctor', 'view');
  assert.deepEqual(get(db, DOC).settings, {});
  assert.throws(() => save(db, { default_lang: 'ru' }, {}, DOC), (e) => e.status === 403 && /Просмотр/.test(e.message));
  grant(db, 'doctor', 'edit');
  save(db, { default_lang: 'ru' }, {}, DOC);
  assert.equal(get(db, DOC).settings.default_lang, 'ru');
  assert.equal(get(db).settings.default_lang, 'ru', 'администратор без строки видит всё');
  grant(db, 'doctor', 'none');
  assert.throws(() => get(db, DOC), (e) => e.status === 403);
});

test('чтения — в READ_ONLY_RPCS (клиника с истёкшей лицензией смотрит), запись — нет; всё зарегистрировано', () => {
  for (const n of ['website_settings_get', 'website_content_list', 'website_pick_lists']) {
    assert.equal(isReadOnlyRpc(n), true, n);
    assert.ok(getRpc(n), n);
  }
  for (const n of ['website_settings_save', 'website_content_save', 'website_content_publish', 'website_content_delete', 'website_content_reorder']) {
    assert.equal(isReadOnlyRpc(n), false, n);
    assert.ok(getRpc(n), n);
  }
});

test('get отдаёт settings, updated_at и состояние слушателя site', () => {
  const db = fresh();
  registerSiteController(null);
  const out = get(db);
  assert.deepEqual(out.settings, {});
  assert.ok(out.updated_at);
  assert.deepEqual(out.site, { running: false, port: 0 });
});

test('проверки Chilla: не объект, чужой язык, default_lang вне langs', () => {
  const db = fresh();
  assert.throws(() => save(db, 'not an object'), (e) => e.status === 400);
  assert.throws(() => save(db, ['x']), (e) => e.status === 400);
  assert.throws(() => save(db, { default_lang: 'de' }), (e) => e.status === 400);
  assert.throws(() => save(db, { langs: ['uz', 'xx'] }), (e) => e.status === 400);
  assert.throws(() => save(db, { langs: 'uz' }), (e) => e.status === 400);
  assert.throws(() => save(db, { default_lang: 'uz', langs: ['ru', 'en'] }), (e) => e.status === 400 && /включённых/.test(e.message));
  save(db, { default_lang: 'ru', langs: ['ru', 'en'] });
  assert.throws(() => save(db, { big: 'x'.repeat(70 * 1024) }), (e) => e.status === 400 && /64/.test(e.message));
});

test('«Сайт включён» — только настоящий true/false', () => {
  const db = fresh();
  for (const bad of ['true', 'false', 1, 0, null, {}]) {
    assert.throws(() => save(db, { enabled: bad }), (e) => e.status === 400, String(bad));
  }
  save(db, { enabled: true });
  assert.equal(get(db).settings.enabled, true);
  save(db, { enabled: false });
  assert.equal(get(db).settings.enabled, false);
});

test('сохранение сбрасывает кэш сайта и пересчитывает слушатель', () => {
  const db = fresh();
  assert.equal(getSettings(db).hero.ru, undefined);   // кэш прогрет
  let refreshed = 0;
  save(db, { hero: { ru: { title: 'Здоровье' } } }, {}, ADMIN, { hasModule: yes, refresh: () => { refreshed += 1; } });
  assert.equal(getSettings(db).hero.ru.title, 'Здоровье', 'сайт видит правку сразу, а не через 30 с');
  assert.equal(refreshed, 1);
  // сломанный слушатель не ломает сохранение
  const out = save(db, { x: 1 }, {}, ADMIN, { hasModule: yes, refresh: () => { throw new Error('EADDRINUSE'); } });
  assert.equal(out.ok, true);
});

test('сохранение enabled поднимает и закрывает слушатель без перезапуска (настоящий реестр)', () => {
  const db = fresh();
  const opened = [];
  const fake = () => { const s = { closed: false, close() { s.closed = true; }, on() { return s; } }; opened.push(s); return s; };
  registerSiteController(createSiteController(db, { env: {}, hasModule: yes, listen: fake }));
  try {
    const on = websiteSettingsSave(db, { settings: { enabled: true } }, ADMIN, { hasModule: yes });
    assert.deepEqual(on.site, { running: true, port: 8001 });
    assert.equal(opened.length, 1);
    assert.deepEqual(get(db).site, { running: true, port: 8001 });
    const off = websiteSettingsSave(db, { settings: { enabled: false } }, ADMIN, { hasModule: yes });
    assert.deepEqual(off.site, { running: false, port: 0 });
    assert.equal(opened[0].closed, true);
  } finally { registerSiteController(null); }
});

// ---- Chilla WEBSITE_SETTINGS_LOST_UPDATE_V1 -------------------------------

test('lost update: сохранение со свежим updated_at проходит и возвращает новый', () => {
  const db = fresh();
  const before = get(db);
  const out = save(db, { clinic_name: 'Novo Medics' }, { prev_updated_at: before.updated_at });
  assert.equal(get(db).settings.clinic_name, 'Novo Medics');
  assert.equal(out.updated_at, get(db).updated_at, 'экран держит эту версию для следующего сохранения');
});

test('lost update: устаревшая вкладка НЕ затирает то, что записали после неё', () => {
  const db = fresh();
  const stale = get(db).updated_at;
  save(db, { clinic_name: 'Novo Medics', hero: { ru: { title: 'Забота' } } });
  assert.throws(() => save(db, { hero: { ru: {} } }, { prev_updated_at: stale }), (e) => e.status === 409 && /Обновите/.test(e.message));
  const now = get(db).settings;
  assert.equal(now.hero.ru.title, 'Забота');
  assert.equal(now.clinic_name, 'Novo Medics');
});

test('lost update: после отказа перечитал — сохранил; без версии, с пустой и null — как раньше', () => {
  const db = fresh();
  const stale = get(db).updated_at;
  save(db, { clinic_name: 'A' });
  assert.throws(() => save(db, { clinic_name: 'B' }, { prev_updated_at: stale }), (e) => e.status === 409);
  save(db, { clinic_name: 'B' }, { prev_updated_at: get(db).updated_at });
  assert.equal(get(db).settings.clinic_name, 'B');
  save(db, { clinic_name: 'C' });
  save(db, { clinic_name: 'D' }, { prev_updated_at: '' });
  save(db, { clinic_name: 'E' }, { prev_updated_at: null });
  assert.equal(get(db).settings.clinic_name, 'E');
});

test('lost update: отказ не меняет ни настройки, ни updated_at', () => {
  const db = fresh();
  save(db, { clinic_name: 'A' });
  const state = get(db);
  assert.throws(() => save(db, { clinic_name: 'Z' }, { prev_updated_at: '2000-01-01T00:00:00Z' }), (e) => e.status === 409);
  const after = get(db);
  assert.equal(after.settings.clinic_name, 'A');
  assert.equal(after.updated_at, state.updated_at);
});
