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
// JOURNALS_V1_SPECIALTIES (2026-10-02) — two added at the owner's request: «in
// the employees, we need to add 2 specialties, "иглотерапевт" and
// "нейрофизиолог"» — in the sheet's alphabetical places (53 in all).
// REFERENCE_LISTS_V1 (2026-10-06) — владелец: «add another 50+».
// 120 — 53 + 67 по слову владельца 2026-10-06 (REFERENCE_LISTS_V1).
// Новые — на алфавитных местах по русскому названию (localeCompare ru); порядок
// прежних 53 не тронут (Подолог по-прежнему последний). Список всё так же
// встроен в программу, из medcore не читается; сохраняется русское название.
export const SPECIALTY_ROWS = [
    { slug: 'akusher-ginekolog', ru: 'Акушер-гинеколог', uz: 'Akusher-ginekolog', en: 'Obstetrician-Gynecologist' },
    { slug: 'allergolog-immunolog', ru: 'Аллерголог-иммунолог', uz: 'Allergolog-immunolog', en: 'Allergist-Immunologist' },
    { slug: 'angiolog', ru: 'Ангиолог', uz: 'Angiolog', en: 'Angiologist' },
    { slug: 'androlog', ru: 'Андролог', uz: 'Androlog', en: 'Andrologist' },
    { slug: 'anesteziolog-reanimatolog', ru: 'Анестезиолог-реаниматолог', uz: 'Anesteziolog-reanimatolog', en: 'Anesthesiologist-Reanimatologist' },
    { slug: 'audiolog-surdolog', ru: 'Аудиолог-сурдолог', uz: 'Audiolog-surdolog', en: 'Audiologist' },
    { slug: 'bariatricheskiy-hirurg', ru: 'Бариатрический хирург', uz: 'Bariatrik jarroh', en: 'Bariatric Surgeon' },
    { slug: 'vertebrolog', ru: 'Вертебролог', uz: 'Vertebrolog', en: 'Vertebrologist' },
    { slug: 'virusolog', ru: 'Вирусолог', uz: 'Virusolog', en: 'Virologist' },
    { slug: 'kt-mrt', ru: 'Врач КТ и МРТ', uz: 'KT va MRT shifokori', en: 'CT and MRI Radiologist' },
    { slug: 'vrach-lfk', ru: 'Врач ЛФК', uz: 'DJT (davolash jismoniy tarbiyasi) shifokori', en: 'Exercise Therapy Physician' },   // REFERENCE_LISTS_V1 — вычитка uz
    { slug: 'uzi', ru: 'Врач УЗИ', uz: 'UTT shifokori', en: 'Ultrasound (Sonographer)' },
    { slug: 'funkcionalnaya-diagnostika', ru: 'Врач функциональной диагностики', uz: 'Funksional diagnostika shifokori', en: 'Functional Diagnostics' },
    { slug: 'vrach-laborant', ru: 'Врач-лаборант', uz: 'Laboratoriya shifokori', en: 'Clinical Laboratory Physician' },
    { slug: 'gastroenterolog', ru: 'Гастроэнтеролог', uz: 'Gastroenterolog', en: 'Gastroenterologist' },
    { slug: 'gematolog', ru: 'Гематолог', uz: 'Gematolog', en: 'Hematologist' },
    { slug: 'genetik', ru: 'Генетик', uz: 'Genetik', en: 'Geneticist' },
    { slug: 'gepatolog', ru: 'Гепатолог', uz: 'Gepatolog', en: 'Hepatologist' },
    { slug: 'geriatr', ru: 'Гериатр', uz: 'Geriatr', en: 'Geriatrician' },
    { slug: 'ginekolog', ru: 'Гинеколог', uz: 'Ginekolog', en: 'Gynecologist' },
    { slug: 'ginekolog-endokrinolog', ru: 'Гинеколог-эндокринолог', uz: 'Ginekolog-endokrinolog', en: 'Gynecologic Endocrinologist' },
    { slug: 'dermatovenerolog', ru: 'Дерматовенеролог', uz: 'Dermatovenerolog', en: 'Dermatovenereologist' },
    { slug: 'dermatolog', ru: 'Дерматолог', uz: 'Dermatolog', en: 'Dermatologist' },
    { slug: 'detskiy-allergolog', ru: 'Детский аллерголог', uz: 'Bolalar allergologi', en: 'Pediatric Allergist' },
    { slug: 'detskiy-gastroenterolog', ru: 'Детский гастроэнтеролог', uz: 'Bolalar gastroenterologi', en: 'Pediatric Gastroenterologist' },
    { slug: 'detskiy-gematolog', ru: 'Детский гематолог', uz: 'Bolalar gematologi', en: 'Pediatric Hematologist' },
    { slug: 'detskiy-ginekolog', ru: 'Детский гинеколог', uz: 'Bolalar ginekologi', en: 'Pediatric Gynecologist' },
    { slug: 'detskiy-dermatolog', ru: 'Детский дерматолог', uz: 'Bolalar dermatologi', en: 'Pediatric Dermatologist' },
    { slug: 'detskiy-infeksionist', ru: 'Детский инфекционист', uz: 'Bolalar infeksionisti', en: 'Pediatric Infectious Disease Specialist' },
    { slug: 'detskiy-kardiolog', ru: 'Детский кардиолог', uz: 'Bolalar kardiologi', en: 'Pediatric Cardiologist' },
    { slug: 'detskiy-lor', ru: 'Детский ЛОР', uz: 'Bolalar LOR shifokori', en: 'Pediatric ENT' },
    { slug: 'detskiy-nevrolog', ru: 'Детский невролог', uz: 'Bolalar nevrologi', en: 'Pediatric Neurologist' },
    { slug: 'detskiy-nefrolog', ru: 'Детский нефролог', uz: 'Bolalar nefrologi', en: 'Pediatric Nephrologist' },
    { slug: 'detskiy-onkolog', ru: 'Детский онколог', uz: 'Bolalar onkologi', en: 'Pediatric Oncologist' },
    { slug: 'detskiy-oftalmolog', ru: 'Детский офтальмолог', uz: 'Bolalar oftalmologi', en: 'Pediatric Ophthalmologist' },
    { slug: 'detskiy-psihiatr', ru: 'Детский психиатр', uz: 'Bolalar psixiatri', en: 'Child Psychiatrist' },
    { slug: 'detskiy-psiholog', ru: 'Детский психолог', uz: 'Bolalar psixologi', en: 'Child Psychologist' },
    { slug: 'detskiy-pulmonolog', ru: 'Детский пульмонолог', uz: 'Bolalar pulmonologi', en: 'Pediatric Pulmonologist' },
    { slug: 'detskiy-revmatolog', ru: 'Детский ревматолог', uz: 'Bolalar revmatologi', en: 'Pediatric Rheumatologist' },
    { slug: 'detskiy-stomatolog', ru: 'Детский стоматолог', uz: 'Bolalar stomatologi', en: 'Pediatric Dentist' },
    { slug: 'detskiy-travmatolog-ortoped', ru: 'Детский травматолог-ортопед', uz: 'Bolalar travmatolog-ortopedi', en: 'Pediatric Orthopedist' },
    { slug: 'detskiy-urolog-androlog', ru: 'Детский уролог-андролог', uz: 'Bolalar urolog-andrologi', en: 'Pediatric Urologist-Andrologist' },
    { slug: 'detskiy-hirurg', ru: 'Детский хирург', uz: 'Bolalar jarrohi', en: 'Pediatric Surgeon' },
    { slug: 'detskiy-endokrinolog', ru: 'Детский эндокринолог', uz: 'Bolalar endokrinologi', en: 'Pediatric Endocrinologist' },
    { slug: 'defektolog', ru: 'Дефектолог', uz: 'Defektolog', en: 'Special Education Specialist (Defectologist)' },   // REFERENCE_LISTS_V1 — вычитка
    { slug: 'dietolog', ru: 'Диетолог', uz: 'Dietolog', en: 'Dietitian' },
    { slug: 'igloterapevt', ru: 'Иглотерапевт', uz: 'Ignaterapevt', en: 'Acupuncturist' },   // JOURNALS_V1_SPECIALTIES — владелец, 02.10
    { slug: 'implantolog', ru: 'Имплантолог', uz: 'Implantolog', en: 'Dental Implantologist' },
    { slug: 'infeksionist', ru: 'Инфекционист', uz: 'Infeksionist', en: 'Infectious Disease Specialist' },
    { slug: 'kardiolog', ru: 'Кардиолог', uz: 'Kardiolog', en: 'Cardiologist' },
    { slug: 'kardiolog-aritmolog', ru: 'Кардиолог-аритмолог', uz: 'Kardiolog-aritmolog', en: 'Cardiac Electrophysiologist' },
    { slug: 'kardiohirurg', ru: 'Кардиохирург', uz: 'Kardiojarroh', en: 'Cardiac Surgeon' },
    { slug: 'kinezioterapevt', ru: 'Кинезиотерапевт', uz: 'Kinezioterapevt', en: 'Kinesiotherapist' },
    { slug: 'kosmetolog', ru: 'Косметолог', uz: 'Kosmetolog', en: 'Cosmetologist' },
    { slug: 'logoped', ru: 'Логопед', uz: 'Logoped', en: 'Speech Therapist' },
    { slug: 'mammolog', ru: 'Маммолог', uz: 'Mammolog', en: 'Mammologist' },
    { slug: 'manualnyy-terapevt', ru: 'Мануальный терапевт', uz: 'Manual terapevt', en: 'Manual Therapist' },
    { slug: 'massazhist', ru: 'Массажист', uz: 'Massajchi', en: 'Massage Therapist' },
    { slug: 'medicinskiy-psiholog', ru: 'Медицинский психолог', uz: 'Tibbiy psixolog', en: 'Clinical Psychologist' },
    { slug: 'mikrobiolog', ru: 'Микробиолог', uz: 'Mikrobiolog', en: 'Microbiologist' },
    { slug: 'narkolog', ru: 'Нарколог', uz: 'Narkolog', en: 'Narcologist' },
    { slug: 'nevrolog', ru: 'Невролог', uz: 'Nevrolog', en: 'Neurologist' },
    { slug: 'neyrofiziolog', ru: 'Нейрофизиолог', uz: 'Neyrofiziolog', en: 'Neurophysiologist' },   // JOURNALS_V1_SPECIALTIES — владелец, 02.10
    { slug: 'neyrohirurg', ru: 'Нейрохирург', uz: 'Neyrojarroh', en: 'Neurosurgeon' },
    { slug: 'neonatolog', ru: 'Неонатолог', uz: 'Neonatolog', en: 'Neonatologist' },
    { slug: 'nefrolog', ru: 'Нефролог', uz: 'Nefrolog', en: 'Nephrologist' },
    { slug: 'nutriciolog', ru: 'Нутрициолог', uz: 'Nutritsiolog', en: 'Nutritionist' },
    { slug: 'onkoginekolog', ru: 'Онкогинеколог', uz: 'Onkoginekolog', en: 'Gynecologic Oncologist' },
    { slug: 'onkolog', ru: 'Онколог', uz: 'Onkolog', en: 'Oncologist' },
    { slug: 'onkolog-mammolog', ru: 'Онколог-маммолог', uz: 'Onkolog-mammolog', en: 'Breast Oncologist' },
    { slug: 'ortodont', ru: 'Ортодонт', uz: 'Ortodont', en: 'Orthodontist' },
    { slug: 'osteopat', ru: 'Остеопат', uz: 'Osteopat', en: 'Osteopath' },
    { slug: 'lor', ru: 'Отоларинголог (ЛОР)', uz: 'Otolaringolog (LOR)', en: 'Otolaryngologist (ENT)' },
    { slug: 'oftalmolog', ru: 'Офтальмолог', uz: 'Oftalmolog', en: 'Ophthalmologist' },
    { slug: 'oftalmohirurg', ru: 'Офтальмохирург', uz: 'Oftalmojarroh', en: 'Ophthalmic Surgeon' },
    { slug: 'parazitolog', ru: 'Паразитолог', uz: 'Parazitolog', en: 'Parasitologist' },
    { slug: 'parodontolog', ru: 'Пародонтолог', uz: 'Parodontolog', en: 'Periodontist' },
    { slug: 'pediatr', ru: 'Педиатр', uz: 'Pediatr', en: 'Pediatrician' },
    { slug: 'plasticheskiy-hirurg', ru: 'Пластический хирург', uz: 'Plastik jarroh', en: 'Plastic Surgeon' },
    { slug: 'proktolog', ru: 'Проктолог', uz: 'Proktolog', en: 'Proctologist' },
    { slug: 'profpatolog', ru: 'Профпатолог', uz: 'Kasb patologi (profpatolog)', en: 'Occupational Medicine Physician' },   // REFERENCE_LISTS_V1 — вычитка uz
    { slug: 'psihiatr', ru: 'Психиатр', uz: 'Psixiatr', en: 'Psychiatrist' },
    { slug: 'psihoterapevt', ru: 'Психотерапевт', uz: 'Psixoterapevt', en: 'Psychotherapist' },
    { slug: 'pulmonolog', ru: 'Пульмонолог', uz: 'Pulmonolog', en: 'Pulmonologist' },
    { slug: 'radioterapevt', ru: 'Радиотерапевт', uz: 'Radioterapevt', en: 'Radiation Oncologist' },
    { slug: 'reabilitolog', ru: 'Реабилитолог', uz: 'Reabilitolog', en: 'Rehabilitation Specialist' },
    { slug: 'revmatolog', ru: 'Ревматолог', uz: 'Revmatolog', en: 'Rheumatologist' },
    { slug: 'rentgenolog', ru: 'Рентгенолог', uz: 'Rentgenolog', en: 'Radiologist' },
    { slug: 'reproduktolog', ru: 'Репродуктолог', uz: 'Reproduktolog', en: 'Reproductologist' },
    { slug: 'seksolog', ru: 'Сексолог', uz: 'Seksolog', en: 'Sexologist' },
    { slug: 'semeynyy-vrach', ru: 'Семейный врач (ВОП)', uz: 'Oilaviy shifokor', en: 'Family Doctor (GP)' },
    { slug: 'somnolog', ru: 'Сомнолог', uz: 'Somnolog', en: 'Sleep Medicine Specialist' },
    { slug: 'sosudistyy-hirurg', ru: 'Сосудистый хирург', uz: 'Qon-tomir jarrohi', en: 'Vascular Surgeon' },
    { slug: 'sportivnyy-vrach', ru: 'Спортивный врач', uz: 'Sport shifokori', en: 'Sports Medicine Physician' },
    { slug: 'stomatolog', ru: 'Стоматолог', uz: 'Stomatolog', en: 'Dentist' },
    { slug: 'stomatolog-gigienist', ru: 'Стоматолог-гигиенист', uz: 'Stomatolog-gigiyenist', en: 'Dental Hygienist' },
    { slug: 'stomatolog-ortoped', ru: 'Стоматолог-ортопед', uz: 'Stomatolog-ortoped', en: 'Prosthodontist' },
    { slug: 'stomatolog-terapevt', ru: 'Стоматолог-терапевт', uz: 'Stomatolog-terapevt', en: 'Restorative Dentist' },
    { slug: 'stomatolog-hirurg', ru: 'Стоматолог-хирург', uz: 'Stomatolog-jarroh', en: 'Dental Surgeon' },
    { slug: 'terapevt', ru: 'Терапевт', uz: 'Terapevt', en: 'Internal Medicine (Therapist)' },
    { slug: 'toksikolog', ru: 'Токсиколог', uz: 'Toksikolog', en: 'Toxicologist' },
    { slug: 'torakalnyy-hirurg', ru: 'Торакальный хирург', uz: 'Torakal jarroh', en: 'Thoracic Surgeon' },
    { slug: 'travmatolog-ortoped', ru: 'Травматолог-ортопед', uz: 'Travmatolog-ortoped', en: 'Traumatologist-Orthopedist' },
    { slug: 'transfuziolog', ru: 'Трансфузиолог', uz: 'Transfuziolog', en: 'Transfusiologist' },
    { slug: 'triholog', ru: 'Трихолог', uz: 'Trixolog', en: 'Trichologist' },
    { slug: 'urolog', ru: 'Уролог', uz: 'Urolog', en: 'Urologist' },
    { slug: 'fizioterapevt', ru: 'Физиотерапевт', uz: 'Fizioterapevt', en: 'Physiotherapist' },
    { slug: 'flebolog', ru: 'Флеболог', uz: 'Flebolog', en: 'Phlebologist' },
    { slug: 'foniatr', ru: 'Фониатр', uz: 'Foniatr', en: 'Phoniatrist' },
    { slug: 'ftiziatr', ru: 'Фтизиатр', uz: 'Ftiziatr', en: 'Phthisiatrician (TB Specialist)' },
    { slug: 'himioterapevt', ru: 'Химиотерапевт', uz: 'Kimyoterapevt', en: 'Medical Oncologist (Chemotherapy)' },   // REFERENCE_LISTS_V1 — вычитка uz
    { slug: 'hirurg', ru: 'Хирург', uz: 'Jarroh', en: 'Surgeon (General)' },
    { slug: 'hirurg-onkolog', ru: 'Хирург-онколог', uz: 'Jarroh-onkolog', en: 'Surgical Oncologist' },
    { slug: 'chelyustno-licevoy-hirurg', ru: 'Челюстно-лицевой хирург', uz: 'Yuz-jag‘ jarrohi', en: 'Maxillofacial Surgeon' },
    { slug: 'embriolog', ru: 'Эмбриолог', uz: 'Embriolog', en: 'Embryologist' },
    { slug: 'endodontist', ru: 'Эндодонтист', uz: 'Endodontist', en: 'Endodontist' },
    { slug: 'endokrinolog', ru: 'Эндокринолог', uz: 'Endokrinolog', en: 'Endocrinologist' },
    { slug: 'endoskopist', ru: 'Эндоскопист', uz: 'Endoskopist', en: 'Endoscopist' },
    { slug: 'epileptolog', ru: 'Эпилептолог', uz: 'Epileptolog', en: 'Epileptologist' },
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
