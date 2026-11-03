// DUP_STOP_V1 (2026-11-02) — дверь /api/db: та же услуга второй раз в том же визите —
// 409 duplicate_order (вставка, пачка, upsert). Решение владельца (3.21.0, п. 3): запрет —
// в пределах одного визита. Случай с dev: визит 411, врач направил на две услуги дважды с
// разницей в минуту — все четыре строки ушли в счёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
function localDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
const D = localDay(3);

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0);
  user.run(3, 'cc', hashPassword('password1'), 'Оператор', 'callcenter', 0);
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1);
  user.run(11, 'doc2', hashPassword('password1'), 'Петров', 'doctor', 1);
  user.run(12, 'head', hashPassword('password1'), 'Главврач', 'doctor', 1);   // DUP_STOP_V1 (ревью, проба D) — главный врач — дополнительной ролью
  db.prepare('UPDATE users SET extra_roles = ? WHERE id = 12').run(JSON.stringify(['head_doctor']));
  user.run(13, 'nurse', hashPassword('password1'), 'Медсестра', 'nurse', 0);   // DUP_STOP_V1 (ревью, остаток 2) — правит строки, не читая их
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('nurse', JSON.stringify({ sections: ['inventory'], levels: {}, grants: {} }));
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ брюшной полости',80000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'Капельница',30000,'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (70,'Без типа (по умолчанию)',50000)").run();   // DUP_STOP_V1 (ревью m4) — type по умолчанию 'consultation', врач не нужен
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor) VALUES (80,'Приём терапевта',100000,'consultation',1)").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (6, 'Повторный', 'Повторный приём', 60000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент Тест','+998900000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cc', 'doc', 'head', 'nurse']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const rpc = (name, who, args) => call('/api/rpc/' + name, who, args);
  const dbq = (who, desc) => call('/api/db', who, desc);
  return { db, server, rpc, dbq, close: () => { server.close(); db.close(); } };
}

function arrivedVisit(t, day = localDay(0)) {
  return Number(t.db.prepare("INSERT INTO visits (patient_id, visit_date, status, doctor_id) VALUES (77, ?, 'arrived', 10)").run(at(day, 9)).lastInsertRowid);
}
const ins = (t, who, values, extra = {}) => t.dbq(who, { table: 'visit_services', op: 'insert', values, ...extra });
const row = (vid, svc, more = {}) => ({ visit_id: vid, service_id: svc, quantity: 1, unit_price: 40000, total: 40000, status: 'added', ...more });
const live = (t, vid, svc) => t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND service_id IS ? AND status <> 'cancelled'").all(vid, svc).length;

test('DUP_STOP_V1: врач направил на ту же услугу второй раз в том же визите — 409 duplicate_order, строка одна', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const first = await ins(t, 'doc', row(v, 40));
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await ins(t, 'doc', row(v, 40));
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.equal(again.json.error.code, 'duplicate_order');
    assert.match(again.json.error.message, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, .+, счёта ещё нет\.$/);
    assert.ok(again.json.error.template && again.json.error.params, 'шаблон и значения — экран переведёт фразу');
    assert.equal(live(t, v, 40), 1);
  } finally { t.close(); }
});

