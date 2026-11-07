// META_LEADS_V1_HUB (2026-10-16, owner: «in setting block build separate
// setting block of commercial instruments after salary of doctors, there
// start to build integration») — в хабе «Настройки» ПОСЛЕ «Зарплата врача»
// стоит группа «Коммерческие инструменты», а в ней плитка «Meta: заявки из
// рекламы», ведущая на маршрут 'meta-settings'.
//
// Что закреплено:
//   * группа — последняя, сразу после «Зарплата врача» (порядок владельца);
//   * плитка живая и ведёт на 'meta-settings' навигацией, а не справочником;
//   * администратору плитка видна; роли, которой ключ settings.meta не
//     настраивали, — нет (токен Meta — доступ к заявкам всей страницы, правило
//     Telegram-бота и Телефонии).
//
// Fake-DOM harness — copied from __tests__/settings-hub-fold.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
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

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    const data = { update_status: { current_version: '0.1.3', offer: null, approved: false, last_result: null } }[name] ?? {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderSettingsHub, GROUPS } = await import('../views/settings-hub.js');
const { setFullAccess, setEffectiveFromRole, setActorRoles } = await import('../permissions.js');

const cards   = (root) => byClass(root, 'set-card');
const titleOf = (card) => textOf(byClass(card, 'set-card-title')[0] || mk('div')).trim();
const rowsOf  = (card) => byClass(card, 'set-row').map((r) => ({ name: textOf(byClass(r, 'set-row-name')[0] || mk('div')).trim(), node: r, live: String(r.className).includes('set-row-link') }));

async function mountHub(nav) {
  const root = mk('div');
  await renderSettingsHub(root, { onNavigate: (...a) => nav.push(a) });
  await tick();
  return root;
}

test('группа «Коммерческие инструменты» стоит последней, сразу после «Зарплата врача»', async () => {
  setFullAccess('Администратор');
  const root = await mountHub([]);
  const titles = cards(root).map(titleOf);
  const i = titles.indexOf('Коммерческие инструменты');
  assert.ok(i >= 0, 'группа на экране; заголовки: ' + titles.join(' | '));
  assert.equal(titles[i - 1], 'Зарплата врача', 'сразу после «Зарплата врача»');
  assert.equal(i, titles.length - 1, 'последняя');
  assert.equal(GROUPS[GROUPS.length - 1].title, 'Коммерческие инструменты', 'и в объявлении GROUPS — последняя');
});

test('плитки «Meta: заявки из рекламы» и «Ссылки для рекламы в Telegram» живые и ведут на свои маршруты', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);
  const g = cards(root).find((c) => titleOf(c) === 'Коммерческие инструменты');
  const rows = rowsOf(g);
  // MOIZVONKI_V2 ставил сюда вторую плитку «Мои Звонки»; MOIZVONKI_IN_TELEPHONY_V1
  // (владелец, 2026-10-17: «all telephony stuff should be done in here») вернул
  // провайдера в «Телефонию». TG_DEEPLINK_V1 (2026-10-26) добавил вторую плитку —
  // «Ссылки для рекламы в Telegram» (маршрут telegram-deeplinks, окно «Telegram-бот»).
  // SMS_INFORM_V1 (2026-10-30) — третья плитка «SMS-информирование» (Play Mobile).
  assert.deepStrictEqual(rows.map((r) => r.name), ['Meta: заявки из рекламы', 'Ссылки для рекламы в Telegram', 'SMS-информирование']);
  assert.ok(rows.every((r) => r.live), 'плитки живые, не «Скоро»');
  for (const r of rows) r.node.click();
  assert.deepStrictEqual(nav, [['meta-settings'], ['telegram-deeplinks'], ['sms-settings']]);
  const items = GROUPS[GROUPS.length - 1].items;
  assert.deepStrictEqual(items.map((i) => i.route), ['meta-settings', 'telegram-deeplinks', 'sms-settings'], 'видимость плиток — по маршруту (права роли)');
});

