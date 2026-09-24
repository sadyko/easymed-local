// INPATIENT_SHARE_V1, ревью (PLUS) — «Зарплата врачей — доля от услуг»
// (views/doctor-pay.js) сохраняла ставки через /api/db в users, а реестр такую
// запись отклоняет: экран говорил «обновлено», а ставки не менялись.
//
// Стенд: настоящий сервер (createApp) за фальшивым fetch экрана, вход
// администратором — сохранение обязано ДОЙТИ до users.service_rates врача,
// с каноническим ключом pct и со всеми прочими ключами строки.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.checked=false;this.disabled=false;}
 appendChild(c){this.children.push(c);c.parentElement=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.appendChild(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true;} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;} removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){if(this.parentElement)this.parentElement.removeChild(this);} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? TOAST_EL : null),
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : (store.get(k) ?? null)), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; }, easymed: { state: { user: { id: 1, role: 'admin' } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

const realFetch = globalThis.fetch;
const db = openDb(':memory:');
migrate(db);
db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,?,?,?,?)').run('boss', hashPassword('password1'), 'Boss', 'admin');
db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
            VALUES (7,'doc','x','Хирургов Хасан','doctor',1,?)`).run(JSON.stringify([
  { service_id: 1, pct: 30, inpatient_pct: 20, branches: [1] },
  { service_id: 2, pct: 0, fix: 50000, branches: [] },
]));
db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Аппендэктомия',1000000), (2,'Перевязка',100000), (3,'УЗИ',200000)").run();
const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'password1' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const writes = [];
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('/api/users/')) writes.push(u);
  return realFetch(base + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });
};

after(() => new Promise((r) => server.close(r)));   // и при упавшей проверке

const { renderDoctorPay } = await import('../views/doctor-pay.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ratesOf = (id) => JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(id).service_rates);
const labelWith = (root, text) => tags(root, 'label').find((l) => textOf(l).includes(text));
const tick = (el) => { el.checked = true; el.dispatchEvent({ type: 'change', target: el }); };

async function open() {
  const host = mk('div');
  await renderDoctorPay(host);
  await flush();
  return host;
}

test('«Выбранные врачи»: доля доходит до service_rates врача ключом pct, прочие ключи строки целы', async () => {
  const host = await open();
  tick(tags(labelWith(host, 'Аппендэктомия'), 'input')[0]);
  tick(tags(labelWith(host, 'УЗИ'), 'input')[0]);
  const pct = tags(host, 'input').find((n) => n.attrs.type === 'number');
  pct.value = '45';
  tick(tags(labelWith(host, 'Выбранные врачи'), 'input')[0]);
  tick(tags(labelWith(host, 'Хирургов Хасан'), 'input')[0]);
  tags(host, 'button').find((b) => textOf(b).includes('Применить долю')).click();
  await flush(60);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(writes, ['/api/users/7'], 'сохранение не ушло маршрутом сотрудников');
  const rates = ratesOf(7);
  const of = (id) => rates.find((r) => Number(r.service_id) === id);
  assert.equal(of(1).pct, 45, 'доля не записана');
  assert.equal(of(1).inpatient_pct, 20, 'стационарная доля потерялась');
  assert.deepEqual(of(1).branches, [1]);
  assert.equal(of(3).pct, 45, 'новая строка не добавлена');
  assert.equal(of(2).fix, 50000, 'чужая строка тронута');
  assert.ok(!rates.some((r) => 'percentage' in r));
});

test('«Все врачи»: доля по умолчанию у услуги и обновление строк врачей, у которых услуга есть', async () => {
  writes.length = 0;
  const host = await open();
  tick(tags(labelWith(host, 'Перевязка'), 'input')[0]);
  const pct = tags(host, 'input').find((n) => n.attrs.type === 'number');
  pct.value = '12';
  tags(host, 'button').find((b) => textOf(b).includes('Применить долю')).click();
  await flush(60);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(db.prepare('SELECT default_doctor_percent AS p FROM services WHERE id = 2').get().p, 12);
  const bandage = ratesOf(7).find((r) => Number(r.service_id) === 2);
  assert.equal(bandage.pct, 12);
  assert.equal(bandage.fix, 50000, 'фиксированная ставка стёрта');
});
