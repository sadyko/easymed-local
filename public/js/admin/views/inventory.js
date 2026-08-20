// Закупки — PROCUREMENT_REDESIGN_V1 — workspace shell matching the cloud
// design. Page head «Закупки» + toolbar chips (Дашборд / Отделения / Сроки
// годности / Инвентаризация / Журнал / Обновить) + underline tabs (Склад /
// Заявки / Заказы на закупку / Товары / Поставщики).
//
// Live panes: Склад (inventory-sklad.js), Товары (inventory-products.js),
// Поставщики (inventory-suppliers.js), Дашборд + Журнал (this file).
// Заявки / Заказы / Отделения / Сроки годности / Инвентаризация are visible
// «Во 2-й фазе» placeholders (spec 2026-08-05-procurement-redesign-design.md).
//
// on_hand / avg_cost change ONLY through RPCs (receive_stock_lines,
// adjust_stock, issue_stock_lines, dispense_item/void_dispense) — the
// allow-list in server/db/schema-registry.js enforces this.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import {
    fetchGuard, loadingCard, comingSoon, fmtPrice, fmtQty, fmtSignedQty,
    movementTag, fetchMovements, isLowStock,
} from './inventory-shared.js';
import { renderProductsTab } from './inventory-products.js';
import { renderSkladTab } from './inventory-sklad.js';
import { renderSuppliersTab } from './inventory-suppliers.js';
// PROCUREMENT_DOCS_V1 — живые вкладки Заявки / Заказы + Инвентаризация (Phase 2)
import { renderRequisitionsTab, renderPurchaseOrdersTab, renderStockCountsTab } from './inventory-docs.js';

const refs = { container: null, onNavigate: null, chipsEl: null, tabBarEl: null, contentEl: null };
const state = { pane: 'sklad' };

const TABS = [
    { id: 'sklad',           label: 'Склад',             icon: 'Layers' },
    { id: 'requisitions',    label: 'Заявки',            icon: 'Send' },
    { id: 'purchase_orders', label: 'Заказы на закупку', icon: 'Receipt' },
    { id: 'products',        label: 'Товары',            icon: 'Pill' },
    { id: 'suppliers',       label: 'Поставщики',        icon: 'Building' },
];
const CHIPS = [
    { id: 'dashboard',   label: 'Дашборд',        icon: 'Chart' },
    { id: 'departments', label: 'Отделения',      icon: 'Building' },
    { id: 'expiry',      label: 'Сроки годности', icon: 'Clock' },
    { id: 'stockcount',  label: 'Инвентаризация', icon: 'Grid' },
    { id: 'audit',       label: 'Журнал',         icon: 'Activity' },
];

export async function renderInventory(container, { onNavigate } = {}) {
    refs.container = container;
    refs.onNavigate = onNavigate;
    state.pane = 'sklad';   // всегда открываемся на Складе
    mount();
    await repaint();
}

function mount() {
    clear(refs.container);
    refs.chipsEl = h('div', { class: 'page-head-actions', style: { flexWrap: 'wrap' } });
    refs.tabBarEl = h('div', { class: 'proc-tabs' });
    refs.contentEl = h('div', { class: 'proc-tab-content' });
    paintChips();
    paintTabBar();

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Закупки'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                    'Остатки, поставщики и заказы на закупку — по всем филиалам клиники.'),
            ),
            refs.chipsEl,
        ),
        refs.tabBarEl,
        refs.contentEl,
    ));
}

function setPane(id) {
    if (state.pane !== id) {
        state.pane = id;
        paintChips();
        paintTabBar();
    }
    repaint();
}

function paintChips() {
    clear(refs.chipsEl);
    for (const c of CHIPS) {
        const active = state.pane === c.id;
        refs.chipsEl.appendChild(h('button', {
            class: 'btn btn-sm ' + (active ? 'btn-primary' : 'btn-outline'),
            type: 'button',
            onclick: () => setPane(c.id),
        }, Icon(c.icon, { size: 14 }), ' ' + c.label));
    }
    refs.chipsEl.appendChild(h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', title: 'Обновить данные',
        onclick: () => repaint(),
    }, Icon('Refresh', { size: 14 }), ' Обновить'));
}

function paintTabBar() {
    clear(refs.tabBarEl);
    for (const t of TABS) {
        const active = state.pane === t.id;
        refs.tabBarEl.appendChild(h('button', {
            class: 'proc-tab' + (active ? ' active' : ''),
            type: 'button',
            onclick: () => setPane(t.id),
        }, Icon(t.icon, { size: 14 }), t.label));
    }
}

