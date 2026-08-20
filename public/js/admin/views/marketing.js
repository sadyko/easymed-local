// Marketing module — ported from "Marketing module/Easy-Med HIS.html".
// Two top-level pages (page-tab), each with their own sub-tabs:
//
//   Plans & operations  — for the marketing team
//       · Dashboard   (KPIs + funnel + channel efficiency + team workload)
//       · Workspace   (Kanban: Backlog / In progress / In review / Done)
//       · Campaigns   (campaigns table with channels, budget, leads)
//       · Budget      (month envelope + per-channel allocation + approvals)
//
//   Patient notifications  — automations + segments + templates
//       · Dashboard   (KPIs + channel mix donut + top automations)
//       · Automations (list of running automations + segment chips)
//       · Segments    (live segment builder with audience preview)
//       · Templates   (message library)
//
// This is a static-demo build (no DB yet). All data lives in the *_DATA
// constants below and matches the original prototype 1:1 so the user gets
// the same look & numbers.

import { h, Icon, PageHead, Tag, Avatar, Spark, Delta, Ring, clear, toast, fmtDateTime } from '../ui.js';
import { supabase } from '../../supabase.js';
import { canDelete } from '../permissions.js';

// ============================================================================
// State
// ============================================================================
const state = {
    page:        'plans',         // 'plans' | 'notifications'
    plansTab:    'dashboard',     // 'dashboard' | 'workspace' | 'campaigns' | 'budget'
    notifTab:    'dashboard',     // 'dashboard' | 'automations' | 'segments' | 'templates' | 'messages'
    segment: {
        age:      [35, 75],
        doctor:   'Cardiology',
        visit:    '180–365 days',
        gender:   'any',
        channels: new Set(['tgbot', 'sms']),
    },
    // DB-backed data — loaded lazily.
    notif: {
        loaded:    false,
        templates: [],     // notification_templates rows
        messages:  [],     // notification_messages rows (recent)
    },
    mk: {
        loaded: false,
        tasks:  [],        // marketing_tasks rows
        filter: 'all',     // 'all' | 'high' (Workspace tab filter)
    },
};

let containerRef = null;
// Fade in only when the view is freshly opened — not on every filter-driven
// repaint, which would restart the animation and make the panel blink.
let firstPaint = true;

export function renderMarketing(container) {
    containerRef = container;
    firstPaint = true;
    paint();
    // Lazy-load both DB-backed datasets on first open. Each call to paint()
    // after the load reflects fresh data.
    if (!state.notif.loaded) loadNotifData().then(() => paint());
    if (!state.mk.loaded)    loadMarketingData().then(() => paint());
}

async function loadMarketingData() {
    const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1 — scope to this clinic (super-admin JWT passes RLS everywhere)
    const { data, error } = await supabase
        .from('marketing_tasks')
        .select('*')
        .eq('company_id', cid)
        .order('status', { ascending: true })
        .order('sort_order', { ascending: true });
    if (error) {
        console.warn('[marketing] tasks load failed:', error.message);
        if (/relation .* does not exist|could not find the table|schema cache/i.test(error.message)) {
            toast('Apply migration 016_marketing_tasks.sql in Supabase first.', 'fail');
        }
        state.mk.tasks = [];
    } else {
        state.mk.tasks = data || [];
    }
    state.mk.loaded = true;
}

async function loadNotifData() {
    const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1
    const [tpls, msgs] = await Promise.all([
        supabase.from('notification_templates').select('*').eq('company_id', cid).order('created_at', { ascending: false }),
        supabase.from('notification_messages')
            .select('id, automation_id, template_id, patient_id, channel, address, subject, body, status, queued_at, sent_at, error, patients(full_name, last_name, first_name, mrn, phone)')
            .eq('company_id', cid)
            .order('queued_at', { ascending: false }).limit(200),
    ]);
    if (tpls.error) {
        console.warn('[marketing] templates load failed:', tpls.error.message);
        if (/relation .* does not exist|could not find the table|schema cache/i.test(tpls.error.message)) {
            toast('Apply migration 015_notifications.sql in Supabase first.', 'fail');
        }
        state.notif.templates = [];
    } else state.notif.templates = tpls.data || [];
    state.notif.messages = msgs.error ? [] : (msgs.data || []);
    state.notif.loaded = true;
}

function paint() {
    clear(containerRef);
    const isPlans = state.page === 'plans';
    const rootClass = firstPaint ? 'fade-in' : '';
    firstPaint = false;
    containerRef.appendChild(h('div', { class: rootClass, style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        // Page-level pill switch + page-specific header
        h('div', { class: 'row', style: { gap: '8px' } },
            pagePill('plans',         'Plans & operations',    'Megaphone'),
            pagePill('notifications', 'Patient notifications', 'Bell'),
        ),
        isPlans ? plansPage() : notificationsPage(),
    ));
}

function pagePill(id, label, icon) {
    const on = state.page === id;
    return h('button', {
        type: 'button',
        onclick: () => { if (state.page !== id) { state.page = id; paint(); } },
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '8px 16px', borderRadius: '999px',
            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
            background: on ? 'var(--primary-50)' : 'white',
            color: on ? 'var(--primary-700)' : 'var(--ink-700)',
            fontWeight: on ? 600 : 500, fontSize: '13.5px',
            cursor: 'pointer', fontFamily: 'inherit',
        },
    }, Icon(icon, { size: 14 }), label);
}

// ============================================================================
// PLANS & OPERATIONS
// ============================================================================

// ---- Demo data ------------------------------------------------------------
const MK_KPI = {
    bookings:    412, bookingTrend: [220,260,255,290,310,340,360,355,380,405,395,412],
    leads:      1284, leadsTrend:   [80,95,110,130,140,160,180,170,210,230,250,284],
    spendMTD:  148.8, spendTrend:   [12,18,16,22,20,28,26,30,32,34,36,38],
    roas:        3.4, roasTrend:    [2.1,2.4,2.6,2.5,2.8,3.0,3.1,3.0,3.2,3.3,3.4,3.4],
};

const MK_CHANNELS = [
    { id: 'tg',   name: 'Telegram',        budget: 60, spent: 42, leads: 380, color: 'var(--info-500)',    icon: 'Send' },
    { id: 'ig',   name: 'Instagram ads',   budget: 55, spent: 38, leads: 290, color: '#ec4899',            icon: 'Camera' },
    { id: 'gads', name: 'Google ads',      budget: 50, spent: 36, leads: 240, color: 'var(--ok-500)',      icon: 'Globe' },
    { id: 'ooh',  name: 'OOH / billboards',budget: 35, spent: 18, leads:  96, color: 'var(--warn-500)',    icon: 'Flag' },
    { id: 'part', name: 'Partnerships',    budget: 25, spent: 11, leads: 180, color: 'var(--purple-500)',  icon: 'Building' },
    { id: 'cont', name: 'Content / SEO',   budget: 15, spent:  4, leads:  98, color: 'var(--primary-500)', icon: 'Doc' },
];

// Tasks live in the marketing_tasks table (migration 016) — loaded into
// state.mk.tasks by loadMarketingData(). The original 11-row seed lives in
// the migration's INSERT so a fresh install still shows the demo board.

// Column scaffolding only — actual tasks come from state.mk.tasks (DB).
const MK_COLS = [
    { id: 'backlog', title: 'Backlog',     color: 'var(--ink-400)' },
    { id: 'wip',     title: 'In progress', color: 'var(--info-500)' },
    { id: 'review',  title: 'In review',   color: 'var(--warn-500)' },
    { id: 'done',    title: 'Done',        color: 'var(--ok-500)' },
];

// `liveTasks()` honours the Workspace filter chips (All / High priority).
function liveTasks() {
    const all = state.mk.tasks || [];
    if (state.mk.filter === 'high') return all.filter(t => t.priority === 'high');
    return all;
}

const MK_CAMPAIGNS = [
    { name: 'Spring check-up · families',   channels: ['ig','tg'],     owner: 'AK', oc: 'av-2', status: 'in-progress', budget: 32, spent: 24, leads: 162, start: 'May 12', end: 'Jun 10' },
    { name: 'Cardiology · 40+ awareness',   channels: ['gads','cont'], owner: 'DJ', oc: 'av-5', status: 'in-progress', budget: 28, spent: 19, leads: 124, start: 'May 05', end: 'Jun 30' },
    { name: 'Pediatrics summer push',       channels: ['ig','part'],   owner: 'NS', oc: 'av-4', status: 'scheduled',   budget: 22, spent:  3, leads:  18, start: 'Jun 01', end: 'Aug 15' },
    { name: 'Lab — book online (Telegram)', channels: ['tg'],          owner: 'AK', oc: 'av-2', status: 'in-progress', budget: 18, spent: 14, leads: 285, start: 'Apr 20', end: 'Jun 20' },
    { name: 'OOH · Chilonzor district',     channels: ['ooh'],         owner: 'RX', oc: 'av-3', status: 'scheduled',   budget: 35, spent:  0, leads:   0, start: 'Jun 10', end: 'Aug 10' },
    { name: 'Annual check-up reminders',    channels: ['cont','tg'],   owner: 'MT', oc: 'av-7', status: 'completed',   budget: 12, spent: 12, leads: 410, start: 'Mar 01', end: 'May 15' },
];

const MK_TEAM = [
    { name: 'A. Karimova',  role: 'Marketing lead',     initials: 'AK', color: 'av-2', open: 4, done: 18, load: 0.78 },
    { name: 'N. Sodiqova',  role: 'Content & email',    initials: 'NS', color: 'av-4', open: 3, done: 14, load: 0.55 },
    { name: 'D. Juraev',    role: 'Performance / web',  initials: 'DJ', color: 'av-5', open: 5, done: 22, load: 0.92 },
    { name: 'R. Xolmatov',  role: 'Creative / OOH',     initials: 'RX', color: 'av-3', open: 3, done: 11, load: 0.64 },
    { name: 'M. Tursunova', role: 'Analytics',          initials: 'MT', color: 'av-7', open: 2, done:  9, load: 0.42 },
];

const PRIO_STYLE = {
    high: { bg: 'var(--crit-50)', fg: 'var(--crit-700)', label: 'High' },
    med:  { bg: 'var(--warn-50)', fg: 'var(--warn-700)', label: 'Med' },
    low:  { bg: 'var(--ink-50)',  fg: 'var(--ink-600)',  label: 'Low' },
};

const channelMeta = (id) => MK_CHANNELS.find(c => c.id === id);

// ---- Plans router ---------------------------------------------------------
function plansPage() {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Marketing · Plans & operations',
            subtitle: 'Campaign pipeline, team workload, and budget — for the marketing team.',
            right: [
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Download', { size: 14 }), ' Export'),
                h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus',     { size: 14 }), ' New campaign'),
            ],
        }),
        h('div', { class: 'tabs' },
            subTab('plansTab', 'dashboard',  'Dashboard',  'Dashboard'),
            subTab('plansTab', 'workspace',  'Workspace',  'Layers',   liveTasks().length),
            subTab('plansTab', 'campaigns',  'Campaigns',  'Megaphone',MK_CAMPAIGNS.length),
            subTab('plansTab', 'budget',     'Budget',     'Wallet'),
        ),
        state.plansTab === 'dashboard' ? plansDashboard()
        : state.plansTab === 'workspace' ? plansWorkspace()
        : state.plansTab === 'campaigns' ? plansCampaigns()
        : plansBudget(),
    );
}

