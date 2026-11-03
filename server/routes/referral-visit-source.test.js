// REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 — ревью полировки 3.21.0, L-1 (проба RF1f) и N1.
//
// Правило владельца: врач получает бонус за услугу, которую направил (строка визита), — в любом
// окне. Источник ВИЗИТА (процент со всех строк визита) ставит только стойка («Кто направил»
// мастера, «Код отправителя» быстрой регистрации), он приходит из карты пациента или от партнёра
// (колл-центр); направлением врач источником визита не становится.
//
// L-1 — «Направить на услуги» из кабинета врача (мастер визита в режиме направления) ставил врачу
// его же внутренний источник «Кто направил» и слал его в ensure_visit: на новый день визит его
// сохранял, и врач получал 10 % со всех строк — и со своей услуги, и с консультации, которую
// стойка добавила назавтра (проба RF1f: 26 000 вместо 8 000 за одно направленное УЗИ). Теперь
// мастер в режиме направления источник визита не ставит, а сервер (ensure_visit, calendar_book)
// источник визита от врача, главного врача и медсестры не читает — только от стойки и колл-центра.
// N1 — visit_set_doctor_referrer снят: экраны его не зовут, а вкладка со старым кодом окна визита
// больше не делает рекомендовавшего врача направившим всего визита.
// Настоящая база (все миграции), настоящее приложение и вход под ролями; данные — выдуманные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { hashPassword } from '../services/auth.js';
import { runReport, doctorReferralReward, doctorPaySummary } from '../services/rpc/reports.js';
import { openCashShift } from '../services/rpc/cashier.js';
import { referralsInternal } from '../services/rpc/referrals.js';

const YESTERDAY = localDay(-1);
const TODAY = localDay(0);
const LATER = localDay(3);   // день без визита пациента: ensure_visit заводит НОВЫЙ визит
const admin = { id: 1, role: 'admin' };
const lastId = (db, t) => db.prepare(`SELECT MAX(id) id FROM ${t}`).get().id;
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const visitSource = (db, id) => db.prepare('SELECT referral_source_id r FROM visits WHERE id = ?').get(id).r;

function seed(db) {
  const u = db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)");
  u.run(12, 'doc2', hashPassword('password1'), 'Петров', 'doctor', 1);
  u.run(13, 'doc3', hashPassword('password1'), 'Сидоров', 'doctor', 1);
  u.run(14, 'admdoc', hashPassword('password1'), 'Администратор-врач', 'admin', 1);   // ADMIN_DOCTOR_V1 — у стойки он стойка
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (51,'Допплер',80000,'imaging')").run();
  db.prepare('UPDATE referral_source_categories SET standard_percent = 10 WHERE is_internal = 1').run();
  const extCat = Number(db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 5)").run().lastInsertRowid);
  db.prepare("INSERT INTO referral_sources (id, name, category_id) VALUES (900, 'Клиника Б', ?)").run(extCat);
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (499, 77, ?, 'arrived')").run(at(YESTERDAY, 9));
}

async function login(t, username) {
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход ' + username);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json };
  };
  return { rpc: (n, a) => call('/api/rpc/' + n, a), dbq: (d) => call('/api/db', d) };
}

async function payVisit(t, visitId, ids) {
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: visitId, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  openCashShift(t.db, { opening_float: 0 }, { id: 9, role: 'cashier', full_name: 'Кассир' });
  const p = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: inv.json.data.invoice.total_amount, method: 'cash' });
  assert.equal(p.status, 200, p.text);
}

