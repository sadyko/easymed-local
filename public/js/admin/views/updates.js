// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 6) — the
// approval screen: the moment a human says yes to an offered version and
// picks the hour. SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md,
// Task 3) grew this route into Settings → «Система»: the updates cards this
// file owns, then three sibling card modules — activation & subscription
// (system-subscription.js), backups (system-backups.js) and the danger zone
// (system-danger.js) — split out rather than inlined so this file stays
// readable (the same sibling-module pattern laboratory.js uses for
// lab-barcode.js/lab-grouping.js). Route id stays 'updates' on purpose: deep
// links and admin.js's lockout exemption both key on it.
//
// Reachable from renderUpdateBanner() (admin.js) and from Settings →
// «Система» (settings-hub.js). It survives a full licence lockout on purpose
// (admin.js's renderViewInner exempts 'updates' next to 'activation') — an
// update may be exactly what fixes the clinic's own licensing situation, and
// now also because a lapsed clinic must still be able to save its data and a
// decommissioned one to erase itself (the backup/reset RPCs are
// ALWAYS_ALLOWED server-side for the same reason — see
// server/services/control/gate.js's own comment).
//
// READABLE BY ANYONE; the approve/change/cancel BUTTONS render only for an
// admin actor — checked the same way cashier-desk.js's isGeneralAdmin() and
// telegram-chat.js's canBroadcast() already do (primary role OR 'admin' in
// extra_roles, never `user.role === 'admin'` alone — see isAdminActor()
// below). The sibling cards receive that same verdict as a parameter instead
// of re-deriving it, so all call sites still move together. This is
// politeness only: every RPC re-checks server-side no matter what renders.
//
// Every scheduling/formatting DECISION lives in ../updates-logic.js (updates)
// or ../system-logic.js (the three new cards) as pure, unit-tested functions —
// the view files only build DOM and talk to RPCs.

import { h, Icon, clear, toast } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { licenceState } from '../licence.js';
import {
    scheduleChoices, resolveHour, isValidHour, offerIsCurrent,
    formatScheduled, updateOutcomeMessage, whatsNewState,
} from '../updates-logic.js';
import { renderSubscriptionCard } from './system-subscription.js';
import { renderBackupsCard } from './system-backups.js';
import { renderDangerCard } from './system-danger.js';

const LAST_SEEN_KEY = 'em.updates.lastSeenVersion';
const NOTES_CACHE_KEY = 'em.updates.notesCache';   // { [version]: notes_ru } — small, capped below

// Mirrors cashier-desk.js's isGeneralAdmin() / telegram-chat.js's
// canBroadcast() exactly, on purpose — one convention for "does the CURRENT
// actor hold admin, counting extra_roles" across every view that needs it,
// not a fourth slightly-different copy. (window.easymed.state.user does not
// currently carry `extra_roles` — see those two files' own history — so the
// fallback below is inert today the same way theirs is; it stays here so all
// three call sites move together the day that gap is closed, instead of
// fixing one and leaving the others silently behind again.)
function isAdminActor() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u) return false;
    if (u.is_super_admin === true || u.is_admin === true) return true;
    const extra = Array.isArray(u.extra_roles) ? u.extra_roles : [];
    return [u.role, ...extra].includes('admin');
}

