// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ОТКРЫЛ И СОХРАНИЛ — НИЧЕГО НЕ ИЗМЕНИЛОСЬ»,
// НАСТОЯЩИЙ ЭКРАН «РОЛИ» НА НАСТОЯЩЕМ СЕРВЕРЕ.
//
// Доказанная ошибка (docs/specs/2026-09-29-roles-save-truth-design.md): экран
// рисовал у ключа, который роль не настраивала, СВОЮ ДОГАДКУ из старой галочки
// раздела, а «Сохранить роль» писал матрицу целиком — и первое же сохранение
// без единой правки делало догадку настоящим правом. Оператор колл-центра
// получал `crm.all` и читал чужую заявку, регистратор — измерения стационара
// (admission_vitals_add: 403 → 200).
//
// ПОЧЕМУ СТЕНД НАСТОЯЩИЙ. Экран — тот же roles-editor.js на фальшивой DOM
// (приём roles-editor.test.mjs), а всё, что он спрашивает и пишет, уходит
// HTTP-запросом в НАСТОЯЩИЙ сервер (createApp) на базе после всех миграций:
// /api/db с защитой «Ролей», /api/rpc с воротами лицензии. Заглушка сервера
// дала бы зелёный тест и на старом коде — ломалось всё на границе «экран —
// сервер».
//
// Пункты 2–5 раздела «Тесты» спецификации:
//   2 — открыл и сохранил: grants, sections/levels и уровни ворот те же — у
//       каждой строки role_permissions свежей базы, которую экран открывает,
//       и у четырёх синтетических ролей;
//   3 — тронул одно окно или действие: в grants добавилось ровно оно;
//   4 — сторож: у незаписанного ключа с воротами экран показывает ответ сервера;
//   5 — два доказанных сценария, сквозь сервер.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Фальшивая DOM — копия из roles-editor.test.mjs (там объяснено, зачем каждая часть).
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
 get value(){
   if(this.tagName!=='SELECT')return this._v===null?'':this._v;
   if(this._v!==null)return this._v;
   const on=this.children.find(c=>c.tagName==='OPTION'&&'selected' in c.attrs);
   return on?String(on.attrs.value??''):(this.children[0]?String(this.children[0].attrs.value??''):'');
 }
 set value(v){this._v=String(v);}
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
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, easymed: { state: { user: null } }, confirm: () => true };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const tagsOf = (root, tag) => walk(root).filter((n) => n.tagName === tag);
const byClass = (root, cls) => walk(root).filter((n) => n.classList.contains(cls));
const findButtonByText = (root, re) => tagsOf(root, 'BUTTON').find((b) => re.test(textOf(b)));
const roleButton = (root, key) => tagsOf(root, 'BUTTON').find((b) => b.dataset.role === key);
const radiosFor = (root, key) => tagsOf(root, 'INPUT').filter((n) => n.attrs.type === 'radio' && n.attrs.name === 'grant:' + key);
const chosen = (root, key) => { const on = radiosFor(root, key).find((n) => n.checked); return on ? on.attrs.value : null; };
const pick = (root, key, lvl) => {
  const r = radiosFor(root, key).find((n) => n.attrs.value === lvl);
  for (const x of radiosFor(root, key)) x.checked = x === r;
  r.dispatchEvent({ type: 'change' });
};

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- настоящий сервер ---------------------------------------------------------
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');
const { effectiveGrantsOf } = await import('../../../../server/services/rpc/roles-effective.js');
const { customRoleCreate } = await import('../../../../server/services/rpc/custom-roles.js');
const { fallbackLevel } = await import('../../../../server/services/gate-fallbacks.js');
const { tabRankOfPerms, PATIENT_CARD_TABS } = await import('../../../../server/services/roles.js');
const { catalogRows, grantsFromLegacy } = await import('../../shared/permission-catalog.js');

// Экран ходит относительными адресами (/api/db, /api/rpc/…) — их везём на
// сервер стенда, с сессией администратора.
const realFetch = globalThis.fetch;
let BASE = '';
let COOKIE = '';
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('/')) return realFetch(url, opts);
  return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};

