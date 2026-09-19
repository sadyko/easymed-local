// DOCTOR_TIER_V1 — ступень доли врача по объёму. Порядок, зафиксированный
// владельцем: считается ТОЧНАЯ услуга, календарный месяц по дате визита,
// ступень — только у строк ВЫШЕ порога, считаются строки оплаченные ИЛИ
// начатые/завершённые врачом, ступень никого не понижает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorTierPositions } from './reports.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const user = { id: 1, role: 'admin' };
const SEP = { from: '2026-09-01', to: '2026-09-30' };

// Один врач, одна услуга 100 000, налог 0 (чтобы цифры читались глазами).
function clinic({ pct = 30, tierFrom = 25, tierPct = 40, fix = null, taxRate = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const rates = JSON.stringify([{ service_id: 1, pct, ...(fix == null ? {} : { fix }) }]);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, service_rates)
              VALUES (1,'doc','x','doctor','Доктор Д.', ?)`).run(rates);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare('INSERT INTO services (id, name, price, tax_rate, doctor_tier_from, doctor_tier_percent) VALUES (1,?,?,?,?,?)')
    .run('Приём', 100000, taxRate, tierFrom, tierPct);
  let seq = 0;
  // Одна строка = один визит с одной услугой; paid → счёт с датой дня и статусом invoiceStatus.
  const line = ({ day = '2026-09-05', status = 'added', paid = true, invoiceStatus = 'paid', qty = 1, price = 100000 } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date) VALUES (?,1,?)').run(id, day + 'T09:00:00Z');
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,1,1,?,?,?,?)`).run(id, id, qty, price, price * qty, status);
    if (paid) {
      const sub = price * qty;
      db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                  VALUES (?,?,?,1,?,0,?,?,?,?)`).run(id, 'INV-' + id, id, sub, sub, invoiceStatus === 'paid' ? sub : 0, invoiceStatus, day + 'T10:00:00Z');
      db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
                  VALUES (?,?,1,'Приём',?,?,?)`).run(id, id, qty, price, sub);
      db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(id, id);
    }
    return id;
  };
  const lines = (n, opts) => { for (let i = 0; i < n; i++) line(opts); };
  return { db, line, lines };
}

const fee = (db, range = SEP) => {
  const r = runReport(db, { kind: 'doctor_salaries', ...range }, user);
  return r.rows.length ? r.rows[0][r.columns.indexOf('Доля врача (гонорар)')] : 0;
};

test('до порога — личный процент: 25 строк × 30 000', () => {
  const c = clinic(); c.lines(25);
  assert.equal(fee(c.db), 750000);
});

