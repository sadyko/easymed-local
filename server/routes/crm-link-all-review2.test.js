// CRM_LINK_ALL_V1 (2026-10-16) — ПОВТОРНОЕ РЕВЬЮ ВОРОНКИ И ПРИВАТНОСТИ (раунд 2, 56aba5e7).
// Повторы ревью (zz-f2-privacy, zz-f2-funnel, zz-f2-funnel2) — настоящими тестами, каждый
// со своей правкой:
//   • PRIV-3  — карточка, у которой сменили пациента, не показывает визиты прежнего;
//               CRM_ONE_WAY_V1 (O10) — привязки при смене пациента остаются, чужие визиты
//               отсекает чтение (триггер мигр. 246 снят);
//   • PRIV-3b — ступень двигают только визиты пациента карточки;
//   • G-1     — отмена: дата карточки — по оставшимся живым записям (cardDateOf); живых не
//               осталось — карточке возвращается самый ранний след её привязок, в любом
//               порядке отмен;
//   • G-2 / F-2a — отмена после «Подтверждён» — как отмена из «Записан»;
//   • F-6     — запись, заведённая сразу «Подтверждён», двигает карточку так же, как
//               подтверждение после записи;
//   • F-10    — карточка, которую закрыла стойка, видит визит, даже когда его держит
//               привязка другой карточки (таблица показа crm_card_visit_views);
//   • F-3     — «Не пришёл» пропущен (P-4) — дата карточки на живой записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep } from '../services/crm/no-show.js';
import { crmCardBookings } from '../services/rpc/crm-card-bookings.js';
import { crmMergeLeads } from '../services/rpc/crm-merge.js';
import { openStageKeys } from '../services/crm/config.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D7 = localDay(7);
const D10 = localDay(10);
const BOSS = { id: 1, role: 'admin', extra_roles: [] };
const mark = (t, vid, day, hour, status, who = 'reg') => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status });
const shown = (t, rid) => crmCardBookings(t.db, { request_id: rid }, BOSS).bookings.map((b) => b.visit_id);
const liveBookings = (t, rid) => t.db.prepare(`SELECT v.id FROM visits v WHERE v.status NOT IN ('cancelled','no_show') AND (
    v.id IN (SELECT visit_id FROM crm_booking_links WHERE request_id = ?) OR
    v.id IN (SELECT visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'))`).all(rid, rid);
const seed78 = (db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Другой Пациент', '+998 90 111 22 33')").run();
const relink = (t, rid, pid, extra = {}) => t.dbq('cc', { table: 'crm_requests', op: 'update', values: { patient_id: pid, ...extra }, filters: [{ col: 'id', op: 'eq', val: rid }] });
/** Карточка, которую берёт только C′: желание на D+12, не записанное (шаг C её не берёт). */
const displayCard = (t, { stale = false } = {}) => {
  const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(stale ? 5 : 1), assigned: 3 });
  addLine(t.db, rid, { svc: 40, day: localDay(12) });
  return rid;
};

// ═══════════════════════════════════════════════════════════════════════════
// PRIV-3 — СМЕНИЛИ ПАЦИЕНТА КАРТОЧКИ — ЧУЖИХ ВИЗИТОВ ОНА НЕ ПОКАЗЫВАЕТ
// ═══════════════════════════════════════════════════════════════════════════
for (const via of ['match', 'patient']) {
  test(`CRM_LINK_ALL_V1 (ревью приватности PRIV-3, ${via}): карточке сменили пациента 77 → 78 — «Записи пациента» без визита 77 (врач, услуги); CRM_ONE_WAY_V1 (O10) — привязка остаётся, чужой визит отсекает чтение`, async () => {
    const t = await startCrmApp(seed78);
    try {
      // match — карточка ждёт без даты (шаг C); patient — её берёт только C′
      const rid = via === 'match' ? addLead(t.db, { assigned: 3, updated: daysAgoIso(1) }) : displayCard(t);
      const v = await calendarBook(t, 'reg', D3);   // регистратура записала пациента 77
      assert.deepEqual(link(t, v), { request_id: rid, source: via });
      assert.deepEqual(shown(t, rid), [v]);
      const up = await relink(t, rid, 78);
      assert.equal(up.status, 200, up.text);
      const r = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.data.bookings, [], 'карточка пациента 78 показывает визит пациента 77: ' + r.text);
      // CRM_ONE_WAY_V1 (O10) — триггер мигр. 246 снят: привязка остаётся (77 → 78 → 77 её не теряет),
      // «Записи пациента» её не показывают — визит не пациента карточки.
      assert.deepEqual(link(t, v), { request_id: rid, source: via });
    } finally { t.close(); }
  });
}

