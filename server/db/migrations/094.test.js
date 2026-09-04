// 094.test.js — DIET_TABLES_V1: справочник столов, история и приёмы пищи.
//
// Три вопроса, и первый из них — про то, что выглядит как ошибка:
//   • столов ПЯТНАДЦАТЬ и двенадцатого среди них НЕТ. Стол №12 упразднён;
//     дыра между №11 и №13 правильная, и тест стоит здесь, чтобы её никто не
//     «починил», пересчитав строки;
//   • справочник переживает повторный прогон и НЕ затирает правки клиники
//     (INSERT OR IGNORE по UNIQUE(code));
//   • правила, ради которых заведены две другие таблицы, держит сама база:
//     один действующий стол на госпитализацию, один приём пищи в день на
//     пациента, закрытые списки статусов и разовости.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

/** Клиника: пациент на койке под лечением. */
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (1,1,1,1,1,1,'active')`).run();
  return db;
}

// ─── 1. Справочник ──────────────────────────────────────────────────────────

test('столов ровно пятнадцать, и двенадцатого среди них НЕТ', () => {
  const db = fresh();
  const codes = db.prepare('SELECT code FROM diet_tables ORDER BY sort_order').all().map((r) => r.code);
  assert.equal(codes.length, 15, 'пятнадцать столов Певзнера');
  assert.deepEqual(codes, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '13', '14', '15']);
  assert.equal(codes.includes('12'), false, 'стол №12 упразднён — дыра в нумерации правильная');
  db.close();
});

test('номер стола — текст: «0» и «15» существуют и печатаются как написаны', () => {
  const db = fresh();
  const zero = db.prepare("SELECT code, name FROM diet_tables WHERE code = '0'").get();
  assert.equal(zero.code, '0');
  assert.match(zero.name, /зондовый/);
  assert.equal(typeof db.prepare("SELECT code FROM diet_tables WHERE code = '15'").get().code, 'string');
  db.close();
});

test('у каждого стола есть показание — врач выбирает по диагнозу, а не по номеру', () => {
  const db = fresh();
  const empty = db.prepare("SELECT code FROM diet_tables WHERE TRIM(indication) = ''").all();
  assert.deepEqual(empty, [], 'ни одного стола без показания');
  assert.match(db.prepare("SELECT indication i FROM diet_tables WHERE code = '9'").get().i, /диабет/i);
  assert.match(db.prepare("SELECT indication i FROM diet_tables WHERE code = '5'").get().i, /печени/i);
  db.close();
});

test('справочник редактируемый: клиника заводит свой стол и гасит ненужный', () => {
  const db = fresh();
  db.prepare("INSERT INTO diet_tables (code, name, indication, sort_order) VALUES ('1а','Стол №1а','После операции на желудке',16)").run();
  db.prepare("UPDATE diet_tables SET active = 0 WHERE code = '14'").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM diet_tables WHERE active = 1').get().c, 15);
  assert.equal(db.prepare("SELECT active a FROM diet_tables WHERE code = '14'").get().a, 0);
  db.close();
});

test('повторный прогон сида не затирает правки клиники (INSERT OR IGNORE)', () => {
  const db = fresh();
  db.prepare("UPDATE diet_tables SET name = 'Стол №5 (печёночный)', active = 0 WHERE code = '5'").run();
  // Ровно то, что делает миграция при повторном применении.
  db.prepare("INSERT OR IGNORE INTO diet_tables (code, name, indication, active, sort_order) VALUES ('5','Стол №5','Болезни печени…',1,5)").run();
  const row = db.prepare("SELECT name, active FROM diet_tables WHERE code = '5'").get();
  assert.equal(row.name, 'Стол №5 (печёночный)', 'переименование клиники цело');
  assert.equal(row.active, 0, 'снятый active не воскрешён');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM diet_tables WHERE code = '5'").get().c, 1, 'дубля нет');
  db.close();
});

// ─── 2. История назначений ──────────────────────────────────────────────────

test('действующий стол один: два открытых периода база не принимает', () => {
  const db = fresh();
  const ins = db.prepare("INSERT INTO admission_diets (admission_id, diet_code, since) VALUES (1, ?, ?)");
  ins.run('15', '2026-09-04T08:00:00Z');
  assert.throws(() => ins.run('9', '2026-09-04T09:00:00Z'), /UNIQUE/i,
    'без этого правила порционник посчитал бы пациенту две порции');
  db.close();
});

test('закрытый период не мешает открыть новый — история копится', () => {
  const db = fresh();
  db.prepare("INSERT INTO admission_diets (admission_id, diet_code, since, ended_at) VALUES (1,'15','2026-09-04T08:00:00Z','2026-09-05T08:00:00Z')").run();
  db.prepare("INSERT INTO admission_diets (admission_id, diet_code, since) VALUES (1,'9','2026-09-05T08:00:00Z')").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM admission_diets WHERE admission_id = 1').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM admission_diets WHERE admission_id = 1 AND ended_at IS NULL').get().c, 1);
  db.close();
});

test('разовость питания живёт на строке стола и ограничена 3–6', () => {
  const db = fresh();
  db.prepare("INSERT INTO admission_diets (admission_id, diet_code, meals_per_day) VALUES (1,'11',6)").run();
  assert.equal(db.prepare('SELECT meals_per_day m FROM admission_diets WHERE admission_id = 1').get().m, 6);
  assert.throws(() => db.prepare("INSERT INTO admission_diets (admission_id, diet_code, meals_per_day, ended_at) VALUES (1,'9',2,'x')").run(), /CHECK/i);
  assert.throws(() => db.prepare("INSERT INTO admission_diets (admission_id, diet_code, meals_per_day, ended_at) VALUES (1,'9',7,'x')").run(), /CHECK/i);
  db.close();
});

test('стол ссылается на справочник по коду — выдуманный номер не пройдёт', () => {
  const db = fresh();
  db.pragma('foreign_keys = ON');
  assert.throws(() => db.prepare("INSERT INTO admission_diets (admission_id, diet_code) VALUES (1,'12')").run(), /FOREIGN KEY/i,
    'стола №12 нет — и назначить его нельзя');
  db.close();
});

// ─── 3. Приёмы пищи ─────────────────────────────────────────────────────────

test('один приём пищи в день на пациента — вторая строка отвергается', () => {
  const db = fresh();
  const ins = db.prepare("INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (1,'2026-09-04',?,?)");
  ins.run('lunch', 'eaten');
  assert.throws(() => ins.run('lunch', 'refused'), /UNIQUE/i,
    'повтор перезаписывает свою строку (UPSERT), а не заводит вторую');
  // Другой приём и другой день — разные строки, это норма.
  ins.run('dinner', 'served');
  db.prepare("INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (1,'2026-09-05','lunch','eaten')").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM admission_meals').get().c, 3);
  db.close();
});

test('закрытые списки: приём пищи и его статус — только известные значения', () => {
  const db = fresh();
  const ins = db.prepare("INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (1,'2026-09-04',?,?)");
  for (const key of ['breakfast', 'breakfast2', 'lunch', 'tea', 'dinner', 'night']) ins.run(key, 'waiting');
  assert.throws(() => ins.run('brunch', 'eaten'), /CHECK/i);
  assert.throws(() => db.prepare("INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (1,'2026-09-06','lunch','ate')").run(), /CHECK/i);
  for (const st of ['waiting', 'served', 'eaten', 'partial', 'refused', 'npo', 'missed']) {
    db.prepare("INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (1,?, 'lunch', ?)").run('2026-10-' + String(10 + ['waiting', 'served', 'eaten', 'partial', 'refused', 'npo', 'missed'].indexOf(st)), st);
  }
  db.close();
});

// ─── 4. Ничего чужого не сломано ────────────────────────────────────────────

test('миграция не трогает admissions и деньги: старая госпитализация цела', () => {
  const db = fresh();
  const adm = db.prepare('SELECT * FROM admissions WHERE id = 1').get();
  assert.equal(adm.status, 'active');
  assert.equal(adm.bed_id, 1);
  // Колонки разовости на admissions НЕТ намеренно — она на строке стола.
  const cols = db.prepare('PRAGMA table_info(admissions)').all().map((c) => c.name);
  assert.equal(cols.includes('meals_per_day'), false, 'разовость живёт в admission_diets, а не здесь');
  db.close();
});
