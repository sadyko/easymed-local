// REPRINT_SERVICE_CHECK_V1 — сбор талонов очереди для повторной печати.
//
// Логика одна и та же в трёх местах: касса печатает чек, касса печатает счёт,
// регистратура перепечатывает чек по строке услуги. Раньше она жила только
// внутри cashier-desk.js, поэтому счёт кассы очередь вообще не запрашивал.
// Здесь — чистая часть: как ответ issue_queue_numbers превращается в талоны.

import { test } from 'node:test';
import assert from 'node:assert';
import { ticketsFor } from '../views/receipt-print.js';

const VS = [
  { id: 1, services: { name: 'ОАК' } },
  { id: 2, services: { name: 'Биохимия' } },
  { id: 3, services: { name: 'Консультация ЛОРа' } },
];

test('талон получает название услуги по своей строке визита', () => {
  const out = ticketsFor(VS, [{ visit_service_id: 3, label: 'Набиев Ойбек', number: 5, queue_key: 'doc:9:d' }]);
  assert.deepStrictEqual(out, [{ service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 5, key: 'doc:9:d' }]);
});

// Все анализы одного чека — одно место в лабораторной очереди: сервер выдаёт им
// ОДИН номер. Талоны не схлопываем здесь — это делает шаблон, группируя по key.
test('услуги с общим номером сохраняются каждая со своим названием', () => {
  const out = ticketsFor(VS, [
    { visit_service_id: 1, label: 'Лаборатория', number: 10, queue_key: 'lab:d' },
    { visit_service_id: 2, label: 'Лаборатория', number: 10, queue_key: 'lab:d' },
  ]);
  assert.equal(out.length, 2);
  assert.deepStrictEqual(out.map(t => t.service), ['ОАК', 'Биохимия']);
  assert.deepStrictEqual([...new Set(out.map(t => t.number))], [10]);
});

test('строка без известной услуги не теряет талон', () => {
  const out = ticketsFor(VS, [{ visit_service_id: 99, label: 'Лаборатория', number: 4 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].service, 'Услуга');
});

test('пустой или сломанный ответ не роняет печать', () => {
  for (const bad of [null, undefined, [], 'nope', 42]) {
    assert.deepStrictEqual(ticketsFor(VS, bad), [], JSON.stringify(bad));
  }
  assert.deepStrictEqual(ticketsFor(null, [{ visit_service_id: 1, number: 2 }])[0].service, 'Услуга');
});

// --- RECEIPT_DOB_PERFORMER_V1 -----------------------------------------------
// Чек печатает, КТО оказал услугу. Роль — не украшение: по чеку идут в кабинет
// или в лабораторию, и «Лаборант» отвечает на вопрос «куда», когда у человека
// на руках несколько строк.
import { performersByItem, ROLE_RU } from '../views/receipt-print.js';

const VS_ROWS = [
  { id: 1, invoice_item_id: 10, doctor_id: { full_name: 'Юсупов О.', role: 'doctor',  specialty: 'Терапевт' } },
  { id: 2, invoice_item_id: 11, doctor_id: { full_name: 'Сулаймонов А.', role: 'lab',  specialty: '' } },
  { id: 3, invoice_item_id: 12, doctor_id: null },
];

test('исполнитель раскладывается по строкам счёта', () => {
  const by = performersByItem(VS_ROWS);
  assert.deepStrictEqual(by[10], { performer: 'Юсупов О.', performerRole: 'Врач' });
  assert.deepStrictEqual(by[11], { performer: 'Сулаймонов А.', performerRole: 'Лаборант' });
});

// Услугу может выполнять кто угодно свободный — назначенного исполнителя нет,
// и выдумывать его нельзя.
test('строка без исполнителя не попадает в карту', () => {
  assert.strictEqual(performersByItem(VS_ROWS)[12], undefined);
});

test('роли переведены, неизвестная роль не ломает печать', () => {
  assert.strictEqual(ROLE_RU.doctor, 'Врач');
  assert.strictEqual(ROLE_RU.nurse, 'Медсестра');
  assert.strictEqual(ROLE_RU.lab, 'Лаборант');
  const by = performersByItem([{ id: 9, invoice_item_id: 20, doctor_id: { full_name: 'Кто-то', role: 'wizard' } }]);
  assert.strictEqual(by[20].performer, 'Кто-то');
  assert.strictEqual(by[20].performerRole, '', 'неизвестную роль не печатаем, имя оставляем');
});

test('пустой или сломанный список не роняет печать', () => {
  for (const bad of [null, undefined, [], 'nope', 42]) {
    assert.deepStrictEqual(performersByItem(bad), {}, JSON.stringify(bad));
  }
});

// DISCOUNT_CHANGE_PAID_V1 (3.23.0) — квитанция «Изменение скидки»: скидка была и стала, причина,
// сколько вернули и куда (каждый возврат своим способом), сумма счёта и оплачено после.
import { slipData as slipDataDc } from '../views/receipt-print.js';
test('DISCOUNT_CHANGE_PAID_V1: квитанция «Изменение скидки» — было/стало, причина, возвращено и куда', () => {
  const d = slipDataDc({
    kind: 'discount', invoice: { invoice_number: 'INV-A-26-00052', total_amount: 100000, paid_amount: 100000 },
    patient: { full_name: 'Рахимов Жасур', mrn: 'A-26-00015' },
    pctBefore: 20, sumBefore: 40000, pctAfter: 50, sumAfter: 100000, reason: 'акция', refunded: 60000,
    plan: [{ refund_method: 'cash', amount: 40000 }, { to_balance: true, refund_method: 'wallet', amount: 20000 }], cashier: 'Кассир',
  });
  assert.equal(d.subtitle, 'Изменение скидки');
  assert.equal(d.docNo, 'INV-A-26-00052');
  const rows = Object.fromEntries(d.rows);
  assert.equal(rows['Было'], 'Скидка 20% — 40 000 сум');
  assert.equal(rows['Стало'], 'Скидка 50% — 100 000 сум');
  assert.equal(rows['Причина'], 'акция');
  assert.equal(d.amountLabel, 'Возвращено');
  assert.equal(d.amount, 60000);
  assert.equal(d.method, 'Наличные 40 000, На баланс пациента 20 000');
  assert.deepEqual(d.afterRows, [['Сумма счёта', '100 000'], ['Оплачено', '100 000']]);
  const none = slipDataDc({ kind: 'discount', invoice: {}, patient: {}, pctBefore: 20, sumBefore: 40000, pctAfter: 0, sumAfter: 0, refunded: 0, plan: [] });
  assert.equal(Object.fromEntries(none.rows)['Стало'], 'Без скидки');
  assert.ok(!Object.fromEntries(none.rows)['Причина'], 'без причины — строки нет');
});
