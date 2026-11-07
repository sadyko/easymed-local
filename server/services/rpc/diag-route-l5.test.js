// DIAG_ROUTE_V1 (3.22.0, ревью L-5) — ОЧЕРЕДЬ И СЧЁТЧИКИ ЛАБОРАТОРИИ — ПО ОБЩЕМУ ПРАВИЛУ МАРШРУТА.
//
// Талоны очереди (queue.js issueQueueNumbers) и счётчики «Анализы в работе» (dashboard.js) и
// «Лаборатория» сводки (dashboard-overview.js) узнавали анализ по is_lab / type = 'lab' — а
// лаборатория, кабинет и процедуры с 3.21 решают маршрут группой (shared/service-route.js): у
// группы «Консультации» (умолчание колонки, под которым клиники держат анализы) — отделением и
// типом каталога. Анализ группы «Консультации» из отделения «Лаборатория» стоял в очереди
// лаборатории, а талон получал в линию врача и в счётчики не попадал. Для остальных групп —
// ответы прежние (проверяется ниже).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueQueueNumbers } from './queue.js';
import { dashboardSummary } from './dashboard.js';
import { dashboardOverview } from './dashboard-overview.js';

process.env.TZ = 'Asia/Tashkent';
const REG = { id: 1, role: 'registrar' };
const ADMIN = { id: 9, role: 'admin' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (1,'r','x','Reg','registrar',1,0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (9,'a','x','Adm','admin',1,0)").run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (50,'Лаборатория','laboratory'), (60,'Процедурный','procedure')").run();
  db.prepare("INSERT INTO service_types (id, name) VALUES (70,'Лабораторная диагностика')").run();
  const s = db.prepare('INSERT INTO services (id, name, price, type, is_lab, department_id, type_id) VALUES (?,?,?,?,?,?,?)');
  s.run(1, 'ОАК', 30000, 'lab', 1, null, null);
  s.run(2, 'Ферритин', 70000, 'consultation', 0, 50, null);      // «Консультации» из отделения «Лаборатория»
  s.run(3, 'Витамин D', 90000, 'consultation', 0, null, 70);     // «Консультации» с «лабораторным» типом
  s.run(4, 'Капельница', 20000, 'consultation', 0, 60, null);    // «Консультации» из «Процедурного»
  s.run(5, 'Приём', 50000, 'consultation', 0, null, null);
  s.run(6, 'УЗИ', 90000, 'imaging', 0, 50, 70);                  // «Диагностика» — подсказки не решают
  s.run(7, 'ЭКГ', 40000, 'imaging', 0, 60, null);
  db.prepare("INSERT INTO patients (id, full_name, branch_id) VALUES (1,'П1',1)").run();
  db.prepare("INSERT INTO visits (id, patient_id, branch_id, visit_date, status) VALUES (1,1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'scheduled')").run();
  return db;
}
const line = (db, svc, status = 'added') => db.prepare(
  "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_at) VALUES (1,?,1,0,0,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(svc, status).lastInsertRowid;

test('ревью L-5: талон — анализ «Консультаций» из лаборатории идёт в окно забора, из «Процедурного» — в процедурный', () => {
  const db = seed();
  const ids = [1, 2, 3, 4, 5, 6, 7].map((s) => line(db, s));
  const t = new Map(issueQueueNumbers(db, { p_ids: ids }, REG).map((x) => [x.visit_service_id, x.queue_key.split(':').slice(0, 2).join(':')]));
  assert.equal(t.get(ids[0]).split(':')[0], 'lab', 'ОАК');
  assert.equal(t.get(ids[1]).split(':')[0], 'lab', 'Ферритин (отделение)');
  assert.equal(t.get(ids[2]).split(':')[0], 'lab', 'Витамин D (тип каталога)');
  assert.equal(t.get(ids[3]), 'proc:room', 'Капельница (процедурный)');
  assert.equal(t.get(ids[4]), 'doc:0', 'Приём без врача — общая врачебная линия, как прежде');
  assert.equal(t.get(ids[5]), 'doc:0', 'УЗИ «Диагностика» — подсказки не решают, как прежде');
  assert.equal(t.get(ids[6]), 'doc:0', 'ЭКГ «Диагностика» из «Процедурного» — как прежде');
});

test('ревью L-5: «Анализы в работе» сводки считает и анализ «Консультаций» из лаборатории, но не УЗИ', () => {
  const db = seed();
  for (const s of [1, 2, 3, 4, 5, 6, 7]) line(db, s, 'queued');
  assert.equal(dashboardSummary(db, {}, ADMIN).lab_pending_count, 3, 'ОАК, Ферритин, Витамин D');
});

test('ревью L-5: «Лаборатория» обзора — «заказано» тем же правилом', () => {
  const db = seed();
  for (const s of [1, 2, 3, 4, 5, 6, 7]) line(db, s, 'queued');
  assert.equal(dashboardOverview(db, { days: 7 }, ADMIN).lab.ordered, 3);
});
