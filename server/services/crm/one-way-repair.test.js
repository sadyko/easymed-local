// CRM_ONE_WAY_V1 (O8) — разовое исправление строк карточек при установке (crm/one-way-repair.js).
// Решение контролёра по ревью r4 (п. 1, 5, 6) — ИСПРАВЛЕНИЕ НИЧЕГО НЕ УДАЛЯЕТ: строки, указывающие на строку
// визита, остаются строками записи и отмечаются по происхождению (копия — только по правилу 0–2 с на записи
// регистратуры: legacy_copy, позже отмена её снимает); строки отменённых записей — отпущенные желания (копии —
// сняты); датированное желание без ссылки, чья карточка отменила запись того дня, — отпущенное желание.
// Каждая строка, о которой принято решение, — в журнале; строки визитов и счета не меняются; второй раз — ничего.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmOneWayRepair } from './one-way-repair.js';
import { releaseCancelled } from './one-way.js';

const T0 = '2026-10-01T09:00:00Z';
const plus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function base() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2, 'reg', 'x', 'Регистратор', 'registrar', 0), (7, 'doc', 'x', 'Врач', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (30, 'Консультация', 100000, 'consultation'), (40, 'Анализ', 40000, 'lab')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77, 'Пациент', '+998900000077')").run();
  const newCard = () => Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Пациент', '+998900000077', 'scheduled', 77)").run().lastInsertRowid);
  const rid = newCard();
  const visit = (day, status = 'scheduled') => Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, created_at) VALUES (77, 7, ?, ?, 2, ?)')
    .run(`${day}T10:00:00Z`, status, T0).lastInsertRowid);
  const vline = (vid, svc, at = T0) => Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, ?, 7, 1, 100, 100, 'added', 2, ?)")
    .run(vid, svc, at).lastInsertRowid);
  const cline = (o) => Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto, created_at)
                                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(o.rid ?? rid, o.svc ?? 30, o.day ?? null, o.status ?? 'pending', o.visit ?? null, o.vs ?? null, o.auto ?? 0, o.at ?? T0).lastInsertRowid);
  const linkTo = (vid, r, source) => db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, ?)').run(vid, r, source);
  return { db, rid, newCard, visit, vline, cline, linkTo };
}
const row = (db, id) => { const r = db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id); return r ? { ...r } : null; };
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM crm_request_services').get().n;
const money = (db) => ({
  vs: db.prepare('SELECT * FROM visit_services ORDER BY id').all().map((x) => ({ ...x })),
  inv: db.prepare('SELECT * FROM invoices ORDER BY id').all().map((x) => ({ ...x })),
});
const logOf = (db) => db.prepare('SELECT line_id, action FROM crm_one_way_repair_log ORDER BY id').all().map((r) => [r.line_id, r.action]);

