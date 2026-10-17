// LAN_ADDRESS_V1 — экран «Адрес в сети» (views/lan-address.js).
//
// Владелец: сервер клиники после перезапуска получает новый адрес, и другие
// компьютеры и анализаторы его теряют. Экран обязан: показать адрес и MAC
// (с «Копировать»), имя в сети и почему оно может не открываться (брандмауэр),
// шаги резервирования в роутере; предупредить о смене «было → стало» и дать
// администратору скрыть его до следующей смены. Кнопки — только администратору.
// Фальшивый DOM — как в system-view.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
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
const store = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — язык до импорта экрана
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, dispatchEvent(){ return true; }, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).filter((n) => n.tagName !== 'SVG').map((n) => n._t || '').join(' ');
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const button = (root, re) => buttons(root).find((b) => re.test(textOf(b)));
const settle = () => new Promise((r) => setTimeout(r, 15));

const jsonOk = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
const CHANGE = { from: ['192.168.1.147'], to: ['192.168.1.156'], at: '2026-10-16T08:00:00.000Z' };
function status(over = {}) {
  return {
    addresses: [{ adapter: 'Ethernet', address: '192.168.1.156', netmask: '255.255.255.0', mac: 'A4-BB-6D-12-34-56' }],
    port: 8000, change: CHANGE, remembered: ['192.168.1.156'],
    name: { base: 'easymed', current: 'easymed.local', url: 'http://easymed.local:8000', state: 'active', reason: '', suffixed: false },
    mdns_enabled: true, router_hint: 'http://192.168.1.1', can_manage: true, ...over,
  };
}
let ST, CALLS;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    CALLS.push([name, body]);
    if (name === 'lan_address_status') return jsonOk(ST);
    if (name === 'lan_address_dismiss') { ST = { ...ST, change: null }; return jsonOk(ST); }
    if (name === 'lan_address_mdns') { ST = { ...ST, mdns_enabled: body.enabled, name: { ...ST.name, state: body.enabled ? 'active' : 'off', reason: body.enabled ? '' : 'setting' } }; return jsonOk(ST); }
  }
  return jsonOk({});
};

const { renderLanAddress } = await import('../views/lan-address.js');
const { setLang } = await import('../i18n.js');

async function mount(st) {
  ST = st; CALLS = [];
  const root = mk('div');
  await renderLanAddress(root);
  return root;
}
test.beforeEach(() => { setLang('ru'); });

test('адрес сменился: предупреждение «было → стало», адрес, ссылка, MAC как в ipconfig, имя в сети', async () => {
  const root = await mount(status());
  const t = textOf(root);
  assert.match(t, /Адрес сервера изменился: было 192\.168\.1\.147, стало 192\.168\.1\.156\./);
  assert.match(t, /Другие компьютеры и анализаторы могут не находить сервер\. Закрепите адрес в роутере/);
  assert.ok(t.includes('http://192.168.1.156:8000'));
  assert.ok(t.includes('A4-BB-6D-12-34-56'));
  assert.ok(t.includes('Ethernet'));
  assert.ok(t.includes('http://easymed.local:8000'));
  assert.ok(t.includes('работает'));
  assert.deepEqual(CALLS.map((c) => c[0]), ['lan_address_status']);
});

test('инструкция роутера: ipconfig /all, страница роутера, TP-Link, MikroTik, Keenetic, прочие; MAC и адрес этого ПК', async () => {
  const t = textOf(await mount(status()));
  assert.ok(t.includes('ipconfig /all'));
  assert.ok(t.includes('«Физический адрес»'));
  assert.ok(t.includes('http://192.168.1.1'));
  assert.ok(t.includes('TP-Link — «DHCP → Резервирование адресов»'));
  assert.ok(t.includes('MikroTik — «IP → DHCP Server → Leases»') && t.includes('«Make Static»'));
  assert.ok(t.includes('Keenetic — «Список устройств»') && t.includes('«Постоянный IP-адрес»'));
  assert.ok(t.includes('«DHCP Reservation»'));
  assert.ok(t.includes('Впишите физический адрес A4-BB-6D-12-34-56 и адрес 192.168.1.156'));
});

test('брандмауэр и анализаторы сказаны прямо: команда netsh для UDP 5353, «анализаторам имя не поможет»', async () => {
  const t = textOf(await mount(status()));
  assert.ok(t.includes('Если имя не открывается на других компьютерах'));
  assert.ok(t.includes('netsh advfirewall firewall add rule name="EasyMed (network name)" dir=in action=allow protocol=UDP localport=5353 remoteip=localsubnet profile=private,domain'), 'правило — только своя подсеть и частная сеть');
  assert.ok(t.includes('отмечена как «Частная»'));
  assert.ok(t.includes('Анализаторы указывают адрес сервера числом'));
});

