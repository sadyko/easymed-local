// CLINIC_API_FIX_V1 (2026-10-06) — карточка сотрудника шлёт в public_profile
// только поля, которые стали не такими, какими карточка их открыла.
//
// Было: правка копилась по факту ВВОДА — поле, которое тронули и вернули как
// было, всё равно уходило. Врач тем временем правит то же поле в «Моём
// профиле», а администратор, открывший карточку раньше, сохраняет её — и
// возвращает врачу старый текст. Теперь уходит только отличие от открытого
// (тексты — без пробелов по краям, как их хранит сервер), а без отличий
// ключа public_profile в PATCH нет вовсе.
//
// Fake-DOM харнесс — тот же, что в employees-specialties-save.test.mjs, плюс
// значение <textarea> из её текста, как в браузере.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c); if (this.tagName === 'TEXTAREA' && c && c.nodeType === 3) this.value += c._t; return c;}
 removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);
   if (k === 'checked') this.checked = true;
   if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);}
 getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelectorAll(sel){const m=String(sel).match(/^(\w+)\[([\w-]+)(?:="([^"]*)")?\]$/);if(!m)return [];const out=[];
   const go=(e)=>{for(const c of e.children||[]){if(c.tagName===m[1].toUpperCase()&&(m[3]===undefined?(m[2] in (c.attrs||{})):(c.attrs||{})[m[2]]===m[3]))out.push(c);go(c);}};go(this);return out;}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
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
  easymed: { state: { user: { id: 2, role: 'admin', is_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const person = (id, username, extra = {}) => ({
  id, username, full_name: 'Каримов Алишер', last_name: 'Каримов', first_name: 'Алишер', middle_name: '',
  phone: '+998901112233', role: 'doctor', is_active: true, is_local: true, extra_roles: [],
  staff_type: 'doctor', is_doctor: true, specialty: 'Кардиолог', specialties: [{ slug: 'kardiolog', name: 'Кардиолог' }],
  service_rates: [], referral_rates: [], inpatient_rates: [], ...extra,
});
// Публичный профиль в том виде, в каком его отдаёт сервер (publicProfileOf):
// пустое — '' / null / [].
const PROFILE = {
  full_name_ru: 'Каримов Алишер', full_name_uz: 'Karimov Alisher', full_name_en: '',
  academic_title_ru: '', academic_title_uz: '', academic_title_en: '',
  bio_ru: 'Кардиолог, двенадцать лет практики.', bio_uz: 'Kardiolog.', bio_en: '',
  education_entries: [], experience_entries: [], certifications_entries: [], prof_dev_entries: [],
  experience_years: 12, instagram_url: '', telegram_url: '', photo_url: '',
};
const DOC = person(90, 'dr.karimov', { public_profile: PROFILE });
// Строка без public_profile (сервер его не прислал) — раздел открывается пустым.
const BARE = person(91, 'dr.bare', {});

const writes = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: [DOC, BARE] }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    let rows = [];
    if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар' }];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };

async function openCard(username) {
  document.body.children.length = 0;
  writes.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
  assert.ok(row, 'нет строки @' + username);
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function tab(card, label) {
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
}
async function openProfileTab(username) {
  const card = await openCard(username);
  await tab(card, 'Публичный профиль');
  const bio = tags(card, 'textarea');
  assert.equal(bio.length, 3, 'три поля биографии (RU / UZ / EN)');
  return {
    card,
    bio: { ru: bio[0], uz: bio[1], en: bio[2] },
    years: tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.max === '80'),
    input: (ph) => tags(card, 'input').find((i) => i.attrs.placeholder === ph),
  };
}
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
}
const onlyWrite = () => { assert.equal(writes.length, 1, 'карточка не ушла на сервер'); return writes[0].body; };

test('изменили только биографию UZ — public_profile = { bio_uz }', async () => {
  const s = await openProfileTab('dr.karimov');
  assert.equal(s.bio.uz.value, 'Kardiolog.', 'раздел открылся не с тем текстом');
  type(s.bio.uz, 'Kardiolog, o‘n ikki yillik tajriba.');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { bio_uz: 'Kardiolog, o‘n ikki yillik tajriba.' });
});

test('биографию RU правили и вернули как было, UZ изменили — уходит только bio_uz', async () => {
  const s = await openProfileTab('dr.karimov');
  type(s.bio.ru, 'Кардиолог');
  type(s.bio.ru, 'Кардиолог, двенадцать лет практики.');
  type(s.bio.uz, 'Kardiolog!');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { bio_uz: 'Kardiolog!' });
});

test('поля профиля трогали, но вернули (и с пробелом по краям) — ключа public_profile нет вовсе', async () => {
  const s = await openProfileTab('dr.karimov');
  type(s.bio.ru, 'x');
  type(s.bio.ru, 'Кардиолог, двенадцать лет практики. ');
  type(s.years, '');
  type(s.years, '12');
  type(s.input('https://instagram.com/…'), 'https://instagram.com/a');
  type(s.input('https://instagram.com/…'), '');
  await save(s.card);
  const body = onlyWrite();
  assert.ok(!('public_profile' in body), 'ушло без изменений: ' + JSON.stringify(body.public_profile));
});

test('раздел профиля не открывали — public_profile нет', async () => {
  const card = await openCard('dr.karimov');
  await tab(card, 'Занятость и зарплата');
  const salary = tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.placeholder === '0');
  type(salary, '3000000');
  await save(card);
  const body = onlyWrite();
  assert.equal(body.salary_fixed, 3000000);
  assert.ok(!('public_profile' in body), 'public_profile ушёл без правок');
});

test('стаж изменили — уходит только experience_years числом', async () => {
  const s = await openProfileTab('dr.karimov');
  type(s.years, '13');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { experience_years: 13 });
});

test('профиль с сервера не пришёл — пустой раздел ничего не стирает, правка одного поля шлёт только его', async () => {
  let s = await openProfileTab('dr.bare');
  type(s.bio.en, 'x');
  type(s.bio.en, '');
  await save(s.card);
  assert.ok(!('public_profile' in onlyWrite()), 'пустой раздел ушёл на сервер');

  s = await openProfileTab('dr.bare');
  type(s.input('https://t.me/…'), 'https://t.me/dr_bare');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { telegram_url: 'https://t.me/dr_bare' });
});
