// SERVICE_EDITOR_FRESH_ROW_V1 (3.23.0, поток G) — РЕДАКТОР УСЛУГИ ПРАВИТ СВЕЖУЮ
// СТРОКУ ИЗ БАЗЫ, А НЕ ТУ, ЧТО ЕМУ ПЕРЕДАЛИ.
//
// Владелец: «please check the applied price changes in the service settings not
// applying or not saving». Редактор (views/service-editor.js) строил поля из
// переданной строки `row` и при сохранении слал ВСЕ поля цены по счёту визита
// (пустое — null) через service_save, а сервер пишет их как прислано. Значит:
//   • строка без колонок цен визита (частичная) — блок «Цена по счёту визита»
//     открывается ПУСТЫМ (снимок 70), и сохранение ЛЮБОГО другого поля
//     (название, цена, длительность) СТИРАЕТ сохранённые цены второго и
//     повторного визита;
//   • устаревшая строка (список загружен до правки в другой вкладке или у
//     другого администратора, тихая перезагрузка после сохранения не прошла) —
//     редактор показывает старые цены визита и сохранением возвращает их.
// Теперь редактор, открытый на существующей услуге, сам читает её строку по id.
//
// Стенд — НЕ заглушка: фальшивый fetch пропускает вызовы экрана через настоящий
// компилятор /api/db и настоящий реестр RPC на SQLite в памяти, прошедшей миграции
// (как wizard-booking.test.mjs и discount-choice-wizard.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── крошечный DOM (как в services-catalog.test.mjs) ────────────────────────
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; this.checked = false; this.disabled = false; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren(...cs) { this.children.length = 0; for (const c of cs) if (c) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'disabled') this.disabled = true; }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { if (e.type === 'click' && this.disabled) return false; for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} scrollTo() {} select() {}
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
  const el = new F(t);
  // <select>: значение — отмеченный вариант (как у браузера), пока его не задали руками.
  if (el.tagName === 'SELECT') {
    let own = null;
    Object.defineProperty(el, 'value', {
      get() {
        if (own !== null) return own;
        const opts = el.children.filter((o) => o.tagName === 'OPTION');
        const sel = opts.find((o) => 'selected' in o.attrs) || opts[0];
        return sel ? (sel.attrs.value ?? '') : '';
      },
      set(v) { own = String(v); },
      configurable: true,
    });
  }
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const toastEl = {
  dataset: {}, _t: null, setAttribute() {},
  classList: { add() {}, remove() {}, contains() { return false; } },
  set textContent(v) { TOASTS.push(String(v)); },
  get textContent() { return TOASTS[TOASTS.length - 1] || ''; },
};
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null),
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов (прогон с force-en меняет только navigator).
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: null } }, CLINIC: { id: 1 }, scrollY: 0, scrollTo() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const flush = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// ─── настоящая база + настоящий реестр за фальшивым fetch ───────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { reshape } = await import('../../../../server/routes/db.js');

const ADMIN = { id: 1, role: 'admin', extra_roles: [], is_admin: true, full_name: 'Администратор' };
let USER = ADMIN;
let DB = null;
const RPC = [];
let FAIL_SERVICE_READ = false;

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
    if (FAIL_SERVICE_READ && body.table === 'services' && body.op === 'select') {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'Service unavailable' } }) };
    }
    let compiled;
    try { compiled = compile(body, USER); }
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
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};

const { openServiceEditor } = await import('../views/service-editor.js?v=rh1');
const { renderServices } = await import('../views/services.js');

// ─── посев: услуга владельца со снимка — 80 000, второй 20 000 (3–5 дн.), повторный 10 000 (6–10 дн.)
let SVC_ID = null;   // id услуги владельца в свежей базе (миграции кладут свой демо-каталог)
const SVC_NAME = 'Вторичная консультация невролога';
const TIER = { price_secondary: 20000, secondary_days_from: 3, secondary_days_to: 5, price_repeat: 10000, repeat_days_from: 6, repeat_days_to: 10 };
const TIER_KEYS = Object.keys(TIER);
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Администратор','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Регистратор','registrar')").run();
  SVC_ID = getRpc('service_save')(db, { name: SVC_NAME, type: 'consultation', price: 80000, duration_minutes: 30, requires_doctor: false, performers: [], ...TIER }, ADMIN).id;
  if (DB) DB.close();
  DB = db;
  return db;
}
const stored = () => DB.prepare(`SELECT name, price, duration_minutes, ${TIER_KEYS.join(', ')} FROM services WHERE id = ?`).get(SVC_ID);

