// Public Site — clinic owner's Symptex activation & profile-completion page.
// PUBLIC_SITE_V4 — PER-BRANCH (branch = clinic). A tab per branch; each branch has its own
// publication status, completion, branch-linked doctors and REAL Symptex page preview. ALL data
// via gw(); never writes medcore / talks to Symptex directly.

import { h, Icon, Avatar, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { gw } from '../gateway.js';
import { getSelectedBranchIds } from '../branch-context.js?v=bc3';

const STATUS_META = {
    not_published: { label: 'Не опубликовано', color: 'var(--ink-500)', dot: 'var(--ink-300)' },
    pending:       { label: 'На рассмотрении', color: 'var(--warn-600, #b45309)', dot: 'var(--warn-500, #d97706)' },
    published:     { label: 'Опубликовано',    color: 'var(--ok-600, #047857)', dot: 'var(--ok-500, #10b981)' },
};
const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}
function initialsOf(name) {
    const p = (name || '').trim().split(/\s+/);
    return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?';
}

export async function renderPublicSite(container, ctx = {}) {
    const onNavigate = ctx.onNavigate || (() => {});
    clear(container);
    container.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Загрузка…'));

    let resp;
    try { resp = await gw('/public-site/branches'); }
    catch (e) {
        clear(container);
        const noClinic = /no clinic/i.test(e.message || '');
        container.appendChild(h('div', { class: 'error-state', style: { padding: '48px 24px', textAlign: 'center' } },
            h('div', { style: { color: 'var(--crit-700)', display: 'flex', justifyContent: 'center', marginBottom: '10px' } }, Icon('Warning', { size: 26 })),
            h('div', { style: { fontWeight: '600', color: 'var(--ink-900)' } }, noClinic ? 'Раздел доступен только сотрудникам клиники' : 'Не удалось загрузить данные'),
            noClinic ? null : h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, e.message || String(e))));
        return;
    }
    const branches = (resp && resp.branches) || [];
    clear(container);
    const root = h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    container.appendChild(root);
    root.appendChild(hero());

    if (!branches.length) {
        root.appendChild(h('div', { class: 'card', style: { padding: '32px', textAlign: 'center' } },
            h('div', { class: 'muted' }, 'У клиники ещё нет филиалов. Добавьте филиал в разделе «Настройки → Филиалы».')));
        return;
    }

    // Default to the globally-selected branch if exactly one is active, else the first.
    let sel = [];
    try { sel = getSelectedBranchIds() || []; } catch (e) {}
    let activeId = (sel.length === 1 && branches.some(b => String(b.branch_id) === String(sel[0]))) ? sel[0] : branches[0].branch_id;

    const tabsEl = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
    const contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    root.appendChild(h('div', null,
        h('div', { class: 'muted', style: { fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: '600', marginBottom: '8px' } }, 'Филиал'),
        tabsEl));
    root.appendChild(contentEl);

    function paintTabs() {
        clear(tabsEl);
        for (const b of branches) tabsEl.appendChild(branchTab(b, String(b.branch_id) === String(activeId), () => {
            if (String(b.branch_id) === String(activeId)) return;
            activeId = b.branch_id; paintTabs(); loadBranch();
        }));
    }
    async function loadBranch() {
        clear(contentEl);
        contentEl.appendChild(h('div', { class: 'empty', style: { padding: '36px' } }, 'Загрузка филиала…'));
        let dash, preview, previewMeta;
        try {
            [dash, preview, previewMeta] = await Promise.all([
                gw('/public-site/dashboard?branch_id=' + encodeURIComponent(activeId)),
                gw('/public-site/preview?branch_id=' + encodeURIComponent(activeId)),
                gw('/public-site/preview-url?branch_id=' + encodeURIComponent(activeId)).catch(() => null),
            ]);
        } catch (e) {
            clear(contentEl);
            contentEl.appendChild(h('div', { class: 'error-state', style: { padding: '32px', textAlign: 'center' } }, trf('Не удалось загрузить филиал: {msg}', { msg: e.message || e })));
            return;
        }
        clear(contentEl);
        const reload = () => { /* refresh tab status + content */ refreshTabStatus(dash.branch_id); loadBranch(); };
        contentEl.appendChild(statusBanner(dash, reload));
        contentEl.appendChild(summary(dash));
        contentEl.appendChild(completionBlock(dash));
        contentEl.appendChild(doctorsBlock(dash, onNavigate));
        contentEl.appendChild(previewBlock(dash, preview, previewMeta));
    }
    function refreshTabStatus(branchId) {
        // After a publish request, reflect 'pending' on the tab without a full reload.
        const b = branches.find(x => String(x.branch_id) === String(branchId));
        if (b && b.publication_status === 'not_published') { b.publication_status = 'pending'; paintTabs(); }
    }
    paintTabs();
    loadBranch();
}

