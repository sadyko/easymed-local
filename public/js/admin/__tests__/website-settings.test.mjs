// WEBSITE_V1, этап 2 — экран «Веб-сайт» (views/website-settings.js) и его
// подключение (плитка, маршрут, права, лицензия).
//
// Что закреплено:
//   * «Сайт включён» шлёт website_settings_save с настоящим boolean и ВЕСЬ объект
//     настроек, строка состояния берётся из ответа сервера (site.running/port),
//     «Открыть сайт» — только когда сайт работает;
//   * prev_updated_at: первое сохранение несёт метку из website_settings_get,
//     второе — метку, которую вернуло первое; отказ 409 — фраза сервера в тосте,
//     выключатель возвращается;
//   * «Просмотр» строки «Веб-сайт» — поля серые, кнопок «Сохранить» нет;
//   * вкладка «Врачи»: скрытые — с причиной по state, у показанных — «На главной»,
//     публикации и удаления нет, «Сбросить» — только при has_extras;
//   * вкладка «Услуги»: без поиска — только показанные, поиск — по всем;
//   * плитка «Веб-сайт» в «Коммерческих инструментах» настроек: администратору
//     видна, роли без строки «Веб-сайт» — нет; маршрут продаётся модулем `website`.
//
// Фейковая DOM — копия из __tests__/ai-assistant.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this._v=null;this._chk=null;this.disabled=false;this.parentNode=null;}
 appendChild(c){this.children.push(c);c.parentNode=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if(k==='value')this._v=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',target:this,currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 remove(){ if(this.parentNode) this.parentNode.removeChild(this); }
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get checked(){return this._chk===null?('checked' in this.attrs):this._chk;} set checked(v){this._chk=!!v;}
 get value(){return this._v===null?'':this._v;} set value(v){this._v=String(v);}
 get classList(){const s=this;return{
   contains:c=>String(s.className).split(/\s+/).includes(c),
   add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},
   remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x&&x!==c).join(' ');},
   toggle(c,on){if(on)this.add(c);else this.remove(c);},
 };}
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

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
// I18N_LOCALE_PIN_V1 — язык закреплён ДО импорта вида: i18n.js выбирает его один раз.
localStorage.setItem('admin.lang', 'ru');
globalThis.location = { hostname: 'clinic-pc' };
globalThis.window = {
  location: globalThis.location, localStorage: globalThis.localStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- фейковый сервер: /api/rpc/<имя> ----------------------------------------
const rpcAnswers = {};
const rpcCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const name = u.startsWith('/api/rpc/') ? u.slice('/api/rpc/'.length).split('?')[0] : '';
  let args = {};
  try { args = init.body ? JSON.parse(init.body) : {}; } catch { args = {}; }
  if (name) rpcCalls.push([name, args]);
  let a = rpcAnswers[name];
  if (typeof a === 'function') a = a(args);
  if (a && a.__error) return { ok: false, status: a.__status || 400, json: async () => ({ error: a.__error }) };
  return { ok: true, status: 200, json: async () => ({ data: a === undefined ? {} : a }) };
};
const callsOf = (name) => rpcCalls.filter(([n]) => n === name).map(([, a]) => a);

const { renderWebsiteSettings, __test } = await import('../views/website-settings.js');
const perms = await import('../permissions.js');
const { GROUPS } = await import('../views/settings-hub.js');
const { LICENSED_MODULES } = await import('../licensed-modules.js');
const { setLicence, isLicensed } = await import('../licence.js');

// Роль без полного доступа: настроенная, вошедший — не администратор.
function asRole(grants) {
  perms.setEffectiveFromRole({ name: 'Маркетолог', permissions: {
    sections: ['patients', 'settings'], levels: { patients: 'viewer', settings: 'viewer' }, grants,
  } });
  Object.assign(window.easymed.state.user, { role: 'registrar', is_super_admin: false });
  perms.setActorRoles(['registrar']);
}
function asAdmin() {
  Object.assign(window.easymed.state.user, { role: 'admin', is_super_admin: true });
  perms.setActorRoles(['admin']);
  perms.setFullAccess('Администратор');
}

async function mount(tab = 'general') {
  __test.state.tab = tab;
  const c = mk('div');
  await renderWebsiteSettings(c);
  await tick();
  return c;
}
const enabledBox = (root) => byAttr(root, 'data-ws-enabled')[0];

