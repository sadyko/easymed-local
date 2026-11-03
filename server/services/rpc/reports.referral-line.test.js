// REFERRAL_LINE_V1 — вознаграждение за направление ПО СТРОКЕ (решение владельца 2026-11-02 —
// «обоим»): источник визита/пациента получает своё, источник строки визита — своё, если он
// другой; тот же источник — один раз; своя строка врача — без бонуса; закрытый месяц не
// двигается. Одни строки на «Рефералы», детализацию, кабинет врача и «Зарплаты врачей».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorReferralReward, doctorPaySummary, payPeriodClose, __setReportsPushDown } from './reports.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-08-01';
const TO = '2026-08-31';

// Врач 1 «Направлялов» направляет (внутренний источник S1, категория «Внутренние врачи» 5 %),
// врач 2 «Узистов» исполняет УЗИ 200 000; партнёр «Клиника Х» (категория «Партнёры» 10 %).
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'ref', 'x', 'doctor', 'Направлялов Н.Н.', 1);
  u.run(2, 'uzi', 'x', 'doctor', 'Узистов У.У.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  const internalCat = db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  db.prepare('UPDATE referral_source_categories SET standard_percent = 5 WHERE id = ?').run(internalCat);
  const extCat = Number(db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid);
  const P = Number(db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Х', ?)").run(extCat).lastInsertRowid);
  const S1 = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2, 'УЗИ', 200000, 'imaging')").run();
  return { db, S1, P, internalCat };
}
let N = 0;
const patient = (db, name, src = null) => Number(db.prepare('INSERT INTO patients (full_name, referral_source_id) VALUES (?, ?)').run(name, src).lastInsertRowid);
// Счёт на одну строку визита (УЗИ 200 000, исполнитель performer) от 05.08.2026.
function line(db, { pt, visitSource = null, lineSource = null, performer = 2, status = 'paid' }) {
  N += 1;
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, referral_source_id) VALUES (?, '2026-08-05T09:00:00Z', ?)").run(pt, visitSource).lastInsertRowid);
  const inv = Number(db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                                 VALUES (?, ?, ?, 200000, 0, 200000, ?, ?, '2026-08-05T10:00:00Z')`)
    .run('INV-L' + N, vid, pt, status === 'paid' ? 200000 : 0, status).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 2, 'УЗИ', 1, 200000, 200000)").run(inv).lastInsertRowid);
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id, referred_by_source_id)
              VALUES (?, 2, ?, 1, 200000, 200000, 'completed', ?, ?)`).run(vid, performer, item, lineSource);
  return { vid, inv, item };
}
const run = (db, kind, extra = {}) => runReport(db, { kind, from: FROM, to: TO, ...extra }, admin);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const bySource = (db, kind = 'referrals') => Object.fromEntries(objects(run(db, kind)).map((o) => [o['Источник'], o]));

test('направление в день, когда визит уже был (у визита источника нет): строка со своим источником — бонус врачу', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Азизов'), lineSource: S1 });
  const own = bySource(db)['Направлялов Н.Н.'];
  assert.ok(own, 'направивший строки не попал в «Рефералы»');
  assert.equal(own['Вид'], 'Внутренний');
  assert.equal(own['Услуг'], 1);
  assert.equal(own['Вознаграждение'], 10000);   // 5 % от 200 000
});

test('партнёр пациента + врач строки — оба, каждый по своей ставке', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  const rows = bySource(db);
  assert.equal(rows['Клиника Х']['Вознаграждение'], 20000);
  assert.equal(rows['Направлялов Н.Н.']['Вознаграждение'], 10000);
  assert.ok(run(db, 'referrals').notes.some((n) => n.includes('получают оба')), 'правило «обоим» не объяснено под отчётом');
});

test('врач — источник и визита, и строки: платится один раз', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Валиев'), visitSource: S1, lineSource: S1 });
  const rows = objects(run(db, 'referrals'));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]['Источник'], rows[0]['Услуг'], rows[0]['Вознаграждение']], ['Направлялов Н.Н.', 1, 10000]);
  assert.equal(objects(run(db, 'referrals_detail')).length, 1);
});

test('своя строка врача (он же исполнитель) — без бонуса', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Гафуров'), lineSource: S1, performer: 1 });
  assert.deepEqual(objects(run(db, 'referrals')), []);
});

test('неоплаченный счёт — в суммах, но без вознаграждения', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Давлатов'), lineSource: S1, status: 'unpaid' });
  const own = bySource(db)['Направлялов Н.Н.'];
  assert.deepEqual([own['Сумма услуг'], own['Оплачено'], own['Вознаграждение']], [200000, 0, 0]);
});

