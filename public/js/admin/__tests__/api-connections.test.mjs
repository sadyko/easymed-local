// CLINIC_API_STEP7_V1 — страница «API и подключения»: адрес, подключения, журнал;
// права (`can` от сервера), филиал, честные строки о публичном сервере.
import { test } from 'node:test';
import assert from 'node:assert';
import { mk, reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, rpcNames, storeValues,
  settingsFixture, JOURNAL, KEY_VALUE } from './api-harness.mjs';

const { renderApiConnections } = await import('../views/api-connections.js');

async function open(over = {}, ctx = {}) {
  onRpc('api_settings_get', () => settingsFixture(over));
  onRpc('api_journal_list', () => JOURNAL);
  const root = mk('div');
  await renderApiConnections(root, ctx);
  await tick();
  return root;
}

test('администратор: адрес и «Ещё не работает», публичный сервер — прямо; подключения: маска, права, источник, уведомления, «ещё не было», статус; журнал', async () => {
  reset();
  const root = await open();
  const t = textOf(root);
  for (const s of ['API и подключения', 'https://api.easymed.uz/klinika-demo/v1/', 'Ещё не работает', 'Публичный сервер',
    'Ещё не включён', 'em_live_••••a91c', 'Все данные клиники', 'Запись на приём', 'med24.uz/hooks/easymed', 'событий: 3',
    'Не настроены', 'ещё не было', 'Включено', 'Выключено', 'создано автоматически', 'klinika-demo.uz',
    'Выпущен новый ключ', 'Настройки изменены: Название, Права', 'Изменено имя в адресе', 'Данные пациентов наружу не передаются']) {
    assert.ok(t.includes(s), 'нет на экране: ' + s);
  }
  assert.ok(buttonByText(root, /Добавить подключение/));
  assert.ok(!/\b(No|Add|Edit|yet)\b/.test(t), 'английский шаблон на русском экране');
});

test('имени в адресе нет: поле с предложением; неверное — объяснение без запроса; верное — api_slug_save; «Добавить подключение» выключена', async () => {
  reset();
  const root = await open({ slug: '', base_url: '', slug_suggestion: 'klinika-demo', connections: [] });
  const input = byAttr(root, 'id', 'apic-slug')[0];
  assert.equal(input.value, 'klinika-demo');
  assert.ok('disabled' in buttonByText(root, /Добавить подключение/).attrs);
  input.value = '-плохо';
  buttonByText(root, /^Сохранить$/).click();
  await tick();
  assert.ok(!rpcNames().includes('api_slug_save'));
  assert.ok(textOf(root).includes('Только латинские буквы, цифры и дефис'));
  onRpc('api_slug_save', (b) => ({ slug: b.slug, base_url: 'https://api.easymed.uz/' + b.slug + '/v1/', site_created: true }));
  input.value = ' Shifo ';
  buttonByText(root, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'api_slug_save')[1], { slug: 'shifo' });
});

test('«Просмотр»: без «Добавить подключение», ключ «Скрыт», без копирования; имя в адресе не правится', async () => {
  reset();
  const root = await open({ can: { view: true, edit: false, admin: false },
    connections: settingsFixture().connections.map((c) => ({ ...c, key_mask: '', secret_mask: '' })) });
  const t = textOf(root);
  assert.ok(!buttonByText(root, /Добавить подключение/));
  assert.ok(!buttonByText(root, /Изменить имя/));
  assert.ok(t.includes('Скрыт'));
  assert.equal(byAttr(root, 'data-apic-act', 'copy-key').length, 0);
  assert.ok(t.includes('Новое подключение создаёт администратор'));
});

test('филиал: только строка «в главном здании»', async () => {
  reset();
  const root = await open({ building_role: 'secondary', connections: [] });
  assert.ok(textOf(root).includes('Подключения API настраиваются в главном здании клиники.'));
  assert.ok(!buttonByText(root, /Добавить подключение/));
});

test('скопировать ключ из таблицы: api_connection_reveal и буфер; значения нет ни на странице, ни в localStorage', async () => {
  reset();
  const root = await open();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  byAttr(root, 'data-apic-act', 'copy-key')[1].click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'api_connection_reveal')[1], { id: 3, what: 'key' });
  assert.deepEqual(clip, [KEY_VALUE]);
  assert.ok(!textOf(root).includes(KEY_VALUE), 'значение осталось на странице');
  assert.ok(!storeValues().some((v) => v.includes(KEY_VALUE)), 'значение в localStorage');
});

test('адрес для партнёров не заполнен: предупреждение и «Открыть «Компанию»»', async () => {
  reset();
  const nav = [];
  const root = await open({ partner_address_missing: ['region_code', 'street_ru'] }, { onNavigate: (v) => nav.push(v) });
  assert.ok(textOf(root).includes('Адрес для партнёров в «Компании» не заполнен'));
  buttonByText(root, /Открыть «Компанию»/).click();
  assert.deepEqual(nav, ['documents-settings']);
});

test('срок ключа: «Ключ истекает …» за 14 дней и «Ключ истёк»', async () => {
  reset();
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const base = settingsFixture();
  const root = await open({ connections: [{ ...base.connections[1], key_expires_at: soon }, { ...base.connections[1], id: 5, key_expires_at: past }] });
  assert.ok(textOf(root).includes('Ключ истекает'));
  assert.ok(textOf(root).includes('Ключ истёк'));
});

test('сервер старше экрана (data: null): пустой, но целый экран', async () => {
  reset();
  onRpc('api_settings_get', () => null);
  onRpc('api_journal_list', () => null);
  const root = mk('div');
  await renderApiConnections(root, {});
  await tick();
  assert.ok(textOf(root).includes('API и подключения'));
});

test('открыть по ссылке из CRM: страница с payload грузится (карточка — задача 12)', async () => {
  reset();
  await open({}, { payload: { connection_id: 3 } });
  assert.ok(rpcNames().includes('api_settings_get'));
});
