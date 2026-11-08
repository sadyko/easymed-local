// REFERRAL_FULL_PRICE_V1 (3.22.0, владелец 2026-11-08: «discount not applied to the
// partners share — full price, always») — ВОЗНАГРАЖДЕНИЕ ЗА НАПРАВЛЕНИЕ СКИДКОЙ НЕ
// УМЕНЬШАЕТСЯ. Одно правило для всех источников: внешние партнёры, представители и
// свои врачи-направившие (амбулатория и стационар):
//   • процент — от цены строки ДО скидки: УЗИ 200 000, скидка 20 % (пациент платит
//     160 000), партнёр 10 % → 20 000 (было 16 000);
//   • скидка 100 % (бесплатно для пациента): счёт закрыт при выставлении, как
//     оплаченный, — партнёру всё равно 10 % от 200 000 = 20 000; отменённый и
//     неоплаченный счёт — ничего, как прежде;
//   • фикс за услугу скидкой не уменьшается (70 000 и при 20 %, и при 100 %);
//   • ВОЗВРАТ — не скидка: вернули половину денег — половина вознаграждения, как
//     прежде, и тем путём, что касса предлагает по умолчанию («скидка после продажи»:
//     сумма счёта уменьшается до оплаченного), и «с доплатой» (reopen_balance);
//   • закрытые месяцы — как записаны: месяц, закрытый до решения, не пересчитывается
//     и не даёт корректировки от смены правила.
// ВЛАДЕЛЕЦ (2026-11-08, второе решение): правило — «с дня обновления». Счета,
// выставленные ДО того, как клиника поставила 3.22.0 (мигр. 283 записывает этот
// момент, если счета в базе уже есть), считаются по прежнему правилу — прошлые суммы
// не меняются ни на одном экране, в закрытых и в открытых месяцах. У новой базы
// (и у тестов выше, которые сеют счета после migrate()) отметки нет — новое правило
// для всех счетов.
// Всё — через настоящие RPC кассы и настоящие отчёты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { runReport, doctorPaySummary, doctorReferralReward, payPeriodClose } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission, recordPayment, refundPayment } from './billing.js';
import { voidInvoice } from './cashier.js';
import { referralsDoctorDetail } from './referrals.js';
import { today } from '../domain/day.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

const admin = { id: 9, role: 'admin' };
const round2 = (n) => Math.round(n * 100) / 100;
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (list, col) => round2(list.reduce((n, o) => n + (Number(o[col]) || 0), 0));

function months(db) {
  const cur = today(db).slice(0, 7);
  const back = (m) => {
    let y = Number(m.slice(0, 4)); let mm = Number(m.slice(5, 7)) - 1;
    if (mm < 1) { mm = 12; y -= 1; }
    return y + '-' + String(mm).padStart(2, '0');
  };
  const prev = back(cur);
  return { cur, prev, prev2: back(prev) };
}
const lastDay = (m) => m + '-' + String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
const range = (m) => ({ from: m + '-01', to: lastDay(m) });
const run = (db, kind, rng, extra = {}) => runReport(db, { kind, ...rng, ...extra }, admin);
const refRows = (db, rng, extra) => objects(run(db, 'referrals', rng, extra));
const rewardOf = (rows, source, where) => sum(rows.filter((o) => o['Источник'] === source && (!where || o['Где'] === where)), 'Вознаграждение');
const salaryOf = (db, rng, col, name = 'Направляев Н.') => {
  const o = objects(run(db, 'doctor_salaries', rng)).find((x) => x['Врач'] === name);
  return o ? (Number(o[col]) || 0) : 0;
};

