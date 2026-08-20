// Easy-Med — Platform Console boot.
// Lives at setting.easymed.uz. Strictly gated to super_admins; everyone
// else is bounced to their own clinic subdomain. Reads live data via
// Supabase using the authenticated session's JWT (super_admins bypass
// RLS through current_user_is_super_admin() in the policies).

import { supabase } from './supabase.js';
import { renderDashboard }      from './setting/views/dashboard.js?v=dash1';
import { renderClinics }        from './setting/views/clinics.js';
import { renderSignupRequests } from './setting/views/signup-requests.js';
import { renderUsers }          from './setting/views/users.js';
import { renderSettings }       from './setting/views/settings.js';
import { renderAudit }          from './setting/views/audit.js';
import { renderVerifications }  from './setting/views/verifications.js';
import { renderPlatformTeam }   from './setting/views/platform-team.js';
import { renderUpgradeRequests } from './setting/views/upgrade-requests.js';
import { renderPayments }        from './setting/views/payments.js';
import { renderTariffs }         from './setting/views/tariffs.js';
import { renderSupport }         from './setting/views/support.js';
import { renderCountries, renderRegions, renderDistricts, renderUserSignups } from './setting/views/refdata.js';
import { renderServiceCatalog } from './setting/views/service-catalog.js';
import { renderServiceRequests } from './setting/views/service-requests.js';
import { renderSymptexClinics } from './setting/views/symptex-clinics.js?v=symptex3';
import { gw } from './setting/gateway.js';   // PUBLIC_SITE_V1 — publication-request badge

const root = document.getElementById('platform-root');

const state = {
    me:           null,    // public.users row of the signed-in platform user
    view:         'dashboard',
    sub:          null,
    counts:       {},
    // Browser-style multi-tabs. Each tab owns its own DOM subtree mounted
    // inside #content; switching tabs only toggles visibility — the view
    // is never re-rendered, so search filters, table sort, scroll
    // position, in-progress form input, computed results all survive.
    //   { id, view, sub, label, root, scrollY }
    tabs:        [],
    activeTabId: null,
};

// `hideFromSidebar: true` means: still registered (and navigate(id) works),
// but absent from the sidebar tree. Geography / Services / Billing / Audit /
// Platform team all live inside the "Platform settings" hub now, so the
// sidebar shrinks to OVERVIEW / TENANCY / ACCESS REQUESTS / OPERATIONS-with-
// just-settings.
const VIEWS = {
    dashboard:       { label: 'Dashboard',        render: renderDashboard,      group: 'Overview' },
    verifications:   { label: 'Verifications',    render: renderVerifications,  group: 'Tenancy'  },
    clinics:         { label: 'Clinics',          render: renderClinics,        group: 'Tenancy'  },
    'symptex-clinics': { label: 'Clinics in Symptex', render: renderSymptexClinics, group: 'Tenancy' },
    'signup-requests': { label: 'Clinic signups',  render: renderSignupRequests, group: 'Access requests' },
    'user-signups':  { label: 'Sign-up requests', render: renderUserSignups, group: 'Access requests' },
    countries:       { label: 'Countries',        render: renderCountries,   group: 'Geography',  hideFromSidebar: true },
    regions:         { label: 'Regions',          render: renderRegions,     group: 'Geography',  hideFromSidebar: true },
    districts:       { label: 'Districts',        render: renderDistricts,   group: 'Geography',  hideFromSidebar: true },
    'service-catalog':  { label: 'Services catalog', render: renderServiceCatalog,  group: 'Services', hideFromSidebar: true },
    'service-requests': { label: 'Service requests', render: renderServiceRequests, group: 'Services', hideFromSidebar: true },
    'upgrade-requests':{ label: 'Upgrade requests', render: renderUpgradeRequests, group: 'Tenancy' },
    support:         { label: 'Support',          render: renderSupport,        group: 'Tenancy'  },
    payments:        { label: 'Payments',         render: renderPayments,       group: 'Billing',    hideFromSidebar: true },
    tariffs:         { label: 'Tariffs',          render: renderTariffs,        group: 'Billing',    hideFromSidebar: true },
    users:           { label: 'Users',            render: renderUsers,          group: 'Tenancy'  },
    audit:           { label: 'Audit log',        render: renderAudit,          group: 'Operations', hideFromSidebar: true },
    'platform-team': { label: 'Platform team',    render: renderPlatformTeam,   group: 'Operations', hideFromSidebar: true },
    settings:        { label: 'Platform settings', render: renderSettings,      group: 'Operations' },
};

