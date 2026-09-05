import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';
import {
  scopeQuery, normalizeLabScope, ownBuildingOnly,
  LAB_SCOPE_CLINIC, LAB_SCOPE_BUILDING, LAB_SCOPE_DEFAULT,
} from './lab-scope.js';

// LAB_ONE_CLINIC_V1 (2026-09-03) — одна лаборатория на всю клинику.
//
// Владелец: «the lab can be one single so whenever clinic registrates the
// patient the all clinics laborants should see the list of the patients and
// enter the data.» До этого очередь и история «Готово» были заперты в своём
// здании жёстким `.is('sync_origin', null)`.
//
// Проверяется здесь ровно то, из-за чего эта настройка может тихо не работать:
// значение по умолчанию (владелец просил «включено»), приведение мусора и —
// главное — что фильтр попадает В ЗАПРОС, а не накладывается на уже полученные
// строки. Второе не косметика: у очереди есть .limit(5000), и отсев после
// выборки означал бы, что лимит съеден чужими строками, а своя работа не
// доехала.

// -----------------------------------------------------------------------------
// Значения
// -----------------------------------------------------------------------------

test('по умолчанию лаборатория обслуживает ВСЮ КЛИНИКУ', () => {
  assert.equal(LAB_SCOPE_DEFAULT, LAB_SCOPE_CLINIC);
  assert.equal(normalizeLabScope(undefined), LAB_SCOPE_CLINIC);
  assert.equal(normalizeLabScope(null), LAB_SCOPE_CLINIC, 'старая база без колонки — не повод спрятать работу');
  assert.equal(normalizeLabScope(''), LAB_SCOPE_CLINIC);
  assert.equal(normalizeLabScope('branch'), LAB_SCOPE_CLINIC, 'опечатка не должна превращаться в третье поведение');
  assert.equal(ownBuildingOnly(undefined), false);
});

test('«только своё здание» надо выбрать явно', () => {
  assert.equal(normalizeLabScope(LAB_SCOPE_BUILDING), LAB_SCOPE_BUILDING);
  assert.equal(ownBuildingOnly(LAB_SCOPE_BUILDING), true);
  assert.equal(ownBuildingOnly(LAB_SCOPE_CLINIC), false);
});

// -----------------------------------------------------------------------------
// Фильтр запроса
// -----------------------------------------------------------------------------

/** Построитель-двойник: запоминает, звали ли .is() и с чем. */
function fakeQuery() {
  const calls = [];
  const qb = { calls, is(col, val) { calls.push([col, val]); return qb; } };
  return qb;
}

test('«всю клинику» — запрос уходит БЕЗ границы по филиалу', () => {
  const qb = fakeQuery();
  const out = scopeQuery(qb, LAB_SCOPE_CLINIC);
  assert.equal(out, qb, 'цепочка запроса не должна рваться');
  assert.deepEqual(qb.calls, [], 'ни одного фильтра происхождения — иначе чужие пробирки снова исчезнут');
});

test('«только своё здание» — тот самый фильтр, что стоял в очереди раньше', () => {
  const qb = fakeQuery();
  const out = scopeQuery(qb, LAB_SCOPE_BUILDING);
  assert.equal(out, qb);
  assert.deepEqual(qb.calls, [['sync_origin', null]]);
});

test('неизвестное значение фильтр не ставит — очередь не пустеет молча', () => {
  for (const junk of [null, undefined, '', 'BUILDING', 0, {}]) {
    const qb = fakeQuery();
    scopeQuery(qb, junk);
    assert.deepEqual(qb.calls, [], 'значение ' + JSON.stringify(junk));
  }
});

// -----------------------------------------------------------------------------
// Экран: граница накладывается ОДНИМ способом, и только в лаборатории
// -----------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const labSrc = fs.readFileSync(path.join(HERE, 'laboratory.js'), 'utf8');

test('в laboratory.js не осталось ни одного жёсткого фильтра происхождения', () => {
  const code = labSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(/\.is\(\s*'sync_origin'/.test(code), false,
    'граница задаётся настройкой через scopeQuery(), а не вписывается в запрос руками');
  // Оба запроса ОДНОГО списка — очередь и история «Готово» — идут через неё.
  assert.equal((code.match(/scopeQuery\(/g) || []).length, 2,
    'и очередь, и вкладка «Готово»: отфильтровать половину значило бы показать чужую работу в одной и спрятать в другой');
});

test('настройка читается из doc_settings и пишется туда же', () => {
  assert.ok(labSrc.includes("supabase.from('doc_settings').select('lab_scope')"),
    'значение приезжает из справочника клиники (миграция 085)');
  assert.ok(labSrc.includes("supabase.from('doc_settings').update({ lab_scope: scope })"),
    'переключатель сохраняет настройку клиники, а не местное состояние экрана');
  assert.ok(labSrc.includes('isAdminActor()'), 'переключатель — администратору; сервер требует того же');
});

test('пофилиальные экраны НЕ тронуты — решение владельца 2026-09-02 в силе', () => {
  const untouched = ['doctor-room.js', 'visits.js', 'requests-inbox.js', 'consultation.js'];
  for (const file of untouched) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.ok(/\.is\('sync_origin', null\)/.test(src),
      file + ': очередь врача и регистратура остаются своего здания');
    assert.equal(src.includes('lab-scope.js'), false,
      file + ': настройка лаборатории не должна распространяться на этот экран');
  }
  // PROC_PERFORMER_V1 — у процедур ПРАВИЛО ТО ЖЕ, но живёт оно теперь на
  // сервере. Очередь склеивает две таблицы (кабинетную visit_services и
  // палатную admission_services), а склеить их браузер не может, поэтому
  // фильтр происхождения переехал вместе со всем запросом. Проверяем его там,
  // где он стоит, а не там, где стоял.
  const procSrc = fs.readFileSync(path.join(HERE, 'procedures.js'), 'utf8');
  assert.ok(procSrc.includes("supabase.rpc('procedures_list'"),
    'procedures.js: очередь приходит одним серверным запросом');
  assert.equal(procSrc.includes('lab-scope.js'), false,
    'procedures.js: настройка лаборатории не должна распространяться на этот экран');
  const procRpc = fs.readFileSync(
    path.join(HERE, '..', '..', '..', '..', 'server', 'services', 'rpc', 'procedures.js'), 'utf8');
  assert.ok(/sync_origin IS NULL/.test(procRpc),
    'rpc/procedures.js: очередь процедур остаётся своего здания');
});

test('каждая строка переключателя есть в словаре на трёх языках', () => {
  const phrases = [
    'Лаборатория обслуживает',
    'Всю клинику',
    'Своё здание',
    'Лаборатория обслуживает всю клинику: в очереди — заказы всех филиалов',
    'Лаборатория обслуживает только своё здание: заказы соседних филиалов сюда не попадают',
    'Лаборатория обслуживает всю клинику',
    'Лаборатория обслуживает только своё здание',
    'Не удалось сохранить настройку: {msg}',
    'Филиал {letter}',
  ];
  for (const p of phrases) {
    assert.ok(labSrc.includes(p), 'строка исчезла с экрана — тест устарел: ' + p);
    const entry = STRINGS[p];
    assert.ok(entry, 'нет ключа словаря: ' + p);
    for (const lang of ['ru', 'uz', 'en']) {
      assert.equal(typeof entry[lang], 'string', p + ': нет перевода ' + lang);
      assert.notEqual(entry[lang].trim(), '', p + ': пустой перевод ' + lang);
    }
  }
});
