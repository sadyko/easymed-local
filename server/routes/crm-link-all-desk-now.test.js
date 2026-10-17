// CRM_LINK_ALL_V1 (2026-10-16) — R3 (решение владельца D2, дефект G5): МАСТЕР НА СЕГОДНЯ
// «СЕЙЧАС» — ПРИХОД К СТОЙКЕ. Без слота (живая очередь, услуги без времени) мастер шлёт
// ensure_visit с desk: true — как быстрая регистрация; со слотом — тоже, если слот начинается
// не позже чем через 30 минут: сервер проверяет это сам (DESK_NOW_MINUTES, wizard-desk.js).
// Слот позже — запись. Роль и сегодняшний день проверяет шаг связи (deskArrival).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { link } from '../test-helpers/crm-link-all.js';

const local = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
/** Слот через `min` минут — того же местного дня? Иначе проверка о другом (около полуночи). */
const sameDay = (min) => local(Date.now() + min * 60000) === local(Date.now());
const ensure = (t, who, startIso, extra = {}) => t.rpc('ensure_visit', who, { patient_id: 77, date: startIso, doctor_id: 10, visit_type: 'outpatient',
  book: { doctor_id: 10, service_id: 30, start: startIso, duration_minutes: 30 }, desk: true, ...extra });

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот через 10 минут: «Пришёл»', { skip: !sameDay(40) && 'около полуночи слот уходит в другой день' }, async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const r = await ensure(t, 'reg', start);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(link(t, r.json.data.visit.id).request_id, rid);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот уже начался (записан на 20 минут раньше): «Пришёл»', { skip: !sameDay(-20) && 'сразу после полуночи слот во вчерашнем дне' }, async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const r = await ensure(t, 'reg', new Date(Date.now() - 20 * 60000).toISOString());
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот через 3 часа (или завтра): запись, «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const r = await ensure(t, 'reg', new Date(Date.now() + 3 * 3600e3).toISOString());
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: близкий слот с desk от врача и колл-центра — не приход (deskArrival не меняется)', { skip: !sameDay(40) && 'около полуночи' }, async () => {
  for (const who of ['doc', 'cc']) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, {});
      const r = await ensure(t, who, new Date(Date.now() + 10 * 60000).toISOString());
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, 'scheduled', who);
    } finally { t.close(); }
  }
});
