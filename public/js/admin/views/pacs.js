// Imaging · PACS — radiology worklist, DICOM viewer (synthetic for now),
// reporting, and modality fleet. Ported from the Pacs design sample
// (`Pacs/Easy-doctor HIS.html` → component `PACS`). Mock data inline; wire to
// real `studies` / `study_files` / `radiology_reports` tables in a later pass.
//
// Lifecycle of a study (see LifecycleFlow):
//   1 ORDER → 2 SCHEDULED → 3 ARRIVED → 4 ACQUIRED → 5 TO READ →
//   6 READING → 7 REPORTED → 8 VERIFIED → 9 DISTRIBUTED

import { h, html, Icon, Avatar, PageHead, Spark, Delta, clear } from '../ui.js';

// ───────────────────────── Reference data ─────────────────────────
const PACS_STATUS = {
    scheduled: { label: 'Scheduled', dot: 'var(--ink-400)',    step: 2 },
    arrived:   { label: 'Arrived',   dot: 'var(--info-500)',   step: 3 },
    acquired:  { label: 'Acquired',  dot: 'var(--cyan-500, #06b6d4)', step: 4 },
    'to-read': { label: 'To read',   dot: 'var(--warn-500)',   step: 5 },
    reading:   { label: 'Reading',   dot: 'var(--primary-500)', step: 6 },
    reported:  { label: 'Reported',  dot: 'var(--purple-500)',  step: 7 },
    verified:  { label: 'Verified',  dot: 'var(--ok-500)',     step: 8, terminal: true },
};

const MODALITY = {
    CT:  { label: 'CT',  color: 'var(--info-500)' },
    MRI: { label: 'MRI', color: 'var(--purple-500)' },
    XR:  { label: 'XR',  color: 'var(--ok-500)' },
    US:  { label: 'US',  color: 'var(--warn-500)' },
};
const modInfo = (m) => MODALITY[m] || { label: m, color: 'var(--ink-500)' };

const PACS_KPI = {
    studiesToday: 38,
    toRead: 12,
    stat: 3,
    tatHours: 4.2,
    critical: 2,
    modalitySplit: [
        { id: 'CT',  value: 16 },
        { id: 'MRI', value: 9 },
        { id: 'XR',  value: 9 },
        { id: 'US',  value: 4 },
    ],
    tatTrend: [6.1, 5.8, 5.2, 5.4, 4.9, 4.6, 4.4, 4.2],
    volTrend: [28, 31, 34, 30, 36, 33, 38, 38],
};

const PACS_STUDIES = [
    { id: 'ST-26-1048', patient: { name: 'Абдукаюмов Баходир', av: 'БА', avc: 'av-6', age: 30, sex: 'M', mrn: 'P-26-00048' }, mod: 'CT',  bodyPart: 'Head · without contrast', series: 4, images: 192, ref: 'Dr. O. Yusupov', priority: 'stat',    status: 'to-read',  acc: 'ACC-100482', when: '11:24', tat: '—' },
    { id: 'ST-26-1047', patient: { name: 'Karimova Aziza',     av: 'KA', avc: 'av-3', age: 58, sex: 'F', mrn: 'P-26-06721' }, mod: 'MRI', bodyPart: 'Lumbar spine',          series: 6, images: 320, ref: 'Dr. D. Juraev',  priority: 'routine', status: 'reading',  acc: 'ACC-100481', when: '10:58', tat: '0:42' },
    { id: 'ST-26-1046', patient: { name: 'Yusupov Doniyor',    av: 'YD', avc: 'av-1', age: 35, sex: 'M', mrn: 'P-26-02014' }, mod: 'XR',  bodyPart: 'Chest · PA + lateral',   series: 2, images: 2,   ref: 'Dr. N. Sodiqova', priority: 'routine', status: 'to-read',  acc: 'ACC-100480', when: '10:40', tat: '—' },
    { id: 'ST-26-1045', patient: { name: 'Ergashev Sherzod',   av: 'ES', avc: 'av-5', age: 64, sex: 'M', mrn: 'P-26-08124' }, mod: 'CT',  bodyPart: 'Chest · contrast (PE)',  series: 5, images: 286, ref: 'Dr. O. Yusupov', priority: 'stat',    status: 'acquired', acc: 'ACC-100479', when: '10:22', tat: '—' },
    { id: 'ST-26-1044', patient: { name: 'Sobirova Iroda',     av: 'SI', avc: 'av-7', age: 71, sex: 'F', mrn: 'P-26-01926' }, mod: 'MRI', bodyPart: 'Brain · with contrast',  series: 8, images: 412, ref: 'Dr. R. Xolmatov', priority: 'routine', status: 'reported', acc: 'ACC-100478', when: '09:50', tat: '2:08' },
    { id: 'ST-26-1043', patient: { name: 'Tursunov Akmal',     av: 'TA', avc: 'av-2', age: 47, sex: 'M', mrn: 'P-26-05477' }, mod: 'US',  bodyPart: 'Abdomen · complete',     series: 1, images: 36,  ref: 'Dr. M. Tursunova',priority: 'routine', status: 'verified', acc: 'ACC-100477', when: '09:18', tat: '1:32' },
    { id: 'ST-26-1042', patient: { name: 'Nazarova Gulnora',   av: 'NG', avc: 'av-4', age: 52, sex: 'F', mrn: 'P-26-09812' }, mod: 'CT',  bodyPart: 'Abdomen / pelvis',       series: 6, images: 344, ref: 'Dr. D. Juraev',  priority: 'routine', status: 'scheduled',acc: 'ACC-100476', when: '13:30', tat: '—' },
    { id: 'ST-26-1041', patient: { name: 'Latipov Komil',      av: 'LK', avc: 'av-3', age: 60, sex: 'M', mrn: 'P-26-04572' }, mod: 'XR',  bodyPart: 'Right knee',             series: 2, images: 3,   ref: 'Dr. O. Yusupov', priority: 'routine', status: 'arrived',  acc: 'ACC-100475', when: '12:10', tat: '—' },
];

// Window/level presets exposed in the pro viewer dropdown.
const DV_PRESETS = [
    { id: 'heart',  label: 'Cardiac',      ww: 600,  wl: 200 },
    { id: 'soft',   label: 'Soft tissue',  ww: 400,  wl: 40 },
    { id: 'lung',   label: 'Lung',         ww: 1500, wl: -600 },
    { id: 'bone',   label: 'Bone',         ww: 2000, wl: 500 },
    { id: 'bright', label: 'Bright blood', ww: 300,  wl: 220 },
];
const DV_FRAMES = 16;
const DV_TOOL_LABEL = {
    wl: 'Window / Level', pan: 'Pan', zoom: 'Zoom', magnify: 'Magnify',
    length: 'Length', angle: 'Angle', roi: 'Rectangle ROI', ellipse: 'Ellipse ROI',
    probe: 'Probe', annotate: 'ArrowAnnotate', erase: 'Erase',
};

// ───────────────────────── State + entry ─────────────────────────
function freshDvState() {
    return {
        frame: 9, playing: false, tool: 'annotate',
        wl: { ww: 252, wl: 126 }, zoom: 1, pan: { x: 0, y: 0 },
        invert: false,
        marks: [{ id: 1, type: 'annotate', a: { x: 0.55, y: 0.58 }, b: { x: 0.74, y: 0.30 }, text: 'jujasdufjasdf' }],
        pending: [], draft: null,
        report: 'Cine MRI 16 frames. Normal cardiac function. EF 60%.',
        signed: false,
        nextId: 2,
    };
}

