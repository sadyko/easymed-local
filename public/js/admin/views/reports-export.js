// Reports → Downloads: pulls one row per invoice_item across the current
// branch + period, resolves doctor / registrar / referral / service-type
// lookups, and hands the flat array to SheetJS for an .xlsx download.
//
// Kept out of reports.js so the analytics view stays lean; the reports page
// dynamic-imports this only when the user clicks a download button.

import { supabase } from '../../supabase.js';
import { h, Icon, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { formatMethods } from '../../shared/payment-methods.js?v=pm1';   // INVOICE_METHOD_COLUMN_V1 — общий словарь с сервером
import { reportTotals } from './report-totals.js?v=rt1';   // REPORT_TOTALS_V1

// The exact column order the owner spec'd. Keys map to fields we produce
// in buildRevenueRow(); labels are the header row in the .xlsx.
export const REVENUE_COLUMNS = [
    { key: 'patient_id',           label: 'Patient ID' },
    { key: 'patient_full_name',    label: 'Patient Full name' },
    { key: 'patient_phone',        label: 'Number' },
    { key: 'visit_kind',           label: 'Outpatient or inpatient' },
    { key: 'service_group',        label: 'Service group' },
    { key: 'service_type',         label: 'Service type' },
    { key: 'service_category',     label: 'Service category' },
    { key: 'service_name',         label: 'Service' },
    { key: 'price',                label: 'Price' },
    { key: 'amount',               label: 'Amount' },
    { key: 'discount',             label: 'discount' },
    { key: 'amount_after_discount',label: 'Amount After discount' },
    { key: 'tax_rate',             label: 'Tax rate' },
    { key: 'amount_after_tax',     label: 'Amount after tax' },
    { key: 'service_date',         label: 'Service date' },
    { key: 'done_date',            label: 'Done date' },
    { key: 'coverage_type',        label: 'Coverage type' },
    { key: 'coverer',              label: 'Coverer' },
    { key: 'payment_state',        label: 'Payment state' },
    { key: 'doctor_name',          label: 'Doctor Name' },
    { key: 'doctor_payroll_pct',   label: 'Doctor Payroll for Service (%)' },
    { key: 'doctor_payroll_amt',   label: 'Doctor Payroll for Service' },
    { key: 'branch',               label: 'Branch' },
    { key: 'registrar_name',       label: 'Registrar Name' },
    { key: 'referral_category',    label: 'Referal source category' },
    { key: 'referrer_name',        label: 'Referrer Name' },
    { key: 'referral_payroll_pct', label: 'Referral Payroll (%)' },
    { key: 'referral_payroll_amt', label: 'Referral Payroll' },
    { key: 'invoice_number',       label: 'Invoice number' },
];

// Period selector maps to a [fromISO, toISO] window against invoices.created_at
// so the report matches what the Reports page already displays.
function periodWindow(period) {
    const now = new Date();
    const to  = new Date(now.getTime()).toISOString();
    const startOf = (d) => { d.setHours(0, 0, 0, 0); return d; };
    if (period === 'today') {
        return [startOf(new Date()).toISOString(), to];
    }
    if (period === 'week') {
        const d = startOf(new Date()); d.setDate(d.getDate() - 7); return [d.toISOString(), to];
    }
    if (period === 'month') {
        const d = new Date(now.getFullYear(), now.getMonth(), 1); return [d.toISOString(), to];
    }
    if (period === 'quarter') {
        const q = Math.floor(now.getMonth() / 3) * 3;
        const d = new Date(now.getFullYear(), q, 1); return [d.toISOString(), to];
    }
    if (period === 'year') {
        const d = new Date(now.getFullYear(), 0, 1); return [d.toISOString(), to];
    }
    return [new Date(0).toISOString(), to];
}

// Helpers to convert between a YYYY-MM-DD <input type="date"> value and an
// ISO instant. From = start-of-day local; To = end-of-day local so the
// picked "to" date is inclusive.
function dateInputToStartIso(v) {
    if (!v) return null;
    const d = new Date(v + 'T00:00:00');
    return isNaN(d) ? null : d.toISOString();
}
function dateInputToEndIso(v) {
    if (!v) return null;
    const d = new Date(v + 'T23:59:59.999');
    return isNaN(d) ? null : d.toISOString();
}
function isoToDateInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Turn "outpatient" / "inpatient" from what the data tells us.
function visitKindLabel(inv) {
    if (inv.admission_id) return 'Inpatient';
    if (inv.visit_id)     return 'Outpatient';
    return '—';
}

function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// One invoice_items row + all resolved sidecar lookups → one Excel row.
function buildRevenueRow({ ii, inv, svc, svcType, svcCategory, doctor, registrar, branch, payer, referral, admittingVisit, admissionRow, sourceServiceRow }) {
    const price     = Number(svc?.price   ?? ii.unit_price ?? 0);
    const qty       = Number(ii.quantity  ?? 1);
    const amount    = Number(ii.unit_price ?? 0) * qty;
    // invoice_items.discount_percentage → row-level discount amount.
    const discPct   = Number(ii.discount_percentage ?? 0);
    const discAmt   = amount * discPct / 100;
    const afterDisc = amount - discAmt;
    const taxRate   = Number(svc?.tax_rate ?? 0);
    // VAT_INCLUSIVE_V1 — VAT is baked INTO the price. «Amount after tax» is the
    // net once the embedded VAT is removed (afterDisc / 1.rate), NOT afterDisc
    // with tax added on top.
    const afterTax  = taxRate > 0 ? afterDisc / (1 + taxRate / 100) : afterDisc;

    // Doctor % / amount — services.default_doctor_percent is the clinic-level
    // baseline. sourceServiceRow (visit_services / admission_services) can
    // override if a custom field exists on the row; today's schema doesn't
    // carry that per-row so we fall back to the service default.
    const docPct    = Number(svc?.default_doctor_percent ?? 0);
    // DOCTOR_SHARE_AFTER_TAX_V1 — процент врача берётся от суммы ПОСЛЕ налога.
    // Было `afterDisc * docPct` — доля начислялась и с той части, что уходит в
    // налог, и выгрузка расходилась с отчётом «Зарплата врачей».
    // Базой служит afterTax этого же файла, чтобы строка оставалась
    // самосогласованной (см. VAT_INCLUSIVE_V1 выше о модели налога).
    const docAmt    = afterTax * docPct / 100;

    // Payment state — invoice.status is authoritative (unpaid/partial/paid/refunded).
    const paid = Number(inv.paid_amount ?? 0);
    const total = Number(inv.total_amount ?? 0);
    let paymentState = inv.status || '';
    if (!paymentState) {
        if (paid <= 0)             paymentState = 'unpaid';
        else if (paid >= total)    paymentState = 'paid';
        else                       paymentState = 'partial';
    }

    return {
        patient_id:            inv.patients?.mrn || '',
        patient_full_name:     inv.patients?.full_name || '',
        patient_phone:         inv.patients?.phone || '',
        visit_kind:            visitKindLabel(inv),
        service_group:         svc?.type || '',
        service_type:          svcType?.name || '',
        service_category:      svcCategory?.name || '',
        service_name:          svc?.name || ii.description || '',
        price,
        amount,
        discount:              discAmt,
        amount_after_discount: afterDisc,
        tax_rate:              taxRate,
        amount_after_tax:      Math.round(afterTax * 100) / 100,
        service_date:          fmtDateTime(sourceServiceRow?.scheduled_at || sourceServiceRow?.performed_at || admittingVisit?.visit_date || admissionRow?.admitted_at || inv.created_at),
        done_date:             fmtDateTime(sourceServiceRow?.performed_at || sourceServiceRow?.verified_at || inv.paid_at || ''),
        coverage_type:         inv.coverage_type || 'patient',
        coverer:               payer?.name || (inv.coverage_type === 'patient' ? 'Self-pay' : ''),
        payment_state:         paymentState,
        doctor_name:           doctor?.full_name || '',
        doctor_payroll_pct:    docPct,
        doctor_payroll_amt:    Math.round(docAmt * 100) / 100,
        branch:                branch?.name || '',
        registrar_name:        registrar?.full_name || '',
        referral_category:     referral?.category || '',
        referrer_name:         referral?.name || '',
        referral_payroll_pct:  Number(referral?.commission_percent ?? 0),
        referral_payroll_amt:  referral ? (Math.round(afterDisc * Number(referral.commission_percent || 0) / 100 * 100) / 100) : 0,
        invoice_number:        inv.invoice_number || '',
    };
}

// Kick the query and produce the [{...29 cols}] array. Runs one fat select
// with nested joins for what PostgREST can inline, then supplements with
// two small parallel lookups for doctor + referral.
//
// Filter precedence:
//   - Explicit fromIso/toIso override `period`
//   - Explicit branchIds (array) override `branchId`; empty array = all
export async function buildRevenueReport({ period, branchId, branchIds, clinicId, fromIso, toIso }) {
    if (!fromIso || !toIso) {
        [fromIso, toIso] = periodWindow(period);
    }
    let q = supabase.from('invoice_items')
        .select(`
            id, invoice_id, service_id, description, quantity, unit_price, discount_percentage, total, created_at,
            services (
                id, name, type, tax_rate, default_doctor_percent, category_id, type_id
            ),
            invoices!inner (
                id, invoice_number, visit_id, admission_id, patient_id, branch_id,
                payer_id, coverage_type, subtotal, discount_amount, tax_amount,
                total_amount, paid_amount, status, created_by, created_at, paid_at,
                patients ( id, mrn, full_name, phone, referral_source_id ),
                branches ( id, name ),
                payers   ( id, name, type )
            )
        `)
        .gte('invoices.created_at', fromIso)
        .lte('invoices.created_at', toIso)
        .limit(10000);
    if (clinicId) q = q.eq('company_id', clinicId);
    // branchIds wins if it's a real subset; else fall back to the legacy single-branch selector.
    if (Array.isArray(branchIds) && branchIds.length > 0) {
        q = q.in('invoices.branch_id', branchIds);
    } else if (branchId && branchId !== 'all') {
        q = q.eq('invoices.branch_id', branchId);
    }

    const { data: rawItems, error } = await q;
    if (error) throw new Error('invoice_items load: ' + error.message);
    const items = (rawItems || []).filter(r => r.invoices); // drop orphans

    if (items.length === 0) return [];

    // Batch the sidecar lookups.
    const visitIds       = [...new Set(items.map(r => r.invoices.visit_id).filter(Boolean))];
    const admissionIds   = [...new Set(items.map(r => r.invoices.admission_id).filter(Boolean))];
    const registrarIds   = [...new Set(items.map(r => r.invoices.created_by).filter(Boolean))];
    const typeIds        = [...new Set(items.map(r => r.services?.type_id).filter(Boolean))];
    const categoryIds    = [...new Set(items.map(r => r.services?.category_id).filter(Boolean))];
    const referralSrcIds = [...new Set(items.map(r => r.invoices.patients?.referral_source_id).filter(Boolean))];
    const itemIds        = items.map(r => r.id);

    const [
        visitServicesRes, admissionServicesRes,
        visitsRes, admissionsRes,
        registrarsRes, typesRes, categoriesRes, referralsRes,
    ] = await Promise.all([
        // Row-level source rows so we can pull the doctor + service/done dates.
        supabase.from('visit_services').select('id, visit_id, doctor_id, invoice_item_id, status, scheduled_at, verified_at, created_at, sample_collected_at').in('invoice_item_id', itemIds),
        supabase.from('admission_services').select('id, admission_id, doctor_id, invoice_item_id, performed_at, created_at').in('invoice_item_id', itemIds),
        // Fallbacks for doctor/date when the row link is missing.
        visitIds.length     ? supabase.from('visits').select('id, doctor_id, visit_date, visit_type').in('id', visitIds) : Promise.resolve({ data: [] }),
        admissionIds.length ? supabase.from('admissions').select('id, attending_doctor_id, admitted_at').in('id', admissionIds) : Promise.resolve({ data: [] }),
        registrarIds.length ? supabase.from('users').select('id, full_name').in('id', registrarIds) : Promise.resolve({ data: [] }),
        typeIds.length      ? supabase.from('service_types').select('id, name').in('id', typeIds) : Promise.resolve({ data: [] }),
        categoryIds.length  ? supabase.from('service_categories').select('id, name').in('id', categoryIds) : Promise.resolve({ data: [] }),
        referralSrcIds.length ? supabase.from('referral_sources').select('id, name, category, commission_percent').in('id', referralSrcIds) : Promise.resolve({ data: [] }),
    ]);

    // Distinct doctor ids from ALL sources — visit_services, admission_services,
    // and the fallback visits/admissions.
    const doctorIds = new Set();
    (visitServicesRes.data     || []).forEach(r => r.doctor_id && doctorIds.add(r.doctor_id));
    (admissionServicesRes.data || []).forEach(r => r.doctor_id && doctorIds.add(r.doctor_id));
    (visitsRes.data     || []).forEach(r => r.doctor_id && doctorIds.add(r.doctor_id));
    (admissionsRes.data || []).forEach(r => r.attending_doctor_id && doctorIds.add(r.attending_doctor_id));

    const doctorsRes = doctorIds.size
        ? await supabase.from('users').select('id, full_name').in('id', [...doctorIds])
        : { data: [] };

    // Index everything by id for fast joins in the mapping step.
    const byId = (arr) => Object.fromEntries((arr || []).map(x => [x.id, x]));
    const visitsById       = byId(visitsRes.data);
    const admissionsById   = byId(admissionsRes.data);
    const registrarsById   = byId(registrarsRes.data);
    const typesById        = byId(typesRes.data);
    const categoriesById   = byId(categoriesRes.data);
    const referralsById    = byId(referralsRes.data);
    const doctorsById      = byId(doctorsRes.data);
    // Source rows keyed by invoice_item_id — we prefer whichever matches.
    const vsvcByItem = Object.fromEntries((visitServicesRes.data     || []).map(r => [r.invoice_item_id, r]));
    const asvcByItem = Object.fromEntries((admissionServicesRes.data || []).map(r => [r.invoice_item_id, r]));

    // REVENUE_DONE_ONLY_V1 — revenue counts only PERFORMED services: a linked
    // visit_services row must be completed/done (or lab-verified); a linked
    // admission_services row must have performed_at. Invoice lines with no
    // service link (manual/ad-hoc) are kept — there is nothing to gate on.
    const isDoneVs = (r) => r.status === 'completed' || r.status === 'done' || !!r.verified_at;
    const performedItems = items.filter(ii => {
        const vsRow = vsvcByItem[ii.id]; if (vsRow) return isDoneVs(vsRow);
        const asRow = asvcByItem[ii.id]; if (asRow) return !!asRow.performed_at;
        return true;
    });

    // Compose the rows.
    return performedItems.map(ii => {
        const inv    = ii.invoices;
        const svc    = ii.services || null;
        const sourceServiceRow = asvcByItem[ii.id] || vsvcByItem[ii.id] || null;

        // Doctor resolution priority: source row → visit/admission fallback.
        let doctorId = sourceServiceRow?.doctor_id;
        if (!doctorId && inv.visit_id)      doctorId = visitsById[inv.visit_id]?.doctor_id;
        if (!doctorId && inv.admission_id)  doctorId = admissionsById[inv.admission_id]?.attending_doctor_id;
        const doctor = doctorId ? doctorsById[doctorId] : null;

        return buildRevenueRow({
            ii, inv, svc,
            svcType:      svc?.type_id     ? typesById[svc.type_id]        : null,
            svcCategory:  svc?.category_id ? categoriesById[svc.category_id] : null,
            doctor,
            registrar:    inv.created_by                ? registrarsById[inv.created_by]                              : null,
            branch:       inv.branches                  || null,
            payer:        inv.payers                    || null,
            referral:     inv.patients?.referral_source_id ? referralsById[inv.patients.referral_source_id] : null,
            admittingVisit: inv.visit_id                ? visitsById[inv.visit_id]                                    : null,
            admissionRow:   inv.admission_id            ? admissionsById[inv.admission_id]                            : null,
            sourceServiceRow,
        });
    });
}

// Trigger a browser download of an .xlsx built from `rows` (array of objects)
// keyed by REVENUE_COLUMNS entries. SheetJS pulled at click-time so the
// reports page pays no cost until the user asks for a download.
async function downloadRevenueXlsx(rows, filenameBase = 'total-revenue') {
    if (rows.length === 0) { toast('No revenue in the selected period.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const header = REVENUE_COLUMNS.map(c => c.label);
    const dataMatrix = [
        header,
        ...rows.map(r => REVENUE_COLUMNS.map(c => r[c.key] == null ? '' : r[c.key])),
    ];
    const ws = XLSX.utils.aoa_to_sheet(dataMatrix);
    // Wider columns for the text-heavy ones so the file opens legible.
    ws['!cols'] = REVENUE_COLUMNS.map(c => ({
        wch: Math.max(c.label.length + 2,
            /name|Full|Service|category|type|Coverer|Registrar|Doctor|Branch|Number|Invoice|group/i.test(c.label) ? 22 : 14),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Total revenue');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${filenameBase}-${stamp}.xlsx`);
}


// ---------------------------------------------------------------------------
// REFERRAL_REWARDS_V1 — «Рефералы»: reward per referral source, % by product
// group. Basis: visit_services rows carrying a referral (per-service
// referral_source_id from the booking wizard, falling back to the visit-level
// one), non-cancelled, amount = visit_services.total. Rate per service =
// source manual → source.commission_rates[type_id] ?? 0, else the clinic-wide
// companies.referral_reward_rates[type_id] ?? 0 (unset group = 0%).
// ---------------------------------------------------------------------------
export const REFERRAL_COLUMNS = [
    { key: 'source_name',     label: 'Источник' },
    { key: 'source_category', label: 'Категория' },
    { key: 'mode',            label: 'Режим ставок' },
    { key: 'services_count',  label: 'Услуг' },
    { key: 'amount_sum',      label: 'Сумма услуг' },
    { key: 'reward_sum',      label: 'Вознаграждение' },
];

export async function buildReferralReport({ period, branchId, branchIds, clinicId, fromIso, toIso }) {
    if (!fromIso || !toIso) {
        [fromIso, toIso] = periodWindow(period);
    }
    let q = supabase.from('visit_services')
        .select(`
            id, total, status, referral_source_id, service_id,
            services ( id, name, type_id ),
            visits!inner ( id, visit_date, branch_id, company_id, status, referral_source_id )
        `)
        .gte('visits.visit_date', fromIso)
        .lte('visits.visit_date', toIso)
        .limit(10000);
    if (clinicId) q = q.eq('visits.company_id', clinicId);
    if (Array.isArray(branchIds) && branchIds.length > 0) {
        q = q.in('visits.branch_id', branchIds);
    } else if (branchId && branchId !== 'all') {
        q = q.eq('visits.branch_id', branchId);
    }
    const { data: raw, error } = await q;
    if (error) throw new Error('visit_services load: ' + error.message);

    const rows = (raw || []).filter(r => r.visits
        && r.status !== 'cancelled' && r.visits.status !== 'cancelled'
        && (r.referral_source_id || r.visits.referral_source_id));
    if (rows.length === 0) return [];

    const srcIds = [...new Set(rows.map(r => r.referral_source_id || r.visits.referral_source_id))];
    const [srcRes, catRes, coRes] = await Promise.all([
        supabase.from('referral_sources').select('id, name, category_id, commission_mode, commission_rates').in('id', srcIds),
        supabase.from('referral_source_categories').select('id, name'),
        clinicId ? supabase.from('companies').select('referral_reward_rates').eq('id', clinicId).single() : Promise.resolve({ data: null }),
    ]);
    if (srcRes.error && /commission_mode/.test(srcRes.error.message || '')) {
        throw new Error('Примените миграцию 103 (referral_rewards) в Supabase SQL editor.');
    }
    const srcById = new Map((srcRes.data || []).map(s => [s.id, s]));
    const catById = new Map((catRes.data || []).map(c => [c.id, c.name]));
    const generalRates = (coRes.data && coRes.data.referral_reward_rates) || {};

    // Aggregate per source.
    const agg = new Map();   // id -> { source_name, ..., services_count, amount_sum, reward_sum }
    for (const r of rows) {
        const sid = r.referral_source_id || r.visits.referral_source_id;
        const src = srcById.get(sid);
        const amount = Number(r.total || 0);
        const typeId = r.services ? r.services.type_id : null;
        const manual = src && src.commission_mode === 'manual';
        const rateMap = manual ? (src.commission_rates || {}) : generalRates;
        const pct = typeId != null && rateMap[typeId] != null ? Number(rateMap[typeId]) : 0;
        let a = agg.get(sid);
        if (!a) {
            a = {
                source_name: src ? src.name : '(источник удалён)',
                source_category: src ? (catById.get(src.category_id) || '—') : '—',
                mode: manual ? 'Вручную' : 'Общий',
                services_count: 0, amount_sum: 0, reward_sum: 0,
            };
            agg.set(sid, a);
        }
        a.services_count += 1;
        a.amount_sum += amount;
        a.reward_sum += amount * pct / 100;
    }
    return [...agg.values()]
        .map(a => ({ ...a, amount_sum: Math.round(a.amount_sum), reward_sum: Math.round(a.reward_sum) }))
        .sort((x, y) => y.reward_sum - x.reward_sum);
}

async function downloadReferralsXlsx(rows, filenameBase = 'referrals') {
    if (rows.length === 0) { toast('Нет рефералов в выбранном периоде.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const header = REFERRAL_COLUMNS.map(c => c.label);
    const dataMatrix = [header, ...rows.map(r => REFERRAL_COLUMNS.map(c => r[c.key] == null ? '' : r[c.key]))];
    const ws = XLSX.utils.aoa_to_sheet(dataMatrix);
    ws['!cols'] = REFERRAL_COLUMNS.map(c => ({ wch: Math.max(c.label.length + 2, /Источник|Категория/i.test(c.label) ? 26 : 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Referrals');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${filenameBase}-${stamp}.xlsx`);
}

// ---------------------------------------------------------------------------
// OWNER_REPORT_V1 — «Отчёт владельца»: charts instead of a table. Basis:
// visit_services.total, non-cancelled, by visits.visit_date (accrual — same
// definition as Revenue). Four panels: KPI tiles · monthly line (fixed last-12-
// months window) · revenue by product group (one-hue bars) · inflow by payer
// (categorical palette, validated: #0d8a72/#2563eb/#b45309/#7c3aed).
// ---------------------------------------------------------------------------
async function ownerFetchVS(fromIso, toIso, clinicId, branchIds, branchId) {
    let q = supabase.from('visit_services')
        .select('id, total, status, payer_covered, services ( type_id ), visits!inner ( visit_date, branch_id, company_id, status, coverage_type )')
        .gte('visits.visit_date', fromIso)
        .lte('visits.visit_date', toIso)
        .limit(10000);
    if (clinicId) q = q.eq('visits.company_id', clinicId);
    if (Array.isArray(branchIds) && branchIds.length > 0) q = q.in('visits.branch_id', branchIds);
    else if (branchId && branchId !== 'all') q = q.eq('visits.branch_id', branchId);
    const { data, error } = await q;
    if (error) throw new Error('visit_services: ' + error.message);
    return (data || []).filter(r => r.visits && r.status !== 'cancelled' && r.visits.status !== 'cancelled');
}

const OWNER_M_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export async function buildOwnerReport({ period, branchId, branchIds, clinicId, fromIso, toIso }) {
    if (!fromIso || !toIso) [fromIso, toIso] = periodWindow(period);
    const now = new Date();
    const mFromIso = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString();
    const [rows, mRows, typesRes] = await Promise.all([
        ownerFetchVS(fromIso, toIso, clinicId, branchIds, branchId),
        ownerFetchVS(mFromIso, now.toISOString(), clinicId, branchIds, branchId),
        supabase.from('service_types').select('id, name'),
    ]);
    const typeName = new Map((typesRes.data || []).map(t => [t.id, t.name]));

    const revenue = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    const count = rows.length;

    const g = new Map();
    for (const r of rows) {
        const nm = typeName.get(r.services && r.services.type_id) || 'Прочее';
        g.set(nm, (g.get(nm) || 0) + Number(r.total || 0));
    }
    const byGroup = [...g.entries()].map(([name, value]) => ({ name, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value);

    const monthly = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        monthly.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: OWNER_M_RU[d.getMonth()], value: 0 });
    }
    const mIdx = new Map(monthly.map((m, i) => [m.key, i]));
    for (const r of mRows) {
        const d = new Date(r.visits.visit_date);
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const i = mIdx.get(k);
        if (i != null) monthly[i].value += Number(r.total || 0);
    }
    for (const m of monthly) m.value = Math.round(m.value);

    const P = { patient: 0, insurance: 0, corporate: 0, state: 0 };
    for (const r of rows) {
        const amt = Number(r.total || 0);
        if (!r.payer_covered) { P.patient += amt; continue; }
        const c = r.visits.coverage_type;
        if (c === 'corporate') P.corporate += amt;
        else if (c === 'state' || c === 'government') P.state += amt;
        else P.insurance += amt;
    }
    // Fixed categorical order + hues (validated palette) — never re-assigned by rank.
    const byPayer = [
        { label: 'Пациент (самооплата)', color: '#0d8a72', value: Math.round(P.patient) },
        { label: 'ДМС / Страховка',      color: '#2563eb', value: Math.round(P.insurance) },
        { label: 'B2B (корпоратив)',     color: '#b45309', value: Math.round(P.corporate) },
        { label: 'Госпрограмма',         color: '#7c3aed', value: Math.round(P.state) },
    ].filter(x => x.value > 0);

    return { kpis: { revenue: Math.round(revenue), count, avg: count ? Math.round(revenue / count) : 0 }, byGroup, monthly, byPayer };
}

// ---- chart primitives (self-drawn, CSP-safe; text wears text tokens) ----
function ownerCard(title, sub, bodyEl) {
    return h('div', { style: { background: 'var(--white)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '16px 18px', minWidth: 0 } },
        h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } }, title),
        sub ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, sub) : null,
        h('div', { style: { marginTop: '12px' } }, bodyEl));
}
function ownerTip() {
    const t = h('div', { style: { position: 'fixed', zIndex: '200', pointerEvents: 'none', display: 'none',
        background: 'var(--ink-900, #0b1418)', color: '#fff', borderRadius: '8px', padding: '6px 10px',
        font: '600 12px -apple-system, "Segoe UI", Roboto, sans-serif', boxShadow: '0 6px 18px rgba(11,20,24,.3)', whiteSpace: 'nowrap' } });
    document.body.appendChild(t);
    return {
        show(x, y, text) { t.textContent = text; t.style.display = 'block'; t.style.left = (x + 12) + 'px'; t.style.top = (y - 30) + 'px'; },
        hide() { t.style.display = 'none'; },
        destroy() { t.remove(); },
    };
}
// Horizontal bar list — magnitude in ONE hue unless a row carries its own
// identity color (payer composition). 4px rounded data end, 2px gaps, direct labels.
function ownerBars(items, { hue = '#0d8a72', tip, total = null } = {}) {
    const max = Math.max(...items.map(i => i.value), 1);
    const sum = total != null ? total : items.reduce((s, i) => s + i.value, 0);
    const wrapEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
    for (const it of items) {
        const pctW = Math.max(1, Math.round(it.value / max * 100));
        const share = sum > 0 ? Math.round(it.value / sum * 100) : 0;
        const row = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) 2fr auto', alignItems: 'center', gap: '10px', padding: '4px 4px', borderRadius: '6px' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-800)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '7px' } },
                it.color ? h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: it.color, flex: 'none' } }) : null,
                it.name || it.label),
            h('span', { style: { display: 'block', height: '14px', background: 'var(--ink-50, #f3f5f7)', borderRadius: '4px', overflow: 'hidden' } },
                h('span', { style: { display: 'block', height: '100%', width: pctW + '%', background: it.color || hue, borderRadius: '0 4px 4px 0' } })),
            h('span', { class: 'num', style: { fontSize: '12px', color: 'var(--ink-800)', fontVariantNumeric: 'tabular-nums' } },
                it.value.toLocaleString('ru-RU') + (sum > 0 ? '  · ' + share + '%' : '')));
        row.addEventListener('mousemove', (e) => tip && tip.show(e.clientX, e.clientY, trf('{name}: {value} сум · {share}%', { name: it.name || it.label, value: it.value.toLocaleString('ru-RU'), share })));
        row.addEventListener('mouseleave', () => tip && tip.hide());
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--ink-25, #fafbfb)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        wrapEl.appendChild(row);
    }
    return wrapEl;
}
// Single-series line chart (SVG): 2px line, soft area, 3 recessive gridlines,
// hover crosshair + marker + tooltip, direct label on the last point.
function ownerLine(points, { hue = '#0d8a72', tip } = {}) {
    // OWNER_CHART_HEIGHT_V1 — on the full-screen report the chart used to balloon
    // to ~500px because a 720×200 viewBox with width:100% derives its height from
    // the container width. Cap the height (clamp) and use a WIDE viewBox whose
    // aspect ≈ the render aspect + preserveAspectRatio:none so it fills the width
    // (hover math stays correct) with negligible text distortion.
    const W = 1600, H = 220, padL = 10, padR = 60, padT = 18, padB = 30;
    const max = Math.max(...points.map(p => p.value), 1);
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = (i) => padL + (points.length > 1 ? i / (points.length - 1) : 0.5) * iw;
    const y = (v) => padT + ih - (v / max) * ih;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = '100%'; svg.style.display = 'block';
    svg.style.height = 'clamp(170px, 22vh, 240px)';   // OWNER_CHART_HEIGHT_V1
    const add = (tag, attrs, textContent) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
        if (textContent != null) el.textContent = textContent;
        svg.appendChild(el); return el;
    };
    for (const fr of [0, 0.5, 1]) {   // recessive gridlines + scale labels
        const gy = padT + ih - fr * ih;
        add('line', { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: 'var(--ink-100, #e8ecef)', 'stroke-width': '1' });
        add('text', { x: padL + iw + 4, y: gy + 3, 'font-size': '9', fill: 'var(--ink-400, #8a97a0)' },
            fr === 0 ? '0' : Math.round(max * fr).toLocaleString('ru-RU'));
    }
    const coords = points.map((p, i) => [x(i), y(p.value)]);
    add('path', { d: 'M' + coords.map(c => c[0] + ',' + c[1]).join(' L') + ` L${padL + iw},${padT + ih} L${padL},${padT + ih} Z`, fill: hue, opacity: '0.08' });
    add('path', { d: 'M' + coords.map(c => c[0] + ',' + c[1]).join(' L'), fill: 'none', stroke: hue, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    points.forEach((p, i) => add('text', { x: x(i), y: H - 8, 'font-size': '9.5', 'text-anchor': 'middle', fill: 'var(--ink-500, #55636d)' }, p.label));
    const last = points[points.length - 1];
    if (last && last.value > 0) add('text', { x: coords[coords.length - 1][0], y: coords[coords.length - 1][1] - 8, 'font-size': '10', 'font-weight': '700', 'text-anchor': 'end', fill: 'var(--ink-800, #1f2d34)' }, last.value.toLocaleString('ru-RU'));
    const vline = add('line', { x1: 0, y1: padT, x2: 0, y2: padT + ih, stroke: 'var(--ink-300, #aab4bc)', 'stroke-width': '1', 'stroke-dasharray': '3 3', visibility: 'hidden' });
    const marker = add('circle', { cx: 0, cy: 0, r: '4.5', fill: hue, stroke: '#fff', 'stroke-width': '2', visibility: 'hidden' });
    svg.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        const relX = (e.clientX - r.left) / r.width * W;
        let best = 0, bd = Infinity;
        coords.forEach((c, i) => { const d = Math.abs(c[0] - relX); if (d < bd) { bd = d; best = i; } });
        vline.setAttribute('x1', coords[best][0]); vline.setAttribute('x2', coords[best][0]); vline.setAttribute('visibility', 'visible');
        marker.setAttribute('cx', coords[best][0]); marker.setAttribute('cy', coords[best][1]); marker.setAttribute('visibility', 'visible');
        tip && tip.show(e.clientX, e.clientY, trf('{name}: {value} сум', { name: points[best].label, value: points[best].value.toLocaleString('ru-RU') }));
    });
    svg.addEventListener('mouseleave', () => { vline.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); tip && tip.hide(); });
    return svg;
}
function ownerKpiTile(label, value, sub) {
    return h('div', { style: { background: 'var(--white)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '14px 18px', minWidth: 0 } },
        h('div', { class: 'muted', style: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
        h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 800, color: 'var(--ink-900)', marginTop: '4px', fontVariantNumeric: 'tabular-nums' } }, value),
        sub ? h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, sub) : null);
}

export function renderOwnerCharts(el, d) {
    clear(el);
    if (!d || !d.kpis || (d.kpis.count === 0 && d.monthly.every(m => m.value === 0))) {
        el.appendChild(h('div', { class: 'muted', style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' } },
            'Нет данных за выбранный период. Попробуйте расширить диапазон дат или изменить филиалы.'));
        return;
    }
    const tip = ownerTip();
    // The tooltip node lives on document.body — remove it when the builder overlay goes away.
    const obs = new MutationObserver(() => { if (!el.isConnected) { tip.destroy(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } },
        ownerKpiTile('Общая выручка', d.kpis.revenue.toLocaleString('ru-RU') + ' ' + tr('сум'), 'за выбранный период'),
        ownerKpiTile('Услуг оказано', d.kpis.count.toLocaleString('ru-RU'), 'без отменённых'),
        ownerKpiTile('Средний чек', d.kpis.avg.toLocaleString('ru-RU') + ' ' + tr('сум'), 'выручка / услуги')));
    el.appendChild(h('div', { style: { marginTop: '14px' } },
        ownerCard('Выручка по месяцам', 'последние 12 месяцев — независимо от выбранного периода', ownerLine(d.monthly, { tip }))));
    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '14px' } },
        ownerCard('Выручка по группам услуг', 'за выбранный период', d.byGroup.length ? ownerBars(d.byGroup, { tip }) : h('div', { class: 'muted' }, 'Нет данных.')),
        ownerCard('Поступления по плательщикам', 'кто покрывает услуги — за выбранный период', d.byPayer.length ? ownerBars(d.byPayer, { tip }) : h('div', { class: 'muted' }, 'Нет данных.'))));
}

