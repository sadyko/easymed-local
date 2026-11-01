// META_INBOX_V1 — экран «Чат Facebook и Instagram» (views/meta-chat.js).
//
// Что закреплено:
//   * три раздела в полосе: Messenger, Instagram, Комментарии — со счётчиками;
//   * список раздела — только его переписки; открытие — meta_inbox_messages;
//   * окно 24 часа закрыто — поля ответа нет, есть объяснение;
//   * ответ — meta_inbox_send с текстом; отказ показывается фразой;
//   * комментарии: ответ публично — в корень, в личку — последнему автору;
//   * «Просмотр» — без поля ответа и без кнопок.
//
// Fake-DOM harness — copied from __tests__/settings-hub-commercial.test.mjs.

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
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
// Фоновый опрос экрана в тесте не нужен — и держал бы процесс.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
let lastPrompt = '';
globalThis.prompt = (q) => { lastPrompt = q; return '+998901234567'; };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const byAttr = (root, a, v) => walk(root).filter((n) => n.attrs && a in n.attrs && (v === undefined || n.attrs[a] === v));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const NOW = new Date().toISOString();
let canReply = true;
let windowOpen = true;
let sendAnswer = { ok: true };
const calls = [];
const RESP = {
  meta_inbox_state: () => ({ enabled: true, connected: true, page_name: 'Клиника', ig_username: 'clinic.uz', last_poll_at: NOW, errors: [],
    can_reply: canReply, can_manage: canReply, unread: { messenger: 1, instagram: 0, comments: 2, total: 3 } }),
  meta_inbox_conversations: () => ({ unread: { messenger: 1, instagram: 0, comments: 2 }, conversations: [
    { id: 11, platform: 'messenger', peer_name: 'Анна Ким', peer_username: '', last_text: 'Сколько стоит УЗИ?', last_direction: 'in', last_at: NOW, last_in_at: NOW, unread: 1, window_open: windowOpen },
    { id: 12, platform: 'instagram', peer_name: '', peer_username: 'bek_92', last_text: 'Запись есть?', last_direction: 'in', last_at: NOW, last_in_at: NOW, unread: 0, window_open: true },
  ] }),
  meta_inbox_messages: () => ({
    conversation: { id: 11, platform: 'messenger', peer_name: 'Анна Ким', peer_username: '', crm_request_id: null, window_open: windowOpen, window_until: NOW },
    messages: [{ id: 1, direction: 'in', text: 'Сколько стоит УЗИ?', attachments: [], created_at: NOW, status: 'ok', error: '', error_text: '', sent_by_name: '' }],
  }),
  meta_inbox_send: () => sendAnswer,
  meta_inbox_comments: () => ({ unread: { messenger: 1, instagram: 0, comments: 2 }, threads: [
    { id: 21, platform: 'facebook', post_text: 'Скидка на анализы', post_url: '', post_is_ad: false, author_name: 'Олег', text: 'А в субботу работаете?', last_is_page: false, last_at: NOW, replies: 0, unread: 1, answered: false, is_hidden: false, crm_request_id: null },
  ] }),
  meta_inbox_comment_thread: () => ({
    post: { platform: 'facebook', text: 'Скидка на анализы', url: 'https://fb.example/p1', is_ad: false },
    comments: [{ id: 21, author_name: 'Олег', text: 'А в субботу работаете?', created_at: NOW, is_page: false, is_hidden: false, is_root: true, private_replied_at: null, crm_request_id: null, sent_by_name: '' }],
  }),
  meta_inbox_comment_reply: () => ({ ok: true }),
  meta_inbox_comment_private: () => ({ ok: true }),
  meta_inbox_to_crm: () => ({ ok: true, status: 'created', crm_request_id: 7 }),
  // META_INBOX_STATS_V1 — форма та же, что у meta/inbox-stats.js.
  meta_inbox_stats: (args) => ({
    range: { days: args.days, from: '2026-10-25', to: '2026-10-31', unit: 'day' },
    totals: { messages_in: 12, message_people: 5, messages_out: 7, messages_failed: 0, comments_in: 40, comment_people: 31, comments_on_ads: 9,
      comments_hidden: 1, comment_replies: 6, private_replies: 2, requests: 30, answered: 20, missed: 3, within_hour: 15, median_ms: 25 * 60000,
      message_median_ms: 10 * 60000, people: 36, leads: 4, conversion: 4 / 36 },
    leads: { total: 4, created: 3, merged: 1, won: 1, lost: 0, open: 3, patients: 1 },
    stages: [{ key: 'in_process', label: 'В обработке', kind: 'open', color: 'info', position: 1, count: 3 }, { key: 'came', label: 'Пришёл', kind: 'won', color: 'ok', position: 5, count: 1 }],
    channels: ['messenger', 'instagram', 'facebook', 'instagram_comments'].map((key) => ({ key, incoming: 1, people: 1, requests: 1, answered: 1, waiting: 0, missed: 0, within_hour: 1, median_ms: 60000, leads: 1 })),
    series: ['2026-10-30', '2026-10-31'].map((key) => ({ key, messenger: 1, instagram: 2, facebook: 3, instagram_comments: 4, replies: 2 })),
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 10 ? 5 : 0 })),
    posts: [{ platform: 'facebook', post_id: 'p2', post_text: 'Скидка на анализы', post_url: '', is_ad: true, comments: 9, people: 8, leads: 2 }],
    staff: [{ user_id: 1, name: 'Администратор', messages: 7, comment_replies: 3, private_replies: 2, leads: 4 }],
    outside: { messages: 0, comment_replies: 3 },
    waiting_now: { messages: 2, comments: 5 },
  }),
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    let args = {};
    try { args = init.body ? JSON.parse(init.body) : {}; } catch { args = {}; }
    calls.push({ name, args });
    const fn = RESP[name];
    return { ok: true, json: async () => ({ data: fn ? fn(args) : {} }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderMetaChat } = await import('../views/meta-chat.js');
const { setFullAccess } = await import('../permissions.js');

// Раздел экран помнит между заходами (state модуля) — тест начинает с Messenger.
async function mount() {
  const root = mk('div');
  await renderMetaChat(root);
  await tick();
  byAttr(root, 'data-meta-tab', 'messenger')[0].click();
  await tick();
  return root;
}
const rows = (root) => byAttr(root, 'data-meta-row').map((r) => r.attrs['data-meta-row']);

test('META_INBOX_LAYOUT_V2: вкладки как во «Входящих» Meta; «Все сообщения» — обе переписки, вкладка канала — свою', async () => {
  setFullAccess('Администратор'); canReply = true; windowOpen = true;
  const root = await mount();
  assert.deepStrictEqual(byAttr(root, 'data-meta-tab').map((t) => t.attrs['data-meta-tab']), ['all', 'messenger', 'instagram', 'fb_comments', 'ig_comments']);
  assert.deepStrictEqual(rows(root), ['11']);
  byAttr(root, 'data-meta-tab', 'all')[0].click();
  await tick();
  assert.deepStrictEqual(rows(root), ['11', '12']);
  byAttr(root, 'data-meta-filter', 'unread')[0].click();
  assert.deepStrictEqual(rows(root), ['11'], 'фильтр «Непрочитанные»');
  byAttr(root, 'data-meta-filter', 'unread')[0].click();
  byAttr(root, 'data-meta-tab', 'instagram')[0].click();
  await tick();
  assert.deepStrictEqual(rows(root), ['12']);
  assert.ok(textOf(root).includes('bek_92'));
});

test('переписка: открытие читает ленту; ответ уходит текстом; отказ — фразой', async () => {
  setFullAccess('Администратор'); canReply = true; windowOpen = true;
  const root = await mount();
  byAttr(root, 'data-meta-row', '11')[0].click();
  await tick();
  assert.ok(calls.some((c) => c.name === 'meta_inbox_messages' && c.args.id === 11));
  assert.ok(textOf(root).includes('Сколько стоит УЗИ?'));
  const input = byAttr(root, 'data-meta-input')[0];
  input.value = 'Стоит 150 000 сум.';
  byAttr(root, 'data-meta-send')[0].click();
  await tick();
  const sent = calls.filter((c) => c.name === 'meta_inbox_send').at(-1);
  assert.deepStrictEqual(sent.args, { id: 11, text: 'Стоит 150 000 сум.' });

  sendAnswer = { ok: false, reason: 'user_unavailable', message: 'Человек недоступен: удалил переписку, заблокировал страницу или удалил аккаунт.' };
  const input2 = byAttr(root, 'data-meta-input')[0];
  input2.value = 'Ещё?';
  byAttr(root, 'data-meta-send')[0].click();
  await tick();
  assert.match(String(toastMsg), /Человек недоступен/);
  sendAnswer = { ok: true };
});

test('окно 24 часа закрыто — поля ответа нет, есть объяснение', async () => {
  setFullAccess('Администратор'); canReply = true; windowOpen = false;
  const root = await mount();
  byAttr(root, 'data-meta-row', '11')[0].click();
  await tick();
  assert.equal(byAttr(root, 'data-meta-input').length, 0);
  assert.equal(byAttr(root, 'data-meta-window-closed').length, 1);
  windowOpen = true;
});

test('комментарии: публично — в корень; в личку — автору; «В CRM» спрашивает телефон', async () => {
  setFullAccess('Администратор'); canReply = true;
  const root = await mount();
  byAttr(root, 'data-meta-tab', 'fb_comments')[0].click();
  await tick();
  byAttr(root, 'data-meta-row', '21')[0].click();
  await tick();
  assert.ok(textOf(root).includes('Скидка на анализы'), 'пост над ниткой');
  byAttr(root, 'data-meta-input')[0].value = 'Да, до 15:00';
  byAttr(root, 'data-meta-send')[0].click();
  await tick();
  assert.deepStrictEqual(calls.filter((c) => c.name === 'meta_inbox_comment_reply').at(-1).args, { id: 21, text: 'Да, до 15:00' });

  byAttr(root, 'data-meta-mode', 'private')[0].click();
  byAttr(root, 'data-meta-input')[0].value = 'Напишите номер';
  byAttr(root, 'data-meta-send')[0].click();
  await tick();
  assert.deepStrictEqual(calls.filter((c) => c.name === 'meta_inbox_comment_private').at(-1).args, { id: 21, text: 'Напишите номер' });

  // META_INBOX_LEAD_FORM_V1 — «Отметить как лид» открывает форму, а не prompt():
  // имя подставлено из Meta, «Ответственный — я» включён.
  byAttr(root, 'data-meta-crm')[0].click();
  await tick();
  assert.equal(lastPrompt, '');
  const form = byAttr(document.body, 'data-meta-lead-form').at(-1);
  assert.ok(form, 'форма лида открыта');
  assert.equal(byAttr(form, 'data-lead-name')[0].value, 'Олег');
  byAttr(form, 'data-lead-phone')[0].value = '+998901234567';
  byAttr(form, 'data-lead-comment')[0].value = 'Хочет на УЗИ в субботу';
  byAttr(form, 'data-lead-save')[0].click();
  await tick();
  assert.deepStrictEqual(calls.filter((c) => c.name === 'meta_inbox_to_crm').at(-1).args,
    { kind: 'comment', id: 21, name: 'Олег', phone: '+998901234567', comment: 'Хочет на УЗИ в субботу', take: true });

  // «В CRM» стоит под каждым чужим комментарием нитки.
  assert.equal(byAttr(root, 'data-meta-crm-comment', '21').length, 1);
});

test('«Просмотр»: ни поля ответа, ни «В CRM», ни «Скрыть»', async () => {
  setFullAccess('Администратор'); canReply = false;
  const root = await mount();
  byAttr(root, 'data-meta-row', '11')[0].click();
  await tick();
  assert.equal(byAttr(root, 'data-meta-input').length, 0);
  assert.equal(byAttr(root, 'data-meta-crm').length, 0);
  assert.ok(textOf(root).includes('только чтение'));
  byAttr(root, 'data-meta-tab', 'fb_comments')[0].click();
  await tick();
  byAttr(root, 'data-meta-row', '21')[0].click();
  await tick();
  assert.equal(byAttr(root, 'data-meta-hide').length, 0);
  assert.equal(byAttr(root, 'data-meta-crm-comment').length, 0);
  canReply = true;
});

test('META_INBOX_STATS_V1: «Статистика» в шапке открывает цифры вместо переписки; период перечитывает; назад — к переписке', async () => {
  setFullAccess('Администратор'); canReply = true; windowOpen = true;
  const root = await mount();
  const toggle = () => byAttr(root, 'data-meta-stats-toggle')[0];
  assert.ok(toggle(), 'кнопка «Статистика» есть');
  assert.ok(textOf(toggle()).includes('Статистика'));
  calls.length = 0;
  toggle().click();
  await tick();
  const st = calls.filter((c) => c.name === 'meta_inbox_stats');
  assert.equal(st.length, 1);
  assert.equal(st[0].args.days, 30, 'по умолчанию — 30 дней');
  const stats = byAttr(root, 'data-meta-stats')[0];
  assert.ok(stats, 'страница статистики нарисована');
  const txt = textOf(stats);
  for (const s of ['Личные сообщения', 'Комментарии', 'Ответы клиники', 'Время ответа', 'Без ответа', 'Лиды из чата', 'По каналам', 'Кто отвечал', 'Скидка на анализы', 'Пришёл'])
    assert.ok(txt.includes(s), s);
  assert.ok(txt.includes('25 мин'), 'медиана словами');
  assert.deepStrictEqual(byAttr(stats, 'data-meta-channel').map((r) => r.attrs['data-meta-channel']), ['messenger', 'instagram', 'facebook', 'instagram_comments']);
  assert.ok(textOf(toggle()).includes('К переписке'));

  byAttr(root, 'data-meta-period', '7')[0].click();
  await tick();
  assert.equal(calls.filter((c) => c.name === 'meta_inbox_stats').at(-1).args.days, 7);

  toggle().click();
  await tick();
  assert.ok(textOf(toggle()).includes('Статистика'), 'вернулись к переписке');
});
