// CRM_UNIFY_V1 — РАЗОВОЕ ИСПРАВЛЕНИЕ (решение владельца 5, Р19): застрявшие
// карточки, чей пациент несомненно пришёл в день записи, — в конверсию (в том
// числе из ошибочного «Не пришёл»); потерянные задачи — оператору карточки.
// Только однозначные случаи; деньги, визиты и строки не трогаются; updated_at
// карточек не двигается; один раз; упавший запуск повторяется целиком.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmUnifyRepair } from './unify-repair.js';
import { crmNoShowSweep } from './no-show.js';

const pad = (n) => String(n).padStart(2, '0');
const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Местное время дня → ISO (UTC). */
const at = (ymd, hh = 10) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, hh, 0, 0, 0).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
const Y = day(-1), Y2 = day(-2), Y5 = day(-5), T0 = day(0), T = day(1);
const OLD = at(day(-30), 9);   // карточки заведены давно — до своих дней записи

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_active, custom_role_code) VALUES (?,?,?,?,?,?,?)');
  u.run(21, 'opa', 'x', 'А', 'callcenter', 1, null);
  u.run(22, 'opb', 'x', 'Б', 'callcenter', 1, null);
  u.run(23, 'boss', 'x', 'Админ', 'admin', 1, null);
  u.run(24, 'head', 'x', 'Руководитель', 'callcenter', 1, 'head_cc');
  u.run(25, 'gone', 'x', 'Уволен', 'callcenter', 0, null);
  u.run(26, 'kassa', 'x', 'Кассир', 'cashier', 1, null);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('head_cc','Рук.','callcenter')").run();
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('head_cc', JSON.stringify({ sections: ['crm'], levels: { crm: 'editor' }, grants: { 'crm.all': 'edit' } }));
  for (let id = 1; id <= 20; id++) db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(id, 'П' + id);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO payers (id, name) VALUES (1, 'Страховая')").run();
  return db;
}
const visit = (db, p, d, { status = 'scheduled', origin = null } = {}) =>
  Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (?, ?, ?, ?)').run(p, at(d), status, origin).lastInsertRowid);
const lead = (db, p, status, d = null, { owner = 21, born = OLD } = {}) =>
  Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date, assigned_to, created_at, updated_at) VALUES ('Л','998900000000',?,?,?,?,?,?)")
    .run(status, p, d, owner, born, born).lastInsertRowid);
const line = (db, rid, vid, d, status = 'pending') =>
  Number(db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?, 40, ?, ?, ?)').run(rid, d, status, vid).lastInsertRowid);
const link = (db, vid, rid) => db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
const invoice = (db, vid, createdDay, { status = 'unpaid', payer = null } = {}) =>
  Number(db.prepare('INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status, payer_id, created_at) VALUES (?, (SELECT patient_id FROM visits WHERE id = ?), 1000, 0, ?, ?, ?)')
    .run(vid, vid, status, payer, at(createdDay, 8)).lastInsertRowid);
const pay = (db, inv, paidDay) => {
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 1000, 'cash', ?)").run(inv, at(paidDay, 11));
  db.prepare("UPDATE invoices SET paid_amount = 1000, status = 'paid' WHERE id = ?").run(inv);
};
const work = (db, vid, status = 'collected', extra = {}) =>
  Number(db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, clinic_item_id) VALUES (?, 40, 1, 1, 1, ?, ?)')
    .run(vid, status, extra.item ?? null).lastInsertRowid);
