// Easy-Med — clinic context (hostname → slug → companies row).
//
// The wildcard nginx server block at /etc/nginx/sites-available/easymed.uz
// routes <slug>.easymed.uz to the same docroot. This module reads the slug
// from the browser's hostname so the app knows which clinic ("company") it
// belongs to.
//
// Safe before the companies.slug column exists: loadClinicBySlug() returns
// null on any error, the rest of the app degrades to single-tenant mode.

const APEX_DOMAINS = ['easymed.uz', 'easymed.local'];
const RESERVED_SUBDOMAINS = new Set([
    'www', 'admin', 'api', 'mail', 'ftp', 'root', 'app',
    'static', 'cdn', 'assets', 'auth', 'login', 'signup',
    'setting', 'settings', 'console', 'platform', 'support',
    'docs', 'status', 'help', 'billing',
]);
const SLUG_RE = /^[a-z][a-z0-9-]{2,29}$/;

// Parse the slug out of a hostname.
// Examples:
//   demo.easymed.uz       → 'demo'
//   acme.easymed.uz       → 'acme'
//   easymed.uz            → null  (marketing apex)
//   www.easymed.uz        → null  (reserved)
//   localhost             → null  (dev)
//   192.168.1.5           → null  (raw IP)
export function parseClinicSlug(hostname) {
    if (!hostname || typeof hostname !== 'string') return null;
    const host = hostname.toLowerCase().split(':')[0];   // strip port if any
    for (const apex of APEX_DOMAINS) {
        if (host === apex) return null;
        if (host.endsWith('.' + apex)) {
            const slug = host.slice(0, host.length - apex.length - 1);
            if (!slug || slug.includes('.')) return null;  // 2nd-level only
            if (RESERVED_SUBDOMAINS.has(slug)) return null;
            if (!SLUG_RE.test(slug)) return null;
            return slug;
        }
    }
    return null;
}

// Look up the matching companies row via the SECURITY DEFINER RPC defined
// in migration 047. Returns the row or null on any error (RPC missing on
// older DBs, no match, network). Caller must tolerate null.
export async function loadClinicBySlug(supabase, slug) {
    if (!slug || !supabase) return null;
    try {
        const { data, error } = await supabase
            .rpc('get_clinic_by_slug', { p_slug: slug });
        if (error) return null;
        if (Array.isArray(data)) return data[0] || null;
        return data || null;
    } catch {
        return null;
    }
}

// Convenience: detect, load, store on globals. Called from admin boot.
// Returns { slug, clinic } — both may be null.
export async function initClinicContext(supabase) {
    const slug = parseClinicSlug(window.location.hostname);
    window.CLINIC_SLUG = slug;

    // LOCAL_SINGLE_CLINIC_V1 — the cloud identifies a clinic by subdomain, but an
    // offline install is reached by raw IP (10.4.1.82) or localhost, and
    // parseClinicSlug returns null for both BY DESIGN. The old code took that as
    // "no clinic" and parked window.CLINIC = null forever, so currentClinicId()
    // was always null and every screen gated on it loaded nothing — silently.
    // lab-settings.js was the visible casualty: it bailed before reading services,
    // and the "Нет привязки к клинике" notice it left behind was wiped by the next
    // repaint, so the screen simply looked like a clinic with no services.
    // Locally there is exactly ONE clinic and get_clinic_by_slug ignores the slug
    // (it builds the row from the doc_settings singleton), so ask for it anyway.
    const clinic = await loadClinicBySlug(supabase, slug || 'local');
    window.CLINIC = clinic;
    if (!clinic) {
        // Subdomain has no matching clinic row — common when a slug got
        // renamed in Settings → Companies. Log loud so DevTools makes it
        // obvious why downstream features (trial banner, support widget,
        // tariffs) all degrade.
        console.warn(`[clinic-context] get_clinic_by_slug returned nothing for '${slug || 'local'}'. Every screen gated on currentClinicId() will load empty — in a local install that means the RPC or doc_settings row is missing, not a subdomain problem.`);
    }
    // renderTrialBanner(clinic);   // NOTIF_CENTER_V1 — replaced by the unified notifications bell
    return { slug, clinic };
}

