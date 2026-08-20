// Reports — Owner overview dashboard (real-data port of Documents/src/view-reports.jsx).
//
// Layout (top to bottom):
//   1. Page head — "Owner overview" + Print / Export / Refresh
//   2. Branch + period selector strip + live chip
//   3. Hospital weather banner — derived operational-health score
//   4. Today's pulse — 6 live "right now" metrics
//   5. Hero KPIs — Cash In · Revenue · Patients · Bed occupancy (with spark + delta)
//   6. Needs your attention — computed operational alerts
//   7. Money — Cash In vs Revenue reconciliation + Revenue by area
//   8. Patients — daily volume + top services by revenue
//   9. Branch comparison — per-branch Cash In / Revenue / Patients (only on "All")
//  10. Capacity — bed occupancy by ward + top doctors by work done
//  11. Quality — placeholder until patient feedback is tracked
//  12. Decision summary — what's working / what to do next
//
// Two financial metrics, by the owner's definition:
//   • Cash In  = all money received      = SUM(payments.amount)
//   • Revenue  = value of work done&closed = SUM(visit_services.total WHERE completed)
//                                          + SUM(admission_services.total WHERE completed)
// They differ: Cash In is cash-basis (when money lands), Revenue is accrual-basis
// (when a doctor / lab tech / diagnostics laborant actually finishes the service).
//
// NOTE on period attribution: visit_services has no dedicated completed_at column,
// so completed work is bucketed by created_at (admission_services by performed_at).
// Swap to a real completion timestamp here if one is added to the schema.

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, Spark, Bars, Delta, PageHead, Avatar, clear, toast, initials, avColor } from '../ui.js';
import { getAvailableBranches } from '../branch-context.js';
import { renderDownloadsPanel } from './reports-export.js?v=vendorxlsx1';

const state = {
    period:   'month',     // 'today' | 'week' | 'month' | 'quarter' | 'year'
    branchId: 'all',
    branches: [],          // [{ id, name }] loaded once from the branches table
    rows:     null,        // computed metrics blob (null while loading)
};
let containerRef  = null;
let onNavigateRef = null;
// Persistent slots so changing branch/period only swaps the affected parts
// (selector active-state + data panels) instead of clearing and fading the
// whole page in — which blinked on every click.
let selectorEl = null;
let contentEl  = null;

const PERIODS = [
    { id: 'today',   label: 'Today',        icon: 'Clock'    },
    { id: 'week',    label: 'This week',    icon: 'Calendar' },
    { id: 'month',   label: 'This month',   icon: 'Calendar' },
    { id: 'quarter', label: 'This quarter', icon: 'Chart'    },
    { id: 'year',    label: 'This year',    icon: 'Chart'    },
];

// services.type → revenue "area". The owner thinks in terms of who did the work:
// doctors (consultations + procedures), laboratory, diagnostics (imaging).
const AREA_OF_TYPE = {
    consultation: 'doctors',
    procedure:    'doctors',
    lab:          'lab',
    imaging:      'diagnostics',
    pharmacy:     'other',
    other:        'other',
};
const AREA_META = {
    doctors:     { label: 'Doctors',     color: 'var(--primary-600)',           icon: 'Stethoscope' },
    lab:         { label: 'Laboratory',  color: 'var(--info-600, #2563eb)',     icon: 'Flask'       },
    diagnostics: { label: 'Diagnostics', color: 'var(--purple-500, #a855f7)',   icon: 'Activity'    },
    inpatient:   { label: 'Inpatient',   color: 'var(--ok-600, #16a34a)',       icon: 'Bed'         },
    other:       { label: 'Other',       color: 'var(--ink-400)',               icon: 'Layers'      },
};
const AREA_ORDER = ['doctors', 'lab', 'diagnostics', 'inpatient', 'other'];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function renderReports(container, { onNavigate } = {}) {
    containerRef  = container;
    onNavigateRef = onNavigate || null;
    clear(container);
    // REPORTS_DOWNLOADS_ONLY_V1 — the analytics dashboard (weather banner,
    // KPIs, money/patients/capacity panels) is retired per owner request.
    // Reports is now the export hub: pick dates + branches, download .xlsx.
    // No metrics load = instant page. The old panel functions remain below,
    // unused, in case the dashboard comes back.
    mount();
}

function mount() {
    clear(containerRef);
    contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    renderContent();

    containerRef.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Reports',
            subtitle: 'Выберите отчёт — настройка периода, филиалов и предпросмотр откроются на весь экран.',
        }),
        contentEl,
    ));
}

// Re-render just the selector strip (cheap, no animation) so the clicked
// branch/period reflects its active state immediately.
function renderSelector() {
    if (!selectorEl) return;
    clear(selectorEl);
    selectorEl.appendChild(selectorStrip());
}

// Swap the data panels in place — no fade-in wrapper, no whole-page clear, so
// the values update smoothly without a blink.
function renderContent() {
    if (!contentEl) return;
    clear(contentEl);
    // Downloads panel — .xlsx exports with their own date-range + branch
    // filters. getBranches uses branch-context so restricted staff only see
    // their assigned branches.
    contentEl.appendChild(renderDownloadsPanel({
        getPeriod:   () => state.period,
        getBranchId: () => state.branchId,
        getClinicId: () => window.CLINIC?.id || null,
        getBranches: () => getAvailableBranches(),
    }));
}

// Fetch metrics for the current branch/period, then refresh only the content
// (the old panels stay visible during the fetch — no blank flash).
async function reloadContent() {
    state.rows = await loadMetrics(state.period, state.branchId);
    renderContent();
}

// ---------------------------------------------------------------------------
// Branch + period selector
// ---------------------------------------------------------------------------
function selectorStrip() {
    const branchBtn = (id, label, icon) => h('button', {
        onclick: async () => { if (state.branchId === id) return; state.branchId = id; renderSelector(); await reloadContent(); },
        style: {
            padding: '8px 14px', border: 0, borderRadius: '8px',
            background: state.branchId === id ? 'white' : 'transparent',
            color: state.branchId === id ? 'var(--primary-700)' : 'var(--ink-600)',
            fontSize: '12.5px', fontWeight: state.branchId === id ? 700 : 500,
            cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: state.branchId === id ? 'var(--shadow-sm, 0 1px 2px rgba(11,20,24,0.08))' : 'none',
            display: 'flex', alignItems: 'center', gap: '7px',
        },
    }, Icon(icon, { size: 13 }), label);

    return h('div', { class: 'card', style: { padding: '12px 14px' } },
        h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { style: { color: 'var(--primary-600)', display: 'flex' } }, Icon('Building', { size: 15 })),
                h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--ink-700)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'View'),
            ),
            h('div', { style: { display: 'flex', gap: '6px', padding: '4px', background: 'var(--ink-50)', borderRadius: '11px', border: '1px solid var(--ink-100)', flexWrap: 'wrap' } },
                branchBtn('all', 'All branches', 'Dashboard'),
                ...state.branches.map(b => branchBtn(b.id, b.name, 'MapPin')),
            ),
            h('span', { style: { width: '1px', height: '22px', background: 'var(--ink-200)' } }),
            h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--ink-700)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Period'),
            h('div', { class: 'segmented' },
                ...PERIODS.map(p => h('button', {
                    class: state.period === p.id ? 'on' : '',
                    onclick: async () => { if (state.period === p.id) return; state.period = p.id; renderSelector(); await reloadContent(); },
                }, p.label)),
            ),
            h('span', { class: 'grow' }),
            liveChip(),
        ),
    );
}

