// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «Прослушать» в карточке заявки только тому,
// кому слушать можно (can_listen у каждой строки журнала — те же ворота, что
// у telephony_call_recording). Остальным — одна строка под списком: почему
// кнопки нет и где это право выдают (спецификация, п. 5, «Тесты», п. 7).
//
// Владелец писал «call center listening the records … not working on the
// roles»: кнопка рисовалась всем, у кого есть журнал, а отказ приходил только
// после нажатия — тостом. Теперь кнопки нет там, где её нажатие откажут, и
// причина написана под журналом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, mk, walk, textOf, byClass, tick } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LEAD = { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call',
  created_at: '2026-09-03T10:12:00Z', assigned_to: 12, users: { full_name: 'Оператор Лола' } };
const TALK = { id: 11, started_at: '2026-09-20T08:00:00Z', call_type: 0, billsec: 42, waitsec: 5, disposition: 'ANSWER',
  internal_number: '101', operator_name: 'Лола', recording_url: null, has_recording: true };
const DENIED = 'Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».';

async function card(calls) {
  window.easymed.state.user = ADMIN;
  S.leads = [LEAD];
  S.leadCalls = calls;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const c = byClass(root, 'crm-card')[0];
  c.dispatchEvent({ type: 'click', target: c, currentTarget: c, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  return modal;
}
const playButtons = (modal) => walk(modal).filter((n) => n.tagName === 'BUTTON' && /Прослушать/.test(textOf(n)));
const count = (s, part) => s.split(part).length - 1;

test('без права слушать: кнопки «Прослушать» нет, под списком — одна строка, где его выдают', async () => {
  const modal = await card([{ ...TALK, can_listen: false }, { ...TALK, id: 12, can_listen: false }]);
  assert.equal(playButtons(modal).length, 0, 'кнопка, которую сервер всё равно отклонит');
  assert.equal(count(textOf(modal), DENIED), 1, 'строки-пояснения нет или она у каждого звонка');
});

test('с правом слушать: «Прослушать» у каждого разговора, пояснения нет', async () => {
  const modal = await card([{ ...TALK, can_listen: true }, { ...TALK, id: 12, can_listen: true }]);
  assert.equal(playButtons(modal).length, 2);
  assert.equal(count(textOf(modal), DENIED), 0);
});

test('звонки без разговора: слушать нечего — ни кнопки, ни пояснения про право', async () => {
  const modal = await card([{ ...TALK, billsec: 0, can_listen: false }]);
  assert.equal(playButtons(modal).length, 0);
  assert.equal(count(textOf(modal), DENIED), 0);
  assert.ok(textOf(modal).includes('Разговора не было — записывать нечего.'));
});
