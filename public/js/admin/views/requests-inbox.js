// «Заявки» — registrator inbox + funnel/history (REQUESTS_INBOX_V3, redesigned to EasyMed's design
// language: teal hero + .stat KPI cards + .segmented funnel toggle + clean .card requests).
// Активные = status='requested' (Symptex bookings + doctor-less lab/procedure/appointment requests):
//   assign doctor+time (-> scheduled) / accept no-doctor (-> registered) / reject WITH A REASON (-> cancelled).
// История = every Symptex-originated request that was processed or DROPPED, with the rejection reason +
//   WHO rejected + WHEN — nothing is deleted (cancel_reason/cancelled_by/cancelled_at on the visit), so
//   the admin sees the real funnel. Writes via the RLS-scoped supabase client.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

const RU_MO = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.'];
const pad = (n) => String(n).padStart(2, '0');
const SYMPTEX_LIKE = '%Symptex%';
const ACTIVE_SEL = 'id, patient_id, doctor_id, service_id, branch_id, room_id, visit_date, duration_minutes, notes, visit_no, created_at, status';
const HIST_SEL = ACTIVE_SEL + ', cancel_reason, cancelled_by, cancelled_at';

const OUTCOME = {
    scheduled:   ['Записан',   'var(--primary-700, #115d5a)', 'var(--primary-50, #effaf8)'],
    confirmed:   ['Подтверждён', 'var(--primary-700, #115d5a)', 'var(--primary-50, #effaf8)'],
    arrived:     ['Пришёл',    'var(--ok-700, #047857)',      'var(--ok-50, #ecfdf5)'],
    in_progress: ['На приёме',  'var(--ok-700, #047857)',     'var(--ok-50, #ecfdf5)'],
    registered:  ['Принят',    'var(--ok-700, #047857)',      'var(--ok-50, #ecfdf5)'],
    completed:   ['Завершён',  'var(--ink-500, #55636d)',     'var(--ink-50, #f3f5f7)'],
    concluded:   ['Завершён',  'var(--ink-500, #55636d)',     'var(--ink-50, #f3f5f7)'],
    closed:      ['Завершён',  'var(--ink-500, #55636d)',     'var(--ink-50, #f3f5f7)'],
    cancelled:   ['Отклонён',  'var(--crit-700, #b91c1c)',    'var(--crit-50, #fef2f2)'],
    no_show:     ['Не пришёл', 'var(--warn-700, #b45309)',    'var(--warn-50, #fffbeb)'],
};
const outcomeOf = (s) => OUTCOME[s] || [s || '—', 'var(--ink-500, #55636d)', 'var(--ink-50, #f3f5f7)'];
const currentUserId = () => (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null;

function fmtDateTime(iso) { const d = iso && new Date(iso); return (d && !isNaN(d)) ? `${d.getDate()} ${RU_MO[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
function fmtRel(iso) { const d = iso && new Date(iso); return (d && !isNaN(d)) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
function toLocalInput(iso) { const d = iso && new Date(iso); return (d && !isNaN(d)) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }

// Source / kind badge from the visit note (the gateway stamps the kind in RU).
function kindOf(note) {
    const n = String(note || '');
    if (/Лаборатор/i.test(n)) return { label: 'Лаборатория', color: 'var(--teal-2, #0e8c77)', bg: 'var(--primary-50, #effaf8)' };
    if (/Процедур/i.test(n))  return { label: 'Процедура',   color: '#6d28d9', bg: '#f5f3ff' };
    if (/Symptex/i.test(n))   return { label: 'Запись',      color: 'var(--info-700, #1d4ed8)', bg: 'var(--info-50, #eff6ff)' };
    return { label: 'Заявка', color: 'var(--ink-500, #55636d)', bg: 'var(--ink-50, #f3f5f7)' };
}

// Styled cancellation dialog (replaces window.prompt). onConfirm(reason) -> truthy closes it.
function openRejectDialog(patient, onConfirm) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    function onEsc(e) { if (e.key === 'Escape') close(); }
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const errEl = h('div', { style: { fontSize: '12px', color: 'var(--crit-700, #b91c1c)', minHeight: '14px', marginTop: '2px' } });
    const ta = h('textarea', { rows: '3', placeholder: 'Например: пациент не отвечает, дубль записи, нет нужного врача в эту дату…',
        style: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--ink-200, #d3d9de)', borderRadius: '10px', padding: '10px 12px', font: 'inherit', fontSize: '14px', resize: 'vertical', minHeight: '74px' },
        oninput: () => { if (ta.value.trim()) errEl.textContent = ''; } });
    const submit = h('button', { class: 'btn btn-primary', style: { background: '#dc2626', borderColor: '#dc2626' } }, 'Отклонить заявку');
    submit.onclick = async () => {
        const reason = ta.value.trim();
        if (!reason) { errEl.textContent = 'Укажите причину — это поможет администратору.'; ta.focus(); return; }
        submit.disabled = true; submit.textContent = 'Отклоняем…';
        const ok = await onConfirm(reason);
        if (ok) close(); else { submit.disabled = false; submit.textContent = 'Отклонить заявку'; }
    };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit.click(); };
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, 'Отклонить заявку'), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { style: { fontSize: '13.5px', color: 'var(--ink-600, #324049)', lineHeight: 1.5 } },
                'Пациент ', h('b', null, patient), '. Причину увидит администратор в разделе «История» — пациенту она не отправляется.'),
            h('div', { style: { display: 'grid', gap: '5px' } },
                h('label', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--ink-500)' } }, 'Причина отказа'),
                ta, errEl)),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn btn-outline', onclick: close }, 'Отмена'),
            submit)));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onEsc);
    setTimeout(() => ta.focus(), 30);
}

export async function renderRequestsInbox(container) {
    clear(container);
    const wrap = h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '1100px' } });
    container.appendChild(wrap);
    const state = { mode: 'active' };

    async function load() {
        clear(wrap);
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px', color: 'var(--ink-400)' } }, 'Загрузка…'));

        const counts = { requested: 0, processed: 0, dropped: 0 };
        try {
            const [tot, req, drop] = await Promise.all([
                supabase.from('visits').select('id', { count: 'exact', head: true }).ilike('notes', SYMPTEX_LIKE),
                supabase.from('visits').select('id', { count: 'exact', head: true }).ilike('notes', SYMPTEX_LIKE).eq('status', 'requested'),
                supabase.from('visits').select('id', { count: 'exact', head: true }).ilike('notes', SYMPTEX_LIKE).in('status', ['cancelled', 'no_show']),
            ]);
            counts.requested = req.count || 0;
            counts.dropped = drop.count || 0;
            counts.processed = Math.max(0, (tot.count || 0) - counts.requested - counts.dropped);
        } catch (e) { /* fail-soft */ }

        let visits = [];
        try {
            let qb = supabase.from('visits');
            qb = state.mode === 'active'
                ? qb.select(ACTIVE_SEL).eq('status', 'requested').order('created_at', { ascending: false })
                : qb.select(HIST_SEL).ilike('notes', SYMPTEX_LIKE).neq('status', 'requested').order('created_at', { ascending: false }).limit(100);
            const { data, error } = await qb;
            if (error) throw error;
            visits = data || [];
        } catch (e) {
            clear(wrap); wrap.appendChild(hero()); wrap.appendChild(kpiRow(counts)); wrap.appendChild(toolbar());
            wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px', color: 'var(--crit-700, #b91c1c)' } }, trf('Не удалось загрузить: {msg}', { msg: e.message || e })));
            return;
        }

        const pids = [...new Set(visits.map(v => v.patient_id).filter(Boolean))];
        const sids = [...new Set(visits.map(v => v.service_id).filter(Boolean))];
        const cbids = [...new Set(visits.map(v => v.cancelled_by).filter(Boolean))];
        const [pn, sn, dn, bn, cb, rm] = await Promise.all([
            pids.length ? supabase.from('patients').select('id, full_name, first_name, last_name, phone').in('id', pids) : Promise.resolve({ data: [] }),
            sids.length ? supabase.from('services').select('id, name').in('id', sids) : Promise.resolve({ data: [] }),
            supabase.from('users').select('id, full_name, specialty, branch_id').eq('is_doctor', true).eq('active', true).order('full_name'),
            supabase.from('branches').select('id, name'),
            cbids.length ? supabase.from('users').select('id, full_name').in('id', cbids) : Promise.resolve({ data: [] }),
            supabase.from('rooms').select('id, name, code').eq('active', true).order('code'),
        ]);
        const pm = {}, ph = {}, sm = {}, bm = {}, cbm = {};
        for (const r of ((pn && pn.data) || [])) { pm[r.id] = r.full_name || [r.last_name, r.first_name].filter(Boolean).join(' ') || '—'; ph[r.id] = r.phone || ''; }
        for (const r of ((sn && sn.data) || [])) sm[r.id] = r.name || '';
        for (const r of ((bn && bn.data) || [])) bm[r.id] = r.name || '';
        for (const r of ((cb && cb.data) || [])) cbm[r.id] = r.full_name || '—';
        const doctors = ((dn && dn.data) || []);
        const docName = {}; for (const d of doctors) docName[d.id] = d.full_name || '—';
        const rooms = ((rm && rm.data) || []);
        const roomName = {}; for (const r of rooms) roomName[r.id] = r.name || trf('Каб. {code}', { code: r.code || '' });
        render(visits, { pm, ph, sm, bm, doctors, docName, cbm, rooms, roomName }, counts);
    }

    // ── Teal hero (matches the dashboard) ──────────────────────────────────────
    function hero() {
        return h('div', { style: {
            background: 'linear-gradient(120deg, #0c3a39 0%, #115d5a 50%, #167873 100%)',
            borderRadius: '14px', padding: '20px 24px', color: 'white', position: 'relative', overflow: 'hidden',
        } },
            h('div', { style: { position: 'absolute', right: '-40px', top: '-40px', width: '220px', height: '220px', background: 'radial-gradient(circle, rgba(255,255,255,0.10) 0%, transparent 65%)' } }),
            h('div', { style: { position: 'absolute', right: '90px', bottom: '-80px', width: '180px', height: '180px', background: 'radial-gradient(circle, rgba(46,200,191,0.18) 0%, transparent 65%)' } }),
            h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '12px', fontWeight: 600, background: 'rgba(255,255,255,0.14)', padding: '4px 10px', borderRadius: '999px', marginBottom: '10px' } },
                Icon('Bell', { size: 13 }), 'Symptex'),
            h('h2', { style: { margin: 0, fontSize: '23px', fontWeight: 700, letterSpacing: '-0.02em', position: 'relative' } }, 'Заявки'),
            h('p', { style: { margin: '5px 0 0', fontSize: '13.5px', opacity: 0.88, maxWidth: '620px', position: 'relative', lineHeight: 1.5 } },
                'Обращения пациентов из Symptex. Подтвердите запись и назначьте врача — или отклоните с комментарием. Все обращения сохраняются в истории.'));
    }

    // ── KPI funnel cards (.stat) — clickable to switch tab ─────────────────────
    function statCard({ label, value, sub, color, icon, mode }) {
        return h('div', { class: 'stat', style: { minWidth: 0, cursor: 'pointer', outline: state.mode === mode ? `2px solid ${color}` : 'none' },
            onclick: () => { if (state.mode !== mode) { state.mode = mode; load(); } } },
            h('div', { class: 'row' },
                h('div', { style: { width: '34px', height: '34px', borderRadius: '9px', display: 'grid', placeItems: 'center', color, background: `color-mix(in srgb, ${color} 14%, transparent)` } }, Icon(icon, { size: 18 })),
                h('span', { class: 'grow' })),
            h('div', { class: 'stat-label', style: { marginTop: '10px' } }, label),
            h('div', { class: 'stat-value num' }, String(value)),
            sub ? h('div', { style: { fontSize: '11.5px', color: 'var(--ink-500)', marginTop: '4px' } }, sub) : null);
    }
    function kpiRow(c) {
        return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px' } },
            statCard({ label: 'Новые', value: c.requested, sub: 'ждут ответа', color: 'var(--info-700, #1d4ed8)', icon: 'Bell', mode: 'active' }),
            statCard({ label: 'Обработано', value: c.processed, sub: 'записаны или приняты', color: 'var(--ok-700, #047857)', icon: 'Check', mode: 'history' }),
            statCard({ label: 'Отклонено', value: c.dropped, sub: 'с указанием причины', color: 'var(--crit-700, #b91c1c)', icon: 'X', mode: 'history' }));
    }

    function toolbar() {
        const tab = (mode, label) => h('button', { class: state.mode === mode ? 'on' : '', onclick: () => { if (state.mode !== mode) { state.mode = mode; load(); } } }, label);
        return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
            h('div', { class: 'segmented' }, tab('active', 'Активные'), tab('history', 'История')),
            h('button', { class: 'btn btn-outline btn-sm', onclick: () => load() }, Icon('Refresh', { size: 14 }), ' Обновить'));
    }

    function render(visits, lk, counts) {
        clear(wrap);
        wrap.appendChild(hero());
        wrap.appendChild(kpiRow(counts));
        wrap.appendChild(toolbar());
        // REQUESTS_FILL_V1 — fill the reserved content height so a short/empty
        // list no longer leaves a big blank area below (.content has
        // min-height: 100vh - topbar). UI-only; no logic changed.
        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 'calc(100vh - var(--topbar-h, 56px) - 300px)' } });
        if (!visits.length) { list.style.justifyContent = 'center'; list.appendChild(emptyState()); wrap.appendChild(list); return; }
        for (const v of visits) list.appendChild(state.mode === 'active' ? activeCard(v, lk) : historyCard(v, lk));
        wrap.appendChild(list);
    }

    function emptyState() {
        const active = state.mode === 'active';
        return h('div', { class: 'card', style: { padding: '48px 24px', textAlign: 'center', color: 'var(--ink-400)' } },
            h('div', { style: { width: '52px', height: '52px', margin: '0 auto 12px', borderRadius: '14px', display: 'grid', placeItems: 'center', color: active ? 'var(--ok-700, #047857)' : 'var(--ink-400)', background: active ? 'var(--ok-50, #ecfdf5)' : 'var(--ink-50, #f3f5f7)' } }, Icon(active ? 'Check' : 'Clock', { size: 26 })),
            h('div', { style: { fontWeight: 700, fontSize: '16px', color: 'var(--ink-800, #142026)' } }, active ? 'Новых заявок нет' : 'История пуста'),
            h('div', { style: { fontSize: '13.5px', marginTop: '5px', maxWidth: '420px', marginInline: 'auto', lineHeight: 1.5 } },
                active ? 'Вы обработали все обращения. Новые заявки из Symptex появятся здесь — мы подсветим их.' : 'Подтверждённые и отклонённые заявки будут собираться здесь — с причиной отказа и автором.'));
    }

    // ── shared card pieces ─────────────────────────────────────────────────────
    function cardShell(children) {
        return h('div', { class: 'card', style: { padding: '16px 18px' } }, children);
    }
    function patientHead(v, lk, rightBadges) {
        const patient = lk.pm[v.patient_id] || 'Пациент';
        const phone = lk.ph[v.patient_id] || '';
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '10px', background: 'var(--primary-50, #effaf8)', fontWeight: 700, fontSize: '12px', color: 'var(--primary-700, #115d5a)', flex: 'none' } }, initials(patient)),
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontWeight: 700, fontSize: '14.5px', color: 'var(--ink-900, #0b1418)' } }, patient),
                phone ? h('a', { href: 'tel:' + phone, style: { fontSize: '12.5px', color: 'var(--primary-600, #167873)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' } }, Icon('Phone', { size: 11 }), phone) : null),
            h('span', { class: 'grow' }), rightBadges);
    }
    const pill = (label, fg, bg) => h('span', { style: { fontSize: '11.5px', fontWeight: 600, color: fg, background: bg, padding: '3px 10px', borderRadius: '999px', whiteSpace: 'nowrap' } }, label);
    const serviceText = (v, lk) => lk.sm[v.service_id] || String(v.notes || '').replace(/^Symptex\s+/i, '') || 'Запись на приём';
    function metaLine(v, lk) {
        const branch = lk.bm[v.branch_id] || '';
        const hasSlot = v.visit_date && !/^0001/.test(String(v.visit_date));
        const item = (icon, txt) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, Icon(icon, { size: 12 }), txt);
        return h('div', { style: { fontSize: '12px', color: 'var(--ink-500, #55636d)', display: 'flex', gap: '14px', flexWrap: 'wrap' } },
            v.doctor_id ? item('Stethoscope', lk.docName[v.doctor_id] || 'врач') : null,
            branch ? item('MapPin', branch) : null,
            hasSlot ? item('Clock', fmtDateTime(v.visit_date)) : null,
            v.created_at ? h('span', { style: { color: 'var(--ink-400, #7a8892)' } }, trf('создана {when}', { when: fmtRel(v.created_at) })) : null);
    }

    function activeCard(v, lk) {
        const k = kindOf(v.notes);
        const patient = lk.pm[v.patient_id] || 'Пациент';
        const hasSlot = v.visit_date && !/^0001/.test(String(v.visit_date));
        const inp = { fontSize: '13px', padding: '8px 10px', border: '1px solid var(--ink-200, #d3d9de)', borderRadius: '9px', background: '#fff', color: 'var(--ink-800, #142026)' };
        const docSel = h('select', { style: { ...inp, minWidth: '190px' } },
            h('option', { value: '' }, '— без врача —'),
            ...lk.doctors.map(d => h('option', { value: d.id, ...(d.id === v.doctor_id ? { selected: true } : {}) }, (d.full_name || '—') + (d.specialty ? ` · ${d.specialty}` : ''))));
        const roomSel = h('select', { style: { ...inp, minWidth: '190px' } },
            h('option', { value: '' }, '— без кабинета —'),
            ...((lk.rooms || []).map(r => h('option', { value: r.id, ...(r.id === v.room_id ? { selected: true } : {}) }, (lk.roomName && lk.roomName[r.id]) || r.name || trf('Каб. {code}', { code: r.code || '' })))));
        const dtInput = h('input', { type: 'datetime-local', style: inp, value: hasSlot ? toLocalInput(v.visit_date) : '' });
        const confirmBtn = h('button', { class: 'btn btn-primary btn-sm' }, Icon('Check', { size: 15 }), ' Подтвердить');
        const rejectBtn = h('button', { class: 'btn btn-outline btn-sm', style: { color: 'var(--crit-700, #b91c1c)', borderColor: 'var(--crit-200, #fecaca)' } }, 'Отклонить');

        confirmBtn.onclick = async () => {
            // REQ_CONFIRM_ASSIGN_V1 — a confirmed request must land on the calendar:
            // a doctor (clinician services) OR a cabinet (lab/procedure), plus a time.
            const docId = docSel.value || null;
            const roomId = roomSel.value || null;
            if (!docId && !roomId) { toast('Выберите врача или кабинет, чтобы назначить запись.', 'fail'); return; }
            if (!dtInput.value) { toast('Укажите дату и время приёма.', 'fail'); return; }
            const d = new Date(dtInput.value);
            if (isNaN(d)) { toast('Некорректная дата и время.', 'fail'); return; }
            confirmBtn.disabled = rejectBtn.disabled = true;
            const upd = { status: 'scheduled', doctor_id: docId, room_id: roomId, visit_date: d.toISOString() };
            const { error } = await supabase.from('visits').update(upd).eq('id', v.id);
            if (error) { toast(trf('Не удалось подтвердить: {msg}', { msg: error.message }), 'fail'); confirmBtn.disabled = rejectBtn.disabled = false; return; }
            toast(docId ? 'Запись подтверждена и назначена врачу' : 'Запись подтверждена (кабинет)');
            load();
        };
        rejectBtn.onclick = () => openRejectDialog(patient, async (reason) => {
            confirmBtn.disabled = rejectBtn.disabled = true;
            const { error } = await supabase.from('visits').update({ status: 'cancelled', cancel_reason: reason, cancelled_by: currentUserId(), cancelled_at: new Date().toISOString() }).eq('id', v.id);
            if (error) { toast(trf('Не удалось отклонить: {msg}', { msg: error.message }), 'fail'); confirmBtn.disabled = rejectBtn.disabled = false; return false; }
            toast('Заявка отклонена');
            load();
            return true;
        });

        return cardShell(h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'space-between' } },
            h('div', { style: { minWidth: '260px', flex: '1 1 320px' } },
                patientHead(v, lk, pill(k.label, k.color, k.bg)),
                h('div', { style: { fontSize: '14px', fontWeight: 600, color: 'var(--ink-800, #142026)', margin: '2px 0 6px' } }, serviceText(v, lk)),
                metaLine(v, lk)),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', minWidth: '210px' } },
                h('label', { style: { fontSize: '11px', color: 'var(--ink-400)', fontWeight: 600 } }, 'Врач'),
                docSel,
                h('label', { style: { fontSize: '11px', color: 'var(--ink-400)', fontWeight: 600, marginTop: '2px' } }, 'Кабинет (для услуг без врача)'),
                roomSel,
                h('label', { style: { fontSize: '11px', color: 'var(--ink-400)', fontWeight: 600, marginTop: '2px' } }, 'Дата и время приёма'),
                dtInput,
                h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } }, confirmBtn, rejectBtn))));
    }

    function historyCard(v, lk) {
        const k = kindOf(v.notes);
        const [oLabel, oFg, oBg] = outcomeOf(v.status);
        const who = v.cancelled_by ? (lk.cbm[v.cancelled_by] || 'сотрудник') : '';
        return cardShell(h('div', null,
            patientHead(v, lk, h('span', { style: { display: 'flex', gap: '6px' } }, pill(k.label, k.color, k.bg), pill(oLabel, oFg, oBg))),
            h('div', { style: { fontSize: '14px', fontWeight: 600, color: 'var(--ink-800, #142026)', margin: '2px 0 6px' } }, serviceText(v, lk)),
            metaLine(v, lk),
            (v.status === 'cancelled' && (v.cancel_reason || who)) ? h('div', { style: { marginTop: '9px', padding: '9px 12px', background: 'var(--crit-50, #fef2f2)', border: '1px solid var(--crit-200, #fecaca)', borderRadius: '10px', fontSize: '12.5px', color: 'var(--crit-700, #b91c1c)' } },
                h('span', { style: { fontWeight: 600 } }, 'Причина отказа: '), (v.cancel_reason || '—'),
                (who || v.cancelled_at) ? h('div', { style: { color: 'var(--ink-400, #7a8892)', marginTop: '3px', fontSize: '11.5px' } }, [who ? trf('отклонил: {who}', { who }) : '', v.cancelled_at ? ('· ' + fmtRel(v.cancelled_at)) : ''].filter(Boolean).join(' ')) : null) : null));
    }

    await load();
}