function liveChip() {
    return h('span', {
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '4px 10px', borderRadius: '999px',
            background: 'var(--ok-50)', color: 'var(--ok-700)',
            fontSize: '11.5px', fontWeight: 600,
        },
    },
        h('span', { style: { width: '7px', height: '7px', borderRadius: '999px', background: 'var(--ok-500)' } }),
        'Live · ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    );
}

// ---------------------------------------------------------------------------
// Hospital weather banner
// ---------------------------------------------------------------------------
function hospitalWeather(m) {
    const occ = Math.min(m.occupancy_pct || 0, 100);
    const unpaidRatio = m.total_invoices > 0 ? m.open_invoices_count / m.total_invoices : 0;
    // Collection ratio — how much of the work we've actually been paid for.
    const collection = m.revenue_total > 0 ? Math.min(m.cash_in_total / m.revenue_total, 1.2) : 1;
    const score = Math.round(Math.max(0, Math.min(100,
        45 +
        (occ * 0.25) +
        ((m.revenue_delta_pct || 0) * 0.35) +
        ((1 - unpaidRatio) * 15) +
        ((collection - 0.5) * 30)
    )));

    const c = scoreColor(score);
    const label = score >= 85 ? 'Excellent' : score >= 70 ? 'Stable' : score >= 55 ? 'Watch' : 'Critical';

    const metric = (lbl, value, opts = {}) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '110px' } },
        h('div', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-500)', fontWeight: 700 } }, lbl),
        h('div', { class: 'num', style: { fontSize: '17px', fontWeight: 700, color: opts.ink || 'var(--ink-900)', letterSpacing: '-0.01em' } }, value),
    );

    return h('div', { class: 'card', style: { padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '14px', minWidth: '260px' } },
            h('div', null,
                h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', color: 'var(--ink-500)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 } },
                    h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: c.rgb, display: 'inline-block' } }),
                    'Operational health',
                ),
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '6px' } },
                    h('span', { class: 'num', style: { fontSize: '36px', fontWeight: 700, color: c.rgb, lineHeight: '1', letterSpacing: '-0.02em' } }, String(score)),
                    h('span', { class: 'muted num', style: { fontSize: '15px', fontWeight: 500 } }, '/ 100'),
                ),
                h('div', { style: { position: 'relative', marginTop: '12px', width: '220px', height: '6px', borderRadius: '999px', background: 'linear-gradient(90deg, #dc2626 0%, #f59e0b 50%, #10b981 100%)' } },
                    h('div', { style: { position: 'absolute', left: `calc(${score}% - 7px)`, top: '-4px', width: '14px', height: '14px', borderRadius: '999px', background: 'white', border: `3px solid ${c.rgb}`, boxShadow: '0 1px 3px rgba(0,0,0,0.18)' } }),
                ),
                h('div', { style: { marginTop: '6px' } },
                    h('span', { style: { display: 'inline-block', padding: '2px 10px', borderRadius: '999px', background: c.rgbA(0.12), color: c.rgb, fontSize: '11px', fontWeight: 600 } }, label),
                ),
            ),
        ),
        h('div', { style: { display: 'flex', gap: '28px', flex: 1, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            metric('Cash In',   formatMoney(m.cash_in_total),  { ink: 'var(--ok-700)' }),
            metric('Revenue',   formatMoney(m.revenue_total),  { ink: 'var(--primary-700)' }),
            metric('Collected', (m.revenue_total > 0 ? Math.round(m.cash_in_total / m.revenue_total * 100) : 100) + '%'),
            metric('Patients',  String(m.patients_period || 0)),
        ),
    );
}

// ---------------------------------------------------------------------------
// Today's pulse
// ---------------------------------------------------------------------------
function pulseStrip(m) {
    const cells = [
        { label: 'Patients today', value: String(m.patients_today ?? 0),    icon: 'Patients', color: 'var(--info-700)' },
        { label: 'In progress',    value: String(m.in_progress_count ?? 0), icon: 'Activity', color: 'var(--warn-700)' },
        { label: 'Inpatients',     value: String(m.inpatients_count ?? 0),  icon: 'Bed',      color: 'var(--purple-500, #a855f7)' },
        { label: 'Cash today',     value: formatMoney(m.cash_today),        icon: 'Wallet',   color: 'var(--ok-700)' },
        { label: 'Open invoices',  value: String(m.open_invoices_count ?? 0), icon: 'Warning', color: 'var(--crit-700)' },
        { label: 'Critical labs',  value: String(m.critical_today ?? 0),    icon: 'Flask',    color: 'var(--crit-700)' },
    ];
    return h('div', { class: 'card', style: { padding: '14px 16px' } },
        h('div', { style: { fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-600)', fontWeight: 700, marginBottom: '10px' } }, "Right now"),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '14px' } },
            ...cells.map(c => h('div', null,
                h('div', { class: 'row', style: { gap: '6px', color: c.color, fontSize: '11.5px', fontWeight: 600 } }, Icon(c.icon, { size: 13 }), c.label),
                h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 700, color: 'var(--ink-900)', marginTop: '4px', letterSpacing: '-0.01em' } }, c.value),
            )),
        ),
    );
}

// ---------------------------------------------------------------------------
// Hero KPIs — Cash In · Revenue · Patients · Occupancy
// ---------------------------------------------------------------------------
function heroKpis(m) {
    const periodLabel = (PERIODS.find(p => p.id === state.period)?.label || 'period').toLowerCase();
    const cards = [
        { label: 'Cash In',       value: formatMoney(m.cash_in_total),  delta: m.cash_in_delta_pct, spark: m.cash_in_spark, color: 'var(--ok-600, #16a34a)', sub: 'money received · ' + periodLabel },
        { label: 'Revenue',       value: formatMoney(m.revenue_total),  delta: m.revenue_delta_pct, spark: m.revenue_spark, color: 'var(--primary-600)', sub: 'services done & closed · ' + periodLabel },
        { label: 'Patients seen', value: String(m.patients_period || 0), delta: m.patients_delta_pct, spark: m.patients_spark, color: 'var(--info-600)', sub: periodLabel },
        { label: 'Bed occupancy', value: (m.occupancy_pct ?? '—') + (m.occupancy_pct != null ? '%' : ''), delta: null, spark: null, color: 'var(--purple-500, #a855f7)', sub: `${m.beds_occupied || 0} / ${m.beds_total || 0} beds` },
    ];
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
        ...cards.map(c => h('div', { class: 'card', style: { padding: '16px 18px' } },
            h('div', { style: { fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-600)', fontWeight: 700 } }, c.label),
            h('div', { class: 'num', style: { fontSize: '26px', fontWeight: 700, color: 'var(--ink-900)', marginTop: '6px', letterSpacing: '-0.02em' } }, c.value),
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' } },
                h('div', { class: 'muted', style: { fontSize: '11.5px' } }, c.sub),
                c.delta != null ? Delta(c.delta) : h('span'),
            ),
            (c.spark && c.spark.length > 1)
                ? h('div', { style: { marginTop: '8px' } }, Spark(c.spark, { color: c.color, w: 220, h: 38, fill: true }))
                : h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '8px', height: '38px', display: 'flex', alignItems: 'center' } }, ''),
        )),
    );
}

