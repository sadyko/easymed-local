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

// Компания уже выбрана в смете — спрашивать её второй раз значит делать вид,
// что первый выбор не считался.
test('шаг «Кто платит» подтверждает выбор, а не спрашивает заново', () => {
  assert.match(src, /выбран в смете/, 'карточка подтверждения');
  assert.match(src, /payerPickerOpen/, 'состояние раскрытия сетки');
  assert.match(src, /'Сменить'|"Сменить"/, 'кнопка возврата к сетке');
});

// Счёт пациента и акт плательщика содержат ПРОТИВОПОЛОЖНЫЕ наборы услуг
// (COVERAGE_SPLIT_V1). Отдать акту готовый queueRows счёта значит напечатать
// на нём номера к услугам, которых в нём нет, и потерять номера к тем, что есть.
//
// И отбор идёт по строкам КОНКРЕТНОГО акта, а не по «всем покрытым»: актов
// печатается по одному на плательщика (цикл по aktJobs), и на акте «Cenergo»
// не должно быть номера к услуге, которую оплачивает другая организация.
test('акт получает очередь по СВОИМ услугам, а не по услугам счёта пациента', () => {
  const at = src.indexOf('function printAkt(');
  assert.notEqual(at, -1, 'printAkt на месте');
  const fn = src.slice(at, at + 2200);
  assert.match(fn, /\bqueue\b/, 'printAkt принимает и передаёт очередь');
  assert.match(src, /aktQueue/, 'очередь для акта собирается отдельно');
  const loopAt = src.indexOf('for (const job of aktJobs)');
  assert.notEqual(loopAt, -1, 'цикл по актам на месте');
  assert.match(src.slice(loopAt, loopAt + 600), /job\.lines/, 'отбор по строкам ЭТОГО акта, а не по общему набору');
});
