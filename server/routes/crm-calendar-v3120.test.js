// V3120_FIX (2026-09-27) — CRM, календарь, очередь: находки инспекции 3.12.0.
//
// Всё через НАСТОЯЩИЕ двери (/api/db и /api/rpc под настоящими ролями), как в
// crm-calendar-mirror.test.js: правило, проверенное на функции, ничего не
// говорит о том, соблюдает ли его дверь.
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
const consultLines = (db, visitId) => db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = 30').all(visitId);

test('MAJOR: вторая карточка на ту же консультацию у того же врача — одна строка визита и счёт 100 000, а не 200 000', async () => {
  const t = await start();
  try {
    const a = await crmCard(t);
    const b = await crmCard(t);
    assert.equal(b.visitId, a.visitId, 'второй визит на тот же день');
    assert.equal(consultLines(t.db, a.visitId).length, 1, 'вторая карточка завела вторую консультацию в запись');
    const linked = t.db.prepare("SELECT request_id, visit_service_id FROM crm_request_services WHERE status = 'pending' ORDER BY id").all();
    assert.equal(linked.length, 2);
    assert.equal(linked[0].visit_service_id, linked[1].visit_service_id, 'обе строки заявок держат одну строку визита');

    // Слияние дублей: у оставшейся карточки — одна ждущая строка.
    const m = await t.rpc('crm_merge_leads', 'boss', { keep_id: a.rid, merge_ids: [b.rid] });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const left = t.db.prepare("SELECT * FROM crm_request_services WHERE request_id = ? AND status = 'pending'").all(a.rid);
    assert.equal(left.length, 1, 'после слияния у карточки две одинаковые строки');
    assert.equal(consultLines(t.db, a.visitId).length, 1, 'слияние сняло или удвоило строку визита');

    // Касса: счёт по всем строкам записи — одна консультация.
    const ids = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ?').all(a.visitId).map((r) => r.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: a.visitId, visit_service_ids: ids, discount_amount: 0 });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    assert.equal(Number(inv.json.data.invoice.total_amount), 100000);
  } finally { t.close(); }
});

test('MAJOR: слияние двух карточек, каждая со СВОЕЙ строкой визита (до исправления), — дубль снимается', async () => {
  const t = await start();
  try {
    const a = await crmCard(t);
    // Состояние, оставленное прежней версией: вторая карточка со своей строкой визита.
    const r2 = t.db.prepare("INSERT INTO crm_requests (full_name, phone, patient_id, status, source) VALUES ('Пациент Тест','+998900000077',77,'scheduled','call')").run().lastInsertRowid;
    const vs2 = t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,30,10,1,100000,100000,'added')").run(a.visitId).lastInsertRowid;
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto) VALUES (?,30,10,?,'pending',?,?,1)").run(r2, D, a.visitId, vs2);
    assert.equal(consultLines(t.db, a.visitId).length, 2);
    const m = await t.rpc('crm_merge_leads', 'boss', { keep_id: a.rid, merge_ids: [r2] });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(consultLines(t.db, a.visitId).length, 1, 'двойная консультация пережила слияние');
  } finally { t.close(); }
});

test('MAJOR: calendar_book без visit_id не заводит второй живой визит на день', async () => {
  const t = await start();
  try {
    // Пустая запись дня (без работы) — перенос, а не второй визит.
    const first = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 9), duration_minutes: 30 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 11, service_id: 30, start: at(D, 15), duration_minutes: 30 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.data.visit.id, first.json.data.visit.id, 'заведён второй визит вместо переноса');
    assert.equal(again.json.data.moved, true);
    assert.equal(again.json.data.visit.doctor_id, 11);
    const live = () => t.db.prepare("SELECT COUNT(*) n FROM visits WHERE patient_id = 77 AND status NOT IN ('cancelled','no_show')").get().n;
    assert.equal(live(), 1);

    // Визит с работой (счёт) — отказ словами, с кодом и параметрами.
    const vs = t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,30,11,1,100000,100000,'added')").run(first.json.data.visit.id).lastInsertRowid;
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: first.json.data.visit.id, visit_service_ids: [vs], discount_amount: 0 });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    const busy = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 17), duration_minutes: 30 });
    assert.equal(busy.status, 409, JSON.stringify(busy.json));
    assert.equal(busy.json.error.code, 'day_visit_busy');
    assert.match(busy.json.error.message, /уже есть визит.*добавьте услугу в этот визит/);
    assert.equal(busy.json.error.params.visit_id, first.json.data.visit.id);
    assert.equal(live(), 1);

    // Согласие «добавить в этот визит» — ответом сам визит дня, без правок.
    const add = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 17), duration_minutes: 30, add_to_day_visit: true });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.equal(add.json.data.visit.id, first.json.data.visit.id);
    assert.equal(add.json.data.added_to_day_visit, true);
    assert.equal(live(), 1);

    // Другой день — обычная новая запись.
    const other = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(localDay(5), 9), duration_minutes: 30 });
    assert.equal(other.status, 200);
    assert.equal(other.json.data.created, true);
  } finally { t.close(); }
});

