// FIX_318_V1 (M2, ревью 3.18.0) — вкладка «Реферирование → Telegram-бот»:
// подключение врача ждёт подтверждения администратора. Ждущие — своей
// карточкой «Ожидают подтверждения» (врач, последние цифры присланного номера,
// дата) с кнопками «Подтвердить» / «Отклонить»; в «Подключённые» попадают
// только подтверждённые; плитка «Ждут подтверждения».
// Fake-DOM harness — как в referrals-view.test.mjs, включая pin 'admin.lang'='ru' ДО импортов.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;} remove(){}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x!==c).join(' ');},toggle(c,on){ if(on===undefined) on=!this.contains(c); if(on) this.add(c); else this.remove(c);}};}
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
const bodyEl = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:bodyEl,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.history = { replaceState(){} };
let confirmAnswer = true;
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: { id: 1, role: 'admin' } } },
  open: () => null, confirm: () => confirmAnswer };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, name, v) => walk(root).filter((n) => name in n.attrs && (v === undefined || n.attrs[name] === String(v)));
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const calls = [];
let links = [];
function seedLinks() {
  links = [
    { id: 11, status: 'pending', phone_tail: '6570', source_id: 2, source_name: 'Набиев Ойбек', source_code: '0086', source_phone: '+998 90 310 65 70',
      tg_name: 'Ойбек', tg_username: 'oybek', linked_at: '2026-10-27T09:00:00Z', notifications: 0 },
    { id: 12, status: 'confirmed', phone_tail: '8887', source_id: 1, source_name: 'Абдурахманова Дилара', source_code: '0003', source_phone: '998912098887',
      tg_name: 'Дилара', tg_username: '', linked_at: '2026-10-20T09:00:00Z', last_notified_at: '2026-10-26T09:00:00Z', notifications: 3 },
  ];
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body });
    if (name === 'doctor_bot_settings_get') return jsonOk({ enabled: true, has_token: true, token_hint: 'abcd', bot_username: 'clinic_doctors_bot', last_check_status: 'ok',
      message_template: 'Здравствуйте! {пациент} & Ко, {дата}.' + String.fromCharCode(10) + '{услуги}' + String.fromCharCode(10) + 'Спасибо!' });
    if (name === 'doctor_bot_settings_save') return jsonOk({ enabled: true, has_token: true, token_hint: 'abcd', bot_username: 'clinic_doctors_bot', last_check_status: 'ok', message_template: body.message_template });
    if (name === 'doctor_bot_stats') return jsonOk({ doctors_active: 5, with_phone: 4, connected: links.filter((l) => l.status === 'confirmed').length,
      pending: links.filter((l) => l.status === 'pending').length, without_phone: 1, notifications_30d: 3, viewed_30d: 1 });
    if (name === 'doctor_bot_links_list') return jsonOk(links.map((l) => ({ ...l })));
    if (name === 'doctor_bot_link_confirm') { const l = links.find((x) => x.id === body.id); l.status = 'confirmed'; return jsonOk({ id: body.id, confirmed: true }); }
    if (name === 'doctor_bot_link_reject') { links = links.filter((x) => x.id !== body.id); return jsonOk({ id: body.id, rejected: true }); }
    return jsonOk({});
  }
  return jsonOk({});
};

const { renderReferralsBot } = await import('../views/referrals-bot.js');
const { DEFAULT_TEMPLATE } = await import('../doctor-bot-message.js');

async function mount() {
  calls.length = 0; toastMsg = null; seedLinks();
  const host = mk('div');
  await renderReferralsBot(host);
  await tick();
  return host;
}

test('ждущее подключение — в карточке «Ожидают подтверждения» с хвостом номера и датой; в «Подключённых» — только подтверждённые; плитка «Ждут подтверждения»', async () => {
  const host = await mount();
  const card = byAttr(host, 'data-bot-pending')[0];
  assert.ok(card, 'карточка ожидающих есть');
  const t = textOf(card);
  assert.ok(t.includes('Ожидают подтверждения') && t.includes('Набиев Ойбек') && t.includes('…6570') && t.includes('27.10.2026'), t);
  assert.ok(!t.includes('Абдурахманова Дилара'), 'подтверждённый — не в ожидающих');
  assert.ok(byAttr(card, 'data-bot-confirm', 11)[0] && byAttr(card, 'data-bot-reject', 11)[0], 'кнопки «Подтвердить» и «Отклонить»');
  assert.equal(byAttr(host, 'data-bot-revoke', 11).length, 0, 'ждущий не в «Подключённых»');
  assert.equal(byAttr(host, 'data-bot-revoke', 12).length, 1, 'подтверждённый — в «Подключённых»');
  const tile = byAttr(host, 'data-kpi', 'Ждут подтверждения')[0];
  assert.ok(tile && textOf(tile).includes('1'));
});

