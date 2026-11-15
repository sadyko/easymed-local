// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — задачи на карточке заявки.
//
// Владелец: «add tasks to the card of the crm». Решено: список — текст, дата и
// время, ответственный, отметка «сделано»; красный счётчик просроченных у
// пункта CRM в меню — ответственному свои, администратору все. Проверяется то,
// что отрисовалось, и то, что ушло на сервер.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, RPC, mk, walk, textOf, byClass, byAttr, tick, TOASTS, crmView } from './crm-harness.mjs';
import { isOverdue, nearestOpenTasks, localDueIso, nowIso, overdueTaskCount, DEFAULT_DUE_TIME, TASK_LIST_SELECT } from '../views/crm-tasks.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { renderCrm, openCrmTasks } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LOLA = { id: 12, full_name: 'Оператор Лола', role: 'callcenter' };
const PAST = '2026-01-01T09:00:00Z';
const FUTURE = '2099-01-01T09:00:00Z';
const LEAD = { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call',
  created_at: '2026-09-03T10:12:00Z', assigned_to: 12, users: { full_name: 'Оператор Лола' } };

async function board(user, leads = [LEAD]) {
  window.easymed.state.user = user;
  S.leads = leads;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
async function openCard(user, lead = LEAD) {
  const root = await board(user, [lead]);
  const card = byClass(root, 'crm-card')[0];
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  return { root, modal };
}
const tasksBox = (modal) => byAttr(modal, 'data-crm-tasks')[0];
const taskRows = (modal) => byClass(modal, 'crm-task');
const one = (modal, a) => byAttr(modal, a)[0];

test('чистые правила: просрочено, ближайшая задача, срок из местных даты и времени', () => {
  const now = '2026-09-23T12:00:00Z';
  assert.equal(isOverdue({ due_at: '2026-09-23T11:59:00Z' }, now), true);
  assert.equal(isOverdue({ due_at: now }, now), true, 'срок ровно сейчас — уже пора');
  assert.equal(isOverdue({ due_at: '2026-09-23T12:01:00Z' }, now), false);
  assert.equal(isOverdue({ due_at: PAST, done_at: now }, now), false, 'сделанная не просрочена');
  assert.equal(isOverdue({ due_at: null }, now), false);
  const m = nearestOpenTasks([
    { id: 1, request_id: 5, due_at: '2026-09-25T09:00:00Z' },
    { id: 2, request_id: 5, due_at: '2026-09-24T09:00:00Z' },
    { id: 3, request_id: 5, due_at: '2026-09-20T09:00:00Z', done_at: '2026-09-20T10:00:00Z' },
    { id: 4, request_id: 6, due_at: null },
  ]);
  assert.equal(m.get('5').id, 2);
  assert.equal(m.get('6').id, 4);
  const iso = localDueIso('2026-10-05', '14:30');
  assert.match(iso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/);
  assert.equal(new Date(iso).getHours(), 14, 'местное время не сохранилось');
  assert.equal(localDueIso('', '10:00'), '');
  // Ревью W2-M7: время по умолчанию одно — в поле и в запасном значении.
  assert.equal(new Date(localDueIso('2026-10-05', '')).getHours(), Number(DEFAULT_DUE_TIME.slice(0, 2)));
  assert.match(nowIso(), /Z$/);
});

test('карточка без задач: блок «Задачи» с пустым списком, на доске метки нет', async () => {
  S.tasks = [];
  const { root, modal } = await openCard(ADMIN);
  const box = tasksBox(modal);
  assert.ok(box, 'в окне заявки нет блока задач');
  assert.ok(textOf(modal).includes('Задачи'));
  assert.ok(byAttr(box, 'data-crm-tasks-empty').length === 1 && textOf(box).includes('Задач пока нет.'));
  assert.equal(byClass(root, 'crm-card-task').length, 0);
  // Блок стоит между «Комментарий» и «Звонки»
  const t = textOf(modal);
  assert.ok(t.indexOf('Комментарий') < t.indexOf('Задачи') && t.indexOf('Задачи') < t.indexOf('Звонки по этому номеру'),
    'блок задач не между комментарием и звонками');
});

test('у новой заявки задач нет — задаче не к чему привязаться', async () => {
  const root = await board(ADMIN, []);
  const btn = walk(root).find((n) => n.tagName === 'BUTTON' && /Новая заявка/.test(textOf(n)));
  btn.click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.equal(tasksBox(modal), undefined);
});

test('создать: текст, дата без ограничения сверху, время, ответственный по умолчанию — оператор заявки', async () => {
  // CRM_UNIFY_V1 — список ответственных приходит от сервера (crm_task_assignees).
  S.assignees = [{ id: 12, full_name: 'Оператор Лола' }];
  S.tasks = []; CALLS.length = 0;
  const { modal } = await openCard(ADMIN);
  const date = one(modal, 'data-task-date');
  assert.equal(date.getAttribute('type'), 'date');
  assert.equal(date.getAttribute('max'), null, 'у даты задачи есть max — будущую дату не выбрать');
  assert.equal(one(modal, 'data-task-who').value, '12', 'ответственный по умолчанию — не оператор заявки');
  assert.equal(one(modal, 'data-task-time').getAttribute('value'), DEFAULT_DUE_TIME);

  one(modal, 'data-task-text').value = 'Перезвонить после обеда';
  date.value = '2099-01-01';
  one(modal, 'data-task-time').value = '14:30';
  one(modal, 'data-task-add').click();
  await tick(60);
  const ins = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'insert');
  assert.ok(ins, 'задача не ушла на сервер');
  assert.equal(ins.values.request_id, 1);
  assert.equal(ins.values.text, 'Перезвонить после обеда');
  assert.equal(ins.values.assignee_id, 12);
  assert.ok(!('created_by' in ins.values), 'экран шлёт created_by — его ставит сервер');
  assert.equal(new Date(ins.values.due_at).getHours(), 14);
  assert.ok(!('done_at' in ins.values));
  assert.equal(taskRows(modal).length, 1);
  assert.ok(textOf(taskRows(modal)[0]).includes('Перезвонить после обеда'));
  assert.ok(textOf(taskRows(modal)[0]).includes('Оператор Лола'));
});

