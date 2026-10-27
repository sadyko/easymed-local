// MOIZVONKI_V2 — правила «звонок → заявка» для «Моих Звонков» заводятся кодом
// (ensureMoizvonkiRouting), а не миграцией: см. шапку moizvonki-routing.js о
// том, почему файл 247_*.sql ломал migrations/077.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureMoizvonkiRouting } from './moizvonki-routing.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const rules = (db) => db.prepare("SELECT disposition, action, stage_key FROM crm_call_routing WHERE provider = 'moizvonki' ORDER BY disposition").all().map((r) => ({ ...r }));

test('заводит две строки: ANSWER в первую открытую колонку, NOANSWER в «Перезвонить»; повтор ничего не добавляет; строки Binotel не тронуты', () => {
  const db = fresh();
  const binotelBefore = db.prepare("SELECT COUNT(*) AS n FROM crm_call_routing WHERE provider = 'binotel'").get().n;
  assert.deepEqual(rules(db), [], 'свежая база — правил вендора нет');
  assert.equal(ensureMoizvonkiRouting(db), 2);
  const first = db.prepare("SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position, key LIMIT 1").get().key;
  assert.deepEqual(rules(db), [
    { disposition: 'ANSWER', action: 'create', stage_key: first },
    { disposition: 'NOANSWER', action: 'create', stage_key: 'recall' },
  ]);
  assert.equal(ensureMoizvonkiRouting(db), 0, 'второй вызов — ничего нового');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_call_routing WHERE provider = 'binotel'").get().n, binotelBefore);
});

test('правило, поправленное владельцем, не перезаписывается; без живой колонки «Перезвонить» пропущенный идёт в первую открытую', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_call_routing (provider, disposition, action, stage_key) VALUES ('moizvonki', 'ANSWER', 'ignore', NULL)").run();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'recall'").run();
  assert.equal(ensureMoizvonkiRouting(db), 1);
  const first = db.prepare("SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position, key LIMIT 1").get().key;
  assert.notEqual(first, 'recall');
  assert.deepEqual(rules(db), [
    { disposition: 'ANSWER', action: 'ignore', stage_key: null },
    { disposition: 'NOANSWER', action: 'create', stage_key: first },
  ]);
});

test('база без таблицы правил — ноль и предупреждение, не исключение', () => {
  const db = openDb(':memory:');
  const warn = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try { assert.equal(ensureMoizvonkiRouting(db), 0); }
  finally { console.warn = warn; }
  assert.ok(seen.some((s) => s.includes('moizvonki routing not seeded')));
});
