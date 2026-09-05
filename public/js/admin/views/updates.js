// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 6) — the
// approval screen: the moment a human says yes to an offered version and
// picks the hour. SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md,
// Task 3) grew this route into Settings → «Система» by hanging three sibling
// cards off it — subscription, backups, the danger zone.
//
// SETTINGS_SPLIT_V1 (2026-08-29) took them off again. The owner's instruction:
// «in the system only the version and last updated "wahts new"». So this
// screen is back to what its name says — the current version, the offer /
// approve UI (that is what the screen is FOR), and the one-time what's-new
// note. Nothing was deleted, only rehoused:
//     subscription  ->  views/subscription.js   (route 'subscription')
//     backups       ->  views/clinic-data.js    (route 'clinic-data')
//     danger zone   ->  views/clinic-data.js
// Each of those imports the SAME card module it always did; there is no second
// copy of any card anywhere.
//
// Route id stays 'updates': the banner, deep links and admin.js's lockout
// exemption all key on it.
//
// Reachable from renderUpdateBanner() (admin.js) and from Settings →
// «Система» (settings-hub.js). It survives a full licence lockout on purpose
// (admin.js's renderViewInner exempts 'updates' next to 'activation') — an
// update may be exactly what fixes the clinic's own licensing situation. The
// other two halves of the old page carry their own exemptions now, for the
// reasons written in their own headers.
//
// READABLE BY ANYONE; the approve/change/cancel BUTTONS render only for an
// admin actor — ../admin-actor.js, the one shared verdict all three screens
// use. Politeness only: every RPC re-checks server-side no matter what renders.
//
// Every scheduling/formatting DECISION lives in ../updates-logic.js as pure,
// unit-tested functions — this file only builds DOM and talks to RPCs.
//
// UPDATES_I18N_V1 (2026-08-30) — EVERY user-facing string on this screen goes
// through tr(), and there is a test that fails if a new one ever does not:
// updates-i18n.test.js next door reads this file, finds every Cyrillic string
// literal in it, and asserts (a) that each one is an argument to tr(), and
// (b) that the dictionary has ru/uz/en for it. Measured before the change
// (comments excluded): 23 bare literals against 12 tr() calls, plus every
// dynamic sentence updates-logic.js built by concatenation — so an Uzbek
// clinic read a mixture. The owner's 2026-08-29 screenshot showed
// «Joriy versiya: 0.4.5» over «У вас последняя версия — 0.4.5.». Sentences
// with a version/date/byte count in them are templates plus say() now, never
// concatenation; see say() below.
//
// UPDATE_PROGRESS_V1 (2026-08-30, owner: «can we show status of the
// downloading of the last update please fix that») — paintProgress() renders
// the phase and the real byte counts the updater reports, so a clinic can
// tell a big download from a hung one.

import { h, Icon, clear, toast } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { licenceState } from '../licence.js';
import { isAdminActor } from '../admin-actor.js';
import {
    scheduleChoices, resolveHour, isValidHour, offerIsCurrent,
    formatScheduled, updateOutcomeMessage, whatsNewState, pendingRestartMessage,
    fill, upToDateMessage, progressView,
} from '../updates-logic.js';
// SETTINGS_SPLIT_V1 — imported ONLY to keep the old '#updates/subscription'
// deep link landing on the subscription screen (see renderUpdates below).
// The ?v= tag MUST match admin.js's import of the same file: a browser keys
// modules by URL, so two different tags would load two instances of it (the
// same trap doc-settings.js's own '?v must match in EVERY importer' note
// records).
import { renderSubscription } from './subscription.js?v=split1';

const LAST_SEEN_KEY = 'em.updates.lastSeenVersion';
const NOTES_CACHE_KEY = 'em.updates.notesCache';   // { [version]: notes_ru } — small, capped below

