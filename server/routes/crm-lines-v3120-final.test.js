// V3120_FINAL — CRM (2026-09-28): строки заявок, делящие одну строку визита.
//
//   • строка регистратуры заменяет строку зеркала — на неё переходят ВСЕ ждущие
//     строки заявок, а не одна (вторая карточка иначе снималась);
//   • «Что спрашивают» считает общую строку визита двух карточек один раз.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
function localDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
const D = localDay(3);

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0);
  user.run(3, 'cc', hashPassword('password1'), 'Оператор', 'callcenter', 0);
  user.run(4, 'lab', hashPassword('password1'), 'Лаборант', 'lab', 0);
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1);
  user.run(11, 'doc2', hashPassword('password1'), 'Петров', 'doctor', 1);
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (30,'Консультация терапевта',100000,'consultation',1,30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (41,'Бесплатный скрининг',0,'lab',1)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент Тест','+998900000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cc', 'lab', 'doc']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const rpc = (name, who, args) => call('/api/rpc/' + name, who, args);
  const dbq = (who, desc) => call('/api/db', who, desc);
  return { db, server, rpc, dbq, close: () => { server.close(); db.close(); } };
}

/** Карточка колл-центра на консультацию у Иванова в день D, записанная из CRM. */
async function crmCard(t, { hh = 10 } = {}) {
  const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998900000077', patient_id: 77, status: 'in_process', source: 'call' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rid = r.json.data.id;
  const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: [
    { request_id: rid, service_id: 30, scheduled_date: D, doctor_id: 10, status: 'pending' },
  ] });
  assert.equal(ins.status, 200, JSON.stringify(ins.json));
  const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, hh), doctor_id: 10,
    book: { doctor_id: 10, service_id: 30, start: at(D, hh), duration_minutes: 30 } });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  return { rid, visitId: b.json.data.visit.id };
}

const pendingOf = (db) => db.prepare("SELECT id, request_id, status, visit_service_id FROM crm_request_services ORDER BY id").all();

test('CRM: строка регистратуры заменила строку зеркала — ВСЕ ждущие строки заявок переходят на неё, ни одна не снимается', async () => {
  const t = await start();
  try {
    const a = await crmCard(t);
    const b = await crmCard(t);
    assert.equal(b.visitId, a.visitId);
    const before = pendingOf(t.db);
    assert.equal(before.length, 2);
    assert.equal(before[0].visit_service_id, before[1].visit_service_id, 'обе карточки держат одну строку визита');

    // Регистратура в день приёма вставляет СВОЮ строку той же услуги.
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: a.visitId, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const own = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 30').all(a.visitId);
    assert.equal(own.length, 1, 'строка зеркала не уступила место');
    const after = pendingOf(t.db);
    for (const l of after) {
      assert.equal(l.status, 'pending', 'строка второй карточки снята');
      assert.equal(l.visit_service_id, own[0].id, 'строка второй карточки указывает на удалённую строку визита');
    }
    // Следующая сверка (любая правка визита) тоже ничего не снимает.
    await t.dbq('reg', { table: 'visit_services', op: 'update', values: { notes: 'x' }, filters: [{ col: 'id', op: 'eq', val: own[0].id }] });
    assert.deepEqual(pendingOf(t.db).map((l) => l.status), ['pending', 'pending']);
  } finally { t.close(); }
});

test('CRM: «Что спрашивают» считает общую строку визита двух карточек ОДИН раз', async () => {
  const t = await start();
  try {
    await crmCard(t);
    await crmCard(t);
    const r = await t.rpc('callcenter_report', 'boss', { from: localDay(-30), to: localDay(30) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const top = r.json.data.topServices.find((x) => x.name === 'Консультация терапевта');
    assert.ok(top, JSON.stringify(r.json.data.topServices));
    assert.equal(top.count, 1, 'одна консультация посчитана дважды');
  } finally { t.close(); }
});