test('без текста или без даты — отказ словами, ничего не вставлено', async () => {
  S.tasks = []; CALLS.length = 0; TOASTS.length = 0;
  const { modal } = await openCard(ADMIN);
  one(modal, 'data-task-add').click();
  await tick(30);
  one(modal, 'data-task-text').value = 'Позвонить';
  one(modal, 'data-task-add').click();
  await tick(30);
  assert.equal(CALLS.filter((c) => c.table === 'crm_tasks' && c.op === 'insert').length, 0);
  assert.ok(TOASTS.some((t) => t.includes('Напишите, что нужно сделать.')));
  assert.ok(TOASTS.some((t) => t.includes('Укажите дату задачи.')));
});

// CRM_UNIFY_V1 — ПРАВИЛО ИЗМЕНЕНО НАМЕРЕННО: раньше у заявки без оператора
// ответственным по умолчанию становился «я» — администратор и руководитель
// ставили задачи себе. Теперь у ничьей карточки выбор обязателен, а список
// людей — от сервера (crm_task_assignees): только те, кто может вести карточку.
test('CRM_UNIFY_V1: у ничьей карточки ответственный не выбран; без выбора задача не создаётся', async () => {
  S.tasks = []; CALLS.length = 0; TOASTS.length = 0;
  S.assignees = [{ id: 7, full_name: 'Админ' }, { id: 12, full_name: 'Оператор Лола' }];
  const { modal } = await openCard(LOLA, { ...LEAD, assigned_to: null, users: null });
  await tick(30);
  assert.equal(one(modal, 'data-task-who').value, '', 'у ничьей карточки ответственный снова «я»');
  const first = walk(one(modal, 'data-task-who')).find((n) => n.tagName === 'OPTION');
  assert.ok(textOf(first).includes('— выберите ответственного —'));
  one(modal, 'data-task-text').value = 'Перезвонить';
  one(modal, 'data-task-date').value = '2099-01-01';
  one(modal, 'data-task-add').click();
  await tick(30);
  assert.ok(TOASTS.some((t) => t.includes('Выберите ответственного.')));
  assert.equal(CALLS.filter((c) => c.table === 'crm_tasks' && c.op === 'insert').length, 0, 'задача создана без ответственного');
  // выбрал — создаётся
  const who = one(modal, 'data-task-who');
  who.value = '7';
  who.dispatchEvent({ type: 'change', target: who, currentTarget: who });
  one(modal, 'data-task-add').click();
  await tick(60);
  const ins = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'insert');
  assert.ok(ins, 'задача с выбранным ответственным не ушла');
  assert.equal(ins.values.assignee_id, 7);
});

