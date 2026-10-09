// CRM_UNIFY_V1 — ЗАГРУЗКА ДОСКИ (views/crm-board-load.js). Владелец: «карточки
// иногда пропадают» (доска брала 800 последних — две недели звонков) и «"Показать
// ещё 20" убрать, чтобы все карточки были в окне» (Р12, Р13).
//   • открытые — ВСЕ, без предела: всё, что не закрыто (статус не из закрытых
//     колонок), — так карточка со ступенью, которой нет в запасной воронке,
//     тоже не пропадает;
//   • закрытые («Пришёл», «Отказ», прочие проигрышные) — созданные в периоде;
//     для «Всё время» — последние 300 на колонку, а число — из базы.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: { getItem: () => 'ru', setItem() {}, removeItem() {} } };
globalThis.localStorage = globalThis.localStorage || globalThis.window.localStorage;
const { loadBoard, periodBounds, periodStart, CLOSED_ALL_TIME_LIMIT, BOARD_SELECT, withOperator } = await import('../views/crm-board-load.js');

/** Поддельный db-клиент: записывает описания запросов и отвечает по таблице. */
function fakeDb(answer) {
  const calls = [];
  const from = (table) => {
    const d = { table, filters: [], order: [], select: null, count: null, limit: null };
    const b = {
      select(cols, opts) { d.select = cols; if (opts && opts.count) d.count = opts.count; return b; },
      order(col, o) { d.order.push([col, o && o.ascending === false ? 'desc' : 'asc']); return b; },
      limit(n) { d.limit = n; return b; },
      not(col, op, val) { d.filters.push(['not.' + op, col, val]); return b; },
      then(ok, bad) { calls.push(d); return Promise.resolve(answer(d)).then(ok, bad); },
    };
    for (const op of ['eq', 'in', 'is', 'gte', 'lte', 'lt']) b[op] = (col, val) => { d.filters.push([op, col, val]); return b; };
    return b;
  };
  return { from, calls };
}
const lead = (id, status, created_at = '2026-10-01T10:00:00Z') => ({ id, status, created_at });
const isOpenQuery = (c) => c.filters.some(([op, col]) => op === 'not.in' && col === 'status');

test('«Всё время»: открытые — одним запросом без предела (всё, что не закрыто); закрытые — по колонке, по 300, с числом из базы', async () => {
  const db = fakeDb((d) => (isOpenQuery(d)
    ? { data: [lead(1, 'in_process'), lead(5, 'custom_open')], error: null }
    : { data: [lead(d.filters.find(([op]) => op === 'eq')[2] === 'came' ? 2 : 3, 'x')], count: 1, error: null }));
  const res = await loadBoard({ db, closedKeys: ['came', 'stopped'], bounds: { from: null, to: null } });
  const open = db.calls.find(isOpenQuery);
  assert.ok(open, 'открытые грузятся не «всё, кроме закрытых»');
  assert.deepEqual(open.filters.find(([op]) => op === 'not.in')[2], ['came', 'stopped']);
  assert.equal(open.limit, null, 'открытые карточки снова обрезаны пределом');
  assert.equal(open.select, BOARD_SELECT);
  const closed = db.calls.filter((c) => c.filters.some(([op, col]) => op === 'eq' && col === 'status'));
  assert.deepEqual(closed.map((c) => c.limit), [CLOSED_ALL_TIME_LIMIT, CLOSED_ALL_TIME_LIMIT]);
  assert.ok(closed.every((c) => c.count === 'exact'), 'у закрытой колонки нет числа из базы');
  assert.deepEqual(res.rows.map((r) => r.id), [5, 3, 2, 1], 'строки по убыванию id, без дублей');
  assert.deepEqual(res.capped, {}, 'полная колонка помечена обрезанной');
});

