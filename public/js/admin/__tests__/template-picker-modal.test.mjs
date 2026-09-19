// TEMPLATE_PICKER_V1 (FAST_REG_ONE_SCREEN_V1, T2) — reusable «Пакеты» modal.
//
// template-picker-modal.js imports the REAL `supabase` client (../../supabase.js,
// same import the visit wizard uses), which is backed by fetch('/api/db', …) —
// not a fake supabase double passed in as an argument (listTemplates() itself
// takes a client, but the modal calls it with the module-level singleton, the
// way openTemplatePicker() does in visit-wizard.js). So the double here is a
// fake global fetch answering '/api/db' selects on 'service_templates', the
// same technique patient-create-modal.test.mjs uses for `patients` /
// `patient_categories`.
//
// Fake DOM is the minimal one from patient-create-modal.test.mjs (F/TX/mk),
// with one deliberate difference: `document.addEventListener/removeEventListener
// /dispatchEvent` are REAL (recording) here, not no-ops — the Esc-closes test
// needs a document-level 'keydown' dispatch to actually reach the modal's
// listener, the same way item-picker-modal.js binds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake DOM — modeled on patient-create-modal.test.mjs's F/TX/mk.
// ---------------------------------------------------------------------------
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener(t, fn) { const a = this._l[t]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); }
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector() { return null; } querySelectorAll() { return []; }
  get classList() { const s = this; return { contains: (c) => String(s.className || '').split(/\s+/).includes(c), add(c) { s.className = (s.className ? s.className + ' ' : '') + c; }, remove() {}, toggle() {} }; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const toastEl = mk('div');
const toasts = [];
Object.defineProperty(toastEl, 'textContent', { get() { return toastEl._t; }, set(v) { toastEl._t = String(v); toasts.push(String(v)); } });

const bodyEl = mk('body');
// Снятия окна считаются ПОИМЁННО: «закрыто» и «закрыто дважды» выглядят на
// экране одинаково, а разница между ними и есть предмет одной из проверок.
let bodyRemovals = 0;
const realBodyRemoveChild = bodyEl.removeChild.bind(bodyEl);
bodyEl.removeChild = (c) => { bodyRemovals++; return realBodyRemoveChild(c); };
const docListeners = {};
globalThis.document = {
  createElement: mk,
  createElementNS: (_n, t) => mk(t),
  createTextNode: (t) => new TX(t),
  head: mk('head'),
  body: bodyEl,
  documentElement: mk('html'),
  addEventListener(type, fn) { (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn) { const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  dispatchEvent(e) { for (const fn of (docListeners[e.type] || []).slice()) fn(e); return true; },
  getElementById: (id) => (id === 'toast' ? toastEl : null),
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

const fakeStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (fakeStore.has(k) ? fakeStore.get(k) : null),
  setItem: (k, v) => { fakeStore.set(k, String(v)); },
  removeItem: (k) => { fakeStore.delete(k); },
  clear: () => fakeStore.clear(),
};
// I18N_LOCALE_PIN_V1 — i18n.js picks a language ONCE at module load; pin it
// before anything imports i18n.js (transitively, via ui.js).
globalThis.localStorage.setItem('admin.lang', 'ru');

// --- fake transport ---------------------------------------------------------
// supabase.js -> db-client.js POSTs a {table, op, columns, filters, order}
// descriptor to '/api/db'. Only `service_templates` selects matter here.
let templateRows = [];
let templateError = null;
// Задержка ответа. Без неё окно, закрытое ПОКА пакеты грузятся, в тесте
// недостижимо вовсе: ответ приходит раньше, чем успеваешь нажать Esc.
let templateGate = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    if (table === 'service_templates') {
      if (templateGate) await templateGate;
      if (templateError) return { ok: false, status: 400, json: async () => ({ error: templateError }) };
      return ok({ data: JSON.parse(JSON.stringify(templateRows)), error: null, count: templateRows.length });
    }
    return ok({ data: [], error: null, count: 0 });
  }
  return ok({ data: null });
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const { openTemplatePickerModal } = await import('../views/template-picker-modal.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const dialogs = (name) => walk(bodyEl).filter((n) => n.attrs && n.attrs['data-dialog'] === name);
const escapeKeydown = () => document.dispatchEvent({ type: 'keydown', key: 'Escape' });

test('список пакетов рисуется с размером, клик по строке отдаёт шаблон и закрывает окно', async () => {
  toasts.length = 0;
  templateError = null;
  templateRows = [
    { id: 1, name: 'Первичный приём', service_ids: [1, 2, 3] },
    { id: 2, name: 'Общий анализ крови', service_ids: '[4]' },
  ];

  let picked = null;
  const dlg = openTemplatePickerModal({ onPick: (t) => { picked = t; } });
  assert.equal(dialogs('template-picker').length, 1, 'overlay mounted on document.body with data-dialog');

  await tick();

  const text = textOf(dlg.overlay);
  assert.match(text, /Первичный приём/);
  assert.match(text, /3 усл\./, 'три id -> «3 усл.»');
  assert.match(text, /Общий анализ крови/);
  assert.match(text, /1 усл\./, 'service_ids как JSON-строка "[4]" -> «1 усл.»');

  const rows = walk(dlg.overlay).filter((n) => n.tagName === 'BUTTON' && !n.classList.contains('modal-close'));
  assert.equal(rows.length, 2, 'ровно две строки-кнопки для выбора');
  rows[0].click();

  assert.ok(picked, 'onPick вызван');
  assert.equal(picked.id, 1);
  assert.equal(dialogs('template-picker').length, 0, 'окно снято с document.body после выбора');
});

test('пустой список — подсказка, ошибка — предупреждение', async () => {
  // Пустой список.
  templateError = null;
  templateRows = [];
  const dlgEmpty = openTemplatePickerModal({ onPick: () => {} });
  await tick();
  assert.match(textOf(dlgEmpty.overlay), /Пакетов пока нет/);
  dlgEmpty.close();

  // Ошибка.
  toasts.length = 0;
  templateError = { message: 'boom' };
  const dlgErr = openTemplatePickerModal({ onPick: () => {} });
  await tick();
  assert.equal(dialogs('template-picker').length, 0, 'окно закрыто после ошибки');
  assert.ok(toasts.some((t) => t.includes('boom')), 'тост с текстом ошибки: ' + JSON.stringify(toasts));
  templateError = null;
});

test('Esc закрывает без выбора', async () => {
  templateError = null;
  templateRows = [{ id: 9, name: 'Чек-ап', service_ids: [1] }];
  let pickedCalled = false;
  const dlg = openTemplatePickerModal({ onPick: () => { pickedCalled = true; } });
  await tick();
  assert.equal(dialogs('template-picker').length, 1);

  escapeKeydown();

  assert.equal(dialogs('template-picker').length, 0, 'окно снято по Esc');
  assert.equal(pickedCalled, false, 'onPick не вызван');
});

// ===========================================================================
// Окно закрыли, пока пакеты ещё грузились.
//
// Список пакетов спрашивается у сервера, и между вопросом и ответом окно можно
// закрыть — Esc, крестиком, кликом по подложке. Ответ от этого не исчезает: он
// приходит в УЖЕ ЗАКРЫТОЕ окно и продолжает работать так, будто оно на экране.
// Тогда отказ сервера выдаёт тост поверх того, что регистратор открыл вместо
// этого окна («Не удалось загрузить пакеты» посреди счёта), и закрывает окно
// ВТОРОЙ раз — а второе снятие в живом DOM уже не его, а того, что встало на
// его место. Ответ закрытому окну не принадлежит, и делать с ним нечего.
// ===========================================================================
test('окно закрыли, пока грузились пакеты: ответ приходит в пустоту — ни тоста, ни второго закрытия', async () => {
  templateError = null;
  templateRows = [{ id: 9, name: 'Чек-ап', service_ids: [1] }];
  toasts.length = 0;
  let release;
  templateGate = new Promise((r) => { release = r; });

  const removalsBefore = bodyRemovals;
  openTemplatePickerModal({ onPick: () => {} });
  assert.equal(dialogs('template-picker').length, 1, 'окно не открылось');

  // Закрыли ДО ответа.
  escapeKeydown();
  assert.equal(dialogs('template-picker').length, 0, 'Esc не снял окно');
  assert.equal(bodyRemovals - removalsBefore, 1, 'закрытие сняло окно не один раз');

  // Ответ приходит после закрытия — и приносит с собой отказ сервера.
  templateError = { message: 'boom' };
  release();
  await tick(40);
  templateGate = null;
  templateError = null;

  assert.deepEqual(toasts, [],
    'закрытое окно всё равно отругалось тостом: ' + JSON.stringify(toasts));
  assert.equal(dialogs('template-picker').length, 0, 'окно вернулось на экран');
  assert.equal(bodyRemovals - removalsBefore, 1,
    'окно сняли дважды: ' + (bodyRemovals - removalsBefore));
});