test('CRM_UNIFY_V1: список ответственных — ровно ответ сервера (кто может вести карточку)', async () => {
  S.tasks = []; RPC.length = 0;
  S.assignees = [{ id: 12, full_name: 'Оператор Лола' }, { id: 24, full_name: 'Руководитель' }];
  const { modal } = await openCard(ADMIN);
  await tick(30);
  const opts = walk(one(modal, 'data-task-who')).filter((n) => n.tagName === 'OPTION').map((o) => o.value);
  assert.deepEqual(opts, ['', '12', '24'], 'в списке «я» или кто-то, кого сервер не предлагал');
  assert.equal(one(modal, 'data-task-who').value, '12', 'по умолчанию не оператор карточки');
  assert.ok(RPC.some((r) => r.name === 'crm_task_assignees' && r.body.request_id === 1));
});

test('CRM_UNIFY_V1: оператор карточки, который вести её не может, по умолчанию не ставится', async () => {
  S.tasks = [];
  S.assignees = [{ id: 24, full_name: 'Руководитель' }];   // Лолы (12) в ответе нет — уволена или «просмотр»
  const { modal } = await openCard(ADMIN);
  await tick(30);
  assert.equal(one(modal, 'data-task-who').value, '', 'по умолчанию стоит тот, кого сервер не предлагает');
});

test('CRM_UNIFY_V1: список ответственных не загрузился — понятное сообщение, задачу не поставить с угаданным ответственным', async () => {
  S.tasks = []; CALLS.length = 0; TOASTS.length = 0;
  S.assignees = [{ id: 12, full_name: 'Оператор Лола' }];
  S.assigneesError = 'сбой сети';
  try {
    const { modal } = await openCard(ADMIN);
    await tick(30);
    const who = one(modal, 'data-task-who');
    assert.equal(who.value, '', 'ответственный угадан без ответа сервера');
    assert.ok(who.disabled, 'поле «Ответственный» доступно без списка');
    const note = one(modal, 'data-task-who-error');
    assert.ok(note && textOf(note).includes('Список ответственных не загрузился'), 'нет сообщения о сбое');
    one(modal, 'data-task-text').value = 'Перезвонить';
    one(modal, 'data-task-date').value = '2099-01-01';
    one(modal, 'data-task-add').click();
    await tick(30);
    assert.equal(CALLS.filter((c) => c.table === 'crm_tasks' && c.op === 'insert').length, 0, 'задача ушла с угаданным ответственным');
    assert.ok(TOASTS.some((t) => t.includes('Список ответственных не загрузился')));
  } finally { S.assigneesError = null; }
});

test('просроченная задача — предупреждающий стиль в окне и метка на доске', async () => {
  S.tasks = [
    { id: 50, request_id: 1, text: 'Уточнить анализы', due_at: PAST, assignee_id: 12, done_at: null, users: { full_name: 'Оператор Лола' } },
    { id: 51, request_id: 1, text: 'Напомнить о приёме', due_at: FUTURE, assignee_id: 12, done_at: null, users: { full_name: 'Оператор Лола' } },
  ];
  const { root, modal } = await openCard(ADMIN);
  const rows = taskRows(modal);
  assert.equal(rows.length, 2);
  const late = rows.find((r) => textOf(r).includes('Уточнить анализы'));
  const ok = rows.find((r) => textOf(r).includes('Напомнить о приёме'));
  assert.ok(String(late.className).includes('crm-task-overdue'));
  assert.ok(textOf(late).includes('Просрочено'));
  assert.ok(!String(ok.className).includes('crm-task-overdue'));
  const chip = byClass(root, 'crm-card-task');
  assert.equal(chip.length, 1);
  // CRM_UNIFY_V1 — чип называет, чья задача (было «задача: …» без исполнителя).
  assert.ok(textOf(chip[0]).includes('задача (Оператор Лола): Уточнить анализы'), 'на доске не ближайшая задача или не назван исполнитель');
  assert.ok(String(chip[0].className).includes('crm-card-task-late'));
});

