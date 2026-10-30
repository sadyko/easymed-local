// REFUND_ANY_V1 (2026-10-30) — ВОЗВРАТ ИЗ ОКНА ВИЗИТА — НАСТОЯЩИМ ОКНОМ.
//
// visit-refund-door.test.mjs держит исходник; здесь — поведение целиком:
// настоящее окно визита (visit-modal.js) → «Возврат» / «Платежи» → настоящее
// окно «Платежи» кассы (cashier-desk.js, подгружается в момент действия тем же
// штампом, что у admin.js) → возврат. За фальшивым fetch — настоящая база (все
// миграции), настоящий компилятор запросов /api/db и настоящие RPC сервера.
//
// Поправка 7 плана: денежное действие окна «Платежи», открытого из окна
// визита, закрывает только свои окна — окно визита остаётся в документе и
// перечитывается ровно один раз (onDone), «Платежи» исчезают.
//
// Права: «Возврат» и «Платежи» видит только тот, кому сервер их даст
// (cashier_invoice_search и возвраты — касса и администратор, с учётом
// дополнительных ролей). Регистратору кнопок нет — и сервер ему отказывает.
//
// Ревью B5: после возврата перечитывается и вкладка «Услуги» (строка снова с
// галочкой и пометкой «возвращено»), журнал счёта называет возврат строки
// словами («Услуга возвращена»), возврат оплаты пишет журнал сервер;
// «Возврат» — у любого счёта с деньгами, и у старого отменённого; двойной
// щелчок открывает одно окно «Платежи»; касса не подгрузилась или счёт
// чужого здания — сообщение, окно визита на месте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Касса «не подгрузилась» (обрыв сети в браузере): подгрузка модуля кассы
// падает, пока поднят флаг. Хук — в том же потоке (registerHooks), флаг виден.
let failCashImport = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (failCashImport && /cashier-desk\.js\?v=/.test(specifier)) throw new Error('Failed to fetch dynamically imported module');
    return nextResolve(specifier, context);
  },
});

// ─── крошечный DOM ──────────────────────────────────────────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = { setProperty() {}, getPropertyValue() { return ''; } };
    this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.disabled = false; this.parentElement = null;
  }
  // Как в браузере: свойство поля — из атрибута, пока его не задали явно.
  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v) { this._checked = !!v; }
  get value() { return this._value !== undefined ? this._value : (this.attrs.value || ''); }
  set value(v) { this._value = String(v); }
  appendChild(c) { if (c.parentElement) c.parentElement.removeChild(c); this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentElement = null; return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren(...cs) { this.children.length = 0; for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {} setSelectionRange() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set() { const s = new F('svg'); s._t = ''; e.content.firstChild = s; }, get() { return ''; } });
  }
  return e;
};
const walk = (e, o = []) => { for (const c of (e && e.children) || []) { o.push(c); walk(c, o); } return o; };
const isModal = (n) => String(n.className || '').split(/\s+/).includes('modal');
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? TOAST_EL : null), querySelector: () => null,
  // Окна — где угодно в документе, как у браузера.
  querySelectorAll: (sel) => (sel === '.modal' ? walk(document.body).filter(isModal) : []),
};
// Язык экрана — явно, до импорта видов (i18n выбирает его один раз).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  easymed: { state: { user: null } }, easymedSetTabSub: () => {},
  CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.confirm = () => true;

// ─── настоящий сервер за фальшивым fetch ─────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { createInvoiceForVisit, recordPayment } = await import('../../../../server/services/rpc/billing.js');
const { openCashShift } = await import('../../../../server/services/rpc/cashier.js');

const CASHIER = { id: 9, role: 'cashier', full_name: 'Кассир', extra_roles: [] };
const REGISTRAR = { id: 7, role: 'registrar', full_name: 'Регистратор', extra_roles: [] };
const DOC_CASHIER = { id: 21, role: 'doctor', full_name: 'Врач-кассир', extra_roles: ['cashier'] };

