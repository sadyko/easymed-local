// Call center · CRM — standalone view (sits next to Marketing in the sidebar).
// Ported from "Call Center/src/view-callcenter.jsx" to vanilla h(). Static demo
// data — no DB yet; the status changer mutates CC_CALLS in memory.
//
// Six tabs:
//   Dashboard · Live queue · All calls · Reminders · Agents · Scripts
// Click any call row anywhere → opens the right-side CallDrawer.

import { h, Icon, PageHead, Tag, Avatar, Spark, Delta, clear } from '../ui.js';

// ----------------------------------------------------------------------------
// Module state
// ----------------------------------------------------------------------------
const state = {
    tab:     'dashboard',     // 'dashboard' | 'queue' | 'calls' | 'reminders' | 'agents' | 'scripts'
    filter:  'all',           // All-calls table filter bucket
    drawer:  null,            // currently-open call object — null = closed
};
let containerRef = null;
let onNavigateRef = null;

export function renderCallCenter(container, ctx = {}) {
    containerRef  = container;
    onNavigateRef = ctx.onNavigate || (() => {});
    paint();
}

function paint() {
    clear(containerRef);
    containerRef.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        page(),
    ));
    if (state.drawer) containerRef.appendChild(callDrawer(state.drawer));
}

// ----------------------------------------------------------------------------
// Demo data
// ----------------------------------------------------------------------------
const CC_STATUS = {
    'new':            { label: 'New',            dot: 'var(--info-500)',    terminal: false, icon: 'Bell' },
    'assigned':       { label: 'Assigned',       dot: 'var(--ink-500)',     terminal: false, icon: 'User' },
    'in-progress':    { label: 'In progress',    dot: 'var(--primary-500)', terminal: false, icon: 'Phone' },
    'callback':       { label: 'Callback',       dot: 'var(--warn-500)',    terminal: false, icon: 'Clock' },
    'no-answer':      { label: 'No answer',      dot: 'var(--warn-500)',    terminal: false, icon: 'PhoneMissed' },
    'voicemail':      { label: 'Voicemail',      dot: 'var(--ink-400)',     terminal: false, icon: 'Mic' },
    'scheduled':      { label: 'Scheduled',      dot: 'var(--ok-500)',      terminal: true,  icon: 'Calendar' },
    'not-interested': { label: 'Not interested', dot: 'var(--ink-400)',     terminal: true,  icon: 'X' },
    'stopped':        { label: 'Stopped (DNC)',  dot: 'var(--crit-500)',    terminal: true,  icon: 'Stop' },
    'lost':           { label: 'Lost',           dot: 'var(--crit-500)',    terminal: true,  icon: 'X' },
};
const ccIsTerminal = (s) => !!CC_STATUS[s]?.terminal;

const CC_KPI = {
    open: 47, inQueue: 8, slaWithin60s: 89.4, aht: '3:42', conversion: 38.2,
    agentsOnline: 7, agentsTotal: 9,
    volume:       [82,96,104,118,132,140,158,172,168,176,184,190],
    conversion12: [31,33,32,34,35,36,36,37,37,38,38,38],
    sla:          [85,86,84,87,88,88,89,90,89,90,89,89],
    aht12:        [4.1,4.0,3.9,3.8,3.9,3.8,3.7,3.7,3.6,3.7,3.6,3.7],
};

const CC_REASONS = [
    { id: 'book',    label: 'New booking',             value: 142, color: 'var(--primary-600)' },
    { id: 'reschd',  label: 'Reschedule',              value:  86, color: 'var(--info-500)' },
    { id: 'recall',  label: 'Recall · 6-mo follow-up', value:  64, color: 'var(--ok-500)' },
    { id: 'results', label: 'Results inquiry',         value:  48, color: 'var(--purple-500)' },
    { id: 'noshow',  label: 'No-show recovery',        value:  34, color: 'var(--warn-500)' },
    { id: 'billing', label: 'Billing / payment',       value:  22, color: 'var(--ink-500)' },
];
const ccReason = (id) => CC_REASONS.find(r => r.id === id) || { label: id, color: 'var(--ink-500)' };

const CC_AGENTS = [
    { id: 'ag1', name: 'Madina Tursunova', initials: 'MT', color: 'av-4', state: 'on-call',   handled: 28, conv: 46, aht: '3:18', occ: 0.86, sla: 93 },
    { id: 'ag2', name: 'Sevara Karimova',  initials: 'SK', color: 'av-2', state: 'available', handled: 31, conv: 41, aht: '3:34', occ: 0.71, sla: 90 },
    { id: 'ag3', name: 'Aziz Yusupov',     initials: 'AY', color: 'av-1', state: 'on-call',   handled: 24, conv: 38, aht: '4:02', occ: 0.78, sla: 87 },
    { id: 'ag4', name: 'Dilshod Juraev',   initials: 'DJ', color: 'av-5', state: 'wrap-up',   handled: 22, conv: 35, aht: '3:55', occ: 0.69, sla: 84 },
    { id: 'ag5', name: 'Nilufar Sodiqova', initials: 'NS', color: 'av-6', state: 'available', handled: 26, conv: 39, aht: '3:21', occ: 0.74, sla: 91 },
    { id: 'ag6', name: 'Rustam Xolmatov',  initials: 'RX', color: 'av-3', state: 'break',     handled: 18, conv: 33, aht: '4:11', occ: 0.62, sla: 82 },
    { id: 'ag7', name: 'Kamola Eshonova',  initials: 'KE', color: 'av-7', state: 'on-call',   handled: 29, conv: 44, aht: '3:28', occ: 0.81, sla: 92 },
];

const CC_AGENT_STATE = {
    'available': { label: 'Available', color: 'var(--ok-500)',   bg: 'var(--ok-50)' },
    'on-call':   { label: 'On call',   color: 'var(--info-500)', bg: 'var(--info-50)' },
    'wrap-up':   { label: 'Wrap-up',   color: 'var(--warn-500)', bg: 'var(--warn-50)' },
    'break':     { label: 'Break',     color: 'var(--ink-500)',  bg: 'var(--ink-50)' },
};

