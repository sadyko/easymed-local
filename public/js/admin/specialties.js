// SPECIALTY_LIST_V1 — the clinic's medical specialities, as a closed list.
//
// «Специальность» used to be a free-text box, so the same speciality arrived
// spelled three ways («Кардиология», «кардиолог», «Врач-кардиолог») and nothing
// downstream could group or filter by it. It is now a dropdown fed from here.
//
// The stored value is the LABEL ITSELF, not a slug. Every place that shows a
// doctor's speciality (the booking wizard, the service picker, the doctor
// profile, printed documents) reads users.specialty straight out and prints it,
// so switching to slugs would turn all of those into «cardiology» overnight and
// invalidate the rows already in the database. Keeping label-as-value means this
// change constrains new input without rewriting a single existing record.
//
// Alphabetical: the list is long enough that scan order matters more than any
// notion of importance.

import { trf } from './i18n.js';   // I18N_COVERAGE_V1 — суффикс опции собирается вокруг значения, перевод до сборки

// SPECIALTIES_CLONED_V1 (2026-09-15) — the list is a CLONE of medcore's
// Specialties sheet (50) + Подолог, from «Справочники EasyMed (бланк).xlsx».
// Not fetched from medcore — owner: «it should be only cloned to the
// easymed». Order = the sheet's. The stored value is still the Russian
// label (see above); uz / en come from the dictionary at display time.
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

// Option pairs [value, label] for a <select>.
//
// `current` is whatever the record already holds. A value typed in before the
// list existed is kept as its own option rather than being dropped: without
// this, opening an old doctor's card would quietly show «— не указана —» and
// saving anything else on the card would erase their speciality. The marker
// tells the admin it is off-list so they can correct it deliberately.
export function specialtyOptions(current) {
    const opts = [['', '— не указана —'], ...SPECIALTIES.map((s) => [s, s])];
    const cur = canonicalSpecialty(current);
    if (cur && !SPECIALTIES.includes(cur)) opts.splice(1, 0, [cur, trf('{name}  (не из списка)', { name: cur })]);
    return opts;
}
