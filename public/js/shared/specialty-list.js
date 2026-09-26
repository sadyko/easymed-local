// DOCTOR_LINES_SPECIALTY_V1 (2026-09-26) — the specialty list and its
// canonicaliser live HERE, in a pure module (no DOM, no i18n), so the server can
// group reports by specialty with the very same rules the employee card saves
// with. It used to sit in admin/specialties.js, which imports the browser i18n
// runtime; the server importing that would drag a screen module into Node.
// admin/specialties.js re-exports everything below, so no screen changes.

// SPECIALTIES_CLONED_V1 (2026-09-15) — the list is a CLONE of medcore's
// Specialties sheet (50) + Подолог, from «Справочники EasyMed (бланк).xlsx».
// Not fetched from medcore — owner: «it should be only cloned to the
// easymed». Order = the sheet's. The stored value is still the Russian
// label (see admin/specialties.js); uz / en come from the dictionary at display time.
export const SPECIALTY_ROWS = [
    { slug: 'akusher-ginekolog', ru: 'Акушер-гинеколог', uz: 'Akusher-ginekolog', en: 'Obstetrician-Gynecologist' },
    { slug: 'allergolog-immunolog', ru: 'Аллерголог-иммунолог', uz: 'Allergolog-immunolog', en: 'Allergist-Immunologist' },
    { slug: 'androlog', ru: 'Андролог', uz: 'Androlog', en: 'Andrologist' },
    { slug: 'anesteziolog-reanimatolog', ru: 'Анестезиолог-реаниматолог', uz: 'Anesteziolog-reanimatolog', en: 'Anesthesiologist-Reanimatologist' },
    { slug: 'uzi', ru: 'Врач УЗИ', uz: 'UTT shifokori', en: 'Ultrasound (Sonographer)' },
    { slug: 'funkcionalnaya-diagnostika', ru: 'Врач функциональной диагностики', uz: 'Funksional diagnostika shifokori', en: 'Functional Diagnostics' },
    { slug: 'gastroenterolog', ru: 'Гастроэнтеролог', uz: 'Gastroenterolog', en: 'Gastroenterologist' },
    { slug: 'gematolog', ru: 'Гематолог', uz: 'Gematolog', en: 'Hematologist' },
    { slug: 'genetik', ru: 'Генетик', uz: 'Genetik', en: 'Geneticist' },
    { slug: 'ginekolog', ru: 'Гинеколог', uz: 'Ginekolog', en: 'Gynecologist' },
    { slug: 'dermatovenerolog', ru: 'Дерматовенеролог', uz: 'Dermatovenerolog', en: 'Dermatovenereologist' },
    { slug: 'dermatolog', ru: 'Дерматолог', uz: 'Dermatolog', en: 'Dermatologist' },
    { slug: 'detskiy-nevrolog', ru: 'Детский невролог', uz: 'Bolalar nevrologi', en: 'Pediatric Neurologist' },
    { slug: 'detskiy-stomatolog', ru: 'Детский стоматолог', uz: 'Bolalar stomatologi', en: 'Pediatric Dentist' },
    { slug: 'detskiy-hirurg', ru: 'Детский хирург', uz: 'Bolalar jarrohi', en: 'Pediatric Surgeon' },
    { slug: 'dietolog', ru: 'Диетолог', uz: 'Dietolog', en: 'Dietitian' },
    { slug: 'infeksionist', ru: 'Инфекционист', uz: 'Infeksionist', en: 'Infectious Disease Specialist' },
    { slug: 'kardiolog', ru: 'Кардиолог', uz: 'Kardiolog', en: 'Cardiologist' },
    { slug: 'kardiohirurg', ru: 'Кардиохирург', uz: 'Kardiojarroh', en: 'Cardiac Surgeon' },
    { slug: 'logoped', ru: 'Логопед', uz: 'Logoped', en: 'Speech Therapist' },
    { slug: 'mammolog', ru: 'Маммолог', uz: 'Mammolog', en: 'Mammologist' },
    { slug: 'narkolog', ru: 'Нарколог', uz: 'Narkolog', en: 'Narcologist' },
    { slug: 'nevrolog', ru: 'Невролог', uz: 'Nevrolog', en: 'Neurologist' },
    { slug: 'neyrohirurg', ru: 'Нейрохирург', uz: 'Neyrojarroh', en: 'Neurosurgeon' },
    { slug: 'nefrolog', ru: 'Нефролог', uz: 'Nefrolog', en: 'Nephrologist' },
    { slug: 'onkolog', ru: 'Онколог', uz: 'Onkolog', en: 'Oncologist' },
    { slug: 'ortodont', ru: 'Ортодонт', uz: 'Ortodont', en: 'Orthodontist' },
    { slug: 'lor', ru: 'Отоларинголог (ЛОР)', uz: 'Otolaringolog (LOR)', en: 'Otolaryngologist (ENT)' },
    { slug: 'oftalmolog', ru: 'Офтальмолог', uz: 'Oftalmolog', en: 'Ophthalmologist' },
    { slug: 'pediatr', ru: 'Педиатр', uz: 'Pediatr', en: 'Pediatrician' },
    { slug: 'plasticheskiy-hirurg', ru: 'Пластический хирург', uz: 'Plastik jarroh', en: 'Plastic Surgeon' },
    { slug: 'proktolog', ru: 'Проктолог', uz: 'Proktolog', en: 'Proctologist' },
    { slug: 'psihiatr', ru: 'Психиатр', uz: 'Psixiatr', en: 'Psychiatrist' },
    { slug: 'psihoterapevt', ru: 'Психотерапевт', uz: 'Psixoterapevt', en: 'Psychotherapist' },
    { slug: 'pulmonolog', ru: 'Пульмонолог', uz: 'Pulmonolog', en: 'Pulmonologist' },
    { slug: 'reabilitolog', ru: 'Реабилитолог', uz: 'Reabilitolog', en: 'Rehabilitation Specialist' },
    { slug: 'revmatolog', ru: 'Ревматолог', uz: 'Revmatolog', en: 'Rheumatologist' },
    { slug: 'rentgenolog', ru: 'Рентгенолог', uz: 'Rentgenolog', en: 'Radiologist' },
    { slug: 'reproduktolog', ru: 'Репродуктолог', uz: 'Reproduktolog', en: 'Reproductologist' },
    { slug: 'semeynyy-vrach', ru: 'Семейный врач (ВОП)', uz: 'Oilaviy shifokor', en: 'Family Doctor (GP)' },
    { slug: 'sosudistyy-hirurg', ru: 'Сосудистый хирург', uz: 'Qon-tomir jarrohi', en: 'Vascular Surgeon' },
    { slug: 'stomatolog', ru: 'Стоматолог', uz: 'Stomatolog', en: 'Dentist' },
    { slug: 'stomatolog-hirurg', ru: 'Стоматолог-хирург', uz: 'Stomatolog-jarroh', en: 'Dental Surgeon' },
    { slug: 'terapevt', ru: 'Терапевт', uz: 'Terapevt', en: 'Internal Medicine (Therapist)' },
    { slug: 'travmatolog-ortoped', ru: 'Травматолог-ортопед', uz: 'Travmatolog-ortoped', en: 'Traumatologist-Orthopedist' },
    { slug: 'urolog', ru: 'Уролог', uz: 'Urolog', en: 'Urologist' },
    { slug: 'fizioterapevt', ru: 'Физиотерапевт', uz: 'Fizioterapevt', en: 'Physiotherapist' },
    { slug: 'flebolog', ru: 'Флеболог', uz: 'Flebolog', en: 'Phlebologist' },
    { slug: 'hirurg', ru: 'Хирург', uz: 'Jarroh', en: 'Surgeon (General)' },
    { slug: 'endokrinolog', ru: 'Эндокринолог', uz: 'Endokrinolog', en: 'Endocrinologist' },
    { slug: 'podolog', ru: 'Подолог', uz: 'Podolog', en: 'Podologist' },
];
export const SPECIALTIES = SPECIALTY_ROWS.map((r) => r.ru);

