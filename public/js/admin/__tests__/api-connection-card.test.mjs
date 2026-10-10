// CLINIC_API_STEP7_V1 — карточка подключения: только изменённое; уровни
// (`can`); ключ и секрет — показать, выпустить новый с подтверждением;
// удаление с подтверждением; журнал — запросы (шаг 8) и изменения.
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, onRpc, calls, textOf, byAttr, buttonByText, tick, modal, rpcNames, settingsFixture, KEY_VALUE, mk, docKey } from './api-harness.mjs';

const { openConnectionCard } = await import('../views/api-connection-card.js');
const KEY2 = 'em_live_TESTONLYtestonlyTESTONLYtest2222';
const S = settingsFixture();
const P = S.connections[1];
function open(over = {}, conn = P, tab = 'main') {
  const changed = [];
  openConnectionCard({ settings: settingsFixture(over), connection: conn, onChanged: () => changed.push(1), onNavigate: () => {}, tab });
  return { m: modal('conn'), changed };
}
const tabBtn = (m, k) => byAttr(m, 'data-apic-tab', k)[0];
const sent = (name) => calls.filter((c) => c[0] === name).map((c) => c[1]);

test('сохранение шлёт только изменённое: выключить — {id, active:false}; переименовать — {id, name}', async () => {
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const { m, changed } = open();
  const active = byAttr(m, 'id', 'apic-f-active')[0];
  active.checked = false; active.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, active: 0 }]);
  assert.equal(changed.length, 1);
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const t2 = open();
  const name = byAttr(t2.m, 'id', 'apic-f-name')[0];
  name.value = 'med24'; name.dispatchEvent({ type: 'input' });
  buttonByText(t2.m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, name: 'med24' }]);
});

test('права: «Доступ» — галочка «Пакеты услуг» уходит упорядоченным списком прав', async () => {
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const { m } = open();
  tabBtn(m, 'access').click();
  const pk = byAttr(m, 'id', 'apic-read-packages')[0];
  pk.checked = true; pk.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, scopes: ['clinic', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments'] }]);
});

test('ключ (администратор): «Показать» — api_connection_reveal; «Выпустить новый ключ» — подтверждение, затем окно «Новый ключ для …»', async () => {
  reset();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  onRpc('api_connection_regenerate', () => ({ value: KEY2, connection: { ...P, key_mask: 'em_live_••••2222' } }));
  const { m } = open({}, P, 'key');
  byAttr(m, 'data-apic-act', 'show')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_reveal'), [{ id: 3, what: 'key' }]);
  assert.equal(byAttr(m, 'aria-label', 'Ключ доступа')[0].value, KEY_VALUE);
  buttonByText(m, /Выпустить новый ключ/).click();
  assert.ok(textOf(m).includes('прежний перестанет работать сразу'));
  assert.equal(sent('api_connection_regenerate').length, 0, 'без подтверждения ушёл запрос');
  byAttr(m, 'data-apic-act', 'rotate-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_regenerate'), [{ id: 3, what: 'key', confirm: true }]);
  const h = modal('conn-key');
  assert.ok(h && textOf(h).includes('прежний больше не подходит'));
});

test('секрет: «Новый секрет» — подтверждение, затем новый секрет виден в поле', async () => {
  reset();
  onRpc('api_connection_regenerate', () => ({ value: 'em_whsec_TESTONLYtestonlyTESTONLYtest9999', connection: P }));
  const { m } = open({}, P, 'hooks');
  byAttr(m, 'data-apic-act', 'regen')[0].click();
  byAttr(m, 'data-apic-act', 'secret-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_regenerate'), [{ id: 3, what: 'secret', confirm: true }]);
  assert.equal(byAttr(m, 'aria-label', 'Секрет для подписи уведомлений')[0].value, 'em_whsec_TESTONLYtestonlyTESTONLYtest9999');
});

test('удаление: подтверждение, затем {id, confirm:true}; у сайта клиники удаления нет', async () => {
  reset();
  onRpc('api_connection_delete', () => ({ ok: true }));
  const { m, changed } = open();
  buttonByText(m, /Удалить подключение/).click();
  assert.ok(textOf(m).includes('Ключ и секрет сотрутся'));
  byAttr(m, 'data-apic-act', 'delete-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_delete'), [{ id: 3, confirm: true }]);
  assert.equal(changed.length, 1);
  reset();
  const site = open({}, S.connections[0]);
  assert.ok(!buttonByText(site.m, /Удалить подключение/));
  assert.ok(textOf(site.m).includes('удалить его нельзя'));
  assert.ok(textOf(site.m).includes('klinika-demo.uz'), 'адрес сайта клиники — из «Компании»');
});