const state = {
    tab:        'dashboard',
    openStudy:  PACS_STUDIES[0],
    wlFilter:   'all',
    wlMod:      'All',
    dv:         freshDvState(),
    report:     { impression: '', findings: '', critical: false },
};

let containerRef = null;
let dvCineTimer  = null;
let dvImageEl    = null;     // ref to the .dv-image div (for screen→image coord math)

function stopDvCine() {
    if (dvCineTimer) { clearInterval(dvCineTimer); dvCineTimer = null; }
    state.dv.playing = false;
}
function startDvCine() {
    stopDvCine();
    state.dv.playing = true;
    dvCineTimer = setInterval(() => { state.dv.frame = (state.dv.frame + 1) % DV_FRAMES; paint(); }, 90);
}

export function renderPacs(container) {
    containerRef = container;
    stopDvCine();
    state.dv = freshDvState();
    paint();
}

function paint() {
    clear(containerRef);
    containerRef.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        PageHead({
            title: 'Imaging · PACS',
            subtitle: 'Radiology worklist, DICOM viewer and structured reporting for CT, MRI, X-ray & ultrasound.',
            right: [
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Download', { size: 14 }), ' Export'),
                h('button', { class: 'btn btn-outline btn-sm' }, Icon('Send', { size: 14 }), ' DICOM send'),
                h('button', { class: 'btn btn-primary btn-sm' }, Icon('Plus', { size: 14 }), ' New order'),
            ],
        }),
        tabsBar(),
        h('div', null, tabBody()),
    ));
}

function tabsBar() {
    const tabs = [
        { id: 'dashboard', label: 'Dashboard', icon: 'Dashboard' },
        { id: 'worklist',  label: 'Worklist',  icon: 'Scan', count: PACS_KPI.toRead, countKind: 'warn' },
        { id: 'viewer',    label: 'Viewer',    icon: 'Image' },
        { id: 'reporting', label: 'Reporting', icon: 'Doc' },
        { id: 'equipment', label: 'Modalities',icon: 'Activity' },
    ];
    return h('div', { class: 'tabs', style: { marginTop: '-4px', flexWrap: 'wrap' } },
        ...tabs.map(t => h('button', {
            class: 'tab' + (state.tab === t.id ? ' on' : ''),
            onclick: () => {
                if (state.tab === 'viewer' && t.id !== 'viewer') stopDvCine();
                state.tab = t.id;
                paint();
            },
        },
            Icon(t.icon, { size: 14 }), ' ', t.label,
            t.count != null && h('span', { class: 'tab-count', style: t.countKind === 'warn' ? { background: 'var(--warn-50)', color: 'var(--warn-700)' } : undefined }, String(t.count)),
        )),
    );
}

function tabBody() {
    if (state.tab === 'dashboard') return pacsDashboard();
    if (state.tab === 'worklist')  return pacsWorklist();
    if (state.tab === 'viewer')    return pacsViewer(state.openStudy);
    if (state.tab === 'reporting') return pacsReporting(state.openStudy);
    if (state.tab === 'equipment') return pacsEquipment();
    return h('div');
}

function openInViewer(study) {
    state.openStudy = study;
    stopDvCine();
    // Reset viewer mutable state but keep the chosen tool / preset feel.
    state.dv = { ...freshDvState(), tool: state.dv?.tool || 'annotate' };
    state.tab = 'viewer';
    paint();
}

// ───────────────────────── Dashboard tab ─────────────────────────
function pacsDashboard() {
    const k = PACS_KPI;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // KPI cards
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '14px' } },
            pacsKpi({ label: 'Studies today',   value: k.studiesToday,        delta: +9,   trend: k.volTrend, color: 'var(--primary-600)', icon: 'Scan' }),
            pacsKpi({ label: 'Awaiting read',   value: k.toRead,              delta: -2,   trend: [16,15,14,14,13,12,12,12], color: 'var(--warn-500)', icon: 'Image', reverse: true }),
            pacsKpi({ label: 'STAT pending',    value: k.stat,                trend: [4,3,5,3,2,3,3,3], color: 'var(--crit-500)', icon: 'Warning', hideDelta: true }),
            pacsKpi({ label: 'Avg turnaround',  value: k.tatHours, unit: 'h', delta: -0.4, trend: k.tatTrend.map(v => 10 - v), color: 'var(--info-500)', icon: 'Clock', suffix: 'h', reverse: true }),
            pacsKpi({ label: 'Critical results',value: k.critical,            trend: [1,2,1,3,2,1,2,2], color: 'var(--purple-500)', icon: 'Pulse', hideDelta: true }),
        ),

        // Lifecycle flow
        h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Repeat', { size: 16 }), ' How a study flows through PACS'),
                h('span', { class: 'muted', style: { fontSize: '12px' } }, 'order → distributed'),
            ),
            h('div', { style: { padding: '20px 22px 24px' } }, lifecycleFlow()),
        ),

        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '16px' } },
            // Modality split donut
            h('div', { class: 'card' },
                h('div', { class: 'card-header' }, h('h3', null, Icon('Grid', { size: 16 }), ' By modality · today')),
                h('div', { style: { padding: '18px 22px 22px', display: 'flex', gap: '18px', alignItems: 'center' } },
                    pacsDonut({ segments: k.modalitySplit.map(m => ({ value: m.value, color: modInfo(m.id).color })), size: 132, stroke: 18, center: k.studiesToday, sub: 'studies' }),
                    h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' } },
                        ...k.modalitySplit.map(m => h('div', { class: 'row', style: { gap: '10px', fontSize: '12.5px' } },
                            h('span', { style: { width: '9px', height: '9px', borderRadius: '3px', background: modInfo(m.id).color } }),
                            h('span', { style: { color: 'var(--ink-800)', fontWeight: 600 } }, modInfo(m.id).label),
                            h('span', { class: 'grow' }),
                            h('span', { class: 'num', style: { color: 'var(--ink-900)', fontWeight: 700 } }, String(m.value)),
                        )),
                    ),
                ),
            ),

            // Reading worklist snapshot
            h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, Icon('Image', { size: 16 }), ' Reading worklist ',
                        h('span', { class: 'h-count' }, String(PACS_STUDIES.filter(s => ['to-read','reading'].includes(s.status)).length))),
                    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openInViewer(PACS_STUDIES[0]) }, 'Open viewer ', Icon('ArrowRight', { size: 14 })),
                ),
                h('div', { style: { padding: '4px 0 6px' } },
                    ...PACS_STUDIES
                        .filter(s => ['to-read','reading','acquired'].includes(s.status))
                        .slice(0, 5)
                        .map(s => h('div', { class: 'row', style: { padding: '10px 18px', borderTop: '1px solid var(--ink-100)', gap: '12px', cursor: 'pointer' }, onclick: () => openInViewer(s) },
                            modBadge(s.mod),
                            h('div', { style: { flex: 1, minWidth: 0 } },
                                h('div', { class: 'cell-strong', style: { fontSize: '12.5px' } }, s.patient.name),
                                h('div', { class: 'muted', style: { fontSize: '11px' } }, `${s.bodyPart} · ${s.images} img`),
                            ),
                            s.priority === 'stat' && h('span', { class: 'pacs-stat' }, 'STAT'),
                            pacsStatus(s.status),
                        )),
                ),
            ),
        ),
    );
}

