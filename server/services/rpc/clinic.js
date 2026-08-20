// COMPAT_CLINIC_V1 — get_clinic_by_slug, ported for the ORIGINAL (multi-tenant)
// easymed.uz admin views to run against Easy-Med Local's single-clinic backend.
//
// Upstream (public/js/admin/clinic-context.js) resolves a "clinic" (companies
// row) from the browser's hostname via `supabase.rpc('get_clinic_by_slug', {p_slug})`
// and parks the result on window.CLINIC. Locally there is exactly one clinic
// and no `companies` table, so this returns a single synthetic row built from
// doc_settings (the local clinic's branding/settings singleton, id=1).
//
// Runs pre-auth: admin.js's boot() calls initClinicContext(supabase) BEFORE
// rehydrateUserFromSession() — the app must know which clinic it is before it
// can even render the login screen (clinic name in the header, trial banner,
// verification gate). So `user` may legitimately be null/undefined here; this
// handler does not require one (unlike RPCs that mutate data or read
// role-restricted rows).
export function getClinicBySlug(db, _args, _user) {
  const settings = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};

  return {
    id: 1,
    slug: 'local',
    name: settings.clinic_name || 'Easy-Med Local',
    active: true,
    // Fields the upstream trial-banner / branding code reads defensively
    // (clinic?.name, clinic?.plan, clinic?.trial_ends_at, clinic?.is_locked,
    // clinic?.verification_status) — set to values that make every one of
    // those code paths a no-op: no trial banner, never locked, never rejected.
    logo_url: settings.logo_data_url || null,
    address: settings.address || null,
    phone: settings.phone || null,
    email: settings.email || null,
    // COMPANY_SECTION_V1 — фирменный цвет и реквизиты печати едут вместе с
    // остальной идентичностью клиники. Без них «Компания» меняла название и
    // логотип, а цвет документов оставался прежним: он жил только в
    // doc_branding (дизайнер), и одна клиника имела два разных цвета.
    accent_color: settings.accent_color || null,
    license_number: settings.license || null,
    plan: 'active',
    trial_ends_at: null,
    is_locked: false,
    verification_status: 'verified',
  };
}
