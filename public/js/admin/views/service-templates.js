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

// SERVICES_PACKAGES_V1 — пакет и шаблон сметы различает отметка is_package
// (мигр. 244); цену пакета и цену каждой услуги в нём считает одна функция
// (shared/package-price.js packageCalc) — та же, что у окна пакета, сервера и
// API. Скидку категории пациента пакет не получает (решение владельца 1).
import { isPackageRow, packageIds, packageTerms, packageItems, packageCalc, packageLineOf, packageLineMoney, packageDayState } from '../../shared/package-price.js';

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
// SERVICES_PACKAGES_V1 — правило одно с сервером и API (shared/package-price.js).
export function packageState(template, day = localToday()) {
    return packageDayState(template, day);
}

/** Is the package on offer on `day` (window inclusive on both ends)? */
export function packageValidOn(template, day = localToday()) {
    return packageState(template, day) === 'active';
}

/** The package discount, 0..100 (a broken value is 0 — never a made-up discount). */
// SERVICES_PACKAGES_V1 — процент скидки пакета: посчитанный по прайсу, если цены
// подгружены (listTemplates withPrices), иначе процент, заданный клиникой; у
// шаблона сметы — 0.
export function packageDiscount(template) {
    if (template && template.package_calc) return template.package_calc.pct;
    if (template && template.is_package != null && !isPackageRow(template)) return 0;
    const t = packageTerms(template);
    return t.mode === 'percent' ? t.value : 0;
}

/**
 * PACKAGES_V1 (ревью I-1) → SERVICES_PACKAGES_V1 — как СЕРВЕР разделит смету
 * (billing.js createInvoiceForVisit), чтобы экран показал и отправил то же:
 *   • строка пакета, у которой известна цена в пакете (package.full / .price —
 *     cartPackage), в день строки в сроке пакета — СВОЯ скидка (full − price) ×
 *     количество; скидка группы пациента на неё не ложится (решение 1);
 *   • строка пакета без скидки и все остальные — «остальное»: лояльность,
 *     промокод и пол группы считаются только по нему.
 * `lines` — [{ total, qty, package, day }]; total строки пакета — full × qty,
 * ровно как выставит счёт. Returns { packageDiscount, restTotal } (до тийина).
 */
export function packageSplit(lines) {
    const r2 = (n) => Math.round(n * 100) / 100;
    let packageDiscount = 0;
    let restTotal = 0;
    for (const l of Array.isArray(lines) ? lines : []) {
        const pkg = l && l.package;
        const m = pkg && pkg.price != null && pkg.full != null && packageValidOn(pkg, l.day || localToday())
            ? packageLineMoney({ package_full: pkg.full, package_price: pkg.price, quantity: l.qty == null ? 1 : l.qty })
            : null;
        if (m && m.discount > 0) packageDiscount += m.discount;
        else restTotal += Number(l && l.total) || 0;
    }
    return { packageDiscount: r2(packageDiscount), restTotal: r2(restTotal) };
}

/**
 * SERVICES_PACKAGES_V1 — пакет строки сметы: { id, name, is_package, valid_from,
 * valid_until } и, если раскладка пакета посчитана (listTemplates withPrices),
 * цена услуги без скидки и в пакете (full, price) — те же числа, что сервер
 * запишет на строку. У шаблона сметы цены нет: его строки — обычные.
 */
export function cartPackage(template, serviceId) {
    if (!template || template.id == null) return null;
    const base = { id: Number(template.id), name: template.name || '', is_package: isPackageRow(template) ? 1 : 0,
        valid_from: template.valid_from || null, valid_until: template.valid_until || null };
    const line = base.is_package && template.package_calc ? packageLineOf(template.package_calc, serviceId) : null;
    return line ? { ...base, full: line.full, price: line.price } : base;
}

/**
 * SERVICES_PACKAGES_V1 — раскладка каждого ПАКЕТА списка по сегодняшнему
 * прайсу: шаблону добавляется package_calc ({ full, price, off, pct, lines }).
 * Цены услуг — одним запросом. Не прочитались — package_calc нет: смета
 * покажет строки без цены пакета, а цену запишет сервер.
 */
export async function attachPackagePrices(supabase, templates) {
    const list = (Array.isArray(templates) ? templates : []).filter(isPackageRow);
    const ids = [...new Set(list.flatMap((t) => packageIds(t)))];
    if (!ids.length) return templates;
    let services = [];
    try {
        const { data, error } = await supabase.from('services').select('id, price, active').in('id', ids);
        services = error || !Array.isArray(data) ? [] : data;
    } catch { services = []; }
    if (!services.length) return templates;
    for (const t of list) t.package_calc = packageCalc(packageTerms(t), packageItems(t, services).items);
    return templates;
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
// SERVICES_PACKAGES_V1 — withPrices: раскладка пакетов по прайсу
// (attachPackagePrices); kinds: 'templates' — только шаблоны сметы (окно
// записи колл-центра: его дверь booking_lines_add пакета не несёт).
export async function listTemplates(supabase, { on, withPrices = false, kinds = 'all' } = {}) {
    const res = await supabase.from(TABLE)
        .select('id, name, service_ids, discount_percent, valid_from, valid_until, is_package, name_uz, name_en, discount_mode, discount_value')
        .eq('active', true)
        .order('name');
    if (!res || res.error || !Array.isArray(res.data)) return res;
    let data = res.data;
    if (kinds === 'templates') data = data.filter((t) => !isPackageRow(t));
    if (on !== null) {
        const day = on || localToday();
        data = data.filter((t) => packageValidOn(t, day));
    }
    if (withPrices) await attachPackagePrices(supabase, data);
    return data === res.data ? res : { ...res, data };
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