// ---------------------------------------------------------------------------
// Needs your attention
// ---------------------------------------------------------------------------
function needsAttention(m) {
    const alerts = [];
    if (m.critical_today > 0)
        alerts.push({ sev: 'crit', icon: 'Flask',  label: `${m.critical_today} critical lab result${m.critical_today === 1 ? '' : 's'} today`, hint: 'Verify and notify the ordering doctor.', go: () => onNavigateRef?.('labs') });
    if (m.open_invoices_total > 0)
        alerts.push({ sev: 'warn', icon: 'Wallet', label: `${formatMoney(m.open_invoices_total)} not yet collected`, hint: `${m.open_invoices_count} invoice${m.open_invoices_count === 1 ? '' : 's'} unpaid or partial.`, go: () => onNavigateRef?.('cashier') });
    const gap = (m.revenue_total || 0) - (m.cash_in_total || 0);
    if (gap > 0 && m.revenue_total > 0 && gap / m.revenue_total > 0.15)
        alerts.push({ sev: 'warn', icon: 'Coins', label: `${formatMoney(gap)} earned but not yet collected`, hint: 'Revenue is running ahead of Cash In — chase outstanding payments.', go: () => onNavigateRef?.('cashier') });
    if (m.unverified_results > 0)
        alerts.push({ sev: 'info', icon: 'Doc',    label: `${m.unverified_results} lab result${m.unverified_results === 1 ? '' : 's'} awaiting verification`, hint: 'In the lab queue at stage "Resulted".', go: () => onNavigateRef?.('labs') });
    if (m.queued_services > 0)
        alerts.push({ sev: 'info', icon: 'Activity', label: `${m.queued_services} service${m.queued_services === 1 ? '' : 's'} queued for providers`, hint: 'Paid orders waiting to be started.', go: () => onNavigateRef?.('consultation') });

    if (alerts.length === 0) {
        return h('div', { class: 'card', style: { padding: '16px 18px' } },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                h('span', { style: { fontSize: '22px' } }, '✅'),
                h('div', null,
                    h('div', { style: { fontWeight: 700, fontSize: '14px', color: 'var(--ink-900)' } }, 'All clear'),
                    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, 'No outstanding alerts right now.'),
                ),
            ),
        );
    }

    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Warning', { size: 15 }), ' Needs your attention ', h('span', { class: 'h-count' }, String(alerts.length))),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
            ...alerts.map(a => h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderTop: '1px solid var(--ink-100)', background: a.sev === 'crit' ? 'var(--crit-50)' : a.sev === 'warn' ? 'var(--warn-50)' : 'white' } },
                h('div', { style: { width: '34px', height: '34px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'white', color: a.sev === 'crit' ? 'var(--crit-700)' : a.sev === 'warn' ? 'var(--warn-700)' : 'var(--info-700)', border: '1px solid ' + (a.sev === 'crit' ? 'var(--crit-200, #fecaca)' : a.sev === 'warn' ? 'var(--warn-200, #fde68a)' : 'var(--info-200, #c7dcfd)') } }, Icon(a.icon, { size: 16 })),
                h('div', { style: { flex: 1 } },
                    h('div', { style: { fontWeight: 600, fontSize: '13px', color: 'var(--ink-900)' } }, a.label),
                    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, a.hint),
                ),
                a.go && h('button', { class: 'btn btn-outline btn-sm', onclick: a.go }, 'Open ', Icon('ChevronRight', { size: 12 })),
            )),
        ),
    );
}

// ---------------------------------------------------------------------------
// Money — Cash In vs Revenue + Revenue by area
// ---------------------------------------------------------------------------
function moneyPanel(m) {
    const cash = m.cash_in_total || 0;
    const rev  = m.revenue_total || 0;
    const gap  = rev - cash;                       // + = uncollected, − = collected ahead
    const collectionPct = rev > 0 ? Math.round((cash / rev) * 100) : 100;
    const maxBar = Math.max(cash, rev, 1);

    const areas = AREA_ORDER
        .map(k => ({ key: k, ...AREA_META[k], val: m.revenue_by_area?.[k] || 0 }))
        .filter(a => a.val > 0);
    const areaTotal = areas.reduce((s, a) => s + a.val, 0) || 1;

    return h('div', null,
        sectionHeader('Wallet', 'Money — Cash In vs Revenue', 'Money received against the value of work done & closed'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: '16px' } },

            // Cash In vs Revenue reconciliation
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Coins', { size: 16 }), ' Cash In vs Revenue'),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, collectionPct + '% collected'),
                ),
                h('div', { style: { padding: '18px 22px 22px' } },
                    moneyBar('Revenue', rev, maxBar, 'var(--primary-500)', 'value of services done & closed'),
                    h('div', { style: { height: '14px' } }),
                    moneyBar('Cash In', cash, maxBar, 'var(--ok-500)', 'money actually received'),

                    h('div', { style: { marginTop: '18px', padding: '12px 14px', background: gap > 0 ? 'var(--warn-50)' : 'var(--ok-50)', border: '1px solid ' + (gap > 0 ? '#fde9b6' : '#c6efd9'), borderRadius: '9px' } },
                        h('div', { class: 'row', style: { gap: '8px', color: gap > 0 ? 'var(--warn-700)' : 'var(--ok-700)' } },
                            h('span', { style: { display: 'flex' } }, Icon(gap > 0 ? 'Warning' : 'Check', { size: 14 })),
                            h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: gap > 0 ? 'var(--warn-700)' : 'var(--ok-700)' } },
                                gap > 0 ? `${formatMoney(gap)} earned but not yet collected`
                                        : gap < 0 ? `${formatMoney(-gap)} collected ahead of work done`
                                        : 'Cash In matches Revenue exactly'),
                            h('span', { class: 'grow' }),
                            h('span', { style: { fontSize: '11.5px', color: 'var(--ink-600)' } },
                                gap > 0 ? 'Chase outstanding invoices' : 'Healthy collection'),
                        ),
                    ),
                ),
            ),

            // Revenue by area
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Layers', { size: 16 }), ' Revenue by area'),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, formatMoney(rev)),
                ),
                h('div', { style: { padding: '18px 22px' } },
                    areas.length === 0
                        ? h('div', { class: 'empty', style: { padding: '24px 8px' } }, 'No completed services in this period.')
                        : h('div', null,
                            h('div', { style: { display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', marginBottom: '16px' } },
                                ...areas.map(a => h('div', { style: { width: (a.val / areaTotal * 100) + '%', background: a.color }, title: a.label })),
                            ),
                            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                                ...areas.map(a => h('div', { class: 'row', style: { fontSize: '12.5px', gap: '8px' } },
                                    h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: a.color, flex: '0 0 10px' } }),
                                    h('span', { style: { color: 'var(--ink-700)', flex: 1 } }, a.label),
                                    h('span', { class: 'num cell-strong' }, formatMoney(a.val)),
                                    h('span', { class: 'muted num', style: { fontSize: '11px', minWidth: '34px', textAlign: 'right' } }, Math.round(a.val / areaTotal * 100) + '%'),
                                )),
                            ),
                        ),
                ),
            ),
        ),
    );
}

