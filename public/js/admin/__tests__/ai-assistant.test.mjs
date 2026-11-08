// AI_CHAT_V1 — экран «ИИ-помощник» (views/ai-assistant.js) и пометки ИИ в
// «Чате с пациентами» (views/telegram-chat.js).
//
// Что закреплено:
//   * переключатель зовёт ai_settings_save с настоящим true и перерисовывает
//     состояние «Отвечает ИИ»;
//   * лимит, отсутствие модуля и пустой список услуг (A8) сказаны словами;
//   * отказ сервера (402 module_missing) — фразой сервера в тосте, а
//     переключатель возвращается в прежнее положение;
//   * в чате Telegram: ответ ИИ (by_ai) помечен «ИИ», чат из ai_flags помечен
//     «Нужен оператор», чип «Отвечает ИИ» в шапке; сбой ai_flags — без пометок
//     и без падения.
//
// Фейковая DOM — копия из __tests__/roles-editor.test.mjs (checked отражает
// атрибут, который ставит h()).

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this._v=null;this._chk=null;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if(k==='value')this._v=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
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
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
// Опрос чата Telegram в тесте не нужен — и держал бы процесс.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Тост — ui.js toast() держит таймер в el._t, поэтому текст живёт отдельно.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- фейковый сервер: /api/rpc/<имя> ----------------------------------------
// Ответ — значение или функция; { __error, __status } — отказ сервера.
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

const { renderAiAssistant } = await import('../views/ai-assistant.js');
const chat = await import('../views/telegram-chat.js');
const marks = await import('../ai-chat-marks.js');

const switchOf = (root) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox');

test('AI_CHAT_V1: экран показывает переключатель и включает ИИ', async () => {
  rpcAnswers.ai_settings_get = { enabled: false, enabled_at: null, blocked: '', has_module: true, facts: { services: 12, doctors: 3 } };
  rpcAnswers.ai_settings_save = { enabled: true, enabled_at: '2026-11-08T10:00:00Z', blocked: '', has_module: true, facts: { services: 12, doctors: 3 } };
  const container = mk('div');
  await renderAiAssistant(container);
  await tick();
  assert.ok(textOf(container).includes('ИИ отвечает в чатах'));
  assert.ok(textOf(container).includes('Отвечают операторы'));
  assert.ok(!textOf(container).includes('ИИ не знает ни одной услуги'), 'услуги есть — предупреждения нет');
  const sw = switchOf(container);
  assert.ok(!('disabled' in sw.attrs), 'модуль есть, права есть — переключатель доступен');
  sw.checked = true;
  sw.dispatchEvent({ type: 'change' });
  await tick();
  assert.deepEqual(rpcCalls.at(-1), ['ai_settings_save', { enabled: true }]);
  assert.ok(textOf(container).includes('Отвечает ИИ'));
  assert.equal(toastMsg, 'ИИ отвечает в чатах.');
});

test('AI_CHAT_V1: лимит и нет модуля — сказано словами', async () => {
  rpcAnswers.ai_settings_get = { enabled: true, enabled_at: 'x', blocked: 'limit', has_module: true, facts: { services: 5, doctors: 1 } };
  const c = mk('div'); await renderAiAssistant(c); await tick();
  assert.ok(textOf(c).includes('Месячный лимит ИИ исчерпан'));

  rpcAnswers.ai_settings_get = { enabled: false, enabled_at: null, blocked: '', has_module: false, facts: { services: 5, doctors: 1 } };
  const c2 = mk('div'); await renderAiAssistant(c2); await tick();
  assert.ok(textOf(c2).includes('Модуль «ИИ-помощник» не подключён'));
  assert.ok('disabled' in switchOf(c2).attrs, 'без модуля включить нельзя — переключатель выключен');
});

test('AI_CHAT_V1 (A8): ни одной услуги на сайте — экран говорит, где их отметить', async () => {
  rpcAnswers.ai_settings_get = { enabled: true, enabled_at: 'x', blocked: '', has_module: true, facts: { services: 0, doctors: 2 } };
  const c = mk('div'); await renderAiAssistant(c); await tick();
  assert.ok(textOf(c).includes('ИИ не знает ни одной услуги: отметьте услуги для показа на сайте в «Настройки → Услуги для сайта и партнёров»'));
  assert.equal(byAttr(c, 'data-ai-no-services').length, 1);
});