test('WEBSITE_V1: «Сайт включён» шлёт boolean и весь объект; состояние — из ответа сервера', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_settings_get = { settings: { default_lang: 'ru', contact: { phone: '+998 71 000' } }, updated_at: '2026-11-24T10:00:00.000Z', site: { running: false, port: 0 } };
  rpcAnswers.website_settings_save = { ok: true, updated_at: '2026-11-24T10:05:00.000Z', site: { running: true, port: 8001 } };
  const c = await mount();
  assert.ok(textOf(c).includes('Сайт выключен'));
  assert.equal(byAttr(c, 'data-ws-open').length, 0, 'сайт не работает — ссылки «Открыть сайт» нет');
  assert.ok(textOf(c).includes('Разрешить'), 'подсказка про вопрос Windows о порте');
  const box = enabledBox(c);
  assert.ok(!('disabled' in box.attrs));
  box.checked = true;
  box.dispatchEvent({ type: 'change' });
  await tick();
  const [args] = callsOf('website_settings_save');
  assert.strictEqual(args.settings.enabled, true, 'настоящий true, не строка и не 1');
  assert.equal(args.settings.contact.phone, '+998 71 000', 'уходит весь объект настроек');
  assert.equal(args.prev_updated_at, '2026-11-24T10:00:00.000Z', 'метка версии из website_settings_get');
  assert.ok(textOf(c).includes('Сайт работает: порт 8001'));
  const link = byAttr(c, 'data-ws-open')[0];
  assert.equal(link.attrs.href, 'http://clinic-pc:8001/ru/', 'адрес — имя этого компьютера, порт сайта, язык по умолчанию');

  // Выключение — настоящий false.
  rpcAnswers.website_settings_save = { ok: true, updated_at: '2026-11-24T10:06:00.000Z', site: { running: false, port: 0 } };
  const box2 = enabledBox(c);
  box2.checked = false;
  box2.dispatchEvent({ type: 'change' });
  await tick();
  const second = callsOf('website_settings_save')[1];
  assert.strictEqual(second.settings.enabled, false);
  assert.equal(second.prev_updated_at, '2026-11-24T10:05:00.000Z', 'вторая запись несёт метку, которую вернула первая');
  assert.ok(textOf(c).includes('Сайт выключен'));
});

test('WEBSITE_V1: включён, но слушателя нет — сказано словами, без ссылки', async () => {
  asAdmin();
  rpcAnswers.website_settings_get = { settings: { enabled: true }, updated_at: 'T1', site: { running: false, port: 0 } };
  const c = await mount();
  assert.ok(textOf(c).includes('Сайт включён, но не запущен'));
  assert.equal(byAttr(c, 'data-ws-open').length, 0);
});

test('WEBSITE_V1: «Сохранить» несёт prev_updated_at из прошлого сохранения; 409 — фраза сервера', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_settings_get = { settings: { enabled: false, langs: ['uz', 'ru', 'en'], default_lang: 'uz' }, updated_at: 'T1', site: { running: false, port: 0 } };
  rpcAnswers.website_settings_save = { ok: true, updated_at: 'T2', site: { running: false, port: 0 } };
  const c = await mount();
  byAttr(c, 'data-ws-save')[0].click();
  await tick();
  assert.equal(callsOf('website_settings_save')[0].prev_updated_at, 'T1');
  byAttr(c, 'data-ws-save')[0].click();
  await tick();
  assert.equal(callsOf('website_settings_save')[1].prev_updated_at, 'T2');

  const msg = 'Настройки сайта изменились в другом окне уже после того, как эта страница их прочитала. Обновите страницу и внесите правку заново — иначе вы сотрёте чужие изменения.';
  rpcAnswers.website_settings_save = { __status: 409, __error: { message: msg } };
  toastMsg = null;
  const box = enabledBox(c);
  box.checked = true;
  box.dispatchEvent({ type: 'change' });
  await tick();
  assert.ok(String(toastMsg).includes('Обновите страницу'), 'тост: ' + toastMsg);
  assert.equal(enabledBox(c).checked, false, 'выключатель вернулся');
  assert.strictEqual(__test.state.settings.enabled, false, 'и в объекте настроек — прежнее значение');
});

test('WEBSITE_V1: «Просмотр» — поля серые, кнопок «Сохранить» нет', async () => {
  asRole({ commerce_website: 'view' });
  try {
    assert.equal(perms.commerceToolLevel('commerce_website'), 'view');
    rpcAnswers.website_settings_get = { settings: { enabled: true }, updated_at: 'T1', site: { running: true, port: 8001 } };
    const c = await mount();
    assert.equal(byAttr(c, 'data-ws-save').length, 0, 'кнопки «Сохранить» нет');
    assert.ok('disabled' in enabledBox(c).attrs, 'выключатель серый');
    assert.ok(textOf(c).includes('Доступ только для чтения'));
    const c2 = await mount('seo');
    assert.equal(byAttr(c2, 'data-ws-save').length, 0);
  } finally { asAdmin(); }
});

