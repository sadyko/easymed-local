// WAIT_REG_V1 (ревью, 3.25.0) — «ЖДУТ РЕГИСТРАЦИИ» И «ОФОРМИТЬ ПО ЗАПИСИ» ПОСЛЕ РЕВЬЮ — НА НАСТОЯЩЕМ СЕРВЕРЕ.
//
// Пробы ревью (rev-waitreg: zz-review-probe PROBE-1..4) — настоящими проверками. Экраны — вкладка
// «Ждут регистрации» и окно визита — ходят на НАСТОЯЩЕЕ приложение (стенд crm-unify-app.js) с куки
// регистратора, как wait-reg-live.test.mjs:
//   • M1, L5 — Escape в окне причины закрывает только его; окно причины — настоящий диалог;
//   • H2 — запись на вид приёма: строка «из записи» в смете, счёт ровно на неё, второй консультации нет;
//   • M2, L4 — направление врача, не оформленное с причиной: пропуск пишет сервер (номер строки), пациент
//     уходит из списка;
//   • H1, M4 — анализ «на дату» у пациента со счётом: в списке; убранный с причиной отпускается сервером
//     ДО ensure_visit и в визит не возвращается; отпускать нечего — остановка словами (L1);
//   • решение владельца — оформлен без счёта — уходит из списка; запись без услуги — «услуга не
//     выбрана», окно на врача записи.
// День — местный день клиники; время записи — в его пределах (любой час дня).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  closest() { return null; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  getClientRects() { return [1]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() {
    const s = this;
    return {
      contains: (c) => String(s.className).split(/\s+/).includes(c),
      add(c) { if (!String(s.className).split(/\s+/).includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = String(s.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle() {},
    };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s._t = ''; e.content.firstChild = s; }, get() { return ''; } });
  }
  if (String(t).toLowerCase() === 'select') Object.defineProperty(e, 'options', { get() { return e.children.filter((c) => c.tagName === 'OPTION'); } });
  return e;
};
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
const docListeners = {};
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener(type, fn) { (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn) { const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear() {} };
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {} }), scrollTo() {}, scrollY: 0,
  easymed: { state: { user: { id: 2, full_name: 'Регистратура', role: 'registrar' } } },
  confirm: () => true,
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};
globalThis.confirm = () => true;
globalThis.history = { state: null, replaceState() {}, pushState() {} };

// ─── НАСТОЯЩИЙ СЕРВЕР: относительные адреса экрана — на стенд, с куки регистратора ───
const realFetch = globalThis.fetch;
let LIVE = null;
const SENT = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!LIVE || !u.startsWith('/')) return realFetch(url, opts);
  let body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
  if (u.startsWith('/api/rpc/')) SENT.push({ kind: 'rpc', name: decodeURIComponent(u.slice('/api/rpc/'.length)), body });
  else if (u.startsWith('/api/db')) SENT.push({ kind: (body && body.op) || 'select', table: body && body.table, body });
  return realFetch(LIVE.base + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: LIVE.cookie } });
};

const { startCrmApp, localDay, addLead, addLine } = await import('../../../../server/test-helpers/crm-unify-app.js');
const { calendarBook, addVisitLine } = await import('../../../../server/test-helpers/crm-link-all.js');
const { renderRegistrarWaiting, loadRegistrarWaiting } = await import('../views/registrar-waiting.js');
const { setFullAccess } = await import('../permissions.js');
const { forgetSlots } = await import('../views/service-picker-modal.js?v=ownrep4');