const DB = openDb(':memory:');
migrate(DB);
const SEED = (() => {
  const u = DB.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, must_change_password)
                        VALUES (?,?,?,?,?,?,1,0)`);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(20, 'doc', 'x', 'doctor', 'Врач', 1);
  u.run(21, 'doccash', 'x', 'doctor', 'Врач-кассир', 1);
  DB.prepare('UPDATE users SET extra_roles = ? WHERE id = 21').run(JSON.stringify(['cashier']));
  const pid = DB.prepare("INSERT INTO patients (full_name) VALUES ('Тестовый Пациент')").run().lastInsertRowid;
  const svc = DB.prepare('INSERT INTO services (name, price, type, is_lab) VALUES (?, ?, ?, 0)');
  const consult = svc.run('Приём терапевта', 100000, 'consultation').lastInsertRowid;
  const proc = svc.run('Перевязка', 50000, 'procedure').lastInsertRowid;
  const line = DB.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?, ?, ?, 1, 0, 0)');
  const visitOf = () => DB.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(pid).lastInsertRowid;
  openCashShift(DB, { opening_float: 0 }, CASHIER);
  // Визит с двумя оплаченными счетами: доплата перевязки — старый счёт,
  // приём — новейший (его показывает вкладка).
  const vid = visitOf();
  const l1 = line.run(vid, proc, null).lastInsertRowid;
  const older = createInvoiceForVisit(DB, { visit_id: vid, visit_service_ids: [l1] }, REGISTRAR).invoice;
  recordPayment(DB, { invoice_id: older.id, amount: older.total_amount, method: 'cash' }, CASHIER);
  const l2 = line.run(vid, consult, 20).lastInsertRowid;
  const newest = createInvoiceForVisit(DB, { visit_id: vid, visit_service_ids: [l2] }, REGISTRAR).invoice;
  recordPayment(DB, { invoice_id: newest.id, amount: newest.total_amount, method: 'cash' }, CASHIER);
  DB.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run('2026-10-30T08:00:00Z', older.id);
  DB.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run('2026-10-30T09:00:00Z', newest.id);
  // Визит с неоплаченным счётом — отменяется, как прежде.
  const vid2 = visitOf();
  const l3 = line.run(vid2, consult, 20).lastInsertRowid;
  const unpaid = createInvoiceForVisit(DB, { visit_id: vid2, visit_service_ids: [l3] }, REGISTRAR).invoice;
  return { pid, vid, vid2, older, newest, unpaid, l2 };
})();

let USER = CASHIER;   // кто спрашивает сервер
const CALLS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message, code: status === 403 ? 'forbidden' : undefined } }), text: async () => message });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    CALLS.push(['rpc:' + name, body]);
    const handler = getRpc(name);
    if (!handler) return fail(501, 'RPC not implemented');
    try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
  }
  if (u === '/api/db') {
    CALLS.push(['db:' + body.table, body]);
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(400, e.message); }
    const { sql, params, meta } = compiled;
    if (meta.op !== 'select') { DB.prepare(sql).run(...params); return ok(null); }
    const rows = reshape(DB.prepare(sql).all(...params), meta);
    for (const r of rows) for (const c of meta.json || []) if (typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { r[c] = null; } }
    if (meta.single === 'single') return ok(rows[0]);
    if (meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return fail(404, 'no route ' + u);
};

const perms = await import('../permissions.js');
const VM = await import('../views/visit-modal.js');
const { tr } = await import('../i18n.js');
const { REFUNDED_LINE_MARK } = await import('../../shared/refunded-line.js');

/** Свежий визит с одним оплаченным счётом (приём терапевта). */
function paidVisit() {
  const vid = DB.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(SEED.pid).lastInsertRowid;
  const svc = DB.prepare("SELECT id FROM services WHERE name = 'Приём терапевта'").get().id;
  const l = DB.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?, ?, 20, 1, 0, 0)').run(vid, svc).lastInsertRowid;
  const inv = createInvoiceForVisit(DB, { visit_id: vid, visit_service_ids: [l] }, REGISTRAR).invoice;
  recordPayment(DB, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, CASHIER);
  return { vid, inv: DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id) };
}

const textOf = (e) => (e ? e.textContent : '');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await tick(0); };
async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await tick(5); }
  assert.fail('не дождались: ' + what);
}
const modals = () => walk(document.body).filter(isModal);
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const refundDoors = (root) => buttons(root).filter((b) => b.attrs['data-visit-refund'] !== undefined);
const invoiceReads = (vid) => CALLS.filter(([n, b]) => n === 'db:invoices' && (b.filters || []).some((f) => f.col === 'visit_id' && String(f.val) === String(vid))).length;
const rpcCalls = (name) => CALLS.filter(([n]) => n === 'rpc:' + name);
const isTab = (b) => String(b.className).split(/\s+/).includes('tab');

function signIn(user, roleRow) {
  USER = user;
  perms.setEffectiveFromRole(roleRow);
  window.easymed.state.user = { ...user };
}
const asCashier = () => signIn(CASHIER, { name: 'cashier', permissions: { sections: ['cashier', 'patients', 'appointments'], levels: { cashier: 'admin', patients: 'editor' }, grants: {} } });
const asRegistrar = () => signIn(REGISTRAR, { name: 'registrar', permissions: { sections: ['patients', 'appointments'], levels: { patients: 'editor', appointments: 'editor' }, grants: {} } });
const asDoctorCashier = () => signIn(DOC_CASHIER, { name: 'doctor', permissions: { sections: ['patients', 'consultation', 'cashier'], levels: { cashier: 'admin', patients: 'editor' }, grants: {} } });

/** Окно визита на вкладке «Счёт» — как его открывает регистратура или касса. */
async function openVisitOnInvoice(vid) {
  document.body.children.length = 0;
  const visit = DB.prepare('SELECT * FROM visits WHERE id = ?').get(vid);
  VM.openVisitModal({ visit: { ...visit, status: 'arrived' }, patient: { id: SEED.pid, full_name: 'Тестовый Пациент' } });
  await flush();
  const win = lastModal();
  assert.ok(win, 'окно визита не открылось');
  const tabs = buttons(win).filter(isTab);
  assert.equal(tabs.length, 3, 'вкладки окна визита');
  tabs[1].click();   // services · invoice · details
  await flush();
  return win;
}

// Первым: касса в этом процессе ещё не подгружалась ни разу.
test('касса не подгрузилась: сообщение, окно визита на месте, окна «Платежи» нет', async () => {
  asCashier();
  CALLS.length = 0; TOASTS.length = 0;
  const win = await openVisitOnInvoice(SEED.vid);
  const main = refundDoors(win).find((b) => b.attrs['data-visit-refund'] === String(SEED.newest.id));
  assert.ok(main, 'нет «Возврат» у оплаченного счёта');
  failCashImport = true;
  try {
    main.click();
    await until(() => TOASTS.length > 0, 'сообщение о сбое');
  } finally {
    failCashImport = false;
  }
  await flush();
  assert.equal(TOASTS.length, 1, TOASTS.join(' | '));
  assert.ok(TOASTS[0].startsWith('Не удалось открыть платежи: '), TOASTS[0]);
  assert.deepEqual(modals(), [win], 'окно визита пропало или открылось лишнее окно');
  assert.equal(rpcCalls('cashier_invoice_search').length, 0);
  document.body.children.length = 0;
});

test('касса: «Возврат» в окне визита → «Платежи» → «Оставить услугу в визите»: окно визита остаётся и перечитывается один раз, «Платежи» закрыты', async () => {
  asCashier();
  CALLS.length = 0; TOASTS.length = 0;
  const win = await openVisitOnInvoice(SEED.vid);
  const doors = refundDoors(win);
  assert.deepEqual(doors.map((b) => b.attrs['data-visit-refund']).sort(), [String(SEED.newest.id), String(SEED.older.id)].sort(),
    'у новейшего счёта — «Возврат», у прежнего оплаченного — «Платежи» в «Другие счета визита»');
  const main = doors.find((b) => b.attrs['data-visit-refund'] === String(SEED.newest.id));
  assert.equal(textOf(main).trim(), 'Возврат');
  assert.ok(walk(win).some((n) => n.attrs && n.attrs['data-visit-other-invoices'] !== undefined), 'нет блока «Другие счета визита»');
  assert.ok(textOf(win).includes('Другие счета визита'));
  assert.ok(!textOf(win).includes('Cancel & refund') && !textOf(win).includes('Отменить и вернуть'), 'у оплаченного счёта — отмена целиком');

  const readsBefore = invoiceReads(SEED.vid);
  // Ревью B5, п. 7 — двойной щелчок: одно окно «Платежи», один запрос счёта.
  main.click();
  main.click();
  await until(() => modals().length >= 2, 'окно «Платежи»');
  await flush();
  assert.equal(modals().length, 2, 'двойной щелчок открыл два окна «Платежи»');
  const pay = lastModal();
  assert.notEqual(pay, win);
  assert.ok(textOf(pay).includes('Платежи · ' + SEED.newest.invoice_number), textOf(pay).slice(0, 200));
  assert.deepEqual(rpcCalls('cashier_invoice_search').map(([, b]) => b), [{ invoice_id: SEED.newest.id }]);

  buttonByText(pay, 'Вернуть услугу').click();
  const dlg = lastModal();
  assert.equal(modals().length, 3, 'окно возврата услуги');
  const keep = walk(dlg).find((n) => n.tagName === 'INPUT' && n.attrs['data-keep-line'] !== undefined);
  assert.ok(keep, 'неначатой услуге визита — «Оставить услугу в визите»: ' + textOf(dlg).slice(0, 300));
  keep.checked = true;
  buttonByText(dlg, 'Вернуть услугу').click();
  await until(() => modals().length === 1, 'окна возврата закрылись');
  await flush();

  assert.equal(rpcCalls('refund_invoice_line').length, 1);
  assert.equal(rpcCalls('refund_invoice_line')[0][1].keep_services, true);
  assert.deepEqual(modals(), [win], 'окно визита закрылось вместе с окнами возврата');
  assert.ok(win.parentElement === document.body, 'окно визита вынуто из документа');
  assert.equal(invoiceReads(SEED.vid) - readsBefore, 1, 'окно визита перечитало счета ровно один раз');
  // Перечитано по-настоящему: новейший счёт пуст и отменён — «Возврата» у него
  // больше нет; прежний оплаченный счёт по-прежнему в «Другие счета визита».
  const inv = DB.prepare('SELECT status, paid_amount FROM invoices WHERE id = ?').get(SEED.newest.id);
  assert.equal(inv.paid_amount, 0);
  assert.deepEqual(refundDoors(win).map((b) => b.attrs['data-visit-refund']), [String(SEED.older.id)]);
  // «Оставить услугу в визите» — строка осталась в визите без счёта.
  const vs = DB.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(SEED.l2);
  assert.equal(vs.invoice_item_id, null);
  assert.ok(TOASTS.some((t) => t.startsWith('Возвращено')), TOASTS.join(' | '));
  // Ревью B5, п. 2 — «Invoice activity» называет возврат строки словами, а не кодом.
  assert.ok(textOf(win).includes(tr(REFUNDED_LINE_MARK)), 'журнал счёта не назвал возврат строки');
  assert.ok(!textOf(win).includes('refund_line'), 'журнал счёта показал код действия');

  // Ревью B5, п. 1 — перечитана и вкладка «Услуги»: оставленная строка снова
  // без счёта — с галочкой и пометкой «возвращено»; счётчик вкладки верный.
  buttons(win).filter(isTab)[0].click();
  await flush();
  const lines = DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(SEED.vid).n;
  const svcTab = buttons(win).filter(isTab)[0];
  assert.equal(textOf(walk(svcTab).find((n) => n.className === 'tab-count')), String(lines), 'счётчик вкладки «Услуги»');
  const row = walk(win).find((n) => n.tagName === 'TR' && textOf(n).includes('Приём терапевта'));
  assert.ok(row, 'строки приёма нет на вкладке «Услуги»');
  assert.ok(walk(row.children[0]).some((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox'), 'у оставленной строки нет галочки — вкладка не перечитана');
  assert.ok(textOf(row).includes(tr('возвращено')), 'нет пометки «возвращено»');
  assert.equal(invoiceReads(SEED.vid) - readsBefore, 1, 'вкладка «Услуги» перечитывала счета');
  document.body.children.length = 0;
});

test('касса: «Платежи» другого счёта визита → возврат оплаты: окно визита остаётся и перечитывается один раз', async () => {
  asCashier();
  CALLS.length = 0; TOASTS.length = 0;
  const win = await openVisitOnInvoice(SEED.vid);
  const door = refundDoors(win).find((b) => b.attrs['data-visit-refund'] === String(SEED.older.id));
  assert.ok(door, 'нет «Платежи» у прежнего оплаченного счёта');
  assert.equal(textOf(door).trim(), 'Платежи');
  const readsBefore = invoiceReads(SEED.vid);
  door.click();
  await until(() => modals().length === 2, 'окно «Платежи»');
  const pay = lastModal();
  assert.ok(textOf(pay).includes('Платежи · ' + SEED.older.invoice_number));
  buttonByText(pay, 'Возврат').click();
  const dlg = lastModal();
  assert.equal(modals().length, 3, 'окно возврата оплаты');
  walk(dlg).find((n) => n.tagName === 'INPUT').value = String(SEED.older.total_amount);   // сумма возврата
  buttonByText(dlg, 'Оформить возврат').click();
  await until(() => modals().length === 1, 'окна возврата закрылись');
  await flush();

  assert.equal(rpcCalls('refund_payment').length, 1);
  assert.deepEqual(modals(), [win], 'окно визита закрылось после возврата оплаты');
  assert.equal(invoiceReads(SEED.vid) - readsBefore, 1, 'окно визита перечитало счета ровно один раз');
  assert.equal(DB.prepare('SELECT paid_amount FROM invoices WHERE id = ?').get(SEED.older.id).paid_amount, 0);
  assert.equal(refundDoors(win).length, 0, 'денег по счетам визита не осталось — кнопок возврата тоже');
  assert.ok(!walk(win).some((n) => n.attrs && n.attrs['data-visit-other-invoices'] !== undefined), 'пустой блок «Другие счета визита»');
  // Ревью B5, п. 3 — возврат оплаты журналирует сервер: строка 'refunded', и
  // «Invoice activity» визита её показывает своей пометкой.
  const logged = DB.prepare("SELECT refund_amount, visit_id FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refunded'").all(SEED.older.id);
  assert.deepEqual(logged, [{ refund_amount: SEED.older.total_amount, visit_id: SEED.vid }]);
  assert.ok(textOf(win).includes(tr('Refunded')), 'журнал визита не показал возврат оплаты');
  document.body.children.length = 0;
});

test('права: регистратору «Возврат» и «Платежи» не показаны — и сервер ему их не даёт; врачу с ролью кассы — показаны и сервер даёт', async () => {
  // Свежий визит с оплаченным счётом: прошлые тесты деньги уже вернули.
  const { vid, inv } = paidVisit();

  asRegistrar();
  let win = await openVisitOnInvoice(vid);
  assert.equal(refundDoors(win).length, 0, 'регистратору — кнопка, которую сервер отвергнет');
  assert.ok(!walk(win).some((n) => n.attrs && n.attrs['data-visit-other-invoices'] !== undefined));
  for (const [name, args] of [['cashier_invoice_search', { invoice_id: inv.id }], ['invoice_line_work', { invoice_id: inv.id }]]) {
    assert.throws(() => getRpc(name)(DB, args, REGISTRAR), (e) => e.status === 403, name + ': сервер дал регистратору');
  }

  asDoctorCashier();
  win = await openVisitOnInvoice(vid);
  assert.deepEqual(refundDoors(win).map((b) => b.attrs['data-visit-refund']), [String(inv.id)], 'роль кассы дополнительной — кнопки нет');
  const found = getRpc('cashier_invoice_search')(DB, { invoice_id: inv.id }, DOC_CASHIER);
  assert.equal(found.rows.length, 1, 'сервер не дал роли кассы дополнительной');
  // И окно «Платежи» у него полное: платёж и строки счёта читаются.
  TOASTS.length = 0;
  refundDoors(win)[0].click();
  await until(() => modals().length === 2, 'окно «Платежи» врачу с ролью кассы');
  await flush();
  const pay = lastModal();
  assert.ok(buttonByText(pay, 'Возврат'), 'нет платежа в окне «Платежи»: ' + textOf(pay).slice(0, 300));
  assert.ok(buttonByText(pay, 'Вернуть услугу'), 'нет строк счёта в окне «Платежи»');
  assert.deepEqual(TOASTS, [], 'отказ сервера: ' + TOASTS.join(' | '));
  document.body.children.length = 0;
});

test('неоплаченный счёт: «Возврата» нет — отменяется, как прежде', async () => {
  asCashier();
  const win = await openVisitOnInvoice(SEED.vid2);
  assert.equal(refundDoors(win).length, 0);
  assert.ok(buttons(win).some((b) => textOf(b).trim() === tr('Cancel invoice')), 'нет «Cancel invoice» у неоплаченного счёта');
  document.body.children.length = 0;
});

test('ревью B5, п. 5: старый отменённый счёт, на котором остались деньги, — «Возврат» есть, «Cancel invoice» нет; «Платежи» открываются', async () => {
  asCashier();
  const f = paidVisit();
  // Отмена до BILLING_AUDIT_FIX_V1 денег не трогала: счёт «отменён», а оплата на нём.
  DB.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(f.inv.id);
  CALLS.length = 0; TOASTS.length = 0;
  const win = await openVisitOnInvoice(f.vid);
  const doors = refundDoors(win);
  assert.deepEqual(doors.map((b) => b.attrs['data-visit-refund']), [String(f.inv.id)], 'у отменённого счёта с деньгами нет «Возврат»');
  assert.equal(textOf(doors[0]).trim(), 'Возврат');
  assert.ok(!buttons(win).some((b) => textOf(b).trim() === tr('Cancel invoice')), 'отменённый счёт снова предлагают отменить');
  doors[0].click();
  await until(() => modals().length === 2, 'окно «Платежи»');
  const pay = lastModal();
  assert.ok(buttonByText(pay, 'Возврат'), 'у платежа отменённого счёта нет возврата: ' + textOf(pay).slice(0, 300));
  assert.deepEqual(TOASTS, []);
  // Ревью B5 (повторное) — вернуть все деньги: счёт остаётся отменённым, а не
  // становится долгом; окно визита долга не показывает.
  buttonByText(pay, 'Возврат').click();
  const dlg = lastModal();
  walk(dlg).find((n) => n.tagName === 'INPUT').value = String(f.inv.paid_amount);
  buttonByText(dlg, 'Оформить возврат').click();
  await until(() => modals().length === 1, 'окна возврата закрылись');
  await flush();
  assert.deepEqual(modals(), [win]);
  const row = DB.prepare('SELECT status, paid_amount FROM invoices WHERE id = ?').get(f.inv.id);
  assert.deepEqual({ ...row }, { status: 'void', paid_amount: 0 }, 'отменённый счёт после возврата');
  assert.equal(DB.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE invoice_id = ? AND action = 'void'").get(f.inv.id).n, 0,
    'отменённый счёт отменён второй раз');
  const debtCell = walk(win).find((n) => n.tagName === 'DIV' && n.children.length === 2 && textOf(n.children[0]) === tr('Debt'));
  assert.ok(debtCell, 'нет поля «Долг» в окне визита');
  assert.equal(textOf(debtCell.children[1]).trim(), '0 UZS', 'окно визита показывает долг по отменённому счёту');
  assert.ok(!textOf(win).includes(tr('Outstanding: ').trim()), 'окно визита просит оплатить отменённый счёт');
  assert.equal(refundDoors(win).length, 0, 'денег не осталось — «Возврата» нет');
  document.body.children.length = 0;
});

test('ревью B5, п. 8: счёт чужого здания — касса называет причину, окно визита на месте; щелчок снова работает', async () => {
  asCashier();
  const f = paidVisit();
  DB.prepare("UPDATE invoices SET sync_origin = 'B' WHERE id = ?").run(f.inv.id);
  CALLS.length = 0; TOASTS.length = 0;
  const win = await openVisitOnInvoice(f.vid);
  const door = refundDoors(win)[0];
  assert.ok(door, 'нет «Возврат» у оплаченного счёта');
  door.click();
  await until(() => TOASTS.length > 0, 'сообщение об отказе');
  await flush();
  assert.deepEqual(TOASTS, ['Это счёт другого здания — его деньги возвращает касса того здания.']);
  assert.deepEqual(modals(), [win], 'окно визита пропало или открылось лишнее окно');
  // Защита от двойного щелчка отпущена и после отказа.
  door.click();
  await until(() => TOASTS.length === 2, 'второй щелчок');
  assert.equal(rpcCalls('cashier_invoice_search').length, 2);
  document.body.children.length = 0;
});
