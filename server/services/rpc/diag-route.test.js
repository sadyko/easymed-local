// DIAG_ROUTE_V1 (2026-11-03) — «маршрут решает ГРУППА услуги, а не название»:
// сервер. Очередь процедур (procedures_list), сводка «Процедуры» главной,
// статистика лаборатории и вкладки «Вставить результаты» берут одно правило
// (public/js/shared/service-route.js): тип каталога и вид отделения решают
// только у строки без группы.
//
// Случаи расследования: A12 — ЭКГ группы «Диагностика» в отделении видом
// «Процедурный» (клиника завела «Кабинет функциональной диагностики») уходило в
// «Процедуры»; A13 / A09 — УЗИ группы «Диагностика» в отделении «Лаборатория» или
// с типом «Лабораторная диагностика» считалось анализом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { proceduresList } from './procedures.js';
import { labUsageStats } from './lab-stats.js';
import { lineKind } from './patient-doc-sources.js';

const admin = { id: 1, role: 'admin' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'uzi','x','Сонолог','doctor',1)").run();
  const proc = Number(db.prepare("INSERT INTO departments (name, kind) VALUES ('Кабинет функциональной диагностики', 'procedure')").run().lastInsertRowid);
  const lab = db.prepare("SELECT id FROM departments WHERE kind = 'laboratory' LIMIT 1").get().id;   // мигр. 049
  const labType = Number(db.prepare("INSERT INTO service_types (name) VALUES ('Лабораторная диагностика')").run().lastInsertRowid);
  const S = db.prepare('INSERT INTO services (id, name, price, type, department_id, type_id) VALUES (?, ?, 100000, ?, ?, ?)');
  S.run(101, 'ЭКГ (A12)', 'imaging', proc, null);
  S.run(102, 'УЗИ (A13)', 'imaging', lab, null);
  S.run(103, 'УЗИ (A09)', 'imaging', null, labType);
  S.run(104, 'Капельница', 'procedure', null, null);
  S.run(105, 'ОАК', 'lab', null, null);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест-A')").run();
  const v = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 12, datetime('now'), 'arrived')").run().lastInsertRowid);
  const L = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, 12, 1, 100000, 100000, 'queued')");
  for (const sid of [101, 102, 103, 104, 105]) L.run(v, sid);
  return db;
}

test('procedures_list: ЭКГ группы «Диагностика» из отделения видом «Процедурный» — не процедура; капельница — процедура', () => {
  const db = seed();
  try {
    const names = proceduresList(db, {}, admin).rows.map((r) => r.service);
    assert.deepEqual(names, ['Капельница']);
  } finally { db.close(); }
});

test('lab_usage_stats: УЗИ группы «Диагностика» из отделения «Лаборатория» и с «лабораторным» типом — не анализ', () => {
  const db = seed();
  try {
    const out = labUsageStats(db, { period: 'all' }, admin);
    assert.deepEqual(out.services.map((s) => s.name), ['ОАК']);
  } finally { db.close(); }
});

test('«Вставить результаты» (lineKind): анализ решает группа; отдел — только у строки без группы', () => {
  assert.equal(lineKind({ type: 'consultation', dept_kind: 'laboratory' }), 'consult', 'группа «Консультации» решает сама');
  assert.equal(lineKind({ type: 'other', dept_kind: 'laboratory' }), 'consult');
  assert.equal(lineKind({ type: 'imaging', dept_kind: 'laboratory' }), 'diag');
  assert.equal(lineKind({ type: '', dept_kind: 'laboratory' }), 'labs', 'без группы — прежнее правило');
  assert.equal(lineKind({ type: 'lab' }), 'labs');
  assert.equal(lineKind({ type: 'consultation', is_lab: 1 }), 'labs');
  assert.equal(lineKind({ type: 'consultation', dept_kind: 'diagnostics' }), 'diag', 'бланк диагностики внутри кабинета — как прежде');
});