function subTab(stateKey, id, label, icon, count) {
    const on = state[stateKey] === id;
    return h('button', {
        class: 'tab' + (on ? ' on' : ''),
        onclick: () => { if (!on) { state[stateKey] = id; paint(); } },
    }, Icon(icon, { size: 14 }), ' ', label,
        count != null && h('span', { class: 'tab-count' }, String(count)),
    );
}

// ---- Plans · Dashboard ----------------------------------------------------
function plansDashboard() {
    const k = MK_KPI;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // KPIs
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
            kpiTile('Bookings driven',  k.bookings,            '',      +14,  k.bookingTrend,                'var(--primary-600)', 'Target'),
            kpiTile('Qualified leads',  k.leads.toLocaleString('ru-RU'),'',    +22,  k.leadsTrend,                  'var(--info-500)',    'Patients'),
            kpiTile('Spend · MTD',      k.spendMTD,            'M UZS', +6,   k.spendTrend,                  'var(--warn-500)',    'Wallet'),
            kpiTile('ROAS',             k.roas,                '×',     +0.3, k.roasTrend.map(v => v * 100), 'var(--ok-500)',      'Trend', ''),
        ),
        // Funnel + Channel efficiency
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '16px' } },
            cardBox('Acquisition funnel · May', 'Target',
                h('div', { class: 'segmented', style: { marginLeft: 'auto' } },
                    h('button', null, '7d'), h('button', { class: 'on' }, 'MTD'), h('button', null, 'QTD'),
                ),
                h('div', { style: { padding: '18px 22px 22px' } }, funnel([
                    { label: 'Impressions',         value: 2840000, color: 'var(--info-500)' },
                    { label: 'Clicks / visits',     value:  142300, color: '#06b6d4' },
                    { label: 'Leads',               value:    1284, color: 'var(--purple-500)' },
                    { label: 'Booked appointments', value:     412, color: 'var(--primary-600)' },
                    { label: 'Showed up',           value:     338, color: 'var(--ok-500)' },
                ])),
            ),
            cardBox('Channel efficiency', 'Chart',
                h('span', { class: 'muted', style: { fontSize: '12px' } }, 'cost per lead'),
                h('div', { style: { padding: '10px 4px 6px' } }, ...MK_CHANNELS.map(c => {
                    const cpl = c.leads ? Math.round((c.spent * 1_000_000) / c.leads) : 0;
                    const max = Math.max(...MK_CHANNELS.map(x => x.leads));
                    const w = (c.leads / max) * 100;
                    return h('div', { class: 'row', style: { padding: '8px 18px', gap: '12px' } },
                        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: c.color } }),
                        h('div', { style: { minWidth: '110px', fontSize: '12.5px', fontWeight: 500, color: 'var(--ink-800)' } }, c.name),
                        h('div', { style: { flex: 1, height: '8px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
                            h('div', { style: { width: w + '%', height: '100%', background: c.color, borderRadius: '999px' } })),
                        h('div', { class: 'num', style: { width: '56px', textAlign: 'right', fontSize: '12px', color: 'var(--ink-700)', fontWeight: 600 } }, String(c.leads)),
                        h('div', { class: 'num muted', style: { width: '72px', textAlign: 'right', fontSize: '11.5px' } }, (cpl/1000).toFixed(1) + 'k'),
                    );
                })),
            ),
        ),
        // Team + pipeline
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '16px' } },
            cardBox('Team workload', 'Patients',
                h('span', { class: 'h-count' }, String(MK_TEAM.length)),
                h('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: 'auto' } }, 'Reassign ', Icon('ArrowRight', { size: 14 })),
                h('div', { style: { padding: '4px 4px 8px' } }, ...MK_TEAM.map(t => h('div', { class: 'row', style: { padding: '10px 18px', gap: '12px' } },
                    Avatar({ initials: t.initials, color: t.color }),
                    h('div', { style: { minWidth: 0, flex: '0 0 200px' } },
                        h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, t.name),
                        h('div', { class: 'muted', style: { fontSize: '11.5px' } }, t.role),
                    ),
                    h('div', { style: { minWidth: 0, flex: 1 } },
                        h('div', { class: 'row', style: { fontSize: '11px', color: 'var(--ink-500)', marginBottom: '3px' } },
                            h('span', null, 'Load'),
                            h('span', { class: 'grow' }),
                            h('span', { class: 'num', style: { color: 'var(--ink-800)', fontWeight: 600 } }, Math.round(t.load * 100) + '%'),
                        ),
                        h('div', { style: { height: '5px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
                            h('div', { style: { width: (t.load * 100) + '%', height: '100%',
                                background: t.load > 0.85 ? 'var(--crit-500)' : t.load > 0.7 ? 'var(--warn-500)' : 'var(--primary-500)',
                                borderRadius: '999px' } })),
                    ),
                    h('div', { class: 'num', style: { width: '90px', textAlign: 'right', fontSize: '12px' } },
                        h('span', { style: { color: 'var(--ink-900)', fontWeight: 600 } }, String(t.open)),
                        h('span', { class: 'muted' }, '/' + (t.open + t.done)),
                        h('div', { class: 'muted', style: { fontSize: '10.5px', marginTop: '1px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'open · total'),
                    ),
                ))),
            ),
            cardBox('Pipeline health', 'Activity',
                h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, 'this week'),
                h('div', { style: { padding: '18px 22px', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px' } },
                    ...MK_COLS.map(col => {
                        const count = state.mk.tasks.filter(t => t.status === col.id).length;
                        return h('div', {
                            style: { background: 'var(--ink-25)', borderRadius: '10px', padding: '12px 14px', border: '1px solid var(--ink-100)' },
                        },
                            h('div', { class: 'row', style: { marginBottom: '6px' } },
                                h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: col.color } }),
                                h('span', { style: { fontSize: '11px', color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 } }, col.title),
                            ),
                            h('div', { class: 'num', style: { fontSize: '26px', fontWeight: 700, color: 'var(--ink-900)' } }, String(count)),
                        );
                    }),
                ),
                h('div', { style: { padding: '4px 22px 18px', display: 'flex', flexDirection: 'column', gap: '10px' } },
                    callout('ok',   'On track',  '6 campaigns delivering ≥ROAS target'),
                    callout('warn', 'At risk',   'OOH · Chilonzor — vendor approval pending 4d'),
                    callout('info', 'Insight',   'Telegram leads converting 2.3× vs. Instagram'),
                ),
            ),
        ),
    );
}

// ---- Plans · Workspace (Kanban) ------------------------------------------
// Tasks live in marketing_tasks. Cards are draggable between columns,
// drop → updates `status` in the DB. Click a card to edit/delete.
// "Add card" / "+ Task" opens the same editor with status pre-set.
function plansWorkspace() {
    const filtered = liveTasks();
    return h('div', { class: 'card', style: { padding: '18px 18px 22px' } },
        h('div', { class: 'row', style: { marginBottom: '14px' } },
            h('h3', { style: { margin: 0, fontSize: '14.5px', color: 'var(--ink-900)' } }, 'Team kanban · ', String(filtered.length), ' tasks'),
            h('span', { class: 'grow' }),
            h('div', { class: 'segmented' },
                wsFilter('all',  'All'),
                wsFilter('high', 'High priority'),
            ),
            h('button', { class: 'btn btn-primary btn-sm', style: { marginLeft: '8px' },
                onclick: () => openTaskEditor(null) }, Icon('Plus', { size: 14 }), ' Task'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
            ...MK_COLS.map(col => {
                const tasks = filtered.filter(t => t.status === col.id);
                return h('div', {
                    style: { background: 'var(--ink-25)', border: '1px solid var(--ink-100)', borderRadius: '12px',
                             padding: '12px 12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '360px' },
                    ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.style.background = 'var(--primary-50)'; },
                    ondragleave: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; },
                    ondrop: (ev) => {
                        ev.preventDefault();
                        ev.currentTarget.style.background = 'var(--ink-25)';
                        const id = ev.dataTransfer.getData('text/plain');
                        if (id) moveTask(id, col.id);
                    },
                },
                    h('div', { class: 'row', style: { padding: '0 4px 4px' } },
                        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: col.color } }),
                        h('span', { style: { fontSize: '12px', fontWeight: 700, color: 'var(--ink-800)', textTransform: 'uppercase', letterSpacing: '0.05em' } }, col.title),
                        h('span', { class: 'grow' }),
                        h('span', { style: { fontSize: '11.5px', color: 'var(--ink-500)', fontWeight: 600, background: 'white', padding: '1px 7px', borderRadius: '999px', border: '1px solid var(--ink-100)' } }, String(tasks.length)),
                    ),
                    ...tasks.map(t => taskCard(t)),
                    h('button', { class: 'btn btn-ghost btn-sm',
                        style: { justifyContent: 'center', marginTop: 'auto', color: 'var(--ink-500)' },
                        onclick: () => openTaskEditor({ status: col.id }),
                    }, Icon('Plus', { size: 13 }), ' Add card'),
                );
            }),
        ),
    );
}

function wsFilter(id, label) {
    const on = state.mk.filter === id;
    return h('button', {
        class: on ? 'on' : '',
        onclick: () => { if (state.mk.filter !== id) { state.mk.filter = id; paint(); } },
    }, label);
}

function taskCard(t) {
    const p = PRIO_STYLE[t.priority] || PRIO_STYLE.med;
    const dueLabel = t.due_date ? new Date(t.due_date).toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) : '';
    const dueOverdue = t.due_date && new Date(t.due_date) < new Date(new Date().toDateString()) && t.status !== 'done';
    return h('div', {
        draggable: 'true',
        ondragstart: (ev) => {
            ev.dataTransfer.setData('text/plain', t.id);
            ev.dataTransfer.effectAllowed = 'move';
            ev.currentTarget.style.opacity = '0.5';
        },
        ondragend: (ev) => { ev.currentTarget.style.opacity = '1'; },
        onclick: () => openTaskEditor(t),
        style: { background: 'white', border: '1px solid var(--ink-100)', borderRadius: '10px',
            padding: '12px 12px 11px', boxShadow: '0 1px 2px rgba(11,20,24,0.04)',
            cursor: 'grab', userSelect: 'none' },
        onmouseenter: (ev) => { ev.currentTarget.style.borderColor = 'var(--primary-300)'; ev.currentTarget.style.boxShadow = '0 2px 6px rgba(11,20,24,0.08)'; },
        onmouseleave: (ev) => { ev.currentTarget.style.borderColor = 'var(--ink-100)'; ev.currentTarget.style.boxShadow = '0 1px 2px rgba(11,20,24,0.04)'; },
    },
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.35, marginBottom: '9px' } }, t.title),
        h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
            t.tag && Tag(t.tag, { kind: t.tag_kind || '' }),
            h('span', { style: { fontSize: '10.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px',
                background: p.bg, color: p.fg, textTransform: 'uppercase', letterSpacing: '0.04em' } }, p.label),
        ),
        h('div', { class: 'row', style: { gap: '6px' } },
            t.owner_initials && Avatar({ initials: t.owner_initials, color: t.owner_color || 'av-1', size: 'sm' }),
            h('span', { class: 'grow' }),
            dueLabel && h('span', {
                class: 'muted', style: { fontSize: '11.5px', display: 'inline-flex', alignItems: 'center', gap: '4px',
                    color: dueOverdue ? 'var(--crit-700)' : undefined, fontWeight: dueOverdue ? 600 : 400 },
            }, Icon('Clock', { size: 11 }), ' ', dueLabel),
        ),
    );
}