function readLocal(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
    try { localStorage.setItem(key, value); } catch { /* best-effort — a note shown twice is not worth crashing over */ }
}
function readNotesCache() {
    try {
        const raw = readLocal(NOTES_CACHE_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch { return {}; }
}
// Cache an offer's notes the MOMENT the clinic ever sees it — by the time
// the version installs and current_version catches up, the offer field has
// usually moved on to whatever comes next (or is gone entirely; see
// checkin.js), so nothing server-side still has this version's notes lying
// around by then. See updates-logic.js's whatsNewState() for the read side.
function rememberOffer(offer) {
    if (!offer || !offer.version) return;
    const cache = readNotesCache();
    cache[offer.version] = offer.notes_ru || '';
    // Capped at 5 — a clinic sees a handful of releases in its lifetime, not
    // enough to make this a real storage concern, but unbounded growth
    // forever is still sloppy for no benefit.
    const keys = Object.keys(cache);
    while (keys.length > 5) { delete cache[keys.shift()]; }
    writeLocal(NOTES_CACHE_KEY, JSON.stringify(cache));
}

export async function renderUpdates(root) {
    clear(root);
    const wrap = h('div', { class: 'fade-in upd-wrap' });
    root.appendChild(wrap);

    const body = h('div', { class: 'upd-body' });

    // «Проверить обновления» — one immediate check-in instead of waiting for
    // the daily timer. The same check-in also renews the licence and delivers
    // module grants (see rpc/updates.js's updateCheckNow), which is why a
    // successful check re-reads licence_status below: if the vendor just
    // granted a module, the whole app must re-read its licence — a reload,
    // the same way activation.js reloads after a successful unlock — instead
    // of leaving the sidebar lying until the next full page load.
    // Admin-only in the UI to match the server's own hasAnyRole gate; the
    // server re-checks regardless, this is the same politeness as the
    // approve/cancel buttons above it.
    // The page head says «Система» (settings-hub.js's tile matches); the
    // check button stays up here because it serves TWO cards at once — the
    // same check-in that fetches an update offer also renews the licence and
    // delivers module grants, so it is the subscription card's "refresh"
    // exactly as much as the updates card's (the plan's own table says so).
    const admin = isAdminActor();
    const head = h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'Система'),
            h('p', { class: 'page-subtitle' }, 'Обновления, активация, резервные копии и данные клиники.')));
    if (admin) {
        const checkStatus = h('span', { class: 'upd-check-status muted', role: 'status' });
        const checkBtn = h('button', {
            type: 'button', class: 'btn btn-outline upd-check-btn',
            onclick: () => checkNow(body, checkBtn, checkStatus),
        }, Icon('Refresh', { size: 15 }), ' ', 'Проверить обновления');
        head.appendChild(h('div', { class: 'upd-check' }, checkBtn, checkStatus));
    }
    wrap.appendChild(head);

    wrap.appendChild(h('h2', { class: 'sys-section-title' }, 'Обновления'));
    wrap.appendChild(body);
    body.appendChild(h('div', { class: 'empty' }, 'Загрузка…'));

    let status = null;
    try {
        const { data, error } = await supabase.rpc('update_status', {});
        if (error) throw error;
        status = data || {};
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'card upd-card' },
            h('p', { class: 'upd-error', role: 'status' }, 'Не удалось загрузить статус обновления. Попробуйте ещё раз позже.')));
        // Deliberately NOT a return any more: the cards below must render
        // even when the update status cannot load — a clinic that cannot
        // reach its own server status is exactly the clinic that may need
        // its backups next.
    }
    if (status) paint(body, status);

    // SYSTEM_SETTINGS_V1 — the three sibling cards, in the plan's order.
    // Subscription paints synchronously from the boot-time licence copy;
    // backups is awaited so this function resolves only once the whole page
    // is real (the fake-DOM tests — and the human eye — rely on that).
    const subRoot = h('div');
    wrap.appendChild(subRoot);
    renderSubscriptionCard(subRoot, { admin });

    const bakRoot = h('div');
    wrap.appendChild(bakRoot);
    await renderBackupsCard(bakRoot, { admin });

    const dzRoot = h('div');
    wrap.appendChild(dzRoot);
    renderDangerCard(dzRoot, { admin });
}

// The button's whole flow: check in now, then decide whether the LICENCE
// moved (module granted, subscription renewed, lock lifted) — that needs a
// reload so every part of the app re-reads it — or only the update status
// moved, which this screen can repaint in place.
async function checkNow(body, btn, statusEl) {
    // Same explicit re-entrancy guard as buildScheduleControls' approve():
    // `disabled` stops a real pointer click but not a second direct call
    // landing before the browser reflects the attribute.
    if (btn.disabled) return;
    btn.disabled = true;
    statusEl.textContent = tr('Проверка…');
    try {
        const { data, error } = await supabase.rpc('update_check_now', {});
        if (error) throw error;
        // ok:false is the RPC's honest "the check-in itself broke" (see
        // updateCheckNow's backstop) — the status fields beside it are still
        // current, but the admin must not read "Проверка выполнена" off a
        // check that never reached the vendor.
        if (data && data.ok === false) throw new Error('checkin failed');

        const before = licenceState();
        const { data: lic } = await supabase.rpc('licence_status', {});
        const changed = lic && (
            JSON.stringify(Array.isArray(lic.modules) ? lic.modules : []) !==
            JSON.stringify(Array.isArray(before.modules) ? before.modules : [])
            || (lic.locked === true) !== (before.locked === true)
        );
        if (changed) {
            statusEl.textContent = '';
            toast(tr('Лицензия обновлена — страница перезагрузится.'), 'ok');
            // Same short readable-before-reload delay as activation.js's
            // unlock path — not a mechanism anything depends on.
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 1200);
            return;
        }

        statusEl.textContent = '';
        toast(tr('Проверка выполнена.'), 'ok');
        refreshBanner();
        paint(body, data || {});
        btn.disabled = false;
    } catch (e) {
        btn.disabled = false;
        statusEl.textContent = tr('Не удалось проверить обновления. Попробуйте ещё раз.');
    }
}

