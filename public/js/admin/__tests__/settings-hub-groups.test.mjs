// SETTINGS_ONE_COMPANY_V1 + SUBSCRIPTION_SUBROUTE_V1 (2026-08-29, owner: «в
// настройках два управления филиалами — сделать одно, второе убрать; сделать
// системные настройки одним разделом: компания, филиалы, система, подписка»).
//
// Что здесь действительно закреплено:
//   * в хабе ровно ОДНА группа про саму клинику — «Настройки Easy-Med» — и в
//     ней строки в порядке владельца: Компания · Филиалы · Система · Подписка
//     (+ «Данные клиники», см. ниже);
//   * дубликат исчез: плитки «Компании» нет, группы «Управление филиалами»
//     нет, и слово «Компания» встречается в хабе один-единственный раз —
//     именно эта неоднозначность и была жалобой;
//   * ничего не потеряло вход: «Компания» по-прежнему открывает
//     documents-settings, «Система» — updates, «Филиалы» — тот же редактор
//     branches, что и раньше, а группа «Системные настройки» (CRM, телефония,
//     Telegram, API) осталась ровно такой, какой была.
//
// SETTINGS_SPLIT_V1 (2026-08-29) переставил две вещи в этом файле:
//   * «Подписка» зовёт СВОЙ маршрут ('subscription'), а не подмаршрут
//     «Системы». Правило «никакой второй копии карточки» не отменено — оно
//     соблюдено импортом: views/subscription.js подключает ту же самую
//     views/system-subscription.js;
//   * появилась пятая плитка «Данные клиники» → 'clinic-data'. Она проверяется
//     здесь именно потому, что это единственный вход к резервным копиям и к
//     удалению данных после того, как их убрали с «Системы»: плитка исчезнет —
//     функции станут недостижимыми, и тест обязан это поймать.
//
// Fake-DOM harness — copied from __tests__/lab-panels-mode.test.mjs (itself
// from telephony-settings.test.mjs / system-view.test.mjs), including the
// localStorage 'admin.lang'='ru' pin BEFORE the view imports: i18n.js picks
// its language once at module load, and every Russian assertion below depends
// on it.

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
// I18N_LOCALE_PIN_V1 — i18n.js picks its language ONCE, at module load, from
// this same store's 'admin.lang' before ever consulting navigator.language.
// Pinning 'ru' here, BEFORE the view imports below, is what makes this file's
// Russian-string assertions hold on GitHub's English-locale runner exactly as
// they do on a Russian-locale dev machine.
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

// A toast node, so ui.js reuses it instead of appending to the fake body.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- fake server ------------------------------------------------------------
// The hub itself reads nothing; the branches editor does one /api/db select.
// updates.js talks to /api/rpc — answer the three calls its page makes.
let dbTables = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    dbTables.push(body && body.table);
    const rows = { branches: [{ id: 1, name: 'Main Branch', phone: '', address: '', active: 1 }] }[body && body.table] || [];
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    const data = {
      update_status: { current_version: '0.1.3', offer: null, approved: false, last_result: null },
      backup_list: { backups: [] },
      licence_status: { clinic_name: 'Novo Medics', clinic_id: 'dev-local', modules: [], locked: false },
    }[name] ?? {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderSettingsHub } = await import('../views/settings-hub.js');
const { renderUpdates } = await import('../views/updates.js');
const { setFullAccess } = await import('../permissions.js');
// The subscription card reads the boot-time licence copy, not an RPC (see
// views/system-subscription.js) — so seed it the way system-view.test.mjs does,
// or the card renders em-dashes and the deep link cannot be told from a stub.
const { setLicence } = await import('../licence.js');
setLicence({
  state: 'ok', locked: false, reason: null, days_left: 22, modules: ['crm'],
  clinic_name: 'Нурафшон Мед', clinic_id: 'c-000051',
  valid_until: new Date(2026, 8, 12).toISOString(), last_checkin: new Date(2026, 7, 23, 9, 0).toISOString(),
});

// --- hub readers ------------------------------------------------------------
// A group card is .set-card: its .set-card-title is the heading and every
// .set-row-name inside it is one tile. Read the hub the way a person does —
// by what is written on it — rather than by the GROUPS array, which is the
// thing under test.
function groups(root) {
  return byClass(root, 'set-card').map((card) => ({
    title: textOf(byClass(card, 'set-card-title')[0] || mk('div')).trim(),
    rows: byClass(card, 'set-row').map((r) => ({
      name: textOf(byClass(r, 'set-row-name')[0] || mk('div')).trim(),
      node: r,
    })),
  }));
}
const groupTitles = (root) => groups(root).map((g) => g.title);
const groupNamed = (root, title) => groups(root).find((g) => g.title === title);
const allRowNames = (root) => groups(root).flatMap((g) => g.rows.map((r) => r.name));

async function mountHub(nav) {
  const root = mk('div');
  await renderSettingsHub(root, { onNavigate: (...a) => nav.push(a) });
  await tick();
  return root;
}