function lifecycleFlow() {
    const steps = [
        { n: 1, label: 'Order',       icon: 'Doc',      who: 'Referring doctor' },
        { n: 2, label: 'Scheduled',   icon: 'Calendar', who: 'Modality slot' },
        { n: 3, label: 'Arrived',     icon: 'User',     who: 'Reception' },
        { n: 4, label: 'Acquired',    icon: 'Scan',     who: 'Technologist' },
        { n: 5, label: 'To read',     icon: 'Image',    who: 'Worklist' },
        { n: 6, label: 'Reading',     icon: 'ZoomIn',   who: 'Radiologist' },
        { n: 7, label: 'Reported',    icon: 'Edit',     who: 'Draft report' },
        { n: 8, label: 'Verified',    icon: 'Check',    who: 'Signed' },
        { n: 9, label: 'Distributed', icon: 'Send',     who: 'Referrer + portal' },
    ];
    const nodes = [];
    steps.forEach((s, i) => {
        const done = s.n <= 4;
        nodes.push(h('div', { class: 'pacs-flow-node' },
            h('div', { class: 'pacs-flow-ic' + (done ? ' done' : '') }, Icon(s.icon, { size: 16 })),
            h('div', { class: 'pacs-flow-n' }, String(s.n)),
            h('div', { class: 'pacs-flow-l' }, s.label),
            h('div', { class: 'pacs-flow-w' }, s.who),
        ));
        if (i < steps.length - 1) nodes.push(h('div', { class: 'pacs-flow-arrow' }, Icon('ChevronRight', { size: 14 })));
    });
    return h('div', { class: 'pacs-flow' }, ...nodes);
}

function pacsKpi({ label, value, unit, delta, trend, color, icon, suffix = '%', reverse, hideDelta }) {
    return h('div', { class: 'stat', style: { position: 'relative' } },
        h('div', { class: 'row' },
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: color, opacity: '0.12', position: 'absolute' } }),
            h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', color, position: 'relative' } }, Icon(icon, { size: 18 })),
            h('span', { class: 'grow' }),
            !hideDelta && Delta(reverse ? -(delta || 0) : (delta || 0), suffix),
        ),
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-value num' }, String(value), unit && h('span', { class: 'unit' }, unit)),
        Spark(trend, { color, w: 220, h: 30 }),
    );
}

// ───────────────────────── Worklist tab ─────────────────────────
function pacsWorklist() {
    const buckets = [
        { id: 'all',      label: 'All',         count: PACS_STUDIES.length },
        { id: 'unread',   label: 'To read',     count: PACS_STUDIES.filter(s => s.status === 'to-read').length, badge: 'warn' },
        { id: 'stat',     label: 'STAT',        count: PACS_STUDIES.filter(s => s.priority === 'stat').length, badge: 'crit' },
        { id: 'progress', label: 'In progress', count: PACS_STUDIES.filter(s => ['arrived','acquired','reading','reported'].includes(s.status)).length },
        { id: 'done',     label: 'Verified',    count: PACS_STUDIES.filter(s => s.status === 'verified').length },
    ];
    const shown = PACS_STUDIES.filter(s => {
        if (state.wlMod !== 'All' && s.mod !== state.wlMod) return false;
        if (state.wlFilter === 'unread')   return s.status === 'to-read';
        if (state.wlFilter === 'stat')     return s.priority === 'stat';
        if (state.wlFilter === 'progress') return ['arrived','acquired','reading','reported'].includes(s.status);
        if (state.wlFilter === 'done')     return s.status === 'verified';
        return true;
    });

    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
                ...buckets.map(b => h('button', {
                    onclick: () => { state.wlFilter = b.id; paint(); },
                    style: {
                        padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
                        border: '1px solid ' + (state.wlFilter === b.id ? 'var(--primary-500)' : 'var(--ink-100)'),
                        background: state.wlFilter === b.id ? 'var(--primary-50)' : 'white',
                        color: state.wlFilter === b.id ? 'var(--primary-700)' : 'var(--ink-700)',
                        fontSize: '12.5px', fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit',
                    },
                },
                    b.label,
                    h('span', { style: {
                        fontSize: '11px', padding: '0 6px', borderRadius: '999px',
                        background: b.badge === 'crit' ? 'var(--crit-50)' : b.badge === 'warn' ? 'var(--warn-50)' : 'var(--ink-50)',
                        color:      b.badge === 'crit' ? 'var(--crit-700)' : b.badge === 'warn' ? 'var(--warn-700)' : 'var(--ink-600)',
                        fontWeight: 700,
                    } }, String(b.count)),
                )),
            ),
            h('div', { class: 'segmented' },
                ...['All','CT','MRI','XR','US'].map(m => h('button', {
                    class: state.wlMod === m ? 'on' : '',
                    onclick: () => { state.wlMod = m; paint(); },
                }, m)),
            ),
        ),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Mod'), h('th', null, 'Patient'), h('th', null, 'Study'),
                h('th', null, 'Accession'), h('th', null, 'Referrer'),
                h('th', null, 'Images'), h('th', null, 'Priority'),
                h('th', null, 'Status'), h('th', null, 'Time'),
                h('th', { style: { width: '90px' } }),
            )),
            h('tbody', null, ...shown.map(s => h('tr', { style: { cursor: 'pointer' }, onclick: () => openInViewer(s) },
                h('td', null, modBadge(s.mod)),
                h('td', null, h('div', { class: 'row', style: { gap: '10px' } },
                    Avatar({ initials: s.patient.av, color: s.patient.avc, size: 'sm' }),
                    h('div', null,
                        h('div', { class: 'cell-strong' }, s.patient.name),
                        h('div', { class: 'muted cell-mono', style: { fontSize: '11px' } }, `${s.patient.mrn} · ${s.patient.age}${s.patient.sex}`),
                    ),
                )),
                h('td', { class: 'cell-strong', style: { maxWidth: '220px' } }, s.bodyPart),
                h('td', { class: 'cell-mono muted', style: { fontSize: '11.5px' } }, s.acc),
                h('td', { class: 'muted' }, s.ref),
                h('td', { class: 'num' }, String(s.images)),
                h('td', null, s.priority === 'stat'
                    ? h('span', { class: 'pacs-stat' }, 'STAT')
                    : h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Routine')),
                h('td', null, pacsStatus(s.status)),
                h('td', { class: 'muted num', style: { fontSize: '12px' } }, s.when),
                h('td', { onclick: (e) => e.stopPropagation() },
                    h('button', { class: 'btn btn-outline btn-sm', onclick: () => openInViewer(s) }, Icon('Image', { size: 13 }), ' Open'),
                ),
            ))),
        ),
    );
}

// ───────────────────────── Viewer tab ─────────────────────────
// Full-screen-style DICOM viewer embedded in the PACS tab. Left rail with
// study / patient / image meta + draft report, top toolbar with W/L · Pan ·
// Zoom · Magnify · Length · Angle · ROI · Ellipse · Probe · Annotate · Erase,
// preset dropdown, bottom cine scrubber. Synthetic cardiac MRI canvas stands
// in for real DICOM (swap for Cornerstone.js once `studies` table is wired).
const FOV_MM = 320;     // physical FOV across the canvas, used for length/area math