const CC_CALLS = [
    { id: 'c-1001', dir: 'in',  patient: { name: 'Aliyev Bobur',     mrn: 'MRN-04188', av: 'AB', avc: 'av-2', age: 42 }, reason: 'recall',  status: 'in-progress',    agent: 'MT', startedAt: '11:42',     duration: '2:14', attempts: 1, priority: 'med',  nextAction: null,               note: 'Cardio · 6-mo check-in. Discussing slot for Thu morning.' },
    { id: 'c-1002', dir: 'out', patient: { name: 'Karimova Aziza',   mrn: 'MRN-06721', av: 'KA', avc: 'av-3', age: 58 }, reason: 'noshow',  status: 'callback',       agent: 'SK', startedAt: '11:36',     duration: '1:48', attempts: 2, priority: 'high', nextAction: 'Today · 15:00',    note: 'Requested call back at 15:00 — confirm Friday slot.' },
    { id: 'c-1003', dir: 'in',  patient: { name: 'Yusupov Doniyor',  mrn: 'MRN-02014', av: 'YD', avc: 'av-1', age: 35 }, reason: 'book',    status: 'scheduled',      agent: 'AY', startedAt: '11:28',     duration: '4:32', attempts: 1, priority: 'med',  nextAction: null,               linkedAppt: 'Wed 28 May · 10:30 · Dr. Yusupov', note: '' },
    { id: 'c-1004', dir: 'out', patient: { name: 'Rashidova Malika', mrn: 'MRN-03392', av: 'RM', avc: 'av-4', age: 29 }, reason: 'reschd',  status: 'no-answer',      agent: 'NS', startedAt: '11:14',     duration: '0:00', attempts: 3, priority: 'med',  nextAction: 'Today · 17:30',    note: '3rd attempt — try evening window.' },
    { id: 'c-1005', dir: 'in',  patient: { name: 'Ergashev Sherzod', mrn: 'MRN-08124', av: 'ES', avc: 'av-5', age: 64 }, reason: 'results', status: 'new',            agent: '—',  startedAt: '11:48',     duration: '0:00', attempts: 0, priority: 'high', nextAction: 'Pickup ≤ 60s',     note: 'Inbound · holding 38s.' },
    { id: 'c-1006', dir: 'out', patient: { name: 'Tursunov Akmal',   mrn: 'MRN-05477', av: 'TA', avc: 'av-6', age: 47 }, reason: 'recall',  status: 'scheduled',      agent: 'KE', startedAt: '10:55',     duration: '5:08', attempts: 2, priority: 'low',  nextAction: null,               linkedAppt: 'Mon 02 Jun · 09:00 · Dr. Karimov', note: '' },
    { id: 'c-1007', dir: 'out', patient: { name: 'Sobirova Iroda',   mrn: 'MRN-01926', av: 'SI', avc: 'av-7', age: 71 }, reason: 'recall',  status: 'voicemail',      agent: 'DJ', startedAt: '10:38',     duration: '0:42', attempts: 2, priority: 'med',  nextAction: 'Tomorrow · 10:00', note: 'Left voicemail — single follow-up in 24h.' },
    { id: 'c-1008', dir: 'in',  patient: { name: 'Xojayev Otabek',   mrn: 'MRN-07733', av: 'XO', avc: 'av-1', age: 38 }, reason: 'billing', status: 'assigned',       agent: 'SK', startedAt: '11:46',     duration: '0:00', attempts: 0, priority: 'low',  nextAction: 'Pickup now',       note: 'Routed to billing queue.' },
    { id: 'c-1009', dir: 'out', patient: { name: 'Nazarova Gulnora', mrn: 'MRN-09812', av: 'NG', avc: 'av-2', age: 52 }, reason: 'noshow',  status: 'not-interested', agent: 'NS', startedAt: '10:22',     duration: '2:01', attempts: 1, priority: 'low',  nextAction: null,               note: 'Patient declined — preferred a different clinic.' },
    { id: 'c-1010', dir: 'out', patient: { name: 'Latipov Komil',    mrn: 'MRN-04572', av: 'LK', avc: 'av-3', age: 60 }, reason: 'recall',  status: 'stopped',        agent: 'AY', startedAt: '09:58',     duration: '0:36', attempts: 1, priority: 'low',  nextAction: null,               note: 'DNC — added to do-not-contact list.' },
    { id: 'c-1011', dir: 'out', patient: { name: 'Madaminov Jasur',  mrn: 'MRN-02867', av: 'MJ', avc: 'av-4', age: 44 }, reason: 'recall',  status: 'lost',           agent: 'MT', startedAt: 'Yesterday', duration: '0:00', attempts: 5, priority: 'low',  nextAction: null,               note: 'Retry cap reached after 5 attempts.' },
    { id: 'c-1012', dir: 'in',  patient: { name: 'Inoyatova Saida',  mrn: 'MRN-06108', av: 'IS', avc: 'av-5', age: 33 }, reason: 'book',    status: 'callback',       agent: 'KE', startedAt: '11:02',     duration: '1:12', attempts: 1, priority: 'med',  nextAction: 'Today · 14:15',    note: 'Wants to confirm OB-GYN with her husband first.' },
];

const CC_REMINDERS = CC_CALLS.filter(c => !ccIsTerminal(c.status) && c.nextAction && !c.nextAction.startsWith('Pickup'));

const CC_SCRIPTS = [
    { id: 'sc-1', title: 'Cardiology · 6-month recall',  reason: 'recall',  steps: 5, used: 184, conv: 46, length: '3–5 min' },
    { id: 'sc-2', title: 'No-show recovery (≤ 48h)',     reason: 'noshow',  steps: 4, used:  78, conv: 51, length: '2–3 min' },
    { id: 'sc-3', title: 'New booking · inbound',        reason: 'book',    steps: 6, used: 412, conv: 88, length: '4–6 min' },
    { id: 'sc-4', title: 'Reschedule · soft offer',      reason: 'reschd',  steps: 4, used: 156, conv: 62, length: '2–3 min' },
    { id: 'sc-5', title: 'Results inquiry triage',       reason: 'results', steps: 5, used:  92, conv: 28, length: '3–4 min' },
];

const CC_SCRIPT_STEPS = [
    'Open · greet & verify identity',
    'Reason · explain the call',
    'Offer · propose slot / next step',
    'Handle objection · soft re-offer',
    'Close · confirm & log status',
    'Wrap · summarise & next step',
];

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
function page() {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Call center · CRM',
            subtitle: 'Inbound & outbound contact workflow — linked to the patient base and live scheduling.',
            right: [
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Download', { size: 14 }), ' Export'),
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('PhoneOut', { size: 14 }), ' Outbound campaign'),
                h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus',     { size: 14 }), ' New call'),
            ],
        }),
        h('div', { class: 'tabs' },
            tab('dashboard', 'Dashboard',  'Dashboard'),
            tabBadge('queue',     'Live queue', 'Bell',    CC_KPI.inQueue,        'crit'),
            tab('calls',     'All calls',  'Phone',   CC_CALLS.length),
            tabBadge('reminders', 'Reminders',  'Repeat',  CC_REMINDERS.length,   'warn'),
            tab('agents',    'Agents',     'Headset', CC_AGENTS.length),
            tab('scripts',   'Scripts',    'Doc'),
        ),
        state.tab === 'dashboard' ? dashboard()
        : state.tab === 'queue'     ? queue()
        : state.tab === 'calls'     ? callsTable()
        : state.tab === 'reminders' ? reminders()
        : state.tab === 'agents'    ? agents()
        : scripts(),
    );
}

