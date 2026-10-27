// META_LEADS_V1_VIEW — экран «Meta: заявки из рекламы» в поддельном DOM:
//   * без токена — предупреждение «Токен не задан», поле токена, инструкция;
//   * с подключением — страница, формы с галочками, выключатель опроса;
//   * таблица последних заявок с итогом и этапом CRM;
//   * «Проверить и сохранить токен» зовёт meta_connect с введённым токеном и
//     после успеха токена на экране нет.
//
// Fake-DOM harness — copied from __tests__/settings-hub-fold.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; if (k === 'disabled') this.disabled = true;} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.confirm = () => true;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byTag = (root, tag) => walk(root).filter((n) => n.tagName === tag.toUpperCase());
const byAttr = (root, k) => walk(root).filter((n) => k in n.attrs);

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- fake server -------------------------------------------------------------
const TOKEN = 'EAAGTESTONLYtokenForView01';
const EMPTY = { enabled: false, token_set: false, token_tail: '', page_id: '', page_name: '', token_checked_at: null, token_expires_at: null,
  forms_mode: 'all', forms: [], poll_minutes: 2, since_ts: 0, last_poll_at: null, last_ok_at: null, last_error: '', updated_at: null };
const CONNECTED = { ...EMPTY, enabled: true, token_set: true, token_tail: 'w01', page_id: '777', page_name: 'Клиника Нур', token_checked_at: '2026-10-16T09:00:00Z',
  forms: [{ id: 'f1', name: 'Консультация', status: 'ACTIVE', leads_count: 12, selected: true }, { id: 'f2', name: 'УЗИ', status: 'ARCHIVED', leads_count: 3, selected: false }],
  last_poll_at: '2026-10-16T09:10:00Z', last_ok_at: '2026-10-16T09:10:00Z' };
const LEADS = [
  { id: 2, leadgen_id: 'L2', form_name: 'Консультация', platform: 'ig', created_time: '2026-10-16T09:05:00+0000', received_at: '2026-10-16T09:10:00Z', full_name: 'Азиз Каримов', phone: '+998901234567', email: '', status: 'created', error: '', crm_request_id: 41, crm_stage_label: 'В обработке' },
  { id: 1, leadgen_id: 'L1', form_name: 'УЗИ', platform: 'fb', created_time: '2026-10-15T12:00:00+0000', received_at: '2026-10-15T12:02:00Z', full_name: 'Без карточки', phone: '', email: '', status: 'error', error: 'boom', crm_request_id: null, crm_stage_label: '' },
];
let settings = { ...EMPTY };
const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body });
    let data;
    if (name === 'meta_settings_get') data = settings;
    else if (name === 'meta_leads_recent') data = settings.token_set ? LEADS : [];
    else if (name === 'meta_connect') { settings = { ...CONNECTED, enabled: false }; data = { ok: true, page: { id: '777', name: 'Клиника Нур' }, pages: [{ id: '777', name: 'Клиника Нур' }], forms: CONNECTED.forms, settings }; }
    else if (name === 'meta_settings_save') { settings = { ...settings, ...body }; data = settings; }
    else if (name === 'meta_poll_now') data = { settings, created: 1, merged: 0, errors: 0 };
    else if (name === 'licence_status') data = { state: 'ok', locked: false, modules: ['crm'] };
    else data = {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderMetaSettings } = await import('../views/meta-settings.js');
const { setLicence } = await import('../licence.js');
setLicence({ state: 'ok', locked: false, reason: null, days_left: 22, modules: ['crm'], clinic_name: 'Нур', clinic_id: 'c-1' });

async function mount(nav = []) {
  const root = mk('div');
  await renderMetaSettings(root, { onNavigate: (...a) => nav.push(a) });
  await tick(60);
  return root;
}

