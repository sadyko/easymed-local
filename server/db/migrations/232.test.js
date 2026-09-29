// MRN_BEYOND_99999_V1 (мигр. 232) — номер карты после 99 999.
//
// Было: номер — последние ПЯТЬ знаков карты, год — окно substr(mrn, -9, 4),
// нули — substr('00000' || n, -5). Сотая тысяча давала «00000», следующая —
// снова «00000», и каждая новая карта упиралась в UNIQUE(mrn): регистрация и
// импорт отказывали (на копии dev легли 29 806 из 44 606).
//
// Стало: формат прежний, номер читается ЦЕЛИКОМ после второго дефиса, год — по
// месту сразу после первого, до 99 999 пять цифр с нулями, дальше — просто
// больше цифр: A-26-99999 → A-26-100000.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = '232_mrn_beyond_99999.sql';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }
const yyOf = (db) => db.prepare("SELECT substr(strftime('%Y','now'), 3, 2) y").get().y;
const yearAt = (yy, d) => String((Number(yy) + 100 + d) % 100).padStart(2, '0');
const put = (db, mrn, name = 'Импорт') =>
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run(name, mrn);
const register = (db, name = 'Новый') => {
  const id = db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(name).lastInsertRowid;
  return db.prepare('SELECT mrn FROM patients WHERE id = ?').get(id).mrn;
};
const allMrns = (db) => db.prepare('SELECT id, mrn FROM patients ORDER BY id').all();
const schemaOf = (db, names) => db.prepare(
  `SELECT name, sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY name`,
).all(...names);

/** База ровно на 231 — до этой миграции; apply232() докатывает её через тот же migrate(). */
function at231() {
  const dir = tmpDir('em-232-');
  for (const f of fs.readdirSync(HERE)) {
    const m = /^(\d{3,})_.*\.sql$/.exec(f);
    if (m && Number(m[1]) < 232) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  }
  const db = openDb(':memory:');
  migrate(db, dir);
  const last = db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get().name;
  assert.equal(last, '231_crm_request_sources.sql', 'база обязана стоять ровно перед 232');
  return {
    db,
    apply232() {
      fs.copyFileSync(path.join(HERE, FILE), path.join(dir, FILE));
      migrate(db, dir);
    },
  };
}

test('232: после 99 999 идут 100000 и 100001 — номер целиком, а не последние пять знаков', () => {
  const db = freshDb();
  const yy = yyOf(db);
  put(db, `A-${yy}-99998`);
  put(db, `A-${yy}-99999`);
  assert.equal(register(db), `A-${yy}-100000`);
  assert.equal(register(db), `A-${yy}-100001`);
  const c = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT mrn) d FROM patients').get();
  assert.equal(c.n, c.d, 'все номера разные');
  db.close();
});

test('232: до 99 999 номер прежний — пять цифр с нулями; граница проходится подряд, без пропусков и повторов', () => {
  const db = freshDb();
  const yy = yyOf(db);
  assert.equal(register(db), `A-${yy}-00001`, 'первая карта года — как всегда');
  put(db, `A-${yy}-00041`);
  assert.equal(register(db), `A-${yy}-00042`);
  put(db, `A-${yy}-99500`);
  const got = [];
  db.transaction(() => { for (let i = 0; i < 1000; i++) got.push(register(db)); })();
  const want = [];
  for (let n = 99501; n <= 100500; n++) want.push(`A-${yy}-${String(n).padStart(5, '0')}`);
  assert.deepEqual(got, want);
  db.close();
});

test('232: карты других лет в счёт не идут — ни прошлого, ни будущего, даже шестизначные', () => {
  const db = freshDb();
  const yy = yyOf(db);
  put(db, `A-${yearAt(yy, -1)}-150000`);
  put(db, `P-${yearAt(yy, -1)}-99999`);
  put(db, `A-${yearAt(yy, +1)}-120000`);
  put(db, `B-${yearAt(yy, -10)}-100001`);
  assert.equal(register(db), `A-${yy}-00001`, 'год — по месту после первого дефиса, а не окном от конца');
  // …а шестизначная карта ЭТОГО года — в счёт: окно от конца (-9, 4) у неё
  // попадало на «6-10» и теряло её, номера пошли бы по второму кругу.
  put(db, `P-${yy}-100007`);
  assert.equal(register(db), `A-${yy}-100008`);
  db.close();
});

