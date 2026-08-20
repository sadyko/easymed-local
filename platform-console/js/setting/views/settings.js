// Platform → Settings. Platform-wide knobs persisted in a tiny
// public.platform_settings key/value table (created on first save).
//
// Pass 1 redesign — cognitive-load fixes only, no new functionality:
//   * Status banner up top — what's actually on, what's at stake, real counts.
//   * Per-field "default / custom" chip with one-click "Reset to default"
//     so the user always knows whether they're on the recommended setting,
//     and can revert without scrolling. Removes the "✓ Recommended" badge
//     spam from every label (signal noise → real signal).
//   * Sticky save bar shows the DIFF — exactly which fields changed,
//     before → after — so the user closes the Zeigarnik loop before
//     committing, and the "Save" button name carries the count.
//   * Toggle widened so the on-state label ("New clinics can sign up")
//     stops getting cropped at 92px.
//   * Help text rewritten in cause-and-effect frames: not "what the field
//     means" but "what happens if you flip it" — Loss Aversion working
//     for the user, not the system.

import { esc, toast } from '../../setting.js';

const DEFAULTS = {
    trial_days:    7,
    default_plan:  'trial',
    signup_open:   true,
    contact_email: 'hello@easymed.uz',
    apex_domain:   'easymed.uz',
};

