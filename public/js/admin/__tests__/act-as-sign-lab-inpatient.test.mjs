// ADMIN_ACT_AS_V1 (2026-10-28) — R3 В ЛАБОРАТОРИИ, ПРОЦЕДУРАХ И СТАЦИОНАРЕ.
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md, R3: от чужого
// имени не подписываются «Проверить и выдать» результаты лаборатории
// (verified_by), подтверждение процедуры (procedure_complete) и записи
// стационара (admission_review_save — создать, изменить, подписать, черновик
// тоже). Сервер отказывает сам; кнопки экрана неактивны, подсказка — текст
// отказа R3. Без входа от имени — всё как было.
//
// Поддельный DOM — тот же, что в __tests__/lab-card.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;} removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){ const i = fakeBody.children.indexOf(this); if (i > -1) fakeBody.children.splice(i, 1); } select(){} closest(){return null;}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t + this.children.map((c) => (c && c.textContent) || '').join('');} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s.attrs.html = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F; globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const fakeBody = mk('body');
const toasts = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set(v) { toasts.push(String(v)); } });
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t), head: mk('head'), body: fakeBody, documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null) };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
const LAB = { id: 5, full_name: 'Лаборант Л.', role: 'lab', extra_roles: [], acting_admin: null };
const ACTING = (u) => ({ ...u, acting_admin: { id: 1, full_name: 'Петров П.' } });
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: LAB } }, CLINIC: { id: 'c-1' },
  confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { language: 'ru-RU', languages: ['ru-RU'], clipboard: { writeText: async () => {} } } });

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const buttonWith = (root, re) => buttons(root).filter((b) => re.test(textOf(b)));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- поддельный сервер -------------------------------------------------------
let VISIT_SERVICES = [];
let LAB_RESULTS = [];
let PROC_ROWS = [];
const RPCS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(data)) }) });
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = { visit_services: VISIT_SERVICES, visits: [{ id: 'v-1', visit_date: '2026-10-28', patients: { id: 'p-1', full_name: 'Пациент П.', mrn: 'P-1' } }],
      lab_results: LAB_RESULTS, departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }] }[table] || [];
    if (table === 'visit_services') {
      const f = ((body && body.filters) || []).find((x) => x && x.col === 'status');
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return ok(rows);
  }
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length);
    RPCS.push(name);
    if (name === 'procedures_list') return ok({ rows: PROC_ROWS, scope: 'all' });
    return ok(null);
  }
  return ok(null);
};

const { ACT_AS_SIGN_REFUSAL } = await import('../../shared/act-as.js');
const { renderLaboratory } = await import('../views/laboratory.js');
const { renderProcedures } = await import('../views/procedures.js');
const { docActionsBar } = await import('../views/case-doc-a4.js');
const { inpatientModal } = await import('../views/inpatient-modal.js');
const { setFullAccess } = await import('../permissions.js');
const { setLang } = await import('../i18n.js');
setFullAccess(true);

const locked = (b) => b.disabled === true && b.getAttribute('title') === ACT_AS_SIGN_REFUSAL;

