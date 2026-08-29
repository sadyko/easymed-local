// BRANCH_IDENTITY_V1 — что карточка «Синхронизация филиалов» РИСУЕТ, а не что
// она решает. Решения проверяет branch-sync-logic.test.mjs (чистые функции, без
// DOM); здесь проверяется провод между решением и экраном, потому что именно
// провод и был оборван: becomeMainState существовать могла бы и раньше — блок
// «Этот филиал — главный» всё равно рисовался безусловно.
//
// ОДНО СВОЙСТВО НА ВЕСЬ ФАЙЛ: кнопка «Сделать главным филиалом» есть ровно там,
// где сервер её примет. Установке, которая уже является филиалом (буква принята
// и отменить её нельзя), и установке, которая не смогла прочитать свою
// служебную запись, branch_sync_make_key отказывает ВСЕГДА — а кнопка, которую
// показали и которая всегда отказывает, хуже отсутствующей: владелец нажимает,
// читает отказ и идёт искать свою ошибку там, где её нет.
//
// Fake-DOM harness — тот же, что в __tests__/settings-hub-groups.test.mjs
// (оттуда же и пин localStorage 'admin.lang'='ru' ДО импорта экрана: i18n.js
// выбирает язык один раз, при загрузке модуля, и все русские утверждения ниже
// держатся на этом).

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin' } } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');

// Единственный вызов, который делает эта карточка в состоянии «не связаны»:
// список филиалов грузится только у главного филиала.
let status = null;
globalThis.fetch = async (url) => {
  const name = String(url).replace('/api/rpc/', '');
  if (name === 'branch_sync_status') return { ok: true, json: async () => ({ data: status }) };
  throw new Error('экран не должен звать ' + name + ' в этом состоянии');
};

const { renderBranchSyncCard } = await import('../views/branch-sync.js');

async function paint(st) {
  status = st;
  const container = mk('div');
  await renderBranchSyncCard(container);
  return textOf(container);
}

const BUTTON = 'Сделать главным филиалом';
const PAIR = 'Подключить к главному';

test('новой установке кнопку «сделать главным» показывают', async () => {
  // Обычный случай, ради которого блок и существует: миграция 080 ставит
  // identity_role = 'main', пары ещё нет.
  const text = await paint({ role: 'none', identity_role: 'main', letter: 'A', suggested_url: '10.0.0.5:8000' });
  assert.ok(text.includes(BUTTON), 'кнопка обязана быть: сервер её примет');
  assert.ok(text.includes('Адрес этого компьютера'), 'поле адреса живёт вместе с кнопкой');
  assert.ok(text.includes(PAIR));
});

test('ОТВЯЗАННОМУ ФИЛИАЛУ КНОПКИ НЕТ — сервер откажет ей всегда', async () => {
  // «Отвязать» стирает файл пары и НЕ трогает принятую букву: она напечатана на
  // карточках пациентов. Установка выглядит несвязанной (role: 'none') и при
  // этом навсегда остаётся филиалом C, а branch_sync_make_key отвечает ей
  // identity_is_branch — сколько бы раз её ни нажали.
  const text = await paint({ role: 'none', identity_role: 'secondary', letter: 'C', suggested_url: '10.0.0.5:8000' });
  assert.ok(!text.includes(BUTTON), 'кнопки, которая всегда отказывает, на экране быть не должно');
  assert.ok(!text.includes('Адрес этого компьютера'), 'поле адреса существует ради этой кнопки');
  assert.ok(text.includes('Эта установка — филиал'), 'вместо кнопки — объяснение');
  assert.ok(text.includes('C-26-00042'), 'и буква объяснена номером, который видит регистратура');
  // ЛЕКАРСТВО ОСТАЁТСЯ НА ЭКРАНЕ: связаться заново ключом с той же буквой —
  // единственное, что этой установке доступно.
  assert.ok(text.includes(PAIR));
});

test('установке, потерявшей служебную запись, кнопки тоже нет, и сказано почему', async () => {
  // identity_role: null — статус не смог прочитать branch_identity (строку
  // удалили, база повреждена). Сервер в этом состоянии отказывает кодом
  // identity_missing, поэтому кнопки нет и здесь; но состояние ОТДЕЛЬНОЕ, а не
  // «филиал»: филиалу помогает ключ подключения, а тут — только восстановление
  // базы, и фраза обязана вести туда.
  const text = await paint({ role: 'none', identity_role: null, letter: null, suggested_url: '10.0.0.5:8000' });
  assert.ok(!text.includes(BUTTON));
  assert.ok(text.includes('Установка не знает своего филиала'));
  assert.match(text, /Восстановите базу из резервной копии/);
  assert.match(text, /регистрировать пациентов/, 'та же запись держит и регистратуру');
  assert.ok(!text.includes('Эта установка — филиал'), 'это не филиал — это неизвестность');
  // Ключ БЕЗ буквы базу не трогает и связывает как прежде, так что блок
  // подключения здесь мёртвой кнопкой не становится и остаётся на экране.
  assert.ok(text.includes(PAIR));
});
