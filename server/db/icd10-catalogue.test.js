// ICD10_CATALOGUE_V1 (2026-09-05) — СПРАВОЧНИК МКБ-10 ДЕЙСТВИТЕЛЬНО ЕСТЬ.
//
// Владелец: «we need to add a icd codes».
//
// Таблица icd10 стояла в схеме с миграции 027 и была пуста во ВСЕХ клиниках.
// Окно выбора диагноза обещало «в справочнике 14 000 кодов», получало ноль
// строк и молча падало на запасной список из двенадцати примеров, зашитый в
// service-workspace.js. Пустая таблица и «поиск не работает» выглядят на
// экране одинаково, поэтому здесь проверяется не «запрос компилируется», а
// СОДЕРЖИМОЕ: сколько рубрик, что у них есть родитель, и находится ли
// конкретный диагноз по русскому слову.
//
// Источник — официальная выгрузка Минздрава РФ (OID 1.2.643.5.1.13.13.11.1005,
// версия 2.27). Числа ниже — из неё; они закреплены с запасом вниз, чтобы тест
// ловил «справочник не загрузился», а не спорил с очередной версией выгрузки.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('справочник МКБ-10 загружен: тысячи рубрик, а не двенадцать примеров', (t) => {
  const db = fresh();
  t.after(() => db.close());

  const total = db.prepare('SELECT COUNT(*) c FROM icd10').get().c;
  assert.ok(total > 14000, 'в справочнике всего ' + total + ' строк — выгрузка не приехала');

  const byKind = Object.fromEntries(
    db.prepare('SELECT kind, COUNT(*) c FROM icd10 GROUP BY kind').all().map((r) => [r.kind, r.c]));
  assert.ok(byKind.category > 2000, 'трёхзначных рубрик: ' + byKind.category);
  assert.ok(byKind.sub > 12000, 'четырёхзначных подрубрик: ' + byKind.sub);
  assert.equal(byKind.chapter, 22, 'классов болезней в МКБ-10 ровно 22');
  assert.ok(byKind.block > 200, 'блоков рубрик: ' + byKind.block);
});

test('иерархия связная: у каждой подрубрики есть существующий родитель', (t) => {
  const db = fresh();
  t.after(() => db.close());

  const orphans = db.prepare(`
    SELECT COUNT(*) c FROM icd10 child
    WHERE child.kind = 'sub'
      AND (child.parent_code IS NULL
           OR NOT EXISTS (SELECT 1 FROM icd10 p WHERE p.code = child.parent_code))`).get().c;
  assert.equal(orphans, 0, 'подрубрик без родителя: ' + orphans + ' — листать справочник нечем');

  const cholera = db.prepare("SELECT code, name, parent_code, kind FROM icd10 WHERE code = 'A00.0'").get();
  assert.equal(cholera.kind, 'sub');
  assert.equal(cholera.parent_code, 'A00');
  assert.match(cholera.name, /Холера/);
});

test('диагноз находится по русскому слову — так его и ищет врач', (t) => {
  const db = fresh();
  t.after(() => db.close());

  const found = db.prepare(`
    SELECT code FROM icd10
    WHERE kind IN ('category','sub') AND active = 1 AND name LIKE '%сахарный диабет%'`).all()
    .map((r) => r.code);
  assert.ok(found.length > 10, 'по «сахарный диабет» нашлось ' + found.length + ' кодов');
  assert.ok(found.includes('E11.9'), 'E11.9 (диабет 2 типа без осложнений) — самый частый в поликлинике');

  const byCode = db.prepare("SELECT name FROM icd10 WHERE code = 'J06.9'").get();
  assert.match(byCode.name, /дыхательных путей/, 'поиск по коду тоже обязан отвечать названием');
});

test('разделы классификации не выдаются за диагнозы', (t) => {
  const db = fresh();
  t.after(() => db.close());

  // «A00-A09» — блок рубрик, «I» — класс болезней. Поставить их пациенту
  // нельзя: таких диагнозов не существует. Они лежат в таблице ради листания,
  // и окно диагноза обязано отбирать по kind, а не показывать всё подряд.
  const block = db.prepare("SELECT kind FROM icd10 WHERE code = 'A00-A09'").get();
  assert.equal(block.kind, 'block');
  const chapter = db.prepare("SELECT kind FROM icd10 WHERE code = 'I'").get();
  assert.equal(chapter.kind, 'chapter');

  // Диагноз — это буква и две цифры (I10 — гипертензия, буква тут законная),
  // с необязательной точкой и уточнением. Диапазон «A00-A09» и римская «I»
  // под это не подходят — по форме кода и отличаем.
  const shape = db.prepare(`
    SELECT code FROM icd10
    WHERE kind IN ('category','sub')
      AND (code LIKE '%-%' OR NOT code GLOB '[A-Z][0-9][0-9]*')
    LIMIT 5`).all().map((r) => r.code);
  assert.deepEqual(shape, [], 'в выдаче диагнозов оказались разделы: ' + shape.join(', '));
});

test('коды не повторяются: уникальный индекс на месте', (t) => {
  const db = fresh();
  t.after(() => db.close());

  const dup = db.prepare('SELECT code, COUNT(*) c FROM icd10 GROUP BY code HAVING c > 1').all();
  assert.deepEqual(dup, [], 'повторяющиеся коды: ' + JSON.stringify(dup.slice(0, 5)));

  // Клиника, успевшая завести свой код руками, переживает обновление: вставка
  // идёт INSERT OR IGNORE, и совпадение по коду её строку не затирает.
  db.prepare("UPDATE icd10 SET name = 'Своё название клиники' WHERE code = 'A00'").run();
  assert.throws(() => db.prepare("INSERT INTO icd10 (code, name) VALUES ('A00', 'дубль')").run(),
    /UNIQUE/, 'второй такой же код обязан отвергаться базой');
});
