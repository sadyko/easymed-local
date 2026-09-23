// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — ручная заявка на номер, у которого
// уже есть карточка.
//
// Владелец: «fix the duplicates in the crm». Решено: перед созданием новой
// заявки сервер отвечает, есть ли у номера карточки (crm_leads_by_phone, все
// стадии), и окно предлагает «Открыть существующую / Создать всё равно».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, RPC, mk, walk, textOf, byAttr, tick, button } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

async function newRequestModal() {
  CALLS.length = 0; RPC.length = 0; S.inserted = null;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  button(root, /Новая заявка/).click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно новой заявки не открылось');
  const inputs = walk(modal).filter((n) => n.tagName === 'INPUT');
  const name = inputs.find((n) => /Фамилия Имя/.test(n.getAttribute('placeholder') || ''));
  const phone = inputs.find((n) => n.getAttribute('type') === 'tel');
  assert.ok(name && phone, 'нет полей ФИО и телефона');
  name.value = 'Буронова Феруза';
  phone.value = '+998 91 566 22 78';
  return modal;
}
const saveNew = async (modal) => { button(modal, /Создать заявку/).click(); await tick(60); };
const dupDialog = () => document.body.children.find((n) => n.attrs && 'data-crm-dup' in n.attrs);
const inserts = () => CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'insert');

const DUPS = [
  { id: 41, full_name: 'Буронова Феруза', phone: '915662278', status: 'came', stage_label: 'Пришёл', stage_kind: 'won',
    created_at: '2026-08-01T10:00:00Z', assigned_to: null, assigned_name: '', can_open: true },
  // Ревью W2-M3: о чужой карточке сервер сообщает только сам факт.
  { can_open: false, foreign: true },
];

test('новый номер — никакого окна, заявка создаётся сразу', async () => {
  S.dups = [];
  const modal = await newRequestModal();
  await saveNew(modal);
  const ask = RPC.find((r) => r.name === 'crm_leads_by_phone');
  assert.ok(ask, 'перед созданием сервер не спросили о дубле');
  assert.equal(ask.body.phone, '+998 91 566 22 78');
  assert.equal(dupDialog(), undefined);
  assert.equal(inserts().length, 1);
});

test('номер с карточками — окно со списком; своя открывается, чужая — только названа', async () => {
  S.dups = DUPS;
  const modal = await newRequestModal();
  await saveNew(modal);
  const dlg = dupDialog();
  assert.ok(dlg, 'дубль не остановил создание');
  assert.equal(inserts().length, 0, 'заявка вставлена, не дождавшись ответа человека');
  const t = textOf(dlg);
  assert.ok(t.includes('У этого номера уже есть карточка'));
  assert.ok(t.includes('Буронова Феруза') && t.includes('Пришёл'));
  assert.ok(t.includes('Есть карточка у другого оператора'));
  assert.ok(!t.includes('Перезвонить') && !t.includes('Зарина'), 'о чужой карточке сказано больше, чем «есть»');
  const opens = byAttr(dlg, 'data-dup-open');
  assert.deepEqual(opens.map((b) => b.attrs['data-dup-open']), ['41'], '«Открыть» только у видимой карточки');
  assert.ok(button(dlg, /Создать всё равно/));
});

test('«Открыть» — новая заявка не создаётся, открывается существующая', async () => {
  S.dups = DUPS;
  S.leads = [{ id: 41, full_name: 'Буронова Феруза', phone: '915662278', status: 'came', source: 'call', created_at: '2026-08-01T10:00:00Z' }];
  const modal = await newRequestModal();
  await saveNew(modal);
  byAttr(dupDialog(), 'data-dup-open')[0].click();
  await tick(60);
  assert.equal(inserts().length, 0, '«Открыть» всё равно завёл вторую карточку');
  const read = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'select' && c.single
    && (c.filters || []).some((f) => f.col === 'id' && String(f.val) === '41'));
  assert.ok(read, 'существующая карточка не дочитана');
  assert.equal(dupDialog(), undefined);
  const opened = document.body.children.filter((n) => String(n.className).includes('modal'));
  assert.equal(opened.length, 1, 'окно новой заявки не закрылось или существующая не открылась');
  assert.ok(textOf(opened[0]).includes('Заявка'), 'открылось не окно заявки');
  S.leads = [];
});

