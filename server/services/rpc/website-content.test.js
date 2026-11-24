// WEBSITE_V1, этап 2 — содержимое сайта из редактора. Отделения, отзывы, FAQ,
// новости — перенос тестов Chilla (website-content.test.js); врачи и услуги —
// новые: у них нет своей публикации, только добавки, а метка «На сайте» — по
// тому же правилу, что у самого сайта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  websitePickLists, websiteContentList, websiteContentSave, websiteContentPublish,
  websiteContentDelete, websiteContentReorder,
} from './website-content.js';
import { makeSlug } from './website-slug.js';
import {
  publishedDoctors, publishedServices, publishedTestimonials, publishedFaq, departmentBySlug, invalidateContentCache,
} from '../../site/content.js';
import { seedDoctor, seedService } from '../../test-helpers/site-seed.js';
import { createSiteApp } from '../../site/app.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOC = { id: 2, role: 'doctor', extra_roles: [] };
const O = { hasModule: () => true };

function fresh() { invalidateContentCache(); const db = openDb(':memory:'); migrate(db); return db; }
function grant(db, role, lvl) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions || '{}') : {};
  perms.grants = { ...(perms.grants || {}), commerce_website: lvl };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const list = (db, kind, user = ADMIN) => websiteContentList(db, { kind }, user, O).rows;
const save = (db, kind, row, user = ADMIN) => websiteContentSave(db, { kind, row }, user, O);
const publish = (db, kind, id, published, user = ADMIN) => websiteContentPublish(db, { kind, id, published }, user, O);
const del = (db, kind, id) => websiteContentDelete(db, { kind, id }, ADMIN, O);
const reorder = (db, kind, ids) => websiteContentReorder(db, { kind, ids }, ADMIN, O);
const seedDepartment = (db, name = 'Тестовое отделение', active = 1) =>
  Number(db.prepare('INSERT INTO departments (name, active) VALUES (?, ?)').run(name, active).lastInsertRowid);

// ---------------------------------------------------------------------------
// Ворота

test('без модуля website — 402 module_missing у всех шести', () => {
  const db = fresh();
  const no = { hasModule: () => false };
  for (const fn of [
    () => websitePickLists(db, {}, ADMIN, no),
    () => websiteContentList(db, { kind: 'faq' }, ADMIN, no),
    () => websiteContentSave(db, { kind: 'faq', row: {} }, ADMIN, no),
    () => websiteContentPublish(db, { kind: 'faq', id: 1, published: 1 }, ADMIN, no),
    () => websiteContentDelete(db, { kind: 'faq', id: 1 }, ADMIN, no),
    () => websiteContentReorder(db, { kind: 'faq', ids: [] }, ADMIN, no),
  ]) assert.throws(fn, (e) => e.status === 402 && e.code === 'module_missing');
});

test('права: без строки — 403; «Просмотр» читает, но не пишет ни одним путём; «Изменение» пишет', () => {
  const db = fresh();
  assert.throws(() => list(db, 'doctors', DOC), (e) => e.status === 403);
  assert.throws(() => websitePickLists(db, {}, DOC, O), (e) => e.status === 403);
  grant(db, 'doctor', 'view');
  assert.ok(Array.isArray(list(db, 'faq', DOC)));
  assert.ok(Array.isArray(websitePickLists(db, {}, DOC, O).departments));
  const f = save(db, 'faq', { content: { ru: { q: 'A' } } });
  for (const fn of [
    () => save(db, 'faq', { content: { ru: { q: 'B' } } }, DOC),
    () => publish(db, 'faq', f.id, 1, DOC),
    () => websiteContentDelete(db, { kind: 'faq', id: f.id }, DOC, O),
    () => websiteContentReorder(db, { kind: 'faq', ids: [f.id] }, DOC, O),
  ]) assert.throws(fn, (e) => e.status === 403);
  assert.equal(list(db, 'faq').length, 1, 'просмотр ничего не записал');
  grant(db, 'doctor', 'edit');
  assert.ok(save(db, 'faq', { content: { ru: { q: 'B' } } }, DOC).id > 0);
});