function moneyBar(label, value, max, color, sub) {
    return h('div', null,
        h('div', { class: 'row', style: { marginBottom: '6px', fontSize: '13px' } },
            h('span', { style: { fontWeight: 600, color: 'var(--ink-900)' } }, label),
            h('span', { class: 'grow' }),
            h('span', { class: 'num cell-strong', style: { color } }, formatMoney(value)),
        ),
        h('div', { style: { height: '12px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
            h('div', { style: { width: (value / max * 100).toFixed(1) + '%', height: '100%', background: color, borderRadius: '999px' } }),
        ),
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, sub),
    );
}

// ---------------------------------------------------------------------------
// Patients — daily volume + top services by revenue
// ---------------------------------------------------------------------------
function patientsPanel(m) {
    const rows = m.top_services || [];
    const maxRev = rows.reduce((mx, r) => Math.max(mx, r.revenue || 0), 0) || 1;
    const spark = m.patients_spark || [];

    return h('div', null,
        sectionHeader('Patients', 'Patients — who came through the door', 'Daily volume and what they were here for'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '16px' } },

            // Daily volume (last 14 days)
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Patients', { size: 16 }), ' Patients · last 14 days'),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, (spark.reduce((s, v) => s + v, 0)) + ' total'),
                ),
                h('div', { style: { padding: '20px 22px' } },
                    spark.length === 0
                        ? h('div', { class: 'empty', style: { padding: '24px 8px' } }, 'No visits recorded.')
                        : responsiveSvg(Bars(spark, { w: 460, h: 150, color: 'var(--primary-500)', gap: 6 }), 150),
                ),
            ),

            // Top services by revenue
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Chart', { size: 16 }), ' Top services by revenue ', h('span', { class: 'h-count' }, String(rows.length))),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'Completed work · ' + periodSubtitle()),
                ),
                rows.length === 0
                    ? h('div', { class: 'empty', style: { padding: '28px 20px' } }, 'No completed services in this period.')
                    : h('div', { style: { padding: '8px 0 4px' } },
                        ...rows.map((r, i) => h('div', { style: { padding: '10px 22px', borderTop: i > 0 ? '1px solid var(--ink-100)' : 'none' } },
                            h('div', { class: 'row', style: { marginBottom: '6px', fontSize: '13px' } },
                                h('span', { style: { fontWeight: 600, color: 'var(--ink-900)' } }, r.name || '—'),
                                h('span', { class: 'grow' }),
                                h('span', { class: 'num cell-strong', style: { color: 'var(--primary-700)' } }, formatMoney(r.revenue)),
                                h('span', { class: 'muted num', style: { fontSize: '11.5px', marginLeft: '8px' } }, (r.count || 0) + '×'),
                            ),
                            h('div', { style: { height: '5px', background: 'var(--ink-100)', borderRadius: '999px' } },
                                h('div', { style: { width: (r.revenue / maxRev * 100) + '%', height: '100%', background: 'var(--primary-500)', borderRadius: '999px' } }),
                            ),
                        )),
                    ),
            ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Branch comparison (only on "All branches")
// ---------------------------------------------------------------------------
function branchComparison(m) {
    const rows = m.branch_rows || [];
    if (rows.length === 0) return h('div');
    const maxRev = Math.max(...rows.map(b => b.revenue), 1);

    return h('div', null,
        sectionHeader('Building', 'Branch comparison', 'Same metrics, side by side — which branch needs your time?'),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Branch'),
                    h('th', { class: 'num' }, 'Cash In'),
                    h('th', { class: 'num' }, 'Revenue'),
                    h('th', { class: 'num' }, 'Collected'),
                    h('th', null, ''),
                    h('th', { class: 'num' }, 'Patients'),
                )),
                h('tbody', null,
                    ...rows.map(b => {
                        const coll = b.revenue > 0 ? Math.round(b.cashIn / b.revenue * 100) : 100;
                        return h('tr', null,
                            h('td', null, h('div', { class: 'row', style: { gap: '10px' } },
                                Avatar({ initials: initials(b.name), color: avColor(b.id) }),
                                h('div', null, h('div', { class: 'cell-strong' }, b.name)),
                            )),
                            h('td', { class: 'num cell-strong', style: { color: 'var(--ok-700)' } }, formatMoney(b.cashIn)),
                            h('td', { class: 'num cell-strong', style: { color: 'var(--primary-700)' } }, formatMoney(b.revenue)),
                            h('td', null, Tag(coll + '%', { kind: coll >= 90 ? 'ok' : coll >= 70 ? 'warn' : 'crit' })),
                            h('td', { style: { width: '120px' } },
                                h('div', { style: { height: '5px', background: 'var(--ink-100)', borderRadius: '999px' } },
                                    h('div', { style: { width: (b.revenue / maxRev * 100) + '%', height: '100%', background: 'var(--primary-500)', borderRadius: '999px' } }),
                                ),
                            ),
                            h('td', { class: 'num cell-strong' }, String(b.patients)),
                        );
                    }),
                    h('tr', { style: { background: 'var(--ink-25)' } },
                        h('td', { class: 'cell-strong' }, h('div', { class: 'row', style: { gap: '10px' } },
                            h('div', { style: { width: '34px', height: '34px', borderRadius: '999px', background: 'linear-gradient(135deg, var(--primary-500), var(--primary-700))', color: 'white', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '12px' } }, '∑'),
                            h('div', null, 'Network total'),
                        )),
                        h('td', { class: 'num cell-strong', style: { color: 'var(--ok-700)' } }, formatMoney(m.cash_in_total)),
                        h('td', { class: 'num cell-strong', style: { color: 'var(--primary-700)' } }, formatMoney(m.revenue_total)),
                        h('td', null, Tag((m.revenue_total > 0 ? Math.round(m.cash_in_total / m.revenue_total * 100) : 100) + '%', { kind: 'ok' })),
                        h('td', null, ''),
                        h('td', { class: 'num cell-strong' }, String(m.patients_period || 0)),
                    ),
                ),
            ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Capacity — bed occupancy by ward + top doctors by work done