// Three groups so the page reads as three decisions, not five.
const GROUPS = [
    {
        title: 'Signup & access',
        sub:   'Who can join the platform and on what plan.',
        fields: [
            {
                key: 'signup_open', type: 'toggle',
                label: 'Public signup enabled',
                help: 'OFF blocks the landing-page wizard from accepting new clinics. Existing clinics are unaffected — they keep signing in normally.',
                onLabel:  'Accepting new clinics',
                offLabel: 'Signups paused',
                impact: 'high',
            },
            {
                key: 'trial_days', type: 'number', min: 1, max: 90,
                label: 'Trial length (days)',
                help: 'After this many days a new clinic must pick a paid plan, or their database write-locks (reads keep working).',
            },
            {
                key: 'default_plan', type: 'select',
                label: 'Default plan on signup',
                options: ['trial', 'starter', 'growth', 'enterprise'],
                help: 'Almost every new clinic should land on Trial. Pick a paid plan here only when you\'re comping a specific clinic (no trial gate).',
            },
        ],
    },
    {
        title: 'Domain',
        sub:   'The apex domain new clinic subdomains are built under.',
        fields: [
            {
                key: 'apex_domain', type: 'text',
                label: 'Apex domain',
                help: 'A new clinic named "medion" will live at the URL below.',
                preview: true,
            },
        ],
    },
    {
        title: 'Support',
        sub:   'How clinics reach you when something breaks.',
        fields: [
            {
                key: 'contact_email', type: 'email',
                label: 'Support contact email',
                help: 'Shown on the trial-expired banner that staff see when their clinic\'s write-lock kicks in.',
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// State captured per mount so paintSaveBar / paintFieldStatus can read it
// from anywhere without prop-drilling through every handler.
// ---------------------------------------------------------------------------
const ui = {
    initial:    {},   // values at last save (or defaults if first load)
    lastSavedISO: null,
    counts:     {},
    supabase:   null,
};

// ---------------------------------------------------------------------------

// Inline SVG icons (Lucide-style, 18×18, stroke=currentColor). Reused
// inside the colored chip on each hub card. Single-stroke, no fills —
// they pick up the chip's accent color from CSS.
const ICON_SVG = {
    globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="4"/><path d="M12 3v18M3 12h18"/></svg>`,
    flask: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M9 3v6.5L4 18a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 18l-5-8.5V3"/><path d="M7 3h10"/><path d="M7 14h10"/></svg>`,
    card:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 11h20"/><path d="M6 15h4"/></svg>`,
    sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 7h12M8 12h12M4 17h10"/><circle cx="17" cy="7" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="15" cy="17" r="2"/></svg>`,
};

// Hub sections — every nav item that used to sit at the bottom of the
// sidebar (Geography / Services / Billing / Operations) now lives inside
// this page as a clickable card grid. Sidebar shrinks to the essentials.
const HUB_SECTIONS = [
    { group: 'Geography', color: '#06b6d4', icon: ICON_SVG.globe, items: [
        { id: 'countries',        label: 'Countries',         desc: 'Country list shared by every clinic' },
        { id: 'regions',          label: 'Regions',           desc: 'Regions / states, parented to a country' },
        { id: 'districts',        label: 'Districts',         desc: 'Districts / cities, parented to a region' },
    ]},
    { group: 'Services', color: '#a855f7', icon: ICON_SVG.flask, items: [
        { id: 'service-catalog',  label: 'Services catalog',  desc: 'Master service catalogue shared across clinics' },
        { id: 'service-requests', label: 'Service requests',  desc: 'Clinic requests to add a service to the catalogue' },
    ]},
    { group: 'Billing', color: '#16a34a', icon: ICON_SVG.card, items: [
        { id: 'payments',         label: 'Payments',          desc: 'Invoices issued to clinics — paid, sent, overdue' },
        { id: 'tariffs',          label: 'Tariffs',           desc: 'Paid-plan tariffs and feature gates' },
    ]},
    { group: 'Operations', color: '#0284c7', icon: ICON_SVG.sliders, items: [
        { id: 'audit',            label: 'Audit log',         desc: 'Every admin action against the platform DB' },
        { id: 'platform-team',    label: 'Platform team',     desc: 'Internal staff with platform-console access' },
    ]},
];

export async function renderSettings(root, { supabase, navigate }) {
    ui.supabase = supabase;
    ui.navigate = navigate;

    if (!document.getElementById('ps-styles')) {
        document.head.appendChild(Object.assign(document.createElement('style'), {
            id: 'ps-styles',
            textContent: PAGE_CSS,
        }));
    }

    root.innerHTML = `
      <div class="ps-hub">
        <div class="ps-hub-head">
          <div>
            <h2>Platform settings</h2>
            <p class="ps-hub-sub">Browse every cross-clinic configuration area. Each card opens a full editor.</p>
          </div>
          <div class="ps-hub-search-wrap">
            <input id="ps-hub-search" class="ps-hub-search" placeholder="Search settings…">
          </div>
        </div>
        <div class="ps-hub-grid" id="ps-hub-grid">
          ${HUB_SECTIONS.map(renderHubCard).join('')}
        </div>
      </div>

      <div id="ps-status" class="ps-status">
        <div class="ps-status-loading">Loading current platform state…</div>
      </div>

      <div class="card ps-card">
        <div class="ps-card-head">
          <h2>Platform configuration</h2>
          <button type="button" class="ps-info-toggle" id="ps-info-toggle" title="Where is this stored?">i</button>
        </div>
        <p class="ps-card-sub">Settings here apply to every clinic on the platform.</p>
        <div class="ps-info" id="ps-info" hidden>
          Stored in <code>public.platform_settings</code>. Each row is a single
          <code>(key, value)</code> pair, upserted on save.
        </div>

        <form id="ps-form" class="ps-form"></form>

        <div class="modal-err" id="ps-err"></div>
      </div>

      <div class="card">
        <h2>System</h2>
        <table class="t" style="min-width:0">
          <tbody>
            <tr><td>App version</td><td class="muted">Easy-Med · v1.0 (multi-tenant)</td></tr>
            <tr><td>Signup wizard URL</td><td><a href="https://easymed.uz/" target="_blank">https://easymed.uz/</a></td></tr>
            <tr><td>Platform console URL</td><td><a href="https://setting.easymed.uz/" target="_blank">https://setting.easymed.uz/</a></td></tr>
            <tr><td>Reserved subdomains</td><td class="muted">www, admin, api, mail, ftp, root, app, static, cdn, assets, auth, login, signup, setting, settings, console, platform, support, docs, status, help, billing</td></tr>
          </tbody>
        </table>
      </div>

      <div class="ps-savebar" id="ps-savebar">
        <div class="ps-savebar-status" id="ps-saved-at">Loading…</div>
        <div class="ps-savebar-actions" id="ps-savebar-actions"></div>
      </div>
    `;

    const form = root.querySelector('#ps-form');
    form.innerHTML = GROUPS.map(renderGroup).join('');

    // Wire the new hub-grid card clicks + live search. Cheap and synchronous,
    // so it runs before the async DB calls below — the user can navigate to
    // a sub-section immediately, even before configuration values land.
    wireHubInteractions(root);

    // Load values + clinic counts in parallel.
    const [stored, counts] = await Promise.all([loadAll(supabase), loadCounts(supabase)]);
    const merged = { ...DEFAULTS, ...stored };
    ui.counts = counts;
    ui.lastSavedISO = stored.__last_saved_at || null;

    for (const g of GROUPS) for (const f of g.fields) writeField(f, merged[f.key]);
    paintStatus(merged, counts);
    refreshDomainPreview(merged.apex_domain);

    // Snapshot what we loaded — this is the "saved" baseline the save-bar
    // diff is computed against. Updated again on every successful save.
    snapshotInitial();

    // Wire change listeners on every input so the per-field "custom" chip
    // and the save-bar diff stay in sync as the user types/clicks.
    for (const g of GROUPS) {
        for (const f of g.fields) wireFieldEvents(f, merged);
        for (const f of g.fields) paintFieldStatus(f);
    }
    paintSaveBar();

    // Apex preview tracks edits live.
    const apexInp = document.getElementById('ps-apex_domain');
    if (apexInp) apexInp.addEventListener('input', () => refreshDomainPreview(apexInp.value));

    // Status banner updates live when the signup toggle flips.
    const signupTog = document.querySelector('[data-toggle-key="signup_open"]');
    signupTog?.addEventListener('click', () => {
        paintStatus({ ...merged, ...readAll() }, counts);
    });

    // Developer info disclosure.
    root.querySelector('#ps-info-toggle').addEventListener('click', () => {
        const el = root.querySelector('#ps-info');
        el.hidden = !el.hidden;
    });
}

// ---------------------------------------------------------------------------
// Event wiring per field — handles all input types and routes to the same
// post-change refresh path (chip + save-bar + side effects).
// ---------------------------------------------------------------------------

function wireFieldEvents(f, merged) {
    const el = document.getElementById('ps-' + f.key);
    if (!el) return;

    const after = () => {
        paintFieldStatus(f);
        paintSaveBar();
        if (f.key === 'apex_domain') refreshDomainPreview(el.value);
    };

    if (f.type === 'toggle') {
        const handler = () => { toggleBool(el, f); after(); paintStatus({ ...merged, ...readAll() }, ui.counts); };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', e => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handler(); }
        });
    } else {
        const ev = (f.type === 'select') ? 'change' : 'input';
        el.addEventListener(ev, after);
    }

    // Per-field "Reset to default" link (rendered hidden until the field
    // differs from the default).
    const resetBtn = document.getElementById('ps-reset-' + f.key);
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            writeField(f, DEFAULTS[f.key]);
            after();
            if (f.key === 'signup_open') paintStatus({ ...merged, ...readAll() }, ui.counts);
        });
    }
}