function pacsViewer(study) {
    const v = state.dv;
    const contrast = Math.max(45, Math.min(320, 100 * (380 / Math.max(40, v.wl.ww))));
    const brightness = Math.max(45, Math.min(220, 110 + (126 - v.wl.wl) / 5));
    const filter = `contrast(${contrast}%) brightness(${brightness}%) ${v.invert ? 'invert(1)' : ''}`;

    // ─── Helpers (closed over `v` so they always see the live state) ───
    const setTool  = (t) => { v.tool = t; v.pending = []; paint(); };
    const setFrame = (f) => { v.frame = (f + DV_FRAMES) % DV_FRAMES; paint(); };
    const addMark  = (m) => { m.id = v.nextId++; v.marks.push(m); paint(); };
    const norm = (e) => {
        if (!dvImageEl) return { x: 0.5, y: 0.5 };
        const r = dvImageEl.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
        };
    };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * FOV_MM;
    const angleDeg = (a, vx, c) => {
        const a1 = Math.atan2(a.y - vx.y, a.x - vx.x);
        const a2 = Math.atan2(c.y - vx.y, c.x - vx.x);
        let d = Math.abs((a1 - a2) * 180 / Math.PI); if (d > 180) d = 360 - d;
        return d.toFixed(0);
    };
    const eraseAt = (p) => {
        let bi = -1, bd = 0.06;
        v.marks.forEach((m, i) => { const q = m.a; const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; bi = i; } });
        if (bi >= 0) { v.marks.splice(bi, 1); paint(); }
    };

    const startDrag = (e, kind) => {
        const sx = e.clientX, sy = e.clientY;
        const base = { ...v.wl }, bz = v.zoom, bp = { ...v.pan };
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (kind === 'wl')        v.wl   = { ww: Math.max(20, Math.round(base.ww + dx * 3)), wl: Math.round(base.wl - dy * 2) };
            else if (kind === 'zoom') v.zoom = Math.max(0.4, Math.min(6, bz - dy * 0.008));
            else if (kind === 'pan' || kind === 'magnify') v.pan = { x: bp.x + dx, y: bp.y + dy };
            paint();
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
    const startShape = (type, p0) => {
        const move = (ev) => { v.draft = { type, a: p0, b: norm(ev) }; paint(); };
        const up = (ev) => {
            const p = norm(ev);
            if (Math.hypot(p.x - p0.x, p.y - p0.y) > 0.02) {
                const area = Math.abs((p.x - p0.x) * (p.y - p0.y)) * (FOV_MM / 10) * (FOV_MM / 10);
                addMark({ type, a: p0, b: p, area: area.toFixed(1), mean: 80 + Math.floor(80 + (p0.x + p0.y) * 60) % 120 });
            }
            v.draft = null; paint();
            window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };

    const onDown = (e) => {
        if (e.button === 2) { startDrag(e, 'zoom'); return; }
        if (e.button === 1) { startDrag(e, 'pan');  return; }
        const p = norm(e);
        if (v.tool === 'wl' || v.tool === 'pan' || v.tool === 'zoom' || v.tool === 'magnify') { startDrag(e, v.tool); return; }
        if (v.tool === 'roi' || v.tool === 'ellipse') { v.draft = { type: v.tool, a: p, b: p }; startShape(v.tool, p); return; }
        if (v.tool === 'probe') { addMark({ type: 'probe', a: p, value: 60 + Math.round((1 - p.y) * 180) }); return; }
        if (v.tool === 'annotate') {
            const b = { x: Math.min(0.95, p.x + 0.16), y: Math.max(0.05, p.y - 0.16) };
            addMark({ type: 'annotate', a: p, b, text: '', editing: true });
            return;
        }
        if (v.tool === 'erase')  { eraseAt(p); return; }
        if (v.tool === 'length') {
            const nx = [...v.pending, p];
            if (nx.length === 2) { addMark({ type: 'length', a: nx[0], b: nx[1], mm: dist(nx[0], nx[1]).toFixed(1) }); v.pending = []; }
            else { v.pending = nx; paint(); }
            return;
        }
        if (v.tool === 'angle') {
            const nx = [...v.pending, p];
            if (nx.length === 3) { addMark({ type: 'angle', a: nx[0], v: nx[1], c: nx[2], deg: angleDeg(nx[0], nx[1], nx[2]) }); v.pending = []; }
            else { v.pending = nx; paint(); }
            return;
        }
    };

    const onWheel = (e) => { e.preventDefault(); setFrame(v.frame + (e.deltaY > 0 ? 1 : -1)); };
    const commitText = (id, text) => {
        const m = v.marks.find(x => x.id === id);
        if (!m) return;
        m.text = text || 'annotation';
        m.editing = false;
        paint();
    };

    // ─── Toolbar buttons ───
    const TOOLS_A = [
        { id: 'wl', label: 'W/L' }, { id: 'pan', label: 'Pan' },
        { id: 'zoom', label: 'Zoom' }, { id: 'magnify', label: 'Magnify' },
    ];
    const TOOLS_B = [
        { id: 'length',   label: 'Length',   g: '↔' },
        { id: 'angle',    label: 'Angle',    g: '∠' },
        { id: 'roi',      label: 'ROI',      g: '▭' },
        { id: 'ellipse',  label: 'Ellipse',  g: '⬭' },
        { id: 'probe',    label: 'Probe',    g: '◎' },
        { id: 'annotate', label: 'Annotate', g: '→' },
        { id: 'erase',    label: 'Erase',    g: '✕' },
    ];
    const toolBtn = (t, glyph) => h('button', { class: 'dv-tool' + (v.tool === t.id ? ' on' : ''), onclick: () => setTool(t.id) },
        glyph && h('span', { class: 'g' }, glyph),
        t.label,
    );

    const toolbar = h('div', { class: 'dv-toolbar' },
        ...TOOLS_A.map(t => toolBtn(t)),
        h('span', { class: 'dv-sep' }),
        ...TOOLS_B.map(t => toolBtn(t, t.g)),
        h('span', { class: 'dv-sep' }),
        h('select', {
            class: 'dv-select', value: '',
            onchange: (e) => {
                const p = DV_PRESETS.find(x => x.id === e.target.value);
                if (p) { v.wl = { ww: p.ww, wl: p.wl }; paint(); }
                e.target.value = '';
            },
        },
            h('option', { value: '' }, 'Preset…'),
            ...DV_PRESETS.map(p => h('option', { value: p.id }, p.label)),
        ),
        h('button', { class: 'dv-tool' + (v.invert ? ' on' : ''), onclick: () => { v.invert = !v.invert; paint(); } }, 'Invert'),
        h('button', { class: 'dv-tool', onclick: () => { v.zoom = 1; v.pan = { x: 0, y: 0 }; v.wl = { ww: 252, wl: 126 }; paint(); } }, 'Reset'),
        h('button', { class: 'dv-tool', onclick: () => { v.marks = []; v.pending = []; v.draft = null; paint(); } }, 'Clear marks'),
        h('span', { class: 'grow' }),
        h('button', { class: 'dv-tool' }, h('span', { class: 'g' }, '⬓'), 'Save PNG'),
        h('button', { class: 'dv-tool' }, h('span', { class: 'g' }, '⤓'), 'DICOM'),
        h('button', { class: 'dv-tool' }, h('span', { class: 'g' }, '⎙'), 'Print'),
        h('button', { class: 'dv-tool' }, h('span', { class: 'g' }, '↗'), 'Share'),
    );

    // ─── Stage ───
    const cursorMap = {
        pan: 'grab', zoom: 'ns-resize',
        length: 'crosshair', angle: 'crosshair', annotate: 'crosshair',
        probe: 'crosshair', roi: 'crosshair', ellipse: 'crosshair', erase: 'crosshair',
    };
    const image = h('div', {
        class: 'dv-image',
        style: { transform: `translate(${v.pan.x}px, ${v.pan.y}px) scale(${v.zoom})` },
        ref: (el) => { dvImageEl = el; },
    }, cardiacCanvas(v.frame, filter), dvMarksLayer(v, commitText));

    const overlayName = (study && study.patient && study.patient.name) || 'Sherzod Mirzaev';
    const overlayMod  = (study && modInfo(study.mod).label) || 'MR';
    const overlayPart = (study && study.bodyPart) || 'Heart';

    const stage = h('div', {
        class: 'dv-stage',
        style: { cursor: cursorMap[v.tool] || 'default' },
        onmousedown: onDown,
        onwheel: onWheel,
        oncontextmenu: (e) => e.preventDefault(),
    },
        image,
        h('div', { class: 'dv-ov tl' },
            h('div', { class: 'b' }, overlayName),
            h('div', null, 'Cardiac MRI cine — multi-frame stack'),
        ),
        h('div', { class: 'dv-ov tr' },
            h('div', null, `${overlayMod} · ${overlayPart}`),
            h('div', null, new Date(state.openStudy?.when || Date.now()).toString().slice(0, 1) ? '2026-06-02' : '2026-06-02'),
        ),
        h('div', { class: 'dv-ov bl' },
            h('div', null, `WW ${Math.round(v.wl.ww)}  WL ${Math.round(v.wl.wl)}`),
            h('div', null, `Zoom ${(v.zoom * 100).toFixed(0)}%`),
            h('div', { class: 'dim' }, `ready · ${DV_FRAMES} images · loaded in 9ms`),
        ),
        h('div', { class: 'dv-ov br' },
            h('div', { class: 'b' }, `slice ${v.frame + 1} / ${DV_FRAMES}`),
        ),
    );

    // ─── Scrubber ───
    const pct = (v.frame / (DV_FRAMES - 1)) * 100;
    const scrub = h('div', { class: 'dv-scrub' },
        h('button', { class: 'dv-pbtn', title: 'First',     onclick: () => setFrame(0) }, '⏮'),
        h('button', { class: 'dv-pbtn', title: 'Previous',  onclick: () => setFrame(v.frame - 1) }, '◀'),
        h('input', {
            class: 'dv-range', type: 'range', min: 0, max: String(DV_FRAMES - 1), value: String(v.frame),
            style: { background: `linear-gradient(90deg, var(--dv-accent) ${pct}%, #2a3640 ${pct}%)` },
            oninput: (e) => setFrame(Number(e.target.value)),
        }),
        h('button', { class: 'dv-pbtn accent', title: 'Play / Pause',
            onclick: () => { v.playing ? stopDvCine() : startDvCine(); paint(); } }, v.playing ? '❚❚' : '▶'),
        h('button', { class: 'dv-pbtn', title: 'Next', onclick: () => setFrame(v.frame + 1) }, '▶▶'),
        h('span', { class: 'dv-slabel' }, `slice ${v.frame + 1} / ${DV_FRAMES}`),
    );

    return h('div', { class: 'dv dv-embed' },
        dvLeftRail(study, v),
        h('div', { class: 'dv-main' }, toolbar, stage, scrub),
    );
}

// Left info rail — study / patient / image / report / source / mouse controls.
function dvLeftRail(study, v) {
    const sec = (title, ...children) => h('div', { class: 'dv-sec' },
        h('div', { class: 'dv-sec-t' }, title),
        ...children,
    );
    const kv = (k, val) => h('div', { class: 'dv-kv' },
        h('span', { class: 'k' }, k),
        h('span', { class: 'v' }, String(val)),
    );

    const p     = study && study.patient || {};
    const studyId   = study?.id || '—';
    const modality  = study ? modInfo(study.mod).label : 'MR';
    const bodyPart  = study?.bodyPart || 'Heart';
    const patName   = p.name || 'Sherzod Mirzaev';
    const patDob    = p.dob || '1976-11-02';
    const patId     = p.mrn || 'pat-002';

    return h('aside', { class: 'dv-rail' },
        sec('Study',
            kv('ID', studyId),
            kv('Modality', modality),
            kv('Body part', bodyPart),
            kv('Date', '2026-06-02'),
        ),
        sec('Patient',
            kv('Name', patName),
            kv('DOB', patDob),
            kv('ID', patId),
        ),
        sec('Image',
            kv('Size', '256 × 256'),
            kv('Frames', DV_FRAMES),
            kv('Bits / pixel', '8'),
            kv('WW / WL', `${Math.round(v.wl.ww)} / ${Math.round(v.wl.wl)}`),
        ),
        sec('Radiology report',
            h('textarea', {
                class: 'dv-report', disabled: v.signed ? true : null,
                oninput: (e) => { v.report = e.target.value; },
            }, v.report),
            h('div', { class: 'dv-rbtns' },
                h('button', { class: 'dv-btn ghost', disabled: v.signed ? true : null }, 'Save draft'),
                h('button', {
                    class: 'dv-btn ' + (v.signed ? 'locked' : 'accent'),
                    onclick: () => { v.signed = !v.signed; paint(); },
                }, v.signed ? '🔒 Locked' : 'Sign & lock'),
            ),
            h('div', { class: 'dv-rmeta' }, v.signed ? 'signed 02.06.2026, 15:48:02' : 'draft · saved 02.06.2026, 15:47:11'),
        ),
        sec('Source',
            kv('Stored at', 'clinic-agent'),
            kv('Streamed via', 'cloud cache'),
        ),
        sec('Mouse controls',
            kv('Left-drag', DV_TOOL_LABEL[v.tool] || v.tool),
            kv('Middle-drag', 'pan'),
            kv('Right-drag', 'zoom'),
            kv('Wheel', 'scroll slices'),
        ),
    );
}

// SVG overlay with all marks (length/angle/roi/ellipse/probe/annotate) + draft
// shape + pending click dots, plus the HTML labels that sit on top of the SVG.
function dvMarksLayer(v, commitText) {
    const all = v.draft ? [...v.marks, v.draft] : v.marks;
    const C = '#39d98a';
    const svgParts = all.map(m => {
        if (m.type === 'length') {
            return `<line x1="${m.a.x*100}" y1="${m.a.y*100}" x2="${m.b.x*100}" y2="${m.b.y*100}" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>
                <circle cx="${m.a.x*100}" cy="${m.a.y*100}" r="0.7" fill="${C}"/>
                <circle cx="${m.b.x*100}" cy="${m.b.y*100}" r="0.7" fill="${C}"/>`;
        }
        if (m.type === 'angle') {
            return `<line x1="${m.a.x*100}" y1="${m.a.y*100}" x2="${m.v.x*100}" y2="${m.v.y*100}" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>
                <line x1="${m.c.x*100}" y1="${m.c.y*100}" x2="${m.v.x*100}" y2="${m.v.y*100}" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>
                <circle cx="${m.v.x*100}" cy="${m.v.y*100}" r="0.7" fill="${C}"/>`;
        }
        if (m.type === 'roi') {
            const x = Math.min(m.a.x, m.b.x) * 100, y = Math.min(m.a.y, m.b.y) * 100;
            const w = Math.abs(m.a.x - m.b.x) * 100, hh = Math.abs(m.a.y - m.b.y) * 100;
            return `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="rgba(57,217,138,0.08)" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
        }
        if (m.type === 'ellipse') {
            const cx = (m.a.x + m.b.x) / 2 * 100, cy = (m.a.y + m.b.y) / 2 * 100;
            const rx = Math.abs(m.a.x - m.b.x) / 2 * 100, ry = Math.abs(m.a.y - m.b.y) / 2 * 100;
            return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="rgba(57,217,138,0.08)" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
        }
        if (m.type === 'probe') {
            const x = m.a.x * 100, y = m.a.y * 100;
            return `<circle cx="${x}" cy="${y}" r="0.8" fill="none" stroke="${C}" stroke-width="1" vector-effect="non-scaling-stroke"/>
                <line x1="${x-1.4}" y1="${y}" x2="${x+1.4}" y2="${y}" stroke="${C}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>
                <line x1="${x}" y1="${y-1.4}" x2="${x}" y2="${y+1.4}" stroke="${C}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`;
        }
        if (m.type === 'annotate') {
            return `<circle cx="${m.a.x*100}" cy="${m.a.y*100}" r="0.9" fill="none" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke"/>
                <line x1="${m.a.x*100}" y1="${m.a.y*100}" x2="${m.b.x*100}" y2="${m.b.y*100}" stroke="#fff" stroke-width="0.8" vector-effect="non-scaling-stroke"/>
                <circle cx="${m.b.x*100}" cy="${m.b.y*100}" r="0.8" fill="none" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
        }
        return '';
    }).join('');
    const pendingDots = (v.pending || []).map(p => `<circle cx="${p.x*100}" cy="${p.y*100}" r="0.7" fill="#ffd23f"/>`).join('');
    const svg = html(`<svg class="dv-marks" viewBox="0 0 100 100" preserveAspectRatio="none">${svgParts}${pendingDots}</svg>`);

    // HTML labels (positioned in % so they survive zoom/pan)
    const labels = [];
    all.forEach(m => {
        if (m.type === 'length') labels.push(dvLbl((m.a.x + m.b.x) / 2, (m.a.y + m.b.y) / 2, `${m.mm} mm`));
        else if (m.type === 'angle') labels.push(dvLbl(m.v.x, m.v.y, `${m.deg}°`, 8, -4));
        else if (m.type === 'probe') labels.push(dvLbl(m.a.x, m.a.y, `sig ${m.value}`, 8, -8));
        else if (m.type === 'roi' || m.type === 'ellipse') labels.push(dvLbl(Math.max(m.a.x, m.b.x), Math.min(m.a.y, m.b.y), `${m.area} cm² · μ${m.mean}`, 4, -2));
        else if (m.type === 'annotate') {
            if (m.editing) {
                labels.push(h('input', {
                    class: 'dv-anno-input', autofocus: true,
                    style: { left: `${m.b.x * 100}%`, top: `${m.b.y * 100}%` },
                    onkeydown: (e) => { if (e.key === 'Enter') commitText(m.id, e.target.value); },
                    onblur: (e) => commitText(m.id, e.target.value),
                }));
            } else {
                labels.push(h('span', { class: 'dv-anno', style: { left: `${m.b.x * 100}%`, top: `${m.b.y * 100}%` } }, m.text || ''));
            }
        }
    });

    return h('div', { style: { position: 'absolute', inset: 0 } }, svg, ...labels);
}

function dvLbl(x, y, text, dx = 6, dy = -6) {
    return h('span', {
        class: 'dv-mlbl',
        style: { left: `${x * 100}%`, top: `${y * 100}%`, transform: `translate(${dx}px, ${dy}px)` },
    }, text);
}

// Cardiac MRI cine canvas — synthetic deterministic frames (0..15) of a
// beating heart. Used as a stand-in until real DICOM is wired through
// Cornerstone.js loaders.
function cardiacCanvas(frame, cssFilter) {
    const cv = document.createElement('canvas');
    cv.className = 'dv-canvas';
    cv.style.filter = cssFilter;
    drawCardiacFrame(cv, frame);
    return cv;
}

function drawCardiacFrame(cv, frame) {
    const N = 420; cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    let seed = (frame * 2654435761 + 12345) % 2147483647;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed % 1000) / 1000; };
    const phase = (Math.sin(frame / DV_FRAMES * Math.PI * 2) + 1) / 2;
    const cx = N * 0.50, cy = N * 0.52;

    ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, N, N);

    const base = ctx.createRadialGradient(cx, cy, N * 0.15, cx, cy, N * 0.7);
    base.addColorStop(0, '#10161b'); base.addColorStop(1, '#080b0e');
    ctx.fillStyle = base; ctx.fillRect(0, 0, N, N);

    const chest = ctx.createRadialGradient(cx, cy, N * 0.1, cx, cy, N * 0.62);
    chest.addColorStop(0, '#1b2228'); chest.addColorStop(1, '#0a0e11');
    ctx.fillStyle = chest;
    ctx.beginPath(); ctx.ellipse(cx, cy, N * 0.50, N * 0.47, 0, 0, 7); ctx.fill();

    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(-0.35);
    ctx.strokeStyle = 'rgba(225,232,236,0.55)'; ctx.lineWidth = N * 0.018;
    ctx.beginPath(); ctx.ellipse(0, 0, N * 0.34, N * 0.29, 0, 0, 7); ctx.stroke();
    ctx.fillStyle = '#5a6168';
    ctx.beginPath(); ctx.ellipse(0, 0, N * 0.325, N * 0.275, 0, 0, 7); ctx.fill();

    const blood = (x, y, r, bright = 0.95) => {
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, `rgba(220,228,234,${bright})`);
        g.addColorStop(0.7, `rgba(190,200,208,${bright * 0.8})`);
        g.addColorStop(1, 'rgba(120,130,138,0.15)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.92, 0, 0, 7); ctx.fill();
    };
    const s = 0.82 + 0.30 * phase;
    blood(-N * 0.05,  -N * 0.04, N * 0.105 * s);
    blood( N * 0.115, -N * 0.02, N * 0.085 * s, 0.9);
    blood(-N * 0.02,   N * 0.155, N * 0.075 * s, 0.85);
    blood( N * 0.13,   N * 0.145, N * 0.065 * s, 0.82);
    ctx.fillStyle = 'rgba(70,78,85,0.9)';
    ctx.beginPath(); ctx.arc(-N * 0.075, -N * 0.02, N * 0.014, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(-N * 0.025, -N * 0.06, N * 0.013, 0, 7); ctx.fill();
    ctx.restore();

    blood(cx + N * 0.20, cy + N * 0.20, N * 0.03, 0.9);

    for (let i = 0; i < 5200; i++) {
        const ang = rnd() * Math.PI * 2, rad = rnd() * N * 0.46;
        const px = cx + Math.cos(ang) * rad * 1.05, py = cy + Math.sin(ang) * rad;
        const vv = rnd();
        ctx.fillStyle = `rgba(200,208,214,${vv * 0.10})`;
        ctx.fillRect(px, py, 1, 1);
    }
    const vg = ctx.createRadialGradient(cx, cy, N * 0.32, cx, cy, N * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, N, N);
}

// ───────────────────────── Reporting tab ─────────────────────────
function pacsReporting(study) {
    const templates = {
        CT:  { tech: 'Helical CT of the head was performed without intravenous contrast. 1.0 mm axial sections with coronal and sagittal reformats.', find: 'No acute intracranial hemorrhage, mass effect or midline shift. Grey–white differentiation preserved. Ventricles and sulci are age-appropriate. No extra-axial collection. Visualized paranasal sinuses and mastoids are clear.', imp: 'No acute intracranial abnormality.' },
        MRI: { tech: 'Multiplanar, multisequence MRI was performed. T1, T2, FLAIR, DWI/ADC and post-contrast T1 sequences obtained.', find: 'No restricted diffusion to suggest acute infarct. No abnormal parenchymal signal or enhancing lesion. Normal flow voids. No mass effect.', imp: 'Unremarkable MRI of the brain.' },
        XR:  { tech: 'PA and lateral chest radiographs.', find: 'Lungs are clear and well expanded. No focal consolidation, effusion or pneumothorax. Cardiomediastinal silhouette within normal limits. Osseous structures intact.', imp: 'No acute cardiopulmonary process.' },
        US:  { tech: 'Real-time grayscale and color Doppler ultrasound of the abdomen.', find: 'Liver normal in size and echotexture. Gallbladder without stones or wall thickening. No biliary dilatation. Kidneys normal bilaterally. No free fluid.', imp: 'Normal abdominal ultrasound.' },
    };
    const tpl = templates[study.mod] || templates.CT;

    const findingsTA   = h('textarea', { class: 'pr-area', rows: '7', placeholder: 'Describe the findings, or insert a template above…',
        oninput: (e) => { state.report.findings = e.target.value; } }, state.report.findings);
    const impressionTA = h('textarea', { class: 'pr-area imp', rows: '3', placeholder: 'Summary impression / diagnosis…',
        oninput: (e) => { state.report.impression = e.target.value; } }, state.report.impression);

    return h('div', { class: 'pacs-report' },
        // Left: study + key images
        h('div', { class: 'card', style: { alignSelf: 'flex-start' } },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Image', { size: 16 }), ' Study')),
            h('div', { style: { padding: '16px' } },
                h('div', { class: 'row', style: { gap: '12px', marginBottom: '14px' } },
                    modBadge(study.mod),
                    h('div', null,
                        h('div', { class: 'cell-strong', style: { fontSize: '14px' } }, study.patient.name),
                        h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${study.patient.mrn} · ${study.patient.age}${study.patient.sex} · ${study.acc}`),
                    ),
                ),
                h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)', marginBottom: '10px' } }, study.bodyPart),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
                    ...[0,1,2,3].map(i => h('div', { class: 'pr-keyimg' },
                        sliceCanvas({
                            mod: study.mod,
                            plane: ['ax','co','sa','ax'][i],
                            slice: [20,18,16,28][i],
                            total: 48,
                            thumb: true,
                        }),
                    )),
                ),
                h('div', { class: 'pr-meta' },
                    kvRow('Referrer', study.ref),
                    kvRow('Series / images', `${study.series} / ${study.images}`),
                    kvRow('Acquired', `Today ${study.when}`),
                    kvRow('Priority', study.priority === 'stat' ? 'STAT' : 'Routine'),
                ),
            ),
        ),

        // Right: report editor
        h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Doc', { size: 16 }), ' Radiology report'),
                h('button', {
                    class: 'btn btn-outline btn-sm',
                    onclick: () => { state.report.findings = tpl.find; state.report.impression = tpl.imp; paint(); },
                }, Icon('Layers', { size: 13 }), ` Insert ${modInfo(study.mod).label} template`),
            ),
            h('div', { style: { padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' } },
                h('div', null,
                    h('div', { class: 'pr-label' }, 'Technique'),
                    h('div', { class: 'pr-readonly' }, tpl.tech),
                ),
                h('div', null,
                    h('div', { class: 'pr-label' }, 'Findings'),
                    findingsTA,
                ),
                h('div', null,
                    h('div', { class: 'pr-label' }, 'Impression'),
                    impressionTA,
                ),
                h('label', { class: 'pr-critical' },
                    h('button', { class: 'cbx' + (state.report.critical ? ' on' : ''), onclick: (e) => { e.preventDefault(); state.report.critical = !state.report.critical; paint(); } },
                        state.report.critical && Icon('Check', { size: 12 })),
                    h('div', null,
                        h('div', { style: { fontSize: '13px', fontWeight: 700, color: state.report.critical ? 'var(--crit-700)' : 'var(--ink-900)' } }, 'Critical / urgent finding'),
                        h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Triggers immediate call-back to the referring doctor and a flag on the patient record.'),
                    ),
                ),
                h('div', { class: 'pr-foot' },
                    h('span', { class: 'muted', style: { fontSize: '12px' } },
                        Icon('User', { size: 12, style: { verticalAlign: '-2px' } }), ' Reading: R. Xolmatov, MD · Radiology'),
                    h('span', { class: 'grow' }),
                    h('button', { class: 'btn btn-outline' }, 'Save draft'),
                    h('button', { class: 'btn btn-primary' }, Icon('Check', { size: 14 }), ' Verify & sign'),
                ),
            ),
        ),
    );
}

