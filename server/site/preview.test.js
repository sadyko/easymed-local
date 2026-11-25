// WEBSITE_PREVIEW_V1 — предпросмотр рисует несохранённое и ничего не пишет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedSite } from '../test-helpers/site-seed.js';
import { websitePreview } from '../services/rpc/website.js';
import { isReadOnlyRpc } from '../services/control/gate.js';
import { getSettings, invalidateContentCache } from './content.js';
import { previewBase, previewTokenOk, previewCss } from './preview.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const opt = { hasModule: () => true };
function fresh() { const db = openDb(':memory:'); migrate(db); const ids = seedSite(db); invalidateContentCache(); return { db, ids }; }
const html = (db, args) => websitePreview(db, args, ADMIN, opt).html;

test('несохранённый заголовок виден; настройки и кэш сайта не тронуты; база не изменилась', () => {
  const { db } = fresh();
  const before = db.prepare('SELECT total_changes() n').get().n;
  const out = html(db, { path: '/ru/', settings: { hero: { ru: { title: 'Черновик-777' } } } });
  assert.match(out, /Черновик-777/);
  assert.equal(getSettings(db).hero.ru.title, 'Здоровье');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.doesNotMatch(html(db, { path: '/ru/' }), /Черновик-777/);
});

test('код аналитики не исполняется ни из черновика, ни из сохранённого', () => {
  const { db } = fresh();
  db.prepare("UPDATE website_settings SET settings = json_set(settings, '$.analytics', json('{\"inject_snippet\":\"TRACK_SAVED\"}'))").run();
  assert.doesNotMatch(html(db, { path: '/ru/' }), /TRACK_SAVED/);
  assert.doesNotMatch(html(db, { path: '/ru/', settings: { analytics: { inject_snippet: 'TRACK_DRAFT' } } }), /TRACK_DRAFT/);
});

test('черновик карточки: новый вопрос, новая новость, правка отделения и описания услуги', () => {
  const { db, ids } = fresh();
  assert.match(html(db, { path: '/ru/faq', row: { kind: 'faq', row: { content: { ru: { q: 'Вопрос-Ч', a: 'Ответ-Ч' } } } } }), /Вопрос-Ч/);
  assert.match(html(db, { path: '/ru/news/draft', row: { kind: 'posts', row: { content: { ru: { title: 'Новость-Ч', body: 'т' } } } } }), /Новость-Ч/);
  const dep = html(db, { path: '/ru/departments/kardiologiya', row: { kind: 'departments', row: { department_id: ids.cardiology, slug: 'kardiologiya', content: { ru: { name: 'Отделение-Ч' } } } } });
  assert.match(dep, /Отделение-Ч/);
  assert.match(html(db, { path: '/ru/services/' + ids.s1, row: { kind: 'services', row: { service_id: ids.s1, content: { ru: { body: 'Описание-Ч' } } } } }), /Описание-Ч/);
});

test('неопубликованная новость и отделение со своим слагом открываются в предпросмотре', () => {
  const { db } = fresh();
  assert.match(html(db, { path: '/ru/news/svoya', row: { kind: 'posts', row: { id: 55, slug: 'svoya', content: { ru: { title: 'Скрытая-Ч' } } } } }), /Скрытая-Ч/);
  assert.match(html(db, { path: '/ru/departments/draft', row: { kind: 'departments', row: { department_id: 987, slug: '', content: { ru: { name: 'Новое-Ч' } } } } }), /Новое-Ч/);
});

test('черновик не показывает скрытую услугу', () => {
  const { db, ids } = fresh();
  assert.doesNotMatch(html(db, { path: '/ru/services/' + ids.s2, row: { kind: 'services', row: { service_id: ids.s2, content: { ru: { body: 'x' } } } } }), /Секретная услуга/);
});

test('каждая страница сайта рисуется; неизвестный адрес — 404 сайта', () => {
  const { db } = fresh();
  for (const p of ['', 'doctors', 'services', 'departments', 'news', 'about', 'contact', 'faq', 'privacy', 'terms', 'appointment', 'appointment/thanks']) {
    assert.match(html(db, { path: '/ru/' + p }), /<!doctype html>/i, p);
  }
  assert.match(html(db, { path: '/ru/constructor' }), /notfound/);
  assert.match(html(db, { path: '/ru/services/99999' }), /notfound/);
});

test('стили и шрифты — по адресу с ключом; чужой ключ не подходит', () => {
  const { db } = fresh();
  const out = html(db, { path: '/ru/' });
  assert.ok(out.includes(`href="${previewBase()}/assets/site.css"`));
  assert.ok(!/(src|href)="\/(assets|media)\//.test(out));
  assert.equal(previewCss("url('/assets/fonts/a.woff2')"), `url('${previewBase()}/assets/fonts/a.woff2')`);
  assert.equal(previewTokenOk(previewBase().split('/').pop()), true);
  assert.equal(previewTokenOk('x'), false);
  assert.equal(previewTokenOk(''), false);
});

test('права: без строки «Веб-сайт» — 403, без модуля — 402; чтение для ворот лицензии', () => {
  const { db } = fresh();
  assert.throws(() => websitePreview(db, {}, { id: 2, role: 'doctor', extra_roles: [] }, opt), (e) => e.status === 403);
  assert.throws(() => websitePreview(db, {}, ADMIN, { hasModule: () => false }), (e) => e.status === 402);
  assert.throws(() => websitePreview(db, { settings: [] }, ADMIN, opt), (e) => e.status === 400);
  assert.throws(() => websitePreview(db, { row: { kind: 'users', row: {} } }, ADMIN, opt), (e) => e.status === 400);
  assert.equal(isReadOnlyRpc('website_preview'), true);
});
