// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — метки на карточках заявок.
//
// Метки из «Настройки → CRM-канбан» видны на карточке доски и в списке,
// фильтруют доску, ставятся и снимаются в окне заявки (уходит РАЗНИЦА:
// вставка новых строк связи, удаление снятых), попадают в выгрузку.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, mk, walk, textOf, byAttr, byClass, tick, button, TOASTS } from './crm-harness.mjs';
import { boardConfig, shapeConfig, validateTags } from '../crm-settings-logic.js?v=crmcfg1';

const { renderCrm, groupLeadTags } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const TAGS = [
  { key: 'vip', label: 'VIP', color: 'purple', position: 1, is_active: true },
  { key: 'repeat', label: 'Повторный', color: 'teal', position: 2, is_active: true },
  { key: 'old', label: 'Старая', color: '', position: 3, is_active: false },
];
const LEADS = [
  { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call', created_at: '2026-09-03T10:12:00Z' },
  { id: 2, full_name: 'Юсупов Бахтиёр', phone: '+998901112233', status: 'in_process', source: 'call', created_at: '2026-09-04T10:12:00Z' },
];

async function board(view = 'kanban') {
  window.easymed.state.user = ADMIN;
  S.config = { tags: TAGS };
  S.leads = LEADS;
  S.leadTags = [{ request_id: 1, tag_key: 'vip' }, { request_id: 1, tag_key: 'old' }, { request_id: 2, tag_key: 'repeat' }];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  // Состояние доски (вид, выбранная метка) — общее для модуля: возвращаем
  // исходное, чтобы тесты не зависели от порядка.
  const all = byAttr(root, 'data-crm-tag-filter')[0];
  if (all) { walk(all).find((n) => n.tagName === 'BUTTON' && textOf(n) === 'Все').click(); await tick(); }
  button(root, view === 'list' ? /Список/ : /Канбан/).click();
  await tick();
  return root;
}
const cardOf = (root, name) => byClass(root, 'crm-card').find((c) => textOf(c).includes(name));

test('чистые правила: связи группируются по заявке; видимые метки предлагаются, все — подписаны', () => {
  const m = groupLeadTags([{ request_id: 1, tag_key: 'a' }, { request_id: 1, tag_key: 'b' }, { request_id: 2, tag_key: 'a' }, null, { request_id: 3 }]);
  assert.deepEqual([...m.entries()], [['1', ['a', 'b']], ['2', ['a']]]);
  const c = boardConfig({ tags: TAGS });
  assert.deepEqual(c.tags, [['vip', 'VIP', 'purple'], ['repeat', 'Повторный', 'teal']], 'скрытая метка предлагается');
  assert.deepEqual(c.tagRu.old, ['Старая', ''], 'скрытая метка на карточке осталась без подписи');
  assert.deepEqual(shapeConfig({}).tags, [], 'сервер без меток — пустой список, а не запасной набор');
  assert.equal(validateTags([]).ok, true);
  assert.equal(validateTags([{ key: 'vip', label: 'VIP', color: 'nope' }]).ok, false);
  assert.equal(validateTags([{ key: 'a', label: 'A', color: '' }, { key: 'a', label: 'B', color: '' }]).ok, false);
});

test('карточка доски показывает свои метки, включая скрытую', async () => {
  const root = await board();
  const c1 = cardOf(root, 'Каримова');
  assert.deepEqual(byAttr(c1, 'data-lead-tag').map((n) => n.getAttribute('data-lead-tag')), ['vip', 'old']);
  assert.ok(textOf(c1).includes('VIP') && textOf(c1).includes('Старая'));
  assert.deepEqual(byAttr(cardOf(root, 'Юсупов'), 'data-lead-tag').map((n) => n.getAttribute('data-lead-tag')), ['repeat']);
  window.easymed.state.user = null;
});

test('фильтр «Метки»: чипы по меткам выборки со счётчиком; выбор сужает доску', async () => {
  const root = await board();
  const row = byAttr(root, 'data-crm-tag-filter')[0];
  assert.ok(row, 'над доской нет фильтра «Метки»');
  const chips = byAttr(row, 'data-tag-chip');
  assert.deepEqual(chips.map((n) => n.getAttribute('data-tag-chip')), ['vip', 'repeat', 'old']);
  assert.ok(textOf(chips[0]).includes('VIP · 1'));
  chips[1].click();
  await tick();
  const cards = byClass(root, 'crm-card');
  assert.equal(cards.length, 1);
  assert.ok(textOf(cards[0]).includes('Юсупов'), 'фильтр по метке показал не ту заявку');
  window.easymed.state.user = null;
});

test('список: колонка «Метки»', async () => {
  const root = await board('list');
  const heads = walk(root).filter((n) => n.tagName === 'TH').map(textOf);
  assert.ok(heads.includes('Метки'), 'в списке нет колонки «Метки»');
  const cells = byAttr(root, 'data-list-tags');
  assert.equal(cells.length, 2);
  assert.ok(cells.some((c) => textOf(c).includes('VIP') && textOf(c).includes('Старая')));
  window.easymed.state.user = null;
});

test('окно заявки: метки переключаются, при сохранении уходит только разница', async () => {
  const root = await board();
  const card = cardOf(root, 'Каримова');
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  const box = byAttr(modal, 'data-card-tags')[0];
  assert.ok(box, 'в окне заявки нет меток');
  const pick = (k) => byAttr(box, 'data-tag-pick').find((n) => n.getAttribute('data-tag-pick') === k);
  assert.deepEqual(byAttr(box, 'data-tag-pick').map((n) => n.getAttribute('data-tag-pick')), ['vip', 'repeat', 'old'],
    'скрытую метку, стоящую на заявке, нечем снять');
  assert.equal(pick('vip').getAttribute('aria-pressed'), 'true');
  assert.equal(pick('repeat').getAttribute('aria-pressed'), 'false');

  pick('repeat').click();            // поставить
  byAttr(box, 'data-tag-pick').find((n) => n.getAttribute('data-tag-pick') === 'old').click();   // снять
  CALLS.length = 0;
  const save = walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить'));
  save.click();
  await tick(120);

  const ins = CALLS.filter((c) => c.table === 'crm_request_tags' && c.op === 'insert');
  const del = CALLS.filter((c) => c.table === 'crm_request_tags' && c.op === 'delete');
  assert.equal(ins.length, 1);
  assert.deepEqual([].concat(ins[0].values), [{ request_id: 1, tag_key: 'repeat' }]);
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].filters.find((f) => f.col === 'tag_key').val, ['old']);
  assert.equal(del[0].filters.find((f) => f.col === 'request_id').val, 1);
  assert.deepEqual(S.leadTags.filter((t) => t.request_id === 1).map((t) => t.tag_key).sort(), ['repeat', 'vip']);
  window.easymed.state.user = null;
});

