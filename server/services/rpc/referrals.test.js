// REFERRALS_CRM_V1 — RPC экрана «Реферирование».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { today } from '../domain/day.js';
import {
  referralsRepresentatives, referralsAssignRepresentative, referralsInternal, referralsActivity,
  referralsSourceDetail, referralsDoctorDetail, RpcError,
} from './referrals.js';
import { getRpc } from './index.js';

const ymd = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
// Визит в полдень местного дня: date(..,'localtime') даёт тот же день.
const atNoon = (daysAgo) => new Date(ymd(daysAgo) + 'T12:00:00').toISOString();

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, specialty, custom_role_code) VALUES (?,?,?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Администратор', '', null);
  ins.run(2, 'reg', 'x', 'registrar', 'Регистратор', '', null);
  ins.run(3, 'doc', 'x', 'doctor', 'Врач Внутренний', 'Невролог', null);
  ins.run(4, 'rep', 'x', 'callcenter', 'Представитель Один', '', 'medrep');
  ins.run(5, 'rep2', 'x', 'callcenter', 'Представитель Уволенный', '', 'medrep');
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 5').run();
  // Своя роль без ключа «Реферирование» и своя роль с ним — проверка ворот (REFERRALS_NAV_V1).
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('nocrm', 'Без ключа', 'nurse')").run();
  db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('nocrm', ?)").run(JSON.stringify({ sections: ['patients'], levels: {}, patient_tabs: {} }));
  ins.run(6, 'nocrm', 'x', 'nurse', 'Без Ключа', '', 'nocrm');
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('refs', 'Реферирование', 'callcenter')").run();
  db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('refs', ?)").run(JSON.stringify({ sections: ['referrals'], levels: { referrals: 'viewer' }, patient_tabs: {} }));
  ins.run(7, 'refs', 'x', 'callcenter', 'С Ключом', '', 'refs');

  const src = db.prepare('INSERT INTO referral_sources (name, first_name, phone, workplace, specialty, representative_id) VALUES (?,?,?,?,?,?)');
  src.run('Абдурахманова Дилара', 'Дилара', '+998912098887', 'Джизак', 'Терапевт', 4);
  src.run('Набиев Ойбек', 'Ойбек', '+998903106570', 'Джизак', 'ЛОР', null);
  const ids = db.prepare("SELECT id, name FROM referral_sources WHERE doctor_id IS NULL ORDER BY id").all();
  const A = ids[0].id, B = ids[1].id;
  const internal = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 3').get().id;

  const pat = db.prepare('INSERT INTO patients (id, full_name, phone, referral_source_id) VALUES (?,?,?,?)');
  pat.run(10, 'Пациент Первый', '+998900000001', A);
  pat.run(11, 'Пациент Второй', '+998900000002', null);
  pat.run(12, 'Пациент Третий', '+998900000003', null);
  const vis = db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, referral_source_id) VALUES (?,?,?,?,?)');
  vis.run(10, 3, atNoon(1), 'arrived', null);        // источник из карточки пациента → A
  vis.run(10, 3, atNoon(2), 'arrived', A);
  vis.run(11, 3, atNoon(3), 'scheduled', A);
  vis.run(11, 3, atNoon(4), 'cancelled', A);         // не направление
  vis.run(12, 3, atNoon(50), 'arrived', B);          // затихает: 31–90 дней
  vis.run(12, 3, atNoon(1), 'no_show', B);           // не направление
  const rec = db.prepare('INSERT INTO recommended_services (patient_id, service_name, recommended_by, status, created_at) VALUES (?,?,?,?,?)');
  rec.run(10, 'УЗИ', 3, 'done', atNoon(1));
  rec.run(11, 'МРТ', 3, 'pending', atNoon(2));
  rec.run(11, 'Анализ', 3, 'cancelled', atNoon(3));
  rec.run(12, 'Старое', 3, 'done', atNoon(400));     // вне периода
  return { db, A, B, internal };
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };   // CRM у регистратора есть, ключа «Реферирование» — нет
const noCrm = { id: 6, role: 'nurse', custom_role_code: 'nocrm' };
const withKey = { id: 7, role: 'callcenter', custom_role_code: 'refs' };
const period = { from: ymd(30), to: ymd(0) };

