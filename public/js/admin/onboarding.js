// Easy-Med — Interactive onboarding / guidance overlay.
//
// STRICT NO-REDESIGN: this is a self-contained layer that sits ON TOP of the
// existing admin app. It changes no module, layout, workflow, or DB. It reads
// `window.easymed.state` (current user + view), points at existing elements by
// stable selectors (and best-effort, icon-matched nav items), and persists
// progress in localStorage per user. Loaded by a single <script> include in
// admin.html — nothing else is touched.
//
// Public API (window.easymedOnboarding): defineTour, defineTips, defineHelp,
// defineEmpty, restart, setHelpMode.

import { iconHtml } from './icons.js';
// I18N_ONBOARDING_V1 (2026-09-05) — этот слой ПЕРЕВОДИТСЯ, а не делает вид.
// До сих пор отсюда звался только trf() ради «Шаг N из M», а весь остальной
// текст — приветствие, подписи кнопок, заголовки и тела подсказок — уходил в
// свой собственный el() (он ничего про словарь не знает) как есть. Ловушка не
// в том, что было не переведено, а в том, что ВЫГЛЯДЕЛО переведённым: строки
// лежали в i18n-strings.js (их туда загоняет i18n-coverage.test.mjs, который
// читает и этот файл), словарь был полон в трёх языках — и не читался никем.
// Теперь всё видимое проходит через tr(); реестры подсказок ниже остаются
// русскими ИСХОДНИКАМИ — ровно так же, как русские исходники в любом другом
// экране, — и переводятся в момент показа.
import { tr, trf } from './i18n.js';   // I18N_COVERAGE_V1 — «Шаг N из M» собирается вокруг чисел

// ---------------------------------------------------------------------------
// Progress store (localStorage, per user)
// ---------------------------------------------------------------------------
const STORE_VERSION = 1;
const lsKey = (uid) => `em-onboarding:v${STORE_VERSION}:${uid || 'anon'}`;

function loadStore(uid) {
    try {
        const raw = JSON.parse(localStorage.getItem(lsKey(uid)));
        if (raw && raw.version === STORE_VERSION) return raw;
    } catch { /* corrupt → defaults */ }
    return { version: STORE_VERSION, welcomeDone: false, neverShow: false,
             completedTours: {}, completedTips: {}, helpMode: false };
}
function saveStore(uid, s) { try { localStorage.setItem(lsKey(uid), JSON.stringify(s)); } catch {} }

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
const S = {
    user: null,
    role: '_default',
    store: null,
    view: null,
    active: null,        // live tour controller, if a tour is running
    helpLayer: null,     // help-mode markers container
    tipShownThisView: false,
};

// ---------------------------------------------------------------------------
// Tiny DOM helper (self-contained — does not depend on the app's ui.js)
// ---------------------------------------------------------------------------
function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; n.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); }
    return n;
}
const $ = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };

// ---------------------------------------------------------------------------
// Target resolver
//   spec: { selector } | { nav: '<viewKey>' } | null (centered)
// Nav items carry no stable id and labels are localized, so we match a nav item
// by its icon SVG (locale-independent). Best-effort: returns null → caller skips.
// ---------------------------------------------------------------------------
const MODULE_ICON = {
    patients: 'Patients', consultation: 'Stethoscope', beds: 'Bed',
    cashier: 'Wallet', 'cashier-shifts': 'Clock', reports: 'Chart',
    labs: 'Flask', dashboard: 'Dashboard', settings: 'Settings',
};
function iconFirstPath(name) {
    try {
        const tpl = document.createElement('template');
        tpl.innerHTML = iconHtml(name, { size: 18 });
        const p = tpl.content.querySelector('path, rect, circle, polyline, polygon, line, ellipse');
        return p ? (p.getAttribute('d') || p.outerHTML) : null;
    } catch { return null; }
}
function resolveNav(viewKey) {
    const wanted = iconFirstPath(MODULE_ICON[viewKey]);
    const items = document.querySelectorAll('#sidebar-body .nav-item');
    if (!wanted || !items.length) return null;
    for (const it of items) {
        const p = it.querySelector('.nav-icon svg path, .nav-icon svg rect, .nav-icon svg circle, .nav-icon svg polyline');
        const d = p ? (p.getAttribute('d') || p.outerHTML) : null;
        if (d && d === wanted) return it;
    }
    return null;
}
function resolveTarget(spec) {
    if (!spec) return null;
    if (spec.selector) return $(spec.selector);
    if (spec.nav) return resolveNav(spec.nav);
    return null;
}

