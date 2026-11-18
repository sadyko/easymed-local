// WAIT_REG_V1 (3.25.0, 2026-11-17) — «ЖДУТ РЕГИСТРАЦИИ» И «ОФОРМИТЬ ПО ЗАПИСИ» НА НАСТОЯЩЕМ СЕРВЕРЕ.
//
// Экраны — вкладка «Ждут регистрации» (views/registrar-waiting.js) и окно визита
// (views/visit-wizard.js) — ходят на НАСТОЯЩЕЕ приложение (стенд crm-unify-app.js: /api/db с сетью
// R7b и шагом связи CRM, реестр RPC, касса) с куки регистратора, как в booked-rows-live.test.mjs.
// Сверяется то, что видит экран, с тем, что легло в базу:
//   • «Оформить по записи» — окно визита со строкой «из записи»; подтверждение — тот же визит,
//     ровно записанная строка, один счёт; пациент уходит из списка;
//   • ВЫНУЖДАЮЩАЯ ФУНКЦИЯ: строку «из записи», «от врача» и «из заявки» не убрать без причины;
//     причина — в журнале визита (invoice_audit_log); строка записи снимается с визита, строка
//     заявки возвращается в CRM без даты, направление врача остаётся в визите;
//   • повтор направленной услуги — прежний запрет DUP_STOP_V1 (до ensure_visit);
//   • анализ «на дату» — окно визита заводит визит дня с ним, одна строка, один счёт.
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

test('WAIT_REG_V1 (настоящий сервер): вкладка → «Оформить по записи» — окно со строкой «из записи»; один визит, ровно строка записи, один счёт; пациент ушёл из списка', async () => {
  const t = await live();
  try {
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    const [booked] = lines(t, vid).map((r) => r.id);
    const host = mk('div');
    // CRM_BOOKINGS_TAB_V1 — вкладка по умолчанию показывает записи CRM; запись календаря — при «Все».
    const tab = await renderRegistrarWaiting(host, {}, { filter: { source: 'all' } });
    const row = walk(host).find((n) => n.attrs && n.attrs['data-rwait-row'] === '78');
    assert.ok(row, 'записанного пациента нет во вкладке: ' + textOf(host));
    assert.match(textOf(row), /Календарёва Анна/);
    assert.match(textOf(row), /Календарь/);
    assert.match(textOf(row), /13:00/);
    walk(row).find((n) => n.attrs && n.attrs['data-rwait-register'] === '78').click();
    for (let i = 0; i < 80 && !wizard(); i++) await wait(25);
    await wait(150); await flush(30);
    const ov = wizard();
    assert.ok(ov, '«Оформить по записи» не открыло окно визита: ' + JSON.stringify(TOASTS));
    assert.ok(walk(ov).some((n) => n.attrs && n.attrs['data-booked-line'] === String(booked)), 'строки «из записи» нет в смете');
    await pressUntilCreate();
    assert.deepEqual(visitsOf(t, 78), [vid], 'оформление завело второй визит');
    assert.deepEqual(lines(t, vid).map((r) => r.id), [booked], 'в визите не ровно строка записи');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(vid).n, 1, 'счетов не один');
    assert.deepEqual(invoiceLines(t, vid), [booked], 'счёт не на строку записи');
    const after = await loadRegistrarWaiting();
    assert.equal(after.rows.some((r) => r.patient_id === 78), false, 'оформленный пациент остался в списке');
    await tab.reload();
    assert.equal(walk(host).some((n) => n.attrs && n.attrs['data-rwait-row'] === '78'), false, 'вкладка не убрала оформленного');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (настоящий сервер): строку «из записи» без причины не убрать; с причиной — снята с визита, причина в журнале, счёт на остальное', async () => {
  const t = await live();
  try {
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    const [booked] = lines(t, vid).map((r) => r.id);
    const ov = await openFor(78);
    await addFromCatalog(ov, 41);
    // Передумали — строка на месте.
    railRemoveBtn(ov, 'data-booked-line', booked).click();
    let dlg = await reasonDialog();
    dlgBtn(dlg, 'data-drop-cancel').click();
    await wait(30); await flush(10);
    assert.ok(walk(wizard()).some((n) => n.attrs && n.attrs['data-booked-line'] === String(booked)), '«Оставить услугу» убрало строку');
    // Без причины — не отпускает.
    railRemoveBtn(wizard(), 'data-booked-line', booked).click();
    dlg = await reasonDialog();
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(30);
    assert.ok(dropDialog(), 'окно отпустило без причины');
    assert.ok(TOASTS.some((x) => /Укажите причину/.test(x)), 'не сказано, что нужна причина');
    // С причиной — убрана из сметы.
    dlgArea(dlg).value = 'Пациент отказался от консультации';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    assert.equal(dropDialog(), null);
    assert.equal(walk(wizard()).some((n) => n.attrs && n.attrs['data-booked-line'] === String(booked)), false, 'строка осталась в смете');
    await pressUntilCreate();
    const rm = SENT.find((s) => s.kind === 'rpc' && s.name === 'booking_line_remove');
    assert.ok(rm, 'строку записи не сняли с визита');
    // WAIT_REG_V1 (ревью M3) — окно регистрации помечает себя: без причины сервер такую строку не снимет.
    assert.deepEqual(rm.body, { visit_service_id: booked, registration: true, reason: 'Пациент отказался от консультации' });
    assert.equal(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(booked), undefined, 'строка записи осталась в визите');
    const log = t.db.prepare("SELECT visit_id, reason FROM invoice_audit_log WHERE action = 'line_booked_removed'").all();
    assert.deepEqual(log, [{ visit_id: vid, reason: 'Пациент отказался от консультации' }]);
    assert.deepEqual(visitsOf(t, 78), [vid], 'появился второй визит');
    assert.deepEqual(lines(t, vid).map((r) => r.service_id), [41]);
    assert.deepEqual(invoiceLines(t, vid), lines(t, vid).map((r) => r.id));
  } finally { t.close(); }
});

