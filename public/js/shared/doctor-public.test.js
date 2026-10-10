// DOCTOR_PROFILE_V1 — публичный профиль врача: языки, «работает с» и стаж,
// заполненность, кому можно показываться, кого прятать.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOR_LANGS, BOOKING_DAYS, DEFAULT_BOOKING_DAYS, PUBLIC_SLOT_MIN, PREVIEW_DAYS, PRACTICE_SINCE_MIN,
  DOCTOR_PUBLIC_MESSAGES, COMPLETENESS_LABELS,
  normalizeLanguages, readLanguages, languagesProblem, cleanPracticeSince, experienceYears, shownPracticeSince, withExperience,
  profileCompleteness, publicationProblem, doctorPublicState, doctorIsPublic,
} from './doctor-public.js';
import { STRINGS } from '../admin/i18n-strings.js';

const NOW = new Date(2026, 9, 10);

test('постоянные — как в макете: три языка, запись на 7/14/30 (по умолчанию 14), окно 15 минут, превью на 7 дней', () => {
  assert.deepEqual(DOCTOR_LANGS, ['ru', 'uz', 'en']);
  assert.deepEqual(BOOKING_DAYS, [7, 14, 30]);
  assert.equal(DEFAULT_BOOKING_DAYS, 14);
  assert.equal(PUBLIC_SLOT_MIN, 15);
  assert.equal(PREVIEW_DAYS, 7);
  assert.equal(PRACTICE_SINCE_MIN, 1940);
});

test('языки приёма: порядок ru, uz, en без повторов; чужой код и не список — нет; пустой — «нужен хотя бы один»', () => {
  assert.deepEqual(normalizeLanguages(['en', 'ru', 'en']), ['ru', 'en']);
  assert.deepEqual(normalizeLanguages('["uz"]'), ['uz']);
  assert.equal(normalizeLanguages(['de']), null);
  assert.equal(normalizeLanguages('ru'), null);
  assert.deepEqual(readLanguages('мусор'), []);
  assert.deepEqual(readLanguages(null), []);
  assert.deepEqual(readLanguages(['uz', 'ru']), ['ru', 'uz']);
  assert.equal(languagesProblem(['ru', 'uz']), null);
  assert.equal(languagesProblem([]), DOCTOR_PUBLIC_MESSAGES.oneLanguage);
  assert.equal(languagesProblem(['fr']), DOCTOR_PUBLIC_MESSAGES.languages);
});

test('«работает врачом с»: целый год 1940..текущий; пусто — снять; стаж растёт сам', () => {
  assert.deepEqual(cleanPracticeSince('2014', NOW), { value: 2014 });
  assert.deepEqual(cleanPracticeSince('', NOW), { value: null });
  assert.deepEqual(cleanPracticeSince(null, NOW), { value: null });
  for (const bad of [1939, 2027, 2014.5, 'abc']) {
    assert.deepEqual(cleanPracticeSince(bad, NOW), { problem: DOCTOR_PUBLIC_MESSAGES.since }, String(bad));
  }
  assert.equal(experienceYears(2014, NOW), 12);
  assert.equal(experienceYears(2014, new Date(2030, 0, 1)), 16, 'через четыре года стаж больше на четыре');
  assert.equal(experienceYears(null, NOW), null);
  assert.equal(shownPracticeSince({ practice_since: 2010, experience_years: 3 }, NOW), 2010, 'год сильнее прежнего стажа');
  assert.equal(shownPracticeSince({ practice_since: null, experience_years: 12 }, NOW), 2014, 'строка главной старой версии — год из стажа');
  assert.equal(shownPracticeSince({}, NOW), null);
});

test('стаж и год пишутся вместе: пришёл год — стаж из него; пришёл только стаж (экран старой версии) — год из стажа', () => {
  assert.deepEqual(withExperience({ practice_since: 2014, bio_ru: 'x' }, NOW), { practice_since: 2014, bio_ru: 'x', experience_years: 12 });
  assert.deepEqual(withExperience({ practice_since: null }, NOW), { practice_since: null, experience_years: null });
  assert.deepEqual(withExperience({ experience_years: 12 }, NOW), { experience_years: 12, practice_since: 2014 });
  assert.deepEqual(withExperience({ experience_years: null }, NOW), { experience_years: null, practice_since: null });
  assert.deepEqual(withExperience({ bio_ru: 'x' }, NOW), { bio_ru: 'x' });
});

test('заполненность — семь проверок макета: ФИО ×3, специальность, биография ×3', () => {
  const full = { full_name_ru: 'Иванов', full_name_uz: 'Ivanov', full_name_en: 'Ivanov', bio_ru: 'а', bio_uz: 'b', bio_en: 'c' };
  assert.deepEqual(profileCompleteness(full, 1), { pct: 100, missing: [] });
  assert.deepEqual(profileCompleteness({ ...full, full_name_en: ' ', bio_en: '' }, 2), { pct: 71, missing: ['ФИО EN', 'биография EN'] });
  assert.deepEqual(profileCompleteness({}, 0), { pct: 0, missing: ['ФИО RU', 'ФИО UZ', 'ФИО EN', 'специальность', 'биография RU', 'биография UZ', 'биография EN'] });
});

test('показываемый врач — с ФИО на русском и специальностью; скрытому можно всё', () => {
  assert.equal(publicationProblem({ is_public: 0, full_name_ru: '', specialties: 0 }), null);
  assert.equal(publicationProblem({ is_public: 1, full_name_ru: ' ', specialties: 2 }), DOCTOR_PUBLIC_MESSAGES.nameRu);
  assert.equal(publicationProblem({ is_public: true, full_name_ru: 'Иванов', specialties: 0 }), DOCTOR_PUBLIC_MESSAGES.specialty);
  assert.equal(publicationProblem({ is_public: 1, full_name_ru: 'Иванов', specialties: 1 }), null);
});

test('кого видят партнёры: врач по is_doctor, работает, включён, его здание не скрыто', () => {
  const branches = new Map([[5, { id: 5, show_public: 0 }], [6, { id: 6, show_public: 1 }]]);
  const doc = { is_doctor: 1, is_active: 1, is_public: 1, branch_id: 6 };
  assert.equal(doctorPublicState(doc, branches), 'shown');
  assert.equal(doctorIsPublic(doc, branches), true);
  assert.equal(doctorPublicState({ ...doc, is_public: 0 }, branches), 'off');
  assert.equal(doctorPublicState({ ...doc, branch_id: 5 }, branches), 'branch_hidden');
  assert.equal(doctorPublicState({ ...doc, is_active: false }, branches), 'inactive');
  assert.equal(doctorPublicState({ ...doc, is_doctor: 0, role: 'doctor', specialty: 'Кардиолог' }, branches), 'not_doctor',
    'врач — по is_doctor, не по роли и специальности');
  assert.equal(doctorPublicState({ ...doc, is_doctor: true, is_public: true, is_active: true }, branches), 'shown', 'булевы из /api/users — тоже');
});

test('каждое сообщение и подпись заполненности переведены на ru / uz / en', () => {
  for (const m of [...Object.values(DOCTOR_PUBLIC_MESSAGES), ...COMPLETENESS_LABELS]) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});