// ---------------------------------------------------------------------------
// RENDERERS
// ---------------------------------------------------------------------------
// Hub card renderer — used by the grid at the top of the Settings page.
// ---------------------------------------------------------------------------
function renderHubCard(g) {
    const count = g.items.length;
    return `
      <section class="ps-hub-card">
        <header class="ps-hub-card-head">
          <div class="ps-hub-card-icon" style="background:${g.color}22;color:${g.color}">${g.icon}</div>
          <div>
            <div class="ps-hub-card-title">${esc(g.group)}</div>
            <div class="ps-hub-card-count">${count} section${count === 1 ? '' : 's'}</div>
          </div>
        </header>
        <div class="ps-hub-card-body">
          ${g.items.map(it => `
            <button class="ps-hub-row" data-view="${esc(it.id)}" data-search="${esc((it.label + ' ' + it.desc).toLowerCase())}">
              <div class="ps-hub-row-text">
                <div class="ps-hub-row-label">${esc(it.label)}</div>
                <div class="ps-hub-row-desc">${esc(it.desc)}</div>
              </div>
              <span class="ps-hub-row-chev">›</span>
            </button>
          `).join('')}
        </div>
      </section>
    `;
}

function wireHubInteractions(root) {
    // Row click → navigate to that view (sub-section). The console's
    // browser-style tab strip handles "tab persistence" for us — every
    // click adds a tab at the top of the console.
    root.querySelectorAll('.ps-hub-row').forEach(b => {
        b.addEventListener('click', () => ui.navigate && ui.navigate(b.dataset.view));
    });

    // Live search across labels + descriptions; empty cards collapse.
    const inp = root.querySelector('#ps-hub-search');
    if (!inp) return;
    inp.addEventListener('input', () => {
        const term = inp.value.trim().toLowerCase();
        root.querySelectorAll('.ps-hub-card').forEach(card => {
            let visible = 0;
            card.querySelectorAll('.ps-hub-row').forEach(row => {
                const hay = row.dataset.search || '';
                const ok = !term || hay.includes(term);
                row.style.display = ok ? '' : 'none';
                if (ok) visible++;
            });
            card.style.display = visible === 0 ? 'none' : '';
        });
    });
}