test('неизвестный раздел — 400', () => {
  const db = fresh();
  assert.throws(() => list(db, 'bogus'), (e) => e.status === 400);
  assert.throws(() => list(db, '__proto__'), (e) => e.status === 400);
  assert.throws(() => save(db, 'bogus', {}), (e) => e.status === 400);
});

// ---------------------------------------------------------------------------
// Врачи — из профиля

test('врачи: список — все активные врачи, shown по правилу сайта, добавки рядом', () => {
  const db = fresh();
  const shown = seedDoctor(db, { ru: 'Алиев Шерзод', specialty: 'Кардиолог' });
  const hidden = seedDoctor(db, { ru: 'Скрытый Врач', shown: false });
  const fired = seedDoctor(db, { ru: 'Уволенный Врач', active: 0 });
  const rows = list(db, 'doctors');
  const ids = rows.map((r) => r.user_id);
  assert.ok(ids.includes(shown) && ids.includes(hidden));
  assert.ok(!ids.includes(fired), 'неактивный врач в редакторе не нужен');
  const a = rows.find((r) => r.user_id === shown);
  const b = rows.find((r) => r.user_id === hidden);
  assert.equal(a.shown, true); assert.equal(a.state, 'shown');
  assert.equal(b.shown, false); assert.equal(b.state, 'off', 'подсказка: включить «Публичный профиль»');
  assert.equal(a.full_name, 'Алиев Шерзод');
  assert.equal(a.specialty, 'Кардиолог');
  assert.deepEqual([a.featured, a.sort_order, a.has_extras], [0, 0, false]);
  assert.equal(rows[0].user_id, shown, 'показанные — первыми');
  // метка совпадает с тем, что реально отдаёт сайт
  assert.deepEqual(rows.filter((r) => r.shown).map((r) => r.id), publishedDoctors(db).map((d) => d.id));
});

test('врачи: добавки сохраняются частично и видны сайту сразу; delete сбрасывает их, врач остаётся', () => {
  const db = fresh();
  const id = seedDoctor(db, { ru: 'Алиев Шерзод' });
  assert.equal(publishedDoctors(db)[0].featured, 0);   // кэш сайта прогрет
  assert.deepEqual(save(db, 'doctors', { user_id: id, featured: true, sort_order: 5 }), { id });
  assert.equal(publishedDoctors(db)[0].featured, 1, 'сохранение сбросило кэш сайта');
  save(db, 'doctors', { user_id: id, sort_order: 2 });
  let r = list(db, 'doctors').find((x) => x.user_id === id);
  assert.deepEqual([r.featured, r.sort_order, r.has_extras], [1, 2, true], '«На главной» пережило правку порядка');
  del(db, 'doctors', id);
  r = list(db, 'doctors').find((x) => x.user_id === id);
  assert.deepEqual([r.featured, r.sort_order, r.has_extras], [0, 0, false]);
  assert.equal(publishedDoctors(db)[0].featured, 0, 'и сайт это видит');
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(id), 'сам врач не тронут');
});

test('врачи: отказы — чужой, неактивный, не врач; публикации у врача нет', () => {
  const db = fresh();
  assert.throws(() => save(db, 'doctors', { user_id: 999999 }), (e) => e.status === 400);
  assert.throws(() => save(db, 'doctors', {}), (e) => e.status === 400);
  const fired = seedDoctor(db, { ru: 'Уволенный', active: 0 });
  assert.throws(() => save(db, 'doctors', { user_id: fired, featured: 1 }), (e) => e.status === 400 && /неактив/i.test(e.message));
  assert.throws(() => save(db, 'doctors', { user_id: ADMIN.id, featured: 1 }), (e) => e.status === 400, 'администратор не врач');
  const id = seedDoctor(db, { ru: 'Врач' });
  assert.throws(() => publish(db, 'doctors', id, 1), (e) => e.status === 400 && /Публичн/.test(e.message));
});

