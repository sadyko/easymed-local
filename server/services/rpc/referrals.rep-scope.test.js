// REP_OWN_DOCTORS_V1 (2026-11-18) — медпредставитель видит только своих врачей.
//
// Владелец: «Med rep should not see internal doctors and they only have to see only
// their own doctors on their name, and even they shouldn't see other med rep's doctors
// also». Проверяется на обеих дверях: RPC экрана «Реферирование» и /api/db (компилятор
// запросов — вкладка «Врачи-источники», карточки, выпадающие списки). Остальным ролям
// список не меняется — иначе регистратура не смогла бы выбрать, кто направил.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { isRepresentative } from '../representative.js';
import {
  referralsRepresentatives, referralsInternal, referralsDoctorDetail, referralsActivity, referralsSourceDetail,
  referralsAssignRepresentative, referralsRepresentativeOptions, referralsScope, RpcError,
} from './referrals.js';
import { getRpc } from './index.js';

const ymd = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const atNoon = (daysAgo) => new Date(ymd(daysAgo) + 'T12:00:00').toISOString();
const period = { from: ymd(30), to: ymd(0) };

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const repOne = { id: 4, role: 'callcenter', custom_role_code: 'medrep' };
const repTwo = { id: 8, role: 'callcenter', custom_role_code: 'medrep' };
// Клиника завела свою роль «Медпредставитель» под своим кодом (FIX_318_V1 L4).
const repOwnCode = { id: 9, role: 'callcenter', custom_role_code: 'rep_local' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, specialty, custom_role_code, is_doctor) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Администратор', '', null, 0);
  u.run(2, 'reg', 'x', 'registrar', 'Регистратор', '', null, 0);
  u.run(3, 'doc', 'x', 'doctor', 'Врач Клиники', 'Невролог', null, 1);
  u.run(4, 'rep1', 'x', 'callcenter', 'Представитель Один', '', 'medrep', 0);
  u.run(8, 'rep2', 'x', 'callcenter', 'Представитель Два', '', 'medrep', 0);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('rep_local', 'Медпредставитель', 'callcenter')").run();
  u.run(9, 'rep3', 'x', 'callcenter', 'Представитель Свой Код', '', 'rep_local', 0);
  // Раздел «Реферирование» открыт ролям представителей (клиника решает это в «Ролях»).
  const perm = JSON.stringify({ sections: ['referrals'], levels: { referrals: 'viewer' }, patient_tabs: {} });
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('medrep', perm);
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('rep_local', perm);

  const src = db.prepare('INSERT INTO referral_sources (name, specialty, representative_id) VALUES (?,?,?)');
  const A = Number(src.run('Врач Первого', 'ЛОР', 4).lastInsertRowid);
  const B = Number(src.run('Врач Второго', 'Терапевт', 8).lastInsertRowid);
  const C = Number(src.run('Ничей Врач', 'Хирург', null).lastInsertRowid);
  const D = Number(src.run('Врач Своего Кода', 'Уролог', 9).lastInsertRowid);
  const internal = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 3').get().id;   // заводит триггер (мигр. 122)

  const pat = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?,?,?)');
  pat.run(10, 'Пациент А', '+998900000010');
  pat.run(11, 'Пациент Б', '+998900000011');
  pat.run(12, 'Пациент В', '+998900000012');
  const vis = db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, referral_source_id) VALUES (?,?,?,?,?)');
  vis.run(10, 3, atNoon(1), 'arrived', A);
  vis.run(11, 3, atNoon(2), 'arrived', B);
  vis.run(12, 3, atNoon(3), 'arrived', B);
  return { db, A, B, C, D, internal };
}

const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const forbidden = (e) => e instanceof RpcError && e.status === 403;
const notFound = (e) => e instanceof RpcError && e.status === 404;

test('кто представитель: роль medrep и своя роль с именем «Медпредставитель»; администратор — никогда', () => {
  const { db } = fresh();
  assert.equal(isRepresentative(db, repOne), true);
  assert.equal(isRepresentative(db, repOwnCode), true);
  assert.equal(isRepresentative(db, registrar), false);
  assert.equal(isRepresentative(db, { id: 1, role: 'admin', custom_role_code: 'medrep' }), false);
  assert.deepEqual(referralsScope(db, {}, repOne), { own_only: true });
  assert.deepEqual(referralsScope(db, {}, admin), { own_only: false });
  assert.equal(typeof getRpc('referrals_scope'), 'function', 'referrals_scope зарегистрирован в rpc/index.js');
});

