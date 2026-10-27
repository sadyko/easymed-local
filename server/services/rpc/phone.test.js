// CRM_PHONE_V1 (2026-10-17) — ТЕЛЕФОН ВНУТРИ CRM: четыре RPC рабочего места телефониста.
//
// Перенос phone/index.test.js (CALLCENTER_OPERATOR_V1): пять рабочих мест, каждое со
// СВОИМ набором прав, и один звонок с записью. Каждый вызов обязан спрашивать СВОЁ
// право, а ссылка на запись — приходить только тому, кому прослушивание выдано.
// Отдельной программы больше нет, но дыра, которую эти тесты закрывали, никуда не
// делась: журнал звонков — вся история обращений клиники, и право ПОЗВОНИТЬ его
// не открывает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyPhoneMe, telephonyMyExtension, telephonyExtensions, telephonyCallLog } from './phone.js';
import { RpcError } from './telephony.js';
import { getRpc } from './index.js';

function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

// Пять рабочих мест, каждое со СВОИМ набором прав, — чтобы «пустил» нельзя было
// спутать с «не пустил» по соседнему праву.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  for (const [id, name, full, role] of [
    [1, 'adm', 'Администратор', 'admin'],
    [2, 'dialer', 'Только набор', 'nurse'],
    [3, 'watcher', 'Только журнал', 'lab'],
    [4, 'listener', 'Журнал и записи', 'cashier'],
    [5, 'nobody', 'Без телефонии', 'doctor'],
  ]) mk.run(id, name, 'x', full, role);
  // Миграция 141 уже записала этим ролям явные «Нет» — выдаём поверх ровно то,
  // что проверяем.
  setGrants(db, 'nurse',   { 'crm.dial': 'edit', 'crm.calls': 'none', 'crm.recording': 'none' });
  setGrants(db, 'lab',     { 'crm.dial': 'none', 'crm.calls': 'view', 'crm.recording': 'none' });
  setGrants(db, 'cashier', { 'crm.dial': 'none', 'crm.calls': 'view', 'crm.recording': 'edit' });
  db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number, billsec, recording_url)
              VALUES ('c-1', '2026-09-20T08:00:00Z', 0, '998901112233', '101', 42, 'https://rec/1.mp3')`).run();
  return db;
}
const U = {
  adm: { id: 1, role: 'admin' }, dialer: { id: 2, role: 'nurse' }, watcher: { id: 3, role: 'lab' },
  listener: { id: 4, role: 'cashier' }, nobody: { id: 5, role: 'doctor' },
};
const denied = (fn, status = 403) => assert.throws(fn, (e) => e instanceof RpcError && e.status === status);

test('все четыре вызова зарегистрированы в реестре RPC', () => {
  for (const n of ['telephony_phone_me', 'telephony_my_extension', 'telephony_extensions', 'telephony_call_log']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});

test('без прав — отказ на всём', async () => {
  const db = seed();
  denied(() => telephonyPhoneMe(db, {}, U.nobody));
  denied(() => telephonyCallLog(db, {}, U.nobody));
  denied(() => telephonyMyExtension(db, { extension: '101' }, U.nobody));
  await assert.rejects(() => telephonyExtensions(db, {}, U.nobody), (e) => e instanceof RpcError && e.status === 403);
});

// ГЛАВНОЕ. Журнал звонков — это вся история обращений клиники: номера, время,
// кто звонил и ссылка на запись разговора. Право ПОЗВОНИТЬ его не открывает.
test('журнал звонков открывает право «Журнал звонков», а не право «Позвонить»', () => {
  const db = seed();
  assert.throws(() => telephonyCallLog(db, {}, U.dialer), (e) => e.status === 403 && /«Журнал звонков»/.test(e.message),
    'человеку с одним лишь набором номера отдали весь журнал звонков клиники');
  assert.equal(telephonyCallLog(db, {}, U.watcher).calls.length, 1);
  assert.equal(telephonyCallLog(db, {}, U.adm).calls.length, 1);
});

test('набор и своя трубка — право «Позвонить», а не право журнала', async () => {
  const db = seed();
  denied(() => telephonyMyExtension(db, { extension: '101' }, U.watcher));
  await assert.rejects(() => telephonyExtensions(db, {}, U.watcher), (e) => e.status === 403);
  assert.deepEqual(telephonyMyExtension(db, { extension: '101' }, U.dialer), { ok: true, extension: '101' });
  assert.deepEqual(await telephonyExtensions(db, {}, U.dialer), { extensions: [], error: '' });
});

// Экран рисует «Позвонить», журнал и «Прослушать» по трём флагам — тем же воротам,
// что у самих вызовов: кнопка, которую сервер всё равно откажет, не рисуется.
test('рабочее место (me): три флага прав честные', () => {
  const db = seed();
  const flags = (u) => { const m = telephonyPhoneMe(db, {}, u); return [m.may_dial, m.may_log, m.may_hear]; };
  assert.deepEqual(flags(U.dialer),   [true,  false, false]);
  assert.deepEqual(flags(U.watcher),  [false, true,  false]);
  assert.deepEqual(flags(U.listener), [false, true,  true]);
  assert.deepEqual(flags(U.adm),      [true,  true,  true]);
  const me = telephonyPhoneMe(db, {}, U.dialer);
  assert.equal(me.full_name, 'Только набор');
  assert.equal(me.extension, '');
  assert.equal(me.line, null, 'линии в тесте нет');
});

// ССЫЛКА НА ЗАПИСЬ — ОТДЕЛЬНОЕ ПРАВО, И В ЖУРНАЛЕ ЕЁ БЫТЬ НЕ ДОЛЖНО. Адрес записи
// у Binotel и «Моих Звонков» прямой: уехав в журнал, он даёт голос пациента
// любому, кто журнал открыл. Флаг has_recording остаётся — кнопка рисуется по
// нему и получает честный отказ.
test('запись разговора приходит только тому, кому выдано прослушивание', () => {
  const db = seed();
  const seen = telephonyCallLog(db, {}, U.watcher);
  assert.equal(seen.may_hear, false);
  assert.equal(seen.calls[0].recording_url, null, 'ссылка на запись уехала в журнал мимо права «Прослушать»');
  assert.equal(seen.calls[0].has_recording, true, 'журнал скрыл сам факт записи — кнопке не из чего взяться');
  const heard = telephonyCallLog(db, {}, U.listener);
  assert.equal(heard.may_hear, true);
  assert.equal(heard.calls[0].recording_url, 'https://rec/1.mp3', 'выданное право прослушивания не отдало запись');
  assert.equal(telephonyCallLog(db, {}, U.adm).calls[0].recording_url, 'https://rec/1.mp3');
});

test('своя трубка: цифры не длиннее двенадцати, пишется ТОЛЬКО себе', () => {
  const db = seed();
  denied(() => telephonyMyExtension(db, { extension: 'abc' }, U.dialer), 400);
  denied(() => telephonyMyExtension(db, { extension: '1234567890123' }, U.dialer), 400);
  telephonyMyExtension(db, { extension: '102' }, U.dialer);
  const ext = (id) => db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(id).pbx_extension;
  assert.equal(ext(2), '102');
  assert.equal(ext(1), null, 'трубка назначилась чужой строке');
  assert.equal(telephonyPhoneMe(db, {}, U.dialer).extension, '102');
  telephonyMyExtension(db, { extension: '' }, U.dialer);
  assert.equal(ext(2), null, 'пустой выбор должен снимать трубку, а не писать пустую строку');
});

test('журнал: предел зажат в 1..200, по умолчанию 60; поля для экрана на месте', () => {
  const db = seed();
  const add = db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number, billsec)
                          VALUES (?, ?, 1, '998935550112', '101', 0)`);
  add.run('c-2', '2026-09-20T09:00:00Z'); add.run('c-3', '2026-09-20T10:00:00Z'); add.run('c-4', '2026-09-20T11:00:00Z');
  assert.equal(telephonyCallLog(db, { limit: 2 }, U.adm).calls.length, 2);
  assert.equal(telephonyCallLog(db, { limit: 0 }, U.adm).calls.length, 1);
  assert.equal(telephonyCallLog(db, { limit: 'x' }, U.adm).calls.length, 4);
  assert.equal(telephonyCallLog(db, { limit: 999 }, U.adm).calls.length, 4);
  const first = telephonyCallLog(db, {}, U.adm).calls[0];
  assert.equal(first.general_call_id, undefined, 'служебный id вендора экрану не нужен');
  for (const k of ['id', 'started_at', 'call_type', 'external_number', 'internal_number', 'billsec', 'disposition', 'patient_id', 'patient_name', 'patient_mrn', 'operator_name', 'has_recording']) {
    assert.ok(k in first, 'в строке журнала нет поля ' + k);
  }
  assert.equal(first.started_at, '2026-09-20T11:00:00Z', 'журнал не отсортирован от свежего к старому');
});

test('список трубок станции: без onlinePBX пусто, с ним — включённые номера; отказ станции — словом', async () => {
  const db = seed();
  assert.deepEqual(await telephonyExtensions(db, {}, U.adm), { extensions: [], error: '' });
  db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
              VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1, ?, ?, 30)`)
    .run(JSON.stringify({ domain: 'clinic.onpbx.ru' }), JSON.stringify({ auth_key: 'a', key_id: 'k', key: 'v' }));
  const asked = [];
  const ok = async (domain, method) => { asked.push(domain + ' ' + method); return { ok: true, data: [{ num: 101, enabled: true }, { num: 102, enabled: false }, { num: '103' }] }; };
  assert.deepEqual(await telephonyExtensions(db, {}, U.adm, { pbxCallImpl: ok }), { extensions: ['101', '103'], error: '' });
  assert.deepEqual(asked, ['clinic.onpbx.ru user/get.json']);
  const down = async () => ({ ok: false, reason: 'offline' });
  assert.deepEqual(await telephonyExtensions(db, {}, U.adm, { pbxCallImpl: down }), { extensions: [], error: 'offline' });
});
