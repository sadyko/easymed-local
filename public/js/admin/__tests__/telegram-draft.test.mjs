// TELEGRAM_DRAFT_KEEP_V1 — набранный ответ не должен исчезать.
//
// Лента опрашивается раз в 10 секунд, и раньше КАЖДЫЙ ответ сервера пересобирал
// панель вместе с полем ввода: сотрудник печатал пациенту, и фраза пропадала на
// середине слова. Тест гоняет НАСТОЯЩИЙ вид: печатает, вызывает опрос и
// проверяет, что текст на месте — и когда нового нет, и когда пришло сообщение
// (тогда перерисовка нужна, но черновик обязан пережить её).

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.scrollHeight=20;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
 type(v){this.value=v;this.dispatchEvent({type:'input',currentTarget:this,target:this});}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;} get options(){return this.children.filter(c=>c.tagName==='OPTION');}
 get label(){return this.attrs.label!==undefined?this.attrs.label:this._t;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
const mk=t=>{const e=new F(t);if(e.tagName==='TEMPLATE'){e.content={firstChild:null};Object.defineProperty(e,'innerHTML',{set(v){const s=new F('svg');s._t=String(v);e.content.firstChild=s;},get(){return '';}});}return e;};
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
globalThis.window={location:{hostname:'localhost'},localStorage:{getItem:()=>null,setItem(){}},addEventListener(){}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

// The bot thread the screenshot shows: unchanged between polls.
let MESSAGES = [{ id: 1, direction: 'out', kind: 'system', text: 'Здравствуйте! Это официальный бот клиники «Novo Medics».', created_at: '2026-08-19T09:56:00Z' }];
let polls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const name = String(url).split('/api/rpc/')[1] || '';
  const ok = (data) => ({ ok: true, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
  if (name === 'telegram_chats_list') return ok({ chats: [{ chat_id: '777', tg_name: 'Пациент', tg_username: '', patients: [], unread: 0, last_text: '…', last_direction: 'out', last_at: '2026-08-19T09:56:00Z', folders: [], blocked: false }], unread: 0, folders: [] });
  if (name === 'telegram_chat_messages') { polls++; return ok({ messages: MESSAGES, can_reply: true, patients: [], chat: { chat_id: '777', tg_name: 'Пациент' }, blocked: false, phone: '998900000000' }); }
  return ok({});
};


const DRAFT = 'Здравствуйте, результаты гото';

test('набранный ответ переживает опрос ленты', async (t) => {
const chat = await import('../views/telegram-chat.js');
  // Раньше здесь стоял process.exit(): опрос по setInterval не давал прогону
  // завершиться. Но выход процессом маскирует падения — снимаем интервал
  // штатно, и он снимется даже если тест упадёт.
  t.after(() => chat.__test_stopPolling());
const root = mk('div');
await chat.renderTelegramChat(root, {});
await new Promise(r => setTimeout(r, 60));

const walk=(e,o=[])=>{o.push(e);for(const c of e.children||[])walk(c,o);return o;};
const findInput = () => walk(root).concat(walk(document.body)).find(n => n.tagName === 'TEXTAREA');

// open the chat
const openable = walk(root).find(n => n._l.click && (walk(n).map(x=>x._t||'').join(' ')).includes('Пациент'));
openable && openable.click();
await new Promise(r => setTimeout(r, 60));

  let input = findInput();
assert.ok(input, 'поле ответа должно быть');

input.type(DRAFT);


// poll with NO new messages — the reported case
await chat.__test_refreshThread();
await new Promise(r => setTimeout(r, 40));
  let after = findInput();
assert.strictEqual(after.value, DRAFT, 'опрос без новых сообщений НЕ должен трогать поле');
  assert.strictEqual(after === input, true, 'панель вообще не перерисовывалась');

// poll WITH a new message — panel must repaint, draft must survive
MESSAGES = MESSAGES.concat([{ id: 2, direction: 'in', kind: 'text', text: 'Ало?', created_at: '2026-08-19T10:00:00Z' }]);
await chat.__test_refreshThread();
await new Promise(r => setTimeout(r, 40));
  const after2 = findInput();
  assert.strictEqual(after2 !== after, true, 'новое сообщение обязано перерисовать ленту');
  assert.strictEqual(after2.value, DRAFT, 'черновик обязан пережить перерисовку');

  console.log('\nverdict : набранный ответ переживает и опрос, и приход нового сообщения');
});
