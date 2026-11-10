// CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0) — АВТОМАТИЧЕСКИЙ «НЕ ПРИШЁЛ» ЧЕРЕЗ НАСТОЯЩИЕ ДВЕРИ.
// Владелец (2026-11-10): «we also need to add the "unarrived" status tick … also confirm that
// automatically unarrived patients goes to the unarrived».
//
// Что проверяется (настоящая база, настоящее приложение, вход под ролями):
//   1. сидовая воронка: записанный из карточки пациент, чей день записи прошёл, уходит проходом
//      (crmNoShowSweep — при запуске и раз в час) в колонку с ролью «не пришёл», ровно один раз;
//   2. настройка владельца со снимка 65: «запись» — «Перезвонить», «подтверждение» — «Записан»,
//      «не пришёл» — «Не пришёл»; и что тогда бывает с обычной карточкой «Перезвонить» с прошедшей
//      датой звонка и без записи;
//   3. роль «не пришёл» на ОТКРЫТОЙ колонке (CRM_NO_SHOW_ANY_COLUMN_V1): туда ровно один раз, и
//      новая запись из карточки возвращает её в колонку записи;
//   4. отметка «Не пришёл» в календаре переносит карточку сразу, без прохода.
// Проход «наутро» зовётся с днём после записи (crmNoShowSweep({ day })) — запись делается
// настоящей дверью на будущий день (прошедший день дверь записи не принимает).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { openDb } from '../db/connection.js';
import { crmNoShowSweep, crmArrivalCatchUp } from '../services/crm/no-show.js';

// Дни и время — по часам БАЗЫ (SQLite localtime), а не JS: проход считает день SQLite, и прогон
// поздним вечером (сдвиг пояса JS, tz-late) не должен разводить дни.
const CLOCK = openDb(':memory:');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => CLOCK.prepare("SELECT date('now', 'localtime', ?) AS d").get(off + ' days').d;
const at = (day, hh, mm = 0) => CLOCK.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc') AS t").get(day + ' ' + pad(hh) + ':' + pad(mm) + ':00').t;
const D = localDay(2);        // день записи
const NEXT = localDay(3);     // наутро после записи — день прохода
const st = (t, id) => t.lead(id).status;

/** Роли колонок через экран «CRM-канбан» (crm_config_save под администратором). map: { key: role|null }; extra — новые колонки. */
async function setRoles(t, map, extra = []) {
  const g = await t.rpc('crm_config_get', 'boss', {});
  assert.equal(g.status, 200, g.text);
  const stages = [...g.json.data.stages, ...extra];
  const won = stages.findIndex((s) => s.kind === 'won');
  // новые колонки — перед конверсией (открытые колонки после неё не бывают колонкой записи, а здесь неважно)
  const ordered = [...stages.slice(0, won).filter((s) => !extra.includes(s)), ...extra, ...stages.slice(won).filter((s) => !extra.includes(s))];
  const body = ordered.map((s) => ({ key: s.key, label: s.label, color: s.color || '', kind: s.kind || 'open', is_active: s.is_active !== false,
    role: Object.prototype.hasOwnProperty.call(map, s.key) ? map[s.key] : (s.role || null) }));
  const r = await t.rpc('crm_config_save', 'boss', { stages: body });
  assert.equal(r.status, 200, r.text);
  return Object.fromEntries(r.json.data.stages.filter((s) => s.role).map((s) => [s.role, s.key]));
}

/** Карточка, как её заводит окно заявки (views/crm.js persist): /api/db, со строкой консультации на день D. */
async function newCard(t, { status = 'in_process' } = {}) {
  const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status, source: 'call' } });
  assert.equal(r.status, 200, r.text);
  const id = r.json.data.id;
  const x = await t.dbq('cc', { table: 'crm_request_services', op: 'insert',
    values: [{ request_id: id, status: 'pending', service_id: 30, scheduled_date: D, doctor_id: 10 }] });
  assert.equal(x.status, 200, x.text);
  return id;
}
/** «Сохранить и записать» в карточке (views/crm.js bookDays): ensure_visit с записью и номером карточки. */
async function bookCard(t, rid, day = D, hh = 11) {
  const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(day, hh), doctor_id: 10, crm_request_id: rid,
    book: { doctor_id: 10, service_id: 30, start: at(day, hh), duration_minutes: 30 } });
  assert.equal(b.status, 200, b.text);
  return b.json.data.visit.id;
}
/** Час прохода: сначала догоняющий проход прихода, потом «Не пришёл» (scheduleCrmNoShow), в день `day`. */
function hourly(t, day = NEXT) {
  crmArrivalCatchUp(t.db);
  return crmNoShowSweep(t.db, { day });
}

test('3. CRM_NO_SHOW_ANY_COLUMN_V1: «не пришёл» на открытой колонке — пропущенная запись уходит туда ровно один раз; новая запись возвращает в колонку записи', async () => {
  const t = await startCrmApp();
  try {
    const roles = await setRoles(t, { no_show: null, missed: 'no_show' },
      [{ key: 'missed', label: 'Не дошли', color: 'crit', kind: 'open', is_active: true }]);
    assert.deepEqual(roles, { booked: 'scheduled', confirmed: 'approved', no_show: 'missed' });
    const A = await newCard(t);
    await bookCard(t, A);
    assert.equal(st(t, A), 'scheduled');
    assert.deepEqual(hourly(t), [A]);
    assert.equal(st(t, A), 'missed', 'пропущенная запись не ушла в открытую колонку «Не пришёл»');
    assert.deepEqual(hourly(t), [], 'проход снова «поставил» карточку, уже стоящую в колонке «Не пришёл»');
    assert.deepEqual(hourly(t, localDay(5)), [], 'и через день тоже');
    assert.equal(st(t, A), 'missed');
    // Оператор перезвонил и записал заново из карточки — карточка снова «Записан».
    await t.dbq('cc', { table: 'crm_request_services', op: 'insert',
      values: [{ request_id: A, status: 'pending', service_id: 30, scheduled_date: localDay(4), doctor_id: 10 }] });
    await bookCard(t, A, localDay(4), 12);
    assert.equal(st(t, A), 'scheduled', 'новая запись не вернула карточку из «Не пришёл»');
  } finally { t.close(); }
});

for (const where of ['lost', 'open']) {
  test(`4. отметка «Не пришёл» в календаре переносит карточку сразу, без прохода (колонка «Не пришёл» — ${where === 'lost' ? 'проигрышная' : 'открытая'})`, async () => {
    const t = await startCrmApp();
    try {
      const target = where === 'lost' ? 'no_show' : 'missed';
      if (where === 'open') {
        await setRoles(t, { no_show: null, missed: 'no_show' }, [{ key: 'missed', label: 'Не дошли', color: 'crit', kind: 'open', is_active: true }]);
      }
      const A = await newCard(t);
      const vA = await bookCard(t, A);
      assert.equal(st(t, A), 'scheduled');
      const m = await t.rpc('calendar_book', 'reg', { visit_id: vA, start: at(D, 11), status: 'no_show' });
      assert.equal(m.status, 200, m.text);
      assert.equal(st(t, A), target, 'отметка «Не пришёл» в календаре не перенесла карточку');
      assert.deepEqual(hourly(t), [], 'проход потом ещё раз «поставил» её');
      assert.equal(st(t, A), target);
    } finally { t.close(); }
  });
}
