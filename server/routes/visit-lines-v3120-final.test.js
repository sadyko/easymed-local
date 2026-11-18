// V3120_FINAL — строки визита у двери /api/db и визит дня (2026-09-28).
//
//   G1  неоплаченную строку не проводят в работу через «queued»; RELEASE_SELECT_V1 —
//       при части и долге в работу идёт только отмеченная кассиром строка;
//   G2  строку визита не заводят сразу в работе;
//   S2  строку в счёте и выданный товар табличным путём не удаляют; строку
//       без услуги/товара/вида приёма («свободная цена») не заводят;
//   G3  запись к одному врачу не переезжает под запись к другому.
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

const upd = (t, who, id, values) => t.dbq(who, { table: 'visit_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const statusOf = (t, id) => t.db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
function visit(t) {
  return t.db.prepare("INSERT INTO visits (patient_id, visit_date, status, doctor_id) VALUES (77, ?, 'arrived', 10)").run(at(D, 9)).lastInsertRowid;
}
function line(t, v, { svc = 40, price = 40000, status = 'added', doctor = null, item = null } = {}) {
  return t.db.prepare('INSERT INTO visit_services (visit_id, service_id, clinic_item_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,?,1,?,?,?)')
    .run(v, svc, item, doctor, price, price, status).lastInsertRowid;
}

// ─── G1 ─────────────────────────────────────────────────────────────────────

test('G1: неоплаченную строку нельзя провести через «queued» (added → queued → collected)', async () => {
  const t = await start();
  try {
    const v = visit(t);
    const unpaid = line(t, v);
    const q = await upd(t, 'lab', unpaid, { status: 'queued' });
    assert.equal(q.status, 409, JSON.stringify(q.json));
    assert.match(q.json.error.message, /не оплачен/);
    assert.equal(statusOf(t, unpaid), 'added');
    for (const st of ['no_show', 'done']) {
      assert.notEqual((await upd(t, 'reg', unpaid, { status: st })).status, 200, st);
    }
    assert.equal(statusOf(t, unpaid), 'added');
    assert.equal((await upd(t, 'reg', unpaid, { status: 'cancelled' })).status, 200, 'отмена неоплаченной строки');
  } finally { t.close(); }
});

test('G1: законные пути не закрыты — бесплатная, в счёте плательщика, отпущенная кассой при части и долге', async () => {
  const t = await start();
  try {
    const v = visit(t);
    const free = line(t, v, { svc: 41, price: 0 });
    assert.equal((await upd(t, 'lab', free, { status: 'queued' })).status, 200, 'бесплатная');

    t.db.prepare("INSERT INTO payers (id, name, active) VALUES (5, 'Страховая', 1)").run();
    const covered = line(t, v);
    const pay = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [covered], discount_amount: 0, payer_id: 5 });
    assert.equal(pay.status, 200, JSON.stringify(pay.json));
    assert.equal(statusOf(t, covered), 'queued', 'счёт плательщику сам ставит строку в очередь');
    assert.equal((await upd(t, 'lab', covered, { status: 'collected' })).status, 200);

    // RELEASE_SELECT_V1 — частичная оплата: в работу идёт отмеченная кассиром строка.
    const part = line(t, v);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [part], discount_amount: 0 });
    const p = await t.rpc('record_payment', 'boss', { invoice_id: inv.json.data.invoice.id, amount: 10000, method: 'cash', release_line_ids: [part] });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(statusOf(t, part), 'queued', 'отмеченная строка отпущена');
    assert.equal((await upd(t, 'lab', part, { status: 'collected' })).status, 200, 'частично оплаченный счёт, строка отмечена');

    const debt = line(t, v);
    const inv2 = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [debt], discount_amount: 0 });
    const d = await t.rpc('mark_invoice_debt', 'boss', { invoice_id: inv2.json.data.invoice.id, release_line_ids: [debt] });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal((await upd(t, 'lab', debt, { status: 'collected' })).status, 200, 'долг, строка отмечена');
  } finally { t.close(); }
});

