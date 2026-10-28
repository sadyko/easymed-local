// ADMIN_ACT_AS_V1 (2026-10-28) — АДМИНИСТРАТОР РАБОТАЕТ ОТ ИМЕНИ СОТРУДНИКА.
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md. Здесь — сервер:
//   • R1/R2 — кто может войти от имени и как кого; отказы с текстами;
//   • /me и вход несут acting_admin (null или {id, full_name});
//   • журнал act_as_actions: записи /api/db, все RPC, записи /api/users — с кодом
//     ответа; чтения не пишутся;
//   • R3 — подпись документов врача от чужого имени: сервер отказывает сам на
//     каждом пути (заключение приёма, «Проверить и выдать», процедура, записи
//     стационара, копия подписанного документа);
//   • R4 — авто-конец по каждой причине, с причиной в журнале; R5 — сессии
//     сотрудника не трогаются; R6 — его пароль не меняется.
// R7 (лицензия) — в licence-gate.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { admissionOrderCreate, admissionAdmit } from '../services/rpc/inpatient.js';
import { notesBaseOf, NOTES_BASE_KEY } from '../services/domain/cabinet-notes.js';
import { ACT_AS_MESSAGES, ACT_AS_END, ACT_AS_SIGN_REFUSAL } from '../../public/js/shared/act-as.js';

const BOSS = 1, BOSS2 = 2, DOC = 3, NURSE = 4, LAB = 5, FRESH = 6, GONE = 7, ADMX = 8, REGADM = 9, TEMPADM = 10, REG = 11, HDOC = 12;

