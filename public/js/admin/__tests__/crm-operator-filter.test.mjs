// CRM_UNIFY_V1 — ФИЛЬТР «ОПЕРАТОР» (Р15). Владелец: «нет фильтра по оператору».
// Оператору — Все / Мои / Ничьи; администратору и руководителю (crm.all) — ещё
// и по имени. Фильтр работает в загрузке доски (до любого предела), в поиске
// (crm_search { assigned }), в filtered(), в «Списке», в Excel и в «Отчёте».
// Номер у чужой карточки — подсказка «есть у другого оператора», без самой
// карточки. Вид «Задачи» живёт своим отбором «Чьи задачи».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, RPC, mk, walk, textOf, byAttr, byClass, tick } from './crm-harness.mjs';
import { TASK_LIST_SELECT } from '../views/crm-tasks.js';

const { renderCrm, crmExcelRows } = await import('../views/crm.js');

const OPA = { id: 21, full_name: 'Оператор А', role: 'callcenter', extra_roles: [] };
const BOSS = { id: 23, full_name: 'Админ', role: 'admin', is_admin: true, extra_roles: [] };
const LEADS = [
  { id: 1, full_name: 'Мой Лид', phone: '+998901111111', status: 'in_process', source: 'call', assigned_to: 21, users: { full_name: 'Оператор А' }, created_at: '2026-10-08T10:00:00Z' },
  { id: 2, full_name: 'Ничей Лид', phone: '+998902222222', status: 'in_process', source: 'call', assigned_to: null, users: null, created_at: '2026-10-08T11:00:00Z' },
];
const STAFF = [
  { id: 21, full_name: 'Оператор А', role: 'callcenter', extra_roles: [] },
  { id: 22, full_name: 'Оператор Б', role: 'callcenter', extra_roles: [] },
  { id: 9, full_name: 'Кассир', role: 'cashier', extra_roles: [] },
];
async function boardAs(user, view) {
  window.easymed.state.user = user;
  S.leads = LEADS.map((l) => ({ ...l })); S.search = []; S.dups = []; S.tasks = []; S.staff = STAFF; S.config = null;
  CALLS.length = 0; RPC.length = 0;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  if (view) { walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === view).click(); await tick(60); }
  return root;
}
const chip = (root, key) => byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === key);
const boardReads = () => CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'select' && !c.single && c.columns !== 'id, status, source, sources, created_at, assigned_to');
// набор в поиске — как в crm-search.test.mjs (SEARCH_DEBOUNCE_V1: 500 мс паузы)
async function type(root, q) {
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  inp.value = q;
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560); await tick(30);
}
// Фильтр и поиск — состояние модуля: вернуть «Все» и пустой поиск после теста.
async function reset(root) {
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  if (inp && inp.value) await type(root, '');
  const all = chip(root, 'all');
  if (all && all.getAttribute('aria-pressed') !== 'true') { all.click(); await tick(60); }
  window.easymed.state.user = null;
}

test('оператору — Все / Мои / Ничьи, без выбора по имени; «Мои» уходит во ВСЕ запросы доски', async () => {
  const root = await boardAs(OPA);
  assert.deepEqual(byAttr(root, 'data-op-chip').map((n) => n.getAttribute('data-op-chip')), ['all', 'me', 'none']);
  assert.equal(byAttr(root, 'data-op-select').length, 0, 'оператору предложен выбор чужого оператора');
  CALLS.length = 0;
  chip(root, 'me').click(); await tick(60);
  const reads = boardReads();
  assert.ok(reads.length >= 2, 'доска не перезагрузилась');
  assert.ok(reads.every((q) => q.filters.some((f) => f.col === 'assigned_to' && f.op === 'eq' && f.val === 21)), 'фильтр ушёл не во все запросы доски');
  assert.equal(chip(root, 'me').getAttribute('aria-pressed'), 'true');
  // карточки доски — только мои (стенд применяет отбор)
  assert.deepEqual(byClass(root, 'crm-card').map((c) => textOf(c).includes('Мой Лид')), [true]);
  await reset(root);
});

test('руководителю — ещё и по имени (только те, кто ведёт доску); «Ничьи» — is null; по имени — eq', async () => {
  const root = await boardAs(BOSS);
  const sel = byAttr(root, 'data-op-select')[0];
  assert.ok(sel, 'администратору нет выбора по имени');
  assert.deepEqual(walk(sel).filter((n) => n.tagName === 'OPTION').map((o) => o.value), ['', '21', '22'], 'в выборе кассир или нет операторов');
  CALLS.length = 0;
  chip(root, 'none').click(); await tick(60);
  assert.ok(boardReads().every((q) => q.filters.some((f) => f.col === 'assigned_to' && f.op === 'is' && f.val === null)));
  CALLS.length = 0;
  const sel2 = byAttr(root, 'data-op-select')[0];
  sel2.value = '22';
  sel2.dispatchEvent({ type: 'change', target: sel2, currentTarget: sel2 });
  await tick(60);
  assert.ok(boardReads().every((q) => q.filters.some((f) => f.col === 'assigned_to' && f.op === 'eq' && f.val === 22)));
  assert.equal(byAttr(root, 'data-op-select')[0].value, '22');
  await reset(root);
});

