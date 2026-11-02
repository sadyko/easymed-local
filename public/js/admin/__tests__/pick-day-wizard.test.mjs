// PICK_DAY_V1 (решение владельца 2026-11-02) — НЕТ ВРЕМЕНИ СЕГОДНЯ — ДЕНЬ
// ВЫБИРАЕТ РЕГИСТРАТОР.
//
// Мастер визита (visit-wizard.js) ставил врачебной строке первый свободный слот
// за 14 дней: вечером или в выходной врача строка молча уходила на завтра, а
// услуги без врача оставались сегодня — смета делилась на два визита и два
// счёта (на dev — все 12 случаев «одна регистрация — два счёта»).
//
// Стенд — тот же, что у wizard-booking.test.mjs: поддельный DOM, а за
// поддельным fetch — настоящий реестр RPC и настоящая SQLite после миграций
// (calendar_slots считает настоящий slot-engine). Врач НЕ работает в
// сегодняшний день недели — значит, сегодня у него нет ни одного окна при
// любом часе запуска, а ближайшее — завтра в 10:00.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (как в wizard-booking.test.mjs) ─────────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
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
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { reshape } = await import('../../../../server/routes/db.js');   // ревью-2 — связи (patient_categories) вложенными, как настоящий маршрут

let USER = { id: 1, role: 'registrar', extra_roles: [] };   // INVOICE_APPEND_V1 (ревью M1) — тест баланса идёт администратором
let DB = null;
const RPC = [];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    stampWriteBody(DB, body);
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'select') {
        const rows = reshape(DB.prepare(sql).all(...params), meta);
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { forgetSlots } = await import('../views/service-picker-modal.js');
const { nearestButtonText, manyDaysWarning } = await import('../views/pick-day.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const localDayOfIso = (iso) => isoOf(new Date(iso));

/**
 * todayOff — врач не работает в сегодняшний день недели (окон сегодня нет при
 * любом часе запуска); иначе — работает каждый день с from до to.
 * 21 — консультация (нужен врач), 22 — анализ (без врача), 23 — ЭКГ без врача,
 * но с единственным назначенным исполнителем (врач 7, «Услуги и ставки»).
 */
function seed({ todayOff = true, from = '10:00', to = '16:00' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const todayKey = WD[new Date().getDay()];
  const wh = {};
  for (const k of WD) wh[k] = { enabled: !(todayOff && k === todayKey), from, to };
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?,?)")
    .run(JSON.stringify(wh), JSON.stringify([{ service_id: 23, pct: 10 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, requires_doctor) VALUES (21,'Консультация терапевта',100000,30,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  db.prepare("INSERT INTO services (id, name, price, requires_doctor) VALUES (23,'ЭКГ',50000,0)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return db;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const overlay = () => document.body.children.find(isWizard);
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));

async function openWizard(presetServiceIds) {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds });
  await flush(20); await wait(80); await flush(20);   // autoPickSlot → calendar_slots (настоящий)
  assert.ok(overlay(), 'мастер визита не открылся');
}

/** «Далее / Сформировать счёт» — как человек: выключенную кнопку браузер не нажимает. */
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = overlay();
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs))
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(80); await flush(30);
}

test('нет времени сегодня: у строки врача нет дня, красная пометка, «Ближайшее: …» — завтра 10:00; дальше не пройти', async () => {
  seed();
  await openWizard([21]);
  const ov = overlay();
  assert.ok(textOf(ov).includes('Сегодня у врача нет свободного времени'), 'нет красной пометки: ' + textOf(ov).slice(0, 400));
  const near = byAttr(ov, 'data-pick-nearest', 21);
  assert.ok(near, 'нет кнопки «Ближайшее»');
  assert.equal(textOf(near).replace(/\s+/g, ' ').trim(), nearestButtonText(isoOf(dayOffset(1)), 10 * 60));
  assert.ok(byAttr(ov, 'data-pick-day', 21), 'нет кнопки «Выбрать день»');
  assert.ok(textOf(ov).includes('сегодня у врача нет свободного времени — выберите день или уберите услугу'), 'шаг не говорит, почему дальше нельзя');
  await pressUntilCreate();
  assert.ok(!RPC.some((c) => c.name === 'ensure_visit'), 'строка без дня ушла в запись');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, 0, 'визит заведён молча на другой день');
});