test('232: буква филиала — одна или несколько; номер считается по всем буквам года', () => {
  const db = freshDb();
  const yy = yyOf(db);
  db.prepare("UPDATE branch_identity SET letter = 'AB' WHERE id = 1").run();
  put(db, `AB-${yy}-99999`);
  assert.equal(register(db), `AB-${yy}-100000`);

  // Восемь знаков — предел letters.js (LETTER_MAX_CHARS); схема длину не
  // ограничивает, и правило от этого не зависит: позиции — от дефисов.
  db.prepare("UPDATE branch_identity SET letter = 'ABCDEFGH' WHERE id = 1").run();
  put(db, `XYZ-${yy}-100040`);
  put(db, `P-${yy}-00007`);
  assert.equal(register(db), `ABCDEFGH-${yy}-100041`);

  db.prepare("UPDATE branch_identity SET letter = 'C' WHERE id = 1").run();
  put(db, `РУЧН-${yy}-100100`);   // введённый руками номер с кириллицей — как и прежде, в счёт
  assert.equal(register(db), `C-${yy}-100101`);
  db.close();
});

test('232: P- и A- одной серией, как в настоящей базе (legacy P-26 + свои A-26): счётчик общий', () => {
  const db = freshDb();
  const yy = yyOf(db);
  const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
  db.transaction(() => {
    for (let n = 99000; n <= 99990; n++) ins.run('Легаси', `P-${yy}-${n}`);
  })();
  put(db, `A-${yy}-99999`, 'Свой');
  assert.equal(register(db), `A-${yy}-100000`, 'после наибольшего из ОБЕИХ букв');
  put(db, `P-${yy}-100010`, 'Импорт P');           // импорт с явным номером — в счёт
  assert.equal(register(db), `A-${yy}-100011`);
  put(db, `B-${yy}-100500`, 'От соседа');          // карта соседнего здания — в счёт, как было
  assert.equal(register(db), `A-${yy}-100501`);
  db.close();
});

test('232: явный номер не переписывается, и следующий идёт после него', () => {
  const db = freshDb();
  const yy = yyOf(db);
  put(db, `A-${yy}-123456`, 'С номером');
  assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name = 'С номером'").get().mrn, `A-${yy}-123456`);
  assert.equal(register(db), `A-${yy}-123457`);
  db.close();
});

test('232: нелепо длинный номер (10+ цифр) счётчик не угоняет и не переполняет', () => {
  const db = freshDb();
  const yy = yyOf(db);
  put(db, `A-${yy}-00041`);
  put(db, `P-${yy}-1000000000`);
  put(db, `P-${yy}-99999999999999999999`);
  put(db, `P-${yy}--5`);
  assert.equal(register(db), `A-${yy}-00042`);
  assert.equal(register(db), `A-${yy}-00043`);
  db.close();
});

test('232: нет строки branch_identity — регистрация отказывает громко, как и прежде', () => {
  const db = freshDb();
  const before = db.prepare('SELECT COUNT(*) n FROM patients').get().n;
  db.prepare('DELETE FROM branch_identity').run();
  assert.throws(() => register(db), /branch identity missing/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, before, 'карта без номера не осталась');
  db.close();
});

test('232: клиника на 231 у самой границы — номера не меняются, выдача продолжается с 100000', () => {
  const { db, apply232 } = at231();
  const yy = yyOf(db);
  put(db, `P-${yy}-99998`);
  put(db, `P-${yy}-99999`);
  // Ошибка, которую чинит 232, — воспроизведена на 231.
  assert.equal(register(db, 'Сотая тысяча'), `A-${yy}-00000`, '231: сотая тысяча даёт «00000»');
  assert.throws(() => register(db, 'Следующий'), /UNIQUE constraint failed: patients\.mrn/);

  const before = allMrns(db);
  apply232();
  assert.deepEqual(allMrns(db), before, 'существующие номера не меняются — ни один, включая «00000»');
  assert.equal(register(db), `A-${yy}-100000`);
  assert.equal(register(db), `A-${yy}-100001`);
  db.close();
});

