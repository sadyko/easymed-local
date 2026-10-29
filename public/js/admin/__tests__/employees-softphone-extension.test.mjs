// SOFTPHONE_V1 — поле «Внутренний номер (АТС)» в карточке сотрудника — НАЗНАЧЕННЫЙ
// номер (users.pbx_extension_assigned): только на нём телефон Easy-Med входит в АТС.
//
// Проверяется:
//   * поле показывает назначенный номер, а не выбранный сотрудником в «Моя трубка»;
//   * сохранение уходит с ним же (сервер назначает, только если номер поменяли);
//   * сотрудник выбрал себе другой номер — под полем пометка с этим номером;
//     выбор совпадает с назначенным или не сделан — пометки нет;
//   * подсказка «На этом номере сотрудник сможет принимать звонки…» на месте.
//
// Fake-DOM харнесс — тот же, что в employees-card-save.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);
   if (k === 'checked') this.checked = true;
   if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);}
 getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){ globalThis.__focused = this; } blur(){} scrollTo(){} remove(){} select(){}
 querySelectorAll(sel){const m=String(sel).match(/^(\w+)\[([\w-]+)(?:="([^"]*)")?\]$/);if(!m)return [];const out=[];
   const go=(e)=>{for(const c of e.children||[]){if(c.tagName===m[1].toUpperCase()&&(m[3]===undefined?(m[2] in (c.attrs||{})):(c.attrs||{})[m[2]]===m[3]))out.push(c);go(c);}};go(this);return out;}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 2, role: 'admin', is_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const op = (id, username, last, first, ext, assigned) => ({
  id, username, full_name: last + ' ' + first, last_name: last, first_name: first, middle_name: '', phone: '+998901112233',
  role: 'registrar', is_active: true, is_local: true, extra_roles: [], staff_type: 'admin_staff', is_doctor: false,
  service_rates: [], referral_rates: [], inpatient_rates: [], pbx_extension: ext, pbx_extension_assigned: assigned,
});
const USERS = [
  op(80, 'self.pick', 'Каримова', 'Азиза', '107', '108'),   // выбрала себе 107, назначен 108
  op(81, 'same.pick', 'Юсупов', 'Бобур', '108', '108'),     // выбор = назначение
  op(82, 'not.set', 'Алиева', 'Нигора', '107', ''),         // выбрала 107, ничего не назначено
  op(83, 'no.phone', 'Расулов', 'Тимур', '', ''),           // не на телефоне
];
// Сервер до миграции 259: назначенного номера в ответе нет вовсе.
const OLD = op(84, 'old.server', 'Сафарова', 'Лола', '107', undefined);
delete OLD.pbx_extension_assigned;
USERS.push(OLD);

const writes = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: USERS }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
const extField = (card) => tags(card, 'input').find((i) => i.attrs.placeholder === '101');

async function openCard(username) {
  document.body.children.length = 0;
  writes.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
  assert.ok(row, 'нет строки @' + username);
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
}
const NOTE = (n) => `Сейчас у сотрудника выбран номер ${n} — телефон Easy-Med на нём не включится, пока номер не назначен здесь. Если это его трубка — впишите номер здесь и сохраните.`;
const ADMIN_ONLY = 'Номер для телефона в Easy-Med назначает администратор.';
const SOFT_HINT = 'На этом номере сотрудник сможет принимать звонки прямо в Easy-Med.';

test('поле номера — назначенный номер; сотрудник выбрал себе другой — пометка с его номером', async () => {
  const card = await openCard('self.pick');
  assert.equal(extField(card).value, '108', 'поле показывает выбор «Моя трубка», а не назначенный номер');
  assert.ok(textOf(card).includes(NOTE('107')), 'нет пометки о самовыбранном номере');
  assert.ok(textOf(card).includes(SOFT_HINT), 'нет подсказки о телефоне Easy-Med');
});