test('«Ближайшее» ставит строке завтрашний слот — и визит записывается на завтра 10:00', async () => {
  seed();
  await openWizard([21]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  const start = new Date(ev.body.book.start);
  assert.equal(isoOf(start), isoOf(dayOffset(1)));
  assert.deepEqual([start.getHours(), start.getMinutes()], [10, 0]);
});

test('смета на два дня — «Услуги на 2 дня → 2 визита, 2 счёта»; «Всё на один день» сводит анализ к дню приёма: один визит, один счёт', async () => {
  seed();
  await openWizard([21, 22]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  const box = byAttr(overlay(), 'data-many-days', 2);
  assert.ok(box, 'нет предупреждения о двух днях');
  assert.ok(textOf(box).includes(manyDaysWarning(2)), textOf(box));
  assert.equal(manyDaysWarning(2), 'Услуги на 2 дня → 2 визита, 2 счёта');
  const one = byAttr(box, 'data-one-day');
  assert.ok(one, 'нет кнопки «Всё на один день»');
  one.click();
  await flush(20);
  assert.ok(!byAttr(overlay(), 'data-many-days'), 'предупреждение осталось — строки не сведены');
  await pressUntilCreate();
  const evs = RPC.filter((c) => c.name === 'ensure_visit');
  assert.equal(evs.length, 1, 'визитов больше одного: ' + JSON.stringify(evs.map((e) => e.body.date)));
  assert.equal(localDayOfIso(evs[0].body.date), isoOf(dayOffset(1)), 'визит не на день приёма');
  const inv = RPC.filter((c) => c.name === 'create_invoice_for_visit');
  assert.equal(inv.length, 1, 'счетов больше одного');
  assert.equal(inv[0].body.visit_service_ids.length, 2);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 3').get().n, 1);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1);
});

test('«Выбрать день» открывает календарь врача: выбранный день ставит время, пометка уходит', async () => {
  seed();
  await openWizard([21]);
  const pick = walk(overlay()).filter((n) => n.attrs && n.attrs['data-pick-day'] === '21');
  assert.ok(pick.length, 'нет кнопки «Выбрать день»');
  pick[0].click();   // кнопка в строке каталога — первая
  await wait(80); await flush(20);
  const pop = walk(overlay()).find((n) => n.style && n.style.width === '252px' && n.style.display === '');
  assert.ok(pop, 'календарь врача не открылся');
  const tomorrow = dayOffset(1);
  if (tomorrow.getMonth() !== new Date().getMonth()) {   // завтра — уже следующий месяц
    walk(pop).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === '›').click();
    await wait(80); await flush(20);
  }
  // Кнопка дня: первая строка — число месяца, вторая — «N окн».
  const dayBtn = walk(pop).find((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs)
    && n.children[0] && textOf(n.children[0]).trim() === String(tomorrow.getDate()));
  assert.ok(dayBtn, 'в календаре нет завтрашнего дня с окнами');
  dayBtn.click();
  await flush(20);
  assert.ok(!byAttr(overlay(), 'data-no-today'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи');
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(tomorrow));
});

test('время сегодня есть — берётся сегодняшнее; на другой день строка сама не уходит никогда', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  await openWizard([21]);
  const ov = overlay();
  if (textOf(ov).includes('Сегодня у врача нет свободного времени')) {
    // Часы клиники на сегодня уже кончились: окон нет — и строка без дня, а не на завтра.
    await pressUntilCreate();
    assert.ok(!RPC.some((c) => c.name === 'ensure_visit'));
    return;
  }
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(new Date()), 'время поставлено не на сегодня');
});

test('услуга без врача с единственным исполнителем остаётся сегодня — день врача ей не ставится', async () => {
  seed();   // врач 7 сегодня не работает; ЭКГ (23) назначена ему одному
  await openWizard([23]);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'услуге без врача не нужен день врача');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.ok(!ev.body.book, 'услуга без врача заняла время врача');
  assert.equal(localDayOfIso(ev.body.date), isoOf(new Date()), 'ЭКГ уехала на день врача');
});

// INVOICE_APPEND_V1 — у пациента сегодня визит с неоплаченным счётом (анализ):
// мастер добавляет ЭКГ в тот же визит, и сервер дописывает её в тот же счёт.
test('INVOICE_APPEND_V1: мастер — визит дня с неоплаченным счётом: ЭКГ в тот же счёт, тост «Добавлено в счёт № …»', async () => {
  seed();
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (3, ?, 'arrived', 1)").run(today.toISOString()).lastInsertRowid);
  const lab = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 22, 1, 40000, 40000, 'added', 1)").run(vid).lastInsertRowid);
  const first = getRpc('create_invoice_for_visit')(DB, { visit_id: vid, visit_service_ids: [lab] }, USER).invoice;
  await openWizard([23]);
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  const inv = DB.prepare('SELECT * FROM invoices').all();
  assert.equal(inv.length, 1, 'второй счёт за один визит: ' + JSON.stringify(inv.map((i) => [i.invoice_number, i.total_amount])));
  assert.equal(inv[0].id, first.id);
  assert.equal(inv[0].total_amount, 90000, 'анализ 40 000 + ЭКГ 50 000');
  assert.ok(TOASTS.some((t) => t.includes('Добавлено в счёт № ' + first.invoice_number + ' — новая сумма 90 000 сум')), 'нет фразы: ' + JSON.stringify(TOASTS));
});

