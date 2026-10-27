// CALL_RING_V1 (2026-10-17) — разборщик события станции «звонок начался / ответили /
// закончился». Один и тот же модуль читают клиника (прямой приём и Binotel) и
// публичный сервер (приём вебхука onlinePBX): если бы у каждого был свой разбор,
// одно и то же событие станции читалось бы по-разному по обе стороны канала.
//
// Официальной схемы вебхуков onlinePBX в открытом доступе нет (спецификация,
// «Что сегодня»), поэтому разбор терпимый — по подстрокам и запасным именам
// полей — и здесь закреплено, ЧТО именно он терпит и где отказывает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePbxEvent, ringFromBinotelSettings, RING, ANSWER, END } from './pbx-event.js';

const NOW = Date.parse('2026-10-17T07:00:00Z');
const SEC = Math.floor(NOW / 1000);   // unix-секунды того же мига

test('onlinePBX: начало входящего звонка (JSON, unix-секунды) → ring/in с номерами и временем', () => {
  const ev = normalizePbxEvent({ event: 'call_start', direction: 'inbound', uuid: 'u-1', caller: '998901112233', callee: '101', date: SEC, gateway: 'gw1', domain: 'clinic.onpbx.ru' }, { now: NOW });
  assert.deepEqual(ev, { uuid: 'u-1', event: RING, direction: 'in', caller: '998901112233', callee: '101', at: '2026-10-17T07:00:00Z' });
});

test('onlinePBX: завершение исходящего (form-разбор: строки) → end/out; плюс в номере сохраняется', () => {
  const ev = normalizePbxEvent({ event: 'call_end', direction: 'outbound', uuid: 'u-2', caller: '101', callee: '+998 93 555-01-12', hangup_cause: 'NORMAL_CLEARING', call_duration: '96', date: String(SEC + 60) }, { now: NOW });
  assert.deepEqual(ev, { uuid: 'u-2', event: END, direction: 'out', caller: '101', callee: '+998935550112', at: '2026-10-17T07:01:00Z' });
});

test('запасные имена полей: from/to/call_id, ответ по слову answer, миллисекунды и ISO во времени', () => {
  assert.deepEqual(normalizePbxEvent({ event: 'call_answer', direction: 'in', call_id: 'c7', from: '998977012345', to: '102', timestamp: NOW }, { now: NOW }),
    { uuid: 'c7', event: ANSWER, direction: 'in', caller: '998977012345', callee: '102', at: '2026-10-17T07:00:00Z' });
  assert.deepEqual(normalizePbxEvent({ event: 'Начало звонка', direction: 'входящий', id: 'c8', caller_id_number: '998901234567', destination_number: '103', time: '2026-10-17T07:02:00Z' }, { now: NOW }),
    { uuid: 'c8', event: RING, direction: 'in', caller: '998901234567', callee: '103', at: '2026-10-17T07:02:00Z' });
});

test('без направления — по виду номеров: короткий звонит длинному — исходящий, иначе входящий', () => {
  assert.equal(normalizePbxEvent({ event: 'call_start', uuid: 'a', caller: '101', callee: '998901112233' }, { now: NOW }).direction, 'out');
  assert.equal(normalizePbxEvent({ event: 'call_start', uuid: 'b', caller: '998901112233', callee: '101' }, { now: NOW }).direction, 'in');
});

test('без uuid событие всё равно живёт: ключ собирается из номеров и минуты, чтобы ответ и конец нашли начало', () => {
  const a = normalizePbxEvent({ event: 'call_start', caller: '998901112233', callee: '101', date: SEC }, { now: NOW });
  const b = normalizePbxEvent({ event: 'call_end', caller: '998901112233', callee: '101', date: SEC + 30 }, { now: NOW });
  assert.equal(a.uuid, b.uuid, 'начало и конец одного звонка получили разные ключи');
  assert.match(a.uuid, /^syn:/);
});

test('непонятное событие не теряется молча: unknown с ИМЕНАМИ полей (без значений); пустое — null', () => {
  assert.deepEqual(normalizePbxEvent({ event: 'weird_thing', uuid: 'x', caller: '998901112233' }, { now: NOW }), { unknown: true, keys: ['event', 'uuid', 'caller'] });
  assert.equal(normalizePbxEvent(null, { now: NOW }), null);
  assert.equal(normalizePbxEvent('строка', { now: NOW }), null);
  assert.equal(normalizePbxEvent({}, { now: NOW }), null);
});

test('время мусорное или отсутствует — берётся время приёма; номера чистятся до цифр', () => {
  const ev = normalizePbxEvent({ event: 'call_start', uuid: 'u', caller: '(90) 111-22-33', callee: 'ext 101', date: 'вчера' }, { now: NOW });
  assert.equal(ev.at, '2026-10-17T07:00:00Z');
  assert.equal(ev.caller, '901112233');
  assert.equal(ev.callee, '101');
});

test('Binotel «кто звонит» (apiCallSettings) → ring/in с его же номером звонка', () => {
  assert.deepEqual(ringFromBinotelSettings({ requestType: 'apiCallSettings', externalNumber: '0501112233', internalNumber: '101', generalCallID: 'g-1' }, { now: NOW }),
    { uuid: 'binotel:g-1', event: RING, direction: 'in', caller: '0501112233', callee: '101', at: '2026-10-17T07:00:00Z' });
  assert.equal(ringFromBinotelSettings({ requestType: 'apiCallSettings' }, { now: NOW }), null, 'без номера звонящего показывать нечего');
});
