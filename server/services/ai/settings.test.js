import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { readAiSettings, setAiEnabled, setAiBlocked } from './settings.js';

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
