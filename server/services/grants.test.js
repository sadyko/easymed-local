// GRANTS_V1 — права по справочнику: настройка роли меняет ответ ворот, а её
// отсутствие оставляет всё, как было.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { grantLevel, grantAllows, requireGrant, GrantError } from './grants.js';
import { admissionVitalsAdd, admissionVitalsList, admissionVitalsDelete } from './rpc/vitals.js';
import { CATALOG, catalogRows, levelAllows } from '../../public/js/shared/permission-catalog.js';

const NURSE = { id: 31, role: 'nurse', extra_roles: [] };
const REG   = { id: 32, role: 'registrar', extra_roles: [] };
const CUSTOM = { id: 33, role: 'nurse', extra_roles: [], custom_role_code: 'palatnaya' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)');
  mk.run(31, 'nurse1', 'x', 'Медсестра', 'nurse', null);
  mk.run(32, 'reg1', 'x', 'Регистратор', 'registrar', null);
  mk.run(33, 'nurse2', 'x', 'Палатная', 'nurse', 'palatnaya');
  return db;
}
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = grants;
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('без настройки — как было: список ролей из кода решает', () => {
  const db = seed();
  try {
    assert.equal(grantLevel(db, NURSE, 'inpatient.vitals'), null, 'у роли не должно быть записи, пока её не настроили');
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'edit', ['nurse', 'admin']), true);
    assert.equal(grantAllows(db, REG, 'inpatient.vitals', 'edit', ['nurse', 'admin']), false);
  } finally { db.close(); }
});

test('настроенный уровень главнее списка из кода — и в обе стороны', () => {
  const db = seed();
  try {
    // Заведующая ЗАКРЫЛА медсестре измерения — список из кода уже не спасает.
    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'edit', ['nurse', 'admin']), false);
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'view', ['nurse', 'admin']), true);
    // И ОТКРЫЛА регистратуре — хотя в коде её никогда не было.
    setGrants(db, 'registrar', { 'inpatient.vitals': 'edit' });
    assert.equal(grantAllows(db, REG, 'inpatient.vitals', 'edit', ['nurse', 'admin']), true);
  } finally { db.close(); }
});

test('уровни вложены: «удаление» даёт и «изменение», и «просмотр»', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'delete' });
    for (const need of ['view', 'edit', 'delete']) assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', need, []), true, need);
    setGrants(db, 'nurse', { 'inpatient.vitals': 'none' });
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'view', ['nurse']), false, '«Нет» — это нет, даже если код разрешал');
  } finally { db.close(); }
});

test('несколько ролей — самая щедрая; своя роль клиники ЗАМЕНЯЕТ основу', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'none' });
    setGrants(db, 'senior_nurse', { 'inpatient.vitals': 'edit' });
    const both = { id: 31, role: 'nurse', extra_roles: ['senior_nurse'] };
    assert.equal(grantLevel(db, both, 'inpatient.vitals'), 'edit', 'дополнительная роль — прибавка');

    // Своя роль «Палатная» на основе медсестры: пока строки нет — как медсестра.
    assert.equal(grantLevel(db, CUSTOM, 'inpatient.vitals'), 'none');
    setGrants(db, 'palatnaya', { 'inpatient.vitals': 'delete' });
    assert.equal(grantLevel(db, CUSTOM, 'inpatient.vitals'), 'delete', 'своя роль не заменила основу');
  } finally { db.close(); }
});

