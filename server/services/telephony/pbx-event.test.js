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
import { normalizePbxEvent, ringFromBinotelSettings, endFromBinotelCompleted, RING, ANSWER, END } from './pbx-event.js';

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

test('непонятное событие не теряется молча: unknown с ИМЕНАМИ полей (без значений) и именем события; пустое — null', () => {
  assert.deepEqual(normalizePbxEvent({ event: 'weird_thing', uuid: 'x', caller: '998901112233' }, { now: NOW }), { unknown: true, keys: ['event', 'uuid', 'caller'], name: 'weird_thing' });
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

// FIX_318_V1 (C6) — имена событий угадывались по подстрокам: «call_missed»
// (есть «call») читался как «звонит», «pending» (есть «end») — как «конец».
// Теперь — только известные имена; остальное — unknown с именем (по нему
// схема сверяется на настоящей станции), а не догадка.
test('FIX_318_V1: имена событий — только известные; call_missed, pending и прочие — unknown с именем, не угадываются', () => {
  for (const name of ['call_missed', 'pending', 'weird_thing', 'call_transfer', 'record_ready', 'calling', 'ended_by_timeout']) {
    const ev = normalizePbxEvent({ event: name, uuid: 'x', caller: '998901112233' }, { now: NOW });
    assert.equal(ev.unknown, true, name + ' угадан как ' + ev.event);
    assert.equal(ev.name, name);
    assert.deepEqual(ev.keys, ['event', 'uuid', 'caller']);
  }
  const kind = (event) => normalizePbxEvent({ event, uuid: 'a', caller: '998901112233', callee: '101' }, { now: NOW }).event;
  assert.equal(kind('CALL_START'), RING, 'регистр не важен');
  assert.equal(kind('call-answered'), ANSWER, 'дефис — как подчёркивание');
  assert.equal(kind(' hangup '), END);
  assert.equal(kind('Завершение звонка'), END, 'названия событий кабинета onlinePBX по-русски');
  assert.equal(kind('Начавшийся разговор'), ANSWER);
  assert.equal(kind('начало  звонка'), RING);
  // Имя непонятного события — без номеров и не длиннее 40 знаков.
  assert.equal(normalizePbxEvent({ event: '998901112233', uuid: 'x' }, { now: NOW }).name, '?');
  assert.equal(normalizePbxEvent({ event: 'x'.repeat(100), uuid: 'x' }, { now: NOW }).name.length, 40);
});

test('FIX_318_V1: время вне диапазона дат, мусор и дальше суток от приёма — время приёма, без исключения (раньше огромное число — 400 станции)', () => {
  for (const date of [1e20, '1e300', -5, 'Infinity', '9999-99-99', SEC + 3 * 86400, SEC - 3 * 86400, String(1e16), 8.64e15 + 1]) {
    let ev;
    assert.doesNotThrow(() => { ev = normalizePbxEvent({ event: 'call_start', uuid: 'u', caller: '998901112233', date }, { now: NOW }); }, String(date));
    assert.equal(ev.at, '2026-10-17T07:00:00Z', String(date));
  }
  assert.equal(normalizePbxEvent({ event: 'call_start', uuid: 'u', date: SEC + 3600 }, { now: NOW }).at, '2026-10-17T08:00:00Z', 'в пределах суток — время станции');
});

test('FIX_318_V1: Binotel «звонок завершён» → end того же binotel:<id>; разговор был — answered; без id — null', () => {
  assert.deepEqual(endFromBinotelCompleted({ generalCallID: 'g-1', callType: '0', externalNumber: '0501112233', internalNumber: '101', billsec: '0', disposition: 'NOANSWER' }, { now: NOW }),
    { uuid: 'binotel:g-1', event: END, direction: 'in', caller: '0501112233', callee: '101', at: '2026-10-17T07:00:00Z', answered: false });
  assert.equal(endFromBinotelCompleted({ generalCallID: 'g-2', billsec: '42' }, { now: NOW }).answered, true);
  assert.equal(endFromBinotelCompleted({ generalCallID: 'g-3', billsec: '0', disposition: 'ANSWER' }, { now: NOW }).answered, true);
  assert.equal(endFromBinotelCompleted({ generalCallID: 'g-4', callType: '1' }, { now: NOW }).direction, 'out');
  assert.equal(endFromBinotelCompleted({ startTime: '1' }, { now: NOW }), null);
  assert.equal(endFromBinotelCompleted(null, { now: NOW }), null);
});