function tab(id, label, iconName, count) {
    const on = state.tab === id;
    return h('button', {
        class: 'tab' + (on ? ' on' : ''),
        onclick: () => { if (!on) { state.tab = id; paint(); } },
    }, Icon(iconName, { size: 14 }), ' ', label,
        count != null && h('span', { class: 'tab-count' }, String(count)),
    );
}

function tabBadge(id, label, iconName, count, kind) {
    const on = state.tab === id;
    return h('button', {
        class: 'tab' + (on ? ' on' : ''),
        onclick: () => { if (!on) { state.tab = id; paint(); } },
    }, Icon(iconName, { size: 14 }), ' ', label,
        h('span', { class: 'tab-count', style: { background: `var(--${kind}-50)`, color: `var(--${kind}-700)` } }, String(count)),
    );
}

// ----------------------------------------------------------------------------
// Dashboard
// ----------------------------------------------------------------------------
function dashboard() {
    const k = CC_KPI;
    const reasonsTotal = CC_REASONS.reduce((s, r) => s + r.value, 0);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // Row 1: KPI strip
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '14px' } },
            kpi('Open calls',         String(k.open),               '',   +12,  k.volume,                       'var(--primary-600)', 'Phone'),
            kpi('SLA · pickup ≤ 60s', String(k.slaWithin60s),       '%',  +1.4, k.sla,                          'var(--ok-500)',      'Target',  'pt'),
            kpi('Avg. handle time',   k.aht,                        '',   -0.1, k.aht12.map(v => 5 - v),        'var(--info-500)',    'Clock',   'm', false, true),
            kpi('Booking conversion', String(k.conversion),         '%',  +2.8, k.conversion12,                 'var(--purple-500)',  'Target',  'pt'),
            kpi('Agents online',      `${k.agentsOnline}/${k.agentsTotal}`, '', 0, [7,7,8,8,9,9,8,9,7,9,8,7], 'var(--warn-500)',    'Headset', '%', true),
        ),
        // Row 2: hourly volume + reasons donut
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '16px' } },
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Activity', { size: 16 }), ' Hourly call volume · today'),
                    h('div', { class: 'row', style: { gap: '12px', fontSize: '12.5px', color: 'var(--ink-500)' } },
                        legendDot('var(--info-500)',    'Inbound'),
                        legendDot('var(--primary-500)', 'Outbound'),
                        legendDot('var(--crit-500)',    'Missed'),
                    ),
                ),
                h('div', { style: { padding: '14px 22px 22px' } },
                    stackedBars(
                        ['08','09','10','11','12','13','14','15','16','17','18','19'],
                        [
                            { color: 'var(--info-500)',    data: [12,18,22,26,20,16,18,24,28,30,22,12] },
                            { color: 'var(--primary-500)', data: [ 8,14,18,22,16,14,16,22,24,28,20,10] },
                            { color: 'var(--crit-500)',    data: [ 1, 2, 3, 4, 2, 1, 2, 3, 5, 4, 2, 1] },
                        ],
                    ),
                ),
            ),
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Target', { size: 16 }), ' Call reasons · last 7 days'),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, String(reasonsTotal) + ' calls'),
                ),
                h('div', { style: { padding: '14px 22px 22px', display: 'flex', gap: '18px', alignItems: 'center' } },
                    donut(CC_REASONS.map(r => ({ value: r.value, color: r.color })), 130, 18, String(reasonsTotal), 'calls'),
                    h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' } },
                        ...CC_REASONS.map(r => h('div', { class: 'row', style: { gap: '8px', fontSize: '12.5px' } },
                            h('span', { style: { width: '9px', height: '9px', borderRadius: '3px', background: r.color } }),
                            h('span', { style: { color: 'var(--ink-800)', fontWeight: 500 } }, r.label),
                            h('span', { class: 'grow' }),
                            h('span', { class: 'num', style: { color: 'var(--ink-900)', fontWeight: 600 } }, String(r.value)),
                        )),
                    ),
                ),
            ),
        ),
        // Row 3: status pipeline + in-queue snapshot
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '16px' } },
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Layers', { size: 16 }), ' Status pipeline · this week'),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'active → terminal'),
                ),
                h('div', { style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '12px' } },
                    statusFlow(),
                    pipelineBar(),
                ),
            ),
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Bell', { size: 16 }), ' In queue now ', h('span', { class: 'h-count' }, String(CC_KPI.inQueue))),
                    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.tab = 'queue'; paint(); } },
                        'Open queue ', Icon('ArrowRight', { size: 14 })),
                ),
                h('div', { style: { padding: '4px 0 8px' } },
                    ...CC_CALLS.filter(c => c.status === 'new' || c.status === 'assigned').slice(0, 4).map(c =>
                        h('div', {
                            class: 'row',
                            style: { padding: '10px 18px', borderTop: '1px solid var(--ink-100)', gap: '10px', cursor: 'pointer' },
                            onclick: () => openCall(c),
                        },
                            Avatar({ initials: c.patient.av, color: c.patient.avc, size: 'sm' }),
                            h('div', { style: { flex: 1, minWidth: 0 } },
                                h('div', { class: 'cell-strong', style: { fontSize: '12.5px' } }, c.patient.name),
                                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                                    ccReason(c.reason).label + ' · ' + (c.dir === 'in' ? 'inbound' : 'outbound')),
                            ),
                            statusPill(c.status),
                            h('span', { class: 'num muted', style: { fontSize: '12.5px', width: '50px', textAlign: 'right' } }, c.startedAt),
                        )),
                ),
            ),
        ),
    );
}

function legendDot(color, label) {
    return h('span', { class: 'row', style: { gap: '5px' } },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: color } }),
        label,
    );
}

function kpi(label, value, unit, delta, trend, color, iconName, suffix = '%', hideDelta = false, reverse = false) {
    return h('div', { class: 'stat', style: { position: 'relative' } },
        h('div', { class: 'row' },
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: color, opacity: 0.12, position: 'absolute' } }),
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', color, position: 'relative' } },
                Icon(iconName, { size: 16 })),
            h('span', { class: 'grow' }),
            !hideDelta && Delta(reverse ? -delta : delta, suffix),
        ),
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-value num' }, value, unit && h('span', { class: 'unit' }, unit)),
        Spark(trend, { color, w: 220, h: 30 }),
    );
}

