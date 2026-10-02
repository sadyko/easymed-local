// CABINET_FIX_V1_R1 (мигр. 236) — АВТОР У СТАРЫХ ШАБЛОНОВ.
//
// С CABINET_FIX_V1_TPL личный шаблон читает только автор (author_id) и
// администратор, правит — автор или администратор. У шаблонов, сохранённых
// до того, автора нет: редактор «Документов» его не писал вовсе («Только я»
// там тоже ставился), кабинет — до TPL_AUTHOR_LOCAL_V1. Такой личный шаблон
// стал виден одному администратору, а общий не мог поправить его же автор.
// Миграция берёт автора по author_name — только там, где имя ровно у ОДНОГО
// сотрудника; где совпадений нет или их несколько, автора не выдумывает.
// Только UPDATE, без перестройки таблицы; повторный накат ничего не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, fs.readdirSync(DIR).find((f) => /^236_.*\.sql$/.test(f))), 'utf8');

function dbBefore236() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig236-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 236)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('236: автор старого шаблона — по имени, только при единственном совпадении; повторный накат ничего не меняет', () => {
  const db = dbBefore236();
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role) VALUES
      (11, 'aziza', 'x', 'Каримова Азиза', 'doctor'),
      (12, 'ivan1', 'x', 'Иванов Иван', 'doctor'),
      (13, 'ivan2', 'x', 'Иванов Иван', 'doctor'),
      (14, 'bah', 'x', 'Юсупов Бахтиёр', 'doctor');
    INSERT INTO consultation_templates (id, name, doc_type, scope, body, author_id, author_name) VALUES
      (1, 'Личный из Документов', 'Приём (осмотр, консультация)', 'private', '{}', NULL, 'Каримова Азиза'),
      (2, 'Общий без автора',     '0',   'shared',  '{}', NULL, 'Каримова Азиза'),
      (3, 'Тёзки',                '0',   'private', '{}', NULL, 'Иванов Иван'),
      (4, 'Никто',                '0',   'private', '{}', NULL, 'Врач'),
      (5, 'Пустое имя',           '0',   'private', '{}', NULL, NULL),
      (6, 'Уже с автором',        '1.0', 'private', '{}', 14,   'Каримова Азиза');
  `);
  const authors = () => Object.fromEntries(db.prepare('SELECT id, author_id FROM consultation_templates ORDER BY id').all().map((r) => [r.id, r.author_id]));
  migrate(db);
  assert.deepEqual(authors(), { 1: 11, 2: 11, 3: null, 4: null, 5: null, 6: 14 },
    'автор поставлен не по правилу: только единственное совпадение имени и только там, где автора нет');
  // повторный накат того же текста — ничего не меняет (и не падает)
  const before = JSON.stringify(db.prepare('SELECT * FROM consultation_templates ORDER BY id').all());
  db.exec(SQL);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM consultation_templates ORDER BY id').all()), before);
  // таблица не перестраивалась: остальные колонки на месте
  assert.equal(db.prepare('SELECT doc_type FROM consultation_templates WHERE id = 6').get().doc_type, '1.0');
});

test('236: миграция — только UPDATE', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.match(code, /UPDATE\s+consultation_templates/i);
  assert.ok(!/\b(CREATE|DROP|ALTER|DELETE|INSERT)\b/i.test(code), 'миграция не только UPDATE');
});
