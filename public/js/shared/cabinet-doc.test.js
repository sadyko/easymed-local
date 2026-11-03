// PASTE_SOURCES_V1 — последняя ПОДПИСАННАЯ запись кабинета (visit_services.notes):
// одно правило для карты пациента («Документы», WS_DERIVED_DOCS_V1) и для
// «Вставить результаты» кабинета (rpc patient_doc_sources).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastSignedEntry } from './cabinet-doc.js';

test('lastSignedEntry: последняя подписанная версия; черновики и направления не в счёт', () => {
  const raw = JSON.stringify({ __service_workspace_v1: 1, diagnoses: [{ code: 'J20.9', type: 'main' }], history: [
    { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', fields: { chief_complaint: 'первая' } },
    { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', fields: { chief_complaint: 'вторая' } },
    { kind: 'draft', savedAt: '2026-10-03T08:00:00.000Z', fields: { chief_complaint: 'черновик' } },
    { kind: 'referral', savedAt: '2026-10-03T09:00:00.000Z' },
  ] });
  const got = lastSignedEntry(raw);
  assert.equal(got.entry.fields.chief_complaint, 'вторая');
  assert.equal(got.payload.diagnoses[0].code, 'J20.9', 'диагнозы строки едут вместе с записью');
});

test('lastSignedEntry: не JSON, текст медсестры, массив, history не массив, без подписи — null', () => {
  for (const raw of [null, '', '{не json', 'Свободный текст лаборатории', '[]',
    JSON.stringify({ history: {} }), JSON.stringify({ history: [{ kind: 'draft', fields: {} }] }), JSON.stringify({ history: [null, 1, 'x'] })]) {
    assert.equal(lastSignedEntry(raw), null, String(raw));
  }
});

test('карта пациента берёт подписанную запись тем же правилом (patient-card.js)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'admin', 'views', 'patient-card.js'), 'utf8');
  assert.match(src, /lastSignedEntry\(r\.notes\)/, 'карта пациента разбирает notes сама, мимо общего правила');
  assert.ok(!/filter\(e2 => e2\.kind === 'signed'\)/.test(src), 'в карте остался свой разбор подписанных версий');
});
