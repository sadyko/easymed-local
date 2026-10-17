// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r3/zz-r3-same.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R3 — same-service.js: server R7b (retire) vs mirror sameService vs screen (isBookedTwin) on a grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { sameService } from '../services/crm/booking-mirror.js';
import { sameBookedService, screenTakesBooked } from '../../public/js/shared/same-service.js';
import { isBookedTwin } from '../../public/js/admin/views/booked-rows.js';

test('CRM_ONE_WAY_V1 (повтор r3) — R3-SAME: grid — retire rule == mirror rule; screen (with each door\'s needsDoctor) takes every line the server would retire', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor) VALUES (30,'К',1,'consultation',1), (40,'А',1,'lab',0)").run();
  const docs = [null, 0, 10, 11];
  const keys = [{ s: 30 }, { s: 40 }, { c: 5 }, { c: 6 }];
  const bad = [];
  for (const kx of keys) for (const ky of keys) for (const dx of docs) for (const dy of docs) {
    const X = { service_id: kx.s ?? null, consultation_type_id: kx.c ?? null, doctor_id: dx };
    const Y = { service_id: ky.s ?? null, consultation_type_id: ky.c ?? null, doctor_id: dy };
    const lineOf = (r) => ({ serviceId: r.service_id ?? null, consultationTypeId: r.service_id == null ? (r.consultation_type_id ?? null) : null, doctorId: r.doctor_id ?? null });
    const needs = Y.service_id != null ? !!db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(Y.service_id).requires_doctor : false;
    const server = sameBookedService(lineOf(X), lineOf(Y), { needsDoctor: needs });
    const mirror = sameService(db, X, Y);
    if (server !== mirror) bad.push(['server!=mirror', X, Y, server, mirror]);
    // screen: booked-rows row of X (needsDoctor only for consultation types), screen line Y with its own needsDoctor
    const b = { ...lineOf(X), needsDoctor: X.service_id == null && X.consultation_type_id != null };
    const ln = { ...lineOf(Y), needsDoctor: Y.service_id != null ? needs : true };
    const screen = isBookedTwin(ln, b);
    if (server && !screen) bad.push(['server retires but screen inserts', X, Y]);
  }
  assert.deepEqual(bad, []);
});
