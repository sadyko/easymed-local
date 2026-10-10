// CLINIC_API_STEP7_V1 (ревью №5) — экран «API и подключения» на английском: ни одной
// кириллической буквы на странице, в окнах «Новое подключение», «Что передать» и в
// каждой вкладке карточки. Системные имена подключения сайта клиники — «Сайт
// клиники» и источник «Сайт» — хранятся по-русски и обязаны переводиться и внутри
// фраз («New key for “…”», «with the source “…”»). Данные клиники — латиницей.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, walk, onRpc, reset, tick, settingsFixture, KEY_VALUE, SECRET_VALUE } from './api-harness.mjs';

localStorage.setItem('admin.lang', 'en');   // после стенда (он ставит 'ru'), до видов: язык выбирается при загрузке i18n.js
const { getLang } = await import('../i18n.js');
const { renderApiConnections } = await import('../views/api-connections.js');
const { openNewConnection, openHandover } = await import('../views/api-connection-new.js');
const { openConnectionCard } = await import('../views/api-connection-card.js');

const CYR = /[А-Яа-яЁё]/;
function leaks(root, where, out) {
  for (const n of walk(root)) {
    if (n.tagName === 'SVG') continue;
    if (typeof n._t === 'string' && CYR.test(n._t)) out.push(where + ' text: ' + n._t.trim());
    for (const a of ['title', 'aria-label', 'placeholder']) if (n.attrs && CYR.test(n.attrs[a] || '')) out.push(where + ' ' + a + ': ' + n.attrs[a]);
  }
}
function fixture() {
  const fx = settingsFixture({ clinic_name: 'Clinic Demo', partner_address_missing: ['street_ru'] });
  for (const c of fx.connections) { c.created_by_name = 'Boss'; c.key_issued_by_name = 'Boss'; c.contact = c.contact ? 'Partner desk' : ''; }
  return fx;   // подключение сайта клиники — «Сайт клиники», источник «Сайт», как их создаёт сервер
}

test('en: страница, окна и вкладки карточки — без кириллицы, «Сайт клиники» и «Сайт» переведены', async () => {
  assert.equal(getLang(), 'en');
  reset();
  const fx = fixture();
  onRpc('api_settings_get', () => fx);
  onRpc('api_journal_list', () => [{ id: 1, at: '2026-10-10T09:00:00Z', connection_id: 1, connection_name: 'Сайт клиники', user_name: 'Boss', action: 'created', detail: {} }]);
  onRpc('api_connection_draft', () => ({ draft_id: 'd1', key: KEY_VALUE, secret: SECRET_VALUE }));
  const out = [];
  const root = mk('div');
  await renderApiConnections(root, {});
  await tick();
  leaks(root, 'page', out);
  await openNewConnection({ settings: fx });
  for (const m of document.body.children) leaks(m, 'new', out);
  document.body.children.length = 0;
  const site = fx.connections[0];
  openHandover({ settings: fx, connection: site, key: KEY_VALUE, baseUrl: fx.base_url, rotated: true });
  openHandover({ settings: fx, connection: site, key: KEY_VALUE, baseUrl: fx.base_url });
  for (const m of document.body.children) leaks(m, 'handover', out);
  document.body.children.length = 0;
  for (const tab of ['main', 'access', 'hooks', 'key', 'log']) {
    openConnectionCard({ settings: fx, connection: site, tab });
    await tick();
    for (const m of document.body.children) leaks(m, 'card:' + tab, out);
    document.body.children.length = 0;
  }
  assert.deepEqual(out, [], 'кириллица на английском экране:\n' + out.join('\n'));
});

// CLINIC_API_STEP7_V1 — решение владельца 11 по зданиям: отказ включения из-за
// филиала на сайте на английском — фраза сервера переведена по шаблону (имя здания
// — значение), кнопка «Открыть «Филиалы»» — тоже; ни одной кириллической буквы.
test('en: отказ «филиал на сайте без адреса» — переведённая фраза с именем здания и «Open “Branches”»', async () => {
  reset();
  const fx = fixture();
  const template = 'Подключение нельзя включить: у здания «{name}», которое показывается на сайте, не заполнен адрес для партнёров — город или область, район и улица на русском. Заполните его в «Филиалах» или снимите там «Показывать филиал на сайте и у партнёров».';
  onRpc('api_connection_update', () => ({ status: 409, __error: { code: 'branch_address_required',
    message: template.replace('{name}', 'Chilanzar'), template, params: { name: 'Chilanzar' } } }));
  const conn = { ...fx.connections[1], active: false };
  openConnectionCard({ settings: fx, connection: conn, tab: 'main', onNavigate: () => {} });
  const m = document.body.children.find((n) => n.attrs && n.attrs['data-apic-modal'] === 'conn');
  const active = walk(m).find((n) => n.attrs && n.attrs.id === 'apic-f-active');
  active.checked = true; active.dispatchEvent({ type: 'change' });
  walk(m).find((n) => n.tagName === 'BUTTON' && n.attrs['data-apic-act'] === 'save').click();
  await tick();
  const out = [];
  leaks(m, 'card', out);
  assert.deepEqual(out, [], 'кириллица в отказе на английском экране:\n' + out.join('\n'));
  const text = walk(m).map((n) => n._t || '').join('');
  assert.ok(text.includes('the building “Chilanzar”'), 'фраза сервера не переведена: ' + text.slice(0, 300));
  assert.ok(text.includes('Open “Branches”'));
  document.body.children.length = 0;
});