test('«Изменение» без администратора: ключ и секрет скрыты, права и уведомления не правятся, удаления нет; «Сохранить» есть', () => {
  reset();
  const { m } = open({ can: { view: true, edit: true, admin: false } }, { ...P, key_mask: '', secret_mask: '' }, 'key');
  assert.ok(textOf(m).includes('Ключ видит и меняет только администратор.'));
  assert.equal(byAttr(m, 'data-apic-act', 'show').length, 0);
  tabBtn(m, 'access').click();
  assert.ok('disabled' in byAttr(m, 'id', 'apic-read-packages')[0].attrs);
  assert.ok(!buttonByText(m, /Удалить подключение/));
  assert.ok(buttonByText(m, /^Сохранить$/));
});

test('«Просмотр»: поля выключены, «Сохранить» нет', () => {
  reset();
  const { m } = open({ can: { view: true, edit: false, admin: false } }, { ...P, key_mask: '', secret_mask: '' });
  assert.ok('disabled' in byAttr(m, 'id', 'apic-f-name')[0].attrs);
  assert.ok(!buttonByText(m, /^Сохранить$/));
});

test('включение без адреса для партнёров: отказ сервера показан с «Открыть «Компанию»»', async () => {
  reset();
  onRpc('api_connection_update', () => ({ __error: { code: 'partner_address_required',
    message: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.' }, status: 409 }));
  const { m } = open({}, { ...P, active: false });
  const active = byAttr(m, 'id', 'apic-f-active')[0];
  active.checked = true; active.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.ok(textOf(m).includes('Подключение нельзя включить'));
  assert.ok(buttonByText(m, /Открыть «Компанию»/));
});

test('журнал: «Запросы с этим ключом» — честно пусто до публичного сервера; «Изменения настроек» — из api_journal_list', async () => {
  reset();
  onRpc('api_journal_list', (b) => (b && b.connection_id === 3 ? [{ id: 1, at: '2026-10-10T09:00:00Z', user_name: 'Босс', action: 'created', detail: {} }] : []));
  const { m } = open({}, P, 'log');
  await tick();
  assert.ok(textOf(m).includes('Запросов с этим ключом ещё не было'));
  assert.ok(textOf(m).includes('Подключение создано'));
  assert.deepEqual(sent('api_journal_list'), [{ connection_id: 3, limit: 50 }]);
});

// CLINIC_API_STEP7_V1 (ревью №11) — окна экрана: имя для читалки, фокус внутрь и
// обратно, Escape с любого места, одна карточка на подключение.
test('окно: имя — заголовок (aria-labelledby), фокус — на первом поле, Escape закрывает, фокус возвращается туда, откуда открыли', () => {
  reset();
  const opener = mk('tr');
  opener.focus();
  const { m } = open();
  const dlg = byAttr(m, 'role', 'dialog')[0];
  const titleId = dlg.attrs['aria-labelledby'];
  assert.ok(titleId, 'у окна нет aria-labelledby');
  const h2 = byAttr(m, 'id', titleId)[0];
  assert.ok(h2 && h2.tagName === 'H2' && textOf(h2).includes('med24.uz'), 'aria-labelledby не ведёт на заголовок');
  assert.equal(document.activeElement, byAttr(m, 'id', 'apic-f-active')[0], 'фокус не перешёл в окно');
  const e = docKey('Escape');
  assert.ok(!modal('conn'), 'Escape не закрыл окно');
  assert.ok(e.prevented, 'Escape окна ушёл дальше');
  assert.equal(document.activeElement, opener, 'фокус не вернулся к строке');
  assert.equal((document._l.keydown || []).length, 0, 'слушатель Escape остался на document после закрытия');
});

test('та же карточка дважды (Enter дважды на строке) — одно окно, без двойных id', () => {
  reset();
  const first = openConnectionCard({ settings: settingsFixture(), connection: P, tab: 'main' });
  const second = openConnectionCard({ settings: settingsFixture(), connection: P, tab: 'main' });
  assert.equal(document.body.children.filter((n) => n.attrs && n.attrs['data-apic-modal'] === 'conn').length, 1, 'две карточки одного подключения');
  assert.equal(second, first, 'второе открытие вернуло не открытое окно');
  first.close();
  openConnectionCard({ settings: settingsFixture(), connection: P, tab: 'main' });
  assert.ok(modal('conn'), 'после закрытия карточка снова открывается');
});

// CLINIC_API_STEP7_V1 (ревью №1, решение владельца 5) — ключи видят только
// администраторы и открывают их снова: администратор с «API: Просмотр» (`can.reveal`
// без `can.admin`) видит маски и «Показать / Скопировать», но не выпускает новых
// ключей и секретов, не удаляет и ничего не правит.
const VIEW_ADMIN = { can: { view: true, edit: false, admin: false, reveal: true } };

test('администратор на «Просмотре»: ключ — маска, «Показать» спрашивает сервер; выпуска нового ключа, удаления и «Сохранить» нет', async () => {
  reset();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  const { m } = open(VIEW_ADMIN, P, 'key');
  const input = byAttr(m, 'aria-label', 'Ключ доступа')[0];
  assert.ok(input, 'ключа не видно администратору на «Просмотре»');
  assert.equal(input.value, 'em_live_••••a91c');
  const show = byAttr(m, 'data-apic-act', 'show')[0];
  assert.ok(show, 'нет «Показать»');
  assert.equal(show.dataset.viewOk, '1', '«Показать» перехватит рамка «только просмотр»');
  assert.equal(byAttr(m, 'data-apic-act', 'copy')[0].dataset.viewOk, '1', '«Скопировать» перехватит рамка «только просмотр»');
  show.click();
  await tick();
  assert.deepEqual(sent('api_connection_reveal'), [{ id: 3, what: 'key' }]);
  assert.equal(input.value, KEY_VALUE);
  assert.equal(byAttr(m, 'data-apic-act', 'rotate').length, 0, '«Выпустить новый ключ» у администратора без «Изменения»');
  assert.ok(textOf(m).includes('Новый ключ выпускает администратор с правом «Изменение».'));
  assert.ok(!buttonByText(m, /Удалить подключение/), 'удаление у администратора без «Изменения»');
  assert.ok(!buttonByText(m, /^Сохранить$/), '«Сохранить» у администратора без «Изменения»');
});

test('администратор на «Просмотре»: секрет — маска и «Показать», без «Новый секрет»; права и уведомления не правятся', async () => {
  reset();
  onRpc('api_connection_reveal', () => ({ value: 'em_whsec_TESTONLYtestonlyTESTONLYtest51d0' }));
  const { m } = open(VIEW_ADMIN, P, 'hooks');
  const input = byAttr(m, 'aria-label', 'Секрет для подписи уведомлений')[0];
  assert.ok(input && input.value === 'em_whsec_••••51d0', 'секрета не видно администратору на «Просмотре»');
  assert.equal(byAttr(m, 'data-apic-act', 'regen').length, 0, '«Новый секрет» у администратора без «Изменения»');
  assert.ok(textOf(m).includes('Новый секрет выпускает администратор с правом «Изменение».'));
  assert.ok('disabled' in byAttr(m, 'id', 'apic-f-hook')[0].attrs, 'адрес уведомлений правится');
  byAttr(m, 'data-apic-act', 'show')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_reveal'), [{ id: 3, what: 'secret' }]);
  tabBtn(m, 'access').click();
  assert.ok('disabled' in byAttr(m, 'id', 'apic-read-packages')[0].attrs, 'права правятся');
  tabBtn(m, 'main').click();
  assert.ok('disabled' in byAttr(m, 'id', 'apic-f-name')[0].attrs, 'название правится');
});

test('«Изменение» без администратора (can.reveal нет): ключ и секрет скрыты, «Показать» нет', () => {
  reset();
  const { m } = open({ can: { view: true, edit: true, admin: false, reveal: false } }, { ...P, key_mask: '', secret_mask: '' }, 'key');
  assert.ok(textOf(m).includes('Ключ видит и меняет только администратор.'));
  assert.equal(byAttr(m, 'data-apic-act', 'show').length, 0);
  tabBtn(m, 'hooks').click();
  assert.ok(textOf(m).includes('Секрет видит и меняет только администратор.'));
  assert.equal(byAttr(m, 'data-apic-act', 'show').length, 0);
});

// CLINIC_API_STEP7_V1 — решение владельца 11 по зданиям: включение отказано из-за
// филиала на сайте без адреса — сообщение сервера называет здание, кнопка ведёт в
// «Филиалы» (хаб настроек, раздел branches), а не в «Компанию».
const BRANCH_REFUSAL = { code: 'branch_address_required',
  message: 'Подключение нельзя включить: у здания «Чиланзар», которое показывается на сайте, не заполнен адрес для партнёров — город или область, район и улица на русском. Заполните его в «Филиалах» или снимите там «Показывать филиал на сайте и у партнёров».' };

test('включение: филиал на сайте без адреса — сообщение называет здание, «Открыть «Филиалы»» ведёт в раздел «Филиалы»', async () => {
  reset();
  onRpc('api_connection_update', () => ({ __error: BRANCH_REFUSAL, status: 409 }));
  const nav = [];
  openConnectionCard({ settings: settingsFixture(), connection: { ...P, active: false }, onNavigate: (v, p) => nav.push([v, p]), tab: 'main' });
  const m = modal('conn');
  const active = byAttr(m, 'id', 'apic-f-active')[0];
  active.checked = true; active.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.ok(textOf(m).includes('у здания «Чиланзар»'), 'сообщение не называет здание');
  assert.ok(!buttonByText(m, /Открыть «Компанию»/), 'кнопка ведёт в «Компанию», а адрес — в «Филиалах»');
  buttonByText(m, /Открыть «Филиалы»/).click();
  assert.deepEqual(nav, [['settings', { section: 'branches' }]]);
  assert.ok(!modal('conn'), 'карточка не закрылась при уходе');
});