test('CRM_LINK_ALL_V1 (ревью приватности PRIV-3) · CRM_ONE_WAY_V1 (O10): у карточки без пациента записей нет; карточка показывает только визиты своего пациента — привязки при смене пациента остаются', async () => {
  const t = await startCrmApp(seed78);
  try {
    const rid = displayCard(t);
    const v77 = await calendarBook(t, 'reg', D3);
    assert.deepEqual(link(t, v77), { request_id: rid, source: 'patient' });
    const v78 = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (78, 10, ?, 'scheduled', 2)").run(at(D7, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'phone')").run(v78, rid);
    // колл-центровая привязка (не «только для воронки») не снимается, но и не показывается чужой
    const vcc = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(localDay(5), 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'callcenter')").run(vcc, rid);
    assert.equal((await relink(t, rid, 78)).status, 200);
    assert.deepEqual(link(t, v77), { request_id: rid, source: 'patient' }, 'CRM_ONE_WAY_V1 (O10) — привязка остаётся, её отсекает чтение');
    assert.deepEqual(link(t, v78), { request_id: rid, source: 'phone' });
    assert.deepEqual(link(t, vcc), { request_id: rid, source: 'callcenter' });
    assert.deepEqual(shown(t, rid), [v78], 'карточка 78 показывает не свои визиты');
    t.db.prepare('UPDATE crm_requests SET patient_id = NULL WHERE id = ?').run(rid);
    assert.deepEqual(shown(t, rid), [], 'карточка без пациента показывает визиты');
    assert.deepEqual(link(t, v78), { request_id: rid, source: 'phone' }, 'CRM_ONE_WAY_V1 (O10) — привязка остаётся');
    // правка карточки без смены пациента привязок не трогает
    const rid2 = addLead(t.db, { assigned: 3, updated: daysAgoIso(1), name: 'Вторая' });
    const v2 = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(at(localDay(6), 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(v2, rid2);
    assert.equal((await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { note: 'перезвонить', patient_id: 77 }, filters: [{ col: 'id', op: 'eq', val: rid2 }] })).status, 200);
    assert.deepEqual(link(t, v2), { request_id: rid2, source: 'patient' });
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIV-3b — СТУПЕНЬ КАРТОЧКИ ДВИГАЮТ ТОЛЬКО ВИЗИТЫ ЕЁ ПАЦИЕНТА
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью приватности PRIV-3b): карточку C′ перевели на пациента 78 — приход пациента 77 её не закрывает', async () => {
  const t = await startCrmApp(seed78);
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(10), status: 'recall' });   // давняя — C′ возвращает её
    const v = await calendarBook(t, 'reg', TODAY, { hour: 18 });
    assert.equal(link(t, v) && link(t, v).request_id, rid);
    assert.equal((await relink(t, rid, 78, { status: 'in_process' })).status, 200);
    assert.equal((await mark(t, v, TODAY, 18, 'arrived')).status, 200);
    assert.equal(t.lead(rid).status, 'in_process', 'приход пациента 77 закрыл карточку пациента 78');
  } finally { t.close(); }
});

for (const to of ['arrived', 'confirmed', 'no_show', 'cancelled']) {
  test(`CRM_LINK_ALL_V1 (ревью приватности PRIV-3b, ${to}): запись колл-центра (строка и привязка), карточку перевели на пациента 78 — «${to}» визита 77 ступень и дату карточки не трогает`, async () => {
    const t = await startCrmApp(seed78);
    try {
      const rid = addLead(t.db, { assigned: 3 });
      const day = to === 'no_show' ? TODAY : D3;
      const v = await callcenterBook(t, day, { hour: to === 'no_show' ? 8 : 12 });
      assert.equal(t.lead(rid).status, 'scheduled');
      assert.equal((await relink(t, rid, 78, { status: 'in_process', scheduled_date: D7 })).status, 200);
      const before = t.lead(rid);
      if (to === 'cancelled' || to === 'arrived') assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
      assert.equal((await mark(t, v, day, to === 'no_show' ? 8 : 12, to)).status, 200);
      const after = t.lead(rid);
      assert.deepEqual([after.status, after.scheduled_date], [before.status, before.scheduled_date], `«${to}» визита пациента 77 сдвинул карточку пациента 78`);
    } finally { t.close(); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// G-1 — ОТМЕНА: ДАТА — ПО ОСТАВШИМСЯ ЖИВЫМ ЗАПИСЯМ; ЖИВЫХ НЕТ — КАРТОЧКЕ ВОЗВРАЩАЕТСЯ
// САМЫЙ РАННИЙ СЛЕД ЕЁ ПРИВЯЗОК, В ЛЮБОМ ПОРЯДКЕ ОТМЕН
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью воронки G-1a): две записи регистратуры (C′), отменили первую — дата карточки на оставшейся записи', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D3]);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D7], 'дата карточки — на отменённом дне');
  } finally { t.close(); }
});