// Hardcoded role → section-permission map. Migration 046 introduced
// users.platform_role; granular per-role tickable permissions move to a
// roles editor UI in a follow-up (this map becomes the seed data then).
// 'super_admin' implicitly gets everything (no key check below) so any
// new sidebar items added later don't accidentally lock them out.
const PLATFORM_ROLE_SECTIONS = {
    admin:    new Set(['dashboard','verifications','clinics','symptex-clinics','signup-requests','user-signups','countries','regions','districts','upgrade-requests','support','payments','tariffs','users','audit','platform-team','service-catalog','service-requests']),
    operator: new Set(['dashboard','verifications','signup-requests','upgrade-requests','support','payments','audit']),
};

// Expose the VIEWS registry for any view that wants to introspect the
// full nav (e.g. a future palette / quick-switcher) without an import cycle.
window.__SETTING_VIEWS__ = VIEWS;

// DIAG_VISIBLE_ERRORS_V1 — surface uncaught JS errors on-screen (temporary
// diagnostic). Without this a thrown error during boot/navigate silently
// leaves the UI spinning "Loading…" forever, which is impossible to debug
// remotely. Shows a fixed bottom banner with the real stack.
function __setFatal(msg) {
    try {
        let b = document.getElementById('em-fatal-banner');
        if (!b) {
            b = document.createElement('div');
            b.id = 'em-fatal-banner';
            b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,monospace;padding:10px 14px;max-height:42vh;overflow:auto;white-space:pre-wrap';
            (document.body || document.documentElement).appendChild(b);
        }
        b.textContent = 'JS error (setting console): ' + msg;
    } catch (_) {}
}
window.addEventListener('error', (e) => __setFatal((e.error && (e.error.stack || e.error.message)) || e.message || 'error'));
window.addEventListener('unhandledrejection', (e) => __setFatal('unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))));

function canSeeSection(viewId) {
    if (!state.me) return false;
    const role = state.me.platform_role;
    if (role === 'super_admin' || state.me.is_super_admin) return true;
    const allowed = PLATFORM_ROLE_SECTIONS[role];
    return !!(allowed && allowed.has(viewId));
}

export function navigate(view, opts = {}) {
    if (!VIEWS[view]) view = 'dashboard';
    // Permission gate: if the active platform role can't see this view,
    // bounce to the first one they can. Dashboard is in every role's
    // allow-set, so the fallback is reliable.
    if (!canSeeSection(view)) {
        for (const id of Object.keys(VIEWS)) {
            if (canSeeSection(id)) { view = id; break; }
        }
    }
    const sub = opts.sub || null;
    const tabId = tabIdFor(view, sub);

    // Tab already open? Just switch to it — never re-render.
    const existing = state.tabs.find(t => t.id === tabId);
    if (existing) {
        switchToTab(tabId);
        if (!opts.skipHistory) pushHistory(view, sub);
        return;
    }

    // First navigation since boot — kick the shell into existence so
    // #content exists for the new tab's root to mount into.
    if (!document.getElementById('content')) paintShell();

    // New tab — mount a fresh DOM root for it inside #content. The view's
    // render() draws into this root; switching tabs hides this root but
    // never destroys it, so all view state survives.
    const content = document.getElementById('content');
    const tabRoot = document.createElement('div');
    tabRoot.className = 'view-tab-root';
    tabRoot.dataset.tabId = tabId;
    tabRoot.innerHTML = '<div class="row-loading"><div class="spinner"></div>Loading…</div>';
    content.appendChild(tabRoot);

    const tab = {
        id:      tabId,
        view,
        sub,
        label:   initialTabLabel(view),
        root:    tabRoot,
        scrollY: 0,
    };

    // Save outgoing tab's scroll before swapping focus.
    snapshotActiveScroll();

    state.tabs.push(tab);
    state.activeTabId = tabId;
    state.view = view;
    state.sub  = sub;

    if (!opts.skipHistory) pushHistory(view, sub);

    paintShell();
    paintTabStrip();
    showOnlyActiveTab();

    // Render is async — fire-and-forget but catch rejections so a thrown
    // error in one view can't bubble up as an unhandled promise rejection
    // and break subsequent navigations.
    Promise.resolve()
        .then(() => VIEWS[view].render(tabRoot, { state, supabase, navigate, refreshBadges, sub }))
        .catch(err => {
            console.warn('[render]', view, err);
            // DIAG_VISIBLE_ERRORS_V1 — show the failure in the tab instead of an
            // endless spinner, so the actual cause is visible on screen.
            try {
                tabRoot.innerHTML = `<div class="row-loading" style="color:#f87171;white-space:pre-wrap;align-items:flex-start">`
                    + `Ошибка при загрузке «${esc(VIEWS[view]?.label || view)}»:\n`
                    + esc(err?.stack || err?.message || String(err)) + `</div>`;
            } catch (_) {}
        });
}

function pushHistory(view, sub) {
    const wantHash = '#' + view + (sub ? ':' + sub : '');
    if (location.hash !== wantHash) {
        try { history.pushState({ view, sub: sub || null }, '', wantHash); } catch {}
    }
}

// ---------------------------------------------------------------------
// Tab identity, labels, switching, reordering
// ---------------------------------------------------------------------
function tabIdFor(view, sub) {
    // Sub-routed views get their own tab per sub (so #settings:billing
    // and #settings:geography are separate tabs).
    return sub ? `${view}:${sub}` : view;
}

function initialTabLabel(view) {
    return VIEWS[view]?.label || view;
}

// Views can update their own tab's label once they have a better one
// (e.g. clinic name fetched async). Used as `window.easymedSetTabLabel`
// to match the clinic-side API.
window.easymedSetTabLabel = function setTabLabel(tabId, label) {
    const t = state.tabs.find(t => t.id === tabId);
    if (!t || !label) return;
    t.label = label;
    paintTabStrip();
};

function snapshotActiveScroll() {
    const cur = state.tabs.find(t => t.id === state.activeTabId);
    if (cur) cur.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
}

function switchToTab(tabId) {
    if (state.activeTabId === tabId) return;
    snapshotActiveScroll();
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) return;
    state.activeTabId = tabId;
    state.view        = tab.view;
    state.sub         = tab.sub;
    paintShell();
    paintTabStrip();
    showOnlyActiveTab();
    requestAnimationFrame(() => window.scrollTo({ top: tab.scrollY || 0, behavior: 'instant' in window ? 'instant' : 'auto' }));
}

function showOnlyActiveTab() {
    // TAB_DOM_TRUTH_V1 — state.tabs is the source of truth for what lives in
    // #content. A stale/duplicate mount (an old tab root left behind by a
    // re-render) would otherwise linger in the DOM stuck on its "Loading…"
    // spinner while the fresh root shows the data — the "two stacked copies"
    // bug. So: drop any .view-tab-root that isn't a tracked root, and show only
    // the active tab's root.
    const content = document.getElementById('content');
    if (!content) return;
    const activeRoot = state.tabs.find(t => t.id === state.activeTabId)?.root || null;
    const tracked = new Set(state.tabs.map(t => t.root));
    for (const el of content.querySelectorAll('.view-tab-root')) {
        if (!tracked.has(el)) { el.remove(); continue; }   // orphan/duplicate — remove
        el.style.display = (el === activeRoot) ? '' : 'none';
    }
}

function reorderTab(fromId, toId) {
    if (fromId === toId) return;
    const fromIdx = state.tabs.findIndex(t => t.id === fromId);
    const toIdx   = state.tabs.findIndex(t => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = state.tabs.splice(fromIdx, 1);
    state.tabs.splice(toIdx, 0, moved);
    // Re-append DOM in the new order so display lines up with the strip.
    const content = document.getElementById('content');
    if (content) for (const t of state.tabs) content.appendChild(t.root);
    paintTabStrip();
}

// Parse the URL hash into a (view, sub) tuple. Format: #view[:sub]
function routeFromHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return { view: null, sub: null };
    const [view, sub] = raw.split(':');
    return { view: view || null, sub: sub || null };
}

// Back / forward — re-navigate without pushing another history entry.
window.addEventListener('popstate', () => {
    const { view, sub } = routeFromHash();
    if (!view) return;
    navigate(view, { sub, skipHistory: true });
});

// Browser-style keyboard shortcuts:
//   Ctrl+W            → close current tab
//   Ctrl+Tab          → next tab
//   Ctrl+Shift+Tab    → previous tab
//   Ctrl+1..9         → jump to tab N
window.addEventListener('keydown', (e) => {
    // Bail out if focus is in an input/textarea so the user can type
    // shortcuts in their fields without the shell stealing them.
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
    if (!(e.ctrlKey || e.metaKey)) return;

    if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (state.activeTabId) closeTab(state.activeTabId);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        if (state.tabs.length < 2) return;
        const i = state.tabs.findIndex(t => t.id === state.activeTabId);
        const next = e.shiftKey
            ? (i - 1 + state.tabs.length) % state.tabs.length
            : (i + 1) % state.tabs.length;
        switchToTab(state.tabs[next].id);
        return;
    }
    if (e.key >= '1' && e.key <= '9') {
        const i = parseInt(e.key, 10) - 1;
        if (i < state.tabs.length) {
            e.preventDefault();
            switchToTab(state.tabs[i].id);
        }
    }
});

