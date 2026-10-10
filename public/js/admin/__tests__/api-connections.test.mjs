// CLINIC_API_STEP7_V1 — страница «API и подключения»: адрес, подключения, журнал;
// права (`can` от сервера), филиал, честные строки о публичном сервере.
import { test } from 'node:test';
import assert from 'node:assert';
import { mk, reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, rpcNames, storeValues,
  settingsFixture, JOURNAL, KEY_VALUE, setClipboard, modal } from './api-harness.mjs';

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
  for (const s of ['API и подключения', 'Ещё не работает', 'Публичный сервер',
    'Ещё не включён', 'em_live_••••a91c', 'Все данные клиники', 'Запись на приём', 'med24.uz/hooks/easymed', 'событий: 3',
    'Не настроены', 'ещё не было', 'Включено', 'Выключено', 'создано автоматически', 'klinika-demo.uz',
    'Выпущен новый ключ', 'Настройки изменены: Название, Права', 'Изменено имя в адресе', 'Данные пациентов наружу не передаются']) {
    assert.ok(t.includes(s), 'нет на экране: ' + s);
  }
  assert.equal(byAttr(root, 'aria-label', 'Адрес API')[0].value, 'https://api.easymed.uz/klinika-demo/v1/');   // ревью №2 — адрес в поле
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

test('открыть по ссылке из CRM: payload.connection_id открывает карточку подключения', async () => {
  reset();
  await open({}, { payload: { connection_id: 3 } });
  const m = document.body.children.find((n) => n.attrs && n.attrs['data-apic-modal'] === 'conn');
  assert.ok(m && textOf(m).includes('med24.uz'));
});

// CLINIC_API_STEP7_V1 (ревью №2) — сеть клиники открывает Easy-Med по http: буфера
// обмена нет. Одно копирование ключа — одно открытие ключа (одна строка журнала):
// значение, уже полученное от сервера, уходит в карточку, а не теряется.
test('нет буфера: «Скопировать ключ» открывает карточку на «Ключе» с открытым и выделенным значением; «Скопировать» в карточке не спрашивает сервер второй раз', async () => {
  reset();
  setClipboard(false);
  const root = await open();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  byAttr(root, 'data-apic-act', 'copy-key')[1].click();
  await tick();
  const m = modal('conn');
  assert.ok(m, 'карточка не открылась');
  assert.equal(byAttr(m, 'data-apic-tab', 'key')[0].attrs['aria-selected'], 'true', 'карточка не на вкладке «Ключ»');
  const input = byAttr(m, 'aria-label', 'Ключ доступа')[0];
  assert.equal(input.value, KEY_VALUE, 'в карточке — маска вместо открытого ключа');
  assert.equal(input.selected, true, 'значение не выделено для Ctrl+C');
  assert.equal(document.activeElement, input, 'фокус не в поле ключа');
  byAttr(m, 'data-apic-act', 'copy')[0].click();
  await tick();
  assert.equal(rpcNames().filter((n) => n === 'api_connection_reveal').length, 1, 'одно копирование — два открытия ключа в журнале');
  assert.ok(!textOf(root).includes(KEY_VALUE), 'значение осталось на странице');
  assert.ok(!storeValues().some((v) => v.includes(KEY_VALUE)), 'значение в localStorage');
});

test('адрес API — в поле только для чтения: без буфера «Скопировать» выделяет его для Ctrl+C', async () => {
  reset();
  setClipboard(false);
  const root = await open();
  const input = byAttr(root, 'aria-label', 'Адрес API')[0];
  assert.ok(input && input.tagName === 'INPUT' && 'readonly' in input.attrs, 'адрес API не в поле');
  assert.equal(input.value, 'https://api.easymed.uz/klinika-demo/v1/');
  byAttr(root, 'data-apic-act', 'copy')[0].click();
  await tick();
  assert.equal(input.selected, true, 'адрес не выделен');
  assert.equal(document.activeElement, input, 'фокус не в поле адреса');
});

