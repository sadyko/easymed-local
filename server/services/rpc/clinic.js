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
import { readIdentity } from '../branch-sync/identity.js';   // CLINIC_PROFILE_V1
import { isSquarePngDataUrl } from '../../../public/js/shared/clinic-logo-rules.js';   // CLINIC_PROFILE_V1

export function getClinicBySlug(db, _args, _user) {
  const settings = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};

  return {
    id: 1,
    slug: 'local',
    name: settings.clinic_name || 'Easy-Med Local',
    // CLINIC_PROFILE_V1 — названия на трёх языках и сайт. name — по-прежнему
    // то, что печатается (clinic_name, запасное 'Easy-Med Local'); name_uz /
    // name_en идут наружу и в интерфейс на этих языках (shared/company-branding.js
    // печатает name_ru || name — то же clinic_name). Сайт — для интерфейса и
    // партнёров: на бланках он не печатается (ответ владельца 2026-10-10,
    // company-branding.js его в бланк не переносит).
    name_ru: settings.clinic_name || null,
    name_uz: settings.name_uz || null,
    name_en: settings.name_en || null,
    website: settings.website || null,
    // CLINIC_PROFILE_V1 — «Компания» в филиале показывает общее только для просмотра.
    building_role: (() => { try { return readIdentity(db).role; } catch { return 'main'; } })(),
    active: true,
    // Fields the upstream trial-banner / branding code reads defensively
    // (clinic?.name, clinic?.plan, clinic?.trial_ends_at, clinic?.is_locked,
    // clinic?.verification_status) — set to values that make every one of
    // those code paths a no-op: no trial banner, never locked, never rejected.
    logo_url: settings.logo_data_url || null,
    // CLINIC_PROFILE_V1 — знак в шапке программы: печатная копия логотипа, если
    // она КВАДРАТНАЯ (квадратный логотип или прежний квадратный). Широкий
    // прежний логотип в знак 30×30 не помещается — тогда знак остаётся «+».
    logo_mark_url: isSquarePngDataUrl(settings.logo_data_url) ? settings.logo_data_url : null,
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