const NOTES = (history) => JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history });
const SIGNED = { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', by: DOC, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель' } };
const SIGNED_NEW = { kind: 'signed', savedAt: '2026-10-28T09:00:00.000Z', by: DOC, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель, итог' } };
const DRAFT = { kind: 'draft', savedAt: '2026-10-28T08:30:00.000Z', fields: { chief_complaint: 'Кашель, правка' }, tab: 't1' };

const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';

async function startServer({ dataDir = licensedDataDir() } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('reg_to_admin', 'Старший регистратор', 'admin')").run();
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, custom_role_code, is_doctor, is_active, must_change_password)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const pw = hashPassword('password1');
  u.run(BOSS, 'boss', pw, 'Петров П.', 'admin', '[]', null, 0, 1, 0);
  u.run(BOSS2, 'boss2', pw, 'Сидоров С.', 'admin', '[]', null, 0, 1, 0);
  u.run(DOC, 'doc', pw, 'Иванова А.', 'doctor', '[]', null, 1, 1, 0);
  u.run(NURSE, 'nurse', pw, 'Медсестра Н.', 'nurse', '[]', null, 0, 1, 0);
  u.run(LAB, 'lab', pw, 'Лаборант Л.', 'lab', '[]', null, 0, 1, 0);
  u.run(FRESH, 'fresh', pw, 'Новичок Н.', 'registrar', '[]', null, 0, 1, 1);
  u.run(GONE, 'gone', pw, 'Уволенный У.', 'registrar', '[]', null, 0, 0, 0);
  u.run(ADMX, 'admx', pw, 'Админ-врач А.', 'doctor', '["admin"]', null, 1, 1, 0);
  u.run(REGADM, 'regadm', pw, 'Старший рег. С.', 'registrar', '[]', 'reg_to_admin', 0, 1, 0);
  u.run(TEMPADM, 'tempadm', pw, 'Новый админ Н.', 'admin', '[]', null, 0, 1, 1);
  u.run(REG, 'reg', pw, 'Регистратор Р.', 'registrar', '[]', null, 0, 1, 0);
  u.run(HDOC, 'hdoc', pw, 'Главврач Г.', 'doctor', '["head_doctor"]', null, 1, 1, 0);

  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Пациент')").run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (90, 'Процедурный', 'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1, 'Консультация', 100000, 'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type, department_id) VALUES (2, 'Инъекция', 50000, 'procedure', 90)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (3, 'ОАК', 40000, 'lab', 1)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-10-28T07:00:00Z', 'arrived')").run();
  const line = db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes)
                           VALUES (?, 1, ?, ?, 1, 100000, 100000, ?, ?)`);
  line.run(1, 1, DOC, 'in_progress', NOTES([SIGNED]));   // заключение приёма — подпись от имени
  line.run(2, 1, DOC, 'in_progress', NOTES([SIGNED]));   // заключение приёма — подписывает сам врач
  line.run(3, 2, null, 'queued', null);                  // процедура — от имени
  line.run(4, 2, null, 'queued', null);                  // процедура — сама медсестра
  line.run(5, 3, null, 'resulted', null);                // анализ — от имени
  line.run(6, 3, null, 'resulted', null);                // анализ — сам лаборант
  line.run(7, 1, DOC, 'in_progress', null);              // копия подписанного документа
  db.prepare("INSERT INTO lab_results (id, visit_service_id, parameter, value) VALUES (1, 5, 'HGB', '130'), (2, 6, 'HGB', '128')").run();

  const server = await listen(createApp(db, { dataDir }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, dataDir };
}

async function login(base, username, password = 'password1') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, 'вход ' + username);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// Ревью безопасности (вкладки) — вкладка экрана шлёт X-Em-Act-As: номер входа
// от имени, под который она собрана (0 — без него). Здесь cookie — вкладка:
// TAB помнит, что ей ответили вход и возврат. { tab: false } — запрос без
// заголовка (старая вкладка, чужая страница).
const TAB = new Map();
async function call(base, cookie, method, path, body, headers = {}, { tab = true } = {}) {
  const tabHeader = tab && cookie && TAB.has(cookie) ? { 'X-Em-Act-As': String(TAB.get(cookie)) } : {};
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...tabHeader, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const me = async (base, cookie) => (await call(base, cookie, 'GET', '/api/auth/me')).json.user;
const actAs = async (base, cookie, userId) => {
  const r = await call(base, cookie, 'POST', '/api/auth/act-as', { user_id: userId });
  if (r.status === 200) TAB.set(cookie, r.json.act_as_id);
  return r;
};
const back = async (base, cookie) => {
  const r = await call(base, cookie, 'DELETE', '/api/auth/act-as');
  if (r.status === 200) TAB.set(cookie, r.json.act_as_id);
  return r;
};
const db_ = (base, cookie, body) => call(base, cookie, 'POST', '/api/db', body);
const rpc = (base, cookie, name, args = {}) => call(base, cookie, 'POST', '/api/rpc/' + name, args);
const update = (base, cookie, table, id, values) => db_(base, cookie, { table, op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });

const journal = (db) => db.prepare('SELECT * FROM act_as_sessions ORDER BY id').all();
const lastJournal = (db) => db.prepare('SELECT * FROM act_as_sessions ORDER BY id DESC LIMIT 1').get();
const actions = (db, actAsId) => db.prepare('SELECT kind, name, status FROM act_as_actions WHERE act_as_id = ? ORDER BY id').all(actAsId);
const actingSession = (db, adminId) => db.prepare('SELECT * FROM sessions WHERE user_id = ? AND act_as_id IS NOT NULL').get(adminId);

/** Сдвинуть начало входа от имени в прошлое (обе отметки: в сессии и в журнале). */
function startedAgo(db, adminId, ms) {
  const s = actingSession(db, adminId);
  const at = iso(Date.now() - ms);
  db.prepare('UPDATE sessions SET act_as_started_at = ? WHERE id = ?').run(at, s.id);
  db.prepare('UPDATE act_as_sessions SET started_at = ? WHERE id = ?').run(at, s.act_as_id);
  return at;
}

const SESSION_KEYS = ['acting_admin', 'custom_role_code', 'department_id', 'extra_roles', 'full_name', 'id', 'is_active',
  'is_doctor', 'must_change_password', 'role', 'username'];

// ─── R1 / R2 ────────────────────────────────────────────────────────────────

test('R1: администратор входит от имени сотрудника — ответ и /me несут сотрудника и acting_admin; журнал открыт', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const before = await me(base, boss);
    assert.equal(before.acting_admin, null, 'без входа от имени acting_admin — null');
    assert.deepEqual(Object.keys(before).sort(), SESSION_KEYS);

    const r = await actAs(base, boss, DOC);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.user.id, DOC);
    assert.equal(r.json.user.role, 'doctor');
    assert.deepEqual(r.json.acting_admin, { id: BOSS, full_name: 'Петров П.' });
    assert.deepEqual(r.json.user.acting_admin, { id: BOSS, full_name: 'Петров П.' });

    const now = await me(base, boss);
    assert.deepEqual(Object.keys(now).sort(), SESSION_KEYS, 'форма /me та же, с acting_admin');
    assert.equal(now.id, DOC);
    assert.equal(now.full_name, 'Иванова А.');
    assert.equal(now.is_doctor, true);
    assert.deepEqual(now.acting_admin, { id: BOSS, full_name: 'Петров П.' });
    assert.deepEqual(Object.keys(now.acting_admin).sort(), ['full_name', 'id'], 'о администраторе — только номер и имя');

    const j = journal(db);
    assert.equal(j.length, 1);
    assert.equal(j[0].admin_id, BOSS);
    assert.equal(j[0].target_id, DOC);
    assert.equal(j[0].admin_name, 'Петров П.');
    assert.equal(j[0].target_name, 'Иванова А.');
    assert.equal(j[0].ended_at, null);
    assert.equal(j[0].end_reason, null);
    const s = actingSession(db, BOSS);
    assert.equal(s.user_id, BOSS, 'сессия остаётся сессией администратора');
    assert.equal(s.act_as_user_id, DOC);
    assert.equal(s.act_as_id, j[0].id);
    assert.ok(s.act_as_started_at);
  } finally { server.close(); }
});

test('R1: отказы — не администратор, уже от имени, временный пароль администратора; администратор дополнительной ролью — может', async () => {
  const { db, server, base } = await startServer();
  try {
    const doc = await login(base, 'doc');
    let r = await actAs(base, doc, NURSE);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.notAdmin);

    const regadm = await login(base, 'regadm');   // своя роль на основе администратора, но users.role — регистратор
    r = await actAs(base, regadm, NURSE);
    assert.equal(r.status, 403, 'R1 — isAdminUser: роль admin основная или дополнительная');

    const temp = await login(base, 'tempadm');
    r = await actAs(base, temp, NURSE);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'password_change_required');
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.password);

    const boss = await login(base, 'boss');
    assert.equal((await actAs(base, boss, NURSE)).status, 200);
    r = await actAs(base, boss, LAB);
    assert.equal(r.status, 403, 'от имени — уже не администратор');
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.already);
    assert.equal((await me(base, boss)).id, NURSE, 'отказ не сменил сотрудника');

    const admx = await login(base, 'admx');
    r = await actAs(base, admx, LAB);
    assert.equal(r.status, 200, 'администратор дополнительной ролью входит от имени');
    assert.equal(journal(db).length, 2);
  } finally { server.close(); }
});

test('R2: отказы — себя, администратора (основной, дополнительной, своей ролью на основе администратора), не входившего, отключённого, несуществующего', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const cases = [
      [BOSS, 400, ACT_AS_MESSAGES.self],
      [BOSS2, 400, ACT_AS_MESSAGES.targetAdmin],
      [ADMX, 400, ACT_AS_MESSAGES.targetAdmin],
      [REGADM, 400, ACT_AS_MESSAGES.targetAdmin],
      [FRESH, 400, ACT_AS_MESSAGES.targetNew],
      [GONE, 400, ACT_AS_MESSAGES.targetInactive],
      [999, 404, ACT_AS_MESSAGES.notFound],
      ['abc', 400, ACT_AS_MESSAGES.noTarget],
      [null, 400, ACT_AS_MESSAGES.noTarget],
    ];
    for (const [id, status, message] of cases) {
      const r = await actAs(base, boss, id);
      assert.equal(r.status, status, 'user_id ' + id);
      assert.equal(r.json.error.message, message, 'user_id ' + id);
    }
    assert.equal(journal(db).length, 0, 'отказ не пишет журнал');
    assert.equal((await me(base, boss)).id, BOSS);
    assert.equal(actingSession(db, BOSS), undefined);
  } finally { server.close(); }
});

test('возврат: DELETE /api/auth/act-as — снова администратор, журнал закрыт «Вернулся»; повтор — тоже 200; без сессии — 401', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    const r = await back(base, boss);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.user.id, BOSS);
    assert.equal(r.json.user.acting_admin, null);
    assert.equal(r.json.acting_admin, null);
    const after = await me(base, boss);
    assert.equal(after.id, BOSS);
    assert.equal(after.acting_admin, null);
    const j = lastJournal(db);
    assert.equal(j.end_reason, ACT_AS_END.returned);
    assert.equal(j.end_reason, 'Вернулся');
    assert.ok(j.ended_at >= j.started_at);
    const s = db.prepare('SELECT act_as_user_id, act_as_id, act_as_started_at FROM sessions WHERE user_id = ?').get(BOSS);
    assert.deepEqual({ ...s }, { act_as_user_id: null, act_as_id: null, act_as_started_at: null });

    const again = await back(base, boss);
    assert.equal(again.status, 200, 'возврат без входа от имени — не ошибка');
    assert.equal(again.json.user.id, BOSS);
    assert.equal((await back(base, null)).status, 401);
  } finally { server.close(); }
});

// ─── Журнал действий ────────────────────────────────────────────────────────

test('журнал: записи /api/db, все RPC и записи /api/users — с кодом ответа; чтения не пишутся; после возврата — ничего', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const id = actingSession(db, BOSS).act_as_id;

    // Чтения — не пишутся.
    assert.equal((await db_(base, boss, { table: 'visit_services', op: 'select', columns: 'id' })).status, 200);
    await call(base, boss, 'GET', '/api/users');
    await call(base, boss, 'GET', '/api/auth/me');
    assert.deepEqual(actions(db, id), []);

    // Запись /api/db — таблица и операция, код ответа.
    const ok = await update(base, boss, 'visit_services', 7, { status: 'completed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const refused = await db_(base, boss, { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 7 }] });
    assert.equal(refused.status, 403, 'врачу удалять строку визита нельзя — отказ тоже в журнале');
    // RPC — любой, с кодом ответа.
    const list = await rpc(base, boss, 'procedures_list', {});
    const unknown = await rpc(base, boss, 'no_such_rpc', {});
    assert.equal(unknown.status, 501);
    // Запись /api/users.
    const patch = await call(base, boss, 'PATCH', '/api/users/' + DOC, { full_name: 'Иванова А. Б.' });

    assert.deepEqual(actions(db, id), [
      { kind: 'db', name: 'visit_services.update', status: 200 },
      { kind: 'db', name: 'visit_services.delete', status: 403 },
      { kind: 'rpc', name: 'procedures_list', status: list.status },
      { kind: 'rpc', name: 'no_such_rpc', status: 501 },
      { kind: 'users', name: 'PATCH /users/' + DOC, status: patch.status },
    ]);
    const text = JSON.stringify(db.prepare('SELECT * FROM act_as_actions').all());
    assert.doesNotMatch(text, /Пациент|completed|Иванова/, 'в журнале нет данных — только имена таблиц и RPC');

    // После возврата — ничего не пишется.
    await back(base, boss);
    await update(base, boss, 'visit_services', 7, { status: 'in_progress' });
    await rpc(base, boss, 'procedures_list', {});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM act_as_actions').get().n, 5);
  } finally { server.close(); }
});

// FIX_318_V1 (ADMIN_ACT_AS_V1) — чтения выпуска 3.18.0 (меню, лицензия, панель
// «Телефон», «Реферирование») журнал помечает «только чтение» и не считает
// записями. До исправления оболочка, открытая от имени, давала «Действий: 37 ·
// записей: 9» при одной настоящей записи: эти RPC не были в списке чтений
// ворот лицензии (control/gate.js), который читает журнал.
test('FIX_318_V1: журнал — чтения 3.18.0 и licence_status помечены «только чтение» и не считаются записями', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, REG);
    const id = actingSession(db, BOSS).act_as_id;
    const reads = ['nav_visibility_get', 'licence_status', 'get_clinic_by_slug', 'telephony_phone_me', 'telephony_live',
      'telephony_call_log', 'referrals_activity'];
    for (const n of reads) await rpc(base, boss, n, {});
    assert.equal((await rpc(base, boss, 'nav_visibility_get', {})).status, 200);
    assert.equal((await rpc(base, boss, 'licence_status', {})).status, 200);
    // Одна настоящая запись и одна попытка записи 3.18.0 (отказ — тоже запись журнала).
    const ext = await rpc(base, boss, 'telephony_my_extension', { extension: '101' });
    assert.equal(ext.status, 200, JSON.stringify(ext.json));
    const save = await rpc(base, boss, 'nav_visibility_save', { hidden: [] });
    assert.equal(save.status, 403, 'видимость разделов меняет администратор');
    await back(base, boss);

    const r = await call(base, boss, 'GET', `/api/auth/act-as/log?user_id=${REG}&act_as_id=${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const flags = r.json.actions.map((a) => [a.name, a.read_only]);
    assert.deepEqual(flags, [
      ...reads.map((n) => [n, true]),
      ['nav_visibility_get', true], ['licence_status', true],
      ['telephony_my_extension', false], ['nav_visibility_save', false],
    ]);
    assert.equal(r.json.session.action_count, reads.length + 4);
    assert.equal(r.json.session.write_count, 2, 'записи — только telephony_my_extension и попытка nav_visibility_save');
    const list = await call(base, boss, 'GET', '/api/auth/act-as/log?user_id=' + REG);
    assert.equal(list.json.sessions[0].write_count, 2, 'список сеансов считает так же');
  } finally { server.close(); }
});