test('сохранение без правки поля уходит с назначенным номером (сервер ничего не назначит)', async () => {
  const card = await openCard('self.pick');
  type(tags(card, 'input').find((i) => i.attrs.placeholder === 'name@example.uz'), 'k@example.uz');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  assert.equal(writes[0].body.pbx_extension, '108', 'ушёл самовыбранный номер — сохранение назначило бы его');
  assert.equal(writes[0].body.assign_extension, true, 'нет отметки новой карточки — сервер не назначит и вписанный номер');
});

test('администратор вписал номер сотрудника — уходит он с отметкой (назначение)', async () => {
  const card = await openCard('self.pick');
  assert.equal(extField(card).disabled, undefined, 'администратору поле закрыто');
  assert.ok(!textOf(card).includes(ADMIN_ONLY));
  type(extField(card), '107');
  await save(card);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.pbx_extension, '107');
  assert.equal(writes[0].body.assign_extension, true);
});

test('сервер до миграции 259 (нет pbx_extension_assigned) — поле показывает номер, пометки нет', async () => {
  const card = await openCard('old.server');
  assert.equal(extField(card).value, '107', 'поле пустое — сохранение карточки стёрло бы номер');
  assert.ok(!textOf(card).includes('сам выбрал в «Моя трубка»'), 'лишняя пометка');
});

// Назначает только администратор (routes/users.js): у того, кому выдано
// «Сотрудники → Изменение», поле только для просмотра, и сказано почему.
test('не-администратор с «Сотрудниками»: поле только для просмотра, «назначает администратор», без пометки о выборе', async () => {
  const P = await import('../permissions.js');
  const was = window.easymed.state.user;
  window.easymed.state.user = { id: 5, role: 'nurse', extra_roles: [] };
  P.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.employees': 'edit' } } });
  try {
    const card = await openCard('self.pick');
    assert.equal(extField(card).value, '108');
    assert.equal(extField(card).disabled, true, 'не-администратору поле номера открыто');
    assert.ok(textOf(card).includes(ADMIN_ONLY), 'не сказано, кто назначает номер');
    assert.ok(!textOf(card).includes('сам выбрал в «Моя трубка»'), 'пометка с действием, которого у него нет');
    assert.ok(textOf(card).includes(SOFT_HINT));
  } finally {
    P.setFullAccess();
    window.easymed.state.user = was;
  }
});

test('пометки нет, когда выбор совпадает с назначенным или не сделан', async () => {
  for (const name of ['same.pick', 'no.phone']) {
    const card = await openCard(name);
    assert.ok(!textOf(card).includes('сам выбрал в «Моя трубка»'), name + ': лишняя пометка');
    assert.ok(textOf(card).includes(SOFT_HINT), name + ': нет подсказки о телефоне Easy-Med');
  }
  assert.equal(extField(await openCard('same.pick')).value, '108');
  assert.equal(extField(await openCard('no.phone')).value, '');
});

test('ничего не назначено, а сотрудник выбрал себе номер — поле пустое, пометка есть', async () => {
  const card = await openCard('not.set');
  assert.equal(extField(card).value, '', 'самовыбранный номер показан как назначенный');
  assert.ok(textOf(card).includes(NOTE('107')));
});

test('пометка переводится шаблоном: номер подставлен и на узбекском, и на английском', async () => {
  const { setLang } = await import('../i18n.js');
  try {
    setLang('en');
    let text = textOf(await openCard('self.pick'));
    assert.ok(text.includes('The employee currently has number 107 selected — the Easy-Med phone will not turn on for it until the number is assigned here.'), 'пометка не переведена на английский');
    assert.ok(text.includes('If it is their handset, enter the number here and save.'));
    assert.ok(text.includes('The employee can take calls on this number directly in Easy-Med.'));
    setLang('uz');
    text = textOf(await openCard('self.pick'));
    assert.ok(text.includes('Hozir xodimda 107 raqami tanlangan — raqam shu yerda biriktirilmaguncha'), 'пометка не переведена на узбекский');
  } finally { setLang('ru'); }
});
