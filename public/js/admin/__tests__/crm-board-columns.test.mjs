// CRM_UNIFY_V1 — КОЛОНКИ ДОСКИ: все карточки, без «Показать ещё»; у обрезанной
// закрытой колонки («Всё время», последние 300) — число из базы и подсказка;
// период перезагружает закрытые. Плюс замер: 2000+ открытых карточек.
// Владелец: «"Показать ещё 20" убрать, чтобы все карточки были в окне»,
// «карточки иногда пропадают» (Р12, Р13).
// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0, решение владельца Q1) — выбранный «Период»
// сужает КАЖДУЮ колонку (открытые тоже) по дате поступления; над доской строка
// «Период «…»: показаны заявки, поступившие … Открытых за другие дни: N — Показать
// все». CRM_FILTER_ALL_VALUE_V1 — «Все · N» = сумма чисел колонок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, mk, walk, textOf, byClass, byAttr, tick } from './crm-harness.mjs';
import { DEFAULT_STAGES } from '../crm-settings-logic.js?v=crmcfg1';

const { renderCrm, CRM_FILTER_ALL } = await import('../views/crm.js');
const { BOARD_SELECT, OUTSIDE_SELECT } = await import('../views/crm-board-load.js');   // CRM_PERIOD_ALL_COLUMNS_V1

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const lead = (id, status, extra = {}) => ({ id, full_name: 'Лид ' + id, phone: '+99890' + String(1000000 + id), status, source: 'call',
  created_at: '2026-10-01T10:00:00Z', ...extra });
async function board(leads) {
  window.easymed.state.user = ADMIN;
  S.config = null; S.leads = leads; S.search = []; S.tasks = []; S.leadTags = []; S.dups = [];
  CALLS.length = 0;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const colOf = (root, key) => walk(root).find((n) => n.attrs && n.attrs['data-col'] === key);
const countOf = (root, key) => textOf(byAttr(root, 'data-col-count').find((n) => n.getAttribute('data-col-count') === key));
const chipText = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));

test('в колонке все карточки, кнопки «Показать ещё» нет, число — настоящее', async () => {
  const root = await board(Array.from({ length: 25 }, (_, i) => lead(i + 1, 'in_process')));
  assert.equal(byClass(colOf(root, 'in_process'), 'crm-card').length, 25, 'колонка снова рисует только часть карточек');
  assert.ok(!walk(root).some((n) => n.tagName === 'BUTTON' && /Показать ещё/.test(textOf(n))));
  assert.equal(countOf(root, 'in_process'), '25');
  window.easymed.state.user = null;
});

test('открытые грузятся все: карточка старше 800 последних не пропадает', async () => {
  // 850 свежих закрытых «Не пришёл» и одна старая открытая — раньше её съедал предел 800.
  const leads = [lead(1, 'recall', { full_name: 'Старая живая заявка' }), ...Array.from({ length: 850 }, (_, i) => lead(i + 2, 'no_show'))];
  const root = await board(leads);
  const recall = colOf(root, 'recall');
  assert.ok(textOf(recall).includes('Старая живая заявка'), 'старая открытая карточка пропала с доски');
  const open = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'select' && (c.filters || []).some((f) => f.op === 'not.in'));
  assert.ok(open && open.limit === undefined, 'открытые снова с пределом');
  window.easymed.state.user = null;
});

test('«Всё время»: закрытая колонка упёрлась в 300 — в заголовке число из базы и подсказка; при поиске — число показанных', async () => {
  S.countFor = { came: 4321 };
  try {
    const root = await board(Array.from({ length: 300 }, (_, i) => lead(i + 1, 'came')));
    assert.equal(countOf(root, 'came'), '4321', 'в заголовке число загруженных, а не базы');
    const hint = byAttr(root, 'data-col-capped');
    assert.equal(hint.length, 1, 'нет подсказки «выберите период»');
    assert.ok(textOf(hint[0]).includes('Показаны последние 300'));
    assert.equal(byClass(colOf(root, 'came'), 'crm-card').length, 300);
    // поиск сужает показанное — итог базы под него не считан, число — по показанным
    const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
    inp.value = 'Лид 12';
    inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
    await tick(560); await tick(20);
    assert.notEqual(countOf(root, 'came'), '4321');
    assert.equal(byAttr(root, 'data-col-capped').length, 0);
    // поиск — состояние модуля: сбросить для следующих тестов
    inp.value = '';
    inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
    await tick(560); await tick(20);
  } finally { S.countFor = null; window.easymed.state.user = null; }
});