// ─── R3: подпись документов врача от чужого имени ───────────────────────────

test('R3: заключение приёма — новая или изменённая подпись от имени — 403; черновик — можно; сам врач — подписывает', async () => {
  const { db, server, base } = await startServer();
  try {
    const notesOf = (id) => db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(id).notes;
    const write = (cookie, id, history) => update(base, cookie, 'visit_services', id, { notes: NOTES(history), [NOTES_BASE_KEY]: notesBaseOf(notesOf(id)) });

    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const before = notesOf(1);
    let r = await write(boss, 1, [SIGNED, SIGNED_NEW]);
    assert.equal(r.status, 403, 'новая подпись от имени');
    assert.equal(r.json.error.code, 'sign_while_acting');
    assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL);
    r = await write(boss, 1, [{ ...SIGNED, fields: { chief_complaint: 'Кашель, переписано' } }]);
    assert.equal(r.status, 403, 'изменённая подписанная версия (тот же savedAt) от имени');
    assert.equal(notesOf(1), before, 'документ не тронут');

    r = await write(boss, 1, [SIGNED, DRAFT]);
    assert.equal(r.status, 200, 'черновик от имени — можно: он не подписан. ' + JSON.stringify(r.json));
    assert.match(notesOf(1), /Кашель, правка/);

    const doc = await login(base, 'doc');
    r = await write(doc, 2, [SIGNED, SIGNED_NEW]);
    assert.equal(r.status, 200, 'сам врач подписывает. ' + JSON.stringify(r.json));
    assert.match(notesOf(2), /2026-10-28T09:00:00/);
  } finally { server.close(); }
});

test('R3: «Проверить и выдать» лаборатории (verified_by/verified_at) — 403 от имени; результат вносить можно; сам лаборант — выдаёт', async () => {
  const { db, server, base } = await startServer();
  try {
    const stamp = new Date().toISOString();
    const boss = await login(base, 'boss');
    await actAs(base, boss, LAB);
    let r = await update(base, boss, 'lab_results', 1, { verified_by: LAB, verified_at: stamp });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'sign_while_acting');
    assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL);
    r = await update(base, boss, 'visit_services', 5, { status: 'completed', verified_by: LAB, verified_at: stamp });
    assert.equal(r.status, 403);
    r = await update(base, boss, 'visit_services', 5, { verified_at: stamp });
    assert.equal(r.status, 403, 'и одна отметка времени — это выдача');
    assert.equal(db.prepare('SELECT verified_by FROM lab_results WHERE id = 1').get().verified_by, null);
    assert.equal(db.prepare('SELECT status, verified_by FROM visit_services WHERE id = 5').get().status, 'resulted');
    r = await update(base, boss, 'lab_results', 1, { value: '131' });
    assert.equal(r.status, 200, 'вносить результат от имени можно. ' + JSON.stringify(r.json));

    const lab = await login(base, 'lab');
    r = await update(base, lab, 'lab_results', 2, { verified_by: LAB, verified_at: stamp });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await update(base, lab, 'visit_services', 6, { status: 'completed', verified_by: LAB, verified_at: stamp });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(db.prepare('SELECT verified_by FROM visit_services WHERE id = 6').get().verified_by, LAB);
  } finally { server.close(); }
});

test('R3: подтверждение процедуры (procedure_complete) — 403 от имени; сама медсестра — подтверждает', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    let r = await rpc(base, boss, 'procedure_complete', { kind: 'outpatient', id: 3 });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'sign_while_acting');
    assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL);
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 3').get().status, 'queued');

    const nurse = await login(base, 'nurse');
    r = await rpc(base, nurse, 'procedure_complete', { kind: 'outpatient', id: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const row = db.prepare('SELECT status, verified_by FROM visit_services WHERE id = 4').get();
    assert.equal(row.status, 'completed');
    assert.equal(row.verified_by, NURSE);
  } finally { server.close(); }
});

