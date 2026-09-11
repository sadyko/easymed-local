#!/usr/bin/env node
// FACILITY_PLAN_V1 — ДЕМО-КЛИНИКА ДЛЯ РАЗРАБОТЧИКА. Только для базы разработки.
//
// Владелец просил «realistic demo data» для плана клиники. Это боевой продукт:
// выдуманные этажи, отделения и врачи не имеют права попасть в базу клиники,
// поэтому демо живёт здесь — отдельным скриптом, который запускают руками на
// СВОЕЙ базе, — а не в миграции и не в установке.
//
//   node scripts/seed-demo-hospital.mjs [путь/к/easymed.db]
//
// Скрипт идемпотентен по имени: повторный запуск ничего не дублирует. Он не
// трогает существующие строки — только добавляет отсутствующие.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, '..', 'data', 'easymed.db');
const db = openDb(file);
migrate(db);

const FLOORS = [['Цокольный этаж', 0], ['1 этаж', 1], ['2 этаж', 2], ['3 этаж', 3]];
const DEPTS = [
    ['Кардиология', 'clinical'], ['Неврология', 'clinical'], ['Педиатрия', 'clinical'], ['Гинекология', 'clinical'],
    ['Урология', 'clinical'], ['Общая хирургия', 'inpatient'], ['ЛОР', 'clinical'], ['Офтальмология', 'clinical'],
    ['Лаборатория', 'laboratory'], ['Лучевая диагностика', 'diagnostics'],
];
// [этаж, отделение, код, название, тип, врачи…]
const ROOMS = [
    [1, 'Кардиология', '101', 'Кабинет 101', 'consultation', 'Каримов Азиз', 'Алиева Мадина'],
    [1, 'Кардиология', '102', 'Кабинет 102', 'consultation', 'Ахмедов Рустам'],
    [1, 'Кардиология', '103', 'Кабинет ЭКГ', 'diagnostics'],
    [1, 'Лаборатория', '110', 'Забор крови', 'laboratory'],
    [1, 'Лаборатория', '111', 'Биохимия', 'laboratory'],
    [1, 'Лучевая диагностика', '120', 'УЗИ', 'diagnostics', 'Саидова Нилуфар'],
    [1, 'Лучевая диагностика', '121', 'Рентген', 'diagnostics'],
    [1, null, '100', 'Регистратура', 'reception'],
    [1, null, '104', 'Процедурная', 'procedure'],
    [2, 'Неврология', '201', 'Кабинет 201', 'consultation', 'Юсупов Бахтиёр'],
    [2, 'Неврология', '202', 'Кабинет 202', 'consultation', 'Рахимова Дилноза'],
    [2, 'Общая хирургия', '210', 'Операционная 1', 'operating'],
    [2, 'Общая хирургия', '211', 'Перевязочная', 'procedure'],
    [2, 'Общая хирургия', '212', 'Кабинет хирурга', 'consultation', 'Тошев Жасур', 'Мирзаев Улугбек'],
    [2, 'ЛОР', '220', 'Кабинет ЛОР', 'consultation', 'Эргашев Жахонгир'],
    [2, 'Офтальмология', '230', 'Кабинет офтальмолога', 'consultation', 'Назарова Гулноза'],
    [2, 'Урология', '240', 'Кабинет уролога', 'consultation', 'Мирзақулов Эломон'],
    [3, 'Педиатрия', '301', 'Кабинет педиатра', 'consultation', 'Холматова Севара', 'Абдуллаев Шерзод'],
    [3, 'Педиатрия', '302', 'Кабинет педиатра 2', 'consultation', 'Умарова Зарина'],
    [3, 'Гинекология', '310', 'Кабинет гинеколога', 'consultation', 'Исмаилова Нигора'],
    [3, 'Гинекология', '311', 'Смотровая', 'procedure'],
    [0, null, 'B1', 'Склад', 'utility'],
    [0, 'Лаборатория', 'B2', 'Стерилизационная', 'utility'],
];
// [этаж, отделение, код, название, тип, коек]
const WARDS = [
    [2, 'Общая хирургия', 'П1', 'Палата 1', 'general', 4],
    [2, 'Общая хирургия', 'П2', 'Палата 2', 'general', 4],
    [2, 'Общая хирургия', 'ПИТ', 'Реанимация', 'icu', 2],
    [3, 'Педиатрия', 'П3', 'Детская палата', 'pediatrics', 6],
    [3, 'Гинекология', 'П4', 'Послеродовая', 'maternity', 3],
];
const EQUIPMENT = ['ЭКГ-аппарат', 'Кушетка', 'Тонометр', 'УЗИ-сканер', 'Рентген-аппарат', 'Центрифуга', 'Анализатор', 'Наркозный аппарат',
    'Операционный стол', 'Монитор пациента', 'Инфузионный насос', 'Весы', 'Офтальмоскоп', 'Отоскоп', 'Кресло гинекологическое'];
