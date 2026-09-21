// CALLCENTER_OPERATOR_V1 (mig 141) — работа оператора колл-центра выдана ему
// строками матрицы прав, а не спрятана в списках ролей внутри кода.
//
// Форма проверки — та же, что у 059 (роль callcenter): выдали что хотели ·
// никому ничего не расширили · повторный накат ничего не удваивает. Плюс один
// тест, ради которого миграция и существует: регистратура не теряет телефон.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { telephonyDial, crmLeadCalls } from '../../services/rpc/telephony.js';
import { grantAllows } from '../../services/grants.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const grantsOf = (db, role) =>
  (JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions).grants) || {};

test('141 выдаёт колл-центру его работу: звонки, набор, записи, Cust Dev, заведение пациента', () => {
  const db = freshDb();
  try {
    assert.deepEqual(grantsOf(db, 'callcenter'), {
      'crm.calls': 'view',
      'crm.dial': 'edit',
      'crm.recording': 'edit',
      'crm.convert': 'edit',
      'custdev.list': 'view',
      'custdev.rate': 'edit',
    });
    // Старые поля не тронуты: раздел выдаётся по-прежнему миграцией 059.
    const perms = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get().permissions);
    assert.ok(perms.sections.includes('crm'), 'доска заявок пропала из старых полей');
    assert.equal(perms.levels.crm, 'admin');
  } finally { db.close(); }
});

test('141 не расширяет никого, кроме колл-центра и регистратуры', () => {
  const db = freshDb();
  try {
    // Регистратура получает РОВНО то, что ей и так даёт код (DIAL_ROLES,
    // CALL_LOG_ROLES): ни заведения пациента, ни Cust Dev тут нет.
    assert.deepEqual(grantsOf(db, 'registrar'), {
      'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit',
    });
    // Остальные роли строк матрицы не получили вовсе — для них действует
    // правило перехода, то есть прежнее поведение.
    for (const role of ['doctor', 'nurse', 'cashier', 'lab', 'inventory', 'admin', 'head_doctor', 'senior_nurse']) {
      assert.deepEqual(grantsOf(db, role), {}, 'миграция тронула роль ' + role);
    }
    // И сам admin по-прежнему звонит — списком ролей из кода.
    assert.equal(grantAllows(db, { id: 1, role: 'admin' }, 'crm.dial', 'edit', ['admin', 'registrar', 'callcenter']), true);
  } finally { db.close(); }
});

test('141 идемпотентна: повторный прогон не задваивает и не переписывает', () => {
  const db = freshDb();
  try {
    // Клиника СВОЁ решение уже приняла: оператору запрещено слушать записи.
    const perms = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get().permissions);
    perms.grants['crm.recording'] = 'none';
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='callcenter'").run(JSON.stringify(perms));
    // Забываем ТОЛЬКО эту миграцию — так выглядит её повторный накат; забыть
    // весь журнал значило бы пересоздавать схему с нуля, а проверяем мы не это.
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '141%'").run();

    migrate(db);   // второй проход обязан быть no-op, а не переписать решение
    assert.equal(grantsOf(db, 'callcenter')['crm.recording'], 'none', 'повторный накат перебил решение клиники');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE role='callcenter'").get().c, 1);
  } finally { db.close(); }
});

// ЗАЧЕМ МИГРАЦИЯ ВООБЩЕ НУЖНА. Ворота телефонии больше не читают список ролей
// напрямую — они спрашивают матрицу и падают на список только для ролей, у
// которых ключа нет. Регистратура обязана звонить и до, и после этого, а
// выданный ключ переживает ещё и первое «Сохранить роль» на экране прав.
test('141: регистратура звонит и видит журнал — до всякой настройки на экране', () => {
  const db = freshDb();
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(7, 'reg', 'x', 'registrar');
    const reg = { id: 7, role: 'registrar' };
    assert.deepEqual(crmLeadCalls(db, { phone: '+998901234567' }, reg), [], 'журнал звонков закрылся регистратуре');
    // Набор доходит до телефонии (линии нет — отказ станции, но НЕ 403 матрицы).
    return telephonyDial(db, { phone: '+998901234567' }, reg).then(
      () => { throw new Error('звонок не мог пройти: линии нет'); },
      (e) => { assert.equal(e.status, 400, 'ворота прав отказали регистратуре вместо телефонии'); },
    ).finally(() => db.close());
  } catch (e) { db.close(); throw e; }
});
