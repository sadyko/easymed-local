// REFERRAL_LINE_V1 — правило «кто ставит направившего строки» и «кому вознаграждение за строку».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lineReferralStamp, lineBeneficiaries, isDeskActor, isDoctorActor, LineReferralError,
  recommendationAuthorStamp, EXTERNAL_LINE_ADDS_TO_EXTERNAL_BASE } from './line-referral.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 1);
  u.run(2, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(10, 'doc', 'x', 'doctor', 'Иванов', 1);    // триггер мигр. 122 заводит внутренний источник
  u.run(12, 'doc2', 'x', 'doctor', 'Петров', 1);
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Партнёр')").run();
  db.prepare("INSERT INTO referral_sources (id, name, active) VALUES (901, 'Выключен', 0)").run();
  const src = (id) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(id).id;
  return { db, src };
}
const doctor = { id: 10, role: 'doctor', extra_roles: [], is_doctor: true };
const registrar = { id: 2, role: 'registrar', extra_roles: [], is_doctor: false };
const adminDoctor = { id: 1, role: 'admin', extra_roles: [], is_doctor: true };
const nurse = { id: 5, role: 'nurse', extra_roles: [] };

test('кто есть кто: стойка — администратор и регистратура (и дополнительной ролью); врач — флаг или роль', () => {
  assert.equal(isDeskActor(registrar), true);
  assert.equal(isDeskActor({ id: 3, role: 'doctor', extra_roles: ['registrar'] }), true);
  assert.equal(isDeskActor(doctor), false);
  assert.equal(isDoctorActor(doctor), true);
  assert.equal(isDoctorActor({ id: 4, role: 'nurse', extra_roles: ['head_doctor'] }), true);
  assert.equal(isDoctorActor(nurse), false);
});

test('врач: свой включённый источник, присланное браузером не читается; своя строка — пусто', () => {
  const { db, src } = fresh();
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 12, referred_by_source_id: 900 }), src(10));
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: null }), src(10));
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 10 }), null);
  db.prepare('UPDATE referral_sources SET active = 0 WHERE doctor_id = 10').run();
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 12 }), null);
});

test('стойка: только явно; неверный или выключенный — отказ словами; источник самого исполнителя — пусто', () => {
  const { db, src } = fresh();
  assert.equal(lineReferralStamp(db, registrar, { doctor_id: 12 }), null);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: '' }), null);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: 900 }), 900);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: '900' }), 900);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 'abc' }),
    (e) => e instanceof LineReferralError && e.status === 400);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 901 }), /не найден или выключен/);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 99999 }), /не найден или выключен/);
  assert.equal(lineReferralStamp(db, registrar, { doctor_id: 12, referred_by_source_id: src(12) }), null);
  // Администратор-врач — стойка: свой источник сам не ставится (и его у него нет: триггер мигр. 122 — только role 'doctor').
  assert.equal(lineReferralStamp(db, adminDoctor, { doctor_id: 12 }), null);
});

test('прочие роли и вызов без базы или без сессии — пусто', () => {
  const { db } = fresh();
  assert.equal(lineReferralStamp(db, nurse, { referred_by_source_id: 900 }), null);
  assert.equal(lineReferralStamp(null, registrar, { referred_by_source_id: 900 }), null);
  assert.equal(lineReferralStamp(db, null, { referred_by_source_id: 900 }), null);
});

test('кому вознаграждение: источник визита/пациента — как прежде; источник строки — ещё и ему, если другой и строка не его', () => {
  const P = { id: 900, doctor_id: null };
  const S1 = { id: 5, doctor_id: 10 };
  const S1copy = { id: 6, doctor_id: 10 };   // тот же сотрудник другим источником
  const via = (list) => list.map((b) => b.via + ':' + b.source.id);
  assert.deepEqual(via(lineBeneficiaries(P, null, 12)), ['visit:900']);
  assert.deepEqual(via(lineBeneficiaries(null, S1, 12)), ['line:5']);
  assert.deepEqual(via(lineBeneficiaries(P, S1, 12)), ['visit:900', 'line:5']);
  assert.deepEqual(via(lineBeneficiaries(S1, S1, 12)), ['visit:5']);
  assert.deepEqual(via(lineBeneficiaries(S1, S1copy, 12)), ['visit:5']);
  assert.deepEqual(via(lineBeneficiaries(P, S1, 10)), ['visit:900'], 'своя строка врача — без бонуса источнику строки');
  assert.deepEqual(via(lineBeneficiaries(null, null, null)), []);
});

// REFERRAL_LINE_V1 · ревью U10 MEDIUM-4 (вариант «б»): два ВНЕШНИХ партнёра за одну строку не
// платятся — строка остаётся за партнёром визита/пациента; врач строки по-прежнему — сверху.
test('кому вознаграждение: внешний партнёр строки к внешнему партнёру визита не добавляется (вариант «б»)', () => {
  const P = { id: 900, doctor_id: null };
  const Q = { id: 901, doctor_id: null };
  const S1 = { id: 5, doctor_id: 10 };
  const via = (list) => list.map((b) => b.via + ':' + b.source.id);
  assert.equal(EXTERNAL_LINE_ADDS_TO_EXTERNAL_BASE, false, 'переключатель варианта — «б»');
  assert.deepEqual(via(lineBeneficiaries(P, Q, 12)), ['visit:900'], 'два партнёра за одну строку');
  assert.deepEqual(via(lineBeneficiaries(null, Q, 12)), ['line:901'], 'без партнёра визита — партнёр строки');
  assert.deepEqual(via(lineBeneficiaries(S1, Q, 12)), ['visit:5', 'line:901'], 'врач визита + партнёр строки — правило «обоим» не тронуто');
  assert.deepEqual(via(lineBeneficiaries(P, S1, 12)), ['visit:900', 'line:5'], 'партнёр + врач строки — оба');
});

// Ревью U10 HIGH-1 — кто рекомендовал (recommended_services.recommended_by) ставит сервер: врачу —
// он сам (что прислал браузер, не читается), остальным — никто: медсестра или стойка не выдают
// свою рекомендацию за рекомендацию врача.
test('автор рекомендации: врач (и администратор-врач) — он сам; стойка, медсестра, без сессии — никто', () => {
  const { db } = fresh();
  assert.equal(recommendationAuthorStamp(db, doctor, { recommended_by: 12 }), 10);
  assert.equal(recommendationAuthorStamp(db, doctor, {}), 10);
  assert.equal(recommendationAuthorStamp(db, adminDoctor, { recommended_by: 12 }), 1);
  assert.equal(recommendationAuthorStamp(db, registrar, { recommended_by: 12 }), null);
  assert.equal(recommendationAuthorStamp(db, nurse, { recommended_by: 12 }), null);
  assert.equal(recommendationAuthorStamp(db, null, { recommended_by: 12 }), null);
});