// CRM_PERIOD_ALL_COLUMNS_V1 — ОБНОВЛЕНО НАМЕРЕННО: открытые тоже грузятся за период
// (раньше — все, без даты), и отдельным лёгким запросом — открытые вне периода.
test('период: закрытые и открытые грузятся за период, без предела; открытые вне периода — лёгким запросом', async () => {
  const root = await board([lead(1, 'in_process'), lead(2, 'came')]);
  CALLS.length = 0;
  chipText(root, /^Сегодня$/).click();
  await tick(60);
  const reads = CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'select');
  const closed = reads.find((c) => (c.filters || []).some((f) => f.op === 'in' && f.col === 'status'));
  assert.ok(closed, 'смена периода не перезагрузила закрытые');
  assert.ok(closed.filters.some((f) => f.col === 'created_at' && f.op === 'gte'), 'закрытые не ограничены периодом');
  assert.equal(closed.limit, undefined);
  const open = reads.find((c) => c.columns === BOARD_SELECT && (c.filters || []).some((f) => f.op === 'not.in'));
  assert.ok(open, 'открытые не перезагружены');
  assert.ok(open.filters.some((f) => f.col === 'created_at' && f.op === 'gte'), 'открытые не ограничены периодом');
  assert.equal(open.limit, undefined);
  const lite = reads.find((c) => c.columns === OUTSIDE_SELECT);
  assert.ok(lite && lite.filters.some((f) => f.col === 'created_at' && f.op === 'lt'), 'открытые вне периода не спрошены');
  // вернуть «Всё время» — модульное состояние общее для тестов файла
  chipText(root, /^Всё время$/).click();
  await tick(60);
  window.easymed.state.user = null;
});

test('замер: 2000+ открытых карточек рисуются и перерисовываются поиском за разумное время', async () => {
  const stages = ['in_process', 'recall', 'scheduled', 'approved'];
  const leads = Array.from({ length: 2400 }, (_, i) => lead(i + 1, stages[i % 4], { note: i % 3 ? 'Перезвонить после обеда' : null }));
  const t0 = performance.now();
  const root = await board(leads);
  const tRender = performance.now() - t0;
  assert.equal(byClass(root, 'crm-card').length, 2400);
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  const t1 = performance.now();
  inp.value = 'Лид 12';
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560);
  const tSearch = performance.now() - t1 - 560;
  const t2 = performance.now();
  inp.value = '';
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560);
  const tClear = performance.now() - t2 - 560;
  console.log(`[замер CRM_UNIFY_V1] 2400 открытых: первая отрисовка ${tRender.toFixed(0)} мс (с загрузкой), поиск ${Math.max(0, tSearch).toFixed(0)} мс, сброс поиска ${Math.max(0, tClear).toFixed(0)} мс (поддельный DOM)`);
  assert.equal(byClass(root, 'crm-card').length, 2400);
  // Порог щедрый: поддельный DOM медленнее браузера по-своему; ловим порядок, а не миллисекунды.
  assert.ok(tRender < 8000, 'первая отрисовка 2400 карточек дольше 8 с');
  window.easymed.state.user = null;
});

// ---------------------------------------------------------------------------
// CRM_UNIFY_V1 — ИТОГОВОЕ РЕВЬЮ (C3, C4, C6).
// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0) — C3 ПЕРЕПИСАН НАМЕРЕННО. Было (решение
// контролёра 3.17): «Период» не прячет открытые, сужает только закрытые. Владелец
// (2026-11-10): фильтр «не работает» — при «Сегодня» на доске тысячи давних
// открытых. Решение Q1: период — по дате поступления, в КАЖДОЙ колонке; давние
// открытые называет строка над доской, «Показать все» возвращает «Всё время».
// ---------------------------------------------------------------------------
const DAY = 86400000;
const isoAgo = (days) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const asDb = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');   // так created_at пишет база
const periodLine = (root) => byAttr(root, 'data-crm-period-line')[0] || null;
const showAllBtn = (root) => walk(periodLine(root)).find((n) => n.tagName === 'BUTTON' && n.attrs && 'data-crm-period-all' in n.attrs);
const dmy = (ymd) => ymd.split('-').reverse().join('.');
const ymdOf = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

