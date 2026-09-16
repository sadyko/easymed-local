// CUSTOM_ROLES_V1 — своя роль клиники: таблица есть, код у сотрудника хранится,
// права считаются по своей роли, а не по её основе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { readableColumns, writableColumns, canWrite } from '../schema-registry.js';
import { permissionRoles, sectionLevel, canViewSection, patientTabLevel } from '../../services/roles.js';

// Кто вправе писать: реестр не отдаёт список ролей наружу, поэтому спрашиваем
// его тем же вопросом, что и компилятор запросов.
const ROLES_TO_TRY = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];
const writeRoles = (table, op) => ROLES_TO_TRY.filter((r) => canWrite(table, op, r));

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('starshiy-registrator', 'Старший регистратор', 'registrar')").run();
    return db;
}

test('таблица своих ролей есть, читается и правится только администратором; удаления нет', () => {
    const db = seed();
    try {
        const cols = db.prepare('PRAGMA table_info(custom_roles)').all().map((c) => c.name);
        for (const c of ['code', 'name', 'base_role', 'active']) assert.ok(cols.includes(c), 'нет колонки ' + c);
        for (const c of ['code', 'name', 'base_role', 'active']) assert.ok(readableColumns('custom_roles').includes(c), c + ' не читается');
        assert.deepEqual(writableColumns('custom_roles', 'insert').sort(), ['active', 'base_role', 'code', 'name']);
        assert.deepEqual(writableColumns('custom_roles', 'update').sort(), ['active', 'base_role', 'name']);
        // Удаление роли оставило бы людей с кодом, которого нет, — и без прав:
        // ни одна роль его не может (список ролей пуст).
        assert.deepEqual(writeRoles('custom_roles', 'delete'), []);
        assert.deepEqual(writeRoles('custom_roles', 'insert'), ['admin']);
    } finally { db.close(); }
});

test('у сотрудника есть код своей роли, и он читается экранами', () => {
    const db = seed();
    try {
        const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
        assert.ok(cols.includes('custom_role_code'), 'нет колонки users.custom_role_code');
        assert.ok(readableColumns('users').includes('custom_role_code'), 'код своей роли не читается');
        db.prepare("INSERT INTO users (username, password_hash, full_name, role, custom_role_code) VALUES ('reg2','x','Регистратор Два','registrar','starshiy-registrator')").run();
        const u = db.prepare("SELECT role, custom_role_code FROM users WHERE username = 'reg2'").get();
        assert.equal(u.role, 'registrar', 'основа лежит в role — по ней сервер отдаёт данные');
        assert.equal(u.custom_role_code, 'starshiy-registrator');
    } finally { db.close(); }
});

test('права считаются по СВОЕЙ роли, а не по основе: своя роль может видеть меньше', () => {
    const db = seed();
    try {
        db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'")
          .run(JSON.stringify({ sections: ['patients', 'crm'], levels: { patients: 'editor', crm: 'editor' } }));
        db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('starshiy-registrator', ?)")
          .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'viewer' } }));
        const user = { id: 1, role: 'registrar', custom_role_code: 'starshiy-registrator' };
        assert.deepEqual(permissionRoles(user), ['starshiy-registrator']);
        assert.equal(sectionLevel(db, user, 'patients'), 'viewer', 'уровень берётся у своей роли');
        assert.equal(canViewSection(db, user, 'crm'), false, 'чего своей роли не дали — того нет, даже если есть у основы');
        // а обычный регистратор по-прежнему видит CRM
        assert.equal(canViewSection(db, { id: 2, role: 'registrar' }, 'crm'), true);
    } finally { db.close(); }
});

test('своя роль без настроенных прав НЕ запирает человека — работает основа', () => {
    const db = seed();
    try {
        db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'")
          .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'editor' } }));
        const user = { id: 3, role: 'registrar', custom_role_code: 'starshiy-registrator' };   // строки прав ещё нет
        assert.equal(sectionLevel(db, user, 'patients'), 'editor');
    } finally { db.close(); }
});

test('дополнительные роли по-прежнему прибавляются к своей роли', () => {
    const db = seed();
    try {
        db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('starshiy-registrator', ?)")
          .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'viewer' } }));
        db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'cashier'")
          .run(JSON.stringify({ sections: ['cashier'], levels: { cashier: 'admin' } }));
        const user = { id: 4, role: 'registrar', custom_role_code: 'starshiy-registrator', extra_roles: ['cashier'] };
        assert.equal(canViewSection(db, user, 'patients'), true);
        assert.equal(sectionLevel(db, user, 'cashier'), 'admin', 'дополнительная роль добавляет свой раздел');
    } finally { db.close(); }
});

test('вкладки карты пациента тоже решает своя роль', () => {
    const db = seed();
    try {
        db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'")
          .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'editor' }, patient_tabs: { services: 'edit' } }));
        db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('starshiy-registrator', ?)")
          .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'editor' }, patient_tabs: { services: 'none' } }));
        const user = { id: 5, role: 'registrar', custom_role_code: 'starshiy-registrator' };
        assert.equal(patientTabLevel(db, user, 'services'), 'none', 'услуги пациента закрыты своей ролью');
        assert.equal(patientTabLevel(db, { id: 6, role: 'registrar' }, 'services'), 'edit');
    } finally { db.close(); }
});
