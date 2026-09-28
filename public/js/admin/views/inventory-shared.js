// Закупки — shared helpers for the procurement workspace modules
// (inventory.js shell + inventory-sklad.js / inventory-products.js /
// inventory-suppliers.js). Extracted from the original single-file
// inventory.js (PROCUREMENT_WORKSPACE_V1) during PROCUREMENT_REDESIGN_V1 so
// every tab module formats numbers, guards stale fetches, and labels stock
// movements the same way.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag } from '../ui.js';
import { GOODS_CATEGORY_RU } from '../../shared/goods-catalog.js';   // SUPPLIERS_VAT_V1

// Cross-module fetch-race guard: every tab's async fetch grabs a token and
// bails (without touching the DOM) if a newer fetch — including one triggered
// by switching tabs — has landed since. One shared counter object so a fetch
// started by the previous tab module is invalidated by the next one.
export const fetchGuard = { token: 0 };

export function loadingCard() {
    return h('div', { class: 'card', style: { textAlign: 'center', padding: '40px 20px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…');
}

// Placeholder for panes deferred to phase 2.
export function comingSoon(title, text, icon) {
    return h('div', { class: 'card' },
        h('div', { class: 'empty' },
            h('div', { style: { marginBottom: '10px', color: 'var(--ink-400)' } }, Icon(icon, { size: 32 })),
            h('div', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--ink-800)', marginBottom: '4px' } }, title),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, text),
        ),
    );
}

// Thousands-separated integer money display (e.g. 50000 -> "50 000").
export function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Money keeping up to 2 decimals (2169.51 -> "2 169.51", 285000 -> "285 000").
export function fmtMoney2(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const [int, frac] = Math.abs(v).toFixed(2).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const sign = v < 0 ? '-' : '';
    return sign + (frac === '00' ? grouped : `${grouped}.${frac}`);
}

// Trim a display-only quantity to a sane precision (whole numbers stay whole).
export function fmtQty(n) {
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n * 100) / 100);
}

// Signed quantity + unit, e.g. "+30 шт" / "-5 шт" (stock_movements.qty is
// already signed at the DB level — receive/void positive, dispense negative,
// adjust either way — this just makes the '+' explicit for readability).
export function fmtSignedQty(n, unit) {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : '';
    return `${sign}${fmtQty(v)} ${unit || ''}`.trim();
}

// Reorder rule, shared by the Склад flag, the Товары «Мало» tag and the
// Дашборд KPI. A product counts as low only when a reorder level is actually
// set — the default 0 would otherwise flag everything the moment it hits zero.
export function isLowStock(p) {
    const reorder = Number(p.reorder_level) || 0;
    return reorder > 0 && (Number(p.on_hand) || 0) <= reorder;
}

// PROCUREMENT_CATEGORIES_V1 — fixed catalog, stored in products.procurement_category.
// SUPPLIERS_VAT_V1 — типы товаров «жёстко»: один список на сервер и экран
// (public/js/shared/goods-catalog.js — его же читают product_save, импорт Excel
// и отчёты). Названия переводятся при показе (h() → tr()).
export const CATEGORY_LABEL = GOODS_CATEGORY_RU;

// SUPPLIERS_VAT_V1 — выбор ставки НДС: ровно три варианта. Значение <select> —
// строка: '12', '0' или 'none' («без НДС»); на сервер уходит 12, 0 или null.
export const VAT_OPTIONS = [['12', '12 %'], ['0', '0 %'], ['none', 'Без НДС']];
export function vatToSelect(rate) {
    if (rate === null || rate === undefined || rate === '') return 'none';
    return String(Number(rate));
}
export function vatFromSelect(value) {
    return value === 'none' || value === '' || value == null ? null : Number(value);
}
/** <select> ставки НДС; onChange получает 12 | 0 | null. */
export function vatSelect(rate, onChange, style = {}) {
    const sel = h('select', { style: { ...selStyle, width: 'auto', minWidth: '96px', ...style }, 'aria-label': 'Ставка НДС' },
        ...VAT_OPTIONS.map(([v, label]) => h('option', { value: v, selected: vatToSelect(rate) === v }, label)));
    sel.value = vatToSelect(rate);
    if (typeof onChange === 'function') sel.addEventListener('change', () => onChange(vatFromSelect(sel.value)));
    return sel;
}
/** Подпись ставки для таблиц: «12 %», «0 %», «Без НДС». */
export function vatText(rate) {
    const v = vatToSelect(rate);
    const opt = VAT_OPTIONS.find(([x]) => x === v);
    return opt ? opt[1] : 'Без НДС';
}

// Inline styles for selects / numeric inputs inside modal line tables.
export const selStyle = { width: '100%', height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit' };
export const numStyle = { width: '100%', height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', textAlign: 'right' };

// RU movement tag; «Выдача» is kind 'dispense' + reference_type 'issue'
// (issue_stock_lines). A plain 'dispense' is a visit dispense (Списание).
const MOVEMENT_KIND = {
    receive:  { label: 'Приход',        kind: 'ok' },
    dispense: { label: 'Списание',      kind: 'info' },
    adjust:   { label: 'Корректировка', kind: 'warn' },
    void:     { label: 'Отмена',        kind: 'off' },
};
export function movementTag(m) {
    if (m.kind === 'dispense' && m.reference_type === 'issue') {
        return Tag('Выдача', { kind: 'info', dot: true });
    }
    const t = MOVEMENT_KIND[m.kind] || { label: m.kind || '—', kind: '' };
    return Tag(t.label, { kind: t.kind, dot: true });
}

// Движения склада — «Последние приходы» на Дашборде склада.
//
// STOCK_LOG_V1 — ХОДИТ RPC, А НЕ В ТАБЛИЦУ. Журнал движений закрыт в реестре
// (server/db/schema-registry.js: читать stock_movements напрямую может только
// склад), потому что «кому выдали» и «почём куплено» — это не то, что видит
// каждый вошедший. Кто и сколько из журнала увидит, решает ОДНО правило на
// сервере (rpc/stock-log.js journalScope: своё / свой отдел / вся клиника), и
// оно же знает про настроенные клиникой уровни доступа, которых восемь основных
// ролей реестра выразить не могут. Поэтому карточка спрашивает у той же двери,
// что и сам журнал, а не у второй, открытой шире.
//
// Форма ответа остаётся прежней (`products.name` рядом со строкой): вызывающие
// читают её так с первого дня, и менять их ради имени поля незачем.
export async function fetchMovements({ kind, limit } = {}) {
    const { data, error } = await supabase.rpc('stock_movements_list', {
        kind: kind || 'all',
        ...(limit ? { limit } : {}),
    });
    if (error) return { data: null, error };
    const rows = (data && data.movements) || [];
    return {
        data: rows.map(m => ({ ...m, products: { name: m.product_name, base_unit: m.unit, unit: m.unit } })),
        error: null,
    };
}
