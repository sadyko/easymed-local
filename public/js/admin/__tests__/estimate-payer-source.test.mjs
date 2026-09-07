// PAYER_COMPANY_IN_ESTIMATE_V1 — проверки по ИСХОДНИКУ visit-wizard.js.
//
// Файл не импортируется тестами (supabase, иконки, весь экран), поэтому здесь
// закрепляется то, что видно в тексте: ряд компаний собран, снятие идёт через
// clearPayer (а не через setPayer('self'), который сбросил бы ТИП), и надпись
// «выберете на следующем шаге» не вернулась.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'visit-wizard.js'), 'utf8');

test('смета собирает ряд компаний', () => {
  assert.match(src, /companyRow/, 'ряд есть');
  assert.match(src, /splitCompanies|toggleCompanyId/, 'логика взята из payer-choice.js, а не написана заново');
  assert.match(src, /from '\.\/payer-choice\.js/, 'модуль импортирован');
});

// setPayer('self') зовёт setPayKind('self') и сбрасывает ТИП — ряд компаний
// схлопнулся бы целиком. Ровно эту ошибку тест и держит закрытой.
test('снятие отметки не сбрасывает тип плательщика', () => {
  assert.match(src, /function clearPayer\(\)/, 'отдельная функция снятия');
  const at = src.indexOf('function clearPayer()');
  const body = src.slice(at, at + 260);
  assert.doesNotMatch(body, /setPayKind/, 'clearPayer не трогает тип');
  assert.match(body, /payerId\s*=\s*'self'/);
});

test('надпись «выберете на шаге» не вернулась', () => {
  assert.doesNotMatch(src, /компанию выберете на шаге/, 'её место занял настоящий список');
});

// Комментарии в этом проекте — единственная запись о том, ПОЧЕМУ код такой.
// Развернуть решение и оставить прежний довод стоять = спор с призраком.
test('прежний маркер переписан, а не удалён молча', () => {
  assert.doesNotMatch(src, /ряд компаний из СМЕТЫ убран/, 'старая формулировка снята');
  assert.match(src, /PAYER_COMPANY_IN_ESTIMATE_V1/, 'новый маркер на месте');
  assert.match(src, /PAYER_COMPANY_ON_STEP2_V1/, 'и ссылка на отменённое решение сохранена');
});