// CALLCENTER_OPERATOR_V1 — АДМИНИСТРАТОР ПРОХОДИТ ВСЕГДА, И ЭТО ПРО АДМИНА-ВРАЧА.
//
// Строку админа экран «Роли» не рисует (ROLE_LIST её не содержит), то есть
// настроить его матрицу нельзя в принципе — и «Нет» у него взяться неоткуда.
// А вот прочитаться чужое «Нет» у него могло: у администратора клиники
// ОСНОВНАЯ роль сплошь и рядом `doctor`, а `admin` стоит дополнительной
// (ADMIN_DOCTOR_V1). grantLevel() берёт САМЫЙ ЩЕДРЫЙ уровень из его ролей, но
// щедрее «Нет» у врача ничего нет, если админ ключа не настраивал, — и
// администратор клиники оставался бы без звонка ровно после того, как миграция
// 141 проставит врачу явные `none`.
//
// Предикат — тот же `hasAnyRole(user, ['admin'])`, что у всех админских ворот
// (rpc/backup.js, rpc/telephony.js requireAdmin): один ответ на вопрос «это
// администратор?» во всей программе.
test('администратор проходит, даже если его ВРАЧЕБНОЙ роли ключ запрещён (ADMIN_DOCTOR_V1)', () => {
  const db = seed();
  try {
    setGrants(db, 'doctor', { 'inpatient.vitals': 'none', 'crm.dial': 'none' });
    const adminDoctor = { id: 34, role: 'doctor', extra_roles: ['admin'] };
    const doctor = { id: 35, role: 'doctor', extra_roles: [] };

    assert.equal(grantAllows(db, doctor, 'crm.dial', 'edit', ['registrar']), false, 'врачу «Нет» обязано значить нет');
    assert.equal(grantAllows(db, adminDoctor, 'crm.dial', 'edit', ['registrar']), true,
      'администратор клиники заперт «Нет» своей врачебной роли');
    assert.equal(grantAllows(db, adminDoctor, 'inpatient.vitals', 'delete', []), true);
    assert.doesNotThrow(() => requireGrant(db, adminDoctor, 'inpatient.vitals', 'edit', [], 'записывать измерения'));

    // Уровень при этом ЧИТАЕТСЯ как есть: grantLevel — это «что настроено»,
    // а не «пустить ли». Экраны, которые показывают настройку, не должны
    // видеть у врачебной роли админа несуществующее «Удаление».
    assert.equal(grantLevel(db, adminDoctor, 'inpatient.vitals'), 'none');
  } finally { db.close(); }
});

// CALLCENTER_OPERATOR_V1 — ПОБЛАЖКА АДМИНИСТРАТОРА НЕ РАСПРОСТРАНЯЕТСЯ НА
// СВОЮ РОЛЬ КЛИНИКИ, СДЕЛАННУЮ НА ЕГО ОСНОВЕ.
//
// «Старший администратор» — своя роль клиники (CUSTOM_ROLES_V1) на основе
// `admin`: routes/users.js пишет в users.role ОСНОВУ, поэтому такой человек
// читается как администратор, а матрицу ему настраивают СВОЮ. Безусловный
// пропуск администратора отменял бы в ней каждое «Нет» — экран показывал бы
// запрет, которого нет, хотя свою роль заводят ровно затем, чтобы что-то
// отнять.
//
// ПРАВИЛО: поблажка действует, пока по этому ключу (или по его разделу) у
// СОБСТВЕННОЙ роли человека ничего не настроено. Администратор-врач под неё
// по-прежнему попадает: своей роли клиники у него нет, а «Нет» ему записано
// ЧУЖОЙ, врачебной ролью (ADMIN_DOCTOR_V1) — ради этого случая поблажка и
// существует.
test('своя роль клиники на основе администратора слушается своей же матрицы', () => {
  const db = seed();
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)')
      .run(36, 'sadm', 'x', 'Старший администратор', 'admin', 'starshiy_admin');
    const boss = { id: 36, role: 'admin', extra_roles: [], custom_role_code: 'starshiy_admin' };

    // Своя роль есть, но этого ключа она не трогала — администратор проходит.
    setGrants(db, 'starshiy_admin', { 'inpatient.vitals': 'edit' });
    assert.equal(grantAllows(db, boss, 'inpatient.prescriptions', 'edit', []), true,
      'ненастроенный ключ отнял у администратора то, чего ему никто не запрещал');

    // А теперь клиника закрыла ему назначения — и это обязано значить нет.
    setGrants(db, 'starshiy_admin', { 'inpatient.vitals': 'edit', 'inpatient.prescriptions': 'none' });
    assert.equal(grantAllows(db, boss, 'inpatient.prescriptions', 'edit', ['admin']), false,
      'поблажка администратора отменила запрет, записанный его СОБСТВЕННОЙ роли');
    assert.equal(grantAllows(db, boss, 'inpatient.vitals', 'edit', []), true,
      'выданное той же своей ролью перестало работать');

    // Штатный администратор и администратор-врач — ровно как были.
    setGrants(db, 'doctor', { 'crm.dial': 'none' });
    assert.equal(grantAllows(db, { id: 1, role: 'admin', extra_roles: [] }, 'inpatient.prescriptions', 'edit', []), true,
      'штатному администратору настроить матрицу негде — его пускают всегда');
    assert.equal(grantAllows(db, { id: 34, role: 'doctor', extra_roles: ['admin'] }, 'crm.dial', 'edit', ['registrar']), true,
      'администратор-врач заперт «Нет» чужой, врачебной роли');
  } finally { db.close(); }
});

