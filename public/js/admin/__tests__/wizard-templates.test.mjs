// WIZ_TEMPLATES_LOCAL_V1 — the visit wizard must offer шаблоны сметы.
//
// The bug this pins is a comment that outlived its reason. visit-wizard.js was
// written with «Выбрать шаблон» deliberately left out, explained in its header
// as "no templates table locally" — true when it was written, false from
// migration 027 onward, where service_templates was created. Nobody revisited
// it, so the patient card's «Добавить услуги» (which opens THIS wizard, not
// service-picker-modal.js) had no templates while the Калькулятор did.
//
// A source-level guard, like migrations/055.test.js: the wizard cannot be
// imported without a DOM, but the wiring being present is exactly what was
// missing, and that is checkable.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// public/js/admin/__tests__ -> repo root is four levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const wizard = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'visit-wizard.js'), 'utf8');

test('the wizard uses the shared template module rather than its own copy', () => {
  assert.match(
    wizard,
    /import\s*\{[^}]*resolveTemplate[^}]*\}\s*from\s*'\.\/service-templates\.js/,
    'template rules belong in service-templates.js, where they are unit-tested',
  );
});

test('the смета offers «Сохранить как шаблон»', () => {
  assert.match(wizard, /Сохранить как шаблон/, 'the button the patient-card flow was missing');
  assert.match(wizard, /createTemplate\s*\(/, 'and it must actually save');
});

test('the catalogue offers «Выбрать шаблон»', () => {
  assert.match(wizard, /Выбрать шаблон/);
  assert.match(wizard, /listTemplates\s*\(/, 'and it must actually list them');
});

// The comment is the reason the feature was absent for so long. If someone
// reinstates the claim, the tables have to be gone too — and they are not.
test('the stale «no templates table locally» claim is gone', () => {
  assert.doesNotMatch(
    wizard,
    /is not ported \(no templates/i,
    'service_templates exists (migration 027) — the header must not claim otherwise',
  );
});

// applyTemplate() runs at the wizard's top level; repaintCatalog() does not
// exist there (it is nested inside paintStep1), so calling it would throw a
// ReferenceError the moment a template was applied.
test('applying a template repaints via a function that is actually in scope', () => {
  const start = wizard.indexOf('function applyTemplate(');
  assert.ok(start > -1, 'applyTemplate must exist');
  // Strip // comments: the body explains WHY repaintCatalog is not used, and
  // the check is about the code, not the prose.
  const body = wizard.slice(start, start + 1200).replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(body, /repaintCatalog\s*\(/, 'repaintCatalog is scoped inside paintStep1 — unreachable from here');
  assert.match(body, /\bpaint\s*\(\s*\)/, 'paint() re-renders the step and the смета');
});
