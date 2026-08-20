// Which settings tables are clinic-scoped (have a company_id column) vs global reference data.
// Allow-list, verified against the EasyMed DB on 2026-06-04. Unknown tables default to NOT
// scoped (RLS-only — the safe pre-existing behavior) so a new/global table can never break a
// section query by filtering on a non-existent company_id column. TENANT_SCOPE_V2
export const CLINIC_SCOPED_TABLES = new Set([
    'beds', 'branches', 'cashback_rules', 'cashiers', 'consultation_types', 'departments',
    'doctor_consultation_prices', 'doctor_prices',
    'doctor_referral_bonuses', 'floors', 'ikpu_codes', 'patient_allergies', 'patient_categories', 'patient_conditions', 'patients',  // SLICE5_MEDCARD
    'payer_policies', 'payers', 'payment_providers', 'positions', 'product_nnm',
    'referral_source_categories', 'referral_sources', 'roles', 'rooms', 'schedule_blocks',
    'clinic_items', 'product_categories', 'product_types',
    'service_categories', 'service_types', 'services', 'users', 'virtual_doctors', 'wards',
    'document_types', 'doc_branding',
    'lab_panels', 'lab_panel_analytes',   // LAB_SETTINGS_V1
]);

// Global (no company_id): companies, countries, regions, districts, signup_requests,
// clinic_signup_requests, platform_settings — left RLS-only.

export function isClinicScopedTable(table) {
    return !!table && CLINIC_SCOPED_TABLES.has(table);
}

// The current clinic's company_id (from the subdomain), or null when there's no clinic context.
export function currentClinicId() {
    return (typeof window !== 'undefined' && window.CLINIC && window.CLINIC.id) || null;
}