for (const order of ['first-then-second', 'second-then-first']) {
  test(`CRM_LINK_ALL_V1 (ревью воронки G-1b/G-1c, ${order}): обе записи C′ отменены — карточке возвращаются «Перезвонить» и прежняя дата, проход «Не пришёл» её не трогает`, async () => {
    const t = await startCrmApp();
    try {
      const rid = displayCard(t);
      const v1 = await calendarBook(t, 'reg', D3);
      const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
      const seq = order === 'first-then-second' ? [[v1, D3, 12], [v2, D7, 15]] : [[v2, D7, 15], [v1, D3, 12]];
      for (const [v, d, h] of seq) assert.equal((await mark(t, v, d, h, 'cancelled')).status, 200);
      assert.equal(liveBookings(t, rid).length, 0);
      assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', D10], 'карточка не вернулась туда, где была до записей');
      crmNoShowSweep(t.db, { day: localDay(4) });
      assert.equal(t.lead(rid).status, 'recall');
    } finally { t.close(); }
  });
}

test('CRM_LINK_ALL_V1 (ревью воронки G-1): ступень, которую поставил человек, отмена не откатывает — дата по живой записи', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    t.db.prepare("UPDATE crm_requests SET status = 'in_process' WHERE id = ?").run(rid);   // оператор передвинул сам
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['in_process', D7]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки G-1b): отмены в разные дни — след первой записи живёт, пока у карточки есть живая запись «только для воронки»; вторая отмена через два дня возвращает «Перезвонить» и прежнюю дату', async () => {
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (79, 'Третий', '+998 90 333 44 55')").run());
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    t.db.prepare('UPDATE crm_booking_undo SET created_at = ?').run(daysAgoIso(2));   // прошло два дня
    await calendarBook(t, 'reg', localDay(5), { pid: 79 });   // любая запись чистит старые следы
    assert.equal((await mark(t, v2, D7, 15, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', D10], 'след первой записи вычищен — карточка осталась «Записан»');
  } finally { t.close(); }
});