// ----------------------------------------------------------------------------
// Status flow + pipeline bar
// ----------------------------------------------------------------------------
function statusFlow() {
    const active = [
        { id: 'new',         c: 'var(--info-500)' },
        { id: 'assigned',    c: 'var(--ink-500)' },
        { id: 'in-progress', c: 'var(--primary-500)' },
    ];
    const branch = [
        { id: 'callback',  c: 'var(--warn-500)' },
        { id: 'no-answer', c: 'var(--warn-500)' },
        { id: 'voicemail', c: 'var(--ink-400)' },
    ];
    const terminal = [
        { id: 'scheduled',      c: 'var(--ok-500)' },
        { id: 'not-interested', c: 'var(--ink-400)' },
        { id: 'stopped',        c: 'var(--crit-500)' },
        { id: 'lost',           c: 'var(--crit-500)' },
    ];
    const node = (s) => {
        const m = CC_STATUS[s.id];
        return h('div', {
            style: {
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                padding: '6px 11px', background: 'white',
                border: `1.5px solid ${s.c}`, borderRadius: '999px',
                fontSize: '12.5px', fontWeight: 600, color: s.c, whiteSpace: 'nowrap',
            },
        }, Icon(m.icon, { size: 12 }), ' ', m.label);
    };
    const arrow = () => {
        const wrap = document.createElement('span');
        wrap.style.flex = '0 0 auto';
        wrap.style.display = 'inline-flex';
        wrap.innerHTML = '<svg width="18" height="10" viewBox="0 0 18 10"><path d="M0 5 H14 M10 1 L14 5 L10 9" fill="none" stroke="var(--ink-300)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        return wrap;
    };
    const sectionLabel = (txt) => h('div', {
        style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)',
                 letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' },
    }, txt);
    const interleave = (items, sep) => {
        const out = [];
        items.forEach((it, i) => { out.push(node(it)); if (i < items.length - 1) out.push(sep()); });
        return out;
    };
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        h('div', null,
            sectionLabel('Active · reminders running'),
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
                ...interleave(active, arrow),
                arrow(),
                h('span', { style: { fontSize: '12.5px', color: 'var(--ink-400)', alignSelf: 'center', fontStyle: 'italic' } }, '(or branch ↓)'),
            ),
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '8px', paddingLeft: '26px' } },
                ...interleave(branch, () => h('span', { style: { color: 'var(--ink-300)', fontSize: '12.5px' } }, '·')),
            ),
        ),
        h('div', { style: { height: '1px', background: 'var(--ink-100)' } }),
        h('div', null,
            sectionLabel('Terminal · reminders STOP'),
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, ...terminal.map(node)),
        ),
    );
}

function pipelineBar() {
    const dist = [
        { id: 'new',           n: 18, c: 'var(--info-500)' },
        { id: 'assigned',      n: 11, c: 'var(--ink-400)' },
        { id: 'in-progress',   n:  6, c: 'var(--primary-500)' },
        { id: 'callback',      n: 24, c: 'var(--warn-500)' },
        { id: 'no-answer',     n: 32, c: '#f0b94a' },
        { id: 'voicemail',     n: 14, c: 'var(--ink-300)' },
        { id: 'scheduled',     n:188, c: 'var(--ok-500)' },
        { id: 'not-interested',n: 26, c: 'var(--ink-400)' },
        { id: 'stopped',       n:  8, c: 'var(--crit-500)' },
        { id: 'lost',          n: 14, c: '#df5d59' },
    ];
    const total = dist.reduce((s, d) => s + d.n, 0);
    return h('div', { style: { marginTop: '6px' } },
        h('div', { class: 'row', style: { marginBottom: '6px', fontSize: '12.5px' } },
            h('span', { style: { color: 'var(--ink-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' } },
                'Distribution · ' + total + ' calls'),
            h('span', { class: 'grow' }),
            h('span', { class: 'num', style: { color: 'var(--ok-700)', fontWeight: 700 } },
                Math.round(188 / total * 100) + '% scheduled'),
        ),
        h('div', { style: { height: '14px', display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--ink-100)' } },
            ...dist.map(d => h('div', { title: `${CC_STATUS[d.id].label} · ${d.n}`, style: { width: (d.n / total * 100) + '%', background: d.c } })),
        ),
        h('div', { class: 'row', style: { marginTop: '8px', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px' } },
            ...dist.map(d => h('span', { class: 'row', style: { gap: '5px' } },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: d.c } }),
                h('span', { style: { color: 'var(--ink-700)' } }, CC_STATUS[d.id].label),
                h('span', { class: 'num', style: { color: 'var(--ink-900)', fontWeight: 600 } }, String(d.n)),
            )),
        ),
    );
}

// ----------------------------------------------------------------------------
// Live queue
// ----------------------------------------------------------------------------
function queue() {
    const q  = CC_CALLS.filter(c => c.status === 'new' || c.status === 'assigned');
    const act = CC_CALLS.filter(c => c.status === 'in-progress');
    const cbs = CC_CALLS.filter(c => c.status === 'callback');
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
        queueColumn('Inbound queue', 'info', 'var(--info-500)',    q,   'No calls holding'),
        queueColumn('On call now',   'ok',   'var(--primary-500)', act, 'No active calls'),
        queueColumn('Callbacks due', 'warn', 'var(--warn-500)',    cbs, 'No callbacks scheduled'),
    );
}

function queueColumn(title, badgeKind, accent, calls, emptyText) {
    return h('div', { class: 'card', style: { background: 'var(--ink-25)' } },
        h('div', { class: 'card-header', style: { background: 'white' } },
            h('h3', null,
                h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: accent, display: 'inline-block', marginRight: '6px' } }),
                title,
                h('span', { class: 'h-count', style: { background: `var(--${badgeKind}-50)`, color: `var(--${badgeKind}-700)` } }, String(calls.length)),
            ),
        ),
        h('div', { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '360px' } },
            calls.length === 0
                ? h('div', { style: { padding: '30px 10px', textAlign: 'center', color: 'var(--ink-400)', fontSize: '12.5px' } }, emptyText)
                : calls.map(c => h('button', {
                    onclick: () => openCall(c),
                    style: {
                        textAlign: 'left', background: 'white',
                        border: '1px solid var(--ink-100)', borderRadius: '10px',
                        padding: '12px 12px 11px', cursor: 'pointer',
                        display: 'flex', flexDirection: 'column', gap: '8px',
                        fontFamily: 'inherit',
                    },
                },
                    h('div', { class: 'row', style: { gap: '8px' } },
                        Avatar({ initials: c.patient.av, color: c.patient.avc, size: 'sm' }),
                        h('div', { style: { flex: 1, minWidth: 0 } },
                            h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, c.patient.name),
                            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, c.patient.mrn + ' · ' + c.patient.age + 'y'),
                        ),
                        c.priority === 'high' && Tag('High', { kind: 'crit', dot: true }),
                    ),
                    h('div', { class: 'row', style: { gap: '6px', fontSize: '12.5px' } },
                        h('span', { style: { color: ccReason(c.reason).color, fontWeight: 600 } }, ccReason(c.reason).label),
                        h('span', { class: 'grow' }),
                        h('span', { style: { color: 'var(--ink-500)' } },
                            Icon(c.dir === 'in' ? 'PhoneIn' : 'PhoneOut', { size: 11 }),
                            ' ', c.startedAt),
                    ),
                    h('div', { class: 'row', style: { gap: '6px' } },
                        statusPill(c.status),
                        c.nextAction && h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '· ' + c.nextAction),
                    ),
                )),
        ),
    );
}

