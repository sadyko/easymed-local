// REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 — полировка 3.21.0 (остатки повторного ревью U10).
//   п. 7  visit_set_doctor_referrer — только стойка и только по своей строке услуги рекомендации
//         (проба R1e: врач писал рекомендацию задним числом и получал 10 % чужого визита); с ревью
//         полировки N1 вызов снят и ничего не пишет;
//   п. 8  два разных врача на одной строке — вариант «б»: врач строки ЗАМЕНЯЕТ врача визита
//         (проба R3b); «Рефералы», подробно, кабинет врача и «Зарплаты врачей» — одни суммы;
//   п. 9  рекомендация, уже привязанная к строке, ко второй не привязывается (проба R1d);
//   п. 10 «от врача» — рекомендовавший, а не вставивший строку коллега (проба R3a);
//   п. 11 «Представители» не считают партнёра строки на визите другого партнёра (проба R2).
//   ревью полировки M1 — окно визита больше не делает рекомендовавшего врача направившим всего
//         визита: бонус — только за услугу рекомендации, в любом окне стойки (проба PB1);
//   ревью полировки L2 — «Бонус» рекомендации называет и направившего визита, которому платят,
//         если рекомендатель выполняет услугу сам (проба PB3).
// Настоящая база (все миграции), настоящее приложение и вход под ролями; данные — выдуманные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { hashPassword } from '../services/auth.js';
import { runReport, doctorReferralReward, doctorPaySummary } from '../services/rpc/reports.js';
import { openCashShift } from '../services/rpc/cashier.js';
import { referralsRepresentatives } from '../services/rpc/referrals.js';
import { DOCTOR_LINE_REPLACES_DOCTOR_BASE, EXTERNAL_LINE_ADDS_TO_EXTERNAL_BASE } from '../services/domain/line-referral.js';

const TODAY = localDay(0);
const YESTERDAY = localDay(-1);
const TOMORROW = localDay(1);
const admin = { id: 1, role: 'admin' };
const lastId = (db, t) => db.prepare(`SELECT MAX(id) id FROM ${t}`).get().id;
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

function seed(db) {
  const u = db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,'doctor',1)");
  u.run(12, 'doc2', hashPassword('password1'), 'Петров');
  u.run(13, 'doc3', hashPassword('password1'), 'Сидоров');
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (62,'ЭКГ',50000,'imaging')").run();
  db.prepare('UPDATE referral_source_categories SET standard_percent = 10 WHERE is_internal = 1').run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (499, 77, ?, 'arrived')").run(at(YESTERDAY, 9));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500, 77, ?, 'arrived')").run(at(TODAY, 9));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (501, 77, ?, 'scheduled')").run(at(TOMORROW, 9));
}

async function login(t, username) {
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход ' + username);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json };
  };
  return { rpc: (name, args) => call('/api/rpc/' + name, args), dbq: (desc) => call('/api/db', desc) };
}

async function payVisit(t, visitId, ids) {
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: visitId, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  openCashShift(t.db, { opening_float: 0 }, { id: 9, role: 'cashier', full_name: 'Кассир' });
  const p = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: inv.json.data.invoice.total_amount, method: 'cash' });
  assert.equal(p.status, 200, p.text);
}
const detailRows = (db, from = TODAY, to = TODAY) => objects(runReport(db, { kind: 'referrals_detail', from, to }, admin))
  .map((o) => [o['Источник'], o['Услуга'], o['Вознаграждение']]);