test('роли без настроенного ключа settings.meta плитка не показывается — группа исчезает целиком', async () => {
  // Настроенная роль с обычным набором разделов (форма сохранённой роли, как в
  // role-reports-settings.test.mjs), без ключа Meta: как у Telegram и
  // Телефонии — только администратор.
  setEffectiveFromRole({ name: 'Регистратор', permissions: {
    sections: ['patients', 'dashboard', 'crm', 'settings'],
    levels: { patients: 'editor', dashboard: 'viewer', crm: 'editor', settings: 'viewer' },
    grants: {},
  } });
  // Кто вошёл — тоже регистратор, как в admin-rows-grantable.test.mjs: роли
  // входа берутся из пользователя окна, а он в этом стенде администратор,
  // которому открыта любая плитка (isRouteAllowed, ревью C1/I1).
  const user = globalThis.window.easymed.state.user;
  const was = { role: user.role, super: user.is_super_admin, name: user.full_name };
  Object.assign(user, { role: 'registrar', is_super_admin: false, full_name: 'Регистратор' });
  setActorRoles(['registrar']);
  try {
    const root = await mountHub([]);
    const titles = cards(root).map(titleOf);
    assert.ok(!titles.includes('Коммерческие инструменты'), 'группы нет для роли без ключа: ' + titles.join(' | '));
  } finally {
    Object.assign(user, { role: was.role, is_super_admin: was.super, full_name: was.name });
    setActorRoles(['admin']);
    setFullAccess('Администратор');
  }
});

// COMMERCE_NAV_V1 + SMS_PUSH_V1 (2026-10-30) — пункт меню «Коммерческие
// инструменты» — не плитки настроек (они остались в хабе выше), а
// Push-уведомление по Telegram и SMS. Владелец: «In sms photo should not possible».
const { renderCommercePush, smsParts } = await import('../views/commerce-push.js');
const perms = await import('../permissions.js');
const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);

test('SMS_PUSH_V1: три колонки; администратору — оба канала; у SMS нет картинки', async () => {
  setFullAccess('Администратор');
  const root = mk('div');
  renderCommercePush(root);
  await tick();
  assert.equal(byClass(root, 'cp-col').length, 3, 'сообщение · предпросмотр · кому');
  const tabs = byAttr(root, 'data-push-channel');
  assert.deepStrictEqual(tabs.map((t) => t.getAttribute('data-push-channel')), ['telegram', 'sms']);
  const image = byAttr(root, 'data-push-image')[0];
  assert.equal(image.style.display, '', 'у Telegram картинка есть');
  tabs[1].click();
  const tabsAfter = byAttr(root, 'data-push-channel');
  assert.equal(tabsAfter.find((t) => t.getAttribute('data-push-channel') === 'sms').getAttribute('aria-selected'), 'true');
  assert.equal(image.style.display, 'none', 'у SMS картинки нет');
  assert.equal(byAttr(root, 'data-push-sms-note')[0].style.display, '', 'подсказка «только текст» видна');
  assert.ok(!textOf(root).includes('Meta: заявки из рекламы'), 'плиток настроек на странице больше нет');
});

test('SMS_PUSH_V1: части SMS — кириллица 70/67, латиница 160/153 (как на сервере)', () => {
  assert.equal(smsParts('а'.repeat(70)), 1);
  assert.equal(smsParts('а'.repeat(71)), 2);
  assert.equal(smsParts('a'.repeat(160)), 1);
  assert.equal(smsParts('a'.repeat(307)), 3);
});

test('COMMERCE_NAV_V1: пункт виден администратору; роли без «Telegram-бот: Изменение» и не администратору — нет', async () => {
  setFullAccess('Администратор');
  assert.equal(perms.isModuleAllowed('commerce'), true);
  assert.equal(perms.isRouteAllowed('commerce'), true);
  setEffectiveFromRole({ name: 'Регистратор', permissions: {
    sections: ['patients', 'crm', 'settings'], levels: { patients: 'editor', crm: 'editor', settings: 'viewer' }, grants: {},
  } });
  const user = globalThis.window.easymed.state.user;
  const was = { role: user.role, super: user.is_super_admin };
  Object.assign(user, { role: 'registrar', is_super_admin: false });
  setActorRoles(['registrar']);
  try {
    assert.equal(perms.isModuleAllowed('commerce'), false);
    assert.equal(perms.isRouteAllowed('commerce'), false);
  } finally {
    Object.assign(user, { role: was.role, is_super_admin: was.super });
    setActorRoles(['admin']);
    setFullAccess('Администратор');
  }
});

// COMMERCE_TOOLS_V1 (2026-10-30) — пункт меню — витрина инструментов, Push —
// один из них, на своём адресе. Владелец: «make them separate, as there will be
// more instrument».
const { renderCommerceHub, TOOLS } = await import('../views/commerce-hub.js');

