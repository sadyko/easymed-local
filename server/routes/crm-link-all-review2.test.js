// CRM_LINK_ALL_V1 (2026-10-16) — ПОВТОРНОЕ РЕВЬЮ ВОРОНКИ И ПРИВАТНОСТИ (раунд 2, 56aba5e7).
// Повторы ревью (zz-f2-privacy, zz-f2-funnel, zz-f2-funnel2) — настоящими тестами, каждый
// со своей правкой:
//   • PRIV-3  — карточка, у которой сменили пациента, не показывает визиты прежнего; привязки
//               «только для воронки» к чужим визитам при смене пациента снимаются;
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
  test(`CRM_LINK_ALL_V1 (ревью приватности PRIV-3, ${via}): карточке сменили пациента 77 → 78 — «Записи пациента» без визита 77 (врач, услуги)${via === 'patient' ? ', привязка «только для воронки» к нему снята' : ''}`, async () => {
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
      if (via === 'patient') assert.equal(link(t, v), null, 'привязка для воронки к визиту прежнего пациента осталась');
    } finally { t.close(); }
  });
}

test('CRM_LINK_ALL_V1 (ревью приватности PRIV-3): у карточки без пациента записей нет; привязка к визиту нового пациента остаётся, к визиту прежнего — снимается', async () => {
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
    assert.equal(link(t, v77), null);
    assert.deepEqual(link(t, v78), { request_id: rid, source: 'phone' });
    assert.deepEqual(link(t, vcc), { request_id: rid, source: 'callcenter' });
    assert.deepEqual(shown(t, rid), [v78], 'карточка 78 показывает не свои визиты');
    t.db.prepare('UPDATE crm_requests SET patient_id = NULL WHERE id = ?').run(rid);
    assert.deepEqual(shown(t, rid), [], 'карточка без пациента показывает визиты');
    assert.equal(link(t, v78), null, 'карточке без пациента осталась привязка для воронки');
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