// Врач 1 «Узистов» — исполнитель УЗИ (без своей ставки: здесь важна только доля
// направившего). Врач 2 «Направляев» — свой врач-направивший: его внутренний источник,
// своя ставка 5 %. «Клиника Х» — внешний партнёр, категория «Партнёры» 10 %.
// «Фикс-партнёр» — та же категория и особая ставка за УЗИ: фикс 70 000.
// Пациент 1 — от «Клиники Х», 2 — от Направляева, 3 — от «Фикс-партнёра».
//
// upgrading: база клиники ДО обновления (все миграции ниже 283); c.upgrade() ставит
// 3.22.0 — мигр. 283 записывает момент обновления, если счета уже есть.
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
function clinic({ upgrading = false } = {}) {
  const db = openDb(':memory:');
  if (upgrading) {
    const stage = tmpDir('em-rfp-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 283 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
  } else migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,'',0)`);
  u.run(1, 'uzi', 'x', 'doctor', 'Узистов У.', 1);
  u.run(2, 'napr', 'x', 'doctor', 'Направляев Н.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1, 'УЗИ', 200000, 0, 'imaging')").run();
  let own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get();
  if (!own) own = { id: db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев Н.', 2)").run().lastInsertRowid };
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 5, own_rates = '[]' WHERE id = ?").run(own.id);
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid;
  const partner = Number(db.prepare("INSERT INTO referral_sources (name, code, category_id) VALUES ('Клиника Х', 'KX', ?)").run(cat).lastInsertRowid);
  const fixer = Number(db.prepare("INSERT INTO referral_sources (name, code, category_id, service_rates) VALUES ('Фикс-партнёр', 'FP', ?, ?)")
    .run(cat, JSON.stringify([{ service_id: 1, unit: 'fix', value: 70000 }])).lastInsertRowid);
  const pt = db.prepare('INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (?,?,?,?)');
  pt.run(1, 'P-1', 'Пациент партнёра', partner);
  pt.run(2, 'P-2', 'Пациент врача', own.id);
  pt.run(3, 'P-3', 'Пациент фикс-партнёра', fixer);
  let seq = 0;
  // Выполненное УЗИ пациента patient в день at (без счёта).
  const line = ({ at, patient }) => {
    const id = ++seq;
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?, 'scheduled')").run(id, patient, at);
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,1,1,1,200000,200000,'completed')`).run(id, id);
    return id;
  };
  // Счёт на строку со скидкой discount (сум), датированный днём строки (период — по дате счёта).
  const bill = (id, at, discount = 0) => {
    const extra = discount > 0 ? { discount_amount: discount, discount_choice: 'manual' } : { discount_amount: 0 };
    const inv = createInvoiceForVisit(db, { visit_id: id, visit_service_ids: [id], ...extra }, admin).invoice;
    if (at) db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(at, inv.id);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  };
  const pay = (inv, amount = inv.total_amount) => {
    recordPayment(db, { invoice_id: inv.id, amount, method: 'cash' }, admin);
    return db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').get(inv.id).id;
  };
  // Счёт пациента patient со скидкой 20 % (40 000), оплачен целиком; id платежа.
  const paidWith20 = (at, patient) => {
    const inv = bill(line({ at, patient }), at, 40000);
    assert.equal(inv.total_amount, 160000, 'скидка 20 % не легла на счёт');
    return { inv, payment: pay(inv) };
  };
  const upgrade = () => migrate(db);   // клиника ставит 3.22.0 (мигр. 283)
  return { db, line, bill, pay, paidWith20, partner, fixer, own: own.id, upgrade };
}

// ─── ПРОЦЕНТ — ОТ ЦЕНЫ ДО СКИДКИ ─────────────────────────────────────────────

