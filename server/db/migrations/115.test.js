// REFERRAL_CATEGORY_RATES_V1 (мигр. 115) — перенос уже настроенных денег.
//
// Миграция трогает то, по чему клиника ПЛАТИТ партнёрам, поэтому проверяется не
// «колонки появились», а обещание: первая же выгрузка отчёта после обновления
// даёт те же цифры, что накануне. Отсюда и разбор по шагам — категория из
// текста, правило с именем категории, правило с именем источника и их приоритет.
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
const SQL = fs.readFileSync(path.join(DIR, '115_referral_category_rates.sql'), 'utf8');

// База БЕЗ 115: применяем всё до неё, чтобы сначала завести «старый мир» —
// категорию свободным текстом и правила вознаграждения по имени, — а потом
// прогнать саму миграцию и увидеть, что она с ними сделала.
function dbBefore115() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig115-');
  // Миграции ДО 115, а не «все, кроме 115»: более поздние опираются
  // на то, что заводит эта, и без неё падают прямо в подготовке теста.
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 115)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

const source = (db, name, category) =>
  db.prepare('INSERT INTO referral_sources (name, category) VALUES (?, ?)').run(name, category).lastInsertRowid;
const reward = (db, name, percent, active = 1) =>
  db.prepare('INSERT INTO referral_rewards (name, percent, active) VALUES (?, ?, ?)').run(name, percent, active).lastInsertRowid;
const cat = (db, name) =>
  db.prepare('INSERT INTO referral_source_categories (name) VALUES (?)').run(name).lastInsertRowid;

const srcRow = (db, id) => db.prepare('SELECT * FROM referral_sources WHERE id = ?').get(id);
const catByName = (db, name) => db.prepare('SELECT * FROM referral_source_categories WHERE name = ?').get(name);
const catCount = (db) => db.prepare('SELECT COUNT(*) n FROM referral_source_categories').get().n;

test('115: колонки на месте и по умолчанию источник платит по категории', () => {
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', '');
    db.exec(SQL);
    const s = srcRow(db, id);
    assert.equal(s.reward_mode, 'category', 'новый источник должен наследовать ставку категории');
    assert.equal(s.own_percent, 0);
    assert.equal(s.own_rates, '');
    assert.equal(s.category_id, null);
    const c = db.prepare('SELECT * FROM referral_source_categories LIMIT 1').get();
    if (c) { assert.equal(c.standard_percent, 0); assert.equal(c.rates, ''); }
  } finally { db.close(); }
});

test('115: категория из свободного текста становится записью справочника', () => {
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', 'Внешний врач');
    assert.equal(catByName(db, 'Внешний врач'), undefined, 'категории заранее быть не должно');

    db.exec(SQL);

    const c = catByName(db, 'Внешний врач');
    assert.ok(c, 'категория не завелась');
    assert.equal(srcRow(db, id).category_id, c.id, 'источник не связан с категорией');
    assert.equal(srcRow(db, id).category, '', 'текст не погашен — остались два источника правды');
  } finally { db.close(); }
});

test('115: уже существующая категория переиспользуется, а не дублируется', () => {
  const db = dbBefore115();
  try {
    const cid = cat(db, 'Внешний врач');
    const id = source(db, 'Иванов Пётр', '  внешний ВРАЧ ');   // регистр и пробелы по краям
    db.exec(SQL);
    assert.equal(catCount(db), 1, 'завелась вторая категория с тем же названием');
    assert.equal(srcRow(db, id).category_id, cid);
  } finally { db.close(); }
});

test('115: два РАЗНЫХ написания дают две категории — миграция не угадывает опечатку', () => {
  const db = dbBefore115();
  try {
    const a = source(db, 'Иванов', 'Внешный врач');   // опечатка
    const b = source(db, 'Петров', 'Внешний врач');
    db.exec(SQL);
    assert.equal(catCount(db), 2, 'две категории слились — угаданное слияние ставок необратимо');
    assert.notEqual(srcRow(db, a).category_id, srcRow(db, b).category_id);
  } finally { db.close(); }
});

test('115: правило с именем КАТЕГОРИИ становится её стандартным процентом', () => {
  const db = dbBefore115();
  try {
    source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10);
    db.exec(SQL);
    assert.equal(catByName(db, 'Внешний врач').standard_percent, 10);
  } finally { db.close(); }
});

test('115: правило с именем ИСТОЧНИКА переводит его на свою ставку', () => {
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Иванов Пётр', 25);
    db.exec(SQL);
    const s = srcRow(db, id);
    assert.equal(s.reward_mode, 'own');
    assert.equal(s.own_percent, 25);
  } finally { db.close(); }
});

test('115: правило по имени источника перекрывает правило по имени категории', () => {
  // Тот же приоритет, что в сегодняшнем referralsReport: личная ставка сильнее
  // категорийной. Если его переставить, партнёру начнут платить другую сумму.
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10);
    reward(db, 'Иванов Пётр', 25);
    db.exec(SQL);

    const s = srcRow(db, id);
    assert.equal(s.reward_mode, 'own', 'источник со своим правилом остался на категорийной ставке');
    assert.equal(s.own_percent, 25);
    assert.equal(catByName(db, 'Внешний врач').standard_percent, 10, 'категория тоже должна была получить свои 10%');
  } finally { db.close(); }
});

