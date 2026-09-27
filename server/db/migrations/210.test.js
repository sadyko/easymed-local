// V3120_PERF (мигр. 210) — только индексы: ни одна строка не меняется, в
// журнал обмена филиалов не попадает ничего, и каждый заявленный индекс есть.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const FILE = '210_v3120_perf_indexes.sql';
const SQL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), FILE), 'utf8');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const names = [...code.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

test('210: в файле только CREATE INDEX IF NOT EXISTS', () => {
  const stmts = code.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, names.length);
  assert.equal(names.length, 19);
  for (const s of stmts) assert.match(s, /^CREATE INDEX IF NOT EXISTS \w+\s+ON \w+\(/, s);
});

test('210: все индексы на месте, повторный прогон не пишет в sync_journal', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
    for (const n of names) assert.ok(have.has(n), 'нет индекса ' + n);

    db.prepare("INSERT INTO patients (full_name) VALUES ('Тест')").run();
    for (const n of names) db.exec(`DROP INDEX ${n}`);
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(FILE);
    const before = db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c;
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c, before);
    const again = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
    for (const n of names) assert.ok(again.has(n), 'нет индекса после повтора ' + n);
  } finally { db.close(); }
});