test('CRM_ONE_WAY_V1 O8 (ревью r4): ничего не удаляется — копия на записи регистратуры отмечена, строка записи колл-центра, желания оператора и строка CRM остаются строками записи; позже отмена снимает только копию', () => {
  const { db, rid, newCard, visit, vline, cline, linkTo } = base();
  const v = visit('2026-10-20');
  linkTo(v, rid, 'match');
  const x = vline(v, 30);
  const copy = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const doneCopy = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(0), status: 'done' });
  const operator = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(600) });
  const earlier = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(-3600) });
  const y = vline(v, 40);
  const crmLine = cline({ svc: 40, day: '2026-10-20', visit: v, vs: y, auto: 1, at: plus(-60) });
  // запись колл-центра другой карточки: строка в ту же секунду — строка записи (R2), не копия
  const cc = newCard();
  const vc = visit('2026-10-22');
  linkTo(vc, cc, 'callcenter');
  const xc = vline(vc, 30);
  const ccLine = cline({ rid: cc, day: '2026-10-22', visit: vc, vs: xc, at: plus(0) });
  const before = money(db);
  const rows = count(db);
  const out = crmOneWayRepair(db);
  assert.equal(out.skipped, false);
  assert.equal(out.failed, false);
  assert.equal(count(db), rows, 'исправление удалило строки карточек');
  assert.equal(row(db, copy).legacy_copy, 1);
  for (const id of [operator, earlier, crmLine, ccLine, doneCopy]) assert.equal(row(db, id).legacy_copy, 0, 'отмечена не копия: ' + id);
  for (const id of [copy, operator, earlier, crmLine, ccLine]) {
    const r = row(db, id);
    assert.deepEqual([r.status, r.visit_id != null, r.visit_service_id != null], ['pending', true, true], 'строка записи изменена: ' + id);
  }
  assert.equal(row(db, doneCopy).status, 'done');
  assert.deepEqual([out.counts.marked_copy, out.counts.kept_booked, out.counts.kept_done], [1, 4, 1]);
  assert.deepEqual(money(db), before, 'строки визитов и счета не тронуты');
  const log = logOf(db);
  assert.equal(log.length, 6, 'не каждая строка в журнале: ' + JSON.stringify(log));
  assert.ok(log.some(([id, a]) => id === copy && a === 'marked_copy'));
  assert.ok(log.some(([id, a]) => id === ccLine && a === 'kept_booked'));
  assert.match(out.summary, /ничего не удалено/);
  // позже регистратура отменяет запись: копия снимается, строки оператора и CRM — в карточку без дня (O4)
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
  releaseCancelled(db, v);
  assert.deepEqual([row(db, copy).status, row(db, copy).visit_service_id], ['cancelled', x], 'копия вернулась в карточку желанием');
  for (const id of [operator, earlier, crmLine]) {
    const r = row(db, id);
    assert.deepEqual([r.status, r.scheduled_date, r.visit_id, r.released_from_visit_id], ['pending', null, null, v], 'строка записи не отпущена: ' + id);
  }
  assert.equal(count(db), rows);
  assert.deepEqual(money(db), before);
});

test('CRM_ONE_WAY_V1 O8 (ревью r4): строки отменённой записи — отпущенные желания, копии сняты (не удалены); старые ссылки прежней отмены и ссылка в живой визит сняты; державшая без строки визита — с отметкой; снятые не тронуты', () => {
  const { db, visit, vline, cline } = base();
  const w = visit('2026-10-21', 'cancelled');
  const xw = vline(w, 30);
  const held = cline({ day: '2026-10-21', visit: w, vs: xw, at: plus(-600) });
  const heldCopy = cline({ day: '2026-10-21', visit: w, vs: xw, at: plus(1) });
  const stale = cline({ day: '2026-10-21', visit: null, vs: xw, at: plus(-600) });
  const staleCopy = cline({ day: '2026-10-21', visit: null, vs: xw, at: plus(0) });
  const redated = cline({ day: '2026-10-25', visit: null, vs: xw, at: plus(-600) });
  const noLine = cline({ svc: 40, day: '2026-10-21', visit: w, vs: null, at: plus(-600) });
  const live = visit('2026-10-22');
  const xl = vline(live, 40);
  const moved = cline({ svc: 40, day: '2026-10-28', visit: null, vs: xl, at: plus(-600) });
  const gone = cline({ day: '2026-10-21', visit: w, vs: xw, status: 'cancelled', at: plus(-600) });
  const before = money(db);
  const rows = count(db);
  const out = crmOneWayRepair(db);
  assert.equal(count(db), rows, 'исправление удалило строки карточек');
  const r = row(db, held);
  assert.deepEqual([r.status, r.scheduled_date, r.visit_id, r.visit_service_id, r.released_from_visit_id, r.released_vs_id, r.released_held], ['pending', null, null, null, w, xw, 0]);
  for (const id of [heldCopy, staleCopy]) assert.deepEqual([row(db, id).status, row(db, id).legacy_copy], ['cancelled', 1], 'копия отменённой записи не снята: ' + id);
  const s = row(db, stale);
  assert.deepEqual([s.scheduled_date, s.visit_service_id, s.released_from_visit_id], [null, null, w]);
  const d = row(db, redated);
  assert.deepEqual([d.scheduled_date, d.visit_service_id, d.released_from_visit_id], ['2026-10-25', null, null], 'день оператора сохранён');
  const n = row(db, noLine);
  assert.deepEqual([n.visit_id, n.scheduled_date, n.released_from_visit_id, n.released_held], [null, null, w, 1]);
  const m = row(db, moved);
  assert.deepEqual([m.scheduled_date, m.visit_service_id, m.released_from_visit_id], ['2026-10-28', null, null]);
  assert.deepEqual([row(db, gone).status, row(db, gone).visit_id], ['cancelled', w], 'снятая строка — история, не трогается');
  assert.deepEqual([out.counts.released, out.counts.cancelled_copy, out.counts.released_stale, out.counts.cleared_stale, out.counts.cleared_moved], [2, 2, 1, 1, 1]);
  assert.deepEqual(money(db), before);
  assert.equal(logOf(db).length, 7);
});

