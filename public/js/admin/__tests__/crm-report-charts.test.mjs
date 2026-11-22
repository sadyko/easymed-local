// CRM_SALES_CHARTS_V1 — графики «Отчёта по заявкам»: шкала круглыми шагами,
// подписи шагов, две линии с легендой и подсказкой, полосы списка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, textOf } from './crm-harness.mjs';

const { niceMax, stepLabel, shortMoney, lineChart, barChart, barList, SERIES } = await import('../views/crm-report-charts.js');

test('шкала — четыре круглых шага, не меньше максимума', () => {
  assert.equal(niceMax(36), 40);
  assert.equal(niceMax(50), 80);
  assert.equal(niceMax(3), 4);
  assert.equal(niceMax(0), 4);
  assert.equal(niceMax(9_500_000), 20_000_000);
  for (const m of [7, 36, 113, 2_345_678]) assert.ok(niceMax(m) >= m);
});

test('подписи: день — «дд.мм», месяц — «мм.гггг», деньги — коротко', () => {
  assert.equal(stepLabel('2026-11-22'), '22.11');
  assert.equal(stepLabel('2026-11'), '11.2026');
  assert.match(shortMoney(2_500_000), /^2,5 /);
});

test('две линии — легенда из двух имён, по пути на ряд, наведение показывает значения', () => {
  const keys = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const el = lineChart({ keys, series: [
    { name: 'Заявки', color: SERIES.one, values: [5, 8, 3] },
    { name: 'Пришли', color: SERIES.two, values: [1, 4, 2] },
  ] });
  const nodes = walk(el);
  assert.equal(nodes.filter((n) => n.tagName && n.tagName.toLowerCase() === 'path' && n.getAttribute && n.getAttribute('data-series')).length, 2);
  assert.ok(textOf(el).includes('Заявки') && textOf(el).includes('Пришли'), 'нет легенды');
  const hit = nodes.find((n) => n.getAttribute && n.getAttribute('data-step') === '2026-11-02');
  hit.dispatchEvent({ type: 'mouseenter' });
  assert.ok(textOf(el).includes('8') && textOf(el).includes('02.11'), 'подсказка не показала значения шага');
});

test('столбики и полосы рисуются; доля внутри полосы — вторым цветом', () => {
  const bars = barChart({ keys: ['2026-11-01', '2026-11-02'], values: [100, 0], name: 'Принесли' });
  assert.ok(walk(bars).some((n) => String(n.getAttribute && n.getAttribute('class')).includes('crc-bar')));
  const list = barList({ rows: [{ label: 'Instagram', value: 10, part: 4, valueText: '10', note: '40%' }] });
  assert.ok(textOf(list).includes('Instagram') && textOf(list).includes('40%'));
});
