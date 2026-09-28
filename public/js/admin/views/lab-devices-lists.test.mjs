// lab-devices-lists.test.mjs — где стоит прибор на экране «Анализаторы»
// (LIS_ANALYZER_LIST_V1). Чистое правило: список на входе, раскладка на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDevices, portState } from './lab-devices-lists.js';

const D = (id, added, last_seen_at, extra = {}) => ({ id, name: 'П' + id, added, last_seen_at, port: 2575, ...extra });

test('три места: таблица, «Найдены в сети», «Ждут первого сообщения»', () => {
  const s = splitDevices([
    D(1, 1, '2026-09-28T13:52:09Z'),   // добавлен и говорил — таблица
    D(2, 0, '2026-09-29T08:00:00Z'),   // найден сам — ждёт «Добавить»
    D(3, 1, null),                     // добавлен руками, молчит — ждёт сообщения
  ]);
  assert.deepEqual(s.table.map((d) => d.id), [1]);
  assert.deepEqual(s.found.map((d) => d.id), [2]);
  assert.deepEqual(s.waiting.map((d) => d.id), [3]);
});

test('сервер до миграции 228 (added нет) — прибор не пропадает из таблицы', () => {
  const s = splitDevices([{ id: 7, name: 'Старый', last_seen_at: '2026-09-10T17:56:20Z' }]);
  assert.deepEqual(s.table.map((d) => d.id), [7]);
});

test('порт ждущего прибора: слушается, не поднялся, выключен, неизвестно', () => {
  const st = { listening: [2575], failed: [
    { port: 5100, code: 'busy', error: 'LIS: порт 5100 уже занят — вероятно, Easy-Med уже запущен' },
    { port: 5200, code: 'error', error: 'listen EACCES: permission denied 0.0.0.0:5200' },
  ] };
  assert.deepEqual(portState({ port: 2575 }, st), { kind: 'listening', port: 2575 });
  // Ревью M6: причина — кодом; сырой текст сервера (русский, с догадкой о
  // причине) до экрана не доходит — экран говорит своими словами.
  assert.deepEqual(portState({ port: 5100 }, st), { kind: 'failed', port: 5100, code: 'busy' });
  assert.deepEqual(portState({ port: 5200 }, st), { kind: 'failed', port: 5200, code: 'error' });
  assert.deepEqual(portState({ port: 5300 }, { listening: [], failed: [{ port: 5300, error: 'x' }] }),
    { kind: 'failed', port: 5300, code: 'error' }, 'сервер без кода — просто «не слушается»');
  assert.deepEqual(portState({ port: 6000 }, st), { kind: 'off', port: 6000 });
  assert.deepEqual(portState({ port: 2575 }, null), { kind: 'unknown', port: 2575 });
  assert.equal(portState({}, st).port, 2575, 'порт не задан — значит, порт по умолчанию');
});