// ----------------------------------------------------------------------------
// All calls (filterable table)
// ----------------------------------------------------------------------------
function callsTable() {
    const buckets = [
        { id: 'all',       label: 'All',       count: CC_CALLS.length },
        { id: 'active',    label: 'Active',    count: CC_CALLS.filter(c => !ccIsTerminal(c.status)).length },
        { id: 'callback',  label: 'Callback',  count: CC_CALLS.filter(c => c.status === 'callback').length },
        { id: 'no-answer', label: 'No answer', count: CC_CALLS.filter(c => c.status === 'no-answer').length },
        { id: 'scheduled', label: 'Scheduled', count: CC_CALLS.filter(c => c.status === 'scheduled').length },
        { id: 'terminal',  label: 'Closed',    count: CC_CALLS.filter(c =>  ccIsTerminal(c.status)).length },
    ];
    const shown = CC_CALLS.filter(c => {
        if (state.filter === 'all') return true;
        if (state.filter === 'active') return !ccIsTerminal(c.status);
        if (state.filter === 'terminal') return ccIsTerminal(c.status);
        return c.status === state.filter;
    });
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
                ...buckets.map(b => {
                    const on = state.filter === b.id;
                    return h('button', {
                        onclick: () => { if (state.filter !== b.id) { state.filter = b.id; paint(); } },
                        style: {
                            padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
                            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-100)'),
                            background: on ? 'var(--primary-50)' : 'white',
                            color: on ? 'var(--primary-700)' : 'var(--ink-700)',
                            fontSize: '12.5px', fontWeight: 600, display: 'inline-flex',
                            alignItems: 'center', gap: '6px', fontFamily: 'inherit',
                        },
                    },
                        b.label,
                        h('span', { style: { fontSize: '12.5px', padding: '0 6px', borderRadius: '999px',
                            background: on ? 'white' : 'var(--ink-50)', color: 'var(--ink-600)', fontWeight: 600 } }, String(b.count)),
                    );
                }),
            ),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Filter',   { size: 14 }), ' Filter'),
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Calendar', { size: 14 }), ' Today'),
            ),
        ),
        h('table', { class: 'tbl' },
            h('thead', null,
                h('tr', null,
                    h('th', { style: { width: '36px' } }, 'Dir'),
                    h('th', null, 'Patient'),
                    h('th', null, 'Reason'),
                    h('th', null, 'Status'),
                    h('th', null, 'Agent'),
                    h('th', null, 'Started'),
                    h('th', null, 'Attempts'),
                    h('th', null, 'Next action'),
                    h('th', null, 'Linked'),
                    h('th', { style: { width: '40px' } }),
                ),
            ),
            h('tbody', null,
                ...shown.map(c => h('tr', { style: { cursor: 'pointer' }, onclick: () => openCall(c) },
                    h('td', null,
                        h('span', {
                            style: {
                                width: '26px', height: '26px', borderRadius: '7px',
                                background: c.dir === 'in' ? 'var(--info-50)'  : 'var(--primary-50)',
                                color:      c.dir === 'in' ? 'var(--info-600)' : 'var(--primary-700)',
                                display: 'inline-grid', placeItems: 'center',
                            },
                        }, Icon(c.dir === 'in' ? 'PhoneIn' : 'PhoneOut', { size: 13 })),
                    ),
                    h('td', null, h('div', { class: 'row', style: { gap: '10px' } },
                        Avatar({ initials: c.patient.av, color: c.patient.avc, size: 'sm' }),
                        h('div', null,
                            h('div', { class: 'cell-strong' }, c.patient.name),
                            h('div', { class: 'muted cell-mono', style: { fontSize: '12.5px' } }, c.patient.mrn),
                        ),
                    )),
                    h('td', null, h('span', {
                        style: {
                            display: 'inline-flex', alignItems: 'center', gap: '5px',
                            padding: '2px 8px', borderRadius: '999px',
                            background: 'white', border: `1px solid ${ccReason(c.reason).color}40`,
                            color: ccReason(c.reason).color, fontSize: '12.5px', fontWeight: 600,
                        },
                    },
                        h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: ccReason(c.reason).color } }),
                        ccReason(c.reason).label,
                    )),
                    h('td', null, statusPill(c.status)),
                    h('td', null, c.agent === '—' ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—') : agentChip(c.agent)),
                    h('td', { class: 'muted num', style: { fontSize: '12.5px' } }, c.startedAt),
                    h('td', null, h('span', {
                        style: {
                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                            padding: '1px 8px', borderRadius: '999px',
                            background: c.attempts >= 3 ? 'var(--crit-50)' : 'var(--ink-25)',
                            color:      c.attempts >= 3 ? 'var(--crit-700)' : 'var(--ink-700)',
                            fontSize: '12.5px', fontWeight: 600, fontFamily: 'var(--font-mono)',
                        },
                    }, String(c.attempts))),
                    h('td', null,
                        c.nextAction
                            ? h('span', { style: { fontSize: '12.5px', color: 'var(--ink-800)', fontWeight: 500 } },
                                Icon('Clock', { size: 11 }), ' ', c.nextAction)
                            : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—'),
                    ),
                    h('td', { onclick: (e) => e.stopPropagation() },
                        h('div', { class: 'row', style: { gap: '4px' } },
                            h('button', {
                                class: 'icon-btn btn-sm', title: 'Patient card',
                                style: { width: '26px', height: '26px' },
                                onclick: () => onNavigateRef('patients'),
                            }, Icon('User', { size: 13 })),
                            c.linkedAppt && h('button', {
                                class: 'icon-btn btn-sm', title: 'Linked appt: ' + c.linkedAppt,
                                style: { width: '26px', height: '26px', color: 'var(--ok-600)' },
                                onclick: () => onNavigateRef('appointments'),
                            }, Icon('Calendar', { size: 13 })),
                        ),
                    ),
                    h('td', { onclick: (e) => e.stopPropagation() },
                        h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' } }, Icon('Dot3', { size: 14 })),
                    ),
                )),
            ),
        ),
    );
}

function agentChip(initials) {
    const a = CC_AGENTS.find(x => x.initials === initials);
    if (!a) return h('span', { class: 'muted' }, '—');
    const parts = a.name.split(' ');
    return h('div', { class: 'row', style: { gap: '7px' } },
        Avatar({ initials: a.initials, color: a.color, size: 'sm' }),
        h('span', { style: { fontSize: '12.5px', fontWeight: 500, color: 'var(--ink-800)' } },
            parts[0] + ' ' + (parts[1] ? parts[1][0] + '.' : '')),
    );
}

