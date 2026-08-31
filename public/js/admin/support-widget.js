// Easy-Med — floating help / support bubble.
// Mounted on every admin page. Renders a fixed-position circle button
// bottom-right. Click → chat panel slides up with the current ticket's
// message history + a typing area. Sending fires send_support_message
// RPC which finds (or creates) the company's active ticket and appends.
//
// Polls every 25s while open so platform replies show up without a
// page refresh. Unread badge on the bubble surfaces fresh replies even
// when the panel is closed.

import { supabase } from '../supabase.js';
import { tr } from './i18n.js';   // I18N_COVERAGE_V1 — sink-обёртки: textContent/confirm не проходят через h()

const STATE = {
    bubble:        null,
    panel:         null,
    ticket:        null,        // current ticket row
    pollTimer:     null,
    unreadCount:   0,
    booted:        false,
};

const POLL_MS = 25_000;

// ---------------------------------------------------------------------
// Styles — kept inline in JS so the widget works on any page without a
// matching <link> tag.
// ---------------------------------------------------------------------
function injectStyles() {
    if (document.getElementById('sw-styles')) return;
    const s = document.createElement('style');
    s.id = 'sw-styles';
    // i18n-exempt-start: CSS виджета — русский встречается только в CSS-комментарии внутри строки
    s.textContent = `
.sw-bubble {
    /* COMBINED_FAB_V1 — the single floating button (chat + Режим подсказок), bottom-LEFT. */
    position: fixed; left: 18px; bottom: 18px; z-index: 99999;
    width: 56px; height: 56px; border-radius: 50%; border: none;
    background: linear-gradient(135deg, #0d8a8a, #0a6e6e);
    color: white; cursor: pointer; box-shadow: 0 12px 30px rgba(13,138,138,0.42);
    display: grid; place-items: center;
    transition: transform .15s, box-shadow .15s;
}
.sw-bubble:hover { transform: scale(1.06); box-shadow: 0 14px 36px rgba(13,138,138,0.55); }
.sw-bubble .sw-icon { width: 24px; height: 24px; }
.sw-bubble .sw-x    { display: none; width: 18px; height: 18px; }
.sw-bubble.open .sw-icon { display: none; }
.sw-bubble.open .sw-x    { display: block; }
.sw-bubble .sw-badge {
    position: absolute; top: -4px; right: -4px;
    min-width: 20px; height: 20px; border-radius: 999px;
    background: #d75050; color: white;
    font-size: 12.5px; font-weight: 700; letter-spacing: -0.02em;
    display: grid; place-items: center; padding: 0 6px;
    border: 2px solid white; line-height: 1;
}
.sw-bubble .sw-badge.hidden { display: none; }

.sw-panel {
    position: fixed; left: 18px; bottom: 84px; z-index: 99998;   /* COMBINED_FAB_V1 — left side */
    width: 380px; max-width: calc(100vw - 32px); height: 540px; max-height: calc(100vh - 120px);
    background: white; border-radius: 16px; box-shadow: 0 28px 60px rgba(11,20,28,0.28);
    display: none; flex-direction: column; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transform-origin: bottom left; animation: sw-pop .18s ease-out;
}
/* COMBINED_FAB_V1 — mini-menu that fans out of the single FAB */
.sw-menu { position: fixed; left: 18px; bottom: 84px; z-index: 99999; display: none; flex-direction: column; gap: 8px; }
.sw-menu.open { display: flex; animation: sw-pop .15s ease-out; transform-origin: bottom left; }
.sw-menu-item {
    display: flex; align-items: center; gap: 10px;
    background: #fff; border: 1px solid #e2e8ea; border-radius: 999px;
    padding: 8px 16px 8px 9px; cursor: pointer;
    box-shadow: 0 10px 26px rgba(11,20,28,0.18);
    font: 600 13.5px -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1f2d34;
}
.sw-menu-item:hover { background: #f4f8f8; }
.sw-menu-item .ic { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: #0d8a8a; color: #fff; font-weight: 700; flex: none; }
.sw-menu-item.help.on .ic { background: #b45309; }
.sw-panel.open { display: flex; }
@keyframes sw-pop { from { transform: scale(.92) translateY(8px); opacity: 0 } to { transform: scale(1) translateY(0); opacity: 1 } }

.sw-head {
    background: linear-gradient(135deg, #0d8a8a, #0a6e6e);
    color: white; padding: 16px 18px; flex-shrink: 0;
}
.sw-head h3 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.sw-head .sw-sub { font-size: 12.5px; opacity: 0.85; margin-top: 3px; line-height: 1.4; }

.sw-body {
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 16px 14px; background: #f4f7f9;
    display: flex; flex-direction: column; gap: 10px;
}
.sw-empty {
    text-align: center; color: #5a6c78; font-size: 13.5px;
    margin: auto; max-width: 280px; padding: 16px; line-height: 1.55;
}
.sw-empty .sw-empty-icon { font-size: 40px; margin-bottom: 10px; opacity: 0.65; }

.sw-msg {
    display: flex; gap: 6px; align-items: flex-end;
    max-width: 86%;
}
.sw-msg.user      { align-self: flex-end;   flex-direction: row-reverse; }
.sw-msg.platform  { align-self: flex-start; }
.sw-msg.system    { align-self: center; max-width: 100%; }
.sw-msg .sw-bub-content {
    background: white; border: 1px solid #e6ecf0; border-radius: 14px; padding: 9px 13px;
    font-size: 13.5px; line-height: 1.5; color: #0d1e2c; word-wrap: break-word;
}
.sw-msg.user .sw-bub-content {
    background: linear-gradient(180deg, #0d8a8a, #0a6e6e);
    color: white; border-color: transparent; border-bottom-right-radius: 4px;
}
.sw-msg.platform .sw-bub-content { border-bottom-left-radius: 4px; }
.sw-msg.system .sw-bub-content {
    background: transparent; color: #7a8a94; font-size: 12.5px; font-style: italic;
    border: none; padding: 4px 8px;
}
.sw-msg .sw-time { font-size: 12.5px; color: #97a4ad; margin: 0 6px 2px; }

.sw-foot {
    flex-shrink: 0; border-top: 1px solid #e6ecf0;
    padding: 12px 14px; background: white;
}
.sw-input-row { display: flex; gap: 8px; align-items: flex-end; }
.sw-input {
    flex: 1; min-height: 38px; max-height: 120px; resize: none;
    padding: 9px 12px; border: 1.5px solid #d8e0e6; border-radius: 10px;
    font-size: 13.5px; font-family: inherit; outline: none;
    background: white; color: #0d1e2c; transition: border-color .12s;
    line-height: 1.45;
}
.sw-input:focus { border-color: #0d8a8a; }
.sw-send {
    padding: 9px 14px; border-radius: 10px; border: none;
    background: linear-gradient(180deg, #0d8a8a, #0a6e6e); color: white;
    font-weight: 700; font-size: 13.5px; cursor: pointer; font-family: inherit;
    flex-shrink: 0;
}
.sw-send:disabled { opacity: 0.5; cursor: not-allowed; }
.sw-foot .sw-help { font-size: 12.5px; color: #97a4ad; margin-top: 6px; text-align: center; line-height: 1.35; }
.sw-foot .sw-err  { font-size: 12.5px; color: #c83434; margin-top: 6px; min-height: 16px; }
`;
    /* i18n-exempt-end */
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------
// DOM build
// ---------------------------------------------------------------------
function buildBubble() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw-bubble';
    b.setAttribute('aria-label', 'Help');
    b.innerHTML = `
        <svg class="sw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>
        </svg>
        <svg class="sw-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        <span class="sw-badge hidden" id="sw-badge">0</span>
    `;
    return b;
}