// ---------------------------------------------------------------------------
// Styles (injected once)
// ---------------------------------------------------------------------------
function injectStyles() {
    if (document.getElementById('em-onb-styles')) return;
    const s = document.createElement('style');
    s.id = 'em-onb-styles';
    s.textContent = `
.em-onb-overlay { position: fixed; inset: 0; z-index: 99000; pointer-events: none; }
.em-onb-dim { position: fixed; background: rgba(11,20,24,0.55); pointer-events: auto; transition: all .15s ease; }
.em-onb-ring { position: fixed; border-radius: 10px; box-shadow: 0 0 0 3px #167873, 0 0 0 9999px rgba(0,0,0,0); pointer-events: none; transition: all .15s ease; }
.em-onb-pop { position: fixed; z-index: 99002; max-width: 320px; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(11,20,24,.28); padding: 16px 18px; font: 13.5px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2d34; pointer-events: auto; }
.em-onb-pop h4 { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: #0b1418; }
.em-onb-pop p { margin: 0; color: #324049; }
.em-onb-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.em-onb-grow { flex: 1; }
.em-onb-btn { border: 1px solid #d3d9de; background: #fff; color: #1f2d34; border-radius: 8px; padding: 7px 13px; font: 600 12.5px inherit; cursor: pointer; }
.em-onb-btn:hover { background: #f3f5f7; }
.em-onb-btn.primary { background: #167873; border-color: #167873; color: #fff; }
.em-onb-btn.primary:hover { background: #115d5a; }
.em-onb-btn.ghost { border-color: transparent; color: #55636d; }
.em-onb-step { font-size: 12.5px; color: #7a8892; font-weight: 600; }
.em-onb-arrow { position: fixed; z-index: 99002; width: 0; height: 0; pointer-events: none; }
.em-onb-pop.em-onb-center { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%); max-width: 420px; padding: 24px 26px; text-align: center; }
.em-onb-pop.em-onb-center h4 { font-size: 20px; margin-bottom: 8px; }
.em-onb-pop.em-onb-center p { color: #324049; }
.em-onb-pop.em-onb-center .em-onb-foot { flex-wrap: wrap; }
.em-onb-helpbtn { position: fixed; left: 18px; bottom: 18px; z-index: 98000; width: 44px; height: 44px; border-radius: 50%; background: #167873; color: #fff; border: 0; cursor: pointer; box-shadow: 0 6px 18px rgba(13,138,114,.4); font-size: 20px; font-weight: 700; display: grid; place-items: center; }
.em-onb-helpbtn.on { background: #b45309; }
.em-onb-marker { position: fixed; z-index: 98500; width: 20px; height: 20px; border-radius: 50%; background: #167873; color: #fff; border: 2px solid #fff; box-shadow: 0 2px 8px rgba(11,20,24,.3); cursor: pointer; font: 700 12.5px/16px sans-serif; text-align: center; pointer-events: auto; }
@keyframes em-onb-pulse { 0%{box-shadow:0 0 0 3px #167873,0 0 0 0 rgba(22,120,115,.5)} 70%{box-shadow:0 0 0 3px #167873,0 0 0 10px rgba(22,120,115,0)} 100%{box-shadow:0 0 0 3px #167873,0 0 0 0 rgba(22,120,115,0)} }
.em-onb-ring.pulse { animation: em-onb-pulse 1.8s infinite; }
`;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Spotlight + Popover primitives
// ---------------------------------------------------------------------------
function clearOverlay() {
    document.querySelectorAll('.em-onb-overlay, .em-onb-pop:not(.help-pop), .em-onb-arrow, .em-onb-dim, .em-onb-ring').forEach(n => n.remove());
    window.removeEventListener('resize', repositionActive);
    window.removeEventListener('scroll', repositionActive, true);
}
let repositionActive = () => {};

// Render a spotlight (dim + ring) over `rect`, or a plain dim if rect is null.
function renderSpotlight(rect, block) {
    document.querySelectorAll('.em-onb-dim, .em-onb-ring').forEach(n => n.remove());
    if (!rect) {
        const dim = el('div', { class: 'em-onb-dim', style: { inset: '0' } });
        if (!block) dim.style.pointerEvents = 'none';
        document.body.appendChild(dim);
        return;
    }
    const pad = 6;
    const x = Math.max(0, rect.left - pad), y = Math.max(0, rect.top - pad);
    const w = rect.width + pad * 2, h = rect.height + pad * 2;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Four dim panels around the hole (lets the highlighted element stay visible/clickable).
    const mk = (st) => { const d = el('div', { class: 'em-onb-dim', style: st }); if (!block) d.style.pointerEvents = 'none'; document.body.appendChild(d); };
    mk({ left: '0', top: '0', width: vw + 'px', height: y + 'px' });
    mk({ left: '0', top: (y + h) + 'px', width: vw + 'px', height: Math.max(0, vh - y - h) + 'px' });
    mk({ left: '0', top: y + 'px', width: x + 'px', height: h + 'px' });
    mk({ left: (x + w) + 'px', top: y + 'px', width: Math.max(0, vw - x - w) + 'px', height: h + 'px' });
    document.body.appendChild(el('div', { class: 'em-onb-ring pulse', style: { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' } }));
}

// Place a popover next to `rect` (auto flip), or centered if rect is null.
function placePopover(pop, rect) {
    if (!rect) { pop.classList.add('em-onb-center'); document.body.appendChild(pop); return; }
    document.body.appendChild(pop);
    const pr = pop.getBoundingClientRect();
    const gap = 14, vw = window.innerWidth, vh = window.innerHeight;
    let top, left, placement = 'bottom';
    if (rect.bottom + gap + pr.height < vh) { top = rect.bottom + gap; placement = 'bottom'; }
    else if (rect.top - gap - pr.height > 0) { top = rect.top - gap - pr.height; placement = 'top'; }
    else { top = Math.max(8, Math.min(vh - pr.height - 8, rect.top)); placement = 'side'; }
    if (placement === 'side') {
        left = (rect.right + gap + pr.width < vw) ? rect.right + gap : Math.max(8, rect.left - gap - pr.width);
    } else {
        left = Math.max(8, Math.min(vw - pr.width - 8, rect.left + rect.width / 2 - pr.width / 2));
    }
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
}

// ---------------------------------------------------------------------------
// Tour engine
// ---------------------------------------------------------------------------
function startTour(steps, onDone) {
    if (!Array.isArray(steps) || !steps.length) { onDone && onDone(); return; }
    let i = 0;
    const render = () => {
        clearOverlay();
        const step = steps[i];
        const target = resolveTarget(step.target);
        // Skip a step whose target can't be resolved (best-effort, no-touch).
        if (step.target && !target) { i++; if (i >= steps.length) { finish(); } else { render(); } return; }
        if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const rect = target ? target.getBoundingClientRect() : null;
        renderSpotlight(rect, false);
        const last = i === steps.length - 1;
        const pop = el('div', { class: 'em-onb-pop' },
            el('div', { class: 'em-onb-step' }, trf('Шаг {i} из {n}', { i: i + 1, n: steps.length })),
            el('h4', null, tr(step.title || '')),
            el('p', { html: tr(step.body || '') }),
            el('div', { class: 'em-onb-foot' },
                el('button', { class: 'em-onb-btn ghost', onclick: skip }, tr('Пропустить')),
                el('span', { class: 'em-onb-grow' }),
                i > 0 ? el('button', { class: 'em-onb-btn', onclick: () => { i--; render(); } }, tr('Назад')) : null,
                el('button', { class: 'em-onb-btn primary', onclick: () => { if (last) finish(); else { i++; render(); } } }, tr(last ? 'Готово' : 'Далее')),
            ),
        );
        placePopover(pop, rect);
        repositionActive = () => {
            const r2 = target ? target.getBoundingClientRect() : null;
            renderSpotlight(r2, false);
            placePopover(pop, r2);
        };
        window.addEventListener('resize', repositionActive);
        window.addEventListener('scroll', repositionActive, true);
    };
    const close = () => { clearOverlay(); S.active = null; onDone && onDone(); };
    const skip   = () => close();
    const finish = () => close();
    S.active = { steps, close };
    render();
}

// Welcome modal → Start / Skip / Never show again.
function showWelcome(onStart) {
    clearOverlay();
    renderSpotlight(null, true);
    const pop = el('div', { class: 'em-onb-pop em-onb-center' },
        el('h4', null, tr('Добро пожаловать в EasyMed HIS')),
        el('p', null, tr('Давайте за 2 минуты пройдёмся по системе.')),
        el('div', { class: 'em-onb-foot', style: { justifyContent: 'center', marginTop: '18px' } },
            el('button', { class: 'em-onb-btn ghost', onclick: () => { setNever(); clearOverlay(); } }, tr('Больше не показывать')),
            el('button', { class: 'em-onb-btn', onclick: () => { markWelcomeDone(); clearOverlay(); } }, tr('Пропустить')),
            el('button', { class: 'em-onb-btn primary', onclick: () => { markWelcomeDone(); clearOverlay(); onStart(); } }, tr('Начать тур')),
        ),
    );
    placePopover(pop, null);
}

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------
function markWelcomeDone() { S.store.welcomeDone = true; saveStore(S.user?.id, S.store); }
function setNever() { S.store.neverShow = true; S.store.welcomeDone = true; saveStore(S.user?.id, S.store); }
function markTour(name) { S.store.completedTours[name] = true; saveStore(S.user?.id, S.store); }
function markTip(key) { S.store.completedTips[key] = true; saveStore(S.user?.id, S.store); }
function tipDone(key) { return !!S.store.completedTips[key]; }

// ---------------------------------------------------------------------------
// Content registries (data-driven; extend freely)
// ---------------------------------------------------------------------------
const MODULE_STEPS = {
    patients:       { target: { nav: 'patients' },       title: 'Пациенты', body: 'Регистрация, поиск и ведение пациентов.' },
    consultation:   { target: { nav: 'consultation' },   title: 'Кабинет врача', body: 'Консультации, назначения, диагнозы и планы лечения.' },
    beds:           { target: { nav: 'beds' },           title: 'Палаты и койки', body: 'Госпитализации, переводы, занятость коек и выписки.' },
    cashier:        { target: { nav: 'cashier' },        title: 'Касса', body: 'Платежи, счета и кассовые операции.' },
    'cashier-shifts': { target: { nav: 'cashier-shifts' }, title: 'Кассовая смена', body: 'Открытие/закрытие смены, X/Z-отчёты и сдача кассы.' },
    reports:        { target: { nav: 'reports' },        title: 'Отчёты', body: 'Аналитика и отчётность клиники.' },
};
const TOURS = {
    registrar:     ['patients', 'cashier', 'reports'],
    doctor:        ['patients', 'consultation'],
    nurse:         ['patients', 'beds'],
    cashier:       ['cashier', 'cashier-shifts'],
    administrator: ['patients', 'consultation', 'beds', 'cashier-shifts', 'reports'],
    _default:      ['patients', 'consultation', 'beds', 'cashier-shifts'],
};
function tourSteps(role) {
    return (TOURS[role] || TOURS._default).map(k => MODULE_STEPS[k]).filter(Boolean);
}

// Contextual tips: shown once when a view is first opened (role-filtered).
const CONTEXT_TIPS = {
    // ONBOARDING_TARGET_V1 (2026-09-05) — цель была `.sidebar-cta`, призывная
    // кнопка меню. Оболочку перестроили (NO_TABS_APPBAR_V1), кнопки не стало,
    // resolveTarget стал возвращать null — и подсказка тихо пропускалась:
    // ошибка без единого следа на экране. Теперь она показывает на ту кнопку,
    // которая действительно заводит пациента, — «Создать пациента» в шапке
    // раздела (views/patients.js, data-onb).
    patients:        [{ key: 'patients.new', target: { selector: '[data-onb="create-patient"]' }, title: 'Совет', body: 'Заведите первого пациента кнопкой <b>Создать пациента</b> в шапке раздела.' }],
    cashier:         [{ key: 'cashier.open', target: { selector: '#sidebar-body .nav-item.active' }, title: 'Совет', body: 'Откройте кассовую смену перед приёмом платежей.' }],
    'cashier-shifts':[{ key: 'shift.open', target: { selector: '#sidebar-body .nav-item.active' }, title: 'Совет', body: 'Откройте смену, чтобы начать принимать платежи.' }],
    beds:            [{ key: 'beds.legend', target: { selector: '#sidebar-body .nav-item.active' }, title: 'Совет', body: 'Зелёные койки свободны; занятые показывают пациента.' }],
};

// Help-mode markers per view: ⓘ with an explanation.
const HELP_HINTS = {
    beds:   [{ target: { selector: '#sidebar-body .nav-item.active' }, title: 'Перевод между палатами', body: 'Перемещение пациента с одной койки/палаты на другую с сохранением истории.' }],
    cashier:[{ target: { selector: '#sidebar-body .nav-item.active' }, title: 'Страховое биллингование', body: 'Услуги, покрытые плательщиком, идут в акт, а не в кассу.' }],
};

// Empty-state hints: when the app shows an `.empty` node on this view.
// (Currently disabled — the patient view has multiple sub-lists, any of which
// can be empty for legitimate reasons. Latching onto the first .empty node
// misled users into thinking the whole patient table was empty.)
const EMPTY_HINTS = {};

// ---------------------------------------------------------------------------
// Contextual tips — shown on view change, once
// ---------------------------------------------------------------------------
function maybeShowTip(view) {
    if (S.active || S.store.neverShow) return;
    const tips = (CONTEXT_TIPS[view] || []).filter(t => !t.role || t.role === S.role);
    const tip = tips.find(t => !tipDone(t.key));
    if (!tip) return;
    const target = resolveTarget(tip.target);
    if (tip.target && !target) return;   // skip if not resolvable
    const rect = target ? target.getBoundingClientRect() : null;
    const pop = el('div', { class: 'em-onb-pop' },
        el('h4', null, tr(tip.title || 'Совет')),
        el('p', { html: tr(tip.body || '') }),
        el('div', { class: 'em-onb-foot' },
            el('span', { class: 'em-onb-grow' }),
            el('button', { class: 'em-onb-btn primary', onclick: () => { markTip(tip.key); pop.remove(); } }, tr('Понятно')),
        ),
    );
    placePopover(pop, rect);
    pop.classList.add('help-pop');   // not cleared by tour clearOverlay
}

// ---------------------------------------------------------------------------
// Empty-state guidance — observe the app's `.empty` nodes
// ---------------------------------------------------------------------------
function checkEmptyState(view) {
    document.querySelectorAll('.em-onb-empty').forEach(n => n.remove());
    const hint = EMPTY_HINTS[view];
    if (!hint || S.store.neverShow) return;
    const content = document.querySelector('.content, #view-root, main') || document.body;
    if (!content.querySelector('.empty')) return;
    const cta = hint.cta ? resolveTarget(hint.cta) : null;
    const box = el('div', { class: 'em-onb-pop help-pop em-onb-empty', style: { position: 'static', maxWidth: 'none', margin: '10px auto', boxShadow: 'none', border: '1px dashed #d3d9de' } },
        el('h4', null, tr(hint.title)),
        el('p', null, tr(hint.body)),
        hint.cta ? el('div', { class: 'em-onb-foot' }, el('button', { class: 'em-onb-btn primary', onclick: () => { const t = resolveTarget(hint.cta); if (t) t.click(); } }, tr(hint.ctaLabel || 'Создать'))) : null,
    );
    const emptyEl = content.querySelector('.empty');
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.insertBefore(box, emptyEl.nextSibling);
}

// ---------------------------------------------------------------------------
// Help Mode — toggle + ⓘ markers
// ---------------------------------------------------------------------------
function renderHelpButton() {
    // COMBINED_FAB_V1 — the standalone «?» FAB is retired: Режим подсказок moved
    // into the support-widget button (bottom-left).
    // SUPPORT_FAB_REMOVED_V1 — та кнопка убрана (см. admin.html), поэтому у
    // «Режима подсказок» сейчас НЕТ точки входа в интерфейсе. Сам режим цел и
    // включается из консоли: window.easymedOnboarding.setHelpMode(true).
    // Если он понадобится пользователям — вернуть сюда собственную кнопку.
    return;
}
function clearHelpMarkers() { document.querySelectorAll('.em-onb-marker').forEach(n => n.remove()); }
function renderHelpMarkers(view) {
    clearHelpMarkers();
    if (!S.store.helpMode) return;
    for (const hint of (HELP_HINTS[view] || [])) {
        const target = resolveTarget(hint.target);
        if (!target) continue;
        const r = target.getBoundingClientRect();
        const m = el('div', { class: 'em-onb-marker', title: tr(hint.title), style: { left: (r.right - 8) + 'px', top: (r.top - 8) + 'px' },
            onclick: () => {
                clearOverlay();
                const pop = el('div', { class: 'em-onb-pop help-pop' },
                    el('h4', null, tr(hint.title)), el('p', { html: tr(hint.body) }),
                    el('div', { class: 'em-onb-foot' }, el('span', { class: 'em-onb-grow' }), el('button', { class: 'em-onb-btn primary', onclick: () => pop.remove() }, tr('Закрыть'))));
                placePopover(pop, r);
            } }, 'i');
        document.body.appendChild(m);
    }
}
function setHelpMode(on) {
    S.store.helpMode = !!on; saveStore(S.user?.id, S.store);
    const btn = document.querySelector('.em-onb-helpbtn'); if (btn) btn.classList.toggle('on', !!on);
    if (on) renderHelpMarkers(S.view); else clearHelpMarkers();
}

// ---------------------------------------------------------------------------
// View change handling
// ---------------------------------------------------------------------------
function onViewChange(view) {
    S.view = view;
    document.querySelectorAll('.em-onb-pop.help-pop:not(.em-onb-empty)').forEach(n => n.remove());
    clearHelpMarkers();
    setTimeout(() => {
        renderHelpMarkers(view);
        checkEmptyState(view);
        if (!S.active) maybeShowTip(view);
    }, 350);   // let the view render
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const api = {
    defineTour(role, steps) { TOURS[role] = steps; },
    defineModuleStep(key, step) { MODULE_STEPS[key] = step; },
    defineTips(view, tips) { CONTEXT_TIPS[view] = tips; },
    defineHelp(view, hints) { HELP_HINTS[view] = hints; },
    defineEmpty(view, hint) { EMPTY_HINTS[view] = hint; },
    setHelpMode,
    helpMode: () => !!(S.store && S.store.helpMode),   // COMBINED_FAB_V1 — read by support-widget's joint button
    restart() { startTour(tourSteps(S.role), () => markTour(S.role)); },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function normalizeRole(u) {
    const r = String(u?.role || u?.role_name || '').toLowerCase();
    if (/(admin|owner|super)/.test(r)) return 'administrator';
    if (/(registr|reception|регистр)/.test(r)) return 'registrar';
    if (/(doctor|врач)/.test(r)) return 'doctor';
    if (/(nurse|медсестр)/.test(r)) return 'nurse';
    if (/(cashier|касс)/.test(r)) return 'cashier';
    return '_default';
}
function init() {
    injectStyles();
    S.user = window.easymed.state.user;
    S.role = normalizeRole(S.user);
    S.store = loadStore(S.user?.id);
    S.view = window.easymed.state.view;
    window.easymedOnboarding = api;
    renderHelpButton();
    // First-login welcome → role tour.
    if (!S.store.welcomeDone && !S.store.neverShow) {
        setTimeout(() => showWelcome(() => startTour(tourSteps(S.role), () => markTour(S.role))), 800);
    }
    // Poll for view changes (the app updates window.easymed.state.view on navigate).
    let lastView = S.view;
    setInterval(() => {
        const v = window.easymed?.state?.view;
        if (v && v !== lastView) { lastView = v; onViewChange(v); }
    }, 600);
    // Initial pass for the landing view.
    onViewChange(S.view);
}
(function waitForApp(tries = 0) {
    if (window.easymed?.state?.user) { try { init(); } catch (e) { console.warn('[onboarding] init failed:', e); } return; }
    if (tries > 60) return;   // ~30s then give up silently
    setTimeout(() => waitForApp(tries + 1), 500);
})();