async function repaint() {
    clear(refs.contentEl);
    const container = refs.contentEl;
    switch (state.pane) {
        case 'sklad':      return renderSkladTab(container);
        case 'products':   return renderProductsTab(container);
        case 'suppliers':  return renderSuppliersTab(container);
        case 'dashboard':  return renderDashboardTab(container);
        case 'audit':      return renderAuditTab(container);
        // PROCUREMENT_DOCS_V1 — Заявки / Заказы / Инвентаризация живые (Phase 2)
        case 'requisitions':    return renderRequisitionsTab(container);
        case 'purchase_orders': return renderPurchaseOrdersTab(container);
        case 'stockcount':      return renderStockCountsTab(container);
        case 'departments':
            return void container.appendChild(comingSoon('Отделения',
                'Товары и остатки по отделениям. Появится следующим шагом.', 'Building'));
        case 'expiry':
            return void container.appendChild(comingSoon('Сроки годности',
                'Партии и сроки годности (FEFO). Появится следующим шагом.', 'Clock'));
        default:
            return;
    }
}

// =============================================================================
// ДАШБОРД
// =============================================================================
const KPI_ACCENT = {
    primary: { fg: 'var(--primary-600)', bg: 'var(--primary-50)' },
    ok:      { fg: 'var(--ok-700)',      bg: 'var(--ok-50)' },
    warn:    { fg: 'var(--warn-700)',    bg: 'var(--warn-50)' },
    info:    { fg: 'var(--info-700)',    bg: 'var(--info-50)' },
};

function kpiTile({ icon, accent, label, value, meta, valueWarn, onClick }) {
    const a = KPI_ACCENT[accent] || KPI_ACCENT.primary;
    return h('div', { class: 'dash-kpi', onclick: onClick || undefined },
        h('div', { class: 'dash-kpi-top' },
            h('div', { class: 'dash-kpi-icon', style: { color: a.fg, background: a.bg } }, Icon(icon, { size: 18 })),
            onClick ? h('span', { class: 'dash-kpi-go' }, '→') : null,
        ),
        h('div', { class: 'dash-kpi-label' }, label),
        h('div', {
            class: 'dash-kpi-value num',
            style: valueWarn ? { color: 'var(--warn-700)' } : null,
        }, value),
        meta ? h('div', { class: 'dash-kpi-meta' }, meta) : null,
    );
}

async function renderDashboardTab(container) {
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    let products = null;
    let productsError = null;
    try {
        const res = await supabase.from('products')
            .select('id,name,on_hand,avg_cost,sale_price,reorder_level,base_unit,procurement_category,active')
            .limit(1000);
        products = res.data;
        productsError = res.error;
    } catch (e) {
        productsError = e;
    }
    if (token !== fetchGuard.token) return;

    const { data: recent } = await fetchMovements({ kind: 'receive', limit: 8 });
    if (token !== fetchGuard.token) return;

    clear(container);

    if (productsError) {
        toast('Не удалось загрузить дашборд: ' + (productsError.message || productsError), 'fail');
        container.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить данные.'));
        return;
    }

    const all = products || [];
    const active = all.filter(p => p.active);
    const productsById = new Map(all.map(p => [p.id, p]));

    const stockValue = active.reduce((s, p) => s + (Number(p.on_hand) || 0) * (Number(p.avg_cost) || 0), 0);
    const lowStock = active.filter(isLowStock);
    const categories = new Set(active.map(p => p.procurement_category).filter(Boolean));

    const grid = h('div', { class: 'dash-kpi-row' },
        kpiTile({ icon: 'Pill', accent: 'primary', label: 'Товары', value: String(active.length) }),
        kpiTile({ icon: 'Coins', accent: 'ok', label: 'Стоимость склада', value: fmtPrice(stockValue) }),
        kpiTile({
            icon: 'Warning', accent: lowStock.length > 0 ? 'warn' : 'ok', label: 'Мало на складе',
            value: String(lowStock.length), valueWarn: lowStock.length > 0,
            onClick: () => setPane('sklad'),
        }),
        kpiTile({ icon: 'Layers', accent: 'info', label: 'Категории', value: String(categories.size) }),
    );

    const detailGrid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '16px', marginTop: '16px' } },
        lowStockCard(lowStock),
        recentReceiptsCard(recent || [], productsById),
    );

    container.appendChild(h('div', null, grid, detailGrid));
}

function lowStockCard(list) {
    if (!list.length) {
        return h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Pill', { size: 15 }), ' Мало на складе')),
            h('div', { class: 'empty', style: { padding: '28px 20px' } }, 'Все остатки выше минимума.'),
        );
    }
    const shown = list.slice(0, 10);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Warning', { size: 15 }), ' Мало на складе ', h('span', { class: 'h-count' }, String(list.length))),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
            ...shown.map(p => h('div', {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--ink-100)' },
            },
                h('div', { style: { fontWeight: 600, fontSize: '13px', color: 'var(--ink-900)' } }, p.name || '—'),
                h('div', { class: 'muted num', style: { fontSize: '12px' } },
                    `${fmtQty(Number(p.on_hand) || 0)} / ${fmtQty(Number(p.reorder_level) || 0)} ${p.base_unit || ''}`.trim()),
            )),
        ),
    );
}

