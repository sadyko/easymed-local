// LIS_REAL_ANALYZERS_V1 (мигр. 233) — настоящие анализаторы клиники: Easy-Med
// подключается к прибору сам (lab_devices.dial), как прибор назвал себя в
// MSH-4 (lab_devices.sending_facility), вид сообщения — проба, контроль,
// калибровка или запрос (lab_device_messages.kind).
//
// Только ADD COLUMN: пересборка таблицы, на которую ссылаются, внутри migrate()
// роняет клинику при запуске (урок v1.1.0), а в lab_device_messages лежат
// мегабайты сырых проб. CHECK миграции 123 на transport и status не трогаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';
import { TABLES } from '../../services/branch-sync/catalogue.js';
import { REGISTRY } from '../schema-registry.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = '233_lis_real_analyzers.sql';
const SQL = fs.readFileSync(path.join(DIR, FILE), 'utf8');

const col = (db, t, n) => db.prepare(`PRAGMA table_info("${t}")`).all().find((c) => c.name === n);

function dbBefore233() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig233-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 233)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('233: lab_devices.dial — 0/1, по умолчанию 0; sending_facility — TEXT, по умолчанию NULL', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const dial = col(db, 'lab_devices', 'dial');
    assert.ok(dial, 'колонка dial есть');
    assert.equal(dial.notnull, 1);
    assert.equal(dial.dflt_value, '0', 'прибор звонит сам — так у всех, кого заводили до этой миграции');
    const fac = col(db, 'lab_devices', 'sending_facility');
    assert.ok(fac, 'колонка sending_facility есть');
    assert.equal(fac.type, 'TEXT');
    const id = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Руками', 'mindray-bc-5300')").run().lastInsertRowid;
    assert.deepEqual({ ...db.prepare('SELECT dial, sending_facility FROM lab_devices WHERE id = ?').get(id) }, { dial: 0, sending_facility: null });
    db.prepare("INSERT INTO lab_devices (name, profile, dial) VALUES ('Звоним сами', 'mindray-bc-5300', 1)").run();
    assert.throws(() => db.prepare("INSERT INTO lab_devices (name, profile, dial) VALUES ('Мусор', '', 2)").run(), /CHECK/);
  } finally { db.close(); }
});

test('233: lab_device_messages.kind — result/qc/calibration/query, по умолчанию result', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const kind = col(db, 'lab_device_messages', 'kind');
    assert.ok(kind, 'колонка kind есть');
    assert.equal(kind.notnull, 1);
    assert.equal(kind.dflt_value, "'result'");
    const ins = db.prepare("INSERT INTO lab_device_messages (peer, raw, status, kind) VALUES ('10.0.0.9', 'MSH|', 'unmatched', ?)");
    for (const k of ['result', 'qc', 'calibration', 'query']) ins.run(k);
    assert.throws(() => ins.run('x'), /CHECK/);
    const id = db.prepare("INSERT INTO lab_device_messages (peer, raw, status) VALUES ('10.0.0.9', 'MSH|', 'unmatched')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT kind FROM lab_device_messages WHERE id = ?').get(id).kind, 'result');
  } finally { db.close(); }
});

test('233: на живой базе прежние строки — result и 0, данные целы', () => {
  const db = dbBefore233();
  try {
    assert.ok(!col(db, 'lab_devices', 'dial'), 'до 233 колонки нет — иначе тест ничего не проверяет');
    db.prepare("INSERT INTO lab_devices (id, name, profile, host, sending_app) VALUES (1, 'BC-5300', 'mindray-bc-5300', '10.0.0.9', 'BC-5300')").run();
    db.prepare("INSERT INTO lab_device_messages (id, device_id, peer, raw, sample_id, status, detail) VALUES (1, 1, '10.0.0.9', 'MSH|^~\\&|BC-5300', 'LAB-000123', 'applied', 'ок')").run();
    const before = db.prepare('SELECT * FROM lab_device_messages').all();

    db.exec(SQL);

    assert.deepEqual({ ...db.prepare('SELECT dial, sending_facility, sending_app, host FROM lab_devices WHERE id = 1').get() },
      { dial: 0, sending_facility: null, sending_app: 'BC-5300', host: '10.0.0.9' }, 'MSH-4 бэкфиллом не пишется: строка узнаёт его со следующей пробы');
    const after = db.prepare('SELECT * FROM lab_device_messages').all();
    assert.equal(after[0].kind, 'result');
    assert.deepEqual(after.map(({ kind, ...r }) => r), before, 'инвариант 2: сохранённое сообщение не меняется');
  } finally { db.close(); }
});

test('233: счётчик служебных за день идёт по маленькому индексу, а не по мегабайтам сырых проб', () => {
  // kind лежит в записи ПОСЛЕ raw: без индекса подсчёт «контроль за сегодня»
  // читал бы каждую пробу целиком, с картинками, за все месяцы.
  const db = openDb(':memory:');
  try {
    migrate(db);
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_lab_device_messages_service'").get();
    assert.ok(idx, 'индекс есть');
    assert.match(idx.sql, /WHERE\s+kind\s*<>\s*'result'/i, 'частичный: в нём только служебные строки');
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT device_id, kind, COUNT(*) AS n FROM lab_device_messages
       WHERE kind <> 'result' AND device_id IS NOT NULL AND received_at >= ? AND received_at < ?
       GROUP BY device_id, kind`).all('2026-10-01T00:00', '2026-10-02T00:00').map((r) => r.detail).join(' | ');
    assert.match(plan, /COVERING INDEX idx_lab_device_messages_service/, plan);
  } finally { db.close(); }
});

test('233: в файле только ADD COLUMN и индекс — ни пересборки, ни UPDATE, ни DELETE', () => {
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(code), 'пересборка таблицы внутри migrate() роняет клинику при запуске');
  assert.ok(!/\bDROP\b/i.test(code));
  assert.ok(!/^\s*UPDATE\s/im.test(code));
  assert.ok(!/\bDELETE\b/i.test(code));
  assert.equal((code.match(/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/gi) || []).length, 3);
});

test('233: реестр схемы — dial читается и пишется человеком; sending_facility и kind пишет только сервер', () => {
  const dev = REGISTRY.lab_devices;
  for (const c of ['dial', 'sending_facility']) assert.ok(dev.read.columns.includes(c), 'lab_devices.' + c + ' читается');
  assert.ok(dev.write.insert.columns.includes('dial'), '«Добавить по адресу» с флажком «Easy-Med подключается сам»');
  assert.ok(dev.write.update.columns.includes('dial'), '«Изменить»');
  assert.ok(!dev.write.insert.columns.includes('sending_facility'), 'как прибор назвался — пишет только сервер');
  assert.ok(!dev.write.update.columns.includes('sending_facility'));
  const msg = REGISTRY.lab_device_messages;
  assert.ok(msg.read.columns.includes('kind'));
  assert.ok(msg.filters.includes('kind'), 'лоток и лента берут только пробы');
  assert.deepEqual([msg.write.insert.roles, msg.write.update.roles, msg.write.delete.roles], [[], [], []], 'лоток пишет только сервер');
});

test('233: анализатор принадлежит зданию — в справочник и журнал филиалов не едет', () => {
  for (const t of ['lab_devices', 'lab_device_messages']) {
    assert.ok(!TABLES.some((x) => x.name === t), t + ' в справочнике филиалов');
    assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, t), t + ' в журнале филиалов');
  }
});
