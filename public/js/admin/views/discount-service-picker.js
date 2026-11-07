// DISCOUNT_V2 (решение владельца 2026-11-07, п. 5) — «ТОЛЬКО НА ЭТИ УСЛУГИ» — ОКНО ВЫБОРА.
//
// Было: длинный список всех услуг клиники с галочками прямо в форме скидки. Стало:
// в форме — сколько выбрано и выбранные услуги «фишками» (каждую можно убрать
// крестиком) и кнопка «Выбрать услуги…»; в окне — поиск, услуги по категориям (а
// без категории — по группе услуги), «Выбрать всю категорию», счётчик выбранного.
// Сохраняется то же, что прежде: массив id услуг (patient_discounts.service_ids,
// колонка json в реестре) — ни одна прежняя скидка не меняется.
//
// Чистые функции (groupServicesForPicker, filterPickerGroups, toggleGroupIds) — без
// DOM и сети: их проверяет тест. Окно и поле формы — ниже, на h() из ui.js.
import { supabase } from '../../supabase.js';
import { h, Icon, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { serviceGroupLabel } from './service-group.js?v=aug17e';
// DISCOUNT_RATES_V1 (3.22.0) — у скидки свои ставки по группе, категории и услуге (мигр. 274).
import { parseRates, cleanRates, ratesSummary, RATE_GROUPS, RATE_GROUP_LABELS } from '../discount-rates.js';

const collator = new Intl.Collator('ru');

/**
 * Услуги по разделам окна: категория услуги, а без неё — группа услуги.
 * @param {Array<{id:number,name:string,type?:string,type_id?:number,category_id?:number}>} services
 * @param {{types?: Array<{id:number,name:string}>, categories?: Array<{id:number,name:string}>}} refs
 * @returns {Array<{key:string, name:string, items:Array<{id:number,name:string}>}>}
 */
export function groupServicesForPicker(services, { types = [], categories = [] } = {}) {
  const catName = new Map((categories || []).map((c) => [String(c.id), c.name || '']));
  const groups = new Map();
  for (const s of services || []) {
    const id = Number(s && s.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const cat = s.category_id != null && catName.get(String(s.category_id));
    const name = cat || serviceGroupLabel(s, types) || '—';
    const key = (cat ? 'c:' : 'g:') + name;
    if (!groups.has(key)) groups.set(key, cat ? { key, name, items: [], categoryId: Number(s.category_id) } : { key, name, items: [] });   // categoryId: DISCOUNT_RATES_V1 — ставка категории
    groups.get(key).items.push({ id, name: String(s.name || '') });
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => collator.compare(a.name, b.name));
  return out.sort((a, b) => collator.compare(a.name, b.name));
}

/** Разделы с услугами, подходящими под поиск (по названию услуги или раздела). */
export function filterPickerGroups(groups, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return groups;
  const out = [];
  for (const g of groups || []) {
    if (g.name.toLowerCase().includes(q)) { out.push(g); continue; }
    const items = g.items.filter((it) => it.name.toLowerCase().includes(q));
    if (items.length) out.push({ ...g, items });
  }
  return out;
}

/** «Выбрать всю категорию»: все её (видимые) услуги выбраны — снять их, иначе — выбрать все. */
export function toggleGroupIds(selected, items) {
  const ids = (items || []).map((it) => Number(it.id));
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  for (const id of ids) { if (all) selected.delete(id); else selected.add(id); }
  return selected;
}

/**
 * Окно выбора услуг. onApply(ids) — выбранные id по порядку выбора; «Отмена» —
 * без изменений.
 */
export function openDiscountServicePicker({ selected = [], groups = [], onApply, rates = undefined, withScope = true }) {
  const picked = new Set((selected || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  // DISCOUNT_RATES_V1 — rates передан: у категории и у услуги — поле «%» (пусто — процент
  // скидки по умолчанию), сверху — пять групп услуг. withScope: false — только ставки
  // (скидка группы пациентов: «только на эти услуги» у неё нет).
  const withRates = rates !== undefined;
  const r = withRates ? parseRates(rates) : null;
  const overlay = h('div', { class: 'modal', 'data-discount-services-picker': '' });
  const close = () => overlay.remove();
  overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
  const q = h('input', { type: 'search', placeholder: tr('Поиск услуги или категории…'), 'data-picker-search': '', style: { width: '100%' } });
  const list = h('div', { 'data-picker-list': '', style: { maxHeight: '52vh', overflowY: 'auto', display: 'grid', gap: '10px', marginTop: '8px' } });
  const countEl = h('span', { 'data-picker-count': '', style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-700)' } });
  const sync = () => { countEl.textContent = withScope ? trf('Выбрано: {n}', { n: picked.size }) : trf('Своих ставок: {n}', { n: Object.keys(r.c).length + Object.keys(r.s).length }); };
  const paint = () => {
    clear(list);
    const shown = filterPickerGroups(groups, q.value);
    if (!shown.length) list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr(groups.length ? 'Ничего не найдено' : 'Услуг нет')));
    for (const g of shown) {
      const chosen = g.items.filter((it) => picked.has(it.id)).length;
      const all = chosen === g.items.length && g.items.length > 0;
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', borderBottom: '1px solid var(--ink-100)' } },
        h('span', { style: { flex: 1, fontWeight: 700, fontSize: '13.5px' } }, g.name),
        withScope ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, chosen + ' / ' + g.items.length) : null,
        withScope ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-picker-group': g.key,
          onclick: () => { toggleGroupIds(picked, g.items); sync(); paint(); } },
        tr(all ? 'Снять всю категорию' : 'Выбрать всю категорию')) : null,
        withRates && g.categoryId ? rateInput(r, 'c', g.categoryId, sync, { 'data-rate-category': String(g.categoryId) }) : null);
      const rows = h('div', { style: { display: 'grid', gap: '2px', paddingLeft: '4px' } });
      for (const it of g.items) {
        let cb = null;
        if (withScope) {
          cb = h('input', { type: 'checkbox', checked: picked.has(it.id), 'data-picker-service': String(it.id) });
          cb.checked = picked.has(it.id);
          cb.addEventListener('change', () => { if (cb.checked) picked.add(it.id); else picked.delete(it.id); sync(); });
        }
        rows.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', cursor: 'pointer', padding: '2px 0', flex: 1, minWidth: 0 } }, cb, it.name),
          withRates ? rateInput(r, 's', it.id, sync, { 'data-rate-service': String(it.id) }) : null));
      }
      list.appendChild(h('div', null, head, rows));
    }
    sync();
  };
  q.addEventListener('input', paint);
  const apply = h('button', { class: 'btn btn-primary', type: 'button', 'data-picker-apply': '',
    onclick: () => { close(); if (typeof onApply === 'function') onApply([...picked], withRates ? cleanRates(r) : undefined); } }, tr('Применить'));   // DISCOUNT_RATES_V1 — и ставки
  overlay.appendChild(h('div', { class: 'modal-card', style: { width: '620px', maxWidth: 'calc(100vw - 32px)' } },
    h('header', { class: 'modal-head' },
      h('h2', null, Icon('Coins', { size: 16 }), ' ', tr(withScope ? 'Услуги скидки' : 'Скидка по услугам')),
      h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, withRates ? groupRateRows(r, sync) : null, withRates ? h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '6px 0' } },
      tr('Пусто — процент скидки по умолчанию. Действует самая точная ставка: услуга, потом категория, потом группа. 0 % — без скидки, 100 % — бесплатно.')) : null, q, list),
    h('footer', { class: 'modal-foot' },
      countEl,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
      apply)));
  document.body.appendChild(overlay);
  paint();
  return { close, overlay };
}

