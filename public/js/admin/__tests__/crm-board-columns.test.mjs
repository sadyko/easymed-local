// CRM_UNIFY_V1 — КОЛОНКИ ДОСКИ: все карточки, без «Показать ещё»; у обрезанной
// закрытой колонки («Всё время», последние 300) — число из базы и подсказка;
// период перезагружает закрытые. Плюс замер: 2000+ открытых карточек.
// Владелец: «"Показать ещё 20" убрать, чтобы все карточки были в окне»,
// «карточки иногда пропадают» (Р12, Р13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, mk, walk, textOf, byClass, byAttr, tick } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

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

test('период: закрытые грузятся за период одним запросом, открытые — все', async () => {
  const root = await board([lead(1, 'in_process'), lead(2, 'came')]);
  CALLS.length = 0;
  chipText(root, /^Сегодня$/).click();
  await tick(60);
  const reads = CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'select');
  const closed = reads.find((c) => (c.filters || []).some((f) => f.op === 'in' && f.col === 'status'));
  assert.ok(closed, 'смена периода не перезагрузила закрытые');
  assert.ok(closed.filters.some((f) => f.col === 'created_at' && f.op === 'gte'), 'закрытые не ограничены периодом');
  assert.equal(closed.limit, undefined);
  assert.ok(reads.some((c) => (c.filters || []).some((f) => f.op === 'not.in')), 'открытые не перезагружены');
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
// CRM_UNIFY_V1 — ИТОГОВОЕ РЕВЬЮ (C3, C4, C6). Решение контролёра (владелец:
// «карточки пропадают»): чип «Период» НИКОГДА не прячет открытые карточки —
// он сужает только закрытые колонки («Пришёл» и проигрышные); числа открытых
// колонок — полные.
// ---------------------------------------------------------------------------
const DAY = 86400000;
const isoAgo = (days) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('C3: «Период» не прячет открытые карточки ни при каком выборе; сужает только закрытые', async () => {
  const leads = [
    lead(1, 'recall', { full_name: 'Старый Перезвон', created_at: isoAgo(10) }),
    lead(2, 'recall', { full_name: 'Сегодняшний', created_at: isoAgo(0) }),
    lead(3, 'came', { full_name: 'Давний Пришедший', created_at: isoAgo(10) }),
    lead(4, 'came', { full_name: 'Пришёл сегодня', created_at: isoAgo(0) }),
  ];
  const root = await board(leads);
  try {
    for (const re of [/^Всё время$/, /^Сегодня$/, /^Эта неделя$/, /^30 дней$/, /^Свой период$/]) {
      chipText(root, re).click(); await tick(80);
      assert.ok(textOf(colOf(root, 'recall')).includes('Старый Перезвон'), `открытая карточка спрятана периодом ${re}`);
      assert.equal(countOf(root, 'recall'), '2', `число открытой колонки не полное при ${re}`);
    }
    chipText(root, /^Сегодня$/).click(); await tick(80);
    assert.ok(!textOf(colOf(root, 'came')).includes('Давний Пришедший'), 'закрытая карточка вне периода видна');
    assert.ok(textOf(colOf(root, 'came')).includes('Пришёл сегодня'));
    // ушли из раздела и вернулись — период сохранился, открытые по-прежнему видны
    const again = mk('div');
    await renderCrm(again, { onNavigate() {} }); await tick();
    assert.ok(textOf(colOf(again, 'recall')).includes('Старый Перезвон'));
    chipText(again, /^Всё время$/).click(); await tick(80);
  } finally { window.easymed.state.user = null; }
});

test('C3: подсказка обрезанной колонки не зовёт выбирать период ради открытых', async () => {
  S.countFor = { came: 4321 };
  try {
    const root = await board(Array.from({ length: 300 }, (_, i) => lead(i + 1, 'came')));
    const hint = textOf(byAttr(root, 'data-col-capped')[0]);
    assert.ok(hint.includes('Показаны последние 300'), hint);
    assert.ok(hint.includes('открытые карточки видны всегда'), 'подсказка не говорит, что открытые видны всегда: ' + hint);
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
  const opChip = (k) => byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === k);
  opChip('me').click(); await tick(80);
  assert.equal(countOf(root, 'came'), '5');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    const slowAll = b && b.table === 'crm_requests' && b.op === 'select' && !(b.filters || []).some((f) => f.col === 'assigned_to');
    if (slowAll) await new Promise((r) => setTimeout(r, 250));
    return realFetch(url, o);
  };
  try {
    opChip('all').click(); await tick(10);   // A — медленный
    opChip('me').click();                     // B — быстрый
    await tick(600);
    assert.equal(byAttr(root, 'data-op-chip').find((n) => n.getAttribute('aria-pressed') === 'true').getAttribute('data-op-chip'), 'me');
    assert.equal(countOf(root, 'came'), '5', 'старый ответ «Все» перезаписал число');
    assert.equal(byClass(colOf(root, 'came'), 'crm-card').length, 5, 'старый ответ «Все» перезаписал карточки');
  } finally {
    globalThis.fetch = realFetch;
    opChip('all').click(); await tick(120);
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
  const mine = byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'me');
  mine.click(); await tick(80);
  const onlyMine = await crmExportRows();
  assert.equal(onlyMine.rows.length, 226, 'выгрузка не взяла фильтр «Оператор»');
  byAttr(root, 'data-op-chip').find((n) => n.getAttribute('data-op-chip') === 'all').click(); await tick(80);
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
// contact-window.js liveKeys). На доске — как открытая: видна всегда, «Период» её
// не сужает, 300 на колонку нет, число полное; «Список» и Excel — так же.
test('«Не пришёл» — живая колонка: видна при любом периоде, без 300, число полное; «Список» и Excel согласны', async () => {
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
    // «Сегодня»: давняя «Не пришёл» видна, число полное; давняя «Остановлена» (закрытая) — нет
    chipText(root, /^Сегодня$/).click(); await tick(80);
    assert.ok(textOf(colOf(root, 'no_show')).includes('Давний Не пришёл'), '«Период» спрятал «Не пришёл»');
    assert.equal(countOf(root, 'no_show'), '350');
    assert.ok(!textOf(colOf(root, 'stopped')).includes('Давний Остановлен'), 'закрытая карточка вне периода видна');
    // «Список» — те же карточки
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click(); await tick(80);
    assert.ok(textOf(root).includes('Давний Не пришёл'), '«Список» спрятал «Не пришёл» периодом');
    assert.equal(byAttr(root, 'data-list-capped').length, 0);
    // Excel — тоже
    const exp = await crmExportRows();
    assert.ok(exp.rows.some((r) => r.full_name === 'Давний Не пришёл'), 'выгрузка спрятала «Не пришёл» периодом');
    assert.ok(!exp.rows.some((r) => r.full_name === 'Давний Остановлен'));
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban').click(); await tick(80);
    chipText(root, /^Всё время$/).click(); await tick(80);
  } finally { S.countFor = null; window.easymed.state.user = null; }
});
