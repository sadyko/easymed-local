// TELEGRAM_CHAT_FILE_V1 — скрепка в панели ответа.
//
// Тест гоняет НАСТОЯЩИЙ вид, а не его пересказ: выбирает файл через тот же
// <input type=file>, что и оператор, и проверяет четыре вещи, на которых это
// ломается незаметно — выбранное видно до отправки, слишком большой файл не
// доходит до заливки, вложение переживает опрос ленты (ровно та беда, что была
// с черновиком), а отправка сперва кладёт файл в хранилище и только потом
// зовёт RPC.

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

let MESSAGES = [{ id: 1, direction: 'in', kind: 'text', text: 'Tahlil natijalarimni yuboring', created_at: '2026-08-19T11:23:00Z' }];
const uploads = [];      // что ушло в /api/storage
const sentFiles = [];    // с чем позвали telegram_chat_send_file

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (data) => ({ ok: true, json: async () => ({ data }), headers: { getSetCookie: () => [] } });

  if (u.startsWith('/api/storage/')) {
    uploads.push({ url: u, body: opts.body });
    return ok({ path: u.split('/').slice(4).join('/'), size: (opts.body && opts.body.size) || 0 });
  }
  const name = u.split('/api/rpc/')[1] || '';
  if (name === 'telegram_chats_list') {
    return ok({ chats: [{ chat_id: '777', tg_name: 'GQ', tg_username: '', patients: [], unread: 0, last_text: '…', last_direction: 'in', last_at: '2026-08-19T11:23:00Z', folders: [], blocked: false }], unread: 0, folders: [] });
  }
  if (name === 'telegram_chat_messages') {
    return ok({ messages: MESSAGES, can_reply: true, patients: [], chat: { chat_id: '777', tg_name: 'GQ' }, blocked: false, phone: '998973339329' });
  }
  if (name === 'telegram_chat_send_file') {
    sentFiles.push(JSON.parse(opts.body));
    return ok({ ok: true });
  }
  return ok({});
};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const fakeFile = (name, size, type = 'application/pdf') => ({ name, size, type });

test('оператор прикрепляет файл и он уходит пациенту', async (t) => {
  const chat = await import('../views/telegram-chat.js');
  // Опрос по setInterval держит процесс живым — снимаем его ДАЖЕ если тест
  // упадёт, иначе падение превращается в зависший прогон всего набора.
  t.after(() => chat.__test_stopPolling());
  const root = mk('div');
  await chat.renderTelegramChat(root, {});
  await new Promise((r) => setTimeout(r, 60));

  const all = () => walk(root).concat(walk(document.body));
  const openable = walk(root).find((n) => n._l.click && walk(n).map((x) => x._t || '').join(' ').includes('GQ'));
  openable && openable.click();
  await new Promise((r) => setTimeout(r, 60));

  const picker = () => all().find((n) => n.tagName === 'INPUT' && n.attrs.type === 'file');
  // Текст живёт в текстовых узлах, а не в самих элементах.
  const trayText = () => all().map((n) => n._t || '').join(' | ');
  const choose = (...files) => {
    const p = picker();
    p.files = files;
    p.dispatchEvent({ type: 'change', currentTarget: p, target: p });
  };

  // Скрепка стоит там, куда её просили: в панели ответа, рядом с «отправить».
  assert.ok(picker(), 'выбор файла должен быть в панели ответа');
  const clip = all().find((n) => n.tagName === 'BUTTON' && /рикрепить/.test(n.attrs.title || ''));
  assert.ok(clip, 'кнопка «Прикрепить файл» должна быть');

  // 1. Выбранное видно ДО отправки — иначе «что сейчас уйдёт пациенту» знает
  //    только память оператора.
  choose(fakeFile('Анализ крови.pdf', 240000));
  assert.ok(trayText().includes('Анализ крови.pdf'), 'выбранный файл должен быть виден: ' + trayText());

  // 2. Слишком большой файл отсекается ЗДЕСЬ, а не после минуты заливки.
  choose(fakeFile('снимок.zip', 25 * 1024 * 1024));
  assert.ok(!trayText().includes('снимок.zip'), 'файл больше 20 МБ не должен попасть в отправку');
  assert.strictEqual(uploads.length, 0, 'и тем более не должен уйти в хранилище');

  // 3. Пришло новое сообщение — панель пересобирается. Вложение обязано
  //    пережить это ровно так же, как черновик (TELEGRAM_DRAFT_KEEP_V1).
  MESSAGES = MESSAGES.concat([{ id: 2, direction: 'in', kind: 'text', text: 'Ало?', created_at: '2026-08-19T11:30:00Z' }]);
  await chat.__test_refreshThread();
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(trayText().includes('Анализ крови.pdf'), 'вложение не должно пропадать при опросе ленты');

  // 4. Отправка: сперва файл в хранилище клиники, потом RPC с путём и именем.
  const input = all().find((n) => n.tagName === 'TEXTAREA');
  input.type('Ваши результаты');
  const send = all().find((n) => n.tagName === 'BUTTON' && /тправить/.test(n.attrs.title || ''));
  send.click();
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(uploads.length, 1, 'файл должен быть загружен один раз');
  assert.ok(uploads[0].url.startsWith('/api/storage/telegram-media/chat/777/'),
    'кладём в корзину бота, в папку этого чата: ' + uploads[0].url);
  assert.strictEqual(sentFiles.length, 1);
  assert.strictEqual(sentFiles[0].chat_id, '777');
  assert.strictEqual(sentFiles[0].name, 'Анализ крови.pdf', 'пациент видит имя, которое дал оператор');
  assert.strictEqual(sentFiles[0].caption, 'Ваши результаты', 'текст уходит подписью к файлу');
  assert.ok(sentFiles[0].path, 'путь в хранилище обязателен');

  // Отправленное не должно остаться в панели и уйти второй раз.
  assert.ok(!trayText().includes('Анализ крови.pdf'), 'после отправки вложение убирается');

  console.log('\nprepared :', trayText() || '(пусто)');
  console.log('uploaded :', uploads[0].url);
  console.log('sent     :', JSON.stringify(sentFiles[0]));

});