function branchTab(b, active, onClick) {
    const sm = STATUS_META[b.publication_status] || STATUS_META.not_published;
    return h('button', { type: 'button', onclick: onClick, title: sm.label, style: {
        display: 'flex', alignItems: 'center', gap: '9px', padding: '10px 15px', borderRadius: '11px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13.5px',
        border: '1px solid ' + (active ? 'var(--primary-500)' : 'var(--ink-200)'),
        background: active ? tint('var(--primary-600)', 9) : '#fff',
        color: active ? 'var(--primary-800, #065f46)' : 'var(--ink-700)', fontWeight: active ? '700' : '500',
    } },
        h('span', { style: { width: '9px', height: '9px', borderRadius: '999px', background: sm.dot, flex: '0 0 9px' } }),
        h('span', null, b.name),
        h('span', { style: { fontSize: '11px', color: 'var(--ink-400)', fontWeight: '500' } }, (b.completion_score || 0) + '%'));
}

// ── Hero ─────────────────────────────────────────────────────────────────────
function hero() {
    return h('div', { style: { background: 'linear-gradient(120deg, #0c3a39 0%, #115d5a 50%, #167873 100%)', borderRadius: '14px', padding: '22px 26px', color: 'white', position: 'relative', overflow: 'hidden' } },
        h('div', { style: { position: 'absolute', right: '-40px', top: '-40px', width: '230px', height: '230px', background: 'radial-gradient(circle, rgba(255,255,255,0.10) 0%, transparent 65%)' } }),
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px', position: 'relative' } },
            Icon('Globe', { size: 15 }),
            h('span', { style: { fontSize: '11.5px', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: '0.8', fontWeight: '600' } }, 'Symptex · публичный профиль')),
        h('h2', { style: { margin: '0', fontSize: '22px', fontWeight: '700', letterSpacing: '-0.02em', position: 'relative' } }, 'Ваши филиалы на Symptex'),
        h('p', { style: { margin: '6px 0 0', fontSize: '13.5px', opacity: '0.88', maxWidth: '700px', position: 'relative', lineHeight: '1.6' } },
            'Каждый филиал — отдельная клиника на Symptex со своими врачами, услугами и записью. Выберите филиал, заполните профиль и отправьте его на публикацию — чем полнее данные, тем больше обращений пациентов.'));
}