const TODAY = localDay(0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');
const isWizard = (n) => !!(n && n.attrs && 'data-visit-wizard' in n.attrs);
const wizard = () => document.body.children.find(isWizard) || null;
const dropDialog = () => document.body.children.find((n) => n.attrs && n.attrs['data-dialog'] === 'booked-drop') || null;
const rpcNames = () => SENT.filter((s) => s.kind === 'rpc').map((s) => s.name);

async function live(seed) {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (41, 'Анализ мочи', 30000, 'lab', 1)").run();
    for (const [id, name] of [[78, 'Календарёва Анна'], [80, 'Анализова Вера'], [81, 'Направленов Глеб']]) {
      db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)').run(id, name, '+998 90 000 00 ' + id);
    }
    if (seed) seed(db);
  });
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reg', password: 'password1' }) });
  assert.equal(res.status, 200, 'вход регистратора');
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  globalThis.window.easymed.state.user = { id: 2, full_name: 'Регистратура', role: 'registrar' };
  SENT.length = 0; TOASTS.length = 0;
  document.body.children.length = 0;
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
  forgetSlots();
  return { ...t, close: () => { LIVE = null; document.body.children.length = 0; t.close(); } };
}

/** Открыть окно визита пациента (как «Оформить по записи») и дождаться сметы. */
async function openFor(pid) {
  const { openRegisterByBooking } = await import('../views/registrar-waiting.js');
  await openRegisterByBooking({ id: pid });
  for (let i = 0; i < 80 && !wizard(); i++) await wait(25);
  await wait(150); await flush(30);
  const ov = wizard();
  assert.ok(ov, 'окно визита не открылось: ' + JSON.stringify(TOASTS));
  return ov;
}
/** Кнопка «Убрать» строки сметы, помеченной атрибутом attr = value. */
function railRemoveBtn(ov, attr, value) {
  const tag = walk(ov).find((n) => n.attrs && n.attrs[attr] === String(value));
  assert.ok(tag, 'в смете нет строки ' + attr + '=' + value);
  const row = tag.parentElement;
  const btn = (row.children || []).find((n) => n.tagName === 'BUTTON' && n.attrs.title === 'Убрать');
  assert.ok(btn, 'у строки сметы нет «Убрать»');
  return btn;
}
async function reasonDialog() {
  for (let i = 0; i < 60 && !dropDialog(); i++) await wait(10);
  const dlg = dropDialog();
  assert.ok(dlg, 'окно причины не открылось — строку убрали молча');
  return dlg;
}
const dlgBtn = (dlg, key) => walk(dlg).find((n) => n.tagName === 'BUTTON' && n.attrs[key] !== undefined);
const dlgArea = (dlg) => walk(dlg).find((n) => n.tagName === 'TEXTAREA');
async function addFromCatalog(ov, svcId) {
  const row = walk(ov).find((n) => n.dataset && n.dataset.svcRow === String(svcId));
  assert.ok(row, 'в каталоге нет услуги ' + svcId);
  const btn = walk(row).find((n) => n.tagName === 'BUTTON' && /Добавить/.test(textOf(n)));
  assert.ok(btn, 'у услуги нет «Добавить»');
  btn.click();
  await wait(60); await flush(20);
}
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = wizard();
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON')
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(120); await flush(30);
    if (rpcNames().includes('ensure_visit') || TOASTS.some((x) => /уже назначена в этом визите/.test(x))) break;
  }
  for (let i = 0; i < 80 && !rpcNames().includes('create_invoice_for_visit') && !TOASTS.some((x) => /уже назначена в этом визите/.test(x)); i++) await wait(25);
  await wait(200); await flush(30);
}
const lines = (t, vid) => t.db.prepare("SELECT id, service_id, status, invoice_item_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
const visitsOf = (t, pid) => t.db.prepare("SELECT id FROM visits WHERE patient_id = ? AND status NOT IN ('cancelled', 'no_show') ORDER BY id").all(pid).map((r) => r.id);
const invoiceLines = (t, vid) => t.db.prepare(`SELECT vs.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                                                JOIN visit_services vs ON vs.invoice_item_id = ii.id WHERE i.visit_id = ? ORDER BY vs.id`).all(vid).map((r) => r.id);


/** Окно визита до подтверждения: «Далее», пока оно есть. */
async function toConfirm() {
  for (let i = 0; i < 6; i++) {
    const ov = wizard();
    if (!ov) return;
    const next = walk(ov).filter((n) => n.tagName === 'BUTTON').find((n) => /^\s*Далее/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!next) return;
    next.click();
    await wait(120); await flush(30);
  }
}
/** Подтверждение окна визита: последняя кнопка, затем дождаться конца записи (окно закрылось или пришёл ответ). */
async function confirmWizard() {
  const ov = wizard();
  const btn = walk(ov).filter((n) => n.tagName === 'BUTTON').find((n) => /^\s*(Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
  assert.ok(btn, 'нет кнопки подтверждения: ' + textOf(ov).slice(0, 300));
  btn.click();
  for (let i = 0; i < 120 && wizard(); i++) await wait(25);
  await wait(150); await flush(30);
}

// ===================== WAIT_REG_V1 (ревью) =====================

test('WAIT_REG_V1 (ревью M1, L5): Escape в окне причины закрывает только его — окно визита и смета остаются; окно — настоящий диалог', async () => {
  const t = await live();
  try {
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    const [booked] = lines(t, vid).map((r) => r.id);
    const ov = await openFor(78);
    await addFromCatalog(ov, 41);
    railRemoveBtn(ov, 'data-booked-line', booked).click();
    const dlg = await reasonDialog();
    const card = walk(dlg).find((n) => n.attrs && n.attrs.role === 'dialog');
    assert.ok(card, 'окно причины — не диалог (role="dialog")');
    assert.equal(card.attrs['aria-modal'], 'true');
    const titleId = card.attrs['aria-labelledby'];
    assert.ok(titleId && walk(dlg).some((n) => n.attrs && n.attrs.id === titleId), 'aria-labelledby не указывает на заголовок');
    const area = dlgArea(dlg);
    const label = walk(dlg).find((n) => n.tagName === 'LABEL');
    assert.ok(label && area.attrs.id && label.attrs.for === area.attrs.id, '«Причина» — не подпись поля');
    // Escape: все слушатели document (как браузер на всплытии и погружении).
    for (const fn of (docListeners.keydown || []).slice()) fn({ key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await wait(30); await flush(10);
    assert.equal(dropDialog(), null, 'окно причины не закрылось');
    assert.ok(wizard(), 'Escape в окне причины закрыл всё окно визита');
    assert.ok(walk(wizard()).some((n) => n.attrs && n.attrs['data-booked-line'] === String(booked)), 'строка записи пропала без причины');
    // Окна причины нет — Escape закрывает окно визита, как прежде.
    for (const fn of (docListeners.keydown || []).slice()) fn({ key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await wait(30);
    assert.equal(wizard(), null);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью H2): запись на вид приёма — «Оформить по записи» показывает её «из записи», счёт — ровно на неё, второй консультации нет', async () => {
  const t = await live((db) => {
    db.prepare("INSERT INTO consultation_types (id, name, price, active) VALUES (5, 'Первичный приём', 120000, 1)").run();
    db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available) VALUES (10, 5, 150000, 1)').run();
  });
  try {
    const { at } = await import('../../../../server/test-helpers/crm-unify-app.js');
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 78, doctor_id: 10, consultation_type_id: 5, start: at(TODAY, 13), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 78, lines: [{ consultation_type_id: 5, doctor_id: 10, scheduled_at: at(TODAY, 13) }] });
    assert.equal(add.status, 200, add.text);
    const [ct] = lines(t, vid).map((r) => r.id);
    assert.ok((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 78), 'подготовка: пациента нет в списке');
    const ov = await openFor(78);
    assert.ok(walk(ov).some((n) => n.attrs && n.attrs['data-booked-line'] === String(ct)), 'консультации по виду приёма нет в смете «из записи» — смета пустая');
    assert.match(textOf(ov), /Первичный приём/);
    await pressUntilCreate();
    assert.deepEqual(visitsOf(t, 78), [vid], 'оформление завело второй визит');
    assert.deepEqual(lines(t, vid).map((r) => r.id), [ct], 'вторая строка консультации или строка снята');
    assert.deepEqual(invoiceLines(t, vid), [ct], 'счёт не на строку записи');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(vid).n, 1);
    assert.equal((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 78), false, 'оформленный остался в списке');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью M2, L4): направление врача, не оформленное с причиной, — сервер пишет пропуск с номером строки; пациент уходит из списка', async () => {
  const t = await live();
  try {
    const ev = await t.rpc('ensure_visit', 'doc', { patient_id: 81, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
    const vid = ev.json.data.visit.id;
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
    const sent = await addVisitLine(t, 'doc', vid, { svc: 40, doctor: null });
    const ov = await openFor(81);
    await addFromCatalog(ov, 41);
    railRemoveBtn(ov, 'data-doctor-order-line', sent).click();
    const dlg = await reasonDialog();
    dlgArea(dlg).value = 'Пациент сдаст анализ завтра';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    await pressUntilCreate();
    assert.ok(SENT.some((s) => s.kind === 'rpc' && s.name === 'referral_line_skip'), 'пропуск направления не записан сервером');
    assert.equal(SENT.some((s) => s.table === 'invoice_audit_log'), false, 'журнал пишет браузер через /api/db');
    const log = t.db.prepare("SELECT visit_id, visit_service_id, reason FROM invoice_audit_log WHERE action = 'line_referral_skipped'").all();
    assert.deepEqual(log, [{ visit_id: vid, visit_service_id: sent, reason: 'Пациент сдаст анализ завтра' }]);
    const w = await loadRegistrarWaiting();
    assert.equal(w.rows.some((r) => r.patient_id === 81), false, 'не оформленное с причиной направление держит пациента в списке');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью H1, M4): анализ «на дату» у пациента со счётом — в списке; убранный с причиной не возвращается в визит, строка заявки не закрыта приходом', async () => {
  const t = await live();
  try {
    const ev0 = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
    const vid = ev0.json.data.visit.id;
    const own = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [own], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
    assert.ok((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 80), 'анализ «на дату» после утренней регистрации — не в списке');
    SENT.length = 0; TOASTS.length = 0;
    const ov = await openFor(80);
    await addFromCatalog(ov, 41);
    railRemoveBtn(ov, 'data-crm-line-id', lid).click();
    const dlg = await reasonDialog();
    dlgArea(dlg).value = 'Пациент отказался от анализа';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    await pressUntilCreate();
    const names = rpcNames();
    assert.ok(names.indexOf('crm_wish_release') > -1 && names.indexOf('crm_wish_release') < names.indexOf('ensure_visit'), 'анализ не отпущен до визита: ' + JSON.stringify(names));
    assert.equal(names.filter((n) => n === 'ensure_visit').length, 1, 'второй ensure_visit');
    const live = t.db.prepare("SELECT service_id, invoice_item_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
    assert.deepEqual(live.map((r) => r.service_id), [30, 41], 'отпущенный анализ вернулся в визит (или новая строка не легла)');
    assert.ok(live.every((r) => r.invoice_item_id != null), 'в визите строка без счёта');
    const line = t.db.prepare('SELECT status, scheduled_date, visit_id, visit_service_id, released_from_visit_id FROM crm_request_services WHERE id = ?').get(lid);
    assert.deepEqual(line, { status: 'pending', scheduled_date: null, visit_id: null, visit_service_id: null, released_from_visit_id: 0 }, 'строка заявки закрыта или не отпущена');
    assert.deepEqual(t.db.prepare("SELECT visit_id, reason FROM invoice_audit_log WHERE action = 'line_wish_released'").all(), [{ visit_id: vid, reason: 'Пациент отказался от анализа' }]);
    assert.equal(TOASTS.some((x) => /не удалось|не записан/i.test(x)), false, 'сбой: ' + JSON.stringify(TOASTS));
    assert.equal((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 80), false);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью H1, L1): отпустить нечего — окно визита останавливается словами, визит не тронут', async () => {
  const t = await live();
  try {
    const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
    const ov = await openFor(80);
    await addFromCatalog(ov, 41);
    railRemoveBtn(ov, 'data-crm-line-id', lid).click();
    const dlg = await reasonDialog();
    dlgArea(dlg).value = 'Пациент отказался от анализа';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    // Пока окно было открыто, оператор закрыл строку в карточке.
    t.db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id = ?").run(lid);
    SENT.length = 0; TOASTS.length = 0;
    await pressUntilCreate();
    assert.ok(TOASTS.some((x) => /уже не ждёт сегодняшнего визита/.test(x)), 'отказ сервера не назван: ' + JSON.stringify(TOASTS));
    assert.equal(rpcNames().includes('ensure_visit'), false, 'визит заведён после отказа');
    assert.deepEqual(visitsOf(t, 80), []);
    assert.ok(wizard(), 'окно визита закрылось, как будто всё записано');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью, решение владельца): оформлен без счёта («Сразу выставить счёт» снят) — уходит из списка, строки ждут кассу', async () => {
  const t = await live();
  try {
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    const [booked] = lines(t, vid).map((r) => r.id);
    await openFor(78);
    await toConfirm();
    const cb = walk(wizard()).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox' && /Сразу выставить счёт/.test(textOf(n.parentElement || {})));
    assert.ok(cb, 'нет галочки «Сразу выставить счёт»');
    cb.checked = false;
    cb.dispatchEvent({ type: 'change', currentTarget: cb, target: cb });
    await confirmWizard();
    assert.equal(wizard(), null, 'окно визита не закрылось: ' + JSON.stringify(TOASTS));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(vid).n, 0, 'счёт выставлен, хотя галочка снята');
    assert.ok(rpcNames().includes('registrar_registered'), 'отметка «оформлен» не поставлена');
    assert.deepEqual(lines(t, vid).map((r) => [r.id, r.invoice_item_id]), [[booked, null]]);
    assert.equal((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 78), false, 'оформленный без счёта остался в списке');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью, решение владельца): запись без услуги — «услуга не выбрана»; «Оформить по записи» — окно на врача записи, выбранная услуга ложится в эту запись', async () => {
  const t = await live();
  try {
    const { at } = await import('../../../../server/test-helpers/crm-unify-app.js');
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 78, doctor_id: 10, start: at(TODAY, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const host = mk('div');
    // CRM_BOOKINGS_TAB_V1 — вкладка по умолчанию показывает записи CRM; запись календаря — при «Все».
    await renderRegistrarWaiting(host, {}, { filter: { source: 'all' } });
    const row = walk(host).find((n) => n.attrs && n.attrs['data-rwait-row'] === '78');
    assert.ok(row, 'запись без услуги не во вкладке');
    assert.match(textOf(row), /услуга не выбрана/);
    walk(row).find((n) => n.attrs && n.attrs['data-rwait-register'] === '78').click();
    for (let i = 0; i < 80 && !wizard(); i++) await wait(25);
    await wait(150); await flush(30);
    const ov = wizard();
    assert.ok(ov, 'окно визита не открылось');
    assert.ok(TOASTS.some((x) => /Запись без услуги/.test(x) && /Иванов/.test(x)), 'окно не сказало, на какого врача запись: ' + JSON.stringify(TOASTS));
    await addFromCatalog(ov, 30);
    await wait(200); await flush(30);
    await pressUntilCreate();
    assert.deepEqual(visitsOf(t, 78), [vid], 'услуга легла не в запись');
    const ls = t.db.prepare("SELECT service_id, doctor_id, invoice_item_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid);
    assert.deepEqual(ls.map((r) => [r.service_id, r.doctor_id]), [[30, 10]], 'врач записи не подставлен');
    assert.notEqual(ls[0].invoice_item_id, null);
    assert.equal((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 78), false);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью L2, H2): строки быстрой регистрации целиком — та же услуга к другому врачу становится строкой записи (сказано), консультация по виду приёма вставляется и выставляется', async () => {
  const t = await live((db) => {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петрова', 'doctor', 1)").run();
    db.prepare("INSERT INTO consultation_types (id, name, price, active) VALUES (5, 'Первичный приём', 120000, 1)").run();
    db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available) VALUES (10, 5, 150000, 1)').run();
  });
  try {
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    const [booked] = lines(t, vid).map((r) => r.id);
    const { openRegisterByBooking } = await import('../views/registrar-waiting.js');
    const handle = await openRegisterByBooking({ id: 78 }, { presetLines: [
      { service_id: 30, doctor_id: 11, name: 'Консультация терапевта' },
      { service_id: null, consultation_type_id: 5, doctor_id: 10, name: 'Первичный приём', price: 150000 },
    ] });
    assert.ok(handle && handle.overlay, 'окно визита не вернуло пульт — быстрая регистрация не узнает, что оно открылось');
    for (let i = 0; i < 80 && !wizard(); i++) await wait(25);
    await wait(300); await flush(40);
    const ov = wizard();
    assert.ok(walk(ov).some((n) => n.attrs && n.attrs['data-booked-line'] === String(booked)), 'строка записи пропущена молча — набранная та же услуга к другому врачу её спрятала');
    assert.ok(TOASTS.some((x) => /в записи врач Иванов/.test(x) && /Петрова/.test(x)), 'не сказано, что врач набранной строки не сохранён: ' + JSON.stringify(TOASTS));
    assert.match(textOf(ov), /Первичный приём/);
    await pressUntilCreate();
    assert.deepEqual(visitsOf(t, 78), [vid]);
    const ls = t.db.prepare("SELECT id, service_id, consultation_type_id, doctor_id, invoice_item_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
    assert.deepEqual(ls.map((r) => [r.service_id, r.consultation_type_id, r.doctor_id]), [[30, null, 10], [null, 5, 10]], 'строки визита не те: ' + JSON.stringify(ls));
    assert.equal(ls[0].id, booked, 'строка записи заменена второй');
    assert.ok(ls.every((r) => r.invoice_item_id != null), 'строка без счёта: ' + JSON.stringify(ls));
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью M2): направление врача убрали с причиной и вернули «Добавить» — пропуск не пишется, строка в счёте', async () => {
  const t = await live();
  try {
    const ev = await t.rpc('ensure_visit', 'doc', { patient_id: 81, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
    const vid = ev.json.data.visit.id;
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
    const sent = await addVisitLine(t, 'doc', vid, { svc: 40, doctor: null });
    const ov = await openFor(81);
    railRemoveBtn(ov, 'data-doctor-order-line', sent).click();
    const dlg = await reasonDialog();
    dlgArea(dlg).value = 'Пациент сдаст анализ завтра';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    const add = walk(wizard()).find((n) => n.attrs && n.attrs['data-doctor-order-add'] === String(sent));
    assert.ok(add, 'у убранного направления нет «Добавить»');
    add.click();
    await wait(40); await flush(20);
    assert.ok(walk(wizard()).some((n) => n.attrs && n.attrs['data-doctor-order-line'] === String(sent)), 'направление не вернулось в смету');
    await pressUntilCreate();
    assert.equal(rpcNames().includes('referral_line_skip'), false, 'пропуск записан, хотя направление оформлено');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE action = 'line_referral_skipped'").get().n, 0);
    assert.notEqual(t.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(sent).i, null, 'направление не выставлено');
  } finally { t.close(); }
});