// ---- Task editor + move helpers ------------------------------------------
async function moveTask(id, newStatus) {
    const t = state.mk.tasks.find(x => x.id === id);
    if (!t || t.status === newStatus) return;
    const prev = t.status;
    t.status = newStatus;     // optimistic
    paint();
    const { error } = await supabase.from('marketing_tasks')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) {
        t.status = prev;
        toast(error.message, 'fail');
        paint();
        return;
    }
    toast(`Moved to ${MK_COLS.find(c => c.id === newStatus)?.title || newStatus}.`);
}

function openTaskEditor(existing) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const isNew = !existing || !existing.id;
    const titleInput = h('input', { value: existing?.title || '', placeholder: 'Spring check-up — creative' });
    const descInput  = h('textarea', { rows: '3', placeholder: 'Optional notes / acceptance criteria' });
    if (existing?.description) descInput.value = existing.description;

    const statusSel = h('select', null,
        ...MK_COLS.map(c => h('option', { value: c.id, selected: (existing?.status || 'backlog') === c.id }, c.title)),
    );
    const prioSel = h('select', null,
        h('option', { value: 'high', selected: existing?.priority === 'high' }, 'High'),
        h('option', { value: 'med',  selected: !existing || existing?.priority === 'med' }, 'Med'),
        h('option', { value: 'low',  selected: existing?.priority === 'low' }, 'Low'),
    );

    const tagInput     = h('input', { value: existing?.tag || '', placeholder: 'e.g. Instagram, Telegram, Web…' });
    const tagKindSel   = h('select', null,
        ...[['', 'gray'], ['info', 'blue'], ['ok', 'green'], ['warn', 'amber'], ['crit', 'red'], ['teal', 'teal'], ['purple', 'purple']]
            .map(([v, l]) => h('option', { value: v, selected: (existing?.tag_kind || '') === v }, l)),
    );
    const channelSel = h('select', null,
        h('option', { value: '' }, '—'),
        ...MK_CHANNELS.map(c => h('option', { value: c.id, selected: existing?.channel === c.id }, c.name)),
    );

    const ownerInitInput = h('input', { value: existing?.owner_initials || '', placeholder: 'AK', maxLength: '4', style: { width: '80px' } });
    const ownerColorSel  = h('select', null,
        ...['av-1','av-2','av-3','av-4','av-5','av-6','av-7','av-8'].map(c =>
            h('option', { value: c, selected: (existing?.owner_color || 'av-1') === c }, c)),
    );
    const dueInput = h('input', { type: 'date', value: existing?.due_date ? String(existing.due_date).slice(0, 10) : '' });

    const card = h('div', { class: 'modal-card', style: { width: '560px' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Layers', { size: 16 }), ' ', isNew ? 'New task' : 'Edit task'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { class: 'field' }, h('label', null, 'Title ', h('span', { style: { color: 'var(--crit-500)' } }, '*')), titleInput),
            h('div', { class: 'field' }, h('label', null, 'Description'), descInput),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Status'),   statusSel),
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Priority'), prioSel),
            ),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Tag label'), tagInput),
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Tag colour'), tagKindSel),
            ),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Channel'), channelSel),
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Due date'), dueInput),
            ),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Owner initials'), ownerInitInput),
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Avatar colour'), ownerColorSel),
            ),
        ),
        h('footer', { class: 'modal-foot' },
            !isNew && canDelete('marketing') && h('button', { class: 'btn btn-danger',
                onclick: async () => {
                    if (!confirm(`Delete "${existing.title}"?`)) return;
                    const { error } = await supabase.from('marketing_tasks').delete().eq('id', existing.id);
                    if (error) { toast(error.message, 'fail'); return; }
                    await loadMarketingData(); paint(); close();
                    toast('Task deleted.');
                },
            }, Icon('Trash', { size: 14 }), ' Delete'),
            h('button', { class: 'btn', onclick: close }, 'Cancel'),   // BTNS_RIGHT_V1 — grow removed, Delete joins the right group
            h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                ev.target.disabled = true;
                try {
                    const payload = {
                        title:          titleInput.value.trim(),
                        description:    descInput.value.trim() || null,
                        status:         statusSel.value,
                        priority:       prioSel.value,
                        tag:            tagInput.value.trim() || null,
                        tag_kind:       tagKindSel.value || null,
                        channel:        channelSel.value || null,
                        owner_initials: ownerInitInput.value.trim().toUpperCase() || null,
                        owner_color:    ownerColorSel.value,
                        due_date:       dueInput.value || null,
                        updated_at:     new Date().toISOString(),
                    };
                    if (!payload.title) { toast('Title is required.', 'fail'); return; }
                    let err;
                    if (isNew) ({ error: err } = await supabase.from('marketing_tasks').insert(payload));
                    else       ({ error: err } = await supabase.from('marketing_tasks').update(payload).eq('id', existing.id));
                    if (err) { toast(err.message, 'fail'); return; }
                    await loadMarketingData(); paint(); close();
                    toast(isNew ? 'Task created.' : 'Task updated.');
                } finally { ev.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Save'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => titleInput.focus(), 30);
}

// ---- Plans · Campaigns ----------------------------------------------------
function plansCampaigns() {
    const statusKind = s => ({ 'in-progress': 'info', 'scheduled': 'warn', 'completed': 'ok' }[s] || '');
    const statusText = s => ({ 'in-progress': 'Running', 'scheduled': 'Scheduled', 'completed': 'Completed' }[s] || s);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Megaphone', { size: 16 }), ' Campaigns ', h('span', { class: 'h-count' }, String(MK_CAMPAIGNS.length))),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('div', { class: 'segmented' }, h('button', { class: 'on' }, 'All'), h('button', null, 'Running'), h('button', null, 'Scheduled'), h('button', null, 'Done')),
                h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus', { size: 14 }), ' Campaign'),
            ),
        ),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Campaign'), h('th', null, 'Channels'), h('th', null, 'Owner'),
                h('th', null, 'Dates'), h('th', null, 'Budget'), h('th', null, 'Leads'), h('th', null, 'Status'), h('th', null),
            )),
            h('tbody', null, ...MK_CAMPAIGNS.map(c => {
                const pct = Math.round((c.spent / c.budget) * 100);
                return h('tr', null,
                    h('td', { class: 'cell-strong' }, c.name),
                    h('td', null,
                        h('div', { class: 'row', style: { gap: '4px' } },
                            ...c.channels.map(ch => {
                                const m = channelMeta(ch);
                                return h('span', { title: m.name, style: { width: '22px', height: '22px', borderRadius: '6px', background: m.color, opacity: 0.18, display: 'grid', placeItems: 'center' } },
                                    h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: m.color } }));
                            }),
                            h('span', { class: 'muted', style: { fontSize: '11.5px', marginLeft: '4px' } },
                                c.channels.map(x => channelMeta(x).name).join(', ')),
                        ),
                    ),
                    h('td', null, Avatar({ initials: c.owner, color: c.oc, size: 'sm' })),
                    h('td', { class: 'muted num', style: { fontSize: '12px' } }, c.start + ' → ' + c.end),
                    h('td', { style: { width: '160px' } },
                        h('div', { class: 'row', style: { fontSize: '11.5px', marginBottom: '3px' } },
                            h('span', { class: 'num', style: { color: 'var(--ink-800)', fontWeight: 600 } }, c.spent + 'M'),
                            h('span', { class: 'muted' }, '/' + c.budget + 'M UZS'),
                            h('span', { class: 'grow' }),
                            h('span', { class: 'num muted' }, pct + '%'),
                        ),
                        h('div', { style: { height: '5px', background: 'var(--ink-100)', borderRadius: '999px' } },
                            h('div', { style: { width: pct + '%', height: '100%',
                                background: pct > 90 ? 'var(--crit-500)' : 'var(--primary-500)', borderRadius: '999px' } })),
                    ),
                    h('td', { class: 'cell-strong num' }, String(c.leads)),
                    h('td', null, Tag(statusText(c.status), { kind: statusKind(c.status), dot: true })),
                    h('td', null, h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' } }, Icon('Dot3', { size: 14 }))),
                );
            })),
        ),
    );
}