// CALLCENTER_OPERATOR_V1 — ЗАКРЫТЫЙ РАЗДЕЛ ЗАКРЫВАЕТ ВСЁ, ЧТО В НЁМ.
//
// Уровни у окон и действий остаются лежать в матрице и после того, как раздел
// поставили в «Нет» (экран их гасит, но значение у них прежнее, а клиника
// могла записать такую матрицу и руками). Спроси ворота только про окно — и
// закрытый раздел открылся бы изнутри: «Cust Dev: Нет» при `custdev.list:
// Просмотр` пускал бы на доску обзвона.
test('раздел «Нет» перевешивает уровень, оставшийся у его окна', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { custdev: 'none', 'custdev.list': 'view', inpatient: 'view', 'inpatient.vitals': 'edit' });
    assert.equal(grantAllows(db, NURSE, 'custdev.list', 'view', ['nurse']), false,
      'окно осталось открытым в закрытом разделе');
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'edit', []), true,
      'открытый раздел ничего не отнимает у своих строк');
  } finally { db.close(); }
});

// CALLCENTER_OPERATOR_V1 — КРУГ ЗАМКНУТ: ТО, ЧТО ЗАПИСАЛ ЭКРАН, НЕ ОТНИМАЕТ
// ТОГО, ЧТО ВЫДАЛА МИГРАЦИЯ.
//
// Экран «Роли» сохраняет матрицу ЦЕЛИКОМ, поэтому важно не только как ворота
// её читают, но и что в неё попадает. Раздел, закрытый лишь ВЫВОДОМ из старой
// галочки, экран в матрицу не пишет (roles-matrix.js collectGrants) — иначе
// сервер прочитал бы «crm: Нет» как решение и снял бы с оператора телефон,
// выданный миграцией 141, при том что экран продолжал бы показывать
// «Позвонить пациенту: Изменение». Здесь — вторая половина того же уговора,
// со стороны ворот.
test('матрица, сохранённая экраном, не отнимает ключ, выданный миграцией', () => {
  const db = seed();
  try {
    // Ровно то, что уходит в базу: ключи раздела есть, самого раздела нет.
    setGrants(db, 'palatnaya', {
      'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit',
      patients: 'edit', 'patients.list': 'view',
    });
    assert.equal(grantAllows(db, CUSTOM, 'crm.dial', 'edit', []), true, 'сохранение роли отняло выданный телефон');
    assert.equal(grantAllows(db, CUSTOM, 'crm.calls', 'view', []), true);

    // А записанное «Нет» — по-прежнему решение, и оно закрывает раздел целиком.
    setGrants(db, 'palatnaya', { crm: 'none', 'crm.dial': 'edit' });
    assert.equal(grantAllows(db, CUSTOM, 'crm.dial', 'edit', []), false, 'закрытый решением раздел открылся изнутри');
  } finally { db.close(); }
});

test('отказ — понятной фразой с адресом, где выдают права', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.throws(() => requireGrant(db, NURSE, 'inpatient.vitals', 'edit', ['nurse'], 'записывать измерения'),
      (e) => e instanceof GrantError && e.status === 403 && /Записывать измерения — недоступно вашей роли/.test(e.message) && /Настройки → Роли/.test(e.message));
  } finally { db.close(); }
});

// --- Живые ворота: измерения --------------------------------------------------

function admitPatient(db) {
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (1, 'Тест', 'P-1', '+998900000000')").run();
  db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (1, 1, 'active', '2026-09-18T08:00:00Z')").run();
}

test('ворота измерений слушают матрицу: закрыли медсестре запись — сервер отказывает словами', () => {
  const db = seed();
  try {
    admitPatient(db);
    const ok = admissionVitalsAdd(db, { admission_id: 1, temp_c: 36.6 }, NURSE);
    assert.ok(ok.vital && ok.vital.id, 'до настройки медсестра записывает, как и раньше');

    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.throws(() => admissionVitalsAdd(db, { admission_id: 1, temp_c: 36.7 }, NURSE),
      (e) => e.status === 403 && /аписывать измерения/.test(e.message));
    assert.equal(admissionVitalsList(db, { admission_id: 1 }, NURSE).rows.length, 1, 'просмотр остался');

    // Удаление — по умолчанию только администратору; медсестре — только если выдали.
    assert.throws(() => admissionVitalsDelete(db, { vital_id: ok.vital.id }, NURSE), (e) => e.status === 403);
    setGrants(db, 'nurse', { 'inpatient.vitals': 'delete' });
    assert.equal(admissionVitalsDelete(db, { vital_id: ok.vital.id }, NURSE).ok, true);
    assert.equal(admissionVitalsList(db, { admission_id: 1 }, NURSE).rows.length, 0);
  } finally { db.close(); }
});

// --- Справочник честный -------------------------------------------------------