// RELEASE_SELECT_V1 (3.25.0) — «частично = отпущено» больше нет: строка, которую
// касса не отметила при частичной оплате или долге, в работу не идёт — ни через
// «queued», ни сразу в «collected». Старый частично оплаченный счёт (до
// обновления) свои строки уже отпустил в 'queued' — они работают, как вчера.
test('G1 / RELEASE_SELECT_V1: неотмеченная строка частично оплаченного счёта и долга — в работу не идёт; старая отпущенная — идёт', async () => {
  const t = await start();
  try {
    const v = visit(t);
    const ticked = line(t, v, { svc: 30, price: 100000, doctor: 10 });
    const unticked = line(t, v);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [ticked, unticked], discount_amount: 0 });
    const invId = inv.json.data.invoice.id;
    const p = await t.rpc('record_payment', 'boss', { invoice_id: invId, amount: 100000, method: 'cash', release_line_ids: [ticked] });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.data.invoice.status, 'partial');
    assert.equal(statusOf(t, unticked), 'added');
    for (const st of ['queued', 'collected']) {
      const r = await upd(t, 'lab', unticked, { status: st });
      assert.equal(r.status, 409, st + ': ' + JSON.stringify(r.json));
      assert.match(r.json.error.message, /не оплачен/);
    }
    assert.equal(statusOf(t, unticked), 'added');
    assert.equal((await upd(t, 'boss', ticked, { status: 'in_progress' })).status, 200, 'отмеченная консультация начинается');

    const v2 = visit(t);
    const owed = line(t, v2);
    const inv2 = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v2, visit_service_ids: [owed], discount_amount: 0 });
    const d = await t.rpc('mark_invoice_debt', 'boss', { invoice_id: inv2.json.data.invoice.id, release_line_ids: [] });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal((await upd(t, 'lab', owed, { status: 'collected' })).status, 409, 'долг без отметки — пробу не берут');

    // Счёт 3.24: оплачен частично, строки уже отпущены.
    const old = line(t, v2);
    const inv3 = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v2, visit_service_ids: [old], discount_amount: 0 });
    t.db.prepare("UPDATE invoices SET status = 'partial', paid_amount = 10000 WHERE id = ?").run(inv3.json.data.invoice.id);
    t.db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = ?").run(old);
    assert.equal((await upd(t, 'lab', old, { status: 'collected' })).status, 200, 'старая отпущенная строка работает');
  } finally { t.close(); }
});

// ─── G2 ─────────────────────────────────────────────────────────────────────

test('G2: строку визита нельзя ЗАВЕСТИ сразу в работе; в смете — можно', async () => {
  const t = await start();
  try {
    const v = visit(t);
    for (const st of ['completed', 'queued', 'collected', 'in_progress']) {
      const r = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { visit_id: v, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: st } });
      assert.equal(r.status, 409, st + ': ' + JSON.stringify(r.json));
    }
    const up = await t.dbq('reg', { table: 'visit_services', op: 'upsert', values: { visit_id: v, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'completed' } });
    assert.notEqual(up.status, 200, 'upsert в работе');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v).n, 0);
    const ok = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { visit_id: v, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const plain = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { visit_id: v, service_id: 40, quantity: 1, unit_price: 40000, total: 40000 } });
    assert.equal(plain.status, 200, 'без статуса — в смете по умолчанию');
  } finally { t.close(); }
});

// ─── S2 ─────────────────────────────────────────────────────────────────────

