// Easy-Med — clinic-side "Upgrade my workspace" modal.
//
// Opened from the trial banner (clinic-context.js) when an admin clicks
// "Lock in workspace" / "Restore access". Designed with applied
// marketing psychology:
//   * Endowment effect — opens with live counts of what they've built.
//   * Loss aversion   — frames the trial expiry as data going read-only.
//   * Hick's Law      — only 3 fields, all pre-filled.
//   * Default Effect  — clinic name, manager name, phone from session.
//   * Reciprocity     — promises a 1-hour callback before asking.
//   * Pratfall Effect — admits "we'll call you back" (not auto-upgrade).
//   * Peak-End Rule   — soft success card so the funnel ends on a high.
//
// Lazy-loaded on first click so the trial banner stays cheap.

import { supabase } from '../supabase.js';
import { phoneInput } from './phone-input.js?v=ph1';

const MODAL_ID = 'upg-modal';

// Hardcoded fallback when the tariffs RPC can't be reached (RLS deny,
// migration not applied yet, network blip). Mirrors the seed data.
const FALLBACK_PLAN_OPTIONS = [
    { value: 'starter',    label: 'Starter',    sub: 'Solo doctors or single branch',        price: 500000,  currency: 'UZS' },
    { value: 'growth',     label: 'Growth',     sub: 'Multi-doctor multi-branch clinics',     price: 1500000, currency: 'UZS' },
    { value: 'enterprise', label: 'Enterprise', sub: 'Custom — large clinics and hospitals',  price: null,    currency: 'UZS' },
];

async function loadPlanOptions() {
    try {
        const { data, error } = await supabase.from('tariffs')
            .select('key, display_name, tagline, price_monthly, currency, sort_order, visible_in_modal, is_active')
            .eq('visible_in_modal', true)
            .eq('is_active', true)
            .order('sort_order', { ascending: true });
        if (error || !data?.length) return FALLBACK_PLAN_OPTIONS;
        return data.map(t => ({
            value:    t.key,
            label:    t.display_name,
            sub:      t.tagline || '',
            price:    t.price_monthly,
            currency: t.currency,
        }));
    } catch {
        return FALLBACK_PLAN_OPTIONS;
    }
}

// Compact format for the chips: "500K UZS / mo", "1.5M UZS / mo",
// "Contact us" when price is unset (typically Enterprise tier).
function formatPlanPrice(n, curr) {
    if (n == null) return 'Contact us';
    if (n === 0)   return 'Free';
    const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
    return compact + ' ' + (curr || 'UZS') + ' / mo';
}