// ---- Plans · Budget -------------------------------------------------------
function plansBudget() {
    const total = MK_CHANNELS.reduce((s, c) => s + c.budget, 0);
    const spent = MK_CHANNELS.reduce((s, c) => s + c.spent, 0);
    const pct = Math.round((spent / total) * 100);
    const approvals = [
        { who: 'D. Juraev',   what: 'Google ads · +8M boost',     amount: '+8M',  state: 'pending' },
        { who: 'R. Xolmatov', what: 'OOH · Chilonzor extension',  amount: '+12M', state: 'pending' },
        { who: 'A. Karimova', what: 'Influencer · pediatrics',    amount: '+5M',  state: 'approved' },
    ];
    return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.7fr', gap: '16px' } },
        // Envelope
        h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, 'May budget · UZS'),
            h('div', { class: 'num', style: { fontSize: '34px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em', margin: '6px 0 12px' } },
                spent + 'M ', h('span', { style: { fontSize: '16px', color: 'var(--ink-400)', fontWeight: 500 } }, '/ ' + total + 'M')),
            h('div', { style: { height: '10px', background: 'var(--ink-100)', borderRadius: '999px', marginBottom: '18px', overflow: 'hidden' } },
                h('div', { style: { width: pct + '%', height: '100%', background: 'linear-gradient(90deg, var(--primary-500), var(--primary-700))', borderRadius: '999px' } })),
            h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } },
                Ring({ value: pct, size: 96, stroke: 10, color: 'var(--primary-600)' }),
                h('div', { style: { flex: 1 } },
                    h('div', { style: { fontSize: '12.5px', color: 'var(--ink-700)', marginBottom: '8px' } },
                        'You are ', h('b', null, pct + '%'), ' through the monthly envelope with ', h('b', null, '9 days'), ' remaining — projected to land ', h('b', null, '2% under'), ' plan.'),
                    h('div', { class: 'row', style: { gap: '8px' } },
                        Tag('On budget', { kind: 'ok', dot: true }),
                        Tag('Forecast: 235M', { kind: 'info', dot: true }),
                    ),
                ),
            ),
            h('div', { style: { height: '1px', background: 'var(--ink-100)', margin: '20px 0 16px' } }),
            h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--ink-700)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Approvals queue'),
            ...approvals.map((a, i) => h('div', { class: 'row', style: { padding: '8px 0', borderBottom: i < approvals.length - 1 ? '1px solid var(--ink-100)' : 'none', gap: '10px' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)' } }, a.what),
                    h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'requested by ' + a.who),
                ),
                h('span', { class: 'num', style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } }, a.amount),
                Tag(a.state, { kind: a.state === 'approved' ? 'ok' : 'warn', dot: true }),
            )),
        ),
        // Allocation by channel
        cardBox('Allocation by channel', 'Coins',
            h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, 'budgets in M UZS'),
            h('div', { style: { padding: '18px 22px 22px' } }, ...MK_CHANNELS.map((c, i) => {
                const cPct = Math.round((c.spent / c.budget) * 100);
                return h('div', { style: { marginBottom: i === MK_CHANNELS.length - 1 ? '0' : '16px' } },
                    h('div', { class: 'row', style: { marginBottom: '6px' } },
                        h('div', { style: { width: '28px', height: '28px', borderRadius: '7px', background: c.color, opacity: 0.14, display: 'grid', placeItems: 'center' } },
                            h('span', { style: { width: '10px', height: '10px', borderRadius: '999px', background: c.color } })),
                        h('span', { style: { marginLeft: '10px', fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)' } }, c.name),
                        h('span', { class: 'grow' }),
                        h('span', { class: 'num muted', style: { fontSize: '12px' } },
                            h('b', { style: { color: 'var(--ink-900)' } }, c.spent + 'M'), ' spent · ' + c.budget + 'M allocated'),
                    ),
                    h('div', { style: { position: 'relative', height: '18px', background: 'var(--ink-50)', borderRadius: '6px', overflow: 'hidden' } },
                        h('div', { style: { width: cPct + '%', height: '100%', background: c.color, borderRadius: '6px' } }),
                        h('span', { style: { position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                            fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 600, color: 'var(--ink-700)' } }, cPct + '%'),
                    ),
                    h('div', { class: 'row', style: { marginTop: '6px', gap: '14px', fontSize: '11.5px', color: 'var(--ink-500)' } },
                        h('span', null, h('span', { class: 'num', style: { color: 'var(--ink-800)', fontWeight: 600 } }, String(c.leads)), ' leads'),
                        h('span', null, 'CPL ', h('span', { class: 'num', style: { color: 'var(--ink-800)', fontWeight: 600 } }, (c.spent * 1000 / Math.max(c.leads, 1)).toFixed(1) + 'k'), ' UZS'),
                        h('span', { class: 'grow' }),
                        h('button', { class: 'btn btn-ghost btn-sm', style: { height: '24px', padding: '0 8px' } }, 'Reallocate'),
                    ),
                );
            })),
        ),
    );
}

// ============================================================================
// PATIENT NOTIFICATIONS
// ============================================================================

// ---- Demo data ------------------------------------------------------------
const NT_KPI = {
    recipientsThisWeek: 9420, delivered: 96.2, open: 51.4, ctr: 12.8, bookings: 184, optOut: 0.4,
    trend: {
        delivered: [94,95,95,96,96,96,97,96,96,97,97,96],
        open:      [42,44,45,46,48,49,50,49,51,51,52,51],
        bookings:  [110,120,128,135,150,160,170,168,175,180,184,184],
        sentWeek:  [5800,6100,6400,6900,7500,8200,8900,9420],
    },
};

const NT_CHANNELS = [
    { id: 'tgbot', name: 'Telegram bot', sent: 4280, color: 'var(--info-500)',   icon: 'Bot' },
    { id: 'sms',   name: 'SMS',          sent: 2105, color: 'var(--ok-500)',     icon: 'Msg' },
    { id: 'email', name: 'Email',        sent: 1640, color: 'var(--purple-500)', icon: 'Mail' },
    { id: 'web',   name: 'Web push',     sent:  890, color: '#06b6d4',           icon: 'Globe' },
    { id: 'call',  name: 'Voice bot',    sent:  505, color: 'var(--warn-500)',   icon: 'Phone' },
];

const NT_AUTOMATIONS = [
    { id: 'a1', name: 'Cardiology · 6-month check-in',     trigger: 'No visit ≥ 180 days · last seen by Cardiology', segment: { age: '40–75', doctor: 'Cardiology',        lastVisit: '180+ days' }, channels: ['tgbot','sms','email'],  audience: 1240, sent: 1180, opened:  712, clicked: 198, booked: 64, status: 'running', schedule: 'Daily · 09:30' },
    { id: 'a2', name: 'Annual GP check-up reminder',       trigger: 'No visit ≥ 365 days · any GP',                  segment: { age: '18–65', doctor: 'GP / family medicine',lastVisit: '365+ days' }, channels: ['tgbot','email'],        audience: 3105, sent: 2840, opened: 1612, clicked: 422, booked: 92, status: 'running', schedule: 'Weekly · Mon 10:00' },
    { id: 'a3', name: 'Pediatrics · vaccination schedule', trigger: 'Child age milestone (DTP, MMR…) reached',       segment: { age: '0–7',   doctor: 'Pediatrics',         lastVisit: 'any' },        channels: ['tgbot','sms'],          audience:  412, sent:  380, opened:  295, clicked: 122, booked: 41, status: 'running', schedule: 'Event · age-trigger' },
    { id: 'a4', name: 'Lab results ready',                 trigger: 'LIS · result released',                         segment: { age: 'any',   doctor: 'any',                lastVisit: '< 14 days' },  channels: ['tgbot','sms','email','web'], audience: 1850, sent: 1850, opened: 1610, clicked: 1212, booked: 88, status: 'running', schedule: 'Real-time' },
    { id: 'a5', name: 'Diabetes follow-up · HbA1c',        trigger: 'Diagnosis = E11 · last A1c > 90 days',          segment: { age: '35+',   doctor: 'Endocrinology',      lastVisit: '90+ days' },   channels: ['tgbot','call'],         audience:  286, sent:  260, opened:  198, clicked:  86, booked: 38, status: 'running', schedule: 'Weekly · Wed' },
    { id: 'a6', name: 'Pregnancy · trimester check-ups',   trigger: 'EDD / trimester transitions',                   segment: { age: '18–45', doctor: 'OB/GYN',             lastVisit: 'pregnancy plan' }, channels: ['tgbot','sms'],       audience:  124, sent:  124, opened:  116, clicked:  68, booked: 22, status: 'running', schedule: 'Event · trimester' },
    { id: 'a7', name: 'No-show recovery',                  trigger: 'Appointment status = no-show, ≤ 48h',           segment: { age: 'any',   doctor: 'any',                lastVisit: 'missed' },     channels: ['tgbot','sms','call'],   audience:   78, sent:   78, opened:   66, clicked:  28, booked: 18, status: 'running', schedule: 'Real-time' },
    { id: 'a8', name: 'Dental · 6-month cleaning',         trigger: 'No dental visit ≥ 180 days',                    segment: { age: '14+',   doctor: 'Dental',             lastVisit: '180+ days' },  channels: ['tgbot','email'],        audience:  920, sent:    0, opened:    0, clicked:   0, booked:  0, status: 'paused',  schedule: 'Weekly · Thu 11:00' },
    { id: 'a9', name: 'Birthday · wellness offer',         trigger: 'DOB = today',                                   segment: { age: 'any',   doctor: 'any',                lastVisit: 'any' },        channels: ['tgbot','sms'],          audience:   28, sent:    0, opened:    0, clicked:   0, booked:  0, status: 'draft',   schedule: 'Daily · 08:00' },
];

const NT_TEMPLATES = [
    { id: 'tmpl-card',   name: 'Cardio · gentle nudge',  channel: 'tgbot', preview: '«Здравствуйте, {{first}}! Прошло 6 месяцев с приёма у кардиолога — давайте проверим, как сердце.»', used: 1180 },
    { id: 'tmpl-gp',     name: 'GP annual · short',       channel: 'sms',   preview: '{{first}}, время для ежегодного осмотра. Записаться: easy-med.uz/r/{{ref}}', used: 2840 },
    { id: 'tmpl-lab',    name: 'Lab result ready',        channel: 'tgbot', preview: 'Готов результат анализа. Открыть: {{link}}', used: 1850 },
    { id: 'tmpl-ped',    name: 'Pediatrics · vaccine',    channel: 'tgbot', preview: '{{first}} ({{age_m}} мес.) — настало время для прививки {{vaccine}}.', used: 380 },
    { id: 'tmpl-mail',   name: 'Annual GP · email',       channel: 'email', preview: 'Yearly check-up · easy way to book online.', used: 1640 },
    { id: 'tmpl-noshow', name: 'No-show · come back',     channel: 'sms',   preview: 'Сожалеем, что не удалось встретиться. Перенесём?', used: 78 },
];
const channelInfo = (id) => NT_CHANNELS.find(c => c.id === id);

// ---- Notifications router -------------------------------------------------
function notificationsPage() {
    const tplCount = state.notif.templates.length || NT_TEMPLATES.length;
    const msgCount = state.notif.messages.length;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Marketing · Patient notifications',
            subtitle: 'Auto-segment patients by age, doctor and last visit — and push to bot, SMS, web, email or voice.',
            right: [
                h('button', {
                    class: 'btn btn-outline btn-sm',
                    onclick: () => { state.notifTab = 'templates'; paint(); },
                }, Icon('Layers', { size: 14 }), ' Templates'),
                h('button', {
                    class: 'btn btn-primary btn-sm',
                    onclick: () => openPushNowModal(),
                }, Icon('Send', { size: 14 }), ' Push now'),
            ],
        }),
        h('div', { class: 'tabs' },
            subTab('notifTab', 'dashboard',   'Dashboard',       'Dashboard'),
            subTab('notifTab', 'automations', 'Automations',     'Sparkles', NT_AUTOMATIONS.length),
            subTab('notifTab', 'segments',    'Segment builder', 'Patients'),
            subTab('notifTab', 'templates',   'Templates',       'Doc',      tplCount),
            subTab('notifTab', 'messages',    'Messages',        'Send',     msgCount || null),
        ),
        state.notifTab === 'dashboard' ? notifDashboard()
        : state.notifTab === 'automations' ? notifAutomations()
        : state.notifTab === 'segments' ? notifSegments()
        : state.notifTab === 'messages' ? notifMessages()
        : notifTemplates(),
    );
}