test('процент — от цены до скидки: УЗИ 200 000, скидка 20 %, партнёр 10 % → 20 000; свой врач 5 % → 10 000 — везде одно число', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-02T09:00:00Z';
  c.paidWith20(at, 1);
  c.paidWith20(at, 2);
  const rows = refRows(c.db, range(cur));
  const x = rows.find((o) => o['Источник'] === 'Клиника Х');
  assert.equal(x['Вознаграждение'], 20000, 'партнёру — 10 % от 200 000, а не от 160 000');
  assert.equal(x['Сумма услуг'], 160000, 'деньги строки — по-прежнему после скидки');
  assert.equal(x['Оплачено'], 160000);
  assert.equal(rewardOf(rows, 'Направляев Н.'), 10000, 'своему врачу — 5 % от 200 000, а не 8 000');
  const det = objects(run(c.db, 'referrals_detail', range(cur)));
  const dx = det.find((o) => o['Источник'] === 'Клиника Х');
  assert.deepEqual([dx['Сумма после скидки'], dx['Ставка'], dx['Вознаграждение']], [160000, '10 %', 20000]);
  assert.equal(sum(det, 'Вознаграждение'), 30000, 'детализация = сводка');
  // Кабинет врача, «Зарплаты врачей», «Реферирование → Врачи» — то же число.
  assert.equal(doctorReferralReward(c.db, { doctor_id: 2, ...range(cur) }, admin).reward, 10000);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(cur) }, admin).referral.reward, 10000);
  assert.equal(salaryOf(c.db, range(cur), 'Вознаграждение за направления'), 10000);
  assert.equal(referralsDoctorDetail(c.db, { doctor_id: 2, ...range(cur) }, admin).reward, 10000);
  // Правило названо словами под отчётом — и переведено.
  const notes = run(c.db, 'referrals', range(cur)).notes;
  assert.ok(notes.some((n) => /цены строки счёта до скидки/.test(n)), 'примечание не называет базу «до скидки»: ' + notes.join(' | '));
  assert.ok(!notes.some((n) => /от суммы строки счёта после скидки/.test(n)), 'старое правило осталось в примечании');
});

test('скидка 100 %: счёт закрыт при выставлении — партнёру 10 % от 200 000 = 20 000; отменённый и неоплаченный — ничего', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-03T09:00:00Z';
  const free = c.bill(c.line({ at, patient: 1 }), at, 200000);
  assert.deepEqual([free.total_amount, free.status], [0, 'paid'], 'счёт со скидкой 100 % закрывается как оплаченный');
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 20000);
  const det = objects(run(c.db, 'referrals_detail', range(cur))).find((o) => o['Источник'] === 'Клиника Х');
  assert.deepEqual([det['Сумма после скидки'], det['Вознаграждение']], [0, 20000]);
  // Неоплаченный счёт (без скидки) — по-прежнему ничего.
  c.bill(c.line({ at, patient: 1 }), at);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 20000, 'неоплаченный счёт принёс вознаграждение');
  // Отменённый бесплатный счёт — ничего.
  voidInvoice(c.db, { invoice_id: free.id, reason: 'ошибка' }, admin);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 0, 'отменённый счёт принёс вознаграждение');
});

// ─── ФИКС ────────────────────────────────────────────────────────────────────

test('фикс 70 000 за услугу скидкой не уменьшается — ни 20 %, ни 100 %', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-04T09:00:00Z';
  c.paidWith20(at, 3);
  c.bill(c.line({ at, patient: 3 }), at, 200000);
  const det = objects(run(c.db, 'referrals_detail', range(cur))).filter((o) => o['Источник'] === 'Фикс-партнёр');
  assert.deepEqual(det.map((o) => [o['Сумма после скидки'], o['Вознаграждение']]), [[160000, 70000], [0, 70000]]);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Фикс-партнёр'), 140000);
});

// ─── ВОЗВРАТ — НЕ СКИДКА ─────────────────────────────────────────────────────

test('вернули половину денег — половина вознаграждения, как прежде: и обычным возвратом кассы («скидка после продажи»), и с доплатой', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-05T09:00:00Z';
  // Процент: два счёта «Клиники Х» по 160 000 (скидка 20 %), по каждому вернули 80 000.
  const a = c.paidWith20(at, 1);
  const b = c.paidWith20(at, 1);
  // Фикс: два счёта «Фикс-партнёра», то же самое.
  const f1 = c.paidWith20(at, 3);
  const f2 = c.paidWith20(at, 3);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 40000);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Фикс-партнёр'), 140000);
  refundPayment(c.db, { payment_id: a.payment, amount: 80000, reason: 'половина' }, admin);
  refundPayment(c.db, { payment_id: b.payment, amount: 80000, reason: 'половина', reopen_balance: true }, admin);
  refundPayment(c.db, { payment_id: f1.payment, amount: 80000, reason: 'половина' }, admin);
  refundPayment(c.db, { payment_id: f2.payment, amount: 80000, reason: 'половина', reopen_balance: true }, admin);
  const ps = c.db.prepare('SELECT total_amount, post_sale_discount, status FROM invoices WHERE id = ?');
  assert.deepEqual({ ...ps.get(a.inv.id) }, { total_amount: 80000, post_sale_discount: 80000, status: 'paid' }, 'обычный возврат — «скидка после продажи»');
  assert.equal(ps.get(b.inv.id).status, 'partial', 'возврат с доплатой — счёт ждёт доплаты');
  const det = objects(run(c.db, 'referrals_detail', range(cur)));
  assert.deepEqual(det.filter((o) => o['Источник'] === 'Клиника Х').map((o) => o['Вознаграждение']), [10000, 10000],
    'процент: половина от 20 000 — одинаково обоими путями возврата');
  assert.deepEqual(det.filter((o) => o['Источник'] === 'Фикс-партнёр').map((o) => o['Вознаграждение']), [35000, 35000],
    'фикс: половина от 70 000 — «скидка после продажи» здесь — возврат денег, а не скидка');
});

