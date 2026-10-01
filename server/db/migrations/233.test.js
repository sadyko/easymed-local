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
    // LIS_REAL_ANALYZERS_V1 (ревью R4) — подтверждение, данное до 233, и
    // значение прибора, записанное до 233.
    db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9, 'ОАК', 1)").run();
    db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5, ?, 9, 1)').run('ОАК');
    db.prepare("INSERT INTO lab_panel_analytes (id, panel_id, code, name, unit, device_code, device_code_confirmed) VALUES (1, 5, 'WBC', 'Лейкоциты', '', 'WBC', 1)").run();

    db.exec(SQL);

    assert.deepEqual({ ...db.prepare('SELECT dial, sending_facility, sending_app, host FROM lab_devices WHERE id = 1').get() },
      { dial: 0, sending_facility: null, sending_app: 'BC-5300', host: '10.0.0.9' }, 'MSH-4 бэкфиллом не пишется: строка узнаёт его со следующей пробы');
    const after = db.prepare('SELECT * FROM lab_device_messages').all();
    assert.equal(after[0].kind, 'result');
    assert.equal(after[0].disputes, null);
    assert.deepEqual(after.map(({ kind, disputes, ...r }) => r), before, 'инвариант 2: сохранённое сообщение не меняется');
    // Ревью R4, п. A — бэкфилла нет: прежнее подтверждение — без прибора
    // (NULL). У BS-200 это «не подтверждено» (ingest.js), у кодов
    // производителя отметка не читается.
    assert.deepEqual({ ...db.prepare('SELECT device_code_confirmed AS c, device_code_confirmed_device_id AS d FROM lab_panel_analytes WHERE id = 1').get() }, { c: 1, d: null });
  } finally { db.close(); }
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R4 ───────────────────────────────────────

test('233 (R4): новые колонки — без значения по умолчанию, NULL у прежних строк', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    for (const [t, c, type] of [['lab_panel_analytes', 'device_code_confirmed_device_id', 'INTEGER'], ['lab_results', 'source_message_id', 'INTEGER'],
      ['lab_device_messages', 'disputes', 'TEXT'], ['visit_services', 'lis_status_before', 'TEXT']]) {
      const k = col(db, t, c);
      assert.ok(k, t + '.' + c);
      assert.deepEqual([k.type, k.notnull, k.dflt_value], [type, 0, null], t + '.' + c);
    }
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

test('233: в файле только ADD COLUMN, индекс и триггеры отметки подтверждения — ни пересборки, ни UPDATE данных, ни DELETE', () => {
  const all = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — UPDATE — только в телах двух
  // триггеров, и они пишут только отметку «для какого прибора подтверждено»
  // у той строки, которую вставили или правят. Триггера R3 на lab_panels нет.
  // Ревью R5, п. 6 — третий: смена адреса или порта строки BS-200 снимает
  // отметки, данные для этой строки (подтверждения остаются).
  const trigs = all.match(/CREATE TRIGGER[\s\S]*?\bEND;/gi) || [];
  assert.equal(trigs.length, 3, 'три триггера');
  assert.match(trigs[0], /AFTER INSERT ON lab_panel_analytes/i);
  assert.match(trigs[1], /AFTER UPDATE OF device_code_confirmed, device_code ON lab_panel_analytes/i);
  assert.match(trigs[2], /AFTER UPDATE OF host, port ON lab_devices/i);
  for (const t of trigs.slice(0, 2)) {
    const body = /\bBEGIN\b([\s\S]*)\bEND;/i.exec(t)[1].trim();
    assert.equal(body.split(';').filter((s) => s.trim()).length, 1, 'одна инструкция: ' + body);
    assert.match(body, /^UPDATE lab_panel_analytes SET device_code_confirmed_device_id = CASE[\s\S]*WHERE id = NEW\.id;$/);
  }
  const addr = /\bBEGIN\b([\s\S]*)\bEND;/i.exec(trigs[2])[1].trim();
  assert.equal(addr, 'UPDATE lab_panel_analytes SET device_code_confirmed_device_id = NULL WHERE device_code_confirmed_device_id = NEW.id;');
  assert.ok(!/ON lab_panels\b/i.test(all), 'смена прибора панели ничего не переписывает');
  let code = all;
  for (const t of trigs) code = code.replace(t, '');
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(code), 'пересборка таблицы внутри migrate() роняет клинику при запуске');
  assert.ok(!/\bDROP\b/i.test(code));
  assert.ok(!/^\s*UPDATE\s/im.test(code), 'данные миграция не правит');
  assert.ok(!/\bDELETE\b/i.test(all));
  assert.equal((code.match(/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/gi) || []).length, 7);
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
  // LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — отметку редактор панелей читает и
  // передаёт при вставке (для какого прибора человек подтвердил); последнее
  // слово — у триггера. Правкой строки её не задать.
  const an = REGISTRY.lab_panel_analytes;
  assert.ok(an.read.columns.includes('device_code_confirmed_device_id'));
  assert.ok(an.write.insert.columns.includes('device_code_confirmed_device_id'));
  assert.ok(!an.write.update.columns.includes('device_code_confirmed_device_id'));
  // Источник значения, разобранные споры, статус до прибора — пишет только сервер.
  assert.ok(!REGISTRY.lab_results.write.insert.columns.includes('source_message_id'));
  assert.ok(!REGISTRY.lab_results.write.update.columns.includes('source_message_id'));
  for (const op of ['insert', 'update']) {
    assert.ok(!((REGISTRY.visit_services.write[op] || {}).columns || []).includes('lis_status_before'), 'visit_services.' + op);
  }
});