// INVOICE_APPEND_V1 (ревью M1) — у пациента сегодня неоплаченный счёт (анализ),
// мастер добавляет ЭКГ и платит БАЛАНСОМ. В дописанный счёт «не больше сметы»
// легло бы частичной оплатой, и оплата отпустила бы в очередь и неоплаченный
// анализ. Теперь мастер просит новый счёт (append: false) и платит ровно его.
test('INVOICE_APPEND_V1 (ревью M1): мастер платит балансом — счёт НОВЫЙ, прежний не тронут, в очередь — только оплаченная ЭКГ', async () => {
  seed();
  const tok = DB.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;   // строки с деньгами пишет только сервер (мигр. 160)
  DB.prepare("INSERT INTO patient_deposits (patient_id, amount, status, kind) VALUES (3, 200000, 'received', 'credit')").run();
  DB.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(tok);
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (3, ?, 'arrived', 1)").run(today.toISOString()).lastInsertRowid);
  const lab = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 22, 1, 40000, 40000, 'added', 1)").run(vid).lastInsertRowid);
  const first = getRpc('create_invoice_for_visit')(DB, { visit_id: vid, visit_service_ids: [lab] }, USER).invoice;
  const was = USER;
  USER = { id: 1, role: 'admin', extra_roles: [] };   // баланс списывают касса и администратор
  try {
    await openWizard([23]);
    const label = walk(overlay()).find((n) => n.tagName === 'LABEL' && textOf(n).includes('Баланс: использовать'));
    assert.ok(label, 'нет «Баланс: использовать»');
    const chk = label.children.find((n) => n.tagName === 'INPUT');
    chk.checked = true;
    chk.dispatchEvent({ type: 'change', target: chk, currentTarget: chk });
    await pressUntilCreate();
    const call = RPC.find((c) => c.name === 'create_invoice_for_visit');
    assert.ok(call, 'счёт не выставлялся: ' + JSON.stringify(TOASTS));
    assert.equal(call.body.append, false, 'мастер не попросил новый счёт');
    const inv = DB.prepare('SELECT * FROM invoices ORDER BY id').all();
    assert.equal(inv.length, 2, 'ЭКГ дописана в неоплаченный счёт: ' + JSON.stringify(inv.map((i) => [i.invoice_number, i.total_amount, i.paid_amount])));
    assert.deepEqual([inv[0].id, inv[0].total_amount, inv[0].paid_amount, inv[0].status], [first.id, 40000, 0, 'unpaid'], 'прежний счёт тронут');
    assert.deepEqual([inv[1].total_amount, inv[1].paid_amount, inv[1].status], [50000, 50000, 'paid'], 'новый счёт оплачен не целиком');
    const st = (id) => DB.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
    assert.equal(st(lab), 'added', 'неоплаченный анализ ушёл в очередь');
    const ecg = DB.prepare('SELECT id FROM visit_services WHERE service_id = 23').get().id;
    assert.equal(st(ecg), 'queued');
    assert.equal(getRpc('deposit_balance')(DB, { patient_id: 3 }, USER).balance, 150000, 'с баланса списано не ровно за ЭКГ');
  } finally { USER = was; }
});

// INVOICE_APPEND_V1 (ревью-2) — СМЕТА НА ДВА ДНЯ У ПАЦИЕНТА ГРУППЫ: СКИДКА
// ГРУППЫ — КАЖДОМУ ДНЮ СВОЯ, А НЕ ДВАЖДЫ. VIP 10 %, анализ сегодня 40 000 +
// консультация на выбранный день 100 000: смета — скидка 14 000, к оплате
// 126 000. Мастер отдавал все 14 000 счёту первого дня, второму переносил
// остаток (0) — а сервер давал второму счёту его собственный пол группы
// (10 000): 14 000 + 10 000, пациент платил 116 000, клиника теряла 10 000.
// PICK_DAY_V1 сделал такие сметы обычными. Теперь процент — каждому дню свой
// (restTotal дня × процент = пол группы сервера), между днями переносится
// только сумма (скидка суммой, промокод), и смета показывает ровно то, что
// дадут счета.
const vipPatient = (pct = 10) => {
  const cat = DB.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(pct).lastInsertRowid;
  DB.prepare('UPDATE patients SET category_id = ? WHERE id = 3').run(cat);
};
/** Анализ (22) сегодня + консультация (21) на ближайший день врача — завтра. */
async function twoDayCart() {
  await openWizard([21, 22]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  assert.ok(byAttr(overlay(), 'data-many-days', 2), 'смета не на два дня');
}
/** Скидка суммой — как регистратор: переключатель «сум» и поле скидки. */
async function amountDiscount(sum) {
  const inp = walk(overlay()).find((n) => n.tagName === 'INPUT' && n.max === '100');
  assert.ok(inp, 'нет поля скидки');
  const btn = walk(overlay()).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'сум');
  assert.ok(btn, 'нет переключателя «сум»');
  btn.click();
  await flush(5);
  inp.value = String(sum);
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await flush(5);
}
const sentDiscounts = () => RPC.filter((c) => c.name === 'create_invoice_for_visit').map((c) => c.body.discount_amount);
const invoiceMoney = () => DB.prepare('SELECT subtotal, discount_amount, total_amount FROM invoices ORDER BY id').all().map((r) => [r.subtotal, r.discount_amount, r.total_amount]);

