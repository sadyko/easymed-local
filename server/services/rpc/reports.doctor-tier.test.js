// DOCTOR_TIER_V1 — ступень доли врача по объёму. Порядок, зафиксированный
// владельцем: считается ТОЧНАЯ услуга, календарный месяц по дате визита,
// ступень — только у строк ВЫШЕ порога, ступень никого не понижает.
// PAY_BASIS_PERFORMED_V1 (владелец, 26.09) — считаются и платятся строки
// ВЫПОЛНЕННЫЕ (начатые/завершённые врачом), оплачены они или нет; прежде
// номер получала и оплаченная, но не начатая строка.
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
function clinic({ pct = 30, tierFrom = 25, tierPct = 40, fix = null, taxRate = 0, from2 = 0, pct2 = 0, from3 = 0, pct3 = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const rates = JSON.stringify([{ service_id: 1, pct, ...(fix == null ? {} : { fix }) }]);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, service_rates)
              VALUES (1,'doc','x','doctor','Доктор Д.', ?)`).run(rates);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare('INSERT INTO services (id, name, price, tax_rate, doctor_tier_from, doctor_tier_percent) VALUES (1,?,?,?,?,?)')
    .run('Приём', 100000, taxRate, tierFrom, tierPct);
  // DOCTOR_TIER_V2 — ступени 2 и 3 (миграция 147).
  db.prepare('UPDATE services SET doctor_tier_from_2 = ?, doctor_tier_percent_2 = ?, doctor_tier_from_3 = ?, doctor_tier_percent_3 = ? WHERE id = 1')
    .run(from2, pct2, from3, pct3);
  let seq = 0;
  // Одна строка = один визит с одной услугой; paid → счёт с датой дня и статусом invoiceStatus.
  // `at` — полная отметка времени визита вместо дня: месяц ступени считается по
  // МЕСТНОМУ времени, и проверить границу месяца можно только часами, а не днём.
  // Счёт при этом живёт своей датой (`day`): платят и лечат не в одну секунду.
  // PAY_BASIS_PERFORMED_V1 — по умолчанию строка ВЫПОЛНЕНА (прежде 'added':
  // тогда номер и долю давала оплата счёта).
  const line = ({ day = '2026-09-05', at = null, status = 'completed', paid = true, invoiceStatus = 'paid', qty = 1, price = 100000 } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date) VALUES (?,1,?)').run(id, at || (day + 'T09:00:00Z'));
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

// PAY_BASIS_PERFORMED_V1 — было: «оплаченная, но ещё не начатая строка
// считается в нумерации» (26 оплаченных 'added' → 25 × 30 000 + 40 000). Теперь
// такая строка не выполнена: ни номера, ни доли.
test('оплаченная, но ещё не начатая строка номера не занимает и не платит', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'added' });   // оплачена, не начата
  c.lines(25);                                       // номера 1..25
  assert.equal(fee(c.db), 25 * 30000);
});

// Было: «занимает номер, но не оплачивается» (24 × 30 000 + 40 000). Теперь
// начатая строка без счёта платит по цене, которую выставит счёт (100 000).
test('начатая, но не оплаченная строка занимает номер и оплачивается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'in_progress', paid: false });   // номер 1
  c.lines(25);                                                          // номера 2..26
  assert.equal(fee(c.db), 25 * 30000 + 40000);
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
// PAY_BASIS_PERFORMED_V1 — было 24 × 30 000 + 40 000 (номер без доли):
// теперь взятый материал — выполненная работа, и строка без счёта платит.
test('лабораторная строка считается с момента взятия материала', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'collected', paid: false });   // номер 1
  c.lines(25);                                                       // номера 2..26
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('лабораторная строка с внесённым результатом тоже считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'resulted', paid: false });    // номер 1
  c.lines(25);                                                       // номера 2..26
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('строка в очереди на забор (queued) без оплаты не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'queued', paid: false });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

// PAY_BASIS_PERFORMED_V1 — строка ВЫПОЛНЕНА (прежде 'added'), и всё равно не
// считается: счёт отменён.
test('отменённый счёт не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'completed', invoiceStatus: 'void' });
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

// CLINIC_DAY_V1 + DOCTOR_TIER_V1 — ГРАНИЦА МЕСЯЦА ПРОХОДИТ ПО МЕСТНОЙ ПОЛУНОЧИ.
//
// В базе всё лежит в UTC, а месяц ступени считается местный (localMonth в
// domain/day.js). На UTC+5 приём 30.09 в 20:30Z — это 01:30 первого октября:
// он открывает октябрьский счёт услуг, а не закрывает сентябрьский. Сравнение
// «в лоб», по строке UTC, отдало бы его сентябрю, и 26-я строка получила бы
// ступень на месяц раньше срока — молча и ровно раз в месяц.
//
// PAY_BASIS_PERFORMED_V1 — прежде здесь закреплялось, что у зарплатного отчёта
// и у нумерации РАЗНЫЕ даты (отчёт платил по дате СЧЁТА). Теперь дата одна:
// выплата идёт по дню ВЫПОЛНЕНИЯ — у амбулаторной строки это день визита, тот
// же, по которому считается месяц ступени. Ночной приём 01:30 01.10 платится в
// ОКТЯБРЕ, первой октябрьской строкой, по базовому проценту, — хотя счёт
// оплачен днём 30.09.
test('граница месяца — по местному времени клиники: 30.09 20:30Z — это уже октябрь при UTC+5', (t) => {
  const AT = '2026-09-30T20:30:00Z';      // визит: 01:30 01.10 при UTC+5
  const INV_DAY = '2026-09-30';           // счёт: 10:00Z, то есть 15:00 30.09 при UTC+5
  const p2 = (n) => String(n).padStart(2, '0');
  const localYmd = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };

  const c = clinic();
  c.lines(25);                                   // 25 сентябрьских строк, номера 1..25
  c.line({ at: AT, day: INV_DAY });              // спорная строка

  // Ожидание ВЫВОДИТСЯ из часового пояса машины: на UTC+5 (рабочий пояс клиник)
  // это октябрьская №1 по базовым 30 %, на поясе, где 20:30Z ещё сентябрь, — это
  // сентябрьская №26 по ступени 40 %. Жёсткое число здесь падало бы не на
  // ошибке, а на чужом часовом поясе.
  const visitYm = localYmd(AT).slice(0, 7);
  const invDay = localYmd(INV_DAY + 'T10:00:00Z');
  if (!(invDay >= SEP.from && invDay <= SEP.to)) {
    t.skip('часовой пояс машины уводит и дату счёта из сентября (' + invDay + ') — граница здесь не проверяется');
    return;
  }
  const inSeptember = visitYm === '2026-09';
  if (new Date().getTimezoneOffset() === -300) {
    assert.equal(inSeptember, false,
      'на UTC+5 ночной приём 01:30 01.10 обязан быть первым ОКТЯБРЬСКИМ, а не 26-м сентябрьским');
  }
  // Сентябрь: 25 строк; спорная — 26-я по ступени, только если визит сентябрьский.
  assert.equal(fee(c.db), 25 * 30000 + (inSeptember ? 40000 : 0),
    'месяц ступени посчитан не по местному времени: визит попал в ' + visitYm);
  // Октябрь: спорная строка — первая октябрьская, по базовым 30 %.
  assert.equal(fee(c.db, { from: '2026-10-01', to: '2026-10-31' }), inSeptember ? 0 : 30000,
    'строка выплаты не в месяце своего визита — выплата идёт по дню выполнения');
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

// DOCTOR_TIER_V1 — ПРАВИЛО: позиции спрашиваются ОДНИМ запросом за диапазон
// месяцев, а не по одному запросу на месяц. Цикл по месяцам на «за 12 месяцев»
// это двенадцать запросов подряд. Месяц строки едет в ответе (ym), чтобы
// кабинет сам разложил строки по месяцам.
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

// ---------------------------------------------------------------------------
// DOCTOR_TIER_V2 — три ступени. Пример владельца: ступень 1 — 25 → 40 %,
// ступень 2 — 50 → 45 %, ступень 3 — 100 → 50 %. Строки 1–25 — личные 30 %,
// 26–50 — 40 %, 51–100 — 45 %, 101+ — 50 %.
const THREE = { from2: 50, pct2: 45, from3: 100, pct3: 50 };

test('V2: три ступени — строки по всем четырём полосам', () => {
  const c = clinic(THREE); c.lines(102);
  assert.equal(fee(c.db), 25 * 30000 + 25 * 40000 + 50 * 45000 + 2 * 50000);
});

test('V2: ровно на пороге ступени 2 — ещё ступень 1', () => {
  const c = clinic(THREE); c.lines(50);
  assert.equal(fee(c.db), 25 * 30000 + 25 * 40000);
  c.line();
  assert.equal(fee(c.db), 25 * 30000 + 25 * 40000 + 45000);
});

test('V2: строка с количеством 4 через два порога делится по единицам', () => {
  const c = clinic({ from2: 26, pct2: 45, from3: 27, pct3: 50 });
  c.lines(24);
  c.line({ qty: 4 });   // running 24 → 28: №25 30 %, №26 40 %, №27 45 %, №28 50 %
  assert.equal(fee(c.db), 24 * 30000 + 30000 + 40000 + 45000 + 50000);
});

test('V2: фиксированная ставка — ни одна ступень не трогает', () => {
  const c = clinic({ ...THREE, fix: 15000 }); c.lines(102);
  assert.equal(fee(c.db), 102 * 15000);
});

test('V2: личный процент выше ступени побеждает на своей полосе', () => {
  // Личные 42 %: выше ступени 1 (40 %), ниже ступеней 2 и 3.
  const c = clinic({ ...THREE, pct: 42 }); c.lines(102);
  assert.equal(fee(c.db), 50 * 42000 + 50 * 45000 + 2 * 50000);
});

test('V2: проценты ступеней не обязаны расти — платится доля своей полосы', () => {
  const c = clinic({ tierPct: 50, from2: 50, pct2: 35, from3: 0, pct3: 0 }); c.lines(52);
  assert.equal(fee(c.db), 25 * 30000 + 25 * 50000 + 2 * 35000);
});

test('V2: одна ступень — прежние цифры (регресс)', () => {
  const c = clinic(); c.lines(102);
  assert.equal(fee(c.db), 25 * 30000 + 77 * 40000);
});

test('V2: doctor_tier_positions отдаёт единицы по полосам, деньги сходятся с отчётом', () => {
  const c = clinic({ from2: 26, pct2: 45, from3: 27, pct3: 50 });
  c.lines(24); c.line({ qty: 4 }); c.lines(2);
  const { rows } = doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user);
  const big = rows[24];
  assert.equal(big.units, 4);
  assert.equal(big.units_above, 3);     // за порогом 1
  assert.equal(big.units_above_2, 2);   // за порогом 2
  assert.equal(big.units_above_3, 1);   // за порогом 3
  assert.equal(big.tier_from_2, 26);
  assert.equal(big.tier_percent_2, 45);
  assert.equal(big.tier_from_3, 27);
  assert.equal(big.tier_percent_3, 50);
  const P = 30;
  const money = rows.reduce((s, r) => {
    const a1 = r.units_above, a2 = r.units_above_2, a3 = r.units_above_3;
    const pct = (P * (r.units - a1) + Math.max(P, r.tier_percent) * (a1 - a2)
      + Math.max(P, r.tier_percent_2) * (a2 - a3) + Math.max(P, r.tier_percent_3) * a3) / r.units;
    return s + 100000 * r.units * pct / 100;
  }, 0);
  assert.equal(money, fee(c.db));
});

// DOCTOR_TIER_V2 (правка ревью) — страховка SQL проверяет не только порядок,
// но и пары: порог ступени 2 без доли не должен платить полосу 2 по личной
// ставке, НИЖЕ ступени 1. Такая ступень — «нет», как и все следующие.
test('V2: ступень 2 с порогом, но без доли — «нет», полоса идёт по ступени 1', () => {
  const c = clinic({ from2: 26, pct2: 0, from3: 0, pct3: 0 });
  c.lines(27);
  assert.equal(fee(c.db), 25 * 30000 + 2 * 40000);
  const d = clinic({ from2: 26, pct2: 0, from3: 27, pct3: 50 });
  d.lines(28);
  assert.equal(fee(d.db), 25 * 30000 + 3 * 40000, 'ступень 3 за сломанной ступенью 2 тоже не действует');
  const { rows } = doctorTierPositions(d.db, { doctor_id: 1, month: '2026-09' }, user);
  assert.ok(rows.every((r) => r.tier_from_2 === 0 && r.tier_from_3 === 0 && r.units_above_2 === 0 && r.units_above_3 === 0));
});
