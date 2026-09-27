// V3120_FIX — разбор инспекции 3.12.0, раздел «Безопасность и доступ».
//
// Каждый тест — находка инспекции, повторённая настоящим HTTP-запросом через
// createApp (как её и нашли): /api/db и /api/rpc, живые сессии, база в памяти.
//
//   F1  деньги сотрудников (users) читал любой вошедший;
//   F2  врач удалял и переписывал любой документ визита (visit_documents);
//   M2  врача строки меняли на оплаченной строке / несуществующего / мимо RPC;
//   M3  visit_set_doctor_referrer ставил направившего по голому doctor_id;
//   M4  данные пациента читались ролями без раздела пациентов;
//   M9  массовая правка/удаление без отбора по id;
//   мелочи: подделка created_by/assigned_to заявки CRM, `true` вместо id,
//   500 на кривых дескрипторах, отказ триггера, middle_name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ids = {};
  for (const r of ROLES) {
    ids[r] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?)')
      .run(r, pw, 'Сотрудник ' + r, r, r === 'doctor' ? 1 : 0).lastInsertRowid);
  }
  ids.doctor2 = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,1)')
    .run('doctor2', pw, 'Второй Врач', 'doctor').lastInsertRowid);
  // Деньги второго врача — то, что не должен видеть никто, кроме своих.
  db.prepare(`UPDATE users SET salary_type='fix_plus_kpi', salary_fixed=5000000, salary_percent=12,
      service_rates=?, referral_rates=?, kpi_links=? WHERE id=?`)
    .run(JSON.stringify([{ service_id: 1, pct: 30, fix: 15000, price: 250000, branches: [] }]),
      JSON.stringify([{ service_id: 1, pct: 5 }]), JSON.stringify(['visits']), ids.doctor2);
  db.prepare(`UPDATE users SET salary_fixed=3000000, service_rates=? WHERE id=?`)
    .run(JSON.stringify([{ service_id: 1, pct: 20, branches: [] }]), ids.doctor);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, ids, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'login ' + who);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function post(base, cookie, url, body) {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const q = (ctx, cookie, desc) => post(ctx.base, cookie, '/api/db', desc);
const rpc = (ctx, cookie, name, args) => post(ctx.base, cookie, '/api/rpc/' + name, args);

async function withServer(t) {
  const ctx = await start();
  t.after(() => { ctx.server.close(); ctx.db.close(); });
  ctx.cookie = {};
  for (const r of [...ROLES, 'doctor2']) ctx.cookie[r] = await login(ctx.base, r);
  return ctx;
}

function seedVisit(db, { doctorId, invoiced = false, visitDate = '2026-09-20T09:00:00Z' } = {}) {
  const pid = Number(db.prepare("INSERT INTO patients (mrn, full_name, middle_name) VALUES (?,?,?)")
    .run('P-' + Math.random().toString(36).slice(2, 8), 'Каримов Азиз Бахтиёрович', 'Бахтиёрович').lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO services (name, price, requires_doctor) VALUES ('Приём',100000,1)").run().lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date) VALUES (?,?,?)').run(pid, doctorId, visitDate).lastInsertRowid);
  const vsid = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,100000,100000,'completed')")
    .run(vid, sid, doctorId).lastInsertRowid);
  if (invoiced) {
    const inv = Number(db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status)
      VALUES (?,?,?,100000,0,100000,100000,'paid')`).run('INV-' + vsid, vid, pid).lastInsertRowid);
    const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'Приём',1,100000,100000)")
      .run(inv, sid).lastInsertRowid);
    db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, vsid);
  }
  return { pid, sid, vid, vsid };
}

// ---------------------------------------------------------------------------
// F1 — деньги сотрудников.
// ---------------------------------------------------------------------------
test('F1: регистратура не видит оклад, процент и ставки чужого врача через /api/db users', async (t) => {
  const ctx = await withServer(t);
  const r = await q(ctx, ctx.cookie.registrar, { table: 'users', op: 'select', columns: '*', filters: [{ col: 'id', op: 'eq', val: ctx.ids.doctor2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = r.json.data[0];
  for (const c of ['salary_type', 'salary_fixed', 'salary_percent', 'referral_rates', 'kpi_links']) {
    assert.equal(u[c], null, c + ' должен прийти пустым');
  }
  // Кто какую услугу оказывает и по какой СВОЕЙ цене — это мастер записи, он
  // обязан работать. Процента и фиксированной оплаты там нет.
  assert.deepEqual(u.service_rates, [{ service_id: 1, branches: [], price: 250000 }]);
});

test('F1: врач видит СВОИ деньги, но не деньги коллеги', async (t) => {
  const ctx = await withServer(t);
  const r = await q(ctx, ctx.cookie.doctor, { table: 'users', op: 'select', columns: 'id,salary_fixed,service_rates', filters: [{ col: 'is_doctor', op: 'eq', val: 1 }], order: [{ col: 'id', asc: true }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const mine = r.json.data.find((x) => x.id === ctx.ids.doctor);
  const other = r.json.data.find((x) => x.id === ctx.ids.doctor2);
  assert.equal(mine.salary_fixed, 3000000);
  assert.deepEqual(mine.service_rates, [{ service_id: 1, pct: 20, branches: [] }]);
  assert.equal(other.salary_fixed, null);
  assert.deepEqual(other.service_rates, [{ service_id: 1, branches: [], price: 250000 }]);
});

test('F1: администратор видит всё', async (t) => {
  const ctx = await withServer(t);
  const r = await q(ctx, ctx.cookie.admin, { table: 'users', op: 'select', columns: 'id,salary_fixed,salary_percent,service_rates', filters: [{ col: 'id', op: 'eq', val: ctx.ids.doctor2 }] });
  assert.equal(r.json.data[0].salary_fixed, 5000000);
  assert.equal(r.json.data[0].service_rates[0].pct, 30);
});

test('F1: сортировка по скрытой колонке не работает как оракул (users, services)', async (t) => {
  const ctx = await withServer(t);
  const a = await q(ctx, ctx.cookie.registrar, { table: 'users', op: 'select', columns: 'id', order: [{ col: 'salary_fixed', asc: false }] });
  assert.equal(a.status, 400, JSON.stringify(a.json));
  const b = await q(ctx, ctx.cookie.registrar, { table: 'services', op: 'select', columns: 'id', order: [{ col: 'default_doctor_percent', asc: false }] });
  assert.equal(b.status, 400, JSON.stringify(b.json));
  // Администратору сортировать можно.
  const c = await q(ctx, ctx.cookie.admin, { table: 'users', op: 'select', columns: 'id', order: [{ col: 'salary_fixed', asc: false }] });
  assert.equal(c.status, 200);
});

// ---------------------------------------------------------------------------
// F2 — документы визита.
// ---------------------------------------------------------------------------
test('F2: врач не удаляет документ визита через /api/db', async (t) => {
  const ctx = await withServer(t);
  const { pid, vid, vsid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2 });
  const did = Number(ctx.db.prepare("INSERT INTO visit_documents (patient_id, visit_id, visit_service_id, doc_type, title, body, created_by) VALUES (?,?,?,'protocol','Протокол','{}',?)")
    .run(pid, vid, vsid, ctx.ids.doctor2).lastInsertRowid);
  const r = await q(ctx, ctx.cookie.doctor, { table: 'visit_documents', op: 'delete', filters: [{ col: 'id', op: 'eq', val: did }] });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.ok(ctx.db.prepare('SELECT 1 FROM visit_documents WHERE id = ?').get(did));
});

test('F2: врач не переписывает чужой или подписанный документ; свой черновик — может', async (t) => {
  const ctx = await withServer(t);
  const { pid, vid, vsid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2 });
  const ins = ctx.db.prepare("INSERT INTO visit_documents (patient_id, visit_id, visit_service_id, doc_type, title, body, created_by) VALUES (?,?,?,?,?,?,?)");
  const foreign = Number(ins.run(pid, vid, vsid, 'note', 'Чужая заметка', '{}', ctx.ids.doctor2).lastInsertRowid);
  const signed = Number(ins.run(pid, vid, vsid, 'protocol', 'Мой протокол', '{}', ctx.ids.doctor).lastInsertRowid);
  const draft = Number(ins.run(pid, vid, vsid, 'note', 'Мой черновик', '{}', ctx.ids.doctor).lastInsertRowid);
  for (const id of [foreign, signed, draft]) {
    await q(ctx, ctx.cookie.doctor, { table: 'visit_documents', op: 'update', values: { title: 'ПОДМЕНА' }, filters: [{ col: 'id', op: 'eq', val: id }] });
  }
  const title = (id) => ctx.db.prepare('SELECT title FROM visit_documents WHERE id = ?').get(id).title;
  assert.equal(title(foreign), 'Чужая заметка');
  assert.equal(title(signed), 'Мой протокол');
  assert.equal(title(draft), 'ПОДМЕНА');
});

test('F2: вставка документа подписывается сессией, а не телом запроса', async (t) => {
  const ctx = await withServer(t);
  const { pid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const r = await q(ctx, ctx.cookie.doctor, { table: 'visit_documents', op: 'insert', values: { patient_id: pid, doc_type: 'note', title: 'x', created_by: ctx.ids.doctor2 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = ctx.db.prepare('SELECT created_by FROM visit_documents ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.created_by, ctx.ids.doctor);
});

test('F2: повторная подпись в кабинете — RPC отзывает прежний протокол, а не стирает его', async (t) => {
  const ctx = await withServer(t);
  const { pid, vid, vsid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const first = await rpc(ctx, ctx.cookie.doctor, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'Протокол осмотра', body: { v: 1 } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const second = await rpc(ctx, ctx.cookie.doctor, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'Протокол осмотра', body: { v: 2 } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const rows = ctx.db.prepare('SELECT id, body, voided_at, voided_by, created_by, patient_id, visit_id FROM visit_documents WHERE visit_service_id = ? ORDER BY id').all(vsid);
  assert.equal(rows.length, 2, 'старый протокол остаётся строкой');
  assert.ok(rows[0].voided_at, 'старый отозван');
  assert.equal(rows[0].voided_by, ctx.ids.doctor);
  assert.equal(rows[1].voided_at, null);
  assert.equal(rows[1].created_by, ctx.ids.doctor);
  assert.equal(rows[1].patient_id, pid, 'пациент и визит берутся со строки услуги');
  assert.equal(rows[1].visit_id, vid);
  // /api/db отдаёт только действующий документ — архив не двоится.
  const list = await q(ctx, ctx.cookie.doctor, { table: 'visit_documents', op: 'select', columns: 'id,body', filters: [{ col: 'visit_service_id', op: 'eq', val: vsid }] });
  assert.equal(list.json.data.length, 1);
  assert.deepEqual(list.json.data[0].body, { v: 2 });
});

test('F2: чужую услугу врач не подписывает; лаборант — вовсе', async (t) => {
  const ctx = await withServer(t);
  const { vsid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2 });
  const a = await rpc(ctx, ctx.cookie.doctor, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'x', body: {} });
  assert.equal(a.status, 403, JSON.stringify(a.json));
  const b = await rpc(ctx, ctx.cookie.lab, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'x', body: {} });
  assert.equal(b.status, 403);
  const c = await rpc(ctx, ctx.cookie.doctor2, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'nonsense', title: 'x', body: {} });
  assert.equal(c.status, 400);
});

// ---------------------------------------------------------------------------
// M2 — врач строки услуги.
// ---------------------------------------------------------------------------
test('M2: /api/db больше не меняет врача строки услуги', async (t) => {
  const ctx = await withServer(t);
  const { vsid } = seedVisit(ctx.db, { doctorId: ctx.ids.doctor, invoiced: true });
  await q(ctx, ctx.cookie.registrar, { table: 'visit_services', op: 'update', values: { doctor_id: ctx.ids.doctor2 }, filters: [{ col: 'id', op: 'eq', val: vsid }] });
  assert.equal(ctx.db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(vsid).doctor_id, ctx.ids.doctor);
});

test('M2: patient_card_set_doctor — оплаченная строка, закрытый период, чужой человек', async (t) => {
  const ctx = await withServer(t);
  const paid = seedVisit(ctx.db, { doctorId: ctx.ids.doctor, invoiced: true });
  const r1 = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: paid.vsid, doctor_id: ctx.ids.doctor2 });
  assert.equal(r1.status, 409, JSON.stringify(r1.json));
  assert.equal(ctx.db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(paid.vsid).doctor_id, ctx.ids.doctor);

  const open = seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const r2 = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: open.vsid, doctor_id: 999999 });
  assert.equal(r2.status, 400, JSON.stringify(r2.json));
  assert.match(r2.json.error.message, /[А-Яа-я]/);
  const r3 = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: open.vsid, doctor_id: ctx.ids.cashier });
  assert.equal(r3.status, 400, 'кассир — не исполнитель услуги');
  ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ctx.ids.doctor2);
  const r4 = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: open.vsid, doctor_id: ctx.ids.doctor2 });
  assert.equal(r4.status, 400, 'уволенный врач — не исполнитель');
  ctx.db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(ctx.ids.doctor2);
  const ok = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: open.vsid, doctor_id: ctx.ids.doctor2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const closed = seedVisit(ctx.db, { doctorId: ctx.ids.doctor, visitDate: '2026-08-10T09:00:00Z' });
  ctx.db.prepare("INSERT INTO pay_periods (month) VALUES ('2026-08')").run();
  const r5 = await rpc(ctx, ctx.cookie.admin, 'patient_card_set_doctor', { visit_service_id: closed.vsid, doctor_id: ctx.ids.doctor2 });
  assert.equal(r5.status, 409, JSON.stringify(r5.json));
});

// ---------------------------------------------------------------------------
// M3 — «направивший врач» только по настоящей рекомендации.
// ---------------------------------------------------------------------------
test('M3: без открытой рекомендации врача направивший не ставится; кассир и колл-центр — не вправе', async (t) => {
  const ctx = await withServer(t);
  const v = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2 });
  const bare = await rpc(ctx, ctx.cookie.registrar, 'visit_set_doctor_referrer', { visit_id: v.vid, doctor_id: ctx.ids.doctor });
  assert.equal(bare.status, 409, JSON.stringify(bare.json));
  assert.equal(ctx.db.prepare('SELECT referral_source_id FROM visits WHERE id = ?').get(v.vid).referral_source_id, null);
  for (const who of ['cashier', 'callcenter']) {
    const r = await rpc(ctx, ctx.cookie[who], 'visit_set_doctor_referrer', { visit_id: v.vid, doctor_id: ctx.ids.doctor });
    assert.equal(r.status, 403, who);
  }
});

test('M3: по открытой рекомендации — ставится; врач называет только себя; оплаченный визит не трогается', async (t) => {
  const ctx = await withServer(t);
  const v = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2 });
  ctx.db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status) VALUES (?,?,?,'pending')")
    .run(v.pid, v.sid, ctx.ids.doctor);
  const other = await rpc(ctx, ctx.cookie.doctor2, 'visit_set_doctor_referrer', { visit_id: v.vid, doctor_id: ctx.ids.doctor });
  assert.equal(other.status, 403, 'врач не называет направившим коллегу');
  const ok = await rpc(ctx, ctx.cookie.registrar, 'visit_set_doctor_referrer', { visit_id: v.vid, doctor_id: ctx.ids.doctor });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data ? ok.json.data.set : ok.json.set, true);

  const paid = seedVisit(ctx.db, { doctorId: ctx.ids.doctor2, invoiced: true });
  ctx.db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status) VALUES (?,?,?,'pending')")
    .run(paid.pid, paid.sid, ctx.ids.doctor);
  const r = await rpc(ctx, ctx.cookie.registrar, 'visit_set_doctor_referrer', { visit_id: paid.vid, doctor_id: ctx.ids.doctor });
  assert.equal(r.status, 409, JSON.stringify(r.json));
});

// ---------------------------------------------------------------------------
// M4 — данные пациента по разделам.
// ---------------------------------------------------------------------------
test('M4: склад без раздела пациентов не читает пациентов, анализы, документы, счета, госпитализации', async (t) => {
  const ctx = await withServer(t);
  seedVisit(ctx.db, { doctorId: ctx.ids.doctor, invoiced: true });
  for (const table of ['patients', 'lab_results', 'visit_documents', 'patient_conditions', 'patient_vitals', 'payments', 'invoices', 'admissions']) {
    const r = await q(ctx, ctx.cookie.inventory, { table, op: 'select', columns: 'id', limit: 5 });
    assert.equal(r.status, 403, table + ': ' + JSON.stringify(r.json));
    assert.match(r.json.error.message, /[А-Яа-я]/);
  }
  // Через embed чужой таблицы — тоже нет.
  const e = await q(ctx, ctx.cookie.inventory, { table: 'visits', op: 'select', columns: 'id,patients(full_name)', limit: 5 });
  assert.equal(e.status, 403, JSON.stringify(e.json));
});

test('M4: законные экраны работают — лаборатория, касса, колл-центр, врач', async (t) => {
  const ctx = await withServer(t);
  seedVisit(ctx.db, { doctorId: ctx.ids.doctor, invoiced: true });
  const ok = async (who, table) => {
    const r = await q(ctx, ctx.cookie[who], { table, op: 'select', columns: 'id', limit: 5 });
    assert.equal(r.status, 200, who + ' / ' + table + ': ' + JSON.stringify(r.json));
  };
  await ok('lab', 'lab_results'); await ok('lab', 'patients');
  await ok('cashier', 'invoices'); await ok('cashier', 'payments'); await ok('cashier', 'patients');
  await ok('callcenter', 'patients');
  await ok('doctor', 'visit_documents'); await ok('doctor', 'patient_vitals'); await ok('doctor', 'admissions');
  await ok('nurse', 'admissions'); await ok('registrar', 'invoices');
});

test('M4: закрытая вкладка «Счёт» закрывает счета у роли, которой их даёт только раздел пациентов', async (t) => {
  const ctx = await withServer(t);
  seedVisit(ctx.db, { doctorId: ctx.ids.doctor, invoiced: true });
  const row = ctx.db.prepare("SELECT permissions FROM role_permissions WHERE role = 'lab'").get();
  const perms = JSON.parse(row.permissions);
  perms.patient_tabs = { billing: 'none', labs: 'none' };
  ctx.db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'lab'").run(JSON.stringify(perms));
  const inv = await q(ctx, ctx.cookie.lab, { table: 'invoices', op: 'select', columns: 'id' });
  assert.equal(inv.status, 403, JSON.stringify(inv.json));
  // Анализы лаборатории даёт её собственный раздел — вкладка их не отнимает.
  const lr = await q(ctx, ctx.cookie.lab, { table: 'lab_results', op: 'select', columns: 'id' });
  assert.equal(lr.status, 200);
});

// ---------------------------------------------------------------------------
// M9 — массовые правки.
// ---------------------------------------------------------------------------
test('M9: правка и удаление без отбора по id отвергаются (кроме разрешённых связок)', async (t) => {
  const ctx = await withServer(t);
  const v = seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const a = await q(ctx, ctx.cookie.registrar, { table: 'patients', op: 'update', values: { notes: 'X' }, filters: [{ col: 'active', op: 'eq', val: 1 }] });
  assert.equal(a.status, 400, JSON.stringify(a.json));
  assert.match(a.json.error.message, /[А-Яа-я]/);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM patients WHERE notes = 'X'").get().n, 0);
  const b = await q(ctx, ctx.cookie.admin, { table: 'visit_services', op: 'delete', filters: [{ col: 'status', op: 'eq', val: 'completed' }] });
  assert.equal(b.status, 400, JSON.stringify(b.json));
  // Окно визита снимает услугу парой (visit_id, service_id) — это законно.
  const c = await q(ctx, ctx.cookie.admin, { table: 'visit_services', op: 'delete', filters: [{ col: 'visit_id', op: 'eq', val: v.vid }, { col: 'service_id', op: 'eq', val: v.sid }] });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const d = await q(ctx, ctx.cookie.registrar, { table: 'patients', op: 'update', values: { notes: 'ok' }, filters: [{ col: 'id', op: 'eq', val: v.pid }] });
  assert.equal(d.status, 200);
  // Отбор только по «арендным» колонкам, которые отбрасываются, — тоже не отбор.
  const e = await q(ctx, ctx.cookie.registrar, { table: 'patients', op: 'update', values: { notes: 'Y' }, filters: [{ col: 'company_id', op: 'eq', val: 1 }] });
  assert.equal(e.status, 400, JSON.stringify(e.json));
});

// ---------------------------------------------------------------------------
// Мелочи.
// ---------------------------------------------------------------------------
test('CRM: created_by ставит сервер; оператор не назначает заявку другому', async (t) => {
  const ctx = await withServer(t);
  const a = await q(ctx, ctx.cookie.callcenter, { table: 'crm_requests', op: 'insert', values: { full_name: 'Лид', phone: '+998901112233', created_by: ctx.ids.admin } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(ctx.db.prepare('SELECT created_by FROM crm_requests ORDER BY id DESC LIMIT 1').get().created_by, ctx.ids.callcenter);
  const b = await q(ctx, ctx.cookie.callcenter, { table: 'crm_requests', op: 'insert', values: { full_name: 'Лид 2', assigned_to: ctx.ids.registrar } });
  assert.equal(b.status, 403, JSON.stringify(b.json));
  const c = await q(ctx, ctx.cookie.callcenter, { table: 'crm_requests', op: 'insert', values: { full_name: 'Лид 3', assigned_to: ctx.ids.callcenter } });
  assert.equal(c.status, 200, 'себе — можно');
  const id = ctx.db.prepare('SELECT id FROM crm_requests ORDER BY id DESC LIMIT 1').get().id;
  const d = await q(ctx, ctx.cookie.callcenter, { table: 'crm_requests', op: 'update', values: { assigned_to: ctx.ids.registrar }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(d.status, 403, JSON.stringify(d.json));
  const e = await q(ctx, ctx.cookie.admin, { table: 'crm_requests', op: 'update', values: { assigned_to: ctx.ids.registrar }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(e.status, 200, 'администратор передаёт заявку');
});

test('/api/db: кривые дескрипторы — 400, а не 500', async (t) => {
  const ctx = await withServer(t);
  const c = ctx.cookie.admin;
  const cases = [
    { table: 'patients', op: 'select', columns: 'id', filters: [null] },
    { table: 'patients', op: 'select', columns: 'id', filters: [{ or: [null] }] },
    { table: 'patients', op: 'select', columns: 'id', order: [null] },
    { table: 'patients', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: true }] },
    { table: 'patients', op: 'select', columns: 'id', filters: [{ col: 'full_name', op: 'contains', val: 'a'.repeat(60000) }] },
    { table: 'patients', op: 'upsert', values: { full_name: 'А', phone: '1' }, onConflict: 'phone' },
    { table: 'patients', op: 'delete', filters: [] },
  ];
  for (const d of cases) {
    const r = await q(ctx, c, d);
    assert.equal(r.status, 400, JSON.stringify(d).slice(0, 120) + ' → ' + r.status + ' ' + JSON.stringify(r.json));
  }
});

test('/api/db: неизвестная связь у таблицы без связей — отказ, а не 500', async (t) => {
  const ctx = await withServer(t);
  for (const d of [{ table: 'crm_tags', op: 'select', columns: 'key,unicorn(id)' },
    { table: 'crm_request_tags', op: 'select', columns: 'request_id,unicorn(id)' }]) {
    const r = await q(ctx, ctx.cookie.admin, d);
    assert.equal(r.status, 403, JSON.stringify(r.json));   // тот же ответ, что у любой неизвестной связи
  }
});

test('/api/db: сортировка с embed не двусмысленна', async (t) => {
  const ctx = await withServer(t);
  seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const r = await q(ctx, ctx.cookie.admin, { table: 'visits', op: 'select', columns: 'id,patients(id,full_name)', order: [{ col: 'created_at', asc: false }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('/api/db: отказ триггера доходит до человека его словами (409), а не «Query failed.»', async (t) => {
  const ctx = await withServer(t);
  const r = await q(ctx, ctx.cookie.admin, { table: 'cashback_rules', op: 'insert', values: { name: 'Много', percent: 150 } });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error.message, /Процент кэшбэка/);
});

test('/api/db: поиск дубля по отчеству работает', async (t) => {
  const ctx = await withServer(t);
  seedVisit(ctx.db, { doctorId: ctx.ids.doctor });
  const r = await q(ctx, ctx.cookie.registrar, { table: 'patients', op: 'select', columns: 'id,middle_name', filters: [{ col: 'middle_name', op: 'ilike', val: 'бахт%' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.length, 1);
});