test('R3: записи стационара (admission_review_save) — 403 от имени, даже черновик; сам врач — пишет', async () => {
  const { db, server, base } = await startServer();
  try {
    const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
    const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
    const { admission } = admissionOrderCreate(db, { patient_id: 1, department: 'Терапия' }, { id: REG, role: 'registrar' });
    admissionAdmit(db, { admission_id: admission.id, bed_id: bed }, { id: NURSE, role: 'nurse' });
    const draft = { admission_id: admission.id, kind: 'primary', complaints: 'Боли', diagnosis: 'Наблюдение' };

    const boss = await login(base, 'boss');
    await actAs(base, boss, HDOC);
    for (const args of [draft, { ...draft, publish: true }]) {
      const r = await rpc(base, boss, 'admission_review_save', args);
      assert.equal(r.status, 403, JSON.stringify(args));
      assert.equal(r.json.error.code, 'sign_while_acting');
      assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 0);

    const hdoc = await login(base, 'hdoc');
    const r = await rpc(base, hdoc, 'admission_review_save', draft);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(db.prepare('SELECT author_id FROM admission_reviews').get().author_id, HDOC);
  } finally { server.close(); }
});

test('R3: копия подписанного документа (visit_document_archive) — 403 от имени; сам врач — подписывает', async () => {
  const { db, server, base } = await startServer();
  try {
    const args = { visit_service_id: 7, doc_type: 'protocol', title: 'Протокол осмотра', body: { complaints: 'Кашель' } };
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    let r = await rpc(base, boss, 'visit_document_archive', args);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'sign_while_acting');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0);

    const doc = await login(base, 'doc');
    r = await rpc(base, doc, 'visit_document_archive', args);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(db.prepare('SELECT created_by FROM visit_documents').get().created_by, DOC);
  } finally { server.close(); }
});

// ─── R4: конец работы от имени ──────────────────────────────────────────────

test('R4: 2 часа с начала — «Истекло», конец ровно через 2 часа; запросы — 409 act_as_ended, пока не нажат «Вернуться»', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    const startedAt = startedAgo(db, BOSS, 3 * 3600 * 1000);

    const m = await call(base, boss, 'GET', '/api/auth/me');
    assert.equal(m.status, 200);
    assert.equal(m.json.user.id, BOSS, 'вход от имени снят — /me называет администратора');
    assert.equal(m.json.user.acting_admin, null);
    assert.deepEqual(m.json.act_as_ended, { reason: 'Истекло' });
    const j = lastJournal(db);
    assert.equal(j.end_reason, 'Истекло');
    assert.equal(j.ended_at, iso(Date.parse(startedAt) + 2 * 3600 * 1000), 'конец — ровно через 2 часа от начала');

    // Экран ещё думает, что работает от имени: любой запрос API (и фоновый) — 409,
    // пока он не скажет «Вернуться». Ни одна запись не уходит от имени администратора.
    for (const headers of [{}, { 'x-em-background': '1' }]) {
      const r = await call(base, boss, 'POST', '/api/db', { table: 'visit_services', op: 'update', values: { status: 'completed' }, filters: [{ col: 'id', op: 'eq', val: 7 }] }, headers);
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'act_as_ended');
      assert.equal(r.json.error.message, ACT_AS_MESSAGES.ended);
      assert.equal(r.json.error.reason, 'Истекло');
    }
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 7').get().status, 'in_progress');
    assert.equal((await rpc(base, boss, 'procedures_list')).status, 409);

    const r = await back(base, boss);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.id, BOSS);
    assert.equal(lastJournal(db).end_reason, 'Истекло', '«Вернуться» после авто-конца не переписывает причину');
    assert.equal((await update(base, boss, 'visit_services', 7, { status: 'completed' })).status, 200, 'дальше — администратор');
    assert.equal((await me(base, boss)).id, BOSS);
  } finally { server.close(); }
});

test('R4: сотрудник отключён, удалён, стал администратором (основной, дополнительной, своей ролью) или получил временный пароль — «Сотрудник недоступен»', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const boss2 = await login(base, 'boss2');
    const causes = [
      ['отключён', () => db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(REG), () => db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(REG)],
      ['основная роль admin', () => db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(REG), () => db.prepare("UPDATE users SET role = 'registrar' WHERE id = ?").run(REG)],
      ['дополнительная роль admin', () => db.prepare(`UPDATE users SET extra_roles = '["admin"]' WHERE id = ?`).run(REG), () => db.prepare("UPDATE users SET extra_roles = '[]' WHERE id = ?").run(REG)],
      ['своя роль на основе администратора', () => db.prepare("UPDATE users SET custom_role_code = 'reg_to_admin' WHERE id = ?").run(REG), () => db.prepare('UPDATE users SET custom_role_code = NULL WHERE id = ?').run(REG)],
      ['временный пароль', () => db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(REG), () => db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(REG)],
    ];
    for (const [label, cause, undo] of causes) {
      assert.equal((await actAs(base, boss, REG)).status, 200, label);
      cause();
      const m = await call(base, boss, 'GET', '/api/auth/me');
      assert.equal(m.json.user.id, BOSS, label);
      assert.deepEqual(m.json.act_as_ended, { reason: 'Сотрудник недоступен' }, label);
      assert.equal(lastJournal(db).end_reason, 'Сотрудник недоступен', label);
      assert.equal((await back(base, boss)).status, 200);
      undo();
    }

    // Удалён — настоящим удалением другого администратора: журнал входов от
    // имени удалению не мешает (это не «история сотрудника»).
    assert.equal((await actAs(base, boss, REG)).status, 200);
    const del = await call(base, boss2, 'DELETE', '/api/users/' + REG);
    assert.equal(del.status, 200, JSON.stringify(del.json));
    const r = await db_(base, boss, { table: 'visit_services', op: 'select', columns: 'id' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.reason, 'Сотрудник недоступен');
    assert.equal(lastJournal(db).end_reason, 'Сотрудник недоступен');
    assert.equal(lastJournal(db).target_name, 'Регистратор Р.', 'имя удалённого остаётся в журнале');
  } finally { server.close(); }
});

test('R4: администратор лишён роли — «Сессия завершена»; отключён — его сессия кончилась, «Сессия завершена»', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    db.prepare("UPDATE users SET role = 'registrar' WHERE id = ?").run(BOSS);
    let m = await call(base, boss, 'GET', '/api/auth/me');
    assert.equal(m.json.user.id, BOSS);
    assert.equal(m.json.user.role, 'registrar');
    assert.deepEqual(m.json.act_as_ended, { reason: 'Сессия завершена' });
    assert.equal(lastJournal(db).end_reason, 'Сессия завершена');
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(BOSS);
    await back(base, boss);

    await actAs(base, boss, NURSE);
    const boss2 = await login(base, 'boss2');
    const off = await call(base, boss2, 'PATCH', '/api/users/' + BOSS, { is_active: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(lastJournal(db).end_reason, 'Сессия завершена', 'сессию удалил другой администратор — журнал закрыт');
    m = await call(base, boss, 'GET', '/api/auth/me');
    assert.equal(m.status, 401);
  } finally { server.close(); }
});

