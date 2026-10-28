// CRM_PHONE_V1 (2026-10-17) — «Телефон» внутри EasyMed: кнопка в верхней панели и
// панель наборника и журнала, на стенде доски заявок. Владелец: «I want it to be
// inside the easymed, not in separate adress» → «inside the CRM» → по снимку:
// «put the phone button next to reload button». Проверяется то, что видит
// оператор: кнопка по правам, панель с клавиатурой и журналом, набор уходит в
// telephony_dial и рисует карточку «трубка звонит», сегменты и поиск, раскрытие
// строки с «Прослушать», полоса «только что звонили», отказ прав — строкой, а не
// мёртвой кнопкой, закрытие — вкладка на краю и снятый сдвиг, карточка заявки —
// окном доски, панель переживает переход между разделами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, mk, walk, textOf, byAttr, byClass, tick } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');
const { resetCrmPhone, phoneWorkplaceVisible, mountPhoneButton } = await import('../views/crm-phone.js');
const perms = await import('../permissions.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Времена звонков не пересекают полночь, в какой бы час ни шёл прогон: «сегодня»
// — не раньше начала сегодняшних суток (а первый — ещё и моложе двух минут, для
// «Только что звонили»), «вчера» — вчерашний полдень по местному времени. Было
// «сейчас − 26 часов», и с 00:00 до 02:00 звонок уезжал в «Ранее».
const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
const today = (ago) => Math.max(now - ago, dayStart.getTime());
const yesterdayNoon = new Date(now); yesterdayNoon.setDate(yesterdayNoon.getDate() - 1); yesterdayNoon.setHours(12, 0, 0, 0);
// В порядке сервера: от свежего к старому.
const CALLS = [
  { id: 2, started_at: iso(today(60000)), call_type: 0, external_number: '998935550112', internal_number: '', billsec: 0, disposition: 'NOANSWER',
    patient_id: null, patient_name: null, patient_mrn: null, operator_name: null, recording_url: null, has_recording: false },
  { id: 1, started_at: iso(today(5 * 60000)), call_type: 0, external_number: '998901112233', internal_number: '101', billsec: 42, disposition: 'ANSWER',
    patient_id: 5, patient_name: 'Каримова Азиза', patient_mrn: 'A-12', operator_name: 'Лола', recording_url: null, has_recording: true },
  { id: 3, started_at: iso(yesterdayNoon.getTime()), call_type: 1, external_number: '998977012345', internal_number: '101', billsec: 96, disposition: 'ANSWER',
    patient_id: 6, patient_name: 'Юсупова Малика', patient_mrn: null, operator_name: 'Лола', recording_url: null, has_recording: true },
];
const LEAD = { id: 11, full_name: 'Заявка Тестовая', phone: '+998 90 123 45 67', status: 'in_process', source: 'call', created_at: iso(now), assigned_to: 7, users: { full_name: 'Админ' } };

const NAV = [];
/** Оболочка после входа: кнопка в верхней панели, сдвигаемая область — viewRoot. */
async function shell({ user = ADMIN, me = null, leads = [], crm = true } = {}) {
  resetCrmPhone();
  RPC.length = 0; NAV.length = 0;
  window.easymed.state.user = user;
  S.leads = leads; S.phoneMe = me; S.callLog = CALLS; S.extensions = []; S.dialError = null;
  document.body.children.length = 0;
  const viewRoot = mk('div');
  const bar = mk('div');
  const btn = mountPhoneButton({ onNavigate: (v) => NAV.push(v), shiftTarget: viewRoot });
  if (btn) bar.appendChild(btn);
  if (crm) { await renderCrm(viewRoot, { onNavigate() {} }); await tick(); }
  return { viewRoot, bar, btn };
}
const drawer = () => document.body.children.find((n) => n.attrs && 'data-cph-drawer' in n.attrs);
const edge = () => document.body.children.find((n) => n.attrs && 'data-cph-edge' in n.attrs);
const key = (d, k) => byAttr(d, 'data-k').find((b) => b.getAttribute('data-k') === k).click();
const seg = (d, k) => byAttr(d, 'data-cph-seg').find((b) => b.getAttribute('data-cph-seg') === k).click();
const open = async (btn) => { btn.click(); await tick(40); return drawer(); };

test('кнопка «Телефон» есть у администратора; нажатие открывает панель с клавиатурой, журналом по дням и сдвигает область экрана', async () => {
  const { viewRoot, btn } = await shell();
  assert.ok(btn, 'кнопки «Телефон» нет');
  assert.ok(btn.attrs && 'data-crm-phone' in btn.attrs);
  assert.match(textOf(btn), /Телефон/);
  const d = await open(btn);
  assert.ok(d, 'панель не появилась в document.body');
  assert.ok(!String(d.className).includes('cph-closed'), 'панель осталась закрытой');
  assert.equal(byAttr(d, 'data-k').length, 12, 'клавиатура 3×4');
  assert.equal(byAttr(d, 'data-cph-row').length, 3, 'три строки журнала');
  assert.deepEqual(byClass(d, 'cph-grp').map(textOf), ['Сегодня', 'Вчера']);
  assert.ok(String(viewRoot.className).includes('crm-phone-shift'), 'экран не уступил место панели');
  assert.equal(textOf(byAttr(d, 'data-cph-cnt')[0]), '3 из 3');
  assert.match(textOf(byAttr(d, 'data-cph-status')[0]), /Готов/);
  assert.equal(textOf(byAttr(d, 'data-cph-ext')[0]), 'трубка не выбрана');
  assert.match(byAttr(d, 'data-cph-ext')[0].title, /Админ/, 'имя оператора — в подсказке');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.ok(RPC.some((r) => r.name === 'telephony_phone_me'));
  assert.ok(RPC.some((r) => r.name === 'telephony_call_log'));
});

test('видимость кнопки: право набора ИЛИ журнала; без обоих — кнопки нет, прежняя снимается', async () => {
  perms.setEffectiveFromRole({ name: 'x', permissions: { sections: ['crm'], grants: { 'crm.dial': 'none', 'crm.calls': 'none' } } });
  try {
    assert.equal(phoneWorkplaceVisible(), false);
    perms.setEffectiveFromRole({ name: 'x', permissions: { sections: ['crm'], grants: { 'crm.dial': 'none', 'crm.calls': 'view' } } });
    assert.equal(phoneWorkplaceVisible(), true);
    perms.setEffectiveFromRole({ name: 'x', permissions: { sections: ['crm'], grants: { 'crm.dial': 'edit', 'crm.calls': 'none' } } });
    assert.equal(phoneWorkplaceVisible(), true);
    perms.setEffectiveFromRole({ name: 'x', permissions: { sections: ['crm'], levels: { crm: 'editor' }, grants: { 'crm.dial': 'none', 'crm.calls': 'none' } } });
    const { btn } = await shell({ user: { id: 8, full_name: 'Кассир', role: 'cashier' }, crm: false });
    assert.equal(btn, null, 'кнопка нарисована тому, кому сервер откажет');
    assert.equal(drawer(), undefined);
  } finally {
    perms.setFullAccess(null);
  }
});

test('кнопка идемпотентна: повторный монтаж (смена языка) снимает прежнюю и помнит открытую панель', async () => {
  const { viewRoot, bar, btn } = await shell();
  await open(btn);
  const again = mountPhoneButton({ onNavigate: () => {}, shiftTarget: viewRoot });
  bar.appendChild(again);
  assert.notEqual(again, btn);
  assert.equal(again.getAttribute('aria-pressed'), 'true', 'новая кнопка не знает, что панель открыта');
  assert.ok(String(again.className).includes('on'));
  assert.equal(document.body.children.filter((n) => n.attrs && 'data-cph-drawer' in n.attrs).length, 1, 'вторая панель');
});

test('набор: шесть цифр — «Позвонить» выключена, девять — включена; нажатие уходит в telephony_dial и рисует карточку «трубка звонит»; имя — по заявке доски', async () => {
  const { btn } = await shell({ leads: [LEAD] });
  const d = await open(btn);
  for (const k of '901234') key(d, k);
  assert.equal(textOf(byAttr(d, 'data-cph-num')[0]), '901 234');
  assert.ok(byAttr(d, 'data-cph-call')[0].hasAttribute('disabled'), 'шесть цифр — а звонить можно');
  assert.match(textOf(byAttr(d, 'data-cph-hint')[0]), /целиком/);
  for (const k of '567') key(d, k);
  assert.ok(!byAttr(d, 'data-cph-call')[0].hasAttribute('disabled'));
  assert.match(textOf(byAttr(d, 'data-cph-who')[0]), /Заявка Тестовая/, 'набранный номер заявки не назван по имени');
  byAttr(d, 'data-cph-del')[0].click();
  assert.equal(textOf(byAttr(d, 'data-cph-num')[0]), '901 234 56');
  key(d, '7');
  byAttr(d, 'data-cph-call')[0].click();
  await tick(40);
  const sent = RPC.find((r) => r.name === 'telephony_dial');
  assert.deepEqual(sent && sent.body, { phone: '901234567' });
  const card = byAttr(d, 'data-cph-card')[0];
  assert.ok(card, 'карточки звонка нет');
  assert.equal(card.getAttribute('data-cph-card'), 'ringing');
  assert.match(textOf(card), /Сначала зазвонит/);
  assert.match(textOf(card), /Заявка Тестовая/);
  assert.match(textOf(byAttr(d, 'data-cph-status')[0]), /Трубка звонит/);
  // «Скрыть» — покой; набранное стёрто.
  byAttr(d, 'data-cph-hide')[0].click();
  assert.equal(byAttr(d, 'data-cph-card').length, 0);
  assert.equal(byAttr(d, 'data-k').length, 12);
  assert.match(textOf(byAttr(d, 'data-cph-num')[0]), /Наберите номер/);
});

test('отказ станции — словами в панели, карточки нет', async () => {
  const { btn } = await shell();
  const d = await open(btn);
  S.dialError = 'Линия для звонков не выбрана или выключена. Проверьте настройки — раздел «Телефония».';
  for (const k of '998901234567') key(d, k);
  byAttr(d, 'data-cph-call')[0].click();
  await tick(40);
  assert.equal(byAttr(d, 'data-cph-card').length, 0);
  assert.match(textOf(byAttr(d, 'data-cph-msg')[0]), /Линия для звонков/);
});

test('журнал: сегмент «Пропущенные» оставляет один звонок, поиск по имени — один; строка раскрывается и предлагает «Прослушать» и «Карту пациента»', async () => {
  const { btn } = await shell();
  const d = await open(btn);
  seg(d, 'miss');
  assert.equal(byAttr(d, 'data-cph-row').length, 1);
  assert.match(textOf(byAttr(d, 'data-cph-row')[0]), /Пропущен/);
  assert.equal(textOf(byAttr(d, 'data-cph-cnt')[0]), '1 из 3');
  seg(d, 'out');
  assert.equal(byAttr(d, 'data-cph-row').length, 1);
  assert.match(textOf(byAttr(d, 'data-cph-row')[0]), /Юсупова/);
  seg(d, 'all');
  const q = byAttr(d, 'data-cph-q')[0];
  q.value = 'каримова'; q.dispatchEvent({ type: 'input', target: q, currentTarget: q });
  assert.equal(byAttr(d, 'data-cph-row').length, 1);
  assert.match(textOf(byAttr(d, 'data-cph-row')[0]), /Каримова Азиза · A-12/);
  q.value = ''; q.dispatchEvent({ type: 'input', target: q, currentTarget: q });
  assert.equal(byAttr(d, 'data-cph-row').length, 3);
  // Раскрытие строки разговора: оператор, «Прослушать», «Карта пациента».
  byAttr(d, 'data-cph-row').find((r) => r.getAttribute('data-cph-row') === '1').click();
  const det = byAttr(d, 'data-cph-details');
  assert.equal(det.length, 1);
  assert.match(textOf(det[0]), /Оператор: Лола/);
  assert.equal(byAttr(det[0], 'data-cph-listen').length, 1);
  assert.equal(byAttr(det[0], 'data-cph-open-patient').length, 1);
  // Кнопки «Перезвонить» — у каждой строки, с номером в цифрах.
  assert.deepEqual(byAttr(d, 'data-cph-cb').map((b) => b.getAttribute('data-cph-cb')), ['998935550112', '998901112233', '998977012345']);
  // Пустой результат — словами.
  q.value = 'нет такого'; q.dispatchEvent({ type: 'input', target: q, currentTarget: q });
  assert.equal(byAttr(d, 'data-cph-row').length, 0);
  assert.match(textOf(byAttr(d, 'data-cph-empty')[0]), /Ничего не найдено/);
});

test('«Открыть заявку» из журнала: переход в CRM и то же окно карточки, что у доски', async () => {
  const lead = { ...LEAD, phone: '+998 90 111 22 33' };   // номер первой строки журнала
  const { btn } = await shell({ leads: [lead] });
  const d = await open(btn);
  byAttr(d, 'data-cph-row').find((r) => r.getAttribute('data-cph-row') === '1').click();
  const openBtn = byAttr(d, 'data-cph-open-lead');
  assert.equal(openBtn.length, 1, 'у звонка с заявкой на доске нет «Открыть заявку»');
  openBtn[0].click();
  await tick(60);
  assert.deepEqual(NAV, ['crm'], 'перед карточкой панель не перешла в CRM');
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  // Имя заявки — в поле ввода карточки, а не текстом: ищем INPUT с этим значением.
  assert.ok(walk(modal).some((n) => n.tagName === 'INPUT' && n.value === 'Заявка Тестовая'), 'открылась не та заявка');
});

test('«Только что звонили» — полоса с «Перезвонить» по пропущенному младше двух минут', async () => {
  const { btn } = await shell();
  const d = await open(btn);
  const live = byAttr(d, 'data-cph-live')[0];
  assert.equal(live.hidden, false);
  assert.match(textOf(live), /Только что звонили: \+998 93 555 01 12/);
  const cb = byAttr(live, 'data-cph-live-cb');
  assert.equal(cb.length, 1);
  cb[0].click();
  await tick(40);
  const sent = RPC.filter((r) => r.name === 'telephony_dial').pop();
  assert.deepEqual(sent && sent.body, { phone: '998935550112' });
});

test('без права слушать: нет «Прослушать», есть строка-пояснение; без права набора — нет «Позвонить», «Перезвонить» и выбора трубки', async () => {
  const me = { id: 9, full_name: 'Журнал', extension: '', line: 'onlinepbx', seen_extensions: [], may_dial: false, may_log: true, may_hear: false };
  const { btn } = await shell({ user: { id: 9, full_name: 'Журнал', role: 'registrar' }, me });
  const d = await open(btn);
  assert.equal(byAttr(d, 'data-cph-call').length, 0, 'кнопка «Позвонить» нарисована тому, кому сервер откажет');
  assert.equal(byAttr(d, 'data-cph-cb').length, 0, '«Перезвонить» нарисована тому, кому сервер откажет');
  assert.equal(byAttr(d, 'data-cph-live-cb').length, 0);
  assert.match(textOf(byAttr(d, 'data-cph-hint')[0]), /право «Позвонить пациенту»/);
  assert.ok(byAttr(d, 'data-cph-ext')[0].hasAttribute('disabled'), 'выбор трубки открыт тому, кто звонить не может');
  byAttr(d, 'data-cph-row').find((r) => r.getAttribute('data-cph-row') === '1').click();
  assert.equal(byAttr(d, 'data-cph-listen').length, 0, 'кнопка, которую сервер всё равно отклонит');
  assert.equal(byAttr(d, 'data-cph-rec-note').length, 1, 'нет строки, где выдают право');
  assert.match(textOf(byAttr(d, 'data-cph-rec-note')[0]), /«Прослушать запись»/);
});

test('без права на журнал: нижняя половина — одна строка про право, журнал не спрашивается', async () => {
  const me = { id: 10, full_name: 'Набор', extension: '105', line: 'onlinepbx', seen_extensions: ['105'], may_dial: true, may_log: false, may_hear: false };
  const { btn } = await shell({ user: { id: 10, full_name: 'Набор', role: 'callcenter' }, me });
  const d = await open(btn);
  assert.equal(byAttr(d, 'data-cph-row').length, 0);
  assert.match(textOf(byAttr(d, 'data-cph-empty')[0]), /право «Журнал звонков»/);
  assert.equal(textOf(byAttr(d, 'data-cph-ext')[0]), 'вн. 105');
  assert.match(byAttr(d, 'data-cph-ext')[0].title, /Набор/);
  assert.equal(byAttr(d, 'data-cph-call').length, 1);
});

test('выбор трубки: список от станции, текущая отмечена, «Запомнить» уходит в telephony_my_extension', async () => {
  const me = { id: 7, full_name: 'Админ', extension: '101', line: 'onlinepbx', seen_extensions: ['101', '102'], may_dial: true, may_log: true, may_hear: true };
  const { btn } = await shell({ me });
  S.extensions = ['101', '102', '103'];
  const d = await open(btn);
  byAttr(d, 'data-cph-ext')[0].click();
  await tick(40);
  const sel = byAttr(d, 'data-cph-ext-select')[0];
  assert.ok(sel, 'выбор трубки не открылся');
  assert.deepEqual(sel.children.map((o) => o.attrs.value), ['', '101', '102', '103']);
  assert.ok(sel.children[1].hasAttribute('selected'));
  sel.value = '103';
  byAttr(d, 'data-cph-ext-save')[0].click();
  await tick(40);
  const sent = RPC.find((r) => r.name === 'telephony_my_extension');
  assert.deepEqual(sent && sent.body, { extension: '103' });
  assert.equal(byAttr(d, 'data-cph-ext-select').length, 0, 'после «Запомнить» выбор не закрылся');
  assert.equal(textOf(byAttr(d, 'data-cph-ext')[0]), 'вн. 103');
});

test('закрыть — панель спрятана, вкладка на краю видна, сдвиг снят; вкладка открывает снова', async () => {
  const { viewRoot, btn } = await shell();
  const d = await open(btn);
  byAttr(d, 'data-cph-close')[0].click();
  assert.ok(String(d.className).includes('cph-closed'));
  assert.equal(edge().hidden, false, 'вкладки «Телефон» на краю нет');
  assert.ok(!String(viewRoot.className).includes('crm-phone-shift'), 'сдвиг остался при закрытой панели');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  edge().click();
  await tick(20);
  assert.ok(!String(d.className).includes('cph-closed'));
  assert.equal(edge().hidden, true);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
});

// Кнопка в верхней панели — на каждом экране: переход из CRM в другой раздел
// (оболочка прячет панель доски display:none) телефон не трогает.
test('переход в другой раздел панель не закрывает: доска спрятана, телефон остаётся открытым', async () => {
  const { viewRoot, btn } = await shell();
  const d = await open(btn);
  viewRoot.children[0].style.display = 'none';   // панель доски спрятана кэшем оболочки
  await tick(60);
  assert.ok(!String(d.className).includes('cph-closed'), 'телефон закрылся вместе с доской');
  assert.equal(edge().hidden, true);
});