// ─── СТАЦИОНАР — ТО ЖЕ ПРАВИЛО ───────────────────────────────────────────────

test('стационар: процент партнёра и своего врача — от строк счёта до скидки; фикс — целиком', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 5, inpatient_fixed = 50000 WHERE id = ?').run(c.partner);
  c.db.prepare('UPDATE users SET inpatient_referral_pct = 2, inpatient_referral_fixed = 0 WHERE id = 2').run();
  c.db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id, referring_doctor_id)
                VALUES (1, 'A-1', 1, 1, 'active', ?, 2)`).run(c.partner);
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 1, 5, 200000, 1000000, 'added', 1, ?)`).run(cur + '-06T09:00:00Z');
  const { invoice } = createInvoiceForAdmission(c.db, { admission_id: 1, admission_service_ids: [1] }, admin);
  // Скидка счёта 10 % (100 000): пациент платит 900 000.
  c.db.prepare("UPDATE invoices SET discount_amount = 100000, total_amount = 900000, paid_amount = 900000, status = 'paid' WHERE id = ?").run(invoice.id);
  const inRows = refRows(c.db, range(cur)).filter((o) => o['Где'] === 'Стационар');
  assert.equal(rewardOf(inRows, 'Клиника Х'), 50000 + 50000, 'партнёру — 5 % от 1 000 000 (не от 900 000) + фикс 50 000');
  assert.equal(rewardOf(inRows, 'Направляев Н.'), 20000, 'своему врачу — 2 % от 1 000 000, а не 18 000');
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(cur) }, admin).inpatient_referral.reward, 20000);
  const notes = run(c.db, 'referrals', range(cur)).notes;
  assert.ok(notes.some((n) => /счёта госпитализации до скидки/.test(n)), 'примечание стационара не называет базу «до скидки»');
});

// ─── ЗАКРЫТЫЕ МЕСЯЦЫ — КАК ЗАПИСАНЫ ──────────────────────────────────────────

// Запись месяца, закрытого ещё в прежней версии (до 3.22.0): те же строки, но без
// отметки reward_base, и вознаграждение — по прежнему правилу (процент — после скидки).
function asClosedBeforeDecision(db, month, oldFee) {
  for (const r of db.prepare("SELECT id, data FROM pay_period_lines WHERE month = ? AND kind IN ('ref', 'ref_in')").all(month)) {
    const d = JSON.parse(r.data);
    delete d.reward_base;
    const fee = oldFee(d);
    d.reward = fee; d.fee = fee;
    db.prepare('UPDATE pay_period_lines SET fee = ?, data = ? WHERE id = ?').run(fee, JSON.stringify(d), r.id);
  }
}
const oldRule = (d) => round2((d.amount - d.discount) * Number(d.rate.value) / 100);
// Примечание о счетах, выставленных до обновления (по прежнему правилу).
const legacyNote = (notes) => notes.find((n) => /до обновления программы до 3\.22\.0/.test(n));
const cutoffOf = (db) => (db.prepare('SELECT from_at FROM referral_full_price_from WHERE id = 1').get() || {}).from_at || null;