test('«Представители»: у представителя — только свои врачи, только он сам, пациенты — только его врачей', () => {
  const { db, A, B, C, D } = fresh();
  const mine = referralsRepresentatives(db, period, repOne);
  assert.equal(mine.own_only, true);
  assert.deepEqual(ids(mine.sources), [A]);
  assert.deepEqual(mine.representatives.map((r) => r.id), [4]);
  assert.equal(mine.totals.assigned, 1);
  assert.equal(mine.totals.unassigned, 0);
  assert.equal(mine.totals.representatives, 1);
  assert.equal(mine.totals.patients, 1, 'пациенты врачей другого представителя не считаются');

  assert.deepEqual(ids(referralsRepresentatives(db, period, repTwo).sources), [B]);
  assert.deepEqual(ids(referralsRepresentatives(db, period, repOwnCode).sources), [D]);

  const all = referralsRepresentatives(db, period, admin);
  assert.equal(all.own_only, false);
  assert.deepEqual(ids(all.sources), [A, B, C, D].sort((a, b) => a - b));
  assert.equal(all.totals.patients, 3);
});

test('«Внутренние врачи» и карточка врача клиники представителю закрыты; администратору — как прежде', () => {
  const { db } = fresh();
  assert.throws(() => referralsInternal(db, period, repOne), forbidden);
  assert.throws(() => referralsDoctorDetail(db, { doctor_id: 3, ...period }, repOne), forbidden);
  assert.ok(referralsInternal(db, period, admin).doctors.some((d) => d.id === 3));
  assert.equal(referralsDoctorDetail(db, { doctor_id: 3, ...period }, admin).doctor.id, 3);
});

test('«Активность»: только свои, какой бы фильтр представителя ни прислали', () => {
  const { db, A } = fresh();
  for (const representative_id of [undefined, 'all', 'none', 8, '8']) {
    const r = referralsActivity(db, { representative_id }, repOne);
    assert.ok(r.sources.every((s) => s.id === A), 'фильтр ' + representative_id + ': ' + JSON.stringify(ids(r.sources)));
    assert.deepEqual(r.representatives.map((x) => x.id), [4]);
    assert.equal(r.own_only, true);
  }
});

test('«Подробнее»: чужой, ничей и врач клиники — как несуществующий; свой открывается', () => {
  const { db, A, B, C, internal } = fresh();
  for (const id of [B, C, internal, 99999]) {
    assert.throws(() => referralsSourceDetail(db, { source_id: id, ...period }, repOne), notFound, 'источник ' + id);
  }
  const own = referralsSourceDetail(db, { source_id: A, ...period }, repOne);
  assert.equal(own.source.id, A);
  assert.equal(own.visits.length, 1);
  assert.equal('representative_id' in own.source, false, 'служебная колонка проверки в ответ не уходит');
  assert.equal(referralsSourceDetail(db, { source_id: B, ...period }, admin).source.id, B);
});

test('закрепление: представитель с правом создавать источник берёт ничьего только себе, чужого не трогает', () => {
  const { db, A, B, C } = fresh();
  // Регистраторская основа даёт право создавать источник (реестр: insert — admin, registrar).
  const repDesk = { id: 4, role: 'registrar', custom_role_code: 'medrep' };
  assert.deepEqual(referralsRepresentativeOptions(db, {}, repDesk).representatives.map((r) => r.id), [4]);
  assert.throws(() => referralsAssignRepresentative(db, { source_id: C, user_id: 8 }, repDesk), forbidden, 'другому — нет');
  assert.throws(() => referralsAssignRepresentative(db, { source_id: B, user_id: 4 }, repDesk), notFound, 'чужого — как несуществующего');
  assert.throws(() => referralsAssignRepresentative(db, { source_id: A, user_id: null }, repDesk), (e) => e instanceof RpcError && (e.status === 403));
  assert.deepEqual(referralsAssignRepresentative(db, { source_id: C, user_id: 4 }, repDesk), { source_id: C, representative_id: 4 });
  assert.equal(db.prepare('SELECT representative_id FROM referral_sources WHERE id = ?').get(B).representative_id, 8, 'чужой остался чужим');
});

test('/api/db: представитель получает только свои строки referral_sources; регистратура — все, как прежде', () => {
  const { db, A, B, C, D, internal } = fresh();
  const run = (user, filters = []) => {
    const q = compile({ op: 'select', table: 'referral_sources', columns: 'id', filters }, user, { db });
    return db.prepare(q.sql).all(...q.params).map((r) => r.id).sort((a, b) => a - b);
  };
  assert.deepEqual(run(repOne), [A]);
  assert.deepEqual(run(repOne, [{ col: 'id', op: 'eq', val: B }]), [], 'чужой по номеру — пусто');
  assert.deepEqual(run(repOne, [{ col: 'id', op: 'eq', val: internal }]), [], 'врач клиники по номеру — пусто');
  assert.deepEqual(run(repTwo), [B]);
  const everyone = [A, B, C, D, internal].sort((a, b) => a - b);
  assert.deepEqual(run(registrar), everyone);
  assert.deepEqual(run(admin), everyone);
});
