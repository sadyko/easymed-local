// CASHIER_REPORT_AMOUNT_COL_V1 — колонка «Сумма» в отчёте кассы ищется ПО ИМЕНИ.
//
// Ошибка, ради которой это написано: с 2026-09-04 (c2497c86c, отчёты по всем
// зданиям) сервер ставит «Здание» первой колонкой, и «Сумма» в поступлениях
// стала седьмой (индекс 6), в расходах — пятой (индекс 4). Экран же хранил
// номера 5 и 3 с прежних времён. Итог: «Способ оплаты» форматировался как
// деньги и печатался «не число» (так ru-RU выводит NaN), «Сумма» шла без
// разрядов, а «Итого» над таблицей складывало NaN и показывало 0 UZS при
// 1 695 000 в плитках (снимок владельца 2026-11-07). В расходах то же самое
// ждало первой строки.
//
// Тест — по исходнику, как reports-hub-buildings.test.mjs рядом: страница без
// DOM не поднимается, а связка «какую колонку считать деньгами» проверяться
// обязана — она уже один раз молча разошлась с сервером.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');
const rpc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'rpc', 'cashier-report.js'), 'utf8');

// Списки колонок — те самые, что сервер отдаёт экрану (cashier-report.js).
function serverColumns(name) {
  const at = rpc.indexOf('const ' + name + ' = [');
  assert.ok(at > -1, 'в cashier-report.js есть ' + name);
  const open = rpc.indexOf('[', at);
  const close = rpc.indexOf(']', open);
  return rpc.slice(open + 1, close).split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('сервер: «Сумма» есть ровно один раз в обеих таблицах — по ней экран и находит деньги', () => {
  for (const name of ['incomeColumns', 'expenseColumns']) {
    const cols = serverColumns(name);
    assert.equal(cols.filter((c) => c === 'Сумма').length, 1, name);
  }
  // Документируем сам промах: пятая колонка поступлений — способ оплаты.
  assert.equal(serverColumns('incomeColumns')[5], 'Способ оплаты');
});

test('экран: колонка денег берётся по имени «Сумма», а не по номеру', () => {
  assert.doesNotMatch(hub, /numericCol: \d/,
    'номер колонки, записанный вручную, уже один раз разошёлся с сервером и разойдётся снова');
  assert.match(hub, /rows: d\.income\.rows, numericCol: d\.income\.columns\.indexOf\('Сумма'\)/);
  assert.match(hub, /rows: d\.expense\.rows, numericCol: d\.expense\.columns\.indexOf\('Сумма'\)/);
});
