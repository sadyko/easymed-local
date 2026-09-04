// ACCOMMODATION_AS_SERVICE_V1 — проживание становится услугой ТОЛЬКО по кнопке.
//
// Раньше выписка сама считала проживание и, если сумма выходила больше нуля,
// молча выставляла ОТДЕЛЬНЫЙ счёт. У клиники не было способа не брать за койку
// денег: приходилось ставить скидку 100% или править счёт после выписки.
//
// Теперь проживание — обычная строка стационара (admission_services), которая
// появляется только когда её внесли, и уходит в общий счёт госпитализации
// вместе с процедурами и расходниками. Не внесли — не выставили.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admitPatient, dischargePatient, setAdmissionDiscount } from './inpatient.js';
import { billAccommodation, unbillAccommodation } from './accommodation.js';

const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Касса' };
const LAB   = { id: 5, role: 'lab', full_name: 'Лаборант' };

// Койка со ставкой 200 000/день; пациент лежит со вчера -> 1 сутки к оплате.
function seed({ daysAgo = 1 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'n','x','nurse','Медсестра')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (9,'c','x','cashier','Касса')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wid = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Палата 1','daily',200000)").run().lastInsertRowid;
  const bid = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'B-1','free',0)").run(wid).lastInsertRowid;
  const adm = admitPatient(db, { patient_id: pid, bed_id: bid }, NURSE).admission;
  db.prepare("UPDATE admissions SET admitted_at = datetime('now', ?) WHERE id = ?").run('-' + daysAgo + ' days', adm.id);
  return { db, adm, pid, wid, bid };
}
const lines = (db, admId) => db.prepare('SELECT * FROM admission_services WHERE admission_id = ?').all(admId);

test('внесение проживания создаёт строку стационара с койкой и ставкой', () => {
  const { db, adm, wid, bid } = seed({ daysAgo: 2 });
  const res = billAccommodation(db, { admission_id: adm.id }, NURSE);

  const rows = lines(db, adm.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ward_id, wid);
  assert.equal(rows[0].bed_id, bid);
  assert.equal(rows[0].quantity, 2, 'двое суток');
  assert.equal(rows[0].unit_price, 200000);
  assert.equal(rows[0].total, 400000);
  assert.equal(res.line.total, 400000);
  db.close();
});

// Главное в этой задаче: не внесли — денег не берут.
test('без внесения выписка НЕ создаёт счёт за проживание', () => {
  const { db, adm } = seed();
  const out = dischargePatient(db, { admission_id: adm.id }, NURSE);
  assert.equal(out.admission.invoice_id, null, 'счёт за проживание больше не выставляется сам');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, 0);
  db.close();
});

test('внесённое проживание переживает выписку и остаётся строкой к оплате', () => {
  const { db, adm } = seed();
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  dischargePatient(db, { admission_id: adm.id }, NURSE);
  const rows = lines(db, adm.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoice_item_id, null, 'счёт по стационару выставляет касса, а не выписка');
  db.close();
});

// Скидка на проживание — та же, что уже хранится на госпитализации.
test('скидка применяется при внесении', () => {
  const { db, adm } = seed({ daysAgo: 2 });
  setAdmissionDiscount(db, { admission_id: adm.id, percent: 25 }, CASH);
  const res = billAccommodation(db, { admission_id: adm.id }, NURSE);
  assert.equal(res.line.total, 300000, '400 000 минус 25%');
  db.close();
});

// Дважды одну койку не продают.
test('повторное внесение не плодит строки, а обновляет сумму', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  db.prepare("UPDATE admissions SET admitted_at = datetime('now','-4 days') WHERE id = ?").run(adm.id);
  const again = billAccommodation(db, { admission_id: adm.id }, NURSE);
  const rows = lines(db, adm.id);
  assert.equal(rows.length, 1, 'строка одна');
  assert.equal(rows[0].quantity, 4, 'обновилась до сегодняшнего срока');
  assert.equal(again.line.total, 800000);
  db.close();
});

test('внесённое можно убрать, пока оно не в счёте', () => {
  const { db, adm } = seed();
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  unbillAccommodation(db, { admission_id: adm.id }, NURSE);
  assert.equal(lines(db, adm.id).length, 0);
  db.close();
});