test('233: анализатор принадлежит зданию — в справочник и журнал филиалов не едет', () => {
  for (const t of ['lab_devices', 'lab_device_messages']) {
    assert.ok(!TABLES.some((x) => x.name === t), t + ' в справочнике филиалов');
    assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, t), t + ' в журнале филиалов');
  }
  // LIS_REAL_ANALYZERS_V1 (ревью R4) — отметка прибора, источник значения и
  // статус до прибора — номера строк ЭТОГО здания: соседу они ничего не значат.
  assert.ok(!TABLES.find((x) => x.name === 'lab_panel_analytes').columns.includes('device_code_confirmed_device_id'));
  assert.ok(!SHIPPED.lab_results.includes('source_message_id'));
  assert.ok(!SHIPPED.visit_services.includes('lis_status_before'));
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R4, п. A: подтверждение — для прибора ─────
// У BS-200 номер теста свой у каждого прибора. Подтверждение сопоставления
// (D4) теперь помнит, для КАКОГО прибора оно дано:
// lab_panel_analytes.device_code_confirmed_device_id. Ставит её база — на
// каждом пути записи (триггеры вставки и правки); приём BS-200 применяет
// только строки, подтверждённые для прибора панели (ingest.js). Смена прибора
// панели больше ничего не переписывает: отметка остаётся прежней и просто не
// совпадает с новым прибором.
//
// Редактор панелей сохраняет показатели так: правка lab_panels (в том числе
// device_id), потом вставка новых строк, потом удаление прежних
// (lab-panels.js savePanel), и называет при вставке, для какого прибора
// подтверждено (0 — ни для какого). Ревью R5, п. 2: вставка без этого
// (старая вкладка, прямая запись) наследует отметку прежней строки ТОЙ ЖЕ
// пары «код + показатель», а без такой строки — NULL, не прибор панели:
// иначе подтверждение, данное до 233 или для другого прибора, «отмывалось»
// бы — у копии панели, у строки, которой код переставили.
function panelOn(db, deviceId) {
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1)").run();
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5, ?, 9, ?)').run('Биохимия', deviceId);
}
function devices(db) {
  db.prepare(`INSERT INTO lab_devices (id, name, profile) VALUES (1, 'BS-200', 'mindray-bs-200'), (2, 'BS-200 (2)', 'mindray-bs-200'),
              (3, 'BC-5300', 'mindray-bc-5300')`).run();
}
const insA = (db, { code = 'GLU', name = 'Глюкоза', dc = '2', confirmed = 1, claim, panel = 5 } = {}) => (claim === undefined
  ? db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed) VALUES (?, ?, ?, '', ?, ?)`).run(panel, code, name, dc, confirmed)
  : db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed, device_code_confirmed_device_id)
                VALUES (?, ?, ?, '', ?, ?, ?)`).run(panel, code, name, dc, confirmed, claim)).lastInsertRowid;
const stampOf = (db, id) => db.prepare('SELECT device_code_confirmed_device_id AS d FROM lab_panel_analytes WHERE id = ?').get(id).d;
/** Сохранение редактора: правка панели, вставка строк, удаление прежних. */
function editorSave(db, deviceId, lines) {
  db.prepare('UPDATE lab_panels SET device_id = ? WHERE id = 5').run(deviceId);
  const old = db.prepare('SELECT id FROM lab_panel_analytes WHERE panel_id = 5').all().map((r) => r.id);
  const ids = lines.map((l) => insA(db, l));
  for (const id of old) db.prepare('DELETE FROM lab_panel_analytes WHERE id = ?').run(id);
  return ids;
}