test('C3 (3.23.0): «Период» сужает каждую колонку — открытые и «Не пришёл» тоже; строка над доской называет давние открытые', async () => {
  const leads = [
    lead(1, 'recall', { full_name: 'Старый Перезвон', created_at: isoAgo(40) }),
    lead(2, 'recall', { full_name: 'Сегодняшний', created_at: isoAgo(0) }),
    lead(3, 'came', { full_name: 'Давний Пришедший', created_at: isoAgo(40) }),
    lead(4, 'came', { full_name: 'Пришёл сегодня', created_at: isoAgo(0) }),
    lead(5, 'no_show', { full_name: 'Давний Не пришёл', created_at: isoAgo(40) }),
    lead(6, 'in_process', { full_name: 'Давний В обработке', created_at: isoAgo(40) }),
  ];
  const root = await board(leads);
  try {
    assert.equal(periodLine(root), null, '«Всё время» — строки над доской нет');
    assert.equal(countOf(root, 'recall'), '2');
    chipText(root, /^Сегодня$/).click(); await tick(80);
    assert.ok(!textOf(colOf(root, 'recall')).includes('Старый Перезвон'), 'давняя открытая карточка видна при «Сегодня»');
    assert.ok(textOf(colOf(root, 'recall')).includes('Сегодняшний'));
    assert.equal(countOf(root, 'recall'), '1', 'число открытой колонки не по периоду');
    assert.equal(countOf(root, 'in_process'), '0');
    assert.equal(countOf(root, 'no_show'), '0', '«Не пришёл» не сужена периодом');
    assert.ok(!textOf(colOf(root, 'came')).includes('Давний Пришедший'), 'закрытая карточка вне периода видна');
    assert.ok(textOf(colOf(root, 'came')).includes('Пришёл сегодня'));
    assert.equal(textOf(periodLine(root)), 'Период «Сегодня»: показаны заявки, поступившие сегодня. Открытых за другие дни: 3 — Показать все');
    // «Список» — те же карточки и та же строка
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click(); await tick(80);
    assert.ok(!textOf(root).includes('Старый Перезвон') && textOf(root).includes('Сегодняшний'), '«Список» не по периоду');
    assert.ok(periodLine(root), 'в «Списке» нет строки о периоде');
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click(); await tick(80);
    // ушли из раздела и вернулись — период сохранился
    const again = mk('div');
    await renderCrm(again, { onNavigate() {} }); await tick();
    assert.ok(!textOf(colOf(again, 'recall')).includes('Старый Перезвон'));
    // «Показать все» — «Всё время»: строка ушла, давние карточки на месте
    showAllBtn(again).click(); await tick(80);
    assert.equal(periodLine(again), null);
    assert.ok(String(chipText(again, /^Всё время$/).className).includes(' on'), '«Показать все» не включило «Всё время»');
    assert.ok(textOf(colOf(again, 'recall')).includes('Старый Перезвон'));
    assert.equal(countOf(again, 'no_show'), '1');
  } finally { chipText(root, /^Всё время$/).click(); await tick(80); window.easymed.state.user = null; }
});

