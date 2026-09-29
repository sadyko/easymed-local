// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «Проверьте права этой роли»
// (views/roles-grant-review.js): миграция 230 записала ключи, у которых
// записанный уровень выше стандарта основы, — такие мог выдать сам экран
// «Роли» до этого выпуска. Экран показывает их тому, кто вправе менять роль:
// «Убрать эти права» (решает основа) или «Оставить как есть» (отметка). После
// решения плашки нет (спецификация, §4 и «Тесты», п. 6).
import { test } from 'node:test';
import assert from 'node:assert';

// Фейковая DOM — та же, что в roles-review.test.mjs.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} remove(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter((x)=>x&&x!==c).join(' ');},toggle(c,on){if(on)this.add(c);else this.remove(c);}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){const el=new F(t);if(el.tagName==='TEMPLATE'){el.content={firstChild:null};Object.defineProperty(el,'innerHTML',{set(v){const s=new F('svg');s._t=String(v);el.content.firstChild=s;},get(){return '';}});}return el;}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store=new Map();
globalThis.localStorage={getItem:(k)=>(store.has(k)?store.get(k):null),setItem:(k,v)=>store.set(k,String(v)),removeItem:(k)=>store.delete(k),clear:()=>store.clear()};
localStorage.setItem('admin.lang','ru');
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},easymed:{state:{user:null}}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk=(e,o=[])=>{o.push(e);for(const c of e.children||[])walk(c,o);return o;};
const textOf=(el)=>walk(el).map((n)=>n._t||'').join('');
const buttons=(root)=>walk(root).filter((n)=>n.tagName==='BUTTON');
const tick=(ms=20)=>new Promise((r)=>setTimeout(r,ms));

// Сервер с состоянием: строка роли и строки проверки меняются по-настоящему,
// чтобы «после решения плашки нет» проверялось тем же путём, что на экране.
let ROW; let REVIEWS; let calls;
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const filterVal = (desc, col) => (desc.filters.find((f) => f.col === col) || {}).val;
globalThis.fetch = async (url, opts) => {
  const desc = opts && opts.body ? JSON.parse(opts.body) : null;
  if (!desc) return jsonOk(null);
  calls.push(desc);
  if (desc.table === 'role_grant_reviews' && desc.op === 'select') return jsonOk(REVIEWS.filter((r) => r.role === filterVal(desc, 'role') && r.resolution == null));
  if (desc.table === 'role_grant_reviews' && desc.op === 'update') {
    const ids = filterVal(desc, 'id');
    for (const r of REVIEWS) if (ids.includes(r.id)) Object.assign(r, desc.values);
    return jsonOk([]);
  }
  if (desc.table === 'role_permissions' && desc.op === 'select') return jsonOk({ permissions: JSON.stringify(ROW) });
  if (desc.table === 'role_permissions' && desc.op === 'update') { ROW = JSON.parse(desc.values.permissions); return jsonOk({ id: 1 }); }
  return jsonOk([]);
};
const review = await import('../views/roles-grant-review.js');

const WIDE = { sections: ['patients', 'crm', 'beds'], levels: { patients: 'editor', crm: 'editor', beds: 'editor' },
  grants: { 'crm.all': 'edit', 'inpatient.vitals': 'edit', 'inpatient.marks': 'view', 'crm.dial': 'edit' } };
