import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { aiSettingsGet, aiSettingsSave, aiFlags } from './ai.js';
import { flagChat } from '../ai/guards.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const hasAi = () => true;

test('администратор включает и выключает; регистратура без строки — отказ', () => {
  const db = fresh();
  assert.equal(aiSettingsSave(db, { enabled: true }, ADMIN, { hasModule: hasAi }).enabled, true);
  assert.throws(() => aiSettingsSave(db, { enabled: false }, REG, { hasModule: hasAi }), (e) => e.status === 403);
  assert.throws(() => aiSettingsGet(db, {}, REG), (e) => e.status === 403);
});

test('нет модуля — включить нельзя', () => {
  const db = fresh();
  assert.throws(() => aiSettingsSave(db, { enabled: true }, ADMIN, { hasModule: () => false }), (e) => e.status === 402);
});

test('выключение снимает очередь; aiFlags отдаёт отмеченные чаты', () => {
  const db = fresh();
  aiSettingsSave(db, { enabled: true }, ADMIN, { hasModule: hasAi });
  db.prepare("INSERT INTO ai_chat_jobs (channel, chat_key, source_id, next_at) VALUES ('telegram','1','a','2026-01-01T00:00:00Z')").run();
  aiSettingsSave(db, { enabled: false }, ADMIN, { hasModule: hasAi });
  assert.equal(db.prepare('SELECT status FROM ai_chat_jobs').get().status, 'dropped');
  flagChat(db, 'telegram', '1', 'medical');
  assert.deepEqual(aiFlags(db, {}, ADMIN).map((f) => f.chat_key), ['1']);
});

test('A8: ai_settings_get и save отдают facts с числом услуг и врачей', () => {
  const db = fresh();
  const g = aiSettingsGet(db, {}, ADMIN, { hasModule: hasAi });
  assert.equal(typeof g.facts.services, 'number');
  assert.equal(typeof g.facts.doctors, 'number');
  const s = aiSettingsSave(db, { enabled: true }, ADMIN, { hasModule: hasAi });
  assert.deepEqual(Object.keys(s.facts).sort(), ['doctors', 'services']);
});