// ---- Notifications · Dashboard --------------------------------------------
function notifDashboard() {
    const k = NT_KPI;
    const totalSent = NT_CHANNELS.reduce((s, c) => s + c.sent, 0);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // KPIs
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
            kpiTile('Messages · this week', k.recipientsThisWeek.toLocaleString('ru-RU'), '',  +18,  k.trend.sentWeek,  'var(--info-500)',    'Send'),
            kpiTile('Delivery rate',        k.delivered,                            '%', +0.4, k.trend.delivered, 'var(--ok-500)',      'Check',  'pt'),
            kpiTile('Open rate',            k.open,                                 '%', +2.1, k.trend.open,      'var(--purple-500)',  'Mail',   'pt'),
            kpiTile('Bookings driven',      k.bookings,                             '',  +14,  k.trend.bookings,  'var(--primary-600)', 'Target'),
        ),
        // Channel mix + Top automations
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '16px' } },
            cardBox('Channel mix', 'Layers',
                h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, 'this week · ' + totalSent.toLocaleString('ru-RU') + ' sent'),
                h('div', { style: { padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: '14px' } },
                    h('div', { class: 'row', style: { gap: '22px', alignItems: 'center', justifyContent: 'center' } },
                        donut(NT_CHANNELS.map(c => ({ value: c.sent, color: c.color })), 140, 20, '9.4K', 'sent'),
                    ),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                        ...NT_CHANNELS.map(c => {
                            const pct = ((c.sent / totalSent) * 100).toFixed(1);
                            return h('div', { class: 'row', style: { gap: '10px' } },
                                h('span', { style: { width: '9px', height: '9px', borderRadius: '3px', background: c.color } }),
                                h('span', { style: { fontSize: '12.5px', color: 'var(--ink-800)', fontWeight: 500 } }, c.name),
                                h('span', { class: 'grow' }),
                                h('span', { class: 'num', style: { fontSize: '12px', color: 'var(--ink-900)', fontWeight: 600 } }, c.sent.toLocaleString('ru-RU')),
                                h('span', { class: 'num muted', style: { fontSize: '11.5px', minWidth: '38px', textAlign: 'right' } }, pct + '%'),
                            );
                        }),
                    ),
                ),
            ),
            cardBox('Top automations · efficiency', 'Trend',
                h('div', { class: 'segmented', style: { marginLeft: 'auto' } },
                    h('button', null, '7d'), h('button', { class: 'on' }, '30d'), h('button', null, '90d'),
                ),
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Automation'), h('th', null, 'Sent'), h('th', null, 'Open'),
                        h('th', null, 'CTR'), h('th', null, 'Booked'), h('th', null, 'Eff.'),
                    )),
                    h('tbody', null, ...NT_AUTOMATIONS.filter(a => a.status === 'running').slice(0, 5).map(a => {
                        const open  = ((a.opened / Math.max(a.sent, 1)) * 100).toFixed(0);
                        const ctr   = ((a.clicked / Math.max(a.sent, 1)) * 100).toFixed(0);
                        const book  = ((a.booked / Math.max(a.sent, 1)) * 100).toFixed(1);
                        const score = Math.min(100, Math.round(a.booked / Math.max(a.sent, 1) * 1000));
                        return h('tr', null,
                            h('td', null,
                                h('div', { class: 'cell-strong', style: { fontSize: '12.5px' } }, a.name),
                                h('div', { class: 'muted', style: { fontSize: '11px' } },
                                    a.channels.map(ch => channelInfo(ch).name).join(' · ')),
                            ),
                            h('td', { class: 'num' }, a.sent.toLocaleString('ru-RU')),
                            h('td', { class: 'num' }, open + '%'),
                            h('td', { class: 'num' }, ctr + '%'),
                            h('td', { class: 'num cell-strong' }, String(a.booked)),
                            h('td', { style: { width: '90px' } },
                                h('div', { style: { height: '5px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
                                    h('div', { style: { width: score + '%', height: '100%',
                                        background: score > 50 ? 'var(--ok-500)' : score > 25 ? 'var(--warn-500)' : 'var(--ink-300)' } })),
                                h('div', { class: 'num muted', style: { fontSize: '11px', marginTop: '2px' } }, book + '% book'),
                            ),
                        );
                    })),
                ),
            ),
        ),
        // Reachability + compliance
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '16px' } },
            cardBox('Send volume · last 14 days', 'Activity',
                h('div', { class: 'row', style: { gap: '6px', fontSize: '11.5px', color: 'var(--ink-500)', marginLeft: 'auto' } },
                    ...NT_CHANNELS.map(c => h('span', { class: 'row', style: { gap: '4px' } },
                        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: c.color } }), c.name,
                    )),
                ),
                h('div', { style: { padding: '14px 22px 22px' } }, stackedBars(
                    ['M','T','W','T','F','S','S','M','T','W','T','F','S','S'],
                    [
                        { color: 'var(--info-500)',   data: [380,420,440,460,500,200,180, 520,560,580,620,640,260,200] },
                        { color: 'var(--ok-500)',     data: [180,220,200,210,250,80,60,    240,260,250,280,300,110,90] },
                        { color: 'var(--purple-500)', data: [120,140,150,150,180,50,40,    160,180,170,190,220,80,60] },
                        { color: '#06b6d4',           data: [ 60, 80, 90, 80,100,30,20,    100,120,110,120,140,40,30] },
                        { color: 'var(--warn-500)',   data: [ 30, 40, 40, 40, 50,10,10,     50, 60, 60, 70, 80,20,15] },
                    ],
                )),
            ),
            h('div', { class: 'card', style: { padding: '22px' } },
                h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-500)', fontWeight: 600, marginBottom: '8px' } },
                    'Reachability · base of 8,420 patients'),
                reachBar([
                    { label: 'Telegram',   pct: 71, color: 'var(--info-500)' },
                    { label: 'SMS only',   pct: 18, color: 'var(--ok-500)' },
                    { label: 'Email only', pct:  7, color: 'var(--purple-500)' },
                    { label: 'No consent', pct:  4, color: 'var(--ink-300)' },
                ]),
                h('div', { style: { height: '1px', background: 'var(--ink-100)', margin: '18px 0' } }),
                h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-500)', fontWeight: 600, marginBottom: '12px' } },
                    'Compliance & health'),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' } },
                    miniStat('Opt-out · 30d',         '0.4%', 'down', 'var(--ok-500)'),
                    miniStat('Bounce · email',        '1.2%', 'flat', 'var(--ink-500)'),
                    miniStat('Frequency cap hits',    '38',   'up',   'var(--warn-500)'),
                    miniStat('Quiet-hours violations','0',    'flat', 'var(--ok-500)'),
                ),
            ),
        ),
    );
}

// ---- Notifications · Automations list ------------------------------------
function notifAutomations() {
    const statusKind = s => ({ running: 'ok', paused: 'warn', draft: '' }[s] || '');
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Sparkles', { size: 16 }), ' Active automations ', h('span', { class: 'h-count' }, String(NT_AUTOMATIONS.length))),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('div', { class: 'segmented' },
                    h('button', { class: 'on' }, 'All'), h('button', null, 'Running'), h('button', null, 'Paused'), h('button', null, 'Drafts'),
                ),
                h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus', { size: 14 }), ' New automation'),
            ),
        ),
        h('div', { style: { padding: '6px 0' } }, ...NT_AUTOMATIONS.map(a => {
            const openR = a.sent ? Math.round((a.opened  / a.sent) * 100) : 0;
            const ctrR  = a.sent ? Math.round((a.clicked / a.sent) * 100) : 0;
            const bookR = a.sent ? ((a.booked / a.sent) * 100).toFixed(1) : '—';
            return h('div', { style: {
                padding: '14px 20px', borderTop: '1px solid var(--ink-100)',
                display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 1fr 130px 90px', gap: '18px', alignItems: 'center',
            } },
                h('div', null,
                    h('div', { class: 'row', style: { gap: '8px' } },
                        h('span', { class: 'cell-strong', style: { fontSize: '14px' } }, a.name),
                        Tag(a.status, { kind: statusKind(a.status), dot: true }),
                    ),
                    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px' } },
                        Icon('Clock', { size: 11 }), ' ', a.schedule,
                        h('span', { style: { color: 'var(--ink-300)' } }, ' · '),
                        'trigger: ', a.trigger,
                    ),
                ),
                h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
                    segChip('Age',    a.segment.age),
                    segChip('Doctor', a.segment.doctor),
                    segChip('Visit',  a.segment.lastVisit),
                ),
                h('div', { class: 'row', style: { gap: '5px' } }, ...a.channels.map(ch => {
                    const c = channelInfo(ch);
                    return h('span', { title: c.name, style: {
                        width: '26px', height: '26px', borderRadius: '7px',
                        background: c.color, opacity: 0.16,
                        display: 'grid', placeItems: 'center', position: 'relative', color: c.color,
                    } }, h('span', { style: { color: c.color, opacity: 1, display: 'grid', placeItems: 'center' } },
                        Icon(c.icon, { size: 13 })));
                })),
                h('div', null,
                    h('div', { class: 'num cell-strong' }, a.audience.toLocaleString('ru-RU')),
                    h('div', { class: 'muted', style: { fontSize: '11px' } }, 'audience'),
                    h('div', { class: 'row', style: { marginTop: '8px', gap: '10px', fontSize: '11px' } },
                        h('span', null, h('b', { style: { color: 'var(--ink-800)' } }, openR + '%'), ' ', h('span', { class: 'muted' }, 'open')),
                        h('span', null, h('b', { style: { color: 'var(--ink-800)' } }, ctrR  + '%'), ' ', h('span', { class: 'muted' }, 'ctr')),
                        h('span', null, h('b', { style: { color: 'var(--primary-700)' } }, bookR + '%'), ' ', h('span', { class: 'muted' }, 'book')),
                    ),
                ),
                h('div', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } },
                    h('button', { class: 'icon-btn', style: { width: '30px', height: '30px' }, title: 'Edit' }, Icon('Edit', { size: 14 })),
                    h('button', { class: 'icon-btn', style: { width: '30px', height: '30px' }, title: 'More' }, Icon('Dot3', { size: 14 })),
                ),
            );
        })),
    );
}

function segChip(label, value) {
    return h('span', { style: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '2px 8px 2px 4px', borderRadius: '999px',
        background: 'var(--ink-25)', border: '1px solid var(--ink-100)', fontSize: '11.5px',
    } },
        h('span', { style: { fontSize: '9.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
            background: 'white', padding: '2px 6px', borderRadius: '999px', color: 'var(--ink-500)' } }, label),
        h('span', { style: { fontWeight: 500, color: 'var(--ink-800)' } }, value),
    );
}

// ---- Notifications · Segment builder -------------------------------------
const SPECIALTIES   = ['Any', 'Cardiology', 'GP / family', 'Pediatrics', 'OB/GYN', 'Endocrinology', 'Dental', 'Dermatology', 'Neurology'];
const VISIT_BUCKETS = ['< 14 days', '14–90 days', '90–180 days', '180–365 days', '365+ days', 'Never'];

function liveAudience() {
    const s = state.segment;
    let pct = 1;
    pct *= (s.age[1] - s.age[0]) / 75;
    pct *= s.doctor === 'Any' ? 0.9 : 0.25;
    pct *= s.visit === '< 14 days' ? 0.15 :
           s.visit === '14–90 days' ? 0.30 :
           s.visit === '90–180 days' ? 0.22 :
           s.visit === '180–365 days' ? 0.30 :
           s.visit === '365+ days' ? 0.45 : 0.05;
    pct *= s.gender === 'any' ? 1 : 0.52;
    return Math.max(20, Math.round(8420 * pct));
}