test('одна группа «Настройки Easy-Med» — Компания · Филиалы · Система · Подписка · Данные клиники, в этом порядке', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);

  const g = groupNamed(root, 'Настройки Easy-Med');
  assert.ok(g, 'группа «Настройки Easy-Med» на экране; заголовки: ' + groupTitles(root).join(' | '));
  // SETTINGS_SPLIT_V1 — пятая плитка появилась не «до кучи»: после того как
  // «Система» сузилась до версии и «что нового», это ЕДИНСТВЕННЫЙ вход к
  // резервным копиям и к удалению данных клиники.
  assert.deepStrictEqual(g.rows.map((r) => r.name), ['Компания', 'Филиалы', 'Система', 'Подписка', 'Данные клиники'],
    'четыре плитки владельца в его порядке + «Данные клиники» последней');
  assert.strictEqual(groupTitles(root).filter((t) => t === 'Настройки Easy-Med').length, 1,
    'группа одна — а не вторая такая же рядом');
  assert.strictEqual(textOf(g.rows[3].node).includes('Скоро'), false, '«Подписка» живая, а не заглушка «Скоро»');
  assert.strictEqual(textOf(g.rows[4].node).includes('Скоро'), false, '«Данные клиники» живая, а не заглушка «Скоро»');
});

test('дубликат убран: ни плитки «Компании», ни группы «Управление филиалами»', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);

  const names = allRowNames(root);
  assert.ok(!names.includes('Компании'), 'мёртвая плитка реестра юрлиц («Компании») убрана: ' + names.join(', '));
  assert.ok(!groupTitles(root).includes('Управление филиалами'),
    'пустая группа удалена, а не оставлена с одной строкой: ' + groupTitles(root).join(' | '));
  // Суть жалобы: слово «Компания» в меню должно значить ровно одно.
  assert.deepStrictEqual(names.filter((n) => n === 'Компания' || n === 'Компании'), ['Компания'],
    'в хабе ровно один вход с этим словом (у «Компаний-плательщиков» другое имя и другой смысл)');
  // Реестр юрлиц продолжает существовать как данные и маршрут — просто больше
  // не притворяется настройкой клиники. Ничего не удалено молча.
});

test('ничего не потеряло вход: Компания → documents-settings, Система → updates, Данные клиники → clinic-data, Филиалы → тот же редактор', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);
  const g = groupNamed(root, 'Настройки Easy-Med');

  g.rows[0].node.click();
  assert.deepStrictEqual(nav, [['documents-settings']], '«Компания» — редактор реквизитов клиники (doc_settings)');

  nav.length = 0;
  g.rows[2].node.click();
  assert.deepStrictEqual(nav, [['updates']], '«Система» открывается как прежде, без подмаршрута');

  // SETTINGS_SPLIT_V1 — главное, что должен доказать этот файл: копии и
  // опасная зона не стали недостижимыми при разделении экрана.
  nav.length = 0;
  g.rows[4].node.click();
  assert.deepStrictEqual(nav, [['clinic-data']], '«Данные клиники» — единственный вход к копиям и удалению данных');

  // «Филиалы» — не переход, а тот же встроенный редактор LOOKUP_CONFIG.branches.
  nav.length = 0;
  dbTables = [];
  g.rows[1].node.click();
  await tick();
  assert.deepStrictEqual(nav, [], 'редактор открывается внутри хаба, никуда не навигируя');
  assert.ok(dbTables.includes('branches'), 'читается именно таблица branches: ' + dbTables.join(', '));
  const text = textOf(root);
  assert.ok(text.includes('Main Branch'), 'строка филиала на экране');
  assert.ok(text.includes('Back to settings'), 'кнопка возврата в хаб');
});

test('группа «Системные настройки» не тронута', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);

  const g = groupNamed(root, 'Системные настройки');
  assert.ok(g, 'группа на месте');
  assert.deepStrictEqual(g.rows.map((r) => r.name), ['CRM-канбан', 'Телефония', 'Telegram-бот', 'API'],
    'интеграции остались отдельной группой и в прежнем составе');
});

test('«Подписка» — собственный маршрут, а не подмаршрут «Системы»', async () => {
  setFullAccess('Администратор');
  const nav = [];
  const root = await mountHub(nav);

  groupNamed(root, 'Настройки Easy-Med').rows[3].node.click();
  // SETTINGS_SPLIT_V1 — раньше здесь был ['updates', {sub:'subscription'}].
  assert.deepStrictEqual(nav, [['subscription']],
    'плитка зовёт свой экран; вторая копия карточки при этом не появилась — экран её импортирует');
});

test('старая ссылка #updates/subscription по-прежнему приводит на подписку', async () => {
  setFullAccess('Администратор');
  const root = mk('div');
  await renderUpdates(root, { payload: { sub: 'subscription' } });
  await tick();

  const text = textOf(root);
  assert.ok(text.includes('Активация и подписка'), 'старая закладка открывает карточку подписки: ' + text.slice(0, 200));
  assert.ok(text.includes('Нурафшон Мед'), 'данные лицензии в карточке, а не заглушка');
  // Один экран, одна карточка.
  assert.strictEqual(text.split('Активация и подписка').length - 1, 1, 'карточка одна, копии не появилось');
});

test('обычный заход в «Систему» (без sub) — только обновления, без подписки и копий', async () => {
  setFullAccess('Администратор');
  const root = mk('div');
  await renderUpdates(root);
  await tick();

  const text = textOf(root);
  assert.ok(text.includes('Система'), 'заголовок экрана на месте');
  assert.ok(!text.includes('Активация и подписка'), 'подписка уехала на свой экран: ' + text.slice(0, 200));
  assert.ok(!text.includes('Резервные копии'), 'копии уехали в «Данные клиники»');
});