test('период задан: закрытые — одним запросом в границах created_at, без предела', async () => {
  const db = fakeDb(() => ({ data: [], error: null }));
  await loadBoard({ db, closedKeys: ['came', 'refused'], bounds: { from: '2026-10-01T00:00:00Z', to: '2026-10-05T18:59:59Z' } });
  const closed = db.calls.find((c) => c.filters.some(([op, col, val]) => op === 'in' && col === 'status' && val.includes('came')));
  assert.ok(closed, 'закрытые за период не запрошены одним запросом');
  assert.ok(closed.filters.some(([op, col, val]) => op === 'gte' && col === 'created_at' && val === '2026-10-01T00:00:00Z'));
  assert.ok(closed.filters.some(([op, col, val]) => op === 'lte' && col === 'created_at' && val === '2026-10-05T18:59:59Z'));
  assert.equal(closed.limit, null);
  assert.equal(db.calls.length, 2);
});

test('закрытая колонка упёрлась в 300 — число из базы (тот же запрос, тот же фильтр оператора)', async () => {
  const many = Array.from({ length: CLOSED_ALL_TIME_LIMIT }, (_, i) => lead(1000 + i, 'came'));
  const db = fakeDb((d) => (isOpenQuery(d) ? { data: [], error: null } : { data: many, count: 4321, error: null }));
  const res = await loadBoard({ db, closedKeys: ['came'], bounds: { from: null, to: null }, operator: 'me', me: 21 });
  assert.equal(res.counts.came, 4321);
  assert.equal(res.capped.came, true);
  const cnt = db.calls.find((c) => c.count);
  assert.ok(cnt.filters.some(([op, col, val]) => op === 'eq' && col === 'assigned_to' && val === 21), 'число посчитано без фильтра оператора');
  assert.ok(db.calls.find(isOpenQuery).filters.some(([op, col, val]) => op === 'eq' && col === 'assigned_to' && val === 21), 'открытые без фильтра оператора');
});

test('нет закрытых колонок — открытые без отбора по статусу', async () => {
  const db = fakeDb(() => ({ data: [lead(1, 'a')], error: null }));
  const res = await loadBoard({ db, closedKeys: [], bounds: { from: null, to: null } });
  assert.equal(db.calls.length, 1);
  assert.ok(!db.calls[0].filters.some(([, col]) => col === 'status'));
  assert.equal(res.rows.length, 1);
});

test('ошибка любого запроса — ошибка загрузки, а не пустая (или половинная) доска', async () => {
  const db = fakeDb((d) => (isOpenQuery(d) ? { data: [lead(1, 'a')], error: null } : { data: null, error: { message: 'boom' } }));
  const res = await loadBoard({ db, closedKeys: ['came'], bounds: { from: null, to: null } });
  assert.equal(res.error.message, 'boom');
  assert.deepEqual(res.rows, []);
});

test('границы периода: «Сегодня», «Эта неделя» с понедельника, «30 дней», «Свой период» включает последний день', () => {
  const wed = new Date(2026, 9, 7, 15, 0);   // среда
  assert.equal(new Date(periodBounds('today', '', '', wed).from).getDate(), 7);
  assert.equal(new Date(periodBounds('week', '', '', wed).from).getDate(), 5);
  assert.equal(new Date(periodBounds('30', '', '', wed).from).getDate(), 8);   // 30 календарных дней, включая сегодня
  const c = periodBounds('custom', '2026-10-01', '2026-10-03', wed);
  assert.equal(new Date(c.from).getDate(), 1);
  assert.equal(new Date(c.to).getDate(), 3);
  assert.equal(new Date(c.to).getHours(), 23);
  assert.deepEqual(periodBounds('custom', '', '', wed), { from: null, to: null });
  assert.deepEqual(periodBounds('all'), { from: null, to: null });
  assert.equal(periodStart('all'), null);
});

test('фильтр оператора: мои / ничьи / по имени / все', () => {
  const seen = [];
  const q = { eq: (c, v) => (seen.push(['eq', c, v]), q), is: (c, v) => (seen.push(['is', c, v]), q) };
  withOperator(q, 'me', 21); withOperator(q, 'none', 21); withOperator(q, '24', 21); withOperator(q, 'all', 21); withOperator(q, undefined, 21);
  assert.deepEqual(seen, [['eq', 'assigned_to', 21], ['is', 'assigned_to', null], ['eq', 'assigned_to', 24]]);
});
