// CRM_UNIFY_V1 — ВИД «ЗАДАЧИ»: третий вид раздела CRM (Канбан / Список /
// Задачи). Группы Просрочено / Сегодня / Позже / Без срока; по умолчанию —
// мои; администратор и руководитель (crm.all) выбирают оператора; строка
// открывает карточку; задача на карточке, которую человек не видит, —
// «Карточка у другого оператора»: отметить можно, открыть нельзя. Проверяется
// то, что отрисовалось, и то, что ушло на сервер.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, mk, walk, textOf, byAttr, byClass, tick } from './crm-harness.mjs';
import { taskQuery, TASK_LIST_SELECT } from '../views/crm-tasks.js';

const { groupTasks, renderTasksView } = await import('../views/crm-tasks-view.js');
const { renderCrm } = await import('../views/crm.js');

const NOW = new Date(2026, 9, 9, 12, 0);   // 09.10.2026 12:00 местного
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const T = (id, due, extra = {}) => ({ id, request_id: 100 + id, text: 'Задача ' + id, due_at: due ? iso(due) : null, assignee_id: 21, done_at: null,
  crm_requests: { id: 100 + id, full_name: 'Карточка ' + id, phone: '901', status: 'in_process', assigned_to: 21 }, users: { full_name: 'Оператор А' }, ...extra });
const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LOLA = { id: 12, full_name: 'Оператор Лола', role: 'callcenter' };

test('группы: просрочено, сегодня, позже, без срока; сделанные не показываются', () => {
  const g = groupTasks([
    T(1, new Date(2026, 9, 8, 9)), T(2, new Date(2026, 9, 9, 18)), T(3, new Date(2026, 9, 12, 9)), T(4, null),
    T(5, new Date(2026, 9, 8, 9), { done_at: '2026-10-08T10:00:00Z' }),
    T(6, new Date(2026, 9, 9, 11)),   // сегодня, но время прошло — просрочено
  ], NOW);
  assert.deepEqual([g.overdue, g.today, g.later, g.nodue].map((l) => l.map((t) => t.id)), [[1, 6], [2], [3], [4]]);
});

test('taskQuery — одно правило для списка и счётчика: мои / все / без ответственного / по сотруднику', () => {
  const descOf = (who) => {
    let d = null;
    const b = { select(c, o) { d = { cols: c, count: o && o.count, filters: [] }; return b; },
      is(col, val) { d.filters.push({ col, op: 'is', val }); return b; }, eq(col, val) { d.filters.push({ col, op: 'eq', val }); return b; } };
    taskQuery({ from: () => b }, { who, me: 21 });
    return d;
  };
  assert.equal(descOf('me').cols, TASK_LIST_SELECT);
  // та же строка компилируется настоящим сервером в server/routes/crm-unify-tasks.test.js
  // (страж db-query-schema переменную колонок не видит)
  assert.equal(TASK_LIST_SELECT, 'id, request_id, text, due_at, assignee_id, done_at, users(full_name), crm_requests(id, full_name, phone, status, assigned_to)');
  assert.deepEqual(descOf('me').filters, [{ col: 'done_at', op: 'is', val: null }, { col: 'assignee_id', op: 'eq', val: 21 }]);
  assert.deepEqual(descOf('all').filters, [{ col: 'done_at', op: 'is', val: null }]);
  assert.deepEqual(descOf('none').filters, [{ col: 'done_at', op: 'is', val: null }, { col: 'assignee_id', op: 'is', val: null }]);
  assert.deepEqual(descOf('24').filters, [{ col: 'done_at', op: 'is', val: null }, { col: 'assignee_id', op: 'eq', val: 24 }]);
});

test('по умолчанию — мои: запрос с assignee_id = я; оператору выбора нет', async () => {
  S.tasks = [T(1, new Date(2026, 9, 8, 9))];
  const root = mk('div');
  CALLS.length = 0;
  await renderTasksView(root, { who: 'me', me: 21, canPick: false, onOpen: () => {} });
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select');
  assert.ok(q.filters.some((f) => f.col === 'assignee_id' && f.op === 'eq' && f.val === 21));
  assert.ok(q.filters.some((f) => f.col === 'done_at' && f.op === 'is'));
  assert.equal(q.columns, TASK_LIST_SELECT);
  assert.equal(byAttr(root, 'data-task-who-filter').length, 0, 'оператору предложен выбор чужих задач');
  assert.ok(textOf(root).includes('Просрочено'));
});

