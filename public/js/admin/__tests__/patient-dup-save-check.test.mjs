// PATIENT_DUP_RULE_V3 — проверка дубля ПРИ СОХРАНЕНИИ карты (data.js savePatient →
// findDuplicateCandidates; её ответ — окно «Возможно, пациент уже есть» с «Это он»)
// и второй список «Дубликатов» в картотеке говорят об одном и том же «возможном»:
//   • тот же телефон и та же дата рождения при другом имени — «same phone + DOB»;
//   • то же ФИО и та же дата рождения при любом телефоне — «same name + DOB»
//     (прямой выборкой по дате, а не только из пула «две буквы фамилии» на 60 строк);
//   • мусорная дата рождения и мусорный телефон ничего не находят;
//   • причины в окне — словами экрана, а не кодами.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 focus(){} blur(){} remove(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}}
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
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  easymed: { state: { user: { id: 3, full_name: 'Регистратор', role: 'registrar' } } },
  CLINIC: { id: 'c-1' }, confirm: () => true,
};
globalThis.location = globalThis.window.location;
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.MutationObserver = class { observe(){} disconnect(){} };

// Картотека, по которой отвечает фальшивый /api/db: eq и ilike 'xx%' — как сервер.
let PATIENTS = [];
let poolMisses = false;   // пул «две буквы фамилии/имени» переполнен чужими — нужной карты в нём нет
const selects = [];
let inserted = 0;
const matches = (row, f) => {
  const v = row[f.col] == null ? '' : String(row[f.col]);
  if (f.op === 'eq') return v === String(f.val);
  if (f.op === 'ilike') return v.toLowerCase().startsWith(String(f.val).replace(/%$/, '').toLowerCase());
  return true;
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/rpc/')) return ok({ data: null });
  if (u.startsWith('/api/db')) {
    if (body.op === 'insert') { inserted++; return ok({ data: { id: 900, ...body.values } }); }
    if (body.table !== 'patients') return ok({ data: [], count: 0 });
    selects.push(body);
    const filters = body.filters || [];
    if (poolMisses && filters.some((f) => f.op === 'ilike')) return ok({ data: [], count: 0 });
    const rows = PATIENTS.filter((r) => filters.every((f) => matches(r, f)));
    return ok({ data: JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const { savePatient } = await import('../data.js');
const { dupReasonLabel } = await import('../views/patient-create-modal.js');
const { setLang } = await import('../i18n.js');

const row = (id, last, first, phone, dob, middle = '') => ({ id, mrn: 'A-26-' + id, full_name: [last, first, middle].filter(Boolean).join(' '),
  last_name: last, first_name: first, middle_name: middle, phone, date_of_birth: dob, national_id: '' });

async function trySave(payload) {
  inserted = 0; selects.length = 0;
  try {
    await savePatient({ gender: 'm', ...payload });
    return { saved: inserted === 1 };
  } catch (e) {
    return { err: e };
  }
}

test('случай владельца при сохранении: тот же телефон и та же дата рождения при другом имени — «Возможно, уже есть»', async () => {
  PATIENTS = [row(102, 'Sardor', 'Alimov', '+998977654321', '1991-04-23')];
  poolMisses = false;
  const r = await trySave({ last_name: 'ТЕст 2', first_name: 'Тест 2', phone: '+998977654321', date_of_birth: '1991-04-23' });
  assert.ok(r.err, 'карта сохранилась без вопроса о дубле');
  assert.equal(r.err.code, 'DUPLICATE_PATIENT');
  assert.equal(r.err.existing[0].id, 102);
  assert.ok(r.err.existing[0]._reasons.includes('same phone + DOB'), 'причина не та: ' + r.err.existing[0]._reasons);
});

test('тот же телефон, другое имя и ДРУГАЯ дата — семья, карта сохраняется (как прежде)', async () => {
  PATIENTS = [row(102, 'Sardor', 'Alimov', '+998977654321', '1991-04-23')];
  const r = await trySave({ last_name: 'Sardorova', first_name: 'Malika', phone: '+998977654321', date_of_birth: '2015-02-01' });
  assert.ok(r.saved, 'семья на общем номере остановлена как дубль: ' + (r.err && r.err.message));
});

test('мусорная дата рождения или мусорный телефон «телефон + дата» не находят', async () => {
  PATIENTS = [row(102, 'Sardor', 'Alimov', '+998977654321', '1900-01-01'), row(103, 'Ali', 'Vali', '000000000', '1991-04-23')];
  let r = await trySave({ last_name: 'Other', first_name: 'Person', phone: '+998977654321', date_of_birth: '1900-01-01' });
  assert.ok(r.saved, 'заглушка 1900-01-01 сочла людей одним человеком');
  r = await trySave({ last_name: 'Other', first_name: 'Person', phone: '000000000', date_of_birth: '1991-04-23' });
  assert.ok(r.saved, 'номер-заглушка 000000000 сочёл людей одним человеком');
});

test('то же ФИО и та же дата при другом телефоне — находится прямой выборкой по дате, даже когда пул по имени её не захватил', async () => {
  PATIENTS = [row(301, 'Эргашев', 'Жахонгир', '+998977001122', '1990-04-01', 'Анварович')];
  poolMisses = true;
  try {
    const r = await trySave({ last_name: 'эргашев', first_name: 'ЖАХОНГИР', phone: '+998977003344', date_of_birth: '1990-04-01' });
    assert.ok(r.err && r.err.code === 'DUPLICATE_PATIENT', 'тёзка с той же датой не найден');
    assert.deepEqual(r.err.existing[0]._reasons, ['same name + DOB']);
    assert.ok(selects.some((b) => (b.filters || []).some((f) => f.col === 'date_of_birth' && f.op === 'eq' && f.val === '1990-04-01')),
      'выборки по дате рождения не было');
    // Разные отчества у обеих — разные люди.
    const r2 = await trySave({ last_name: 'Эргашев', first_name: 'Жахонгир', middle_name: 'Бахтиёрович', phone: '+998977003344', date_of_birth: '1990-04-01' });
    assert.ok(r2.saved, 'разные отчества сочтены одним человеком');
  } finally { poolMisses = false; }
});

test('найдено и по имени, и по дате — вторая метка «то же ФИО» не добавляется', async () => {
  PATIENTS = [row(301, 'Эргашев', 'Жахонгир', '+998977001122', '1990-04-01')];
  const r = await trySave({ last_name: 'Эргашев', first_name: 'Жахонгир', phone: '+998977003344', date_of_birth: '1990-04-01' });
  assert.ok(r.err);
  const why = r.err.existing[0]._reasons;
  assert.ok(why.includes('name matches') && why.includes('DOB matches'), 'поиск по имени перестал работать: ' + why);
  assert.ok(!why.includes('same name + DOB'), 'метка повторяет то же самое: ' + why);
});

test('причины в окне дубля — словами экрана на трёх языках', () => {
  setLang('ru');
  assert.equal(dupReasonLabel('same phone + DOB'), 'тот же телефон и дата рождения');
  assert.equal(dupReasonLabel('same name + DOB'), 'то же ФИО и дата рождения');
  assert.equal(dupReasonLabel('same phone + name'), 'тот же телефон и имя');
  assert.equal(dupReasonLabel('name ~ 2 char diff'), 'отличий в имени: 2');
  assert.equal(dupReasonLabel('что-то новое'), 'что-то новое', 'неизвестная причина показывается как есть');
  setLang('uz');
  assert.ok(!/[Ѐ-ӿ]/.test(dupReasonLabel('same phone + DOB')), 'кириллица в узбекской причине');
  setLang('en');
  assert.equal(dupReasonLabel('same name + DOB'), 'same full name and date of birth');
  setLang('ru');
});