// ── Prominent publication banner + per-branch request ────────────────────────
function statusBanner(dash, reload) {
    const st = dash.publication_status;
    const shell = (bg, border, kids) => h('div', { style: { borderRadius: '16px', padding: '20px 24px', background: bg, border: '1px solid ' + border, display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' } }, ...kids);
    const chip = (color, icon) => h('div', { style: { width: '50px', height: '50px', borderRadius: '13px', background: color, color: '#fff', display: 'grid', placeItems: 'center', flex: '0 0 50px', boxShadow: '0 6px 16px ' + tint(color, 35) } }, Icon(icon, { size: 25 }));
    const txt = (title, sub, tc, sc) => h('div', { style: { flex: '1', minWidth: '240px' } },
        h('div', { style: { fontWeight: '700', fontSize: '18px', color: tc } }, title),
        h('div', { style: { fontSize: '13px', color: sc, marginTop: '4px', lineHeight: '1.5' } }, sub));
    const bn = dash.branch_name || 'Филиал';

    if (st === 'published') {
        let date = null;
        try { date = dash.published_at ? new Date(dash.published_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null; } catch (e) {}
        const link = dash.slug ? h('a', { href: 'https://symptex.uz/clinics/' + dash.slug, target: '_blank', rel: 'noopener', class: 'btn', style: { background: '#059669', color: '#fff', fontWeight: '600', padding: '11px 20px', fontSize: '14px', boxShadow: '0 4px 14px rgba(5,150,105,.3)' } }, Icon('Globe', { size: 16 }), ' Открыть страницу') : null;
        return shell('linear-gradient(120deg,#ecfdf5,#d1fae5)', '#6ee7b7', [chip('#059669', 'Check'),
            txt(trf('«{name}» опубликован на Symptex', { name: bn }), date ? trf('Дата публикации: {date}. Пациенты видят филиал в маркетплейсе.', { date }) : 'Пациенты видят филиал в маркетплейсе.', '#065f46', '#047857'), link]);
    }
    if (st === 'pending') {
        return shell('linear-gradient(120deg,#fffbeb,#fef3c7)', '#fcd34d', [chip('#d97706', 'Clock'),
            txt(trf('Заявка на публикацию «{name}» рассматривается', { name: bn }), 'Мы уведомим вас после проверки администратором Symptex. Можно продолжать заполнять профиль.', '#92400e', '#b45309')]);
    }
    const BRANCH_PUBLISH_REQUIRED = ['Адрес', 'Часы работы'];
    const missingCore = BRANCH_PUBLISH_REQUIRED.filter((l) => (dash.clinic_missing || []).includes(l));
    const blocked = missingCore.length > 0;
    const btn = h('button', { class: 'btn', style: { background: blocked ? '#cbb59a' : '#d97706', color: '#fff', fontWeight: '600', padding: '13px 24px', fontSize: '14.5px', boxShadow: blocked ? 'none' : '0 6px 18px rgba(217,119,6,.35)', whiteSpace: 'nowrap', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? '0.85' : '1' }, disabled: blocked, title: blocked ? trf('Заполните профиль филиала: {what}', { what: missingCore.join(', ') }) : '' }, Icon('Megaphone', { size: 17 }), ' Запросить публикацию');
    if (!blocked) btn.onclick = () => requestPublication(btn, reload, dash.branch_id);
    const sub = blocked
        ? trf('Чтобы отправить заявку, заполните профиль филиала: {what}.', { what: missingCore.join(', ') })
        : (dash.synced ? 'Заполните профиль и отправьте заявку — после одобрения пациенты увидят филиал в маркетплейсе и смогут записаться.'
                       : 'Сначала заполните и сохраните профиль филиала, затем отправьте заявку.');
    return shell('linear-gradient(120deg,#fff7ed,#fef3c7)', '#fcd34d', [chip('#f59e0b', 'Megaphone'),
        txt(trf('Филиал «{name}» не отображается на Symptex', { name: bn }), sub, '#92400e', '#b45309'), btn]);
}

async function requestPublication(btn, reload, branchId) {
    btn.disabled = true; btn.style.opacity = '0.7';
    const orig = btn.textContent; btn.textContent = tr('Отправка…');
    try {
        await gw('/public-site/request-publication?branch_id=' + encodeURIComponent(branchId || ''), { method: 'POST' });
        toast('Заявка на публикацию отправлена', 'info');
        reload();
    } catch (e) {
        toast(e.message || 'Не удалось отправить заявку', 'fail');
        btn.disabled = false; btn.style.opacity = ''; btn.textContent = orig;
    }
}

// ── Summary cards ────────────────────────────────────────────────────────────
function summary(dash) {
    const sm = STATUS_META[dash.publication_status] || STATUS_META.not_published;
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px' } },
        kpi({ label: 'Статус публикации', value: sm.label, color: sm.color, icon: 'Globe', small: true }),
        kpi({ label: 'Заполненность филиала', value: dash.completion_score + '%', color: 'var(--primary-600)', icon: 'Check' }),
        kpi({ label: 'Врачи готовы', value: String(dash.doctors_ready), color: 'var(--ok-600, #047857)', icon: 'Stethoscope' }),
        kpi({ label: 'Врачи без данных', value: String(dash.doctors_incomplete), color: dash.doctors_incomplete ? 'var(--warn-500, #d97706)' : 'var(--ink-400)', icon: 'Warning' }));
}
function kpi({ label, value, color, icon, small = false }) {
    return h('div', { class: 'stat', style: { minWidth: '0' } },
        h('div', { class: 'row' }, h('div', { style: { width: '34px', height: '34px', borderRadius: '9px', display: 'grid', placeItems: 'center', color, background: tint(color, 14) } }, Icon(icon, { size: 18 }))),
        h('div', { class: 'stat-label', style: { marginTop: '10px' } }, label),
        h('div', { class: 'stat-value', style: { fontSize: small ? '17px' : '', color } }, value));
}

// ── Completion ───────────────────────────────────────────────────────────────
function bar(pct, color) {
    return h('div', { style: { height: '8px', background: 'var(--ink-100)', borderRadius: '999px', overflow: 'hidden' } },
        h('div', { style: { width: Math.max(0, Math.min(100, pct)) + '%', height: '100%', background: color, borderRadius: '999px', transition: 'width .3s' } }));
}
function chipMissing(label) {
    return h('span', { style: { fontSize: '11.5px', fontWeight: '500', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap', color: 'var(--warn-700, #92400e)', background: tint('var(--warn-500, #d97706)', 13) } }, label);
}
function completionBlock(dash) {
    const card = h('div', { class: 'card', style: { padding: '18px 20px' } });
    card.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('h3', { style: { margin: '0', fontSize: '14px', fontWeight: '700' } }, 'Заполненность филиала'),
        h('span', { class: 'grow' }),
        h('span', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--primary-700)' } }, dash.completion_score + '%')));
    card.appendChild(bar(dash.completion_score, 'var(--primary-500)'));
    const mini = (label, pct) => h('div', { style: { minWidth: '120px', flex: '1' } },
        h('div', { class: 'row', style: { fontSize: '12px', marginBottom: '4px' } }, h('span', { class: 'muted' }, label), h('span', { class: 'grow' }), h('span', { style: { fontWeight: '600' } }, pct + '%')),
        bar(pct, 'var(--primary-400, #5eb0a8)'));
    card.appendChild(h('div', { class: 'row', style: { gap: '20px', marginTop: '12px', flexWrap: 'wrap' } }, mini('Филиал', dash.clinic_score), mini('Врачи', dash.doctors_score)));
    if ((dash.clinic_missing || []).length) {
        card.appendChild(h('div', { style: { marginTop: '14px' } },
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, 'Не хватает по филиалу:'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, ...dash.clinic_missing.map(chipMissing))));
    } else {
        card.appendChild(h('div', { style: { marginTop: '12px', fontSize: '12.5px', color: 'var(--ok-600, #047857)', display: 'inline-flex', alignItems: 'center', gap: '6px' } }, Icon('Check', { size: 14 }), 'Профиль филиала заполнен полностью.'));
    }
    return card;
}

// ── Doctor readiness (linked to THIS branch) ─────────────────────────────────
function doctorsBlock(dash, onNavigate) {
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'card-header' },
        h('h3', null, Icon('Stethoscope', { size: 16 }), ' Врачи филиала ', h('span', { class: 'h-count' }, String(dash.doctors_total))),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => onNavigate('settings:users') }, 'Профили врачей ', Icon('ArrowRight', { size: 14 }))));
    if (!dash.doctors || !dash.doctors.length) {
        card.appendChild(h('div', { class: 'empty', style: { padding: '32px' } }, 'К этому филиалу не привязаны врачи.'));
        return card;
    }
    card.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Врач'), h('th', null, 'Заполненность'), h('th', null, 'Не хватает'))),
        h('tbody', null, ...dash.doctors.map(docRow))));
    return card;
}
function docRow(d) {
    const full = d.completion === 100;
    return h('tr', null,
        h('td', null, h('div', { class: 'row', style: { gap: '10px' } }, Avatar({ initials: initialsOf(d.name), color: 'av-3', size: 'sm' }), h('div', { class: 'cell-strong' }, d.name))),
        h('td', { style: { minWidth: '150px' } }, h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { style: { flex: '1', maxWidth: '90px' } }, bar(d.completion, full ? 'var(--ok-500, #10b981)' : 'var(--warn-500, #d97706)')),
            h('span', { style: { fontSize: '12.5px', fontWeight: '600', color: full ? 'var(--ok-600, #047857)' : 'var(--ink-700)' } }, d.completion + '%'))),
        h('td', null, (d.missing && d.missing.length)
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } }, ...d.missing.map(chipMissing))
            : h('span', { style: { fontSize: '12px', color: 'var(--ok-600, #047857)', display: 'inline-flex', alignItems: 'center', gap: '5px' } }, Icon('Check', { size: 13 }), 'Готов')));
}