const { renderRolesEditor } = await import('../views/roles-editor.js');

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Роли, которые экран открывает (roles-editor.js ROLE_LIST), — с подписью карточки.
const SCREEN_ROLES = [
  ['registrar', 'Регистратор'], ['doctor', 'Врач'], ['cashier', 'Кассир'], ['lab', 'Лаборант'],
  ['nurse', 'Медсестра'], ['inventory', 'Склад'], ['callcenter', 'Оператор колл-центра'],
  ['head_doctor', 'Главный врач'], ['senior_nurse', 'Старшая медсестра'], ['head_cashier', 'Старший кассир'],
];
// Синтетические роли спецификации.
//   legacy-only — только старые поля, и в них всё, что вывод теряет: «Кабинет
//     врача: editor» (строка «Нет / Просмотр»), «Пациенты: editor» без
//     registration и queue, CRM «admin», «Закупки» у врача, раздел без уровня;
//   written — записанные ключи: выше основы (crm.all, inpatient.marks), ниже
//     (crm.dial), раздел «Нет» с незаписанными окнами (mar), строка «только
//     администратор» (settings.api), окна разделов, закрытых по выводу
//     (reports.cashier, procurement.issue), раздел, записанный без старого поля (settings).
const LEGACY_ONLY = {
  sections: ['patients', 'consultation', 'labs', 'inventory', 'beds', 'crm', 'reports-hub', 'settings', 'custdev', 'my-stock'],
  levels: { patients: 'editor', consultation: 'editor', labs: 'admin', inventory: 'editor', beds: 'viewer', crm: 'admin', 'reports-hub': 'viewer', settings: 'viewer', custdev: 'editor' },
};
const WRITTEN = {
  sections: ['patients', 'crm', 'beds', 'queue', 'registration', 'patient-documents'],
  levels: { patients: 'editor', crm: 'editor', beds: 'editor', queue: 'viewer', registration: 'editor', 'patient-documents': 'viewer' },
  grants: { 'crm.all': 'edit', 'crm.dial': 'none', 'inpatient.vitals': 'view', 'inpatient.marks': 'edit', mar: 'none',
    settings: 'view', 'settings.api': 'view', 'reports.cashier': 'view', 'patients.calendar': 'view', 'procurement.issue': 'edit', 'cashier.lines': 'edit' },
};
const SYNTHETIC = [['op-senior', 'Старший оператор'], ['deputy', 'Заместитель'], ['legacy-only', 'Только старые поля'], ['written', 'Записанные ключи']];

async function world(t) {
  const db = openDb(':memory:');
  migrate(db);
  const scols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  const sid = {};
  for (const [id, name, role] of [[1, 'adm', 'admin'], [2, 'op1', 'callcenter'], [3, 'op2', 'callcenter'], [4, 'reg', 'registrar']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, name, 'x', name, role);
    const cols = ['id', 'user_id', 'expires_at'];
    const vals = ['sid-' + name, id, iso(Date.now() + 8 * 3600e3)];
    if (scols.includes('last_seen_at')) { cols.push('last_seen_at'); vals.push(iso(Date.now())); }
    db.prepare(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    sid[name] = 'emsid=sid-' + name;
  }
  customRoleCreate(db, { code: 'op-senior', name: 'Старший оператор', base_role: 'callcenter' }, ADMIN);
  customRoleCreate(db, { code: 'deputy', name: 'Заместитель', base_role: 'admin' }, ADMIN);
  for (const [code, name, base, perms] of [['legacy-only', 'Только старые поля', 'doctor', LEGACY_ONLY], ['written', 'Записанные ключи', 'registrar', WRITTEN]]) {
    db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, name, base);
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify(perms));
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  BASE = `http://127.0.0.1:${server.address().port}`;
  COOKIE = sid.adm;
  t.after(() => new Promise((r) => server.close(() => { db.close(); r(); })));
  return { db, sid };
}