// CLINIC_API_STEP7_V1 (ревью №12) — Enter и пробел на значке «Скопировать ключ»
// всплывали к строке, и строка открывала карточку, отменив нажатие кнопки.
test('Enter и пробел на значке «Скопировать ключ» достаются кнопке, а не строке; Enter на самой строке открывает карточку', async () => {
  reset();
  const root = await open();
  const row = byAttr(root, 'data-apic-conn', '3')[0];
  const btn = byAttr(row, 'data-apic-act', 'copy-key')[0];
  for (const key of ['Enter', ' ']) {
    let prevented = false;
    row.dispatchEvent({ type: 'keydown', key, target: btn, currentTarget: row, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'строка отменила нажатие кнопки: ' + JSON.stringify(key));
  }
  assert.ok(!modal('conn'), 'карточка открылась с клавиатуры на значке копирования');
  row.dispatchEvent({ type: 'keydown', key: 'Enter', target: row, currentTarget: row, preventDefault() {} });
  assert.ok(modal('conn'), 'Enter на строке не открыл карточку');
});

// CLINIC_API_STEP7_V1 (ревью №3) — оболочка держит экран в кэше и второй раз его
// не рисует: переход с connection_id (ссылка «Подключение» из CRM-канбана)
// приходит через ctx.onPayload. Каждый такой переход открывает карточку — и
// когда то же подключение открывают второй раз.
test('экран из кэша оболочки: каждый переход с connection_id открывает карточку (свежие данные), и то же подключение — снова', async () => {
  reset();
  let hook = null;
  await open({}, { onPayload: (fn) => { hook = fn; } });
  assert.equal(typeof hook, 'function', 'экран не подписался на переходы оболочки');
  assert.ok(!modal('conn'), 'без connection_id карточка открылась сама');
  const before = rpcNames().filter((n) => n === 'api_settings_get').length;
  hook({ connection_id: 3 });
  await tick();
  assert.ok(rpcNames().filter((n) => n === 'api_settings_get').length > before, 'карточка открыта по устаревшему списку');
  let m = modal('conn');
  assert.ok(m && textOf(m).includes('med24.uz'), 'переход в кэшированный экран не открыл карточку');
  buttonByText(m, /^Отмена$/).click();
  assert.ok(!modal('conn'));
  hook({ connection_id: 3 });
  await tick();
  m = modal('conn');
  assert.ok(m && textOf(m).includes('med24.uz'), 'то же подключение второй раз не открылось');
  hook({ connection_id: 3 });
  await tick();
  assert.equal(document.body.children.filter((n) => n.attrs && n.attrs['data-apic-modal'] === 'conn').length, 1, 'вторая карточка поверх открытой');
  hook({ connection_id: 999 });
  await tick();
  hook(null);
  await tick();
});

// CLINIC_API_STEP7_V1 (ревью №10) — ширина телефона. Поддельный DOM раскладку не
// считает: проверено в Chrome на 360 и 320 px (страница без прокрутки вбок,
// вкладка «Журнал» в окне); здесь сторожатся правила, которые это дают — колонка
// сетки не шире родителя (minmax(0, 1fr)), шапка карточки переносит кнопку.
test('телефон: сетки экрана — minmax(0, 1fr), шапки карточек переносятся', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../../css/admin-views.css', import.meta.url), 'utf8');
  for (const sel of ['.apic-stack', '.apic-body', '.apic-sec']) {
    const rule = css.match(new RegExp('\\n' + sel.replace('.', '\\.') + ' \\{([^}]*)\\}'));
    assert.ok(rule && /grid-template-columns: minmax\(0, 1fr\)/.test(rule[1]), sel + ': колонка сетки шире родителя на телефоне');
  }
  assert.match(css, /\n\.apic-card \.card-header \{[^}]*flex-wrap: wrap/, 'шапка карточки не переносит «Добавить подключение»');
});

// CLINIC_API_STEP7_V1 (ревью №1, решение владельца 5) — администратор с «API:
// Просмотр» (`can.reveal`, без `can.admin`): на странице — маски и «Скопировать
// ключ», без «Добавить подключение» и «Изменить имя». Экран смонтирован, как в
// оболочке, в рамке «только просмотр»: копирование — не правка, рамка его не
// перехватывает.
test('администратор на «Просмотре», рамка «только просмотр»: маски и «Скопировать ключ» работают; создания и правки нет', async () => {
  reset();
  const perms = await import('../permissions.js');
  const { grantsFromLegacy, legacyFromGrants } = await import('../roles-matrix.js');
  const { renderWithViewOnly } = await import('../view-only.js');
  const legacy = { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } };
  const grants = { ...grantsFromLegacy(legacy), settings: 'view', 'settings.api': 'view' };
  perms.setEffectiveFromRole({ name: 'Администратор (просмотр API)', permissions: { ...legacyFromGrants(grants, legacy), grants } });
  try {
    onRpc('api_settings_get', () => settingsFixture({ can: { view: true, edit: false, admin: false, reveal: true } }));
    onRpc('api_journal_list', () => JOURNAL);
    onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
    const root = mk('div');
    await renderWithViewOnly(root, 'settings.api', (r) => renderApiConnections(r, {}));
    await tick();
    const host = root.children[0];
    assert.ok(String(host.className).includes('is-view-only'), 'стенд не тот: экран не в рамке «только просмотр»');
    const t = textOf(root);
    assert.ok(t.includes('em_live_••••a91c') && !t.includes('Скрыт'), 'маски ключей скрыты от администратора');
    assert.ok(!buttonByText(root, /Добавить подключение/) && !buttonByText(root, /Изменить имя/));
    const copy = byAttr(root, 'data-apic-act', 'copy-key')[1];
    assert.ok(copy, 'нет «Скопировать ключ»');
    let stopped = false;
    const ev = { type: 'click', target: copy, currentTarget: host, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (const fn of host._l.click || []) fn(ev);   // перехват рамки идёт первым (capture)
    assert.equal(stopped, false, 'рамка «только просмотр» проглотила «Скопировать ключ»');
    copy.click();
    await tick();
    assert.deepEqual(calls.find((c) => c[0] === 'api_connection_reveal')[1], { id: 3, what: 'key' });
    assert.deepEqual(clip, [KEY_VALUE]);
    const urlCopy = byAttr(root, 'data-apic-act', 'copy')[0];
    assert.equal(urlCopy.dataset.viewOk, '1', '«Скопировать» адрес API перехватит рамка');
  } finally { perms.setFullAccess('Admin'); }
});