const DOCTORS = [
  { id: 7, user_id: 7, full_name: 'Каримов Алишер', specialty: 'Кардиолог', photo_url: '', shown: true, state: 'shown', featured: 0, sort_order: 0, has_extras: false },
  { id: 9, user_id: 9, full_name: 'Юсупова Нигора', specialty: 'Педиатр', photo_url: '', shown: true, state: 'shown', featured: 1, sort_order: 1, has_extras: true },
  { id: 3, user_id: 3, full_name: 'Рахимов Бобур', specialty: 'Хирург', photo_url: '', shown: false, state: 'off', featured: 0, sort_order: 0, has_extras: false },
  { id: 4, user_id: 4, full_name: 'Азизова Мадина', specialty: 'Невролог', photo_url: '', shown: false, state: 'branch_hidden', featured: 0, sort_order: 0, has_extras: true },
];

test('WEBSITE_V1: «Врачи» — причина скрытия, «На главной», порядок; ни публикации, ни удаления', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_settings_get = { settings: {}, updated_at: null, site: { running: false, port: 0 } };
  rpcAnswers.website_content_list = (a) => (a.kind === 'doctors' ? { rows: DOCTORS.map((r) => ({ ...r })) } : { rows: [] });
  rpcAnswers.website_content_save = { id: 7 };
  rpcAnswers.website_content_reorder = { ok: true };
  const c = await mount('doctors');
  const reasons = byAttr(c, 'data-ws-reason');
  assert.deepEqual(reasons.map((n) => n.attrs['data-ws-reason']), ['off', 'branch_hidden']);
  assert.ok(textOf(c).includes('Скрыт: включите «Публичный профиль» в карточке сотрудника'));
  assert.ok(textOf(c).includes('Скрыт: филиал скрыт с сайта'));
  assert.deepEqual(byAttr(c, 'data-ws-featured').map((n) => n.attrs['data-ws-featured']), ['7', '9'], '«На главной» — только у показанных');
  assert.ok(!textOf(c).includes('Удалить'), 'удалять врача нечем');
  assert.ok(!textOf(c).includes('Опубликовать'));
  assert.deepEqual(byAttr(c, 'data-ws-reset').map((n) => n.attrs['data-ws-reset']), ['9', '4'], '«Сбросить» — только где есть добавки');

  const fb = byAttr(c, 'data-ws-featured')[0];
  fb.checked = true;
  fb.dispatchEvent({ type: 'change' });
  await tick();
  assert.deepEqual(callsOf('website_content_save').at(-1), { kind: 'doctors', row: { user_id: 7, featured: 1 } });
  assert.equal(callsOf('website_content_publish').length, 0);

  // «Ниже» у первого показанного — порядок user_id показанных.
  const row7 = byAttr(c, 'data-ws-row').find((n) => n.attrs['data-ws-row'] === '7');
  const down = walk(row7).find((n) => n.tagName === 'BUTTON' && n.attrs['aria-label'] === 'Ниже');
  down.click();
  await tick();
  assert.deepEqual(callsOf('website_content_reorder').at(-1), { kind: 'doctors', ids: [9, 7] });
});

test('WEBSITE_V1: «Сбросить» у врача — website_content_delete по user_id', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_content_list = { rows: DOCTORS.map((r) => ({ ...r })) };
  rpcAnswers.website_content_delete = { ok: true };
  const c = await mount('doctors');
  const before = document.body.children.length;
  byAttr(c, 'data-ws-reset').find((n) => n.attrs['data-ws-reset'] === '4').click();
  const modal = document.body.children[before];
  assert.ok(textOf(modal).includes('Сбросить настройки сайта?'));
  byAttr(modal, 'data-ws-confirm')[0].click();
  await tick();
  assert.deepEqual(callsOf('website_content_delete').at(-1), { kind: 'doctors', id: 4 });
});

test('WEBSITE_V1: «Услуги» — без поиска только показанные, поиск по всем с причиной', async () => {
  asAdmin();
  const services = [
    { id: 11, service_id: 11, name: 'Приём кардиолога', name_uz: 'Kardiolog qabuli', name_en: '', price: 150000, shown: true, state: 'shown', featured: 0, sort_order: 0, image_path: '', content: {}, has_extras: false },
    { id: 12, service_id: 12, name: 'ЭКГ', name_uz: '', name_en: '', price: 50000, shown: false, state: 'no_uz', featured: 0, sort_order: 0, image_path: '', content: {}, has_extras: false },
    { id: 13, service_id: 13, name: 'УЗИ сердца', name_uz: 'Yurak UTT', name_en: '', price: 90000, shown: false, state: 'off', featured: 0, sort_order: 0, image_path: '', content: {}, has_extras: false },
  ];
  rpcAnswers.website_content_list = { rows: services };
  const c = await mount('services');
  assert.deepEqual(byAttr(c, 'data-ws-row').map((n) => n.attrs['data-ws-row']), ['11']);
  assert.ok(textOf(c).includes('На сайте: 1 из 3'));
  const search = walk(c).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'text');
  search.value = 'экг';
  search.dispatchEvent({ type: 'input', target: search });
  await tick(650);   // SEARCH_DEBOUNCE_V1 — поле поиска с задержкой 500 мс (ui.js)
  assert.deepEqual(byAttr(c, 'data-ws-row').map((n) => n.attrs['data-ws-row']), ['12']);
  assert.ok(textOf(c).includes('Скрыт: нет названия на узбекском'));
  assert.equal(byAttr(c, 'data-ws-edit').length, 0, 'у скрытой услуги описания не правят');
});