const editorCard = () => walk(document.body).find((n) => String(n.className).split(/\s+/).includes('svc-ed'));
/** Поля блока «Цена по счёту визита» по подсказке (порядок как на экране). */
function tierInputs() {
  const card = editorCard();
  assert.ok(card, 'редактор услуги не открылся');
  const ins = tags(card, 'input');
  const byPh = (ph) => ins.filter((i) => i.attrs.placeholder === ph);
  const [repFrom, repTo] = byPh('как у 2-го');
  return {
    price_secondary: byPh('как первый')[0],
    secondary_days_from: ins.find((i) => i.attrs.placeholder === '1' && i.attrs.step === '1'),
    secondary_days_to: byPh('без предела')[0],
    price_repeat: byPh('как второй')[0],
    repeat_days_from: repFrom,
    repeat_days_to: repTo,
  };
}
const shownTier = () => Object.fromEntries(Object.entries(tierInputs()).map(([k, el]) => [k, el ? el.value : undefined]));
const asShown = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v == null ? '' : String(v)]));
const nameInput = () => tags(editorCard(), 'input').find((i) => i.attrs.placeholder === 'напр. Приём кардиолога');
const priceInput = () => tags(editorCard(), 'input').find((i) => i.attrs.step === '0.01' && i.attrs.min === '0' && !['как первый', 'как второй'].includes(i.attrs.placeholder) && i.attrs.max === undefined);
const saveButton = () => tags(editorCard(), 'button').find((b) => textOf(b).includes('Сохранить'));
const typeInto = (el, v) => { el.value = String(v); el.dispatchEvent({ type: 'input', target: el, currentTarget: el }); };

async function open(row, extra = {}) {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  let saved = 0;
  await openServiceEditor({ row, readOnly: false, onSaved: () => { saved++; }, ...extra });
  await flush();
  return { saved: () => saved };
}
async function save() {
  saveButton().click();
  await flush(20);
}

// ═══════════════════════════════════════════════════════════════════════════
// Любой вызывающий: строка без колонок цен визита (частичная)
// ═══════════════════════════════════════════════════════════════════════════
test('частичная строка {id, name, price}: блок «Цена по счёту визита» показывает сохранённое из базы', async () => {
  seed();
  await open({ id: SVC_ID, name: 'Вторичная консультация невролога', price: 80000, type: 'consultation' });
  assert.deepEqual(shownTier(), asShown(TIER), 'цены визита не из базы — блок пуст, как на снимке 70');
});

test('частичная строка: сохранение после смены названия, цены и длительности НЕ стирает цены визита', async () => {
  seed();
  await open({ id: SVC_ID, name: 'Вторичная консультация невролога', price: 80000, type: 'consultation' });
  typeInto(nameInput(), 'Повторная консультация невролога');
  typeInto(priceInput(), '85000');
  const dur = tags(editorCard(), 'input').find((i) => i.attrs.min === '1' && i.attrs.type === 'number');
  typeInto(dur, '40');
  await save();
  assert.ok(TOASTS.includes('Услуга сохранена.'), 'не сохранено: ' + JSON.stringify(TOASTS));
  const row = stored();
  assert.deepEqual([row.name, row.price, row.duration_minutes], ['Повторная консультация невролога', 85000, 40]);
  for (const k of TIER_KEYS) assert.equal(row[k], TIER[k], k + ' стёрт сохранением другого поля');
});

// ═══════════════════════════════════════════════════════════════════════════
// Устаревшая строка: в базе уже другое (вторая вкладка, другой администратор)
// ═══════════════════════════════════════════════════════════════════════════
test('устаревшая строка со старыми ценами визита: редактор показывает свежее из базы, сохранение его не откатывает', async () => {
  seed();
  const old = { ...DB.prepare('SELECT * FROM services WHERE id = ?').get(SVC_ID), price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null, repeat_days_from: null, repeat_days_to: null };
  await open(old);
  assert.deepEqual(shownTier(), asShown(TIER), 'показаны цены визита из устаревшей строки');
  typeInto(nameInput(), 'Консультация невролога (повторная)');
  await save();
  const row = stored();
  assert.equal(row.name, 'Консультация невролога (повторная)');
  for (const k of TIER_KEYS) assert.equal(row[k], TIER[k], k + ' откачен устаревшей строкой');
});

test('новые цены визита сохраняются и видны при повторном открытии', async () => {
  seed();
  await open({ id: SVC_ID });
  const t = tierInputs();
  typeInto(t.price_secondary, '25000');
  typeInto(t.secondary_days_from, '2');
  typeInto(t.secondary_days_to, '6');
  typeInto(t.price_repeat, '0');
  typeInto(t.repeat_days_from, '7');
  typeInto(t.repeat_days_to, '14');
  await save();
  const want = { price_secondary: 25000, secondary_days_from: 2, secondary_days_to: 6, price_repeat: 0, repeat_days_from: 7, repeat_days_to: 14 };
  const row = stored();
  for (const k of TIER_KEYS) assert.equal(row[k], want[k], k);
  await open({ id: SVC_ID });
  assert.deepEqual(shownTier(), asShown(want), 'при повторном открытии — не то, что сохранено');
});