// CLINIC_AFTER_LOGIN_V1 — resolve the clinic once a session exists.
//
// boot() calls initClinicContext() BEFORE rehydrateUserFromSession(), because
// the login screen itself wants the clinic's name and logo. But /api/rpc sits
// behind requireAuth, so on a FIRST login that call answers 401,
// loadClinicBySlug swallows it, and window.CLINIC is parked at null for the
// whole page lifetime — nothing ever asks again.
//
// Every screen gated on currentClinicId() then degrades quietly; lab-settings
// is the one that says so out loud, and a laborant meets it right after saving
// a panel because savePanel() ends in reload().
//
// Idempotent by design: with the clinic already resolved this is a no-op, so
// boot() can call it unconditionally after login. A still-failing lookup leaves
// window.CLINIC as it was and returns null — the app degrades, it never fails
// to boot on this.
export async function ensureClinicContext(supabase) {
    if (typeof window === 'undefined') return null;
    if (window.CLINIC && window.CLINIC.id) return window.CLINIC;
    const clinic = await loadClinicBySlug(supabase, window.CLINIC_SLUG || 'local');
    if (clinic) window.CLINIC = clinic;
    return clinic || null;
}

// ---------------------------------------------------------------------
// Trial banner — top-of-page strip shown only while the clinic is on the
// 'trial' plan. Three states:
//   normal:   >3 days left  → teal "Trial — N days left"
//   warning:  ≤3 days left  → amber "Trial ends in N days"
//   expired:  trial_ends_at < now() OR is_locked → red, blocks the UI
// On the apex (no slug) and for paid plans, nothing is rendered.
// ---------------------------------------------------------------------
function injectTrialStyles() {
    if (document.getElementById('trial-banner-styles')) return;
    const s = document.createElement('style');
    s.id = 'trial-banner-styles';
    s.textContent = `
#trial-banner { position:sticky; top:0; z-index:60; display:flex; align-items:center; justify-content:center; gap:14px;
  padding:11px 18px; font-size:13.5px; font-weight:600; letter-spacing:.01em; color:#8a1414;
  background:linear-gradient(90deg,#ffe2e2,#ffd0d0); border-bottom:1px solid rgba(138,20,20,0.20);
  animation:tb-pulse-bg 1.8s ease-in-out infinite; }
#trial-banner.warn   { animation:tb-pulse-bg 1.4s ease-in-out infinite; }
#trial-banner.danger { color:#fff; background:linear-gradient(90deg,#d23b3b,#bf2626); border-bottom-color:rgba(0,0,0,0.14);
  animation:tb-pulse-danger-bg 1.05s ease-in-out infinite; }
@keyframes tb-pulse-bg        { 0%,100% { background:linear-gradient(90deg,#ffe2e2,#ffd0d0); } 50% { background:linear-gradient(90deg,#ffc9c9,#ffadad); } }
@keyframes tb-pulse-danger-bg { 0%,100% { background:linear-gradient(90deg,#d23b3b,#bf2626); } 50% { background:linear-gradient(90deg,#e85a5a,#d83838); } }
#trial-banner .tb-msg { display:inline-flex; align-items:center; gap:8px; }
#trial-banner .tb-pill { padding:2px 11px; border-radius:999px; background:rgba(255,255,255,0.82);
  font-variant-numeric:tabular-nums; font-weight:700; }
#trial-banner.danger .tb-pill { background:rgba(255,255,255,0.92); color:#bf2626; }
#trial-banner .tb-quiet { color:#8a1414cc; font-weight:500; font-size:12.5px; }
#trial-banner.danger .tb-quiet { color:#ffffffdd; }
#trial-banner button.tb-cta { text-decoration:none; padding:8px 18px; border-radius:9px;
  background:#0d1e2c; color:white; border:none; cursor:pointer; white-space:nowrap;
  font-weight:700; font-family:inherit; transition:transform .08s, box-shadow .15s; font-size:13.5px; letter-spacing:.02em;
  display:inline-flex; align-items:center; gap:6px; animation:tb-cta-pulse 1.8s ease-in-out infinite; }
#trial-banner button.tb-cta:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(13,30,44,0.22); }
#trial-banner button.tb-cta::after { content:'→'; opacity:.7; transition:transform .15s; }
#trial-banner button.tb-cta:hover::after { transform:translateX(2px); opacity:1; }
#trial-banner.danger button.tb-cta { background:#7a1010; animation:tb-cta-pulse-d 1.05s ease-in-out infinite; }
@keyframes tb-cta-pulse   { 0%,100% { box-shadow:0 0 0 0 rgba(191,38,38,0.5); }  50% { box-shadow:0 0 0 7px rgba(191,38,38,0); } }
@keyframes tb-cta-pulse-d { 0%,100% { box-shadow:0 0 0 0 rgba(122,16,16,0.6); }  50% { box-shadow:0 0 0 9px rgba(122,16,16,0); } }
/* keep the panel chrome BELOW the banner so it never covers the sidebar / topbar */
body.has-trial-banner .sidebar { top:var(--tb-h,44px); height:calc(100vh - var(--tb-h,44px)); }
body.has-trial-banner .topbar  { top:var(--tb-h,44px); }
body.has-trial-banner .content { min-height:calc(100vh - var(--topbar-h) - var(--tb-h,44px)); }
`;
    document.head.appendChild(s);
}

