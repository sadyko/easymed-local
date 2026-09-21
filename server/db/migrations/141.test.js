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

// Четыре ключа телефонии и заведения карты — то, чем эта миграция распоряжается.
const PHONE_KEYS = ['crm.calls', 'crm.dial', 'crm.recording', 'crm.convert'];
const allNone = () => Object.fromEntries(PHONE_KEYS.map((k) => [k, 'none']));

test('141 выдаёт колл-центру его работу: звонки, набор, записи, заведение пациента', () => {
  const db = freshDb();
  try {
    assert.deepEqual(grantsOf(db, 'callcenter'), {
      'crm.calls': 'view',
      'crm.dial': 'edit',
      'crm.recording': 'edit',
      'crm.convert': 'edit',
    });
    // Старые поля не тронуты: раздел выдаётся по-прежнему миграцией 059.
    const perms = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get().permissions);
    assert.ok(perms.sections.includes('crm'), 'доска заявок пропала из старых полей');
    assert.equal(perms.levels.crm, 'admin');
    // CUST DEV МИГРАЦИЯ НЕ ТРОГАЕТ ВОВСЕ. Раздел выдан старой галочкой (078), и
    // выданный ключ заморозил бы её в положении «можно»: клиника, понизившая
    // оператора до просмотра, получила бы оценки обратно — молчаливое
    // расширение прав. Строки custdev.* существуют на экране, а решает, пока их
    // не настроили, прежняя галочка (rpc/custdev.js, правило перехода).
    for (const k of ['custdev.list', 'custdev.rate']) {
      assert.ok(!(k in grantsOf(db, 'callcenter')), 'миграция выдала ключ Cust Dev: ' + k);
    }
  } finally { db.close(); }
});

test('141 не расширяет никого, кроме колл-центра и регистратуры', () => {
  const db = freshDb();
  try {
    // Регистратура получает РОВНО то, что ей и так даёт код (DIAL_ROLES,
    // CALL_LOG_ROLES): заведения пациента тут нет — у неё свой ключ
    // `registration` с миграции 055.
    assert.deepEqual(grantsOf(db, 'registrar'), {
      'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit',
    });
    // ОСТАЛЬНЫМ ЗАПИСАНО ЯВНОЕ «НЕТ», и это главное, ради чего миграция трогает
    // роли, которым ничего не выдаёт. Оставь их пустыми — и ПЕРВОЕ ЖЕ
    // «Сохранить роль» на экране прав расширило бы им телефонию: экран
    // достраивает ненастроенные ключи из СТАРЫХ полей (roles-matrix.js
    // grantsFromLegacy), а старая галочка `crm` у роли значила доску заявок, и
    // никогда — право позвонить и прослушать чужой разговор.
    for (const role of ['doctor', 'nurse', 'cashier', 'lab', 'inventory', 'head_doctor', 'senior_nurse']) {
      assert.deepEqual(grantsOf(db, role), allNone(), 'роль осталась открытой для расширения: ' + role);
    }
    // АДМИНИСТРАТОР — единственный, кого миграция не трогает: его строки на
    // экране «Роли» нет, матрицу ему не запишут, а ворота пускают его отдельным
    // правилом (grants.js isAdminUser) — в том числе администратора-врача.
    assert.deepEqual(grantsOf(db, 'admin'), {});
    assert.equal(grantAllows(db, { id: 1, role: 'admin' }, 'crm.dial', 'edit', ['admin', 'registrar', 'callcenter']), true);
    assert.equal(grantAllows(db, { id: 2, role: 'doctor', extra_roles: ['admin'] }, 'crm.dial', 'edit', []), true,
      'администратор-врач заперт «Нет», записанным врачу');
    // А рядовому врачу «Нет» значит нет — иначе запись была бы бутафорией.
    assert.equal(grantAllows(db, { id: 3, role: 'doctor' }, 'crm.dial', 'edit', ['admin', 'registrar', 'callcenter']), false);
  } finally { db.close(); }
});

