// VISIT_TIER_ATTENDED_V1 (доводка) — ОКНА «ВЫСТАВИТЬ СЧЁТ» ПОКАЗЫВАЮТ ЦЕНУ СЧЁТА.
//
// С 3.25.0 касса решает ярус невыставленной строки («второй» / «повторный»
// визит) заново в миг счёта: прошлый визит — только тот, на который пациент
// пришёл и который выставлен. Окна, из которых выставляют счёт на невыставленные
// строки визита, показывали ЗАПИСАННУЮ цену строки — и сумма в окне расходилась
// со счётом: «Выставить счёт · пациент» кассы (cashier-line-fix.js openRebill,
// из «Ждут счёта»), «Счёт и оплата» (visit-bill.js) и вкладка «Services» окна
// визита (visit-modal.js, «Generate invoice»). Теперь у невыставленной строки —
// цена, которую назвал сервер (cashier_line_tiers по visit_id, поле unbilled):
// ярус браузер не считает.
//
// Стенд не заглушка: фальшивый fetch пропускает вызовы через настоящий реестр
// RPC и SQLite в памяти после миграций (как picker-invoice.test.mjs), и сумма в
// окне сверяется с позицией счёта, который выставит настоящий
// create_invoice_for_visit. Даты — сдвигами от сегодняшнего местного дня.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (тот же стенд, что у picker-invoice.test.mjs) ────────────
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
  focus() {} blur() {} select() {} scrollTo() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return new F('div'); }
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const TOASTS = [];
const TOAST_EL = new F('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
  querySelectorAll() { return []; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { markBilled } = await import('../../../../server/test-helpers/billed-line.js');

const USER = { id: 9, role: 'cashier', extra_roles: [] };
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
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented: ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code || 'bad_request', message: e.message } }) }; }
  }
  if (u === '/api/db') {
    stampWriteBody(DB, body);
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'insert' && meta.returning) {
        const info = DB.prepare(sql).run(...params);
        const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
        return ok(meta.single ? row : [row]);
      }
      const rows = meta.op === 'select' ? reshape(DB.prepare(sql).all(...params), meta) : (DB.prepare(sql).run(...params), []);
      if (meta.single === 'single') return ok(rows[0]);
      if (meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const lineFix = await import('../views/cashier-line-fix.js');
const VB = await import('../views/visit-bill.js');
const VM = await import('../views/visit-modal.js');

const walk = (e, out = []) => { for (const c of (e && e.children) || []) { out.push(c); walk(c, out); } return out; };
const textOf = (e) => [e, ...walk(e)].map((n) => n._t || '').join(' ').replace(/[  ]/g, ' ');
const tick = async (ms = 60) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const chips = (root) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes('wzc-tier'));