// ---------------------------------------------------------------------------
// REPORTS_HUB_V1 — the Reports page shows report CARDS; clicking one opens a
// full-screen builder: period presets (today / week / month / custom) +
// branch picker on top, live preview ("mirror") of the generated rows below,
// and a Download .xlsx action once generated.
// ---------------------------------------------------------------------------

// INVOICES_REPORT_V1 — «Счета»: one row per invoice — sums, discount, paid,
// remaining debt, status, payer, registrar. Same period/branch semantics as
// the revenue report (select-all branches = no filter, NULL-branch rows kept).
export const INVOICE_COLUMNS = [
    { key: 'number',    label: '№ счёта' },
    { key: 'created',   label: 'Дата' },
    { key: 'patient',   label: 'Пациент' },
    { key: 'mrn',       label: 'МРН' },
    { key: 'phone',     label: 'Телефон' },
    { key: 'branch',    label: 'Филиал' },
    { key: 'payer',     label: 'Кто платит' },
    { key: 'subtotal',  label: 'Сумма без скидки' },
    { key: 'discount',  label: 'Скидка' },
    { key: 'total',     label: 'Итого' },
    { key: 'paid',      label: 'Оплачено' },
    { key: 'owed',      label: 'Остаток / долг' },
    { key: 'status',    label: 'Статус' },
    { key: 'method',    label: 'Способ оплаты' },   // INVOICE_METHOD_COLUMN_V1
    { key: 'paid_at',   label: 'Дата оплаты' },
    { key: 'registrar', label: 'Регистратор' },
];