// Ревью полировки M1 — вызовы, которые окно визита (visit-modal.js attachRecommendation) делает
// после вставки строки из рекомендации, берутся из самого окна: тест идёт тем же путём, что экран.
const VIEWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', 'admin', 'views');
function modalRecommendationRpcs() {
  const src = fs.readFileSync(path.join(VIEWS, 'visit-modal.js'), 'utf8');
  const i = src.indexOf('async function attachRecommendation(');
  assert.ok(i >= 0, 'attachRecommendation не найдена');
  const body = src.slice(i, src.indexOf('\nasync function ', i + 10));
  return [...body.matchAll(/supabase\.rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
}
async function replayRecommendationRpcs(t, who, names, { recId, lineId, recommender, sourceVisit, visitId = 500 }) {
  for (const name of names) {
    let r;
    if (name === 'visit_set_doctor_referrer') {
      r = await t.rpc(name, who, { visit_id: visitId, doctor_id: recommender, source_visit_id: sourceVisit });
      continue;   // окно терпит отказ (console.warn)
    } else if (name === 'referral_recommendation_attach') {
      r = await t.rpc(name, who, { recommendation_id: recId, visit_service_id: lineId });
    } else {
      assert.fail('окно визита зовёт новый вызов ' + name + ' — допишите его в тест');
    }
    assert.equal(r.status, 200, name + ': ' + r.text);
  }
}

// Ревью полировки N1 — visit_set_doctor_referrer снят (rpc/referral-autofill.js): ничего не пишет
// ни врачу, ни стойке (подробно — referral-visit-source.test.js).
test('полировка п. 7 (проба R1e): врач не делает себя направившим визита стойки задним числом — вызов снят, бонуса нет', async () => {
  const t = await startCrmApp(seed);
  try {
    await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: 12, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    const X = lastId(t.db, 'visit_services');
    // Иванов (10) пациента не видел: рекомендация на другую услугу — после всего
    const rec = await t.dbq('doc', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 40, service_name: 'Анализ крови', status: 'pending' } });
    assert.equal(rec.status, 200, rec.text);
    for (const who of ['doc', 'reg']) {
      const r = await t.rpc('visit_set_doctor_referrer', who, { visit_id: 500, doctor_id: 10 });
      assert.equal(r.status, 200, who + ': ' + r.text);
      assert.deepEqual(r.json.data, { set: false, retired: true }, who);
    }
    assert.equal(t.db.prepare('SELECT referral_source_id r FROM visits WHERE id = 500').get().r, null);
    await payVisit(t, 500, [X]);
    assert.deepEqual(detailRows(t.db), [], 'Иванов получил бонус за визит стойки');
  } finally { t.close(); }
});

test('полировка п. 8 (проба R3b): два врача на визите — Петров за УЗИ, Сидоров за ЭКГ, Петрову за ЭКГ ничего; отчёты, кабинет и зарплаты сходятся', async () => {
  assert.equal(DOCTOR_LINE_REPLACES_DOCTOR_BASE, true, 'вариант «б» (файла владельца owner-r3b.txt нет)');
  const t = await startCrmApp(seed);
  try {
    const A = await login(t, 'doc2');   // Петров (12): УЗИ
    const C = await login(t, 'doc3');   // Сидоров (13): ЭКГ
    assert.equal((await A.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', source_visit_id: 499, status: 'pending' } })).status, 200);
    const r1 = lastId(t.db, 'recommended_services');
    assert.equal((await C.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 62, service_name: 'ЭКГ', source_visit_id: 499, status: 'pending' } })).status, 200);
    const r2 = lastId(t.db, 'recommended_services');
    // стенд: «Кто направил» визита стойка выбрала сама — Петров (ревью полировки M1: окно визита
    // направившего визита по рекомендации больше не ставит)
    const srcOf = (d) => t.db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(d).id;
    t.db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = 500').run(srcOf(12));
    // окно визита регистратуры: строка → вызовы окна (привязка); исполнитель — Иванов
    const names = modalRecommendationRpcs();
    const ids = [];
    for (const [rec, svc, price, doc] of [[r1, 50, 80000, 12], [r2, 62, 50000, 13]]) {
      const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: svc, doctor_id: 10, quantity: 1, unit_price: price, total: price } });
      assert.equal(ins.status, 200, ins.text);
      const X = lastId(t.db, 'visit_services'); ids.push(X);
      await replayRecommendationRpcs(t, 'reg', names, { recId: rec, lineId: X, recommender: doc, sourceVisit: 499 });
    }
    assert.equal(t.db.prepare('SELECT referral_source_id r FROM visits WHERE id = 500').get().r, srcOf(12), 'стенд: Петров — источник визита');
    // окно регистрации («Бонус: …») — то же правило
    const orders = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
    assert.equal(orders.status, 200, orders.text);
    const bonus = Object.fromEntries(orders.json.data.lines.map((l) => [l.name, l.bonus_to]));
    assert.deepEqual(bonus, { 'УЗИ': ['Петров'], 'ЭКГ': ['Сидоров'] });
    await payVisit(t, 500, ids);
    assert.deepEqual(detailRows(t.db).sort(), [['Петров', 'УЗИ', 8000], ['Сидоров', 'ЭКГ', 5000]]);
    const summary = Object.fromEntries(objects(runReport(t.db, { kind: 'referrals', from: TODAY, to: TODAY }, admin)).map((o) => [o['Источник'], o['Вознаграждение']]));
    assert.deepEqual(summary, { 'Петров': 8000, 'Сидоров': 5000 });
    for (const [d, want] of [[12, 8000], [13, 5000]]) {
      assert.equal(doctorReferralReward(t.db, { doctor_id: d, from: TODAY, to: TODAY }, admin).reward, want, 'кабинет ' + d);
      assert.equal(doctorPaySummary(t.db, { doctor_id: d, from: TODAY, to: TODAY }, admin).referral.reward, want, '«Зарплаты врачей» ' + d);
    }
  } finally { t.close(); }
});

