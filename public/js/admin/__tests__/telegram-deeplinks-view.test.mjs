// TG_DEEPLINK_V1_VIEW — экран «Ссылки для рекламы в Telegram» в поддельном DOM:
//   * без бота — предупреждение «Бот не подключён» и пустое состояние;
//   * с ботом — таблица: ссылка https://t.me/<бот>?start=<ключ>, тип заявки,
//     переходы и заявки, переключатель «Активна» сохраняет сразу;
//   * «Изменить» заполняет форму, «Удалить» зовёт telegram_deeplink_delete;
//   * форма «Новая ссылка» отправляет ключ, название, тип, ответы и кнопки
//     в telegram_deeplink_save, ключ — строчными.
//
// Fake-DOM harness — copied from __tests__/meta-settings-view.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; if (k === 'disabled') this.disabled = true;} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} scrollIntoView(){}
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
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
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
const KINDS = { callback: 'Обратный звонок', appointment: 'Запись на приём', question: 'Вопрос' };
const LINKS = [
  { id: 1, key: 'price', name: 'Цена пакетов', lead_kind: 'callback', lead_kind_label: 'Обратный звонок', answer_ru: 'Роды — от 19 999 000 сум', answer_uz: '', answer_en: '', buttons: [], file_path: '', file_kind: '', file_name: '', active: true, hits: 12, unique_hits: 9, leads: 3 },
  { id: 2, key: 'tour', name: 'Экскурсия', lead_kind: 'appointment', lead_kind_label: 'Запись на приём', answer_ru: 'Приходите', answer_uz: '', answer_en: '', buttons: [{ label: 'Цены', action: 'answer', target: 'price' }], file_path: 'deeplinks/1/tour.pdf', file_kind: 'document', file_name: 'Экскурсия.pdf', active: false, hits: 0, unique_hits: 0, leads: 0 },
];
let server = { bot_username: '', bot_enabled: false, lead_kinds: KINDS, links: [] };
const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body });
    let data;
    if (name === 'telegram_deeplinks_list') data = server;
    else if (name === 'telegram_deeplink_save') data = { ...body, id: body.id || 3, lead_kind_label: KINDS[body.lead_kind] };
    else if (name === 'telegram_deeplink_delete') data = { ok: true };
    else data = {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderTelegramDeeplinks } = await import('../views/telegram-deeplinks.js');

async function mount() {
  const root = mk('div');
  await renderTelegramDeeplinks(root, { onNavigate: () => {} });
  await tick(40);
  return root;
}

test('без бота: предупреждение и пустое состояние; форма «Новая ссылка» на месте', async () => {
  server = { bot_username: '', bot_enabled: false, lead_kinds: KINDS, links: [] };
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('Бот не подключён'), text.slice(0, 300));
  assert.ok(text.includes('Ссылок пока нет'));
  assert.ok(text.includes('Новая ссылка'));
  assert.ok(byAttr(root, 'data-deeplink-key').length === 1, 'поле ключа');
  assert.ok(byAttr(root, 'data-deeplink-answer_ru').length === 1, 'поле ответа RU');
});

test('с ботом: таблица со ссылкой, типом и счётчиками; «Активна» сохраняет сразу; «Удалить» зовёт удаление', async () => {
  server = { bot_username: 'clinic_bot', bot_enabled: true, lead_kinds: KINDS, links: LINKS };
  calls.length = 0;
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('https://t.me/clinic_bot?start=price'), 'ссылка собрана из имени бота и ключа');
  assert.ok(text.includes('Обратный звонок') && text.includes('Запись на приём'), 'тип заявки словами');
  assert.ok(text.includes('Экскурсия.pdf'), 'имя файла');
  const rows = byAttr(root, 'data-deeplink-id');
  assert.strictEqual(rows.length, 2);
  const cells = byTag(rows[0], 'td').map((td) => textOf(td));
  assert.ok(cells.includes('12') && cells.includes('3'), 'переходы и заявки: ' + cells.join(' | '));

  const toggle = byAttr(root, 'data-deeplink-active').find((i) => i.attrs['data-deeplink-active'] === '2');
  assert.strictEqual(toggle.checked, false, 'выключенная ссылка — без галочки');
  toggle.checked = true;
  toggle.dispatchEvent({ type: 'change' });
  await tick(60);
  const save = calls.find((c) => c.name === 'telegram_deeplink_save');
  assert.ok(save, 'переключатель сохраняет сразу');
  assert.strictEqual(save.body.id, 2);
  assert.strictEqual(save.body.active, true);
  assert.strictEqual(save.body.key, 'tour', 'полная строка, не только флаг');

  const del = byTag(rows[0], 'button').find((b) => textOf(b).includes('Удалить'));
  del.click();
  await tick(60);
  const d = calls.find((c) => c.name === 'telegram_deeplink_delete');
  assert.ok(d && d.body.id === 1, 'удаление по id после подтверждения');
});