test('отметить сделанной и снять отметку', async () => {
  S.tasks = [{ id: 60, request_id: 1, text: 'Позвонить', due_at: PAST, assignee_id: 12, done_at: null }];
  CALLS.length = 0;
  const { modal } = await openCard(LOLA);
  // CRM_CARD_TASK_DONE_V1 — «Готово» кнопкой, снять отметку — «Вернуть».
  const box = one(modal, 'data-task-done');
  assert.equal(box.tagName, 'BUTTON');
  assert.ok(textOf(box).includes('Готово'));
  box.click();
  await tick(60);
  const upd = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'update');
  assert.ok(upd, 'отметка не ушла на сервер');
  assert.ok(!('done_by' in upd.values), 'экран шлёт done_by — его ставит сервер');
  assert.match(upd.values.done_at, /Z$/);
  assert.ok(String(taskRows(modal)[0].className).includes('crm-task-done'));
  assert.ok(!String(taskRows(modal)[0].className).includes('crm-task-overdue'), 'сделанная всё ещё просрочена');

  const box2 = one(modal, 'data-task-done');
  assert.ok(textOf(box2).includes('Вернуть'), 'у сделанной задачи нет «Вернуть»');
  box2.click();
  await tick(60);
  assert.equal(S.tasks[0].done_at, null);
});

test('удалить может только администратор', async () => {
  S.tasks = [{ id: 70, request_id: 1, text: 'Лишняя', due_at: FUTURE, assignee_id: 12, done_at: null }];
  let { modal } = await openCard(LOLA);
  assert.equal(byAttr(modal, 'data-task-delete').length, 0, 'оператору показали удаление');
  ({ modal } = await openCard(ADMIN));
  CALLS.length = 0;
  one(modal, 'data-task-delete').click();
  await tick(60);
  assert.ok(CALLS.some((c) => c.table === 'crm_tasks' && c.op === 'delete'));
  assert.equal(taskRows(modal).length, 0);
});

// CRM_TASK_EDIT_V1 — карандаш у открытой задачи: правка текста и срока на месте,
// «Отмена» ничего не шлёт; у сделанной задачи карандаша нет.
test('CRM_TASK_EDIT_V1: задачу можно изменить — текст и срок уходят на сервер, «Отмена» ничего не шлёт', async () => {
  S.tasks = [
    { id: 80, request_id: 1, text: 'Позвонить', due_at: FUTURE, assignee_id: 12, done_at: null },
    { id: 81, request_id: 1, text: 'Сделанная', due_at: PAST, assignee_id: 12, done_at: PAST },
  ];
  const { modal } = await openCard(LOLA);
  assert.equal(byAttr(modal, 'data-task-edit').length, 1, 'карандаш — только у открытой задачи');
  CALLS.length = 0;
  one(modal, 'data-task-edit').click();
  assert.equal(byAttr(modal, 'data-task-editing').length, 1, 'строка не перешла в правку');
  one(modal, 'data-task-edit-cancel').click();
  assert.equal(byAttr(modal, 'data-task-editing').length, 0, '«Отмена» не вернула строку');
  assert.ok(!CALLS.some((c) => c.table === 'crm_tasks' && c.op === 'update'), '«Отмена» что-то отправила');

  one(modal, 'data-task-edit').click();
  const txt = one(modal, 'data-task-edit-text');
  assert.equal(txt.value, 'Позвонить', 'в поле не нынешний текст');
  txt.value = 'Перезвонить после обеда';
  one(modal, 'data-task-edit-date').value = '2030-01-15';
  one(modal, 'data-task-edit-time').value = '14:30';
  one(modal, 'data-task-edit-save').click();
  await tick(60);
  const upd = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'update');
  assert.ok(upd, 'правка не ушла на сервер');
  assert.equal(upd.values.text, 'Перезвонить после обеда');
  assert.match(upd.values.due_at, /^2030-01-15T/);
  assert.ok(!('assignee_id' in upd.values), 'ответственный не менялся, а ушёл на сервер');
  assert.equal(byAttr(modal, 'data-task-editing').length, 0, 'после сохранения строка осталась в правке');
});

