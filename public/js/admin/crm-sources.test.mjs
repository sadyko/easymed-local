// CRM_MULTI_SOURCE_V1 (2026-09-29) — чистые правила источников заявки на экране:
// выбор в карточке (порядок нажатий, последний не снимается), фильтр доски по
// нескольким источникам, счёт «заявка — в каждом своём источнике».
// Само правило чтения (leadSources) проверено одной таблицей примеров вместе с
// SQL-записью в server/services/crm/sources.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadSources, toggleLeadSource, leadHasAnySource, sourceTally, MAX_LEAD_SOURCES } from './crm-sources.js';

test('выбор в карточке: добавляет в конец, повторное нажатие снимает, порядок — порядок нажатий', () => {
  let t = toggleLeadSource(['call'], 'instagram');
  assert.deepEqual(t, { list: ['call', 'instagram'], refused: null });
  t = toggleLeadSource(t.list, 'referral');
  assert.deepEqual(t.list, ['call', 'instagram', 'referral']);
  t = toggleLeadSource(t.list, 'call');
  assert.deepEqual(t, { list: ['instagram', 'referral'], refused: null }, 'снятый главный — главным становится следующий');
});

test('выбор в карточке: последний источник не снимается, больше десяти не добавляется', () => {
  const src = ['referral'];
  const t = toggleLeadSource(src, 'referral');
  assert.deepEqual(t, { list: ['referral'], refused: 'last' });
  assert.deepEqual(src, ['referral'], 'входной список не тронут');
  const full = Array.from({ length: MAX_LEAD_SOURCES }, (_, i) => 's' + i);
  assert.equal(MAX_LEAD_SOURCES, 10);
  assert.deepEqual(toggleLeadSource(full, 'extra'), { list: full, refused: 'max' });
  assert.deepEqual(toggleLeadSource(full, 's3').list.length, MAX_LEAD_SOURCES - 1, 'снять из полного можно');
  assert.deepEqual(toggleLeadSource(null, 'call'), { list: ['call'], refused: null });
});

test('фильтр доски: пустой — все заявки; иначе заявка видна, если ХОТЯ БЫ ОДИН её источник отмечен', () => {
  const a = { source: 'instagram', sources: ['instagram', 'referral'] };
  const b = { source: 'call', sources: null };
  assert.equal(leadHasAnySource(a, []), true);
  assert.equal(leadHasAnySource(a, ['referral']), true, 'второй источник заявки тоже отбирается');
  assert.equal(leadHasAnySource(a, ['call', 'telegram']), false);
  assert.equal(leadHasAnySource(b, ['call', 'telegram']), true);
  assert.equal(leadHasAnySource({ source: '' }, ['other']), true, 'заявка без источника читается как «Другое»');
});

test('счёт по источникам: заявка с двумя источниками — в обоих; «пришли» — по предикату', () => {
  const rows = [
    { id: 1, source: 'instagram', sources: ['instagram', 'referral'], status: 'came' },
    { id: 2, source: 'instagram', sources: '["instagram"]', status: 'in_process' },
    { id: 3, source: 'call', sources: null, status: 'came' },
  ];
  const t = sourceTally(rows, (r) => r.status === 'came');
  assert.deepEqual([...t.keys()], ['instagram', 'referral', 'call'], 'порядок первого появления');
  assert.deepEqual(t.get('instagram'), { total: 2, won: 1 });
  assert.deepEqual(t.get('referral'), { total: 1, won: 1 });
  assert.deepEqual(t.get('call'), { total: 1, won: 1 });
  assert.deepEqual(sourceTally(rows).get('instagram'), { total: 2, won: 0 }, 'без предиката «пришли» — ноль');
  assert.deepEqual(leadSources(rows[1]), ['instagram']);
});
