// STAR_MEETS_SCHEMA_V1 — «звёздочка» не просит колонок, которых в базе нет.
//
// ЖИВОЙ СЛУЧАЙ. Владелец увидел «Раздел не загрузился: запрос к базе отклонён —
// patient_categories — unknown column». Реестр объявлял `discount_percent`
// читаемой (её заводит миграция 107), раздел настроек шёл со `select('*')`,
// звёздочка разворачивалась ПО РЕЕСТРУ — и в SQL попадала колонка, которой на
// той установке ещё не было: база стояла на 106. Раздел не открывался целиком,
// хотя три категории в нём лежали.
//
// Это не частный случай, а ОКНО между обновлением программы и применением
// миграций: код у клиники всегда новее базы хотя бы до перезапуска. Пока
// звёздочка разворачивалась по реестру, в этом окне гас каждый экран, читающий
// свою таблицу целиком.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { compile, setLiveColumns } from './query-compiler.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };

function dbWithout(column) {
    // База «на миграцию раньше»: та же таблица, но без новой колонки.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE patient_categories (
        id INTEGER PRIMARY KEY, name TEXT, tier TEXT, active INTEGER DEFAULT 1, created_at TEXT
        ${column ? ', ' + column + ' REAL NOT NULL DEFAULT 0' : ''});`);
    db.exec("INSERT INTO patient_categories (name, active) VALUES ('vip', 1), ('sotrudnik', 1);");
    return db;
}

function useLive(db) {
    setLiveColumns((t) => {
        try {
            const r = db.prepare(`PRAGMA table_info("${t}")`).all();
            return r.length ? new Set(r.map((x) => x.name)) : null;
        } catch { return null; }
    });
}

test('звёздочка на базе БЕЗ новой колонки — раздел открывается', () => {
    const db = dbWithout(null);
    useLive(db);
    try {
        const { sql, params } = compile(
            { op: 'select', table: 'patient_categories', columns: ['*'], filters: [] }, ADMIN);
        assert.ok(!/discount_percent/.test(sql),
            'в SQL попала колонка, которой в этой базе нет: ' + sql);
        const rows = db.prepare(sql).all(params || []);
        assert.deepEqual(rows.map((r) => r.name), ['vip', 'sotrudnik']);
    } finally { setLiveColumns(null); db.close(); }
});

test('когда колонка есть — она приезжает, ничего не потеряно', () => {
    const db = dbWithout('discount_percent');
    useLive(db);
    try {
        const { sql, params } = compile(
            { op: 'select', table: 'patient_categories', columns: ['*'], filters: [] }, ADMIN);
        assert.ok(/discount_percent/.test(sql), 'существующая колонка пропала из выборки');
        const rows = db.prepare(sql).all(params || []);
        assert.equal(rows[0].discount_percent, 0);
    } finally { setLiveColumns(null); db.close(); }
});

test('послабление касается ТОЛЬКО звёздочки: выдуманная колонка по-прежнему отвергается', () => {
    // Опечатка в виде обязана падать, а не возвращать неполные данные молча:
    // пустое поле выглядит как пустое поле, и такой дефект живёт годами.
    //
    // А вот колонка, которая В РЕЕСТРЕ ЕСТЬ и названа явно, компилятором
    // пропускается и падает уже на SQLite. Это НАМЕРЕННО: вид, перечисливший
    // поля поимённо, ждёт именно их, и тихо выбросить одно из них — значит
    // отдать ему данные, которых он не просил. Такие места чинятся в самом виде
    // запасным запросом (см. categorySelect в patient-create-modal.js).
    const db = dbWithout(null);
    useLive(db);
    try {
        assert.throws(() => compile(
            { op: 'select', table: 'patient_categories', columns: ['id', 'favourite_colour'], filters: [] },
            ADMIN), /unknown column/);
    } finally { setLiveColumns(null); db.close(); }
});

test('без сведений о схеме поведение прежнее — разворот по реестру', () => {
    // Компилятор зовут и вне маршрута (тесты, служебные пути): там живой базы
    // нет, и звёздочка обязана работать по-старому, а не схлопываться в ничто.
    setLiveColumns(null);
    const { sql } = compile(
        { op: 'select', table: 'patient_categories', columns: ['*'], filters: [] }, ADMIN);
    assert.ok(/discount_percent/.test(sql), 'без живой схемы разворот обязан идти по реестру');
});