test('DUP_STOP_V1: та же услуга в ДРУГОМ визите — можно; отменённая строка не мешает; процедура повторяется', async () => {
  const t = await start();
  try {
    const v1 = arrivedVisit(t);
    const v2 = arrivedVisit(t, localDay(-1));
    assert.equal((await ins(t, 'reg', row(v1, 40))).status, 200);
    assert.equal((await ins(t, 'reg', row(v2, 40))).status, 200, 'другой визит');
    const id = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 40').get(v1).id;
    const cancel = await t.dbq('reg', { table: 'visit_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: id }] });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
    assert.equal((await ins(t, 'reg', row(v1, 40))).status, 200, 'после отмены');
    assert.equal((await ins(t, 'reg', row(v1, 60))).status, 200);
    assert.equal((await ins(t, 'reg', row(v1, 60))).status, 200, 'процедура второй раз');
  } finally { t.close(); }
});

test('DUP_STOP_V1: консультация — у того же врача второй раз нельзя, у другого врача можно', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const ct = (doctor) => row(v, null, { service_id: null, consultation_type_id: 5, doctor_id: doctor });
    assert.equal((await ins(t, 'reg', ct(10))).status, 200);
    const same = await ins(t, 'reg', ct(10));
    assert.equal(same.status, 409, JSON.stringify(same.json));
    assert.equal(same.json.error.code, 'duplicate_order');
    assert.equal((await ins(t, 'reg', ct(11))).status, 200, 'другой врач');
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью m4): услуга без типа и без «нужен врач» — второй раз нельзя ни без врача, ни у другого врача; консультация с врачом — по врачу', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 70))).status, 200);
    for (const doctor of [10, 11, null]) {
      const again = await ins(t, 'reg', row(v, 70, doctor ? { doctor_id: doctor } : {}));
      assert.equal(again.status, 409, 'врач ' + doctor + ': ' + JSON.stringify(again.json));
      assert.equal(again.json.error.code, 'duplicate_order');
    }
    assert.equal(live(t, v, 70), 1);
    assert.equal((await ins(t, 'reg', row(v, 80, { doctor_id: 10 }))).status, 200);
    assert.equal((await ins(t, 'reg', row(v, 80, { doctor_id: 10 }))).status, 409, 'консультация у того же врача');
    assert.equal((await ins(t, 'reg', row(v, 80, { doctor_id: 11 }))).status, 200, 'консультация у другого врача');
  } finally { t.close(); }
});