function injectStyles() {
    if (document.getElementById('upg-styles')) return;
    const s = document.createElement('style');
    s.id = 'upg-styles';
    s.textContent = `
.upg-overlay { position:fixed; inset:0; background:rgba(13,30,44,0.62); backdrop-filter:blur(5px); display:grid; place-items:center; z-index:10000; padding:20px; animation:upg-fade .15s ease-out; }
@keyframes upg-fade { from { opacity:0 } to { opacity:1 } }
.upg-card { background:#fff; border-radius:20px; width:100%; max-width:540px; max-height:92vh; overflow:auto; box-shadow:0 30px 80px rgba(0,0,0,0.32); position:relative; }
.upg-hero { padding:30px 32px 22px; border-bottom:1px solid #eef2f4; background:linear-gradient(135deg,#0d8a8a,#0a6e6e); color:#fff; border-radius:20px 20px 0 0; }
.upg-hero.warn { background:linear-gradient(135deg,#d49616,#a87810); }
.upg-hero.danger { background:linear-gradient(135deg,#d75050,#a83030); }
.upg-hero h2 { margin:0 0 6px; font-size:22px; font-weight:800; letter-spacing:-0.02em; }
.upg-hero p { margin:0; font-size:14px; opacity:.92; line-height:1.5; }
.upg-close { position:absolute; top:14px; right:18px; background:transparent; border:none; color:#fff; font-size:24px; cursor:pointer; padding:6px 10px; border-radius:8px; line-height:1; }
.upg-close:hover { background:rgba(255,255,255,0.18); }
.upg-body { padding:24px 32px 8px; }
.upg-keep { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:20px; }
.upg-keep-tile { background:#f4f9f9; border:1px solid #e0ecec; border-radius:12px; padding:12px; text-align:center; }
.upg-keep-num { font-size:22px; font-weight:800; color:#0d1e2c; letter-spacing:-0.02em; line-height:1.15; }
.upg-keep-lbl { font-size:11.5px; color:#5a6c78; text-transform:uppercase; letter-spacing:0.04em; margin-top:2px; }
.upg-row { margin-bottom:14px; }
.upg-row label { display:block; font-size:13px; font-weight:600; color:#0d1e2c; margin-bottom:6px; }
.upg-row input, .upg-row textarea { width:100%; padding:11px 14px; border:1.5px solid #d8e0e6; border-radius:10px; font-size:14px; font-family:inherit; outline:none; transition:border-color .12s, box-shadow .12s; box-sizing:border-box; background:#fff; color:#0d1e2c; }
.upg-row input:focus, .upg-row textarea:focus { border-color:#0d8a8a; box-shadow:0 0 0 3px rgba(13,138,138,0.13); }
.upg-row .hint { font-size:11.5px; color:#7a8a94; margin-top:5px; }
.upg-plans { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:6px; }
.upg-plan { cursor:pointer; border:1.5px solid #d8e0e6; border-radius:12px; padding:14px 10px 12px; text-align:center; transition:border-color .1s, background .1s, transform .08s; }
.upg-plan:hover { border-color:#0d8a8a; background:#f4f9f9; }
.upg-plan.on { border-color:#0d8a8a; background:#e6f7f0; box-shadow:0 0 0 3px rgba(13,138,138,0.12); }
.upg-plan .pname  { font-weight:700; font-size:14px; color:#0d1e2c; letter-spacing:-0.01em; }
.upg-plan .pprice { font-size:13px; color:#0a6e6e; font-weight:700; margin-top:6px; letter-spacing:-0.01em; }
.upg-plan .pprice.muted { color:#5a6c78; font-weight:600; }
.upg-plan .psub   { font-size:11px; color:#7a8a94; margin-top:5px; line-height:1.35; }
.upg-promise { background:#eaf4f4; border-left:3px solid #0d8a8a; padding:12px 14px; border-radius:8px; font-size:12.5px; color:#0d1e2c; line-height:1.5; margin:18px 0 0; }
.upg-promise strong { color:#0a6e6e; }
.upg-actions { display:flex; gap:10px; padding:14px 32px 28px; border-top:1px solid #eef2f4; margin-top:18px; }
.upg-btn { flex:1; padding:13px 16px; border-radius:10px; font-size:14px; font-weight:700; border:none; cursor:pointer; font-family:inherit; transition:transform .08s; }
.upg-primary { background:linear-gradient(180deg,#0d8a8a,#0a6e6e); color:#fff; }
.upg-primary:hover:not(:disabled) { transform:translateY(-1px); }
.upg-primary:disabled { opacity:.55; cursor:not-allowed; }
.upg-ghost { background:transparent; color:#5a6c78; border:1.5px solid #d8e0e6; flex:0 0 auto; padding-left:18px; padding-right:18px; }
.upg-err { color:#c83434; font-size:12.5px; padding:0 32px 8px; min-height:18px; }
.upg-success { padding:34px 32px; text-align:center; }
.upg-check-wrap { width:72px; height:72px; border-radius:50%; background:#e6f7f0; color:#0a7c5a; display:grid; place-items:center; margin:0 auto 18px; font-size:36px; font-weight:bold; animation:upg-pop .35s ease-out; }
@keyframes upg-pop { 0% { transform:scale(.5); opacity:0 } 100% { transform:scale(1); opacity:1 } }
.upg-success h3 { margin:0 0 8px; font-size:22px; font-weight:800; color:#0d1e2c; letter-spacing:-0.01em; }
.upg-success p { margin:0 0 18px; color:#5a6c78; font-size:14px; line-height:1.55; }
.upg-success .recap { display:inline-block; background:#f4f9f9; color:#0a6e6e; padding:6px 14px; border-radius:999px; font-weight:600; font-size:13px; }
`;
    document.head.appendChild(s);
}

function fmt(n) { return (n ?? 0).toLocaleString('ru-RU'); }

async function fetchKeepCounts(companyId) {
    if (!companyId) return { patients: 0, visits: 0, invoices: 0 };
    const opts = { count: 'exact', head: true };
    const [p, v, i] = await Promise.all([
        supabase.from('patients').select('id', opts).eq('company_id', companyId),
        supabase.from('visits').select('id', opts).eq('company_id', companyId),
        supabase.from('invoices').select('id', opts).eq('company_id', companyId),
    ]);
    return { patients: p.count || 0, visits: v.count || 0, invoices: i.count || 0 };
}

function inferDefaults() {
    const me      = window.easymed?.state?.user || {};
    const clinic  = window.CLINIC || {};
    return {
        company_id:   clinic.id || null,
        clinic_name:  clinic.name || '',
        manager_name: me.full_name || me.username || '',
        phone:        me.phone || '',
    };
}

