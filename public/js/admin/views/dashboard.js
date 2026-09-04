// Dashboard — DASHBOARD_HOME_V1 — read-only landing page.
// Renders today's-activity stat tiles from the dashboard_summary RPC
// (server/services/rpc/dashboard.js). Mirrors public/js/admin/views/inventory.js
// and services.js for structure (mount / fetchAndPaint via h()/Icon/clear/toast
// from ../ui.js). No client-side aggregation — every number comes straight
// from the RPC.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';

const refs = {
    container:  null,
    onNavigate: null,
    grid:       null,
};

export async function renderDashboard(container, { onNavigate } = {}) {
    refs.container  = container;
    refs.onNavigate = onNavigate;
    mount();
    await fetchAndPaint();
}

// -----------------------------------------------------------------------------
// MOUNT — static shell; fetchAndPaint() repaints just the tile grid.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);

    refs.grid = h('div', { class: 'dash-kpi-row' });

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Dashboard'),
                h('p', { class: 'page-subtitle' }, todaySubtitle()),
            ),
        ),
        refs.grid,
    ));
}

function todaySubtitle() {
    try {
        return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    } catch (_) {
        return new Date().toDateString();
    }
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

async function fetchAndPaint() {
    const token = ++lastFetchToken;
    setLoading();
    try {
        const { data, error } = await supabase.rpc('dashboard_summary', {});
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        if (error) {
            toast('Failed to load dashboard: ' + (error.message || error), 'fail');
            paintError();
            return;
        }
        paintTiles(data || {});
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load dashboard: ' + (e && e.message || e), 'fail');
        paintError();
    }
}

function setLoading() {
    if (!refs.grid) return;
    clear(refs.grid);
    refs.grid.appendChild(h('div', { class: 'card', style: { gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…'));
}

function paintError() {
    if (!refs.grid) return;
    clear(refs.grid);
    refs.grid.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'Could not load dashboard data.'));
}

// Thousands-separated price display, no currency symbol (e.g. 50000 -> "50 000").
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Accent tint per KPI category — fg on the icon glyph, bg behind it (reuses
// the same -700/-50 token pairing as .dash-alert-* / .tag-*).
const KPI_ACCENT = {
    primary: { fg: 'var(--primary-600)', bg: 'var(--primary-50)' },
    ok:      { fg: 'var(--ok-700)',      bg: 'var(--ok-50)' },
    warn:    { fg: 'var(--warn-700)',    bg: 'var(--warn-50)' },
    crit:    { fg: 'var(--crit-700)',    bg: 'var(--crit-50)' },
    info:    { fg: 'var(--info-700)',    bg: 'var(--info-50)' },
};

// BUILDING_REPORTS_V1 — вторая строка плитки: из чего сложено число.
//
// Клиника из нескольких ЗДАНИЙ (отдельных установок, соединённых branch-sync'ом)
// видела на плитках ОДНО число на два дома и читала его как число своего дома.
// Разрез приходит вместе со сводкой (dashboard_summary.buildings) и печатается
// под значением; клиника в одном здании его не видит вовсе — строка «Main
// Branch: 100%» не сообщает ничего.
function splitLine(d, key, fmt) {
    const list = (d && d.buildings) || [];
    if (list.length < 2) return null;
    return list.map(b => b.label + ': ' + fmt(b[key])).join(' · ');
}

function paintTiles(d) {
    if (!refs.grid) return;
    clear(refs.grid);

    const lowStock = Number(d.low_stock_count) || 0;
    const n = (v) => String(Number(v) || 0);

    refs.grid.appendChild(kpi({
        icon: 'Patients', accent: 'primary',
        label: 'Patients today',
        value: String(Number(d.patients_today) || 0),
        split: splitLine(d, 'patients_today', n),
    }));
    refs.grid.appendChild(kpi({
        icon: 'Calendar', accent: 'info',
        label: 'Visits today',
        value: String(Number(d.visits_today) || 0),
        split: splitLine(d, 'visits_today', n),
    }));
    refs.grid.appendChild(kpi({
        icon: 'Coins', accent: 'ok',
        label: 'Collected today',
        value: fmtPrice(d.collected_today),
        split: splitLine(d, 'collected_today', fmtPrice),
    }));
    refs.grid.appendChild(kpi({
        icon: 'Receipt', accent: 'crit',
        label: 'Outstanding',
        value: fmtPrice(d.outstanding_amount),
        meta: `(${Number(d.outstanding_count) || 0} invoices)`,
        split: splitLine(d, 'outstanding_amount', fmtPrice),
    }));
    refs.grid.appendChild(kpi({
        icon: 'Pill', accent: 'warn',
        label: 'Low stock',
        value: String(lowStock),
        valueWarn: lowStock > 0,
        onClick: () => refs.onNavigate && refs.onNavigate('inventory'),
    }));
    refs.grid.appendChild(kpi({
        icon: 'Flask', accent: 'info',
        label: 'Pending lab results',
        value: String(Number(d.lab_pending_count) || 0),
        // Граница здесь — ТА ЖЕ, что у лабораторной очереди под ссылкой
        // (doc_settings.lab_scope); при «вся клиника» разрез показывает, чьи
        // это пробирки.
        split: splitLine(d, 'lab_pending_count', n),
        onClick: () => refs.onNavigate && refs.onNavigate('labs'),
    }));
}

function kpi({ icon, accent, label, value, meta, split, valueWarn, onClick }) {
    const a = KPI_ACCENT[accent] || KPI_ACCENT.primary;
    return h('div', {
        class: 'dash-kpi',
        onclick: onClick || undefined,
    },
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
        split ? h('div', { class: 'dash-kpi-meta', title: split }, split) : null,
    );
}