test('полировка п. 9 (проба R1d): рекомендацию, привязанную к строке и «открытую» правкой, ко второй строке не привязать — 409', async () => {
  const t = await startCrmApp(seed);
  try {
    await t.dbq('doc', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', status: 'pending' } });
    const recId = lastId(t.db, 'recommended_services');
    await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: 12, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    const X1 = lastId(t.db, 'visit_services');
    assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: recId, visit_service_id: X1 })).status, 200);
    const reopen = await t.dbq('reg', { table: 'recommended_services', op: 'update', values: { status: 'pending', closed_at: null }, filters: [{ col: 'id', op: 'eq', val: recId }] });
    assert.equal(reopen.status, 200, 'стенд: статус открывается правкой: ' + reopen.text);
    await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 501, service_id: 50, doctor_id: 12, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    const X2 = lastId(t.db, 'visit_services');
    const again = await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: recId, visit_service_id: X2 });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.error.message, 'Рекомендация уже привязана к другой строке услуги.');
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(X2).s, null, 'вторая строка получила направившего');
    assert.equal(t.db.prepare('SELECT visit_service_id v FROM recommended_services WHERE id = ?').get(recId).v, X1);
    // та же строка — повтор привязки не отказ
    assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: recId, visit_service_id: X1 })).status, 200);
  } finally { t.close(); }
});

test('полировка п. 10 (проба R3a): рекомендацию Петрова (исполняет он сам) добавил Иванов — «от врача» Петров у стойки и в календаре', async () => {
  const t = await startCrmApp(seed);
  try {
    const A = await login(t, 'doc2');
    await A.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', source_visit_id: 499, status: 'pending' } });
    const recId = lastId(t.db, 'recommended_services');
    await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: 12, quantity: 1, unit_price: 80000, total: 80000, status: 'added' } });
    const X = lastId(t.db, 'visit_services');
    assert.equal((await t.rpc('referral_recommendation_attach', 'doc', { recommendation_id: recId, visit_service_id: X })).status, 200);
    const orders = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
    const line = orders.json.data.lines.find((l) => l.visit_service_id === X);
    assert.ok(line, orders.text);
    assert.equal(line.referrer_id, 12);
    assert.equal(line.referrer_name, 'Петров');
    assert.deepEqual(line.bonus_to, [], 'своя строка Петрова — без бонуса');
    const links = await t.rpc('referral_visit_links', 'reg', { visit_ids: [500] });
    assert.deepEqual(links.json.data, [{ visit_id: 500, doctor_name: 'Петров' }]);
  } finally { t.close(); }
});