// «Рефералы» подробно = «Рефералы» = кабинет врача = «Зарплаты врачей» = «Внутренние врачи».
function money(db, from, to) {
  const detail = objects(runReport(db, { kind: 'referrals_detail', from, to }, admin)).map((o) => [o['Источник'], o['Услуга'], o['Вознаграждение']]);
  const summary = Object.fromEntries(objects(runReport(db, { kind: 'referrals', from, to }, admin)).map((o) => [o['Источник'], Number(o['Вознаграждение']) || 0]));
  const byDetail = {};
  for (const [s, , r] of detail) byDetail[s] = (byDetail[s] || 0) + r;
  const internal = referralsInternal(db, { from, to }, admin);
  const docs = {};
  for (const [id, name] of [[12, 'Петров'], [13, 'Сидоров'], [10, 'Иванов']]) {
    const d = internal.doctors.find((x) => x.id === id);
    docs[name] = {
      cab: doctorReferralReward(db, { doctor_id: id, from, to }, admin).reward,
      zp: doctorPaySummary(db, { doctor_id: id, from, to }, admin).referral.reward,
      internal: d ? d.reward : 0,
    };
  }
  return { detail, summary, byDetail, docs };
}
function assertConsistent(m) {
  assert.deepEqual(m.summary, m.byDetail, '«Рефералы» и «Рефералы подробно» расходятся');
  for (const [name, d] of Object.entries(m.docs)) {
    const want = m.byDetail[name] || 0;
    assert.deepEqual([d.cab, d.zp, d.internal], [want, want, want], name + ': кабинет / «Зарплаты» / «Внутренние» ≠ «Рефералы»');
  }
}

