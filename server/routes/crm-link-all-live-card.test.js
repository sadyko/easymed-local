// CRM_LINK_ALL_V1 (2026-10-16) — R1 + R2: ЖИВАЯ КАРТОЧКА ПАЦИЕНТА ДЕРЖИТ ЛЮБУЮ ЕГО ЗАПИСЬ
// (docs/specs/2026-10-16-crm-link-all-doors-design.md, R1–R7), через настоящие двери
// (/api/rpc, /api/db) под настоящими ролями. Стенд — server/test-helpers/crm-unify-app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, undoOf, vsOf, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const D = localDay(3);
const D2 = localDay(5);

// ─── R1 + R2 (решение D1) ──────────────────────────────────────────────────
// CRM_LINK_ALL_V1 (редакция 2) — «показывать, а не копировать»: привязка C′ только для воронки,
// услуга визита в карточку строкой не копируется (её показывает список «Записи пациента»).
test('CRM_LINK_ALL_V1 R1: регистратура записывает на ДРУГОЙ день — живая карточка держит визит (привязка для воронки), строки визита не копируются, строка своего дня не тронута', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const vid = await calendarBook(t, 'reg', D2);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' }, 'визит другого дня не привязан к живой карточке');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id]),
      [[30, D, 'pending', null]], 'строка визита скопирована в карточку или тронута строка своего дня');
    const c = t.lead(rid);
    assert.equal(c.status, 'scheduled');
    assert.equal(c.scheduled_date, D2, 'дата карточки — ближайший записанный день (cardDateOf)');
    assert.equal(vsOf(t, vid).length, 1, 'в визите вторая строка');
    // CRM_LINK_ALL_V1 (ред. 2) — визит виден в «Записях пациента» карточки (crm_card_bookings).
    const bk = await t.rpc('crm_card_bookings', 'boss', { request_id: rid });
    assert.equal(bk.status, 200, bk.text);
    assert.deepEqual(bk.json.data.bookings.map((b) => [b.visit_id, b.day, b.services.map((s) => s.name)]), [[vid, D2, ['Консультация терапевта']]]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: карточка без движения дольше окна — сначала в начало воронки, затем «Записан»; след отмены помнит прежнюю ступень', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', updated: daysAgoIso(5) });
    const vid = await calendarBook(t, 'boss', D);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' });
    const c = t.lead(rid);
    assert.equal(c.status, 'scheduled');
    assert.equal(c.scheduled_date, D);
    assert.ok(Date.parse(c.updated_at) > Date.now() - 3600e3, 'запись после окна — контакт: updated_at не сдвинулся');
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'recall', set_status: 'scheduled' }, 'discard_empty_visit вернёт не ту ступень');
    assert.deepEqual(linesOf(t.db, rid), [], 'CRM_LINK_ALL_V1 (ред. 2) — строка визита скопирована в карточку');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: две живые карточки, ни одна не ждёт этот день — визит берёт двигавшаяся последней; при равенстве — больший id', async () => {
  const t = await startCrmApp();
  try {
    const older = addLead(t.db, { updated: daysAgoIso(2) });
    addLine(t.db, older, { svc: 40, day: D2 });
    const newer = addLead(t.db, { updated: daysAgoIso(1) });
    addLine(t.db, newer, { svc: 40, day: D2 });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid).request_id, newer, 'взята не та карточка');
    assert.equal(t.lead(older).status, 'in_process', 'вторая карточка сдвинулась');
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    const same = daysAgoIso(1);
    const a = addLead(t2.db, { updated: same });
    addLine(t2.db, a, { svc: 40, day: D2 });
    const b = addLead(t2.db, { updated: same });
    addLine(t2.db, b, { svc: 40, day: D2 });
    const vid = await calendarBook(t2, 'reg', D);
    assert.equal(link(t2, vid).request_id, b, 'при равном движении — больший id');
  } finally { t2.close(); }
});

test('CRM_LINK_ALL_V1 R1: закрытые карточки («Пришёл», «Обработка остановлена») запись не получают и не открываются; новой карточки нет', async () => {
  const t = await startCrmApp();
  try {
    const came = addLead(t.db, { status: 'came' });
    const stopped = addLead(t.db, { status: 'stopped' });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid), null);
    assert.equal(t.lead(came).status, 'came');
    assert.equal(t.lead(stopped).status, 'stopped');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2, 'регистратура завела карточку (решение 2)');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 0, 'закрытой карточке приписана услуга');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: давняя «Не пришёл» — живая: запись на будущее возвращает её в начало и ставит «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'no_show', date: localDay(-10), updated: daysAgoIso(10) });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D);
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'no_show', set_status: 'scheduled' });
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: запись ПРОШЛОГО дня (правка истории) живую карточку не берёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    addLine(t.db, rid, { svc: 40, day: D2 });
    const vid = await calendarBook(t, 'reg', localDay(-1));
    assert.equal(link(t, vid), null);
    assert.equal(t.lead(rid).status, 'in_process');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: врач записывает «Повторный визит» на другой день — та же карточка; пациента без карточки — нет', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'doc', D2);
    assert.equal(link(t, vid).request_id, rid);
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[40, null]], 'CRM_LINK_ALL_V1 (ред. 2) — строка визита скопирована в карточку');
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Без Карточки','+998 91 000 00 01')").run();
    const v2 = await calendarBook(t, 'doc', D2, { pid: 78, hour: 15 });
    assert.equal(link(t, v2), null);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests WHERE patient_id = 78').get().n, 0);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: колл-центр — та же карточка, что и раньше (C′ до шага E), и ответ записи о ней молчит', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 4, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D2, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'callcenter' });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'колл-центр завёл вторую карточку');
    assert.ok(!JSON.stringify(b.json).includes('"request_id"') && !JSON.stringify(add.json).includes('crm_requests'), 'ответ раскрывает карточку');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R2: стойка закрывает живую карточку ЛЮБОЙ давности — возврат в начало, затем «Пришёл»; дата прежняя', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: localDay(-20), updated: daysAgoIso(20) });
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(t.lead(rid).scheduled_date, localDay(-20), 'стойка сменила дату карточки');
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'recall', set_status: 'came' });
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R2: две карточки — свежая закрывается, старая (другое обращение) остаётся как была', async () => {
  const t = await startCrmApp();
  try {
    const old = addLead(t.db, { status: 'recall', updated: daysAgoIso(30) });
    const fresh = addLead(t.db, {});
    await deskRegister(t, 'reg');
    assert.equal(t.lead(fresh).status, 'came');
    assert.equal(t.lead(old).status, 'recall', 'стойка закрыла и старую карточку: шаг C уже взял свежую, C′ не нужен');
  } finally { t.close(); }
});