test('CRM_ONE_WAY_V1 O8 (ревью r4): датированное желание без ссылки, чья карточка отменила запись того дня (привязка или след), — отпущенное желание этого визита; без такой отмены — не тронуто', () => {
  const { db, rid, newCard, visit, cline, linkTo } = base();
  const c = visit('2026-10-20', 'cancelled');
  linkTo(c, rid, 'callcenter');
  const sameDay = cline({ day: '2026-10-20' });
  const otherDay = cline({ day: '2026-10-23' });
  const undated = cline({ svc: 40 });
  const card2 = newCard();
  const c2 = visit('2026-10-24', 'cancelled');
  db.prepare("INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, set_status) VALUES (?, ?, 'in_process', 'scheduled')").run(c2, card2);
  const byTrail = cline({ rid: card2, svc: 40, day: '2026-10-24' });
  const card3 = newCard();
  const stranger = cline({ rid: card3, day: '2026-10-20' });   // у этой карточки отменённой записи того дня нет
  const live = visit('2026-10-24');
  linkTo(live, card3, 'match');
  const liveDay = cline({ rid: card3, day: '2026-10-24' });
  // привязка «только для воронки» строк карточки не брала никогда (O9) — её отмена не доказательство
  const card4 = newCard();
  const c4 = visit('2026-10-26', 'cancelled');
  linkTo(c4, card4, 'patient');
  db.prepare("INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, set_status) VALUES (?, ?, 'in_process', 'scheduled')").run(c4, card4);
  const displayDay = cline({ rid: card4, day: '2026-10-26' });
  // ревью r5 (п. 4): отменённую запись записали заново на тот же день — у карточки живая запись этого дня
  const card5 = newCard();
  const c5 = visit('2026-10-27', 'cancelled');
  linkTo(c5, card5, 'callcenter');
  const v5 = visit('2026-10-27');
  linkTo(v5, card5, 'callcenter');
  const rebooked = cline({ rid: card5, day: '2026-10-27' });
  const rows = count(db);
  const out = crmOneWayRepair(db);
  assert.equal(count(db), rows);
  const s = row(db, sameDay);
  assert.deepEqual([s.status, s.scheduled_date, s.visit_id, s.released_from_visit_id, s.released_vs_id], ['pending', null, null, c, null]);
  const t2 = row(db, byTrail);
  assert.deepEqual([t2.scheduled_date, t2.released_from_visit_id], [null, c2]);
  for (const [id, day] of [[otherDay, '2026-10-23'], [stranger, '2026-10-20'], [liveDay, '2026-10-24'], [displayDay, '2026-10-26'], [rebooked, '2026-10-27']]) {
    assert.deepEqual([row(db, id).scheduled_date, row(db, id).released_from_visit_id], [day, null], 'тронуто желание без отменённой записи своего дня: ' + id);
  }
  assert.equal(row(db, undated).released_from_visit_id, null);
  assert.equal(out.counts.released_dated, 2);
  assert.deepEqual(logOf(db).filter(([, a]) => a === 'released_dated').map(([id]) => id), [sameDay, byTrail]);
});

test('CRM_ONE_WAY_V1 O8: исправление проходит один раз — отметка и итог; второй вызов ничего не делает', () => {
  const { db, visit, vline, cline } = base();
  const v = visit('2026-10-20');
  const x = vline(v, 30);
  const first = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const out1 = crmOneWayRepair(db);
  assert.match(out1.summary, /копий отмечено: 1/);
  const mark = db.prepare('SELECT done_at, summary FROM crm_one_way_repair WHERE id = 1').get();
  assert.ok(mark.done_at);
  assert.equal(mark.summary, out1.summary);
  const second = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const out2 = crmOneWayRepair(db);
  assert.equal(out2.skipped, true);
  assert.deepEqual([row(db, first).legacy_copy, row(db, second).legacy_copy], [1, 0], 'второй проход отметил строку');
  assert.equal(count(db), 2);
});