async function until(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function render() {
  const root = mk('div');
  await renderRolesEditor(root, {});
  await until(() => byClass(root, 'roles-card').length > 0, 'экран «Роли»');
  return root;
}
async function openRole(root, role, label) {
  roleButton(root, role).click();
  await until(() => {
    const card = byClass(root, 'roles-card')[0];
    return !!card && textOf(card).includes('· ' + label) && radiosFor(card, 'patients').length > 0;
  }, 'роль ' + role);
}
async function saveRole(root) {
  toastMsg = null;
  const btn = findButtonByText(root, /^Сохранить роль$/);
  assert.ok(btn, 'нет кнопки «Сохранить роль»');
  assert.equal(btn.disabled, false, '«Сохранить роль» заперта');
  btn.click();
  await until(() => toastMsg !== null, 'ответ на «Сохранить роль»');
  assert.match(String(toastMsg), /Права сохранены/, String(toastMsg));
}
const permsOf = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const sorted = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const gateSnapshot = (db, role, perms) => ({
  server: effectiveGrantsOf(db, role),
  shell: sorted({ ...grantsFromLegacy(perms), ...(perms.grants || {}) }),
  tabs: PATIENT_CARD_TABS.map((tab) => tabRankOfPerms(perms, tab)),
});

test('открыл и сохранил — ничего не изменилось: каждая роль свежей базы и четыре синтетические', async (t) => {
  const { db } = await world(t);
  const synthetic = new Set(SYNTHETIC.map(([code]) => code));
  const fresh = db.prepare('SELECT role FROM role_permissions').all().map((r) => r.role).filter((r) => !synthetic.has(r));
  // Строку администратора экран не открывает (её нет в списке ролей: у
  // администратора всегда полный доступ) — остальные открываются все.
  assert.deepEqual(fresh.filter((r) => r !== 'admin').sort(), SCREEN_ROLES.map(([k]) => k).sort(),
    'в свежей базе строка роли, которой нет на экране, — её «пустое сохранение» не проверено');
  const root = await render();
  for (const [role, label] of [...SCREEN_ROLES, ...SYNTHETIC]) {
    const before = permsOf(db, role);
    const gates = gateSnapshot(db, role, before);
    await openRole(root, role, label);
    await saveRole(root);
    const after = permsOf(db, role);
    assert.deepEqual(sorted(after.grants), sorted(before.grants), role + ': grants изменились от пустого сохранения');
    assert.deepEqual([...(after.sections || [])].sort(), [...(before.sections || [])].sort(), role + ': sections изменились');
    assert.deepEqual(sorted(after.levels), sorted(before.levels), role + ': levels изменились');
    assert.deepEqual(gateSnapshot(db, role, after), gates, role + ': изменилось то, что дают ворота');
  }
});

// Окно или действие, которое можно тронуть: раздел открыт и выводом старого
// поля оно не служит (patients.queue выводит ключ queue). Сначала — не
// записанное у роли и с серверными воротами (там и жила догадка экрана), потом
// любое незаписанное, и только если таких нет — записанное («Старшему кассиру»
// миграция 218 записала все три его строки).
function touchable(root, explicit, gated) {
  const rank = (r) => (r.key in explicit ? 2 : gated.has(r.key) ? 0 : 1);
  const rows = catalogRows().filter((r) => r.kind !== 'section' && !r.locked && r.key !== 'patients.queue');
  rows.sort((a, b) => rank(a) - rank(b));
  for (const r of rows) {
    if ((chosen(root, r.parent) || 'none') === 'none') continue;
    const cur = chosen(root, r.key);
    const lvl = (r.levels || ['none', 'view']).find((l) => l !== cur);
    if (lvl) return { key: r.key, lvl };
  }
  return null;
}

test('тронул одно окно или действие — в grants добавилось ровно оно, старые поля не тронуты', async (t) => {
  const { db } = await world(t);
  const root = await render();
  for (const [role, label] of [...SCREEN_ROLES, ...SYNTHETIC]) {
    const before = permsOf(db, role);
    await openRole(root, role, label);
    const touch = touchable(root, before.grants || {}, new Set(Object.keys(effectiveGrantsOf(db, role))));
    assert.ok(touch, role + ': нечего тронуть');
    pick(root, touch.key, touch.lvl);
    await saveRole(root);
    const after = permsOf(db, role);
    assert.deepEqual(sorted(after.grants), sorted({ ...(before.grants || {}), [touch.key]: touch.lvl }), `${role}: тронули ${touch.key} → ${touch.lvl}`);
    assert.deepEqual([...(after.sections || [])].sort(), [...(before.sections || [])].sort(), role + ': sections');
    assert.deepEqual(sorted(after.levels), sorted(before.levels), role + ': levels');
  }
});

test('сторож: у незаписанного ключа с воротами экран показывает ответ сервера, а сервер отвечает про все такие ключи', async (t) => {
  const { db } = await world(t);
  const root = await render();
  for (const [role, label] of SCREEN_ROLES) {
    const res = await fetch('/api/rpc/role_effective_grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    assert.equal(res.status, 200, role);
    const { levels } = (await res.json()).data;
    const pseudo = { id: 0, role, extra_roles: [], custom_role_code: null };
    const gated = catalogRows().filter((r) => r.kind !== 'section' && !r.locked && fallbackLevel(db, pseudo, r.key, 'all') !== null).map((r) => r.key).sort();
    assert.deepEqual(Object.keys(levels).sort(), gated, role + ': сервер ответил не про все ключи с воротами');
    const explicit = permsOf(db, role).grants || {};
    await openRole(root, role, label);
    for (const k of gated) {
      if (k in explicit) continue;
      assert.equal(chosen(root, k), levels[k], `${role}: «${k}» — экран показывает не то, что дают ворота`);
    }
  }
});

test('доказанные сценарии сквозь сервер: после пустого сохранения оператор не читает чужую заявку, регистратор не пишет измерения', async (t) => {
  const { db, sid } = await world(t);
  const lead = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, assigned_to) VALUES ('Чужая заявка', '+998901112233', 3)").run().lastInsertRowid);
  const as = async (who, path, body) => {
    const r = await realFetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sid[who] }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const operatorSeesLead = async () => {
    const r = await as('op1', '/api/db', { table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: lead }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.data.length > 0;
  };
  const registrarVitals = async () => (await as('reg', '/api/rpc/admission_vitals_add', { admission_id: 1, pulse_bpm: 72 })).status;

  assert.equal(await operatorSeesLead(), false, 'до сохранения оператор уже видит чужую заявку — стенд неверен');
  assert.equal(await registrarVitals(), 403, 'до сохранения регистратор уже пишет измерения — стенд неверен');

  const root = await render();
  await openRole(root, 'callcenter', 'Оператор колл-центра');
  await saveRole(root);
  await openRole(root, 'registrar', 'Регистратор');
  await saveRole(root);

  assert.ok(!('crm.all' in (permsOf(db, 'callcenter').grants || {})), 'пустое сохранение записало оператору crm.all');
  assert.equal(await operatorSeesLead(), false, 'после пустого сохранения оператор читает чужую заявку');
  const g = permsOf(db, 'registrar').grants || {};
  for (const k of ['inpatient.vitals', 'inpatient.prescriptions', 'inpatient.marks', 'inpatient.discharge', 'crm.all']) {
    assert.ok(!(k in g), 'пустое сохранение записало регистратору ' + k);
  }
  assert.equal(await registrarVitals(), 403, 'после пустого сохранения admission_vitals_add регистратора — не 403');

  // Проверка самой проверки: будь право записано — обе двери открылись бы.
  const put = (role, grants) => {
    const p = permsOf(db, role);
    p.grants = { ...(p.grants || {}), ...grants };
    db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
  };
  put('callcenter', { 'crm.all': 'edit' });
  assert.equal(await operatorSeesLead(), true, 'стенд не отличает: с crm.all оператор видит чужую заявку');
  put('registrar', { 'inpatient.vitals': 'edit' });
  assert.notEqual(await registrarVitals(), 403, 'стенд не отличает: с измерениями регистратор проходит ворота');
});

// Роль, которую прежний экран уже расширил: миграция 230 ставит её на проверку,
// плашка называет право словами, «Убрать эти права» снимает его — сквозь сервер.
test('плашка миграции 230 сквозь сервер: «Убрать эти права» снимает право, решение записано, плашки больше нет', async (t) => {
  const { db, sid } = await world(t);
  const fs = await import('node:fs');
  const SQL = fs.readFileSync(new URL('../../../../server/db/migrations/230_role_grant_reviews.sql', import.meta.url), 'utf8');
  const lead = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, assigned_to) VALUES ('Чужая заявка', '+998901112233', 3)").run().lastInsertRowid);
  const p = permsOf(db, 'callcenter');
  p.grants = { ...(p.grants || {}), 'crm.all': 'edit' };   // так сохранял роль прежний экран
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), 'callcenter');
  db.exec(SQL);
  // (Синтетическую роль «Записанные ключи» миграция тоже ставит на проверку —
  // её crm.all, отметки, измерения и выдача выше основы-регистратора.)
  assert.deepEqual(db.prepare("SELECT role, key, level, standard FROM role_grant_reviews WHERE role = 'callcenter'").all(),
    [{ role: 'callcenter', key: 'crm.all', level: 'edit', standard: 'none' }]);
  assert.deepEqual(db.prepare("SELECT key FROM role_grant_reviews WHERE role = 'written' ORDER BY key").all().map((x) => x.key),
    ['crm.all', 'inpatient.marks', 'inpatient.vitals', 'procurement.issue']);

  const root = await render();
  await openRole(root, 'callcenter', 'Оператор колл-центра');
  await until(() => textOf(root).includes('Проверьте права этой роли'), 'плашка «Проверьте права этой роли»');
  assert.ok(textOf(root).includes('«CRM · Заявки → Видит все заявки и передаёт их»'));
  toastMsg = null;
  findButtonByText(root, /^Убрать эти права$/).click();
  await until(() => toastMsg !== null, 'ответ на «Убрать эти права»');
  assert.match(String(toastMsg), /Права убраны/, String(toastMsg));

  assert.ok(!('crm.all' in (permsOf(db, 'callcenter').grants || {})), 'право не снято');
  assert.equal(permsOf(db, 'callcenter').grants['crm.dial'], 'edit', 'снято лишнее');
  const row = db.prepare("SELECT resolution, resolved_by FROM role_grant_reviews WHERE role = 'callcenter'").get();
  assert.equal(row.resolution, 'restored');
  assert.equal(row.resolved_by, 1, 'кто решил — из сессии');
  await until(() => byClass(root, 'roles-card').length > 0 && byClass(root, 'roles-state').length === 0, 'роль перечитана');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!textOf(root).includes('Проверьте права этой роли'), 'после решения плашка осталась');
  const r = await realFetch(BASE + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sid.op1 },
    body: JSON.stringify({ table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: lead }] }) });
  assert.deepEqual((await r.json()).data, [], 'оператор по-прежнему читает чужую заявку');
});