test('поиск: фильтр оператора едет в crm_search; при «Все» тело прежнее; строки сервера тоже проходят фильтр', async () => {
  const root = await boardAs(OPA);
  await type(root, 'лид');
  assert.deepEqual(RPC.filter((r) => r.name === 'crm_search').pop().body, { q: 'лид' }, 'при «Все» в поиск ушёл фильтр');
  chip(root, 'me').click(); await tick(60);
  RPC.length = 0;
  // сервер (старый) вернул и ничью карточку — экран её всё равно не показывает при «Мои»
  S.search = () => [{ id: 50, full_name: 'Лид из поиска ничей', phone: '+998905550000', status: 'in_process', source: 'call', assigned_to: null, users: null, created_at: '2025-01-01T10:00:00Z' }];
  await type(root, 'лид из');
  assert.equal(RPC.filter((r) => r.name === 'crm_search').pop().body.assigned, 'me');
  assert.ok(!textOf(root).includes('Лид из поиска ничей'), 'карточка не того оператора показана при «Мои»');
  S.search = [];
  await reset(root);
});

test('номер у чужой карточки — подсказка «есть у другого оператора», без самой карточки; короткий запрос — не спрашивает', async () => {
  const root = await boardAs(OPA);
  S.dups = [{ can_open: false, foreign: true }];
  await type(root, '90909');
  assert.equal(RPC.filter((r) => r.name === 'crm_leads_by_phone').length, 0, 'номер короче 7 цифр проверен на чужие карточки');
  assert.equal(byAttr(root, 'data-crm-foreign-hint').length, 0);
  await type(root, '909092638');
  const ask = RPC.filter((r) => r.name === 'crm_leads_by_phone').pop();
  assert.ok(ask && ask.body.phone === '909092638');
  const hint = byAttr(root, 'data-crm-foreign-hint');
  assert.equal(hint.length, 1, 'нет подсказки «есть у другого оператора»');
  assert.ok(textOf(hint[0]).includes('Этот номер есть у карточки другого оператора'));
  assert.ok(!textOf(root).includes('can_open'));
  S.dups = [];
  await type(root, '909092639');
  assert.equal(byAttr(root, 'data-crm-foreign-hint').length, 0, 'подсказка осталась от прошлого номера');
  await reset(root);
});

test('«Список»: колонка «Оператор» прямо перед «Задача»; Excel — колонка «Оператор»', async () => {
  const root = await boardAs(BOSS, 'list');
  const heads = walk(root).filter((n) => n.tagName === 'TH').map(textOf);
  assert.equal(heads.indexOf('Оператор') + 1, heads.indexOf('Задача'), '«Оператор» не перед «Задача»: ' + heads.join(' | '));
  const cells = byAttr(root, 'data-list-operator').map(textOf);
  assert.deepEqual(cells.sort(), ['Оператор А', '—'].sort());
  const aoa = crmExcelRows(LEADS);
  const col = aoa[0].indexOf('Оператор');
  assert.ok(col > 0, 'в выгрузке нет колонки «Оператор»');
  assert.deepEqual(aoa.slice(1).map((r) => r[col]), ['Оператор А', '']);
  await reset(root);
});

test('«Отчёт» считает с фильтром оператора и называет его', async () => {
  const root = await boardAs(OPA);
  chip(root, 'none').click(); await tick(60);
  document.body.children.length = 0;
  CALLS.length = 0;
  walk(root).find((n) => n.tagName === 'BUTTON' && /Отчёт/.test(textOf(n))).click();
  await tick(60);
  const q = CALLS.find((c) => c.table === 'crm_requests' && c.columns === 'id, status, source, sources, created_at, assigned_to');
  assert.ok(q && q.filters.some((f) => f.col === 'assigned_to' && f.op === 'is' && f.val === null), 'отчёт посчитан без фильтра оператора');
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(byAttr(modal, 'data-report-operator').length && textOf(byAttr(modal, 'data-report-operator')[0]).includes('Оператор: Ничьи'));
  modal.remove();
  await reset(root);
});

test('вид «Задачи» — свой отбор «Чьи задачи»: фильтр «Оператор» его не меняет и в виде не рисуется', async () => {
  const root = await boardAs(BOSS);
  chip(root, 'none').click(); await tick(60);
  CALLS.length = 0;
  walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'tasks').click();
  await tick(80);
  assert.equal(byAttr(root, 'data-op-chip').length, 0, 'фильтр «Оператор» в виде «Задачи»');
  const q = CALLS.find((c) => c.table === 'crm_tasks' && c.op === 'select' && c.columns === TASK_LIST_SELECT);
  assert.ok(q && q.filters.some((f) => f.col === 'assignee_id' && f.op === 'eq' && f.val === 23), 'вид «Задачи» взял фильтр доски');
  walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click();
  await tick(60);
  await reset(root);
});
