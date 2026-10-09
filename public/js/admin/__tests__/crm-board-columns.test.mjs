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