// Ревью полировки M1 (проба PB1) — правило владельца: врач получает бонус за услугу, которую
// направил. Окно визита регистратуры после вставки строки звало visit_set_doctor_referrer: Петров,
// чью рекомендацию добавили, становился направившим ВСЕГО визита и получал 10 % и с консультации
// Иванова, и со своей же услуги (18 000 вместо 8 000), а в мастере и быстрой регистрации (только
// привязка) — 8 000. Теперь окно — то же, что мастер: строка → привязка; источник визита прежний.
// Вызовы окна взяты из visit-modal.js (modalRecommendationRpcs) — тест идёт путём экрана.
test('ревью полировки M1 (проба PB1): рекомендация врача в окне визита — бонус только за её услугу, как в мастере; источник визита не меняется', async () => {
  const modal = modalRecommendationRpcs();
  assert.ok(modal.includes('referral_recommendation_attach'), JSON.stringify(modal));
  const wizard = ['referral_recommendation_attach'];   // мастер визита и быстрая регистрация (walk-in-booking.js)
  for (const f of ['visit-wizard.js', 'walk-in-booking.js']) {
    const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
    assert.match(src, /supabase\.rpc\(\s*'referral_recommendation_attach'/, f);
    assert.doesNotMatch(src, /rpc\(\s*'visit_set_doctor_referrer'/, f);
  }
  const cases = [
    // окно, кто добавляет, исполнитель УЗИ, строки «Рефералов»
    ['окно визита, регистратура, УЗИ делает Сидоров', modal, 'reg', 13, [['Петров', 'УЗИ', 8000]]],
    ['окно визита, регистратура, УЗИ делает сам Петров', modal, 'reg', 12, []],
    ['окно визита, врач Иванов, УЗИ делает Сидоров', modal, 'doc', 13, [['Петров', 'УЗИ', 8000]]],
    ['мастер / быстрая регистрация, УЗИ делает Сидоров', wizard, 'reg', 13, [['Петров', 'УЗИ', 8000]]],
    ['мастер / быстрая регистрация, УЗИ делает сам Петров', wizard, 'reg', 12, []],
  ];
  for (const [label, names, who, performer, want] of cases) {
    const t = await startCrmApp(seed);
    try {
      const P = await login(t, 'doc2');   // Петров (12) рекомендовал УЗИ вчера
      assert.equal((await P.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', source_visit_id: 499, status: 'pending' } })).status, 200);
      const rec = lastId(t.db, 'recommended_services');
      // визит без записи: консультация Иванова (10) 100 000; у визита и карточки направившего нет
      const c = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000 } });
      assert.equal(c.status, 200, c.text);
      const consult = lastId(t.db, 'visit_services');
      const ins = await t.dbq(who, { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: performer, quantity: 1, unit_price: 80000, total: 80000 } });
      assert.equal(ins.status, 200, ins.text);
      const uzi = lastId(t.db, 'visit_services');
      await replayRecommendationRpcs(t, who, names, { recId: rec, lineId: uzi, recommender: 12, sourceVisit: 499 });
      assert.equal(t.db.prepare('SELECT referral_source_id r FROM visits WHERE id = 500').get().r, null, label + ': рекомендовавший стал направившим всего визита');
      await payVisit(t, 500, [consult, uzi]);
      assert.deepEqual(detailRows(t.db), want, label);
      const petrov = want.reduce((s, r) => s + r[2], 0);
      assert.equal(doctorReferralReward(t.db, { doctor_id: 12, from: TODAY, to: TODAY }, admin).reward, petrov, label + ': кабинет');
      assert.equal(doctorPaySummary(t.db, { doctor_id: 12, from: TODAY, to: TODAY }, admin).referral.reward, petrov, label + ': «Зарплаты врачей»');
    } finally { t.close(); }
  }
});