test('CRM_PERIOD_ALL_COLUMNS_V1: строка называет выбранный период — «Эта неделя», «30 дней», свои даты', async () => {
  const root = await board([lead(1, 'recall', { created_at: isoAgo(400) }), lead(2, 'recall', { created_at: isoAgo(0) })]);
  try {
    chipText(root, /^Эта неделя$/).click(); await tick(80);
    assert.equal(textOf(periodLine(root)), 'Период «Эта неделя»: показаны заявки, поступившие на этой неделе. Открытых за другие дни: 1 — Показать все');
    chipText(root, /^30 дней$/).click(); await tick(80);
    assert.equal(textOf(periodLine(root)), 'Период «30 дней»: показаны заявки, поступившие за последние 30 дней. Открытых за другие дни: 1 — Показать все');
    chipText(root, /^Свой период$/).click(); await tick(80);
    const now = new Date();
    const from = dmy(ymdOf(new Date(now.getFullYear(), now.getMonth(), 1)));
    const to = dmy(ymdOf(now));
    assert.equal(textOf(periodLine(root)), `Период «${from} – ${to}»: показаны заявки, поступившие с ${from} по ${to}. Открытых за другие дни: 1 — Показать все`);
    const [fromInp, toInp] = walk(root).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'date');
    fromInp.value = ''; fromInp.dispatchEvent({ type: 'change', target: fromInp }); await tick(80);
    assert.equal(textOf(periodLine(root)), `Период «по ${to}»: показаны заявки, поступившие по ${to}. Открытых за другие дни: 0 — Показать все`);
    const [f2, t2] = walk(root).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'date');
    f2.value = ymdOf(new Date(now.getFullYear(), now.getMonth(), 1)); f2.dispatchEvent({ type: 'change', target: f2 }); await tick(80);
    t2.value = ''; t2.dispatchEvent({ type: 'change', target: t2 }); await tick(80);
    assert.equal(textOf(periodLine(root)), `Период «с ${from}»: показаны заявки, поступившие с ${from}. Открытых за другие дни: 1 — Показать все`);
  } finally { chipText(root, /^Всё время$/).click(); await tick(80); window.easymed.state.user = null; }
});

test('CRM_PERIOD_ALL_COLUMNS_V1: «Свой период» — «по» включает весь последний день (23:59:59), полночь следующего — нет', async () => {
  const day = '2026-10-03';
  const leads = [
    lead(1, 'recall', { full_name: 'Последняя секунда', created_at: asDb(new Date(2026, 9, 3, 23, 59, 59)) }),
    lead(2, 'came', { full_name: 'Пришёл в последнюю секунду', created_at: asDb(new Date(2026, 9, 3, 23, 59, 59)) }),
    lead(3, 'recall', { full_name: 'Полночь следующего дня', created_at: asDb(new Date(2026, 9, 4, 0, 0, 0)) }),
    lead(4, 'recall', { full_name: 'Начало дня', created_at: asDb(new Date(2026, 9, 3, 0, 0, 0)) }),
  ];
  const root = await board(leads);
  try {
    chipText(root, /^Свой период$/).click(); await tick(80);
    for (const k of [0, 1]) {
      const inp = walk(root).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'date')[k];
      inp.value = day; inp.dispatchEvent({ type: 'change', target: inp }); await tick(80);
    }
    const shown = textOf(root);
    assert.ok(shown.includes('Последняя секунда'), 'открытая карточка 23:59:59 последнего дня не попала в период');
    assert.ok(shown.includes('Пришёл в последнюю секунду'), 'закрытая карточка 23:59:59 последнего дня не загружена за период');
    assert.ok(shown.includes('Начало дня'));
    assert.ok(!shown.includes('Полночь следующего дня'), 'карточка следующего дня попала в период');
    assert.equal(countOf(root, 'recall'), '2');
    assert.equal(countOf(root, 'came'), '1');
    assert.match(textOf(periodLine(root)), /Открытых за другие дни: 1 — /);
  } finally { chipText(root, /^Всё время$/).click(); await tick(80); window.easymed.state.user = null; }
});

test('CRM_PERIOD_ALL_COLUMNS_V1: пока доска перезагружается, чипы периода заняты (disabled, aria-busy); после — свободны', async () => {
  const root = await board([lead(1, 'recall', { created_at: isoAgo(0) })]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    if (b && b.table === 'crm_requests' && b.op === 'select') await new Promise((r) => setTimeout(r, 200));
    return realFetch(url, o);
  };
  try {
    chipText(root, /^Сегодня$/).click();
    const busy = byAttr(root, 'data-crm-period');
    assert.equal(busy.length, 5, 'чипов периода не пять');
    assert.ok(busy.every((b) => b.hasAttribute('disabled') && b.getAttribute('aria-busy') === 'true'), 'чипы не показывают загрузку');
    await tick(500);
    const after = byAttr(root, 'data-crm-period');
    assert.ok(after.every((b) => !b.hasAttribute('disabled') && b.getAttribute('aria-busy') !== 'true'), 'чипы остались занятыми');
    assert.ok(String(chipText(root, /^Сегодня$/).className).includes(' on'));
  } finally {
    globalThis.fetch = realFetch;
    chipText(root, /^Всё время$/).click(); await tick(80);
    window.easymed.state.user = null;
  }
});

