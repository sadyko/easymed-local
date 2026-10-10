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