function renderGroup(g) {
    return `
      <section class="ps-group">
        <header class="ps-group-head">
          <h3>${esc(g.title)}</h3>
          <p>${esc(g.sub)}</p>
        </header>
        <div class="ps-group-body">
          ${g.fields.map(renderField).join('')}
        </div>
      </section>
    `;
}

function renderField(f) {
    const help = f.help ? `<div class="ps-help">${esc(f.help)}</div>` : '';

    // Dynamic chip + reset link — populated by paintFieldStatus on every
    // change. Always rendered (empty); just hidden via CSS when not needed.
    const chip = `<span class="ps-status-chip" id="ps-chip-${f.key}" hidden></span>`;
    const resetLink = `<button type="button" class="ps-field-reset" id="ps-reset-${f.key}" hidden>↺ default</button>`;

    if (f.type === 'toggle') {
        return `
          <div class="ps-field ps-field-toggle ${f.impact === 'high' ? 'ps-field-high' : ''}">
            <div class="ps-field-text">
              <div class="ps-label-row">
                <label>${esc(f.label)}</label>
                ${chip}
                ${resetLink}
              </div>
              ${help}
            </div>
            <div class="ps-toggle" id="ps-${f.key}" data-toggle-key="${f.key}" data-value="false" role="switch" tabindex="0">
              <span class="ps-toggle-track"><span class="ps-toggle-thumb"></span></span>
              <span class="ps-toggle-state"></span>
            </div>
          </div>
        `;
    }

    if (f.type === 'select') {
        const opts = f.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        return `
          <div class="ps-field">
            <div class="ps-label-row">
              <label for="ps-${f.key}">${esc(f.label)}</label>
              ${chip}
              ${resetLink}
            </div>
            <select class="ps-input" id="ps-${f.key}">${opts}</select>
            ${help}
          </div>
        `;
    }

    if (f.type === 'number') {
        return `
          <div class="ps-field">
            <div class="ps-label-row">
              <label for="ps-${f.key}">${esc(f.label)}</label>
              ${chip}
              ${resetLink}
            </div>
            <input class="ps-input ps-input-narrow" id="ps-${f.key}" type="number"
                   ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}>
            ${help}
          </div>
        `;
    }

    const previewEl = f.preview
        ? `<div class="ps-preview" id="ps-preview-${f.key}">medion.<span class="ps-preview-apex"></span></div>`
        : '';
    return `
      <div class="ps-field">
        <div class="ps-label-row">
          <label for="ps-${f.key}">${esc(f.label)}</label>
          ${chip}
          ${resetLink}
        </div>
        <input class="ps-input" id="ps-${f.key}" type="${f.type === 'email' ? 'email' : 'text'}">
        ${previewEl}
        ${help}
      </div>
    `;
}

// ---------------------------------------------------------------------------
// Field read/write
// ---------------------------------------------------------------------------

function readField(f) {
    const el = document.getElementById('ps-' + f.key);
    if (!el) return null;
    if (f.type === 'toggle') return el.dataset.value === 'true';
    if (f.type === 'number') return el.value === '' ? '' : Number(el.value);
    return el.value;
}

function writeField(f, v) {
    const el = document.getElementById('ps-' + f.key);
    if (!el) return;
    if (f.type === 'toggle') {
        el.dataset.value = String(!!v);
        el.classList.toggle('on', !!v);
        const state = el.querySelector('.ps-toggle-state');
        if (state) state.textContent = (!!v) ? (f.onLabel || 'On') : (f.offLabel || 'Off');
    } else {
        el.value = v ?? '';
    }
}

function toggleBool(el, f) {
    const next = el.dataset.value !== 'true';
    el.dataset.value = String(next);
    el.classList.toggle('on', next);
    const state = el.querySelector('.ps-toggle-state');
    if (state) state.textContent = next ? (f.onLabel || 'On') : (f.offLabel || 'Off');
}

