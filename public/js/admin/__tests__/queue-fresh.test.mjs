// QUEUE_FRESH_V1 (3.21.0) — ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// queue-fresh.js — маленькая почта между окном приёма и кабинетом врача: окно
// сообщает «строка N получила статус S» сразу после записи на сервер, кабинет и
// «Мой день» подписаны. Здесь — сама почта: подписка, отписка, сбой одного
// подписчика не мешает другим, пустое сообщение никого не зовёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteLineStatus, onLineStatus } from '../queue-fresh.js';

test('подписчики получают номер строки и статус; отписка работает; сбой одного не мешает другим', () => {
    const got = [];
    const offA = onLineStatus(() => { throw new Error('сбой подписчика'); });
    const offB = onLineStatus((id, s) => got.push([id, s]));
    const warn = console.warn;
    console.warn = () => {};
    try { noteLineStatus(41, 'completed'); } finally { console.warn = warn; }
    assert.deepEqual(got, [[41, 'completed']]);
    offA(); offB();
    noteLineStatus(42, 'completed');
    assert.deepEqual(got, [[41, 'completed']], 'отписка не сработала');
});

test('пустой номер или статус — никого не зовут; подписка не-функцией — безвредна', () => {
    const got = [];
    const off = onLineStatus((id, s) => got.push([id, s]));
    noteLineStatus(null, 'completed');
    noteLineStatus('', 'completed');
    noteLineStatus(5, '');
    off();
    assert.deepEqual(got, []);
    const noop = onLineStatus('не функция');
    assert.equal(typeof noop, 'function');
    noop();
});