test('руководитель выбирает: мои, все операторы, без ответственного, по имени', async () => {
  S.tasks = [];
  const root = mk('div');
  const picked = [];
  await renderTasksView(root, { who: 'all', me: 7, canPick: true, staff: [{ id: 21, full_name: 'Оператор А' }], onWho: (w) => picked.push(w) });
  const sel = byAttr(root, 'data-task-who-filter')[0];
  assert.ok(sel, 'руководителю не предложен выбор');
  assert.deepEqual(walk(sel).filter((n) => n.tagName === 'OPTION').map((o) => o.value), ['me', 'all', 'none', '21']);
  assert.equal(sel.value, 'all');
  sel.value = '21';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  assert.deepEqual(picked, ['21']);
  assert.ok(textOf(root).includes('Открытых задач нет.'));
});

test('строка открывает карточку; задача на чужой карточке — «Карточка у другого оператора», не открывается, но отмечается', async () => {
  S.tasks = [T(1, null), T(2, null, { crm_requests: null })];
  const opened = [];
  let changed = 0;
  const root = mk('div');
  CALLS.length = 0;
  await renderTasksView(root, { who: 'me', me: 21, onOpen: (id) => opened.push(id), onChanged: () => { changed++; } });
  const rows = byAttr(root, 'data-task-row');
  assert.equal(rows.length, 2);
  const mine = rows.find((r) => textOf(r).includes('Задача 1'));
  const foreign = rows.find((r) => textOf(r).includes('Задача 2'));
  mine.click(); foreign.click(); await tick();
  assert.deepEqual(opened, [101]);
  assert.ok(textOf(foreign).includes('Карточка у другого оператора'));
  assert.ok(textOf(mine).includes('Карточка 1'));
  // отметить «сделано» на чужой карточке можно
  const box = byAttr(foreign, 'data-task-done')[0];
  box.checked = true;
  box.dispatchEvent({ type: 'change', target: box, currentTarget: box });
  await tick();
  const upd = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'update');
  assert.ok(upd, 'отметка не ушла');
  assert.ok(upd.filters.some((f) => f.col === 'id' && f.val === 2));
  assert.match(upd.values.done_at, /Z$/);
  assert.equal(changed, 1);
});

test('доска: третий вид «Задачи» — фильтры доски скрыты, по умолчанию мои; строка открывает окно заявки', async () => {
  window.easymed.state.user = LOLA;
  S.leads = [{ id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call',
    created_at: '2026-09-03T10:12:00Z', assigned_to: 12, users: { full_name: 'Оператор Лола' } }];
  S.tasks = [{ id: 5, request_id: 1, text: 'Перезвонить Азизе', due_at: null, assignee_id: 12, done_at: null,
    crm_requests: { id: 1, full_name: 'Каримова Азиза', phone: '901', status: 'in_process', assigned_to: 12 }, users: { full_name: 'Оператор Лола' } }];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const btn = walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'tasks');
  assert.ok(btn, 'нет переключателя «Задачи»');
  CALLS.length = 0;
  btn.click();
  await tick(60);
  assert.equal(byAttr(root, 'data-crm-filters').length, 0, 'фильтры доски в виде «Задачи»');
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select' && c.columns === TASK_LIST_SELECT);
  assert.ok(q && q.filters.some((f) => f.col === 'assignee_id' && f.val === 12), 'вид открылся не на «Мои»');
  const row = byAttr(root, 'data-task-row')[0];
  assert.ok(row && textOf(row).includes('Перезвонить Азизе'));
  row.click();
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal && walk(modal).some((n) => n.value === 'Каримова Азиза'), 'строка не открыла карточку');
  window.easymed.state.user = null;
});

test('доска: карточку не из загруженных вид достаёт с сервера; невидимая — понятный отказ', async () => {
  window.easymed.state.user = ADMIN;
  S.leads = [];
  S.tasks = [{ id: 9, request_id: 77, text: 'Старая', due_at: null, assignee_id: 7, done_at: null,
    crm_requests: { id: 77, full_name: 'Не загружена', phone: '901', status: 'in_process', assigned_to: 7 }, users: { full_name: 'Админ' } }];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'tasks').click();
  await tick(60);
  assert.ok(byAttr(root, 'data-task-who-filter').length === 1, 'администратору нет выбора оператора');
  CALLS.length = 0;
  byAttr(root, 'data-task-row')[0].click();
  await tick(60);
  const one = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'select' && c.single);
  assert.ok(one && one.filters.some((f) => f.col === 'id' && String(f.val) === '77'), 'карточка не запрошена с сервера');
  window.easymed.state.user = null;
  assert.ok(byClass(root, 'crm-tv-row').length >= 1);
});
