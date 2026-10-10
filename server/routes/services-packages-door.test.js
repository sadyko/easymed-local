// SERVICES_PACKAGES_V1 — ДВЕРЬ /api/db: ПАКЕТ И ПОКАЗ УСЛУГИ.
//
// Пакет (service_templates с is_package = 1) пишется теми же правилами, что у
// окна «Пакет услуг» (shared/package-price.js packageProblem): название на
// русском, хотя бы одна услуга, способ и величина скидки, даты, показ — только
// с названием на узбекском. Шаблон сметы (is_package = 0, «Сохранить как
// шаблон» регистратуры) — как прежде, без этих проверок.
// Показ услуги на сайте и у партнёров (services.online_booking) — только с
// названием на русском и узбекском, в какую бы дверь ни писали (прежде правило
// держали только окно услуги, service_save и импорт Excel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { PACKAGE_MESSAGES } from '../../public/js/shared/package-price.js';
import { SERVICE_PUBLIC_MESSAGES } from '../../public/js/shared/service-public.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'adm', hashPassword('password1'), 'Администратор', 'admin');
  u.run(2, 'reg', hashPassword('password1'), 'Регистратор', 'registrar');
  db.prepare("INSERT INTO services (id, name, name_uz, price, type) VALUES (1,'УЗИ','UTT',100000,'imaging'), (2,'Анализ',NULL,50000,'lab')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const call = async (base, cookie, desc) => {
  const res = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(desc) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const PKG = { name: 'Check-up', service_ids: [1, 2], is_package: 1, discount_mode: 'percent', discount_value: 15 };

test('пакет: правила окна — отказ 400 с полем, ничего не записано; годный ложится', async () => {
  const { db, server, base } = await startServer();
  try {
    const c = await login(base, 'adm');
    const ins = (values) => call(base, c, { table: 'service_templates', op: 'insert', values });
    for (const [values, field, message] of [
      [{ ...PKG, name: ' ' }, 'name', PACKAGE_MESSAGES.nameRu],
      [{ ...PKG, service_ids: [] }, 'service_ids', PACKAGE_MESSAGES.services],
      [{ ...PKG, service_ids: [1, 1] }, 'service_ids', PACKAGE_MESSAGES.serviceId],
      [{ ...PKG, discount_mode: 'amount', discount_value: 150001 }, 'discount_value', PACKAGE_MESSAGES.amount],
      [{ ...PKG, discount_mode: 'price', discount_value: 150001 }, 'discount_value', PACKAGE_MESSAGES.price],
      [{ ...PKG, valid_from: '2026-10-10', valid_until: '2026-10-01' }, 'valid_until', PACKAGE_MESSAGES.dates],
      [{ ...PKG, show_public: 1 }, 'name_uz', PACKAGE_MESSAGES.publishUz],
    ]) {
      const r = await ins(values);
      assert.equal(r.status, 400, JSON.stringify(values));
      assert.deepEqual([r.body.error.field, r.body.error.message], [field, message]);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM service_templates').get().n, 0);
    assert.equal((await ins({ ...PKG, discount_mode: 'price', discount_value: 150000, show_public: 1, name_uz: 'Check-up' })).status, 200);
  } finally { server.close(); db.close(); }
});

test('пакет: правка — проверяется тронутое; переименование не упирается в прежний показ; снять показ и с учёта — можно', async () => {
  const { db, server, base } = await startServer();
  try {
    const c = await login(base, 'adm');
    const id = db.prepare(`INSERT INTO service_templates (name, service_ids, is_package, discount_mode, discount_value, show_public, name_uz)
                           VALUES ('Check-up', '[1,2]', 1, 'percent', 15, 1, 'Check-up')`).run().lastInsertRowid;
    const upd = (values) => call(base, c, { table: 'service_templates', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    let r = await upd({ name_uz: '' });
    assert.deepEqual([r.status, r.body.error.message], [400, PACKAGE_MESSAGES.publishUz], 'стереть узбекское у показанного пакета нельзя');
    r = await upd({ discount_mode: 'amount', discount_value: 200000 });
    assert.deepEqual([r.status, r.body.error.message], [400, PACKAGE_MESSAGES.amount]);
    assert.equal((await upd({ name: 'Check-up базовый' })).status, 200);
    assert.equal((await upd({ show_public: 0, name_uz: '' })).status, 200, 'снять показ вместе с названием — можно');
    assert.equal((await upd({ active: 0 })).status, 200);
  } finally { server.close(); db.close(); }
});

test('шаблон сметы регистратуры — как прежде: без проверок пакета; отметку пакета регистратура не ставит', async () => {
  const { db, server, base } = await startServer();
  try {
    const c = await login(base, 'reg');
    const r = await call(base, c, { table: 'service_templates', op: 'insert', values: { name: 'Смета', service_ids: [1, 2], active: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.prepare('SELECT is_package FROM service_templates').get().is_package, 0);
    const sneak = await call(base, c, { table: 'service_templates', op: 'insert', values: { name: 'Пакет', service_ids: [1], is_package: 1 } });
    assert.equal(sneak.status, 403);
  } finally { server.close(); db.close(); }
});

test('показ услуги: без названия на узбекском не включить ни вставкой, ни правкой; стереть узбекское у показанной — нельзя', async () => {
  const { db, server, base } = await startServer();
  try {
    const c = await login(base, 'adm');
    const upd = (id, values) => call(base, c, { table: 'services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    let r = await upd(2, { online_booking: 1 });
    assert.deepEqual([r.status, r.body.error.field, r.body.error.message], [400, 'name_uz', SERVICE_PUBLIC_MESSAGES.online]);
    r = await call(base, c, { table: 'services', op: 'insert', values: { name: 'ЭКГ', price: 60000, type: 'imaging', online_booking: 1 } });
    assert.equal(r.status, 400);
    assert.equal((await upd(2, { online_booking: 1, name_uz: 'Tahlil' })).status, 200);
    r = await upd(2, { name_uz: ' ' });
    assert.equal(r.status, 400, 'показанная услуга без узбекского названия');
    assert.equal((await upd(1, { price: 110000 })).status, 200, 'правка, не касающаяся показа, — без проверки');
    assert.equal(db.prepare('SELECT online_booking FROM services WHERE id = 2').get().online_booking, 1);
  } finally { server.close(); db.close(); }
});
