import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { readAiSettings, setAiEnabled, setAiBlocked, clearNoModuleBlock } from './settings.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('включение ставит enabled_at, выключение его не трогает', () => {
  const db = fresh();
  assert.deepEqual(readAiSettings(db), { enabled: false, enabled_at: null, blocked: '' });
  setAiEnabled(db, true, 7, '2026-11-08T10:00:00Z');
  assert.deepEqual(readAiSettings(db), { enabled: true, enabled_at: '2026-11-08T10:00:00Z', blocked: '' });
  setAiEnabled(db, false, 7, '2026-11-08T11:00:00Z');
  assert.equal(readAiSettings(db).enabled, false);
  setAiEnabled(db, true, 7, '2026-11-08T12:00:00Z');
  assert.equal(readAiSettings(db).enabled_at, '2026-11-08T12:00:00Z', 'новое включение — новая точка отсчёта');
});

test('blocked: лимит и модуль; пустая строка снимает', () => {
  const db = fresh();
  setAiBlocked(db, 'limit', '2026-11-08T10:00:00Z');
  assert.equal(readAiSettings(db).blocked, 'limit');
  setAiBlocked(db, '', '2026-11-08T10:05:00Z');
  assert.equal(readAiSettings(db).blocked, '');
  assert.throws(() => setAiBlocked(db, 'whatever'), /blocked/);
});

test('повторное включение при включённом ИИ не сдвигает enabled_at', () => {
  const db = fresh();
  setAiEnabled(db, true, 7, '2026-11-08T10:00:00Z');
  setAiEnabled(db, true, 7, '2026-11-08T10:30:00Z');
  assert.equal(readAiSettings(db).enabled_at, '2026-11-08T10:00:00Z');
});

// AI_CHAT_V1 — «ИИ остановлен» не должен держаться вечно: лимит — месячный,
// модуль могут подключить снова.
test('лимит прошлого месяца (UTC) снимается сам при чтении и в базе', () => {
  const db = fresh();
  setAiBlocked(db, 'limit', '2026-10-31T23:59:00Z');
  assert.equal(readAiSettings(db, Date.parse('2026-10-31T23:59:30Z')).blocked, 'limit', 'тот же месяц — стоит');
  assert.equal(readAiSettings(db, Date.parse('2026-11-01T00:00:10Z')).blocked, '', 'новый месяц — снят');
  const row = db.prepare('SELECT blocked, blocked_at FROM ai_settings WHERE id = 1').get();
  assert.deepEqual({ ...row }, { blocked: '', blocked_at: null });
});

test('лимит того же месяца и no_module сами по месяцу не снимаются', () => {
  const db = fresh();
  setAiBlocked(db, 'limit', '2026-11-02T08:00:00Z');
  assert.equal(readAiSettings(db, Date.parse('2026-11-30T23:00:00Z')).blocked, 'limit');
  setAiBlocked(db, 'no_module', '2026-09-02T08:00:00Z');
  assert.equal(readAiSettings(db, Date.parse('2026-11-30T23:00:00Z')).blocked, 'no_module');
});

test('no_module снимается, когда модуль ai снова в лицензии; лимит — нет', () => {
  const db = fresh();
  setAiBlocked(db, 'no_module', '2026-11-08T10:00:00Z');
  assert.equal(clearNoModuleBlock(db, () => false), false);
  assert.equal(readAiSettings(db).blocked, 'no_module');
  assert.equal(clearNoModuleBlock(db, () => true), true);
  assert.equal(readAiSettings(db).blocked, '');
  setAiBlocked(db, 'limit', new Date().toISOString());
  let asked = 0;
  assert.equal(clearNoModuleBlock(db, () => { asked++; return true; }), false);
  assert.equal(readAiSettings(db).blocked, 'limit');
  assert.equal(asked, 0, 'лицензию проверяем только при no_module');
});
