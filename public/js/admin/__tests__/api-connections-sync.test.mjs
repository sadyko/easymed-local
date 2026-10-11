// PUBLIC_API_V1 — «API и подключения»: строка «Публичный сервер» говорит, что с
// обменом — ещё не включён, ждём Easy-Med, работает (когда последний обмен и
// сколько заявок ждут клинику), нет обмена (с какого времени и почему);
// сервер старше экрана — прежняя строка.
import { test } from 'node:test';
import assert from 'node:assert';
import { mk, reset, onRpc, textOf, byAttr, tick, settingsFixture, JOURNAL } from './api-harness.mjs';

const { renderApiConnections } = await import('../views/api-connections.js');

async function open(sync) {
  reset();
  onRpc('api_settings_get', () => settingsFixture());
  onRpc('api_journal_list', () => JOURNAL);
  if (sync !== undefined) onRpc('api_sync_status', () => sync);
  const root = mk('div');
  await renderApiConnections(root, {});
  await tick();
  return root;
}
const line = (root) => byAttr(root, 'data-apic-sync')[0];

test('сервер старше экрана (нет ответа) — прежняя строка «Ещё не включён» и «Ещё не работает»', async () => {
  const root = await open(undefined);
  assert.equal(line(root).attrs['data-apic-sync'], 'off');
  assert.ok(textOf(root).includes('Ещё не включён') && textOf(root).includes('Ещё не работает'));
});

test('ждём Easy-Med; работает — время обмена и ждущие заявки; нет обмена — с какого времени и почему', async () => {
  let root = await open({ state: 'waiting_vendor', reason: 'not_enabled', last_ok_at: null, pending_events: 0, waiting_requests: 0 });
  assert.ok(textOf(line(root)).includes('Подключения заработают, когда Easy-Med включит для клиники публичный сервер.'));
  root = await open({ state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', last_error: '', waiting_requests: 2, pending_events: 0 });
  assert.match(textOf(line(root)), /Работает\. Последний обмен — .+\. Ждут ответа клиники: 2\./);
  assert.ok(textOf(root).includes('Работает'));
  root = await open({ state: 'error', last_ok_at: '2030-03-11T04:00:00Z', last_error: 'offline', last_error_at: '2030-03-11T05:00:00Z', waiting_requests: 0, pending_events: 1 });
  assert.match(textOf(line(root)), /Нет обмена с .+: нет связи с интернетом\. Заявки партнёров ждут на публичном сервере/);
  assert.ok(textOf(root).includes('Нет связи'));
  root = await open({ state: 'error', last_error: 'paused', last_error_at: '2030-03-11T05:00:00Z' });
  assert.ok(textOf(line(root)).includes('лицензия Easy-Med не продлена'));
});
