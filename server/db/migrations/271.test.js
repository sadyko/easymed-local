// LAB_PANEL_DEDUP_V1 — миграция 271: копии показателей панели схлопываются,
// результаты анализов не трогаются, соответствия филиала вычищены, повтор —
// без изменений, разные показатели с одним именем — остаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = '271_lab_panel_dedup.sql';
const SQL = fs.readFileSync(path.join(HERE, FILE), 'utf8');
const NAMES = ['Лейкоциты', 'Эпит. клетки', 'Микрофлора', 'Гонококки', 'Трихомонады'];

// База после всех миграций (271 прошла по пустой), затем — состояние клиники,
// и миграция ещё раз: ровно то, что случится у клиники при обновлении.
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 1, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (51, 'Мазок (копия)', 1, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (900, 'Анализ гинекологического мазка', 50, 'lab', 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (901, 'Мазок (копия)', 51, 'lab', 1)").run();
  const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order, group_label, unit) VALUES (?, ?, 'numeric', ?, ?, ?)");
  // Панель 900 — каждый показатель трижды, копия за копией.
  for (let c = 0; c < 3; c++) NAMES.forEach((n, i) => a.run(900, n, i, c === 1 ? ' ' : null, null));   // ' ' и NULL раздела — одно и то же
  // Лишний пробел в имени у одной копии — тоже копия (сравнение по trim).
  a.run(900, ' Лейкоциты ', 0, null, null);
  // Тот же показатель в ДРУГОМ разделе бланка — другой показатель.
  a.run(900, 'Лейкоциты', 9, 'V', null);
  // Та же строка, но единицы поправлены — не копия: решает человек.
  a.run(900, 'Микрофлора', 2, null, 'ед.');
  // Другая панель с теми же именами — своя, не трогается.
  NAMES.forEach((n, i) => a.run(901, n, i, null, null));
  // Латиница с другим регистром — разные показатели (trim, не lower).
  a.run(901, 'WBC', 7, null, null); a.run(901, 'wbc', 8, null, null);

  // Результаты пациентов — в том числе трижды записанные — неприкосновенны.
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (2382, 10, 50, 'resulted')").run();
  const r = db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (2382, ?, ?)");
  for (let c = 0; c < 3; c++) for (const n of NAMES) r.run(n, 'v' + c);

  // Филиал: каждая копия панели 900 сопоставлена своей строке главного здания.
  const ids = db.prepare('SELECT id FROM lab_panel_analytes WHERE panel_id = 900 ORDER BY id').all().map((x) => x.id);
  const m = db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?, ?, ?)');
  ids.forEach((id, i) => m.run('lab_panel_analytes', 5000 + i, id));
  m.run('lab_panel_analytes', 9999, 123456);   // строку удалили здесь раньше — соответствие повисло
  m.run('lab_panels', 700, 900);
  m.run('services', 40, 50);
  return db;
}
const analytes = (db) => db.prepare('SELECT * FROM lab_panel_analytes ORDER BY id').all();
const snapshot = (db) => ({
  analytes: analytes(db),
  results: db.prepare('SELECT * FROM lab_results ORDER BY id').all(),
  map: db.prepare('SELECT table_name, remote_id, local_id FROM branch_sync_map ORDER BY table_name, remote_id').all(),
});

test('мигр. 271 стоит в списке миграций и проходит по свежей базе', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(FILE), FILE + ' применена');
});

test('мигр. 271: копии схлопываются до самой новой строки, разные показатели остаются', () => {
  const db = clinic();
  const before = analytes(db);
  db.exec(SQL);
  const p900 = db.prepare("SELECT id, trim(name) n, trim(COALESCE(group_label, '')) g, unit FROM lab_panel_analytes WHERE panel_id = 900 ORDER BY sort_order, id").all();
  assert.deepEqual(p900.map((x) => x.g + '|' + x.n + '|' + (x.unit || '')),
    ['|Лейкоциты|', '|Эпит. клетки|', '|Микрофлора|', '|Микрофлора|ед.', '|Гонококки|', '|Трихомонады|', 'V|Лейкоциты|']);
  // Осталась самая новая из копий: у «Лейкоцитов» — строка с пробелами (вставлена последней).
  const newest = (name, unit = null) => Math.max(...before.filter((x) => x.panel_id === 900 && x.name.trim() === name && (x.group_label || '').trim() === '' && x.unit === unit).map((x) => x.id));
  for (const n of NAMES) assert.ok(p900.some((x) => x.id === newest(n)), n + ': оставлена самая новая строка');
  assert.ok(p900.some((x) => x.id === newest('Микрофлора', 'ед.')));
  // Другая панель — нетронута; WBC и wbc — оба на месте.
  assert.deepEqual(analytes(db).filter((x) => x.panel_id === 901), before.filter((x) => x.panel_id === 901));
});

