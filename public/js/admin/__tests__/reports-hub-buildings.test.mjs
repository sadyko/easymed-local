// BUILDING_REPORTS_V1 — выборка ЗДАНИЙ в конструкторе «Отчётов».
//
// Одна ошибка, ради которой всё это написано: выборка филиалов грузилась с
// `.eq('active', 1)`, а соседнее ЗДАНИЕ заводится приёмом справочника ИМЕННО
// как `active = 0` (branch-sync/catalogue.js: «строка заводится, чтобы была
// ИЗВЕСТНА БУКВА соседа»). То есть экран не мог даже НАЗВАТЬ второе здание —
// не то что посчитать его. Список зданий поэтому приходит от RPC
// report_buildings, а не из /api/db: реестр не отдаёт браузеру branches.letter.
//
// Тест — исходный, как у reports-hub-callcenter.test.mjs рядом: страница
// целиком без DOM не поднимается, а связку «откуда список» и «что уезжает в
// RPC» проверять надо.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildingOptions } from '../views/report-buildings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

test('список зданий берётся у сервера, а не из выборки филиалов с active = 1', () => {
  assert.match(hub, /supabase\.rpc\('report_buildings'/, 'перечень зданий — от report_buildings');
  // Прежняя выборка филиалов остаётся: у клиники, которая правда ведёт филиалы
  // внутри одной базы, она продолжает работать. Это ОРТОГОНАЛЬНОЕ измерение.
  assert.match(hub, /from\('branches'\)[\s\S]{0,80}eq\('active', 1\)/, 'выборка филиалов внутри базы жива');
});

test('показывается одна выборка: здания, когда их больше одного', () => {
  assert.match(hub, /const byBuildings = \(\) => st\.buildings\.length > 1;/);
  assert.match(hub, /pickerLabel\.textContent = byBuildings\(\) \? tr\('Здания'\) : tr\('Филиалы'\)/,
    'заголовок меняется вместе с выборкой — две почти одинаковые шкалы рядом читались бы как одна сломанная');
});

test('в RPC уезжает СОБСТВЕННОЕ подмножество зданий; «выбраны все» = фильтра нет', () => {
  const i = hub.indexOf('args.buildings =');
  assert.ok(i > -1, 'здания уезжают в RPC');
  const frag = hub.slice(i, i + 200);
  assert.match(frag, /st\.buildingKeys\.size && st\.buildingKeys\.size < st\.buildings\.length/,
    '«ничего не выбрано» и «выбрано всё» не должны означать «ничего не показывать»');
});

test('разрез по зданиям и примечания рисуются над таблицей', () => {
  assert.match(hub, /function paintBuildingSummary\(/);
  assert.match(hub, /paintBuildingSummary\(previewEl, st\.result\)/, 'и у таблиц, и у графиков');
  assert.match(hub, /if \(list\.length > 1\)/, 'клинике в одном здании полоса не нужна');
});

// Поведение самого перечня — на чистом модуле: сосед active = 0 обязан быть в
// списке, иначе выбрать его нечем.
test('перечень называет соседа, заведённого как active = 0', () => {
  const list = buildingOptions({
    branches: [{ name: 'Главный корпус', letter: 'A', active: 1 }, { name: 'Чиланзар', letter: 'B', active: 0 }],
    ownLetter: 'A',
  });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[1].label === undefined ? list[1].name : list[1].label, 'Чиланзар');
});