// CRM_UNIFY_V1 — старая подпись { me, isAdmin } оставлена для совместимости;
// внутри — тот же taskQuery, что у вида «Задачи» (проверка ниже).
test('счётчик меню: оператору — свои просроченные, администратору — все', async () => {
  S.tasks = [
    { id: 1, request_id: 1, text: 'a', due_at: PAST, assignee_id: 12, done_at: null },
    { id: 2, request_id: 1, text: 'b', due_at: PAST, assignee_id: 12, done_at: null },
    { id: 3, request_id: 1, text: 'c', due_at: FUTURE, assignee_id: 12, done_at: null },
    { id: 4, request_id: 1, text: 'd', due_at: PAST, assignee_id: 12, done_at: PAST },
    { id: 5, request_id: 1, text: 'e', due_at: PAST, assignee_id: 13, done_at: null },
  ];
  CALLS.length = 0;
  assert.equal(await overdueTaskCount({ me: 12, isAdmin: false }), 2);
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select');
  assert.equal(q.count, 'exact');
  assert.ok(q.filters.some((f) => f.col === 'assignee_id' && f.op === 'eq' && f.val === 12));
  assert.equal(await overdueTaskCount({ me: 13, isAdmin: false }), 1);
  assert.equal(await overdueTaskCount({ me: 7, isAdmin: true }), 3);
  assert.equal(await overdueTaskCount({ me: null, isAdmin: false }), null, 'без «кто я» число выдумано');
});

// ---------------------------------------------------------------------------
// CRM_UNIFY_V1 (задача 13) — счётчик и вид «Задачи» — одно правило (taskQuery);
// чип называет исполнителя, своя задача первой; колонка «Задача» в «Списке».
// ---------------------------------------------------------------------------
test('CRM_UNIFY_V1: счётчик — тот же запрос, что у вида «Задачи»: «мои» и «все»', async () => {
  S.tasks = [
    { id: 1, request_id: 1, text: 'a', due_at: PAST, assignee_id: 12, done_at: null },
    { id: 2, request_id: 1, text: 'b', due_at: PAST, assignee_id: 12, done_at: null },
    { id: 3, request_id: 1, text: 'c', due_at: FUTURE, assignee_id: 12, done_at: null },
    { id: 4, request_id: 1, text: 'd', due_at: PAST, assignee_id: 13, done_at: null },
  ];
  CALLS.length = 0;
  assert.equal(await overdueTaskCount({ who: 'me', me: 12 }), 2);
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select');
  assert.equal(q.count, 'exact');
  assert.deepEqual(q.filters.filter((f) => f.col !== 'due_at'),
    [{ col: 'done_at', op: 'is', val: null }, { col: 'assignee_id', op: 'eq', val: 12 }], 'отбор счётчика разошёлся с видом');
  assert.ok(q.filters.some((f) => f.col === 'due_at' && f.op === 'lte'));
  assert.equal(await overdueTaskCount({ who: 'all', me: 7 }), 3);
  assert.equal(await overdueTaskCount({ who: 'me', me: null }), null);
});

test('CRM_UNIFY_V1: ближайшая задача карточки — сначала своя, потом по сроку', () => {
  const m = nearestOpenTasks([
    { id: 1, request_id: 5, due_at: '2026-10-01T09:00:00Z', assignee_id: 22 },
    { id: 2, request_id: 5, due_at: '2026-10-05T09:00:00Z', assignee_id: 21 },
    { id: 3, request_id: 5, due_at: '2026-10-07T09:00:00Z', assignee_id: 21 },
  ], 21);
  assert.equal(m.get('5').id, 2);
  assert.equal(nearestOpenTasks([{ id: 1, request_id: 5, due_at: '2026-10-01T09:00:00Z', assignee_id: 22 }], 21).get('5').id, 1);
  assert.equal(nearestOpenTasks([
    { id: 1, request_id: 5, due_at: '2026-10-01T09:00:00Z', assignee_id: 22 },
    { id: 2, request_id: 5, due_at: '2026-10-05T09:00:00Z', assignee_id: 21 },
  ]).get('5').id, 1, 'без «кто я» — просто ближайшая');
});