test('WAIT_REG_V1 (настоящий сервер): направление врача — «от врача» в смете; убрать — только с причиной (журнал), строка остаётся в визите; повтор той же услуги — DUP_STOP_V1', async () => {
  const t = await live();
  try {
    const ev = await t.rpc('ensure_visit', 'doc', { patient_id: 81, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
    const sent = await addVisitLine(t, 'doc', vid, { svc: 40, doctor: null });
    let ov = await openFor(81);
    assert.ok(walk(ov).some((n) => n.attrs && n.attrs['data-doctor-order-line'] === String(sent)), 'направления врача нет в смете «от врача»');
    await addFromCatalog(ov, 41);
    railRemoveBtn(ov, 'data-doctor-order-line', sent).click();
    const dlg = await reasonDialog();
    assert.match(textOf(dlg), /направил врач Иванов/);
    dlgArea(dlg).value = 'Пациент сдаст анализ завтра';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    await pressUntilCreate();
    assert.ok(t.db.prepare("SELECT 1 FROM visit_services WHERE id = ? AND status = 'added' AND invoice_item_id IS NULL").get(sent), 'направление врача снято с визита');
    const log = t.db.prepare("SELECT visit_id, reason, notes FROM invoice_audit_log WHERE action = 'line_referral_skipped'").all();
    assert.equal(log.length, 1, 'причина не записана в журнал визита');
    assert.equal(log[0].visit_id, vid);
    assert.equal(log[0].reason, 'Пациент сдаст анализ завтра');
    assert.match(log[0].notes, /Анализ крови/);
    // Повтор той же услуги — прежний запрет повтора, до ensure_visit.
    document.body.children.length = 0; SENT.length = 0; TOASTS.length = 0;
    ov = await openFor(81);
    railRemoveBtn(ov, 'data-doctor-order-line', sent).click();
    const d2 = await reasonDialog();
    dlgArea(d2).value = 'проверка повтора';
    dlgBtn(d2, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    await addFromCatalog(wizard(), 40);
    const before = t.db.prepare('SELECT COUNT(*) n FROM visit_services').get().n;
    await pressUntilCreate();
    assert.ok(TOASTS.some((x) => /уже назначена в этом визите/.test(x)), 'повтор направленной услуги не остановлен: ' + JSON.stringify(TOASTS));
    assert.equal(rpcNames().includes('ensure_visit'), false, 'визит тронут до отказа');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, before, 'повтор записан');
  } finally { t.close(); }
});

// CRM_BOOKINGS_TAB_V1 (направления до оплаты, решение владельца) — направленный врачом пациент со счётом ждёт
// кассу: в «Ждут» с подписью, «Открыть визит» — окно счёта визита (та же дверь, что у кассы: cashier-desk.js
// openVisitWindow → visit-bill.js), «Оформить по записи» нет; касса приняла оплату — пациент ушёл из «Ждут».
test('CRM_BOOKINGS_TAB_V1 (направления до оплаты, настоящий сервер): направление врача со счётом — «к кассе», «Открыть визит» открывает окно счёта визита; оплачено — ушёл из «Ждут»', async () => {
  const t = await live();
  try {
    const ev = await t.rpc('ensure_visit', 'doc', { patient_id: 81, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
    const sent = await addVisitLine(t, 'doc', vid, { svc: 40, doctor: null });
    const inv = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: vid, visit_service_ids: [sent], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const host = mk('div');
    const tab = await renderRegistrarWaiting(host, {}, { filter: { source: 'doctor' } });
    const rowEl = () => walk(host).find((n) => n.attrs && n.attrs['data-rwait-row'] === '81') || null;
    assert.ok(rowEl(), 'направление врача со счётом не в «Ждут»: ' + textOf(host).slice(0, 300));
    assert.match(textOf(rowEl()), /Направил врач — счёт выставлен, к кассе/);
    assert.equal(walk(rowEl()).some((n) => n.attrs && 'data-rwait-register' in n.attrs), false, '«Оформить по записи» у строки, которую ждёт касса');
    const btn = walk(rowEl()).find((n) => n.attrs && n.attrs['data-rwait-visit'] === '81');
    assert.ok(btn, 'нет «Открыть визит»');
    const bill = () => document.body.children.find((n) => n && String(n.className || '').split(/\s+/).includes('modal') && /Счёт и оплата/.test(textOf(n))) || null;
    btn.click();
    for (let i = 0; i < 120 && !bill(); i++) await wait(25);
    await wait(150); await flush(30);
    assert.ok(bill(), '«Открыть визит» не открыл окно счёта визита: ' + JSON.stringify(TOASTS));
    assert.match(textOf(bill()), /Направленов Глеб/, 'окно счёта — не того пациента');
    assert.ok(SENT.some((s) => s.kind === 'select' && s.table === 'visits'), 'визит окна не прочитан с сервера');
    // Касса приняла оплату — пациент ушёл из «Ждут».
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: inv.json.data.invoice.total_amount, method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
    await tab.reload();
    assert.equal(rowEl(), null, 'оплаченное направление осталось в «Ждут»');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (настоящий сервер): анализ «на дату» — окно заводит визит дня с ним: одна строка, один счёт; убранный с причиной — снят, заявка без даты, журнал', async () => {
  const t = await live();
  try {
    const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
    let ov = await openFor(80);
    assert.ok(walk(ov).some((n) => n.attrs && n.attrs['data-crm-line-id'] === String(lid)), 'анализа «на дату» нет в смете строкой «из заявки»');
    await pressUntilCreate();
    const [vid] = visitsOf(t, 80);
    assert.ok(vid, 'визит дня не заведён');
    assert.deepEqual(visitsOf(t, 80), [vid]);
    assert.deepEqual(lines(t, vid).map((r) => r.service_id), [40], 'строк анализа не одна');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(vid).n, 1);
    assert.deepEqual(invoiceLines(t, vid), lines(t, vid).map((r) => r.id));
    assert.equal((await loadRegistrarWaiting()).rows.some((r) => r.patient_id === 80), false, 'оформленный остался в списке');

    // Второй пациент — анализ «на дату» убран с причиной.
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (90, 'Отказова Юлия', '+998 90 000 00 90')").run();
    const rid2 = addLead(t.db, { patient: 90, phone: '+998 90 000 00 90', name: 'Отказова Юлия' });
    const lid2 = addLine(t.db, rid2, { svc: 40, day: TODAY });
    document.body.children.length = 0; SENT.length = 0; TOASTS.length = 0;
    ov = await openFor(90);
    await addFromCatalog(ov, 41);
    const crmTag = walk(ov).find((n) => n.attrs && n.attrs['data-crm-line-id'] === String(lid2));
    assert.ok(crmTag, 'у строки «из заявки» нет метки строки заявки');
    railRemoveBtn(ov, 'data-crm-line-id', lid2).click();
    const dlg = await reasonDialog();
    dlgArea(dlg).value = 'Анализ сдан в другой лаборатории';
    dlgBtn(dlg, 'data-drop-confirm').click();
    await wait(40); await flush(20);
    await pressUntilCreate();
    const [v2] = visitsOf(t, 90);
    assert.deepEqual(lines(t, v2).map((r) => r.service_id), [41], 'убранный анализ остался в визите');
    // WAIT_REG_V1 (ревью H1) — отпущен сервером ДО визита (визита ещё не было): без даты, отметка
    // «отпущена» без визита (0), журнал — с причиной; визит дня его не взял.
    const back = t.db.prepare('SELECT status, visit_id, scheduled_date, released_from_visit_id FROM crm_request_services WHERE id = ?').get(lid2);
    assert.deepEqual(back, { status: 'pending', visit_id: null, scheduled_date: null, released_from_visit_id: 0 }, 'строка заявки не вернулась в CRM без даты');
    const rel = SENT.find((s) => s.kind === 'rpc' && s.name === 'crm_wish_release');
    assert.ok(rel, 'анализ не отпущен сервером');
    assert.ok(SENT.indexOf(rel) < SENT.findIndex((s) => s.kind === 'rpc' && s.name === 'ensure_visit'), 'анализ отпущен не до визита дня');
    assert.equal(rpcNames().filter((n) => n === 'ensure_visit').length, 1, 'второй ensure_visit');
    assert.equal(t.db.prepare("SELECT reason FROM invoice_audit_log WHERE action = 'line_wish_released'").get().reason, 'Анализ сдан в другой лаборатории');
    assert.equal(lid > 0, true);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (настоящий сервер): «Записи CRM» по умолчанию — сегодняшние записи колл-центра; «Завтра» — запись на завтра без «Оформить по записи»; «Все» источники — и календарь', async () => {
  const t = await live((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (86, 'Завтрашний Илья', '+998 90 000 00 86')").run();
  });
  try {
    const { callcenterBook } = await import('../../../../server/test-helpers/crm-link-all.js');
    await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });
    await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });
    await callcenterBook(t, localDay(1), { hour: 10, svc: 30, doctor: 10, pid: 86 });
    const host = mk('div');
    const counts = [];
    const tab = await renderRegistrarWaiting(host, { onCount: (n) => counts.push(n) }, {});
    const rowIds = () => walk(host).filter((n) => n.attrs && n.attrs['data-rwait-row'] !== undefined).map((n) => n.attrs['data-rwait-row']);
    const regIds = () => walk(host).filter((n) => n.attrs && n.attrs['data-rwait-register'] !== undefined).map((n) => n.attrs['data-rwait-register']);
    assert.deepEqual(rowIds(), ['77'], 'по умолчанию не только сегодняшние записи CRM: ' + textOf(host).slice(0, 300));
    assert.deepEqual(regIds(), ['77']);
    assert.deepEqual(counts, [1]);
    const press = async (attr, v) => {
      walk(host).find((n) => n.attrs && n.attrs[attr] === v).click();
      for (let i = 0; i < 120 && tab.state.loading; i++) await wait(25);
      await wait(100); await flush(20);   // и число вкладки (count_only) после списка
    };
    await press('data-rwait-day', 'tomorrow');
    assert.deepEqual(rowIds(), ['86'], '«Завтра» — не запись на завтра');
    assert.deepEqual(regIds(), [], 'у завтрашней записи «Оформить по записи»');
    assert.ok(walk(host).some((n) => n.attrs && n.attrs['data-rwait-card'] === '86'), 'у завтрашней записи нет «Открыть карту»');
    assert.equal(counts.at(-1), 1, 'счётчик вкладки пошёл за открытым фильтром');
    await press('data-rwait-day', 'today');
    await press('data-rwait-src', 'all');
    assert.deepEqual(rowIds(), ['77', '78']);
    const rq = SENT.filter((s) => s.kind === 'rpc' && s.name === 'registrar_waiting').map((s) => s.body);
    assert.deepEqual(rq[0], { sources: ['crm'] });
    assert.ok(rq.some((b) => b.day === localDay(1) && !b.count_only), 'завтра спрошено не днём сервера');
  } finally { t.close(); }
});