test('DUP_STOP_V1: пачка (массив) с одной услугой дважды и upsert повтора — 409, ничего не записано', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const pack = await ins(t, 'reg', [row(v, 50), row(v, 50)]);
    assert.equal(pack.status, 409, JSON.stringify(pack.json));
    assert.equal(pack.json.error.code, 'duplicate_order');
    assert.match(pack.json.error.message, /«УЗИ брюшной полости» выбрана дважды/);
    assert.equal(live(t, v, 50), 0, 'половина пачки легла');
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const up = await t.dbq('reg', { table: 'visit_services', op: 'upsert', onConflict: 'id', values: row(v, 40) });
    assert.equal(up.status, 409, JSON.stringify(up.json));
    assert.equal(up.json.error.code, 'duplicate_order');
    assert.equal(live(t, v, 40), 1);
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью m1): upsert с id уже лежащей строки — id не пишется, вставилась бы вторая строка — 409', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const firstId = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ?').get(v).id;
    const up = await t.dbq('reg', { table: 'visit_services', op: 'upsert', onConflict: 'id', values: { ...row(v, 40), id: firstId } });
    assert.equal(up.status, 409, JSON.stringify(up.json));
    assert.equal(up.json.error.code, 'duplicate_order');
    assert.equal(live(t, v, 40), 1, 'вторая живая строка той же услуги');
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью m2): правка /api/db — вернуть отменённую строку, когда та же услуга уже назначена заново, — 409; без новой — можно', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const upd = (who, values, id) => t.dbq(who, { table: 'visit_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const a = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 40').get(v).id;
    assert.equal((await upd('reg', { status: 'cancelled' }, a)).status, 200);
    assert.equal((await upd('reg', { status: 'added' }, a)).status, 200, 'вернуть единственную строку — можно');
    assert.equal((await upd('reg', { status: 'cancelled' }, a)).status, 200);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200, 'новая строка после отмены');
    const back = await upd('reg', { status: 'added' }, a);
    assert.equal(back.status, 409, JSON.stringify(back.json));
    assert.equal(back.json.error.code, 'duplicate_order');
    assert.equal(live(t, v, 40), 1, 'отменённая строка вернулась второй живой');
    // администратор с причиной — можно, обход в журнале
    const boss = await upd('boss', { status: 'added', __repeat_reason: 'повторный забор' }, a);
    assert.equal(boss.status, 200, JSON.stringify(boss.json));
    assert.equal(live(t, v, 40), 2);
    const log = t.db.prepare("SELECT reason, visit_id FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
    assert.deepEqual(log, [{ reason: 'повторный забор', visit_id: v }]);
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью, остаток 2): правка /api/db ролью, которой строки визита не читаются (медсестра со складом), — повтор всё равно 409', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const upd = (who, values, id) => t.dbq(who, { table: 'visit_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    const peek = await t.dbq('nurse', { table: 'visit_services', op: 'select', columns: 'id', filters: [{ col: 'visit_id', op: 'eq', val: v }] });
    assert.equal(peek.status, 403, 'стенд: медсестре этого стенда строки визита не отдаются');
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const a = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 40').get(v).id;
    assert.equal((await upd('reg', { status: 'cancelled' }, a)).status, 200);
    assert.equal((await upd('nurse', { status: 'added' }, a)).status, 200, 'вернуть единственную строку — можно и ей');
    assert.equal((await upd('reg', { status: 'cancelled' }, a)).status, 200);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200, 'новая строка после отмены');
    const back = await upd('nurse', { status: 'added' }, a);
    assert.equal(back.status, 409, JSON.stringify(back.json));
    assert.equal(back.json.error.code, 'duplicate_order');
    assert.equal(live(t, v, 40), 1, 'отменённая строка не вернулась второй живой');
    assert.equal(back.json.error.message, 'Эта услуга уже назначена в этом визите: «Анализ крови».', 'кем и когда назначена — данные, которых ей не читают');
    // регистратуре — с подробностями, как прежде
    const reg = await upd('reg', { status: 'added' }, a);
    assert.equal(reg.status, 409);
    assert.match(reg.json.error.message, /«Анализ крови» — Регистратура/);
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью m2): правка /api/db — смена вида приёма на вид, который у этого врача уже назначен, — 409; у другого врача — можно; две отменённые строки разом — 409', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const ct = (type, doc) => row(v, null, { service_id: null, consultation_type_id: type, doctor_id: doc });
    assert.equal((await ins(t, 'reg', ct(5, 10))).status, 200);
    assert.equal((await ins(t, 'reg', ct(6, 10))).status, 200);
    assert.equal((await ins(t, 'reg', ct(6, 11))).status, 200);
    const idOf = (type, doc) => t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND consultation_type_id = ? AND doctor_id = ?').get(v, type, doc).id;
    const upd = (values, filters) => t.dbq('reg', { table: 'visit_services', op: 'update', values, filters });
    const sw = await upd({ consultation_type_id: 5 }, [{ col: 'id', op: 'eq', val: idOf(6, 10) }]);
    assert.equal(sw.status, 409, JSON.stringify(sw.json));
    assert.equal(sw.json.error.code, 'duplicate_order');
    const n5 = () => t.db.prepare("SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND consultation_type_id = 5 AND status <> 'cancelled'").get(v).n;
    assert.equal(n5(), 1);
    assert.equal((await upd({ consultation_type_id: 5 }, [{ col: 'id', op: 'eq', val: idOf(6, 11) }])).status, 200, 'у другого врача этого вида нет');
    assert.equal(n5(), 2);
    // две отменённые строки одной услуги возвращают одной правкой — второй раз та же услуга
    assert.equal((await ins(t, 'reg', row(v, 50))).status, 200);
    const u1 = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 50').get(v).id;
    assert.equal((await upd({ status: 'cancelled' }, [{ col: 'id', op: 'eq', val: u1 }])).status, 200);
    assert.equal((await ins(t, 'reg', row(v, 50))).status, 200);
    const u2 = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 50 AND status <> 'cancelled'").get(v).id;
    assert.equal((await upd({ status: 'cancelled' }, [{ col: 'id', op: 'eq', val: u2 }])).status, 200);
    const both = await upd({ status: 'added' }, [{ col: 'id', op: 'in', val: [u1, u2] }]);
    assert.equal(both.status, 409, JSON.stringify(both.json));
    assert.match(both.json.error.message, /«УЗИ брюшной полости» выбрана дважды/);
    assert.equal(live(t, v, 50), 0);
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью, проба D): главный врач (врач с дополнительной ролью) назначает повтор с причиной; visit_dup_check даёт ему обход', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    assert.equal((await ins(t, 'head', row(v, 40))).status, 409, 'без причины');
    const h = await ins(t, 'head', row(v, 40, { __repeat_reason: 'контроль после лечения' }));
    assert.equal(h.status, 200, JSON.stringify(h.json));
    assert.equal(live(t, v, 40), 2);
    const chk = await t.rpc('visit_dup_check', 'head', { visit_id: v, lines: [{ service_id: 40 }] });
    assert.equal(chk.status, 200, JSON.stringify(chk.json));
    assert.equal(chk.json.data.can_override, true);
    const doc = await t.rpc('visit_dup_check', 'doc', { visit_id: v, lines: [] });
    assert.equal(doc.json.data.can_override, false, 'обычный врач');
  } finally { t.close(); }
});