test('CRM_UNIFY_V1: чип называет исполнителя; своя — «вы» и первой; без исполнителя — как раньше', async () => {
  S.tasks = [
    { id: 80, request_id: 1, text: 'Чужая раньше', due_at: PAST, assignee_id: 24, done_at: null, users: { full_name: 'Руководитель' } },
    { id: 81, request_id: 1, text: 'Своя позже', due_at: FUTURE, assignee_id: 12, done_at: null, users: { full_name: 'Оператор Лола' } },
  ];
  let root = await board(LOLA);
  let chip = byClass(root, 'crm-card-task')[0];
  assert.ok(textOf(chip).includes('задача (вы): Своя позже'), 'своя задача не первой или не «вы»: ' + textOf(chip));
  root = await board(ADMIN);
  chip = byClass(root, 'crm-card-task')[0];
  assert.ok(textOf(chip).includes('задача (Руководитель): Чужая раньше'), textOf(chip));
  S.tasks = [{ id: 82, request_id: 1, text: 'Ничья', due_at: FUTURE, assignee_id: null, done_at: null }];
  root = await board(ADMIN);
  chip = byClass(root, 'crm-card-task')[0];
  assert.ok(textOf(chip).includes('задача: Ничья'), textOf(chip));
  // загрузка меток спрашивает, чья задача
  CALLS.length = 0;
  await board(ADMIN);
  // CRM_UNIFY_V1 (итоговое ревью) — ОБНОВЛЕНО НАМЕРЕННО: метки грузятся двумя
  // запросами с числом (со сроком / без срока, loadTaskRows) — ищем по колонкам.
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select' && !String(c.columns).includes('crm_requests('));
  assert.ok(q && /users\(full_name\)/.test(q.columns), 'метки задач грузятся без исполнителя');
});

test('CRM_UNIFY_V1: «Список» — колонка «Задача» говорит то же, что чип', async () => {
  S.tasks = [{ id: 90, request_id: 1, text: 'Перезвонить вечером', due_at: FUTURE, assignee_id: 12, done_at: null, users: { full_name: 'Оператор Лола' } }];
  window.easymed.state.user = ADMIN;
  S.leads = [LEAD, { ...LEAD, id: 2, full_name: 'Без задач', phone: '+998901112233' }];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  crmView(root, 'list');
  await tick(60);
  const heads = walk(root).filter((n) => n.tagName === 'TH').map(textOf);
  assert.ok(heads.includes('Задача'), 'в списке нет колонки «Задача»');
  const cells = byAttr(root, 'data-list-task');
  assert.equal(cells.length, 2);
  assert.ok(cells.some((c) => textOf(c).includes('задача (Оператор Лола): Перезвонить вечером')));
  assert.ok(cells.some((c) => textOf(c).trim() === '—'));
  window.easymed.state.user = null;
});

test('CRM_UNIFY_V1: красный счётчик открывает «Задачи» с тем же отбором (openCrmTasks)', async () => {
  window.easymed.state.user = ADMIN;
  S.leads = [LEAD];
  S.tasks = [{ id: 95, request_id: 1, text: 'Просрочена', due_at: PAST, assignee_id: 12, done_at: null,
    crm_requests: { id: 1, full_name: 'Каримова Азиза', phone: '901', status: 'in_process', assigned_to: 12 }, users: { full_name: 'Оператор Лола' } }];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  CALLS.length = 0;
  openCrmTasks('all');
  await tick(80);
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select' && c.columns === TASK_LIST_SELECT);
  assert.ok(q, 'вид «Задачи» не открылся');
  assert.ok(!q.filters.some((f) => f.col === 'assignee_id'), 'счётчик «все», а вид открылся на «мои»');
  assert.equal(byAttr(root, 'data-task-who-filter')[0].value, 'all');
  // переключатель вида после этого открывает «Мои»
  CALLS.length = 0;
  crmView(root, 'tasks');
  await tick(80);
  const q2 = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select' && c.columns === TASK_LIST_SELECT);
  assert.ok(q2.filters.some((f) => f.col === 'assignee_id' && f.val === 7), 'переключатель вида открыл не «Мои»');
  window.easymed.state.user = null;
});

test('CRM_UNIFY_V1: меню — счётчик считает тем отбором, с которым откроет «Задачи»; значок открывает вид', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', '..', 'admin.js'), 'utf8');
  assert.match(src, /import \{ renderCrm, openCrmTasks \}\s+from '\.\/admin\/views\/crm\.js\?v=phone1'/, 'другой спецификатор — второй экземпляр модуля доски');   // CRM_PHONE_V1 — штамп phone1
  const start = src.indexOf('async function loadNavCounts');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /state\.crmTaskWho = lifted \? 'all' : 'me'/);
  assert.match(body, /overdueTaskCount\(\{ me, who: state\.crmTaskWho \}\)/);
  assert.match(src, /'data-nav-crm-tasks': ''/);
  assert.match(src, /openCrmTasks\(state\.crmTaskWho \|\| 'me'\); navigate\('crm'\)/);
});

