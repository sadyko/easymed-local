// DISCOUNT_RATES_NEW_FORM_V1 (3.22.0, владелец 2026-11-08) — НОВЫЙ ПРОМОКОД СО СТАВКАМИ.
//
// Владелец: «creating a new discount won't apply the services discount». В окне
// «Добавить: Скидки и сертификаты» под «Только на эти услуги» — строка «Ставки по
// услугам — только у промокода с процентом скидки» и ни одной строки ставок; в окне
// «Изменить» у промокода с 10 % строки есть.
//
// Причина: новое окно открывается с пустым «Скидка, %», и правило ревью S5 L-2 (ставки —
// только у промокода С ПРОЦЕНТОМ) прятало пять групп ставок, как у подарочной карты или
// промокода суммой. Набранный процент строки возвращал (это проверено ниже), но окно об
// этом не говорило — строка звучала как запрет. Теперь у промокода без суммы ставки видны
// сразу; а записать ставки без процента нельзя — «Добавить» говорит, что указать (счёт
// ставок без процента не видит: promoRateSource, сервер и экраны).
//
// Здесь весь путь человека: «Добавить» → «Вид» = Промокод → «Скидка, %» = 10 (набором,
// и отдельно — только change/blur) → строки ставок видны → «Консультации» 100 % →
// «Добавить». Запись — через настоящий компилятор запросов и настоящую базу; потом тот
// же промокод — в мастере визита, без перезагрузки страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM: hidden отражается в атрибут, как в браузере ─────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false; this.parentElement = null;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentElement = null; return c; }
  get firstChild() { return this.children[0] || null; }
  get parentNode() { return this.parentElement; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'checked') this.checked = true;
  }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  get hidden() { return 'hidden' in this.attrs; }
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  fire(t) { this.dispatchEvent({ type: t, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
  click() { this.fire('click'); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
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
  if (e.tagName === 'TEMPLATE') { e.content = { firstChild: null }; Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); e.content.firstChild = s; }, get() { return ''; } }); }
  return e;
};
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null, confirm: () => true,
  easymed: { state: { user: { id: 1, full_name: 'Администратор', role: 'admin' } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.confirm = () => true;

const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join('');
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));
/** Видно ли человеку: ни сам узел, ни его предки не скрыты. */
const shown = (n) => { for (let x = n; x; x = x.parentElement) if (x.hidden || (x.style && x.style.display === 'none')) return false; return true; };
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// ─── настоящая база и компилятор за фальшивым fetch (как discount-rates-wizard) ─
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
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
    try { return ok(await handler(DB, body, ADMIN)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u !== '/api/db') return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
  stampWriteBody(DB, body);
  let compiled;
  try { compiled = compile(body, ADMIN); }
  catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
  const { sql, params, meta } = compiled;
  try {
    if (meta.op === 'select') {
      const rows = reshape(DB.prepare(sql).all(...params), meta);
      for (const r of rows) for (const c of meta.json || []) if (r && typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { /* как есть */ } }
      if (meta.single === 'single') return ok(rows[0]);
      if (meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    }
    if (meta.op === 'insert') {
      const info = DB.prepare(sql).run(...params);
      if (!meta.returning) return ok(null);
      const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
      return ok(meta.single ? row : [row]);
    }
    DB.prepare(sql).run(...params);
    return ok(null);
  } catch (e) {
    return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
  }
};

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function seed() {
  if (DB) DB.close();
  DB = openDb(':memory:');
  migrate(DB);
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '00:00', to: '23:59' };
  DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'adm','x','Администратор','admin',0,'')").run();
  DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  DB.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, requires_doctor) VALUES (21, 'Консультация терапевта', 100000, 'consultation', 30, 1)").run();
  DB.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22, 'Анализ крови', 40000, 'lab', 1, 0)").run();
}

const { renderLookupEditor } = await import('../views/settings-hub.js');