test('месяц, закрытый по новому правилу: 20 000 по записи; поздний обычный возврат половины — корректировка −10 000', () => {
  const c = clinic();
  const { prev, prev2 } = months(c.db);
  const at = prev2 + '-11T09:00:00Z';
  const x = c.paidWith20(at, 1);
  payPeriodClose(c.db, { month: prev2 }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 20000);
  assert.ok(refRows(c.db, range(prev)).every((o) => o['Где'] !== 'Корректировка'));
  assert.equal(legacyNote(run(c.db, 'referrals', range(prev2)).notes), undefined, 'примечание о прежнем правиле без прежних строк');
  refundPayment(c.db, { payment_id: x.payment, amount: 80000, reason: 'после закрытия' }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev)).filter((o) => o['Где'] === 'Корректировка'), 'Клиника Х'), -10000);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 20000);
});

// ─── «С ДНЯ ОБНОВЛЕНИЯ»: СЧЕТА ДО 3.22.0 — ПО ПРЕЖНЕМУ ПРАВИЛУ ─────────────────
// Владелец 2026-11-08: счета, выставленные до того, как клиника поставила 3.22.0, —
// процент от суммы после скидки, как было; счета с момента обновления — от цены до
// скидки. Прошлые суммы не меняются ни в закрытых, ни в открытых месяцах.

test('обновление: счёт до обновления — по прежнему правилу (16 000 / 8 000), месяц не закрыт; счёт после — от цены до скидки (20 000 / 10 000)', () => {
  const c = clinic({ upgrading: true });
  const { cur, prev } = months(c.db);
  const at = prev + '-15T09:00:00Z';
  c.paidWith20(at, 1);
  c.paidWith20(at, 2);
  c.upgrade();   // прежняя версия показывала по этим счетам 16 000 / 8 000 — так и остаётся
  assert.ok(cutoffOf(c.db), 'момент обновления не записан');
  const old = refRows(c.db, range(prev));
  assert.equal(rewardOf(old, 'Клиника Х'), 16000, 'счёт до обновления пересчитан по новому правилу');
  assert.equal(rewardOf(old, 'Направляев Н.'), 8000);
  assert.equal(sum(objects(run(c.db, 'referrals_detail', range(prev))), 'Вознаграждение'), 24000);
  assert.equal(doctorReferralReward(c.db, { doctor_id: 2, ...range(prev) }, admin).reward, 8000);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(prev) }, admin).referral.reward, 8000);
  assert.equal(salaryOf(c.db, range(prev), 'Вознаграждение за направления'), 8000);
  assert.equal(referralsDoctorDetail(c.db, { doctor_id: 2, ...range(prev) }, admin).reward, 8000);
  // Счета, выставленные после обновления, — новое правило.
  const nowAt = new Date().toISOString();
  c.paidWith20(nowAt, 1);
  c.paidWith20(nowAt, 2);
  const fresh = refRows(c.db, range(cur));
  assert.equal(rewardOf(fresh, 'Клиника Х'), 20000);
  assert.equal(rewardOf(fresh, 'Направляев Н.'), 10000);
  // Под отчётом — когда сменилось правило; переводится шаблоном с датой.
  const r = run(c.db, 'referrals', { from: prev + '-01', to: lastDay(cur) });
  const note = legacyNote(r.notes);
  assert.ok(note, 'не сказано, что счета до обновления — по прежнему правилу: ' + r.notes.join(' | '));
  const day = c.db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') d").get(cutoffOf(c.db)).d;
  assert.ok(note.includes(day), 'в примечании нет момента обновления ' + day + ': ' + note);
  const t = r.notes_t[r.notes.indexOf(note)];
  assert.ok(t && t.template && t.params && t.params.date === day, 'примечание без шаблона для перевода');
  // Новая база: счета «до обновления» не бывает — и примечания нет.
  const n = clinic();
  n.paidWith20(at, 1);
  assert.equal(rewardOf(refRows(n.db, range(prev)), 'Клиника Х'), 20000, 'у новой базы — новое правило для всех счетов');
  assert.equal(legacyNote(run(n.db, 'referrals', range(prev)).notes), undefined);
});