// UPDATES_I18N_V1 (2026-08-30) — every sentence on this screen that has a
// version, date or byte count in it.
//
// The owner photographed a clinic running fully in Uzbek — «Tizim»,
// «Yangilanishlarni tekshirish», «Joriy versiya: 0.4.5» — with «У вас
// последняя версия — 0.4.5.» underneath it in Russian. The cause was not a
// missing dictionary entry: it was that the sentence was CONCATENATED
// (`'У вас последняя версия' + ' — ' + v + '.'`), and tr() matches whole
// strings, so no key could ever have existed for it.
//
// The fix is this one helper. updates-logic.js hands back {template, params}
// where the template is the complete Russian phrase with `{version}` still in
// it — a real dictionary key — and translation happens BEFORE the values go
// back in. `extra` is a second, independently translatable sentence (only the
// «база данных восстановлена» case needs one), never a fragment.
//
// ui.js's h() ALREADY runs tr() over plain-text children and over aria-label,
// so an explicit tr() around an h() child translates twice. That is deliberate
// here — the explicit call is what makes the routing visible in this file and
// what the test above can actually check, and it covers the paths h() never
// touches (toast(), .textContent, and say()'s own output). It is safe only
// while no translation is itself a key meaning something else; STRINGS does
// contain English keys, so updates-i18n.test.js asserts that translating twice
// equals translating once for every string this screen uses.
function say(msg) {
    if (!msg) return null;
    let out = fill(tr(msg.template), msg.params);
    if (msg.extra) out += ' ' + tr(msg.extra);
    return out;
}

// SETTINGS_SPLIT_V1 — isAdminActor() moved to ../admin-actor.js when the page
// split into three screens that must all agree on the same verdict; its
// reasoning (and its deliberate mirroring of cashier-desk.js /
// telegram-chat.js) travelled with it.

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

// SETTINGS_SPLIT_V1 (2026-08-29) — «Подписка» is its own route now
// ('subscription'), but the hash it used to live at must keep working: the
// predecessor arrangement (SUBSCRIPTION_SUBROUTE_V1) pointed the settings tile
// at '#updates/subscription', so that string is in browser histories, in
// bookmarks, and in whatever the owner pasted to somebody. It is answered here
// rather than in admin.js's router because a redirect at THIS level is true for
// every caller — router, banner, a direct renderUpdates() call in a test — and
// because there is then exactly one place that knows the old hash exists.
//
// The tab keeps its identity ('updates' — tabIdFor() has no notion of the sub),
// so its label is corrected through the bridge admin.js already exposes for
// async tab titles. Without that the strip would say «Система» over a page
// showing «Подписка».
export async function renderUpdates(root, ctx = {}) {
    if (ctx.payload && ctx.payload.sub === 'subscription') {
        try {
            if (typeof window !== 'undefined' && typeof window.easymedSetTabLabel === 'function') {
                window.easymedSetTabLabel(ctx.tabId, tr('Подписка'));
            }
        } catch (e) { /* косметика вкладки — не повод не показать экран */ }
        clear(root);
        return void await renderSubscription(root, ctx);
    }
    // A previous mount's watcher must never outlive it: navigating away and
    // back would otherwise leave two timers polling, and a watcher whose view
    // is long gone can reload the tab out from under whatever the user moved
    // on to. paint() below restarts one if an install is genuinely in flight.
    stopVersionWatch();
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
    // SETTINGS_SPLIT_V1 — the button stays here, on the screen that owns the
    // update offer, and did NOT follow the subscription card to its new route:
    // the owner's list for that screen is "subscription state + modules", and
    // a module granted after «Запросить» still arrives by itself on the next
    // daily check-in.
    const admin = isAdminActor();
    const head = h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, tr('Система')),
            h('p', { class: 'page-subtitle' }, tr('Версия системы и что нового в последнем обновлении.'))));
    if (admin) {
        const checkStatus = h('span', { class: 'upd-check-status muted', role: 'status' });
        const checkBtn = h('button', {
            type: 'button', class: 'btn btn-outline upd-check-btn',
            onclick: () => checkNow(body, checkBtn, checkStatus),
        }, Icon('Refresh', { size: 15 }), ' ', tr('Проверить обновления'));
        head.appendChild(h('div', { class: 'upd-check' }, checkBtn, checkStatus));
    }
    wrap.appendChild(head);

    // SETTINGS_SPLIT_V1 — the «Обновления» section heading went with the
    // siblings: it existed to separate four cards from one another, and one
    // section does not need a heading repeating the page it is on.
    wrap.appendChild(body);
    // ICON_CREDIT_V1 (2026-09-05) — CC BY 4.0 grants the right to use the icon
    // set on ONE condition: the attribution travels with the work. Until now
    // it lived only in public/assets/icons/coolicons/ATTRIBUTION.md — a file
    // inside the release archive that no screen has ever linked to, i.e. the
    // condition was met for whoever unpacks the archive and for nobody who
    // uses the program. One line, on the screen that already exists to say
    // what this program IS (version, what's new), outside `body` so paint()'s
    // clear() never takes it away.
    wrap.appendChild(paintIconCredit());
    body.appendChild(h('div', { class: 'empty' }, tr('Загрузка…')));

    let status = null;
    try {
        const { data, error } = await supabase.rpc('update_status', {});
        if (error) throw error;
        status = data || {};
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'card upd-card' },
            h('p', { class: 'upd-error', role: 'status' }, tr('Не удалось загрузить статус обновления. Попробуйте ещё раз позже.'))));
        // Still not a `return`: the message replaces the «Загрузка…»
        // placeholder and the check button above stays live, so an offline
        // clinic gets a screen it can retry from rather than a spinner that
        // never resolves. (It used to matter for a second reason — the backup
        // cards below had to render anyway — which moved to
        // views/clinic-data.js with them.)
    }
    if (status) paint(body, status);
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