function readAll() {
    const out = {};
    for (const g of GROUPS) for (const f of g.fields) out[f.key] = readField(f);
    return out;
}

// ---------------------------------------------------------------------------
// Default / custom chip + per-field reset visibility
// ---------------------------------------------------------------------------

function paintFieldStatus(f) {
    const chip = document.getElementById('ps-chip-' + f.key);
    const reset = document.getElementById('ps-reset-' + f.key);
    if (!chip || !reset) return;

    const cur = readField(f);
    const def = DEFAULTS[f.key];
    const isDefault = (cur === def) || (cur == null && def == null);

    if (isDefault) {
        chip.textContent = '✓ default';
        chip.className = 'ps-status-chip is-default';
        chip.hidden = false;
        reset.hidden = true;
    } else {
        chip.textContent = 'custom';
        chip.className = 'ps-status-chip is-custom';
        chip.hidden = false;
        reset.hidden = false;
    }
}

// ---------------------------------------------------------------------------
// Save bar — diff before commit
// ---------------------------------------------------------------------------

function snapshotInitial() {
    ui.initial = readAll();
}

function currentDiff() {
    const out = [];
    const cur = readAll();
    for (const g of GROUPS) for (const f of g.fields) {
        const a = ui.initial[f.key];
        const b = cur[f.key];
        if (!sameValue(a, b)) out.push({ field: f, before: a, after: b });
    }
    return out;
}

function sameValue(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    return String(a) === String(b);
}

function displayValue(f, v) {
    if (f.type === 'toggle') return v ? 'ON' : 'OFF';
    if (v === '' || v == null) return '(empty)';
    return String(v);
}

function paintSaveBar() {
    const statusEl  = document.getElementById('ps-saved-at');
    const actionsEl = document.getElementById('ps-savebar-actions');
    if (!statusEl || !actionsEl) return;

    const diff = currentDiff();

    if (diff.length === 0) {
        statusEl.innerHTML = `<span class="ps-saved-label">${ui.lastSavedISO ? 'Last saved ' + relativeTime(ui.lastSavedISO) : 'No changes yet'}</span>`;
        actionsEl.innerHTML = `
          <button type="button" class="btn" id="ps-reset-all">Reset to defaults</button>
          <button type="button" class="btn primary" id="ps-save" disabled>Save</button>
        `;
        wireSaveBarHandlers();
        return;
    }

    const list = diff.slice(0, 4).map(c => `
        <li>
            <span class="ps-diff-label">${esc(c.field.label)}</span>
            <span class="ps-diff-before">${esc(displayValue(c.field, c.before))}</span>
            <span class="ps-diff-arrow">→</span>
            <span class="ps-diff-after">${esc(displayValue(c.field, c.after))}</span>
            ${c.field.impact === 'high' ? '<span class="ps-diff-warn" title="High-impact change">⚠</span>' : ''}
        </li>
    `).join('');
    const more = diff.length > 4 ? `<li class="ps-diff-more">+ ${diff.length - 4} more</li>` : '';

    statusEl.innerHTML = `
      <div class="ps-diff-count">${diff.length} unsaved change${diff.length === 1 ? '' : 's'}</div>
      <ul class="ps-diff-list">${list}${more}</ul>
    `;
    actionsEl.innerHTML = `
      <button type="button" class="btn" id="ps-discard">Discard changes</button>
      <button type="button" class="btn primary" id="ps-save">Save ${diff.length} change${diff.length === 1 ? '' : 's'}</button>
    `;
    wireSaveBarHandlers();
}

function wireSaveBarHandlers() {
    document.getElementById('ps-save')?.addEventListener('click', onSave);
    document.getElementById('ps-discard')?.addEventListener('click', onDiscard);
    document.getElementById('ps-reset-all')?.addEventListener('click', onResetToDefaults);
}

async function onSave() {
    const errEl = document.getElementById('ps-err');
    if (errEl) errEl.textContent = '';
    const patch = readAll();
    const ok = await saveAll(ui.supabase, patch, errEl);
    if (ok) {
        toast('Settings saved.', 'ok');
        ui.lastSavedISO = new Date().toISOString();
        snapshotInitial();
        for (const g of GROUPS) for (const f of g.fields) paintFieldStatus(f);
        paintSaveBar();
    }
}

