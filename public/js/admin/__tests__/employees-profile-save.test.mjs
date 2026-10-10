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
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this._shown=this._t;this.children.length=0;}   // DOCTOR_PROFILE_V1 — _shown: текст тоста (таймер toast() ложится в _t)
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
const YEAR = new Date().getFullYear();   // DOCTOR_PROFILE_V1
const DOC = person(90, 'dr.karimov', { public_profile: PROFILE, branch_id: 1, scheduling_mode: 'schedulable', is_public: false, booking_days: 14, show_queue_count: false });
// Строка без public_profile (сервер его не прислал) — раздел открывается пустым.
const BARE = person(91, 'dr.bare', {});
// DOCTOR_PROFILE_V1 — показываемый врач без специальности, его филиал скрыт с сайта.
const PUB = person(92, 'dr.pub', { specialty: '', specialties: [], is_public: true, branch_id: 2, public_profile: { ...PROFILE } });
// DOCTOR_PROFILE_V1 — показываемый врач открытого филиала.
const SHOWN = person(93, 'dr.shown', { is_public: true, branch_id: 1, public_profile: { ...PROFILE } });
// DOCTOR_PROFILE_V1 — ответ doctor_public_preview (rpc/doctor-public.js).
const PREVIEW = {
  doctor_id: 90, scheduling_mode: 'schedulable', booking_days: 14, show_queue_count: false, slot_minutes: 15,
  days: [
    { date: '2026-10-12', weekday: 'mon', windows: [{ start: '09:00', free: true }, { start: '09:15', free: false }, { start: '09:30', free: true }] },
    { date: '2026-10-13', weekday: 'tue', windows: [] },
  ],
  hours: { mon: ['09:00', '09:45'], tue: null },
  queue_now: 3,
  consultations: [
    { consultation_type_id: 5, api_kind: 'initial', name: { ru: 'Первичный приём', uz: '', en: '' }, price: 150000, own: true, empty: false, minutes: 30 },
    { consultation_type_id: 6, api_kind: 'repeat', name: { ru: 'Повторный приём', uz: '', en: '' }, price: 0, own: true, empty: false, minutes: 15 },
    { consultation_type_id: 7, api_kind: '', name: { ru: 'Онлайн-консультация', uz: '', en: '' }, price: 120000, own: false, empty: false, minutes: 30 },
    // решение владельца 13 — строка врача с пустой ценой: партнёры получат 0
    { consultation_type_id: 8, api_kind: '', name: { ru: 'Консультация по анализам', uz: '', en: '' }, price: 0, own: true, empty: true, minutes: 20 },
  ],
  services: [{ service_id: 501, name: { ru: 'Консультация невролога', uz: '', en: '' }, price: 120000, own: false, online: true }],
  initial_minutes: 30,
};