test('администратор скрывает предупреждение до следующей смены — с at именно той смены', async () => {
  const root = await mount(status());
  const b = button(root, /Скрыть до следующей смены адреса/);
  assert.ok(b, 'кнопка есть');
  b.click();
  await settle();
  assert.deepEqual(CALLS.at(-1), ['lan_address_dismiss', { at: CHANGE.at }]);
  assert.ok(!textOf(root).includes('Адрес сервера изменился'), 'предупреждение ушло');
});

test('не администратор: адрес и инструкция видны, кнопок «Скрыть» и выключателя нет — только «Копировать»', async () => {
  const root = await mount(status({ can_manage: false }));
  const t = textOf(root);
  assert.ok(t.includes('Адрес сервера изменился'));
  assert.ok(buttons(root).length > 0);
  assert.ok(buttons(root).every((b) => /Копировать/.test(textOf(b))), buttons(root).map(textOf).join(' | '));
});

test('выключатель имени: администратор выключает — lan_address_mdns {enabled:false}, метка «выключено»', async () => {
  const root = await mount(status({ change: null }));
  button(root, /Выключить имя в сети/).click();
  await settle();
  assert.deepEqual(CALLS.at(-1), ['lan_address_mdns', { enabled: false }]);
  assert.ok(textOf(root).includes('выключено'));
  assert.ok(button(root, /Включить имя в сети/));
});

test('смены нет — предупреждения нет; имя занято вторым сервером — сказано, на какое имя отвечает этот', async () => {
  const t = textOf(await mount(status({ change: null, name: { base: 'easymed', current: 'easymed-2.local', url: 'http://easymed-2.local:8000', state: 'active', reason: '', suffixed: true } })));
  assert.ok(!t.includes('Адрес сервера изменился'));
  assert.ok(t.includes('Имя easymed.local уже занято другим сервером Easy-Med в этой сети — этот компьютер отвечает на имя easymed-2.local.'));
  assert.ok(t.includes('http://easymed-2.local:8000'));
});

test('порт 5353 не открылся / нет сети — честные слова, без падения', async () => {
  let t = textOf(await mount(status({ change: null, name: { base: 'easymed', current: 'easymed.local', url: 'http://easymed.local:8000', state: 'failed', reason: 'port_busy', suffixed: false } })));
  assert.ok(t.includes('не работает'));
  assert.ok(t.includes('Имя в сети не запустилось на этом компьютере'));
  t = textOf(await mount(status({ change: null, addresses: [] })));
  assert.ok(t.includes('Этот компьютер сейчас не подключён к сети'));
});

test('две сетевые карты — обе с MAC, и подсказка, адрес какой из них закреплять', async () => {
  const t = textOf(await mount(status({ change: null, addresses: [
    { adapter: 'Ethernet', address: '192.168.0.20', netmask: '255.255.255.0', mac: 'D8-5E-D3-01-02-03' },
    { adapter: 'Wi-Fi', address: '192.168.1.145', netmask: '255.255.255.0', mac: 'A4-BB-6D-12-34-56' }] })));
  assert.ok(t.includes('D8-5E-D3-01-02-03') && t.includes('A4-BB-6D-12-34-56'));
  assert.ok(t.includes('несколько сетевых карт'));
});

test('английский экран — по-английски, без кириллицы в словах экрана', async () => {
  setLang('en');
  const t = textOf(await mount(status()));
  assert.ok(t.includes('Server address changed: was 192.168.1.147, now 192.168.1.156.'), t.slice(0, 300));
  assert.ok(t.includes('How to fix the address in the router'));
  const cyr = t.match(/[А-Яа-яЁё][А-Яа-яЁё ]*/g) || [];
  assert.deepEqual(cyr, [], 'кириллица на английском экране: ' + cyr.join(' | '));
});

test('узбекский экран — без кириллицы', async () => {
  setLang('uz');
  const t = textOf(await mount(status({ name: { base: 'easymed', current: 'easymed-2.local', url: 'http://easymed-2.local:8000', state: 'active', reason: 'no_multicast', suffixed: true } })));
  const cyr = t.match(/[А-Яа-яЁё][А-Яа-яЁё ]*/g) || [];
  assert.deepEqual(cyr, [], 'кириллица на узбекском экране: ' + cyr.join(' | '));
});

test('иконки — только Icon(), эмодзи в исходнике экрана нет', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'lan-address.js'), 'utf8');
  assert.equal(/\p{Extended_Pictographic}/u.test(src), false);
});