test('врач, скрытый в профиле, не появляется на сайте от добавок («На главной» и порядок)', () => {
  const db = fresh();
  const hidden = seedDoctor(db, { ru: 'Скрытый Врач', shown: false });
  save(db, 'doctors', { user_id: hidden, featured: 1, sort_order: -100 });
  assert.equal(list(db, 'doctors').find((r) => r.user_id === hidden).shown, false);
  assert.equal(publishedDoctors(db).length, 0);
});

test('скрытый врач с featured=1 отсутствует на публичных страницах сайта', async () => {
  const db = fresh();
  const shown = seedDoctor(db, { ru: 'Алиев Шерзод', uz: 'Aliyev Sherzod' });
  const hidden = seedDoctor(db, { ru: 'Скрытый Врач', uz: 'Yashirin Shifokor' });
  db.prepare("UPDATE users SET is_public = 0 WHERE id = ?").run(hidden);
  save(db, 'doctors', { user_id: hidden, featured: 1, sort_order: -1 });
  save(db, 'doctors', { user_id: shown, featured: 1 });
  const server = await new Promise((resolve) => { const s = createSiteApp(db).listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of ['/ru/', '/ru/doctors', '/uz/', '/uz/doctors']) {
      const html = await (await fetch(base + p)).text();
      assert.ok(!html.includes('Скрытый Врач') && !html.includes('Yashirin Shifokor'), p + ': скрытый врач не показан');
    }
    assert.ok((await (await fetch(base + '/ru/doctors')).text()).includes('Алиев Шерзод'), 'показанный — на месте (тест не пустой)');
    const page = await fetch(base + `/ru/doctors/${hidden}-yashirin-shifokor`, { redirect: 'manual' });
    assert.equal(page.status, 404, 'и страницы врача тоже нет');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Услуги — из прайса

test('услуги: список — активные услуги, shown по servicePublicState, добавки с content', () => {
  const db = fresh();
  const shown = seedService(db, { ru: 'ЭКГ', uz: 'EKG', price: 50000 });
  const off = seedService(db, { ru: 'Секретная', uz: 'Maxfiy', shown: false });
  const noUz = seedService(db, { ru: 'Без узбекского' });
  db.prepare('UPDATE services SET online_booking = 1 WHERE id = ?').run(noUz);
  const rows = list(db, 'services');
  const by = (id) => rows.find((r) => r.service_id === id);
  assert.equal(by(shown).shown, true);
  assert.equal(by(off).state, 'off');
  assert.equal(by(noUz).state, 'no_uz');
  assert.deepEqual([by(shown).name, by(shown).name_uz, by(shown).price], ['ЭКГ', 'EKG', 50000]);
  assert.deepEqual(by(shown).content, {});
  assert.deepEqual(rows.filter((r) => r.shown).map((r) => r.id), publishedServices(db).map((s) => s.id));
});

test('услуги: добавки — фото, описание по языкам (мусор вычищен), частичное сохранение не стирает content', () => {
  const db = fresh();
  const id = seedService(db, { ru: 'ЭКГ', uz: 'EKG' });
  save(db, 'services', {
    service_id: id, featured: 1, image_path: 'services/ekg.jpg',
    content: { ru: { short_desc: 'Кардиограмма', body: 'Текст', preparation: 'Натощак', evil: { x: 1 } }, de: { short_desc: 'nein' } },
  });
  let r = list(db, 'services').find((x) => x.service_id === id);
  assert.deepEqual(r.content, { ru: { short_desc: 'Кардиограмма', body: 'Текст', preparation: 'Натощак' } });
  assert.equal(r.image_path, 'services/ekg.jpg');
  save(db, 'services', { service_id: id, featured: 0 });
  r = list(db, 'services').find((x) => x.service_id === id);
  assert.equal(r.featured, 0);
  assert.equal(r.content.ru.short_desc, 'Кардиограмма', 'без content в запросе описание не стёрто');
  const site = publishedServices(db).find((s) => s.id === id);
  assert.equal(JSON.parse(site.content).ru.short_desc, 'Кардиограмма', 'сайт видит описание сразу');
  assert.equal(site.image_path, 'services/ekg.jpg');
});

test('услуги: отказы — content не объект, фото не строка, отключённая услуга, публикации нет', () => {
  const db = fresh();
  const id = seedService(db, { ru: 'ЭКГ', uz: 'EKG' });
  assert.throws(() => save(db, 'services', { service_id: id, content: 'x' }), (e) => e.status === 400);
  assert.throws(() => save(db, 'services', { service_id: id, content: [1] }), (e) => e.status === 400);
  assert.throws(() => save(db, 'services', { service_id: id, image_path: { a: 1 } }), (e) => e.status === 400);
  db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
  assert.throws(() => save(db, 'services', { service_id: id, featured: 1 }), (e) => e.status === 400);
  assert.throws(() => publish(db, 'services', id, 1), (e) => e.status === 400);
});

test('скрытая услуга (флаг показа снят) от добавок на сайт не попадает', () => {
  const db = fresh();
  const id = seedService(db, { ru: 'Секретная', uz: 'Maxfiy', shown: false });
  save(db, 'services', { service_id: id, featured: 1, content: { ru: { short_desc: 'x' } } });
  assert.equal(publishedServices(db).some((s) => s.id === id), false);
});

test('порядок врачей и услуг: ids — user_id/service_id, добавка заводится, чужие id пропускаются', () => {
  const db = fresh();
  const a = seedDoctor(db, { ru: 'А' });
  const b = seedDoctor(db, { ru: 'Б' });
  reorder(db, 'doctors', [b, 999999, 'x', a]);
  const rows = list(db, 'doctors');
  assert.deepEqual(rows.map((r) => r.user_id), [b, a]);
  assert.deepEqual(publishedDoctors(db).map((d) => d.id), [b, a], 'сайт — в том же порядке');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM website_doctors').get().n, 2);
  const s1 = seedService(db, { ru: 'Один', uz: 'Bir' });
  const s2 = seedService(db, { ru: 'Два', uz: 'Ikki' });
  reorder(db, 'services', [s2, s1]);
  assert.deepEqual(publishedServices(db).filter((s) => [s1, s2].includes(s.id)).map((s) => s.id), [s2, s1]);
});

// ---------------------------------------------------------------------------
// Отделения, отзывы, FAQ, новости — как в Chilla

test('pick_lists: только активные отделения', () => {
  const db = fresh();
  const on = seedDepartment(db, 'Активное');
  const off = seedDepartment(db, 'Закрытое', 0);
  const ids = websitePickLists(db, {}, ADMIN, O).departments.map((d) => d.department_id);
  assert.ok(ids.includes(on));
  assert.ok(!ids.includes(off));
});

test('отделения: авто-слаг, коллизия -2, публикация видна сайту, повторное сохранение — та же строка', () => {
  const db = fresh();
  const d1 = seedDepartment(db, 'Кардиология 1');
  const d2 = seedDepartment(db, 'Кардиология 2');
  const a = save(db, 'departments', { department_id: d1, content: { ru: { name: 'Кардиология' } } });
  const b = save(db, 'departments', { department_id: d2, content: { ru: { name: 'Кардиология' } } });
  assert.deepEqual(list(db, 'departments').map((r) => r.slug).sort(), ['kardiologiya', 'kardiologiya-2']);
  assert.equal(departmentBySlug(db, 'kardiologiya'), undefined, 'ещё не опубликовано');
  publish(db, 'departments', a.id, true);
  assert.ok(departmentBySlug(db, 'kardiologiya'), 'публикация сбросила кэш');
  assert.equal(save(db, 'departments', { department_id: d2, image_path: 'dep.jpg' }).id, b.id);
  const row = list(db, 'departments').find((r) => r.id === b.id);
  assert.equal(row.slug, 'kardiologiya-2', 'без content слаг не пересчитан');
  assert.deepEqual(row.content, { ru: { name: 'Кардиология' } });
  const off = seedDepartment(db, 'Закрытое', 0);
  assert.throws(() => save(db, 'departments', { department_id: off }), (e) => e.status === 400);
  assert.throws(() => save(db, 'departments', { department_id: 999999 }), (e) => e.status === 400);
});

test('отзывы и FAQ: сохранение, публикация видна сайту; оценка вне 1..5 отклоняется; имя автора — строка', () => {
  const db = fresh();
  assert.throws(() => save(db, 'testimonials', { author_name: 'И', rating: 0, content: {} }), (e) => e.status === 400);
  assert.throws(() => save(db, 'testimonials', { author_name: 'И', rating: 6, content: {} }), (e) => e.status === 400);
  assert.throws(() => save(db, 'testimonials', { author_name: { x: 1 }, rating: 5 }), (e) => e.status === 400);
  const t = save(db, 'testimonials', { author_name: 42, rating: 5, content: { ru: { text: 'Отлично' } } });
  assert.equal(list(db, 'testimonials')[0].author_name, '42');
  assert.equal(publishedTestimonials(db).length, 0);
  publish(db, 'testimonials', t.id, true);
  assert.equal(publishedTestimonials(db).length, 1);
  const f = save(db, 'faq', { content: { ru: { q: 'Как записаться?', a: 'По телефону.' } } });
  publish(db, 'faq', f.id, true);
  assert.equal(JSON.parse(publishedFaq(db)[0].content).ru.q, 'Как записаться?');
  publish(db, 'faq', f.id, false);
  assert.equal(publishedFaq(db).length, 0, 'снятие тоже сбрасывает кэш');
  assert.throws(() => publish(db, 'faq', 999999, true), (e) => e.status === 400);
});

test('FAQ: reorder и delete', () => {
  const db = fresh();
  const a = save(db, 'faq', { content: { ru: { q: 'A' } } }).id;
  const b = save(db, 'faq', { content: { ru: { q: 'B' } } }).id;
  const c = save(db, 'faq', { content: { ru: { q: 'C' } } }).id;
  reorder(db, 'faq', [c, a, b]);
  assert.deepEqual(list(db, 'faq').map((r) => r.id), [c, a, b]);
  del(db, 'faq', a);
  assert.deepEqual(list(db, 'faq').map((r) => r.id), [c, b]);
  assert.throws(() => reorder(db, 'faq', 'nope'), (e) => e.status === 400);
});

test('новости: слаг из заголовка, published_at один раз, черновики в конце, reorder отклонён', () => {
  const db = fresh();
  const draft = save(db, 'posts', { content: { ru: { title: 'Черновик' } } }).id;
  const p = save(db, 'posts', { content: { ru: { title: 'Первая новость', excerpt: 'Кратко' } }, cover_path: 7 }).id;
  const row = (id) => list(db, 'posts').find((r) => r.id === id);
  assert.equal(row(p).slug, 'pervaya-novost');
  assert.equal(row(p).cover_path, '7');
  assert.equal(row(p).published_at, null);
  publish(db, 'posts', p, true);
  const first = row(p).published_at;
  assert.ok(first);
  publish(db, 'posts', p, false);
  publish(db, 'posts', p, true);
  assert.equal(row(p).published_at, first, 'дата выхода не переставляется');
  save(db, 'posts', { id: p, published: 1 });
  assert.equal(row(p).published_at, first);
  assert.deepEqual(list(db, 'posts').map((r) => r.id), [p, draft], 'черновик — в конце');
  assert.throws(() => reorder(db, 'posts', [p]), (e) => e.status === 400);
});

test('makeSlug: транслитерация RU/UZ-кириллицы', () => {
  assert.equal(makeSlug('Алиев Шерзод'), 'aliev-sherzod');
  assert.equal(makeSlug('Кардиология'), 'kardiologiya');
  assert.equal(makeSlug(''), '');
  assert.equal(makeSlug('  ---  '), '');
  assert.equal(makeSlug('Ўзбекистон қиши ғоят ҳашаматли'), 'ozbekiston-qishi-goyat-hashamatli');
});