test('DUP_STOP_V1 (ревью, проба E): причина — строка не короче 3 знаков без пробелов по краям; число и пробелы — отказ; в строку причина не пишется, в журнал — обрезанной', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    assert.equal((await ins(t, 'boss', row(v, 40, { __repeat_reason: '   a   ' }))).status, 409, 'пробелы вокруг одной буквы');
    assert.equal((await ins(t, 'boss', row(v, 40, { __repeat_reason: 12345 }))).status, 409, 'не строка');
    const ok = await ins(t, 'boss', row(v, 40, { __repeat_reason: '  повтор по назначению  ' }), { returning: true, single: 'single' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(!('__repeat_reason' in ok.json.data), 'причина вернулась колонкой строки');
    const log = t.db.prepare("SELECT reason, visit_id FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
    assert.deepEqual(log, [{ reason: 'повтор по назначению', visit_id: v }]);
  } finally { t.close(); }
});

test('DUP_STOP_V1: строка записи колл-центра той же услуги не мешает — строка регистратуры занимает её место (R7b)', async () => {
  const t = await start();
  try {
    const ev = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10) });
    assert.equal(ev.status, 200, JSON.stringify(ev.json));
    const v = ev.json.data.visit.id;
    const bl = await t.rpc('booking_lines_add', 'cc', { visit_id: v, lines: [{ service_id: 40 }] });
    assert.equal(bl.status, 200, JSON.stringify(bl.json));
    const x = bl.json.data.added[0].id;
    const y = await ins(t, 'reg', row(v, 40), { returning: true, single: 'single' });
    assert.equal(y.status, 200, JSON.stringify(y.json));
    assert.equal(live(t, v, 40), 1, 'вторая копия записанной услуги');
    assert.equal(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(x), undefined, 'строка записи ушла под строкой регистратуры');
  } finally { t.close(); }
});

test('DUP_STOP_V1: обход — администратор с причиной (__repeat_reason) назначает повтор, журнал счёта помнит; регистратор с причиной — 409', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const reg = await ins(t, 'reg', row(v, 40, { __repeat_reason: 'контрольный анализ' }));
    assert.equal(reg.status, 409, JSON.stringify(reg.json));
    const short = await ins(t, 'boss', row(v, 40, { __repeat_reason: 'ок' }));
    assert.equal(short.status, 409, 'причина короче трёх знаков');
    const boss = await ins(t, 'boss', row(v, 40, { __repeat_reason: 'контрольный анализ' }));
    assert.equal(boss.status, 200, JSON.stringify(boss.json));
    assert.equal(live(t, v, 40), 2);
    const log = t.db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
    assert.equal(log.length, 1);
    assert.equal(log[0].reason, 'контрольный анализ');
    assert.equal(log[0].visit_id, v);
    assert.equal(log[0].actor_user_id, 1);
  } finally { t.close(); }
});