// --- лаборатория --------------------------------------------------------------
const vs = (id, status) => ({ id, visit_id: 'v-1', service_id: 's-' + id, status, sample_collected_at: '2026-10-28T08:20:00Z', sync_origin: null,
  services: { name: 'Общий анализ крови', is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' } });
const res = (id, vsId) => ({ id, visit_service_id: vsId, parameter: 'Гемоглобин', value: '138', unit: 'г/л', flag: 'normal', notes: null, entered_at: '2026-10-28T09:00:00Z' });

async function labQueue(user) {
  window.easymed.state.user = user;
  VISIT_SERVICES = [vs(805, 'resulted'), vs(806, 'resulted')];
  LAB_RESULTS = [res(1, 805), res(2, 806)];
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  return root;
}

test('лаборатория, от имени: «Подтвердить» (вся проба) и «Проверить и выдать» (анализ) — неактивны с подсказкой R3', async () => {
  const root = await labQueue(ACTING(LAB));
  const group = buttonWith(root, /Подтвердить/);
  const rows = buttonWith(root, /Проверить и выдать/);
  assert.ok(group.length >= 1, 'кнопка «Подтвердить» на карточке пробы');
  assert.equal(rows.length, 2, 'по кнопке у каждого анализа');
  for (const b of [...group, ...rows]) assert.ok(locked(b), 'неактивна с подсказкой: ' + textOf(b) + ' / ' + b.getAttribute('title'));
  // «Внести результаты» (не подпись) — работает.
  const enter = buttonWith(root, /Внести результаты/);
  assert.ok(enter.every((b) => b.disabled !== true));
});

test('лаборатория, без входа от имени: те же кнопки — активны, без подсказки R3', async () => {
  const root = await labQueue(LAB);
  for (const b of [...buttonWith(root, /Подтвердить/), ...buttonWith(root, /Проверить и выдать/)]) {
    assert.notEqual(b.disabled, true);
    assert.notEqual(b.getAttribute('title'), ACT_AS_SIGN_REFUSAL);
  }
});

// --- процедуры ----------------------------------------------------------------
const NURSE = { id: 4, full_name: 'Медсестра Н.', role: 'nurse', extra_roles: [], acting_admin: null };
async function procQueue(user) {
  window.easymed.state.user = user;
  PROC_ROWS = [{ kind: 'outpatient', id: 1, status: 'queued', service: 'Инъекция', patient: 'Пациент П.', performer: 'Медсестра Н.', when: '2026-10-28T09:00:00Z' }];
  const root = mk('div');
  await renderProcedures(root);
  await tick();
  return root;
}

test('процедуры, от имени: «Выполнить» неактивна с подсказкой R3; без входа от имени — активна', async () => {
  let root = await procQueue(ACTING(NURSE));
  let done = buttonWith(root, /^ ?Выполнить$/);
  assert.equal(done.length, 1);
  assert.ok(locked(done[0]), done[0].getAttribute('title'));
  root = await procQueue(NURSE);
  done = buttonWith(root, /^ ?Выполнить$/);
  assert.notEqual(done[0].disabled, true);
  assert.equal(done[0].getAttribute('title'), null);
});

// --- стационар ----------------------------------------------------------------
test('стационар, рабочий экран: «Опубликовать» и «Сохранить черновик» неактивны с подсказкой R3, «Печать» и «Заготовка» — работают', () => {
  let submitted = 0;
  const ed = { submitLabel: 'Опубликовать документ', submit: () => { submitted += 1; }, secondaryLabel: 'Сохранить черновик', secondary: () => { submitted += 1; },
    print: () => {}, applyTemplate: () => {}, signLock: ACT_AS_SIGN_REFUSAL };
  const bar = docActionsBar(ed);
  const [pub] = buttonWith(bar, /Опубликовать/);
  const [draft] = buttonWith(bar, /Сохранить черновик/);
  assert.ok(locked(pub) && locked(draft));
  assert.ok(buttonWith(bar, /Печать|Заготовка/).every((b) => b.disabled !== true));
  const free = docActionsBar({ ...ed, signLock: null });
  assert.ok(buttonWith(free, /Опубликовать|Сохранить черновик/).every((b) => b.disabled !== true && b.getAttribute('title') === null));
  assert.equal(submitted, 0);
});

test('стационар, окно: обе кнопки действия неактивны с подсказкой R3; без входа от имени — как были', () => {
  fakeBody.children.length = 0;
  const m = inpatientModal('Дневник', 'Doc', [], 'Опубликовать документ', async () => true,
    { secondaryLabel: 'Сохранить черновик', onSecondary: async () => {}, lockHint: ACT_AS_SIGN_REFUSAL });
  assert.ok(buttonWith(m.overlay, /Опубликовать|Сохранить черновик/).every(locked));
  assert.ok(buttonWith(m.overlay, /Закрыть/).every((b) => b.disabled !== true), '«Закрыть» работает');
  const free = inpatientModal('Дневник', 'Doc', [], 'Опубликовать документ', async () => true,
    { secondaryLabel: 'Сохранить черновик', onSecondary: async () => {} });
  assert.ok(buttonWith(free.overlay, /Опубликовать|Сохранить черновик/).every((b) => b.disabled !== true));
});

test('стационар, редактор записи: от имени — signLock = текст R3, «Опубликовать» и черновик отказывают словами без запроса', async () => {
  const { buildReviewEditor } = await import('../views/admission-modal.js');
  const DOC = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
  window.easymed.state.user = DOC;
  const free = buildReviewEditor({ admission: { id: 7, patients: { full_name: 'Пациент П.' } }, kind: 'daily' });
  assert.ok(free, 'редактор собирается');
  assert.equal(free.signLock, null);

  window.easymed.state.user = ACTING(DOC);
  const ed = buildReviewEditor({ admission: { id: 7, patients: { full_name: 'Пациент П.' } }, kind: 'daily' });
  assert.equal(ed.signLock, ACT_AS_SIGN_REFUSAL);
  await tick();
  RPCS.length = 0; toasts.length = 0;
  assert.equal(await ed.submit(), false);
  await ed.secondary();
  assert.ok(!RPCS.includes('admission_review_save'), 'запрос записи не ушёл');
  assert.equal(toasts.filter((t) => t === ACT_AS_SIGN_REFUSAL).length, 2, toasts.join(' | '));
  window.easymed.state.user = LAB;
});

test('uz/en: подсказка R3 на кнопках — на языке экрана, без кириллицы', () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    const bar = docActionsBar({ submitLabel: 'Опубликовать документ', submit() {}, signLock: ACT_AS_SIGN_REFUSAL });
    const [b] = buttons(bar);
    assert.doesNotMatch(b.getAttribute('title'), /[Ѐ-ӿ]/, lang);
  }
  setLang('ru');
});

// --- ревью-2: «Собрать историю» — подшить историю болезни в карту ------------
// Сборка СНАЧАЛА сохраняет историю в карту (admission_case_file_save, документ
// врача 'case_file'), и только потом печатает — сервер от имени отказывает.
// Кнопка неактивна с подсказкой R3; отдельной «только печати» нет намеренно:
// напечатанная история, которой нет в карте, — то, от чего сборка и защищает.
const D = (kind, over) => Object.assign({
  kind, group: 'required', applies: true, required: true, state: 'pending',
  due_rule: 'clock', due_at: '2026-10-28T08:00:00Z', period_hours: null, periods_missing: 0,
  entries: 0, block: null, review_id: null, published_at: null, author_name: '',
  revisions: [], revision_count: 0, draft_id: null, has_draft: false,
}, over);
const CASE_STATE = {
  admission_id: 7, status: 'active', now: '2026-10-28T09:00:00Z', base_at: '2026-10-28T07:00:00Z', base_source: 'admitted',
  surgical: false, surgical_from: null,
  items: [D('primary', { state: 'published', published_at: '2026-10-28T08:00:00Z', author_name: 'Иванова А.', review_id: 1, revision_count: 1 })],
  other: [], progress: { done: 1, total: 1, overdue: 0, draft: 0 }, next_kind: null,
  discharge_gate: { blocked: false, blocking: [], incomplete: [] },
};

test('ревью-2: «Собрать историю болезни» (список документов) и «Собрать историю» (рабочий экран) — от имени неактивны с подсказкой R3; без входа от имени — как были', async () => {
  const { caseDocsView } = await import('../views/case-docs.js');
  const { assembleFor } = await import('../views/case-workspace.js');
  const DOC = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
  const collect = () => [
    ...buttonWith(caseDocsView({ state: CASE_STATE, onDoc() {}, onAssemble() {} }), /Собрать историю/),
    ...buttonWith(assembleFor(mk('div'), () => {}), /Собрать историю/),
  ];
  window.easymed.state.user = ACTING(DOC);
  let bs = collect();
  assert.equal(bs.length, 2, 'обе кнопки сборки на месте');
  assert.ok(bs.every(locked), 'от имени — неактивны с подсказкой R3');
  window.easymed.state.user = DOC;
  bs = collect();
  assert.ok(bs.every((b) => b.disabled !== true && b.getAttribute('title') === null), 'без входа от имени — как были');
  window.easymed.state.user = LAB;
});

test('ревью-2: сборка истории от имени — отказ словами R3 без запроса; без входа от имени — запрос уходит', async () => {
  const { assembleCaseFile } = await import('../views/case-docs.js');
  const DOC = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
  window.easymed.state.user = ACTING(DOC);
  RPCS.length = 0; toasts.length = 0;
  assert.equal(await assembleCaseFile(7), null);
  assert.ok(!RPCS.includes('admission_case_file_save'), 'запрос сборки не ушёл');
  assert.ok(toasts.includes(ACT_AS_SIGN_REFUSAL), toasts.join(' | '));
  window.easymed.state.user = DOC;
  await assembleCaseFile(7);
  assert.ok(RPCS.includes('admission_case_file_save'), 'без входа от имени — как прежде');
  window.easymed.state.user = LAB;
});