const row = (db, id) => db.prepare('SELECT status, updated_at FROM crm_requests WHERE id = ?').get(id);
const st = (db, id) => row(db, id).status;
const money = (db) => JSON.stringify(['visits', 'invoices', 'payments', 'visit_services', 'crm_request_services', 'crm_booking_links']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const log = (db, kind) => db.prepare('SELECT request_id, task_id, from_value, to_value FROM crm_unify_repair_log WHERE kind = ? ORDER BY id').all(kind);

// ─── КАРТОЧКИ: ЧТО ДВИГАЕТСЯ ───────────────────────────────────────────────

test('карточки: несомненный приход в день записи — в конверсию; updated_at и деньги не меняются', () => {
  const db = seed();
  // а) «Записан» на вчера, оплачено в тот день
  const paid = lead(db, 1, 'scheduled', Y);
  pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  // б) «Не пришёл» на вчера, а услуга в работе (проба взята)
  const missed = lead(db, 2, 'no_show', Y);
  work(db, visit(db, 2, Y));
  // в) без даты; строка держит живой визит позавчера с отметкой «Пришёл»
  const held = lead(db, 3, 'in_process');
  line(db, held, visit(db, 3, Y2, { status: 'arrived' }), Y2);
  // г) дата карточки — другая; привязка записи к визиту позавчера, долг у кассы в тот день
  const linked = lead(db, 4, 'scheduled', T);
  const v4 = visit(db, 4, Y2); link(db, v4, linked); invoice(db, v4, Y2, { status: 'debt' });
  // д) счёт по акту, выставленный в день визита
  const act = lead(db, 5, 'approved', Y);
  invoice(db, visit(db, 5, Y), Y, { payer: 1 });
  // е) пациент в тот день пришёл в соседнее здание (визит соседа, отметка «Пришёл»)
  const branch = lead(db, 6, 'recall', Y);
  visit(db, 6, Y, { status: 'arrived', origin: 'branch-2' });
  // ж) «Не пришёл» строкой заявки, оплачено ДРУГИМ визитом того же дня
  const other = lead(db, 7, 'no_show', Y);
  line(db, other, visit(db, 7, Y), Y);
  pay(db, invoice(db, visit(db, 7, Y), Y), Y);

  const before = money(db);
  const stamps = db.prepare('SELECT id, updated_at FROM crm_requests ORDER BY id').all();
  const out = crmUnifyRepair(db);
  assert.equal(out.skipped, false);
  assert.equal(out.failed, false);
  assert.deepEqual([paid, missed, held, linked, act, branch, other].map((id) => st(db, id)), Array(7).fill('came'));
  assert.deepEqual([out.cards, out.noShows], [5, 2]);
  assert.equal(money(db), before, 'исправление тронуло визиты, счета, платежи, строки визита или заявки');
  assert.deepEqual(db.prepare('SELECT id, updated_at FROM crm_requests ORDER BY id').all(), stamps,
    'updated_at сдвинут: окно повторного обращения сочтёт историю свежим контактом');
  assert.deepEqual(log(db, 'card').map((r) => [r.request_id, r.from_value, r.to_value]), [
    [paid, 'scheduled', 'came'], [missed, 'no_show', 'came'], [held, 'in_process', 'came'], [linked, 'scheduled', 'came'],
    [act, 'approved', 'came'], [branch, 'recall', 'came'], [other, 'no_show', 'came']]);
  assert.match(out.summary, /в конверсию: 5.*«Не пришёл».*: 2.*задач.*: 0/);
  const mark = db.prepare('SELECT done_at, cards, no_shows, tasks FROM crm_unify_repair WHERE id = 1').get();
  assert.ok(mark.done_at);
  assert.deepEqual([mark.cards, mark.no_shows, mark.tasks], [5, 2, 0]);
});

test('конверсия — та, что выбрана в настройках (не зашитая «Пришёл»)', () => {
  const db = seed();
  db.prepare("UPDATE crm_stages SET kind = 'open' WHERE key = 'came'").run();
  db.prepare("UPDATE crm_stages SET kind = 'won' WHERE key = 'approved'").run();
  const rid = lead(db, 1, 'scheduled', Y);
  pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  crmUnifyRepair(db);
  assert.equal(st(db, rid), 'approved');
});

// ─── КАРТОЧКИ: ЧТО НЕ ДВИГАЕТСЯ НИКОГДА ───────────────────────────────────

test('никогда: предоплата, счёт по акту или долг до дня визита, неоплаченный счёт, возврат', () => {
  const db = seed();
  const prepaid = lead(db, 1, 'scheduled', Y);
  pay(db, invoice(db, visit(db, 1, Y), Y2), Y2);                       // заплатил ДО дня
  const actEarly = lead(db, 2, 'scheduled', Y);
  invoice(db, visit(db, 2, Y), Y5, { payer: 1 });                        // акт выставлен при записи
  const debtEarly = lead(db, 3, 'no_show', Y);
  invoice(db, visit(db, 3, Y), Y5, { status: 'debt' });
  const unpaid = lead(db, 4, 'scheduled', Y);
  invoice(db, visit(db, 4, Y), Y);                                       // счёт есть, денег нет
  const refunded = lead(db, 5, 'scheduled', Y);
  const inv5 = invoice(db, visit(db, 5, Y), Y); pay(db, inv5, Y);
  db.prepare("UPDATE invoices SET paid_amount = 0, status = 'refunded' WHERE id = ?").run(inv5);
  const out = crmUnifyRepair(db);
  assert.deepEqual([prepaid, actEarly, debtEarly, unpaid, refunded].map((id) => st(db, id)),
    ['scheduled', 'scheduled', 'no_show', 'scheduled', 'scheduled']);
  assert.deepEqual([out.cards, out.noShows], [0, 0]);
});

test('никогда: товар, талон очереди, старая закрытая строка заявки, строка «в смете» — не несомненный приход', () => {
  const db = seed();
  const goods = lead(db, 1, 'scheduled', Y);
  const v1 = visit(db, 1, Y);
  work(db, v1, 'added');                                                 // услуга «в смете»
  db.prepare("INSERT INTO products (id, name) VALUES (1, 'Бинт')").run();
  work(db, v1, 'added', { item: 1 });                                    // товар в визите
  const ticket = lead(db, 2, 'scheduled', Y);
  const v2 = visit(db, 2, Y);
  db.prepare('INSERT INTO service_queue_tickets (visit_id, number) VALUES (?, 1)').run(v2);
  const doneLine = lead(db, 3, 'no_show', Y);
  line(db, doneLine, visit(db, 3, Y), Y, 'done');                       // 'done' ставила и старая запись
  const out = crmUnifyRepair(db);
  assert.deepEqual([goods, ticket, doneLine].map((id) => st(db, id)), ['scheduled', 'scheduled', 'no_show']);
  assert.equal(out.cards + out.noShows, 0);
});

test('никогда: «Отказ» и прочие проигрышные, конверсия, карточка без пациента, будущий день, отменённый визит', () => {
  const db = seed();
  const refused = lead(db, 1, 'stopped', Y); pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  const unqual = lead(db, 2, 'not_qualified', Y); visit(db, 2, Y, { status: 'arrived' });
  const won = lead(db, 3, 'came', Y); pay(db, invoice(db, visit(db, 3, Y), Y), Y);
  const noPatient = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, scheduled_date, created_at, updated_at) VALUES ('Л','909092638','scheduled',?,?,?)").run(Y, OLD, OLD).lastInsertRowid);
  const future = lead(db, 4, 'scheduled', T); pay(db, invoice(db, visit(db, 4, T), T0), T0);
  const cancelled = lead(db, 5, 'scheduled', Y); pay(db, invoice(db, visit(db, 5, Y, { status: 'cancelled' }), Y), Y);
  const markedNoShow = lead(db, 6, 'scheduled', Y); pay(db, invoice(db, visit(db, 6, Y, { status: 'no_show' }), Y), Y);
  const out = crmUnifyRepair(db);
  assert.deepEqual([refused, unqual, won, noPatient, future, cancelled, markedNoShow].map((id) => st(db, id)),
    ['stopped', 'not_qualified', 'came', 'scheduled', 'scheduled', 'scheduled', 'scheduled']);
  assert.equal(out.cards + out.noShows, 0);
  assert.equal(log(db, 'card').length, 0);
});