// ---------------------------------------------------------------------------
function capacityPanel(m) {
    const wards = m.wards_occupancy || [];
    const docs  = m.top_doctors || [];
    const maxDoc = docs.reduce((mx, d) => Math.max(mx, d.revenue || 0), 0) || 1;
    const pal = (pct) => pct >= 90 ? 'var(--crit-500)' : pct >= 70 ? 'var(--ok-500)' : 'var(--warn-500)';

    return h('div', null,
        sectionHeader('Bed', 'Capacity — space and people', 'Beds in use and who is doing the work'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } },

            // Bed occupancy by ward
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Bed', { size: 16 }), ' Bed occupancy by ward'),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, `${m.beds_occupied || 0} of ${m.beds_total || 0} beds`),
                ),
                h('div', { style: { padding: '14px 22px 20px', display: 'flex', flexDirection: 'column', gap: '12px' } },
                    wards.length === 0
                        ? h('div', { class: 'empty', style: { padding: '20px 8px' } }, 'No wards / beds configured.')
                        : wards.map(w => {
                            const pct = w.total > 0 ? Math.round(w.used / w.total * 100) : 0;
                            return h('div', null,
                                h('div', { class: 'row', style: { marginBottom: '5px', fontSize: '12.5px' } },
                                    h('span', { style: { color: 'var(--ink-700)', fontWeight: 500 } }, w.name),
                                    h('span', { class: 'grow' }),
                                    h('span', { class: 'num muted' }, `${w.used}/${w.total}`),
                                    h('span', { class: 'num', style: { fontWeight: 700, color: pal(pct), minWidth: '40px', textAlign: 'right' } }, pct + '%'),
                                ),
                                h('div', { style: { height: '6px', background: 'var(--ink-100)', borderRadius: '999px' } },
                                    h('div', { style: { width: pct + '%', height: '100%', background: pal(pct), borderRadius: '999px' } }),
                                ),
                            );
                        }),
                ),
            ),

            // Top doctors by completed work
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Stethoscope', { size: 16 }), ' Top doctors · work done'),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, periodSubtitle()),
                ),
                h('div', { style: { padding: '14px 22px 20px', display: 'flex', flexDirection: 'column', gap: '12px' } },
                    docs.length === 0
                        ? h('div', { class: 'empty', style: { padding: '20px 8px' } }, 'No completed services attributed to a doctor.')
                        : docs.map(d => h('div', null,
                            h('div', { class: 'row', style: { marginBottom: '5px', fontSize: '12.5px' } },
                                h('span', { style: { color: 'var(--ink-900)', fontWeight: 600 } }, d.name),
                                h('span', { class: 'muted', style: { fontSize: '11.5px', marginLeft: '6px' } }, `· ${d.count}×`),
                                h('span', { class: 'grow' }),
                                h('span', { class: 'num cell-strong', style: { color: 'var(--primary-700)' } }, formatMoney(d.revenue)),
                            ),
                            h('div', { style: { height: '6px', background: 'var(--ink-100)', borderRadius: '999px' } },
                                h('div', { style: { width: (d.revenue / maxDoc * 100) + '%', height: '100%', background: 'var(--primary-500)', borderRadius: '999px' } }),
                            ),
                        )),
                ),
            ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Quality — placeholder (no patient-feedback source yet)
// ---------------------------------------------------------------------------
function qualityPanel() {
    return h('div', null,
        sectionHeader('Heart', 'Quality — what patients experience', 'Satisfaction, waits and safety'),
        h('div', { class: 'card', style: { padding: '18px 22px' } },
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'center' } },
                h('div', { style: { width: '36px', height: '36px', borderRadius: '9px', background: 'var(--ink-50)', color: 'var(--ink-500)', display: 'grid', placeItems: 'center' } }, Icon('Heart', { size: 18 })),
                h('div', { style: { flex: 1 } },
                    h('div', { style: { fontWeight: 700, fontSize: '13.5px', color: 'var(--ink-900)' } }, 'Not tracked yet'),
                    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, 'Patient satisfaction, wait time and safety incidents will appear here once feedback collection is connected.'),
                ),
                Tag('No data', { kind: '' }),
            ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Decision summary
// ---------------------------------------------------------------------------
function decisionSummary(m) {
    const wins = [];
    const fixes = [];
    const collectionPct = m.revenue_total > 0 ? Math.round(m.cash_in_total / m.revenue_total * 100) : 100;

    if ((m.revenue_delta_pct || 0) > 0) wins.push(`Revenue grew ${m.revenue_delta_pct}% versus the previous period.`);
    if (collectionPct >= 90) wins.push(`Strong collection — ${collectionPct}% of revenue already received as cash.`);
    if (m.occupancy_pct != null && m.occupancy_pct >= 60 && m.occupancy_pct <= 85) wins.push('Bed occupancy is in the healthy range.');
    if (m.critical_today === 0) wins.push('No critical lab results outstanding today.');
    if (wins.length === 0) wins.push('Steady period — no standout gains to report.');

    const gap = (m.revenue_total || 0) - (m.cash_in_total || 0);
    if (m.open_invoices_total > 0) fixes.push(`${formatMoney(m.open_invoices_total)} sitting in unpaid / partial invoices — push collections.`);
    if (gap > 0 && m.revenue_total > 0 && gap / m.revenue_total > 0.15) fixes.push(`Cash In is lagging Revenue by ${formatMoney(gap)} — close the collection gap.`);
    if ((m.revenue_delta_pct || 0) < 0) fixes.push(`Revenue fell ${Math.abs(m.revenue_delta_pct)}% — review scheduling and service mix.`);
    if (m.critical_today > 0) fixes.push(`${m.critical_today} critical lab result${m.critical_today === 1 ? '' : 's'} need a doctor's eyes today.`);
    if (m.occupancy_pct != null && m.occupancy_pct > 90) fixes.push('Beds are near capacity — plan discharges or overflow.');
    if (fixes.length === 0) fixes.push('Nothing urgent — keep an eye on the alerts above.');

    const col = (title, icon, accent, items, bullet, bulletColor) => h('div', { style: { background: 'white', border: '1px solid var(--ink-100)', borderRadius: '14px', padding: '20px 22px', borderLeft: '4px solid ' + accent } },
        h('div', { class: 'row', style: { gap: '10px', marginBottom: '14px' } },
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: accent + '22', color: accent, display: 'grid', placeItems: 'center' } }, Icon(icon, { size: 16 })),
            h('h3', { style: { margin: 0, fontSize: '15px', color: 'var(--ink-900)' } }, title),
        ),
        h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '10px' } },
            ...items.map(t => h('li', { style: { display: 'flex', gap: '10px', fontSize: '13px', color: 'var(--ink-700)', lineHeight: '1.5' } },
                h('span', { style: { color: bulletColor, flex: '0 0 14px', marginTop: '2px', display: 'flex' } }, Icon(bullet, { size: 14 })),
                h('span', null, t),
            )),
        ),
    );

    return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } },
        col("What's working well", 'Heart', 'var(--ok-500)', wins, 'Check', 'var(--ok-500)'),
        col('What to do this week', 'Warning', 'var(--warn-500)', fixes, 'ArrowRight', 'var(--warn-700)'),
    );
}