test('«Создать всё равно» — вставка идёт, и второй раз не спрашивают', async () => {
  S.dups = DUPS;
  const modal = await newRequestModal();
  await saveNew(modal);
  button(dupDialog(), /Создать всё равно/).click();
  await tick(60);
  assert.equal(inserts().length, 1);
  assert.equal(inserts()[0].values.phone, '+998 91 566 22 78');
  assert.equal(RPC.filter((r) => r.name === 'crm_leads_by_phone').length, 1, 'о дубле спросили дважды');
});

test('«Отмена» — ничего не вставлено, окно новой заявки с введённым остаётся', async () => {
  S.dups = DUPS;
  const modal = await newRequestModal();
  await saveNew(modal);
  button(dupDialog(), /^Отмена$/).click();
  await tick(60);
  assert.equal(inserts().length, 0);
  assert.ok(document.body.children.includes(modal), 'окно новой заявки закрылось');
});

// Ревью W2-M5 — «Создать всё равно» относится к ОДНОМУ номеру.
test('ответ «создать всё равно» не переносится на другой номер', async () => {
  S.dups = DUPS;
  S.failInsertOnce = true;   // первая вставка не прошла — окно осталось открытым
  const modal = await newRequestModal();
  await saveNew(modal);
  button(dupDialog(), /Создать всё равно/).click();
  await tick(60);
  assert.equal(S.inserted, null);
  const phone = walk(modal).find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'tel');
  phone.value = '+998 94 284 64 94';
  await saveNew(modal);
  assert.ok(dupDialog(), 'другой номер сохранён без проверки — сработало старое «создать всё равно»');
  assert.equal(RPC.filter((r) => r.name === 'crm_leads_by_phone').length, 2);
  button(dupDialog(), /^Отмена$/).click();
  await tick(30);
});

async function editModal(lead) {
  CALLS.length = 0; RPC.length = 0;
  document.body.children.length = 0;
  S.leads = [lead];
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const card = walk(root).find((n) => String(n.className).split(/\s+/).includes('crm-card'));
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  return document.body.children.find((n) => String(n.className).includes('modal'));
}
const EDIT_LEAD = { id: 5, full_name: 'Юсупов Бекзод', phone: '+998 90 485 88 55', status: 'in_process', source: 'call', created_at: '2026-09-20T10:00:00Z' };
const updates = () => CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'update'
  && c.values && 'full_name' in c.values && (c.filters || []).some((f) => f.col === 'id' && String(f.val) === '5'));

test('правка: номер не менялся — проверки нет', async () => {
  S.dups = [{ ...DUPS[0], id: 5 }];
  const modal = await editModal(EDIT_LEAD);
  button(modal, /Сохранить$/).click();
  await tick(60);
  assert.equal(RPC.filter((r) => r.name === 'crm_leads_by_phone').length, 0);
  assert.equal(updates().length, 1);
});

test('правка: номер сменили на номер с другой карточкой — окно; сама заявка в нём не значится', async () => {
  S.dups = [{ ...DUPS[0], id: 5, full_name: 'Юсупов Бекзод' }, DUPS[0]];
  const modal = await editModal(EDIT_LEAD);
  walk(modal).find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'tel').value = '+998 91 566 22 78';
  button(modal, /Сохранить$/).click();
  await tick(60);
  const dlg = dupDialog();
  assert.ok(dlg, 'номер с чужой карточкой сохранён без предупреждения');
  assert.deepEqual(byAttr(dlg, 'data-dup-open').map((b) => b.attrs['data-dup-open']), ['41'], 'в списке дублей — сама заявка');
  assert.equal(updates().length, 0, 'сохранилось до ответа');
  button(dlg, /Сохранить всё равно/).click();
  await tick(60);
  assert.equal(updates().length, 1);
});

test('правка: у нового номера карточка только эта же — окна нет', async () => {
  S.dups = [{ ...DUPS[0], id: 5 }];
  const modal = await editModal(EDIT_LEAD);
  walk(modal).find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'tel').value = '+998 90 485 88 56';
  button(modal, /Сохранить$/).click();
  await tick(60);
  assert.equal(dupDialog(), undefined);
  assert.equal(updates().length, 1);
});