function paint(body, status) {
    clear(body);
    const admin = isAdminActor();
    const currentVersion = status.current_version || null;
    // offerIsCurrent — the narrow window right after a successful install,
    // before the next daily check-in clears/replaces the offer server-side
    // (see checkin.js). Treated as "nothing to offer" here too.
    const offer = offerIsCurrent(status.offer, currentVersion) ? null : status.offer;

    // Bullet 5 — a failed-and-rolled-back last attempt, said plainly, before
    // anything else on the screen: "a clinic must not learn of its failed
    // update from the vendor".
    const outcomeMsg = updateOutcomeMessage(status.last_result, currentVersion);
    if (outcomeMsg) {
        body.appendChild(h('div', { class: 'card upd-card upd-outcome', role: 'status' },
            h('span', { class: 'upd-outcome-ic' }, Icon('Warning', { size: 16 })),
            // outcomeMsg already carries the failed version + date spliced
            // in (updates-logic.js's own dynamic-Russian-sentence
            // convention) — passed as a plain h() child, so it is a real
            // Text node either way, never raw HTML.
            h('span', null, outcomeMsg)));
    }

    // Bullet 6 — one-time "what's new", only once current_version has
    // actually moved past whatever THIS BROWSER last saw.
    const wn = whatsNewState(currentVersion, readLocal(LAST_SEEN_KEY), readNotesCache());
    if (wn.show) {
        body.appendChild(h('div', { class: 'card upd-card upd-whatsnew' },
            h('div', { class: 'upd-whatsnew-title' }, Icon('Sparkles', { size: 15 }), ' ', 'Что нового в версии ' + wn.version),
            // XSS_HARDEN — notes_ru is vendor-entered free text, not this
            // clinic's own data. Rendered via h()'s plain-child path, which
            // appends a real DOM Text node (document.createTextNode) — never
            // via innerHTML/html(), so `<b>evil</b>` prints as those seven
            // literal characters and can never become a bold element or run
            // a script. No separate escapeHtml() call is needed because no
            // HTML string is ever built here; see the identical note on
            // offer.notes_ru in paintOffer() below.
            wn.notes ? h('p', { class: 'upd-notes' }, wn.notes) : h('p', { class: 'upd-notes muted' }, 'Обновление установлено.')));
    }
    // Mark seen regardless of whether the note was shown — covers both "just
    // saw it" and "first-ever open on this browser, nothing to compare to".
    if (currentVersion) writeLocal(LAST_SEEN_KEY, currentVersion);

    body.appendChild(h('p', { class: 'upd-current' }, 'Текущая версия:', ' ', h('strong', null, currentVersion || '—')));

    if (!offer) {
        // Calm, deliberately unexciting — "up to date" is not an achievement
        // to celebrate every time, just the normal state of things.
        body.appendChild(h('div', { class: 'card upd-card upd-uptodate' },
            h('span', { class: 'upd-uptodate-ic' }, Icon('Check', { size: 16 })),
            // Dynamic version spliced into a fixed Russian sentence — same
            // convention as updates-logic.js's own formatted strings.
            h('span', null, 'У вас последняя версия' + (currentVersion ? ' — ' + currentVersion : '') + '.')));
        return;
    }

    rememberOffer(offer);   // see rememberOffer's own comment — must happen NOW, before this version ever becomes current

    body.appendChild(paintOffer(body, offer, admin, !!status.approved));
    if (status.approved) {
        body.appendChild(paintScheduled(body, status, offer, admin));
    }
}

