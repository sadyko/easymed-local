// REFBILL_REVIEW_V1 (проверка ревью, 2026-09-29) — ОТМЕНЁННАЯ СТРОКА В СЧЁТ НЕ ИДЁТ.
//
// После 3729509 сервер отказывает в счёте за строку со статусом «cancelled» —
// любой роли. Окно визита и окно «Счёт и оплата» по-прежнему отправляли ВСЕ
// невыставленные строки, и одна отменённая строка (старые данные, прямой
// запрос) роняла весь счёт: «Услуга №2 отменена — в счёт её не ставят.».
// Оба окна теперь сами не берут отменённые строки в счёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Крошечный DOM — ровно столько, чтобы модуль окна загрузился.
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.dataset = {}; this._l = {}; this._t = ''; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
}
globalThis.Node = F;
globalThis.document = globalThis.document || {
  createElement: (t) => new F(t), createElementNS: (_n, t) => new F(t), createTextNode: (t) => { const n = new F('#text'); n._t = String(t); return n; },
  head: new F('head'), body: new F('body'), documentElement: new F('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, location: { hash: '' } };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { defaultInvoiceSelection } = await import('../views/visit-modal.js');

test('окно визита: отменённая строка не отмечается для счёта сама', () => {
  const sel = defaultInvoiceSelection([
    { id: 1, status: 'queued', invoice_item_id: null },
    { id: 2, status: 'cancelled', invoice_item_id: null },
    { id: 3, status: 'queued', invoice_item_id: 77 },
    { id: 4, status: 'queued', invoice_item_id: null, __refunded: true },
  ]);
  assert.deepEqual([...sel], [1]);
});

test('окно визита и «Счёт и оплата»: отменённая строка не уходит в счёт даже выбранной', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const modal = fs.readFileSync(path.join(HERE, '..', 'views', 'visit-modal.js'), 'utf8');
  const bill = fs.readFileSync(path.join(HERE, '..', 'views', 'visit-bill.js'), 'utf8');
  assert.match(modal, /selectedIds\.has\(r\.id\) && !r\.invoice_item_id && r\.status !== 'cancelled'/,
    'generateInvoiceFromSelection отправляет отменённую строку — сервер уронит весь счёт');
  assert.match(bill, /r\.invoice_item_id == null && r\.status !== 'cancelled'/,
    '«Выставить счёт» в окне «Счёт и оплата» берёт отменённую строку — сервер уронит весь счёт');
});
