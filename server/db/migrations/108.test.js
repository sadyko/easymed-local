// ROOMS_WARDS_DEPT_V1 — кабинеты и палаты принадлежат отделу.
//
// Владелец: «we should be able to create another departments and add rooms and
// doctors to them». Врачи к отделу были привязаны и раньше (users.department_id),
// кабинеты и палаты — нет.
//
// Отдельно про то, ЧТО именно было сломано: экран настроек кабинетов уже
// показывал колонку «Отдел» и поле выбора (разметка ROOMS_DEPT_FLOOR_V1), но
// колонки rooms.department_id не существовало. Колонка стояла пустой у каждого
// кабинета, а выбранный отдел сохранить было некуда: реестр такого поля не знал
// и молча его отбрасывал. Поэтому проверка идёт ЧЕРЕЗ компилятор — то есть тем
// же путём, которым ходит экран, — а не прямым SQL: прямой INSERT прошёл бы и
// на непрописанном в реестре поле, и дефект остался бы незамеченным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile, setLiveColumns } from '../query-compiler.js';

const ADMIN = { id: 1, role: 'admin' };

function fresh() {
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

test('отдел можно завести, и кабинет с палатой к нему привязываются', () => {
    const db = fresh();
    try {
        exec(db, { op: 'insert', table: 'departments', values: [{ name: 'Физиотерапия', kind: 'clinical', active: 1 }] });
        const dep = db.prepare("SELECT id FROM departments WHERE name = 'Физиотерапия'").get();
        assert.ok(dep, 'отдел не завёлся');

        exec(db, { op: 'insert', table: 'rooms', values: [{ name: 'Кабинет 12', department_id: dep.id, room_type: 'procedure', active: 1 }] });
        exec(db, { op: 'insert', table: 'wards', values: [{ name: 'Палата 3', department_id: dep.id, type: 'general', active: 1 }] });

        // Читаем ФИЛЬТРОМ по отделу — так список настроек и отбирает.
        for (const t of ['rooms', 'wards']) {
            const rows = exec(db, { op: 'select', table: t, columns: ['*'], filters: [{ col: 'department_id', op: 'eq', val: dep.id }] });
            assert.equal(rows.length, 1, t + ': отбор по отделу ничего не нашёл');
            assert.equal(rows[0].department_id, dep.id, t + ': отдел не сохранился');
        }
    } finally { setLiveColumns(null); db.close(); }
});

test('удаление отдела НЕ уносит кабинет вместе с расписанием', () => {
    // Каскад тут был бы бедой: на кабинет ссылаются визиты и расписание.
    // Кабинет остаётся без отдела — это видно в списке и чинится выбором.
    const db = fresh();
    try {
        db.prepare('PRAGMA foreign_keys = ON').run();
        exec(db, { op: 'insert', table: 'departments', values: [{ name: 'Физиотерапия', kind: 'clinical', active: 1 }] });
        const dep = db.prepare("SELECT id FROM departments WHERE name = 'Физиотерапия'").get();
        exec(db, { op: 'insert', table: 'rooms', values: [{ name: 'Кабинет 12', department_id: dep.id, active: 1 }] });

        db.prepare('DELETE FROM departments WHERE id = ?').run(dep.id);
        const room = db.prepare("SELECT name, department_id FROM rooms WHERE name = 'Кабинет 12'").get();
        assert.ok(room, 'кабинет исчез вместе с отделом');
        assert.equal(room.department_id, null, 'ссылка на удалённый отдел осталась');
    } finally { setLiveColumns(null); db.close(); }
});

test('шесть отделов посеяны и КАЖДЫЙ можно удалить', () => {
    // Владелец: «hardcode (but with option to delete)». Посев есть с миграции
    // 038; проверяем именно вторую половину — что ни один не защищён от удаления.
    const db = fresh();
    try {
        const before = db.prepare('SELECT id, name FROM departments ORDER BY id').all();
        assert.equal(before.length, 6, 'посеяно не шесть отделов: ' + before.map((d) => d.name).join(', '));
        for (const d of before) db.prepare('DELETE FROM departments WHERE id = ?').run(d.id);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM departments').get().n, 0, 'какой-то отдел удалить не дали');
    } finally { setLiveColumns(null); db.close(); }
});
