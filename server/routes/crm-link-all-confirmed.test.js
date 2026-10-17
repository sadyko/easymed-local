// CRM_LINK_ALL_V1 (2026-10-16) — R4 (решение владельца D3, дефект G6): «ПОДТВЕРЖДЁН» В
// КАЛЕНДАРЕ ДВИГАЕТ КАРТОЧКУ ВПЕРЁД — в «Колонку подтверждения» (первая видимая открытая
// после «Колонки записи» и до «Пришёл»). Только вперёд, только из «Колонки записи» и колонок
// до неё; updated_at и дата не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { callcenterBook } from '../test-helpers/crm-link-all.js';
import { confirmedStageKeyOf } from '../../public/js/shared/crm-booked-stage.js';
import { crmVisitStatus } from '../services/crm/visit-status.js';

const D = localDay(3);
const SEED = [
  { key: 'in_process', position: 1, is_active: 1, kind: 'open' },
  { key: 'recall', position: 2, is_active: 1, kind: 'open' },
  { key: 'scheduled', position: 3, is_active: 1, kind: 'open' },
  { key: 'approved', position: 4, is_active: 1, kind: 'open' },
  { key: 'came', position: 5, is_active: 1, kind: 'won' },
  { key: 'no_show', position: 6, is_active: 1, kind: 'lost' },
];
const mark = (t, vid, status) => {
  const v = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid);
  return t.rpc('calendar_book', 'reg', { visit_id: vid, start: v.visit_date, status });
};

test('CRM_LINK_ALL_V1 R4: confirmedStageKeyOf — первая видимая открытая после колонки записи и до «Пришёл»', () => {
  assert.equal(confirmedStageKeyOf(SEED, 'scheduled'), 'approved');
  assert.equal(confirmedStageKeyOf(SEED.map((s) => (s.key === 'approved' ? { ...s, is_active: 0 } : s)), 'scheduled'), null, 'скрытая колонка не цель');
  assert.equal(confirmedStageKeyOf(SEED.map((s) => (s.key === 'approved' ? { ...s, position: 9 } : s)), 'scheduled'), null, 'колонка после «Пришёл» не цель');
  assert.equal(confirmedStageKeyOf(SEED, 'approved'), null, 'после колонки записи ничего нет');
  assert.equal(confirmedStageKeyOf(SEED, null), null);
  assert.equal(confirmedStageKeyOf([...SEED, { key: 'agreed', position: 3.5, is_active: 1, kind: 'open' }], 'scheduled'), 'agreed');
});

test('CRM_LINK_ALL_V1 R4: «Подтверждён» на записи колл-центра — карточка в «Подтверждён»; дата и updated_at прежние', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = await callcenterBook(t, D);
    const before = t.lead(rid);
    assert.equal(before.status, 'scheduled');
    const r = await mark(t, vid, 'confirmed');
    assert.equal(r.status, 200, r.text);
    const c = t.lead(rid);
    assert.equal(c.status, 'approved');
    assert.equal(c.scheduled_date, before.scheduled_date);
    assert.equal(c.updated_at, before.updated_at, 'отметка календаря — не контакт (I-5)');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R4: только вперёд — «Пришёл», «Не пришёл» и колонка после записи не двигаются; карточка до записи — двигается', async () => {
  const t = await startCrmApp();
  try {
    const came = addLead(t.db, { status: 'came' });
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(at(D, 9)).lastInsertRowid);
    addLine(t.db, came, { svc: 30, day: D, visit: vid });
    const recall = addLead(t.db, { status: 'recall' });
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, recall);
    const r = await mark(t, vid, 'confirmed');
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(came).status, 'came');
    assert.equal(t.lead(recall).status, 'approved', 'карточка до колонки записи не подтвердилась');
    t.db.prepare("UPDATE crm_requests SET status = 'no_show' WHERE id = ?").run(recall);
    await mark(t, vid, 'scheduled');
    await mark(t, vid, 'confirmed');
    assert.equal(t.lead(recall).status, 'no_show', '«Не пришёл» поднята отметкой «Подтверждён»');
  } finally { t.close(); }
});

// CRM_LINK_ALL_V1 (повторное ревью воронки, F-2a) — прежде здесь стояло «карточка остаётся
// «Подтверждён», дата стёрта»: так карточка без единой записи висела в «Подтверждён» навсегда.
// «Подтверждён» поставила сама запись (R4) — её отмена возвращает карточку, как отмена из
// «Записан» (до R4 так и было). Карточку, которую передвинул человек, — нет (A-I4,
// crm-unify-final-status.test.js).
test('CRM_LINK_ALL_V1 R4 (F-2a): подтверждённую запись отменили — карточка в первой открытой колонке, дата стёрта', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = await callcenterBook(t, D);
    await mark(t, vid, 'confirmed');
    assert.equal(t.lead(rid).status, 'approved');
    const r = await mark(t, vid, 'cancelled');
    assert.equal(r.status, 200, r.text);
    assert.notEqual(t.lead(rid).status, 'approved', 'карточка «Подтверждён» на отменённой записи');
    assert.equal(t.lead(rid).scheduled_date, null, 'дата отменённого приёма осталась — наутро проход унёс бы карточку в «Не пришёл»');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R4: визит соседнего здания — «Подтверждён» карточку не двигает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'scheduled' });
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin) VALUES (77, 10, ?, 'confirmed', 'B')").run(at(D, 9)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    crmVisitStatus(t.db, { visitId: vid, from: 'scheduled', to: 'confirmed' });
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});