test('COMMERCE_TOOLS_V1: витрина — карточка на инструмент; карточка ведёт на его адрес', async () => {
  setFullAccess('Администратор');
  const root = mk('div');
  const went = [];
  renderCommerceHub(root, { onNavigate: (r) => went.push(r) });
  const cards = byAttr(root, 'data-commerce-tool');
  assert.deepStrictEqual(cards.map((c) => c.getAttribute('data-commerce-tool')), TOOLS.map((t) => t.route));
  assert.ok(cards.map((c) => c.getAttribute('data-commerce-tool')).includes('commerce-push'));
  assert.equal(byClass(root, 'cp-col').length, 0, 'сама рассылка на витрине не рисуется');
  cards[0].click();
  assert.deepStrictEqual(went, ['commerce-push']);
});

test('COMMERCE_TOOLS_V1: экран Push закрыт тому, кому закрыт пункт', () => {
  setEffectiveFromRole({ name: 'Регистратор', permissions: {
    sections: ['patients', 'settings'], levels: { patients: 'editor', settings: 'viewer' }, grants: {},
  } });
  const user = globalThis.window.easymed.state.user;
  const was = { role: user.role, super: user.is_super_admin };
  Object.assign(user, { role: 'registrar', is_super_admin: false });
  setActorRoles(['registrar']);
  try {
    assert.equal(perms.isRouteAllowed('commerce-push'), false);
  } finally {
    Object.assign(user, { role: was.role, is_super_admin: was.super });
    setActorRoles(['admin']);
    setFullAccess('Администратор');
  }
  assert.equal(perms.isRouteAllowed('commerce-push'), true);
});

test('COMMERCE_TOOLS_V1: «Telegram-бот: Просмотр» — пункт и карточка ссылок для рекламы, но не Push', () => {
  setEffectiveFromRole({ name: 'Маркетолог', permissions: {
    sections: ['patients', 'settings'], levels: { patients: 'editor', settings: 'viewer' },
    grants: { patients: 'edit', settings: 'view', 'settings.telegram': 'view' },
  } });
  const user = globalThis.window.easymed.state.user;
  const was = { role: user.role, super: user.is_super_admin };
  Object.assign(user, { role: 'registrar', is_super_admin: false });
  setActorRoles(['registrar']);
  try {
    assert.equal(perms.isModuleAllowed('commerce'), true, 'пункт виден');
    assert.equal(perms.isRouteAllowed('commerce-push'), false, 'отправлять нельзя');
    const root = mk('div');
    renderCommerceHub(root, {});
    assert.deepStrictEqual(byAttr(root, 'data-commerce-tool').map((c) => c.getAttribute('data-commerce-tool')), ['telegram-deeplinks']);
  } finally {
    Object.assign(user, { role: was.role, is_super_admin: was.super });
    setActorRoles(['admin']);
    setFullAccess('Администратор');
  }
});

// Ревью 3.22.0 M1 (проба P5) — администратор со СВОЕЙ ролью клиники
// («Заместитель»), которой закрыли «Telegram-бот» или «Настройки». Вчера
// оболочка не давала ему ни Telegram-канала рассылки, ни ссылок для рекламы;
// строки commerce_* у его роли не записаны — значит, как вчера: решает бот.
test('ревью M1: заместитель, чья роль закрыла «Telegram-бот», не получает ни рассылки в Telegram, ни ссылок', () => {
  const CASES = [
    // своя роль                          Push    Ссылки   маршрут ссылок
    [{ 'settings.telegram': 'none' },     'none', 'none',  false],
    [{ 'settings.telegram': 'view' },     'none', 'view',  true],
    [{ settings: 'none' },                'none', 'none',  false],
    [{ settings: 'view' },                'edit', 'edit',  true],
    [{},                                  'edit', 'edit',  true],
    [{ 'settings.telegram': 'none', commerce_links: 'view' }, 'none', 'view', true],
  ];
  try {
    for (const [own, push, links, route] of CASES) {
      setFullAccess('Заместитель');
      perms.setOwnCustomGrants(own);
      const tag = JSON.stringify(own);
      assert.equal(perms.commerceToolLevel('commerce_push'), push, `${tag}: Push`);
      assert.equal(perms.commerceToolLevel('commerce_links'), links, `${tag}: ссылки`);
      assert.equal(perms.isRouteAllowed('telegram-deeplinks'), route, `${tag}: маршрут ссылок`);
      // SMS-канал у полного доступа остаётся, как вчера: окно Push открыто.
      assert.equal(perms.isRouteAllowed('commerce-push'), true, `${tag}: окно Push (SMS)`);
    }
  } finally { setFullAccess('Администратор'); }
  assert.equal(perms.commerceToolLevel('commerce_push'), 'edit', 'штатный администратор — без своей роли');
  assert.equal(perms.isRouteAllowed('telegram-deeplinks'), true);
});