test('кабинет врача, «Зарплаты врачей» и «Рефералы» — одна сумма', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  line(db, { pt: patient(db, 'Азизов'), lineSource: S1 });
  const report = bySource(db)['Направлялов Н.Н.']['Вознаграждение'];
  assert.equal(report, 20000);
  assert.equal(doctorReferralReward(db, { doctor_id: 1, from: FROM, to: TO }, admin).reward, report);
  assert.equal(doctorPaySummary(db, { doctor_id: 1, from: FROM, to: TO }, admin).referral.reward, report);
});

test('закрытый месяц не меняется: правка ставки после закрытия не двигает ни врача строки, ни партнёра', () => {
  const { db, S1, P, internalCat } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  payPeriodClose(db, { month: '2026-08' }, admin);
  db.prepare('UPDATE referral_source_categories SET standard_percent = 50 WHERE id = ?').run(internalCat);
  const rows = bySource(db);
  assert.equal(rows['Направлялов Н.Н.']['Вознаграждение'], 10000);
  assert.equal(rows['Клиника Х']['Вознаграждение'], 20000);
  assert.equal(doctorReferralReward(db, { doctor_id: 1, from: FROM, to: TO }, admin).reward, 10000);
});

// Ревью U10 MEDIUM-4 (вариант «б»): два внешних партнёра за одну строку не платятся — строка
// остаётся за партнёром визита (или карточки пациента); «Кто направил» стойки у новой строки к
// нему не добавляется. Врач строки — по-прежнему сверху (правило «обоим»).
test('MEDIUM-4 (вариант «б»): партнёр визита или пациента + партнёр строки — платится партнёр визита/пациента', () => {
  const { db, S1, P } = seed();
  const extCat = db.prepare('SELECT category_id c FROM referral_sources WHERE id = ?').get(P).c;
  const Q = Number(db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Б', ?)").run(extCat).lastInsertRowid);
  line(db, { pt: patient(db, 'Ергашев'), visitSource: P, lineSource: Q });
  line(db, { pt: patient(db, 'Жураев', P), lineSource: Q });
  line(db, { pt: patient(db, 'Зокиров'), visitSource: S1, lineSource: Q });
  const rows = objects(run(db, 'referrals_detail')).map((o) => [o['Источник'], o['Вознаграждение']]);
  assert.deepEqual(rows.filter((r) => r[0] === 'Клиника Х'), [['Клиника Х', 20000], ['Клиника Х', 20000]]);
  assert.deepEqual(rows.filter((r) => r[0] === 'Клиника Б'), [['Клиника Б', 20000]], 'партнёр строки — только там, где у визита врач, а не партнёр');
  assert.deepEqual(rows.filter((r) => r[0] === 'Направлялов Н.Н.'), [['Направлялов Н.Н.', 10000]]);
});

// Ревью U10 LOW-6: примечание не обещает больше, чем делает расчёт. Врач — источник ВИЗИТА — за
// свою услугу вознаграждение получает (прежнее правило визита); «за свою услугу не получает» —
// только направивший СТРОКИ.
test('LOW-6: примечание «обоим» — правило своей строки названо для направившего строки, а не для любого врача', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  line(db, { pt: patient(db, 'Валиев'), visitSource: S1, performer: 1 });
  const rep = run(db, 'referrals_detail');
  assert.deepEqual(objects(rep).filter((o) => o['Источник'] === 'Направлялов Н.Н.').map((o) => o['Вознаграждение']), [10000, 10000],
    'стенд: врач — источник визита — получает и за свою услугу (правило визита не менялось)');
  assert.ok(!rep.notes.some((n) => n.includes('за свою услугу врач вознаграждения не получает')), 'примечание обещает правило, которого нет у источника визита');
  assert.ok(rep.notes.some((n) => n.includes('получают оба') && n.includes('по этой строке')), 'правило своей строки — для направившего строки: ' + JSON.stringify(rep.notes));
});

test('push-down и без него — одни и те же строки вознаграждения', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  line(db, { pt: patient(db, 'Валиев'), visitSource: S1, lineSource: S1 });
  line(db, { pt: patient(db, 'Гафуров'), lineSource: S1, performer: 1 });
  const fast = JSON.stringify(objects(run(db, 'referrals_detail')));
  __setReportsPushDown(false);
  try { assert.equal(JSON.stringify(objects(run(db, 'referrals_detail'))), fast); }
  finally { __setReportsPushDown(true); }
});