function kvRow(k, v) {
    return h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--ink-200)', fontSize: '12.5px' } },
        h('span', { class: 'muted' }, k),
        h('span', { style: { color: 'var(--ink-900)', fontWeight: 600 } }, v),
    );
}

// ───────────────────────── Equipment / Modalities tab ─────────────────────────
function pacsEquipment() {
    const eq = [
        { mod: 'CT',  name: 'Siemens SOMATOM · CT-1',  room: 'Imaging · room 1', state: 'scanning', util: 78, queue: 3, today: 16 },
        { mod: 'MRI', name: 'GE SIGNA 1.5T · MR-1',    room: 'Imaging · room 2', state: 'online',   util: 64, queue: 2, today: 9 },
        { mod: 'XR',  name: 'Carestream DRX · XR-1',   room: 'Imaging · room 3', state: 'online',   util: 41, queue: 1, today: 9 },
        { mod: 'US',  name: 'Philips Affiniti · US-1', room: 'Cardiology suite', state: 'idle',     util: 22, queue: 0, today: 4 },
        { mod: 'XR',  name: 'Portable DR · XR-2',      room: 'Ward / bedside',   state: 'offline',  util: 0,  queue: 0, today: 0 },
    ];
    const stateMap = {
        scanning: { label: 'Scanning', color: 'var(--primary-600)', bg: 'var(--primary-50)' },
        online:   { label: 'Online',   color: 'var(--ok-700)',      bg: 'var(--ok-50)' },
        idle:     { label: 'Idle',     color: 'var(--ink-500)',     bg: 'var(--ink-50)' },
        offline:  { label: 'Offline',  color: 'var(--crit-700)',    bg: 'var(--crit-50)' },
    };
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' } },
        ...eq.map(e => {
            const s = stateMap[e.state];
            return h('div', { class: 'card', style: { padding: '18px' } },
                h('div', { class: 'row', style: { gap: '12px' } },
                    modBadge(e.mod, true),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { class: 'row', style: { gap: '8px' } },
                            h('span', { style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--ink-900)' } }, e.name),
                            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 9px', borderRadius: '999px', background: s.bg, color: s.color, fontSize: '11px', fontWeight: 700 } },
                                h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: s.color } }), s.label),
                        ),
                        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, e.room),
                    ),
                ),
                h('div', { style: { marginTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } },
                    eqStat('Studies today', String(e.today)),
                    eqStat('In queue', String(e.queue), e.queue > 2 ? 'warn' : null),
                    eqStat('Utilization', e.util + '%', e.util > 75 ? 'warn' : e.util === 0 ? 'crit' : 'ok'),
                ),
                h('div', { style: { marginTop: '12px' } },
                    h('div', { style: { height: '6px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
                        h('div', { style: { width: e.util + '%', height: '100%', background: e.util > 75 ? 'var(--warn-500)' : e.util === 0 ? 'var(--ink-200)' : 'var(--primary-500)', borderRadius: '999px' } }),
                    ),
                ),
            );
        }),
    );
}