test('никогда: приход в ДРУГОЙ день, чем записан; день записи раньше, чем завели карточку', () => {
  const db = seed();
  const otherDay = lead(db, 1, 'scheduled', Y);
  pay(db, invoice(db, visit(db, 1, Y2), Y2), Y2);                       // пришёл позавчера, записан на вчера
  const lateCard = lead(db, 2, 'scheduled', Y2, { born: at(Y, 9) });    // карточку завели после того дня
  pay(db, invoice(db, visit(db, 2, Y2), Y2), Y2);
  const heldOther = lead(db, 3, 'in_process');
  line(db, heldOther, visit(db, 3, Y2), Y2);                            // запись позавчера — без прихода
  pay(db, invoice(db, visit(db, 3, Y), Y), Y);                          // оплата вчера — другим днём
  crmUnifyRepair(db);
  assert.deepEqual([otherDay, lateCard, heldOther].map((id) => st(db, id)), ['scheduled', 'scheduled', 'in_process']);
});

// ─── ЗАДАЧИ ───────────────────────────────────────────────────────────────

test('задачи: без исполнителя и у тех, кто карточку вести не может, — оператору карточки; ведущим — остаются', () => {
  const db = seed();
  const rid = lead(db, 8, 'in_process', null, { owner: 21 });
  const t = (assignee, done = null) => Number(db.prepare("INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at) VALUES (?, 'Т', '2026-01-01T09:00:00Z', ?, ?)").run(rid, assignee, done).lastInsertRowid);
  const nobody = t(null), otherOp = t(22), boss = t(23), head = t(24), gone = t(25), kassa = t(26), own = t(21), done = t(22, '2026-01-02T00:00:00Z');
  const won = lead(db, 9, 'came', Y, { owner: 22 });   // и у закрытой карточки задачи не теряются
  const tw = Number(db.prepare("INSERT INTO crm_tasks (request_id, text, assignee_id) VALUES (?, 'Т', 21)").run(won).lastInsertRowid);
  const out = crmUnifyRepair(db);
  const who = (id) => db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(id).assignee_id;
  assert.deepEqual([nobody, otherOp, boss, head, gone, kassa, own, done, tw].map(who), [21, 21, 23, 24, 21, 21, 21, 22, 22]);
  assert.equal(out.tasks, 5);
  assert.deepEqual(log(db, 'task'), [
    { request_id: rid, task_id: nobody, from_value: null, to_value: '21' },
    { request_id: rid, task_id: otherOp, from_value: '22', to_value: '21' },
    { request_id: rid, task_id: gone, from_value: '25', to_value: '21' },
    { request_id: rid, task_id: kassa, from_value: '26', to_value: '21' },
    { request_id: won, task_id: tw, from_value: '21', to_value: '22' }]);
});