function paintOffer(body, offer, admin, approved) {
    const card = h('div', { class: 'card upd-card upd-offer' },
        h('div', { class: 'upd-offer-head' },
            Icon('Download', { size: 16 }),
            h('span', null, 'Доступно обновление', ' ', h('strong', null, offer.version))));
    if (offer.notes_ru) {
        // See the identical XSS_HARDEN note above — plain h() child, real
        // Text node, `<b>evil</b>` can never become markup here.
        card.appendChild(h('p', { class: 'upd-notes' }, offer.notes_ru));
    }
    if (!admin) {
        // Once already approved (by an admin, possibly in a different
        // session), telling a non-admin "only an admin can confirm this" is
        // stale and confusing — paintScheduled() below already gives them
        // the read-only confirmation instead.
        if (!approved) {
            card.appendChild(h('p', { class: 'upd-admin-note muted' },
                'Только администратор клиники может подтвердить установку.'));
        }
        return card;
    }
    if (!approved) {
        card.appendChild(buildScheduleControls(body, offer));
    }
    return card;
}

function buildScheduleControls(body, offer) {
    const now = new Date();
    const choices = scheduleChoices(now);
    const statusEl = h('p', { class: 'upd-action-status', role: 'status' });
    const warnEl = h('p', { class: 'upd-hour-warn' },
        Icon('Warning', { size: 13 }), ' ',
        'В это время клиника обычно работает — сотрудники будут отключены на 1–2 минуты.');
    warnEl.style.display = 'none';

    const customInput = h('input', {
        type: 'number', min: '0', max: '23', class: 'upd-hour-input',
        value: String(choices.defaultHour), 'aria-label': 'Другое время — час (0-23)',
    });
    const customPreview = h('span', { class: 'upd-hour-preview muted' });

    const buttons = [];
    let busy = false;
    function setBusy(v) { busy = v; for (const b of buttons) b.disabled = v; }

    // ONE action: consent + timing together, one RPC call, never two
    // screens. Re-entrancy guarded the same way locked-module.js's cta is —
    // `disabled` alone stops a real pointer click but not a second direct
    // call landing before the browser reflects the attribute.
    async function approve(hour) {
        if (busy) return;
        if (!isValidHour(hour)) { statusEl.textContent = tr('Выберите час от 0 до 23.'); return; }
        setBusy(true);
        statusEl.textContent = '';
        try {
            const { error } = await supabase.rpc('update_approve', { hour: Number(hour) });
            if (error) throw error;
            const { data: fresh, error: err2 } = await supabase.rpc('update_status', {});
            if (err2) throw err2;
            toast(tr('Обновление запланировано'), 'ok');
            refreshBanner();
            paint(body, fresh || {});   // re-paint straight into the scheduled state — no half-approved limbo
        } catch (e) {
            // RPC failure mid-approve (clinic offline at that second): button
            // re-enables, message says try again, NOTHING half-approved —
            // update_approve only writes consent after every check passes,
            // so a thrown/network-failed call has written nothing at all.
            setBusy(false);
            statusEl.textContent = tr('Не удалось запланировать обновление. Попробуйте ещё раз.');
        }
    }

    // «Обновить сейчас» — same one-action rule as approve(), different wire
    // shape ({now:true}, no hour): the server stamps scheduled_at = this
    // instant and the minute tick installs straight away. Owner-requested
    // (2026-08-23) after the hour-only screen made even a vendor test wait
    // for the next full hour.
    async function approveNow() {
        if (busy) return;
        setBusy(true);
        statusEl.textContent = '';
        try {
            const { error } = await supabase.rpc('update_approve', { now: true });
            if (error) throw error;
            const { data: fresh, error: err2 } = await supabase.rpc('update_status', {});
            if (err2) throw err2;
            toast(tr('Обновление устанавливается'), 'ok');
            refreshBanner();
            paint(body, fresh || {});
        } catch (e) {
            setBusy(false);
            statusEl.textContent = tr('Не удалось запланировать обновление. Попробуйте ещё раз.');
        }
    }

    const nowBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => approveNow() },
        'Обновить сейчас');
    const tonightBtn = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => approve(choices.tonight.hour) },
        'Обновить сегодня ночью');
    const tomorrowBtn = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => approve(choices.tomorrow.hour) },
        'Обновить завтра ночью');
    const customBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => approve(customInput.value) },
        'Запланировать');
    buttons.push(nowBtn, tonightBtn, tomorrowBtn, customBtn);

    function refreshCustomPreview() {
        if (!isValidHour(customInput.value)) { customPreview.textContent = ''; warnEl.style.display = 'none'; return; }
        const r = resolveHour(Number(customInput.value), now);
        customPreview.textContent = r.dateLabel + ', ' + r.hourLabel;
        warnEl.style.display = r.isWorking ? '' : 'none';   // warn, never block — it is their clinic
    }
    customInput.addEventListener('input', refreshCustomPreview);
    refreshCustomPreview();

    return h('div', { class: 'upd-actions' },
        h('div', { class: 'upd-choice' },
            nowBtn,
            // The honest cost of "now", stated where the button is — the same
            // sentence the working-hours warning uses, because it is the same
            // event: a server restart while people may be mid-form.
            h('span', { class: 'upd-choice-when muted' }, 'сотрудники будут отключены на 1–2 минуты')),
        h('div', { class: 'upd-choice' },
            tonightBtn,
            h('span', { class: 'upd-choice-when muted' }, choices.tonight.dateLabel + ', ' + choices.tonight.hourLabel)),
        h('div', { class: 'upd-choice' },
            tomorrowBtn,
            h('span', { class: 'upd-choice-when muted' }, choices.tomorrow.dateLabel + ', ' + choices.tomorrow.hourLabel)),
        h('div', { class: 'upd-choice upd-choice-custom' },
            h('label', { class: 'upd-hour-label' }, 'Другое время:', ' ', customInput, ' ', customPreview),
            customBtn),
        warnEl,
        statusEl);
}

