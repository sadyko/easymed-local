// JOURNALS_V1 — правила журналов без базы: таблица примеров.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  birthYear, JOURNAL_SERVICE_MAX, KINDS_OF_CARE, parseServiceIds, parseKindOfCare, genderWord, dayMinus,
  dedupeJournalLines, sortJournalLines, patientOrdinals, indexRecommendations, referrerOf,
  diagnosisOfBody, consultDiagnosis, referralDiagnosis, conclusionOfDoc,
  ruDay, journalConclusion, RESULTS_RELEASED_T, DONE_WORD,   // JOURNALS_V1_CONCLUSION
} from './journal-rules.js';

test('год рождения — первые четыре знака даты, если это год', () => {
  assert.equal(birthYear('1971-07-03'), '1971');
  assert.equal(birthYear('1971'), '1971');
  assert.equal(birthYear(null), '');
  assert.equal(birthYear(''), '');
  assert.equal(birthYear('03.07.1971'), '');
});

const RU = new Intl.Collator('ru');
const cmp = (a, b) => RU.compare(String(a || ''), String(b || ''));

test('выбор услуг: числа и числа-строки без повторов; пусто и мусор — «empty»; больше 2000 — «too_many»', () => {
  assert.equal(JOURNAL_SERVICE_MAX, 2000);
  assert.deepEqual(parseServiceIds([3, '7', 3, ' 9 ']), { error: null, ids: [3, 7, 9] });
  for (const bad of [undefined, null, 'abc', 5, [], [null, 'x', -1, 0, 1.5, {}, true]]) {
    assert.deepEqual(parseServiceIds(bad), { error: 'empty', ids: [] }, JSON.stringify(bad));
  }
  assert.equal(parseServiceIds(Array.from({ length: 2001 }, (_, i) => i + 1)).error, 'too_many');
  assert.equal(parseServiceIds(Array.from({ length: 2000 }, (_, i) => i + 1)).ids.length, 2000);
});

test('тип: пусто — «все»; три значения; прочее — отказ (null)', () => {
  assert.deepEqual([...KINDS_OF_CARE], ['all', 'inpatient', 'outpatient']);
  assert.equal(parseKindOfCare(undefined), 'all');
  assert.equal(parseKindOfCare(''), 'all');
  assert.equal(parseKindOfCare('inpatient'), 'inpatient');
  assert.equal(parseKindOfCare('outpatient'), 'outpatient');
  assert.equal(parseKindOfCare('day'), null);
});

test('пол словом; день минус N дней', () => {
  assert.equal(genderWord('male'), 'Муж.');
  assert.equal(genderWord('female'), 'Жен.');
  assert.equal(genderWord('other'), '');
  assert.equal(dayMinus('2026-03-13', 30), '2026-02-11');
  assert.equal(dayMinus('2026-03-01', 1), '2026-02-28');
  assert.equal(dayMinus('мусор', 1), '');
});

test('одна работа: строка визита и строки случая одного пациента, услуги и дня — остаётся строка визита, со случаем', () => {
  const lines = [
    { src: 'vs', line_id: 2, patient_id: 1, service_id: 1, day: '2026-03-10', admission_id: null },
    { src: 'as', line_id: 7, patient_id: 1, service_id: 1, day: '2026-03-10', admission_id: 5 },
    { src: 'as', line_id: 6, patient_id: 1, service_id: 1, day: '2026-03-10', admission_id: 5 },
    { src: 'as', line_id: 8, patient_id: 1, service_id: 1, day: '2026-03-11', admission_id: 5 },
    { src: 'as', line_id: 9, patient_id: 2, service_id: 1, day: '2026-03-10', admission_id: 6 },
  ];
  const out = dedupeJournalLines(lines);
  assert.deepEqual(out.map((l) => l.src + l.line_id), ['vs2', 'as8', 'as9']);
  assert.equal(out[0].admission_id, 5, 'строка визита — стационарная: в этот день есть строка случая');
});