const writes = [];
const uploads = [];   // DOCTOR_PROFILE_V1 — файлы фото в хранилище
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: [DOC, BARE, PUB, SHOWN] }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/rpc/doctor_public_preview') return { ok: true, json: async () => ({ data: PREVIEW }) };
  if (u.startsWith('/api/storage/')) { uploads.push(u); return { ok: true, json: async () => ({}) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    let rows = [];
    if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар', show_public: 1 }, { id: 2, name: 'Юнусабад', show_public: 0 }];
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
  uploads.length = 0;   // DOCTOR_PROFILE_V1
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
    since: tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.min === '1940'),   // DOCTOR_PROFILE_V1 — «Работает врачом с»
    name: Object.fromEntries(['ru', 'uz', 'en'].map((l) => [l, tags(card, 'input').find((i) => String(i.attrs.id || '').startsWith('cpf-dpp-fio-' + l))])),
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
  type(s.since, '');
  type(s.since, String(YEAR - 12));
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

test('DOCTOR_PROFILE_V1: «работает врачом с» — из прежнего стажа; изменили — уходит practice_since числом; стаж на сайте пересчитан', async () => {
  const s = await openProfileTab('dr.karimov');
  assert.equal(s.since.value, String(YEAR - 12));
  assert.match(textOf(s.card), /Стаж на сайте, лет: 12\./);
  type(s.since, String(YEAR - 13));
  assert.match(textOf(s.card), /Стаж на сайте, лет: 13\./);
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { practice_since: YEAR - 13 });
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

// ===========================================================================
// DOCTOR_PROFILE_V1 — «Публичный профиль» по макету: показ, заполненность,
// фото, «нет перевода», языки.
// ===========================================================================
// Харнесс: toast() держит таймер в el._t, поэтому текст тоста — в _shown.
const toastText = () => { const t = document.body.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop(); return t ? t._shown : ''; };
const switchOf = (card) => tags(card, 'button').find((b) => b.attrs.role === 'switch');
const langBtn = (card, label) => tags(card, 'button').find((b) => b.className === 'dpp-lang' && textOf(b).trim() === label);

test('DOCTOR_PROFILE_V1: показ — администратор включает, уходит is_public; заполненность называет, чего не хватает', async () => {
  const s = await openProfileTab('dr.karimov');
  const sw = switchOf(s.card);
  assert.equal(sw.attrs['aria-checked'], 'false');
  assert.match(textOf(s.card), /Профиль заполнен на 71%: не хватает — ФИО EN, биография EN\./);
  sw.click();
  assert.equal(sw.attrs['aria-checked'], 'true');
  assert.equal(toastText(), 'Врач будет виден. Пустые переводы партнёры покажут на русском.');
  await save(s.card);
  const body = onlyWrite();
  assert.equal(body.is_public, true);
  assert.ok(!('public_profile' in body), 'показ — не поле профиля');
});

test('DOCTOR_PROFILE_V1: без ФИО на русском врача не показать — «Сначала заполните ФИО», переключатель на месте', async () => {
  const s = await openProfileTab('dr.bare');
  const sw = switchOf(s.card);
  sw.click();
  assert.equal(sw.attrs['aria-checked'], 'false');
  assert.equal(toastText(), 'Сначала заполните ФИО');
});

test('DOCTOR_PROFILE_V1: показываемый без специальности — сохранение держится, ошибка у специальностей', async () => {
  const s = await openProfileTab('dr.pub');
  type(s.bio.en, 'Cardiologist.');
  await save(s.card);
  assert.equal(writes.length, 0, 'ушло на сервер без специальности');
  assert.match(textOf(s.card), /Чтобы показывать врача, выберите специальность\./);
});

test('DOCTOR_PROFILE_V1: ФИО на русском стёрли — «Введите ФИО на русском.», не уходит', async () => {
  const s = await openProfileTab('dr.karimov');
  type(s.name.ru, '');
  await save(s.card);
  assert.equal(writes.length, 0);
  assert.match(textOf(s.card), /Введите ФИО на русском\./);
});

test('DOCTOR_PROFILE_V1: «нет перевода» — у пустых UZ / EN ФИО и биографии; у степени — нет', async () => {
  const s = await openProfileTab('dr.karimov');
  const marks = walk(s.card).filter((n) => n.className === 'cpf-miss' && !n.hidden);
  assert.equal(marks.length, 2, 'ФИО EN и биография EN');
});

test('DOCTOR_PROFILE_V1: языки приёма — уходят списком; последний язык не снимается', async () => {
  const s = await openProfileTab('dr.karimov');
  langBtn(s.card, 'RU').click();
  langBtn(s.card, 'UZ').click();
  langBtn(s.card, 'RU').click();
  langBtn(s.card, 'UZ').click();
  assert.equal(toastText(), 'Нужен хотя бы один язык');
  assert.equal(langBtn(s.card, 'UZ').attrs['aria-pressed'], 'true');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { languages: ['uz'] });
});

test('DOCTOR_PROFILE_V1: фото из карточки — файл в папку врача, в PATCH — photo_url', async () => {
  const s = await openProfileTab('dr.karimov');
  const file = tags(s.card, 'input').find((i) => i.attrs.type === 'file');
  file.dispatchEvent({ type: 'change', target: { files: [new File(['jpeg'], 'portret.jpg', { type: 'image/jpeg' })] } });
  await flush();
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].startsWith('/api/storage/doctor-photos/doctors/90/'), uploads[0]);
  await save(s.card);
  assert.ok(onlyWrite().public_profile.photo_url.startsWith('/api/storage/doctor-photos/doctors/90/'));
});

test('DOCTOR_PROFILE_V1: филиал врача скрыт с сайта — карточка говорит, что партнёры его не увидят', async () => {
  const s = await openProfileTab('dr.pub');
  assert.match(textOf(s.card), /Филиал врача скрыт с сайта/);
});