// Ревью полировки L2 (проба PB3) — у сегодняшнего визита направивший-врач Петров («Кто направил»),
// открытая рекомендация Сидорова на ЭКГ. Вариант «б»: выполнит другой врач — бонус Сидорову; выполнит
// сам Сидоров — его строки бонус не даёт, платится направивший визита Петров. Подпись «Бонус» называла
// только Сидорова; теперь — обоих, каждого со своим условием (имена, без сумм).
test('ревью полировки L2 (проба PB3): «Бонус» рекомендации называет и направившего визита — «если выполняет сам рекомендатель»; платят ровно названным', async () => {
  for (const [performer, want] of [[13, [['Петров', 'ЭКГ', 5000]]], [10, [['Сидоров', 'ЭКГ', 5000]]]]) {
    const t = await startCrmApp((db) => {
      seed(db);
      db.prepare('UPDATE visits SET referral_source_id = (SELECT id FROM referral_sources WHERE doctor_id = 12) WHERE id = 500').run();
      db.prepare("INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, status, created_at) VALUES (77, 62, 'ЭКГ', 13, 'pending', '2026-01-01T09:00:00Z')").run();
    });
    try {
      const o = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
      assert.equal(o.status, 200, o.text);
      const rec = o.json.data.recommendations[0];
      assert.deepEqual({ bonus_to: rec.bonus_to, bonus_if_other: rec.bonus_if_other, bonus_if_self: rec.bonus_if_self },
        { bonus_to: [], bonus_if_other: 'Сидоров', bonus_if_self: 'Петров' });
      const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 62, doctor_id: performer, quantity: 1, unit_price: 50000, total: 50000 } });
      assert.equal(ins.status, 200, ins.text);
      const X = lastId(t.db, 'visit_services');
      assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec.recommendation_id, visit_service_id: X })).status, 200);
      await payVisit(t, 500, [X]);
      const rows = detailRows(t.db);
      assert.deepEqual(rows, want, 'исполнитель ' + performer);
      const named = [...rec.bonus_to, rec.bonus_if_other, rec.bonus_if_self];
      for (const [who] of rows) assert.ok(named.includes(who), who + ' получил бонус, а подпись его не называла');
    } finally { t.close(); }
  }
});

// п. 8 и п. 11 — матрица на деньгах (строки 80 000, 10 %), одно правило на все экраны.
function moneySeed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'd1', 'x', 'doctor', 'Врач Д', 1);
  u.run(2, 'd2', 'x', 'doctor', 'Врач Е', 1);
  u.run(3, 'd3', 'x', 'doctor', 'Исполнитель Ф', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  const internalCat = db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  db.prepare('UPDATE referral_source_categories SET standard_percent = 10 WHERE id = ?').run(internalCat);
  const extCat = Number(db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid);
  const A = Number(db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Партнёр А', ?)").run(extCat).lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Партнёр Б', ?)").run(extCat).lastInsertRowid);
  const D = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  const E = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get().id;
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2, 'УЗИ', 80000, 'imaging')").run();
  let n = 0;
  const line = ({ card = null, visitSource = null, lineSource = null, performer = 3 }) => {
    n += 1;
    const pt = Number(db.prepare('INSERT INTO patients (full_name, referral_source_id) VALUES (?, ?)').run('p' + n, card).lastInsertRowid);
    const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, referral_source_id) VALUES (?, '2026-08-05T09:00:00Z', ?)").run(pt, visitSource).lastInsertRowid);
    const inv = Number(db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                                   VALUES (?, ?, ?, 80000, 0, 80000, 80000, 'paid', '2026-08-05T10:00:00Z')`).run('INV-P' + n, vid, pt).lastInsertRowid);
    const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 2, 'УЗИ', 1, 80000, 80000)").run(inv).lastInsertRowid);
    db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id, referred_by_source_id)
                VALUES (?, 2, ?, 1, 80000, 80000, 'completed', ?, ?)`).run(vid, performer, item, lineSource);
  };
  return { db, A, B, D, E, line };
}

