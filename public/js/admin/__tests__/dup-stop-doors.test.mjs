// DUP_STOP_V1 (2026-11-02) — калькулятор услуг и «Услуги приёма» кабинета врача спрашивают
// «уже назначено» ДО записи. Исходником, как соседние пины (service-workspace-add.test.mjs):
// у окон нет DOM-стенда; поведение помощника — dup-order-check.test.mjs, мастер —
// dup-stop-wizard.test.mjs, быстрая регистрация — booked-rows-live.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', 'views', f), 'utf8');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

test('DUP_STOP_V1: калькулятор — проверка повтора до calendar_book; строки уходят с причиной обхода', () => {
  const src = code(read('service-picker-modal.js'));
  const pre = src.indexOf('await precheckOrders(');
  const book = src.indexOf('await calendarBookOrAsk({');
  assert.ok(pre > 0, 'калькулятор не спрашивает «уже назначено»');
  assert.ok(book > pre, 'проверка повтора — после записи визита: отказ оставит визит');
  assert.match(src.slice(pre, book), /if \(!pre\.ok\)[\s\S]*return;/, 'отказ не останавливает запись');
  assert.match(src, /insertRow\('visit_services', withRepeatReason\(\{/, 'строка без причины обхода');
  assert.match(src, /\}, pre\.reason\)\);/);
});

test('DUP_STOP_V1: «Услуги приёма» — каталог гасит и назначенное в визите другими', () => {
  const src = read('service-workspace.js');
  const card = src.match(/function servicesCard\(ctx\)[\s\S]*?\n\}/);
  assert.ok(card, 'карточка «Услуги приёма» не найдена');
  const c = code(card[0]);
  assert.match(c, /await loadVisitOrders\(\{ visitId: ctx\.visitId \}\)/, 'каталог не спрашивает, что уже назначено в визите');
  assert.match(c, /excludeServiceIds:[^\n]*serviceId[^\n]*blockedPickIds\(ordered\)/, 'каталог гасит только пункты карточки');
});

test('DUP_STOP_V1: быстрая регистрация — проверка повтора до ensure_visit', () => {
  const src = code(read('walk-in-booking.js'));
  const fn = src.slice(src.indexOf('export async function registerWalkIn('));
  const pre = fn.indexOf('await precheckOrders(');
  const ev = fn.indexOf("supabase.rpc('ensure_visit'");
  assert.ok(pre > 0 && ev > pre, 'проверка повтора — после визита дня');
  assert.match(fn, /withRepeatReason\(row, pre\.reason\)/, 'строка без причины обхода');
});