// ─── посев ──────────────────────────────────────────────────────────────────
// Приём 100 000; второй визит 60 000 на 1–6 день. Пациент 3.
const PRICE = 100000, SECOND = 60000;
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Врачев','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (3,'Тестов Тест','P-3')").run();
  db.prepare(`INSERT INTO services (id, name, price, price_secondary, secondary_days_from, secondary_days_to)
              VALUES (30, 'Приём терапевта', ?, ?, 1, 6)`).run(PRICE, SECOND);
  if (DB) DB.close();
  DB = db;
  return db;
}
const dayAt = (offset, hour = 10) => DB.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' ' || printf('%02d', ?) || ':00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`, hour).t;
function visitWith(offset, { tier, unit }) {
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (3, 7, ?, 'arrived')").run(dayAt(offset)).lastInsertRowid);
  const vs = Number(DB.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier)
                                VALUES (?, 30, 7, 1, ?, ?, 'added', ?)`).run(vid, unit, unit, tier).lastInsertRowid);
  return { vid, vs };
}
/** Прошлый приём, на который пациент пришёл и который выставлен, `daysAgo` дней назад. */
const attendedBilled = (daysAgo) => { const p = visitWith(-daysAgo, { tier: 'primary', unit: PRICE }); markBilled(DB, p.vs); return p; };
const billedUnit = (vs) => DB.prepare('SELECT ii.unit_price u FROM invoice_items ii JOIN visit_services vs ON vs.invoice_item_id = ii.id WHERE vs.id = ?').get(vs);

// Два случая, в которых записанная цена строки — не цена счёта.
const CASES = [
  { name: 'записан «второй визит», прошлого выставленного визита нет', setup: () => visitWith(0, { tier: 'secondary', unit: SECOND }), want: PRICE, stale: SECOND, chip: false },
  { name: 'записан «первый визит», прошлый визит 3 дня назад был и выставлен', setup: () => { attendedBilled(3); return visitWith(0, { tier: 'primary', unit: PRICE }); }, want: SECOND, stale: PRICE, chip: true },
];
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

for (const c of CASES) {
  test(`«Выставить счёт · пациент» (касса, «Ждут счёта»): ${c.name} — в окне цена счёта ${money(c.want)}, и счёт выставлен по ней`, async () => {
    seed();
    const { vid, vs } = c.setup();
    document.body.children.length = 0; RPC.length = 0; TOASTS.length = 0;
    const visit = DB.prepare('SELECT * FROM visits WHERE id = ?').get(vid);
    await lineFix.openRebill({ visit_id: vid, visit_date: visit.visit_date, patient_name: 'Тестов Тест' },
      { title: 'Выставить счёт · Тестов Тест', preselectRefunded: false, patientId: 3 });
    await tick();
    const ov = document.body.children[document.body.children.length - 1];
    const row = walk(ov).find((e) => e.attrs && e.attrs['data-rebill-line'] === String(vs));
    assert.ok(row, 'строка не нарисована: ' + textOf(ov).slice(0, 300));
    // сумма строки — узел .num (зачёркнутая рядом цена первого визита — отдельный <s>)
    const amount = walk(row).find((e) => e.tagName === 'DIV' && e.className === 'num');
    assert.ok(amount, 'нет суммы строки: ' + textOf(row));
    assert.equal(textOf(amount).replace(/\s+/g, ' ').trim(), money(c.want) + ' сум', `в окне не цена счёта ${money(c.want)}: ` + textOf(row));
    assert.equal(chips(row).length, c.chip ? 1 : 0, 'чип «Второй визит» — только когда счёт выставит второй визит');
    const struck = walk(row).filter((e) => e.tagName === 'S').map((e) => textOf(e).trim());
    assert.deepEqual(struck, c.chip ? [money(PRICE)] : [], 'зачёркнута только цена первого визита у второго визита');
    const bill = walk(ov).find((e) => e.tagName === 'BUTTON' && /Выставить счёт и принять оплату/.test(textOf(e)));
    assert.ok(bill, 'нет кнопки счёта');
    bill.click();
    await tick(120);
    assert.ok(billedUnit(vs), 'счёт не выставлен: ' + TOASTS.join(' | '));
    assert.equal(billedUnit(vs).u, c.want, 'счёт — та же цена, что показало окно');
  });

  test(`«Счёт и оплата» (visit-bill.js): ${c.name} — у невыставленной строки цена счёта ${money(c.want)}`, async () => {
    seed();
    const { vid, vs } = c.setup();
    document.body.children.length = 0; RPC.length = 0; TOASTS.length = 0;
    VB.openVisitBillModal({ ...DB.prepare('SELECT * FROM visits WHERE id = ?').get(vid), patients: { full_name: 'Тестов Тест', mrn: 'P-3' } }, () => {});
    await tick(100);
    const ov = document.body.children[document.body.children.length - 1];
    const rows = walk(ov).filter((e) => e.tagName === 'TR' && /Приём терапевта/.test(textOf(e)));
    assert.equal(rows.length, 1, 'строка визита не нарисована: ' + textOf(ov).slice(0, 300));
    assert.ok(textOf(rows[0]).includes(money(c.want)), `не цена счёта: ` + textOf(rows[0]));
    assert.ok(!textOf(rows[0]).includes(money(c.stale)), `записанная цена: ` + textOf(rows[0]));
    const gen = walk(ov).find((e) => e.tagName === 'BUTTON' && /Выставить счёт/.test(textOf(e)));
    gen.click();
    await tick(120);
    assert.equal(billedUnit(vs).u, c.want, 'счёт — та же цена');
    const after = walk(document.body.children[document.body.children.length - 1]).filter((e) => e.tagName === 'TR' && /Приём терапевта/.test(textOf(e)));
    assert.ok(textOf(after[0]).includes(money(c.want)), 'выставленная строка — цена позиции счёта: ' + textOf(after[0]));
  });

  test(`окно визита, вкладка «Services» (visit-modal.js): ${c.name} — сумма строки и «selected» — цена счёта ${money(c.want)}`, async () => {
    seed();
    const { vid } = c.setup();
    document.body.children.length = 0; RPC.length = 0; TOASTS.length = 0;
    VM.openVisitModal({ visit: DB.prepare('SELECT * FROM visits WHERE id = ?').get(vid), patient: { id: 3, full_name: 'Тестов Тест' } });
    await tick(120);
    const ov = document.body.children[document.body.children.length - 1];
    const row = walk(ov).find((e) => e.tagName === 'TR' && /Приём терапевта/.test(textOf(e)));
    assert.ok(row, 'строка не нарисована: ' + textOf(ov).slice(0, 300));
    assert.ok(textOf(row).includes(money(c.want) + ' UZS'), 'сумма строки — не цена счёта: ' + textOf(row));
    // итог над таблицей: «N selected · …» или (ничего не отмечено) «Total …» — тоже по цене счёта
    assert.ok(new RegExp('(selected · |Total )' + money(c.want) + ' UZS').test(textOf(ov)), 'итог — не цена счёта: ' + textOf(ov).slice(0, 400));
    VM.closeActive();
  });
}

test('сервер не ответил на цены счёта (старый сервер) — окно «Выставить счёт» показывает записанную цену, как прежде', async () => {
  seed();
  const { vid, vs } = visitWith(0, { tier: 'secondary', unit: SECOND });
  const real = getRpc('cashier_line_tiers');
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('/api/rpc/cashier_line_tiers')
    ? { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented: cashier_line_tiers' } }) }
    : saved(url, opts));
  try {
    document.body.children.length = 0;
    await lineFix.openRebill({ visit_id: vid, visit_date: DB.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date, patient_name: 'Тестов Тест' }, {});
    await tick();
    const ov = document.body.children[document.body.children.length - 1];
    const row = walk(ov).find((e) => e.attrs && e.attrs['data-rebill-line'] === String(vs));
    assert.ok(row && textOf(row).includes(money(SECOND)), 'строка без ответа сервера — записанная цена: ' + (row ? textOf(row) : ''));
  } finally { globalThis.fetch = saved; }
  assert.equal(typeof real, 'function');
});

test.after(() => { if (DB) DB.close(); DB = null; });
