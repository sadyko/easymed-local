// CRM_LINK_ALL_V1 — общие шаги серверных тестов плана docs/plans/2026-10-16-crm-link-all.md
// поверх стенда crm-unify-app.js: двери записи и регистрации так, как их зовут экраны.
// Не тестовый файл — его импортируют.
import assert from 'node:assert/strict';
import { at } from './crm-unify-app.js';

export const link = (t, vid) => t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').get(vid) || null;
export const undoOf = (t, vid, rid) => t.db.prepare('SELECT prev_status, set_status FROM crm_booking_undo WHERE visit_id = ? AND request_id = ?').get(vid, rid) || null;
export const vsOf = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, created_by FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
export const cardLines = (t, rid) => t.db.prepare(`SELECT service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto
                                                    FROM crm_request_services WHERE request_id = ? AND status <> 'cancelled' ORDER BY id`).all(rid);
const priceOf = (t, svc) => t.db.prepare('SELECT price FROM services WHERE id = ?').get(svc).price;

/** Строка визита через /api/db, как её вставляют экраны регистратуры (мастер, быстрая регистрация, каталог). */
export async function addVisitLine(t, who, vid, { svc = 30, doctor = 10, quantity = 1 } = {}) {
  const p = priceOf(t, svc);
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity, unit_price: p, total: p * quantity, price_tier: 'primary', status: 'added' } });
  assert.equal(r.status, 200, r.text);
  return r.json.data.id;
}

/** Календарь → каталог услуг (не колл-центр): calendar_book, затем строка /api/db. */
export async function calendarBook(t, who, day, { hour = 12, svc = 30, doctor = 10, pid = 77 } = {}) {
  const b = await t.rpc('calendar_book', who, { patient_id: pid, doctor_id: doctor, service_id: svc, start: at(day, hour), duration_minutes: 30, status: 'scheduled' });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  await addVisitLine(t, who, vid, { svc, doctor });
  return vid;
}

/** Колл-центр в календаре: calendar_book, затем booking_lines_add. */
export async function callcenterBook(t, day, { hour = 12, svc = 30, doctor = 10, pid = 77, who = 'cc' } = {}) {
  const b = await t.rpc('calendar_book', who, { patient_id: pid, doctor_id: doctor, service_id: svc, start: at(day, hour), duration_minutes: 30, status: 'scheduled' });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  const add = await t.rpc('booking_lines_add', who, { visit_id: vid, patient_id: pid, lines: [{ service_id: svc, doctor_id: doctor, scheduled_at: at(day, hour) }] });
  assert.equal(add.status, 200, add.text);
  return vid;
}

/** Быстрая регистрация (walk-in-booking.js): ensure_visit desk:true без book, затем строки /api/db. */
export async function deskRegister(t, who = 'reg', { items = [{ svc: 30, doctor: 10 }], pid = 77 } = {}) {
  const head = items.find((i) => i.doctor) || null;
  const ev = await t.rpc('ensure_visit', who, { patient_id: pid, date: new Date().toISOString(), doctor_id: head ? head.doctor : null, visit_type: 'outpatient', desk: true });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  const ids = [];
  for (const i of items) ids.push(await addVisitLine(t, who, vid, { svc: i.svc, doctor: i.doctor || null }));
  return { vid, ids };
}