test('232: порядок AFTER INSERT прежний — журнал обмена и авторство нового пациента те же, что на 231', () => {
  const old = at231();          // до 232 — эталон порядка
  const fresh = freshDb();      // с 232
  const journalOf = (db) => {
    const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Журнал')").run().lastInsertRowid;
    const p = db.prepare('SELECT uid, mrn FROM patients WHERE id = ?').get(id);
    return {
      mrnShape: /^A-\d{2}-\d{5}$/.test(p.mrn),
      journal: db.prepare("SELECT op, cols FROM sync_journal WHERE tbl = 'patients' AND uid = ? ORDER BY seq").all(p.uid),
      authored: db.prepare("SELECT col FROM sync_authored WHERE tbl = 'patients' AND uid = ? ORDER BY col").all(p.uid).map((r) => r.col),
    };
  };
  const was = journalOf(old.db);
  const now = journalOf(fresh);
  assert.deepEqual(now, was);
  assert.deepEqual(now.journal, [{ op: 'put', cols: '*' }, { op: 'put', cols: 'mrn' }], 'вставка + номер, как было');
  assert.deepEqual(now.authored, ['mrn']);
  // Соседние триггеры пересозданы ДОСЛОВНО — текстом из 083/084. Концы строк
  // не в счёт: в рабочей копии Windows (core.autocrlf) 083/084 лежат с CRLF, в
  // выпуске и в индексе git — с LF, и sqlite_master хранит текст как прочитан.
  const NEIGHBOURS = ['patients_journal_ins', 'patients_uid_autogen'];
  const lf = (rows) => rows.map((r) => ({ ...r, sql: r.sql.replace(/\r\n/g, '\n') }));
  assert.deepEqual(lf(schemaOf(fresh, NEIGHBOURS)), lf(schemaOf(old.db, NEIGHBOURS)));
  // …и стоят в прежнем порядке создания: номер — раньше uid, uid — раньше журнала.
  const order = fresh.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'patients'
                                  AND name IN ('patients_mrn_autogen','patients_uid_autogen','patients_journal_ins')
                                ORDER BY rowid`).all().map((r) => r.name);
  assert.deepEqual(order, ['patients_mrn_autogen', 'patients_uid_autogen', 'patients_journal_ins']);
  old.db.close(); fresh.close();
});

test('232: повторный накат ничего не меняет — ни через migrate(), ни сам файл второй раз', () => {
  const db = freshDb();
  const yy = yyOf(db);
  put(db, `A-${yy}-99999`);
  assert.equal(register(db), `A-${yy}-100000`);
  const OBJECTS = ['idx_patients_mrn_seq', 'patients_mrn_autogen', 'patients_uid_autogen', 'patients_journal_ins'];
  const schema = schemaOf(db, OBJECTS);
  const applied = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n;
  const mrns = allMrns(db);

  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, applied);
  assert.deepEqual(schemaOf(db, OBJECTS), schema);

  db.exec(fs.readFileSync(path.join(HERE, FILE), 'utf8'));
  assert.deepEqual(schemaOf(db, OBJECTS), schema, 'тот же текст триггеров и индекса');
  assert.deepEqual(allMrns(db), mrns, 'ни один номер не тронут');
  assert.equal(register(db), `A-${yy}-100001`);
  db.close();
});

test('232: MAX триггера идёт одним спуском по индексу — и индекс ровно под выражения триггера', () => {
  const db = freshDb();
  const trig = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'patients_mrn_autogen'").get().sql;
  // Подзапрос берётся ИЗ ТЕКСТА ТРИГГЕРА, а не переписывается здесь: проверяется
  // именно то, что исполняется на каждой регистрации.
  const m = /SELECT COALESCE\(MAX\([\s\S]*?BETWEEN 0 AND 999999999/.exec(trig);
  assert.ok(m, 'подзапрос номера найден в триггере');
  assert.doesNotMatch(trig, /substr\(mrn, -5\)|substr\(mrn, -9, 4\)|'00000'/, 'старого окна от конца больше нет');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + m[0]).all().map((r) => r.detail).join(' | ');
  assert.match(plan, /SEARCH patients USING COVERING INDEX idx_patients_mrn_seq/, plan);
  const ops = db.prepare('EXPLAIN ' + m[0]).all().map((o) => o.opcode);
  assert.ok(ops.some((o) => /^Seek(LE|LT)$/.test(o)) && ops.includes('Prev'), 'MAX берётся с конца диапазона: ' + ops.join(','));
  assert.ok(!ops.includes('Rewind'), 'перебора карт нет');
  db.close();
});

test('232: 100 000+ карт — выдача номера остаётся дешёвой и проходит сотую тысячу', () => {
  const db = freshDb();
  const yy = yyOf(db);
  const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
  db.transaction(() => {
    for (let n = 1; n <= 99000; n++) ins.run('Легаси', `P-${yy}-${String(n).padStart(5, '0')}`);
  })();
  const N = 2000;
  const t0 = process.hrtime.bigint();
  let last;
  db.transaction(() => { for (let i = 0; i < N; i++) last = register(db); })();
  const perInsertMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.equal(last, `A-${yy}-101000`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, 101000);
  // С перебором всех карт вместо индекса это ~40–80 мс на вставку (211); с
  // индексом — доли миллисекунды. Порог с большим запасом на медленную машину.
  assert.ok(perInsertMs < 5, `вставка с выдачей номера стоит ${perInsertMs.toFixed(3)} мс`);
  db.close();
});