test('MAJOR: отчёт колл-центра не считает снятые строки; «Записано» — по ступени из настроек', async () => {
  const t = await start();
  try {
    const r = t.db.prepare("INSERT INTO crm_requests (full_name, phone, patient_id, status, source) VALUES ('П','+998900000077',77,'in_process','call')").run().lastInsertRowid;
    // Правка карточки дважды: строка анализа снималась и ставилась заново.
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,40,?,'cancelled')").run(r, D);
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,40,?,'cancelled')").run(r, D);
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,40,?,'pending')").run(r, D);
    const rep = await t.rpc('callcenter_report', 'boss', {});
    assert.equal(rep.status, 200, JSON.stringify(rep.json));
    const blood = rep.json.data.topServices.find((x) => x.name === 'Анализ крови');
    assert.equal(blood && blood.count, 1, JSON.stringify(rep.json.data.topServices));
    const lab = rep.json.data.byServiceType.find((x) => x.name === 'Лаборатория');
    assert.equal(lab && lab.count, 1, JSON.stringify(rep.json.data.byServiceType));

    // Клиника убрала колонку «Записан»: запись двигает заявку в последнюю
    // живую колонку (scheduledStageKey) — KPI считает её же, а не ноль.
    t.db.prepare("DELETE FROM crm_stages WHERE key = 'scheduled'").run();
    const open = t.db.prepare("SELECT key FROM crm_stages WHERE kind = 'open' ORDER BY position, key").all().map((x) => x.key);
    const booked = open[open.length - 1];
    t.db.prepare('UPDATE crm_requests SET status = ? WHERE id = ?').run(booked, r);
    const rep2 = await t.rpc('callcenter_report', 'boss', {});
    assert.equal(rep2.json.data.kpi.scheduled, 1, 'KPI «Записано» смотрит на зашитый ключ scheduled');
  } finally { t.close(); }
});

test('MAJOR: «CRM: просмотр» не двигает, не берёт и не заводит заявки; «изменение» — может', async () => {
  const t = await start();
  try {
    const rid = t.db.prepare("INSERT INTO crm_requests (full_name, phone, status, source) VALUES ('Лид','+998900000001','in_process','call')").run().lastInsertRowid;
    const setCrm = (lvl) => t.db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
      .run(JSON.stringify({ sections: ['crm'], levels: { crm: lvl } }), 'callcenter');
    setCrm('viewer');
    const move = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'recall' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(move.status, 409, JSON.stringify(move.json));
    assert.match(move.json.error.message, /только на просмотр/);
    const take = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { assigned_to: 3 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(take.status, 409);
    const make = await t.dbq('cc', { table: 'crm_requests', op: 'insert', values: { full_name: 'Новый', phone: '+998900000002', status: 'in_process', source: 'call' } });
    assert.equal(make.status, 409);
    const line = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: { request_id: rid, service_id: 40, status: 'pending' } });
    assert.equal(line.status, 409);
    assert.equal(t.db.prepare('SELECT status, assigned_to FROM crm_requests WHERE id = ?').get(rid).status, 'in_process');
    // Читать доску просмотр по-прежнему может.
    const read = await t.dbq('cc', { table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(read.status, 200);
    // Настроенная матрица прав (grants) — то же правило.
    t.db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
      .run(JSON.stringify({ sections: ['crm'], levels: { crm: 'editor' }, grants: { crm: 'view' } }), 'callcenter');
    const move2 = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'recall' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(move2.status, 409);

    setCrm('editor');
    const ok = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'recall' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(t.db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'recall');
  } finally { t.close(); }
});

test('MINOR: неоплаченную услугу в работу не берут — анализ, консультация; бесплатную и оплаченную — берут', async () => {
  const t = await start();
  try {
    const v = t.db.prepare("INSERT INTO visits (patient_id, visit_date, status, doctor_id) VALUES (77, ?, 'scheduled', 10)").run(at(D, 9)).lastInsertRowid;
    const add = (svc, price, status = 'added', doctor = null) => t.db.prepare(
      'INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,?,?,?)')
      .run(v, svc, doctor, price, price, status).lastInsertRowid;
    const unpaidLab = add(40, 40000);
    const freeLab = add(41, 0);
    const paidLab = add(40, 40000, 'queued');
    const unpaidCons = add(30, 100000, 'added', 10);
    const upd = (who, id, values) => t.dbq(who, { table: 'visit_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });

    const c1 = await upd('lab', unpaidLab, { status: 'collected', sample_collected_at: new Date().toISOString() });
    assert.equal(c1.status, 409, JSON.stringify(c1.json));
    assert.match(c1.json.error.message, /не оплачен/);
    assert.equal(t.db.prepare('SELECT status FROM visit_services WHERE id = ?').get(unpaidLab).status, 'added');
    for (const st of ['in_progress', 'resulted', 'completed']) {
      assert.equal((await upd('lab', unpaidLab, { status: st })).status, 409, st);
    }
    assert.equal((await upd('lab', freeLab, { status: 'collected' })).status, 200, 'бесплатный анализ');
    assert.equal((await upd('lab', paidLab, { status: 'collected' })).status, 200, 'оплаченный анализ');

    const sign = await upd('doc', unpaidCons, { status: 'completed' });
    assert.equal(sign.status, 409, JSON.stringify(sign.json));
    assert.match(sign.json.error.message, /Консультация.*не оплачена.*подписать/);
    // Правка без смены статуса (заметка) — проходит.
    assert.equal((await upd('doc', unpaidCons, { notes: 'жалобы' })).status, 200);
    // Касса приняла деньги — подписывается.
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: [unpaidCons], discount_amount: 0 });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    t.db.prepare("UPDATE invoices SET status = 'paid', paid_amount = total_amount WHERE id = ?").run(inv.json.data.invoice.id);
    assert.equal((await upd('doc', unpaidCons, { status: 'completed' })).status, 200);
  } finally { t.close(); }
});