test('полировка п. 8: матрица двух врачей — врач строки вместо другого врача визита; тот же врач, своя строка, партнёр + врач — как прежде; все экраны сходятся', () => {
  const { db, A, B, D, E, line } = moneySeed();
  try {
    const FROM = '2026-08-01'; const TO = '2026-08-31';
    const step = (args, want) => {
      const before = detailRows(db, FROM, TO).length;
      line(args);
      assert.deepEqual(detailRows(db, FROM, TO).slice(before).map(([s, , r]) => [s, r]).sort(), want, JSON.stringify(args));
    };
    step({ visitSource: D, lineSource: E }, [['Врач Е', 8000]]);                       // прежде: Д 8 000 + Е 8 000
    step({ visitSource: D, lineSource: E, performer: 2 }, [['Врач Д', 8000]]);          // Е исполняет сам — платится визит
    step({ visitSource: D, lineSource: D }, [['Врач Д', 8000]]);                       // один врач — один раз
    step({ visitSource: A, lineSource: D }, [['Врач Д', 8000], ['Партнёр А', 8000]]);  // партнёр + врач — оба
    step({ visitSource: D, lineSource: B }, [['Врач Д', 8000], ['Партнёр Б', 8000]]);  // врач + партнёр — оба
    step({ card: A, lineSource: B }, [['Партнёр А', 8000]]);                           // два партнёра — вариант «б»
    step({ lineSource: E }, [['Врач Е', 8000]]);
    const detail = objects(runReport(db, { kind: 'referrals_detail', from: FROM, to: TO }, admin));
    const summary = objects(runReport(db, { kind: 'referrals', from: FROM, to: TO }, admin));
    const sum = (xs) => xs.reduce((a, o) => a + (Number(o['Вознаграждение']) || 0), 0);
    assert.equal(sum(detail), sum(summary));
    const by = Object.fromEntries(summary.map((o) => [o['Источник'], o['Вознаграждение']]));
    assert.deepEqual([by['Врач Д'], by['Врач Е']], [32000, 16000]);
    const cab = [1, 2].map((d) => doctorReferralReward(db, { doctor_id: d, from: FROM, to: TO }, admin).reward);
    const pay = [1, 2].map((d) => doctorPaySummary(db, { doctor_id: d, from: FROM, to: TO }, admin).referral.reward);
    assert.deepEqual(cab, [32000, 16000], 'кабинет врача');
    assert.deepEqual(pay, cab, '«Зарплаты врачей»');
  } finally { db.close(); }
});

test('полировка п. 11 (проба R2): «Представители» считают визиты партнёра так же, как деньги — партнёр строки на визите другого партнёра не в счёт', () => {
  assert.equal(EXTERNAL_LINE_ADDS_TO_EXTERNAL_BASE, false);
  const { db, A, B, D, line } = moneySeed();
  try {
    const FROM = '2026-08-01'; const TO = '2026-08-31';
    line({ card: A, lineSource: B });          // Б не платится — визит не Б
    line({ visitSource: A, lineSource: B });   // Б не платится — визит не Б
    line({ lineSource: B });                   // Б платится
    line({ visitSource: D, lineSource: B });   // врач визита + партнёр строки — Б платится
    line({ visitSource: A, lineSource: A });   // А — один раз
    const reps = Object.fromEntries(referralsRepresentatives(db, { from: FROM, to: TO }, admin).sources.map((s) => [s.name, [s.visits, s.reward]]));
    assert.deepEqual(reps['Партнёр Б'], [2, 16000], 'визиты Б = визиты, за которые Б платят');
    assert.deepEqual(reps['Партнёр А'], [3, 24000]);
  } finally { db.close(); }
});