// F-1a / F-1b — то же для карточки, которую первую запись берёт шаг C (ждёт без даты), а вторую — C′.
test('CRM_LINK_ALL_V1 (ревью воронки F-1a): записи шагом C и C′, отменили первую — дата карточки на оставшейся записи', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3);
    await calendarBook(t, 'reg', D7, { svc: 40, doctor: 10 });
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D7], 'дата карточки — на отменённом дне');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки F-1b): записи шагом C и C′, отменили обе — карточка не «Записан» без записи: возвращается «В работе», проход «Не пришёл» её не трогает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 40, doctor: 10 });
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.equal((await mark(t, v2, D7, 12, 'cancelled')).status, 200);
    assert.equal(liveBookings(t, rid).length, 0);
    assert.equal(t.lead(rid).status, 'in_process', 'карточка «Записан», хотя все записи отменены');
    crmNoShowSweep(t.db, { day: localDay(4) });
    assert.equal(t.lead(rid).status, 'in_process');
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// G-2 / F-2a — ОТМЕНА ПОСЛЕ «ПОДТВЕРЖДЁН» — КАК ОТМЕНА ИЗ «ЗАПИСАН»
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью воронки F-2a): карточка колл-центра — «Подтверждён» в календаре, потом отмена — карточка в первой открытой колонке, без даты (как до R4)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal((await mark(t, v, D3, 12, 'cancelled')).status, 200);
    assert.equal(liveBookings(t, rid).length, 0);
    assert.notEqual(t.lead(rid).status, 'approved', 'карточка «Подтверждён» на отменённой записи');
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], [openStageKeys(t.db)[0], null]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки G-2): запись C′ — «Подтверждён», потом отмена — карточке возвращаются «Перезвонить» и прежняя дата; проход «Не пришёл» её не трогает', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v = await calendarBook(t, 'reg', D3);
    assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal((await mark(t, v, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', D10]);
    crmNoShowSweep(t.db, { day: localDay(4) });
    assert.equal(t.lead(rid).status, 'recall');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки G-2): «Подтверждён», отменили одну из двух записей C′ — карточка остаётся «Подтверждён», дата на живой записи', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    assert.equal((await mark(t, v2, D7, 15, 'confirmed')).status, 200);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['approved', D7]);
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// F-6 — ЗАПИСЬ, ЗАВЕДЁННАЯ СРАЗУ «ПОДТВЕРЖДЁН», — КАК ПОДТВЕРЖДЕНИЕ ПОСЛЕ ЗАПИСИ
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью воронки F-6): колл-центр завёл запись сразу «Подтверждён» — карточка в «Подтверждён», как после подтверждения записанной', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'confirmed' });
    assert.equal(b.status, 200, b.text);
    assert.deepEqual(link(t, b.json.data.visit.id), { request_id: rid, source: 'callcenter' });
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['approved', D3], 'запись «Подтверждён» оставила карточку «Записан»');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки F-6): регистратура завела запись сразу «Подтверждён» на карточку C′ — карточка «Подтверждён»; отмена возвращает её', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'confirmed' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' });
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['approved', D3]);
    assert.equal((await mark(t, vid, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', D10]);
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// F-10 — КАРТОЧКА, КОТОРУЮ ЗАКРЫЛА СТОЙКА, ВИДИТ ВИЗИТ, ДАЖЕ КОГДА ЕГО ДЕРЖИТ ПРИВЯЗКА
// ДРУГОЙ КАРТОЧКИ (crm_card_visit_views — только для показа)
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью воронки F-10): визит держит привязка карточки X (колл-центр), стойка закрыла карточку Y — Y видит визит в «Записях пациента», привязка X не тронута', async () => {
  const t = await startCrmApp();
  try {
    const X = addLead(t.db, { assigned: 3, name: 'X' });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 23), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    assert.deepEqual(link(t, vid), { request_id: X, source: 'callcenter' });
    const Y = addLead(t.db, { assigned: 4, name: 'Y', date: TODAY });   // карточка второго оператора ждёт сегодня
    const { vid: dv } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(dv, vid, 'второй визит на день');
    assert.equal(t.lead(Y).status, 'came', 'стойка не закрыла карточку Y');
    assert.ok(shown(t, Y).includes(vid), 'карточка, которую закрыла стойка, не видит визита');
    assert.deepEqual(link(t, vid), { request_id: X, source: 'callcenter' }, 'привязку X заменили');
    assert.ok(shown(t, X).includes(vid));
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки F-10): строка показа — только показ: отмена визита карточку Y не двигает; карточка, переведённая на другого пациента, визита не видит', async () => {
  const t = await startCrmApp(seed78);
  try {
    addLead(t.db, { assigned: 3, name: 'X' });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 23), duration_minutes: 30, status: 'scheduled' });
    const vid = b.json.data.visit.id;
    const Y = addLead(t.db, { assigned: 4, name: 'Y', date: TODAY });
    await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(Y).status, 'came');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM crm_card_visit_views WHERE request_id = ? AND visit_id = ?').get(Y, vid).n, 1);
    t.db.prepare("UPDATE crm_requests SET status = 'in_process' WHERE id = ?").run(Y);   // человек вернул в работу
    assert.equal((await mark(t, vid, TODAY, 23, 'cancelled')).status, 200);
    assert.equal(t.lead(Y).status, 'in_process', 'строка показа двигает ступень');
    t.db.prepare('UPDATE crm_requests SET patient_id = 78 WHERE id = ?').run(Y);
    assert.ok(!shown(t, Y).includes(vid), 'карточка пациента 78 видит визит пациента 77');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью воронки F-10): слияние карточек переносит строки показа на оставшуюся — визит виден один раз', async () => {
  const t = await startCrmApp();
  try {
    const X = addLead(t.db, { assigned: 3, name: 'X' });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 23), duration_minutes: 30, status: 'scheduled' });
    const vid = b.json.data.visit.id;
    const Y = addLead(t.db, { assigned: 4, name: 'Y', date: TODAY });
    await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.ok(shown(t, Y).includes(vid));
    const Z = addLead(t.db, { assigned: 4, name: 'Z' });
    t.db.prepare('INSERT INTO crm_card_visit_views (request_id, visit_id) VALUES (?, ?)').run(Z, vid);   // уже показывает тот же визит
    const m = crmMergeLeads(t.db, { keep_id: Z, merge_ids: [Y] }, BOSS);
    assert.ok(m, 'слияние не прошло');
    assert.deepEqual(t.db.prepare('SELECT request_id FROM crm_card_visit_views WHERE visit_id = ? ORDER BY request_id').all(vid).map((r) => r.request_id), [Z]);
    assert.deepEqual(shown(t, Z).filter((v) => v === vid), [vid]);
    assert.ok(t.lead(X), 'карточка X пропала');
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// F-3 — «НЕ ПРИШЁЛ» ПРОПУЩЕН (P-4): ДАТА КАРТОЧКИ — НА ЖИВОЙ ЗАПИСИ
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью воронки F-3): «Не пришёл» на запись регистратуры (C′), у карточки запись колл-центра через неделю — карточка «Записан» с датой живой записи', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    const v0 = await calendarBook(t, 'reg', TODAY, { hour: 8, svc: 40, doctor: 10 });
    assert.equal((await mark(t, v0, TODAY, 8, 'no_show')).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D7], 'дата карточки — на пропущенном визите');
  } finally { t.close(); }
});