test('ревью полировки L-1 (проба RF1f): «Направить на услуги» на новый день — визит без источника, Петров только за направленное УЗИ (8 000, а не 26 000)', async () => {
  const t = await startCrmApp(seed);
  try {
    const P = await login(t, 'doc2');   // Петров (12)
    const own = srcOf(t.db, 12);
    // Мастер направления до исправления слал свой источник врача «Кто направил» визита —
    // вкладка со старым кодом шлёт его и сейчас: сервер его от врача не читает.
    const ev = await P.rpc('ensure_visit', { patient_id: 77, date: LATER, doctor_id: 13, referral_source_id: own });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.created, true, 'визит дня уже был — проверяется не то');
    const vid = ev.json.data.visit.id;
    // Строки мастера: УЗИ делает Сидоров (направление Петрова), Допплер — сам Петров (своя строка).
    const l1 = await P.dbq({ table: 'visit_services', op: 'insert', values: { visit_id: vid, service_id: 50, doctor_id: 13, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    assert.equal(l1.status, 200, l1.text);
    const uzi = lastId(t.db, 'visit_services');
    const l2 = await P.dbq({ table: 'visit_services', op: 'insert', values: { visit_id: vid, service_id: 51, doctor_id: 12, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    assert.equal(l2.status, 200, l2.text);
    const doppler = lastId(t.db, 'visit_services');
    const lineSrc = (id) => t.db.prepare('SELECT referred_by_source_id r FROM visit_services WHERE id = ?').get(id).r;
    assert.equal(lineSrc(uzi), own, 'направленной строке сервер не поставил источник врача');
    assert.equal(lineSrc(doppler), null, 'своя строка врача — не направление');
    // Назавтра стойка добавляет в этот визит консультацию Иванова (каталог, источника не шлёт).
    const c = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: vid, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000 } });
    assert.equal(c.status, 200, c.text);
    const consult = lastId(t.db, 'visit_services');
    await payVisit(t, vid, [uzi, doppler, consult]);
    const m = money(t.db, YESTERDAY, LATER);
    assertConsistent(m);
    assert.deepEqual(m.detail, [['Петров', 'УЗИ', 8000]], 'бонус не только за направленное УЗИ: ' + JSON.stringify(m.detail));
    assert.deepEqual(m.docs['Петров'], { cab: 8000, zp: 8000, internal: 8000 });
    assert.equal(visitSource(t.db, vid), null, 'врач стал направившим ВСЕГО визита своим направлением');
  } finally { t.close(); }
});

test('ревью полировки L-1: ensure_visit — источник визита от врача не читается (ни свой, ни коллеги, ни партнёра); стойка, администратор-врач и колл-центр — ставят', async () => {
  const t = await startCrmApp(seed);
  try {
    const petrov = srcOf(t.db, 12);
    let day = 3;
    const ensure = async (rpc, source) => {
      const r = await rpc('ensure_visit', { patient_id: 77, date: localDay(day++), referral_source_id: source });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.created, true, 'визит дня уже был — проверяется не то');
      return visitSource(t.db, r.json.data.visit.id);
    };
    const doc = (n, a) => t.rpc(n, 'doc', a);   // Иванов (10)
    assert.equal(await ensure(doc, petrov), null, 'врач назвал коллегу направившим визита');
    assert.equal(await ensure(doc, srcOf(t.db, 10)), null, 'врач назвал себя направившим визита');
    assert.equal(await ensure(doc, 900), null, 'врач назвал партнёра направившим визита');
    assert.equal(await ensure((n, a) => t.rpc(n, 'reg', a), 900), 900, 'регистратура: «Кто направил» не сохранён');
    assert.equal(await ensure((n, a) => t.rpc(n, 'reg', a), petrov), petrov, 'регистратура выбрала врача «Кто направил» — не сохранено');
    assert.equal(await ensure((n, a) => t.rpc(n, 'boss', a), 900), 900, 'администратор: «Кто направил» не сохранён');
    const AD = await login(t, 'admdoc');
    assert.equal(await ensure(AD.rpc, petrov), petrov, 'администратор-врач у стойки — стойка');
    // Колл-центр: запись из заявки (crm.js) источника сейчас не шлёт; партнёр или реклама,
    // присланные оператором, по-прежнему ложатся в визит.
    assert.equal(await ensure((n, a) => t.rpc(n, 'cc', a), 900), 900, 'колл-центр: источник заявки не сохранён');
  } finally { t.close(); }
});

test('ревью полировки L-1: calendar_book — источник новой записи от врача не читается; стойка и колл-центр (каталог записи) — ставят', async () => {
  const t = await startCrmApp(seed);
  try {
    let day = 3;
    const book = async (who, source) => {
      const start = new Date(at(localDay(day++), 11));
      const r = await t.rpc('calendar_book', who, { patient_id: 77, start: start.toISOString(), referral_source_id: source });
      assert.equal(r.status, 200, who + ': ' + r.text);
      return visitSource(t.db, r.json.data.visit.id);
    };
    assert.equal(await book('doc', srcOf(t.db, 10)), null, 'врач записью назвал себя направившим визита');
    assert.equal(await book('doc', 900), null, 'врач записью назвал партнёра направившим визита');
    assert.equal(await book('reg', 900), 900, 'регистратура: источник записи не сохранён');
    assert.equal(await book('cc', 900), 900, 'колл-центр: источник записи не сохранён');
  } finally { t.close(); }
});

test('ревью полировки N1: visit_set_doctor_referrer снят — ничего не пишет ни для кого (вкладка со старым окном визита)', async () => {
  const t = await startCrmApp(seed);
  try {
    // Как прежде: рекомендация Петрова, стойка завела её строку в визит дня и зовёт старый вызов.
    t.db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500, 77, ?, 'arrived')").run(at(TODAY, 9));
    const P = await login(t, 'doc2');
    assert.equal((await P.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', source_visit_id: 499, status: 'pending' } })).status, 200);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: 13, quantity: 1, unit_price: 80000, total: 80000 } });
    assert.equal(ins.status, 200, ins.text);
    for (const who of ['reg', 'boss', 'doc', 'cc']) {
      const r = await t.rpc('visit_set_doctor_referrer', who, { visit_id: 500, doctor_id: 12, source_visit_id: 499 });
      assert.equal(r.status, 200, who + ': ' + r.text);
      assert.deepEqual(r.json.data, { set: false, retired: true }, who);
    }
    assert.equal(visitSource(t.db, 500), null, 'снятый вызов сделал Петрова направившим визита');
  } finally { t.close(); }
});