// Воронка с СКРЫТОЙ колонкой «Подтверждён», метка «VIP», два источника.
const HIDDEN_CFG = {
  stages: DEFAULT_STAGES.map((st) => (st.key === 'approved' ? { ...st, is_active: 0 } : st)),
  sources: [{ key: 'call', label: 'Звонок', position: 1, is_active: 1 }, { key: 'instagram', label: 'Instagram', position: 2, is_active: 1 }],
  tags: [{ key: 'vip', label: 'VIP', color: 'purple', position: 1, is_active: true }],
};
async function boardCfg(leads, leadTags = []) {
  window.easymed.state.user = ADMIN;
  S.config = HIDDEN_CFG; S.leads = leads; S.search = []; S.tasks = []; S.leadTags = leadTags; S.dups = [];
  CALLS.length = 0;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const sel = (root, attr) => byAttr(root, attr)[0];
const pick = async (root, attr, v) => { const x = sel(root, attr); x.value = v; x.dispatchEvent({ type: 'change', target: x, currentTarget: x }); await tick(80); };
const allOpt = (root, attr) => walk(sel(root, attr)).find((n) => n.tagName === 'OPTION' && n.attrs.value === (attr === 'data-op-select' ? 'all' : CRM_FILTER_ALL));

test('CRM_PERIOD_ALL_COLUMNS_V1: «Открытых за другие дни» — с тем же оператором, источником и меткой; скрытая колонка не считается', async () => {
  const leads = [
    lead(1, 'recall', { source: 'call', assigned_to: 7, created_at: isoAgo(40) }),
    lead(2, 'recall', { source: 'instagram', assigned_to: 24, created_at: isoAgo(40) }),
    lead(3, 'in_process', { source: 'instagram', assigned_to: null, created_at: isoAgo(40) }),
    lead(4, 'approved', { source: 'call', created_at: isoAgo(40) }),     // скрытая колонка
    lead(5, 'came', { source: 'call', created_at: isoAgo(40) }),         // закрытая
    lead(6, 'recall', { source: 'call', created_at: isoAgo(0) }),        // в периоде
  ];
  const root = await boardCfg(leads, [{ request_id: 3, tag_key: 'vip' }]);
  const n = () => (/Открытых за другие дни: (\d+)/.exec(textOf(periodLine(root))) || [])[1];
  try {
    chipText(root, /^Сегодня$/).click(); await tick(80);
    assert.equal(n(), '3', 'скрытая, закрытая или сегодняшняя карточка посчитаны');
    await pick(root, 'data-src-select', 'instagram');
    assert.equal(n(), '2', 'число не учло источник');
    // Метку выбирают при «Всё время» (за сегодня меток нет) — и возвращаются к «Сегодня».
    chipText(root, /^Всё время$/).click(); await tick(80);
    await pick(root, 'data-tag-select', 'vip');
    chipText(root, /^Сегодня$/).click(); await tick(80);
    assert.equal(n(), '1', 'число не учло метку');
    await pick(root, 'data-tag-select', CRM_FILTER_ALL);
    await pick(root, 'data-src-select', CRM_FILTER_ALL);
    assert.equal(n(), '3');
    await pick(root, 'data-op-select', 'me');
    assert.equal(n(), '1', 'число не учло оператора');
    const lite = CALLS.filter((c) => c.table === 'crm_requests' && c.columns === OUTSIDE_SELECT).pop();
    assert.ok(lite.filters.some((f) => f.col === 'assigned_to' && f.op === 'eq' && String(f.val) === '7'), 'оператор не ушёл в запрос');
  } finally {
    await pick(root, 'data-op-select', 'all');
    chipText(root, /^Всё время$/).click(); await tick(80);
    S.config = null; S.leadTags = []; window.easymed.state.user = null;
  }
});

test('CRM_FILTER_ALL_VALUE_V1: «Все · N» — сумма чисел колонок (у обрезанной — из базы, скрытые не считаются); у Оператора, Источника и Меток — одно число', async () => {
  S.countFor = { came: 4321 };
  const leads = [
    ...Array.from({ length: 300 }, (_, i) => lead(1000 + i, 'came', { source: 'call' })),
    lead(1, 'recall', { source: 'call' }), lead(2, 'recall', { source: 'instagram' }),
    lead(3, 'in_process', { source: 'instagram' }), lead(4, 'approved', { source: 'call' }),
  ];
  const root = await boardCfg(leads, [{ request_id: 3, tag_key: 'vip' }]);
  try {
    const heads = byAttr(root, 'data-col-count').map((x) => Number(textOf(x)));
    const sum = heads.reduce((a, b) => a + b, 0);
    assert.equal(sum, 4321 + 3, 'стенд не тот');
    assert.ok(!byAttr(root, 'data-col-count').some((x) => x.getAttribute('data-col-count') === 'approved'), 'скрытая колонка на доске');
    for (const a of ['data-op-select', 'data-src-select', 'data-tag-select']) {
      assert.equal(textOf(allOpt(root, a)), 'Все · ' + sum, a + ': «Все» не равно сумме колонок');
    }
    assert.equal(sel(root, 'data-src-select').value, CRM_FILTER_ALL, '«Все» источника — пустое значение');
    assert.equal(sel(root, 'data-tag-select').value, CRM_FILTER_ALL, '«Все» меток — пустое значение');
    // Выбран источник: доска сузилась, «Все · N» источника — сколько будет при «Все».
    await pick(root, 'data-src-select', 'instagram');
    assert.equal(byClass(root, 'crm-card').length, 2);
    assert.equal(textOf(allOpt(root, 'data-src-select')), 'Все · ' + sum);
    assert.equal(textOf(allOpt(root, 'data-tag-select')), 'Все · 2', '«Все» меток — не по выбранному источнику');
    await pick(root, 'data-src-select', CRM_FILTER_ALL);
    assert.equal(byClass(root, 'crm-card').length, 303, '«Все» не снял источник');
    assert.equal(sel(root, 'data-src-select').value, CRM_FILTER_ALL);
  } finally { S.countFor = null; S.config = null; S.leadTags = []; window.easymed.state.user = null; }
});

// CRM_PERIOD_ALL_COLUMNS_V1 — подсказка видна только при «Всё время»: открытые там
// показаны все (без 300), но «всегда» уже неправда — «Период» сужает и их.
test('C3: подсказка обрезанной колонки говорит, что открытые показаны все, но не «всегда»', async () => {
  S.countFor = { came: 4321 };
  try {
    const root = await board(Array.from({ length: 300 }, (_, i) => lead(i + 1, 'came')));
    const hint = textOf(byAttr(root, 'data-col-capped')[0]);
    assert.ok(hint.includes('Показаны последние 300'), hint);
    assert.ok(hint.includes('открытые показаны все'), 'подсказка не говорит, что открытые показаны все: ' + hint);
    assert.ok(!hint.includes('видны всегда'), 'подсказка обещает, что открытые видны всегда: ' + hint);
  } finally { S.countFor = null; window.easymed.state.user = null; }
});

test('C4: «Список» при «Всё время» — у обрезанной закрытой колонки та же подсказка, что на доске', async () => {
  S.countFor = { came: 450 };
  try {
    const leads = Array.from({ length: 450 }, (_, i) => lead(i + 1, 'came'));
    const root = await board(leads);
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click();
    await tick(80);
    const rows = walk(root).filter((n) => n.tagName === 'TR' && String(n.className).includes('row-click'));
    assert.equal(rows.length, 300);
    const note = byAttr(root, 'data-list-capped');
    assert.equal(note.length, 1, 'список молча обрезан до 300');
    assert.ok(textOf(note[0]).includes('Пришёл') && textOf(note[0]).includes('450'), textOf(note[0]));
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click();
    await tick(80);
  } finally { S.countFor = null; window.easymed.state.user = null; }
});

test('C6: гонка загрузок — медленный старый ответ не перезаписывает новый', async () => {
  const leads = [...Array.from({ length: 300 }, (_, i) => lead(1000 - i, 'came', { assigned_to: 24 })),
    ...Array.from({ length: 5 }, (_, i) => lead(500 - i, 'came', { assigned_to: 7 }))];
  const root = await board(leads);
  // CRM_FILTERS_DROPDOWN_V1 — «Оператор» — выпадающий список; смена без await, чтобы устроить гонку.
  const setOp = (k) => { const s = byAttr(root, 'data-op-select')[0]; s.value = k; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); };
  setOp('me'); await tick(80);
  assert.equal(countOf(root, 'came'), '5');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    const slowAll = b && b.table === 'crm_requests' && b.op === 'select' && !(b.filters || []).some((f) => f.col === 'assigned_to');
    if (slowAll) await new Promise((r) => setTimeout(r, 250));
    return realFetch(url, o);
  };
  try {
    setOp('all'); await tick(10);   // A — медленный
    setOp('me');                     // B — быстрый
    await tick(600);
    assert.equal(byAttr(root, 'data-op-select')[0].value, 'me');
    assert.equal(countOf(root, 'came'), '5', 'старый ответ «Все» перезаписал число');
    assert.equal(byClass(colOf(root, 'came'), 'crm-card').length, 5, 'старый ответ «Все» перезаписал карточки');
  } finally {
    globalThis.fetch = realFetch;
    setOp('all'); await tick(120);
    window.easymed.state.user = null;
  }
});

