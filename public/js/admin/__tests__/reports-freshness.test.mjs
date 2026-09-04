// BUILDING_FRESHNESS_V1 / PENDING_ITEMS_V1 — «видно, что данные ещё едут».
//
// Две беды одного корня, и обе молчали. Отчёты по зданиям держатся на
// невысказанном допущении, что записи соседа УЖЕ приехали; пока они в пути,
// каждый отчёт врёт по-своему: счёт «Оплачен · Оплачено 0» (статус едет, а
// paid_amount пересчитывается на месте), нули у выключенного здания, выручка
// меньше кассы (позиции счёта ждут неизвестного кода услуги). Ни одно из этих
// состояний экран не называл.
//
// Правило «это хорошая новость или плохая» проверяется НА ЧИСТОМ МОДУЛЕ
// (report-buildings.js): страница целиком без DOM не поднимается. Связка «что
// экран запрашивает и что он с этим делает» — исходным текстом, как в
// reports-hub-buildings.test.mjs рядом.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  freshnessState, freshnessAgeHours, freshnessWorthShowing, FRESHNESS_STALE_HOURS,
} from '../views/report-buildings.js';
import { STRINGS } from '../i18n-strings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

const NOW = Date.parse('2026-09-04T12:00:00Z');
const hoursAgo = (n) => new Date(NOW - n * 3600000).toISOString();

// Здание «всё хорошо»: слышали час назад, ничего не ждёт и не отвергнуто.
const fresh = (over = {}) => ({
  key: 'B', label: 'Чиланзар', own: false, linked: true,
  last_received: hoursAgo(1), pending: 0, refused: 0, seeding: false, seed_page: null,
  ...over,
});

test('состояние здания: худшая новость занимает единственную строку', () => {
  assert.equal(freshnessState(fresh(), NOW), 'ok');
  assert.equal(freshnessState(fresh({ own: true }), NOW), 'own', 'своё здание себе ничего не присылает');
  assert.equal(freshnessState(fresh({ last_received: null }), NOW), 'never',
    'связи не было ни разу — ноль напротив этого здания не значит «там не работали»');
  assert.equal(freshnessState(fresh({ refused: 3 }), NOW), 'refused',
    'непринятая запись сама собой не приедет НИКОГДА — это главная новость строки');
  assert.equal(freshnessState(fresh({ seeding: true, pending: 5 }), NOW), 'seeding',
    'первичная загрузка объясняет и ожидания, и неполные цифры');
  assert.equal(freshnessState(fresh({ pending: 2 }), NOW), 'pending');
  assert.equal(freshnessState(fresh({ last_received: hoursAgo(FRESHNESS_STALE_HOURS + 1) }), NOW), 'stale');
  assert.equal(freshnessState(fresh({ last_received: hoursAgo(FRESHNESS_STALE_HOURS - 1) }), NOW), 'ok',
    'сеанс связи идёт раз в час, поэтому «давно» — это сутки, а не минуты');
});

test('возраст данных: испорченная метка не выдаётся за «сейчас»', () => {
  assert.equal(Math.round(freshnessAgeHours(fresh({ last_received: hoursAgo(5) }), NOW)), 5);
  assert.equal(freshnessAgeHours(fresh({ last_received: null }), NOW), null);
  assert.equal(freshnessAgeHours(fresh({ last_received: 'вчера' }), NOW), null);
});

test('клинике в одном здании полоса не показывается вовсе', () => {
  assert.equal(freshnessWorthShowing({ buildings: [{ own: true }] }), false);
  assert.equal(freshnessWorthShowing({ buildings: [{ own: true }, { own: false }] }), true);
  assert.equal(freshnessWorthShowing(null), false, 'не загрузилось — не показываем, а не падаем');
});

test('экран берёт свежесть у сервера и рисует её на странице «Отчёты»', () => {
  assert.match(hub, /supabase\.rpc\('report_freshness'/, 'источник — read-only RPC, а не /api/db');
  assert.match(hub, /function paintFreshness\(/);
  assert.match(hub, /freshnessWorthShowing\(data\)/, 'одно здание — полосы нет');
  assert.match(hub, /freshnessState\(b, now\)/, 'состояние считает чистый модуль, а не экран');
});

test('недоехавшие позиции: отдельная строка и отдельная метка в разрезе зданий', () => {
  assert.match(hub, /data\.pending_items/, 'экран читает недостачу из ответа сервера');
  assert.match(hub, /pending\.invoices > 0 && pending\.note/,
    'строка появляется, только когда есть о чём сказать');
  assert.match(hub, /trf\('ещё едет: \{amount\}'/,
    'в полосе зданий недостача стоит РЯДОМ с итогом, а не внутри него');
});

test('плитки кассы называют свой охват', () => {
  assert.match(hub, /multi \? tr\('Доход по всем зданиям'\) : tr\('Общий доход'\)/);
  assert.match(hub, /multi \? tr\('Итого по этому зданию \(доход − расход\)'\) : tr\('Итого \(доход − расход\)'\)/,
    'итог по этому зданию нельзя называть «итого» рядом с доходом двух домов');
});

// Отдельно от i18n-coverage.test.mjs: тот проверяет, что литерал ЕСТЬ в
// словаре, а это — что фразы свежести именно те, которые рисует экран, и что у
// каждой сохранены её {дырки} во всех трёх языках (потерянная дырка молча
// проглатывает значение ровно в одном языке).
test('фразы свежести переводятся целиком, вместе со своими дырками', () => {
  const keys = [
    'Свежесть данных по зданиям',
    'Это здание — записи создаются здесь',
    'Данных от этого здания ещё не приходило · ждут: {pending} · не приняты: {refused}',
    'База не приняла записи: {refused} · последние данные: {when} · ждут: {pending}',
    'Идёт первичная загрузка, страница {page} · ждут: {pending}',
    'Данные не приходили с {when} · ждут: {pending} · не приняты: {refused}',
    'Последние данные: {when} · ждут: {pending} · не приняты: {refused}',
    'ещё едет: {amount}',
    'Доход по всем зданиям',
    'Доход этого здания',
    'Расход этого здания',
    'Итого по этому зданию (доход − расход)',
  ];
  for (const key of keys) {
    assert.ok(hub.includes(key), 'фраза «' + key + '» действительно рисуется экраном');
    const entry = STRINGS[key];
    assert.ok(entry, 'фраза «' + key + '» есть в словаре');
    const holes = (key.match(/\{[a-z]+\}/g) || []).sort();
    for (const lang of ['ru', 'uz', 'en']) {
      assert.ok(entry[lang], key + ': нет перевода на ' + lang);
      assert.deepEqual((entry[lang].match(/\{[a-z]+\}/g) || []).sort(), holes,
        key + ': в переводе на ' + lang + ' потеряна подстановка');
    }
  }
});