// Names the old list used that medcore spells differently: a doctor saved with
// one of these is shown — and re-saved — under the medcore name.
export const SPECIALTY_ALIASES = {
    'Оториноларинголог (ЛОР)': 'Отоларинголог (ЛОР)',
    'ЛОР': 'Отоларинголог (ЛОР)',
    'Врач общей практики': 'Семейный врач (ВОП)',
    'Врач УЗД': 'Врач УЗИ',
};
export const canonicalSpecialty = (v) => SPECIALTY_ALIASES[String(v || '').trim()] || String(v || '').trim();

// DOCTOR_LINES_SPECIALTY_V1 — the name a REPORT groups a doctor under. Wider than
// canonicalSpecialty (which only maps the known old spellings, and whose output
// is SAVED): an alias or a list label typed in another case («кардиолог», «лор»)
// lands in the list label too, so one specialty never splits into two groups.
// Off-list values are kept as typed (trimmed); empty stays empty.
const ALIAS_BY_LOWER = new Map(Object.entries(SPECIALTY_ALIASES).map(([k, v]) => [k.toLowerCase(), v]));
const LABEL_BY_LOWER = new Map(SPECIALTIES.map((s) => [s.toLowerCase(), s]));
export function specialtyGroupName(v) {
    const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
    if (!s) return '';
    const low = s.toLowerCase();
    return ALIAS_BY_LOWER.get(low) || LABEL_BY_LOWER.get(low) || s;
}