test('ворота: ключ «Реферирование» или администратор; CRM сам по себе не открывает; все RPC зарегистрированы', () => {
  const { db } = fresh();
  for (const fn of [referralsRepresentatives, referralsInternal, referralsActivity]) {
    fn(db, period, admin);
    fn(db, period, withKey);
    assert.throws(() => fn(db, period, registrar), (e) => e instanceof RpcError && e.status === 403, 'регистратор с CRM, но без ключа');
    assert.throws(() => fn(db, period, noCrm), (e) => e instanceof RpcError && e.status === 403);
  }
  for (const name of ['referrals_representatives', 'referrals_assign_representative', 'referrals_internal',
    'referrals_activity', 'referrals_source_detail', 'referrals_doctor_detail']) {
    assert.equal(typeof getRpc(name), 'function', name + ' не зарегистрирован в rpc/index.js');
  }
});

test('представители: только действующие medrep; агрегаты визитов за период; деньги — администратору, не регистратору', () => {
  const { db, A, B } = fresh();
  const out = referralsRepresentatives(db, period, admin);
  assert.deepEqual(out.representatives.map((r) => r.full_name), ['Представитель Один'], 'уволенный представитель не в списке');
  assert.equal(out.money, true);
  const a = out.sources.find((s) => s.id === A), b = out.sources.find((s) => s.id === B);
  assert.equal(a.visits, 3, 'A: два визита по источнику визита + один по карточке; отменённый не считается');
  assert.equal(a.patients, 2);
  assert.equal(a.representative_id, 4);
  assert.equal(b.visits, 0, 'B: визит 50 дней назад вне периода, «не пришёл» не считается');
  assert.equal(typeof a.received, 'number');
  assert.deepEqual(out.totals, { representatives: 1, assigned: 1, unassigned: 1, patients: 2, received: 0 });

  const reg = referralsRepresentatives(db, period, withKey);
  assert.equal(reg.money, false);
  assert.ok(!('received' in reg.sources[0]) && !('received' in reg.totals), 'роль с ключом, но без reports.referrals денег не получает');
});

test('закрепление: только право «Список источников: Изменение»; только действующий medrep; внутреннего врача не закрепить', () => {
  const { db, B, internal } = fresh();
  assert.throws(() => referralsAssignRepresentative(db, { source_id: B, user_id: 4 }, registrar), (e) => e.status === 403);
  assert.deepEqual(referralsAssignRepresentative(db, { source_id: B, user_id: 4 }, admin), { source_id: B, representative_id: 4 });
  assert.equal(db.prepare('SELECT representative_id FROM referral_sources WHERE id = ?').get(B).representative_id, 4);
  assert.throws(() => referralsAssignRepresentative(db, { source_id: B, user_id: 5 }, admin), (e) => e.status === 400, 'уволенный');
  assert.throws(() => referralsAssignRepresentative(db, { source_id: B, user_id: 2 }, admin), (e) => e.status === 400, 'не medrep');
  assert.throws(() => referralsAssignRepresentative(db, { source_id: internal, user_id: 4 }, admin), (e) => e.status === 400, 'внутренний врач');
  assert.throws(() => referralsAssignRepresentative(db, { source_id: 99999, user_id: 4 }, admin), (e) => e.status === 404);
  assert.deepEqual(referralsAssignRepresentative(db, { source_id: B, user_id: null }, admin), { source_id: B, representative_id: null });
});

test('внутренние врачи: счётчики recommended_services за период, все действующие врачи в списке', () => {
  const { db } = fresh();
  const out = referralsInternal(db, period, admin);
  assert.equal(out.doctors.length, 1);
  const d = out.doctors[0];
  assert.equal(d.full_name, 'Врач Внутренний');
  assert.equal(d.specialty, 'Невролог');
  assert.deepEqual([d.referrals, d.done, d.waiting, d.cancelled, d.patients], [3, 1, 1, 1, 2], 'старое направление вне периода');
  assert.equal(typeof d.amount, 'number');
  assert.deepEqual(out.totals, { doctors_referring: 1, referrals: 3, done: 1, waiting: 1, cancelled: 1, amount: 0, reward: 0 });
  const reg = referralsInternal(db, period, withKey);
  assert.ok(!('amount' in reg.doctors[0]));
});

