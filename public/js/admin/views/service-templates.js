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

export async function listTemplates(supabase) {
    return supabase.from(TABLE)
        .select('id, name, service_ids')
        .eq('active', true)
        .order('name');
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