// COMBINED_FAB_V1 — mini-menu for the single FAB: Чат поддержки + Режим подсказок
// (the onboarding overlay's «?» button was merged into this one).
function buildMenu() {
    const m = document.createElement('div');
    m.className = 'sw-menu';
    m.innerHTML = `
        <button type="button" class="sw-menu-item chat"><span class="ic">💬</span>${tr('Чат поддержки')}</button>
        <button type="button" class="sw-menu-item help"><span class="ic">?</span><span class="lbl">${tr('Режим подсказок')}</span></button>
    `;
    m.querySelector('.chat').addEventListener('click', () => { m.classList.remove('open'); open(); });
    m.querySelector('.help').addEventListener('click', () => {
        const ob = window.easymedOnboarding;
        m.classList.remove('open');
        if (!ob || !ob.setHelpMode) return;
        const cur = typeof ob.helpMode === 'function' ? ob.helpMode() : false;
        ob.setHelpMode(!cur);
    });
    return m;
}
function syncHelpItem() {
    const it = STATE.menu && STATE.menu.querySelector('.sw-menu-item.help');
    if (!it) return;
    const ob = window.easymedOnboarding;
    const on = !!(ob && typeof ob.helpMode === 'function' && ob.helpMode());
    it.classList.toggle('on', on);
    const lbl = it.querySelector('.lbl'); if (lbl) lbl.textContent = on ? tr('Режим подсказок: вкл') : tr('Режим подсказок');
}