// Close a tab. If the closed tab was the active one, fall back to the
// neighbour (right preferred, otherwise left). If all tabs would close,
// snap back to the dashboard so the user is never stranded.
function closeTab(tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const wasActive = state.activeTabId === tabId;
    const tab       = state.tabs[idx];
    tab.root.remove();                 // free the DOM tree
    state.tabs.splice(idx, 1);

    if (state.tabs.length === 0) {
        state.activeTabId = null;
        navigate('dashboard');
        return;
    }
    if (wasActive) {
        const neighbour = state.tabs[Math.min(idx, state.tabs.length - 1)];
        switchToTab(neighbour.id);
    } else {
        paintTabStrip();
    }
}
// Expose for any view that needs to close its own tab programmatically.
state.__closeTab = closeTab;

function refreshBadges() {
    supabase.from('clinic_signup_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .then(({ count }) => {
            state.counts['signup-requests'] = count || 0;
            paintShell();
        });
    supabase.from('companies')
        .select('id', { count: 'exact', head: true })
        .eq('verification_status', 'pending_review')
        .then(({ count }) => {
            state.counts['verifications'] = count || 0;
            paintShell();
        });
    supabase.from('upgrade_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .then(({ count }) => {
            state.counts['upgrade-requests'] = count || 0;
            paintShell();
        });
    supabase.from('payment_invoices')
        .select('id', { count: 'exact', head: true })
        .in('status', ['pending','sent'])
        .then(({ count }) => {
            state.counts['payments'] = count || 0;
            paintShell();
        });
    // Support: count tickets that have unread messages for the platform side.
    supabase.from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .gt('unread_for_platform', 0)
        .then(({ count }) => {
            state.counts['support'] = count || 0;
            paintShell();
        });
    // PUBLIC_SITE_V1 — pending Symptex publication requests live in medcore; read via the gateway.
    gw('/publish/clinics?status=requested').then(r => {
        state.counts['symptex-clinics'] = (r && r.clinics ? r.clinics.length : 0);
        paintShell();
    }).catch(() => {});
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return showLogin();
    await loadMeAndOpen();
}

