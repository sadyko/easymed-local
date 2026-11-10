// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0, решение владельца Q1) — «Период» доски CRM
// на настоящей базе и настоящем /api/db (тот же db-client и тот же loadBoard, что
// у экрана). Владелец: фильтр «не работает» — при «Сегодня» на доске оставались
// тысячи давних открытых карточек (открытые грузились без даты, CRM_UNIFY_V1).
// Теперь:
//   • выбранный период сужает КАЖДУЮ колонку по created_at, открытые тоже;
//   • открытые вне периода приходят лёгким запросом (для строки «Открытых за
//     другие дни: N») — под тем же фильтром «Оператор» и той же видимостью;
//   • «по» своего периода — весь последний день: база пишет created_at без долей
//     секунды ('…:59Z') и сравнивает строки, граница — начало следующего дня.
// Данные — выдуманные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp } from '../test-helpers/crm-unify-app.js';
import { makeDbClient } from '../../public/js/db-client.js';
import { loadBoard, periodBounds, OUTSIDE_SELECT } from '../../public/js/admin/views/crm-board-load.js';

const DAY = 86400000;
const asDb = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');   // как пишет база (strftime …Z)
const daysAgo = (n) => asDb(new Date(Date.now() - n * DAY));
// закрытые колонки запасной воронки (crm.js closedKeys: «Пришёл» + проигрышные, кроме «Не пришёл»)
const CLOSED = ['came', 'stopped', 'not_qualified'];

async function start(rows) {
  const app = await startCrmApp((db) => {
    const ins = db.prepare(`INSERT INTO crm_requests (full_name, phone, status, source, assigned_to, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?)`);
    for (const r of rows) ins.run(r.name, '+99890' + String(1000000 + rows.indexOf(r)), r.status, r.source || 'call', r.assigned ?? null, r.at, r.at);
  });
  const port = app.server.address().port;
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const db = makeDbClient({
    fetch: (u, init) => fetch(u, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } }),
    base: `http://127.0.0.1:${port}/api/db`, banner: false,
  });
  return { app, db };
}
const names = (rows) => rows.map((r) => r.full_name).sort();

test('CRM_PERIOD_ALL_COLUMNS_V1: «Сегодня» — открытые и закрытые только сегодняшние; давние открытые — лёгким запросом, с оператором', async () => {
  const { app, db } = await start([
    { name: 'Давний в обработке', status: 'in_process', at: daysAgo(40), assigned: 3 },
    { name: 'Давний перезвон', status: 'recall', at: daysAgo(10) },
    { name: 'Давний не пришёл', status: 'no_show', at: daysAgo(20), assigned: 3 },
    { name: 'Давний пришёл', status: 'came', at: daysAgo(40) },
    { name: 'Сегодняшний', status: 'in_process', at: asDb(new Date()) },
    { name: 'Пришёл сегодня', status: 'came', at: asDb(new Date()) },
  ]);
  try {
    const bounds = periodBounds('today');
    const res = await loadBoard({ db, closedKeys: CLOSED, bounds, outside: true });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.deepEqual(names(res.rows), ['Пришёл сегодня', 'Сегодняшний'], 'на доске давние карточки');
    assert.deepEqual(res.outside.map((r) => r.status).sort(), ['in_process', 'no_show', 'recall'], 'не те открытые вне периода');
    assert.deepEqual(Object.keys(res.outside[0]).sort(), OUTSIDE_SELECT.split(', ').sort(), 'лёгкий запрос тянет лишнее');
    // «Оператор» — и в доске, и в числе вне периода
    const mine = await loadBoard({ db, closedKeys: CLOSED, bounds, operator: '3', outside: true });
    assert.deepEqual(mine.rows, []);
    assert.equal(mine.outside.length, 2);
    // «Всё время» — всё на доске, вне периода спрашивать нечего
    const all = await loadBoard({ db, closedKeys: CLOSED, bounds: periodBounds('all'), outside: true });
    assert.equal(all.rows.length, 6);
    assert.equal(all.outside, null);
  } finally { app.close(); }
});

test('CRM_PERIOD_ALL_COLUMNS_V1: «Свой период» — «по» включает весь последний день, полночь следующего — нет', async () => {
  const { app, db } = await start([
    { name: 'Первая секунда', status: 'recall', at: asDb(new Date(2026, 9, 1, 0, 0, 0)) },
    { name: 'Последняя секунда', status: 'recall', at: asDb(new Date(2026, 9, 3, 23, 59, 59)) },
    { name: 'Пришёл в последнюю секунду', status: 'came', at: asDb(new Date(2026, 9, 3, 23, 59, 59)) },
    { name: 'Полночь после', status: 'recall', at: asDb(new Date(2026, 9, 4, 0, 0, 0)) },
    { name: 'Накануне', status: 'came', at: asDb(new Date(2026, 8, 30, 23, 59, 59)) },
  ]);
  try {
    const res = await loadBoard({ db, closedKeys: CLOSED, bounds: periodBounds('custom', '2026-10-01', '2026-10-03'), outside: true });
    assert.deepEqual(names(res.rows), ['Первая секунда', 'Последняя секунда', 'Пришёл в последнюю секунду']);
    assert.deepEqual(res.outside.map((r) => r.id).length, 1, 'вне периода — только открытая «Полночь после»');
  } finally { app.close(); }
});
