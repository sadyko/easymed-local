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

test('233: в файле только ADD COLUMN, индекс и триггер сброса подтверждений — ни пересборки, ни UPDATE данных, ни DELETE', () => {
  const all = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // LIS_REAL_ANALYZERS_V1 (ревью R3, п. 2) — единственный UPDATE — в теле
  // триггера, и он только снимает подтверждения у строк перепривязанной панели.
  const trig = /CREATE TRIGGER[\s\S]*?\bEND;/i.exec(all);
  assert.ok(trig, 'триггер есть');
  assert.match(trig[0], /AFTER UPDATE OF device_id ON lab_panels/i);
  assert.match(trig[0], /UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = NEW\.id;/);
  const code = all.replace(trig[0], '');
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(code), 'пересборка таблицы внутри migrate() роняет клинику при запуске');
  assert.ok(!/\bDROP\b/i.test(code));
  assert.ok(!/^\s*UPDATE\s/im.test(code), 'данные миграция не правит');
  assert.ok(!/\bDELETE\b/i.test(all));
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

// ── LIS_REAL_ANALYZERS_V1 — ревью R3, п. 2 ─────────────────────────────────
// У BS-200 номер теста свой у каждого прибора. Панель перепривязали к другому
// прибору (или с BS-200 на другой), а подтверждения сопоставлений остались —
// и «2» второго прибора легло бы в «Глюкозу» под подтверждением, данным для
// нумерации первого. Сохраняют панель обычным /api/db (lab-panels.js), поэтому
// сброс — в базе: триггер на смену lab_panels.device_id.
function panelOn(db, deviceId) {
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1)").run();
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5, ?, 9, ?)').run('Биохимия', deviceId);
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5, 'GLU', 'Глюкоза', '', '2', 1), (5, 'UREA', 'Мочевина', '', '3', 1)`).run();
}
const confirmedOf = (db) => db.prepare('SELECT device_code_confirmed AS c FROM lab_panel_analytes WHERE panel_id = 5 ORDER BY id').all().map((r) => r.c);

test('233 (R3 п. 2): смена прибора панели с BS-200 или на BS-200 — подтверждения сопоставлений сброшены', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare(`INSERT INTO lab_devices (id, name, profile) VALUES (1, 'BS-200', 'mindray-bs-200'), (2, 'BS-200 (2)', 'mindray-bs-200'),
                (3, 'BC-5300', 'mindray-bc-5300'), (4, 'BC-5300 (2)', 'mindray-bc-5300')`).run();
    panelOn(db, 1);
    db.prepare('UPDATE lab_panels SET name = ? WHERE id = 5').run('Биохимия крови');
    assert.deepEqual(confirmedOf(db), [1, 1], 'прибор не менялся — подтверждения на месте');
    db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [1, 1], 'тот же прибор — не смена');
    db.prepare('UPDATE lab_panels SET device_id = 2 WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [0, 0], 'BS-200 → другой BS-200: номера тестов другие');
    assert.deepEqual(db.prepare('SELECT device_code FROM lab_panel_analytes WHERE panel_id = 5 ORDER BY id').all().map((r) => r.device_code), ['2', '3'],
      'коды остаются — подтверждать их заново');

    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE panel_id = 5').run();
    db.prepare('UPDATE lab_panels SET device_id = 3 WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [0, 0], 'с BS-200 на гематологию — тоже');
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE panel_id = 5').run();
    db.prepare('UPDATE lab_panels SET device_id = 4 WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [1, 1], 'BC-5300 → BC-5300: коды производителя, подтверждения прежние');
    db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [1, 1], 'отвязали от гематологии — не BS-200');
    db.prepare('UPDATE lab_panels SET device_id = 2 WHERE id = 5').run();
    assert.deepEqual(confirmedOf(db), [0, 0], 'привязали к BS-200');
  } finally { db.close(); }
});

test('233 (R3 п. 2): список профилей в триггере — ровно профили с codesPerInstrument', async () => {
  const { listProfiles } = await import('../../lis/profiles/index.js');
  const want = listProfiles().filter((p) => p.codesPerInstrument).map((p) => p.key).sort();
  const m = /CREATE TRIGGER[\s\S]*?profile IN \(([^)]*)\)/i.exec(SQL);
  assert.ok(m, 'триггер со списком профилей');
  const got = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(got, want);
});