test('задачи: карточка в стопке или у того, кто вести её не может, — задачи не двигаются', () => {
  const db = seed();
  const pile = lead(db, 8, 'in_process', null, { owner: null });
  const gone = lead(db, 9, 'in_process', null, { owner: 25 });
  const kassa = lead(db, 10, 'in_process', null, { owner: 26 });
  const ids = [pile, gone, kassa].map((rid) => Number(db.prepare("INSERT INTO crm_tasks (request_id, text, assignee_id) VALUES (?, 'Т', 22)").run(rid).lastInsertRowid));
  const free = Number(db.prepare("INSERT INTO crm_tasks (request_id, text) VALUES (?, 'Т')").run(gone).lastInsertRowid);
  const out = crmUnifyRepair(db);
  const who = (id) => db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(id).assignee_id;
  assert.deepEqual([...ids, free].map(who), [22, 22, 22, null]);
  assert.equal(out.tasks, 0);
});

// ─── ОДИН РАЗ; ПАДЕНИЕ; ПОРЯДОК ЗАПУСКА ───────────────────────────────────

test('один раз: второй запуск ничего не делает; без таблицы отметки — молча пропуск', () => {
  const db = seed();
  const rid = lead(db, 1, 'scheduled', Y); pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  assert.equal(crmUnifyRepair(db).cards, 1);
  db.prepare("UPDATE crm_requests SET status = 'scheduled' WHERE id = ?").run(rid);   // кто-то вернул руками
  const again = crmUnifyRepair(db);
  assert.equal(again.skipped, true);
  assert.equal(again.summary, null);
  assert.equal(st(db, rid), 'scheduled', 'исправление сработало второй раз');
  assert.equal(log(db, 'card').length, 1);
  // и по построению: даже без отметки повтор по уже исправленному ничего не находит
  db.prepare("UPDATE crm_requests SET status = 'came' WHERE id = ?").run(rid);
  db.prepare('UPDATE crm_unify_repair SET done_at = NULL WHERE id = 1').run();
  const third = crmUnifyRepair(db);
  assert.deepEqual([third.cards, third.noShows, third.tasks], [0, 0, 0]);
  db.exec('DROP TABLE crm_unify_repair');
  assert.equal(crmUnifyRepair(db).skipped, true);
});