function paintScheduled(body, status, offer, admin) {
    const msg = formatScheduled({ hour: status.hour, scheduled_at: status.scheduled_at, immediate: status.immediate });
    const card = h('div', { class: 'card upd-card upd-scheduled' },
        h('div', { class: 'upd-scheduled-head' }, Icon('Clock', { size: 16 }),
            h('span', null, 'Обновление подтверждено', ' ', h('strong', null, offer.version))),
        h('p', { class: 'upd-scheduled-msg', role: 'status' }, msg || 'Обновление подтверждено.'));

    if (!admin) return card;   // non-admin: status only, no change/cancel controls

    const statusEl = h('p', { class: 'upd-action-status', role: 'status' });
    const changeBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Изменить время');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Отменить');
    const buttons = [changeBtn, cancelBtn];
    let busy = false;
    function setBusy(v) { busy = v; for (const b of buttons) b.disabled = v; }

    // «Изменить время» is cancel + re-approve, ONE flow, no separate confirm
    // screen: cancelling clears the consent, and the very next paint() shows
    // the same offer with the schedule picker again — right up until the
    // window it runs in actually opens.
    async function doCancel(failMsg) {
        if (busy) return;
        setBusy(true);
        statusEl.textContent = '';
        try {
            const { error } = await supabase.rpc('update_cancel', {});
            if (error) throw error;
            const { data: fresh, error: err2 } = await supabase.rpc('update_status', {});
            if (err2) throw err2;
            refreshBanner();
            paint(body, fresh || {});
        } catch (e) {
            setBusy(false);
            statusEl.textContent = failMsg;
        }
    }
    changeBtn.addEventListener('click', () => doCancel(tr('Не удалось изменить время. Попробуйте ещё раз.')));
    cancelBtn.addEventListener('click', () => doCancel(tr('Не удалось отменить. Попробуйте ещё раз.')));

    card.appendChild(h('div', { class: 'upd-actions upd-actions-scheduled' }, changeBtn, cancelBtn, statusEl));
    return card;
}

// Best-effort — the banner (admin.js renderUpdateBanner) is a separate,
// already-mounted DOM tree this view has no reference to and cannot import
// (admin.js is the entry script; views never import it back, or every view
// would form a cycle with the file that imports them all). admin.js exposes
// a refresh hook the same way it already does window.easymedSetTabLabel for
// tab titles — a repaint here should not wait ON, nor fail because of, that
// unrelated part of the screen.
function refreshBanner() {
    try {
        if (typeof window !== 'undefined' && typeof window.easymedRefreshUpdateBanner === 'function') {
            window.easymedRefreshUpdateBanner().catch(() => {});
        }
    } catch { /* the banner is decorative from this screen's point of view */ }
}