function notifSegments() {
    const s = state.segment;
    return h('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '16px' } },
        // Builder
        h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Filter', { size: 16 }), ' Build a segment'),
                h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, 'Combine rules — patients auto-include as data changes.'),
            ),
            h('div', { style: { padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: '22px' } },
                // 1. Age
                segSection('1', 'Age range', 'Match patients in this age window',
                    h('div', { class: 'row', style: { gap: '14px', marginTop: '10px' } },
                        h('span', { class: 'num', style: { fontSize: '22px', fontWeight: 700, color: 'var(--ink-900)', minWidth: '80px' } },
                            s.age[0] + ' – ' + s.age[1]),
                        dualRange(0, 100, s.age, (v) => { s.age = v; paint(); }),
                        h('div', { class: 'row', style: { gap: '4px' } },
                            ...[[0,17,'kids'], [18,39,'18–39'], [40,64,'40–64'], [65,100,'65+']].map(([a,b,l]) =>
                                h('button', { class: 'btn btn-outline btn-sm',
                                    onclick: () => { s.age = [a,b]; paint(); } }, l)),
                        ),
                    ),
                ),
                // 2. Doctor
                segSection('2', 'Last visited doctor / specialty', null,
                    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '10px' } },
                        ...SPECIALTIES.map(sp => radioChip(sp, s.doctor === sp, () => { s.doctor = sp; paint(); })),
                    ),
                ),
                // 3. Last visit
                segSection('3', 'Time since last visit', null,
                    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '10px' } },
                        ...VISIT_BUCKETS.map(b => radioChip(b, s.visit === b, () => { s.visit = b; paint(); })),
                    ),
                ),
                // 4. Optional
                segSection('4', 'Optional filters', null,
                    h('div', { class: 'row', style: { gap: '16px', marginTop: '10px', flexWrap: 'wrap' } },
                        h('div', { class: 'field', style: { minWidth: '180px' } },
                            h('label', null, 'Gender'),
                            (() => {
                                const sel = h('select', null,
                                    h('option', { value: 'any' }, 'Any'),
                                    h('option', { value: 'f'   }, 'Female'),
                                    h('option', { value: 'm'   }, 'Male'),
                                );
                                sel.value = s.gender;
                                sel.addEventListener('change', () => { s.gender = sel.value; paint(); });
                                return sel;
                            })(),
                        ),
                        h('div', { class: 'field', style: { minWidth: '220px' } },
                            h('label', null, 'Condition / diagnosis'),
                            h('input', { placeholder: 'e.g. I10 (Hypertension), E11…' }),
                        ),
                        h('div', { class: 'field', style: { minWidth: '180px' } },
                            h('label', null, 'Branch'),
                            h('select', null,
                                h('option', null, 'All branches'),
                                h('option', null, 'Tashkent · Yunusobod'),
                                h('option', null, 'Tashkent · Chilonzor'),
                                h('option', null, 'Samarkand'),
                            ),
                        ),
                    ),
                ),
                // 5. Channels
                segSection('5', 'Reach via', 'Selected in priority order — falls back to next if no consent',
                    h('div', { class: 'row', style: { gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                        ...NT_CHANNELS.map(c => {
                            const on = s.channels.has(c.id);
                            return h('button', {
                                onclick: () => {
                                    if (on) s.channels.delete(c.id); else s.channels.add(c.id);
                                    paint();
                                },
                                style: {
                                    display: 'inline-flex', alignItems: 'center', gap: '8px',
                                    padding: '8px 14px', borderRadius: '9px',
                                    border: '1.5px solid ' + (on ? c.color : 'var(--ink-200)'),
                                    background: on ? 'color-mix(in oklab, ' + c.color + ' 10%, white)' : 'white',
                                    color: on ? c.color : 'var(--ink-700)',
                                    fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                                },
                            }, Icon(c.icon, { size: 14 }), c.name);
                        }),
                    ),
                ),
            ),
        ),
        // Preview
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
            h('div', { class: 'card', style: { padding: '20px', background: 'linear-gradient(135deg, var(--primary-50) 0%, white 60%)' } },
                h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, 'Live audience'),
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginTop: '6px' } },
                    h('span', { class: 'num', style: { fontSize: '44px', fontWeight: 700, color: 'var(--primary-700)', letterSpacing: '-0.02em', lineHeight: 1 } },
                        liveAudience().toLocaleString('ru-RU')),
                    h('span', { style: { fontSize: '14px', color: 'var(--ink-500)' } }, 'patients match'),
                ),
                h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
                    'Updated in real time as you adjust filters. Audiences refresh every 15 min.'),
                h('div', { style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' } },
                    previewRow('User',        `Ages ${s.age[0]} – ${s.age[1]}` + (s.gender !== 'any' ? `, ${s.gender === 'f' ? 'female' : 'male'}` : '')),
                    previewRow('Stethoscope', `Last visited: ${s.doctor}`),
                    previewRow('Clock',       `Time since last visit: ${s.visit}`),
                    previewRow('Send',        `Channels: ${[...s.channels].map(c => channelInfo(c).name).join(' → ')}`),
                ),
                h('div', { class: 'row', style: { marginTop: '18px', gap: '8px' } },
                    h('button', { class: 'btn btn-primary btn-sm', style: { flex: 1, justifyContent: 'center' } }, Icon('Send', { size: 14 }), ' Use in automation'),
                    h('button', { class: 'btn btn-outline btn-sm' }, Icon('Download', { size: 14 }), ' Save'),
                ),
            ),
            cardBox('Saved segments', 'Folder',
                h('div', { style: { padding: '4px 0' } },
                    ...[
                        { name: 'Cardio · 6 month re-engagement', size: 1240, kind: 'teal' },
                        { name: 'Annual GP — overdue',            size: 3105, kind: 'info' },
                        { name: 'Pediatrics · vaccine milestone', size:  412, kind: 'purple' },
                        { name: 'Endocrinology · A1c overdue',    size:  286, kind: 'warn' },
                        { name: 'Post-op week-1 follow-up',       size:   64, kind: 'crit' },
                    ].map(s2 => h('div', { class: 'row', style: { padding: '11px 18px', borderTop: '1px solid var(--ink-100)', gap: '10px' } },
                        Tag('', { kind: s2.kind, dot: true }),
                        h('span', { style: { fontSize: '13px', fontWeight: 500, color: 'var(--ink-900)' } }, s2.name),
                        h('span', { class: 'grow' }),
                        h('span', { class: 'num muted', style: { fontSize: '12px' } }, s2.size.toLocaleString('ru-RU') + ' patients'),
                        h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' } }, Icon('ChevronRight', { size: 13 })),
                    )),
                ),
            ),
        ),
    );
}

function segSection(num, title, sub, body) {
    return h('div', null,
        h('div', { class: 'row', style: { gap: '10px' } },
            h('span', { style: { width: '22px', height: '22px', borderRadius: '6px', background: 'var(--primary-50)', color: 'var(--primary-700)',
                fontWeight: 700, fontSize: '11px', display: 'grid', placeItems: 'center', border: '1px solid var(--primary-200)' } }, num),
            h('span', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, title),
            sub && h('span', { class: 'muted', style: { fontSize: '12px' } }, '· ' + sub),
        ),
        body,
    );
}

function radioChip(label, on, onclick) {
    return h('button', {
        onclick,
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '7px 12px', borderRadius: '999px',
            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
            background: on ? 'var(--primary-50)' : 'white',
            color: on ? 'var(--primary-700)' : 'var(--ink-700)',
            fontWeight: on ? 600 : 500, fontSize: '12.5px',
            cursor: 'pointer', fontFamily: 'inherit',
        },
    },
        h('span', { style: { width: '6px', height: '6px', borderRadius: '999px',
            background: on ? 'var(--primary-600)' : 'var(--ink-300)' } }),
        label,
    );
}

function previewRow(iconName, text) {
    return h('div', { class: 'row', style: { gap: '8px', padding: '8px 10px', background: 'white', borderRadius: '8px', border: '1px solid var(--ink-100)' } },
        h('span', { style: { color: 'var(--primary-600)' } }, Icon(iconName, { size: 13 })),
        h('span', { style: { fontSize: '12.5px', color: 'var(--ink-800)' } }, text),
    );
}

function dualRange(min, max, value, onChange) {
    const [lo, hi] = value;
    const track = h('div', { style: { position: 'relative', flex: 1, height: '32px' } });
    const valueFromX = (clientX, rect) => {
        const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return Math.round(min + t * (max - min));
    };
    const drag = (which) => (e) => {
        e.preventDefault();
        // Capture the track geometry now, while it's still in the DOM. Each
        // onChange repaints the whole view and detaches this track, after which
        // getBoundingClientRect() returns zeros and snaps the handle to the end.
        const rect = track.getBoundingClientRect();
        const move = (ev) => {
            const v = valueFromX(ev.clientX, rect);
            if (which === 'lo') onChange([Math.min(v, hi - 1), hi]);
            else                onChange([lo, Math.max(v, lo + 1)]);
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
    const pct = (v) => ((v - min) / (max - min)) * 100;
    track.append(
        h('div', { style: { position: 'absolute', top: '14px', left: 0, right: 0, height: '4px', background: 'var(--ink-100)', borderRadius: '999px' } }),
        h('div', { style: { position: 'absolute', top: '14px', left: pct(lo) + '%', right: (100 - pct(hi)) + '%', height: '4px', background: 'var(--primary-500)', borderRadius: '999px' } }),
        h('div', { onmousedown: drag('lo'), style: {
            position: 'absolute', top: '8px', left: 'calc(' + pct(lo) + '% - 8px)', width: '16px', height: '16px',
            borderRadius: '999px', background: 'white', border: '2px solid var(--primary-600)',
            boxShadow: '0 2px 4px rgba(0,0,0,0.10)', cursor: 'grab',
        } }),
        h('div', { onmousedown: drag('hi'), style: {
            position: 'absolute', top: '8px', left: 'calc(' + pct(hi) + '% - 8px)', width: '16px', height: '16px',
            borderRadius: '999px', background: 'white', border: '2px solid var(--primary-600)',
            boxShadow: '0 2px 4px rgba(0,0,0,0.10)', cursor: 'grab',
        } }),
    );
    return track;
}

// ---- Notifications · Templates (DB-backed) -------------------------------
function notifTemplates() {
    const tpls = state.notif.templates;
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Doc', { size: 16 }), ' Message templates ',
                h('span', { class: 'h-count' }, String(tpls.length))),
            h('button', {
                class: 'btn btn-primary btn-sm',
                onclick: () => openTemplateEditor(null),
            }, Icon('Plus', { size: 14 }), ' New template'),
        ),
        tpls.length === 0
            ? h('div', { class: 'empty', style: { padding: '40px 20px' } },
                'No templates yet — click + New template to add one. ',
                'If you just installed migration 015 and still see nothing, refresh the page.')
            : h('div', { style: { padding: '18px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
                ...tpls.map(t => {
                    const c = channelInfo(t.channel) || { color: 'var(--ink-500)', icon: 'Doc', name: t.channel };
                    return h('div', { style: {
                        border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '14px', background: 'white',
                        display: 'flex', flexDirection: 'column', gap: '10px',
                    } },
                        h('div', { class: 'row', style: { gap: '8px' } },
                            h('span', { style: { width: '28px', height: '28px', borderRadius: '7px', background: c.color, opacity: 0.16,
                                display: 'grid', placeItems: 'center' } },
                                h('span', { style: { color: c.color, display: 'grid', placeItems: 'center' } }, Icon(c.icon, { size: 14 }))),
                            h('span', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)' } }, t.name),
                            h('span', { class: 'grow' }),
                            h('button', {
                                class: 'icon-btn', style: { width: '26px', height: '26px' },
                                title: 'Edit', onclick: () => openTemplateEditor(t),
                            }, Icon('Edit', { size: 13 })),
                            canDelete('marketing') && h('button', {
                                class: 'icon-btn', style: { width: '26px', height: '26px', color: 'var(--crit-700)' },
                                title: 'Delete',
                                onclick: async () => {
                                    if (!confirm(`Delete template "${t.name}"?`)) return;
                                    const { error } = await supabase.from('notification_templates').delete().eq('id', t.id);
                                    if (error) { toast(error.message, 'fail'); return; }
                                    await loadNotifData(); paint();
                                    toast('Template deleted.');
                                },
                            }, Icon('Trash', { size: 13 })),
                        ),
                        t.subject && h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 } },
                            'Subject: ', t.subject),
                        h('div', { style: {
                            fontSize: '12px', color: 'var(--ink-700)', lineHeight: 1.5,
                            background: 'var(--ink-25)', borderRadius: '8px', padding: '10px 12px',
                            borderLeft: '3px solid ' + c.color, minHeight: '64px', whiteSpace: 'pre-wrap',
                        } }, t.body || ''),
                        h('div', { class: 'row' },
                            Tag(c.name),
                            !t.active && Tag('Inactive', { kind: 'warn' }),
                            h('span', { class: 'grow' }),
                            h('button', {
                                class: 'btn btn-primary btn-sm',
                                onclick: () => openPushNowModal(t),
                            }, Icon('Send', { size: 13 }), ' Push now'),
                        ),
                    );
                }),
            ),
    );
}