async function loadMeAndOpen() {
    const { data: rows, error } = await supabase
        .from('users')
        .select('id, full_name, username, email, role, is_super_admin, platform_role, auth_user_id')
        .eq('auth_user_id', (await supabase.auth.getSession()).data.session.user.id)
        .limit(1);
    if (error || !rows || rows.length === 0) {
        return showDenied('Your account is signed in but no matching user row exists. Contact platform support.');
    }
    state.me = rows[0];
    // Allow access if EITHER classic is_super_admin (legacy path) OR the new
    // users.platform_role is non-null and recognized. Roles are enforced
    // per-section by canSeeSection() inside navigate() + paintShell().
    const hasPlatformAccess = state.me.is_super_admin
        || ['super_admin','admin','operator'].includes(state.me.platform_role);
    if (!hasPlatformAccess) {
        return showDenied('This console is for platform team members only. Sign in at your clinic\'s subdomain instead.');
    }
    paintShell();
    // Honour the URL hash on first load — if someone opens
    // setting.easymed.uz#tariffs or hits refresh on a sub-page, land
    // them there instead of bouncing to the dashboard.
    const startRoute = routeFromHash();
    if (startRoute.view) {
        navigate(startRoute.view, { sub: startRoute.sub, skipHistory: true });
    } else {
        navigate('dashboard', { skipHistory: true });
    }
    refreshBadges();
}