function eqStat(label, value, kind) {
    return h('div', { style: { padding: '8px 10px', borderRadius: '8px', background: 'var(--ink-25)', border: '1px solid var(--ink-100)' } },
        h('div', { class: 'muted', style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { class: 'num', style: { fontSize: '17px', fontWeight: 700, marginTop: '2px',
            color: kind === 'ok' ? 'var(--ok-700)' : kind === 'warn' ? 'var(--warn-700)' : kind === 'crit' ? 'var(--crit-700)' : 'var(--ink-900)' } }, value),
    );
}

// ───────────────────────── Shared bits ─────────────────────────
function modBadge(mod, lg) {
    const m = modInfo(mod);
    return h('span', {
        style: {
            display: 'inline-grid', placeItems: 'center',
            width: lg ? '44px' : '30px', height: lg ? '44px' : '30px',
            borderRadius: lg ? '11px' : '8px',
            background: `color-mix(in oklab, ${m.color} 14%, white)`,
            color: m.color, fontWeight: 800, fontSize: lg ? '13px' : '10.5px', letterSpacing: '0.02em',
            border: `1px solid color-mix(in oklab, ${m.color} 30%, white)`,
        },
    }, m.label);
}

function pacsStatus(status) {
    const m = PACS_STATUS[status];
    if (!m) return null;
    return h('span', {
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '2px 9px', borderRadius: '999px',
            background: `color-mix(in oklab, ${m.dot} 12%, white)`,
            color: m.dot, border: `1px solid color-mix(in oklab, ${m.dot} 35%, white)`,
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
        },
    },
        h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: m.dot } }),
        m.label,
    );
}

