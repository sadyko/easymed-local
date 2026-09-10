// REFERRAL_SOURCE_CODE_V1 (мигр. 121) — номер источника направления.
//
// Номер выдаёт ТРИГГЕР, потому что источники заводятся через общий /api/db, у
// которого серверного обработчика на вставку нет. Поэтому и проверяется он тем
// же путём, каким ходит форма, а не прямым INSERT: прямая вставка доказала бы
// только то, что триггер существует.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама
import { compile, setLiveColumns } from '../query-compiler.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '121_referral_source_code.sql'), 'utf8');

// База БЕЗ 116 — чтобы завести источники «до номеров» и увидеть, что миграция
// с ними сделала.
function dbBefore116() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig116-');
  // Миграции ДО 116, а не «все, кроме 116»: более поздние опираются
  // на то, что заводит эта, и без неё падают прямо в подготовке теста.
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 116)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

function liveDb() {
  const db = openDb(':memory:');
  migrate(db);
  setLiveColumns((t) => {
    const r = db.prepare(`PRAGMA table_info("${t}")`).all();
    return r.length ? new Set(r.map((x) => x.name)) : null;
  });
  return db;
}
const exec = (db, q) => {
  const c = compile(q, q.role ? { id: 1, role: q.role } : { id: 1, role: 'admin' });
  const st = db.prepare(c.sql);
  return st.reader ? st.all(c.params || []) : st.run(c.params || []);
};

const add = (db, name) => db.prepare('INSERT INTO referral_sources (name) VALUES (?)').run(name).lastInsertRowid;
const codeOf = (db, id) => db.prepare('SELECT code FROM referral_sources WHERE id = ?').get(id).code;

test('116: номера начинаются с 0001 и идут подряд', () => {
  const db = liveDb();
  try {
    assert.equal(codeOf(db, add(db, 'Первый')), '0001');
    assert.equal(codeOf(db, add(db, 'Второй')), '0002');
    assert.equal(codeOf(db, add(db, 'Третий')), '0003');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: номер выдаётся и при заведении через /api/db — тем путём, каким ходит форма', () => {
  const db = liveDb();
  try {
    exec(db, { op: 'insert', table: 'referral_sources', values: [{ name: 'Иванов Пётр' }] });
    const row = db.prepare("SELECT code FROM referral_sources WHERE name = 'Иванов Пётр'").get();
    assert.equal(row.code, '0001', 'источник заведён без номера');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: номер выдаётся и регистратору, не только администратору', () => {
  // Регистратор заводит источники по праву реестра — источник без номера
  // появился бы ровно там, где номером пользуются чаще всего.
  const db = liveDb();
  try {
    exec(db, { op: 'insert', table: 'referral_sources', values: [{ name: 'Петров' }], role: 'registrar' });
    assert.equal(db.prepare("SELECT code FROM referral_sources WHERE name = 'Петров'").get().code, '0001');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: удалённый источник НЕ возвращает свой номер следующему', () => {
  // Тот же довод, по которому счета считает invoice_counters, а не COUNT(*):
  // переиспользованный номер означает две разные записи под одним именем в
  // бумагах, которые уже разошлись.
  const db = liveDb();
  try {
    const a = add(db, 'Первый');
    const b = add(db, 'Второй');
    assert.equal(codeOf(db, b), '0002');
    db.prepare('DELETE FROM referral_sources WHERE id IN (?, ?)').run(a, b);
    assert.equal(codeOf(db, add(db, 'Третий')), '0003', 'номер выдан повторно');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: уже заведённым источникам номера раздаются в порядке заведения', () => {
  const db = dbBefore116();
  try {
    const a = add(db, 'Давний');
    const b = add(db, 'Поздний');
    db.exec(SQL);
    assert.equal(codeOf(db, a), '0001');
    assert.equal(codeOf(db, b), '0002');
    // И следующий продолжает с того же места, а не начинает заново.
    assert.equal(codeOf(db, add(db, 'Новый')), '0003');
  } finally { db.close(); }
});

test('116: номер уникален', () => {
  const db = liveDb();
  try {
    add(db, 'Первый');
    assert.throws(() => db.prepare("INSERT INTO referral_sources (name, code) VALUES ('Двойник', '0001')").run(),
      /UNIQUE/i, 'два источника получили один номер');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: заданный вручную номер триггер не перебивает', () => {
  // Оговорка на перенос данных: строка, приехавшая со своим номером, остаётся
  // со своим. Триггер работает только там, где номера нет.
  const db = liveDb();
  try {
    db.prepare("INSERT INTO referral_sources (name, code) VALUES ('Приезжий', '7777')").run();
    assert.equal(db.prepare("SELECT code FROM referral_sources WHERE name = 'Приезжий'").get().code, '7777');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: после 9999 номер РАСТЁТ, а не ломается', () => {
  // printf('%04d') дополняет до четырёх знаков, но не обрезает. Клиника с
  // десятью тысячами партнёров маловероятна, но упереться в формат и перестать
  // заводить источников она не должна.
  const db = liveDb();
  try {
    db.prepare('UPDATE referral_source_counter SET next_seq = 9999 WHERE id = 1').run();
    assert.equal(codeOf(db, add(db, 'Предпоследний')), '9999');
    assert.equal(codeOf(db, add(db, 'Следующий')), '10000');
  } finally { setLiveColumns(null); db.close(); }
});

test('116: номер читается через /api/db, но записать его нельзя', () => {
  // Номер системный: экран его показывает, но не отправляет обратно — иначе
  // его можно было бы переписать из формы и получить двух партнёров с одним
  // номером в уже разосланной ведомости.
  const db = liveDb();
  try {
    exec(db, { op: 'insert', table: 'referral_sources', values: [{ name: 'Иванов' }] });
    const rows = exec(db, { op: 'select', table: 'referral_sources', columns: ['*'] });
    assert.equal(rows[0].code, '0001', 'номер не читается — экран его не покажет');

    assert.throws(() => exec(db, { op: 'update', table: 'referral_sources',
                                   values: { code: '9999' }, filters: [{ col: 'id', op: 'eq', val: rows[0].id }] }),
      /column|not writable|запрещ/i, 'номер удалось переписать через /api/db');
  } finally { setLiveColumns(null); db.close(); }
});