// ===========================================================================
// Data
// ===========================================================================
async function loadBranches() {
    const { data, error } = await supabase
        .from('branches')
        .select('id, name')
        .eq('company_id', (window.CLINIC && window.CLINIC.id) || null)   // M1 — scope to this clinic
        .eq('active', true)
        .order('name', { ascending: true });
    if (error) { console.warn('[reports] branches:', error.message); return []; }
    return data || [];
}

function periodRange(period) {
    const now = new Date();
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    if (period === 'week') {
        const day = (start.getDay() + 6) % 7;   // ISO week, Monday start
        start.setDate(start.getDate() - day);
    } else if (period === 'month') {
        start.setDate(1);
    } else if (period === 'quarter') {
        start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
    } else if (period === 'year') {
        start.setMonth(0, 1);
    }
    return { start, end };
}

async function loadMetrics(period, branchId) {
    try {
        const { start, end } = periodRange(period);
        const sMs = start.getTime(), eMs = end.getTime();
        const prevLen   = eMs - sMs;
        const prevEnd   = new Date(sMs - 1);
        const prevStart = new Date(prevEnd.getTime() - prevLen);
        const pMs = prevStart.getTime(), pEndMs = prevEnd.getTime();

        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd   = new Date(todayStart.getTime() + 86_400_000);
        const tMs = todayStart.getTime(), tEndMs = todayEnd.getTime();

        const sparkStart = new Date(); sparkStart.setHours(0, 0, 0, 0);
        sparkStart.setDate(sparkStart.getDate() - 13);

        // One wide fetch window per table → bucket everything client-side.
        const windowStart = new Date(Math.min(pMs, sparkStart.getTime(), sMs, tMs));
        const winFrom = windowStart.toISOString();
        const winTo   = new Date(Math.max(eMs, tEndMs)).toISOString();

        const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1 — scope every financial/operational read to this clinic (RLS-bypass roles see all otherwise)
        const cf = cid ? { col: 'company_id', val: cid } : null;
        const [payRows, vsRows, visitRows, admSvcRows, invRows, bedRows, admRows, usersList, critToday, unverified, queued, totalInvoices] = await Promise.all([
            fetchRows('payments',          'amount, method, paid_at, invoices!inner(branch_id, company_id)','paid_at',      winFrom, winTo, cid ? { col: 'invoices.company_id', val: cid } : null),
            fetchRows('visit_services',    'total, status, invoice_item_id, created_at, doctor_id, services(type, name), visits(branch_id)', 'created_at', winFrom, winTo, cf),
            fetchRows('visits',            'id, visit_date, branch_id, status',                             'visit_date',   winFrom, winTo, cf),
            fetchRows('admission_services','total, status, performed_at, services(name, type), wards(branch_id)', 'performed_at', winFrom, winTo, cf),
            fetchAll('invoices',           'id, status, total_amount, paid_amount, branch_id', cf),
            fetchAll('beds',               'id, status, ward_id, wards(name, branch_id)', cf),
            fetchAll('admissions',         'id, status, ward_id, wards(branch_id)', cf),
            fetchAll('users',              'id, full_name', cf),
            countQuery('lab_results',    q => q.eq('flag', 'critical').gte('resulted_at', todayStart.toISOString())).catch(() => 0),
            countQuery('visit_services', q => { let qq = q.eq('status', 'in_progress'); if (cid) qq = qq.eq('company_id', cid); return qq; }).catch(() => 0),
            countQuery('visit_services', q => { let qq = q.eq('status', 'queued'); if (cid) qq = qq.eq('company_id', cid); return qq; }).catch(() => 0),
            countQuery('invoices',       q => cid ? q.eq('company_id', cid) : q).catch(() => 0),
        ]);

        // Branch accessors + filters
        const payBranch   = r => r.invoices?.branch_id ?? null;
        const vsBranch    = r => r.visits?.branch_id ?? null;
        const admBranch   = r => r.wards?.branch_id ?? null;
        const inBranch    = b => branchId === 'all' || b === branchId;
        const isCompleted = r => r.status === 'completed';
        const notDeposit  = r => (r.method || 'cash').toLowerCase() !== 'deposit';   // #19 — deposit-spend is balance use, not new cash-in (matches head Finance)
        const isRevenueVs = r => r.status === 'completed' && r.invoice_item_id;       // #7 — only invoiced completed work is collectable revenue
        const areaOf      = r => AREA_OF_TYPE[r.services?.type] || 'other';

        const sumIn = (rows, valFn, dateFn, branchFn, a, z, filterFn) => {
            let s = 0;
            for (const r of rows) {
                if (filterFn && !filterFn(r)) continue;
                if (!inBranch(branchFn(r))) continue;
                const t = new Date(dateFn(r)).getTime();
                if (t >= a && t < z) s += valFn(r);
            }
            return s;
        };
        const countInRows = (rows, dateFn, branchFn, a, z, filterFn) => {
            let n = 0;
            for (const r of rows) {
                if (filterFn && !filterFn(r)) continue;
                if (!inBranch(branchFn(r))) continue;
                const t = new Date(dateFn(r)).getTime();
                if (t >= a && t < z) n++;
            }
            return n;
        };

        const num = v => Number(v || 0);

        // ----- Cash In (payments) -----
        const cashInTotal = sumIn(payRows, r => num(r.amount), r => r.paid_at, payBranch, sMs, eMs, notDeposit);
        const cashInPrev  = sumIn(payRows, r => num(r.amount), r => r.paid_at, payBranch, pMs, pEndMs, notDeposit);
        const cashToday   = sumIn(payRows, r => num(r.amount), r => r.paid_at, payBranch, tMs, tEndMs, notDeposit);

        // ----- Revenue (completed & invoiced services) -----
        const revVisit = sumIn(vsRows,    r => num(r.total), r => r.created_at,   vsBranch,  sMs, eMs, isRevenueVs);
        const revAdm   = sumIn(admSvcRows, r => num(r.total), r => r.performed_at, admBranch, sMs, eMs, isCompleted);
        const revenueTotal = revVisit + revAdm;
        const revVisitPrev = sumIn(vsRows,    r => num(r.total), r => r.created_at,   vsBranch,  pMs, pEndMs, isRevenueVs);
        const revAdmPrev   = sumIn(admSvcRows, r => num(r.total), r => r.performed_at, admBranch, pMs, pEndMs, isCompleted);
        const revenuePrev  = revVisitPrev + revAdmPrev;

        // Revenue by area
        const revenueByArea = { doctors: 0, lab: 0, diagnostics: 0, inpatient: 0, other: 0 };
        for (const r of vsRows) {
            if (!isRevenueVs(r) || !inBranch(vsBranch(r))) continue;
            const t = new Date(r.created_at).getTime();
            if (t >= sMs && t < eMs) revenueByArea[areaOf(r)] += num(r.total);
        }
        for (const r of admSvcRows) {
            if (!isCompleted(r) || !inBranch(admBranch(r))) continue;
            const t = new Date(r.performed_at).getTime();
            if (t >= sMs && t < eMs) revenueByArea.inpatient += num(r.total);
        }

        // ----- Patients -----
        const patientsPeriod = countInRows(visitRows, r => r.visit_date, r => r.branch_id, sMs, eMs);
        const patientsPrev   = countInRows(visitRows, r => r.visit_date, r => r.branch_id, pMs, pEndMs);
        const patientsToday  = countInRows(visitRows, r => r.visit_date, r => r.branch_id, tMs, tEndMs);
        const inProgressCount = visitRows.filter(r => r.status === 'in_progress' && inBranch(r.branch_id)).length;

        // ----- Sparklines (14 days) -----
        const cashInSpark  = dailySeriesFromRows(payRows.filter(notDeposit), r => num(r.amount), r => r.paid_at,    payBranch, inBranch, 14);
        const revenueSpark = dailySeriesFromRows(vsRows,    r => num(r.total),  r => r.created_at, vsBranch,  inBranch, 14, isRevenueVs);
        const patientsSpark= dailySeriesFromRows(visitRows, null,               r => r.visit_date, r => r.branch_id, inBranch, 14);

        // ----- Top services (completed work) -----
        const svcBuckets = new Map();
        const addSvc = (name, total) => {
            const b = svcBuckets.get(name) || { name, revenue: 0, count: 0 };
            b.revenue += total; b.count += 1; svcBuckets.set(name, b);
        };
        for (const r of vsRows) {
            if (!isRevenueVs(r) || !inBranch(vsBranch(r))) continue;
            const t = new Date(r.created_at).getTime();
            if (t >= sMs && t < eMs) addSvc(r.services?.name || '—', num(r.total));
        }
        for (const r of admSvcRows) {
            if (!isCompleted(r) || !inBranch(admBranch(r))) continue;
            const t = new Date(r.performed_at).getTime();
            if (t >= sMs && t < eMs) addSvc(r.services?.name || '—', num(r.total));
        }
        const topServices = [...svcBuckets.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

        // ----- Top doctors (completed visit_services with a doctor) -----
        const userName = new Map((usersList || []).map(u => [u.id, u.full_name]));
        const docBuckets = new Map();
        for (const r of vsRows) {
            if (!isRevenueVs(r) || !inBranch(vsBranch(r)) || !r.doctor_id) continue;
            const t = new Date(r.created_at).getTime();
            if (t < sMs || t >= eMs) continue;
            const b = docBuckets.get(r.doctor_id) || { name: userName.get(r.doctor_id) || 'Doctor', revenue: 0, count: 0 };
            b.revenue += num(r.total); b.count += 1; docBuckets.set(r.doctor_id, b);
        }
        const topDoctors = [...docBuckets.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6);

        // ----- Open invoices (branch-aware) -----
        let openInvoicesCount = 0, openInvoicesTotal = 0;
        for (const r of invRows) {
            if (!['unpaid', 'partial'].includes(r.status)) continue;
            if (!inBranch(r.branch_id ?? null)) continue;
            openInvoicesCount++;
            openInvoicesTotal += Math.max(0, num(r.total_amount) - num(r.paid_amount));
        }

        // ----- Beds / occupancy (branch-aware) -----
        const wardMap = new Map();
        let bedsTotal = 0, bedsOccupied = 0;
        for (const b of bedRows) {
            if (!inBranch(b.wards?.branch_id ?? null)) continue;
            bedsTotal++;
            const occ = b.status === 'occupied';
            if (occ) bedsOccupied++;
            const wn = b.wards?.name || 'Unassigned';
            const w = wardMap.get(wn) || { name: wn, total: 0, used: 0 };
            w.total++; if (occ) w.used++; wardMap.set(wn, w);
        }
        // Fall back to active admissions if bed.status isn't maintained.
        const activeAdmissions = admRows.filter(a => a.status === 'active' && inBranch(a.wards?.branch_id ?? null)).length;
        if (bedsOccupied === 0 && activeAdmissions > 0) bedsOccupied = Math.min(activeAdmissions, bedsTotal);
        const wardsOccupancy = [...wardMap.values()].sort((a, b) => (b.used / (b.total || 1)) - (a.used / (a.total || 1)));
        const occupancyPct = bedsTotal > 0 ? Math.round((bedsOccupied / bedsTotal) * 100) : null;

        // ----- Per-branch comparison (period) -----
        let branchRows = [];
        if (branchId === 'all' && state.branches.length > 0) {
            const cashByBranch = bucketByBranch(payRows, r => num(r.amount), r => r.paid_at,    payBranch, sMs, eMs);
            const revByBranch  = bucketByBranch(vsRows,  r => num(r.total),  r => r.created_at, vsBranch,  sMs, eMs, isCompleted);
            const admByBranch  = bucketByBranch(admSvcRows, r => num(r.total), r => r.performed_at, admBranch, sMs, eMs, isCompleted);
            const patByBranch  = bucketByBranch(visitRows, () => 1,           r => r.visit_date, r => r.branch_id, sMs, eMs);
            branchRows = state.branches.map(b => ({
                id: b.id, name: b.name,
                cashIn:   cashByBranch.get(b.id) || 0,
                revenue: (revByBranch.get(b.id) || 0) + (admByBranch.get(b.id) || 0),
                patients: patByBranch.get(b.id) || 0,
            })).sort((a, b) => b.revenue - a.revenue);
        }

        return {
            // pulse
            patients_today: patientsToday,
            in_progress_count: inProgressCount,
            inpatients_count: activeAdmissions,
            cash_today: cashToday,
            open_invoices_count: openInvoicesCount,
            open_invoices_total: openInvoicesTotal,
            critical_today: critToday,
            unverified_results: unverified,
            queued_services: queued,
            total_invoices: totalInvoices,

            // money
            cash_in_total: cashInTotal,
            cash_in_delta_pct: pctDelta(cashInTotal, cashInPrev),
            cash_in_spark: cashInSpark,
            revenue_total: revenueTotal,
            revenue_delta_pct: pctDelta(revenueTotal, revenuePrev),
            revenue_spark: revenueSpark,
            revenue_by_area: revenueByArea,

            // patients
            patients_period: patientsPeriod,
            patients_delta_pct: pctDelta(patientsPeriod, patientsPrev),
            patients_spark: patientsSpark,

            // capacity
            occupancy_pct: occupancyPct,
            beds_total: bedsTotal,
            beds_occupied: bedsOccupied,
            wards_occupancy: wardsOccupancy,
            top_doctors: topDoctors,

            // tables
            top_services: topServices,
            branch_rows: branchRows,
        };
    } catch (e) {
        console.error('[reports] loadMetrics failed:', e);
        toast('Could not load metrics: ' + (e?.message || e), 'fail');
        return empty();
    }
}

function bucketByBranch(rows, valFn, dateFn, branchFn, a, z, filterFn) {
    const map = new Map();
    for (const r of rows) {
        if (filterFn && !filterFn(r)) continue;
        const b = branchFn(r);
        if (b == null) continue;
        const t = new Date(dateFn(r)).getTime();
        if (t < a || t >= z) continue;
        map.set(b, (map.get(b) || 0) + valFn(r));
    }
    return map;
}

function dailySeriesFromRows(rows, valFn, dateFn, branchFn, inBranch, days, filterFn) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const buckets = Array.from({ length: days }, () => 0);
    for (const r of rows) {
        if (filterFn && !filterFn(r)) continue;
        if (!inBranch(branchFn(r))) continue;
        const idx = Math.floor((new Date(dateFn(r)).getTime() - start.getTime()) / 86_400_000);
        if (idx >= 0 && idx < days) buckets[idx] += valFn ? valFn(r) : 1;
    }
    return buckets;
}

