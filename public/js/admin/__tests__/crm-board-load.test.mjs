// CRM_UNIFY_V1 — ЗАГРУЗКА ДОСКИ (views/crm-board-load.js). Владелец: «карточки
// иногда пропадают» (доска брала 800 последних — две недели звонков) и «"Показать
// ещё 20" убрать, чтобы все карточки были в окне» (Р12, Р13).
//   • открытые — ВСЕ, без предела: всё, что не закрыто (статус не из закрытых
//     колонок), — так карточка со ступенью, которой нет в запасной воронке,
//     тоже не пропадает;
//   • закрытые («Пришёл», «Отказ», прочие проигрышные) — созданные в периоде;
//     для «Всё время» — последние 300 на колонку, а число — из базы.
// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0, решение владельца Q1) — выбранный «Период»
// сужает и ОТКРЫТЫЕ (по дате поступления); «по» — исключительная граница (начало
// следующего дня); открытые за другие дни — лёгкий запрос для строки над доской.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: { getItem: () => 'ru', setItem() {}, removeItem() {} } };
globalThis.localStorage = globalThis.localStorage || globalThis.window.localStorage;
const { loadBoard, periodBounds, periodStart, CLOSED_ALL_TIME_LIMIT, BOARD_SELECT, withOperator, OUTSIDE_SELECT } = await import('../views/crm-board-load.js');

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

// CRM_PERIOD_ALL_COLUMNS_V1 — ОБНОВЛЕНО НАМЕРЕННО: открытые тоже в границах
// периода (раньше — все, без даты: «Сегодня» грузило тысячи давних открытых);
// «по» — исключительная граница: lt начала следующего дня, а не lte 23:59:59.999.
test('период задан: и открытые, и закрытые — в границах created_at («по» — исключительно), без предела', async () => {
  const db = fakeDb(() => ({ data: [], error: null }));
  await loadBoard({ db, closedKeys: ['came', 'refused'], bounds: { from: '2026-10-01T00:00:00Z', to: '2026-10-05T19:00:00.000Z' } });
  const closed = db.calls.find((c) => c.filters.some(([op, col, val]) => op === 'in' && col === 'status' && val.includes('came')));
  assert.ok(closed, 'закрытые за период не запрошены одним запросом');
  const open = db.calls.find(isOpenQuery);
  for (const [what, q] of [['закрытые', closed], ['открытые', open]]) {
    assert.ok(q.filters.some(([op, col, val]) => op === 'gte' && col === 'created_at' && val === '2026-10-01T00:00:00Z'), what + ' без начала периода');
    assert.ok(q.filters.some(([op, col, val]) => op === 'lt' && col === 'created_at' && val === '2026-10-05T19:00:00.000Z'), what + ' без конца периода');
    assert.ok(!q.filters.some(([op]) => op === 'lte'), what + ': «по» снова включительная граница');
    assert.equal(q.limit, null);
  }
  assert.equal(db.calls.length, 2, 'без просьбы открытые за другие дни не спрашиваются');
});