const ROOM_EQ = { 101: ['ЭКГ-аппарат', 'Кушетка', 'Тонометр'], 102: ['Кушетка', 'Тонометр'], 103: ['ЭКГ-аппарат'], 110: ['Центрифуга', 'Кушетка'], 111: ['Анализатор'],
    120: ['УЗИ-сканер', 'Кушетка'], 121: ['Рентген-аппарат'], 210: ['Операционный стол', 'Наркозный аппарат', 'Монитор пациента'], 220: ['Отоскоп'], 230: ['Офтальмоскоп'],
    301: ['Весы', 'Кушетка'], 310: ['Кресло гинекологическое'] };
const SPECIALTY = { 'Каримов Азиз': 'Кардиолог', 'Алиева Мадина': 'Кардиолог', 'Ахмедов Рустам': 'Кардиолог', 'Саидова Нилуфар': 'Врач УЗД',
    'Юсупов Бахтиёр': 'Невролог', 'Рахимова Дилноза': 'Невролог', 'Тошев Жасур': 'Хирург', 'Мирзаев Улугбек': 'Хирург', 'Эргашев Жахонгир': 'ЛОР',
    'Назарова Гулноза': 'Офтальмолог', 'Мирзақулов Эломон': 'Уролог', 'Холматова Севара': 'Педиатр', 'Абдуллаев Шерзод': 'Педиатр',
    'Умарова Зарина': 'Педиатр', 'Исмаилова Нигора': 'Гинеколог' };

const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const grid = (i) => ({ x: 32 + (i % 4) * 208, y: 32 + Math.floor(i / 4) * 128 });

db.transaction(() => {
    const floorId = {};
    for (const [name, level] of FLOORS) {
        const f = one('SELECT id FROM floors WHERE name = ?', name);
        floorId[level] = f ? f.id : run('INSERT INTO floors (name, level) VALUES (?, ?)', name, level).lastInsertRowid;
    }
    const deptId = {};
    for (const [name, kind] of DEPTS) {
        const d = one('SELECT id FROM departments WHERE name = ?', name);
        deptId[name] = d ? d.id : run('INSERT INTO departments (name, kind) VALUES (?, ?)', name, kind).lastInsertRowid;
    }
    const eqId = {};
    for (const name of EQUIPMENT) {
        const e = one('SELECT id FROM equipment WHERE name = ?', name);
        eqId[name] = e ? e.id : run('INSERT INTO equipment (name) VALUES (?)', name).lastInsertRowid;
    }
    const perFloor = {};
    for (const [lvl, dept, code, name, type, ...docs] of ROOMS) {
        const i = (perFloor[lvl] = (perFloor[lvl] || 0) + 1) - 1;
        let r = one('SELECT id FROM rooms WHERE name = ?', name);
        if (!r) {
            const p = grid(i);
            r = { id: run('INSERT INTO rooms (name, code, room_type, floor_id, department_id, plan_x, plan_y, plan_w, plan_h) VALUES (?,?,?,?,?,?,?,176,96)',
                name, code, type, floorId[lvl], dept ? deptId[dept] : null, p.x, p.y).lastInsertRowid };
        }
        for (const doc of docs) {
            const u = one('SELECT id FROM users WHERE full_name = ?', doc);
            const login = 'demo_' + doc.toLowerCase().replace(/[^a-zа-яё]+/gi, '_');
            const id = u ? u.id : run("INSERT INTO users (username, password_hash, full_name, role, is_doctor, specialty, is_active) VALUES (?, 'demo', ?, 'doctor', 1, ?, 1)",
                login, doc, SPECIALTY[doc] || '').lastInsertRowid;
            run('UPDATE users SET room_id = ? WHERE id = ? AND room_id IS NULL', r.id, id);
        }
        for (const e of ROOM_EQ[code] || []) {
            if (!one('SELECT id FROM room_equipment WHERE room_id = ? AND equipment_id = ?', r.id, eqId[e])) {
                run('INSERT INTO room_equipment (room_id, equipment_id, quantity) VALUES (?, ?, 1)', r.id, eqId[e]);
            }
        }
    }
    for (const [lvl, dept, code, name, type, beds] of WARDS) {
        const i = (perFloor[lvl] = (perFloor[lvl] || 0) + 1) - 1;
        let w = one('SELECT id FROM wards WHERE name = ?', name);
        if (!w) {
            const p = grid(i);
            w = { id: run('INSERT INTO wards (name, code, type, floor_id, department_id, billing_mode, price_per_day, plan_x, plan_y, plan_w, plan_h) VALUES (?,?,?,?,?,\'daily\',150000,?,?,208,112)',
                name, code, type, floorId[lvl], deptId[dept], p.x, p.y).lastInsertRowid };
            for (let b = 1; b <= beds; b++) run('INSERT INTO beds (code, ward_id, status) VALUES (?, ?, ?)', String(b), w.id, b === 1 ? 'occupied' : 'free');
        }
    }
})();

const n = (t) => one('SELECT COUNT(*) AS n FROM ' + t).n;
console.log('demo hospital in', file);
console.log('floors', n('floors'), '· departments', n('departments'), '· rooms', n('rooms'), '· wards', n('wards'), '· beds', n('beds'),
    '· doctors', one("SELECT COUNT(*) AS n FROM users WHERE is_doctor = 1").n, '· equipment', n('equipment'), '· placed', n('room_equipment'));
db.close();