// Fetch rows in a date window. Returns [] on any error (missing table etc).
async function fetchRows(table, select, dateCol, fromIso, toIso, cidFilter) {
    let q = supabase.from(table).select(select).gte(dateCol, fromIso).lte(dateCol, toIso);
    if (cidFilter && cidFilter.val) q = q.eq(cidFilter.col, cidFilter.val);   // M1 — clinic scope (RLS-bypass roles see every clinic otherwise)
    const { data, error } = await q.limit(20000);
    if (error) { console.warn(`[reports] ${table}:`, error.message); return []; }
    return data || [];
}

async function fetchAll(table, select, cidFilter) {
    let q = supabase.from(table).select(select);
    if (cidFilter && cidFilter.val) q = q.eq(cidFilter.col, cidFilter.val);   // M1 — clinic scope (RLS-bypass roles)
    const { data, error } = await q.limit(20000);
    if (error) { console.warn(`[reports] ${table}:`, error.message); return []; }
    return data || [];
}

async function countQuery(table, build) {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    q = build(q);
    const { count, error } = await q;
    if (error) {
        if (/relation .* does not exist/i.test(error.message)) return 0;
        console.warn(`[reports] count ${table}:`, error.message);
        return 0;
    }
    return count || 0;
}

function pctDelta(curr, prev) {
    if (!prev || prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
}

function empty() {
    return {
        patients_today: 0, in_progress_count: 0, inpatients_count: 0, cash_today: 0,
        open_invoices_count: 0, open_invoices_total: 0, critical_today: 0,
        unverified_results: 0, queued_services: 0, total_invoices: 0,
        cash_in_total: 0, cash_in_delta_pct: 0, cash_in_spark: [],
        revenue_total: 0, revenue_delta_pct: 0, revenue_spark: [],
        revenue_by_area: { doctors: 0, lab: 0, diagnostics: 0, inpatient: 0, other: 0 },
        patients_period: 0, patients_delta_pct: 0, patients_spark: [],
        occupancy_pct: null, beds_total: 0, beds_occupied: 0, wards_occupancy: [], top_doctors: [],
        top_services: [], branch_rows: [],
    };
}

// ===========================================================================
// Misc helpers
// ===========================================================================
function sectionHeader(icon, title, sub) {
    return h('div', { class: 'row', style: { gap: '12px', marginBottom: '12px', marginTop: '8px' } },
        h('div', { style: { width: '28px', height: '28px', borderRadius: '7px', background: 'var(--primary-50)', color: 'var(--primary-700)', border: '1px solid var(--primary-200, #b8e6e1)', display: 'grid', placeItems: 'center' } }, Icon(icon, { size: 16 })),
        h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.01em' } }, title),
        h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '4px' } }, '· ' + sub),
    );
}