function recentReceiptsCard(rows, productsById) {
    if (!rows.length) {
        return h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Download', { size: 15 }), ' Последние приходы')),
            h('div', { class: 'empty', style: { padding: '28px 20px' } }, 'Приходов пока нет.'),
        );
    }
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Download', { size: 15 }), ' Последние приходы')),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Товар'), h('th', null, 'Кол-во'), h('th', null, 'Цена за ед.'),
            )),
            h('tbody', null, ...rows.map(m => {
                const fallback = productsById.get(m.product_id);
                const name = (m.products && m.products.name) || (fallback && fallback.name) || `Товар #${m.product_id}`;
                const unit = (fallback && fallback.base_unit) || (m.products && (m.products.base_unit || m.products.unit)) || '';
                return h('tr', null,
                    h('td', null, fmtDateTime(m.created_at)),
                    h('td', null, name),
                    h('td', { class: 'num' }, `${fmtQty(Number(m.qty) || 0)} ${unit}`.trim()),
                    h('td', { class: 'num' }, m.unit_cost != null ? fmtPrice(m.unit_cost) : '—'),
                );
            })),
        ),
    );
}

// =============================================================================
// ЖУРНАЛ ДВИЖЕНИЙ
// =============================================================================
const audit = { kind: 'all', q: '' };

async function renderAuditTab(container) {
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    const { data, error } = await fetchMovements({ limit: 300 });
    if (token !== fetchGuard.token) return;

    clear(container);

    if (error) {
        toast('Не удалось загрузить журнал: ' + (error.message || error), 'fail');
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Не удалось загрузить движения.')));
        return;
    }

    const rows = data || [];
    const tbody = h('tbody');

    const selStyleSmall = { height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit' };
    const kindSel = h('select', { style: selStyleSmall },
        ...[['all', 'Все типы'], ['receive', 'Приход'], ['issue', 'Выдача'], ['dispense', 'Списание'], ['adjust', 'Корректировка'], ['void', 'Отмена']]
            .map(([v, label]) => h('option', { value: v, selected: v === audit.kind }, label)));
    kindSel.addEventListener('change', () => { audit.kind = kindSel.value; paint(); });

    const qInp = h('input', { type: 'text', placeholder: 'Поиск товара…', value: audit.q,
        style: { height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', width: '220px' } });
    qInp.addEventListener('input', () => { audit.q = qInp.value; paint(); });

    function paint() {
        clear(tbody);
        const q = audit.q.trim().toLowerCase();
        const shown = rows.filter(m => {
            const isIssue = m.kind === 'dispense' && m.reference_type === 'issue';
            if (audit.kind === 'issue' && !isIssue) return false;
            if (audit.kind === 'dispense' && (m.kind !== 'dispense' || isIssue)) return false;
            if (audit.kind !== 'all' && audit.kind !== 'issue' && audit.kind !== 'dispense' && m.kind !== audit.kind) return false;
            if (q) {
                const name = (m.products && m.products.name) || '';
                if (!name.toLowerCase().includes(q)) return false;
            }
            return true;
        });
        if (!shown.length) {
            tbody.appendChild(h('tr', null,
                h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Нет подходящих движений.')));
            return;
        }
        for (const m of shown) tbody.appendChild(auditRow(m));
    }

    container.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Activity', { size: 15 }), ' Журнал движений'),
            h('span', { class: 'grow' }),
            qInp,
            kindSel,
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Когда'),
                    h('th', null, 'Товар'),
                    h('th', null, 'Тип'),
                    h('th', null, 'Кол-во'),
                    h('th', null, 'Цена за ед.'),
                    h('th', null, 'Основание'),
                    h('th', null, 'Кто'),
                )),
                tbody,
            ),
        ),
    ));
    paint();
}

function auditRow(m) {
    const name = (m.products && m.products.name) || '—';
    const unit = (m.products && (m.products.base_unit || m.products.unit)) || '';
    const who = (m.users && (m.users.full_name || m.users.username)) || '—';
    return h('tr', null,
        h('td', null, fmtDateTime(m.created_at)),
        h('td', null, name),
        h('td', null, movementTag(m)),
        h('td', { class: 'num' }, fmtSignedQty(m.qty, unit)),
        h('td', { class: 'num' }, m.unit_cost != null ? fmtPrice(m.unit_cost) : '—'),
        h('td', { class: 'muted' }, m.note || ''),
        h('td', null, who),
    );
}
