// BRANCH_PROFILE_V1 — /api/db и «Филиалы»: формат проверяется в любом здании;
// в филиале название, телефон, профиль, часы и показ на сайте любого здания не
// меняются (приезжают из главного, catalogue.js roster), новое здание не
// заводится; в главном адрес для партнёров, карта и телефон СВОЕГО здания —
// только в «Компании» (одно место на здание). Отказ — только если значение меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { becomeSecondary } from '../services/branch-sync/identity.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { BRANCH_MESSAGES } from '../../public/js/shared/branch-profile.js';
import { PROFILE_MESSAGES } from '../../public/js/shared/clinic-profile.js';
import { HOURS_MESSAGES, writeBranchHours, blankDays } from '../../public/js/shared/branch-hours.js';

async function startServer({ secondary = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE branches SET name = 'Главный корпус', name_uz = 'Bosh bino', phone = '+998712000000' WHERE letter = 'A'").run();
  if (secondary) becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  else db.prepare("INSERT INTO branches (name, letter) VALUES ('Чиланзар', 'C')").run();
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, stop() { server.close(); db.close(); } };
}
async function loginAs(base) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const post = (base, cookie, body) => fetch(base + '/api/db', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const idOf = (db, letter) => db.prepare('SELECT id FROM branches WHERE letter = ?').get(letter).id;
const update = (base, cookie, id, values) => post(base, cookie, { table: 'branches', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const WEEK_HOURS = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;

test('филиал: название, телефон, профиль, часы и показ любого здания — 409; база не тронута', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    for (const [letter, values] of [
      ['A', { name: 'Другое' }], ['A', { name_uz: 'Boshqa' }], ['C', { street_ru: 'ул. Новая, 1' }],
      ['C', { working_hours: WEEK_HOURS }], ['C', { is_24_7: true }], ['A', { show_public: 0 }],
      ['C', { maps_url: 'https://yandex.uz/maps/-/CDx' }], ['C', { phone: '+998901112233' }], ['C', { landmark_ru: 'у парка' }],
    ]) {
      const res = await update(t.base, cookie, idOf(t.db, letter), values);
      assert.equal(res.status, 409, letter + ' ' + JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.code, 'conflict');
      assert.equal(error.message, BRANCH_MESSAGES.mainOnly);
    }
    const a = t.db.prepare("SELECT * FROM branches WHERE letter = 'A'").get();
    const c = t.db.prepare("SELECT * FROM branches WHERE letter = 'C'").get();
    assert.deepEqual([a.name, a.name_uz, a.show_public, c.street_ru, c.working_hours, c.is_24_7, c.phone],
      ['Главный корпус', 'Bosh bino', 1, '', '{}', 0, '']);
  } finally { t.stop(); }
});

test('филиал: «работает» и прежний адрес сохраняются; неизменённое общее не мешает', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    const res = await update(t.base, cookie, c, { name: 'Чиланзар', is_24_7: false, phone: '', address: 'ул. Филиальная, 8', active: 1 });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(t.db.prepare('SELECT address FROM branches WHERE id = ?').get(c).address, 'ул. Филиальная, 8');
  } finally { t.stop(); }
});

test('филиал: новое здание не заводится; общее без отбора по одному id — 409', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    let res = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'Новый' } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, BRANCH_MESSAGES.newMainOnly);
    // Компилятор сам не пускает правку без выбора строк (400); отбор по
    // нескольким id он пускает — тогда отказывает этот страж.
    res = await post(t.base, cookie, { table: 'branches', op: 'update', values: { name_en: 'All' }, filters: [{ col: 'active', op: 'eq', val: 1 }] });
    assert.ok(res.status === 400 || res.status === 409, String(res.status));
    res = await post(t.base, cookie, { table: 'branches', op: 'update', values: { name_en: 'All' },
      filters: [{ col: 'id', op: 'in', val: [idOf(t.db, 'A'), idOf(t.db, 'C')] }] });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, BRANCH_MESSAGES.mainOnly);
    res = await post(t.base, cookie, { table: 'branches', op: 'update', values: { name_en: 'All' },
      filters: [{ col: 'id', op: 'eq', val: idOf(t.db, 'C') }, { col: 'active', op: 'eq', val: 1 }] });
    assert.equal(res.status, 409, 'отбор не только по id — что правится, не известно заранее');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM branches WHERE name_en = 'All'").get().n, 0);
  } finally { t.stop(); }
});