test('AI_CHAT_V1: отказ 402 — фраза сервера в тосте, переключатель на месте', async () => {
  rpcAnswers.ai_settings_get = { enabled: false, enabled_at: null, blocked: '', has_module: true, facts: { services: 5, doctors: 1 } };
  rpcAnswers.ai_settings_save = { __status: 402, __error: { code: 'module_missing', message: 'Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.' } };
  toastMsg = null;
  const c = mk('div'); await renderAiAssistant(c); await tick();
  const sw = switchOf(c);
  sw.checked = true;
  sw.dispatchEvent({ type: 'change' });
  await tick();
  assert.ok(String(toastMsg).includes('Не удалось изменить переключатель.'));
  assert.ok(String(toastMsg).includes('Модуль «ИИ-помощник» не подключён'));
  assert.ok(!switchOf(c).checked, 'переключатель вернулся в «выключено»');
  assert.ok(textOf(c).includes('Отвечают операторы'));
});

test('AI_CHAT_V1: сбой загрузки — сказано, а не пустая карточка', async () => {
  rpcAnswers.ai_settings_get = { __status: 500, __error: { message: 'boom' } };
  const c = mk('div'); await renderAiAssistant(c); await tick();
  assert.ok(textOf(c).includes('Не удалось загрузить настройки ИИ.'));
});

// --- «Чат с пациентами» ------------------------------------------------------
const NOW = new Date().toISOString();
function tgServer({ flags }) {
  marks.__resetAiFlagsCache();   // отметки кэшируются на 30 с — каждый тест со своими
  rpcAnswers.telegram_chats_list = { chats: [
    { chat_id: '777', tg_name: 'Пациент Один', tg_username: '', patients: [], unread: 1, last_text: 'Сколько стоит?', last_direction: 'in', last_at: NOW, folders: [], blocked: false },
    { chat_id: '888', tg_name: 'Пациент Два', tg_username: '', patients: [], unread: 0, last_text: 'Спасибо', last_direction: 'out', last_at: NOW, folders: [], blocked: false },
  ], unread: 1, folders: [] };
  rpcAnswers.telegram_chat_messages = { messages: [
    { id: 1, direction: 'in', kind: 'text', text: 'Сколько стоит УЗИ?', created_at: NOW, by_ai: 0 },
    { id: 2, direction: 'out', kind: 'text', text: 'УЗИ брюшной полости — 150 000 сум.', created_at: NOW, by_ai: 1 },
    { id: 3, direction: 'out', kind: 'text', text: 'Ждём вас.', created_at: NOW, by_ai: 0, author: 'Иванова' },
  ], can_reply: true, patients: [], chat: { chat_id: '777', tg_name: 'Пациент Один' }, blocked: false, phone: '' };
  rpcAnswers.ai_flags = flags;
  rpcAnswers.ai_settings_get = { enabled: true, enabled_at: 'x', blocked: '', has_module: true, facts: { services: 5, doctors: 1 } };
}

test('AI_CHAT_V1: Telegram — «Нужен оператор» у отмеченного чата, «ИИ» у ответа ИИ, чип в шапке', async (t) => {
  t.after(() => chat.__test_stopPolling());
  tgServer({ flags: [
    { channel: 'telegram', chat_key: '777', reason: 'medical', flagged_at: NOW },
    { channel: 'meta_dm', chat_key: '888', reason: 'medical', flagged_at: NOW },   // чужой канал — не наш чат 888
  ] });
  const root = mk('div');
  await chat.renderTelegramChat(root, {});
  await tick(60);
  assert.deepEqual(byAttr(root, 'data-ai-flag').map((n) => n.attrs['data-ai-flag']), ['777']);
  assert.ok(textOf(root).includes('Нужен оператор'));
  const chip = byAttr(root, 'data-ai-status')[0];
  assert.ok(chip, 'чип состояния ИИ в шапке');
  assert.equal(chip.textContent, 'Отвечает ИИ');

  const row = walk(root).find((n) => n._l.click && textOf(n).includes('Пациент Один'));
  row.click();
  await tick(60);
  const marks = byAttr(root, 'data-ai-msg');
  assert.equal(marks.length, 1, 'помечен ровно ответ ИИ, а не ответ сотрудника');
  assert.ok(textOf(marks[0]).includes('ИИ'));
});