test('обновление: стационар — по тому же моменту (до — от суммы после скидки, после — от цены до скидки; фикс — как был)', () => {
  const c = clinic({ upgrading: true });
  const { cur, prev } = months(c.db);
  c.db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 5, inpatient_fixed = 50000 WHERE id = ?').run(c.partner);
  c.db.prepare('UPDATE users SET inpatient_referral_pct = 2, inpatient_referral_fixed = 0 WHERE id = 2').run();
  // Госпитализация со счётом на 1 000 000, скидка счёта 10 % (100 000), оплачен.
  const admissionBill = (id, createdAt) => {
    c.db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id, referring_doctor_id)
                  VALUES (?, ?, 1, 1, 'active', ?, 2)`).run(id, 'A-' + id, c.partner);
    c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                  VALUES (?, ?, 1, 1, 1, 5, 200000, 1000000, 'added', 1, ?)`).run(id, id, createdAt);
    const { invoice } = createInvoiceForAdmission(c.db, { admission_id: id, admission_service_ids: [id] }, admin);
    c.db.prepare("UPDATE invoices SET discount_amount = 100000, total_amount = 900000, paid_amount = 900000, status = 'paid', created_at = ? WHERE id = ?")
      .run(createdAt, invoice.id);
  };
  admissionBill(1, prev + '-15T09:00:00Z');
  c.upgrade();
  admissionBill(2, new Date().toISOString());
  const inOf = (m) => refRows(c.db, range(m)).filter((o) => o['Где'] === 'Стационар');
  assert.equal(rewardOf(inOf(prev), 'Клиника Х'), 45000 + 50000, 'до обновления: 5 % от 900 000 + фикс');
  assert.equal(rewardOf(inOf(prev), 'Направляев Н.'), 18000);
  assert.equal(rewardOf(inOf(cur), 'Клиника Х'), 50000 + 50000, 'после обновления: 5 % от 1 000 000 + фикс');
  assert.equal(rewardOf(inOf(cur), 'Направляев Н.'), 20000);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(prev) }, admin).inpatient_referral.reward, 18000);
});

test('обновление: месяц со счетами до обновления, закрытый уже в 3.22.0, — записан по прежнему правилу; корректировок нет; поздний возврат — по нему же', () => {
  const c = clinic({ upgrading: true });
  const { prev, prev2 } = months(c.db);
  const x = c.paidWith20(prev2 + '-10T09:00:00Z', 1);
  c.upgrade();
  payPeriodClose(c.db, { month: prev2 }, admin);
  const rec = JSON.parse(c.db.prepare("SELECT data FROM pay_period_lines WHERE month = ? AND kind = 'ref'").get(prev2).data);
  assert.equal(rec.reward_base, 'after_discount', 'запись не помнит, по какому правилу посчитана строка');
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 16000);
  assert.ok(refRows(c.db, range(prev)).every((o) => o['Где'] !== 'Корректировка'));
  refundPayment(c.db, { payment_id: x.payment, amount: 80000, reason: 'после закрытия', reopen_balance: true }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev)).filter((o) => o['Где'] === 'Корректировка'), 'Клиника Х'), -8000);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 16000);
});

test('обновление: месяц, закрытый ещё прежней версией (запись без отметки), — как записан (16 000 / 8 000); смена правила корректировки не даёт; поздний возврат — по правилу того месяца', () => {
  const c = clinic({ upgrading: true });
  const { prev, prev2 } = months(c.db);
  const at = prev2 + '-10T09:00:00Z';
  const x = c.paidWith20(at, 1);
  c.paidWith20(at, 2);
  payPeriodClose(c.db, { month: prev2 }, admin);
  asClosedBeforeDecision(c.db, prev2, oldRule);   // так месяц записала прежняя версия
  c.upgrade();
  const closed = refRows(c.db, range(prev2));
  assert.equal(rewardOf(closed, 'Клиника Х'), 16000, 'закрытый месяц пересчитан по новому правилу');
  assert.equal(rewardOf(closed, 'Направляев Н.'), 8000);
  assert.equal(salaryOf(c.db, range(prev2), 'Вознаграждение за направления'), 8000);
  assert.ok(legacyNote(run(c.db, 'referrals', range(prev2)).notes), 'не объяснено, почему процент — после скидки');
  // Смена правила — не событие строки: корректировок в первом открытом месяце нет.
  assert.ok(refRows(c.db, range(prev)).every((o) => o['Где'] !== 'Корректировка'), 'смена правила дала корректировку за закрытый месяц');
  assert.equal(salaryOf(c.db, range(prev), 'Корректировки'), 0);
  // Поздний возврат половины денег (с доплатой) — половина от записанных 16 000.
  refundPayment(c.db, { payment_id: x.payment, amount: 80000, reason: 'после закрытия', reopen_balance: true }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev)).filter((o) => o['Где'] === 'Корректировка'), 'Клиника Х'), -8000);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 16000, 'закрытый месяц сдвинулся');
});

