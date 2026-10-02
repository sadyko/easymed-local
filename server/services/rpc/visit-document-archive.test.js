// CABINET_FIX_V1_R1 (2026-10-02, ревью п. 2) — ПОВТОРНАЯ ПОДПИСЬ НЕ ТЕРЯЕТ ТЕКСТ.
//
// visit_document_archive отзывал при каждой подписи ОБА вида документа строки —
// и протокол приёма, и заключение диагностики. Документ УЗИ, подписанный
// «Приёмом», переподписанный бланком «Диагностика» (или пустым бланком),
// пропадал из архива: видимым оставался новый, а в нём текста приёма нет.
// Теперь:
//   • отзывается только документ ТОГО ЖЕ вида — протокол заменяет протокол,
//     заключение диагностики — заключение;
//   • пустая подпись (ни текста, ни изображений, ни рецепта) не отзывает
//     прежний документ того же вида, в котором текст есть: остаются оба.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { visitDocumentArchive } from './patient-card.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7, 'doc', 'x', 'Каримов Алишер', 'doctor');
    INSERT INTO patients (id, full_name) VALUES (1, 'Азизов Бахтиёр');
    INSERT INTO services (id, name, price) VALUES (1, 'УЗИ почек', 120000);
    INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-10-01T07:00:00Z');
    INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (1, 1, 1, 7, 1, 120000, 120000, 'completed');
  `);
  return db;
}
const doc = { id: 7, role: 'doctor', extra_roles: [] };
const sign = (db, doc_type, body) => visitDocumentArchive(db, { visit_service_id: 1, doc_type, title: 'Документ', body }, doc);
const active = (db) => db.prepare('SELECT doc_type, body FROM visit_documents WHERE visit_service_id = 1 AND voided_at IS NULL ORDER BY id')
  .all().map((r) => [r.doc_type, JSON.parse(r.body)]);

const PROTOCOL = { patientName: 'Азизов Бахтиёр', complaint: 'Боль в пояснице', exam: 'Симптом поколачивания отрицательный', dx: '', therapy: '' };
const DIAG = { patientName: 'Азизов Бахтиёр', service: 'УЗИ почек', description: 'Почки обычных размеров', conclusion: 'Патологии нет' };
const DIAG_EMPTY = { patientName: 'Азизов Бахтиёр', service: 'УЗИ почек', description: '', conclusion: '', images: [] };

test('подпись другим видом не отзывает документ прежнего вида: протокол приёма остаётся рядом с заключением диагностики', () => {
  const db = seed();
  sign(db, 'protocol', PROTOCOL);
  sign(db, 'diag', DIAG);
  const docs = active(db);
  assert.deepEqual(docs.map((d) => d[0]), ['protocol', 'diag'], 'протокол приёма отозван подписью диагностики — его текст пропал из архива');
  assert.equal(docs[0][1].complaint, 'Боль в пояснице');
});

test('документ того же вида заменяется, как прежде: старая версия отозвана, а не стёрта', () => {
  const db = seed();
  sign(db, 'diag', DIAG);
  sign(db, 'diag', { ...DIAG, conclusion: 'Патологии нет. Контроль через год.' });
  assert.deepEqual(active(db).map((d) => d[1].conclusion), ['Патологии нет. Контроль через год.']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visit_documents WHERE visit_service_id = 1').get().n, 2, 'прежняя версия стёрта, а не отозвана');
});

test('пустая подпись не отзывает прежний документ с текстом: остаются оба', () => {
  const db = seed();
  sign(db, 'diag', DIAG);
  sign(db, 'diag', DIAG_EMPTY);
  const docs = active(db);
  assert.equal(docs.length, 2, 'пустая подпись заменила документ с текстом');
  assert.equal(docs[0][1].description, 'Почки обычных размеров');
  // изображения и рецепт — тоже содержание: такую подпись пустой не считаем
  const db2 = seed();
  sign(db2, 'diag', DIAG);
  sign(db2, 'diag', { ...DIAG_EMPTY, images: ['data:image/jpeg;base64,AA'] });
  assert.equal(active(db2).length, 1, 'подпись с изображением не заменила прежнюю');
  // пустой поверх пустого — замена, как прежде (тест F2 security-v3120)
  const db3 = seed();
  sign(db3, 'protocol', { v: 1 });
  sign(db3, 'protocol', { v: 2 });
  assert.deepEqual(active(db3).map((d) => d[1]), [{ v: 2 }]);
});