/** «Добавить» в «Скидках и сертификатах» — окно формы. */
async function openAdd() {
  document.body.children.length = 0;
  TOASTS.length = 0;
  const root = mk('div');
  await renderLookupEditor(root, 'patient_discounts', { embedded: true });
  await flush();
  const add = walk(root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary') && textOf(n).includes('Добавить'));
  assert.ok(add, 'нет кнопки «Добавить»');
  add.click();
  await flush();
  const modal = document.body.children.find((n) => String(n.className).split(/\s+/).includes('modal'));
  assert.ok(modal, 'окно «Добавить» не открылось');
  return modal;
}
/** Поле формы по началу подписи: обёртка .field — [label, control]. */
function control(modal, label) {
  const fld = walk(modal).find((n) => String(n.className).split(/\s+/).includes('field') && n.children[0] && n.children[0].tagName === 'LABEL'
    && textOf(n.children[0]).trim().startsWith(label));
  assert.ok(fld, 'нет поля «' + label + '»');
  return fld.children[1];
}
const rateRows = (modal) => byAttr(modal, 'data-rate-groups');
const offHint = (modal) => byAttr(modal, 'data-rates-off');
const saveBtn = (modal) => walk(modal).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary') && textOf(n).includes('Добавить'));
const savedRow = () => DB.prepare('SELECT name, kind, percent, discount_rates FROM patient_discounts ORDER BY id DESC').get();

async function createPromo({ typing }) {
  seed();
  const modal = await openAdd();
  // Снимок владельца: в пустом окне «Добавить» ставок не было — только строка-подсказка.
  assert.ok(rateRows(modal), 'в окне нет пяти групп ставок');
  assert.equal(shown(rateRows(modal)), true, 'новое окно: пяти групп ставок не видно (снимок владельца)');
  assert.equal(shown(offHint(modal)), false, 'новое окно: строка «только у промокода с процентом» вместо ставок');

  const name = control(modal, 'Название');
  name.value = 'Акция ноябрь'; name.fire('input'); name.fire('change');
  const kind = control(modal, 'Вид');
  kind.value = 'promo'; kind.fire('change');
  const pct = control(modal, 'Скидка, %');
  pct.value = '10';
  if (typing) pct.fire('input'); else pct.fire('change');

  assert.equal(shown(rateRows(modal)), true, 'промокод 10 %: строки ставок не появились');
  assert.equal(shown(offHint(modal)), false, 'промокод 10 %: подсказка «только у промокода с процентом» осталась');
  byAttr(modal, 'data-rate-quick', 'consultation:100').click();
  saveBtn(modal).click();
  await flush(20);
  assert.ok(!TOASTS.some((t) => /fail|ошиб|не удалось/i.test(t)), 'запись не прошла: ' + JSON.stringify(TOASTS));
  const row = savedRow();
  assert.ok(row, 'промокод не записан: ' + JSON.stringify(TOASTS));
  assert.equal(row.kind, 'promo');
  assert.equal(Number(row.percent), 10);
  assert.deepEqual(JSON.parse(row.discount_rates || '{}'), { g: { consultation: 100 } }, 'ставка «Консультации 100 %» не записана');
}

test('новый промокод: «Скидка, %» набирают (input) — строки ставок появляются, «Консультации 100 %» записана', async () => {
  await createPromo({ typing: true });
});

test('новый промокод: процент только change/blur (без input) — строки ставок появляются, ставка записана', async () => {
  await createPromo({ typing: false });
});

test('ставки без «Скидка, %» молча не записываются: «Добавить» называет, что указать; с процентом — записано', async () => {
  seed();
  const modal = await openAdd();
  const name = control(modal, 'Название');
  name.value = 'Консультации бесплатно';
  byAttr(modal, 'data-rate-quick', 'consultation:100').click();
  saveBtn(modal).click();
  await flush(20);
  assert.equal(savedRow(), undefined, 'промокод со ставками без процента записан — счёт ставок не увидит');
  assert.ok(TOASTS.includes('Ставки по услугам действуют вместе с процентом скидки: укажите «Скидка, %» — его получат остальные услуги.'),
    'нет объяснения: ' + JSON.stringify(TOASTS));
  assert.ok(document.body.children.includes(modal), 'окно закрылось — введённое пропало');
  const pct = control(modal, 'Скидка, %');
  pct.value = '20'; pct.fire('input');
  saveBtn(modal).click();
  await flush(20);
  const row = savedRow();
  assert.ok(row, 'с процентом не записан: ' + JSON.stringify(TOASTS));
  assert.equal(Number(row.percent), 20);
  assert.deepEqual(JSON.parse(row.discount_rates), { g: { consultation: 100 } });
});

test('подарочная карта, сертификат, промокод суммой — без ставок (строка-подсказка); снова промокод — ставки на месте', async () => {
  seed();
  const modal = await openAdd();
  const kind = control(modal, 'Вид');
  const amount = control(modal, 'Сумма скидки');
  const pct = control(modal, 'Скидка, %');
  byAttr(modal, 'data-rate-quick', 'lab:0').click();
  for (const k of ['gift_card', 'certificate']) {
    kind.value = k; kind.fire('change');
    assert.equal(shown(rateRows(modal)), false, k + ': ставки видны');
    assert.equal(shown(offHint(modal)), true, k + ': нет строки-подсказки');
  }
  kind.value = 'promo'; kind.fire('change');
  assert.equal(shown(rateRows(modal)), true, 'промокод: ставки не вернулись');
  amount.value = '50000'; amount.fire('input');
  assert.equal(shown(rateRows(modal)), false, 'промокод суммой: ставки видны');
  pct.value = '10'; pct.fire('input');
  assert.equal(shown(rateRows(modal)), true, 'промокод с процентом: ставок нет');
  amount.value = ''; amount.fire('input');
  assert.equal(shown(rateRows(modal)), true);
  assert.equal(byAttr(rateRows(modal), 'data-rate-group', 'lab').value, '0', 'ставка «Лаборатория 0 %» пропала при смене вида');
});

// ─── мелочи того же снимка ──────────────────────────────────────────────────
test('пустой выбор ссылки — по-русски: «— все —» у «Только для группы пациентов», «— не выбрано —» у прочих', async () => {
  seed();
  DB.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run();
  const modal = await openAdd();
  const cat = control(modal, 'Только для группы пациентов');
  await flush(20);
  assert.equal(textOf(cat.children[0]), '— все —');
  assert.ok(cat.children.some((o) => textOf(o) === 'VIP'), 'группы не загрузились');
  document.body.children.length = 0;
  const root = mk('div');
  await renderLookupEditor(root, 'beds', { embedded: true });
  await flush();
  walk(root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')).click();
  const bedModal = document.body.children.find((n) => String(n.className).split(/\s+/).includes('modal'));
  const ward = control(bedModal, 'Палата');
  assert.equal(textOf(ward.children[0]), '— не выбрано —', 'до загрузки списка');
  await flush(20);
  assert.equal(textOf(ward.children[0]), '— не выбрано —', 'после загрузки списка');
  assert.ok(!walk(bedModal).some((n) => /— none —/.test(n._t || '')), 'английское «— none —» в русском окне');
});

test('поле ставки «%»: подсказка помещается («—»), смысл — во всплывающей подписи; одинаково у группы пациентов и промокода', async () => {
  const { discountRatesField, discountServicesField } = await import('../views/discount-service-picker.js');
  for (const el of [discountRatesField({}), discountServicesField([], undefined, { rates: {} })]) {
    const inp = byAttr(el, 'data-rate-group', 'consultation');
    assert.equal(inp.attrs.placeholder, '—', 'подсказка поля обрезается («по умо…»)');
    assert.equal(inp.attrs.title, 'Пусто — процент скидки по умолчанию');
  }
});

// ─── вторая сторона жалобы: новый промокод со ставками — в мастере визита сразу ─
// Без перезагрузки страницы: те же модули, что открывали настройки. Мастер читает
// скидки клиники при открытии (visit-wizard.js), сервер — строку промокода при счёте.
const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const wizard = () => document.body.children.find(isWizard);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = wizard();
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

test('новый промокод со ставками из окна «Добавить» — мастер визита (без перезагрузки) считает по ставкам: консультация 0, анализ −10 %', async () => {
  await createPromo({ typing: true });
  const promoId = DB.prepare('SELECT id FROM patient_discounts ORDER BY id DESC').get().id;
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { forgetSlots } = await import('../views/service-picker-modal.js?v=ownrep4');
  forgetSlots();
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds: [21, 22] });
  await flush(20); await wait(80); await flush(20);
  assert.ok(wizard(), 'мастер визита не открылся');
  if (textOf(wizard()).includes('Сегодня у врача нет свободного времени')) { byAttr(wizard(), 'data-pick-nearest', 21).click(); await flush(20); }
  const sel = walk(wizard()).find((n) => n.tagName === 'SELECT' && n.attrs['data-discount-choice'] !== undefined);
  assert.ok(sel, 'нет выбора скидки');
  const opt = sel.children.find((o) => textOf(o).includes('Акция ноябрь'));
  assert.ok(opt, 'нового промокода нет в выборе: ' + JSON.stringify(sel.children.map((o) => textOf(o))));
  assert.equal(textOf(opt).trim(), 'Промокод «Акция ноябрь» — по услугам (по умолчанию 10%)');
  sel.value = opt.attrs.value;
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await flush(5);
  assert.ok(textOf(wizard()).includes('36 000 сум'), 'смета — не 36 000 к оплате (консультация 0, анализ 36 000)');
  await pressUntilCreate();
  const calls = RPC.filter((c) => c.name === 'create_invoice_for_visit');
  assert.ok(calls.length >= 1, 'счёт не выставлен: ' + JSON.stringify(TOASTS));
  assert.ok(calls.every((c) => c.body.discount_choice === 'promo' && Number(c.body.discount_id) === Number(promoId)), 'выбор — не новый промокод: ' + JSON.stringify(calls.map((c) => c.body)));
  assert.deepEqual(DB.prepare('SELECT service_id, discount_amount, discount_rate FROM invoice_items ORDER BY service_id').all().map((r) => [r.service_id, r.discount_amount, r.discount_rate]),
    [[21, 100000, 100], [22, 4000, 10]]);
});

test.after(() => { if (DB) DB.close(); DB = null; });
