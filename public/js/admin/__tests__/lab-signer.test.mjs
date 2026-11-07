// PRINT_PERFORMER_V1 (решение владельца 2026-11-07, п. 9) — бланк анализов
// подписывает тот, кто их ПОДТВЕРДИЛ («Проверить и выдать»: verified_by строки), с
// ролью «Врач-лаборант» — и при перепечатке («Бланк»), а не только в момент
// подтверждения; в «Документах» — не лечащий врач визита. Поддельный DOM и /api/db —
// из lab-tube-label.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';

// Время на этикетке — местное. На Windows Node понимает только имя IANA
// («UZT-5» молча читается как UTC) — пояс задаётся до первого Date.
process.env.TZ = 'Asia/Tashkent';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
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
const fakeBody = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:fakeBody,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида

// Окно печати этикеток: сколько открыто и что в него написано.
let printed = [];
let opened = 0;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
  open: () => { opened++; return { document: { open() {}, write(s) { printed.push(String(s)); }, close() {} } }; },
};
globalThis.confirm = () => false;
globalThis.alert = (m) => { throw new Error('alert: ' + m); };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} } },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db ------------------------------------------------------
const PATIENT = { id: 'p-20', full_name: 'Тестов Пациент Тестович', mrn: 'P-26-00020', gender: 'female', date_of_birth: '1990-02-03' };
// Ревью U11, L6 — визит и строки заведены СЕГОДНЯ (местный полдень): пробирку старше
// 7 дней карточка не печатает, и тест с днём, вписанным в код, через неделю
// перестал бы печатать вовсе. Время забора (19:06) — по-прежнему своё, 2 ноября.
const TODAY_NOON = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString(); })();
const daysAgoNoon = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const VISITS = [{ id: 20, visit_date: TODAY_NOON, patients: PATIENT }];
let VISIT_SERVICES = [];
let LAB_PANELS = [];
let LAB_RESULTS = [];   // К4 — результат у возвращённой строки
let REFUNDED = [];
const USERS = [{ id: 'u-7', full_name: 'Каримова Лаборант' }, { id: 'u-8', full_name: 'Юсупов Лаборант' }];   // PRINT_PERFORMER_V1      // К4 — номера строк «услуга возвращена» (rpc refunded_lines)
function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: LAB_RESULTS, admissions: [],
      lab_panels: LAB_PANELS, lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: [], users: USERS,
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/refunded_lines')) return { ok: true, json: async () => ({ data: { line_ids: REFUNDED } }) };
  return { ok: true, json: async () => ({ data: null }) };
};


const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
const { labSignerData, signerIds } = await import('../views/lab-signer.js');
const { buildSheetHtml } = await import('../../shared/doc-render.js');
setFullAccess(true);

const BLOOD = { name: 'Анализ крови', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const URINE = { name: 'Анализ мочи', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const line = (id, svc, extra = {}) => ({ id, visit_id: 20, service_id: svc === BLOOD ? 40 : 41, status: 'completed', sync_origin: null,
  created_at: TODAY_NOON, scheduled_at: null, sample_collected_at: null, services: svc, ...extra });
const res = (id, vs, parameter, value) => ({ id, visit_service_id: vs, parameter, value, unit: '', flag: 'normal', notes: null, entered_at: TODAY_NOON });

test('подпись: имена подтвердивших через запятую, роль «Врач-лаборант»; никто не подтвердил — подписи нет', () => {
  assert.deepStrictEqual(signerIds(['u-7', null, 'u-7', '', 'u-8']), ['u-7', 'u-8']);
  const d = labSignerData(['Каримова Лаборант', 'Юсупов Лаборант']);
  assert.deepStrictEqual([d.labChief, d.labChiefRole, d.labChiefSpec], ['Каримова Лаборант, Юсупов Лаборант', 'Врач-лаборант', 'Проверил и выдал']);
  assert.strictEqual(labSignerData([]).labChief, '');
});

test('бланк: роль подписи — из данных («Врач-лаборант»); без неё — прежняя «Заведующий лабораторией» (настройки, образец)', () => {
  for (const variant of [null, 'compact']) {
    const s = { clinicName: 'К', accent: '#0f766e', ...(variant ? { variant: { lab: variant } } : {}) };
    const g = [{ title: 'ОАК', tests: [{ name: 'WBC', value: '5', unit: '', ref: '', flag: '', pos: null }] }];
    const signed = buildSheetHtml({ type: 'lab', s, data: { patientName: 'Т', groups: g, ...labSignerData(['Каримова Лаборант']) } });
    assert.match(signed, /Врач-лаборант/);
    assert.match(signed, /Каримова Лаборант/);
    assert.doesNotMatch(signed, /Заведующий лабораторией/);
    const plain = buildSheetHtml({ type: 'lab', s, data: { patientName: 'Т', groups: g, labChief: 'Иванов' } });
    assert.match(plain, /Заведующий лабораторией/);
  }
});

test('лаборатория: «Бланк» выданного визита (перепечатка) подписан подтвердившими, а не «—»', async () => {
  VISIT_SERVICES = [line(29, URINE, { verified_by: 'u-8', verified_at: TODAY_NOON }), line(28, BLOOD, { verified_by: 'u-7', verified_at: TODAY_NOON })];
  LAB_PANELS = [];
  LAB_RESULTS = [res(1, 28, 'Лейкоциты', '6.1'), res(2, 29, 'Белок', '0.1')];
  printed = []; opened = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  const chip = buttons(root).find((b) => textOf(b).startsWith('Все'));
  if (chip) { chip.click(); await tick(); }
  const card = byClass(root, 'lq-card')[0];
  assert.ok(card, 'нет карточки визита');
  const blank = buttons(byClass(card, 'lq-do')[0]).find((b) => clean(b) === 'Бланк');
  assert.ok(blank, 'нет «Бланк»');
  blank.click();
  await tick(120);
  const html = printed.join('');
  assert.ok(html, 'бланк не напечатан');
  assert.match(html, /Врач-лаборант/);
  assert.match(html, /Юсупов Лаборант, Каримова Лаборант|Каримова Лаборант, Юсупов Лаборант/);
  assert.doesNotMatch(html, /Заведующий лабораторией/);
});
