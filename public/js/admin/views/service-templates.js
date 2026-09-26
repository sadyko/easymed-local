// WIZ_TEMPLATES_LOCAL_V1 — шаблоны сметы: имя + список услуг.
//
// A template stores ONLY service ids. Doctor, date and time are chosen at every
// booking, so they are deliberately not part of it — «Первичный приём» is the
// same three services whoever performs them and whenever.
//
// Data layer only: no DOM, no ui.js import, so the rules about what a template
// is can be tested directly. The modals that use this live in the views.
//
// Storage is `service_templates` (migration 027): service_ids is a JSON array
// in a TEXT column, declared json:['service_ids'] in the schema registry so the
// API serialises it on write and parses it back on read.
//
// PACKAGES_V1 (migration 154) — a template is now a PACKAGE: the same row plus
// discount_percent and an OFFER WINDOW valid_from..valid_until (local dates,
// both optional, inclusive). «+Пакеты» offers only packages valid today; the
// discount itself is applied by the server when the invoice is issued
// (create_invoice_for_visit), per line, and only to the package's own services.
// A template saved from the смета is a package with 0 % and no dates.

const TABLE = 'service_templates';

// The ids a template covers, whatever shape they arrive in.
//
// Defensive on purpose: before the registry declared service_ids a json column
// the API handed back the raw TEXT "[1,2]", which Array.isArray() rejects — so
// every template rendered «услуг: 0» and applying one added nothing at all. The
// registry is fixed; this keeps a stale or hand-written row from bringing that
// back.
function idsOf(template) {
    const raw = template && template.service_ids;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    return [];
}

// Resolve a template against the current catalogue.
//
// Returns the services in TEMPLATE order (the order the clinic saved them in,
// which is the order they expect to see them added), plus how many ids no
// longer exist — a service deleted since the template was saved is a fact worth
// reporting, not a crash and not a silent omission.
//
// Ids are compared as strings: a json column yields numbers, an <option> value
// yields strings, and the two must still match.
export function resolveTemplate(template, catalog) {
    const ids = idsOf(template);
    const list = Array.isArray(catalog) ? catalog : [];
    const services = [];
    let missing = 0;
    for (const id of ids) {
        const svc = list.find((s) => String(s.id) === String(id));
        if (svc) services.push(svc); else missing++;
    }
    return { services, missing };
}

// How many services a template covers, without needing the catalogue.
export function templateSize(template) {
    return idsOf(template).length;
}

// The clinic's local calendar day as 'YYYY-MM-DD' (the browser runs on the
// clinic's clock — the same assumption every local-day screen makes).
export function localToday(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const ymd = (v) => { const s = String(v == null ? '' : v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };

/** 'active' | 'expired' | 'upcoming' — where `day` sits against the offer window. */
export function packageState(template, day = localToday()) {
    const from = ymd(template && template.valid_from);
    const until = ymd(template && template.valid_until);
    if (from && day < from) return 'upcoming';
    if (until && day > until) return 'expired';
    return 'active';
}

/** Is the package on offer on `day` (window inclusive on both ends)? */
export function packageValidOn(template, day = localToday()) {
    return packageState(template, day) === 'active';
}

/** The package discount, 0..100 (a broken value is 0 — never a made-up discount). */
export function packageDiscount(template) {
    const n = Number(template && template.discount_percent);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 0;
}

const ruDate = (s) => (s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '');

/**
 * The validity line for the settings list: «действует до 30.09.2026»,
 * «истёк 31.08.2026», «ещё не начался — с 01.10.2026», «бессрочно».
 * Returns [text, params] — the caller translates (I18N: translate first).
 */
export function packageValidityParts(template, day = localToday()) {
    const from = ymd(template && template.valid_from);
    const until = ymd(template && template.valid_until);
    const state = packageState(template, day);
    if (state === 'expired') return ['истёк {date}', { date: ruDate(until) }];
    if (state === 'upcoming') return ['ещё не начался — с {date}', { date: ruDate(from) }];
    if (until) return ['действует до {date}', { date: ruDate(until) }];
    if (from) return ['действует с {date}', { date: ruDate(from) }];
    return ['бессрочно', {}];
}

// PACKAGES_V1 — `on` is the day to offer for (default: today). Packages whose
// window does not cover it are left out: a registrar must never be shown a
// discount the server will refuse. `on: null` returns every active package.
export async function listTemplates(supabase, { on } = {}) {
    const res = await supabase.from(TABLE)
        .select('id, name, service_ids, discount_percent, valid_from, valid_until')
        .eq('active', true)
        .order('name');
    if (!res || res.error || !Array.isArray(res.data) || on === null) return res;
    const day = on || localToday();
    return { ...res, data: res.data.filter((t) => packageValidOn(t, day)) };
}

// A template needs a name to be findable and services to be worth anything;
// both are refused here rather than stored as an unusable row.
export async function createTemplate(supabase, { name, serviceIds } = {}) {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) return { data: null, error: { message: 'Введите название шаблона' } };
    const ids = (Array.isArray(serviceIds) ? serviceIds : []).filter((v) => v != null);
    if (!ids.length) return { data: null, error: { message: 'В смете нет услуг' } };
    return supabase.from(TABLE).insert({ name: clean, service_ids: ids, active: true });
}

// Retire, never destroy: hard DELETE is admin-only, and a template taken out of
// the list should stay recoverable in the database.
export async function retireTemplate(supabase, id) {
    return supabase.from(TABLE).update({ active: false }).eq('id', id);
}