test('каждая строка справочника называет проверку, а ключи не повторяются', () => {
  const keys = new Set();
  for (const r of catalogRows()) {
    assert.ok(!keys.has(r.key), 'ключ повторяется: ' + r.key);
    keys.add(r.key);
    assert.ok(r.label && r.desc, 'у строки нет подписи или описания: ' + r.key);
    assert.ok(Array.isArray(r.levels) && r.levels[0] === 'none', 'уровни строки начинаются с «Нет»: ' + r.key);
    if (r.kind !== 'section') assert.ok(r.enforced, 'окно/действие без проверки — галочка-обманка: ' + r.key);
    // CALLCENTER_OPERATOR_V1 — приставка говорит, ГДЕ проверяют, и словарь её
    // закрыт: rpc: (ворота серверного вызова), route: (маршрут оболочки),
    // client: (предикат оболочки, сервер ключа не читает). Выдуманная приставка
    // читалась бы как обещание серверной проверки, которой нет.
    // ROLE_REPORTS_SETTINGS_V1 — четвёртая приставка, db: — запись в таблицу
    // через /api/db, где реестр называет ключ (`write.grant`), а компилятор
    // запросов его проверяет (server/db/write-grant.js).
    if (r.enforced) assert.match(r.enforced, /^(rpc|route|client|db):\S/, 'непонятно, где проверяют ' + r.key + ': ' + r.enforced);
    // Закрытая строка (только администратор) не предлагает ни одного уровня,
    // кроме «Нет»: иначе экран обещал бы право, которого сервер не даст.
    if (r.locked) assert.deepEqual(r.levels, ['none'], 'закрытая строка предлагает уровень: ' + r.key);
  }
  // Ключи действий стационара, на которые переведены ворота сервера.
  for (const k of ['inpatient.prescriptions', 'inpatient.marks', 'inpatient.vitals', 'inpatient.reviews', 'inpatient.services', 'inpatient.discharge', 'inpatient.requests', 'inpatient.beds', 'inpatient.patients', 'inpatient.history']) {
    assert.ok(keys.has(k), 'сервер проверяет ' + k + ', а в справочнике его нет');
  }
  // CALLCENTER_OPERATOR_V1 — ключи работы оператора: звонки, набор номера,
  // записи разговоров, заведение пациента из заявки и Cust Dev. Пропадёт ключ
  // отсюда — галочка исчезнет с экрана, а проверка на сервере останется, и
  // право станет невыдаваемым.
  for (const k of ['crm.calls', 'crm.dial', 'crm.recording', 'crm.convert', 'custdev.list', 'custdev.rate']) {
    assert.ok(keys.has(k), 'сервер проверяет ' + k + ', а в справочнике его нет');
  }
  // ROLE_REPORTS_SETTINGS_V1 — группы отчётов (их проверяют run_report,
  // owner_report, cashier_report, callcenter_report и кабинет врача) и плитки
  // настроек, чью запись проверяет компилятор запросов.
  for (const k of ['reports.revenue', 'reports.cashier', 'reports.doctor_pay', 'reports.referrals', 'reports.services', 'reports.stock', 'reports.callcenter',
    'settings.patient_categories', 'settings.payers', 'settings.referral_sources', 'settings.doctor_rates', 'settings.rooms', 'settings.company', 'settings.documents']) {
    assert.ok(keys.has(k), 'сервер проверяет ' + k + ', а в справочнике его нет');
  }
  // Закрытые строки владельца: Telegram, телефония, воронка CRM, API-ключи, Роли.
  const byKey = new Map(catalogRows().map((r) => [r.key, r]));
  for (const k of ['settings.telegram', 'settings.telephony', 'settings.crm', 'settings.api', 'settings.roles', 'reports.telegram']) {
    assert.ok(byKey.get(k) && byKey.get(k).locked, k + ' обязана быть закрытой строкой (только администратор)');
  }
  assert.equal(levelAllows('edit', 'view'), true);
  assert.equal(levelAllows('view', 'edit'), false);
  // Восемнадцатый раздел — Cust Dev. Он выдавался миграцией 078, а на экране
  // «Роли» его не было вовсе (CALLCENTER_OPERATOR_V1). ROLE_REPORTS_SETTINGS_V1
  // разделов не прибавил: группы отчётов и плитки настроек — окна прежних
  // разделов «Отчёты» и «Настройки».
  assert.equal(CATALOG.length, 18, 'в справочнике восемнадцать разделов');
  assert.equal(CATALOG.find((s) => s.key === 'reports').windows.length, 8, 'семь групп отчётов и закрытый Telegram');
  assert.equal(CATALOG.find((s) => s.key === 'settings').windows.length, 25, 'плитки хаба настроек');
});