test('активность: статусы по окнам 30 / 90, окно N меняет только две колонки, фильтр по представителю', () => {
  const { db, A, B } = fresh();
  const out = referralsActivity(db, { days: 7 }, admin);
  assert.equal(out.days, 7);
  assert.equal(out.today, today(db));
  const a = out.sources.find((s) => s.id === A), b = out.sources.find((s) => s.id === B);
  assert.equal(a.status, 'active');
  assert.equal(a.total, 3);
  assert.equal(a.current, 3, 'за 7 дней: 1, 2, 3 дня назад');
  assert.equal(a.previous, 0);
  assert.equal(a.last_visit, ymd(1));
  assert.equal(b.status, 'fading', 'единственный визит 50 дней назад');
  assert.equal(b.last_visit, ymd(50));
  assert.equal(b.telegram, false, 'таблицы бота ещё нет — никто не подключён');
  assert.deepEqual(out.totals, { active: 1, fading: 1, passive: 0, never: 0 });

  assert.equal(referralsActivity(db, { days: 14 }, admin).days, 30, 'незнакомое окно — 30');
  assert.deepEqual(referralsActivity(db, { representative_id: 4 }, admin).sources.map((s) => s.id), [A]);
  assert.deepEqual(referralsActivity(db, { representative_id: 'none' }, admin).sources.map((s) => s.id), [B]);

  // FIX_318_V1 (M2) — «Telegram» у врача — только подтверждённое подключение.
  const l = Number(db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '800', '998912098887')").run(A).lastInsertRowid);
  assert.equal(referralsActivity(db, {}, admin).sources.find((s) => s.id === A).telegram, false, 'ждёт подтверждения — ещё не подключён');
  db.prepare("UPDATE doctor_bot_links SET status = 'confirmed' WHERE id = ?").run(l);
  assert.equal(referralsActivity(db, {}, admin).sources.find((s) => s.id === A).telegram, true);
});

test('подробнее: визиты источника за период с услугами и пациентом; направления врача', () => {
  const { db, A } = fresh();
  const d = referralsSourceDetail(db, { source_id: A, ...period }, admin);
  assert.equal(d.source.name, 'Абдурахманова Дилара');
  assert.equal(d.visits.length, 3);
  assert.equal(d.visits[0].patient, 'Пациент Первый');
  assert.equal(d.patients, 2);
  assert.equal(typeof d.received, 'number');
  assert.throws(() => referralsSourceDetail(db, { source_id: 99999, ...period }, admin), (e) => e.status === 404);

  const doc = referralsDoctorDetail(db, { doctor_id: 3, ...period }, admin);
  assert.equal(doc.doctor.full_name, 'Врач Внутренний');
  assert.deepEqual(doc.referrals.map((r) => [r.service, r.status]), [['УЗИ', 'done'], ['МРТ', 'pending'], ['Анализ', 'cancelled']]);
  assert.ok(Array.isArray(doc.lines));
  const reg = referralsDoctorDetail(db, { doctor_id: 3, ...period }, withKey);
  assert.ok(!('lines' in reg) && !('reward' in reg));
});

// ---------------------------------------------------------------------------
// FIX_318_V1 — ревью 3.18.0 («Реферирование»)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { referralReportLines } from './reports.js';
import { buildingContext } from '../domain/buildings.js';

test('M3 (повтор R4): «Внутренние врачи» — по is_doctor: администратор-врач (ADMIN_DOCTOR_V1) в списке и в итогах', () => {
  const { db } = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (8, 'admdoc', 'x', 'admin', 'Админ Врач', 1)").run();
  db.prepare("INSERT INTO recommended_services (patient_id, service_name, recommended_by, status, created_at) VALUES (11, 'КТ', 8, 'pending', ?)").run(atNoon(1));
  const out = referralsInternal(db, period, admin);
  const ad = out.doctors.find((d) => d.id === 8);
  assert.ok(ad, 'администратор-врач в списке');
  assert.deepEqual([ad.referrals, ad.waiting], [1, 1]);
  assert.equal(out.totals.referrals, 4, 'его направление в итогах (3 у врача + 1)');
  assert.ok(!out.doctors.some((d) => d.id === 1), 'администратор без is_doctor — не врач');
});

