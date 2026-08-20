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

export const SPECIALTIES = [
    'Аллерголог-иммунолог',
    'Анестезиолог-реаниматолог',
    'Врач УЗИ',
    'Врач общей практики',
    'Врач функциональной диагностики',
    'Гастроэнтеролог',
    'Гематолог',
    'Гинеколог',
    'Дерматовенеролог',
    'Диетолог',
    'Инфекционист',
    'Кардиолог',
    'Косметолог',
    'Логопед',
    'Маммолог',
    'Мануальный терапевт',
    'Нарколог',
    'Невролог',
    'Нейрохирург',
    'Нефролог',
    'Онколог',
    'Оториноларинголог (ЛОР)',
    'Офтальмолог',
    'Педиатр',
    'Проктолог',
    'Психиатр',
    'Психотерапевт',
    'Пульмонолог',
    'Реабилитолог',
    'Ревматолог',
    'Рентгенолог',
    'Стоматолог',
    'Терапевт',
    'Травматолог-ортопед',
    'Уролог',
    'Физиотерапевт',
    'Флеболог',
    'Хирург',
    'Эндокринолог',
    'Эндоскопист',
];

// Option pairs [value, label] for a <select>.
//
// `current` is whatever the record already holds. A value typed in before the
// list existed is kept as its own option rather than being dropped: without
// this, opening an old doctor's card would quietly show «— не указана —» and
// saving anything else on the card would erase their speciality. The marker
// tells the admin it is off-list so they can correct it deliberately.
export function specialtyOptions(current) {
    const opts = [['', '— не указана —'], ...SPECIALTIES.map((s) => [s, s])];
    const cur = String(current || '').trim();
    if (cur && !SPECIALTIES.includes(cur)) opts.splice(1, 0, [cur, cur + '  (не из списка)']);
    return opts;
}
