// CRM_UNIFY_V1 (итоговое ревью) — ОБЩИЙ ПРОГОН «НИ ОДНОЙ КИРИЛЛИЧЕСКОЙ БУКВЫ».
// Это НЕ тестовый файл (нет «.test.» в имени): его импортируют
// crm-i18n-leaks-en.test.mjs и crm-i18n-leaks-uz.test.mjs. Каждый ставит свой
// язык ДО импорта видов (стенд прибивает 'ru'), рисует доску, «Список», вид
// «Задачи», «Отчёт» и «CRM-канбан» на латинских данных и собирает всё, что
// осталось кириллицей. Раньше утекали подписи источников («Звонок · N») и
// ступеней в «Отчёте» («Пришёл · N»): к ним приклеивали число ДО перевода.
import assert from 'node:assert/strict';
import { S, mk, walk, byAttr, tick, TOASTS } from './crm-harness.mjs';

const CYR = /[А-Яа-яЁёҚқҒғЎўҲҳ]/;
function leaks(root) {
  const out = new Set();
  for (const n of walk(root)) {
    if (n.tagName === 'SVG') continue;
    if (n._t && typeof n._t === 'string' && CYR.test(n._t)) out.add('text: ' + n._t.trim());
    for (const a of ['title', 'aria-label', 'placeholder']) if (n.attrs && CYR.test(n.attrs[a] || '')) out.add(a + ': ' + n.attrs[a]);
  }
  return [...out];
}
const ADMIN = { id: 7, full_name: 'Admin', role: 'admin', is_admin: true, extra_roles: [] };
const LEADS = [
  { id: 1, full_name: 'Karimova Aziza', phone: '+998942846494', status: 'in_process', source: 'call', created_at: '2026-10-08T10:12:00Z', assigned_to: 7, users: { full_name: 'Admin' } },
  { id: 2, full_name: 'Tursunov Bek', phone: '+998901112233', status: 'recall', source: 'call', created_at: '2026-10-08T10:12:00Z', assigned_to: null, users: null },
  ...Array.from({ length: 300 }, (_, i) => ({ id: 1000 - i, full_name: 'Came ' + i, phone: '+99890' + (2000000 + i), status: 'came', source: 'call', created_at: '2026-10-01T10:00:00Z', assigned_to: null, users: null })),
];
const TASKS = [
  { id: 5, request_id: 1, text: 'Call back', due_at: '2026-01-01T09:00:00Z', assignee_id: 7, done_at: null, users: { full_name: 'Admin' }, crm_requests: { id: 1, full_name: 'Karimova Aziza', phone: '901', status: 'in_process', assigned_to: 7 } },
  { id: 6, request_id: 2, text: 'Ask about MRI', due_at: null, assignee_id: 24, done_at: null, users: { full_name: 'Operator B' }, crm_requests: null },
];

/** Нарисовать все поверхности на языке `lang` и вернуть найденную кириллицу по местам. */
export async function crmLeaks(lang) {
  localStorage.setItem('admin.lang', lang);   // после стенда (он ставит 'ru'), до видов
  const { renderCrm, crmExcelRows } = await import('../views/crm.js');
  const { renderTasksView } = await import('../views/crm-tasks-view.js');
  const { renderCrmSettings } = await import('../views/crm-settings.js');
  const { getLang } = await import('../i18n.js');
  assert.equal(getLang(), lang);
  window.easymed.state.user = ADMIN;
  S.config = null; S.leads = LEADS; S.tasks = TASKS; S.countFor = { came: 4321 };
  S.staff = [{ id: 7, full_name: 'Admin', role: 'admin' }, { id: 24, full_name: 'Operator B', role: 'callcenter' }];
  S.dups = [{ can_open: false, foreign: true }];
  TOASTS.length = 0;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const found = {};
  found.kanban = leaks(root);
  byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'me').click(); await tick(60);
  found.kanbanMine = leaks(root);
  byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'all').click(); await tick(60);
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  inp.value = '909092638'; inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560); await tick(40);
  assert.equal(byAttr(root, 'data-crm-foreign-hint').length, 1);
  found.foreignHint = leaks(byAttr(root, 'data-crm-foreign-hint')[0]);
  inp.value = ''; inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560); await tick(40);
  byAttr(root, 'data-crm-view').find((n) => n.getAttribute('data-crm-view') === 'list').click(); await tick(60);
  found.list = leaks(root);
  byAttr(root, 'data-crm-view').find((n) => n.getAttribute('data-crm-view') === 'tasks').click(); await tick(80);
  found.tasks = leaks(root);
  const tv = mk('div');
  await renderTasksView(tv, { who: 'all', me: 7, canPick: true, staff: [{ id: 24, full_name: 'Operator B' }] });
  found.tasksAll = leaks(tv);
  byAttr(root, 'data-crm-view').find((n) => n.getAttribute('data-crm-view') === 'kanban').click(); await tick(60);
  byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'none').click(); await tick(60);
  const reportBtn = walk(root).find((n) => n.tagName === 'BUTTON' && walk(n).some((c) => c._t && /Report|Hisobot|Отчёт/.test(c._t)));
  reportBtn.click(); await tick(80);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  found.report = leaks(modal);
  modal.remove();
  byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'all').click(); await tick(60);
  const set = mk('div');
  await renderCrmSettings(set); await tick();
  found.settings = leaks(set);
  const xls = crmExcelRows(LEADS.slice(0, 2));
  found.excel = [...xls[0], ...xls.slice(1).map((r) => r[6])].filter((x) => CYR.test(String(x)));
  found.toasts = TOASTS.filter((t) => CYR.test(t));
  S.countFor = null; S.dups = []; window.easymed.state.user = null;
  return found;
}
