// DOCTOR_RECOMMEND_V1 (2026-11-24) — «ЗАПИСИ CRM» → «НАПРАВИЛ ВРАЧ»: ОТКРЫТЫЕ РЕКОМЕНДАЦИИ ВРАЧА.
//
// Владелец: «can you bring refered patients to Направил врач place in Записи CRM, when you click to
// patient we should land here» (окно «Добавить услуги» с отмеченными рекомендациями). Кабинет врача
// больше не заводит строк визита — только рекомендации (recommended_services). Проверяется на
// настоящем приложении:
//   • открытая рекомендация — «Ждёт» сегодня, источник «Направил врач» с именем врача, строка
//     kind 'recommendation', и «Оформить по записи» ей можно (день — сегодня, статус — «Ждёт»);
//   • вчерашняя открытая — тоже сегодня (рекомендация ждёт, пока её не оформят или не уберут);
//   • оформленная (done) — «Оформлены» в день закрытия; убранная (cancelled) — «Отменены»;
//   • завтра и вкладка по умолчанию (CRM) её не показывают; счётчик вкладки не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay } from '../test-helpers/crm-unify-app.js';

const TODAY = localDay(0);
const seed = (db) => {
  const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
  p.run(91, 'Рекомендованная Анна', '+998 90 000 00 91');
  p.run(92, 'Вчерашний Борис', '+998 90 000 00 92');
  p.run(93, 'Оформленная Вера', '+998 90 000 00 93');
  p.run(94, 'Убранный Глеб', '+998 90 000 00 94');
  const r = db.prepare(`INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, recommended_by_name, status, closed_at, created_at)
                        VALUES (?, ?, ?, 10, 'Иванов', ?, ?, ?)`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const yesterday = new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  r.run(91, 40, 'Анализ крови', 'pending', null, now);
  r.run(91, 30, 'Консультация терапевта', 'pending', null, now);
  r.run(92, 40, 'Анализ крови', 'pending', null, yesterday);
  r.run(93, 40, 'Анализ крови', 'done', now, yesterday);
  r.run(94, 40, 'Анализ крови', 'cancelled', now, yesterday);
};

const waiting = async (t, args = {}) => {
  const r = await t.rpc('registrar_waiting', 'reg', args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const byPatient = (data) => new Map(data.rows.map((r) => [r.patient_id, r]));

test('DOCTOR_RECOMMEND_V1: открытая рекомендация врача — «Ждёт» сегодня под «Направил врач»', async () => {
  const t = await startCrmApp(seed);
  try {
    const m = byPatient(await waiting(t, { sources: ['doctor'] }));
    assert.deepEqual([...m.keys()].sort(), [91, 92], 'в «Ждут» — только открытые рекомендации');
    const a = m.get(91);
    assert.equal(a.day, TODAY);
    assert.equal(a.status, 'waiting');
    assert.deepEqual(a.sources, [{ kind: 'doctor', name: 'Иванов' }]);
    assert.deepEqual(a.services.slice().sort(), ['Анализ крови', 'Консультация терапевта']);
    assert.ok(a.lines.length === 2 && a.lines.every((l) => l.kind === 'recommendation' && l.recommendation_id > 0), 'строки — рекомендации');
    assert.equal(a.to_cashier, false);
    assert.equal(m.get(92).day, TODAY, 'вчерашняя открытая рекомендация ждёт и сегодня');
  } finally { t.close(); }
});

test('DOCTOR_RECOMMEND_V1: оформленная — «Оформлены», убранная — «Отменены», в день закрытия', async () => {
  const t = await startCrmApp(seed);
  try {
    const reg = byPatient(await waiting(t, { sources: ['doctor'], status: 'registered' }));
    assert.deepEqual([...reg.keys()], [93]);
    assert.equal(reg.get(93).day, TODAY);
    const can = byPatient(await waiting(t, { sources: ['doctor'], status: 'cancelled' }));
    assert.deepEqual([...can.keys()], [94]);
  } finally { t.close(); }
});

test('DOCTOR_RECOMMEND_V1: завтра и вкладка по умолчанию (CRM) рекомендаций не показывают', async () => {
  const t = await startCrmApp(seed);
  try {
    assert.equal((await waiting(t, { day: localDay(1), sources: ['doctor'] })).rows.length, 0, 'завтра — рекомендаций нет');
    assert.equal((await waiting(t, { sources: ['crm'] })).rows.length, 0, 'вкладка по умолчанию — без рекомендаций');
    assert.equal((await waiting(t, { sources: ['crm'], count_only: true })).count, 0, 'счётчик вкладки не изменился');
  } finally { t.close(); }
});
