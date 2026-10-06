// CLINIC_API_FIX_V1 — реквизиты клиники поверх оформления документа: ОДНО
// правило для печати в браузере (views/doc-settings.js) и для PDF в Telegram
// (server/services/telegram/render.js).
//
// Раньше правило жило в двух копиях: applyCompanyBranding() в браузере и её
// ручной повтор на сервере. Копии расходились: сервер клал логотип «Компании»
// в logoDataUrl (поле собственного логотипа дизайнера) и оставлял logoUrl из
// сохранённой копии «Документов» — Telegram слал документы со старым
// логотипом; чистку старых заготовок сервер не делал вовсе. Модуль чистый:
// без window, document, базы и перевода — его импортируют и браузер, и Node.

// V3120_FIX — у клиники без адреса, телефона или почты в «Компании» бланк
// печатал КОНТАКТЫ ПОСТАВЩИКА: «Tashkent, 12 Amir Temur Ave.», «+998 71 200 12
// 00», «hello@easy-med.uz». Пациент звонил бы по чужому номеру. Заготовки
// пустые, а пустое поле бланк не печатает вовсе.
//
// Заготовки подвала были английскими и печатались на каждом русском бланке.
// Теперь подвал — только текст, который клиника вписала сама.
//
// saveDocSettings() хранит объект ЦЕЛИКОМ, заготовки тоже, поэтому у клиник,
// сохранявших «Документы», старые значения лежат в настройках (и в
// doc_branding, который читает сервер). LEGACY_DEFAULTS вычищает именно их (и
// только их) при чтении.
export const LEGACY_DEFAULTS = Object.freeze({
    clinicName: 'Easy-Med Clinic',
    address:    'Tashkent, 12 Amir Temur Ave., 100000',
    phone:      '+998 71 200 12 00',
    email:      'hello@easy-med.uz',
    footerNote: 'Thank you for choosing our clinic. Please keep this document for your records.',
    legalNote:  'This document is generated electronically and is valid without a manual signature when sealed with a digital signature.',
});
// Прежняя заготовка подзаголовка — считается «не задано».
export const LEGACY_TAGLINE = 'Care, clarity, precision';

// Чистка сохранённых настроек от старых заготовок. Меняет и возвращает `s`.
//   • variant — всегда объект;
//   • заготовки поставщика (LEGACY_DEFAULTS) — пусто, только при точном совпадении;
//   • язык 'en' — 'ru' (V3120_FIX: печатные бланки русские);
//   • прежний подзаголовок — пусто.
export function clearLegacyDocSettings(s) {
    if (!s.variant || typeof s.variant !== 'object') s.variant = {};
    for (const [k, v] of Object.entries(LEGACY_DEFAULTS)) if (s[k] === v) s[k] = '';
    if (s.language === 'en') s.language = 'ru';
    if (s.tagline === LEGACY_TAGLINE) s.tagline = '';
    return s;
}

// COMPANY_BRANDING_UNIFY: запись клиники («Компания», в браузере — window.CLINIC,
// на сервере — rpc/clinic.js getClinicBySlug) — источник реквизитов и логотипа;
// настройки «Документов» владеют оформлением и заполняют пробелы. Меняет и
// возвращает `s`.
//   • ручной режим «Документов» (useCompanyIdentity === false) — реквизиты
//     дизайнера главнее; логотип «Компании» снимается, и logoMark() печатает
//     собственный логотип дизайнера (logoDataUrl);
//   • иначе заполненные поля клиники перекрывают копию, пустые её не стирают;
//     logoUrl — всегда логотип клиники (или ничего), logoDataUrl не трогается.
export function overlayCompanyBranding(s, clinic) {
    const c = clinic || null;
    if (s.useCompanyIdentity === false) { s.logoUrl = null; return s; }
    if (!c) return s;
    if (c.name_ru || c.name) s.clinicName = c.name_ru || c.name;
    if (c.address)           s.address    = c.address;
    if (c.phone)             s.phone      = c.phone;
    if (c.email)             s.email      = c.email;
    if (c.website)           s.web        = c.website;
    if (c.tax_id)            s.taxId      = c.tax_id;
    if (c.license_number)    s.license    = c.license_number;
    if (c.legal_name)        s.legalName  = c.legal_name;
    // COMPANY_SECTION_V1 — фирменный цвет тоже принадлежит клинике, а не
    // отдельному шаблону: выбранный в «Компании» он применяется во всех
    // печатных формах сразу. Тумблер «Данные клиники из раздела «Компания»»
    // по-прежнему позволяет задать свой цвет только для печати.
    if (c.accent_color)      s.accent     = c.accent_color;
    s.logoUrl = c.logo_url || null;
    return s;
}

// Сохранённые настройки документа → настройки для печати: чистка заготовок,
// затем реквизиты клиники сверху. Этим путём идут и loadDocSettings() в
// браузере, и loadServerDocSettings() для Telegram.
export function resolveDocSettings(s, clinic) {
    return overlayCompanyBranding(clearLegacyDocSettings(s), clinic);
}