test('ревью-2: VIP 10 %, смета на два дня — скидка группы каждому дню своя: счета 36 000 + 90 000 = 126 000, как в смете', async () => {
  seed();
  vipPatient(10);
  await twoDayCart();
  const txt = textOf(overlay());
  assert.ok(txt.includes('−14 000 сум'), 'смета показывает не 14 000 скидки: ' + txt.slice(txt.indexOf('Скидка'), txt.indexOf('Скидка') + 300));
  assert.ok(txt.includes('126 000 сум'), 'смета — не 126 000 к оплате');
  await pressUntilCreate();
  assert.deepEqual(sentDiscounts(), [4000, 10000], 'в счета ушла не скидка своего дня');
  assert.deepEqual(invoiceMoney(), [[40000, 4000, 36000], [100000, 10000, 90000]], 'скидка группы дана дважды');
  assert.equal(invoiceMoney().reduce((s, m) => s + m[2], 0), 126000);
});

test('ревью-2: VIP 10 % на нецелые суммы — смета округляет скидку по дням, как уйдёт в счета (4 001 + 10 001), и равна сумме счетов', async () => {
  seed();
  vipPatient(10);
  DB.prepare('UPDATE services SET price = 40005 WHERE id = 22').run();
  DB.prepare('UPDATE services SET price = 100005 WHERE id = 21').run();
  await twoDayCart();
  const txt = textOf(overlay());
  assert.ok(txt.includes('−14 002 сум'), 'смета: скидка не по дням: ' + txt.slice(txt.indexOf('Скидка'), txt.indexOf('Скидка') + 300));
  assert.ok(txt.includes('126 008 сум'), 'смета — не 126 008 к оплате');
  await pressUntilCreate();
  assert.deepEqual(sentDiscounts(), [4001, 10001]);
  assert.deepEqual(invoiceMoney(), [[40005, 4001, 36004], [100005, 10001, 90004]]);
});

test('ревью-2: скидка суммой на смету в два дня переносится, как прежде (50 000: 40 000 первому дню, 10 000 второму)', async () => {
  seed();
  await twoDayCart();
  await amountDiscount(50000);
  assert.ok(textOf(overlay()).includes('−50 000 сум'), 'смета показывает не 50 000 скидки');
  await pressUntilCreate();
  assert.deepEqual(sentDiscounts(), [50000, 10000], 'перенос скидки суммой изменился');
  assert.deepEqual(invoiceMoney(), [[40000, 40000, 0], [100000, 10000, 90000]]);
});

test('ревью-2: VIP 10 % и скидка суммой 14 000 на два дня — 14 000 всего, пол группы второго дня не ложится сверху', async () => {
  seed();
  vipPatient(10);
  await twoDayCart();
  await amountDiscount(14000);
  assert.ok(textOf(overlay()).includes('−14 000 сум'), 'смета показывает не 14 000 скидки');
  await pressUntilCreate();
  assert.deepEqual(sentDiscounts(), [4000, 10000]);
  assert.deepEqual(invoiceMoney(), [[40000, 4000, 36000], [100000, 10000, 90000]], 'скидка вышла больше сметы');
});

test('ревью-2: смета на один день — как прежде (VIP 10 %, анализ + ЭКГ сегодня: одна скидка 9 000 со всей сметы)', async () => {
  seed();
  vipPatient(10);
  await openWizard([22, 23]);
  assert.ok(!byAttr(overlay(), 'data-many-days'), 'смета не на один день');
  assert.ok(textOf(overlay()).includes('−9 000 сум'));
  await pressUntilCreate();
  assert.deepEqual(sentDiscounts(), [9000]);
  assert.deepEqual(invoiceMoney(), [[90000, 9000, 81000]]);
});

test.after(() => { if (DB) DB.close(); DB = null; });
