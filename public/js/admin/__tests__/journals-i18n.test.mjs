// JOURNALS_V1 — каждая фраза журналов в словаре РОВНО ОДИН РАЗ и на трёх языках.
//
// Ключ, вписанный в STRINGS второй раз, молча перекрывает первый (поздний
// побеждает в объектном литерале) — и ломает чужой экран. Поэтому кроме
// полноты здесь считается, сколько раз ключ стоит в исходнике словаря.
// Каждая задача плана дописывает свои фразы в KEYS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n-strings.js'), 'utf8');
const LINES = SRC.split('\n').map((l) => l.trimStart());
const count = (k) => LINES.filter((l) => l.startsWith(JSON.stringify(k) + ':')).length;

const KEYS = [
  // Задача 3 — группа «Журналы» в «Настройки → Роли»
  'Журналы',
  'Журнал услуг (УЗИ, ЭКГ и любые выбранные) и реестр стационарных пациентов: диагнозы, заключения, паспортные данные, телефоны и оплаты пациентов.',
];

test('фразы журналов — в словаре ровно один раз, ru/uz/en заполнены', () => {
  for (const k of KEYS) {
    assert.equal(count(k), 1, 'ключ «' + k.slice(0, 60) + '» стоит в словаре ' + count(k) + ' раз(а)');
    for (const l of ['ru', 'uz', 'en']) assert.ok(STRINGS[k] && String(STRINGS[k][l] || '').trim(), k.slice(0, 60) + ' — нет ' + l);
    assert.equal(STRINGS[k].ru, k);
  }
});