test('без токена: предупреждение, поле токена, инструкция; кнопка «Проверить связь» выключена', async () => {
  settings = { ...EMPTY };
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('Токен не задан'), text.slice(0, 300));
  assert.ok(text.includes('Как получить токен'));
  assert.ok(text.includes('leads_retrieval'), 'в инструкции названы права токена');
  const pw = byTag(root, 'input').find((i) => i.attrs.type === 'password');
  assert.ok(pw, 'поле токена — password');
  const test = byTag(root, 'button').find((b) => textOf(b).includes('Проверить связь'));
  assert.ok(test && test.disabled === true, 'без токена проверять нечего');
  assert.ok(text.includes('Заявок из рекламы пока нет'));
});

test('«Проверить и сохранить токен» зовёт meta_connect с токеном; после — страница, формы с галочками, токена на экране нет', async () => {
  settings = { ...EMPTY };
  calls.length = 0;
  const root = await mount();
  const pw = byTag(root, 'input').find((i) => i.attrs.type === 'password');
  pw.value = '  ' + TOKEN + ' ';
  const save = byTag(root, 'button').find((b) => textOf(b).includes('Проверить и сохранить токен'));
  save.click();
  await tick(80);
  const c = calls.find((x) => x.name === 'meta_connect');
  assert.ok(c, 'meta_connect вызван');
  assert.strictEqual(c.body.token, TOKEN, 'токен обрезан по краям');
  const text = textOf(root);
  assert.ok(text.includes('Клиника Нур'), 'имя страницы на экране');
  assert.ok(!text.includes(TOKEN), 'токен на экране не остаётся');
  assert.ok(text.includes('…w01'), 'хвост сохранённого токена подписан');
  const rows = byAttr(root, 'data-form-id');
  assert.deepStrictEqual(rows.map((r) => r.attrs['data-form-id']), ['f1', 'f2']);
  const cbs = rows.map((r) => byTag(r, 'input')[0]);
  assert.deepStrictEqual(cbs.map((cb) => cb.checked), [true, false], 'галочки форм — как сохранено');
  assert.ok(text.includes('в архиве'), 'состояние формы по-русски');
  assert.ok(text.includes('Токен сохранён, опрос выключен'));
});

test('подключено и включено: статус «Подключено», таблица заявок с итогом и этапом CRM, кнопка ведёт в CRM', async () => {
  settings = { ...CONNECTED };
  const nav = [];
  const root = await mount(nav);
  const text = textOf(root);
  assert.ok(text.includes('Подключено · страница «Клиника Нур»'), text.slice(0, 400));
  const rows = byAttr(root, 'data-leadgen-id');
  assert.deepStrictEqual(rows.map((r) => r.attrs['data-leadgen-id']), ['L2', 'L1']);
  assert.ok(textOf(rows[0]).includes('Азиз Каримов') && textOf(rows[0]).includes('Создана карточка'));
  assert.ok(textOf(rows[1]).includes('Ошибка') && textOf(rows[1]).includes('boom'));
  const toCrm = byTag(rows[0], 'button')[0];
  assert.ok(toCrm && textOf(toCrm).includes('В обработке'));
  toCrm.click();
  assert.deepStrictEqual(nav, [['crm']]);
});

test('выключатель «Забирать заявки» сохраняется сразу; «Проверить сейчас» зовёт meta_poll_now', async () => {
  settings = { ...CONNECTED };
  calls.length = 0;
  const root = await mount();
  const cb = byAttr(root, 'data-meta-enabled')[0];
  assert.ok(cb && cb.checked === true, 'выключатель найден и включён');
  cb.checked = false;
  cb.dispatchEvent({ type: 'change' });
  await tick(60);
  const saved = calls.find((x) => x.name === 'meta_settings_save');
  assert.ok(saved && saved.body.enabled === false, 'выключение ушло на сервер сразу');
  settings = { ...CONNECTED };
  const root2 = await mount();
  const now = byTag(root2, 'button').find((b) => textOf(b).includes('Проверить сейчас'));
  now.click();
  await tick(80);
  assert.ok(calls.some((x) => x.name === 'meta_poll_now'), 'meta_poll_now вызван');
});