test('Excel при «Всё время» выгружает ВСЕ строки под текущими фильтрами — без 300 на колонку', async () => {
  const { crmExportRows } = await import('../views/crm.js');
  const leads = [...Array.from({ length: 450 }, (_, i) => lead(i + 1, 'came', { assigned_to: i % 2 ? 7 : null })),
    lead(900, 'recall', { assigned_to: 7 })];
  const root = await board(leads);
  CALLS.length = 0;
  const all = await crmExportRows();
  assert.equal(all.rows.length, 451, 'выгрузка обрезана как доска');
  assert.ok(!CALLS.some((c) => c.table === 'crm_requests' && c.op === 'select' && c.limit !== undefined), 'выгрузка спросила базу с пределом');
  const setOp = (k) => { const s = byAttr(root, 'data-op-select')[0]; s.value = k; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); };   // CRM_FILTERS_DROPDOWN_V1
  setOp('me'); await tick(80);
  const onlyMine = await crmExportRows();
  assert.equal(onlyMine.rows.length, 226, 'выгрузка не взяла фильтр «Оператор»');
  setOp('all'); await tick(80);
  window.easymed.state.user = null;
});

test('вид «Задачи» не грузит доску, которую не показывает', async () => {
  const root = await board([lead(1, 'in_process')]);
  CALLS.length = 0;
  walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'tasks').click();
  await tick(80);
  assert.equal(CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'select').length, 0, 'вид «Задачи» загрузил карточки доски');
  assert.ok(CALLS.some((c) => c.table === 'crm_tasks'), 'вид «Задачи» не спросил задачи');
  walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click();
  await tick(80);
  window.easymed.state.user = null;
});