const rowsFor = () => [
  { id: 1, role: 'registrar', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
  { id: 2, role: 'registrar', key: 'inpatient.vitals', level: 'edit', standard: 'none', resolution: null },
  // С тех пор поменяли руками («Изменение» → «Просмотр») — решено на экране.
  { id: 3, role: 'registrar', key: 'inpatient.marks', level: 'edit', standard: 'none', resolution: null },
];
const fresh = () => { calls = []; ROW = JSON.parse(JSON.stringify(WIDE)); REVIEWS = rowsFor(); };
const notice = async (onDone) => { const box = review.roleGrantReviewNotice('registrar', ROW, { onDone }); await tick(); return box; };

test('показываются строки, чей ключ всё ещё стоит, как нашла миграция', async () => {
  fresh();
  assert.deepStrictEqual((await review.openGrantReviews('registrar', ROW)).map((r) => r.id), [1, 2]);
});

test('плашка: заголовок, права словами справочника, две кнопки', async () => {
  fresh();
  const box = await notice();
  const text = textOf(box);
  assert.ok(text.includes('Проверьте права этой роли'));
  assert.ok(text.includes('У роли есть права выше обычных для её основы: «CRM · Заявки → Видит все заявки и передаёт их», «Стационар → Измерения». До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.'), text);
  assert.ok(!text.includes('Отметки о введении'), 'показано то, что уже решено на экране');
  assert.deepStrictEqual(buttons(box).map((b) => textOf(b)), ['Убрать эти права', 'Оставить как есть']);
});

test('«Убрать эти права»: роль перечитана, сняты только названные ключи, отметка restored; плашка больше не появляется', async () => {
  fresh();
  let done = 0;
  const box = await notice(() => { done++; });
  ROW.grants['crm.dial'] = 'none';   // пока плашка висела, роль правили — запись перечитывается
  buttons(box).find((b) => textOf(b).includes('Убрать эти права')).click();
  await tick();
  assert.strictEqual(done, 1);
  assert.ok(!('crm.all' in ROW.grants) && !('inpatient.vitals' in ROW.grants), 'названные ключи не сняты');
  assert.strictEqual(ROW.grants['inpatient.marks'], 'view', 'снят ключ, которого в плашке не было');
  assert.strictEqual(ROW.grants['crm.dial'], 'none', 'запись роли не перечитана — затёрта свежая правка');
  assert.deepStrictEqual(ROW.sections, WIDE.sections, 'старые поля тронуты');
  const up = calls.find((d) => d.table === 'role_grant_reviews' && d.op === 'update');
  assert.strictEqual(up.values.resolution, 'restored');
  assert.deepStrictEqual(up.filters, [{ col: 'id', op: 'in', val: [1, 2] }]);
  assert.strictEqual((await notice()).children.length, 0, 'после решения плашка снова появилась');
});

test('«Оставить как есть»: права не тронуты, отметка kept; плашка больше не появляется', async () => {
  fresh();
  const box = await notice();
  buttons(box).find((b) => textOf(b).includes('Оставить как есть')).click();
  await tick();
  assert.ok(!calls.some((d) => d.table === 'role_permissions' && d.op === 'update'), 'права тронуты');
  assert.deepStrictEqual(ROW, WIDE);
  assert.strictEqual(calls.find((d) => d.table === 'role_grant_reviews' && d.op === 'update').values.resolution, 'kept');
  assert.strictEqual((await notice()).children.length, 0);
});

test('ключ, изменённый после того, как плашка нарисована, не снимается', async () => {
  fresh();
  const box = await notice();
  ROW.grants['inpatient.vitals'] = 'view';
  buttons(box).find((b) => textOf(b).includes('Убрать эти права')).click();
  await tick();
  assert.strictEqual(ROW.grants['inpatient.vitals'], 'view', 'снят ключ, который уже решили руками');
  assert.ok(!('crm.all' in ROW.grants));
});

// Ревью M4 — на проверке и ключи с воротами-функцией, среди них раздел
// «Закупки» (его ключ — сам раздел, не окно): плашка называет его словами
// справочника, а не кодом.
test('ревью M4: «Оплата врачей» и раздел «Закупки» — словами справочника', () => {
  assert.strictEqual(review.grantKeyLabel('reports.doctor_pay'), 'Отчёты → Оплата врачей');
  assert.strictEqual(review.grantKeyLabel('procurement'), 'Закупки');
  assert.strictEqual(review.grantKeyLabel('settings.departments'), 'Настройки → Отделы');
});

test('нет строк проверки — нет и плашки', async () => {
  fresh(); REVIEWS = [];
  assert.strictEqual((await notice()).children.length, 0);
});