function pacsDonut({ segments, size = 132, stroke = 18, center, sub }) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    const r = (size - stroke) / 2, c = 2 * Math.PI * r;
    let acc = 0;
    const arcs = segments.map((s) => {
        const frac = s.value / total, len = c * frac, off = -acc * c; acc += frac;
        return `<circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${s.color}" stroke-width="${stroke}" fill="none" stroke-dasharray="${len} ${c-len}" stroke-dashoffset="${off}"/>`;
    }).join('');
    const svg = html(`<svg width="${size}" height="${size}" style="transform:rotate(-90deg);display:block">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="var(--ink-100)" stroke-width="${stroke}" fill="none"/>
        ${arcs}
    </svg>`);
    return h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px' } },
        svg,
        h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' } },
            h('div', { style: { textAlign: 'center' } },
                h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700, color: 'var(--ink-900)' } }, String(center)),
                h('div', { class: 'muted', style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, sub),
            ),
        ),
    );
}

// Synthetic DICOM-ish slice renderer — deterministic per (mod, plane, slice).
// In a later pass this gets replaced by Cornerstone.js loading real DICOM
// bytes from a signed Supabase Storage URL.
function sliceCanvas({ mod, plane, slice, total, thumb }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pv-canvas';
    const N = thumb ? 96 : 360;
    canvas.width = N; canvas.height = N;
    drawSlice(canvas, { mod, plane, slice, total, thumb });
    // Apply window/level filter from current viewer state if we're in viewer.
    const v = state.viewer;
    if (v) {
        const contrast = Math.max(40, Math.min(320, 100 * (400 / Math.max(40, v.wl.ww))));
        const brightness = Math.max(40, Math.min(220, 100 + (40 - v.wl.wc) / 6));
        canvas.style.filter = `contrast(${contrast}%) brightness(${brightness}%) ${v.invert ? 'invert(1)' : ''}`;
    }
    return canvas;
}

