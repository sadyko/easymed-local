// REFERRAL_BILL_V1 (2026-09-29) — СКВОЗНОЙ ПУТЬ «ВРАЧ НАПРАВИЛ → КАССА ВИДИТ».
//
// Владелец: «While we are seeing the patient as a doctor and refer to another
// service or a doctor we cannot see them in the cashier's window. Which means
// flow is broken.»
//
// Корень: «Направить на услуги» в кабинете врача открывает мастер визита, а
// тот у врача заводил визит и строки БЕЗ счёта (INVOICE_ROLE_HONEST_V1 — счёт
// выставляли только администратор, регистратура и касса). «Приём оплат» кассы
// строится из одних счетов (cashier_invoices) — визит со строками и без счёта
// кассе не виден вовсе.
//
// Здесь — ровно те вызовы, которые делает мастер (ensure_visit, вставка строки
// через /api/db, create_invoice_for_visit с discount_amount: 0 и payer_id:
// null), через настоящий HTTP и SQLite в памяти после миграций, под настоящими
// сессиями врача и кассира.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
function localDay(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
const TODAY = localDay(0);
const DOC = 10;

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0);
  user.run(3, 'cash', hashPassword('password1'), 'Кассир', 'cashier', 0);
  user.run(DOC, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ брюшной полости',80000,'imaging')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone, mrn) VALUES (77,'Пациент Тест','+998900000077','A-000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cash', 'doc']) {
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

/**
 * «Направить на услуги» из кабинета врача — те же вызовы, что у мастера
 * (visit-wizard.js createVisit): визит дня, затем по строке на услугу. Цену в
 * строке браузер присылает свою — счёт её пересчитывает.
 */
async function referral(t, services) {
  const ev = await t.rpc('ensure_visit', 'doc', {
    patient_id: 77, date: at(TODAY, 9), doctor_id: null, visit_type: 'outpatient',
    referral_source_id: null, branch_id: null, notes: null,
  });
  assert.equal(ev.status, 200, 'визит врача не заведён: ' + JSON.stringify(ev.json));
  const visitId = ev.json.data.visit.id;
  const lineIds = [];
  for (const s of services) {
    const ins = await t.dbq('doc', { table: 'visit_services', op: 'insert', returning: true, single: 'single', values: {
      visit_id: visitId, service_id: s.service_id, quantity: 1,
      unit_price: s.unit_price ?? 1, total: s.unit_price ?? 1, status: 'added', price_tier: null,
    } });
    assert.equal(ins.status, 200, 'строка врача не записана: ' + JSON.stringify(ins.json));
    lineIds.push(ins.json.data.id);
  }
  return { visitId, lineIds };
}

test('REFERRAL_BILL_V1: врач направил и выставил счёт — касса видит неоплаченный счёт по ценам сервера', async () => {
  const t = await start();
  try {
    const { visitId, lineIds } = await referral(t, [{ service_id: 40 }]);
    const inv = await t.rpc('create_invoice_for_visit', 'doc', {
      visit_id: visitId, visit_service_ids: lineIds, discount_amount: 0, payer_id: null,
    });
    assert.equal(inv.status, 200, 'врачу отказано в счёте по его направлению: ' + JSON.stringify(inv.json));
    const invoice = inv.json.data.invoice;
    assert.equal(invoice.status, 'unpaid', 'счёт направления — неоплаченный');
    assert.equal(invoice.total_amount, 40000, 'цена — каталог сервера, а не присланная браузером');
    assert.equal(invoice.paid_amount, 0);
    assert.equal(invoice.created_by, DOC);

    const list = await t.rpc('cashier_invoices', 'cash', {});
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const row = list.json.data.rows.find((r) => r.id === invoice.id);
    assert.ok(row, 'касса не видит счёт по направлению врача');
    assert.equal(row.status, 'unpaid');
    assert.equal(row.total_amount, 40000);
    assert.equal(row.patient_name, 'Пациент Тест');
    assert.equal(list.json.data.counts.unpaid.n, 1, 'плашка «Не оплачен» считает этот счёт');

    // Счёт выставлен — в «Ждут счёта» визита больше нет.
    const un = await t.rpc('cashier_unbilled', 'cash', {});
    assert.equal(un.status, 200, JSON.stringify(un.json));
    assert.ok(!un.json.data.rows.some((r) => r.visit_id === visitId), 'выставленный визит всё ещё «ждёт счёта»');
  } finally { t.close(); }
});

test('REFERRAL_BILL_V1: направление без счёта — касса видит визит в «Ждут счёта» и выставляет счёт сама', async () => {
  const t = await start();
  try {
    const { visitId, lineIds } = await referral(t, [{ service_id: 40 }, { service_id: 50 }]);

    const un = await t.rpc('cashier_unbilled', 'cash', {});
    assert.equal(un.status, 200, 'у кассы нет списка «Ждут счёта»: ' + JSON.stringify(un.json));
    const row = un.json.data.rows.find((r) => r.visit_id === visitId);
    assert.ok(row, 'визит врача без счёта кассе не виден');
    assert.equal(row.patient_id, 77);
    assert.equal(row.patient_name, 'Пациент Тест');
    assert.equal(row.mrn, 'A-000077');
    assert.equal(row.lines_count, 2);
    assert.equal(row.total, 120000, 'сумма — по ценам, по которым выставит счёт касса');
    assert.deepEqual([...row.names].sort(), ['Анализ крови', 'УЗИ брюшной полости']);
    assert.equal(row.added_by, 'Иванов', '«добавил» — тот, кто завёл строку');
    assert.equal(un.json.data.totals.n, 1);
    assert.equal(un.json.data.totals.sum, 120000);

    // Касса выставляет счёт сама — визит уходит из «Ждут счёта» в «Приём оплат».
    const inv = await t.rpc('create_invoice_for_visit', 'cash', { visit_id: visitId, visit_service_ids: lineIds });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    const after = await t.rpc('cashier_unbilled', 'cash', {});
    assert.ok(!after.json.data.rows.some((r) => r.visit_id === visitId));
    const list = await t.rpc('cashier_invoices', 'cash', {});
    assert.ok(list.json.data.rows.some((r) => r.id === inv.json.data.invoice.id && r.status === 'unpaid'));
  } finally { t.close(); }
});

// Дополнение владельца (2026-09-29): у пациента в карте плательщик — «Leave
// for Касса». Врач счёта не выставляет; касса видит визит в «Ждут счёта» и
// выставляет счёт нужному плательщику.
test('REFERRAL_BILL_V1: плательщик в карте — врачу отказ, касса видит визит и выставляет счёт страховой', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (5, 'Страховая', 'insurance', 1)").run();
    t.db.prepare('UPDATE patients SET payer_id = 5 WHERE id = 77').run();
    const { visitId, lineIds } = await referral(t, [{ service_id: 40 }]);
    const inv = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: lineIds, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 403, 'врач выставил счёт пациенту со страховой в карте: ' + JSON.stringify(inv.json));
    assert.equal(inv.json.error.message, 'У пациента в карте указан плательщик — счёт выставляет касса.');
    const un = await t.rpc('cashier_unbilled', 'cash', {});
    assert.ok(un.json.data.rows.some((r) => r.visit_id === visitId), 'визит не ждёт кассу');
    const byPayer = await t.rpc('create_invoice_for_visit', 'cash', { visit_id: visitId, visit_service_ids: lineIds, payer_id: 5 });
    assert.equal(byPayer.status, 200, JSON.stringify(byPayer.json));
    assert.equal(byPayer.json.data.invoice.payer_id, 5, 'касса выставила счёт страховой');
  } finally { t.close(); }
});