/**
 * Поле формы скидки «Только на эти услуги»: сколько выбрано, фишки выбранных
 * услуг (крестик убирает), «Выбрать услуги…» — окно выше. Как прежнее поле:
 * .value — массив id, .load() — загрузить каталог после монтирования.
 */
export function discountServicesField(initialIds, emptyHint = 'Ничего не отмечено — скидка действует на весь счёт', { rates = undefined } = {}) {
  let picked = [...new Set((initialIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  // DISCOUNT_RATES_V1 — ставки скидки (rates передан): пять групп прямо в форме, остальное — в окне.
  const withRates = rates !== undefined;
  let r = withRates ? parseRates(rates) : null;
  const summaryEl = withRates ? h('div', { class: 'muted', 'data-rates-summary': '', style: { fontSize: '12.5px' } }) : null;
  const paintSummary = () => { if (summaryEl) summaryEl.textContent = ratesSummaryText(null, r) || tr('Своих ставок нет — один процент на все услуги скидки'); };
  let services = [], types = [], categories = [];
  const chips = h('div', { 'data-discount-chips': '', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
  const countEl = h('div', { class: 'muted', 'data-discount-count': '', style: { fontSize: '12.5px' } });
  const nameOf = (id) => { const s = services.find((x) => Number(x.id) === id); return s ? s.name : '#' + id; };
  const paint = () => {
    clear(chips);
    countEl.textContent = picked.length ? trf('Выбрано услуг: {n}', { n: picked.length }) : tr(emptyHint);
    for (const id of picked) {
      chips.appendChild(h('span', { 'data-discount-chip': String(id), style: { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 4px 2px 9px', borderRadius: '999px', background: 'var(--primary-50, #e8f3f2)', color: 'var(--primary-700)', fontSize: '12.5px', fontWeight: 600 } },
        nameOf(id),
        h('button', { type: 'button', 'aria-label': tr('Убрать'), 'data-discount-chip-remove': String(id),
          style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: '0 4px', fontSize: '13.5px', lineHeight: 1 },
          onclick: () => { picked = picked.filter((x) => x !== id); paint(); } }, '×')));
    }
  };
  const openBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-discount-services-open': '',
    onclick: () => openDiscountServicePicker({ selected: picked, groups: groupServicesForPicker(services, { types, categories }),
      ...(withRates ? { rates: r } : {}),
      onApply: (ids, nr) => { picked = ids; if (withRates && nr) { r = parseRates(nr); rebuildQuick(); } paint(); } }) },
  Icon('Plus', { size: 13 }), ' ', tr('Выбрать услуги…'));
  const quickHost = h('div', null);
  function rebuildQuick() { if (!withRates) return; clear(quickHost); quickHost.appendChild(groupRateRows(r, paintSummary)); paintSummary(); }
  const el = h('div', { style: { display: 'grid', gap: '6px' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, openBtn, countEl), chips,
    withRates ? quickHost : null, summaryEl);
  rebuildQuick();
  el.load = async () => {
    try {
      const [s, t, c] = await Promise.all([
        supabase.from('services').select('id,name,type,type_id,category_id').eq('active', 1).order('name').limit(5000),
        supabase.from('service_types').select('id,name').order('name'),
        supabase.from('service_categories').select('id,name').order('name'),
      ]);
      services = s && !s.error ? (s.data || []) : [];
      types = t && !t.error ? (t.data || []) : [];
      categories = c && !c.error ? (c.data || []) : [];
    } catch (e) { services = []; }
    paint();
  };
  Object.defineProperty(el, 'value', { get: () => [...picked] });
  if (withRates) Object.defineProperty(el, 'rates', { get: () => cleanRates(r) });   // DISCOUNT_RATES_V1
  paint();
  return el;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOUNT_RATES_V1 (3.22.0, владелец 2026-11-07) — СТАВКИ СКИДКИ ПО УСЛУГАМ.
// «Консультации — 100 %, остальное — 20 %» — два нажатия: «100 %» у Консультаций
// и «Сохранить» (20 % — процент самой скидки). Пять групп — прямо в форме; категории и
// отдельные услуги — в окне «Скидка по услугам» (то же окно, что «Услуги скидки»).
// ═══════════════════════════════════════════════════════════════════════════

/** Поле «%» ставки: пусто — процент скидки по умолчанию. */
function rateInput(r, level, key, onChange, attrs = {}) {
  const k = String(key);
  const cur = r[level][k];
  const inp = h('input', { type: 'number', min: '0', max: '100', step: 'any', placeholder: tr('по умолч.'), value: cur !== undefined ? String(cur) : '',
    'aria-label': tr('Скидка, %'), ...attrs, style: { width: '84px', textAlign: 'right' } });
  inp.value = cur !== undefined ? String(cur) : '';
  inp.addEventListener('input', () => {
    const v = String(inp.value).trim();
    if (v === '' || !Number.isFinite(Number(v))) delete r[level][k];
    else r[level][k] = Math.min(100, Math.max(0, Number(v)));
    if (typeof onChange === 'function') onChange();
  });
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, inp, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '%'));
}

/** Пять групп услуг: поле «%» и быстрые «100 %» / «0 %». */
export function groupRateRows(r, onChange) {
  const box = h('div', { 'data-rate-groups': '', style: { display: 'grid', gap: '4px' } });
  for (const g of RATE_GROUPS) {
    const cell = rateInput(r, 'g', g, onChange, { 'data-rate-group': g });
    const inp = cell.children[0];
    const quick = (v) => h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-rate-quick': g + ':' + v,
      onclick: () => { inp.value = String(v); r.g[g] = v; if (typeof onChange === 'function') onChange(); } }, v + ' %');
    box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('span', { style: { minWidth: '120px', fontSize: '13.5px' } }, tr(RATE_GROUP_LABELS[g])), cell, quick(100), quick(0)));
  }
  return box;
}

/**
 * Сводка у строки скидки: «По умолчанию 20 %, Консультации 100 %, услуг со своей ставкой: 3».
 * defPct — процент скидки (null — без «по умолчанию»); '' — ставок нет.
 */
export function ratesSummaryText(defPct, rates) {
  const s = ratesSummary(defPct, rates);
  if (!s) return '';
  const parts = [];
  if (defPct !== null && defPct !== undefined) parts.push(trf('По умолчанию {pct} %', { pct: s.def }));
  for (const g of s.groups) parts.push(tr(RATE_GROUP_LABELS[g.key]) + ' ' + g.pct + ' %');
  if (s.categories) parts.push(trf('категорий со своей ставкой: {n}', { n: s.categories }));
  if (s.services) parts.push(trf('услуг со своей ставкой: {n}', { n: s.services }));
  return parts.join(', ');
}

/**
 * Поле «Скидка по услугам» группы пациентов: пять групп в форме, «Категории и услуги…» —
 * окно. .value — ставки для записи (JSON-колонка discount_rates), .load() — каталог.
 */
export function discountRatesField(initialRates) {
  let r = parseRates(initialRates);
  let services = [], types = [], categories = [];
  const summaryEl = h('div', { class: 'muted', 'data-rates-summary': '', style: { fontSize: '12.5px' } });
  const paintSummary = () => { summaryEl.textContent = ratesSummaryText(null, r) || tr('Своих ставок нет — скидка группы на все услуги'); };
  const quickHost = h('div', null);
  const rebuild = () => { clear(quickHost); quickHost.appendChild(groupRateRows(r, paintSummary)); paintSummary(); };
  const openBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-rates-open': '',
    onclick: () => openDiscountServicePicker({ selected: [], groups: groupServicesForPicker(services, { types, categories }), rates: r, withScope: false,
      onApply: (_ids, nr) => { if (nr) r = parseRates(nr); rebuild(); } }) },
  Icon('Plus', { size: 13 }), ' ', tr('Категории и отдельные услуги…'));
  const el = h('div', { 'data-rates-field': '', style: { display: 'grid', gap: '6px' } }, quickHost, h('div', null, openBtn), summaryEl);
  el.load = async () => {
    try {
      const [s, t, c] = await Promise.all([
        supabase.from('services').select('id,name,type,type_id,category_id').eq('active', 1).order('name').limit(5000),
        supabase.from('service_types').select('id,name').order('name'),
        supabase.from('service_categories').select('id,name').order('name'),
      ]);
      services = s && !s.error ? (s.data || []) : [];
      types = t && !t.error ? (t.data || []) : [];
      categories = c && !c.error ? (c.data || []) : [];
    } catch (e) { services = []; }
  };
  Object.defineProperty(el, 'value', { get: () => cleanRates(r) });
  rebuild();
  return el;
}