test('AI_CHAT_V1: Telegram — ai_flags отказал, список рисуется без пометок', async (t) => {
  t.after(() => chat.__test_stopPolling());
  tgServer({ flags: { __status: 403, __error: { message: 'Чаты недоступны вашей роли.' } } });
  rpcAnswers.ai_settings_get = { __status: 403, __error: { message: 'нет' } };
  const root = mk('div');
  await chat.renderTelegramChat(root, {});
  await tick(60);
  assert.ok(textOf(root).includes('Пациент Один'));
  assert.equal(byAttr(root, 'data-ai-flag').length, 0);
  const chip = byAttr(root, 'data-ai-status')[0];
  assert.ok(!chip || !chip.textContent, 'отказ ai_settings_get — чип пуст и скрыт');
});

test('AI_CHAT_V1: ai_flags — не чаще раза в 30 секунд; сбой не кэшируется', async () => {
  marks.__resetAiFlagsCache();
  rpcAnswers.ai_flags = [{ channel: 'telegram', chat_key: '1', reason: 'medical', flagged_at: NOW }];
  const count = () => rpcCalls.filter((c) => c[0] === 'ai_flags').length;
  const before = count();
  const t0 = 1_000_000;
  assert.deepEqual([...await marks.loadAiFlags('telegram', t0)], ['telegram:1']);
  assert.deepEqual([...await marks.loadAiFlags('telegram', t0 + 15_000)], ['telegram:1'], 'из кэша');
  assert.deepEqual([...await marks.loadAiFlags('meta_dm', t0 + 15_000)], [], 'кэш фильтруется по каналу');
  assert.equal(count() - before, 1, 'за 30 с — один запрос');
  rpcAnswers.ai_flags = [];
  assert.deepEqual([...await marks.loadAiFlags('telegram', t0 + 30_000)], [], 'через 30 с — свежий ответ');
  assert.equal(count() - before, 2);

  marks.__resetAiFlagsCache();
  rpcAnswers.ai_flags = { __status: 500, __error: { message: 'boom' } };
  assert.equal((await marks.loadAiFlags('telegram', t0)).size, 0);
  assert.equal((await marks.loadAiFlags('telegram', t0 + 1)).size, 0);
  assert.equal(count() - before, 4, 'отказ не кэшируется — спрашиваем снова');
});

test('AI_CHAT_V1: переключатель — role=switch и подпись', async () => {
  rpcAnswers.ai_settings_get = { enabled: false, blocked: '', has_module: true, facts: { services: 1, doctors: 1 } };
  const c = mk('div'); await renderAiAssistant(c); await tick();
  const sw = switchOf(c);
  assert.equal(sw.attrs.role, 'switch');
  assert.equal(sw.attrs['aria-label'], 'ИИ отвечает в чатах');
});

// AI_CHAT_V1: включён, но остановлен (лимит, нет модуля) — ИИ пациентам не
// отвечает; «Отвечает ИИ» при этом было бы неправдой.
test('AI_CHAT_V1: включён, но остановлен — «ИИ остановлен» на экране и в чипе', async () => {
  rpcAnswers.ai_settings_get = { enabled: true, enabled_at: 'x', blocked: 'limit', has_module: true, facts: { services: 5, doctors: 1 } };
  const c = mk('div'); await renderAiAssistant(c); await tick();
  const label = byAttr(c, 'data-ai-state')[0];
  assert.equal(label.attrs['data-ai-state'], 'stopped');
  assert.ok(textOf(c).includes('ИИ остановлен'));
  assert.ok(!textOf(c).includes('Отвечает ИИ'));
  assert.ok(String(label.className).includes('is-stopped'));

  const chip = marks.aiStatusChip();
  await tick();
  assert.equal(chip.textContent, 'ИИ остановлен');
  assert.ok(String(chip.className).includes('is-stopped'));
  assert.equal(chip.hidden, false);

  assert.deepEqual(marks.aiStateOf({ enabled: true, blocked: '' }).key, 'on');
  assert.deepEqual(marks.aiStateOf({ enabled: true, blocked: 'no_module' }).key, 'stopped');
  assert.deepEqual(marks.aiStateOf({ enabled: false, blocked: 'limit' }).key, 'off');
  assert.deepEqual(marks.aiStateOf(null).key, 'off');
});