test('WEBSITE_V1: плитка «Веб-сайт» — в «Коммерческих инструментах» настроек; роли без строки — нет', () => {
  const items = GROUPS.find((g) => g.key === 'commerce').items;
  const tile = items.find((i) => i.route === 'website-settings');
  assert.ok(tile, 'плитка есть');
  assert.equal(tile.label, 'Веб-сайт');
  asAdmin();
  assert.equal(perms.isRouteAllowed('website-settings'), true, 'администратору — да');
  assert.equal(perms.commerceToolLevel('commerce_website'), 'edit');
  asRole({ patients: 'view', settings: 'view' });
  try {
    assert.equal(perms.isRouteAllowed('website-settings'), false, 'роли без строки «Веб-сайт» — нет');
    asRole({ settings: 'view', commerce_website: 'view' });
    assert.equal(perms.isRouteAllowed('website-settings'), true, 'выданный «Просмотр» — открывает');
  } finally { asAdmin(); }
});

test('WEBSITE_V1: маршрут продаётся модулем `website` лицензии', () => {
  assert.equal(LICENSED_MODULES['website-settings'].key, 'website');
  setLicence({ locked: false, modules: ['crm'], state: 'ok', days_left: 30 });
  assert.equal(isLicensed('website-settings'), false, 'без модуля — экран предложения');
  setLicence({ locked: false, modules: ['website'], state: 'ok', days_left: 30 });
  assert.equal(isLicensed('website-settings'), true);
  setLicence(null);
});

test('WEBSITE_PREVIEW_V1: правка уходит в просмотр до сохранения; рамка без доступа к программе', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_settings_get = { settings: { hero: { ru: { title: 'Старый' } } }, updated_at: 'T1', site: { running: false, port: 0 } };
  rpcAnswers.website_preview = { html: '<html></html>' };
  __test.state.lang = 'ru';
  const c = await mount('home');
  const frame = walk(c).find((n) => n.tagName === 'IFRAME');
  assert.equal(frame.attrs.sandbox, 'allow-scripts', 'без allow-same-origin');
  assert.equal(byAttr(c, 'data-ws-dirty')[0].attrs['data-ws-dirty'], '0', 'открытие раздела — не правка');

  const input = walk(c).find((n) => n.tagName === 'INPUT' && n.value === 'Старый');
  input.value = 'Новый';
  input.dispatchEvent({ type: 'input', target: input });
  walk(c).find((n) => n.className === 'ws-body').dispatchEvent({ type: 'input' });   // всплытие: в фейковой DOM его нет
  await tick(500);
  assert.equal(callsOf('website_preview').at(-1).settings.hero.ru.title, 'Новый');
  assert.equal(callsOf('website_preview').at(-1).path, '/ru/');
  assert.equal(callsOf('website_settings_save').length, 0, 'не сохранено');
  assert.equal(byAttr(c, 'data-ws-dirty')[0].attrs['data-ws-dirty'], '1');
  assert.equal(byAttr(c, 'data-ws-discard').length, 1);
});

test('WEBSITE_EDITOR_V2: карточка открывается на месте формы, черновик виден в просмотре', async () => {
  asAdmin();
  rpcCalls.length = 0;
  rpcAnswers.website_settings_get = { settings: {}, updated_at: 'T1', site: { running: false, port: 0 } };
  rpcAnswers.website_content_list = { rows: [{ id: 5, published: 1, content: { ru: { q: 'Где вы?', a: 'Здесь' } } }] };
  rpcAnswers.website_content_save = { id: 5 };
  const c = await mount('faq');
  walk(c).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Изменить')).click();
  await tick(500);
  assert.equal(byAttr(c, 'data-ws-editor').length, 1);
  const pv = callsOf('website_preview').at(-1);
  assert.equal(pv.row.kind, 'faq');
  assert.equal(pv.row.row.content.ru.q, 'Где вы?');
  byAttr(c, 'data-ws-modal-save')[0].click();
  await tick();
  const saved = callsOf('website_content_save').at(-1);
  assert.equal(saved.row.id, 5);
  assert.equal(saved.row.content.ru.a, 'Здесь');
  assert.equal(byAttr(c, 'data-ws-editor').length, 0, 'вернулись к списку');
});