// UPDATE_PAGE_RELOAD_V1 — the page reloads itself once the new version is up.
//
// The server already restarts onto the new version by itself (updater.js
// staleAfterSwitch → exit 75 → the launcher relaunches). What it cannot do is
// refresh the browser tab standing in front of it: an open page keeps showing
// the version it booted with, next to the offer it has ALREADY installed. Every
// successful update on 2026-08-24 looked like a failure for exactly this reason
// — the owner pressed «Обновить сейчас» four times and each time the screen sat
// unchanged while the install had in fact completed.
//
// Polls the authenticated update_status RATHER than adding a version to the
// public /api/health: health takes no session, and a clinic's build number is
// not something to hand an unauthenticated caller on the LAN. Polling is
// bounded to the window where an update is actually in flight, so this is never
// a background timer running all day.
const RELOAD_POLL_MS = 5000;
const RELOAD_GIVE_UP_MS = 15 * 60 * 1000;   // an install that takes longer has failed; the outcome file will say so
let _watchTimer = null;
let _watchBoot = null;
// UPDATE_PROGRESS_V1 — the last progress the screen actually drew. The poll
// below already ran every 5s; repainting on EVERY tick would rebuild the
// card (and the «Изменить время»/«Отменить» buttons under it) whether or not
// anything moved, so a repaint happens only when this signature changes.
let _watchDrawn = null;

// What "something moved" means. Bytes and phase are the real progress; the
// coarse age bucket is what lets a download that has STOPPED moving still
// flip into its stall message — without it the screen would freeze on the
// last byte count precisely in the case the owner most needs told about.
function progressSignature(status) {
    const p = status && status.progress;
    if (!p) return '';
    const ageBucket = Math.floor((Number(p.age_ms) || 0) / 30000);
    return [p.version, p.phase, p.bytes, p.total, ageBucket].join('|');
}

function stopVersionWatch() {
    if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
    _watchBoot = null;
    _watchDrawn = null;
}

function watchForNewVersion(bootVersion, body) {
    // One watcher at a time, and an EXISTING watch for this same version is
    // left running: paint() fires on every repaint, so restarting here would
    // both multiply timers and reset the give-up clock on every redraw.
    if (!bootVersion) return;
    if (_watchTimer && _watchBoot === bootVersion) return;
    stopVersionWatch();
    _watchBoot = bootVersion;
    const startedAt = Date.now();
    _watchTimer = setInterval(async () => {
        if (Date.now() - startedAt > RELOAD_GIVE_UP_MS) { stopVersionWatch(); return; }
        let data = null;
        try {
            const res = await supabase.rpc('update_status', {});
            if (res.error) return;   // mid-restart the server is simply gone — that is expected, keep waiting
            data = res.data;
        } catch { return; }
        const now = data && data.current_version;
        if (now && now !== bootVersion) {
            stopVersionWatch();
            // Reload, not repaint: every screen in the app was built by the OLD
            // code and the sidebar, licence and router state all came from that
            // boot. A repaint would leave a new server behind an old shell.
            if (typeof location !== 'undefined' && location.reload) location.reload();
            return;
        }
        // Still the same version — the update is somewhere in the middle of
        // itself. Redraw only when the progress record actually moved: this is
        // what turns a screen that used to say nothing for minutes into one
        // that counts megabytes.
        if (!body) return;
        const sig = progressSignature(data);
        if (sig === _watchDrawn) return;
        _watchDrawn = sig;
        paint(body, data || {});
    }, RELOAD_POLL_MS);
    // A timer must never hold the page open or outlive the view.
    if (_watchTimer && typeof _watchTimer.unref === 'function') _watchTimer.unref();
}
// ICON_CREDIT_V1 — the CC BY 4.0 notice itself: author, set, licence, and the
// fact that the drawings were CHANGED (build-icon-paths.mjs strips ids and the
// baked-in stroke/fill so the paths can take their colour and weight from the
// theme — a modification in the licence's sense, and one the licence says must
// be stated). Same four facts as ATTRIBUTION.md, which this links to in spirit
// by naming the same sources; the links are a bonus for a clinic that is
// online, the sentence itself is the attribution and it reads fine offline.
function paintIconCredit() {
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
    return h('p', { class: 'upd-credit' },
        tr('Иконки интерфейса:'), ' ',
        link('https://coolicons.cool/', 'coolicons'),
        ' — Kryston Schwarze, ',
        link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'),
        ', ', tr('с изменениями'), '.');
}

