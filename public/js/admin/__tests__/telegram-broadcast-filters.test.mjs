// TG_BROADCAST_FILTERS_V1 — окно «Сообщение пациентам» в поддельном DOM:
//   * две колонки: слева сообщение и картинка, справа «Кому» и «Получатели»;
//   * выпадающие списки заполняются справочниками telegram_broadcast_options;
//   * FIX_318_V1 (H2) — число получателей НЕ считается при открытии (этот
//     расчёт морозил сервер), а после изменения фильтра (с задержкой, одним
//     запросом с полным набором фильтров) или по кнопке; перед отправкой —
//     свежее число (fresh: true), мимо кэша сервера;
//   * «Сбросить фильтры» очищает всё и пересчитывает без условий.
//
// Fake-DOM harness — copied from __tests__/meta-settings-view.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.files=[];}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; if (k === 'disabled') this.disabled = true;} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){ if (this.parentNode) this.parentNode.removeChild(this); } select(){}
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
const body = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

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
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const byAttr = (root, k, v) => walk(root).filter((n) => k in n.attrs && (v === undefined || n.attrs[k] === v));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE_SETTLE_MS = 700;

// --- fake server -------------------------------------------------------------
const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const req = opts && opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body: req });
    let data;
    if (name === 'telegram_broadcast_options') data = {
      doctors: [{ id: 7, full_name: 'Врач Один', specialty: 'Терапевт' }],
      categories: [{ id: 2, name: 'VIP' }],
      branches: [{ id: 1, name: 'Главный' }, { id: 2, name: 'Филиал 2' }],
      service_types: [{ id: 2, name: 'Диагностика' }],
      services: [{ id: 501, name: 'УЗИ', type_id: 2 }],
    };
    else if (name === 'telegram_broadcast_preview') data = { count: 3, cards: 3, sample: [{ name: 'Алиев А.' }, { name: 'Каримов К.' }] };
    else data = {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { openBroadcastModal } = await import('../views/telegram-report.js');

test('окно открывается в две колонки, справочники заполняют списки; получатели при открытии не считаются', async () => {
  calls.length = 0;
  const overlay = openBroadcastModal({});
  await tick(DEBOUNCE_SETTLE_MS);
  assert.equal(byClass(overlay, 'tg-bc-main').length, 1, 'левая колонка');
  assert.equal(byClass(overlay, 'tg-bc-side').length, 1, 'правая колонка');
  const side = byClass(overlay, 'tg-bc-side')[0];
  const sideText = textOf(side);
  for (const label of ['Кому', 'Не приходил с', 'Врач', 'Тип услуги', 'Услуга', 'Категория пациента', 'Пол', 'Возраст от', 'Филиал', 'Только с неоплаченным счётом', 'Получатели']) {
    assert.ok(sideText.includes(label), 'в правой колонке есть «' + label + '»');
  }
  assert.ok(!textOf(byClass(overlay, 'tg-bc-main')[0]).includes('Приходил с'), 'фильтров в левой колонке нет');
  assert.ok(calls.some((c) => c.name === 'telegram_broadcast_options'), 'справочники запрошены');
  const doctorSel = byAttr(overlay, 'data-bc-filter', 'doctor_id')[0];
  assert.ok(doctorSel.children.some((o) => o.attrs.value === '7' && textOf(o).includes('Врач Один')), 'врач в списке');
  assert.ok(!calls.some((c) => c.name === 'telegram_broadcast_preview'), 'FIX_318_V1 (H2): при открытии сервер не считает получателей');
  assert.ok(sideText.includes('Число получателей появится, когда вы измените фильтр или нажмёте «Показать получателей».'), sideText.slice(-200));
  // По кнопке — сразу, без условий.
  const btn = walk(overlay).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Показать получателей'));
  btn.click();
  await tick(60);
  const first = calls.find((c) => c.name === 'telegram_broadcast_preview');
  assert.ok(first, 'по кнопке посчитано');
  assert.deepStrictEqual(first.body.filters, {}, 'без условий');
  assert.ok(!first.body.fresh, 'кнопка предпросмотра может взять число из кэша сервера');
  assert.ok(textOf(byClass(overlay, 'tg-bc-side')[0]).includes('Получателей: 3'));
  overlay.remove();
});

test('FIX_318_V1 (H2): «Отправить» сверяет свежее число (fresh: true) и отправляет с подтверждённым числом', async () => {
  calls.length = 0;
  const overlay = openBroadcastModal({});
  await tick(DEBOUNCE_SETTLE_MS);
  const ru = walk(overlay).find((n) => n.tagName === 'TEXTAREA');
  ru.value = 'Клиника работает до 18:00';
  const prevPrompt = globalThis.prompt;
  globalThis.prompt = () => '3';
  try {
    const send = walk(overlay).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Отправить'));
    send.click();
    await tick(80);
  } finally { globalThis.prompt = prevPrompt; }
  const previews = calls.filter((c) => c.name === 'telegram_broadcast_preview');
  assert.equal(previews.length, 1);
  assert.equal(previews[0].body.fresh, true, 'перед отправкой — мимо кэша');
  const sent = calls.find((c) => c.name === 'telegram_broadcast_send');
  assert.ok(sent, 'отправка ушла');
  assert.equal(sent.body.confirm_count, 3);
  overlay.remove();
});

test('изменение фильтров пересчитывает получателей с полным набором условий; «Сбросить фильтры» очищает всё', async () => {
  calls.length = 0;
  const overlay = openBroadcastModal({});
  await tick(DEBOUNCE_SETTLE_MS);
  calls.length = 0;
  const set = (name, v) => { const el = byAttr(overlay, 'data-bc-filter', name)[0]; assert.ok(el, name); el.value = v; el.dispatchEvent({ type: 'change' }); return el; };
  set('gender', 'female');
  set('category_id', '2');
  set('age_from', '18');
  set('age_to', '65');
  set('not_visited_since', '2026-06-01');
  set('doctor_id', '7');
  set('service_type_id', '2');
  set('branch_id', '2');
  const unpaid = byAttr(overlay, 'data-bc-filter', 'unpaid')[0];
  unpaid.checked = true; unpaid.dispatchEvent({ type: 'change' });
  await tick(DEBOUNCE_SETTLE_MS);
  const previews = calls.filter((c) => c.name === 'telegram_broadcast_preview');
  assert.equal(previews.length, 1, 'девять изменений — один пересчёт (с задержкой)');
  assert.deepStrictEqual(previews[0].body.filters, {
    not_visited_since: '2026-06-01', doctor_id: 7, service_type_id: 2, category_id: 2, branch_id: 2,
    gender: 'female', age_from: 18, age_to: 65, unpaid: true,
  });
  const reset = walk(overlay).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сбросить фильтры'));
  reset.click();
  await tick(DEBOUNCE_SETTLE_MS);
  const after = calls.filter((c) => c.name === 'telegram_broadcast_preview');
  assert.equal(after.length, 2);
  assert.deepStrictEqual(after[1].body.filters, {});
  assert.ok(!after[0].body.fresh && !after[1].body.fresh, 'живой счётчик — из кэша сервера');
  assert.equal(unpaid.checked, false);
  overlay.remove();
});