test('233 (R4 п. A; R5 п. 2): вставка — прибор, названный редактором; 0 — ни для какого; без названного и без прежней строки — NULL', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    devices(db);
    panelOn(db, 1);
    assert.equal(stampOf(db, insA(db, { claim: 1 })), 1, 'человек подтвердил при приборе 1 — экран так и передал');
    assert.equal(stampOf(db, insA(db, { code: 'K', dc: '8', claim: 0 })), null, '0 — подтверждено ни для какого прибора');
    assert.equal(stampOf(db, insA(db, { code: 'Q', dc: '6' })), null, 'никто не назвал прибор — не прибор панели (ревью R5, п. 2)');
    assert.equal(stampOf(db, insA(db, { code: 'UREA', dc: '3', confirmed: 0 })), null);
    assert.equal(stampOf(db, insA(db, { code: 'X', dc: '  ', confirmed: 1, claim: 1 })), null, 'кода нет — подтверждать нечего');
    assert.equal(stampOf(db, insA(db, { code: 'Y', dc: '9', confirmed: 0, claim: 1 })), null, 'отметка без подтверждения не держится');
  } finally { db.close(); }
});

test('233 (R4 п. A, дыра d; R5 п. 2): старая вкладка сохранила — отметка наследуется только у той же пары «код + показатель»', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    devices(db);
    panelOn(db, 1);
    editorSave(db, 1, [{ claim: 1 }, { code: 'UREA', name: 'Мочевина', dc: '3', claim: 1 }]);
    // Вкладка без отметки (или не загрузила профили): прибор панели — 2,
    // строки по-прежнему «подтверждены».
    const ids = editorSave(db, 2, [{}, { code: 'UREA', name: 'Мочевина', dc: '3' }, { code: 'CREA', name: 'Креатинин', dc: '5' }]);
    assert.deepEqual(ids.map((id) => stampOf(db, id)), [1, 1, null],
      'прежние пары — для прибора 1 (не совпадает с панелью — приём BS-200 их не применит); новую никто не подтверждал при приборе 2');
    const again = editorSave(db, 2, [{}, { code: 'UREA', name: 'Мочевина', dc: '3' }]);
    assert.deepEqual(again.map((id) => stampOf(db, id)), [1, 1], 'второе сохранение той же вкладкой отметку не меняет');
    // Ревью R5, п. 2 (повтор Б) — код «2» переставили на другой показатель:
    // отметка глюкозы креатинину не достаётся.
    const remap = editorSave(db, 2, [{ code: 'CREA', name: 'Креатинин', dc: '2' }, { name: 'Глюкоза', dc: '7' }]);
    assert.deepEqual(remap.map((id) => stampOf(db, id)), [null, null]);
  } finally { db.close(); }
});

test('233 (R4 п. A; R5 п. 2): редактор передаёт, для какого прибора подтвердил, — так и записано; до 233 (NULL) остаётся NULL', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    devices(db);
    panelOn(db, 1);
    editorSave(db, 1, [{ claim: 1 }, { code: 'UREA', name: 'Мочевина', dc: '3', claim: 1 }]);
    // Экран: панель на приборе 2, глюкоза подтверждена заново (для 2), мочевина — нет (отметка 1).
    const ids = editorSave(db, 2, [{ claim: 2 }, { code: 'UREA', name: 'Мочевина', dc: '3', claim: 1 }]);
    assert.deepEqual(ids.map((id) => stampOf(db, id)), [2, 1]);
    // Подтверждение, данное до 233 (NULL): экран шлёт 0, старая вкладка — ничего; NULL в обоих случаях.
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed_device_id = NULL WHERE panel_id = 5').run();
    const legacy = editorSave(db, 2, [{ claim: 0 }, { code: 'UREA', name: 'Мочевина', dc: '3' }]);
    assert.deepEqual(legacy.map((id) => stampOf(db, id)), [null, null]);
    // «Копировать»: копия — другая панель; отметки едут как есть (экран называет их).
    db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (6, 'Биохимия (копия)', NULL, 2)").run();
    const copy = [insA(db, { panel: 6, claim: 1 }), insA(db, { panel: 6, code: 'UREA', name: 'Мочевина', dc: '3', claim: 0 }),
      insA(db, { panel: 6, code: 'CREA', name: 'Креатинин', dc: '5' })];
    assert.deepEqual(copy.map((id) => stampOf(db, id)), [1, null, null]);
  } finally { db.close(); }
});

