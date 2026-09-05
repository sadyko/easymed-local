// 105.test.js — PATIENT_FILE_ATTACH_V1.
//
// Миграция добавляет документу пациента ОТЗЫВ (voided_at / voided_by /
// void_reason) вместо удаления. Проверяется не «SQL выполнился», а то, из-за
// чего эта работа могла бы навредить клинике:
//
//   1. НИКТО НЕ ТЕРЯЕТ ДОКУМЕНТ В ДЕНЬ ОБНОВЛЕНИЯ: у всех существующих строк
//      три новых поля пустые, то есть «действует», и карта показывает их
//      ровно как вчера.
//   2. ПРАВИЛО ПРОДУКТА, А НЕ НОВОЕ ПРАВИЛО: имена колонок те же, что у
//      отметки медсестры (093_treatment_orders.sql) — voided_at/voided_by/
//      void_reason. Один и тот же способ погасить клиническую запись во всём
//      продукте.
//   3. МИГРАЦИЯ АДДИТИВНА: только ADD COLUMN и индекс, ни одного UPDATE и ни
//      одного DELETE — на живой базе клиники ей нечего испортить.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(HERE, '105_patient_document_void.sql');

test('105: у документа пациента появляются поля отзыва, и они пустые у всех старых строк', () => {
  const db = openDb(':memory:');
  migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Пациент','MRN-1',1)").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO visit_documents (patient_id, title, doc_type) VALUES (?, 'Заключение', 'protocol')")
    .run(pid).lastInsertRowid;

  const cols = new Set(db.prepare('PRAGMA table_info(visit_documents)').all().map((c) => c.name));
  for (const c of ['voided_at', 'voided_by', 'void_reason']) assert.ok(cols.has(c), 'нет колонки ' + c);

  const row = db.prepare('SELECT voided_at, voided_by, void_reason FROM visit_documents WHERE id = ?').get(id);
  assert.equal(row.voided_at, null, 'существующий документ действует');
  assert.equal(row.voided_by, null);
  assert.equal(row.void_reason, null);
  db.close();
});

test('105: имена полей — те же, что у отметки медсестры (093): продукт гасит записи ОДНИМ способом', () => {
  const db = openDb(':memory:');
  migrate(db);
  const doc = new Set(db.prepare('PRAGMA table_info(visit_documents)').all().map((c) => c.name));
  const marks = new Set(db.prepare('PRAGMA table_info(treatment_administrations)').all().map((c) => c.name));
  for (const c of ['voided_at', 'voided_by', 'void_reason']) {
    assert.ok(marks.has(c), '093 больше не использует ' + c + ' — согласовать словарь');
    assert.ok(doc.has(c));
  }
  db.close();
});

test('105: миграция аддитивна — ни UPDATE, ни DELETE над клиническими данными', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toUpperCase();
  assert.ok(!/\bDELETE\s+FROM\b/.test(code), 'миграция ничего не удаляет');
  assert.ok(!/\bUPDATE\s+\w/.test(code), 'миграция ничего не переписывает');
  assert.equal((code.match(/ALTER TABLE VISIT_DOCUMENTS ADD COLUMN/g) || []).length, 3);
});

test('105: частичный индекс отвечает на запрос карты — действующие документы пациента', () => {
  const db = openDb(':memory:');
  migrate(db);
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM visit_documents'
    + ' WHERE patient_id = 1 AND voided_at IS NULL ORDER BY created_at DESC').all()
    .map((r) => r.detail).join(' ');
  assert.match(plan, /idx_visit_documents_live/, 'запрос карты идёт по индексу: ' + plan);
  db.close();
});