test('R4: выход — «Вышел»; вход другого поверх — «Вышел»; сессия администратора истекла — «Сессия завершена»; сессия удалена другим путём — тоже, а после 2 часов — «Истекло»', async () => {
  const { db, server, base } = await startServer();
  try {
    let boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    assert.equal((await call(base, boss, 'POST', '/api/auth/logout')).status, 200);
    assert.equal(lastJournal(db).end_reason, 'Вышел');

    boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: boss },
      body: JSON.stringify({ username: 'doc', password: 'password1' }) });
    assert.equal(res.status, 200);
    assert.equal(lastJournal(db).end_reason, 'Вышел', 'вход другого человека в этом браузере заканчивает сессию администратора');

    boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(actingSession(db, BOSS).id);
    assert.equal((await call(base, boss, 'GET', '/api/auth/me')).status, 401);
    assert.equal(lastJournal(db).end_reason, 'Сессия завершена');

    boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(actingSession(db, BOSS).id);
    assert.equal(lastJournal(db).end_reason, 'Сессия завершена', 'любое удаление сессии закрывает журнал (триггер)');
    assert.ok(lastJournal(db).ended_at);

    boss = await login(base, 'boss');
    await actAs(base, boss, NURSE);
    const startedAt = startedAgo(db, BOSS, 5 * 3600 * 1000);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(actingSession(db, BOSS).id);
    assert.equal(lastJournal(db).end_reason, 'Истекло', 'позднее удаление после 2 часов — «Истекло»');
    assert.equal(lastJournal(db).ended_at, iso(Date.parse(startedAt) + 2 * 3600 * 1000));
  } finally { server.close(); }
});

// ─── R5, R6 ─────────────────────────────────────────────────────────────────

test('R5: сессии сотрудника не трогаются — он работает одновременно, его действия в журнал не пишутся', async () => {
  const { db, server, base } = await startServer();
  try {
    const doc = await login(base, 'doc');
    const sessionsOfDoc = () => db.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY id').all(DOC).map((r) => r.id);
    const own = sessionsOfDoc();
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    assert.deepEqual(sessionsOfDoc(), own, 'вход от имени не заводит и не трогает сессий сотрудника');

    const mine = await me(base, doc);
    assert.equal(mine.id, DOC);
    assert.equal(mine.acting_admin, null, 'сам сотрудник — без acting_admin');
    assert.equal((await update(base, doc, 'visit_services', 7, { status: 'completed' })).status, 200);
    assert.equal((await update(base, boss, 'visit_services', 7, { status: 'in_progress' })).status, 200);
    const id = lastJournal(db).id;
    assert.deepEqual(actions(db, id), [{ kind: 'db', name: 'visit_services.update', status: 200 }], 'в журнале — только действие от имени');

    await back(base, boss);
    assert.deepEqual(sessionsOfDoc(), own);
    assert.equal((await me(base, doc)).id, DOC, 'сотрудник работает дальше');
  } finally { server.close(); }
});