function paint(body, status) {
    clear(body);
    const admin = isAdminActor();
    const currentVersion = status.current_version || null;
    // offerIsCurrent — the narrow window right after a successful install,
    // before the next daily check-in clears/replaces the offer server-side
    // (see checkin.js). Treated as "nothing to offer" here too.
    const offer = offerIsCurrent(status.offer, currentVersion) ? null : status.offer;

    // Watch only while an install is actually coming: an approved consent, or
    // an outcome file naming a version newer than the one serving this page
    // (the launcher case — installed on disk, the old process still answering).
    // UPDATE_PROGRESS_V1 — the third reason to keep watching: a live progress
    // record. During the switch phase the consent has already been consumed,
    // so `approved` alone can go false at the exact moment the screen most
    // needs to keep refreshing.
    const prog = progressView(status.progress);
    const installing = !!status.approved
        || !!pendingRestartMessage(status.last_result, currentVersion)
        || (prog.show && prog.tone === 'busy');
    // Started, never cancelled by a repaint. The status that arrives WHILE an
    // install runs is not stable — the consent is consumed before the new
    // version answers, so a repaint in that window reports approved:false and
    // an `else stopVersionWatch()` here silently ended the watch at exactly the
    // moment it was needed (caught by its own test, which is why it is written
    // this way). The watch ends on its own terms only: the version changed, or
    // the give-up deadline passed.
    if (installing) watchForNewVersion(currentVersion, body);
    // Recorded AFTER the call above, which may have restarted the watch (and
    // with it cleared this): what the screen is about to draw, so the poll
    // does not redraw the identical card five seconds later merely because it
    // had nothing to compare against yet.
    _watchDrawn = progressSignature(status);

    // UPDATE_PROGRESS_V1 — first on the screen while an update is actually
    // happening: it is the most perishable thing here, and the owner's
    // complaint («can we show status of the downloading») was exactly that
    // there was nothing at this spot at all.
    if (prog.show) body.appendChild(paintProgress(prog));

    // Bullet 5 — a failed-and-rolled-back last attempt, said plainly, before
    // anything else on the screen: "a clinic must not learn of its failed
    // update from the vendor".
    const outcomeMsg = updateOutcomeMessage(status.last_result, currentVersion);
    if (outcomeMsg) {
        body.appendChild(h('div', { class: 'card upd-card upd-outcome', role: 'status' },
            h('span', { class: 'upd-outcome-ic' }, Icon('Warning', { size: 16 })),
            // say() translates the WHOLE phrase and only then puts the version
            // and date back — passed as a plain h() child, so it is a real
            // Text node, never raw HTML.
            h('span', null, say(outcomeMsg))));
    }

    // INSTALLED, NOT YET RUNNING — the launcher case (no Windows service to
    // stop and start, so the old process keeps serving until the Easy-Med
    // window is reopened). Without this the screen shows the OLD version and
    // says nothing, which looks exactly like the update having failed — the
    // confusion that cost the owner a day on 2026-08-24. Rendered ABOVE the
    // offer for the same reason as the failure notice: the clinic must not
    // have to hunt for the state of its own system.
    const restartMsg = pendingRestartMessage(status.last_result, currentVersion);
    if (restartMsg) {
        body.appendChild(h('div', { class: 'card upd-card upd-restart', role: 'status' },
            h('span', { class: 'upd-outcome-ic' }, Icon('Refresh', { size: 16 })),
            h('span', null, say(restartMsg))));
    }

    // Bullet 6 — one-time "what's new", only once current_version has
    // actually moved past whatever THIS BROWSER last saw.
    const wn = whatsNewState(currentVersion, readLocal(LAST_SEEN_KEY), readNotesCache());
    if (wn.show) {
        body.appendChild(h('div', { class: 'card upd-card upd-whatsnew' },
            // Template + fill, not concatenation: «Что нового в версии X» is
            // one phrase in the dictionary, so it can actually be translated.
            h('div', { class: 'upd-whatsnew-title' }, Icon('Sparkles', { size: 15 }), ' ',
                fill(tr('Что нового в версии {version}'), { version: wn.version })),
            // XSS_HARDEN — notes_ru is vendor-entered free text, not this
            // clinic's own data. Rendered via h()'s plain-child path, which
            // appends a real DOM Text node (document.createTextNode) — never
            // via innerHTML/html(), so `<b>evil</b>` prints as those seven
            // literal characters and can never become a bold element or run
            // a script. No separate escapeHtml() call is needed because no
            // HTML string is ever built here; see the identical note on
            // offer.notes_ru in paintOffer() below.
            wn.notes ? h('p', { class: 'upd-notes' }, wn.notes) : h('p', { class: 'upd-notes muted' }, tr('Обновление установлено.'))));
    }
    // Mark seen regardless of whether the note was shown — covers both "just
    // saw it" and "first-ever open on this browser, nothing to compare to".
    if (currentVersion) writeLocal(LAST_SEEN_KEY, currentVersion);

    body.appendChild(h('p', { class: 'upd-current' }, tr('Текущая версия:'), ' ', h('strong', null, currentVersion || '—')));

    if (!offer) {
        // Calm, deliberately unexciting — "up to date" is not an achievement
        // to celebrate every time, just the normal state of things.
        body.appendChild(h('div', { class: 'card upd-card upd-uptodate' },
            h('span', { class: 'upd-uptodate-ic' }, Icon('Check', { size: 16 })),
            // THE line from the owner's screenshot: an Uzbek screen with this
            // sentence in Russian, because it was concatenated. One whole
            // phrase per case now — see upToDateMessage().
            h('span', null, say(upToDateMessage(currentVersion)))));
        return;
    }

    rememberOffer(offer);   // see rememberOffer's own comment — must happen NOW, before this version ever becomes current

    body.appendChild(paintOffer(body, offer, admin, !!status.approved));
    if (status.approved) {
        body.appendChild(paintScheduled(body, status, offer, admin));
    }
}

