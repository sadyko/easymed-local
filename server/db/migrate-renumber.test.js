// MIGRATION_RENUMBER_V1 (2026-11-23) — миграции ветки local/ai-on-main (ИИ-помощник,
// свой ключ, разбор звонков, шаблон бота врачей) применялись на машине разработки под
// номерами 284/287, 291, 292, 293; при слиянии с main они стали 294–297. База, которая
// уже применила их под старыми именами, не должна применять их второй раз (падение
// «table ai_settings already exists» при старте) — отметки перештамповываются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate, pendingMigrations, RENAMED_MIGRATIONS } from './migrate.js';

const names = (db) => new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));

test('база с ветки партнёра (старые имена) стартует: отметки перештампованы, файлы не применяются заново', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Как на машине партнёра: те же таблицы, но отметки под старыми номерами.
  const back = db.prepare('UPDATE schema_migrations SET name = ? WHERE name = ?');
  back.run('287_ai_chat.sql', '294_ai_chat.sql');
  back.run('291_ai_own_key_features.sql', '295_ai_own_key_features.sql');
  back.run('292_ai_call_analysis.sql', '296_ai_call_analysis.sql');
  back.run('293_doctor_bot_message_template.sql', '297_doctor_bot_message_template.sql');
  assert.deepEqual(pendingMigrations(db), [], 'применённые под старым именем посчитаны новыми — лишняя копия базы и повтор');
  assert.doesNotThrow(() => migrate(db), 'перенумерованная миграция применилась второй раз');
  const n = names(db);
  for (const [oldName, newName] of Object.entries(RENAMED_MIGRATIONS)) {
    assert.ok(!n.has(oldName), 'старая отметка осталась: ' + oldName);
    assert.ok(n.has(newName), 'нет новой отметки: ' + newName);
  }
  db.close();
});

test('и 284_ai_chat, и 287_ai_chat на одной машине — одна отметка 294', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE schema_migrations SET name = '287_ai_chat.sql' WHERE name = '294_ai_chat.sql'").run();
  db.prepare("INSERT INTO schema_migrations (name) VALUES ('284_ai_chat.sql')").run();
  assert.doesNotThrow(() => migrate(db));
  const rows = db.prepare("SELECT name FROM schema_migrations WHERE name LIKE '%_ai_chat.sql'").all().map((r) => r.name);
  assert.deepEqual(rows, ['294_ai_chat.sql']);
  db.close();
});

test('чистая база — карта ничего не трогает', () => {
  const db = openDb(':memory:');
  migrate(db);
  const before = [...names(db)].sort();
  migrate(db);
  assert.deepEqual([...names(db)].sort(), before);
  db.close();
});
