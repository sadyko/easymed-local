// MY_STOCK_V1 (mig 144) — «Мои запасы» и «Мой отдел» выданы ролям строкой
// матрицы прав, а не спрятаны в списке ролей внутри кода.
//
// Форма проверки — та же, что у 141: выдали что хотели · никому ничего не
// расширили · повторный накат ничего не переписывает. Плюс два теста, ради
// которых миграция и существует: ворота видят ключ, а клиника, снявшая
// галочку, прячет ОБА пункта.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const permsOf = (db, role) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  return JSON.parse(row.permissions);
};
const sectionsOf = (db, role) => permsOf(db, role).sections || [];

// Те, у кого подотчёт есть сегодня (permissions.js MY_STOCK_ROLES).
const HOLDERS = ['admin', 'doctor', 'nurse', 'senior_nurse', 'head_doctor'];
// Те, кому склад на руки не выдаёт: экран был бы у них всегда пустым.
const NON_HOLDERS = ['registrar', 'cashier', 'lab', 'inventory', 'callcenter'];

test('144 выдаёт ключ тем, кому склад выдаёт под отчёт, и администратору', () => {
  const db = freshDb();
  try {
    for (const role of HOLDERS) {
      assert.ok(sectionsOf(db, role).includes('my-stock'),
        'роль осталась без «Моих запасов», хотя товар ей выдают: ' + role);
      assert.equal(permsOf(db, role).levels['my-stock'], 'viewer',
        'уровень не «только просмотр» — экран ничего не пишет: ' + role);
    }
  } finally { db.close(); }
});

test('144 не расширяет тех, кому товар на руки не выдают', () => {
  const db = freshDb();
  try {
    for (const role of NON_HOLDERS) {
      assert.equal(sectionsOf(db, role).includes('my-stock'), false,
        'ключ выдан роли, у которой экран был бы всегда пустым: ' + role);
    }
    // И ничего, кроме одного ключа, миграция не трогает: разделы кассира —
    // те же, что были до наката.
    assert.deepEqual(sectionsOf(db, 'cashier').slice().sort(),
      ['cashier', 'dashboard', 'patients', 'queue', 'reports-hub']);
  } finally { db.close(); }
});

// СВОИ РОЛИ КЛИНИКИ — ПО ОСНОВЕ, А НЕ ПО ИМЕНИ. «Старшая смена» на основе
// медсестры держит товар на руках ровно так же, как медсестра: пропусти мы её,
// обновление молча отняло бы у неё экран.
test('144 выдаёт ключ и своим ролям клиники — по ОСНОВЕ', () => {
  const db = freshDb();
  try {
    const mk = (code, base, sections) => {
      db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, code, base);
      db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?,?)')
        .run(code, JSON.stringify({ sections, levels: Object.fromEntries(sections.map((s) => [s, 'admin'])) }));
    };
    mk('starshaya_smena', 'nurse', ['patients', 'procedures']);
    mk('starshiy_kassir', 'cashier', ['patients', 'cashier']);
    // Так выглядит накат 144 на клинику, где эти роли уже заведены.
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '144%'").run();
    migrate(db);

    assert.ok(sectionsOf(db, 'starshaya_smena').includes('my-stock'),
      'своя роль на основе медсестры потеряла свой подотчёт');
    assert.equal(sectionsOf(db, 'starshiy_kassir').includes('my-stock'), false,
      'ключ выдан роли на основе кассы — товар ей на руки не выдают');
  } finally { db.close(); }
});

test('144 идемпотентна: повторный прогон не задваивает и не переписывает решение клиники', () => {
  const db = freshDb();
  try {
    // Клиника СВОЁ решение уже приняла: медсестре подотчёт закрыла…
    const nurse = permsOf(db, 'nurse');
    nurse.sections = nurse.sections.filter((s) => s !== 'my-stock');
    delete nurse.levels['my-stock'];
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='nurse'").run(JSON.stringify(nurse));
    // …а кассиру, наоборот, открыла.
    const cashier = permsOf(db, 'cashier');
    cashier.sections.push('my-stock');
    cashier.levels['my-stock'] = 'admin';
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='cashier'").run(JSON.stringify(cashier));

    // Забываем ТОЛЬКО эту миграцию — так выглядит её повторный накат.
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '144%'").run();
    migrate(db);

    assert.equal(sectionsOf(db, 'cashier').filter((s) => s === 'my-stock').length, 1,
      'повторный накат задвоил ключ');
    assert.equal(permsOf(db, 'cashier').levels['my-stock'], 'admin',
      'повторный накат перебил уровень, выбранный клиникой');
    // Роль, у которой ключ СНЯЛИ, обновление возвращает: NOT LIKE смотрит на
    // ВЕСЬ текст строки, а `levels` клиника тоже вычистила. Это осознанная
    // цена идиомы 092 — и она честнее обратной: молчаливое «нет» у роли,
    // которой экран нужен, читается как поломка программы.
    assert.ok(sectionsOf(db, 'nurse').includes('my-stock'));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE role='nurse'").get().c, 1);
  } finally { db.close(); }
});

// ЗАЧЕМ МИГРАЦИЯ ВООБЩЕ НУЖНА: ворота читают ИМЕННО ЭТОТ ключ. Без выданной
// строки медсестра после обновления не увидела бы того, что сама же тратит.
test('144: ворота видят выданный ключ, а снятая галочка прячет ОБА пункта', async () => {
  const db = freshDb();
  try {
    globalThis.window = { easymed: { state: { user: { id: 7, role: 'nurse', department_id: 11 } } } };
    const perms = await import('../../../public/js/admin/permissions.js');
    const asRole = (role) => perms.setEffectiveFromRole({ name: role, permissions: permsOf(db, role) });

    asRole('nurse');
    assert.equal(perms.isModuleAllowed('my-stock'), true, 'выданный ключ не открыл «Мои запасы»');
    assert.equal(perms.isModuleAllowed('my-department'), true, 'выданный ключ не открыл «Мой отдел»');

    asRole('cashier');
    assert.equal(perms.isModuleAllowed('my-stock'), false, 'без ключа пункт остался виден');
    assert.equal(perms.isModuleAllowed('my-department'), false,
      'без ключа «Мой отдел» остался виден — ключ был бы бутафорией');
    perms.setFullAccess('Admin');
    delete globalThis.window;
  } finally { db.close(); }
});