// ---------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------
function showLogin() {
    root.classList.remove('loading');
    root.innerHTML = `
      <div class="gate">
        <div class="gate-card">
          <div class="boot-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>
          </div>
          <h1>Platform Console</h1>
          <p>Sign in with a platform team account.</p>
          <input id="login-user" class="gate-input" placeholder="Username or email" autocomplete="username" autofocus>
          <input id="login-pass" class="gate-input" placeholder="Password" type="password" autocomplete="current-password">
          <button id="login-btn" class="gate-btn">Sign in</button>
          <div id="login-err" class="gate-err"></div>
        </div>
      </div>
    `;
    const btn  = document.getElementById('login-btn');
    const err  = document.getElementById('login-err');
    const userI = document.getElementById('login-user');
    const passI = document.getElementById('login-pass');
    const doLogin = async () => {
        err.textContent = '';
        const input    = userI.value.trim();
        const password = passI.value;
        if (!input || !password) { err.textContent = 'Enter username/email and password.'; return; }
        btn.disabled = true; btn.textContent = 'Signing in…';
        // Email-shaped inputs (platform team users created via the Add modal,
        // or clinic founders) pass through; bare usernames get the derived
        // domain so legacy staff accounts still work.
        const v = input.toLowerCase();
        const email = v.includes('@') ? v : v + '@auth.easymed.local';
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            err.textContent = error.status === 400 ? 'Wrong username or password.' : (error.message || 'Sign-in failed.');
            btn.disabled = false; btn.textContent = 'Sign in';
            return;
        }
        showBoot();
        await loadMeAndOpen();
    };
    btn.addEventListener('click', doLogin);
    passI.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    userI.addEventListener('keydown', e => { if (e.key === 'Enter') passI.focus(); });
}

function showDenied(msg) {
    root.classList.remove('loading');
    root.innerHTML = `
      <div class="gate">
        <div class="gate-card">
          <div class="boot-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>
          </div>
          <h1>Access denied</h1>
          <div class="deny-msg"></div>
          <button class="gate-btn" id="logout-btn">Sign out</button>
        </div>
      </div>
    `;
    root.querySelector('.deny-msg').textContent = msg;
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await supabase.auth.signOut();
        showLogin();
    });
}

function showBoot() {
    root.classList.add('loading');
    root.innerHTML = `
      <div class="boot-card">
        <div class="boot-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>
        </div>
        <div class="boot-title">Easy-Med Platform Console</div>
        <div class="boot-sub">Loading…</div>
      </div>
    `;
}