function onDiscard() {
    // Restore to the last saved snapshot — different from "Reset to defaults",
    // which throws away your saved customisations too.
    for (const g of GROUPS) for (const f of g.fields) writeField(f, ui.initial[f.key]);
    for (const g of GROUPS) for (const f of g.fields) paintFieldStatus(f);
    refreshDomainPreview(ui.initial.apex_domain);
    paintStatus({ ...ui.initial }, ui.counts);
    paintSaveBar();
}

function onResetToDefaults() {
    if (!confirm('Reset every setting to its default? (You can still review the diff and Discard before saving.)')) return;
    for (const g of GROUPS) for (const f of g.fields) writeField(f, DEFAULTS[f.key]);
    for (const g of GROUPS) for (const f of g.fields) paintFieldStatus(f);
    refreshDomainPreview(DEFAULTS.apex_domain);
    paintStatus({ ...DEFAULTS }, ui.counts);
    paintSaveBar();
}

// ---------------------------------------------------------------------------
// Status banner + URL preview + last-saved label
// ---------------------------------------------------------------------------

function paintStatus(settings, counts) {
    const root = document.getElementById('ps-status');
    if (!root) return;
    const on    = !!settings.signup_open;
    const apex  = settings.apex_domain || 'easymed.uz';
    const trial = counts?.trial  ?? '—';
    const paying = counts?.paying ?? '—';

    root.innerHTML = `
      <div class="ps-status-row">
        <div class="ps-status-block">
          <div class="ps-status-dot ${on ? 'ok' : 'off'}"></div>
          <div>
            <div class="ps-status-title">Public signup: <b>${on ? 'ON' : 'OFF'}</b></div>
            <div class="ps-status-sub">${on ? `Accepting new clinics at <code>${esc(apex)}</code>` : 'Landing-page wizard is refusing new signups'}</div>
          </div>
        </div>
        <div class="ps-status-block">
          <div class="ps-stat"><span class="ps-stat-num">${trial}</span><span class="ps-stat-label">on trial</span></div>
          <div class="ps-stat"><span class="ps-stat-num">${paying}</span><span class="ps-stat-label">paying</span></div>
        </div>
      </div>
    `;
}

function refreshDomainPreview(apex) {
    const apexSpan = document.querySelector('#ps-preview-apex_domain .ps-preview-apex');
    if (apexSpan) apexSpan.textContent = (apex || 'easymed.uz').trim();
}

function relativeTime(iso) {
    const d = new Date(iso); if (isNaN(d.getTime())) return 'just now';
    const sec = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60)       return sec + 's ago';
    if (sec < 3600)     return Math.floor(sec / 60) + ' min ago';
    if (sec < 86400)    return Math.floor(sec / 3600) + ' h ago';
    return d.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

async function loadAll(supabase) {
    const out = {};
    const exists = await probe(supabase);
    if (!exists) return out;
    const { data } = await supabase.from('platform_settings').select('key, value, updated_at');
    let newest = null;
    for (const r of (data || [])) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
        if (r.updated_at && (!newest || r.updated_at > newest)) newest = r.updated_at;
    }
    if (newest) out.__last_saved_at = newest;
    return out;
}

async function loadCounts(supabase) {
    try {
        const [{ count: trial }, { count: paying }] = await Promise.all([
            supabase.from('companies').select('id', { count: 'exact', head: true }).eq('plan', 'trial'),
            supabase.from('companies').select('id', { count: 'exact', head: true }).in('plan', ['starter','growth','enterprise']),
        ]);
        return { trial: trial ?? 0, paying: paying ?? 0 };
    } catch {
        return { trial: null, paying: null };
    }
}

async function saveAll(supabase, patch, errEl) {
    const rows = Object.entries(patch).map(([k, v]) => ({ key: k, value: JSON.stringify(v) }));
    const exists = await probe(supabase);
    if (!exists) {
        if (errEl) errEl.textContent = 'platform_settings table not provisioned yet — apply the bootstrap SQL shown in the docs first.';
        return false;
    }
    const { error } = await supabase.from('platform_settings').upsert(rows, { onConflict: 'key' });
    if (error) { if (errEl) errEl.textContent = error.message; return false; }
    return true;
}

async function probe(supabase) {
    const { error } = await supabase.from('platform_settings').select('key', { head: true, count: 'exact' }).limit(1);
    return !error;
}