test('233 (R4 п. A): правка строки — подтвердили или сменили код — отметка прибора панели; прочая правка отметку не трогает', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    devices(db);
    panelOn(db, 1);
    const id = insA(db, { claim: 1 });
    db.prepare('UPDATE lab_panels SET device_id = 2 WHERE id = 5').run();
    assert.equal(stampOf(db, id), 1, 'смена прибора панели отметку не переписывает');
    assert.equal(db.prepare('SELECT device_code_confirmed AS c FROM lab_panel_analytes WHERE id = ?').get(id).c, 1, 'и подтверждение не снимает (триггера R3 нет)');
    db.prepare('UPDATE lab_panel_analytes SET name = ?, unit = ? WHERE id = ?').run('Глюкоза крови', 'ммоль/л', id);
    assert.equal(stampOf(db, id), 1);
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE id = ?').run(id);
    assert.equal(stampOf(db, id), 1, '«подтверждено» поверх подтверждённого — не новое подтверждение');
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE id = ?').run(id);
    assert.equal(stampOf(db, id), null);
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE id = ?').run(id);
    assert.equal(stampOf(db, id), 2, 'подтвердили при панели на приборе 2');
    db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
    db.prepare("UPDATE lab_panel_analytes SET device_code = '12' WHERE id = ?").run(id);
    assert.equal(stampOf(db, id), 1, 'новый код — новое сопоставление при приборе 1');
    db.prepare("UPDATE lab_panel_analytes SET device_code = ' 12 ' WHERE id = ?").run(id);
    assert.equal(stampOf(db, id), 1);
    db.prepare("UPDATE lab_panel_analytes SET device_code = '' WHERE id = ?").run(id);
    assert.equal(stampOf(db, id), null, 'кода нет');
  } finally { db.close(); }
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R5, п. 6 ─────────────────────────────────
// Строке BS-200 сменили адрес или порт («Изменить» в «Анализаторах»): за
// строкой, возможно, уже другой прибор, а у BS-200 номер теста свой у каждого.
// Отметки «подтверждено для этой строки» снимаются (подтверждения остаются —
// экран и лоток скажут «подтвердите заново»). Дописанный адрес строки, у
// которой его не было (discover.js claim), — не смена.
test('233 (R5 п. 6): адрес или порт строки BS-200 сменили — отметки, данные для неё, сняты; у прочих моделей и без смены — нет', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare(`INSERT INTO lab_devices (id, name, profile, host, port) VALUES (1, 'BS-200', 'mindray-bs-200', '10.0.0.40', 2575),
                (2, 'BS-200 (2)', 'mindray-bs-200', '', 2575), (3, 'BC-5300', 'mindray-bc-5300', '10.0.0.9', 2575)`).run();
    panelOn(db, 1);
    db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (6, 'ОАК', NULL, 3)").run();
    const glu = insA(db, { claim: 1 });
    const other = insA(db, { code: 'UREA', name: 'Мочевина', dc: '3', claim: 2 });
    const wbc = insA(db, { panel: 6, code: 'WBC', name: 'Лейкоциты', dc: 'WBC', claim: 3 });
    const st = () => [stampOf(db, glu), stampOf(db, other), stampOf(db, wbc)];

    db.prepare("UPDATE lab_devices SET name = 'BS-200 лаборатория', host = '10.0.0.40', port = 2575 WHERE id = 1").run();
    assert.deepEqual(st(), [1, 2, 3], 'имя сменили, адрес и порт те же');
    db.prepare("UPDATE lab_devices SET host = '10.0.0.41' WHERE id = 2").run();
    assert.deepEqual(st(), [1, 2, 3], 'строке без адреса адрес дописали — не смена');
    db.prepare("UPDATE lab_devices SET host = '10.0.0.10' WHERE id = 3").run();
    assert.deepEqual(st(), [1, 2, 3], 'коды производителя — отметка не читается и не снимается');
    db.prepare("UPDATE lab_devices SET host = '10.0.0.50' WHERE id = 1").run();
    assert.deepEqual(st(), [null, 2, 3], 'адрес BS-200 сменили — отметки этой строки сняты');
    assert.equal(db.prepare('SELECT device_code_confirmed AS c FROM lab_panel_analytes WHERE id = ?').get(glu).c, 1, 'подтверждение остаётся — подтвердить заново');
    db.prepare("UPDATE lab_devices SET port = 5600 WHERE id = 2").run();
    assert.deepEqual(st(), [null, null, 3], 'порт BS-200 сменили');
  } finally { db.close(); }
});

test('233 (R5 п. 6): список профилей в триггере адреса — ровно профили с codesPerInstrument', async () => {
  const { listProfiles } = await import('../../lis/profiles/index.js');
  const want = listProfiles().filter((p) => p.codesPerInstrument).map((p) => p.key).sort();
  const m = /ON lab_devices[\s\S]*?profile IN \(([^)]*)\)/i.exec(SQL);
  assert.ok(m, 'триггер со списком профилей');
  const got = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(got, want);
});
