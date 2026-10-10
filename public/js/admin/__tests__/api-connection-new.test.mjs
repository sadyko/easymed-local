// CLINIC_API_STEP7_V1 — «Новое подключение»: ключ и секрет из черновика сервера,
// «Сгенерировать новый», проверки полей до сервера, адрес для партнёров
// (решение владельца 11); «Что передать подключению» — «Скопировать всё».
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, modal, rpcNames, settingsFixture,
  KEY_VALUE, SECRET_VALUE } from './api-harness.mjs';

const { openNewConnection, handoverText } = await import('../views/api-connection-new.js');
const KEY2 = 'em_live_TESTONLYtestonlyTESTONLYtest2222';

function draftServer() {
  let n = 0;
  onRpc('api_connection_draft', (b) => (b && b.renew === 'key'
    ? { draft_id: 'd1', key: KEY2, secret: SECRET_VALUE }
    : { draft_id: 'd' + (++n), key: KEY_VALUE, secret: SECRET_VALUE }));
}
const field = (root, id) => byAttr(root, 'id', id)[0];
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };

test('ключ и секрет — из черновика сервера; «Сгенерировать новый» — тот же черновик, новый ключ; сайт клиники не выбирается', async () => {
  reset(); draftServer();
  await openNewConnection({ settings: settingsFixture() });
  const m = modal('conn-new');
  assert.ok(m, 'окно не открылось');
  assert.ok(byAttr(m, 'aria-label', 'Ключ доступа')[0].value === KEY_VALUE);
  assert.ok('disabled' in byAttr(m, 'data-apic-kind', 'site')[0].attrs);
  byAttr(m, 'data-apic-act', 'regen')[0].click();
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'api_connection_draft').map((c) => c[1]), [{}, { draft_id: 'd1', renew: 'key' }]);
  assert.equal(byAttr(m, 'aria-label', 'Ключ доступа')[0].value, KEY2);
});

test('проверки до сервера: без названия, запись без «Свободного времени», http в уведомлениях — create не уходит', async () => {
  reset(); draftServer();
  await openNewConnection({ settings: settingsFixture() });
  const m = modal('conn-new');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.ok(textOf(m).includes('Введите название подключения.'));
  type(field(m, 'apic-f-name'), 'med24.uz');
  const slots = field(m, 'apic-read-slots');
  slots.checked = false; slots.dispatchEvent({ type: 'change' });
  type(field(m, 'apic-f-hook'), 'http://med24.uz/hook');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  const t = textOf(m);
  assert.ok(t.includes('Запись на приём требует права «Свободное время».'));
  assert.ok(t.includes('Обычный http не принимаем'));
  assert.ok(!rpcNames().includes('api_connection_create'));
});

test('создание: черновик называется, ключ не отправляется; окно «Что передать» — адрес, ключ, секрет и «Скопировать всё»', async () => {
  reset(); draftServer();
  let created = false;
  onRpc('api_connection_create', (b) => { created = b; return { connection: { ...settingsFixture().connections[1], id: 9, name: b.name }, key: KEY_VALUE, secret: SECRET_VALUE, base_url: 'https://api.easymed.uz/klinika-demo/v1/' }; });
  await openNewConnection({ settings: settingsFixture(), onCreated: () => {} });
  const m = modal('conn-new');
  type(field(m, 'apic-f-name'), 'med24.uz');
  type(field(m, 'apic-f-hook'), 'https://med24.uz/hooks/easymed');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.equal(created.draft_id, 'd1');
  assert.ok(!('key' in created) && !('secret' in created), 'ключ ушёл на сервер из браузера');
  assert.equal(created.kind, 'partner');
  assert.equal(created.active, 1);
  assert.ok(!modal('conn-new'), 'окно создания не закрылось');
  const h = modal('conn-key');
  assert.ok(h, 'нет окна «Что передать»');
  for (const s of ['https://api.easymed.uz/klinika-demo/v1/', 'Authorization: Bearer <ключ>', 'с источником «med24.uz»']) assert.ok(textOf(h).includes(s) || byAttr(h, 'aria-label').some((n) => n.value === s), s);
  buttonByText(h, /Скопировать всё/).click();
  await tick();
  assert.ok(clip[0].includes(KEY_VALUE) && clip[0].includes(SECRET_VALUE) && clip[0].includes('https://api.easymed.uz/klinika-demo/v1/'));
});

test('адрес для партнёров не заполнен: «Подключение включено» снято; включённое — отказ сервера с «Открыть «Компанию»»', async () => {
  reset(); draftServer();
  const nav = [];
  onRpc('api_connection_create', () => ({ __error: { code: 'partner_address_required',
    message: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.' }, status: 409 }));
  await openNewConnection({ settings: settingsFixture({ partner_address_missing: ['street_ru'] }), onNavigate: (v) => nav.push(v) });
  const m = modal('conn-new');
  assert.ok(textOf(m).includes('можно сохранить только выключенным'));
  const active = field(m, 'apic-f-active');
  active.checked = true; active.dispatchEvent({ type: 'change' });
  type(field(m, 'apic-f-name'), 'med24.uz');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.ok(textOf(m).includes('Подключение нельзя включить'));
  buttonByText(m, /Открыть «Компанию»/).click();
  assert.deepEqual(nav, ['documents-settings']);
});

test('текст «Скопировать всё»: секрет — только когда задан адрес уведомлений', () => {
  const base = { clinic: 'Клиника Демо', baseUrl: 'https://api.easymed.uz/klinika-demo/v1/', key: KEY_VALUE, scopes: ['clinic', 'requests'] };
  const withHook = handoverText({ ...base, secret: SECRET_VALUE });
  const without = handoverText({ ...base, secret: '' });
  assert.ok(withHook.includes(SECRET_VALUE) && !without.includes(SECRET_VALUE));
  assert.ok(withHook.includes('Разрешено: О клинике, Заявки'));
  assert.ok(withHook.includes('публичный сервер'));
});

// CLINIC_API_STEP7_V1 — решение владельца 11 по зданиям: создание включённого
// подключения отказано из-за филиала на сайте без адреса — сообщение называет
// здание, «Подключение включено» снято, дорога — в «Филиалы».
test('создание включённого: филиал на сайте без адреса — сообщение называет здание, «Открыть «Филиалы»»', async () => {
  reset(); draftServer();
  const nav = [];
  onRpc('api_connection_create', () => ({ __error: { code: 'branch_address_required',
    message: 'Подключение нельзя включить: у здания «Чиланзар», которое показывается на сайте, не заполнен адрес для партнёров — город или область, район и улица на русском. Заполните его в «Филиалах» или снимите там «Показывать филиал на сайте и у партнёров».' }, status: 409 }));
  await openNewConnection({ settings: settingsFixture(), onNavigate: (v, p) => nav.push([v, p]) });
  const m = modal('conn-new');
  type(field(m, 'apic-f-name'), 'med24.uz');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.ok(textOf(m).includes('у здания «Чиланзар»'));
  assert.equal(field(m, 'apic-f-active').attrs.checked, undefined, '«Подключение включено» не снято');
  buttonByText(m, /Открыть «Филиалы»/).click();
  assert.deepEqual(nav, [['settings', { section: 'branches' }]]);
});
