// INPATIENT_REQUIRED_V1 — разделы документов истории болезни: одна копия на сервер и экран.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_SECTIONS, SECTION_KEYS, sectionsFor } from './case-doc-sections.js';

test('разделы: пять ключей; у каждого рода есть диагноз; неизвестный род — полный набор', () => {
  assert.deepEqual(SECTION_KEYS, ['complaints', 'objective', 'diagnosis', 'plan', 'body']);
  assert.deepEqual(sectionsFor('operation'), ['diagnosis', 'body']);
  assert.deepEqual(sectionsFor('round'), ['complaints', 'objective', 'diagnosis', 'plan']);
  assert.deepEqual(sectionsFor('own_7'), ['complaints', 'objective', 'diagnosis', 'plan', 'body']);
  for (const kind of Object.keys(KIND_SECTIONS)) assert.ok(sectionsFor(kind).includes('diagnosis'), kind);
});

test('экран не держит второй копии списка: case-doc-a4.js берёт его отсюда', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'admin', 'views', 'case-doc-a4.js'), 'utf8');
  assert.ok(src.includes("from '../../shared/case-doc-sections.js'"), 'case-doc-a4.js должен импортировать общий список');
  assert.ok(!/export const KIND_SECTIONS\s*=\s*Object\.freeze\(\{/.test(src), 'вторая копия KIND_SECTIONS в case-doc-a4.js');
  assert.ok(!/\bKIND_SECTIONS\s*=/.test(src), 'KIND_SECTIONS присваивается в case-doc-a4.js');
  assert.ok(!/function\s+sectionsFor\b/.test(src), 'своя sectionsFor в case-doc-a4.js');
});

test('ревью: списки разделов заморожены, sectionsFor отдаёт копию', () => {
  for (const [kind, list] of Object.entries(KIND_SECTIONS)) assert.ok(Object.isFrozen(list), kind);
  const a = sectionsFor('intake');
  a.push('x');
  assert.ok(!sectionsFor('intake').includes('x'), 'правка ответа не должна портить список');
});
