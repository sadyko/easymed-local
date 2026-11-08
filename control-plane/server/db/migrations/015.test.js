import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// AI_CHAT_V1 — 015_ai.sql: расход ИИ-помощника по клинике и месяцу (только
// числа, без текста переписки) и месячный лимит у клиники, 20 USD по умолчанию.

test('015 AI_CHAT_V1: расход ИИ по клинике и месяцу, лимит у клиники', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(clinics)').all().map((c) => c.name);
  assert.ok(cols.includes('ai_monthly_limit_usd'));
  db.prepare("INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES ('c1','A','s')").run();
  db.prepare("INSERT INTO ai_usage (clinic_id, month, requests, input_tokens, output_tokens, cost_micro_usd) VALUES ('c1','2026-11',1,10,5,100)").run();
  assert.throws(() => db.prepare("INSERT INTO ai_usage (clinic_id, month) VALUES ('c1','2026-11')").run(), /UNIQUE|PRIMARY/);
  assert.equal(db.prepare("SELECT ai_monthly_limit_usd l FROM clinics WHERE clinic_id='c1'").get().l, 20);
});

test('015 AI_CHAT_V1: в ai_usage нет ни одного текстового столбца, кроме ключей', () => {
  const db = openDb(':memory:');
  migrate(db);
  const text = db.prepare('PRAGMA table_info(ai_usage)').all()
    .filter((c) => /TEXT/i.test(c.type)).map((c) => c.name).sort();
  assert.deepEqual(text, ['clinic_id', 'month']);
});