test('мигр. 271: результаты анализов не тронуты, соответствия удалённых строк вычищены, остальные — на месте', () => {
  const db = clinic();
  const before = snapshot(db);
  db.exec(SQL);
  const after = snapshot(db);
  assert.deepEqual(after.results, before.results, 'lab_results — без единого изменения');
  const live = new Set(after.analytes.map((x) => x.id));
  const mapA = after.map.filter((x) => x.table_name === 'lab_panel_analytes');
  assert.ok(mapA.every((x) => live.has(x.local_id)), 'нет соответствий на удалённые строки');
  assert.ok(!mapA.some((x) => x.remote_id === 9999), 'повисшее соответствие тоже убрано');
  const keptMapped = before.map.filter((x) => x.table_name === 'lab_panel_analytes' && live.has(x.local_id));
  assert.deepEqual(mapA, keptMapped, 'соответствия оставшихся строк — как были');
  assert.deepEqual(after.map.filter((x) => x.table_name !== 'lab_panel_analytes'), before.map.filter((x) => x.table_name !== 'lab_panel_analytes'),
    'соответствия других таблиц не тронуты');
});

test('мигр. 271: повторный запуск ничего не меняет', () => {
  const db = clinic();
  db.exec(SQL);
  const once = snapshot(db);
  db.exec(SQL);
  assert.deepEqual(snapshot(db), once);
});

// Ревью L1 (проба r5): trim() SQLite без набора снимает только пробелы, а лист ввода и
// lab_panel_save сравнивают String.prototype.trim(). Копия с табуляцией или NBSP в конце имени
// переживала миграцию, а «Сохранить панель» потом отказывал «записан в панели дважды».
test('мигр. 271: копии с табуляцией, переводом строки и неразрывным пробелом по краям — тоже копии', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO lab_panels (id, name, modality, active) VALUES (950, 'Мазок', 'lab', 1)").run();
  const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order, group_label, unit) VALUES (950, ?, 'numeric', ?, ?, 'г/л')");
  a.run('Лейкоциты', 0, null);
  a.run('Лейкоциты ', 1, null);
  a.run('\tЛейкоциты', 2, ' ');
  a.run('Лейкоциты\r\n', 3, ' \t');
  a.run('　Лейкоциты﻿', 4, null);
  a.run('Лейко циты', 5, null);   // пробел ВНУТРИ — другое имя
  db.exec(SQL);
  const left = db.prepare('SELECT name FROM lab_panel_analytes WHERE panel_id = 950 ORDER BY id').all().map((x) => x.name);
  assert.deepEqual(left, ['　Лейкоциты﻿', 'Лейко циты'], 'одна строка на показатель (самая новая)');
  // …и для сравнения листа ввода и lab_panel_save повторов больше нет.
  assert.equal(new Set(left.map((n) => n.trim())).size, left.length);
  db.close();
});

test('мигр. 271: набор пробельных символов trim — ровно тот, что у String.prototype.trim()', () => {
  const sets = SQL.match(/char\(9, [^)]*\)/g) || [];
  assert.equal(sets.length, 4, 'раздел и имя, с обеих сторон');
  assert.equal(new Set(sets).size, 1, 'один и тот же набор');
  const db = openDb(':memory:');
  const q = db.prepare(`SELECT trim('x' || char(?) || 'x' || char(?), ${sets[0]}) AS t`);
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;   // половинки суррогатной пары — не символ
    const ch = String.fromCharCode(cp);
    const js = ('x' + ch + 'x' + ch).trim() === 'x' + ch + 'x';
    const sql = q.get(cp, cp).t === 'x' + ch + 'x';
    if (js !== sql) assert.fail(`U+${cp.toString(16).padStart(4, '0')}: JS trim ${js ? 'снимает' : 'не снимает'}, SQL — ${sql ? 'снимает' : 'нет'}`);
  }
  db.close();
});
