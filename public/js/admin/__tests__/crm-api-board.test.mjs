// PUBLIC_API_V1 — доска CRM и заявки из API: карточка онлайн-записи несёт строку
// «med24.uz · API — ждёт подтверждения до …»; в окне карточки — блок
// «Онлайн-запись через API»; подтверждение закрывает окно (карту пациента
// поставил сервер — «Сохранить» окна не должно записать прежнюю поверх) и
// перерисовывает доску. Карточки из звонков блока не видят.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, CALLS, mk, walk, textOf, byAttr, tick, button } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

const LEAD = { id: 900, full_name: 'Абдурахмонов Фаррух', phone: '+998901234567', status: 'in_process', source: 'call', created_at: '2030-03-11T04:01:00Z' };
const ITEM = {
  id: 41, public_id: 'rq_e2a9f0c1', kind: 'appointment', status: 'pending', connection: { id: 3, name: 'med24.uz' }, external_id: 'med-1',
  received_at: '2030-03-11T04:01:00Z', doctor: { id: 7, name: 'Петров Пётр' }, branch: null, what: { kind: 'consultation', name: 'Первичный приём', price: 150000 },
  start_at: '2030-03-12T05:00:00Z', duration_minutes: 30, hold_until: '2030-03-11T04:31:00Z', decline_reason: '', patient_name: 'Абдурахмонов Фаррух',
  patient_phone: '+998901234567', comment: '', patient: null, partner_cancel_at: null, can: { confirm: true, offer: true, decline: true, accept: false },
};

async function board() {
  RPC.length = 0;
  document.body.children.length = 0;
  S.leads = [LEAD];
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const cardOf = (root) => walk(root).find((n) => String(n.className).split(/\s+/).includes('crm-card'));
async function openCard(root) {
  const card = cardOf(root);
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  return document.body.children.find((n) => String(n.className).includes('modal'));
}

test('доска: строка онлайн-записи на карточке; без заявок из API — нет', async () => {
  S.apiMarks = { 900: [{ id: 41, kind: 'appointment', status: 'pending', connection_name: 'med24.uz', hold_until: '2030-03-11T04:31:00Z' }] };
  const root = await board();
  const line = byAttr(cardOf(root), 'data-api-mark')[0];
  assert.ok(line, 'нет строки онлайн-записи');
  // Срок держания — с датой, если кончается не сегодня (решения владельца 18–19): стенд живёт в 2030 году.
  assert.match(textOf(line), /med24\.uz · APIждёт подтверждения до (завтра |\d\d\.\d\d )?\d\d:\d\d$/);
  S.apiMarks = {};
  const plain = await board();
  assert.equal(byAttr(cardOf(plain), 'data-api-mark').length, 0);
});

test('окно карточки: блок онлайн-записи; подтверждение закрывает окно и перерисовывает доску', async () => {
  S.apiMarks = { 900: [{ id: 41, kind: 'appointment', status: 'pending', connection_name: 'med24.uz', hold_until: '2030-03-11T04:31:00Z' }] };
  S.apiItems = (body) => (body && body.crm_request_id === 900 ? [ITEM] : []);
  S.apiCandidates = [{ id: 1, full_name: 'Абдурахмонов Фаррух', mrn: 'A-1', date_of_birth: '', why: 'phone_name' }];
  const root = await board();
  const modal = await openCard(root);
  const box = byAttr(modal, 'data-api-booking')[0];
  assert.ok(box && textOf(box).includes('Онлайн-запись через API'));
  button(box, /Выбрать/).click();
  await tick();
  const before = RPC.filter((r) => r.name === 'api_board_marks').length;
  const dbBefore = CALLS.length;
  button(box, /Подтвердить запись/).click();
  await tick(80);
  assert.deepEqual(RPC.find((r) => r.name === 'api_booking_confirm').body, { id: 41, patient_id: 1 });
  assert.ok(!document.body.children.includes(modal), 'окно карточки закрыто');
  assert.ok(RPC.filter((r) => r.name === 'api_board_marks').length > before, 'доска перерисована');
  assert.ok(!CALLS.slice(dbBefore).some((c) => c && c.table === 'crm_requests' && c.op === 'update'), 'окно не записало карточку поверх карты, поставленной сервером');
  S.apiItems = []; S.apiMarks = {}; S.apiCandidates = [];
});

test('окно карточки: «Отклонить» — окно остаётся открытым, строки доски перечитаны', async () => {
  S.apiMarks = { 900: [{ id: 41, kind: 'appointment', status: 'pending', connection_name: 'med24.uz', hold_until: '2030-03-11T04:31:00Z' }] };
  S.apiItems = (body) => (body && body.crm_request_id === 900 ? [ITEM] : []);
  const root = await board();
  const modal = await openCard(root);
  const box = byAttr(modal, 'data-api-booking')[0];
  button(box, /^Отклонить$/).click();
  await tick();
  const sel = walk(box).find((n) => n.tagName === 'SELECT');
  sel.value = 'other';
  const before = RPC.filter((r) => r.name === 'api_board_marks').length;
  button(box, /Отклонить запись/).click();
  await tick(80);
  assert.deepEqual(RPC.find((r) => r.name === 'api_booking_decline').body, { id: 41, reason: 'other' });
  assert.ok(document.body.children.includes(modal), 'окно карточки осталось');
  assert.ok(RPC.filter((r) => r.name === 'api_board_marks').length > before, 'строки доски перечитаны');
  S.apiItems = []; S.apiMarks = {};
});

test('карточка звонка: блок онлайн-записи скрыт', async () => {
  S.apiItems = [];
  const root = await board();
  const modal = await openCard(root);
  const box = byAttr(modal, 'data-api-booking')[0];
  assert.ok(box);
  assert.equal(box.style.display, 'none');
});