// ---------------------------------------------------------------------
// Shell paint
// ---------------------------------------------------------------------
function paintShell() {
    root.classList.remove('loading');

    const groups = {};
    for (const [id, v] of Object.entries(VIEWS)) {
        if (!canSeeSection(id)) continue;
        if (v.hideFromSidebar) continue;        // accessible via the Platform settings hub, just not in the sidebar
        (groups[v.group] ||= []).push({ id, ...v });
    }

    const sidebarNavHtml = Object.entries(groups).map(([group, items]) => `
        <div class="nav-section">${group}</div>
        ${items.map(item => `
            <div class="nav-item ${item.id === state.view ? 'on' : ''}" data-view="${item.id}">
                <span>${item.label}</span>
                ${state.counts[item.id] ? `<span class="nav-badge">${state.counts[item.id]}</span>` : ''}
            </div>
        `).join('')}
    `).join('');

    // INCREMENTAL UPDATE PATH — once the shell exists, only refresh the
    // sidebar nav (badges + "on" state) and the topbar title. CRITICAL:
    // do NOT touch #content, because each tab owns a DOM root inside it
    // and refreshBadges fires paintShell on every count resolve. Tab strip
    // is repainted separately by paintTabStrip() so tab handlers survive.
    const existingNav = root.querySelector('.sidebar-nav');
    if (existingNav) {
        existingNav.innerHTML = sidebarNavHtml;
        existingNav.querySelectorAll('.nav-item').forEach(el => {
            el.addEventListener('click', () => navigate(el.dataset.view));
        });
        const h1 = root.querySelector('.topbar h1');
        const sub = root.querySelector('.topbar .sub');
        if (h1)  h1.textContent  = VIEWS[state.view]?.label || '';
        if (sub) sub.textContent = `${VIEWS[state.view]?.group || ''} · setting.easymed.uz`;
        return;
    }

    // FIRST PAINT — build the whole shell. #content gets a fresh Loading
    // placeholder; navigate() replaces it shortly after.
    const meInitial = (state.me?.full_name || state.me?.username || '?')[0].toUpperCase();

    root.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="sidebar-brand">
            <div class="brand-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>
            </div>
            <div class="brand-text">
              <div class="brand-name">Easy-Med</div>
              <div class="brand-sub">Platform</div>
            </div>
          </div>
          <nav class="sidebar-nav">${sidebarNavHtml}</nav>
          <div class="sidebar-foot">
            <div class="user-card">
              <div class="av">${meInitial}</div>
              <div class="who">
                <div class="name">${esc(state.me?.full_name || state.me?.username || '—')}</div>
                <div class="role">Super admin</div>
              </div>
            </div>
            <button class="signout" id="signout-btn">Sign out</button>
          </div>
        </aside>
        <main class="main">
          <div class="tab-strip" id="tab-strip"></div>
          <header class="topbar topbar-compact">
            <div>
              <h1>${esc(VIEWS[state.view]?.label || '')}</h1>
              <div class="sub">${esc(VIEWS[state.view]?.group || '')} · setting.easymed.uz</div>
            </div>
            <div class="topbar-right"></div>
          </header>
          <div class="content" id="content"></div>
        </main>
      </div>
    `;

    root.querySelectorAll('.nav-item').forEach(el => {
        el.addEventListener('click', () => navigate(el.dataset.view));
    });
    document.getElementById('signout-btn').addEventListener('click', async () => {
        await supabase.auth.signOut();
        showLogin();
    });

    // Tab strip is populated/refreshed by paintTabStrip(). One-time wheel
    // handler converts vertical scroll into horizontal so the strip doesn't
    // fight the page when the user has many tabs open.
    const strip = document.getElementById('tab-strip');
    if (strip && !strip.dataset.wheelBound) {
        strip.dataset.wheelBound = '1';
        strip.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                strip.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    }
    paintTabStrip();
}

// ---------------------------------------------------------------------
// Tab strip painter — replaces the strip on every tab change, but never
// touches the per-tab content roots.
// ---------------------------------------------------------------------
function paintTabStrip() {
    const strip = document.getElementById('tab-strip');
    if (!strip) return;

    const tabsHtml = state.tabs.map(t => `
        <div class="tab ${t.id === state.activeTabId ? 'active' : ''}"
             data-tab-id="${esc(t.id)}"
             draggable="true"
             title="${esc(t.label)}">
          <span class="tab-label">${esc(t.label)}</span>
          <button class="tab-close" data-close-id="${esc(t.id)}" title="Close" aria-label="Close">×</button>
        </div>
    `).join('');

    strip.innerHTML = tabsHtml +
        `<button class="tab-new" id="tab-new" title="Open another section" aria-label="Open another section">+</button>`;

    // Click → switch · middle-click → close · drag → reorder
    strip.querySelectorAll('.tab[data-tab-id]').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close')) return;
            switchToTab(el.dataset.tabId);
        });
        el.addEventListener('mousedown', (e) => {
            if (e.button === 1) { e.preventDefault(); closeTab(el.dataset.tabId); }
        });
        el.addEventListener('dragstart', (e) => {
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', el.dataset.tabId);
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('drag-over');
            const fromId = e.dataTransfer.getData('text/plain');
            reorderTab(fromId, el.dataset.tabId);
        });
    });
    strip.querySelectorAll('.tab-close').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(b.dataset.closeId);
        });
    });
    const newTabBtn = document.getElementById('tab-new');
    if (newTabBtn) newTabBtn.addEventListener('click', () => navigate('dashboard'));

    const active = strip.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function toast(msg, kind = 'ok') {
    document.querySelectorAll('.toast').forEach(el => el.remove());
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.style.opacity = '0', 2500);
    setTimeout(() => t.remove(), 3000);
}

export function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function fmtRelative(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60)        return sec + 's ago';
    if (sec < 3600)      return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400)     return Math.floor(sec / 3600) + 'h ago';
    if (sec < 604800)    return Math.floor(sec / 86400) + 'd ago';
    return fmtDate(iso);
}

boot().catch(err => {
    console.error('[platform] boot failed', err);
    root.innerHTML = '<div class="gate"><div class="gate-card"><h1>Boot failed</h1><p>' + esc(err.message || err) + '</p></div></div>';
});