test('«Подтвердить» шлёт doctor_bot_link_confirm { id } и перерисовывает: врач уходит в «Подключённые»', async () => {
  const host = await mount();
  byAttr(host, 'data-bot-confirm', 11)[0].click();
  await tick(40);
  assert.deepEqual(calls.filter((c) => c.name === 'doctor_bot_link_confirm').map((c) => c.body), [{ id: 11 }]);
  assert.equal(toastMsg, 'Подключение подтверждено — врач будет получать уведомления.');
  assert.equal(byAttr(host, 'data-bot-pending').length, 0, 'ждущих больше нет');
  assert.equal(byAttr(host, 'data-bot-revoke', 11).length, 1);
});

test('«Отклонить» — с вопросом; отказ в вопросе ничего не шлёт; согласие шлёт doctor_bot_link_reject { id }', async () => {
  const host = await mount();
  confirmAnswer = false;
  byAttr(host, 'data-bot-reject', 11)[0].click();
  await tick(40);
  assert.equal(calls.filter((c) => c.name === 'doctor_bot_link_reject').length, 0);
  confirmAnswer = true;
  byAttr(host, 'data-bot-reject', 11)[0].click();
  await tick(40);
  assert.deepEqual(calls.filter((c) => c.name === 'doctor_bot_link_reject').map((c) => c.body), [{ id: 11 }]);
  assert.equal(toastMsg, 'Подключение отклонено.');
  assert.equal(byAttr(host, 'data-bot-pending').length, 0);
});

// DOCTOR_BOT_TEMPLATE_V1 — «Сообщение врачу»: текст клиники в поле, справа — как увидит
// врач (строки по одной, {пациент} — жирным узлом, не innerHTML; «&» не превращается в
// разметку); без {пациент} сохранить нельзя; «Сохранить текст» шлёт message_template.
test('DOCTOR_BOT_TEMPLATE_V1: текст сообщения правится, образец меняется сразу, сохраняется через doctor_bot_settings_save', async () => {
  const host = await mount();
  const area = byAttr(host, 'data-bot-template')[0];
  assert.ok(area, 'поле текста есть');
  assert.equal(area.value, 'Здравствуйте! {пациент} & Ко, {дата}.\n{услуги}\nСпасибо!');
  const bubble = byAttr(host, 'data-bot-sample')[0];
  let t = textOf(bubble);
  assert.ok(t.includes('Здравствуйте! Иванов Иван Иванович & Ко') && t.includes('• УЗИ брюшной полости') && t.includes('Спасибо!'), t);
  assert.ok(!t.includes('<b>') && !t.includes('&amp;') && !t.includes('{пациент}'), 'разметка и метки не видны как текст: ' + t);
  const bold = walk(bubble).find((n) => n.tagName === 'B');
  assert.ok(bold && textOf(bold) === 'Иванов Иван Иванович');
  assert.ok(textOf(host).includes('Сообщение врачу') && textOf(host).includes('Получил · Oldim'));

  const save = byAttr(host, 'data-bot-template-save')[0];
  assert.equal(save.disabled, true, 'без изменений сохранять нечего');
  area.value = 'Без метки';
  area.dispatchEvent({ type: 'input' });
  assert.ok(textOf(byAttr(host, 'data-bot-template-problem')[0]).includes('{пациент}'), 'объяснено, чего не хватает');
  assert.equal(save.disabled, true, 'без {пациент} — не сохранить');

  area.value = 'Новый: {пациент}';
  area.dispatchEvent({ type: 'input' });
  assert.ok(textOf(byAttr(host, 'data-bot-sample')[0]).includes('Новый: Иванов Иван Иванович'), 'образец обновился сразу');
  assert.equal(save.disabled, false);
  save.click();
  await tick(40);
  assert.deepEqual(calls.filter((c) => c.name === 'doctor_bot_settings_save').map((c) => c.body), [{ message_template: 'Новый: {пациент}' }]);
  assert.equal(toastMsg, 'Текст сообщения сохранён — врачи будут получать его.');
  assert.equal(byAttr(host, 'data-bot-template')[0].value, 'Новый: {пациент}', 'после сохранения в поле сохранённый текст');
});

test('DOCTOR_BOT_TEMPLATE_V1: «Вернуть стандартный» ставит стандартный текст с благодарностью', async () => {
  const host = await mount();
  byAttr(host, 'data-bot-template-reset')[0].click();
  const area = byAttr(host, 'data-bot-template')[0];
  assert.equal(area.value, DEFAULT_TEMPLATE);
  assert.ok(textOf(byAttr(host, 'data-bot-sample')[0]).includes('Спасибо за доверие к нашей клинике!'));
});