function drawSlice(cv, { mod, plane, slice, total, thumb }) {
    const N = cv.width;
    const ctx = cv.getContext('2d');
    let seed = (slice * 2654435761 + plane.charCodeAt(0) * 40503) % 2147483647;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed % 1000) / 1000; };

    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, N, N);
    const cx = N / 2, cy = N / 2;
    const t = total > 1 ? slice / (total - 1) : 0.5;
    const env = Math.sin(t * Math.PI);
    const bodyR = N * (0.22 + 0.20 * env);

    if (mod === 'XR') {
        const g = ctx.createLinearGradient(0, 0, 0, N);
        g.addColorStop(0, '#1c2329'); g.addColorStop(1, '#2c353d');
        ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
        ctx.fillStyle = 'rgba(220,225,230,0.55)';
        ctx.fillRect(cx - N * 0.03, N * 0.12, N * 0.06, N * 0.7);
        ctx.fillStyle = '#0c1115';
        ctx.beginPath(); ctx.ellipse(cx - N * 0.17, cy, N * 0.14, N * 0.26, 0, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx + N * 0.17, cy, N * 0.14, N * 0.26, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(200,208,214,0.35)'; ctx.lineWidth = N * 0.012;
        for (let r = 0; r < 7; r++) {
            ctx.beginPath(); ctx.arc(cx, cy - N * 0.1, N * (0.12 + r * 0.045), 0.2, Math.PI - 0.2); ctx.stroke();
        }
    } else {
        const isMRI = mod === 'MRI';
        const grad = ctx.createRadialGradient(cx, cy, bodyR * 0.1, cx, cy, bodyR);
        if (isMRI) { grad.addColorStop(0, '#9aa6ad'); grad.addColorStop(0.7, '#6a747b'); grad.addColorStop(1, '#3a4147'); }
        else       { grad.addColorStop(0, '#5a636a'); grad.addColorStop(0.7, '#454d53'); grad.addColorStop(1, '#2a3035'); }
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.ellipse(cx, cy, bodyR * 1.05, bodyR, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = isMRI ? 'rgba(20,24,28,0.8)' : 'rgba(235,240,244,0.85)';
        ctx.lineWidth = N * (mod === 'CT' && env > 0.7 ? 0.02 : 0.012);
        ctx.beginPath(); ctx.ellipse(cx, cy, bodyR * 1.05, bodyR, 0, 0, 7); ctx.stroke();
        const blobs = 3 + Math.floor(env * 3);
        for (let i = 0; i < blobs; i++) {
            const ang = rnd() * Math.PI * 2, rad = rnd() * bodyR * 0.55;
            const bx = cx + Math.cos(ang) * rad, by = cy + Math.sin(ang) * rad;
            const br = bodyR * (0.12 + rnd() * 0.18);
            const bg = ctx.createRadialGradient(bx, by, 1, bx, by, br);
            const dark = isMRI ? rnd() > 0.5 : rnd() > 0.6;
            bg.addColorStop(0, dark ? 'rgba(10,14,18,0.85)' : 'rgba(150,160,168,0.55)');
            bg.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, br, 0, 7); ctx.fill();
        }
        if (env > 0.55) {
            ctx.fillStyle = isMRI ? 'rgba(220,228,234,0.5)' : 'rgba(12,16,20,0.8)';
            ctx.beginPath(); ctx.ellipse(cx - bodyR * 0.12, cy, bodyR * 0.08, bodyR * 0.22, -0.3, 0, 7); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx + bodyR * 0.12, cy, bodyR * 0.08, bodyR * 0.22, 0.3, 0, 7); ctx.fill();
        }
        if (env < 0.5) {
            ctx.fillStyle = mod === 'CT' ? 'rgba(235,240,244,0.8)' : 'rgba(20,24,28,0.7)';
            ctx.beginPath(); ctx.arc(cx, cy + bodyR * 0.6, bodyR * 0.12, 0, 7); ctx.fill();
        }
        const dots = thumb ? 250 : 2600;
        for (let i = 0; i < dots; i++) {
            const ang = rnd() * Math.PI * 2, rad = rnd() * bodyR;
            const px = cx + Math.cos(ang) * rad * 1.05, py = cy + Math.sin(ang) * rad;
            const v2 = rnd();
            ctx.fillStyle = `rgba(${isMRI ? 200 : 180},${isMRI ? 208 : 188},${isMRI ? 214 : 196},${v2 * 0.10})`;
            ctx.fillRect(px, py, 1, 1);
        }
    }
}
