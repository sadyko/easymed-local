// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — СТРОК «ОКАЗАНА» ИЗ ВИЗИТА БОЛЬШЕ НЕТ.
// crmWonCardLines (задача 3, R6) писал строки карточки 'done' по каждой строке визита, который
// держит карточка в «Пришёл», — и до прихода тоже. 'done' — доказательство прихода
// (booking-mirror.js arrivedByEvidence): запись считалась пришедшей, зеркало замирало, отмена в
// CRM оставляла услугу в счёте. Теперь услуги визита карточка показывает списком «Записи
// пациента»; карточку, которую закрыла стойка, а визит держит строка другой карточки, видно по
// привязке для воронки (P-7). Повторы ревью денег (zz-money-won-done, -done-blocks-home,
// -wonlines-edges) и воронки (zz-funnel-a F2/F2b/F2c, -b B8/B9) — настоящими тестами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, calendarBook, callcenterBook, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';
import { arrivedByEvidence } from '../services/crm/booking-mirror.js';
import { crmLinkVisit } from '../services/crm/visit-link.js';
import * as visitLink from '../services/crm/visit-link.js';

const TODAY = localDay(0);
const TOMORROW = localDay(1);
const allLines = (t, rid) => t.db.prepare('SELECT id, service_id, status, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);
const done = (t, rid) => allLines(t, rid).filter((l) => l.status === 'done');
const total = (t, vid) => Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);

test('CRM_LINK_ALL_V1 ред. 2: crmWonCardLines удалён — строк «оказана» из визита нет ни у одной двери', () => {
  assert.equal(typeof visitLink.crmWonCardLines, 'undefined');
});

// ─── zz-money-won-done (W1–W4): запись позже сегодня у карточки «Пришёл» ─────────
async function laterTodayHeldByWonCard(t) {
  const rid = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
  addLine(t.db, rid, { svc: 40, day: TODAY });
  const vid = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
  return { rid, vid };
}

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег W1): запись позже сегодня у прошлой «Пришёл» — до прихода ни одной строки «оказана», запись не «пришла»', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await laterTodayHeldByWonCard(t);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(vid).status, 'scheduled');
    assert.deepEqual(done(t, rid), [], 'карточка показывает услугу оказанной, а пациента ещё нет');
    assert.equal(arrivedByEvidence(t.db, vid), false, 'запись считается пришедшей');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег W2): та же запись — колл-центр по-прежнему снимает анализ (booking_line_remove)', async () => {
  const t = await startCrmApp();
  try {
    const { vid } = await laterTodayHeldByWonCard(t);
    const an = vsOf(t, vid).find((x) => x.service_id === 40);
    assert.ok(an, 'анализа нет в записи');
    const r = await t.rpc('booking_line_remove', 'cc', { visit_service_id: an.id });
    assert.equal(r.status, 200, r.text);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег W3): та же запись — анализ, снятый в CRM, уходит из визита и счёта', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await laterTodayHeldByWonCard(t);
    const line = allLines(t, rid).find((l) => l.service_id === 40 && l.status === 'pending');
    assert.ok(line && line.visit_id === vid);
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', filters: [{ col: 'id', op: 'eq', val: line.id }], values: { status: 'cancelled' } });
    assert.equal(up.status, 200, up.text);
    const left = vsOf(t, vid);
    assert.deepEqual(left.map((x) => x.service_id), [30], 'снятый в CRM анализ остался в визите');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: left.map((x) => x.id), discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(total(t, vid), 100000, 'в счёте анализ, снятый в CRM');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег W4): карточку перетащили в «Пришёл», её запись позже сегодня — строка регистратуры не становится «оказана»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const vid = await callcenterBook(t, TODAY, { hour: 18 });
    const mv = await t.dbq('boss', { table: 'crm_requests', op: 'update', filters: [{ col: 'id', op: 'eq', val: rid }], values: { status: 'came' } });
    if (mv.status !== 200) return;   // перетаскивание в «Пришёл» запрещено — путь закрыт и так
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    assert.deepEqual(done(t, rid), [], 'строка «оказана» до прихода');
    assert.equal(arrivedByEvidence(t.db, vid), false);
  } finally { t.close(); }
});

// ─── zz-money-done-blocks-home (H1) ──────────────────────────────────────────
test('CRM_LINK_ALL_V1 ред. 2 (ревью денег H1): визит стойки с консультацией; строку той же консультации (без врача) перенесли на сегодня; мастер — ОДНА консультация', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, {});
    const l = addLine(t.db, a, { svc: 30, day: TOMORROW, doctor: null });
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(a).status, 'came');
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', values: { scheduled_date: TODAY }, filters: [{ col: 'id', op: 'eq', val: l }] });
    assert.equal(up.status, 200, up.text);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    const rows = vsOf(t, vid);
    assert.deepEqual(rows.map((x) => x.service_id), [30], 'вторая консультация в визите');
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: rows.map((x) => x.id), discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(total(t, vid), 100000);
  } finally { t.close(); }
});