// ----------------------------------------------------------------------------
// Reminders
// ----------------------------------------------------------------------------
function reminders() {
    const overdue  = CC_REMINDERS.filter(r => /Yesterday|10:0|11:0|14:1/.test(r.nextAction));
    const today    = CC_REMINDERS.filter(r => r.nextAction.startsWith('Today'));
    const upcoming = CC_REMINDERS.filter(r => r.nextAction.startsWith('Tomorrow'));
    const buckets = [
        { id: 'overdue',  title: 'Overdue',   kind: 'crit', items: overdue },
        { id: 'today',    title: 'Due today', kind: 'warn', items: today },
        { id: 'upcoming', title: 'Upcoming',  kind: 'info', items: upcoming },
    ];
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        h('div', {
            class: 'card',
            style: { padding: '18px', background: 'linear-gradient(135deg, var(--warn-50), white 60%)' },
        },
            h('div', { class: 'row', style: { gap: '14px' } },
                h('div', { style: { width: '44px', height: '44px', borderRadius: '12px',
                    background: '#fde7c5', display: 'grid', placeItems: 'center', color: 'var(--warn-700)' } },
                    Icon('Repeat', { size: 22 })),
                h('div', { style: { flex: 1 } },
                    h('h3', { style: { margin: 0, fontSize: '15px', color: 'var(--ink-900)' } }, 'How the reminder loop works'),
                    h('p', { class: 'muted', style: { margin: '4px 0 0', fontSize: '12.5px', lineHeight: 1.55 } },
                        'Each call carries a ', h('b', null, 'nextActionAt'), ' while its status is ', h('i', null, 'Active'),
                        '. The system surfaces it to the assigned agent (and auto-dials for predictive campaigns) according to retry policy. Reminders ',
                        h('b', null, 'stop immediately'), ' once the call enters a ', h('i', null, 'Terminal'), ' status: ',
                        Tag('Scheduled',      { kind: 'ok',   dot: true }), ' ',
                        Tag('Not interested', { kind: '',     dot: true }), ' ',
                        Tag('Stopped',        { kind: 'crit', dot: true }), ' ',
                        Tag('Lost',           { kind: 'crit', dot: true }), '.',
                    ),
                ),
                h('div', { class: 'row', style: { gap: '14px' } },
                    retryRule('No-answer policy', '3 retries · 4h apart'),
                    retryRule('Voicemail policy', '1 retry · 24h later'),
                    retryRule('Lost cap',         '5 total attempts'),
                ),
            ),
        ),
        ...buckets.map(b => h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null,
                    h('span', { style: { width: '9px', height: '9px', borderRadius: '999px', background: `var(--${b.kind}-500)`, display: 'inline-block', marginRight: '6px' } }),
                    b.title,
                    h('span', { class: 'h-count', style: { background: `var(--${b.kind}-50)`, color: `var(--${b.kind}-700)` } }, String(b.items.length)),
                ),
            ),
            b.items.length === 0
                ? h('div', { class: 'muted', style: { padding: '18px 22px', fontSize: '13.5px' } }, 'Nothing here. 🎯')
                : h('div', null, ...b.items.map((r, i) => {
                    const parts = r.nextAction.split(' · ');
                    const left  = parts[0] || r.nextAction.split(' ')[0];
                    const right = parts[1] || r.nextAction.split(' ')[1] || '—';
                    return h('div', {
                        class: 'row',
                        style: {
                            padding: '12px 22px',
                            borderTop: i === 0 ? '1px solid var(--ink-100)' : '1px solid var(--ink-50)',
                            gap: '14px', cursor: 'pointer',
                        },
                        onclick: () => openCall(r),
                    },
                        h('div', { style: { width: '56px', textAlign: 'center' } },
                            h('div', { class: 'num', style: { fontSize: '12.5px', color: `var(--${b.kind}-700)`, fontWeight: 700 } }, right),
                            h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, left),
                        ),
                        Avatar({ initials: r.patient.av, color: r.patient.avc, size: 'sm' }),
                        h('div', { style: { flex: 1, minWidth: 0 } },
                            h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, r.patient.name),
                            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                                r.patient.mrn + ' · ' + ccReason(r.reason).label + ' · attempt #' + (r.attempts + 1)),
                        ),
                        statusPill(r.status),
                        agentChip(r.agent),
                        h('div', { class: 'row', style: { gap: '4px' } },
                            h('button', { class: 'btn btn-primary btn-sm', onclick: (e) => e.stopPropagation() },
                                Icon('Phone', { size: 13 }), ' Call now'),
                            h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, title: 'Snooze',   onclick: (e) => e.stopPropagation() }, Icon('Clock', { size: 13 })),
                            h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, title: 'Reassign', onclick: (e) => e.stopPropagation() }, Icon('User',  { size: 13 })),
                        ),
                    );
                })),
        )),
    );
}

function retryRule(label, value) {
    return h('div', null,
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { class: 'num', style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 600, marginTop: '2px' } }, value),
    );
}