function buildPanel() {
    const p = document.createElement('div');
    p.className = 'sw-panel';
    p.innerHTML = `
        <div class="sw-head">
            <h3>Help &amp; support</h3>
            <div class="sw-sub">Send us a message — we usually reply within an hour during business hours.</div>
        </div>
        <div class="sw-body" id="sw-body">
            <div class="sw-empty"><div class="sw-empty-icon">💬</div>Start a conversation — questions about pricing, features, bugs, billing — anything. We're here.</div>
        </div>
        <div class="sw-foot">
            <div class="sw-input-row">
                <textarea id="sw-input" class="sw-input" placeholder="Type your message…" rows="1" maxlength="2000"></textarea>
                <button id="sw-send" class="sw-send">Send</button>
            </div>
            <div class="sw-err" id="sw-err"></div>
            <div class="sw-help">Enter to send · Shift+Enter for newline</div>
        </div>
    `;
    return p;
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function renderMessages(messages) {
    const body = STATE.panel.querySelector('#sw-body');
    if (!messages || messages.length === 0) {
        body.innerHTML = `<div class="sw-empty"><div class="sw-empty-icon">💬</div>Start a conversation — questions about pricing, features, bugs, billing — anything. We're here.</div>`;
        return;
    }
    body.innerHTML = messages.map(m => {
        const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="sw-msg ${escapeHtml(m.sender)}">
                <div class="sw-bub-content">${escapeHtml(m.body).replace(/\n/g, '<br>')}</div>
                <span class="sw-time">${escapeHtml(time)}</span>
            </div>
        `;
    }).join('');
    // Scroll to bottom (latest message)
    body.scrollTop = body.scrollHeight;
}

function updateBadge(n) {
    STATE.unreadCount = n || 0;
    const el = STATE.bubble?.querySelector('#sw-badge');
    if (!el) return;
    if (n > 0) {
        el.textContent = n > 99 ? '99+' : String(n);
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------
async function fetchTicket() {
    // Defensive scoping: super admins can see every company's tickets via
    // RLS, so we MUST filter by this subdomain's clinic. Otherwise the
    // latest ticket from any clinic would leak into this widget.
    const companyId = window.CLINIC?.id;
    if (!companyId) return null;
    const { data, error } = await supabase
        .from('support_tickets')
        .select('id, status, unread_for_user, last_message_at, last_message_from, subject, company_id')
        .eq('company_id', companyId)
        .order('last_message_at', { ascending: false })
        .limit(1);
    if (error) return null;
    return (data && data[0]) || null;
}

async function fetchMessages(ticketId) {
    const { data, error } = await supabase
        .from('support_messages')
        .select('id, sender, body, created_at')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true })
        .limit(200);
    if (error) { console.warn('[support-widget] fetch messages failed', error); return []; }
    return data || [];
}

async function refresh({ markRead = false } = {}) {
    if (!isAuthenticated()) return;
    const t = await fetchTicket();
    STATE.ticket = t;
    if (!t) {
        if (STATE.panel?.classList.contains('open')) renderMessages([]);
        updateBadge(0);
        return;
    }
    updateBadge(t.unread_for_user);
    if (STATE.panel?.classList.contains('open')) {
        const msgs = await fetchMessages(t.id);
        renderMessages(msgs);
        if (markRead && t.unread_for_user > 0) {
            await supabase.rpc('mark_support_read_user', { p_ticket_id: t.id });
            updateBadge(0);
        }
    }
}

function isAuthenticated() {
    // The widget is mounted in admin.html; if there's no logged-in user
    // we hide entirely (the login overlay covers the page anyway).
    return !!(window.easymed?.state?.user?.id);
}

function hasClinicContext() {
    // No clinic = apex (easymed.uz/admin); the widget makes no sense
    // there because we have nobody specific to bind a conversation to.
    return !!(window.CLINIC?.id);
}

// ---------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------
function open() {
    if (!STATE.panel) return;
    STATE.panel.classList.add('open');
    STATE.bubble.classList.add('open');
    // A single background poll (started once auth lands) already keeps the
    // ticket + unread badge fresh, so opening only needs an immediate refresh
    // — starting a second timer here would double the polling while open.
    refresh({ markRead: true });
    STATE.panel.querySelector('#sw-input').focus();
}
function close() {
    STATE.panel.classList.remove('open');
    STATE.bubble.classList.remove('open');
    // The background poll keeps running so the unread badge stays live while
    // the panel is closed; it is the single timer owned by STATE.pollTimer.
}
function toggle() {
    if (STATE.panel.classList.contains('open')) close();
    else open();
}

// ---------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------
async function send() {
    const ta  = STATE.panel.querySelector('#sw-input');
    const btn = STATE.panel.querySelector('#sw-send');
    const err = STATE.panel.querySelector('#sw-err');
    const body = ta.value.trim();
    err.textContent = '';
    if (!body) return;
    if (!hasClinicContext()) {
        const slug = window.CLINIC_SLUG || (location.hostname.split('.')[0]);
        err.textContent = `We can't find a clinic for "${slug}". Open Settings → Companies and confirm the slug matches this URL, or refresh after fixing it.`;
        return;
    }
    btn.disabled = true;
    try {
        // Pass window.CLINIC.id explicitly — that's the SUBDOMAIN's clinic.
        // Without this, the RPC falls back to the user's home company,
        // which leaks across subdomains for super admins.
        const { error } = await supabase.rpc('send_support_message', {
            p_body:       body,
            p_subject:    null,
            p_company_id: window.CLINIC?.id || null,
        });
        if (error) throw error;
        ta.value = '';
        ta.style.height = 'auto';
        await refresh({ markRead: true });
    } catch (e) {
        err.textContent = e.message || 'Could not send. Try again.';
        console.error('[support-widget] send failed', e);
    } finally {
        btn.disabled = false;
        ta.focus();
    }
}

// ---------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------
export function mountSupportWidget() {
    if (STATE.booted) return;
    STATE.booted = true;
    injectStyles();
    STATE.bubble = buildBubble();
    STATE.panel  = buildPanel();
    document.body.appendChild(STATE.bubble);
    document.body.appendChild(STATE.panel);
    // COMBINED_FAB_V1 — one button: клик открывает мини-меню (Чат / Режим
    // подсказок); открытая панель чата закрывается кликом как раньше.
    STATE.menu = buildMenu();
    document.body.appendChild(STATE.menu);
    STATE.bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        if (STATE.panel.classList.contains('open')) { close(); return; }
        STATE.menu.classList.toggle('open');
        syncHelpItem();
    });
    document.addEventListener('click', (e) => {
        if (!STATE.menu.classList.contains('open')) return;
        if (!STATE.menu.contains(e.target) && !STATE.bubble.contains(e.target)) STATE.menu.classList.remove('open');
    });

    const ta = STATE.panel.querySelector('#sw-input');
    const btn = STATE.panel.querySelector('#sw-send');
    btn.addEventListener('click', send);
    ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // Auto-grow textarea
    ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
    });

    // Visibility strategy:
    //   * Hidden until the user is authenticated (don't show on login page)
    //   * Shows as soon as auth lands, EVEN IF window.CLINIC hasn't
    //     populated yet (it usually arrives a few ms later)
    //   * If we open the panel before CLINIC is known, we degrade with
    //     an inline message instead of silently failing
    STATE.bubble.style.display = 'none';

    let authPolls = 0;
    const authWaiter = setInterval(() => {
        authPolls++;
        if (isAuthenticated()) {
            clearInterval(authWaiter);
            STATE.bubble.style.display = 'grid';
            // Once authenticated, start fetching (handles missing CLINIC
            // gracefully — fetchTicket() will just return null).
            refresh();
            // Single owned background poll — tracked so it is never duplicated.
            if (!STATE.pollTimer) STATE.pollTimer = setInterval(refresh, POLL_MS);
            // If we're on the apex (no slug), tone the widget down a
            // notch so it doesn't promise something it can't deliver.
            if (!hasClinicContext()) {
                console.warn('[support-widget] no clinic context yet — apex page or CLINIC failed to load');
            }
            return;
        }
        // Give up after 60s of no auth (user is on login page).
        if (authPolls > 60) clearInterval(authWaiter);
    }, 1000);
}

// Auto-mount on DOMContentLoaded (idempotent).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSupportWidget);
else mountSupportWidget();