// ---- Notifications · Messages (sent log) ---------------------------------
function notifMessages() {
    const rows = state.notif.messages;
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Send', { size: 16 }), ' Sent messages ',
                h('span', { class: 'h-count' }, String(rows.length))),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('button', { class: 'btn btn-outline btn-sm',
                    onclick: () => loadNotifData().then(() => paint()),
                }, Icon('Refresh', { size: 14 }), ' Refresh'),
                h('button', { class: 'btn btn-primary btn-sm',
                    onclick: () => openPushNowModal(),
                }, Icon('Send', { size: 14 }), ' Push now'),
            ),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '40px 20px' } },
                'No messages yet. Click + Push now to send one.')
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Queued'),
                    h('th', null, 'Patient'),
                    h('th', null, 'Channel'),
                    h('th', null, 'Body'),
                    h('th', null, 'Status'),
                    h('th', { style: { width: '180px', textAlign: 'right' } }, 'Update'),
                )),
                h('tbody', null, ...rows.map(messageRow)),
            ),
    );
}

function messageRow(m) {
    const p = m.patients || {};
    const name = [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unknown)';
    const c = channelInfo(m.channel) || { color: 'var(--ink-500)', icon: 'Doc', name: m.channel };
    return h('tr', null,
        h('td', { class: 'num muted', style: { fontSize: '11.5px' } }, formatDateTime(m.queued_at)),
        h('td', null,
            h('div', { class: 'cell-strong' }, name),
            h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                [p.mrn, m.address].filter(Boolean).join(' · ')),
        ),
        h('td', null,
            h('span', { class: 'row', style: { gap: '6px' } },
                h('span', { style: { width: '18px', height: '18px', borderRadius: '5px', background: c.color, opacity: 0.16, display: 'grid', placeItems: 'center' } },
                    h('span', { style: { color: c.color, display: 'grid', placeItems: 'center' } }, Icon(c.icon, { size: 11 }))),
                h('span', null, c.name),
            ),
        ),
        h('td', { style: { maxWidth: '320px', fontSize: '12px' } },
            m.subject && h('div', { class: 'cell-strong' }, m.subject),
            h('div', { class: 'muted', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: m.body }, m.body),
        ),
        h('td', null, messageStatusTag(m.status), m.error && h('div', { class: 'muted', style: { fontSize: '11px', color: 'var(--crit-700)', marginTop: '2px' } }, m.error)),
        h('td', { style: { textAlign: 'right' } }, messageActions(m)),
    );
}

function messageStatusTag(s) {
    const map = {
        queued:    { kind: 'warn', label: 'Queued' },
        sent:      { kind: 'info', label: 'Sent' },
        delivered: { kind: 'info', label: 'Delivered' },
        opened:    { kind: 'ok',   label: 'Opened' },
        clicked:   { kind: 'ok',   label: 'Clicked' },
        failed:    { kind: 'crit', label: 'Failed' },
    };
    const m = map[s] || { kind: '', label: s };
    return Tag(m.label, { kind: m.kind, dot: true });
}

function messageActions(m) {
    const setStatus = async (next, extra = {}) => {
        const patch = { status: next, ...extra };
        const { error } = await supabase.from('notification_messages').update(patch).eq('id', m.id);
        if (error) { toast(error.message, 'fail'); return; }
        Object.assign(m, patch);
        paint();
        toast('Status → ' + next + '.');
    };
    const buttons = [];
    if (m.status === 'queued') {
        buttons.push(
            h('button', { class: 'btn btn-success btn-sm',
                onclick: () => setStatus('sent', { sent_at: new Date().toISOString() }) },
                Icon('Check', { size: 12 }), ' Mark sent'),
            h('button', { class: 'btn btn-ghost btn-sm', style: { color: 'var(--crit-700)' },
                onclick: () => {
                    const err = prompt('Failure reason:'); if (err == null) return;
                    setStatus('failed', { error: err || 'manual' });
                } },
                Icon('X', { size: 12 }), ' Fail'),
        );
    } else if (m.status === 'sent' || m.status === 'delivered') {
        buttons.push(
            h('button', { class: 'btn btn-outline btn-sm',
                onclick: () => setStatus('opened', { opened_at: new Date().toISOString() }) },
                'Opened'),
        );
    } else {
        buttons.push(h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '—'));
    }
    return h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } }, ...buttons);
}