const INV_STATUS_RU = { unpaid: 'Не оплачен', partial: 'Частично', paid: 'Оплачен', refunded: 'Возврат', void: 'Отменён', cancelled: 'Отменён', debt: 'Долг' };

export async function buildInvoicesReport({ branchId, branchIds, clinicId, fromIso, toIso }) {
    let q = supabase.from('invoices')
        .select(`id, invoice_number, created_at, paid_at, status, subtotal, discount_amount, total_amount, paid_amount,
            coverage_type, created_by, branch_id,
            patients ( full_name, mrn, phone ), branches ( name ), payers ( name )`)
        .gte('created_at', fromIso).lte('created_at', toIso)
        .order('created_at', { ascending: false })
        .limit(10000);
    if (clinicId) q = q.eq('company_id', clinicId);
    if (Array.isArray(branchIds) && branchIds.length > 0) q = q.in('branch_id', branchIds);
    else if (branchId && branchId !== 'all') q = q.eq('branch_id', branchId);
    const { data, error } = await q;
    if (error) { console.warn('[invoices report]', error.message); toast(trf('Не удалось получить счета: {msg}', { msg: error.message }), 'fail'); return []; }
    const rows = data || [];
    const regIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))];
    const regsRes = regIds.length ? await supabase.from('users').select('id, full_name').in('id', regIds) : { data: [] };
    const regById = Object.fromEntries((regsRes.data || []).map(u => [u.id, u.full_name]));
    const methodsByInvoice = await loadInvoiceMethods(rows.map(r => r.id));
    const dt = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return rows.map(r => {
        const total = Number(r.total_amount || 0), paid = Number(r.paid_amount || 0);
        return {
            number:    r.invoice_number || r.id.slice(0, 8),
            created:   dt(r.created_at),
            patient:   r.patients?.full_name || '',
            mrn:       r.patients?.mrn || '',
            phone:     r.patients?.phone || '',
            branch:    r.branches?.name || '',
            payer:     r.payers?.name || (r.coverage_type === 'patient' || !r.coverage_type ? 'Пациент' : r.coverage_type),
            subtotal:  Number(r.subtotal || 0),
            discount:  Number(r.discount_amount || 0),
            total, paid,
            owed:      Math.max(total - paid, 0),
            status:    INV_STATUS_RU[r.status] || r.status || '',
            method:    formatMethods(methodsByInvoice[r.id]),   // INVOICE_METHOD_COLUMN_V1
            paid_at:   dt(r.paid_at),
            registrar: regById[r.created_by] || '',
        };
    });
}