// ─── zz-money-wonlines-edges (E1, E4) и zz-funnel-a (F2b): стойка, визит держит чужая строка ─
test('CRM_LINK_ALL_V1 ред. 2 (ревью денег E1, P-7): стойка закрывает свежую карточку B, визит держит строка прошлой «Пришёл» A — B видит визит привязкой, A сегодняшней консультации не получает', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, { status: 'came', updated: daysAgoIso(9), name: 'A' });
    addLine(t.db, a, { svc: 40, day: TODAY });
    const b = addLead(t.db, { name: 'B' });
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(b).status, 'came');
    assert.ok(!allLines(t, a).some((l) => l.service_id === 30), 'сегодняшняя консультация записана в карточку прошлой недели');
    assert.deepEqual(link(t, vid), { request_id: b, source: 'patient' }, 'карточка, которую закрыла стойка, не видит визит (P-7)');
    assert.deepEqual(allLines(t, b), [], 'строки визита скопированы в карточку B');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки F2b, P-7): стойка — сегодняшние услуги видны карточке, которую она закрыла, а не прошломесячной «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const old = addLead(t.db, { status: 'came', date: localDay(-30), updated: daysAgoIso(30), name: 'Прошлый' });
    addLine(t.db, old, { svc: 40, day: TODAY });
    const fresh = addLead(t.db, { name: 'Сегодняшний звонок' });
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(fresh).status, 'came');
    assert.equal(link(t, vid).request_id, fresh);
    assert.ok(!cardLines(t, old).some((l) => l.service_id === 30), 'прошломесячная «Пришёл» получила сегодняшнюю консультацию');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег E4, I7): сбой привязки внутри C′ — запись календаря со строкой проходит, C′ откатывается целиком', async () => {
  const t = await startCrmApp((db) => {
    db.exec("CREATE TRIGGER cla_no_link BEFORE INSERT ON crm_booking_links BEGIN SELECT RAISE(ABORT, 'cla boom'); END;");
  });
  try {
    const rid = addLead(t.db, { date: localDay(3) });
    addLine(t.db, rid, { svc: 40, day: localDay(3) });
    const vid = await calendarBook(t, 'reg', localDay(5));
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30]);
    assert.equal(t.lead(rid).status, 'in_process', 'C′ применён наполовину (ступень без привязки)');
  } finally { t.close(); }
});

// ─── zz-funnel-a (F2, F2c) ───────────────────────────────────────────────────
async function wonCardHoldsLaterToday(t) {
  const rid = addLead(t.db, { status: 'came', date: localDay(-1) });
  const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(TODAY, 17)).lastInsertRowid);
  const lid = addLine(t.db, rid, { svc: 40, day: TODAY, visit: vid });
  const vs40 = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, 1, 40000, 40000, 'added', 3)").run(vid).lastInsertRowid);
  t.db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 1 WHERE id = ?').run(vs40, lid);
  return { rid, vid };
}

test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки F2): карточка «Пришёл» держит запись позже сегодня — услуга, добавленная до прихода, не становится «оказана»', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await wonCardHoldsLaterToday(t);
    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    assert.deepEqual(done(t, rid), [], 'строка «оказана», а пациента нет');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки F2c): после той же вставки запись не «пришла по доказательствам»: колл-центр добавляет услугу, отмена не оставляет «оказана»', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await wonCardHoldsLaterToday(t);
    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    assert.equal(arrivedByEvidence(t.db, vid), false, 'запись не пришла, а доказательства говорят «пришла»');
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    const c = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TODAY, 17), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(done(t, rid), []);
  } finally { t.close(); }
});

// ─── zz-funnel-b (B8, B9) ────────────────────────────────────────────────────
test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки B9): услуга, убранная из визита сразу после регистрации, не остаётся «оказана» на карточке', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    const del = await t.dbq('reg', { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: ids[1] }] });
    let removed = del.status === 200 && !t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(ids[1]);
    if (!removed) {
      await t.rpc('remove_own_visit_line', 'reg', { visit_service_id: ids[1] });
      removed = !t.db.prepare("SELECT 1 FROM visit_services WHERE id = ? AND status <> 'cancelled'").get(ids[1]);
    }
    assert.ok(removed, 'строку не удалось убрать в этом стенде');
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30]);
    assert.ok(!cardLines(t, rid).some((l) => l.service_id === 40 && l.status === 'done'), 'убранный анализ «оказан» на карточке');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки B8): визит соседнего здания — стойка ничего не связывает и строк не пишет', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came' });
    const live = addLead(t.db, {});
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, sync_origin) VALUES (77, 10, ?, 'scheduled', 2, 'B')").run(at(TODAY, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 40000, 40000, 'added')").run(vid);
    crmLinkVisit(t.db, vid, { id: 2, role: 'registrar', extra_roles: [] }, { desk: true });
    assert.deepEqual(cardLines(t, rid), []);
    assert.equal(t.lead(live).status, 'in_process');
  } finally { t.close(); }
});