function daysBetween(future) {
    const ms = new Date(future).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
}

export function renderTrialBanner(clinic) {
    // Remove any existing banner first so language/state changes re-render.
    document.getElementById('trial-banner')?.remove();
    if (!clinic) return;
    if (clinic.plan !== 'trial') return;          // paid plans = no banner
    if (!clinic.trial_ends_at) return;            // unknown trial state
    injectTrialStyles();
    const isExpired = !!clinic.is_locked || (new Date(clinic.trial_ends_at).getTime() < Date.now());
    const days = daysBetween(clinic.trial_ends_at);
    const isWarn = !isExpired && days <= 3;

    const banner = document.createElement('div');
    banner.id = 'trial-banner';
    if (isExpired)   banner.classList.add('danger');
    else if (isWarn) banner.classList.add('warn');

    // ----- left: status pill + quiet sub-line (Loss Aversion framing) -----
    const msg = document.createElement('span');
    msg.className = 'tb-msg';

    const pill = document.createElement('span');
    pill.className = 'tb-pill';
    pill.textContent = isExpired
        ? 'Trial expired'
        : (days === 0
            ? 'Trial ends today'
            : `${days} day${days === 1 ? '' : 's'} left`);
    msg.appendChild(pill);

    const quiet = document.createElement('span');
    quiet.className = 'tb-quiet';
    quiet.textContent = isExpired
        ? 'Writes are paused — data is read-only'
        : (isWarn ? 'Lock in a plan before write access pauses' : 'Pick a plan to keep your data writeable');
    msg.appendChild(quiet);
    banner.appendChild(msg);

    // ----- right: CTA button (Activation Energy → modal) -----
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'tb-cta';
    cta.textContent = isExpired ? 'Restore access' : 'Lock in plan';
    cta.addEventListener('click', () => {
        // Lazy-load — the trial banner ships small; modal loads on demand.
        import('./upgrade-modal.js').then(m => m.openUpgradeModal()).catch(err => {
            console.error('[trial-banner] failed to open upgrade modal', err);
            // Fallback so the user is never stranded.
            window.location.href = 'mailto:hello@easymed.uz?subject=Upgrade%20my%20clinic%20-%20' + encodeURIComponent(clinic.slug || '');
        });
    });
    banner.appendChild(cta);

    // Mount above .app so it sits at the very top.
    const root = document.querySelector('.app') || document.body.firstChild;
    document.body.insertBefore(banner, root);
    document.body.classList.add('has-trial-banner');
    document.documentElement.style.setProperty('--tb-h', banner.offsetHeight + 'px');
}