// СВОИ РОЛИ КЛИНИКИ — ТА ЖЕ ЛОВУШКА, ТОЛЬКО ИМЁН ЗАРАНЕЕ НЕ ЗНАЕТ НИКТО.
// «Старшая смена» на основе врача с открытой доской CRM — обычное дело; без
// явного «Нет» первое сохранение выдало бы ей телефон. Роль, чья ОСНОВА звонит
// (регистратура, колл-центр, администратор), не трогается: у неё это право
// есть сегодня, и отнимать его обновление не вправе.
test('141 закрывает телефонию и своим ролям клиники — по ОСНОВЕ, а не по имени', () => {
  const db = freshDb();
  try {
    const mk = (code, base, sections) => {
      db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, code, base);
      db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?,?)')
        .run(code, JSON.stringify({ sections, levels: Object.fromEntries(sections.map((s) => [s, 'admin'])) }));
    };
    mk('starshaya_smena', 'doctor', ['crm', 'patients']);
    mk('starshiy_registrator', 'registrar', ['crm', 'patients']);
    // Так выглядит накат 141 на клинику, где эти роли уже заведены.
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '141%'").run();
    migrate(db);

    assert.deepEqual(grantsOf(db, 'starshaya_smena'), allNone(), 'своя роль на основе врача осталась открытой');
    assert.deepEqual(grantsOf(db, 'starshiy_registrator'), {}, 'у роли на основе регистратуры отняли телефон');
  } finally { db.close(); }
});

// РОЛЬ БЕЗ НАСТРОЕК ПРОПУСКАЛАСЬ МОЛЧА — И ОСТАВАЛАСЬ ОТКРЫТОЙ ДЛЯ РАСШИРЕНИЯ.
//
// Раздел 3 отбирал строки по `json_valid(permissions)` и `permissions NOT LIKE
// '%…%'`. Обе проверки по пустому (и по NULL) значению истиной не бывают,
// поэтому роль, чью строку завели, а матрицу ни разу не трогали, не получала
// ни одного явного «Нет» — и первое же «Сохранить роль» на экране выдало бы ей
// телефонию, выведя её из старой галочки раздела. Пустая строка — достижимая
// форма этой дыры (колонка объявлена NOT NULL ещё в 013), и закрывается она
// тем же COALESCE, что и NULL.
test('141 закрывает телефонию и роли, у которой настроек нет вовсе', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('novaya_rol', '')").run();
    db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('krivaya_rol', 'не json')").run();
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '141%'").run();
    migrate(db);

    assert.deepEqual(grantsOf(db, 'novaya_rol'), allNone(), 'роль без настроек осталась открытой для расширения');
    // Испорченную строку миграция не трогает и трогать не должна: json_patch по
    // не-JSON вернул бы NULL и стёр бы то немногое, что там есть. Такую строку
    // чинит человек, а не обновление.
    assert.equal(db.prepare("SELECT permissions FROM role_permissions WHERE role='krivaya_rol'").get().permissions, 'не json');
  } finally { db.close(); }
});

test('141 идемпотентна: повторный прогон не задваивает и не переписывает', () => {
  const db = freshDb();
  try {
    // Клиника СВОЁ решение уже приняла: оператору запрещено слушать записи…
    const perms = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get().permissions);
    perms.grants['crm.recording'] = 'none';
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='callcenter'").run(JSON.stringify(perms));
    // …а своему главному врачу, наоборот, звонить разрешила. Явное «Нет» из
    // раздела 3 не смеет вернуться поверх этого решения.
    const doc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='doctor'").get().permissions);
    doc.grants['crm.dial'] = 'edit';
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='doctor'").run(JSON.stringify(doc));
    // Забываем ТОЛЬКО эту миграцию — так выглядит её повторный накат; забыть
    // весь журнал значило бы пересоздавать схему с нуля, а проверяем мы не это.
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '141%'").run();

    migrate(db);   // второй проход обязан быть no-op, а не переписать решение
    assert.equal(grantsOf(db, 'callcenter')['crm.recording'], 'none', 'повторный накат перебил решение клиники');
    assert.equal(grantsOf(db, 'doctor')['crm.dial'], 'edit', 'повторный накат отнял выданное клиникой право');
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