test('«Изменить» заполняет форму; новая ссылка уходит в telegram_deeplink_save с ключом строчными и кнопками', async () => {
  server = { bot_username: 'clinic_bot', bot_enabled: true, lead_kinds: KINDS, links: LINKS };
  calls.length = 0;
  const root = await mount();
  const edit = byTag(byAttr(root, 'data-deeplink-id')[1], 'button').find((b) => textOf(b).includes('Изменить'));
  edit.click();
  await tick(20);
  assert.strictEqual(byAttr(root, 'data-deeplink-key')[0].value, 'tour', 'ключ в форме');
  assert.strictEqual(byAttr(root, 'data-deeplink-name')[0].value, 'Экскурсия');
  assert.ok(textOf(root).includes('Изменить ссылку: Экскурсия'));
  assert.ok(textOf(root).includes('Экскурсия.pdf'), 'текущий файл показан');

  // Отмена → снова «Новая ссылка»
  const cancel = byTag(root, 'button').find((b) => textOf(b).includes('Отмена'));
  cancel.click();
  await tick(20);
  assert.strictEqual(byAttr(root, 'data-deeplink-key')[0].value, '');

  const keyInput = byAttr(root, 'data-deeplink-key')[0];
  keyInput.value = 'Promo_2026';
  keyInput.dispatchEvent({ type: 'input' });
  const nameInput = byAttr(root, 'data-deeplink-name')[0];
  nameInput.value = 'Акция октября';
  nameInput.dispatchEvent({ type: 'input' });
  const kind = byAttr(root, 'data-deeplink-kind')[0];
  kind.value = 'question';
  kind.dispatchEvent({ type: 'change' });
  const ru = byAttr(root, 'data-deeplink-answer_ru')[0];
  ru.value = 'Скидка 20% до конца месяца';
  ru.dispatchEvent({ type: 'input' });
  byAttr(root, 'data-deeplink-add-button')[0].click();
  await tick(10);
  const rowInputs = byTag(byAttr(root, 'data-deeplink-buttons')[0], 'input');
  rowInputs[0].value = 'Сайт';
  rowInputs[0].dispatchEvent({ type: 'input' });
  const sel = byTag(byAttr(root, 'data-deeplink-buttons')[0], 'select')[0];
  sel.value = 'url';
  sel.dispatchEvent({ type: 'change' });
  rowInputs[1].value = 'https://clinic.uz/promo';
  rowInputs[1].dispatchEvent({ type: 'input' });

  byAttr(root, 'data-deeplink-save')[0].click();
  await tick(80);
  const save = calls.find((c) => c.name === 'telegram_deeplink_save');
  assert.ok(save, 'сохранение вызвано');
  assert.strictEqual(save.body.id, 0);
  assert.strictEqual(save.body.key, 'promo_2026', 'ключ строчными');
  assert.strictEqual(save.body.name, 'Акция октября');
  assert.strictEqual(save.body.lead_kind, 'question');
  assert.strictEqual(save.body.answer_ru, 'Скидка 20% до конца месяца');
  assert.deepStrictEqual(save.body.buttons, [{ label: 'Сайт', action: 'url', target: 'https://clinic.uz/promo' }]);
  assert.ok(String(toastMsg).includes('https://t.me/clinic_bot?start=promo_2026'), 'в подтверждении — готовая ссылка: ' + toastMsg);
});

test('ключ не по правилу — форма не отправляется, подсказка словами', async () => {
  server = { bot_username: 'clinic_bot', bot_enabled: true, lead_kinds: KINDS, links: [] };
  calls.length = 0;
  const root = await mount();
  const keyInput = byAttr(root, 'data-deeplink-key')[0];
  keyInput.value = 'цена';
  keyInput.dispatchEvent({ type: 'input' });
  byAttr(root, 'data-deeplink-save')[0].click();
  await tick(40);
  assert.ok(!calls.some((c) => c.name === 'telegram_deeplink_save'), 'не отправлено');
  assert.ok(String(toastMsg).includes('латиница'), toastMsg);
});