test('26-я строка — по ступени 40 %, первые 25 — нет', () => {
  const c = clinic(); c.lines(26);
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('без ступени ничего не меняется', () => {
  const c = clinic({ tierFrom: 0, tierPct: 0 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 30000);
});

test('оплаченная, но ещё не начатая строка считается в нумерации', () => {
  const c = clinic(); c.lines(26, { status: 'added' });
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('начатая, но не оплаченная строка занимает номер, но не оплачивается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'in_progress', paid: false });   // номер 1
  c.lines(25);                                                          // номера 2..26
  assert.equal(fee(c.db), 24 * 30000 + 40000);
});

test('не начатая и не оплаченная строка не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'added', paid: false });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

// Лаборатория идёт по своей лестнице статусов (миграция 041):
// added → queued → collected → in_progress → resulted → completed.
// «Начал» для неё — взятие материала: дальше работа уже идёт.
test('лабораторная строка считается с момента взятия материала', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'collected', paid: false });   // номер 1
  c.lines(25);                                                       // номера 2..26
  assert.equal(fee(c.db), 24 * 30000 + 40000);
});

test('лабораторная строка с внесённым результатом тоже считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'resulted', paid: false });    // номер 1
  c.lines(25);                                                       // номера 2..26
  assert.equal(fee(c.db), 24 * 30000 + 40000);
});

test('строка в очереди на забор (queued) без оплаты не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'queued', paid: false });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

test('отменённый счёт не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'added', invoiceStatus: 'void' });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

test('ступень никого не понижает: врач на 45 % остаётся на 45 %', () => {
  const c = clinic({ pct: 45 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 45000);
});

test('фиксированная ставка: ступень не трогает', () => {
  const c = clinic({ fix: 15000 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 15000);
});

test('количество 3 на границе делится по единицам', () => {
  const c = clinic();
  c.lines(24);
  c.line({ qty: 3 });   // running 24 → 27: 1 единица по 30 %, 2 по 40 %
  // 24 × 30 000 + 300 000 × (30·1 + 40·2)/3 / 100 = 720 000 + 110 000
  assert.equal(fee(c.db), 830000);
});

test('октябрь начинает счёт заново', () => {
  const c = clinic(); c.lines(26);
  c.line({ day: '2026-10-01' });
  assert.equal(fee(c.db, { from: '2026-10-01', to: '2026-10-31' }), 30000);
});

test('недельный отчёт внутри месяца видит ступень всего месяца', () => {
  const c = clinic(); c.lines(25);
  c.line({ day: '2026-09-20' });   // 26-я в месяце
  assert.equal(fee(c.db, { from: '2026-09-15', to: '2026-09-21' }), 40000);
});

test('«Общая выручка» показывает ту же долю, что зарплатный отчёт', () => {
  const c = clinic(); c.lines(26);
  const rev = runReport(c.db, { kind: 'total_revenue', ...SEP }, user);
  const col = rev.columns.indexOf('Доля врача');
  const sum = rev.rows.reduce((s, r) => s + Number(r[col] || 0), 0);
  assert.equal(Math.round(sum), fee(c.db));
});

// Смешанный процент строки — дробь (30·1 + 40·2)/3: в таблицу он должен попасть
// округлённым, а не хвостом из double.
test('«Ставка врача» в «Общей выручке» округлена до двух знаков', () => {
  const c = clinic();
  c.lines(24);
  c.line({ qty: 3 });
  const rev = runReport(c.db, { kind: 'total_revenue', ...SEP }, user);
  const col = rev.columns.indexOf('Ставка врача');
  const rates = rev.rows.map((r) => r[col]);
  assert.ok(rates.includes(36.67), 'смешанная ставка печатается как 36.67, а не ' + JSON.stringify(rates.filter((x) => x !== 30)));
});

test('doctor_tier_positions отдаёт ту же нумерацию, что отчёт', () => {
  const c = clinic(); c.lines(24); c.line({ qty: 3 });
  const { rows } = doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map((r) => r.units_above).slice(0, 24), Array(24).fill(0));
  const last = rows[24];
  assert.equal(last.units, 3);
  assert.equal(last.units_above, 2);
  assert.equal(last.count_so_far, 27);
  assert.equal(last.tier_from, 25);
  assert.equal(last.tier_percent, 40);
  assert.equal(last.service_name, 'Приём');
  const money = rows.reduce((s, r) => s + 100000 * r.units * (30 * (r.units - r.units_above) + 40 * r.units_above) / r.units / 100, 0);
  assert.equal(money, fee(c.db));
});

test('doctor_tier_positions: без ступени — пусто; кривые аргументы — 400', () => {
  const c = clinic({ tierFrom: 0, tierPct: 0 }); c.lines(3);
  assert.deepEqual(doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user).rows, []);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, month: 'сентябрь' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, month: '2026-13' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { month: '2026-09' }, user), (e) => e.status === 400);
});

test('doctor_tier_positions зарегистрирован и считается чтением', () => {
  assert.equal(typeof RPC.doctor_tier_positions, 'function');
  assert.ok(isReadOnlyRpc('doctor_tier_positions'), 'кабинет врача при просроченной лицензии обязан читать свои позиции');
});

// DOCTOR_TIER_V1 — кабинет спрашивает позиции ОДНИМ запросом за диапазон
// месяцев: раньше он звал RPC в цикле по каждому затронутому месяцу, и на
// «за 12 месяцев» это было двенадцать запросов подряд. Месяц строки едет в
// ответе (ym), чтобы кабинет сам разложил строки по месяцам.
test('doctor_tier_positions: диапазон from/to отдаёт строки обоих месяцев с их ym', () => {
  const c = clinic();
  c.lines(2);                        // сентябрь
  c.line({ day: '2026-10-03' });     // октябрь
  const res = doctorTierPositions(c.db, { doctor_id: 1, from: '2026-09', to: '2026-10' }, user);
  assert.equal(res.from, '2026-09');
  assert.equal(res.to, '2026-10');
  assert.equal(res.rows.length, 3);
  assert.deepEqual(res.rows.map((r) => r.ym).sort(), ['2026-09', '2026-09', '2026-10']);
  // Нумерация у октября своя: счёт месяца начинается заново.
  const oct = res.rows.find((r) => r.ym === '2026-10');
  assert.equal(oct.count_so_far, 1);
  // Один месяц через from/to — ровно то же, что через month.
  const one = doctorTierPositions(c.db, { doctor_id: 1, from: '2026-09', to: '2026-09' }, user);
  assert.equal(one.rows.length, 2);
  assert.equal(doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user).month, '2026-09');
});

test('doctor_tier_positions: перевёрнутый и кривой диапазон — 400', () => {
  const c = clinic(); c.lines(1);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, from: '2026-10', to: '2026-09' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, from: '2026-13', to: '2026-13' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, from: '2026-09' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1 }, user), (e) => e.status === 400);
});