test('«Изменение» без администратора (can.reveal нет): «Скрыт», без «Скопировать ключ»', async () => {
  reset();
  const root = await open({ can: { view: true, edit: true, admin: false, reveal: false },
    connections: settingsFixture().connections.map((c) => ({ ...c, key_mask: '', secret_mask: '' })) });
  assert.ok(textOf(root).includes('Скрыт'));
  assert.equal(byAttr(root, 'data-apic-act', 'copy-key').length, 0);
});

// CLINIC_API_STEP7_V1 (ревью слияния №2, №5) — «Адрес для партнёров не заполнен» на
// странице: «Открыть «Компанию»» — только тому, кто правит «Компанию» (иначе строка,
// кто заполняет адрес); в рамке «только просмотр» кнопку-переход рамка не глотает.
async function pageInFrame(extra) {
  const perms = await import('../permissions.js');
  const { grantsFromLegacy, legacyFromGrants } = await import('../roles-matrix.js');
  const { renderWithViewOnly } = await import('../view-only.js');
  const legacy = { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } };
  const grants = { ...grantsFromLegacy(legacy), settings: 'view', 'settings.api': 'view', ...extra };
  perms.setEffectiveFromRole({ name: 'Регистратор', permissions: { ...legacyFromGrants(grants, legacy), grants } });
  onRpc('api_settings_get', () => settingsFixture({ partner_address_missing: ['region_code'], can: { view: true, edit: false, admin: false, reveal: false } }));
  onRpc('api_journal_list', () => JOURNAL);
  const root = mk('div');
  const nav = [];
  await renderWithViewOnly(root, 'settings.api', (r) => renderApiConnections(r, { onNavigate: (v, p) => nav.push([v, p]) }));
  await tick();
  return { perms, root, nav, host: root.children[0] };
}

test('рамка «только просмотр», «Компания: Изменение»: «Открыть «Компанию»» ведёт в «Компанию», рамка её не глотает', async () => {
  reset();
  const { perms, root, nav, host } = await pageInFrame({ 'settings.company': 'edit' });
  try {
    assert.ok(String(host.className).includes('is-view-only'), 'стенд не тот: экран не в рамке');
    const go = byAttr(root, 'data-apic-act', 'open-company')[0];
    assert.ok(go, 'нет «Открыть «Компанию»»');
    let stopped = false;
    const ev = { type: 'click', target: go, currentTarget: host, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (const fn of host._l.click || []) fn(ev);   // перехват рамки идёт первым (capture)
    assert.equal(stopped, false, 'рамка «только просмотр» проглотила переход');
    go.click();
    assert.deepEqual(nav, [['documents-settings', undefined]]);
  } finally { perms.setFullAccess('Admin'); }
});

test('«Компания: Просмотр»: кнопки нет — строка, кто заполняет адрес', async () => {
  reset();
  const { perms, root } = await pageInFrame({ 'settings.company': 'view' });
  try {
    assert.equal(byAttr(root, 'data-apic-act', 'open-company').length, 0, 'кнопка ведёт туда, где адрес не правится');
    assert.ok(textOf(root).includes('Адрес для партнёров заполняет администратор или тот, кому выдано изменение «Компании».'));
  } finally { perms.setFullAccess('Admin'); }
});