// ----------------------------------------------------------------------------
// Agents
// ----------------------------------------------------------------------------
function agents() {
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' } },
        ...CC_AGENTS.map(a => {
            const s = CC_AGENT_STATE[a.state];
            return h('div', { class: 'card', style: { padding: '18px' } },
                h('div', { class: 'row', style: { gap: '12px' } },
                    Avatar({ initials: a.initials, color: a.color }),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { class: 'row', style: { gap: '8px' } },
                            h('span', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, a.name),
                            h('span', {
                                style: {
                                    display: 'inline-flex', gap: '6px', alignItems: 'center',
                                    padding: '2px 8px', borderRadius: '999px',
                                    background: s.bg, color: s.color, fontSize: '12.5px', fontWeight: 700,
                                },
                            },
                                h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: s.color } }),
                                s.label),
                        ),
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, 'Agent · ID ' + a.id.toUpperCase()),
                    ),
                    h('div', { class: 'row', style: { gap: '4px' } },
                        h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, title: 'Listen in' }, Icon('Headset', { size: 13 })),
                        h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' } }, Icon('Dot3', { size: 13 })),
                    ),
                ),
                h('div', { style: { marginTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' } },
                    miniStat('Handled', String(a.handled)),
                    miniStat('Conv.',   a.conv + '%', 'ok'),
                    miniStat('AHT',     a.aht),
                    miniStat('SLA',     a.sla + '%', a.sla >= 90 ? 'ok' : 'warn'),
                ),
                h('div', { style: { marginTop: '12px' } },
                    h('div', { class: 'row', style: { fontSize: '12.5px', marginBottom: '4px' } },
                        h('span', { style: { color: 'var(--ink-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Occupancy'),
                        h('span', { class: 'grow' }),
                        h('span', { class: 'num', style: { color: 'var(--ink-900)', fontWeight: 700 } }, Math.round(a.occ * 100) + '%'),
                    ),
                    h('div', { style: { height: '6px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
                        h('div', {
                            style: {
                                width: (a.occ * 100) + '%', height: '100%',
                                background: a.occ > 0.85 ? 'var(--crit-500)' : a.occ > 0.75 ? 'var(--warn-500)' : 'var(--primary-500)',
                                borderRadius: '999px',
                            },
                        }),
                    ),
                ),
            );
        }),
    );
}

function miniStat(label, value, kind) {
    return h('div', { style: { padding: '8px 10px', borderRadius: '8px', background: 'var(--ink-25)', border: '1px solid var(--ink-100)' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { class: 'num', style: {
            fontSize: '17px', fontWeight: 700, marginTop: '2px',
            color: kind === 'ok' ? 'var(--ok-700)' : kind === 'warn' ? 'var(--warn-700)' : 'var(--ink-900)',
        } }, value),
    );
}

// ----------------------------------------------------------------------------
// Scripts
// ----------------------------------------------------------------------------
function scripts() {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Doc', { size: 16 }), ' Call scripts ', h('span', { class: 'h-count' }, String(CC_SCRIPTS.length))),
            h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus', { size: 14 }), ' New script'),
        ),
        h('div', { style: { padding: '18px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
            ...CC_SCRIPTS.map(s => {
                const r = ccReason(s.reason);
                return h('div', {
                    style: {
                        background: 'white', borderRadius: '12px', border: '1px solid var(--ink-100)',
                        padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px',
                    },
                },
                    h('div', { class: 'row', style: { gap: '8px' } },
                        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: r.color } }),
                        h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: r.color, textTransform: 'uppercase', letterSpacing: '0.06em' } }, r.label),
                        h('span', { class: 'grow' }),
                        Tag(s.conv + '% conv.', { kind: 'ok', dot: true }),
                    ),
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, s.title),
                    h('div', { class: 'row', style: { gap: '12px', fontSize: '12.5px', color: 'var(--ink-600)' } },
                        h('span', null, Icon('Layers', { size: 11 }), ' ', s.steps, ' steps'),
                        h('span', null, Icon('Clock',  { size: 11 }), ' ', s.length),
                        h('span', null, Icon('Phone',  { size: 11 }), ' ', s.used, ' used'),
                    ),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
                        ...CC_SCRIPT_STEPS.slice(0, s.steps).map((st, i) => h('div', { class: 'row', style: { gap: '8px', fontSize: '12.5px', color: 'var(--ink-700)' } },
                            h('span', { style: { width: '18px', height: '18px', borderRadius: '999px', background: 'var(--ink-25)', color: 'var(--ink-600)', display: 'grid', placeItems: 'center', fontSize: '12.5px', fontWeight: 700 } }, String(i + 1)),
                            st,
                        )),
                    ),
                );
            }),
        ),
    );
}

// ----------------------------------------------------------------------------
// Status pill
// ----------------------------------------------------------------------------
function statusPill(status) {
    const m = CC_STATUS[status];
    if (!m) return null;
    return h('span', {
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '2px 8px 2px 7px', borderRadius: '999px',
            background: `color-mix(in oklab, ${m.dot} 10%, white)`,
            color: m.dot,
            border: `1px solid color-mix(in oklab, ${m.dot} 35%, white)`,
            fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
        },
    }, Icon(m.icon, { size: 10 }), ' ', m.label);
}

// ----------------------------------------------------------------------------
// Drawer
// ----------------------------------------------------------------------------
function openCall(c) { state.drawer = c; paint(); }
function closeCall()  { state.drawer = null; paint(); }

function callDrawer(call) {
    const r = ccReason(call.reason);
    const m = CC_STATUS[call.status];
    const ag = CC_AGENTS.find(a => a.initials === call.agent);
    return h('div', { style: { position: 'fixed', inset: 0, zIndex: 100, display: 'flex' } },
        h('div', {
            onclick: closeCall,
            style: { flex: 1, background: 'rgba(11,20,24,0.30)', backdropFilter: 'blur(2px)' },
        }),
        h('div', {
            style: {
                width: '480px', background: 'white', boxShadow: '-10px 0 32px rgba(11,20,24,0.10)',
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
            },
        },
            // Header
            h('div', { style: { padding: '18px 22px 14px', borderBottom: '1px solid var(--ink-100)' } },
                h('div', { class: 'row', style: { gap: '10px' } },
                    h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: r.color, textTransform: 'uppercase', letterSpacing: '0.06em' } }, r.label),
                    h('span', { class: 'grow' }),
                    Tag(call.id),
                    h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, onclick: closeCall }, Icon('X', { size: 14 })),
                ),
                h('div', { class: 'row', style: { gap: '14px', marginTop: '10px' } },
                    Avatar({ initials: call.patient.av, color: call.patient.avc }),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, call.patient.name),
                        h('div', { class: 'muted cell-mono', style: { fontSize: '12.5px' } }, call.patient.mrn + ' · ' + call.patient.age + 'y'),
                    ),
                ),
                h('div', { class: 'row', style: { gap: '6px', marginTop: '12px' } },
                    h('button', { class: 'btn btn-primary btn-sm' }, Icon('Phone', { size: 13 }), ' Call'),
                    h('button', { class: 'btn btn-outline btn-sm', onclick: () => onNavigateRef('patients') },     Icon('User',     { size: 13 }), ' Patient card'),
                    h('button', { class: 'btn btn-outline btn-sm', onclick: () => onNavigateRef('appointments') }, Icon('Calendar', { size: 13 }), ' Schedule'),
                ),
            ),
            // Status row
            h('div', { style: { padding: '14px 22px', background: 'var(--ink-25)', borderBottom: '1px solid var(--ink-100)' } },
                h('div', { class: 'row', style: { gap: '8px' } },
                    h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Current status'),
                    h('span', { class: 'grow' }),
                    h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: m.terminal ? 'var(--ok-700)' : 'var(--warn-700)', textTransform: 'uppercase' } },
                        m.terminal ? '✓ Reminders stopped' : '⟳ Reminders active'),
                ),
                h('div', { class: 'row', style: { gap: '10px', marginTop: '8px' } },
                    h('span', {
                        style: {
                            display: 'inline-flex', alignItems: 'center', gap: '7px',
                            padding: '6px 12px', borderRadius: '8px',
                            background: 'white', border: `1.5px solid ${m.dot}`, color: m.dot,
                            fontSize: '13.5px', fontWeight: 600,
                        },
                    }, Icon(m.icon, { size: 14 }), ' ', m.label),
                    call.nextAction && !m.terminal && h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } },
                        Icon('Clock', { size: 11 }), ' next action ' + call.nextAction),
                ),
            ),
            // Body
            h('div', { style: { padding: '18px 22px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '18px' } },
                call.linkedAppt && h('div', { style: { padding: '12px 14px', background: 'var(--ok-50)', border: '1px solid #c6e7d8', borderRadius: '10px' } },
                    h('div', { class: 'row', style: { gap: '8px' } },
                        Icon('Check', { size: 14 }),
                        h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ok-700)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Appointment linked'),
                    ),
                    h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 600, marginTop: '4px' } }, call.linkedAppt),
                    h('button', { class: 'btn btn-ghost btn-sm', style: { marginTop: '6px', padding: 0, color: 'var(--ok-700)' }, onclick: () => onNavigateRef('appointments') },
                        'Open in Scheduling ', Icon('ArrowRight', { size: 13 })),
                ),
                call.note && h('div', null,
                    h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' } }, 'Agent note'),
                    h('div', { style: { fontSize: '13.5px', color: 'var(--ink-800)', lineHeight: 1.55, padding: '10px 12px', background: 'var(--ink-25)', borderLeft: '3px solid var(--primary-500)', borderRadius: '6px' } }, call.note),
                ),
                h('div', null,
                    h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' } }, 'Call details'),
                    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                        kv('Direction', call.dir === 'in' ? 'Inbound' : 'Outbound'),
                        kv('Agent',     call.agent === '—' ? 'Unassigned' : (ag?.name || call.agent)),
                        kv('Started',   call.startedAt),
                        kv('Duration',  call.duration),
                        kv('Attempts',  String(call.attempts)),
                        kv('Priority',  call.priority, true),
                    ),
                ),
                h('div', null,
                    h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' } }, 'Change status'),
                    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
                        ...Object.entries(CC_STATUS).map(([id, meta]) => {
                            const on = call.status === id;
                            return h('button', {
                                onclick: () => {
                                    const target = CC_CALLS.find(c => c.id === call.id);
                                    if (target) { target.status = id; state.drawer = target; paint(); }
                                },
                                style: {
                                    padding: '6px 10px', borderRadius: '999px', cursor: 'pointer',
                                    border: '1px solid ' + (on ? meta.dot : 'var(--ink-100)'),
                                    background: on ? `color-mix(in oklab, ${meta.dot} 12%, white)` : 'white',
                                    color: on ? meta.dot : 'var(--ink-700)',
                                    fontSize: '12.5px', fontWeight: 600, fontFamily: 'inherit',
                                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                                },
                            },
                                h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: meta.dot } }),
                                meta.label,
                                meta.terminal && Icon('Check', { size: 10 }),
                            );
                        }),
                    ),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } },
                        'Terminal statuses (✓) stop the reminder loop immediately.'),
                ),
                h('div', null,
                    h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' } }, 'Activity'),
                    timeline([
                        { t: 'now',          text: 'Status set to ' + m.label, by: call.agent === '—' ? 'System' : (ag?.name || call.agent), dot: m.dot },
                        { t: call.startedAt, text: (call.dir === 'in' ? 'Inbound call ' : 'Outbound call ') + (call.duration === '0:00' ? '(no answer)' : '· ' + call.duration), by: 'System', dot: 'var(--info-500)' },
                        { t: '-1d',          text: 'Created from ' + r.label + ' campaign', by: 'CRM · auto', dot: 'var(--ink-300)' },
                    ]),
                ),
            ),
            // Footer
            h('div', { style: { padding: '14px 22px', borderTop: '1px solid var(--ink-100)', background: 'white' } },
                h('div', { class: 'row', style: { gap: '8px' } },
                    h('button', { class: 'btn btn-outline btn-sm', style: { flex: 1, justifyContent: 'center' } }, Icon('Pause',    { size: 13 }), ' Snooze 2h'),
                    h('button', { class: 'btn btn-outline btn-sm', style: { flex: 1, justifyContent: 'center' } }, Icon('User',     { size: 13 }), ' Reassign'),
                    h('button', { class: 'btn btn-primary btn-sm', style: { flex: 1.4, justifyContent: 'center' } }, Icon('Calendar', { size: 13 }), ' Book appointment'),
                ),
            ),
        ),
    );
}