test('порядок: дата, ФИО, услуга; номер пациента — по первому появлению', () => {
  const lines = sortJournalLines([
    { src: 'vs', line_id: 3, patient_id: 2, patient: 'Бекова', service: 'ЭКГ', day: '2026-03-02' },
    { src: 'vs', line_id: 1, patient_id: 1, patient: 'Азизов', service: 'УЗИ', day: '2026-03-02' },
    { src: 'as', line_id: 4, patient_id: 1, patient: 'Азизов', service: 'ЭКГ', day: '2026-03-01' },
    { src: 'vs', line_id: 2, patient_id: 2, patient: 'Бекова', service: 'УЗИ', day: '2026-03-02' },
  ], cmp);
  assert.deepEqual(lines.map((l) => l.line_id), [4, 1, 2, 3]);
  assert.deepEqual(patientOrdinals(lines), [1, 1, 2, 2]);
  assert.deepEqual(patientOrdinals([{ patient_id: 7 }, { patient_id: 8 }, { patient_id: 7 }, { patient_id: 9 }]), [1, 2, 1, 3]);
});

test('кто направил: стационар — лечащий или «Стационар»; амбулатория — ближайшая рекомендация не позже дня, иначе источник визита, иначе «сам»', () => {
  const recs = indexRecommendations([   // новые сначала, как отдаёт запрос
    { patient_id: 1, service_id: 1, day: '2026-03-12', doctor_id: 4, name: 'Кардиолог К.К.' },
    { patient_id: 1, service_id: 1, day: '2026-03-05', doctor_id: 2, name: 'Терапевт Т.Т.' },
    { patient_id: 1, service_id: 1, day: '2026-03-04', doctor_id: null, name: '  ' },
  ]);
  const out = (extra) => ({ admission_id: null, patient_id: 1, service_id: 1, day: '2026-03-09', visit_source: null, visit_source_doctor_id: null, ...extra });
  assert.deepEqual(referrerOf({ admission_id: 3 }, recs, { attending: 'Лечащий Л.Л.', attending_doctor_id: 3 }), { text: 'Лечащий Л.Л.', doctorId: 3 });
  assert.deepEqual(referrerOf({ admission_id: 3 }, recs, { attending: null, attending_doctor_id: null }), { text: 'Стационар', doctorId: null });
  assert.deepEqual(referrerOf(out(), recs, null), { text: 'Терапевт Т.Т.', doctorId: 2 });
  assert.deepEqual(referrerOf(out({ day: '2026-03-13' }), recs, null), { text: 'Кардиолог К.К.', doctorId: 4 });
  assert.deepEqual(referrerOf(out({ day: '2026-03-01', visit_source: 'Клиника «Шифо»' }), recs, null), { text: 'Клиника «Шифо»', doctorId: null });
  assert.deepEqual(referrerOf(out({ day: '2026-03-01', visit_source: 'Кардиолог К.К.', visit_source_doctor_id: 4 }), recs, null), { text: 'Кардиолог К.К.', doctorId: 4 });
  assert.deepEqual(referrerOf(out({ service_id: 2 }), recs, null), { text: 'сам', doctorId: null });
});

test('диагноз консультации: основной «код — название», иначе dx; тот же врач, не раньше 30 дней и не позже дня', () => {
  assert.equal(diagnosisOfBody({ diagnoses: JSON.stringify([{ code: 'K29', name: 'Гастрит', type: 'concomitant' }, { code: 'R10.4', name: 'Боль в животе', type: 'main' }]), dx: 'x' }), 'R10.4 — Боль в животе');
  assert.equal(diagnosisOfBody({ diagnoses: [{ code: '', name: 'Без кода', type: 'main' }] }), 'Без кода');
  assert.equal(diagnosisOfBody({ diagnoses: 'битый json', dx: ' I20 — Стенокардия ' }), 'I20 — Стенокардия');
  assert.equal(diagnosisOfBody({}), '');
  const docs = [   // новые сначала
    { patient_id: 1, doctor_id: 2, day: '2026-03-10', text: 'позже визита' },
    { patient_id: 1, doctor_id: 2, day: '2026-03-09', text: 'R10.4 — Боль в животе' },
    { patient_id: 1, doctor_id: 4, day: '2026-02-01', text: 'I25 — ИБС' },
  ];
  assert.equal(consultDiagnosis(docs, 1, 2, '2026-03-09'), 'R10.4 — Боль в животе');
  assert.equal(consultDiagnosis(docs, 1, 4, '2026-03-13'), '', 'консультация старше 30 дней');
  assert.equal(consultDiagnosis(docs, 1, 4, '2026-03-02'), 'I25 — ИБС');
  assert.equal(consultDiagnosis(docs, 1, null, '2026-03-09'), '', 'направил не врач');
  assert.equal(consultDiagnosis(docs, 2, 2, '2026-03-09'), '', 'другой пациент');
});