test('падение посреди прохода: ни одной правки, отметки нет; следующий запуск делает всё один раз', () => {
  const db = seed();
  const rid = lead(db, 1, 'scheduled', Y); pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  const tid = Number(db.prepare("INSERT INTO crm_tasks (request_id, text) VALUES (?, 'Т')").run(rid).lastInsertRowid);
  // «Сбой» на записи журнала задачи — уже ПОСЛЕ того, как карточка сдвинута.
  db.exec("CREATE TRIGGER repair_boom BEFORE INSERT ON crm_unify_repair_log WHEN NEW.kind = 'task' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const err = console.error; console.error = () => {};
  let first;
  try { first = crmUnifyRepair(db); } finally { console.error = err; }
  assert.equal(first.failed, true);
  assert.equal(st(db, rid), 'scheduled', 'карточка сдвинута, хотя проход упал');
  assert.equal(db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(tid).assignee_id, null);
  assert.equal(db.prepare('SELECT done_at FROM crm_unify_repair WHERE id = 1').get().done_at, null, 'отметка стоит после падения');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_unify_repair_log').get().n, 0);
  db.exec('DROP TRIGGER repair_boom');
  const second = crmUnifyRepair(db);
  assert.deepEqual([second.failed, second.cards, second.tasks], [false, 1, 1]);
  assert.equal(st(db, rid), 'came');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_unify_repair_log').get().n, 2);
});

test('порядок запуска: исправление — сразу после миграций и ДО первого прохода «Не пришёл»', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js'), 'utf8');
  const mig = src.indexOf('  migrate(db);');
  const rep = src.indexOf('crmUnifyRepair(db)');
  const sweep = src.indexOf('scheduleCrmNoShow(db)');
  assert.ok(mig > 0 && rep > 0 && sweep > 0, 'нет одного из вызовов в server/index.js');
  assert.ok(mig < rep && rep < sweep, 'исправление не между migrate() и первым проходом «Не пришёл»');
});

test('порядок запуска: проход «Не пришёл» после исправления не уносит исправленную карточку', () => {
  const db = seed();
  // записан строкой на позавчера (не пришёл), а пришёл и оплатил вчера — в день карточки
  const rid = lead(db, 1, 'scheduled', Y);
  line(db, rid, visit(db, 1, Y2), Y2);
  pay(db, invoice(db, visit(db, 1, Y), Y), Y);
  crmUnifyRepair(db);
  assert.equal(st(db, rid), 'came');
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'came');
});

// ─── ОБЪЁМ ────────────────────────────────────────────────────────────────

test('объём: 20 000 карточек, 45 000 пациентов, 5 000 задач — один проход за секунды', () => {
  const db = seed();
  const N_PAT = 45000, N_CARD = 20000, N_TASK = 5000;
  const D = [Y, Y2, Y5, day(-10), day(-40)];
  db.transaction(() => {
    const p = db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)');
    for (let i = 100; i < 100 + N_PAT; i++) p.run(i, 'П' + i);
    const v = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, ?)');
    const inv = db.prepare('INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status, created_at) VALUES (?, ?, 1000, 1000, ?, ?)');
    const pm = db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 1000, 'cash', ?)");
    const c = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date, assigned_to, created_at, updated_at) VALUES ('Л','998900000000',?,?,?,?,?,?)");
    const l = db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?, 40, ?, 'pending', ?)");
    const stages = ['in_process', 'recall', 'scheduled', 'approved', 'no_show', 'came', 'stopped'];
    for (let i = 0; i < N_CARD; i++) {
      const pid = 100 + (i * 7) % N_PAT;
      const d = D[i % D.length];
      const status = stages[i % stages.length];
      const rid = Number(c.run(status, i % 9 === 0 ? null : pid, i % 3 === 0 ? null : d, [21, 22, null][i % 3], OLD, OLD).lastInsertRowid);
      if (i % 2 === 0) {
        const vid = Number(v.run(pid, at(d), i % 11 === 0 ? 'arrived' : 'scheduled').lastInsertRowid);
        if (i % 4 === 0) l.run(rid, d, vid);
        if (i % 5 === 0) { const iid = Number(inv.run(vid, pid, 'paid', at(d, 8)).lastInsertRowid); pm.run(iid, at(i % 10 === 0 ? d : day(-60), 11)); }
      }
    }
    const t = db.prepare("INSERT INTO crm_tasks (request_id, text, assignee_id) VALUES (?, 'Т', ?)");
    for (let i = 0; i < N_TASK; i++) t.run(1 + (i * 3) % N_CARD, [null, 21, 22, 23, 25][i % 5]);
  })();
  const before = money(db);
  const t0 = Date.now();
  const out = crmUnifyRepair(db);
  const ms = Date.now() - t0;
  console.log(`[unify-repair perf] ${N_CARD} карточек / ${N_PAT} пациентов / ${N_TASK} задач: ${ms} мс — ${out.summary}`);
  assert.equal(out.failed, false);
  assert.ok(out.cards + out.noShows > 0 && out.tasks > 0, 'на объёме ничего не исправлено — проверка пустая');
  assert.ok(ms < 20000, `слишком долго: ${ms} мс`);
  assert.equal(money(db), before);
});
