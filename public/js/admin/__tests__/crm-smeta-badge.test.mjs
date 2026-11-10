// CRM_SMETA_BADGE_V1 (3.23.0) — ЗНАЧКИ «ИЗ ЗАЯВКИ» В СМЕТЕ РЕГИСТРАТУРЫ: подписи и вид.
// Владелец: «its there in the smeta but its not prominent» — строка из заявки и пациент, записанный
// из заявки, видны в правой «Смете» сразу: бирюзовый жирный значок, как чип «ИЗ ЗАЯВКИ» каталога, с
// днём записи; на ru, uz и en (uz и en — без кириллицы).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  get textContent() { return this._t + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
// Иконка (ui.js Icon → html()) — разметка в <template>: здесь она становится узлом SVG.
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = new F('#fragment');
    Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s.attrs.markup = String(v); e.content.children = [s]; }, get() { return ''; } });
  }
  return e;
};
globalThis.Node = F;
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t), head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const { setLang } = await import('../i18n.js');
const B = await import('../views/crm-smeta-badge.js');
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const text = (e) => walk(e).map((n) => n._t || '').join('').replace(/\s+/g, ' ').trim();
const CYR = /[Ѐ-ӿ]/;

test('CRM_SMETA_BADGE_V1: подписи — день строки, самый ранний день у пациента, без даты — без дня', () => {
  setLang('ru');
  assert.equal(B.crmDayShort('2026-11-10'), '10.11');
  assert.equal(B.crmDayShort('2026-11-10T10:00:00Z'), '10.11');
  assert.equal(B.crmDayShort(null), '');
  assert.equal(B.crmLineText('2026-11-10'), 'из заявки · 10.11');
  assert.equal(B.crmLineText(null), 'из заявки');
  assert.equal(B.crmBookedText(['2026-11-12', null, '2026-11-10']), 'Записан из заявки на 10.11');
  assert.equal(B.crmBookedText([null]), 'Услуги из заявки');
  assert.equal(B.crmBookedText([]), null);
  assert.equal(B.crmBookedBadge([]), null, 'строк из заявки нет — значка у пациента нет');
});

test('CRM_SMETA_BADGE_V1: вид — заметный значок (бирюзовый, жирный, с иконкой), не серая мелочь', () => {
  setLang('ru');
  const line = B.crmLineBadge('2026-11-10');
  assert.equal(line.className, 'tag');
  assert.equal(line.attrs['data-crm-line'], '10.11');
  assert.equal(text(line), 'из заявки · 10.11');
  assert.equal(line.style.fontWeight, 700);
  assert.match(line.style.color, /teal-700/);
  assert.match(line.style.background, /teal-50/);
  assert.equal(line.children[0].tagName, 'SVG', 'нет иконки');
  assert.equal(B.crmBookedBadge(['2026-11-10']).children[0].tagName, 'SVG', 'у значка пациента нет иконки');
  const head = B.crmBookedBadge(['2026-11-10']);
  assert.equal(head.attrs['data-crm-booked'], '10.11');
  assert.equal(text(head), 'Записан из заявки на 10.11');
  assert.equal(head.style.fontWeight, 700);
  assert.equal(head.style.fontSize, '13.5px', 'значок у пациента — не мельче текста сметы');
  assert.match(head.style.color, /teal-700/);
});

test('CRM_SMETA_BADGE_V1: en и uz — перевод, без кириллицы', () => {
  try {
    setLang('en');
    assert.equal(B.crmLineText('2026-11-10'), 'from request · 10.11');
    assert.equal(B.crmBookedText(['2026-11-10']), 'Booked from request for 10.11');
    assert.equal(text(B.crmLineBadge('2026-11-10')), 'from request · 10.11');
    assert.equal(text(B.crmBookedBadge(['2026-11-10'])), 'Booked from request for 10.11');
    for (const lang of ['en', 'uz']) {
      setLang(lang);
      for (const s of [B.crmLineText('2026-11-10'), B.crmLineText(null), B.crmBookedText(['2026-11-10']), B.crmBookedText([null])]) {
        assert.doesNotMatch(s, CYR, lang + ': ' + s);
        assert.ok(s && s.trim(), lang + ': пустая подпись');
      }
    }
    setLang('uz');
    assert.equal(B.crmLineText('2026-11-10'), 'arizadan · 10.11');
  } finally { setLang('ru'); }
});
