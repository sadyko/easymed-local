// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8z-deskarrive.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// Probe: 37a61983 cameSurely vs desk registration (CRM arrival rule, lines 'done', visit stays 'scheduled').
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking } from './bookings.js';
import { syncVisitOutcomes } from './visit-events.js';
import { crmVisitStatus } from '../crm/visit-status.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

// Решение владельца (2026-10-17): партнёру «пришёл» — ТОЛЬКО после оплаты или начатой услуги; бесплатная
// неоплаченная регистрация на стойке (строки карточки закрыты приходом, визит «Записан») — не приход.
test('CRM_ONE_WAY_V1 (повтор 8a) — free unpaid desk registration is NOT «arrived» for the partner; a started service makes it «arrived»', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW }), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  // то, что делает стойка: правило прихода CRM (строки карточки 'done', визит остаётся «Записан»)
  crmVisitStatus(s.db, { visitId: c.visit.id, from: null, to: 'arrived' });
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:30'), kekPath: s.kekPath });
  const sameDay = one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status;
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  const nextDay = one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status;
  assert.notEqual(sameDay, 'arrived', 'free unpaid desk registration reported to the partner as «arrived» the same day');
  assert.notEqual(nextDay, 'arrived', 'free unpaid desk registration reported to the partner as «arrived»');
  // работа над услугой — приход: партнёр узнаёт «пришёл»
  const line = one(s.db, 'SELECT id FROM visit_services WHERE visit_id = ? ORDER BY id', c.visit.id);
  assert.ok(line, 'the booked consultation is not in the visit');
  s.db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(line.id);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '10:00'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status, 'arrived', 'a started service did not report «arrived»');
});
