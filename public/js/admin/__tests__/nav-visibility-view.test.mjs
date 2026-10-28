// NAV_VISIBILITY_V1 — экран «Видимость разделов» на fake-DOM.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;} remove(){}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; if (k === 'disabled') this.disabled = true;} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 querySelector(sel){const cls=String(sel).replace(/^\./,'');const walk=(e)=>{for(const c of e.children){if(String(c.className).split(/\s+/).includes(cls))return c;const r=walk(c);if(r)return r;}return null;};return walk(this);} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){ const el = new F(t); if (el.tagName === 'TEMPLATE') { el.content = { firstChild: null }; Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } }); } return el; }
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage.setItem('admin.lang', 'ru');
const setCalls = [];
// FIX_318_V1 (B4) — подэкраны разделов, как их отдаёт оболочка (PARENT_OF в admin.js).
const SUBVIEWS = { patients: ['patient-card', 'appointments', 'registration', 'docs-archive'], admissions: ['case-file'] };
const NAV = [
  { section: 'Clinical' }, { id: 'patients', label: 'Patients', icon: 'Patients' }, { id: 'queue', label: 'Очередь', icon: 'Clock', foldsInto: 'patients' }, { id: 'admissions', label: 'Inpatient ward', icon: 'Bed' },
  { section: 'Operations', fold: true }, { id: 'crm', label: 'CRM · Заявки', icon: 'Headset' }, { id: 'referrals', label: 'Referrals', icon: 'Target' },
  { section: 'Settings', fold: true }, { id: 'settings', label: 'Settings', icon: 'Settings' },
];
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, easymed: { state: { user: { id: 1, role: 'admin' } }, NAV, setNavHidden: (l) => { setCalls.push(l); }, subViewsOf: (id) => SUBVIEWS[id] || [] }, confirm: () => true };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, name) => walk(root).filter((n) => name in n.attrs);
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
let toastMsg = null; const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const calls = [];
let hiddenOnServer = ['admissions'];
globalThis.fetch = async (url, opts) => {
  const u = String(url); const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const name = u.startsWith('/api/rpc/') ? u.slice('/api/rpc/'.length).split('?')[0] : null;
  calls.push({ name, body });
  if (name === 'nav_visibility_get') return { ok: true, json: async () => ({ data: { hidden: hiddenOnServer } }) };
  if (name === 'nav_visibility_save') { hiddenOnServer = body.hidden; return { ok: true, json: async () => ({ data: { hidden: body.hidden } }) }; }
  return { ok: true, json: async () => ({ data: {} }) };
};
const perms = await import('../permissions.js');
perms.setFullAccess('Администратор');
const { renderNavVisibility } = await import('../views/nav-visibility.js');

async function mount() { calls.length = 0; setCalls.length = 0; toastMsg = null; const root = mk('div'); await renderNavVisibility(root, {}); await tick(); return root; }
const toggle = (root, id) => byAttr(root, 'data-nav-toggle').find((n) => n.attrs['data-nav-toggle'] === id);

test('группы меню по-русски, каждый пункт — галочка; скрытый снят и помечен; «Настройки» — включены и заблокированы', async () => {
  const root = await mount();
  const t = textOf(root);
  assert.ok(t.includes('Видимость разделов'));
  for (const g of ['Клиника', 'Операции', 'Настройки']) assert.ok(t.includes(g), 'группа ' + g);
  for (const l of ['Пациенты', 'Стационар', 'CRM · Заявки', 'Реферирование']) assert.ok(t.includes(l), 'пункт ' + l);
  assert.strictEqual(toggle(root, 'admissions').checked, undefined, 'скрытый — без галочки');
  assert.ok(t.includes('скрыт'), 'подпись «скрыт» у стационара');
  const s = toggle(root, 'settings');
  assert.strictEqual(s.checked, true);
  assert.strictEqual(s.disabled, true, '«Настройки» скрыть нельзя');
  assert.ok(t.includes('всегда'));
  assert.ok(t.includes('вкладка внутри другого раздела'), 'подсказка у «Очереди» (foldsInto)');
  assert.ok(byAttr(root, 'data-nav-save')[0].disabled, 'без изменений сохранять нечего');
});

test('снятая галочка → сохранение шлёт полный список; оболочке сообщается новый список; «Показать все» очищает', async () => {
  const root = await mount();
  const crm = toggle(root, 'crm');
  crm.checked = false;
  crm.dispatchEvent({ type: 'change' });
  await tick();
  const save = byAttr(root, 'data-nav-save')[0];
  assert.ok(!save.disabled, 'есть изменения — кнопка живая');
  assert.ok(textOf(root).includes('Есть несохранённые изменения.'));
  save.click();
  await tick();
  const c = calls.find((x) => x.name === 'nav_visibility_save');
  assert.deepStrictEqual(c.body, { hidden: ['admissions', 'crm'] });
  assert.deepStrictEqual(setCalls, [['admissions', 'crm']], 'меню оболочки перерисовано сразу');
  assert.ok(String(toastMsg).includes('Сохранено'));

  const all = byAttr(root, 'data-nav-show-all')[0];
  all.click();
  await tick();
  byAttr(root, 'data-nav-save')[0].click();
  await tick();
  const c2 = calls.filter((x) => x.name === 'nav_visibility_save').pop();
  assert.deepStrictEqual(c2.body, { hidden: [] });
  assert.ok(textOf(root).includes('Скрыто разделов: 0'));
});

// FIX_318_V1 (B4) — «Пациенты» прячут не только список: карту пациента,
// регистрацию, «Регистратуру» и архив документов (PARENT_OF), и ссылки на них из
// CRM и блока «Звонит» открывают «Раздел скрыт». Экран обязан сказать это до
// сохранения, а не после.
test('FIX_318_V1: снятый раздел с подэкранами — предупреждение, что ещё скроется вместе с ним', async () => {
  hiddenOnServer = ['admissions'];   // тест выше сохранил пустой список
  const root = await mount();
  const warn = (id) => byAttr(root, 'data-nav-warn').find((n) => n.attrs['data-nav-warn'] === id);
  assert.ok(warn('admissions'), 'скрытый на сервере стационар без предупреждения о своих экранах');
  assert.ok(textOf(warn('admissions')).includes('История болезни'));
  assert.equal(warn('patients'), undefined, 'предупреждение у раздела, который не скрыт');
  assert.equal(warn('crm'), undefined, 'у раздела без подэкранов предупреждать не о чем');

  const p = toggle(root, 'patients');
  p.checked = false;
  p.dispatchEvent({ type: 'change' });
  await tick();
  const w = warn('patients');
  assert.ok(w, 'сняли «Пациентов» — предупреждения нет');
  for (const label of ['Карта пациента', 'Регистрация пациента', 'Регистратура', 'Документы']) {
    assert.ok(textOf(w).includes(label), 'в предупреждении не названо: ' + label + ' — ' + textOf(w));
  }
  assert.ok(textOf(w).includes('Раздел скрыт'), 'не сказано, что ссылки на эти экраны откроют заглушку');

  p.checked = true;
  p.dispatchEvent({ type: 'change' });
  await tick();
  assert.equal(warn('patients'), undefined, 'вернули галочку — предупреждение осталось');
});
