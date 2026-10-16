// PUBLIC_LICENCE_V1 — ревью 8c: строка «Публичный сервер» экрана «API и
// подключения» на узбекском — код ключа обмена («Almashinuv kaliti kodi:
// 46de-4fe9») и подсказка латиницей, ни одной кириллической буквы на странице;
// код тот же, что на русском и английском (его читают вслух сотруднику Easy-Med).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, walk, onRpc, reset, tick, settingsFixture } from './api-harness.mjs';

localStorage.setItem('admin.lang', 'uz');   // после стенда (он ставит 'ru'), до видов: язык выбирается при загрузке i18n.js
const { getLang } = await import('../i18n.js');
const { renderApiConnections } = await import('../views/api-connections.js');

const CYR = /[А-Яа-яЁё]/;
function leaks(root, out) {
  for (const n of walk(root)) {
    if (n.tagName === 'SVG') continue;
    if (typeof n._t === 'string' && CYR.test(n._t)) out.push('text: ' + n._t.trim());
    for (const a of ['title', 'aria-label', 'placeholder']) if (n.attrs && CYR.test(n.attrs[a] || '')) out.push(a + ': ' + n.attrs[a]);
  }
}
function fixture() {
  const fx = settingsFixture({ clinic_name: 'Clinic Demo', partner_address_missing: [] });
  for (const c of fx.connections) { c.created_by_name = 'Boss'; c.key_issued_by_name = 'Boss'; c.contact = c.contact ? 'Partner desk' : ''; }
  return fx;
}

test('uz: «Almashinuv kaliti kodi: 46de-4fe9» va maslahat — «waiting», «ok», «error»; строка «Публичный сервер» без кириллицы', async () => {
  assert.equal(getLang(), 'uz');
  const fx = fixture();
  for (const sync of [
    { state: 'waiting_vendor', reason: 'not_enabled', last_ok_at: null, pending_events: 0, waiting_requests: 0, key_code: '46de-4fe9' },
    { state: 'ok', reason: '', last_ok_at: '2030-03-11T04:00:00Z', last_error: '', waiting_requests: 1, pending_events: 0, key_code: '46de-4fe9' },
    { state: 'error', reason: 'offline', last_ok_at: '2030-03-11T04:00:00Z', last_error: 'offline', last_error_at: '2030-03-11T05:00:00Z', key_code: '46de-4fe9' },
  ]) {
    reset();
    onRpc('api_settings_get', () => fx);
    onRpc('api_journal_list', () => []);
    onRpc('api_sync_status', () => sync);
    const root = mk('div');
    await renderApiConnections(root, {});
    await tick();
    const line = walk(root).find((n) => n.attrs && n.attrs['data-apic-sync']);
    const out = [];
    leaks(line, out);
    assert.deepEqual(out, [], sync.state + ': кириллица в строке «Публичный сервер» на узбекском экране:\n' + out.join('\n'));
    const el = walk(line).find((n) => n.attrs && n.attrs['data-apic-keycode']);
    const text = walk(el).map((n) => n._t || '').join('');
    assert.ok(text.includes('Almashinuv kaliti kodi: 46de-4fe9'), text);
    assert.ok(text.includes('Agar kompyuterni almashtirgan bo‘lsangiz, Easy-Med shu kodni so‘raydi.'), text);
  }
});
