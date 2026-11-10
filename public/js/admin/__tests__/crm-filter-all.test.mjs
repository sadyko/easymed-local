// CRM_FILTER_ALL_VALUE_V1 (3.23.0) — «Все» в списках «Источник» и «Метки» над
// доской CRM — настоящее значение, а не пустое.
//
// Владелец (2026-11-10): фильтр «не работает». Пункт «Все · 7163» стоял с
// пустым значением, и список программы (ui-select.js) рисовал его серым, как
// пустое поле-подсказку, и не показывал среди вариантов: фильтр работал, но
// выглядел выключенным. Теперь у «Все» своё значение (CRM_FILTER_ALL): поле
// пишет его тёмным, как любой выбор, в открытом списке оно есть, и выбор его
// снимает фильтр.
//
// Здесь — НАСТОЯЩИЙ enhanceSelect поверх поля доски. Стенду доски (crm-harness)
// для этого нужны options, classList, querySelector по классу и contains —
// они дописываются ниже, только в этом файле (отдельный процесс теста).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, mk, walk, textOf, byClass, byAttr, tick } from './crm-harness.mjs';

const { renderCrm, CRM_FILTER_ALL } = await import('../views/crm.js');
const { enhanceSelect } = await import('../ui-select.js');

// --- поддельному DOM — то, что нужно списку программы ---------------------
const P = globalThis.Node.prototype;
Object.defineProperty(P, 'options', { get() { return walk(this).filter((n) => n.tagName === 'OPTION'); } });
Object.defineProperty(P, 'classList', { get() {
  const s = this;
  const list = () => String(s.className || '').split(/\s+/).filter(Boolean);
  return {
    contains: (c) => list().includes(c),
    add: (c) => { if (!list().includes(c)) s.className = [...list(), c].join(' '); },
    remove: (c) => { s.className = list().filter((x) => x !== c).join(' '); },
    toggle: (c, on) => {
      const has = list().includes(c);
      const want = on === undefined ? !has : !!on;
      if (want && !has) s.className = [...list(), c].join(' ');
      if (!want && has) s.className = list().filter((x) => x !== c).join(' ');
      return want;
    },
  };
} });
const origQS = P.querySelector;
P.querySelector = function (sel) {
  const m = /^\.([\w-]+)$/.exec(String(sel));
  if (!m) return origQS.call(this, sel);
  return walk(this).slice(1).find((n) => String(n.className || '').split(/\s+/).includes(m[1])) || null;
};
P.contains = function (n) { return walk(this).includes(n); };
// Подпись варианта — текст его детей (<option> из h() держит подпись дочерним узлом).
const tcDesc = Object.getOwnPropertyDescriptor(P, 'textContent');
Object.defineProperty(P, 'textContent', { configurable: true, get() { return textOf(this); }, set(v) { tcDesc.set.call(this, v); } });
window.removeEventListener = () => {};

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const lead = (id, status, source) => ({ id, full_name: 'Лид ' + id, phone: '+99890' + String(1000000 + id), status, source, created_at: now });
const TAGS = [{ key: 'vip', label: 'VIP', color: 'purple', position: 1, is_active: true }];

async function board() {
  window.easymed.state.user = ADMIN;
  S.config = { tags: TAGS };
  S.leads = [lead(1, 'in_process', 'call'), lead(2, 'in_process', 'instagram'), lead(3, 'recall', 'instagram')];
  S.search = []; S.tasks = []; S.leadTags = [{ request_id: 2, tag_key: 'vip' }]; S.dups = []; S.staff = [];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const fieldOf = (wrap) => walk(wrap).find((n) => String(n.className).split(' ').includes('uisel-val'));
function openRows(wrap) {
  walk(wrap).find((n) => String(n.className).split(' ').includes('uisel-field')).click();
  const pop = document.body.children.find((n) => String(n.className).includes('uisel-pop'));
  return walk(pop).filter((n) => String(n.className).split(' ').includes('uisel-row'));
}
const rowText = (r) => textOf(r).trim();

for (const [what, attr, pickLabel, cardsAfterPick] of [
  ['Источник', 'data-src-select', 'Instagram', 2],
  ['Метки', 'data-tag-select', 'VIP', 1],
]) {
  test(`CRM_FILTER_ALL_VALUE_V1: «${what}» — «Все» тёмным, как выбор, есть в открытом списке и снимает фильтр`, async () => {
    const root = await board();
    try {
      const sel = byAttr(root, attr)[0];
      assert.equal(sel.value, CRM_FILTER_ALL);
      const wrap = enhanceSelect(sel);
      const val = fieldOf(wrap);
      assert.equal(val.textContent, 'Все · 3');
      assert.ok(!String(val.className).includes('is-empty'), '«Все» нарисовано серым, как пустое поле');
      let rows = openRows(wrap);
      assert.ok(rows.some((r) => rowText(r).startsWith('Все · 3')), '«Все» нет среди вариантов: ' + rows.map(rowText).join(' | '));
      assert.ok(!rows.some((r) => String(r.className).includes('is-clear')), 'строка «сброса» вместо пункта «Все»');
      // выбор варианта сужает доску
      rows.find((r) => rowText(r).startsWith(pickLabel))._l.mousedown[0]({ preventDefault() {} });
      await tick(40);
      assert.equal(byClass(root, 'crm-card').length, cardsAfterPick);
      // выбор «Все» в новом поле (фильтры перерисованы) — фильтр снят
      const sel2 = byAttr(root, attr)[0];
      const wrap2 = enhanceSelect(sel2);
      rows = openRows(wrap2);
      const all = rows.find((r) => rowText(r).startsWith('Все'));
      assert.ok(all, '«Все» нет в списке, когда выбран другой вариант');
      all._l.mousedown[0]({ preventDefault() {} });
      await tick(40);
      assert.equal(byClass(root, 'crm-card').length, 3, '«Все» не снял фильтр');
      assert.equal(byAttr(root, attr)[0].value, CRM_FILTER_ALL);
    } finally {
      const s = byAttr(root, attr)[0];
      if (s) { s.value = CRM_FILTER_ALL; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); await tick(); }
      document.body.children.length = 0;
      S.config = null; S.leadTags = []; window.easymed.state.user = null;
    }
  });
}

test('CRM_FILTER_ALL_VALUE_V1: значение «Все» не совпадает ни с одним ключом источника или метки', () => {
  // Ключи справочников — [a-z0-9_]{1,32} (server/services/crm/config.js KEY_RE): «all» мог бы быть ключом.
  assert.ok(!/^[a-z0-9_]{1,32}$/.test(CRM_FILTER_ALL), 'значение «Все» может совпасть с ключом справочника');
  assert.notEqual(CRM_FILTER_ALL, '');
});