test('ревью M4: метку в ту же секунду поставил коллега (UNIQUE) — это успех, а не ошибка', async () => {
  const root = await board();
  const card = cardOf(root, 'Юсупов');
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  const box = byAttr(modal, 'data-card-tags')[0];
  byAttr(box, 'data-tag-pick').find((n) => n.getAttribute('data-tag-pick') === 'vip').click();
  S.tagInsertConflict = true;
  TOASTS.length = 0;
  walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить')).click();
  await tick(150);
  S.tagInsertConflict = false;
  assert.ok(!TOASTS.some((t) => /Метки не сохранены/.test(t)), 'гонка двух операторов показана как ошибка: ' + JSON.stringify(TOASTS));
  assert.ok(CALLS.some((c) => c.table === 'crm_request_tags' && c.op === 'select' && (c.filters || []).some((f) => f.col === 'request_id' && f.val === 2)),
    'после отказа не сверились с базой');
  window.easymed.state.user = null;
});

test('ничего не меняли — меток на сервер не уходит; у клиники без меток поля нет', async () => {
  let root = await board();
  let card = cardOf(root, 'Юсупов');
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  let modal = document.body.children.find((n) => String(n.className).includes('modal'));
  CALLS.length = 0;
  walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить')).click();
  await tick(120);
  assert.equal(CALLS.filter((c) => c.table === 'crm_request_tags' && c.op !== 'select').length, 0);

  window.easymed.state.user = ADMIN;
  // Пустой ответ справочника доска намеренно не применяет (прежняя воронка
  // остаётся) — «клиника без меток» это ответ с пустым списком меток.
  S.config = { tags: [] };
  S.leadTags = [];
  document.body.children.length = 0;
  root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  card = byClass(root, 'crm-card')[0];
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.equal(byAttr(modal, 'data-card-tags').length, 0, 'пустое поле «Метки» у клиники без меток');
  assert.equal(byAttr(root, 'data-crm-tag-filter').length, 0);
  window.easymed.state.user = null;
});