// За выставленную строку уже стоят деньги в счёте: её убирает касса своим
// путём, иначе счёт и стационар разойдутся.
test('строку, попавшую в счёт, убрать отсюда нельзя', () => {
  const { db, adm } = seed();
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  // настоящая строка счёта: invoice_item_id — внешний ключ, выдумывать id нельзя
  const invId = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, status) VALUES ('INV-T',1,1,1,'unpaid')").run().lastInsertRowid;
  const itemId = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'Проживание', 1, 1, 1)").run(invId).lastInsertRowid;
  db.prepare('UPDATE admission_services SET invoice_item_id = ? WHERE admission_id = ?').run(itemId, adm.id);
  assert.throws(() => unbillAccommodation(db, { admission_id: adm.id }, NURSE), /счёт|invoice/i);
  db.close();
});

test('роли: кто ведёт стационар — вносит; лаборант — нет', () => {
  const { db, adm } = seed();
  assert.throws(() => billAccommodation(db, { admission_id: adm.id }, LAB), /not allowed/);
  db.close();
});

// Бесплатная койка не создаёт строку на ноль: пустая позиция в счёте только
// путает кассира.
test('нулевая ставка не создаёт строку', () => {
  const { db, adm, wid } = seed();
  db.prepare('UPDATE wards SET price_per_day = 0 WHERE id = ?').run(wid);
  assert.throws(() => billAccommodation(db, { admission_id: adm.id }, NURSE), /нулев|ноль|zero/i);
  assert.equal(lines(db, adm.id).length, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// INPATIENT_FLOW_V1 — САМАЯ ДОРОГАЯ ОШИБКА ЭТОЙ ЗАДАЧИ, если её допустить.
//
// До миграции 091 «пациент в койке» значило ровно status='active'. Теперь между
// поступлением и лечением стоят два шага: пациент лежит в 'admitted' (медсестра
// положила), потом в 'examined' (главный врач осмотрел), и только потом в
// 'active'. Всё это время койка занята и деньги за неё идут.
//
// Оставь мы где-нибудь проверку «только active» — клиника молча перестала бы
// брать за первые сутки, и заметила бы это не на экране, а в конце месяца.
// Поэтому проверяется прямо: проживание вносится в КАЖДОМ состоянии, в котором
// пациент лежит, и одинаковой суммой.
test('проживание начисляется в КАЖДОМ состоянии «в койке», а не только в active', async () => {
  const { IN_BED_STATUSES } = await import('./inpatient-flow.js');
  assert.deepEqual(IN_BED_STATUSES, ['admitted', 'examined', 'active', 'discharging'],
    'список «в койке» изменился — этот тест обязан измениться вместе с ним');

  for (const status of IN_BED_STATUSES) {
    const { db, adm } = seed({ daysAgo: 2 });
    db.prepare('UPDATE admissions SET status = ? WHERE id = ?').run(status, adm.id);

    const res = billAccommodation(db, { admission_id: adm.id }, NURSE);
    assert.equal(res.line.quantity, 2, status + ': двое суток должны быть посчитаны');
    assert.equal(res.line.total, 400000, status + ': сумма не зависит от шага маршрута');
    assert.equal(lines(db, adm.id).length, 1, status + ': ровно одна строка проживания');
    db.close();
  }
});

// Тот же вопрос с другой стороны: пациент, которого только что положили и ещё
// не осмотрели, — обычный лежащий пациент, и карточка обязана показать ему счёт
// за койку так же, как лечащемуся.
test('карточка показывает начисление поступившему, но ещё не осмотренному', async () => {
  const { accommodationState } = await import('./accommodation.js');
  const { db, adm } = seed({ daysAgo: 3 });
  db.prepare("UPDATE admissions SET status = 'admitted' WHERE id = ?").run(adm.id);

  const st = accommodationState(db, { admission_id: adm.id }, NURSE);
  assert.equal(st.stay_units, 3, 'лежит трое суток с момента поступления');
  assert.equal(st.current.units, 3, 'и все трое ещё не выставлены');
  assert.equal(st.current.net, 600000);
  db.close();
});