// INVOICE_METHOD_COLUMN_V1 — методы оплаты по счетам периода.
//
// payments has no date filter in the registry (filters: id, invoice_id, method,
// shift_id), so the only way in is by invoice id — and the report allows up to
// 10 000 invoices. Sent in chunks so the IN list never approaches SQLite's bound
// parameter limit: one oversized query would fail the WHOLE report, and a
// missing «Способ оплаты» must never cost the clinic the rest of the columns.
//
// A failed chunk is logged and skipped for the same reason: those invoices show
// an empty method, the report still renders.
async function loadInvoiceMethods(invoiceIds) {
    const ids = [...new Set((invoiceIds || []).filter(v => v != null))];
    const byInvoice = {};
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { data, error } = await supabase.from('payments').select('invoice_id, method').in('invoice_id', slice);
        if (error) { console.warn('[invoices report] methods:', error.message); continue; }
        for (const p of data || []) {
            (byInvoice[p.invoice_id] || (byInvoice[p.invoice_id] = [])).push(p.method);
        }
    }
    return byInvoice;
}

async function downloadInvoicesXlsx(rows, filenameBase = 'invoices') {
    if (!rows.length) { toast('Нет счетов за период.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const matrix = [INVOICE_COLUMNS.map(c => c.label), ...rows.map(r => INVOICE_COLUMNS.map(c => r[c.key] == null ? '' : r[c.key]))];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    ws['!cols'] = INVOICE_COLUMNS.map(c => ({ wch: /Пациент|Регистратор|платит|Дата/.test(c.label) ? 22 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
    XLSX.writeFile(wb, `${filenameBase}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ---------------------------------------------------------------------------
// SURGERY_RENTAB_V1 — «Рентабельность операций»: по каждой операции из счетов
// периода — сумма счёта, налог, гонорар хирурга, ВСЕ израсходованные товары
// госпитализации (в счёте и вне его — полная расходная часть), прибыль и маржа.
// Хирургия = services.type 'other' (каталожная метка «Хирургия») или именованный
// тип услуги с «хирург/операц» в названии.
// ---------------------------------------------------------------------------
const SURGERY_COLUMNS = [
    { key: 'patient_id',        label: 'Patient ID' },
    { key: 'patient_full_name', label: 'Пациент' },
    { key: 'service_name',      label: 'Операция' },
    { key: 'invoiced',          label: 'Сумма по счёту' },
    { key: 'tax_rate',          label: 'Ставка налога (%)' },
    { key: 'tax_amount',        label: 'Налог' },
    { key: 'surgeon_wage',      label: 'Гонорар хирурга' },
    { key: 'products_total',    label: 'Расходники (товары)' },
    { key: 'net_profit',        label: 'Прибыль клиники' },
    { key: 'margin_pct',        label: 'Маржа (%)' },
];

const SURGERY_TYPE_RE = /хирург|surg|операц|operat/i;

async function buildSurgeryReport({ period, branchId, branchIds, clinicId, fromIso, toIso }) {
    if (!fromIso || !toIso) [fromIso, toIso] = periodWindow(period);
    let q = supabase.from('invoice_items')
        .select(`
            id, invoice_id, service_id, description, quantity, unit_price, discount_percentage, total,
            services ( id, name, type, tax_rate, default_doctor_percent, type_id ),
            invoices!inner (
                id, invoice_number, admission_id, patient_id, branch_id, created_at,
                patients ( id, mrn, full_name )
            )
        `)
        .not('service_id', 'is', null)
        .gte('invoices.created_at', fromIso)
        .lte('invoices.created_at', toIso)
        .limit(10000);
    if (clinicId) q = q.eq('company_id', clinicId);
    if (Array.isArray(branchIds) && branchIds.length > 0) q = q.in('invoices.branch_id', branchIds);
    else if (branchId && branchId !== 'all') q = q.eq('invoices.branch_id', branchId);

    const { data: rawItems, error } = await q;
    if (error) throw new Error('invoice_items load: ' + error.message);
    const items = (rawItems || []).filter(r => r.invoices && r.services);

    // Named surgery types (some clinics use a «Хирургия» service type instead
    // of the built-in 'other' bucket).
    const typeIds = [...new Set(items.map(r => r.services?.type_id).filter(Boolean))];
    const typesRes = typeIds.length ? await supabase.from('service_types').select('id, name').in('id', typeIds) : { data: [] };
    const typeNameById = Object.fromEntries((typesRes.data || []).map(t => [t.id, t.name || '']));

    const surgeries = items.filter(r =>
        r.services.type === 'other' || SURGERY_TYPE_RE.test(typeNameById[r.services.type_id] || ''));
    if (surgeries.length === 0) return [];

    // The FULL expense side: every product consumed during the admission,
    // billable or not, invoiced or not.
    const admissionIds = [...new Set(surgeries.map(r => r.invoices.admission_id).filter(Boolean))];
    const prodByAdmission = {};
    if (admissionIds.length) {
        const { data: prod } = await supabase.from('admission_services')
            .select('admission_id, total, clinic_item_id')
            .in('admission_id', admissionIds)
            .not('clinic_item_id', 'is', null)
            .limit(10000);
        for (const pr of (prod || [])) {
            prodByAdmission[pr.admission_id] = (prodByAdmission[pr.admission_id] || 0) + Number(pr.total || 0);
        }
    }

    // Several surgery lines can share one admission — its product cost is
    // charged to the first line only so totals never double-count.
    const admissionUsed = new Set();
    return surgeries.map(ii => {
        const inv = ii.invoices, svc = ii.services;
        const qty = Number(ii.quantity ?? 1);
        const amount = Number(ii.unit_price ?? 0) * qty;
        const discPct = Number(ii.discount_percentage ?? 0);
        const invoiced = amount - amount * discPct / 100;
        const taxRate = Number(svc.tax_rate ?? 0);
        // VAT_INCLUSIVE_V1 — the invoiced price already includes VAT; extract the
        // embedded tax (rate/(100+rate)) instead of adding rate% on top.
        const taxAmt = taxRate > 0 ? invoiced * taxRate / (100 + taxRate) : 0;
        const wagePct = Number(svc.default_doctor_percent ?? 0);
        // DOCTOR_SHARE_AFTER_TAX_V1 — гонорар от суммы ПОСЛЕ налога. Строкой ниже
        // тот же налог вычитается из прибыли клиники (net), поэтому на прежнем
        // расчёте клиника отдавала его дважды: государству и в базу гонорара.
        const wage = (invoiced - taxAmt) * wagePct / 100;
        let products = 0;
        if (inv.admission_id && !admissionUsed.has(inv.admission_id)) {
            admissionUsed.add(inv.admission_id);
            products = prodByAdmission[inv.admission_id] || 0;
        }
        const net = invoiced - taxAmt - wage - products;
        return {
            patient_id:        inv.patients?.mrn || '',
            patient_full_name: inv.patients?.full_name || '',
            service_name:      svc.name || ii.description || '',
            invoiced:          Math.round(invoiced),
            tax_rate:          taxRate,
            tax_amount:        Math.round(taxAmt),
            surgeon_wage:      Math.round(wage),
            products_total:    Math.round(products),
            net_profit:        Math.round(net),
            margin_pct:        invoiced > 0 ? Math.round(net / invoiced * 1000) / 10 : 0,
        };
    });
}

async function downloadSurgeryXlsx(rows, filenameBase = 'surgery-rentability') {
    if (rows.length === 0) { toast('Нет операций за выбранный период.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const header = SURGERY_COLUMNS.map(c => c.label);
    const dataMatrix = [header, ...rows.map(r => SURGERY_COLUMNS.map(c => r[c.key] == null ? '' : r[c.key]))];
    const ws = XLSX.utils.aoa_to_sheet(dataMatrix);
    ws['!cols'] = SURGERY_COLUMNS.map(c => ({ wch: Math.max(c.label.length + 2, /Пациент|Операция/.test(c.label) ? 26 : 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Surgery rentability');
    XLSX.writeFile(wb, `${filenameBase}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// PROCUREMENT_REPORT_V1 — «Закупки»: одна строка на позицию заказа поставщику
// (purchase_order_items ⋈ purchase_orders ⋈ suppliers ⋈ clinic_items).
export const PO_COLUMNS = [
    { key: 'po',       label: 'PO' },
    { key: 'product',  label: 'Товар' },
    { key: 'supplier', label: 'Поставщик' },
    { key: 'qty',      label: 'Количество' },
    { key: 'sum',      label: 'Сумма' },
];

export async function buildProcurementReport({ branchId, branchIds, clinicId, fromIso, toIso }) {
    let q = supabase.from('purchase_order_items')
        .select(`id, qty_ordered, unit_cost, line_total,
            purchase_orders!inner ( po_number, created_at, branch_id, company_id, suppliers ( name ) ),
            clinic_items ( name, strength, form )`)
        .gte('purchase_orders.created_at', fromIso)
        .lte('purchase_orders.created_at', toIso)
        .limit(10000);
    if (clinicId) q = q.eq('purchase_orders.company_id', clinicId);
    if (Array.isArray(branchIds) && branchIds.length > 0) q = q.in('purchase_orders.branch_id', branchIds);
    else if (branchId && branchId !== 'all') q = q.eq('purchase_orders.branch_id', branchId);
    const { data, error } = await q;
    if (error) { console.warn('[procurement report]', error.message); toast(trf('Не удалось получить закупки: {msg}', { msg: error.message }), 'fail'); return []; }
    return (data || []).map(r => ({
        po:       r.purchase_orders?.po_number || '',
        product:  [r.clinic_items?.name, [r.clinic_items?.strength, r.clinic_items?.form].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
        supplier: r.purchase_orders?.suppliers?.name || '',
        qty:      Number(r.qty_ordered || 0),
        sum:      r.line_total != null ? Number(r.line_total) : Number(r.qty_ordered || 0) * Number(r.unit_cost || 0),
    })).sort((a, b) => String(b.po).localeCompare(String(a.po)));
}

async function downloadProcurementXlsx(rows, filenameBase = 'procurement') {
    if (!rows.length) { toast('Нет закупок за период.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const matrix = [PO_COLUMNS.map(c => c.label), ...rows.map(r => PO_COLUMNS.map(c => r[c.key] == null ? '' : r[c.key]))];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    ws['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 24 }, { wch: 12 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Procurement');
    XLSX.writeFile(wb, `${filenameBase}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Registry of available reports. Each entry: how to build rows + how to
// download them. Add future reports (doctor payroll, cash…) here.
const REPORTS = [
    {
        key:   'total-revenue',
        icon:  'Chart',
        title: 'Общая выручка',
        desc:  'Каждая строка счёта: пациент, услуга, цена, скидка и налог, доля врача, филиал, регистратор, реферал и выплата.',
        columns: REVENUE_COLUMNS,
        build: (opts) => buildRevenueReport(opts),
        download: (rows) => downloadRevenueXlsx(rows, 'total-revenue'),
    },
    {   // REFERRAL_REWARDS_V1
        key:   'referrals',
        icon:  'Coins',
        title: 'Рефералы',
        desc:  'Вознаграждение по источникам направлений: услуги, суммы и расчёт % по группам (режим «Общий» или «Вручную»).',
        columns: REFERRAL_COLUMNS,
        build: (opts) => buildReferralReport(opts),
        download: (rows) => downloadReferralsXlsx(rows, 'referrals'),
    },
    {   // INVOICES_REPORT_V1
        key:   'invoices',
        icon:  'Receipt',
        title: 'Счета',
        desc:  'Все счета за период: суммы, скидки, оплачено, остаток/долг, статус, плательщик и регистратор.',
        columns: INVOICE_COLUMNS,
        build: (opts) => buildInvoicesReport(opts),
        download: (rows) => downloadInvoicesXlsx(rows, 'invoices'),
    },
    {   // PROCUREMENT_REPORT_V1
        key:   'procurement',
        icon:  'Layers',
        title: 'Закупки',
        desc:  'Позиции заказов поставщикам: PO, товар, поставщик, количество и сумма.',
        columns: PO_COLUMNS,
        build: (opts) => buildProcurementReport(opts),
        download: (rows) => downloadProcurementXlsx(rows, 'procurement'),
    },
    {   // SURGERY_RENTAB_V1
        key:   'surgery-rentability',
        icon:  'Activity',
        title: 'Рентабельность операций',
        desc:  'По каждой операции: сумма счёта, налог, гонорар хирурга, израсходованные товары (в счёте и вне его), прибыль клиники и маржа %.',
        columns: SURGERY_COLUMNS,
        build: (opts) => buildSurgeryReport(opts),
        download: (rows) => downloadSurgeryXlsx(rows, 'surgery-rentability'),
    },
    {   // OWNER_REPORT_V1 — charts, no xlsx
        key:   'owner',
        icon:  'TrendingUp',
        title: 'Отчёт владельца',
        desc:  'Графики: общая выручка, выручка по группам услуг, динамика по месяцам и поступления по плательщикам (пациент / ДМС / B2B / госпрограмма).',
        mode:  'charts',
        columns: [],
        build:  (opts) => buildOwnerReport(opts),
        render: (el, data) => renderOwnerCharts(el, data),
    },
];

// Public entry — kept under the legacy name so reports.js needs no changes.
export function renderDownloadsPanel(ctx) {
    return h('div', {
        style: {
            display: 'grid', gap: '14px',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        },
    },
        ...REPORTS.map(rep => reportCard(rep, ctx)),
    );
}

function reportCard(rep, ctx) {
    return h('button', {
        type: 'button',
        onclick: () => openReportBuilder(rep, ctx),
        style: {
            display: 'flex', alignItems: 'flex-start', gap: '14px', textAlign: 'left',
            padding: '18px 20px', background: 'var(--white)',
            border: '1px solid var(--ink-100)', borderRadius: '14px',
            boxShadow: 'var(--shadow-xs)', cursor: 'pointer', fontFamily: 'inherit',
            transition: 'border-color .12s, box-shadow .12s, transform .12s',
        },
        onmouseenter: (e) => { e.currentTarget.style.borderColor = 'var(--primary-300)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; },
        onmouseleave: (e) => { e.currentTarget.style.borderColor = 'var(--ink-100)'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-xs)'; },
    },
        h('div', {
            style: {
                width: '40px', height: '40px', borderRadius: '11px', flex: '0 0 auto',
                background: 'var(--primary-50)', color: 'var(--primary-700)',
                display: 'grid', placeItems: 'center',
            },
        }, Icon(rep.icon || 'Download', { size: 18 })),
        h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--ink-900)' } }, rep.title),
            h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px', lineHeight: 1.45 } }, rep.desc),
            h('div', { style: { marginTop: '10px', fontSize: '12px', fontWeight: 600, color: 'var(--primary-700)', display: 'inline-flex', alignItems: 'center', gap: '5px' } },
                'Открыть отчёт ', Icon('ArrowRight', { size: 12 })),
        ),
    );
}

// ---------------------------------------------------------------------------
// Full-screen builder
// ---------------------------------------------------------------------------
const PRESETS = [
    { id: 'today',  label: 'Сегодня' },
    { id: 'week',   label: 'Эта неделя' },
    { id: 'month',  label: 'Этот месяц' },
    { id: 'custom', label: 'Произвольный' },
];

function presetToInputs(preset) {
    // Reuse periodWindow for the shared presets; 'week' there means "last 7
    // days" which matches the chip's intent well enough for reporting.
    const [fromIso, toIso] = periodWindow(preset === 'custom' ? 'month' : preset);
    return [isoToDateInput(fromIso), isoToDateInput(toIso)];
}

async function openReportBuilder(rep, ctx) {
    const clinicId = ctx.getClinicId();

    // ---- state ----
    const st = {
        preset: 'month',
        fromInput: '', toInput: '',
        branches: [], branchIds: new Set(),
        rows: null,          // last generated rows (null = not generated yet)
        generating: false,
    };
    [st.fromInput, st.toInput] = presetToInputs('month');

    // ---- shell ----
    const overlay = h('div', {
        style: {
            position: 'fixed', inset: '0', zIndex: '150',
            background: 'var(--ink-25, #f6f8f9)',
            display: 'flex', flexDirection: 'column',
        },
    });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    // Header
    overlay.appendChild(h('header', {
        style: {
            display: 'flex', alignItems: 'center', gap: '14px',
            padding: '14px 22px', background: 'var(--white)',
            borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
        },
    },
        h('div', {
            style: { width: '36px', height: '36px', borderRadius: '10px', background: 'var(--primary-50)', color: 'var(--primary-700)', display: 'grid', placeItems: 'center' },
        }, Icon(rep.icon || 'Download', { size: 17 })),
        h('div', null,
            h('div', { style: { fontSize: '16px', fontWeight: 700, color: 'var(--ink-900)' } }, rep.title),
            h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Выберите период и филиалы, затем сформируйте отчёт'),
        ),
        h('span', { style: { flex: 1 } }),
        // REPORT_CLOSE_RED_V1 — the close control must be unmissable
        h('button', {
            class: 'btn',
            style: {
                fontSize: '13.5px', fontWeight: '700',
                background: '#dc2626', borderColor: '#dc2626', color: 'white',
                padding: '9px 18px', borderRadius: '10px',
                boxShadow: '0 2px 8px rgba(220,38,38,0.35)',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = '#b91c1c'; },
            onmouseleave: (e) => { e.currentTarget.style.background = '#dc2626'; },
            onclick: close,
        }, '✕ Закрыть'),
    ));

    // ---- setup panel ----
    const fromInp = h('input', { type: 'date', value: st.fromInput, style: dateInputStyle() });
    const toInp   = h('input', { type: 'date', value: st.toInput,   style: dateInputStyle() });
    fromInp.addEventListener('change', () => { st.fromInput = fromInp.value; });
    toInp.addEventListener('change',   () => { st.toInput   = toInp.value;   });

    // REPORT_HDR_ONELINE_V1 — the date inputs live in their own wrap and are
    // shown ONLY on «Произвольный»; the presets already imply the range.
    const dateWrap = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
        fromInp, h('span', { class: 'muted', style: { fontSize: '12px' } }, '→'), toInp);
    function syncDateEditability() {
        const editable = st.preset === 'custom';
        dateWrap.style.display = editable ? 'flex' : 'none';
        for (const inp of [fromInp, toInp]) {
            inp.disabled = !editable;
            inp.style.background = editable ? 'white' : 'var(--ink-50, #f3f5f7)';
            inp.style.color      = editable ? 'var(--ink-900)' : 'var(--ink-500)';
            inp.style.cursor     = editable ? 'auto' : 'not-allowed';
        }
    }

    const presetsEl = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
    function paintPresets() {
        clear(presetsEl);
        for (const p of PRESETS) {
            presetsEl.appendChild(h('button', {
                type: 'button',
                style: {
                    height: '32px', padding: '0 14px', borderRadius: '999px', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
                    border: '1px solid ' + (st.preset === p.id ? 'var(--primary-600)' : 'var(--ink-200)'),
                    background: st.preset === p.id ? 'var(--primary-600)' : 'var(--white)',
                    color: st.preset === p.id ? '#fff' : 'var(--ink-700)',
                    transition: 'background .1s, border-color .1s, color .1s',
                },
                onclick: () => {
                    st.preset = p.id;
                    if (p.id !== 'custom') {
                        [st.fromInput, st.toInput] = presetToInputs(p.id);
                        fromInp.value = st.fromInput;
                        toInp.value   = st.toInput;
                    }
                    paintPresets();
                    syncDateEditability();
                },
            }, p.label));
        }
    }
    paintPresets();
    syncDateEditability();

    // Branch checklist (async-loaded)
    const branchListEl = h('div', {
        style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: '4px 14px', padding: '5px 10px', minHeight: '32px',
            background: 'var(--white)', border: '1px solid var(--ink-100)',
            borderRadius: '10px', maxHeight: '64px', overflow: 'auto', maxWidth: '440px',
        },
    }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Загрузка филиалов…'));
    const masterCb  = h('input', { type: 'checkbox' });
    const summaryEl = h('span', { class: 'muted', style: { fontSize: '11.5px' } });

    function refreshBranchUI() {
        const total = st.branches.length;
        const picked = st.branchIds.size;
        if (picked === 0) { masterCb.checked = false; masterCb.indeterminate = false; }
        else if (picked === total) { masterCb.checked = true; masterCb.indeterminate = false; }
        else { masterCb.checked = false; masterCb.indeterminate = true; }
        summaryEl.textContent = total === 0 ? ''
            : picked === 0 ? tr('Филиалы не выбраны')
            : picked === total ? trf('Все филиалы ({total})', { total })
            : trf('{n} из {max}', { n: picked, max: total });
    }
    masterCb.addEventListener('change', () => {
        if (masterCb.checked) st.branches.forEach(b => st.branchIds.add(b.id));
        else                  st.branchIds.clear();
        branchListEl.querySelectorAll('input[data-branch-id]').forEach(cb => {
            cb.checked = st.branchIds.has(cb.dataset.branchId);
        });
        refreshBranchUI();
    });

    async function loadBranchesRobust() {
        // Prefer branch-context (already respects user_branches restrictions);
        // fall back to a direct clinic-scoped query when it's empty (e.g. the
        // context failed to init or the user has no assignment rows).
        let list = (ctx.getBranches?.() || []);
        if (!list.length && clinicId) {
            const { data } = await supabase.from('branches')
                .select('id, name').eq('company_id', clinicId).eq('active', true).order('name');
            list = data || [];
        }
        st.branches = list;
        st.branchIds = new Set(list.map(b => b.id));
        clear(branchListEl);
        if (!list.length) {
            branchListEl.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } },
                'Филиалы не найдены — отчёт будет сформирован по всей клинике.'));
        } else {
            for (const b of list) {
                const cb = h('input', {
                    type: 'checkbox', checked: true, dataset: { branchId: b.id },
                    onchange: (e) => {
                        if (e.target.checked) st.branchIds.add(b.id);
                        else                  st.branchIds.delete(b.id);
                        refreshBranchUI();
                    },
                });
                branchListEl.appendChild(h('label', {
                    style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: 'var(--ink-800)', cursor: 'pointer' },
                }, cb, h('span', null, b.name)));
            }
        }
        refreshBranchUI();
    }
    loadBranchesRobust();

    // Generate + download actions
    const downloadBtn = h('button', {
        class: 'btn', disabled: true,
        onclick: async (ev) => {
            if (!st.rows || !st.rows.length) return;
            ev.currentTarget.disabled = true;
            try { await rep.download(st.rows); }
            catch (e) { console.error('[reports-hub] download:', e); toast(trf('Не удалось скачать: {msg}', { msg: e.message || e }), 'fail'); }
            finally { ev.currentTarget.disabled = false; }
        },
    }, Icon('Download', { size: 14 }), ' Скачать Excel');
    if (!rep.download) downloadBtn.style.display = 'none';   // OWNER_REPORT_V1 — chart reports have no xlsx

    const generateBtn = h('button', {
        class: 'btn btn-primary',
        onclick: () => generate(),
    }, Icon('Refresh', { size: 14 }), h('span', { class: 'gen-lbl' }, ' Сформировать отчёт'));

    async function generate() {
        if (st.generating) return;
        st.generating = true;
        generateBtn.disabled = true;
        generateBtn.querySelector('.gen-lbl').textContent = ' Формируем…';
        paintPreviewLoading();
        try {
            const rows = await rep.build({
                fromIso:   dateInputToStartIso(st.fromInput),
                toIso:     dateInputToEndIso(st.toInput),
                // REVENUE_BRANCH_NULL_FIX — pass the branch filter only for a PROPER subset:
                // all-selected (or none) = no filter, so invoices with branch_id NULL stay in.
                branchIds: (st.branchIds.size && st.branchIds.size < st.branches.length) ? [...st.branchIds] : [],
                clinicId,
                period:    'month',   // unused when fromIso/toIso are explicit
            });
            st.rows = rows;
            downloadBtn.disabled = !rep.download || !Array.isArray(rows) || rows.length === 0;   // OWNER_REPORT_V1 — chart data is an object
            paintPreview();
        } catch (e) {
            console.error('[reports-hub] generate:', e);
            toast(trf('Не удалось сформировать отчёт: {msg}', { msg: e.message || e }), 'fail');
            paintPreviewEmpty(trf('Ошибка: {msg}', { msg: e.message || e }));
        } finally {
            st.generating = false;
            generateBtn.disabled = false;
            generateBtn.querySelector('.gen-lbl').textContent = ' Сформировать отчёт';
        }
    }

    // REPORT_HDR_ONELINE_V1 — everything on ONE compact line: presets, dates
    // (custom only), a slim branch box, and the actions. Wraps on narrow screens.
    overlay.appendChild(h('div', {
        style: {
            padding: '10px 22px', background: 'var(--white)',
            borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
            display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center',
        },
    },
        hubLabel('Период', true),
        presetsEl,
        dateWrap,
        hubLabel('Филиалы', true),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ink-700)', cursor: 'pointer', whiteSpace: 'nowrap' } },
            masterCb, h('span', null, 'Выбрать все')),
        branchListEl,
        summaryEl,
        h('span', { style: { flex: '1 1 auto' } }),
        h('div', { class: 'row', style: { gap: '8px', flex: '0 0 auto' } },
            generateBtn,
            downloadBtn,
        ),
    ));

    // ---- preview ("mirror") ----
    const previewEl = h('div', {
        style: { flex: '1 1 auto', overflow: 'auto', padding: '16px 22px' },
    });
    overlay.appendChild(previewEl);

    function paintPreviewEmpty(msg) {
        clear(previewEl);
        previewEl.appendChild(h('div', {
            class: 'muted',
            style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' },
        }, msg || 'Настройте период и филиалы, затем нажмите «Сформировать отчёт» — данные появятся здесь.'));
    }
    function paintPreviewLoading() {
        clear(previewEl);
        previewEl.appendChild(h('div', {
            class: 'muted',
            style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' },
        }, 'Формируем отчёт…'));
    }
    function paintPreview() {
        clear(previewEl);
        if (rep.mode === 'charts') { rep.render(previewEl, st.rows); return; }   // OWNER_REPORT_V1
        const rows = st.rows || [];
        if (rows.length === 0) {
            paintPreviewEmpty('Нет данных за выбранный период. Попробуйте расширить диапазон дат или изменить филиалы.');
            return;
        }
        const CAP = 300;
        const shown = rows.slice(0, CAP);
        previewEl.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '10px' } },
            h('span', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } },
                trf('Строк: {n}', { n: rows.length })),
            rows.length > CAP ? h('span', { class: 'muted', style: { fontSize: '12px' } },
                trf('— показаны первые {n}, в Excel попадут все', { n: CAP })) : null,
        ));
        // Wide table in its own horizontal scroller.
        const thStyle = {
            position: 'sticky', top: 0, background: 'var(--ink-50)', zIndex: 1,
            padding: '8px 10px', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.03em', color: 'var(--ink-600)', whiteSpace: 'nowrap', textAlign: 'left',
            borderBottom: '1px solid var(--ink-150, var(--ink-200))',
        };
        // REPORT_TH_ALIGN_V1 — a numeric column right-aligns its HEADER too, so
        // the value sits directly under its field name instead of drifting right.
        const isNumCol = {};
        for (const c of rep.columns) {
            const probe = shown.find(r => r[c.key] != null && r[c.key] !== '');
            isNumCol[c.key] = typeof (probe && probe[c.key]) === 'number';
        }
        // REPORT_TOTALS_V1 — итог по ВСЕМ строкам отчёта, а не по видимым 300.
        const totals = reportTotals(
            rep.columns, rows,
            (r, c) => r[c.key],
            (c) => isNumCol[c.key]);
        const hasTotals = totals.some(v => v != null);

                // REPORT_TOTALS_V1 — «Итого» прилипает к низу таблицы: при 300
                // строках в скроллере итог, лежащий под ними, не виден без
                // прокрутки в самый конец, а нужен он как раз при взгляде на
                // список целиком.
                const footTd = (content, isNum) => h('td', { style: {
                    padding: '9px 10px', whiteSpace: 'nowrap', textAlign: isNum ? 'right' : 'left',
                    fontWeight: 800, fontSize: '12.5px', color: 'var(--ink-900)',
                    fontVariantNumeric: isNum ? 'tabular-nums' : 'normal',
                    background: 'var(--ink-50, #f1f4f5)', borderTop: '2px solid var(--ink-200)',
                    position: 'sticky', bottom: 0,
                } }, content);
        previewEl.appendChild(h('div', {
            style: { overflow: 'auto', maxHeight: 'calc(100vh - 320px)', background: 'var(--white)', border: '1px solid var(--ink-100)', borderRadius: '12px' },
        },
            h('table', { style: { borderCollapse: 'collapse', fontSize: '12px', minWidth: '100%' } },
                h('thead', null, h('tr', null,
                    ...rep.columns.map(c => h('th', { style: { ...thStyle, textAlign: isNumCol[c.key] ? 'right' : 'left' } }, c.label)),
                )),
                h('tbody', null, ...shown.map((r, i) => h('tr', {
                    style: { background: i % 2 ? 'var(--ink-25, #fafafa)' : 'var(--white)' },
                },
                    ...rep.columns.map(c => {
                        const v = r[c.key];
                        const isNum = typeof v === 'number';
                        return h('td', {
                            style: {
                                padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--ink-800)',
                                textAlign: isNum ? 'right' : 'left',
                                fontVariantNumeric: isNum ? 'tabular-nums' : 'normal',
                                borderBottom: '1px solid var(--ink-50)',
                            },
                        }, v == null || v === '' ? '—' : (isNum ? Number(v).toLocaleString('ru-RU') : String(v)));
                    }),
                ))),
                hasTotals ? h('tfoot', null, h('tr', null,
                    ...rep.columns.map((c, ci) => footTd(
                        ci === 0 ? 'Итого' : (totals[ci] == null ? '' : Number(totals[ci]).toLocaleString('ru-RU')),
                        isNumCol[c.key]))
                )) : null,
            ),
        ));
    }
    paintPreviewEmpty();

    document.body.appendChild(overlay);
}

function hubLabel(text, inline) {
    return h('div', {
        style: {
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--ink-500)',
            marginBottom: inline ? 0 : '6px',
        },
    }, text);
}

function dateInputStyle() {
    return {
        height: '34px', padding: '0 10px', flex: '1 1 130px', maxWidth: '160px',
        border: '1px solid var(--ink-200)', borderRadius: '8px',
        fontSize: '12.5px', fontFamily: 'inherit', background: 'white',
    };
}
