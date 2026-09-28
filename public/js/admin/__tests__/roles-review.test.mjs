// V3121_ROLES — «Проверьте права этой роли» (views/roles-review.js): экран
// «Роли» показывает администратору роль, чей «Просмотр» на стационаре или
// складе совпал с отпечатком старого экрана (мигр. 215), и даёт выбрать:
// вернуть права по умолчанию основы или оставить как есть.
import { test } from 'node:test';
import assert from 'node:assert';

// Фейковая DOM — та же, что в roles-editor.test.mjs (там объяснено, зачем каждая часть).
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} remove(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x&&x!==c).join(' ');},toggle(c,on){if(on)this.add(c);else this.remove(c);}};}
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

const { OLD_SCREEN_AREAS } = await import('../../shared/old-screen-view.js');
const OLD = { sections: ['patients', 'beds'], levels: { patients: 'editor', beds: 'viewer' },
  grants: { ...OLD_SCREEN_AREAS.inpatient.keys, labs: 'view', 'crm.dial': 'none' } };
const EDITED = { ...OLD, grants: { ...OLD.grants, 'inpatient.vitals': 'edit' } };

let ROW; let REVIEWS; let calls;
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
globalThis.fetch = async (url, opts) => {
  const desc = opts && opts.body ? JSON.parse(opts.body) : null;
  if (!desc) return jsonOk(null);
  calls.push(desc);
  if (desc.table === 'role_permission_reviews' && desc.op === 'select') return jsonOk(REVIEWS);
  if (desc.table === 'role_permissions' && desc.op === 'select') return jsonOk({ permissions: JSON.stringify(ROW) });
  return jsonOk([{ id: 1 }]);
};
const review = await import('../views/roles-review.js');

test('показывается только запись, чья роль всё ещё совпадает с отпечатком', async () => {
  calls = []; REVIEWS = [{ id: 7, role: 'nurse', area: 'inpatient', resolution: null }, { id: 8, role: 'nurse', area: 'procurement', resolution: null }];
  assert.deepStrictEqual((await review.openReviews('nurse', OLD)).map((r) => r.id), [7]);
  assert.deepStrictEqual(await review.openReviews('nurse', EDITED), [], 'права уже поправили руками — спрашивать нечего');
});

test('«Вернуть права по умолчанию» снимает ключи раздела, ставит «editor» и закрывает запись', async () => {
  calls = []; ROW = OLD;
  await review.restoreDefaults({ id: 7, role: 'nurse', area: 'inpatient' });
  const up = calls.find((d) => d.table === 'role_permissions' && d.op === 'update');
  assert.ok(up, 'права роли записаны');
  const p = JSON.parse(up.values.permissions);
  for (const k of Object.keys(OLD_SCREEN_AREAS.inpatient.keys)) assert.ok(!(k in p.grants), k + ' снят');
  assert.strictEqual(p.levels.beds, 'editor');
  assert.strictEqual(p.grants.labs, 'view', 'чужие ключи не трогаем');
  const res = calls.find((d) => d.table === 'role_permission_reviews' && d.op === 'update');
  assert.strictEqual(res.values.resolution, 'restored');
  assert.deepStrictEqual(res.filters, [{ col: 'id', op: 'eq', val: 7 }]);
});

test('роль уже поправили руками — права не перезаписываются, запись закрывается', async () => {
  calls = []; ROW = EDITED;
  await review.restoreDefaults({ id: 7, role: 'nurse', area: 'inpatient' });
  assert.ok(!calls.some((d) => d.table === 'role_permissions' && d.op === 'update'));
  assert.ok(calls.some((d) => d.table === 'role_permission_reviews' && d.op === 'update'));
});

test('врезка: по-русски, две кнопки; «Оставить как есть» права не трогает', async () => {
  calls = []; REVIEWS = [{ id: 7, role: 'nurse', area: 'inpatient', resolution: null }];
  let done = 0;
  const box = review.roleReviewNotice('nurse', OLD, { onDone: () => { done++; } });
  await tick();
  const text = textOf(box);
  assert.ok(text.includes('Проверьте права этой роли'));
  assert.ok(text.includes('не записывает измерения'));
  const keep = buttons(box).find((b) => textOf(b).includes('Оставить как есть'));
  assert.ok(buttons(box).some((b) => textOf(b).includes('Вернуть права по умолчанию')));
  keep.click();
  await tick();
  assert.strictEqual(done, 1);
  assert.ok(!calls.some((d) => d.table === 'role_permissions' && d.op === 'update'));
  assert.strictEqual(calls.find((d) => d.table === 'role_permission_reviews' && d.op === 'update').values.resolution, 'kept');
});

test('нет записей — нет и врезки', async () => {
  calls = []; REVIEWS = [];
  const box = review.roleReviewNotice('nurse', OLD);
  await tick();
  assert.strictEqual(box.children.length, 0);
});
