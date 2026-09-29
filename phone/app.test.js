// ROLES_SAVE_TRUTH_V1 (2026-09-29) — EasyPhone: «Прослушать» только тому, кому
// слушать можно (`may_hear` журнала); отказ станции или прав — текстом в
// строке, а не только в подсказке под мышью (спецификация, п. 5, «Тесты», п. 7).
//
// Прежде кнопка была у каждого разговора, а после нажатия превращалась в
// «Не вышло» — причина пряталась в title, и оператор видел лишь «не работает».
import test from 'node:test';
import assert from 'node:assert/strict';

// Крошечная DOM ровно под phone/public/app.js.
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.attrs = {}; this._t = ''; this._l = {}; this.hidden = false; this.disabled = false; this.className = ''; this.title = ''; this.value = ''; }
  appendChild(c) { const n = typeof c === 'string' ? new Txt(c) : c; n.parentNode = this; this.children.push(n); return n; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  replaceWith(n) { const p = this.parentNode; const i = p.children.indexOf(this); p.children.splice(i, 1, n); n.parentNode = p; this.parentNode = null; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  click() { for (const fn of this._l.click || []) fn({ type: 'click', preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  querySelector() { return new El('span'); }
  set innerHTML(v) { this.children = []; this._t = ''; const text = String(v || '').replace(/<[^>]*>/g, ''); if (text) this.appendChild(new Txt(text)); }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._t = String(v); this.children = []; }
}
class Txt extends El { constructor(t) { super('#text'); this._t = String(t); } }
const walk = (e, o = []) => { o.push(e); for (const c of e.children) walk(c, o); return o; };
const buttons = (el) => walk(el).filter((n) => n.tagName === 'BUTTON');

let ids = {};
globalThis.document = {
  createElement: (t) => new El(t),
  getElementById: (id) => ids[id] || (ids[id] = new El('div')),
  querySelector: () => null,
  addEventListener() {},
};
globalThis.setInterval = () => 0;   // экран обновляется сам — в тесте незачем
const flush = () => new Promise((r) => setTimeout(r, 25));

const CALL = { id: 5, started_at: new Date().toISOString(), call_type: 0, external_number: '998901112233', internal_number: '101',
  billsec: 42, patient_name: 'Каримова Азиза', has_recording: true, recording_url: null };
let reply = () => ({ status: 404, body: {} });
globalThis.fetch = async (path) => {
  const r = reply(String(path));
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
async function boot(name, { mayHear, recording }) {
  ids = {};
  reply = (path) => {
    if (path === '/api/me') return { status: 200, body: { id: 1, full_name: 'Оператор', extension: '', line: null, seen_extensions: [] } };
    if (path === '/api/extensions') return { status: 200, body: { extensions: [] } };
    if (path.startsWith('/api/calls')) return { status: 200, body: { may_hear: mayHear, calls: [CALL] } };
    if (path.startsWith('/api/recording')) return recording;
    return { status: 404, body: { error: { message: 'нет такого маршрута' } } };
  };
  await import('./public/app.js?case=' + name);
  await flush();
  return { rec: ids.rows.children[0].children[5], note: ids.recNote };
}

test('без права слушать: «Прослушать» не рисуется, под журналом сказано почему', async () => {
  const { rec, note } = await boot('deny', { mayHear: false });
  assert.equal(buttons(rec).length, 0, 'кнопка «Прослушать» у того, кому слушать нельзя');
  assert.ok(note, 'строки-пояснения под журналом нет');
  assert.equal(note.hidden, false, 'не сказано, почему нет кнопки');
  assert.match(note.textContent, /«Прослушать запись»/);
});

test('с правом — кнопка есть; отказ виден текстом в строке, кнопку можно нажать снова', async () => {
  const message = 'Слушать записи — недоступно вашей роли. Права выдаёт администратор в «Настройки → Роли».';
  const { rec, note } = await boot('allow', { mayHear: true, recording: { status: 403, body: { error: { message } } } });
  assert.ok(!note || note.hidden === true, 'пояснение про право у того, кому слушать можно');
  const [b] = buttons(rec);
  assert.ok(b && b.textContent === 'Прослушать', 'кнопки «Прослушать» нет');
  b.click();
  await flush();
  assert.ok(rec.textContent.includes(message), 'причина отказа не видна в строке: ' + rec.textContent);
  assert.equal(b.textContent, 'Прослушать', 'кнопка осталась «Не вышло» — повторить нельзя');
});