function heroState(clinic) {
    if (!clinic || !clinic.trial_ends_at) {
        return { cls: '', title: 'Keep your workspace running', sub: "Pick a plan and we'll walk you through the details." };
    }
    const daysLeft = Math.max(0, Math.ceil((new Date(clinic.trial_ends_at).getTime() - Date.now()) / 86400000));
    const expired  = !!clinic.is_locked || daysLeft === 0;
    if (expired) {
        return {
            cls: 'danger',
            title: 'Restore access to ' + (clinic.name || 'your clinic'),
            sub:  'Your trial ended — writes are paused. Pick a plan and we restore everything in under a day.',
        };
    }
    if (daysLeft <= 3) {
        return {
            cls: 'warn',
            title: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left to lock in your workspace`,
            sub:  'After the trial expires, your data goes read-only until you upgrade. Lock in your plan now.',
        };
    }
    return {
        cls: '',
        title: 'Lock in your workspace',
        sub:  `You're on day ${7 - daysLeft + 1} of 7. Pick a plan now and you'll never see this banner again.`,
    };
}

function build() {
    const overlay = document.createElement('div');
    overlay.className = 'upg-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="upg-card" role="dialog" aria-labelledby="upg-title">
        <button class="upg-close" type="button" aria-label="Close">×</button>
        <div class="upg-hero" id="upg-hero">
          <h2 id="upg-title">Lock in your workspace</h2>
          <p id="upg-sub">Loading…</p>
        </div>
        <div class="upg-body" id="upg-body">
          <div class="upg-keep" id="upg-keep" style="display:none">
            <div class="upg-keep-tile"><div class="upg-keep-num" id="upg-k-patients">—</div><div class="upg-keep-lbl">patients</div></div>
            <div class="upg-keep-tile"><div class="upg-keep-num" id="upg-k-visits">—</div><div class="upg-keep-lbl">visits</div></div>
            <div class="upg-keep-tile"><div class="upg-keep-num" id="upg-k-invoices">—</div><div class="upg-keep-lbl">invoices</div></div>
          </div>
          <div class="upg-row">
            <label for="upg-clinic">Clinic name</label>
            <input id="upg-clinic" type="text" maxlength="120" required>
          </div>
          <div class="upg-row">
            <label for="upg-manager">Your name</label>
            <input id="upg-manager" type="text" maxlength="120" required>
          </div>
          <div class="upg-row">
            <label for="upg-phone-field">Phone — we call you back</label>
            <!-- PHONE_INPUT_V1 — swapped for the country control after mount; the
                 wrapper keeps id="upg-phone" so the existing .value reads work. -->
            <input id="upg-phone" type="tel" maxlength="40" placeholder="+998 90 123 45 67" required>
          </div>
          <div class="upg-row">
            <label>Plan interest <span style="color:#7a8a94;font-weight:400">(we'll suggest the right fit too)</span></label>
            <div class="upg-plans" id="upg-plans">
              <div class="upg-plan" style="opacity:.5">Loading plans…</div>
            </div>
          </div>
          <div class="upg-promise">
            <strong>What happens next:</strong> a real person calls the number above within
            <strong>1 business hour</strong> to walk through plans and pick the right fit. <strong>No card needed today.</strong>
          </div>
        </div>
        <div class="upg-err" id="upg-err"></div>
        <div class="upg-actions">
          <button type="button" class="upg-btn upg-ghost" data-upg-cancel>Maybe later</button>
          <button type="button" class="upg-btn upg-primary" id="upg-submit">Send → we'll call you back</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
}

function showError(modal, msg) {
    modal.querySelector('#upg-err').textContent = msg || '';
}

function showSuccess(modal, payload) {
    const card = modal.querySelector('.upg-card');
    card.innerHTML = `
      <div class="upg-success">
        <div class="upg-check-wrap">✓</div>
        <h3>Got it. We'll call you back.</h3>
        <p>A teammate will dial <strong>${escapeHtml(payload.phone)}</strong> within an hour to walk you through plans.</p>
        <span class="recap">${escapeHtml(payload.clinic_name)}</span>
        <div class="upg-actions" style="margin-top:24px; padding:0;">
          <button type="button" class="upg-btn upg-primary" data-upg-cancel>Back to my workspace</button>
        </div>
      </div>
    `;
    card.querySelector('[data-upg-cancel]').addEventListener('click', () => modal.remove());
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let selectedPlan = null;

export async function openUpgradeModal() {
    injectStyles();
    let modal = document.getElementById(MODAL_ID);
    if (modal) { modal.style.display = 'grid'; return; }
    modal = build();
    selectedPlan = null;

    const close = () => modal.remove();
    modal.querySelector('.upg-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-upg-cancel]').forEach(b => b.addEventListener('click', close));
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape' && document.body.contains(modal)) { close(); document.removeEventListener('keydown', esc); }
    });

    const clinic = window.CLINIC || {};
    const heroEl = modal.querySelector('#upg-hero');
    const hs = heroState(clinic);
    if (hs.cls) heroEl.classList.add(hs.cls);
    modal.querySelector('#upg-title').textContent = hs.title;
    modal.querySelector('#upg-sub').textContent   = hs.sub;

    // PHONE_INPUT_V1 — replace the plain <input> from the template markup with
    // the shared country control. It carries the same id, and its .value proxies
    // to the real field, so submit() and the pre-fill below need no changes.
    const phonePlaceholder = modal.querySelector('#upg-phone');
    const phoneCtl = phoneInput('phone', '+998 90 123 45 67');
    phoneCtl.id = 'upg-phone';
    phoneCtl.input.id = 'upg-phone-field';
    phonePlaceholder.replaceWith(phoneCtl);

    // Pre-fill (Default Effect + Activation Energy near zero)
    const defaults = inferDefaults();
    modal.querySelector('#upg-clinic').value  = defaults.clinic_name;
    modal.querySelector('#upg-manager').value = defaults.manager_name;
    modal.querySelector('#upg-phone').value   = defaults.phone;

    // Plan selector — chips load from public.tariffs (visible_in_modal=true)
    const plansContainer = modal.querySelector('#upg-plans');
    loadPlanOptions().then(opts => {
        if (!document.body.contains(modal)) return;
        plansContainer.innerHTML = opts.map(p => {
            const priceText = formatPlanPrice(p.price, p.currency);
            const muted     = (p.price == null) ? ' muted' : '';
            return `
                <div class="upg-plan" data-plan="${escapeHtml(p.value)}">
                    <div class="pname">${escapeHtml(p.label)}</div>
                    <div class="pprice${muted}">${escapeHtml(priceText)}</div>
                    ${p.sub ? `<div class="psub">${escapeHtml(p.sub)}</div>` : ''}
                </div>
            `;
        }).join('');
        plansContainer.querySelectorAll('.upg-plan').forEach(el => {
            el.addEventListener('click', () => {
                plansContainer.querySelectorAll('.upg-plan').forEach(x => x.classList.remove('on'));
                el.classList.add('on');
                selectedPlan = el.dataset.plan;
            });
        });
    });

    // Endowment counts — fire-and-forget; show only when ready.
    fetchKeepCounts(defaults.company_id).then(c => {
        if (!document.body.contains(modal)) return;
        modal.querySelector('#upg-k-patients').textContent = fmt(c.patients);
        modal.querySelector('#upg-k-visits').textContent   = fmt(c.visits);
        modal.querySelector('#upg-k-invoices').textContent = fmt(c.invoices);
        if ((c.patients + c.visits + c.invoices) > 0) {
            modal.querySelector('#upg-keep').style.display = 'grid';
        }
    }).catch(() => {});

    modal.querySelector('#upg-submit').addEventListener('click', () => submit(modal, defaults));
    modal.querySelector('#upg-clinic').focus();
}

async function submit(modal, defaults) {
    const clinic_name  = modal.querySelector('#upg-clinic').value.trim();
    const manager_name = modal.querySelector('#upg-manager').value.trim();
    const phone        = modal.querySelector('#upg-phone').value.trim();
    if (clinic_name.length < 2)  return showError(modal, 'Please confirm your clinic name.');
    if (manager_name.length < 2) return showError(modal, "Tell us who we're calling.");
    if (phone.length < 6)        return showError(modal, 'Phone number looks too short.');

    const btn = modal.querySelector('#upg-submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    showError(modal, '');

    try {
        const me     = window.easymed?.state?.user || {};
        const clinic = window.CLINIC || {};
        const { error } = await supabase.from('upgrade_requests').insert({
            company_id:     clinic.id || defaults.company_id || null,
            requested_by:   me.id || null,
            clinic_name,
            manager_name,
            phone,
            requested_plan: selectedPlan,
        });
        if (error) {
            console.error('[upgrade-modal] insert failed', error);
            showError(modal, 'Could not save your request: ' + (error.message || 'unknown error'));
            btn.disabled = false;
            btn.textContent = "Send → we'll call you back";
            return;
        }
        showSuccess(modal, { clinic_name, phone });
    } catch (e) {
        showError(modal, 'Unexpected error. Try again, or email hello@easymed.uz.');
        btn.disabled = false;
        btn.textContent = "Send → we'll call you back";
        console.error('[upgrade-modal] submit fail', e);
    }
}
