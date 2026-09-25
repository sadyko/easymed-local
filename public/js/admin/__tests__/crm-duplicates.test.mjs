// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «Дубликаты» на доске заявок.
//
// Кнопку видят администратор и руководитель колл-центра; в окне — группы
// карточек одного номера, заранее выбрана карточка, которую предлагает сервер;
// «Объединить» сначала спрашивает (отменить нельзя) и только потом шлёт
// crm_merge_leads с выбранной карточкой и остальными. Группа разных пациентов
// кнопки не имеет — вместо неё причина.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, mk, walk, textOf, byAttr, tick, button, TOASTS } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LOLA = { id: 12, full_name: 'Оператор Лола', role: 'callcenter' };

const card = (o) => ({ id: 1, full_name: 'Каримова', phone: '+998 33 322 22 88', status: 'came', stage_label: 'Пришёл', stage_kind: 'won',
  stage_color: 'ok', source: 'call', patient_id: null, patient_name: '', patient_mrn: '', assigned_to: null, assigned_name: '',
  created_at: '2026-09-14T10:06:57Z', lines: 0, tasks: 0, ...o });
const GROUP = { key: '333222288', phone: '+998 33 322 22 88', conflict: false, suggested_id: 706, latest: '2026-09-17T13:52:31Z',
  cards: [card({ id: 706, patient_id: 500, patient_name: 'Каримова Азиза', patient_mrn: 'M-500', lines: 1 }),
    card({ id: 1051, status: 'no_show', stage_label: 'Не пришёл', stage_kind: 'lost', stage_color: 'crit', tasks: 1, assigned_name: 'Оператор Лола' }),
    card({ id: 1385, patient_id: 500, patient_name: 'Каримова Азиза' })] };
const CONFLICT = { key: '901112233', phone: '901112233', conflict: true, suggested_id: 5, latest: '2026-09-10T10:00:00Z',
  cards: [card({ id: 5, patient_id: 500 }), card({ id: 6, patient_id: 501 })] };

async function board(user) {
  window.easymed.state.user = user;
  S.leads = [];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const openBtn = (root) => byAttr(root, 'data-crm-duplicates-open')[0];

test('кнопку «Дубликаты» видит администратор, оператор — нет', async () => {
  assert.ok(openBtn(await board(ADMIN)), 'администратору не показали «Дубликаты»');
  assert.equal(openBtn(await board(LOLA)), undefined, 'оператору показали слияние чужих карточек');
  window.easymed.state.user = null;
});

test('группа: предложенная карточка выбрана; «Объединить» спрашивает, и только «Да» шлёт слияние', async () => {
  S.dupGroups = { groups: [GROUP, CONFLICT], total: 2 };
  S.mergeError = null;
  const root = await board(ADMIN);
  RPC.length = 0;
  openBtn(root).click();
  await tick(40);
  const modal = document.body.children.find((n) => n.attrs && 'data-crm-duplicates' in n.attrs);
  assert.ok(modal, 'окно «Дубликаты» не открылось');
  assert.ok(RPC.some((r) => r.name === 'crm_duplicate_groups'));

  const groups = byAttr(modal, 'data-dup-group');
  assert.equal(groups.length, 2);
  const g = groups[0];
  const radios = byAttr(g, 'data-dup-keep');
  assert.deepEqual(radios.map((r) => r.getAttribute('data-dup-keep')), ['706', '1051', '1385']);
  assert.equal(radios.find((r) => r.checked).getAttribute('data-dup-keep'), '706', 'заранее выбрана не предложенная сервером');
  assert.ok(textOf(g).includes('Карта M-500'));
  assert.ok(textOf(g).includes('Не пришёл'));

  // Человек выбирает другую карточку.
  const r1385 = radios[2];
  r1385.checked = true;
  radios[0].checked = false;
  r1385.dispatchEvent({ type: 'change', target: r1385, currentTarget: r1385 });

  button(g, /Объединить/).click();
  await tick();
  assert.ok(!RPC.some((r) => r.name === 'crm_merge_leads'), 'слияние ушло, не спросив');
  const ask = byAttr(g, 'data-dup-confirm')[0];
  assert.ok(ask && /Отменить это нельзя/.test(textOf(ask)), 'вопрос не говорит, что слияние необратимо');
  assert.ok(/№1385/.test(textOf(ask)));

  byAttr(g, 'data-dup-merge-yes')[0].click();
  await tick(60);
  const call = RPC.find((r) => r.name === 'crm_merge_leads');
  assert.ok(call, 'слияние не ушло на сервер');
  assert.equal(call.body.keep_id, 1385);
  assert.deepEqual(call.body.merge_ids, [706, 1051]);
  assert.ok(TOASTS.some((t) => /объединены/.test(t)));
  window.easymed.state.user = null;
});

test('разные пациенты: кнопки нет, выбор выключен, причина названа', async () => {
  S.dupGroups = { groups: [CONFLICT], total: 1 };
  const root = await board(ADMIN);
  openBtn(root).click();
  await tick(40);
  const modal = document.body.children.find((n) => n.attrs && 'data-crm-duplicates' in n.attrs);
  const g = byAttr(modal, 'data-dup-group')[0];
  assert.equal(byAttr(g, 'data-dup-merge').length, 0, 'группу разных пациентов предлагают слить');
  assert.ok(byAttr(g, 'data-dup-keep').every((r) => r.disabled));
  assert.ok(byAttr(g, 'data-dup-conflict').length === 1 && textOf(g).includes('разным пациентам'));
  window.easymed.state.user = null;
});

test('отказ сервера — сказано вслух, группа остаётся с кнопкой', async () => {
  S.dupGroups = { groups: [GROUP], total: 1 };
  S.mergeError = 'Карточки привязаны к разным пациентам';
  const root = await board(ADMIN);
  openBtn(root).click();
  await tick(40);
  const modal = document.body.children.find((n) => n.attrs && 'data-crm-duplicates' in n.attrs);
  const g = byAttr(modal, 'data-dup-group')[0];
  button(g, /Объединить/).click();
  await tick();
  byAttr(g, 'data-dup-merge-yes')[0].click();
  await tick(60);
  assert.ok(TOASTS.some((t) => /Не удалось объединить/.test(t)));
  assert.equal(byAttr(g, 'data-dup-merge').length, 1, 'после отказа кнопка пропала');
  assert.ok(walk(modal).includes(g), 'группа исчезла, хотя слияния не было');
  S.mergeError = null;
  window.easymed.state.user = null;
});
