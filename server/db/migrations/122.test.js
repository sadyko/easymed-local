// INTERNAL_REFERRAL_V1 (мигр. 122) — наш врач как источник направления.
//
// Смысл миграции в том, что внутренний врач — ОБЫЧНЫЙ источник: тогда
// двухшаговый выбор в мастере, номер, отчёт и ставки работают без единой
// оговорки. Поэтому проверяется не «колонка появилась», а именно это: врач
// виден там же, где партнёры, и ведёт себя так же.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile, setLiveColumns } from '../query-compiler.js';

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
  const c = compile(q, { id: 1, role: 'admin' });
  const st = db.prepare(c.sql);
  return st.reader ? st.all(c.params || []) : st.run(c.params || []);
};

const doctor = (db, full_name, is_active = 1) => db.prepare(
  "INSERT INTO users (username, password_hash, role, full_name, is_active) VALUES (?, 'x', 'doctor', ?, ?)")
  .run('u' + Math.random().toString(36).slice(2, 8), full_name, is_active).lastInsertRowid;
const srcOfDoctor = (db, id) => db.prepare('SELECT * FROM referral_sources WHERE doctor_id = ?').get(id);
const internalCat = (db) => db.prepare('SELECT * FROM referral_source_categories WHERE is_internal = 1').get();

test('117: категория внутренних врачей заведена и помечена ФЛАГОМ, а не названием', () => {
  const db = liveDb();
  try {
    const c = internalCat(db);
    assert.ok(c, 'категории внутренних врачей нет');
    assert.equal(c.is_internal, 1);
    // Переименование не должно менять поведение — на то и флаг.
    db.prepare('UPDATE referral_source_categories SET name = ? WHERE id = ?').run('Наши доктора', c.id);
    assert.equal(internalCat(db).id, c.id, 'переименование потеряло категорию');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: новый врач сразу становится источником в этой категории', () => {
  const db = liveDb();
  try {
    const id = doctor(db, 'Жалилова Зарифа');
    const src = srcOfDoctor(db, id);
    assert.ok(src, 'у врача нет источника — его не будет в списке «кто направил»');
    assert.equal(src.name, 'Жалилова Зарифа');
    assert.equal(src.category_id, internalCat(db).id);
    assert.equal(src.active, 1);
    // REFERRAL_SOURCE_CODE_V1 — номер выдаётся тем же триггером, что партнёрам.
    assert.match(src.code, /^\d{4,}$/, 'врач остался без номера');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: врач без ФИО подписан логином, а не пустой строкой', () => {
  const db = liveDb();
  try {
    const id = db.prepare("INSERT INTO users (username, password_hash, role, full_name, is_active) VALUES ('petrov','x','doctor','',1)").run().lastInsertRowid;
    assert.equal(srcOfDoctor(db, id).name, 'petrov');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: переименование врача переносится на источник', () => {
  // Иначе регистратор видел бы в списке «кто направил» прежнее ФИО.
  const db = liveDb();
  try {
    const id = doctor(db, 'Иванова Мария');
    db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run('Петрова Мария', id);
    assert.equal(srcOfDoctor(db, id).name, 'Петрова Мария');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: уволенный врач перестаёт предлагаться, но источник и его ставки остаются', () => {
  const db = liveDb();
  try {
    const id = doctor(db, 'Уволенный Врач');
    db.prepare("UPDATE referral_sources SET reward_mode='own', own_percent=12 WHERE doctor_id=?").run(id);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);

    const src = srcOfDoctor(db, id);
    assert.equal(src.active, 0, 'уволенный продолжает предлагаться регистратору');
    assert.equal(src.own_percent, 12, 'ставка потеряна вместе с увольнением');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: один источник на врача', () => {
  const db = liveDb();
  try {
    const id = doctor(db, 'Единственный');
    assert.throws(() => db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Двойник', ?)").run(id),
      /UNIQUE/i, 'у врача завелось два источника');
    // А у внешних партнёров doctor_id пустой — их должно быть можно заводить сколько угодно.
    db.prepare("INSERT INTO referral_sources (name) VALUES ('Партнёр 1')").run();
    db.prepare("INSERT INTO referral_sources (name) VALUES ('Партнёр 2')").run();
  } finally { setLiveColumns(null); db.close(); }
});

test('117: врач выбирается тем же двухшаговым списком, что и партнёры', () => {
  // Ради этого всё и сделано: мастер записи не знает про «внутренние
  // направления» ничего особенного — он отбирает источники по категории.
  const db = liveDb();
  try {
    const id = doctor(db, 'Каххоров Сирожиддин');
    const cat = internalCat(db);
    const rows = exec(db, { op: 'select', table: 'referral_sources', columns: ['*'],
                            filters: [{ col: 'category_id', op: 'eq', val: cat.id },
                                      { col: 'active', op: 'eq', val: 1 }] });
    assert.ok(rows.some(r => r.doctor_id === id), 'врача нет в отборе по внутренней категории');
  } finally { setLiveColumns(null); db.close(); }
});

test('117: ставка внутреннего врача читается общим механизмом', () => {
  // Стандартная — на категории, своя — у врача. Никакого второго механизма.
  const db = liveDb();
  try {
    const id = doctor(db, 'Набиев Ойбек');
    const cat = internalCat(db);
    db.prepare('UPDATE referral_source_categories SET standard_percent = 7 WHERE id = ?').run(cat.id);

    let src = srcOfDoctor(db, id);
    assert.equal(src.reward_mode, 'category', 'врач по умолчанию должен идти по стандарту категории');

    db.prepare("UPDATE referral_sources SET reward_mode='own', own_percent=15 WHERE doctor_id=?").run(id);
    src = srcOfDoctor(db, id);
    assert.equal(src.own_percent, 15);
  } finally { setLiveColumns(null); db.close(); }
});
