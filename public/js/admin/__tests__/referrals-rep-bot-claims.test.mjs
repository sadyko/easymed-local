// REP_BOT_CLAIMS_V1 — вкладка «Реферирование → Бот представителей»: список
// «Заявки на закрепление» (только открытые; нет заявок — нет карточки): врач,
// заявитель, кто закреплён сейчас, дата; «Подтвердить» / «Отклонить» шлют
// rep_bot_claim_decide и перерисовывают; отказ сервера — его сообщение и
// перерисовка (закрытая сервером заявка уходит из списка).
// Fake-DOM harness — как в referrals-bot-pending.test.mjs, включая pin 'admin.lang'='ru' ДО импортов.
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
const jsonErr = (message) => ({ ok: false, status: 409, json: async () => ({ error: { message } }) });
const calls = [];
let claims = [];
let decideError = null;
function seed() {
  claims = [
    { id: 5, created_at: '2026-11-19T08:00:00Z', entered_name: 'Каримов Азиз Б.', source_id: 40, source_code: '0040', source_name: 'Каримов Азиз',
      source_phone: '+998901234567', source_active: 1, requester_id: 3, requester_name: 'Юсупов Акмал', current_rep_id: 4, current_rep_name: 'Прежний Представитель' },
    { id: 6, created_at: '2026-11-20T08:00:00Z', entered_name: '', source_id: 41, source_code: '0041', source_name: 'Нарзиев Бобур',
      source_phone: '+998907777777', source_active: 0, requester_id: 3, requester_name: 'Юсупов Акмал', current_rep_id: null, current_rep_name: null },
  ];
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body });
    if (name === 'rep_bot_settings_get') return jsonOk({ enabled: true, has_token: true, token_hint: 'abcd', bot_username: 'clinic_reps_bot', last_check_status: 'ok' });
    if (name === 'rep_bot_stats') return jsonOk({ reps_active: 2, connected: 1, pending: 0, without_phone: 0, added_30d: 0 });
    if (name === 'rep_bot_links_list' || name === 'rep_bot_additions_list') return jsonOk([]);
    if (name === 'rep_bot_claims_list') return jsonOk(claims.map((c) => ({ ...c })));
    if (name === 'rep_bot_claim_decide') {
      claims = claims.filter((c) => c.id !== body.id);   // и решённая, и void — уходят из открытых
      if (decideError) return jsonErr(decideError);
      return jsonOk({ id: body.id, status: body.decision === 'approve' ? 'approved' : 'rejected' });
    }
    return jsonOk({});
  }
  return jsonOk({});
};

const { renderReferralsRepBot } = await import('../views/referrals-rep-bot.js');

async function mount() {
  calls.length = 0; toastMsg = null; decideError = null; confirmAnswer = true; seed();
  const host = mk('div');
  await renderReferralsRepBot(host);
  await tick();
  return host;
}
const decides = () => calls.filter((c) => c.name === 'rep_bot_claim_decide').map((c) => c.body);

test('открытые заявки — карточкой: врач (№, ФИО, телефон), заявитель с ФИО из анкеты, текущий представитель или «не закреплён», дата, кнопки', async () => {
  const host = await mount();
  assert.ok(calls.some((c) => c.name === 'rep_bot_claims_list'), 'список загружается вместе с остальными');
  const card = byAttr(host, 'data-repbot-claims')[0];
  assert.ok(card, 'карточка заявок есть');
  const t = textOf(card);
  for (const s of ['Заявки на закрепление', 'Каримов Азиз', '№ 0040', '+998901234567', 'Юсупов Акмал', 'В анкете: Каримов Азиз Б.',
    'Прежний Представитель', 'Нарзиев Бобур', 'не закреплён', '19.11.2026', '20.11.2026']) {
    assert.ok(t.includes(s), 'нет: ' + s);
  }
  assert.ok(byAttr(card, 'data-repbot-claim-approve', 5)[0] && byAttr(card, 'data-repbot-claim-reject', 5)[0]);
  assert.equal(byAttr(card, 'data-repbot-claim-off', 5).length, 0, 'включённый — без пометки');
  const off = byAttr(card, 'data-repbot-claim-off', 6)[0];
  assert.ok(off && textOf(off).includes('отключён'), 'выключенный врач — с пометкой «отключён»');
});

test('нет открытых заявок — карточки нет', async () => {
  calls.length = 0; toastMsg = null; claims = [];
  const host = mk('div');
  await renderReferralsRepBot(host);
  await tick();
  assert.equal(byAttr(host, 'data-repbot-claims').length, 0);
});

test('«Подтвердить» врача другого представителя — с вопросом; отказ ничего не шлёт; согласие шлёт { id, decision: approve } и перерисовывает', async () => {
  const host = await mount();
  confirmAnswer = false;
  byAttr(host, 'data-repbot-claim-approve', 5)[0].click();
  await tick(40);
  assert.deepEqual(decides(), []);
  confirmAnswer = true;
  byAttr(host, 'data-repbot-claim-approve', 5)[0].click();
  await tick(40);
  assert.deepEqual(decides(), [{ id: 5, decision: 'approve' }]);
  assert.equal(toastMsg, 'Заявка подтверждена — врач закреплён за представителем.');
  assert.equal(byAttr(host, 'data-repbot-claim-approve', 5).length, 0, 'решённая ушла');
  assert.equal(byAttr(host, 'data-repbot-claim-approve', 6).length, 1);
});

test('«Подтвердить» незакреплённого — без вопроса; «Отклонить» — с вопросом и { decision: reject }', async () => {
  const host = await mount();
  confirmAnswer = false;   // вопрос не задаётся — значит и отказ в нём не мешает
  byAttr(host, 'data-repbot-claim-approve', 6)[0].click();
  await tick(40);
  assert.deepEqual(decides(), [{ id: 6, decision: 'approve' }]);
  byAttr(host, 'data-repbot-claim-reject', 5)[0].click();
  await tick(40);
  assert.equal(decides().length, 1, 'отклонение без согласия не уходит');
  confirmAnswer = true;
  byAttr(host, 'data-repbot-claim-reject', 5)[0].click();
  await tick(40);
  assert.deepEqual(decides().at(-1), { id: 5, decision: 'reject' });
  assert.equal(toastMsg, 'Заявка отклонена.');
  assert.equal(byAttr(host, 'data-repbot-claims').length, 0, 'заявок не осталось — карточки нет');
});

test('отказ сервера (заявителя уволили — void) — сообщение сервера, заявка уходит из списка', async () => {
  const host = await mount();
  decideError = 'Заявитель больше не действующий медпредставитель (отключён или снята роль) — заявка закрыта без закрепления.';
  byAttr(host, 'data-repbot-claim-approve', 6)[0].click();
  await tick(40);
  assert.equal(toastMsg, decideError);
  assert.equal(byAttr(host, 'data-repbot-claim-approve', 6).length, 0);
});
