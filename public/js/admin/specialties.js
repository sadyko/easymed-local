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

import { tr, trf, getLang } from './i18n.js';   // I18N_COVERAGE_V1 — суффикс опции собирается вокруг значения, перевод до сборки; REFERENCE_LISTS_V1 — tr/getLang для порядка

// SPECIALTIES_CLONED_V1 — the list itself (a clone of medcore's Specialties
// sheet), the aliases and the canonicaliser live in shared/specialty-list.js
// since DOCTOR_LINES_SPECIALTY_V1: the server groups the «По специальностям»
// report with the same rules, and must not import this file (it pulls i18n).
import { SPECIALTY_ROWS, SPECIALTIES, SPECIALTY_ALIASES, canonicalSpecialty, sortByShownLabel } from '../shared/specialty-list.js?v=spl1';
export { SPECIALTY_ROWS, SPECIALTIES, SPECIALTY_ALIASES, canonicalSpecialty };

// DOCTOR_PROFILE_V1 (ревью шага 5, №10) — НАЗВАНИЕ СПЕЦИАЛЬНОСТИ НА ЯЗЫКЕ ЭКРАНА.
// Одно правило на список «Специальность», шапку и список «Сотрудников», строку
// UZ / EN под списком и «Мой профиль»: название общего справочника
// (SPECIALTY_ROWS — его же отдаёт партнёрам API) по коду, у записи без кода — по
// русскому названию. Не из справочника — как записана: это данные клиники, перевода
// у них нет. entry — код, русское название или { slug, name }.
export function specialtyLabel(entry) {
    const slug = entry && typeof entry === 'object' ? entry.slug : null;
    const name = String((entry && typeof entry === 'object' ? entry.name : entry) || '').trim();
    const row = (slug && SPECIALTY_ROWS.find((r) => r.slug === slug))
        || SPECIALTY_ROWS.find((r) => r.slug === name)
        || SPECIALTY_ROWS.find((r) => r.ru === canonicalSpecialty(name));
    if (!row) return name;
    const lang = getLang();
    return (lang !== 'ru' && row[lang]) || row.ru;
}

// Option pairs [value, label] for a <select>.
//
// `current` is whatever the record already holds. A value typed in before the
// list existed is kept as its own option rather than being dropped: without
// this, opening an old doctor's card would quietly show «— не указана —» and
// saving anything else on the card would erase their speciality. The marker
// tells the admin it is off-list so they can correct it deliberately.
// REFERENCE_LISTS_V1 — пункты по ПОКАЗАННОЙ подписи (перевод на языке
// интерфейса): в uz/en русский порядок выглядел вразнобой. Значение — то же
// русское название.
// DOCTOR_PROFILE_V1 (ревью шага 5, №10) — подпись УЖЕ на языке экрана и из общего
// справочника (specialtyLabel), не из словаря: словарь местами называет ту же
// специальность иначе (en «Internist» — справочник «Internal Medicine
// (Therapist)», uz «Xirurg» — «Jarroh»), и на одной карточке у неё было два
// имени. Вызывающий кладёт подпись текстом (createTextNode), не через h()-перевод.
export function specialtyOptions(current) {
    const opts = [['', tr('— не указана —')], ...sortByShownLabel(SPECIALTIES, specialtyLabel, getLang()).map((s) => [s, specialtyLabel(s)])];
    const cur = canonicalSpecialty(current);
    if (cur && !SPECIALTIES.includes(cur)) opts.splice(1, 0, [cur, trf('{name}  (не из списка)', { name: cur })]);
    return opts;
}