test('очистка цен визита: пустые поля уходят как «не задано» и такими же открываются', async () => {
  seed();
  await open({ id: SVC_ID });
  for (const el of Object.values(tierInputs())) typeInto(el, '');
  await save();
  const row = stored();
  for (const k of TIER_KEYS) assert.equal(row[k], null, k);
  await open({ id: SVC_ID });
  assert.deepEqual(shownTier(), asShown({ price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null, repeat_days_from: null, repeat_days_to: null }));
});

// ═══════════════════════════════════════════════════════════════════════════
// Отказ сервера по правилам цен визита — тост словами сервера, окно с вводом на месте
// ═══════════════════════════════════════════════════════════════════════════
test('отказ service_save («по день» раньше «со дня»): понятный тост, окно открыто, введённое на месте, база не тронута', async () => {
  seed();
  const h = await open({ id: SVC_ID });
  const t = tierInputs();
  typeInto(t.secondary_days_from, '5');
  typeInto(t.secondary_days_to, '2');
  await save();
  assert.ok(TOASTS.some((m) => m.includes('Окно второго визита: «по день» не может быть раньше «со дня».')), 'нет тоста с причиной: ' + JSON.stringify(TOASTS));
  assert.ok(!TOASTS.includes('Услуга сохранена.'));
  assert.equal(h.saved(), 0, 'onSaved позван при отказе');
  assert.ok(editorCard(), 'окно закрылось при отказе — введённое потеряно');
  assert.deepEqual([tierInputs().secondary_days_from.value, tierInputs().secondary_days_to.value], ['5', '2'], 'введённое пропало');
  assert.equal(saveButton().disabled, false, 'кнопка «Сохранить» осталась выключенной');
  const row = stored();
  for (const k of TIER_KEYS) assert.equal(row[k], TIER[k], k + ' изменён отказанным сохранением');
});

test('отказ «цена повторного визита без второго визита»: тост с причиной, окно открыто', async () => {
  seed();
  await open({ id: SVC_ID });
  const t = tierInputs();
  typeInto(t.price_secondary, '');
  typeInto(t.secondary_days_from, '');
  typeInto(t.secondary_days_to, '');
  typeInto(t.repeat_days_from, '');
  typeInto(t.repeat_days_to, '');
  await save();
  assert.ok(TOASTS.some((m) => m.startsWith('Цена повторного визита без цены второго визита')), JSON.stringify(TOASTS));
  assert.ok(editorCard(), 'окно закрылось при отказе');
});

// ═══════════════════════════════════════════════════════════════════════════
// Строку не прочитать — не открывать на правку вслепую
// ═══════════════════════════════════════════════════════════════════════════
test('строка услуги не прочиталась — окно на правку не открывается (иначе сохранение стёрло бы невидимое), тост', async () => {
  seed();
  FAIL_SERVICE_READ = true;
  try { await open({ id: SVC_ID, name: 'Вторичная консультация невролога', price: 80000, type: 'consultation' }); }
  finally { FAIL_SERVICE_READ = false; }
  assert.equal(editorCard(), undefined, 'окно открылось на непрочитанной услуге');
  assert.ok(TOASTS.includes('Не удалось загрузить услугу. Обновите страницу.'), JSON.stringify(TOASTS));
});

test('услуги уже нет в базе (удалили в другой вкладке) — окно не открывается, тост', async () => {
  seed();
  await open({ id: 999999, name: 'Удалённая услуга', price: 1000, type: 'consultation' });
  assert.equal(editorCard(), undefined);
  assert.ok(TOASTS.includes('Услуга не найдена — обновите список.'), JSON.stringify(TOASTS));
});