test('S2: табличным путём не удаляют строку в счёте и выданный товар; «свободную» строку без услуги не заводят', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO products (id, name, sale_price, on_hand) VALUES (1,'Бинт',1000,10)").run();
    const v = visit(t);
    const goods = line(t, v, { svc: null, price: 1000, item: 1 });
    const billed = line(t, v);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [billed], discount_amount: 0 });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    const del = (who, id) => t.dbq(who, { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: id }] });
    for (const who of ['boss', 'reg']) {
      const a = await del(who, goods);
      assert.equal(a.status, 409, who + ' товар: ' + JSON.stringify(a.json));
      assert.match(a.json.error.message, /товар/);
      const b = await del(who, billed);
      assert.equal(b.status, 409, who + ' в счёте: ' + JSON.stringify(b.json));
      assert.match(b.json.error.message, /счёт/);
    }
    // Пакетное удаление по визиту (окно визита, visit_id + service_id) — тоже.
    const bulk = await t.dbq('reg', { table: 'visit_services', op: 'delete', filters: [{ col: 'visit_id', op: 'eq', val: v }, { col: 'service_id', op: 'eq', val: 40 }] });
    assert.equal(bulk.status, 409, JSON.stringify(bulk.json));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v).n, 2);
    // Вид приёма у выставленной строки не меняют.
    assert.equal((await upd(t, 'reg', billed, { consultation_type_id: null })).status, 409);
    // Заметка у выставленной — как прежде (документ строки без врача меняет администратор: DOC_HISTORY_V1).
    assert.equal((await upd(t, 'boss', billed, { notes: 'x' })).status, 200);
    // Невыставленную услугу снять можно, как прежде.
    const open = line(t, v, { svc: 30, price: 100000 });
    assert.equal((await del('reg', open)).status, 200);

    // Строка без услуги, без товара и без вида приёма — «свободная цена».
    for (const who of ['reg', 'doc']) {
      const r = await t.dbq(who, { table: 'visit_services', op: 'insert', values: { visit_id: v, quantity: 1, unit_price: 5, total: 5 } });
      assert.equal(r.status, 409, who + ': ' + JSON.stringify(r.json));
    }
  } finally { t.close(); }
});

// ─── G3 ─────────────────────────────────────────────────────────────────────

test('G3: запись колл-центра к Иванову в 10:00 не переезжает к Петрову в 14:00 — «добавьте в этот визит»', async () => {
  const t = await start();
  try {
    const first = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const vid = first.json.data.visit.id;
    // Строка Иванова в смете записи (как её заводит зеркало заявки / мастер).
    if (!t.db.prepare('SELECT 1 FROM visit_services WHERE visit_id = ?').get(vid)) {
      t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,30,10,1,100000,100000,'added')").run(vid);
    }

    const other = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 11, service_id: 30, start: at(D, 14), duration_minutes: 30 });
    assert.equal(other.status, 409, JSON.stringify(other.json));
    // REPEAT_VISIT_V1 (ревью, minor-2) — работы по записи нет (строка в смете), есть
    // запись к другому врачу: свой код и слова «уже есть запись к …», не «уже идёт работа».
    assert.equal(other.json.error.code, 'day_visit_other_doctor');
    const v = t.db.prepare('SELECT doctor_id, visit_date FROM visits WHERE id = ?').get(vid);
    assert.equal(v.doctor_id, 10, 'врач записи переписан');
    assert.equal(Date.parse(v.visit_date), Date.parse(at(D, 10)), 'время записи переписано');

    const ens = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(D, 14), doctor_id: 11,
      book: { doctor_id: 11, service_id: 30, start: at(D, 14), duration_minutes: 30 } });
    assert.equal(ens.status, 200, JSON.stringify(ens.json));
    assert.equal(ens.json.data.booked, false, 'ensure_visit перенёс чужую запись');
    assert.equal(ens.json.data.reason, 'day_visit_busy');
    assert.equal(t.db.prepare('SELECT doctor_id FROM visits WHERE id = ?').get(vid).doctor_id, 10);

    // Тот же врач — это перенос его же записи, как прежде.
    const same = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 15), duration_minutes: 30 });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    assert.equal(same.json.data.moved, true);
    assert.equal(same.json.data.visit.id, vid);
  } finally { t.close(); }
});