test('R6: пароль сотрудника от его имени не меняется — ни сменой своего пароля, ни карточкой сотрудника', async () => {
  const { db, server, base } = await startServer();
  try {
    // Регистратуре выдано «Сотрудники: Изменение» — иначе карточка отказала бы раньше.
    const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'registrar'").get();
    const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
    perms.grants = { ...(perms.grants || {}), settings: 'view', 'settings.employees': 'edit' };
    if (row) db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'").run(JSON.stringify(perms));
    else db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('registrar', ?)").run(JSON.stringify(perms));

    const boss = await login(base, 'boss');
    await actAs(base, boss, REG);
    let r = await call(base, boss, 'POST', '/api/auth/change-password', { current_password: 'password1', new_password: 'other' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.passwordWhileActing);
    r = await call(base, boss, 'PATCH', '/api/users/' + REG, { password: 'other' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.passwordWhileActing);
    await login(base, 'reg', 'password1');   // пароль прежний
    r = await call(base, boss, 'PATCH', '/api/users/' + REG, { phone: '+998901234567' });
    assert.equal(r.status, 200, 'карточку (без пароля) от имени править можно. ' + JSON.stringify(r.json));
  } finally { server.close(); }
});

// ─── Журнал входов от имени ─────────────────────────────────────────────────

test('журнал входов: администратор видит сеансы сотрудника и их действия; не администратор и работающий от имени — 403', async () => {
  const { server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    await update(base, boss, 'visit_services', 7, { status: 'completed' });
    await rpc(base, boss, 'procedures_list', {});
    let r = await call(base, boss, 'GET', '/api/auth/act-as/log?user_id=' + DOC);
    assert.equal(r.status, 403, 'от имени журнал не открыть');
    assert.equal(r.json.error.message, ACT_AS_MESSAGES.logForbidden);
    await back(base, boss);

    r = await call(base, boss, 'GET', '/api/auth/act-as/log?user_id=' + DOC);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sessions.length, 1);
    const s = r.json.sessions[0];
    assert.equal(s.admin_id, BOSS);
    assert.equal(s.admin_name, 'Петров П.');
    assert.equal(s.target_id, DOC);
    assert.equal(s.target_name, 'Иванова А.');
    assert.equal(s.end_reason, 'Вернулся');
    assert.ok(s.started_at && s.ended_at);
    assert.equal(s.action_count, 2);
    assert.equal(s.write_count, 1, 'чтение-RPC — не запись');

    r = await call(base, boss, 'GET', `/api/auth/act-as/log?user_id=${DOC}&act_as_id=${s.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.session.id, s.id);
    assert.deepEqual(r.json.actions.map((a) => [a.kind, a.name, a.status, a.read_only]), [
      ['db', 'visit_services.update', 200, false],
      ['rpc', 'procedures_list', 200, true],
    ]);
    assert.ok(r.json.actions.every((a) => typeof a.at === 'string'));
    assert.equal(r.json.truncated, false);

    // Журнал администратора — его входы от имени других.
    r = await call(base, boss, 'GET', '/api/auth/act-as/log?user_id=' + BOSS);
    assert.equal(r.json.sessions.length, 1);
    r = await call(base, boss, 'GET', '/api/auth/act-as/log?user_id=' + NURSE);
    assert.deepEqual(r.json.sessions, []);
    r = await call(base, boss, 'GET', `/api/auth/act-as/log?user_id=${NURSE}&act_as_id=${s.id}`);
    assert.equal(r.status, 404, 'сеанс другого сотрудника по чужому номеру не отдаётся');

    assert.equal((await call(base, boss, 'GET', '/api/auth/act-as/log')).status, 400);
    const doc = await login(base, 'doc');
    assert.equal((await call(base, doc, 'GET', '/api/auth/act-as/log?user_id=' + DOC)).status, 403);
    assert.equal((await call(base, null, 'GET', '/api/auth/act-as/log?user_id=' + DOC)).status, 401);
  } finally { server.close(); }
});

// ═══ Ревью безопасности (2026-10-28) ════════════════════════════════════════

/**
 * Запрос, тело которого приходит частями: сервер уже прочитал сессию, а тело
 * ещё нет. between() выполняется между частями (возврат, вход в другой вкладке).
 */
function slowRequest(base, cookie, method, urlPath, headers, payload, between) {
  const u = new URL(base + urlPath);
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const half = Math.max(1, Math.floor(buf.length / 2));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { Cookie: cookie, 'Content-Length': buf.length, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch { /* не JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.write(buf.subarray(0, half));
    setTimeout(async () => {
      try { await between(); } catch (e) { reject(e); return; }
      req.end(buf.subarray(half));
    }, 50);
  });
}

test('ревью HIGH 1: путь в любом регистре — журнал пишется и /API/DB, и /Api/Rpc, и /API/USERS, и /Api/Storage; после авто-конца — 409', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const id = actingSession(db, BOSS).act_as_id;
    const w = { table: 'visit_services', op: 'update', values: { status: 'completed' }, filters: [{ col: 'id', op: 'eq', val: 7 }] };
    assert.equal((await call(base, boss, 'POST', '/API/DB', w)).status, 200);
    assert.equal((await call(base, boss, 'POST', '/Api/Db/', w)).status, 200);
    const list = await call(base, boss, 'POST', '/Api/Rpc/procedures_list', {});
    const users = await call(base, boss, 'PATCH', '/API/USERS/' + DOC, { full_name: 'Иванова А. Б.' });
    const up = await fetch(base + '/Api/Storage/clinic-docs/misc/act-as-case.pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Cookie: boss, 'X-Em-Act-As': String(id) }, body: Buffer.from('%PDF-1.4 x') });
    await up.arrayBuffer();
    assert.deepEqual(actions(db, id).map((r) => ({ ...r })), [
      { kind: 'db', name: 'visit_services.update', status: 200 },
      { kind: 'db', name: 'visit_services.update', status: 200 },
      { kind: 'rpc', name: 'procedures_list', status: list.status },
      { kind: 'users', name: 'PATCH /users/' + DOC, status: users.status },
      { kind: 'storage', name: 'POST /storage/clinic-docs', status: up.status },
    ]);
    // Заголовок вкладки проверяется и на пути в другом регистре.
    assert.equal((await call(base, boss, 'POST', '/API/DB', w, {}, { tab: false })).json.error.code, 'act_as_changed');

    startedAgo(db, BOSS, 3 * 3600 * 1000);
    for (const [method, p, body] of [['POST', '/API/db', w], ['POST', '/api/DB', w], ['POST', '/API/RPC/procedures_list', {}], ['GET', '/API/USERS'], ['GET', '/Api/Storage/clinic-docs/misc/act-as-case.pdf']]) {
      const r = await call(base, boss, method, p, body);
      assert.equal(r.status, 409, method + ' ' + p);
      assert.equal(r.json.error.code, 'act_as_ended', method + ' ' + p);
    }
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 7').get().status, 'completed');
    assert.equal((await call(base, boss, 'GET', '/API/AUTH/me')).status, 200, '/api/auth — в любом регистре — открыт');
  } finally { server.close(); }
});

test('ревью HIGH 2: документ врача в visit_documents от имени — 403 R3 (создать, перевести в документ врача, править его; patient_card_doc_add; история болезни); прочее — можно', async () => {
  const { db, server, base } = await startServer();
  try {
    const doc = await login(base, 'doc');
    // Сам врач пишет заключение — как прежде.
    const own = await db_(base, doc, { table: 'visit_documents', op: 'insert', returning: true, single: 'single',
      values: { doc_type: 'conclusion', title: 'Заключение', patient_id: 1, visit_id: 1, visit_service_id: 7, body: { a: 1 } } });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    const ownId = own.json.data.id;

    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const ins = (doc_type) => db_(base, boss, { table: 'visit_documents', op: 'insert', returning: true, single: 'single',
      values: { doc_type, title: 'Документ', patient_id: 1, visit_id: 1, visit_service_id: 7, body: { a: 1 } } });
    for (const t of ['protocol', 'conclusion', 'diag', 'case_file', 'lab', 'Protocol', ' CONCLUSION ']) {
      const r = await ins(t);
      assert.equal(r.status, 403, t);
      assert.equal(r.json.error.code, 'sign_while_acting', t);
      assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL, t);
    }
    const before = db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n;
    // Заметка без текста документа (body) — не документ врача (с текстом — ревью-2, ниже).
    const note = await db_(base, boss, { table: 'visit_documents', op: 'insert', returning: true, single: 'single',
      values: { doc_type: 'note', title: 'Документ', patient_id: 1, visit_id: 1, visit_service_id: 7 } });
    assert.equal(note.status, 200, 'заметка — не документ врача: ' + JSON.stringify(note.json));
    const noteId = note.json.data.id;
    const toProtocol = await db_(base, boss, { table: 'visit_documents', op: 'update', values: { doc_type: 'protocol' }, filters: [{ col: 'id', op: 'eq', val: noteId }] });
    assert.equal(toProtocol.status, 403, 'черновик в протокол — от имени нельзя');
    assert.equal(toProtocol.json.error.code, 'sign_while_acting');
    const editOwnConclusion = await db_(base, boss, { table: 'visit_documents', op: 'update', values: { body: { a: 2 } }, filters: [{ col: 'id', op: 'eq', val: ownId }] });
    assert.equal(editOwnConclusion.status, 403, 'править заключение врача от имени нельзя');
    assert.equal(editOwnConclusion.json.error.code, 'sign_while_acting');
    assert.equal((await db_(base, boss, { table: 'visit_documents', op: 'update', values: { title: 'Заметка 2' }, filters: [{ col: 'id', op: 'eq', val: noteId }] })).status, 200, 'свою заметку — можно');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, before + 1);
    assert.equal(db.prepare('SELECT doc_type FROM visit_documents WHERE id = ?').get(noteId).doc_type, 'note');

    for (const t of ['conclusion', 'protocol', 'diag']) {
      const r = await rpc(base, boss, 'patient_card_doc_add', { patient_id: 1, row: { doc_type: t, title: 'Заключение', body: { a: 1 }, visit_service_id: 7, visit_id: 1 } });
      assert.equal(r.status, 403, 'patient_card_doc_add ' + t);
      assert.equal(r.json.error.code, 'sign_while_acting');
    }
    const plain = await rpc(base, boss, 'patient_card_doc_add', { patient_id: 1, row: { doc_type: 'note', title: 'Заметка' } });
    assert.notEqual(plain.json.error && plain.json.error.code, 'sign_while_acting', 'заметка через карту — не R3');
    const cf = await rpc(base, boss, 'admission_case_file_save', { admission_id: 1 });
    assert.equal(cf.status, 403, 'история болезни (case_file) от имени');
    assert.equal(cf.json.error.code, 'sign_while_acting');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM visit_documents WHERE doc_type IN ('protocol','conclusion','diag','case_file','lab') AND created_by = ? AND id <> ?").get(DOC, ownId).n, 0);
  } finally { server.close(); }
});

test('ревью-2 LOW 1: текст документа (body) в visit_documents от имени — 403 R3 при любом виде (заметка, без вида): архив открывает его бланком заключения; без текста — можно', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const ins = (values) => db_(base, boss, { table: 'visit_documents', op: 'insert', returning: true, single: 'single',
      values: { title: 'Заключение', patient_id: 1, visit_id: 1, visit_service_id: 7, ...values } });
    for (const values of [{ doc_type: 'note', body: { conclusion: 'здоров' } }, { body: { conclusion: 'здоров' } }, { doc_type: 'upload', body: 'текст' }, { doc_type: 'note', body: [1] }]) {
      const r = await ins(values);
      assert.equal(r.status, 403, JSON.stringify(values));
      assert.equal(r.json.error.code, 'sign_while_acting', JSON.stringify(values));
      assert.equal(r.json.error.message, ACT_AS_SIGN_REFUSAL);
    }
    const arr = await db_(base, boss, { table: 'visit_documents', op: 'insert', values: [{ doc_type: 'note', title: 'a', patient_id: 1 }, { doc_type: 'note', title: 'b', patient_id: 1, body: { x: 1 } }] });
    assert.equal(arr.status, 403, 'пачка, где у одной строки текст');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0, 'ничего не записано');

    // Без текста — можно: заметка-название, пустой текст.
    const plainNote = await ins({ doc_type: 'note' });
    assert.equal(plainNote.status, 200, JSON.stringify(plainNote.json));
    for (const empty of [null, '', {}]) assert.equal((await ins({ doc_type: 'note', body: empty })).status, 200, 'пустой текст: ' + JSON.stringify(empty));
    const id = plainNote.json.data.id;
    // Правка: текст — нельзя (и стереть тоже), название — можно.
    for (const body of [{ conclusion: 'здоров' }, null]) {
      const r = await db_(base, boss, { table: 'visit_documents', op: 'update', values: { body }, filters: [{ col: 'id', op: 'eq', val: id }] });
      assert.equal(r.status, 403, 'правка текста: ' + JSON.stringify(body));
      assert.equal(r.json.error.code, 'sign_while_acting');
    }
    assert.equal((await db_(base, boss, { table: 'visit_documents', op: 'update', values: { title: 'Заметка' }, filters: [{ col: 'id', op: 'eq', val: id }] })).status, 200);
    // Та же дверь в карте пациента: текст — нельзя, название (и файл — «upload») — как прежде.
    const card = await rpc(base, boss, 'patient_card_doc_add', { patient_id: 1, row: { doc_type: 'note', title: 'Заключение', body: { conclusion: 'здоров' } } });
    assert.equal(card.status, 403);
    assert.equal(card.json.error.code, 'sign_while_acting');
    const cardPlain = await rpc(base, boss, 'patient_card_doc_add', { patient_id: 1, row: { doc_type: 'upload', title: 'Скан' } });
    assert.notEqual(cardPlain.json.error && cardPlain.json.error.code, 'sign_while_acting');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM visit_documents WHERE body IS NOT NULL AND body <> '' AND body <> '{}'").get().n, 0, 'документа с текстом от имени нет');

    // Сам врач — как прежде: заметка с текстом.
    await back(base, boss);
    const doc = await login(base, 'doc');
    assert.equal((await db_(base, doc, { table: 'visit_documents', op: 'insert', values: { doc_type: 'note', title: 'Своё', patient_id: 1, body: { a: 1 } } })).status, 200);
  } finally { server.close(); }
});

test('ревью MEDIUM 3: вкладки — /me и вход отдают act_as_id; запись с чужим, пустым или прежним номером — 409 act_as_changed; чтения файлов — как прежде', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    assert.equal((await call(base, boss, 'GET', '/api/auth/me')).json.act_as_id, 0);
    // Файл кладёт сам администратор (без входа от имени и без заголовка — как прежде).
    const up = await fetch(base + '/api/storage/clinic-docs/misc/tab-read.pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Cookie: boss }, body: Buffer.from('%PDF-1.4 x') });
    assert.equal(up.status, 200, await up.text());
    const start = await actAs(base, boss, DOC);
    const id = start.json.act_as_id;
    assert.ok(Number.isInteger(id) && id > 0);
    assert.equal(id, actingSession(db, BOSS).act_as_id);
    assert.equal((await call(base, boss, 'GET', '/api/auth/me')).json.act_as_id, id);

    const w = { table: 'visit_services', op: 'update', values: { status: 'completed' }, filters: [{ col: 'id', op: 'eq', val: 7 }] };
    const changed = ACT_AS_MESSAGES.changed;
    for (const [label, headers, opts] of [['без заголовка', {}, { tab: false }], ['0', { 'X-Em-Act-As': '0' }, {}], ['чужой', { 'X-Em-Act-As': String(id + 5) }, {}], ['мусор', { 'X-Em-Act-As': 'abc' }, {}]]) {
      for (const [m, p, b] of [['POST', '/api/db', w], ['POST', '/api/rpc/procedures_list', {}], ['PATCH', '/api/users/' + DOC, { full_name: 'X' }], ['DELETE', '/api/storage/clinic-docs/misc/none.pdf']]) {
        const r = await call(base, boss, m, p, b, headers, opts);
        assert.equal(r.status, 409, `${label}: ${m} ${p}`);
        assert.equal(r.json.error.code, 'act_as_changed', `${label}: ${m} ${p}`);
        assert.equal(r.json.error.message, changed);
      }
    }
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 7').get().status, 'in_progress');
    assert.deepEqual(actions(db, id), [], 'отказанная вкладкой запись — не действие');
    assert.equal((await update(base, boss, 'visit_services', 7, { status: 'completed' })).status, 200, 'свой номер — можно');

    // Чтения (GET) — без заголовка: картинки и скачивание файлов.
    const img = await fetch(base + '/api/storage/clinic-docs/misc/tab-read.pdf', { headers: { Cookie: boss } });
    assert.equal(img.status, 200);
    await img.arrayBuffer();
    assert.notEqual((await call(base, boss, 'GET', '/api/users', undefined, {}, { tab: false })).status, 409);

    // Вкладка A вернулась — вкладка B (кабинет врача) подписывает: 409, ничего не записано.
    const tabB = TAB.get(boss);
    await back(base, boss);
    const signed = NOTES([SIGNED, SIGNED_NEW]);
    const notesBefore = db.prepare('SELECT notes FROM visit_services WHERE id = 1').get().notes;
    const sign = await call(base, boss, 'POST', '/api/db', { table: 'visit_services', op: 'update',
      values: { notes: signed, [NOTES_BASE_KEY]: notesBaseOf(notesBefore) }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, { 'X-Em-Act-As': String(tabB) });
    assert.equal(sign.status, 409);
    assert.equal(sign.json.error.code, 'act_as_changed');
    assert.equal(db.prepare('SELECT notes FROM visit_services WHERE id = 1').get().notes, notesBefore);
    const arch = await call(base, boss, 'POST', '/api/rpc/visit_document_archive', { visit_service_id: 7, doc_type: 'protocol', body: { a: 1 } }, { 'X-Em-Act-As': String(tabB) });
    assert.equal(arch.json.error.code, 'act_as_changed');
    // Без заголовка и без входа от имени — как прежде (старые вкладки, другие страницы).
    assert.equal((await call(base, boss, 'POST', '/api/db', w, {}, { tab: false })).status, 200);
    assert.equal((await call(base, boss, 'POST', '/api/db', w, { 'X-Em-Act-As': '0' })).status, 200);

    // Наоборот: вкладка A начала вход от имени — админская вкладка C с номером 0 пишет: 409.
    await actAs(base, boss, NURSE);
    const c = await call(base, boss, 'POST', '/api/db', w, { 'X-Em-Act-As': '0' });
    assert.equal(c.status, 409);
    assert.equal(c.json.error.code, 'act_as_changed');
  } finally { server.close(); }
});

test('ревью MEDIUM 4: администратор со своей ролью, где «Сотрудники» не на «Изменении», не входит от имени и не читает журнал; отнятое право кончает вход', async () => {
  const { db, server, base } = await startServer();
  try {
    const grants = (code, level) => db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run(code, JSON.stringify({ grants: { settings: 'view', 'settings.employees': level } }));
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('adm_none', 'Админ без сотрудников', 'admin'), ('adm_view', 'Админ: просмотр', 'admin'), ('adm_edit', 'Админ: изменение', 'admin')").run();
    grants('adm_none', 'none');
    grants('adm_view', 'view');
    grants('adm_edit', 'edit');
    const pw = hashPassword('password1');
    const ins = db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?, ?, ?, ?, 'admin', ?)");
    ins.run(30, 'anone', pw, 'Админ Н.', 'adm_none');
    ins.run(31, 'aview', pw, 'Админ П.', 'adm_view');
    ins.run(32, 'aedit', pw, 'Админ И.', 'adm_edit');
    for (const name of ['anone', 'aview']) {
      const c = await login(base, name);
      const r = await actAs(base, c, REG);
      assert.equal(r.status, 403, name);
      assert.equal(r.json.error.message, ACT_AS_MESSAGES.noEmployeesRight, name);
      const log = await call(base, c, 'GET', '/api/auth/act-as/log?user_id=' + BOSS);
      assert.equal(log.status, 403, name + ' — журнал');
      assert.equal(log.json.error.message, ACT_AS_MESSAGES.logForbidden);
    }
    const edit = await login(base, 'aedit');
    assert.equal((await actAs(base, edit, REG)).status, 200, '«Сотрудники: Изменение» — можно');
    await back(base, edit);
    assert.equal((await call(base, edit, 'GET', '/api/auth/act-as/log?user_id=' + REG)).status, 200);

    // Право отняли посреди входа от имени — вход кончается: «Сессия завершена».
    await actAs(base, edit, REG);
    grants('adm_edit', 'view');
    const m = await call(base, edit, 'GET', '/api/auth/me');
    assert.equal(m.json.user.id, 32);
    assert.deepEqual(m.json.act_as_ended, { reason: 'Сессия завершена' });
  } finally { server.close(); }
});

test('ревью LOW 5: журналы пациента и счёта через /api/db от имени — имя ставит сервер, «сотрудник (от имени: адм. …)», что бы ни прислал экран', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const want = 'Иванова А. (от имени: адм. Петров П.)';
    let r = await db_(base, boss, { table: 'patient_activity_log', op: 'insert',
      values: { patient_id: 1, entity_type: 'patient', action: 'updated', summary: 'x', actor_user_id: DOC, actor_name: 'Самозванец' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await db_(base, boss, { table: 'patient_activity_log', op: 'insert',
      values: [{ patient_id: 1, entity_type: 'patient', action: 'updated', summary: 'y', actor_user_id: DOC }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await db_(base, boss, { table: 'invoice_audit_log', op: 'insert',
      values: { visit_id: 1, action: 'note', actor_user_id: DOC, notes: 'z' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(db.prepare('SELECT actor_name FROM patient_activity_log ORDER BY id').all().map((x) => x.actor_name), [want, want]);
    assert.equal(db.prepare('SELECT actor_name FROM invoice_audit_log').get().actor_name, want);

    await back(base, boss);
    r = await db_(base, boss, { table: 'patient_activity_log', op: 'insert',
      values: { patient_id: 1, entity_type: 'patient', action: 'updated', summary: 'w', actor_user_id: BOSS, actor_name: 'Петров П.' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(db.prepare('SELECT actor_name FROM patient_activity_log ORDER BY id DESC LIMIT 1').get().actor_name, 'Петров П.', 'без входа от имени — как прислал экран');
  } finally { server.close(); }
});

test('ревью LOW 6: брошенный вход (без конца, старше 2 часов) журнал показывает «Истекло» с концом в начало + 2 часа', async () => {
  const { db, server, base } = await startServer();
  try {
    const a = await login(base, 'boss');
    await actAs(base, a, DOC);
    const startedAt = startedAgo(db, BOSS, 5 * 3600 * 1000);
    const b = await login(base, 'boss2');
    const r = await call(base, b, 'GET', '/api/auth/act-as/log?user_id=' + DOC);
    assert.equal(r.status, 200);
    assert.equal(r.json.sessions[0].end_reason, 'Истекло');
    assert.equal(r.json.sessions[0].ended_at, iso(Date.parse(startedAt) + 2 * 3600 * 1000));
    const one = await call(base, b, 'GET', `/api/auth/act-as/log?user_id=${DOC}&act_as_id=${r.json.sessions[0].id}`);
    assert.equal(one.json.session.end_reason, 'Истекло');
    // Идущий вход (меньше 2 часов) — без конца.
    const a2 = await login(base, 'boss');
    await actAs(base, a2, NURSE);
    const live = await call(base, b, 'GET', '/api/auth/act-as/log?user_id=' + NURSE);
    assert.equal(live.json.sessions[0].ended_at, null);
    assert.equal(live.json.sessions[0].end_reason, null);
  } finally { server.close(); }
});

test('ревью LOW 7: долгая запись (/api/db, файл) — вход от имени сменился, пока шло тело, — 409, ничего не записано', async () => {
  const { db, server, base, dataDir } = await startServer();
  try {
    const boss = await login(base, 'boss');
    await actAs(base, boss, DOC);
    const id = TAB.get(boss);
    const body = JSON.stringify({ table: 'visit_services', op: 'update', values: { status: 'completed' }, filters: [{ col: 'id', op: 'eq', val: 7 }] });
    let r = await slowRequest(base, boss, 'POST', '/api/db', { 'Content-Type': 'application/json', 'X-Em-Act-As': String(id) }, body,
      () => back(base, boss));
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'act_as_changed');
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 7').get().status, 'in_progress');

    // Наоборот: начали от имени, пока шло тело записи администратора.
    r = await slowRequest(base, boss, 'POST', '/api/db', { 'Content-Type': 'application/json', 'X-Em-Act-As': '0' }, body,
      () => actAs(base, boss, NURSE));
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'act_as_changed');
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 7').get().status, 'in_progress');

    // 2 часа истекли, пока шёл файл, — 409 act_as_ended, файла нет.
    const id2 = TAB.get(boss);
    r = await slowRequest(base, boss, 'POST', '/api/storage/clinic-docs/misc/slow.pdf', { 'Content-Type': 'application/pdf', 'X-Em-Act-As': String(id2) },
      Buffer.from('%PDF-1.4 ' + 'x'.repeat(2000)), async () => { startedAgo(db, BOSS, 3 * 3600 * 1000); });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'act_as_ended');
    assert.equal(fs.existsSync(path.join(dataDir, 'storage', 'clinic-docs', 'misc', 'slow.pdf')), false, 'файл не записан');
  } finally { server.close(); }
});