test('поиск на телефоне: поле не шире строки (без 300px насмерть)', async () => {
  const root = await board([lead(1, 'in_process')]);
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  const box = inp.parentNode;
  assert.notEqual(box.style.flex, '0 0 300px', 'поле поиска снова не сжимается');
  assert.equal(box.style.maxWidth, '100%');
  assert.equal(box.style.minWidth, '0');
  window.easymed.state.user = null;
});

// CRM_UNIFY_V1 (итоговое ревью) — высота колонки по месту под доской
// (views/crm.js columnHeightFor; замеры Chrome — в отчёте задачи).
test('высота колонки: ноутбук 1366×768 — низ колонок в окне; 1920×1080 — выше; телефон — по окну от верха доски', async () => {
  const { columnHeightFor } = await import('../views/crm.js');
  // 1366×768: верх списка 390, под списком 45px обвязки, зазор 16 → 317, и низ доски = 768 − 16
  const laptop = columnHeightFor({ viewportH: 768, listTop: 390, windowTop: 333, chromeBelow: 45 });
  assert.equal(laptop, 317);
  assert.ok(390 + laptop + 45 <= 768 - 16 + 0.5, 'низ доски ниже края окна');
  assert.equal(columnHeightFor({ viewportH: 1080, listTop: 390, windowTop: 333, chromeBelow: 45 }), 629);
  // телефон: фильтры в несколько строк, доска ниже сгиба — колонка по окну, когда доска наверху
  assert.equal(columnHeightFor({ viewportH: 740, listTop: 1010, windowTop: 950, chromeBelow: 45 }), 619);
  // совсем мало места — не меньше 240
  assert.equal(columnHeightFor({ viewportH: 300, listTop: 1010, windowTop: 950, chromeBelow: 45 }), 240);
});