function kv(label, value, capitalize) {
    return h('div', { style: { padding: '8px 10px', background: 'var(--ink-25)', borderRadius: '8px', border: '1px solid var(--ink-100)' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 600, marginTop: '2px', textTransform: capitalize ? 'capitalize' : 'none' } }, value),
    );
}

function timeline(items) {
    return h('div', { style: { position: 'relative', paddingLeft: '18px' } },
        h('div', { style: { position: 'absolute', left: '5px', top: '4px', bottom: '4px', width: '1px', background: 'var(--ink-100)' } }),
        ...items.map((it, i) => h('div', { style: { position: 'relative', paddingBottom: i === items.length - 1 ? 0 : '12px' } },
            h('span', { style: {
                position: 'absolute', left: '-18px', top: '3px', width: '10px', height: '10px', borderRadius: '999px',
                background: it.dot, border: '2px solid white', boxShadow: '0 0 0 1px var(--ink-100)',
            } }),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('span', { style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 500 } }, it.text),
                h('span', { class: 'grow' }),
                h('span', { class: 'muted num', style: { fontSize: '12.5px' } }, it.t),
            ),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, 'by ' + it.by),
        )),
    );
}

// ----------------------------------------------------------------------------
// Local copies of donut() + stackedBars() (kept tiny, no dep on marketing.js)
// ----------------------------------------------------------------------------
function donut(segments, size = 140, stroke = 20, centerLabel, centerSub) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    const r = size / 2 - stroke / 2;
    const c = 2 * Math.PI * r;
    let acc = 0;
    const parts = segments.map(seg => {
        const frac = seg.value / total;
        const len  = c * frac;
        const off  = c * acc;
        acc += frac;
        return `<circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${seg.color}" stroke-width="${stroke}" fill="none" stroke-dasharray="${len} ${c-len}" stroke-dashoffset="${-off}"/>`;
    });
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = wrap.style.height = size + 'px';
    wrap.innerHTML = `<svg width="${size}" height="${size}" style="transform: rotate(-90deg)">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="var(--ink-100)" stroke-width="${stroke}" fill="none"/>
        ${parts.join('')}
    </svg>`;
    wrap.appendChild(h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' } },
        h('div', { style: { textAlign: 'center' } },
            h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' } }, centerLabel),
            h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, centerSub),
        ),
    ));
    return wrap;
}

function stackedBars(labels, series) {
    const n = labels.length, w = 660, hgt = 130, gap = 4;
    const bw = (w - gap * (n - 1)) / n;
    const totals = labels.map((_, i) => series.reduce((s, ss) => s + ss.data[i], 0));
    const max = Math.max(...totals);
    let svg = `<svg width="100%" height="${hgt + 20}" viewBox="0 0 ${w} ${hgt + 20}" preserveAspectRatio="xMidYMid meet">`;
    for (let i = 0; i < labels.length; i++) {
        const x = i * (bw + gap);
        let y = hgt;
        svg += `<g>`;
        for (const ss of series) {
            const bh = (ss.data[i] / max) * hgt;
            y -= bh;
            svg += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${ss.color}"/>`;
        }
        svg += `<text x="${x + bw/2}" y="${hgt + 14}" text-anchor="middle" font-size="12.5" fill="var(--ink-400)" font-family="var(--font-mono)">${labels[i]}</text></g>`;
    }
    svg += `</svg>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = svg;
    return wrap;
}
