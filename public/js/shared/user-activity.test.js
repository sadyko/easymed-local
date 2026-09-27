// V3120_FINAL (I5) — фоновые запросы помечаются, запросы человека — нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withActivityHeaders, noteUserInput, isBackgroundNow, BACKGROUND_HEADER, ACTIVE_WINDOW_MS } from './user-activity.js';

test('сразу после действия человека запрос не фоновый', () => {
  const t = 1_000_000_000;
  noteUserInput(t);
  assert.equal(isBackgroundNow(t + 500), false);
  assert.deepEqual(withActivityHeaders({ 'Content-Type': 'application/json' }, t + 500), { 'Content-Type': 'application/json' });
});

test('без действий дольше окна — запрос фоновый, заголовок x-em-background: 1', () => {
  const t = 2_000_000_000;
  noteUserInput(t);
  const h = withActivityHeaders({ 'Content-Type': 'application/json' }, t + ACTIVE_WINDOW_MS + 1);
  assert.equal(h[BACKGROUND_HEADER], '1');
  assert.equal(h['Content-Type'], 'application/json', 'прежние заголовки сохраняются');
  assert.equal(BACKGROUND_HEADER, 'x-em-background');
});

test('клиент данных и RPC шлют заголовок через общий помощник', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../supabase.js', import.meta.url), 'utf8');
  assert.match(src, /withActivityHeaders/);
  assert.ok((src.match(/withActivityHeaders\(/g) || []).length >= 3, 'db/auth-мост, rpc и хранилище');
});