test('диагноз строки: стационар — при поступлении, иначе осмотр; амбулатория — консультация направившего', () => {
  const adm = { admission_diagnosis: '', review_diagnosis: 'I10 — Гипертензия' };
  assert.equal(referralDiagnosis({ admission_id: 2 }, adm, { doctorId: null }, []), 'I10 — Гипертензия');
  assert.equal(referralDiagnosis({ admission_id: 2 }, { admission_diagnosis: 'K35.8 — Острый аппендицит', review_diagnosis: 'I10' }, null, []), 'K35.8 — Острый аппендицит');
  const docs = [{ patient_id: 1, doctor_id: 2, day: '2026-03-09', text: 'R10.4 — Боль в животе' }];
  assert.equal(referralDiagnosis({ admission_id: null, patient_id: 1, day: '2026-03-09' }, null, { doctorId: 2 }, docs), 'R10.4 — Боль в животе');
});

// JOURNALS_V1_CONCLUSION (владелец, 02.10): «the fields of the "conclusion" in
// the journal → the "diagnosis" or "conclusion" in the doctors cabinet». Поле
// кабинета «Заключение» (conclusion_text → тело conclusionText; у заключения
// диагностики — conclusion), пустое — «Диагноз» (основной «код — название»,
// иначе dx). «Описание» исследования (description) — не заключение.
test('заключение документа: «Заключение» кабинета, иначе «Диагноз» — основной «код — название», иначе dx; описание — нет', () => {
  assert.equal(conclusionOfDoc({ conclusion: 'Гепатомегалия', description: 'Печень увеличена' }), 'Гепатомегалия');
  assert.equal(conclusionOfDoc({ conclusion: ' ', description: 'Без патологии' }), '', 'описание исследования — не заключение');
  assert.equal(conclusionOfDoc({ conclusionText: 'Синусовый ритм', dx: 'I49' }), 'Синусовый ритм');
  assert.equal(conclusionOfDoc({ conclusionText: '  ', diagnoses: JSON.stringify([{ code: 'I20.8', name: 'Стенокардия напряжения', type: 'main' }]), dx: 'Стенокардия' }),
    'I20.8 — Стенокардия напряжения', 'пустое «Заключение» — основной диагноз');
  assert.equal(conclusionOfDoc({ dx: 'I49' }), 'I49');
  assert.equal(conclusionOfDoc({}), '');
  assert.equal(conclusionOfDoc(null), '');
});

test('заключение строки: документ врача, иначе у анализа — «Результаты выданы дд.мм.гггг», у прочего — «Выполнено»; иначе пусто', () => {
  assert.equal(RESULTS_RELEASED_T, 'Результаты выданы {date}');
  assert.equal(DONE_WORD, 'Выполнено');
  assert.equal(ruDay('2026-03-19'), '19.03.2026');
  assert.equal(ruDay(null), '');
  assert.equal(ruDay('мусор'), '');
  const blank = { text: '', template: null, params: null };
  // а. Подписанный документ — всегда первым, и у анализа тоже.
  assert.deepEqual(journalConclusion({ done: 1, released_day: '2026-03-19' }, ' Гепатомегалия ', true), { text: 'Гепатомегалия', template: null, params: null });
  // б. Анализ без документа: выдан — день выдачи шаблоном; не выдан — пусто, даже если «completed».
  assert.deepEqual(journalConclusion({ done: 1, released_day: '2026-03-19' }, '', true),
    { text: 'Результаты выданы 19.03.2026', template: 'Результаты выданы {date}', params: { date: '19.03.2026' } });
  assert.deepEqual(journalConclusion({ done: 1, released_day: null }, '', true), blank);
  // в. Прочая услуга без документа: отмечена выполненной — «Выполнено».
  assert.deepEqual(journalConclusion({ done: 1, released_day: null }, '', false), { text: 'Выполнено', template: 'Выполнено', params: {} });
  assert.deepEqual(journalConclusion({ done: 0, released_day: '2026-03-19' }, null, false), blank);
});