// ---- Template editor modal -----------------------------------------------
function openTemplateEditor(existing) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInput    = h('input', { value: existing?.name || '', placeholder: 'e.g. Cardio · gentle nudge' });
    const channelSelect = h('select', null,
        ...NT_CHANNELS.map(c => h('option', { value: c.id, selected: (existing?.channel || 'tgbot') === c.id }, c.name)),
    );
    const subjectInput = h('input', { value: existing?.subject || '', placeholder: 'Only used for email' });
    const bodyInput    = h('textarea', { rows: '6', placeholder: 'Use {{first}}, {{link}}, {{ref}} …' });
    if (existing?.body) bodyInput.value = existing.body;
    const descInput    = h('input', { value: existing?.description || '', placeholder: 'When you use this template' });
    const activeBox    = h('input', { type: 'checkbox' });
    if (existing ? existing.active : true) activeBox.checked = true;

    const card = h('div', { class: 'modal-card', style: { width: '560px' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' ', existing ? 'Edit template' : 'New template'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { class: 'field' }, h('label', null, 'Name'),         nameInput),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Channel'),    channelSelect),
                h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Subject (email only)'), subjectInput),
            ),
            h('div', { class: 'field' }, h('label', null, 'Body'),         bodyInput),
            h('div', { class: 'field' }, h('label', null, 'Description'),  descInput),
            h('div', { class: 'field' },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    activeBox, 'Active'),
            ),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: async (e) => {
                e.target.disabled = true;
                try {
                    const payload = {
                        name:        nameInput.value.trim(),
                        channel:     channelSelect.value,
                        subject:     subjectInput.value.trim() || null,
                        body:        bodyInput.value.trim(),
                        description: descInput.value.trim() || null,
                        active:      activeBox.checked,
                        updated_at:  new Date().toISOString(),
                    };
                    if (!payload.name) { toast('Name is required.', 'fail'); return; }
                    if (!payload.body) { toast('Body is required.', 'fail'); return; }
                    let err;
                    if (existing) {
                        ({ error: err } = await supabase.from('notification_templates').update(payload).eq('id', existing.id));
                    } else {
                        ({ error: err } = await supabase.from('notification_templates').insert(payload));
                    }
                    if (err) { toast(err.message, 'fail'); return; }
                    await loadNotifData(); paint(); close();
                    toast(existing ? 'Template updated.' : 'Template created.');
                } finally { e.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Save'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => nameInput.focus(), 30);
}

// ---- Push now modal ------------------------------------------------------
// Pick a template (preselected if passed in), pick a patient (autocomplete),
// substitute simple variables, queue a notification_messages row.
function openPushNowModal(preset) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const templateSelect = h('select', null,
        ...state.notif.templates.map(t =>
            h('option', { value: t.id, selected: preset && t.id === preset.id }, `${t.name} (${channelInfo(t.channel)?.name || t.channel})`)),
    );
    if (!state.notif.templates.length) {
        templateSelect.appendChild(h('option', { value: '' }, '— no templates —'));
    }

    const patientSearch = h('input', {
        placeholder: 'Search patient by name, MRN, phone…',
        autocomplete: 'off',
        oninput: (e) => debouncedPatientSearch(e.target.value),
    });
    const resultsEl = h('div', {
        style: { display: 'none', border: '1px solid var(--ink-100)', borderRadius: '8px', marginTop: '4px',
                 maxHeight: '200px', overflow: 'auto', background: 'white' },
    });
    const chip = h('div', { style: { display: 'none', marginTop: '6px', padding: '8px 10px',
        background: 'var(--info-50)', borderRadius: '8px', border: '1px solid #c7dcfd' } });

    let chosenPatient = null;
    function pickPatient(p) {
        chosenPatient = p;
        resultsEl.style.display = 'none'; clear(resultsEl);
        clear(chip); chip.style.display = '';
        const name = [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unknown)';
        chip.append(h('div', { class: 'row', style: { gap: '10px' } },
            Icon('User', { size: 14 }),
            h('div', null,
                h('div', { class: 'cell-strong' }, name),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    [p.mrn, p.phone].filter(Boolean).join(' · ')),
            ),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
                chosenPatient = null; chip.style.display = 'none';
                patientSearch.value = ''; patientSearch.focus(); updatePreview();
            } }, '×'),
        ));
        patientSearch.value = name;
        updatePreview();
    }
    let _t;
    function debouncedPatientSearch(term) {
        clearTimeout(_t); _t = setTimeout(() => doPatientSearch(term, resultsEl, pickPatient), 220);
    }

    const previewBox = h('div', { style: {
        marginTop: '8px', padding: '12px', background: 'var(--ink-25)',
        border: '1px solid var(--ink-100)', borderRadius: '8px', whiteSpace: 'pre-wrap',
        fontSize: '13px', color: 'var(--ink-900)', minHeight: '60px',
    } });
    const addressInput = h('input', { placeholder: 'phone / chat-id / email — auto-filled if available' });

    function updatePreview() {
        const tpl = state.notif.templates.find(x => x.id === templateSelect.value);
        if (!tpl) { previewBox.textContent = '(pick a template)'; return; }
        const p = chosenPatient || {};
        const first = p.first_name || (p.full_name || '').split(' ')[1] || p.full_name || 'Patient';
        const ref   = (p.mrn || p.id || 'XXXX').slice(-6);
        const rendered = (tpl.body || '')
            .replace(/\{\{first\}\}/g, first)
            .replace(/\{\{ref\}\}/g,   ref)
            .replace(/\{\{link\}\}/g,  'https://easy-med.uz/r/' + ref)
            .replace(/\{\{name\}\}/g,  [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || first);
        previewBox.textContent = rendered;
        // Auto-fill address if empty.
        if (!addressInput.value.trim() && p) {
            const c = tpl.channel;
            if      (c === 'sms' || c === 'call') addressInput.value = p.phone || '';
            else if (c === 'email')                addressInput.value = p.email || '';
        }
    }
    templateSelect.addEventListener('change', updatePreview);

    const card = h('div', { class: 'modal-card', style: { width: '560px' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Send', { size: 16 }), ' Push notification'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { class: 'field' }, h('label', null, 'Template ', h('span', { style: { color: 'var(--crit-500)' } }, '*')),  templateSelect),
            h('div', { class: 'field' }, h('label', null, 'Patient ',  h('span', { style: { color: 'var(--crit-500)' } }, '*')),
                patientSearch, resultsEl, chip),
            h('div', { class: 'field' }, h('label', null, 'Address (phone / chat-id / email)'), addressInput),
            h('div', { class: 'field' }, h('label', null, 'Preview'), previewBox),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: async (e) => {
                e.target.disabled = true;
                try {
                    if (!templateSelect.value) { toast('Pick a template.', 'fail'); return; }
                    if (!chosenPatient)        { toast('Pick a patient.',  'fail'); return; }
                    const tpl = state.notif.templates.find(x => x.id === templateSelect.value);
                    const payload = {
                        template_id: tpl.id,
                        patient_id:  chosenPatient.id,
                        channel:     tpl.channel,
                        address:     addressInput.value.trim() || null,
                        subject:     tpl.subject || null,
                        body:        previewBox.textContent,
                        status:      'queued',
                    };
                    const { error } = await supabase.from('notification_messages').insert(payload);
                    if (error) { toast(error.message, 'fail'); return; }
                    toast('Notification queued.');
                    state.notifTab = 'messages';
                    await loadNotifData(); paint(); close();
                } finally { e.target.disabled = false; }
            } }, Icon('Send', { size: 14 }), ' Queue push'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => patientSearch.focus(), 30);
    updatePreview();
}

async function doPatientSearch(term, resultsEl, onPick) {
    const t = (term || '').trim();
    if (t.length < 2) { clear(resultsEl); resultsEl.style.display = 'none'; return; }
    const fields = ['full_name', 'last_name', 'first_name', 'phone', 'mrn'];
    const seen = new Set();
    const rows = [];
    await Promise.all(fields.map(async (f) => {
        try {
            const { data } = await supabase.from('patients')
                .select('id, mrn, full_name, last_name, first_name, phone, email, date_of_birth')
                .eq('company_id', (window.CLINIC && window.CLINIC.id) || null)   // M1 — don't leak other clinics' patients
                .ilike(f, '%' + t + '%').limit(8);
            for (const r of (data || [])) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        } catch {}
    }));
    clear(resultsEl);
    if (rows.length === 0) {
        resultsEl.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12px' } },
            `No patient matched "${t}".`));
    } else {
        for (const p of rows.slice(0, 8)) {
            resultsEl.appendChild(h('button', {
                type: 'button',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                         background: 'transparent', border: '0', borderBottom: '1px solid var(--ink-100)',
                         cursor: 'pointer', font: 'inherit' },
                onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; },
                onmouseleave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
                onclick: () => onPick(p),
            },
                h('div', { class: 'cell-strong' },
                    [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unnamed)'),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    [p.mrn, p.phone, p.date_of_birth].filter(Boolean).join(' · ')),
            ));
        }
    }
    resultsEl.style.display = '';
}

function formatDateTime(d) { return fmtDateTime(d); }   // DATE_FMT_V1

// ============================================================================
// Shared visual helpers
// ============================================================================
function cardBox(title, iconName, ...children) {
    // Children passed after the title are placed in the header row first,
    // then any remaining children fall into the body. We treat anything
    // that's a DOM element with .card-header-only marker as header content
    // for simplicity here we put the first child (if any) into the header
    // beside the title and the rest into the body.
    const headerExtras = [];
    const bodyChildren = [];
    for (const c of children) {
        if (c && c.nodeType === 1 && (c.classList.contains('segmented') || c.classList.contains('h-count')
                || (c.classList.contains('btn') && (c.classList.contains('btn-sm') || c.classList.contains('btn-ghost'))))) {
            headerExtras.push(c);
        } else if (c && c.nodeType === 1 && c.tagName === 'SPAN' && (c.classList.contains('muted') || c.classList.contains('h-count'))) {
            headerExtras.push(c);
        } else {
            bodyChildren.push(c);
        }
    }
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon(iconName, { size: 16 }), ' ', title),
            ...headerExtras,
        ),
        ...bodyChildren,
    );
}

function kpiTile(label, value, unit, delta, trend, color, iconName, suffix = '%') {
    return h('div', { class: 'stat', style: { position: 'relative' } },
        h('div', { class: 'row' },
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: color, opacity: 0.12, position: 'absolute' } }),
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', color, position: 'relative' } },
                Icon(iconName, { size: 16 })),
            h('span', { class: 'grow' }),
            Delta(delta, suffix),
        ),
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-value num' }, String(value), unit && h('span', { class: 'unit' }, unit)),
        Spark(trend, { color, w: 220, h: 30 }),
    );
}

function callout(kind, text, detail) {
    const map = {
        ok:   { bg: 'var(--ok-50)',   fg: 'var(--ok-700)',   dot: 'var(--ok-500)' },
        warn: { bg: 'var(--warn-50)', fg: 'var(--warn-700)', dot: 'var(--warn-500)' },
        info: { bg: 'var(--info-50)', fg: 'var(--info-700)', dot: 'var(--info-500)' },
    }[kind];
    return h('div', { class: 'row', style: { gap: '10px', padding: '8px 12px', background: map.bg, borderRadius: '8px' } },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '999px', background: map.dot, flex: '0 0 8px' } }),
        h('span', { style: { fontSize: '12px', fontWeight: 700, color: map.fg, minWidth: '60px' } }, text),
        h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, detail),
    );
}

function funnel(rows) {
    const max = rows[0].value;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        ...rows.map((r, i) => {
            const w = (r.value / max) * 100;
            const conv = i > 0 ? ((r.value / rows[i-1].value) * 100).toFixed(1) : null;
            return h('div', null,
                h('div', { class: 'row', style: { marginBottom: '4px', fontSize: '12.5px' } },
                    h('span', { style: { color: 'var(--ink-800)', fontWeight: 500 } }, r.label),
                    h('span', { class: 'grow' }),
                    conv && h('span', { class: 'muted', style: { fontSize: '11.5px', marginRight: '10px' } }, '→ ' + conv + '%'),
                    h('span', { class: 'num', style: { fontWeight: 600, color: 'var(--ink-900)' } }, r.value.toLocaleString('ru-RU')),
                ),
                h('div', { style: { height: '16px', background: 'var(--ink-50)', borderRadius: '5px', overflow: 'hidden' } },
                    h('div', { style: { width: w + '%', height: '100%', background: 'linear-gradient(90deg, ' + r.color + ', ' + r.color + 'dd)', borderRadius: '5px' } })),
            );
        }),
    );
}

function donut(segments, size = 140, stroke = 20, centerLabel, centerSub) {
    const total = segments.reduce((s, x) => s + x.value, 0);
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    let acc = 0;
    const parts = [];
    for (const seg of segments) {
        const frac = seg.value / total;
        const len = c * frac;
        const dash = `${len} ${c - len}`;
        const offset = -acc * c;
        acc += frac;
        parts.push(`<circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${seg.color}" stroke-width="${stroke}" fill="none" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"/>`);
    }
    const wrap = h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px' } });
    wrap.innerHTML = `<svg width="${size}" height="${size}" style="transform: rotate(-90deg)">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="var(--ink-100)" stroke-width="${stroke}" fill="none"/>
        ${parts.join('')}
    </svg>`;
    wrap.appendChild(h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' } },
        h('div', { style: { textAlign: 'center' } },
            h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' } }, centerLabel),
            h('div', { class: 'muted', style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, centerSub),
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
        svg += `<text x="${x + bw/2}" y="${hgt + 14}" text-anchor="middle" font-size="10" fill="var(--ink-400)" font-family="var(--font-mono)">${labels[i]}</text></g>`;
    }
    svg += `</svg>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = svg;
    return wrap;
}

function reachBar(segments) {
    return h('div', null,
        h('div', { style: { height: '18px', background: 'var(--ink-50)', borderRadius: '6px', overflow: 'hidden', display: 'flex' } },
            ...segments.map(s => h('div', { title: s.label + ' · ' + s.pct + '%', style: { width: s.pct + '%', background: s.color } })),
        ),
        h('div', { class: 'row', style: { marginTop: '10px', gap: '6px', flexWrap: 'wrap' } },
            ...segments.map(s => h('span', { class: 'row', style: { gap: '6px', fontSize: '12px' } },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: s.color } }),
                h('span', { style: { color: 'var(--ink-700)' } }, s.label),
                h('span', { class: 'num', style: { color: 'var(--ink-900)', fontWeight: 600 } }, s.pct + '%'),
            )),
        ),
    );
}

function miniStat(label, value, trend, color) {
    return h('div', { style: { padding: '10px 12px', background: 'var(--ink-25)', border: '1px solid var(--ink-100)', borderRadius: '8px' } },
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 } }, label),
        h('div', { class: 'row', style: { marginTop: '2px', gap: '6px' } },
            h('span', { class: 'num', style: { fontSize: '18px', fontWeight: 700, color: 'var(--ink-900)' } }, value),
            h('span', { style: { fontSize: '10px', color } }, trend === 'up' ? '↑' : trend === 'down' ? '↓' : '–'),
        ),
    );
}