test('обновление: месяц, закрытый ещё без записи партнёров (до мигр. 202), — партнёр живьём, по правилу своего счёта (16 000)', () => {
  const c = clinic({ upgrading: true });
  const { prev2 } = months(c.db);
  c.paidWith20(prev2 + '-12T09:00:00Z', 1);
  c.upgrade();
  payPeriodClose(c.db, { month: prev2 }, admin);
  c.db.prepare('UPDATE pay_periods SET partners = 0 WHERE month = ?').run(prev2);
  c.db.prepare('DELETE FROM pay_period_lines WHERE month = ? AND doctor_id IS NULL').run(prev2);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 16000, 'партнёр закрытого месяца пересчитан по новому правилу');
});

// ─── ПРИМЕЧАНИЯ — НА ТРЁХ ЯЗЫКАХ ─────────────────────────────────────────────

const noCyr = (s) => typeof s === 'string' && s.length > 0 && !/[А-Яа-яЁё]/.test(s);

test('примечания «Рефералов» о базе вознаграждения есть в словаре (и шаблон с датой обновления): uz и en — без кириллицы', () => {
  // Обновлённая база: счёт до обновления, стационар после — база, стационар, «до обновления» шаблоном.
  const c = clinic({ upgrading: true });
  const { cur, prev } = months(c.db);
  c.paidWith20(prev + '-10T09:00:00Z', 1);
  c.upgrade();
  c.db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 5 WHERE id = ?').run(c.partner);
  c.db.prepare("INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id) VALUES (1, 'A-1', 1, 1, 'active', ?)").run(c.partner);
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 1, 1, 200000, 200000, 'added', 1, ?)`).run(new Date().toISOString());
  const { invoice } = createInvoiceForAdmission(c.db, { admission_id: 1, admission_service_ids: [1] }, admin);
  c.db.prepare("UPDATE invoices SET paid_amount = total_amount, status = 'paid' WHERE id = ?").run(invoice.id);
  const r = run(c.db, 'referrals', { from: prev + '-01', to: lastDay(cur) });
  // Новая база с записью прежней версии (без момента обновления) — «до обновления» без даты.
  const f = clinic();
  const { prev2 } = months(f.db);
  f.paidWith20(prev2 + '-10T09:00:00Z', 1);
  payPeriodClose(f.db, { month: prev2 }, admin);
  asClosedBeforeDecision(f.db, prev2, oldRule);
  const s = run(f.db, 'referrals', range(prev2));
  const picked = [];
  for (const rep of [r, s]) {
    rep.notes.forEach((n, i) => {
      if (/до скидки|до обновления программы до 3\.22\.0/.test(n)) picked.push({ n, t: rep.notes_t[i] });
    });
  }
  assert.ok(picked.some((p) => /счёта госпитализации до скидки/.test(p.n)), 'нет примечания стационара');
  assert.ok(picked.some((p) => p.t && p.t.template), 'нет шаблона «до обновления» с датой');
  assert.ok(picked.some((p) => !p.t && legacyNote([p.n])), 'нет примечания «до обновления» без даты');
  for (const { n, t } of picked) {
    const key = t && t.template ? t.template : n;
    const e = STRINGS[key];
    assert.ok(e, 'нет статьи словаря: ' + key.slice(0, 80));
    assert.equal(e.ru, key);
    for (const lang of ['en', 'uz']) {
      assert.ok(noCyr(e[lang]), lang + ' с кириллицей или пуст: ' + key.slice(0, 60));
      if (t && t.template) assert.ok(e[lang].includes('{date}'), lang + ': в переводе потерян {date}');
    }
  }
});