test('главное здание: правка нескольких зданий разом — отказ, только если среди них своё и его адрес меняется', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    t.db.prepare("INSERT INTO branches (name, letter) VALUES ('Юнусабад', 'D')").run();
    const [a, c, d] = ['A', 'C', 'D'].map((l) => idOf(t.db, l));
    const bulk = (ids, values) => post(t.base, cookie, { table: 'branches', op: 'update', values, filters: [{ col: 'id', op: 'in', val: ids }] });
    let res = await bulk([c, d], { phone: '+998901112233' });
    assert.equal(res.status, 200, 'своего здания среди них нет');
    res = await bulk([a, c], { phone: '+998901112233' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, BRANCH_MESSAGES.ownInCompany);
    assert.equal(t.db.prepare('SELECT phone FROM branches WHERE id = ?').get(a).phone, '+998712000000');
    res = await bulk([a, c], { show_public: 0 });
    assert.equal(res.status, 200, 'показ на сайте своего здания — в «Филиалах»');
  } finally { t.stop(); }
});

test('главное здание: чужое здание правится целиком; своё — без адреса, карты и телефона (они в «Компании»)', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    let res = await update(t.base, cookie, c, { name_en: 'Chilonzor branch', phone: '+998901112233', region_code: 'tashkent-city',
      street_ru: 'ул. Бунёдкор, 5', landmark_uz: 'Metro qarshisida', maps_url: 'https://yandex.uz/maps/-/CDc', show_public: 0,
      working_hours: WEEK_HOURS, is_24_7: 0 });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(Object.values(t.db.prepare('SELECT name_en, phone, show_public, working_hours FROM branches WHERE id = ?').get(c)),
      ['Chilonzor branch', '+998901112233', 0, WEEK_HOURS]);

    const a = idOf(t.db, 'A');
    for (const values of [{ street_ru: 'ул. Мира, 1' }, { phone: '+998900000000' }, { maps_url: 'https://yandex.uz/maps/-/CDa' }]) {
      res = await update(t.base, cookie, a, values);
      assert.equal(res.status, 409, JSON.stringify(values));
      assert.equal((await res.json()).error.message, BRANCH_MESSAGES.ownInCompany);
    }
    res = await update(t.base, cookie, a, { phone: '+998712000000', name_en: 'Main building', landmark_ru: 'У парка', working_hours: WEEK_HOURS });
    assert.equal(res.status, 200, 'телефон как был — не отказ; ориентир, названия и часы своего здания — здесь');
    res = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'Юнусабад', name_uz: 'Yunusobod', working_hours: '{}' } });
    assert.ok(res.ok, 'новое здание заводит главное');
  } finally { t.stop(); }
});

test('формат — в любом здании: чужая карта, старая форма часов, отметка 2, разметка в коде — 400 с объяснением', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    for (const [values, field, message] of [
      [{ maps_url: 'https://maps.google.com/x' }, 'maps_url', PROFILE_MESSAGES.maps],
      [{ working_hours: JSON.stringify({ mon: { enabled: true, from: '09:00', to: '18:00' } }) }, 'working_hours', HOURS_MESSAGES.stored],
      [{ show_public: 2 }, 'show_public', BRANCH_MESSAGES.flag],
      [{ district_code: '"><script>' }, 'district_code', BRANCH_MESSAGES.code],
    ]) {
      const res = await update(t.base, cookie, c, values);
      assert.equal(res.status, 400, JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.field, field);
      assert.equal(error.message, message);
    }
    const ins = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'X', maps_url: 'http://yandex.uz/maps' } });
    assert.equal(ins.status, 400, 'вставка проверяется так же');
  } finally { t.stop(); }
});