// CRM_UNIFY_V1 (итоговое ревью, решение контролёра) — сидовая «Не пришёл» — ЖИВАЯ
// работа (операторы перезванивают; с I-3 звонок или запись её открывают, сервер:
// contact-window.js liveKeys). На доске — как открытая: 300 на колонку нет, число
// полное; «Список» и Excel — так же.
// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0) — ОБНОВЛЕНО НАМЕРЕННО: выбранный «Период»
// сужает и её (как каждую колонку); давняя «Не пришёл» входит в «Открытых за другие дни».
test('«Не пришёл» — живая колонка: без 300, число полное; «Период» сужает её, как открытые; «Список» и Excel согласны', async () => {
  const { crmExportRows } = await import('../views/crm.js');
  const leads = [
    lead(1, 'no_show', { full_name: 'Давний Не пришёл', created_at: isoAgo(40) }),
    ...Array.from({ length: 349 }, (_, i) => lead(i + 2, 'no_show', { created_at: isoAgo(1) })),
    lead(900, 'stopped', { full_name: 'Давний Остановлен', created_at: isoAgo(40) }),
  ];
  S.countFor = { no_show: 350 };
  try {
    const root = await board(leads);
    // «Всё время»: не обрезана — все 350 карточек, без подсказки «последние 300»
    assert.equal(byClass(colOf(root, 'no_show'), 'crm-card').length, 350, '«Не пришёл» обрезана, как закрытая');
    assert.equal(countOf(root, 'no_show'), '350');
    assert.ok(!byAttr(root, 'data-col-capped').some((n) => n.getAttribute('data-col-capped') === 'no_show'));
    // в загрузке «Не пришёл» — среди открытых (not in), отдельного запроса по колонке нет
    const reads = CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'select');
    const open = reads.find((c) => (c.filters || []).some((f) => f.op === 'not.in'));
    assert.ok(open && !open.filters.find((f) => f.op === 'not.in').val.includes('no_show'), '«Не пришёл» исключена из открытых');
    assert.ok(!reads.some((c) => (c.filters || []).some((f) => f.op === 'eq' && f.col === 'status' && f.val === 'no_show')), '«Не пришёл» грузится как закрытая');
    // «30 дней»: давняя «Не пришёл» (40 дней) скрыта, вчерашние — видны; число — по периоду;
    // давняя «Остановлена» (закрытая) — тоже нет
    chipText(root, /^30 дней$/).click(); await tick(80);
    assert.ok(!textOf(colOf(root, 'no_show')).includes('Давний Не пришёл'), '«Период» не сузил «Не пришёл»');
    assert.equal(countOf(root, 'no_show'), '349');
    assert.ok(!textOf(colOf(root, 'stopped')).includes('Давний Остановлен'), 'закрытая карточка вне периода видна');
    assert.match(textOf(periodLine(root)), /Открытых за другие дни: 1 — /, 'давняя «Не пришёл» не названа строкой над доской');
    // «Список» — те же карточки
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click(); await tick(80);
    assert.ok(!textOf(root).includes('Давний Не пришёл'), '«Список» не сузил «Не пришёл» периодом');
    assert.equal(byAttr(root, 'data-list-capped').length, 0);
    // Excel — тоже
    const exp = await crmExportRows();
    assert.ok(!exp.rows.some((r) => r.full_name === 'Давний Не пришёл'), 'выгрузка не сузила «Не пришёл» периодом');
    assert.equal(exp.rows.filter((r) => r.status === 'no_show').length, 349);
    assert.ok(!exp.rows.some((r) => r.full_name === 'Давний Остановлен'));
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click(); await tick(80);
    chipText(root, /^Всё время$/).click(); await tick(80);
  } finally { S.countFor = null; window.easymed.state.user = null; }
});
