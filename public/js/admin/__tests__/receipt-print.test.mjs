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