function moneyWorld() {
  const { db } = fresh();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (?,?,?,?,?,?,?)');
  u.run(8, 'admdoc', 'x', 'admin', 'Админ Врач', 1, 1);       // ADMIN_DOCTOR_V1
  u.run(9, 'gone', 'x', 'doctor', 'Уволенный Врач', 1, 0);     // уволен, но деньги за период есть
  const cat = db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  db.prepare('UPDATE referral_source_categories SET standard_percent = 5 WHERE id = ?').run(cat);
  const own = (doctorId, name) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId)?.id
    ?? Number(db.prepare('INSERT INTO referral_sources (name, first_name, doctor_id, category_id) VALUES (?,?,?,?)').run(name, name, doctorId, cat).lastInsertRowid);
  const src8 = own(8, 'Админ Врач');
  const src9 = own(9, 'Уволенный Врач');
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (701, 'УЗИ почек', 200000, 'imaging')").run();
  const v = db.prepare('INSERT INTO visits (id, patient_id, visit_date, status, referral_source_id) VALUES (?,?,?,?,?)');
  const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                          VALUES (?,?,?,?,?,0,?,?,'paid',?)`);
  const item = db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,701,'УЗИ почек',1,?,?)");
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?,701,3,1,?,?,'completed',?)");
  [[901, 10, src8, 200000], [902, 12, src9, 100000]].forEach(([id, pid, src, sum], i) => {
    v.run(id, pid, atNoon(1), 'arrived', src);
    inv.run(id, 'INV-' + id, id, pid, sum, sum, sum, atNoon(1));
    item.run(id, id, sum, sum);
    vs.run(id, sum, sum, id);
    void i;
  });
  return db;
}

test('M3: итоги «Внутренних врачей» сходятся с отчётом «Рефералы» (внутренние): деньги администратора-врача и уволенного врача не теряются', () => {
  const db = moneyWorld();
  const out = referralsInternal(db, period, admin);
  const lines = referralReportLines(db, { ...period, referrer: 'internal' }, buildingContext(db));
  const num = (x) => Number(x) || 0;
  const reward = Math.round(lines.reduce((a, r) => a + num(r.reward), 0) * 100) / 100;
  const received = Math.round(lines.reduce((a, r) => a + (r.paid ? num(r.after_discount) * num(r.pay_factor) : 0), 0) * 100) / 100;
  assert.ok(reward > 0, 'в отчёте есть вознаграждение: ' + reward);
  assert.equal(out.totals.reward, reward, 'вознаграждение — как в «Рефералах»');
  assert.equal(out.totals.amount, received, 'получено — как в «Рефералах»');
  const ids = out.doctors.map((d) => d.id);
  assert.ok(ids.includes(8), 'администратор-врач');
  assert.ok(ids.includes(9), 'уволенный врач с деньгами за период — в списке, иначе итог не сходится');
  assert.equal(out.doctors.find((d) => d.id === 9).reward, 5000, '5 % от 100 000');
});

test('L5: строки отчёта «Рефералы» получают контекст зданий отчёта, а не пользователя', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./referrals.js', import.meta.url)), 'utf8');
  const calls = [...src.matchAll(/referralReportLines\(([^;]*?)\)\s*(?:\.|\)|;|\n)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'вызовы найдены: ' + calls.length);
  for (const c of calls) assert.ok(!/,\s*user\s*$/.test(c.trim()), 'третьим аргументом — user: ' + c);
});

test('L4: сотрудник своей роли клиники «Медпредставитель» (другой код) — представитель на экране и его можно закрепить', () => {
  const { db, B } = fresh();
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('med_rep', 'Медпредставитель', 'callcenter')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, custom_role_code) VALUES (12, 'rep3', 'x', 'callcenter', 'Представитель Клиники', 'med_rep')").run();
  const out = referralsRepresentatives(db, period, admin);
  assert.deepEqual(out.representatives.map((r) => r.full_name).sort(), ['Представитель Клиники', 'Представитель Один']);
  assert.deepEqual(referralsAssignRepresentative(db, { source_id: B, user_id: 12 }, admin), { source_id: B, representative_id: 12 });
  assert.throws(() => referralsAssignRepresentative(db, { source_id: B, user_id: 2 }, admin), (e) => e.status === 400, 'регистратор — не представитель');
});