// UPDATE_PROGRESS_V1 — what the update is doing, right now.
//
// Every DECISION (which phase, what percentage, is it stalled, is this record
// the corpse of an install a restart interrupted) is progressView()'s, in
// ../updates-logic.js, where it is unit-tested with no DOM in sight. This
// function only turns that verdict into elements.
//
// No emoji anywhere — icons come from the project's own set (../icons.js),
// same as every other card on this screen.
function paintProgress(view) {
    const card = h('div', {
        class: 'card upd-card upd-progress' + (view.tone === 'warn' ? ' upd-progress-warn' : ''),
        // Announced: this card changes underneath a person who may not be
        // looking at that exact corner of the screen.
        role: 'status', 'aria-live': 'polite',
    },
        h('div', { class: 'upd-progress-head' },
            Icon(view.tone === 'warn' ? 'Warning' : 'Download', { size: 16 }),
            h('span', null, say(view.title))));

    if (view.detail) card.appendChild(h('p', { class: 'upd-progress-detail' }, say(view.detail)));

    // A bar ONLY when a real percentage exists. With no Content-Length the
    // detail line says "загружено N МБ" and there is deliberately no bar —
    // a bar that crawls towards an unknown end is exactly the "is it stuck?"
    // confusion this change exists to end.
    if (view.percent != null) {
        const fillEl = h('div', { class: 'upd-progress-fill' });
        fillEl.style.width = view.percent + '%';
        card.appendChild(h('div', {
            class: 'upd-progress-bar', role: 'progressbar',
            'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(view.percent),
        }, fillEl));
    }

    if (view.note) card.appendChild(h('p', { class: 'upd-progress-note' }, say(view.note)));
    return card;
}