// ── Public preview — the REAL Symptex page (iframe, desktop) ─────────────────
function symptexFrame(url) {
    const DESIGN_W = 1280, DESIGN_H = 1900;
    const wrap = h('div', { style: { position: 'relative', width: '100%', overflow: 'hidden', borderRadius: '14px', border: '1px solid var(--ink-100)', background: '#fff' } });
    const frame = h('iframe', { src: url, loading: 'lazy', scrolling: 'no', style: { width: DESIGN_W + 'px', height: DESIGN_H + 'px', border: '0', transformOrigin: 'top left', display: 'block' } });
    wrap.appendChild(frame);
    const apply = () => { const w = wrap.clientWidth || DESIGN_W; const s = w / DESIGN_W; frame.style.transform = 'scale(' + s + ')'; wrap.style.height = (DESIGN_H * s) + 'px'; };
    requestAnimationFrame(apply);
    if (typeof ResizeObserver !== 'undefined') { try { new ResizeObserver(apply).observe(wrap); } catch (e) {} }
    else if (typeof window !== 'undefined') window.addEventListener('resize', apply);
    return wrap;
}
function previewBlock(dash, preview, previewMeta) {
    const published = dash.publication_status === 'published' && dash.slug;
    const liveUrl = published ? 'https://symptex.uz/clinics/' + dash.slug : null;
    const draftUrl = (previewMeta && previewMeta.preview_url) || null;
    const frameUrl = liveUrl || draftUrl;
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'card-header' },
        h('h3', null, Icon('Globe', { size: 16 }), ' Страница филиала на Symptex'),
        frameUrl ? h('a', { href: frameUrl, target: '_blank', rel: 'noopener', class: 'btn btn-ghost btn-sm' }, 'Открыть полностью ', Icon('ArrowRight', { size: 14 }))
                 : h('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'Предпросмотр')));
    const body = h('div', { style: { padding: '14px 16px' } });
    card.appendChild(body);
    if (frameUrl) {
        body.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '7px' } },
            published ? [Icon('Check', { size: 13 }), 'Это настоящая страница филиала на Symptex (десктоп).']
                      : [h('span', { style: { fontSize: '10.5px', fontWeight: '700', color: 'var(--warn-700, #92400e)', background: tint('var(--warn-500, #d97706)', 15), padding: '2px 8px', borderRadius: '6px' } }, 'ЧЕРНОВИК'),
                         'Настоящая страница Symptex с данными филиала — видна только вам, пока он не опубликован.']));
        body.appendChild(symptexFrame(frameUrl));
    } else {
        body.appendChild(h('div', { style: { borderRadius: '14px', border: '1px dashed var(--ink-200)', background: 'var(--warm-50, #fafaf9)', padding: '28px 24px', textAlign: 'center' } },
            h('div', { style: { width: '52px', height: '52px', borderRadius: '14px', margin: '0 auto 12px', background: tint('var(--primary-600)', 12), color: 'var(--primary-700)', display: 'grid', placeItems: 'center' } }, Icon('Globe', { size: 26 })),
            h('div', { style: { fontWeight: '700', fontSize: '15px', color: 'var(--ink-900)' } }, 'Филиал ещё не синхронизирован'),
            h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px', maxWidth: '460px', marginLeft: 'auto', marginRight: 'auto', lineHeight: '1.55' } },
                trf('Заполните и сохраните профиль филиала — после этого здесь появится предпросмотр настоящей страницы Symptex. Сейчас: {doctors} врач(ей), {services} услуг(и).', { doctors: (preview.doctors || []).length, services: preview.services_count || 0 }))));
    }
    return card;
}
