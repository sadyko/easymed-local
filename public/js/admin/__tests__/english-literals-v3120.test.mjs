// V3120_FIX (2026-09-27) — АНГЛИЙСКИЙ ТЕКСТ, КОТОРЫЙ tr() НЕ ПЕРЕВЕДЁТ.
//
// Инспекция v3.12.0 прошла все экраны русским интерфейсом и собрала английские
// строки, которых нет в словаре: tr() возвращает незнакомую строку как есть, и
// посреди русского экрана стоит «Take payment», «Page 1 of 2338 · 70120
// patients», «Tax / registration ID». i18n-coverage.test.mjs ловит ТОЛЬКО
// русские литералы без перевода; этот тест — обратную сторону для экранов,
// которые правила инспекция: английский литерал в подписи, подсказке, тосте
// или тексте элемента обязан быть ключом словаря (или стать русским исходником).
//
// Регулярные выражения — те же, что у сканера инспекции
// (inspect-output/i18n/english-literals.mjs), чтобы «зелёный» здесь значил
// «чисто» и там.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = path.resolve(HERE, '..');

// Экран → (необязательно) вырезаемый кусок: печатная функция visit-modal.js
// принадлежит печатным бланкам (их язык — решение бланка, а не экрана).
const FILES = {
  'access-denied.js': null,
  'views/patient-documents.js': null,
  'views/visit-bill.js': null,
  'views/section-crud.js': null,
  'views/employees.js': null,
  'views/patients.js': null,
  'views/patients-hub.js': null,
  'views/patient-card.js': null,
  'views/patient-create-modal.js': null,
  'views/procedures.js': null,
  'views/doctor-profile.js': null,
  'views/service-editor.js': null,
  'views/system-subscription.js': null,
  'views/visit-modal.js': ['function openInvoicePrintWindow(', 'function invoicePane('],
};

const RX = [
  /toast\(\s*(['"`])([A-Z][A-Za-z][^'"`]{2,160})\1/g,
  /\b(?:title|placeholder|'aria-label'|label|subtitle|textContent)\s*[:=]\s*(['"`])([A-Z][a-z][^'"`\n]{3,160})\1/g,
  /\bh\(\s*'[a-z0-9]+'\s*,\s*(?:null|\{[^{}]*\})\s*,\s*(['"`])([A-Z][a-z][^'"`\n]{3,160})\1/g,
];

test('экраны, которые правила инспекция v3.12.0, не несут английского текста мимо словаря', () => {
  const bad = [];
  for (const [rel, cut] of Object.entries(FILES)) {
    let src = fs.readFileSync(path.join(ADMIN, ...rel.split('/')), 'utf8');
    if (cut) {
      const a = src.indexOf(cut[0]); const b = src.indexOf(cut[1]);
      assert.ok(a > 0 && b > a, rel + ': не найден вырезаемый кусок — тест проверяет не то');
      src = src.slice(0, a) + src.slice(b);
    }
    const lines = src.split('\n');
    for (const rx of RX) {
      rx.lastIndex = 0; let m;
      while ((m = rx.exec(src))) {
        const s = m[2];
        if (!/ /.test(s) && s.length < 12) continue;
        if (/^[A-Z][a-zA-Z]+$/.test(s)) continue;
        if (STRINGS[s] || STRINGS[s.trim()]) continue;
        const ln = src.slice(0, m.index).split('\n').length;
        if (/console\.|\/\/|i18n-exempt/.test(lines[ln - 1].split(m[0])[0])) continue;
        bad.push(rel + ':' + ln + '  ' + s);
      }
    }
  }
  assert.deepEqual(bad, [], 'английский текст без перевода:\n' + bad.join('\n'));
});

test('подписи групп переключателей — слова, а не служебные имена', () => {
  const src = fs.readFileSync(path.join(ADMIN, 'views', 'patient-create-modal.js'), 'utf8');
  assert.match(src, /'aria-label': tr\(label \|\| name\)/, 'radioChips снова читает служебное имя вслух');
  for (const call of src.match(/radioChips\('__residency',[\s\S]*?\)\)/g) || []) {
    assert.match(call, /label: 'Резидентство'/, 'у «Резидентства» нет подписи группы');
  }
  const card = fs.readFileSync(path.join(ADMIN, 'views', 'patient-card.js'), 'utf8');
  assert.match(card, /radioChips\('__edit_gender',[\s\S]{0,200}label: 'Пол'/, 'у «Пола» в карте нет подписи группы');
});

test('конструктор бланков «Документы»: подписи вариантов и цветов по-русски', () => {
  const src = fs.readFileSync(path.join(ADMIN, 'views', 'documents.js'), 'utf8');
  for (const en of ["'Modern'", "'Serif'", "'Compact'", "'Airy'", "'Rounded'", "'Sharp'", "'Tax / registration ID'",
                    "'Blue'", "'Violet'", "'Forest'", "'Ink'", "'Amber'", "'Crimson'", "'Pink'", "editorCard('Elements'"]) {
    assert.equal(src.includes(en), false, 'в конструкторе бланков осталось ' + en);
  }
  for (const ru of ['Современный', 'С засечками', 'Плотно', 'Обычно', 'Свободно', 'Скруглённые', 'Прямые', 'ИНН / регистрационный номер', 'Графит']) {
    assert.ok(STRINGS[ru] && STRINGS[ru].uz && STRINGS[ru].en, '«' + ru + '» без перевода');
  }
});