test('новая услуга (row = null) открывается как прежде, без чтения строки', async () => {
  seed();
  const before = RPC.length;
  await open(null);
  assert.ok(editorCard());
  assert.ok(textOf(editorCard()).includes('Новая услуга'));
  assert.deepEqual(shownTier(), asShown({ price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null, repeat_days_from: null, repeat_days_to: null }));
  assert.equal(RPC.length, before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Вызывающие openServiceEditor: «Услуги» (services.js) и «Настройки → Услуги» (section-crud.js)
// ═══════════════════════════════════════════════════════════════════════════
test('«Услуги» (services.js): список загружен ДО правки цен визита в другой вкладке — клик по строке показывает свежие цены, сохранение их держит', async () => {
  seed();
  // Цены визита ещё не заданы, когда открыт список.
  DB.prepare(`UPDATE services SET ${TIER_KEYS.map((k) => k + ' = NULL').join(', ')} WHERE id = ?`).run(SVC_ID);
  window.easymed.state.user = ADMIN;
  document.body.children.length = 0;
  const container = mk('div');
  await renderServices(container, {});
  const rowOf = () => tags(container, 'tr').find((r) => String(r.className).includes('row-click') && textOf(r).includes(SVC_NAME));
  for (let i = 0; i < 50 && !rowOf(); i++) await flush();
  const row = rowOf();
  assert.ok(row, 'строка услуги в списке');
  // Список на экране. Другая вкладка / другой администратор сохраняет цены визита.
  DB.prepare(`UPDATE services SET ${TIER_KEYS.map((k) => k + ' = @' + k).join(', ')} WHERE id = @id`).run({ ...TIER, id: SVC_ID });
  TOASTS.length = 0;
  row.click();
  await flush();
  assert.deepEqual(shownTier(), asShown(TIER), 'редактор открыт на устаревшей строке списка');
  typeInto(nameInput(), 'Вторичная консультация невролога (ред.)');
  await save();
  for (const k of TIER_KEYS) assert.equal(stored()[k], TIER[k], k + ' стёрт сохранением из списка');
});

test('«Настройки → Услуги» (section-crud.js) отдаёт редактору свою строку списка — редактор перечитывает её по id', () => {
  // section-crud.js читает список `select('*')` и передаёт строку как есть; правило
  // свежей строки живёт в самом редакторе (тесты выше — с частичной и устаревшей
  // строкой), поэтому здесь достаточно убедиться, что раздел зовёт тот же редактор.
  const crud = fs.readFileSync(path.join(HERE, '..', 'views', 'section-crud.js'), 'utf8');
  const call = crud.slice(crud.indexOf("if (state.sectionKey === 'services') {"), crud.indexOf("if (state.sectionKey === 'patients')"));
  assert.match(call, /openServiceEditor\(\{\s*row,/, 'раздел «Услуги» настроек открывает не единый редактор');
  const editor = fs.readFileSync(path.join(HERE, '..', 'views', 'service-editor.js'), 'utf8');
  assert.match(editor, /SERVICE_EDITOR_FRESH_ROW_V1/, 'нет метки правила свежей строки');
  // Других вызывающих нет: новый вызов обязан пройти через тот же редактор.
  const callers = [];
  for (const f of fs.readdirSync(path.join(HERE, '..', 'views'))) {
    if (!f.endsWith('.js') || f === 'service-editor.js') continue;
    if (/openServiceEditor\(/.test(fs.readFileSync(path.join(HERE, '..', 'views', f), 'utf8'))) callers.push(f);
  }
  assert.deepEqual(callers.sort(), ['section-crud.js', 'services.js'], 'появился новый вызывающий openServiceEditor — проверьте, что он передаёт строку с id');
});

// ═══════════════════════════════════════════════════════════════════════════
// Не-администратор: правит услуги только администратор (service_save)
// ═══════════════════════════════════════════════════════════════════════════
test('регистратор: «Услуги» открывают редактор на просмотр со свежими ценами визита, кнопки «Сохранить» нет; service_save — 403', async () => {
  seed();
  USER = { id: 2, role: 'registrar', extra_roles: [] };
  try {
    window.easymed.state.user = USER;
    document.body.children.length = 0;
    const container = mk('div');
    await renderServices(container, {});
    const rowOf = () => tags(container, 'tr').find((r) => String(r.className).includes('row-click') && textOf(r).includes(SVC_NAME));
    for (let i = 0; i < 50 && !rowOf(); i++) await flush();
    const row = rowOf();
    assert.ok(row, 'строка услуги в списке');
    row.click();
    await flush();
    assert.ok(textOf(editorCard()).includes('Просмотр услуги'));
    assert.deepEqual(shownTier(), asShown(TIER), 'цены визита не видны регистратору');
    assert.equal(saveButton(), undefined, 'у регистратора есть «Сохранить»');
    assert.ok(Object.values(tierInputs()).every((el) => el.disabled), 'поля цен визита не выключены');
    assert.throws(() => getRpc('service_save')(DB, { id: SVC_ID, name: 'x', type: 'consultation', price: 1, performers: [] }, USER), /только администратор/);
  } finally { USER = ADMIN; window.easymed.state.user = ADMIN; }
});

test.after(() => { if (DB) DB.close(); DB = null; });