test('CRM_PERIOD_ALL_COLUMNS_V1: открытые за другие дни — лёгкий запрос вне периода (до «с» и с «по»), тот же оператор, без предела', async () => {
  const F = '2026-10-01T00:00:00.000Z';
  const T = '2026-10-05T19:00:00.000Z';
  const db = fakeDb((d) => {
    if (d.select !== OUTSIDE_SELECT) return { data: [lead(9, 'recall')], error: null };
    const before = d.filters.some(([op, col, val]) => op === 'lt' && col === 'created_at' && val === F);
    return { data: before ? [{ id: 1, status: 'recall' }, { id: 2, status: 'no_show' }] : [{ id: 2, status: 'no_show' }, { id: 3, status: 'in_process' }], error: null };
  });
  const res = await loadBoard({ db, closedKeys: ['came'], bounds: { from: F, to: T }, operator: 'me', me: 21, outside: true });
  const lite = db.calls.filter((c) => c.select === OUTSIDE_SELECT);
  assert.equal(lite.length, 2, 'вне периода — до «с» и с «по»');
  assert.ok(lite.some((c) => c.filters.some(([op, col, val]) => op === 'lt' && col === 'created_at' && val === F)));
  assert.ok(lite.some((c) => c.filters.some(([op, col, val]) => op === 'gte' && col === 'created_at' && val === T)));
  for (const c of lite) {
    assert.ok(c.filters.some(([op, col, val]) => op === 'not.in' && col === 'status' && val.includes('came')), 'вне периода — только открытые');
    assert.ok(c.filters.some(([op, col, val]) => op === 'eq' && col === 'assigned_to' && val === 21), 'без фильтра «Оператор»');
    assert.equal(c.limit, null);
  }
  assert.deepEqual(res.outside.map((r) => r.id).sort(), [1, 2, 3], 'строки вне периода — без повторов');
  assert.deepEqual(res.rows.map((r) => r.id), [9]);
  assert.equal(OUTSIDE_SELECT, 'id, status, source, sources', 'лёгкий запрос тянет лишнее');

  // Только «с» — один запрос; «Всё время» — ни одного, outside = null.
  const one = fakeDb(() => ({ data: [], error: null }));
  await loadBoard({ db: one, closedKeys: ['came'], bounds: { from: F, to: null }, outside: true });
  assert.equal(one.calls.filter((c) => c.select === OUTSIDE_SELECT).length, 1);
  const all = fakeDb(() => ({ data: [], error: null }));
  const resAll = await loadBoard({ db: all, closedKeys: ['came'], bounds: { from: null, to: null }, outside: true });
  assert.equal(all.calls.filter((c) => c.select === OUTSIDE_SELECT).length, 0);
  assert.equal(resAll.outside, null);

  // Сбой лёгкого запроса — доска на месте, строки «вне периода» нет (null), а не ошибка доски.
  const bad = fakeDb((d) => (d.select === OUTSIDE_SELECT ? { data: null, error: { message: 'boom' } } : { data: [lead(9, 'recall')], error: null }));
  const resBad = await loadBoard({ db: bad, closedKeys: ['came'], bounds: { from: F, to: T }, outside: true });
  assert.equal(resBad.error, undefined);
  assert.deepEqual(resBad.rows.map((r) => r.id), [9]);
  assert.equal(resBad.outside, null);
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
  // CRM_PERIOD_ALL_COLUMNS_V1 — «по» — исключительная граница: начало дня ПОСЛЕ «по».
  assert.equal(new Date(c.to).getDate(), 4);
  assert.equal(new Date(c.to).getHours(), 0);
  // Весь последний день: база пишет created_at без долей секунды ('…:59Z') и
  // сравнивает строки. Карточка в 23:59:59 «по»-дня — внутри (с границей
  // '…:59.999Z' она была снаружи: 'Z' > '.'), полночь следующего дня — снаружи.
  const asDb = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lastSecond = asDb(new Date(2026, 9, 3, 23, 59, 59));
  const nextMidnight = asDb(new Date(2026, 9, 4, 0, 0, 0));
  assert.ok(lastSecond >= c.from && lastSecond < c.to, `23:59:59 последнего дня вне периода: ${lastSecond} / ${c.to}`);
  assert.ok(!(nextMidnight < c.to), 'полночь следующего дня попала в период');
  assert.equal(periodBounds('custom', '', '2026-10-03', wed).from, null);
  assert.equal(periodBounds('custom', '', '2026-10-03', wed).to, c.to);
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

// CRM_UNIFY_V1 (задача 8) — «Отчёт» считает заявки по базе своим лёгким запросом
// за свой период (и с фильтром оператора, Р14), а не то, что загрузила доска.
test('отчёт: свой лёгкий запрос за свой период и с фильтром оператора', async () => {
  const { loadReportRows, REPORT_SELECT } = await import('../views/crm-board-load.js');
  const db = fakeDb(() => ({ data: [lead(1, 'came')], error: null }));
  const now = new Date(2026, 9, 9, 12, 0);
  const rows = await loadReportRows({ db, days: 30, operator: 'none', now });
  assert.equal(rows.length, 1);
  const c = db.calls[0];
  assert.equal(c.select, REPORT_SELECT);
  assert.equal(REPORT_SELECT, 'id, status, source, sources, created_at, assigned_to');
  const gte = c.filters.find(([op, col]) => op === 'gte' && col === 'created_at');
  assert.ok(gte, 'период отчёта не ушёл в запрос');
  assert.equal(new Date(gte[2]).getTime(), now.getTime() - 30 * 86400000);
  assert.ok(c.filters.some(([op, col, val]) => op === 'is' && col === 'assigned_to' && val === null));
  assert.equal(c.limit, null, 'отчёт обрезан пределом');
  const all = await loadReportRows({ db, days: 0 });
  assert.ok(!db.calls[1].filters.some(([, col]) => col === 'created_at'), '«Всё время» обрезано датой');
  assert.ok(Array.isArray(all));
  const bad = fakeDb(() => ({ data: null, error: { message: 'boom' } }));
  assert.equal(await loadReportRows({ db: bad, days: 7 }), null, 'ошибка выдана за пустой отчёт');
});

// CRM_UNIFY_V1 (итоговое ревью) — выгрузка Excel: closedLimit 0 — закрытые одним запросом без предела.
test('closedLimit 0 («Всё время» для выгрузки): закрытые одним запросом, без 300 и без числа', async () => {
  const db = fakeDb(() => ({ data: [], error: null }));
  await loadBoard({ db, closedKeys: ['came', 'stopped'], bounds: { from: null, to: null }, closedLimit: 0 });
  assert.equal(db.calls.length, 2);
  const closed = db.calls.find((c) => c.filters.some(([op, col]) => op === 'in' && col === 'status'));
  assert.ok(closed, 'закрытые не одним запросом');
  assert.equal(closed.limit, null);
  assert.ok(!closed.filters.some(([, col]) => col === 'created_at'));
});