// ---------------------------------------------------------------------------
// Scoped CSS — injected once on first render.
// ---------------------------------------------------------------------------

const PAGE_CSS = `
/* ---- Hub grid (Geography / Services / Billing / Operations) ---- */
.ps-hub { margin-bottom: 22px; }
.ps-hub-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.ps-hub-head h2 { margin: 0; font-size: 16px; font-weight: 700; color: var(--ink); }
.ps-hub-sub  { margin: 4px 0 0; font-size: 12.5px; color: var(--ink-3); }
.ps-hub-search-wrap { position: relative; }
.ps-hub-search {
    height: 34px; padding: 0 12px;
    background: var(--bg-3); border: 1px solid var(--line); border-radius: 8px;
    color: var(--ink); font-size: 12.5px; font-family: inherit; outline: none;
    min-width: 240px;
}
.ps-hub-search:focus { border-color: var(--teal); box-shadow: 0 0 0 3px rgba(25,181,156,0.18); }

.ps-hub-grid { display: grid; gap: 14px; grid-template-columns: repeat(2, 1fr); align-items: stretch; }
@media (max-width: 1100px) { .ps-hub-grid { grid-template-columns: 1fr; } }

.ps-hub-card { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.ps-hub-card-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.ps-hub-card-icon { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 17px; line-height: 1; flex: 0 0 34px; }
.ps-hub-card-title { font-size: 13px; font-weight: 700; color: var(--ink); }
.ps-hub-card-count { font-size: 11px; color: var(--ink-3); margin-top: 1px; }
.ps-hub-card-body { padding: 4px 6px 6px; display: flex; flex-direction: column; }

.ps-hub-row {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 10px 10px;
    border: 0; border-radius: 8px; background: transparent;
    color: var(--ink); font-family: inherit; text-align: left;
    cursor: pointer; transition: background-color 120ms ease;
}
.ps-hub-row:hover { background: var(--bg-3); }
.ps-hub-row-text  { flex: 1; min-width: 0; }
.ps-hub-row-label { font-size: 12.5px; font-weight: 600; color: var(--ink); }
.ps-hub-row-desc  { font-size: 11px; color: var(--ink-3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-hub-row-chev  { color: var(--ink-3); font-size: 17px; line-height: 1; flex: 0 0 14px; }

.ps-status { margin-bottom: 18px; }
.ps-status-row { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; gap: 24px; justify-content: space-between; }
.ps-status-loading { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; color: var(--ink-3); font-size: 13px; }
.ps-status-block { display: flex; align-items: center; gap: 16px; }
.ps-status-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
.ps-status-dot.ok  { background: var(--green); box-shadow: 0 0 0 4px rgba(31,181,116,0.15); }
.ps-status-dot.off { background: var(--red);   box-shadow: 0 0 0 4px rgba(215,80,80,0.15); }
.ps-status-title { font-size: 14px; font-weight: 600; color: var(--ink); }
.ps-status-title b { font-weight: 800; }
.ps-status-sub { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
.ps-status-sub code { background: var(--bg-3); padding: 1px 6px; border-radius: 4px; font-size: 11.5px; }
.ps-stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; }
.ps-stat-num { font-size: 20px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.ps-stat-label { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }

.ps-card { padding: 22px 26px; }
.ps-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.ps-card-head h2 { margin: 0; }
.ps-card-sub { color: var(--ink-3); font-size: 12.5px; margin: 0 0 18px; }
.ps-info-toggle { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line); background: var(--bg-3); color: var(--ink-3); font-size: 11px; font-weight: 700; cursor: pointer; display: grid; place-items: center; font-style: italic; }
.ps-info-toggle:hover { color: var(--ink); border-color: var(--teal); }
.ps-info { background: var(--bg-3); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: var(--ink-3); margin-bottom: 16px; }
.ps-info code { color: var(--teal); }

.ps-form { display: flex; flex-direction: column; gap: 22px; }

.ps-group-head { margin-bottom: 12px; }
.ps-group-head h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); font-weight: 700; margin: 0; }
.ps-group-head p { font-size: 12.5px; color: var(--ink-3); margin: 4px 0 0; }
.ps-group-body { display: flex; flex-direction: column; gap: 14px; padding-top: 6px; border-top: 1px solid var(--line); }

.ps-field { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; }
.ps-field-toggle { flex-direction: row; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg-3); }
.ps-field-toggle.ps-field-high { border-color: var(--line-2); }
.ps-field-text { flex: 1; min-width: 0; }

.ps-label-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ps-field label { font-size: 13px; font-weight: 600; color: var(--ink); }
.ps-help { font-size: 12px; color: var(--ink-3); margin-top: 2px; line-height: 1.45; }

/* Dynamic field-status indicator: shows "default" when the value matches
   DEFAULTS, "custom" when it differs. Replaces the old static "Recommended"
   badge that fired on every field regardless of state. */
.ps-status-chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em; border: 1px solid transparent; }
.ps-status-chip.is-default { background: rgba(25,181,156,0.10); color: var(--teal); border-color: rgba(25,181,156,0.25); }
.ps-status-chip.is-custom  { background: rgba(225,180,40,0.10); color: #d6a51c; border-color: rgba(225,180,40,0.25); }

.ps-field-reset { background: transparent; border: 0; padding: 2px 6px; font-size: 11px; color: var(--ink-3); cursor: pointer; border-radius: 4px; }
.ps-field-reset:hover { color: var(--teal); background: rgba(25,181,156,0.08); }

.ps-input { width: 100%; padding: 9px 12px; background: var(--bg-3); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; font-family: inherit; font-size: 13px; outline: none; transition: border-color .12s, box-shadow .12s; }
.ps-input:focus { border-color: var(--teal); box-shadow: 0 0 0 3px rgba(25,181,156,0.18); }
.ps-input-narrow { max-width: 140px; }

.ps-preview { margin-top: 6px; font-size: 12.5px; color: var(--ink-2); background: var(--bg-3); border: 1px dashed var(--line-2); border-radius: 8px; padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ps-preview-apex { color: var(--teal); }

/* Toggle: was fixed 92px which cropped the on-state label "New clinics can
   sign up". Now auto-sizes around its content with a sensible min. */
.ps-toggle { min-width: 92px; min-height: 38px; display: inline-flex; align-items: center; gap: 10px; padding: 0 14px 0 4px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px; cursor: pointer; user-select: none; transition: background .15s, border-color .15s; flex: 0 0 auto; }
.ps-toggle .ps-toggle-track { position: relative; width: 38px; height: 22px; background: var(--bg); border-radius: 999px; flex: 0 0 auto; transition: background .15s; }
.ps-toggle .ps-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--ink-3); transition: left .15s, background .15s; }
.ps-toggle .ps-toggle-state { font-size: 11px; color: var(--ink-3); font-weight: 600; white-space: nowrap; }
.ps-toggle.on { background: rgba(31,181,116,0.12); border-color: rgba(31,181,116,0.4); }
.ps-toggle.on .ps-toggle-track { background: rgba(31,181,116,0.35); }
.ps-toggle.on .ps-toggle-thumb { left: 18px; background: var(--green); }
.ps-toggle.on .ps-toggle-state { color: var(--green); }
.ps-toggle:focus { outline: 2px solid rgba(25,181,156,0.4); outline-offset: 2px; }

/* Save bar — when nothing is dirty it's a one-line status; when there are
   unsaved edits it expands to show the full diff so the operator commits
   with eyes-open. */
.ps-savebar { position: sticky; bottom: 0; margin-top: 20px; padding: 14px 22px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; box-shadow: 0 -8px 24px rgba(0,0,0,0.25); }
.ps-savebar-status { flex: 1; min-width: 0; }
.ps-saved-label { font-size: 12px; color: var(--ink-3); }
.ps-savebar-actions { display: flex; gap: 8px; flex: 0 0 auto; align-self: center; }
.ps-savebar-actions .btn[disabled] { opacity: 0.4; cursor: not-allowed; }

.ps-diff-count { font-size: 12.5px; font-weight: 700; color: var(--ink); margin-bottom: 6px; }
.ps-diff-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.ps-diff-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2); }
.ps-diff-label { font-weight: 600; color: var(--ink); min-width: 140px; }
.ps-diff-before { color: var(--ink-3); text-decoration: line-through; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.ps-diff-arrow { color: var(--ink-3); font-weight: 700; }
.ps-diff-after { color: var(--teal); font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.ps-diff-warn { color: #d6a51c; font-weight: 700; }
.ps-diff-more { color: var(--ink-3); font-size: 11.5px; font-style: italic; }
`;