// 0–100 score → continuous red→amber→green colour (traffic-light midpoint).
function scoreColor(score) {
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    const lerp = (a, b, t) => a + (b - a) * t;
    let r, g, b;
    if (s < 50) { const t = s / 50;        r = lerp(220, 245, t); g = lerp(38, 158, t); b = lerp(38, 11, t); }
    else        { const t = (s - 50) / 50; r = lerp(245, 16, t);  g = lerp(158, 185, t); b = lerp(11, 129, t); }
    const R = Math.round(r), G = Math.round(g), B = Math.round(b);
    return { rgb: `rgb(${R}, ${G}, ${B})`, rgbA: a => `rgba(${R}, ${G}, ${B}, ${a})` };
}

function formatMoney(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + ' M';
    if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(1) + ' K';
    return v.toLocaleString('ru-RU');
}

function periodSubtitle() {
    return PERIODS.find(x => x.id === state.period)?.label || '';
}

// Make a fixed-size SVG (from Spark/Bars) stretch to its container width.
function responsiveSvg(svgEl, heightPx) {
    if (!svgEl || !svgEl.setAttribute) return svgEl;
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('width', '100%');
    svgEl.style.width = '100%';
    svgEl.style.height = heightPx + 'px';
    return svgEl;
}

function exportCsv(m) {
    if (!m) { toast('Nothing to export yet.', 'fail'); return; }
    const branchName = state.branchId === 'all' ? 'All branches' : (state.branches.find(b => b.id === state.branchId)?.name || state.branchId);
    const lines = [
        ['metric', 'value'],
        ['branch',              branchName],
        ['period',              state.period],
        ['cash_in',             m.cash_in_total],
        ['cash_in_delta_pct',   m.cash_in_delta_pct],
        ['revenue',             m.revenue_total],
        ['revenue_delta_pct',   m.revenue_delta_pct],
        ['revenue_doctors',     m.revenue_by_area?.doctors ?? 0],
        ['revenue_laboratory',  m.revenue_by_area?.lab ?? 0],
        ['revenue_diagnostics', m.revenue_by_area?.diagnostics ?? 0],
        ['revenue_inpatient',   m.revenue_by_area?.inpatient ?? 0],
        ['revenue_other',       m.revenue_by_area?.other ?? 0],
        ['patients_period',     m.patients_period],
        ['patients_delta_pct',  m.patients_delta_pct],
        ['patients_today',      m.patients_today],
        ['cash_today',          m.cash_today],
        ['open_invoices_count', m.open_invoices_count],
        ['open_invoices_total', m.open_invoices_total],
        ['critical_labs_today', m.critical_today],
        ['occupancy_pct',       m.occupancy_pct ?? ''],
        ['beds_total',          m.beds_total],
        ['beds_occupied',       m.beds_occupied],
    ];
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `easymed-reports-${state.branchId}-${state.period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