test('115: ВЫКЛЮЧЕННОЕ правило не переносится', () => {
  // Оно не платило вчера и не должно начать платить после обновления —
  // сегодняшний отчёт читает ставки условием active = 1.
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10, 0);
    reward(db, 'Иванов Пётр', 25, 0);
    db.exec(SQL);

    assert.equal(srcRow(db, id).reward_mode, 'category', 'выключенное правило включило свою ставку');
    assert.equal(srcRow(db, id).own_percent, 0);
    assert.equal(catByName(db, 'Внешний врач').standard_percent, 0, 'выключенное правило дало категории процент');
  } finally { db.close(); }
});

test('115: при нескольких правилах с одним именем берётся последнее заведённое', () => {
  // Так ведёт себя сегодняшняя Map: она строится обходом списка, и последнее
  // совпадение затирает прежние. Переносить надо ту ставку, что действует.
  const db = dbBefore115();
  try {
    source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10);
    reward(db, 'Внешний врач', 15);
    db.exec(SQL);
    assert.equal(catByName(db, 'Внешний врач').standard_percent, 15);
  } finally { db.close(); }
});

test('115: правила остаются в базе — это путь назад', () => {
  const db = dbBefore115();
  try {
    source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10);
    db.exec(SQL);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM referral_rewards').get().n, 1,
      'исходные правила снесены — откатиться нечем');
  } finally { db.close(); }
});

test('115: повторный прогон переноса ничего не меняет', () => {
  // Блок переноса объявлен идемпотентным в самой миграции. Проверяется именно
  // это: оператор, разбирающийся с неудачным обновлением, может прогнать его
  // ещё раз, не удвоив категории и не сбив ставки.
  const db = dbBefore115();
  try {
    const id = source(db, 'Иванов Пётр', 'Внешний врач');
    reward(db, 'Внешний врач', 10);
    reward(db, 'Иванов Пётр', 25);
    db.exec(SQL);

    const before = { src: srcRow(db, id), cats: catCount(db), std: catByName(db, 'Внешний врач').standard_percent };
    db.exec(SQL.split('-- ===================== ПЕРЕНОС')[1].replace(/^[^\n]*\n/, ''));

    assert.equal(catCount(db), before.cats, 'повтор удвоил категории');
    assert.equal(catByName(db, 'Внешний врач').standard_percent, before.std);
    assert.deepEqual(srcRow(db, id), before.src, 'повтор изменил источник');
  } finally { db.close(); }
});

// Проверка ЧЕРЕЗ КОМПИЛЯТОР — тем же путём, которым ходит экран настроек, а не
// прямым SQL: прямой INSERT прошёл бы и на непрописанном в реестре поле, и
// дефект «выбранное молча не сохраняется» остался бы незамеченным. Ровно так
// уже была потеряна колонка «Отдел» у кабинетов (108.test.js).
const ADMIN = { id: 1, role: 'admin' };

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
  const c = compile(q, ADMIN);
  const st = db.prepare(c.sql);
  return st.reader ? st.all(c.params || []) : st.run(c.params || []);
};

test('115: ставки по группам долетают до базы и объявлены JSON-колонкой', () => {
  // Две половины круга живут на РАЗНЫХ слоях: сериализует компилятор, а
  // разбирает обратно маршрут /api/db по списку meta.json. Проверяются обе —
  // без второй редактор получил бы строку и нарисовал пустую таблицу ставок.
  const db = liveDb();
  try {
    const rates = [{ type_id: 3, unit: 'pct', value: 20 }, { type_id: 7, unit: 'fix', value: 60000 }];
    exec(db, { op: 'insert', table: 'referral_source_categories',
               values: [{ name: 'Внешний врач', standard_percent: 10, rates }] });

    const raw = db.prepare("SELECT rates, standard_percent FROM referral_source_categories WHERE name = 'Внешний врач'").get();
    assert.equal(raw.standard_percent, 10);
    assert.equal(typeof raw.rates, 'string', 'в SQLite нет jsonb — ставки хранятся текстом');
    assert.deepEqual(JSON.parse(raw.rates), rates, 'ставки не долетели до базы');

    const meta = compile({ op: 'select', table: 'referral_source_categories', columns: ['*'] }, ADMIN).meta;
    assert.ok(meta.json.includes('rates'), 'колонка не объявлена JSON — маршрут вернёт её строкой');
  } finally { setLiveColumns(null); db.close(); }
});

test('115: источник пишет свои ставки и режим тем же путём', () => {
  const db = liveDb();
  try {
    exec(db, { op: 'insert', table: 'referral_source_categories', values: [{ name: 'Внешний врач', standard_percent: 10 }] });
    const cat = db.prepare("SELECT id FROM referral_source_categories WHERE name = 'Внешний врач'").get();
    const own = [{ type_id: 3, unit: 'pct', value: 15 }];
    exec(db, { op: 'insert', table: 'referral_sources',
               values: [{ name: 'Иванов Пётр', category_id: cat.id, reward_mode: 'own', own_percent: 5, own_rates: own }] });

    // Читаем ОТБОРОМ по категории — так список источников и фильтруют экраны.
    const rows = exec(db, { op: 'select', table: 'referral_sources', columns: ['*'],
                            filters: [{ col: 'category_id', op: 'eq', val: cat.id }] });
    assert.equal(rows.length, 1, 'отбор по категории ничего не нашёл');
    assert.equal(rows[0].reward_mode, 'own');
    assert.equal(rows[0].own_percent, 5);
    assert.deepEqual(JSON.parse(rows[0].own_rates), own, 'свои ставки не сохранились');

    const meta = compile({ op: 'select', table: 'referral_sources', columns: ['*'] }, ADMIN).meta;
    assert.ok(meta.json.includes('own_rates'), 'колонка не объявлена JSON — редактор получит строку');
  } finally { setLiveColumns(null); db.close(); }
});
