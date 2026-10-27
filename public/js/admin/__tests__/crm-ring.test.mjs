// CALL_RING_V1 (2026-10-17) — блок «Звонит» в панели «Телефон» на стенде доски.
// Владелец: «is it possible to ring here and number with patient name appear» →
// «panel show the "Звонит" block with an "Открыть карту" button». Проверяется:
// живой входящий → блок с именем пациента и кнопкой карты (карта НЕ открывается
// сама); неизвестный номер → «Новая заявка» с подставленным номером; заявка →
// окно доски; ответили / пропущен; закрытая панель — toast и пульс; «Скрыть»;
// звук выключается и помнится; без WebAudio ничего не падает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, mk, walk, textOf, byAttr, tick, TOASTS } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');
const { resetCrmPhone, mountPhoneButton } = await import('../views/crm-phone.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const now = Date.now();
const LEAD = { id: 11, full_name: 'Заявка Тестовая', phone: '+998 93 555 01 12', status: 'in_process', source: 'call', created_at: new Date(now).toISOString(), assigned_to: 7, users: { full_name: 'Админ' } };
const live = (over) => ({ uuid: 'r1', direction: 'in', state: 'ringing', was_answered: false, caller: '998901112233', callee: '101', number: '998901112233',
  since: new Date(now).toISOString(), updated: now, patient: { id: 5, full_name: 'Каримова Азиза', mrn: 'A-12' }, lead: null, ...over });

const NAV = [];
async function shell({ leads = [LEAD], calls = [] } = {}) {
  resetCrmPhone();
  RPC.length = 0; NAV.length = 0; TOASTS.length = 0;
  window.easymed.state.user = ADMIN;
  S.leads = leads; S.phoneMe = null; S.callLog = []; S.extensions = []; S.dialError = null; S.live = calls;
  document.body.children.length = 0;
  const viewRoot = mk('div');
  const btn = mountPhoneButton({ onNavigate: (v, p) => NAV.push([v, p]), shiftTarget: viewRoot, livePollMs: 25 });
  await renderCrm(viewRoot, { onNavigate() {} });
  await tick(80);
  return { viewRoot, btn };
}
const drawer = () => document.body.children.find((n) => n.attrs && 'data-cph-drawer' in n.attrs);
const edge = () => document.body.children.find((n) => n.attrs && 'data-cph-edge' in n.attrs);
const open = async (btn) => { btn.click(); await tick(80); return drawer(); };
const ringBlock = (d) => byAttr(d, 'data-cph-ring')[0];

test('живой входящий от пациента: кнопка в верхней строке пульсирует; в панели блок «Звонит» с именем, картой и кнопкой «Открыть карту» — карта сама не открывается', async () => {
  const { btn } = await shell({ calls: [live()] });
  assert.ok(String(btn.className).includes('ring'), 'кнопка «Телефон» не показала звонок');
  assert.equal(NAV.length, 0, 'карта открылась сама — владелец просил кнопку');
  const d = await open(btn);
  const b = ringBlock(d);
  assert.ok(b, 'блока «Звонит» нет');
  assert.equal(b.getAttribute('data-cph-ring'), 'ringing');
  assert.match(textOf(b), /Каримова Азиза/);
  assert.match(textOf(b), /Входящий звонок/);
  assert.match(textOf(b), /Карта A-12/);
  assert.equal(byAttr(d, 'data-k').length, 0, 'клавиатура рисуется поверх звонка');
  assert.match(textOf(byAttr(d, 'data-cph-status')[0]), /Звонит/);
  byAttr(b, 'data-cph-ring-patient')[0].click();
  assert.deepEqual(NAV, [['patient-card', { id: 5, full_name: 'Каримова Азиза' }]]);
});

test('незнакомый номер: «Номер не знаком» и «Новая заявка» — окно доски с подставленным номером', async () => {
  const { btn } = await shell({ calls: [live({ patient: null, number: '998935550199', caller: '998935550199' })] });
  const d = await open(btn);
  const b = ringBlock(d);
  assert.match(textOf(b), /Номер не знаком/);
  assert.match(textOf(b), /\+998 93 555 01 99/);
  assert.equal(byAttr(b, 'data-cph-ring-patient').length, 0);
  byAttr(b, 'data-cph-ring-new')[0].click();
  await tick(60);
  assert.ok(NAV.some(([v]) => v === 'crm'), 'перед окном заявки не перешли в CRM');
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно новой заявки не открылось');
  assert.ok(walk(modal).some((n) => n.tagName === 'INPUT' && n.value === '+998 93 555 01 99'), 'номер звонящего не подставлен');
});

test('звонит заявка с доски: «Заявка на доске» и «Открыть заявку» — то же окно, что у доски', async () => {
  const { btn } = await shell({ calls: [live({ patient: null, number: '998935550112', caller: '998935550112', lead: { id: 11, full_name: 'Заявка Тестовая', status: 'in_process' } })] });
  const d = await open(btn);
  const b = ringBlock(d);
  assert.match(textOf(b), /Заявка Тестовая/);
  assert.match(textOf(b), /Заявка на доске/);
  byAttr(b, 'data-cph-ring-lead')[0].click();
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  assert.ok(walk(modal).some((n) => n.tagName === 'INPUT' && n.value === 'Заявка Тестовая'));
});

test('ответили → «Разговор идёт»; сорвался → «Пропущен» и «Перезвонить»; состоявшийся и законченный — блока нет, клавиатура на месте', async () => {
  const { btn } = await shell({ calls: [live({ state: 'answered', was_answered: true })] });
  const d = await open(btn);
  assert.match(textOf(ringBlock(d)), /Разговор идёт/);
  S.live = [live({ state: 'ended', was_answered: false })];
  await tick(80);
  const b = ringBlock(d);
  assert.equal(b.getAttribute('data-cph-ring'), 'ended');
  assert.match(textOf(b), /Пропущен/);
  assert.equal(byAttr(b, 'data-cph-cb').length, 1);
  S.live = [live({ state: 'ended', was_answered: true })];
  await tick(80);
  assert.equal(byAttr(d, 'data-cph-ring').length, 0);
  assert.equal(byAttr(d, 'data-k').length, 12);
});

test('панель закрыта: один toast «Звонит: …» и пульс вкладки на краю; «Скрыть» убирает блок до конца звонка', async () => {
  const { btn } = await shell({ calls: [] });
  const d = await open(btn);
  byAttr(d, 'data-cph-close')[0].click();
  S.live = [live()];
  await tick(120);
  assert.equal(TOASTS.filter((t) => /Звонит: Каримова Азиза/.test(t)).length, 1, 'toast не один раз на звонок: ' + TOASTS.join(' | '));
  assert.ok(String(edge().className).includes('ring'), 'вкладка на краю не пульсирует');
  btn.click(); await tick(40);
  byAttr(ringBlock(d), 'data-cph-ring-hide')[0].click();
  await tick(60);
  assert.equal(byAttr(d, 'data-cph-ring').length, 0, 'скрытый звонок остался');
  assert.equal(byAttr(d, 'data-k').length, 12);
  assert.ok(!String(edge().className).includes('ring'));
});

test('звук: кнопка-колокольчик выключает и помнит в этом браузере; без WebAudio звонок не падает', async () => {
  const { btn } = await shell({ calls: [live()] });
  const d = await open(btn);
  const mute = byAttr(d, 'data-cph-mute')[0];
  assert.equal(mute.getAttribute('aria-pressed'), 'false');
  mute.click();
  assert.equal(mute.getAttribute('aria-pressed'), 'true');
  assert.equal(localStorage.getItem('easymed.phone.mute'), '1');
  assert.ok(String(mute.className).includes('off'));
  await tick(60);
  assert.ok(ringBlock(d), 'блок исчез при выключенном звуке');
});