function paintOffer(body, offer, admin, approved) {
    const card = h('div', { class: 'card upd-card upd-offer' },
        h('div', { class: 'upd-offer-head' },
            Icon('Download', { size: 16 }),
            h('span', null, tr('Доступно обновление'), ' ', h('strong', null, offer.version))));
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
                tr('Только администратор клиники может подтвердить установку.')));
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
        tr('В это время клиника обычно работает — сотрудники будут отключены на 1–2 минуты.'));
    warnEl.style.display = 'none';

    const customInput = h('input', {
        type: 'number', min: '0', max: '23', class: 'upd-hour-input',
        value: String(choices.defaultHour), 'aria-label': tr('Другое время — час (0-23)'),
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

    // UPDATE_CONFIRM_V1 (2026-09-05) — «Обновить сейчас» is the ONE control on
    // this screen with no undo and no delay: update_approve({now:true}) stamps
    // scheduled_at = this instant (server/services/rpc/updates.js), the minute
    // tick picks it up and updater.js exits within seconds. Nothing anywhere
    // under public/ registers a beforeunload handler, so a half-typed patient
    // card, consultation or invoice in any OTHER open window simply ceases to
    // exist — with no message, on a click that until now took effect on the
    // first press.
    //
    // Every other button on this screen schedules for 03:00 and asks nothing,
    // correctly: nobody is mid-form at three in the morning. This one is
    // pressed at 11:40, which is exactly why it gets the question.
    //
    // The working-hours sentence is the one already written for the custom
    // hour picker below (warnEl) — the same event, the same consequence, so
    // the same words rather than a second wording that could drift. It is
    // added ONLY when the click really lands in working hours, so the dialog
    // does not cry wolf at 22:00.
    //
    // window.confirm is guarded the way roles-editor.js and crm-settings.js
    // guard theirs: the fake-DOM test harness has no dialogs, and a missing
    // one must not turn the button into a no-op.
    function confirmRestartNow() {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
        const at = new Date();   // NOT the `now` captured when the screen was drawn — it may have sat open for hours
        const lines = [tr('Установить обновление сейчас?')];
        if (resolveHour(at.getHours(), at).isWorking) {
            lines.push(tr('В это время клиника обычно работает — сотрудники будут отключены на 1–2 минуты.'));
        }
        lines.push(tr('Программа перезапустится сразу. Всё незаписанное в открытых окнах — карта пациента, приём, счёт — пропадёт.'));
        return window.confirm(lines.join('\n\n'));
    }

    // «Обновить сейчас» — same one-action rule as approve(), different wire
    // shape ({now:true}, no hour): the server stamps scheduled_at = this
    // instant and the minute tick installs straight away. Owner-requested
    // (2026-08-23) after the hour-only screen made even a vendor test wait
    // for the next full hour.
    async function approveNow() {
        if (busy) return;
        // Asked BEFORE setBusy: «Отмена» must leave the screen exactly as it
        // was, buttons live, nothing said in statusEl.
        if (!confirmRestartNow()) return;
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
        tr('Обновить сейчас'));
    const tonightBtn = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => approve(choices.tonight.hour) },
        tr('Обновить сегодня ночью'));
    const tomorrowBtn = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => approve(choices.tomorrow.hour) },
        tr('Обновить завтра ночью'));
    const customBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => approve(customInput.value) },
        tr('Запланировать'));
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
            h('span', { class: 'upd-choice-when muted' }, tr('сотрудники будут отключены на 1–2 минуты'))),
        h('div', { class: 'upd-choice' },
            tonightBtn,
            h('span', { class: 'upd-choice-when muted' }, choices.tonight.dateLabel + ', ' + choices.tonight.hourLabel)),
        h('div', { class: 'upd-choice' },
            tomorrowBtn,
            h('span', { class: 'upd-choice-when muted' }, choices.tomorrow.dateLabel + ', ' + choices.tomorrow.hourLabel)),
        h('div', { class: 'upd-choice upd-choice-custom' },
            h('label', { class: 'upd-hour-label' }, tr('Другое время:'), ' ', customInput, ' ', customPreview),
            customBtn),
        warnEl,
        statusEl);
}

function paintScheduled(body, status, offer, admin) {
    const msg = formatScheduled({ hour: status.hour, scheduled_at: status.scheduled_at, immediate: status.immediate });
    const card = h('div', { class: 'card upd-card upd-scheduled' },
        h('div', { class: 'upd-scheduled-head' }, Icon('Clock', { size: 16 }),
            h('span', null, tr('Обновление подтверждено'), ' ', h('strong', null, offer.version))),
        h('p', { class: 'upd-scheduled-msg', role: 'status' }, say(msg) || tr('Обновление подтверждено.')));

    if (!admin) return card;   // non-admin: status only, no change/cancel controls

    const statusEl = h('p', { class: 'upd-action-status', role: 'status' });
    const changeBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, tr('Изменить время'));
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, tr('Отменить'));
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
