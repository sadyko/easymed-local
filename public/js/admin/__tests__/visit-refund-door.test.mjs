// REFUND_ANY_V1 (2026-10-29) — ВОЗВРАТ ИЗ ОКНА ВИЗИТА — ТО ЖЕ ОКНО «ПЛАТЕЖИ», ЧТО У КАССЫ.
//
// Окно визита (visit-modal.js) возвращало только последний счёт и только
// целиком («Cancel & refund» → отмена с возвратом всех денег). Теперь по счёту с
// деньгами — «Возврат»: окно «Платежи» кассы (cashier-desk.js
// openInvoiceRefundById) — вернуть услугу, вернуть оплату, «Оставить услугу в
// визите»; после возврата перечитывается окно визита (onDone). Другие счета
// визита с деньгами — списком, у каждого — «Платежи». Неоплаченный счёт
// отменяется, как прежде.
//
// Проверка — исходником, как соседние пины (own-shelf-picker-v3120,
// booking-doors). Поведение — настоящим окном визита на заглушке документа:
// visit-refund-window.test.mjs (окно визита переживает возврат и перечитывается
// один раз, вместе с вкладкой «Услуги»; двойной щелчок; сбои); окно «Платежи»
// с onDone — cashier-refund-any.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VM = fs.readFileSync(path.join(HERE, '..', 'views', 'visit-modal.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(HERE, '..', '..', 'admin.js'), 'utf8');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

test('окно визита открывает окно «Платежи» кассы тем же экземпляром модуля (штамп admin.js) и с onDone', () => {
  const stamp = (ADMIN.match(/views\/cashier-desk\.js\?v=([\w-]+)'/) || [])[1];
  assert.ok(stamp, 'штамп кассы в admin.js не найден');
  const m = code(VM).match(/import\('\.\/cashier-desk\.js(?:\?v=([\w-]+))?'\)/);
  assert.ok(m, 'окно визита не подгружает кассу в момент действия');
  assert.equal(m[1], stamp, 'другой штамп — второй экземпляр модуля кассы');
  assert.match(code(VM), /mod\.openInvoiceRefundById\(invoiceId, \{ onDone: onReload \}\)/);
});

test('оплаченный счёт: «Возврат» — окно кассы; отмена целиком — только у счёта без денег', () => {
  const pane = code(VM).match(/function invoicePane\(state, onReload\)[\s\S]*?\n\}/);
  assert.ok(pane, 'invoicePane не найден');
  // Ревью B5, п. 5 — «Возврат» у любого счёта с деньгами, и у старого отменённого.
  assert.match(pane[0], /moneyHands && paid > 0 && h\('button',[\s\S]*?openCashierPayments\(inv\.id, onReload\)/, 'у счёта с деньгами нет «Возврат» в окно кассы');
  assert.match(pane[0], /cancellable && !\(paid > 0\) && h\('button',[\s\S]*?openCancelInvoiceDialog\(inv, \{ onDone: onReload \}\)/, 'неоплаченный счёт больше не отменяется');
  assert.ok(!/Cancel & refund/.test(pane[0]), '«Cancel & refund» снова ведёт к отмене целиком');
  assert.match(pane[0], /moneyHands \? otherInvoicesBlock\(state, inv, onReload\) : null/, 'другие счета визита не показаны');
});

test('окно визита знает все счета визита, а не только последний', () => {
  const load = code(VM).match(/async function loadInvoice\(state\)[\s\S]*?\n\}/);
  assert.ok(load, 'loadInvoice не найден');
  // Ревью B5, п. 4 — счета одной секунды идут по номеру: новейший — первым.
  assert.match(load[0], /\.order\('created_at', \{ ascending: false \}\)\.order\('id', \{ ascending: false \}\)\.limit\(20\)/);
  assert.match(load[0], /state\.invoices = data \|\| \[\];/);
  assert.match(load[0], /state\.invoice = state\.invoices\[0\] \|\| null;/);
});

test('строки окна визита — в словаре на трёх языках, uz/en без кириллицы', () => {
  for (const key of ['Другие счета визита', 'Не удалось открыть платежи: {msg}', 'Платежи', 'Возврат']) {
    const e = STRINGS[key];
    assert.ok(e, 'нет ключа словаря: ' + key);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang], key + ': нет перевода ' + lang);
      assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': кириллица в ' + lang);
    }
  }
});

test('ревью B5, п. 6: слова отмены целиком с возвратом ушли из окна визита — и из словаря', () => {
  for (const key of ['Cancel & refund', 'Cancel & refund the paid amount', 'Cancel invoice and refund the paid amount']) {
    assert.equal(STRINGS[key], undefined, 'в словаре остался неиспользуемый ключ: ' + key);
    assert.ok(!VM.includes(key), 'окно визита снова говорит: ' + key);
  }
});
