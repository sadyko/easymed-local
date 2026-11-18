import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeName, firstNameOf, phoneKey, idKey, namesMatch,
  duplicateGroups, duplicateIdSet, mrnOrder, mrnSeriesRefusal,
  // PATIENT_DUP_RULE_V3 — «возможные дубликаты»
  dobKey, nameParts, fullNameKey, pairKey, possibleDuplicateGroups, duplicateScan, POSSIBLE_REASONS,
  levenshtein, withinOneEdit, memoNormalizer,
} from './patient-duplicates.js';

// ---------------------------------------------------------------------------
// normalizeName / firstNameOf
// ---------------------------------------------------------------------------
test('normalizeName: case, ё/е and punctuation do not decide identity', () => {
  assert.equal(normalizeName('  Азиз  '), 'азиз');
  assert.equal(normalizeName('АЗИЗ'), 'азиз');
  assert.equal(normalizeName('Фёдор'), 'федор');
  assert.equal(normalizeName('Абдулла-Азиз'), 'абдулла азиз');
  assert.equal(normalizeName(null), '');
});

test('firstNameOf: explicit first_name wins', () => {
  assert.equal(firstNameOf({ first_name: 'Азиз', full_name: 'Каримов Дилшод' }), 'азиз');
});

test('firstNameOf: falls back to full_name using the «Фамилия Имя» reading', () => {
  assert.equal(firstNameOf({ full_name: 'Каримов Азиз Рустамович' }), 'азиз');
  assert.equal(firstNameOf({ full_name: 'Каримов Азиз' }), 'азиз');
  assert.equal(firstNameOf({ full_name: 'Азиз' }), 'азиз', 'one word IS the first name');
  assert.equal(firstNameOf({}), '');
});

// ---------------------------------------------------------------------------
// phoneKey / idKey
// ---------------------------------------------------------------------------
test('phoneKey: every spelling of one number collapses to one key', () => {
  const key = phoneKey('+998 95 076 80 08');
  assert.equal(phoneKey('998950768008'), key);
  assert.equal(phoneKey('95 076 80 08'), key);
  assert.equal(phoneKey('+998-95-076-80-08'), key);
});

test('phoneKey: junk phones never group', () => {
  for (const junk of ['', null, '0', '123', '00000']) assert.equal(phoneKey(junk), '');
});

test('idKey: separators dropped, passport letters kept', () => {
  assert.equal(idKey('AA 1234567'), 'AA1234567');
  assert.equal(idKey('123-456-789-01234'), '12345678901234');
  assert.equal(idKey('12'), '', 'too short to identify anyone');
  assert.equal(idKey(null), '');
});

// ---------------------------------------------------------------------------
// namesMatch
// ---------------------------------------------------------------------------
test('namesMatch: same name in any spelling', () => {
  assert.ok(namesMatch('Азиз', 'азиз'));
  assert.ok(namesMatch('Фёдор', 'Федор'));
});

test('namesMatch: one typo in a long name still matches', () => {
  assert.ok(namesMatch('Дилшод', 'Дилшот'));
  assert.ok(namesMatch('Мухаммад', 'Мухамад'));
});

test('namesMatch: different names do not match', () => {
  assert.ok(!namesMatch('Азиз', 'Дилноза'));
  assert.ok(!namesMatch('Али', 'Аля'), 'short names get no typo tolerance');
  assert.ok(!namesMatch('Олег', 'Олеся'));
});

test('namesMatch: a blank name proves nothing', () => {
  assert.ok(!namesMatch('', 'Азиз'));
  assert.ok(!namesMatch('', ''));
  assert.ok(!namesMatch(null, undefined));
});

// ---------------------------------------------------------------------------
// duplicateGroups — THE rule
// ---------------------------------------------------------------------------
const PHONE = '+998 90 123 45 67';

test('a family on one phone is NOT a pile of duplicates', () => {
  // The bug this rule replaces: same surname + same number flagged everyone.
  const rows = [
    { id: 1, phone: PHONE, first_name: 'Азиз',    last_name: 'Каримов' },
    { id: 2, phone: PHONE, first_name: 'Дилноза', last_name: 'Каримова' },
    { id: 3, phone: PHONE, first_name: 'Рустам',  last_name: 'Каримов' },
    { id: 4, phone: PHONE, first_name: 'Малика',  last_name: 'Каримова' },
  ];
  assert.deepEqual(duplicateGroups(rows), []);
  assert.equal(duplicateIdSet(rows).size, 0);
});

test('the same first name twice on one phone IS a duplicate', () => {
  const rows = [
    { id: 1, phone: PHONE, first_name: 'Азиз',    last_name: 'Каримов' },
    { id: 2, phone: PHONE, first_name: 'Дилноза', last_name: 'Каримова' },
    { id: 3, phone: PHONE, first_name: 'Азиз',    last_name: 'Karimov' },
  ];
  const groups = duplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort(), [1, 3], 'only the two Азиз cards, not the sister');
});

test('a different SURNAME never breaks a match, and never makes one', () => {
  const rows = [
    // Same person, surname typed differently on the second visit.
    { id: 1, phone: PHONE, first_name: 'Азиз', last_name: 'Каримов' },
    { id: 2, phone: PHONE, first_name: 'Азиз', last_name: 'Karimov' },
    // Same surname, same phone, different person.
    { id: 3, phone: PHONE, first_name: 'Малика', last_name: 'Каримов' },
  ];
  assert.deepEqual(duplicateIdSet(rows), new Set([1, 2]));
});

test('same first name on DIFFERENT phones is not a duplicate', () => {
  const rows = [
    { id: 1, phone: '+998 90 111 11 11', first_name: 'Азиз' },
    { id: 2, phone: '+998 90 222 22 22', first_name: 'Азиз' },
  ];
  assert.deepEqual(duplicateGroups(rows), []);
});

test('phone written in different formats still groups', () => {
  const rows = [
    { id: 1, phone: '+998 90 123 45 67', first_name: 'Азиз' },
    { id: 2, phone: '901234567',         first_name: 'Азиз' },
  ];
  assert.deepEqual(duplicateIdSet(rows), new Set([1, 2]));
});

test('a typo in the first name on one phone still groups', () => {
  const rows = [
    { id: 1, phone: PHONE, first_name: 'Дилшод' },
    { id: 2, phone: PHONE, first_name: 'Дилшот' },
  ];
  assert.deepEqual(duplicateIdSet(rows), new Set([1, 2]));
});

test('same PINFL alone is a duplicate — no phone needed', () => {
  const rows = [
    { id: 1, national_id: '12345678901234', phone: '+998 90 111 11 11', first_name: 'Азиз' },
    { id: 2, national_id: '1234 5678 9012 34', phone: '+998 90 222 22 22', first_name: 'Aziz' },
  ];
  assert.deepEqual(duplicateIdSet(rows), new Set([1, 2]));
});

test('blank phone / blank PINFL never group cards together', () => {
  const rows = [
    { id: 1, phone: '', national_id: '', first_name: 'Азиз' },
    { id: 2, phone: null, national_id: null, first_name: 'Азиз' },
    { id: 3, phone: '   ', national_id: '-', first_name: 'Азиз' },
  ];
  assert.deepEqual(duplicateGroups(rows), []);
});

test('rows with no first name at all are left alone rather than guessed at', () => {
  const rows = [
    { id: 1, phone: PHONE, first_name: '' },
    { id: 2, phone: PHONE, first_name: '' },
  ];
  assert.deepEqual(duplicateGroups(rows), []);
});

test('a chain (PINFL then phone+name) forms ONE group, not two pairs', () => {
  const rows = [
    { id: 1, national_id: 'AA1234567', phone: '+998 90 111 11 11', first_name: 'Азиз' },
    { id: 2, national_id: 'AA1234567', phone: '+998 90 222 22 22', first_name: 'Азиз' },
    { id: 3, national_id: '',          phone: '+998 90 222 22 22', first_name: 'Азиз' },
  ];
  const groups = duplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort(), [1, 2, 3]);
});

test('full_name-only records (imported) are read with the same rule', () => {
  const rows = [
    { id: 1, phone: PHONE, full_name: 'Каримов Азиз Рустамович' },
    { id: 2, phone: PHONE, full_name: 'Каримова Дилноза' },
    { id: 3, phone: PHONE, full_name: 'Karimov Азиз' },
  ];
  assert.deepEqual(duplicateIdSet(rows), new Set([1, 3]));
});

test('empty / malformed input never throws', () => {
  assert.deepEqual(duplicateGroups([]), []);
  assert.deepEqual(duplicateGroups(null), []);
  assert.deepEqual(duplicateGroups([null, {}, { phone: PHONE }]), [], 'rows without an id are skipped');
});

// ---------------------------------------------------------------------------
// mrnOrder — MRN_BEYOND_99999_V1: «самая старая карта» по номеру, тем же
// правилом, что у триггера выдачи (миграция 232).
// ---------------------------------------------------------------------------
test('mrnOrder: after 99 999 the number is read whole — A-26-99999 is older than A-26-100000', () => {
  assert.ok(mrnOrder('A-26-99999', 'A-26-100000') < 0, 'text order would say the opposite ("1" < "9")');
  assert.ok(mrnOrder('A-26-100000', 'A-26-99999') > 0);
  assert.ok(mrnOrder('A-26-100001', 'A-26-100000') > 0);
  assert.equal(mrnOrder('A-26-00042', 'A-26-00042'), 0);
});

test('mrnOrder: year first, then the number, across letters — one counter spans P- and A-', () => {
  const sorted = ['A-26-100000', 'P-26-00005', 'A-26-99999', 'A-25-120000', 'AB-26-70128'].sort(mrnOrder);
  assert.deepEqual(sorted, ['A-25-120000', 'P-26-00005', 'AB-26-70128', 'A-26-99999', 'A-26-100000']);
});

test('mrnOrder: hand-typed or missing numbers go after the parsed ones and never throw', () => {
  const sorted = ['без-формата', '', 'A-26-00007', null, 'MRN-08124'].sort(mrnOrder);
  // Parsed first; the rest as text under the fixed 'ru' collation with digit
  // runs as numbers: the empty ones ('' and null read as '') keep their input
  // order (sort is stable), then Cyrillic before Latin — whatever the locale of
  // the machine running this.
  assert.deepEqual(sorted, ['A-26-00007', '', null, 'без-формата', 'MRN-08124']);
  assert.deepEqual(['P-7', 'P-10', 'P-9'].sort(mrnOrder), ['P-7', 'P-9', 'P-10'], 'unparsed: digit runs compare as numbers');
});

// ---------------------------------------------------------------------------
// mrnSeriesRefusal — MRN_BEYOND_99999_V1, review 1: the import window refuses a
// card number that would use up its year's series. The trigger (migration 232)
// counts 0…999 999 999 and refuses to issue past it; one imported placeholder
// 'P-26-999999999' would stop registration for the rest of the year.
// ---------------------------------------------------------------------------
test('mrnSeriesRefusal: 999 999 000 … 999 999 999 in any year is refused, with the reason', () => {
  for (const m of ['P-26-999999000', 'A-26-999999999', 'AB-27-999999500', ' P-26-999999999 ', 'P-26-0999999999']) {
    const why = mrnSeriesRefusal(m);
    assert.equal(typeof why, 'string', m);
    assert.match(why, /999 999 000/);
  }
});

test('mrnSeriesRefusal: ordinary, empty, uncounted and hand-typed numbers pass', () => {
  for (const m of [null, undefined, '', '   ', 'P-26-00042', 'A-26-100000', 'P-26-999998999',
    'P-26-1000000000', 'P-26-99999999999999999999', 'без-формата', 'MRN-08124']) {
    assert.equal(mrnSeriesRefusal(m), null, String(m));
  }
});

test('mrnSeriesRefusal: the patients import checks every new row with it', () => {
  const src = fs.readFileSync(new URL('./views/section-import-export.js', import.meta.url), 'utf8');
  const at = src.indexOf('\n    patients: {');
  assert.ok(at > 0, 'patients import config found');
  const cfg = src.slice(at, src.indexOf('columns:', at));
  assert.match(cfg, /validateInsert:\s*\(payload\)\s*=>\s*mrnSeriesRefusal\(payload\.mrn\)/);
});

test('mrnOrder: the merge dialog picks its default card with it, not with text order', () => {
  const src = fs.readFileSync(new URL('./views/patients.js', import.meta.url), 'utf8');
  const at = src.indexOf('function openMergeModal');
  assert.ok(at > 0, 'openMergeModal found');
  const body = src.slice(at, src.indexOf('let primaryId', at));
  assert.match(body, /mrnOrder\(a\.mrn, b\.mrn\)/);
  assert.doesNotMatch(body, /localeCompare/);
});

// ---------------------------------------------------------------------------
// PATIENT_DUP_RULE_V3 — «Возможные дубликаты — проверьте». Уверенные правила
// (V2) не меняются; второй список — пары, которые человек должен посмотреть:
//   • тот же телефон и та же дата рождения, имена разные;
//   • то же ФИО и та же дата рождения, телефон любой.
// Пара из уверенной группы вторым списком не повторяется; пустая или мусорная
// дата/телефон ничего не группируют; пары «Не дубликат» не показываются.
// ---------------------------------------------------------------------------
const OWNER_PHONE = '+998 97 765 43 21';
// Случай владельца (имена, номер и дата изменены): три карты на одном номере — «TEST», «Alimov», «Тест 2»; у двух
// из них («Sardor Alimov» и «ТЕст 2 Тест 2») одна дата рождения 1991-04-23.
const OWNER_ROWS = [
  { id: 101, phone: OWNER_PHONE,     first_name: 'TEST',   last_name: '',       full_name: 'TEST',          date_of_birth: '1990-05-05' },
  { id: 102, phone: '998977654321',  first_name: 'Alimov',   last_name: 'Sardor',  full_name: 'Sardor Alimov',    date_of_birth: '1991-04-23' },
  { id: 103, phone: '+998977654321', first_name: 'Тест 2', last_name: 'ТЕст 2', full_name: 'ТЕст 2 Тест 2', date_of_birth: '1991-04-23' },
];

test('dobKey: дата YYYY-MM-DD (и ДД.ММ.ГГГГ) — ключ; пусто и мусор — нет ключа', () => {
  assert.equal(dobKey('1991-04-23'), '1991-04-23');
  assert.equal(dobKey('1991-04-23T00:00:00.000Z'), '1991-04-23', 'время после даты не мешает');
  assert.equal(dobKey('23.04.1991'), '1991-04-23', 'та же дата, записанная по-русски');
  for (const junk of ['', null, undefined, '   ', 'abc', '1994-13-01', '2023-02-30', '0000-00-00', '1900-01-01', '1899-12-31', '94-11-15']) {
    assert.equal(dobKey(junk), '', String(junk));
  }
});

test('nameParts / fullNameKey: колонки или «Фамилия Имя Отчество» из full_name; без фамилии или имени ключа нет', () => {
  assert.deepEqual(nameParts({ last_name: 'Каримов', first_name: 'Азиз', middle_name: 'Рустамович' }),
    { last: 'каримов', first: 'азиз', middle: 'рустамович' });
  assert.deepEqual(nameParts({ full_name: 'Каримов Азиз Рустамович' }), { last: 'каримов', first: 'азиз', middle: 'рустамович' });
  assert.deepEqual(nameParts({ full_name: 'Азиз' }), { last: '', first: 'азиз', middle: '' });
  assert.equal(fullNameKey({ full_name: 'Фёдоров  Пётр' }), 'федоров петр');
  assert.equal(fullNameKey({ last_name: 'ФЕДОРОВ', first_name: 'петр' }), 'федоров петр');
  assert.equal(fullNameKey({ first_name: 'Азиз' }), '', 'одно имя — не ФИО');
  assert.equal(fullNameKey({ last_name: 'Каримов' }), '', 'одна фамилия — не ФИО');
  assert.equal(fullNameKey({}), '');
});

test('pairKey: порядок карт не важен', () => {
  assert.equal(pairKey(103, 102), pairKey(102, 103));
  assert.equal(pairKey(9, 10), '9:10', 'id сравниваются числами, а не текстом');
});

test('случай владельца: уверенных дубликатов нет (правило V2 не тронуто), возможная пара — «Alimov» и «Тест 2» по телефону и дате рождения', () => {
  assert.deepEqual(duplicateGroups(OWNER_ROWS), [], 'уверенные правила изменились');
  assert.deepEqual(possibleDuplicateGroups(OWNER_ROWS), [{ ids: [102, 103], reasons: [POSSIBLE_REASONS.PHONE_DOB] }]);
  assert.equal(POSSIBLE_REASONS.PHONE_DOB, 'phone_dob');
  assert.equal(POSSIBLE_REASONS.NAME_DOB, 'name_dob');
});

test('то же ФИО и та же дата рождения при разных телефонах — возможный дубликат (регистр, ё/е, full_name против колонок)', () => {
  const rows = [
    { id: 1, phone: '+998 90 111 11 11', full_name: 'Фёдоров Пётр Ильич', date_of_birth: '1980-03-04' },
    { id: 2, phone: '+998 91 222 22 22', last_name: 'ФЕДОРОВ', first_name: 'петр', middle_name: 'Ильич', date_of_birth: '1980-03-04' },
    { id: 3, phone: '',                  last_name: 'Федоров', first_name: 'Петр', date_of_birth: '1980-03-04' },
  ];
  assert.deepEqual(duplicateGroups(rows), []);
  assert.deepEqual(possibleDuplicateGroups(rows), [{ ids: [1, 2, 3], reasons: [POSSIBLE_REASONS.NAME_DOB] }],
    'пустое отчество совместимо с любым');
});

test('то же ФИО и дата, но РАЗНЫЕ отчества — это разные люди', () => {
  const rows = [
    { id: 1, phone: '+998 90 111 11 11', last_name: 'Каримов', first_name: 'Азиз', middle_name: 'Рустамович', date_of_birth: '1980-03-04' },
    { id: 2, phone: '+998 91 222 22 22', last_name: 'Каримов', first_name: 'Азиз', middle_name: 'Бахтиёрович', date_of_birth: '1980-03-04' },
  ];
  assert.deepEqual(possibleDuplicateGroups(rows), []);
});

test('обе причины сразу — одна группа с двумя причинами', () => {
  const rows = [
    { id: 5, phone: PHONE, last_name: 'Каримов', first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 6, phone: PHONE, last_name: 'Каримова', first_name: 'Дилноза', date_of_birth: '1980-03-04' },
    { id: 7, phone: '+998 91 222 22 22', last_name: 'Каримова', first_name: 'Дилноза', date_of_birth: '1980-03-04' },
  ];
  assert.deepEqual(possibleDuplicateGroups(rows), [{ ids: [5, 6, 7], reasons: [POSSIBLE_REASONS.PHONE_DOB, POSSIBLE_REASONS.NAME_DOB] }]);
});

test('пара из уверенной группы вторым списком не повторяется', () => {
  // Один телефон, одно имя, одна дата — это уверенный дубликат, а не «возможный».
  const sameName = [
    { id: 1, phone: PHONE, last_name: 'Каримов', first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 2, phone: PHONE, last_name: 'Каримов', first_name: 'Азиз', date_of_birth: '1980-03-04' },
  ];
  assert.equal(duplicateGroups(sameName).length, 1);
  assert.deepEqual(possibleDuplicateGroups(sameName), []);
  // Общий ПИНФЛ + то же ФИО и дата — тоже уверенный, «возможным» не повторяется.
  const byPinfl = [
    { id: 3, national_id: '12345678901234', phone: '+998 90 111 11 11', full_name: 'Каримов Азиз', date_of_birth: '1980-03-04' },
    { id: 4, national_id: '12345678901234', phone: '+998 91 222 22 22', full_name: 'Каримов Азиз', date_of_birth: '1980-03-04' },
  ];
  assert.deepEqual(possibleDuplicateGroups(byPinfl), []);
  // Но третья карта, «возможно та же», показывается вместе с уверенной парой.
  const plusThird = [...sameName, { id: 9, phone: PHONE, last_name: 'Каримов', first_name: 'Aziz', date_of_birth: '1980-03-04' }];
  assert.deepEqual(possibleDuplicateGroups(plusThird), [{ ids: [1, 2, 9], reasons: [POSSIBLE_REASONS.PHONE_DOB] }]);
});

test('пустая или мусорная дата рождения ничего не группирует', () => {
  for (const dob of ['', null, '0000-00-00', '1900-01-01', 'не знаю']) {
    const rows = [
      { id: 1, phone: PHONE, last_name: 'Каримов', first_name: 'Азиз', date_of_birth: dob },
      { id: 2, phone: PHONE, last_name: 'Каримова', first_name: 'Дилноза', date_of_birth: dob },
      { id: 3, phone: '+998 91 222 22 22', last_name: 'Каримов', first_name: 'Азиз', date_of_birth: dob },
    ];
    assert.deepEqual(possibleDuplicateGroups(rows), [], 'дата ' + JSON.stringify(dob));
  }
});

test('мусорный или пустой телефон не группирует по правилу «телефон + дата»', () => {
  for (const phone of ['', null, '0', '123', '000000000', '+998 00 000 00 00', '1111111']) {
    const rows = [
      { id: 1, phone, first_name: 'Азиз', date_of_birth: '1980-03-04' },
      { id: 2, phone, first_name: 'Дилноза', date_of_birth: '1980-03-04' },
    ];
    assert.deepEqual(possibleDuplicateGroups(rows), [], 'телефон ' + JSON.stringify(phone));
  }
});

test('разная дата рождения — не возможный дубликат (ни по телефону, ни по ФИО)', () => {
  const rows = [
    { id: 1, phone: PHONE, last_name: 'Каримов', first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 2, phone: PHONE, last_name: 'Каримова', first_name: 'Дилноза', date_of_birth: '1980-03-05' },
    { id: 3, phone: '+998 91 222 22 22', last_name: 'Каримов', first_name: 'Азиз', date_of_birth: '1981-03-04' },
  ];
  assert.deepEqual(possibleDuplicateGroups(rows), []);
});

test('одно имя без фамилии на разных телефонах с одной датой — не ФИО, не группируется', () => {
  const rows = [
    { id: 1, phone: '+998 90 111 11 11', first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 2, phone: '+998 91 222 22 22', first_name: 'Азиз', date_of_birth: '1980-03-04' },
  ];
  assert.deepEqual(possibleDuplicateGroups(rows), []);
});

test('«Не дубликат»: отмеченная пара не показывается, остальные связи группы остаются', () => {
  assert.deepEqual(possibleDuplicateGroups(OWNER_ROWS, { dismissed: new Set([pairKey(103, 102)]) }), []);
  // Тройня на одном номере с одной датой: три связи; одна снята — группа держится на двух.
  const triplets = [
    { id: 1, phone: PHONE, first_name: 'Азиз', date_of_birth: '2020-01-02' },
    { id: 2, phone: PHONE, first_name: 'Дилноза', date_of_birth: '2020-01-02' },
    { id: 3, phone: PHONE, first_name: 'Рустам', date_of_birth: '2020-01-02' },
  ];
  assert.deepEqual(possibleDuplicateGroups(triplets, { dismissed: new Set([pairKey(1, 2)]) }).map((g) => g.ids), [[1, 2, 3]]);
  assert.deepEqual(possibleDuplicateGroups(triplets, { dismissed: new Set([pairKey(1, 2), pairKey(1, 3)]) }).map((g) => g.ids), [[2, 3]]);
  assert.deepEqual(possibleDuplicateGroups(triplets, { dismissed: new Set([pairKey(1, 2), pairKey(1, 3), pairKey(2, 3)]) }), []);
  // Отметка «Не дубликат» не трогает уверенные группы.
  const sure = [
    { id: 1, phone: PHONE, first_name: 'Азиз', date_of_birth: '2020-01-02' },
    { id: 2, phone: PHONE, first_name: 'Азиз', date_of_birth: '2020-01-02' },
  ];
  assert.equal(duplicateScan(sure, new Set([pairKey(1, 2)])).sure.length, 1);
});

test('огромная «корзина» одного телефона и одной даты — заглушка, а не человек: не группируется', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, phone: PHONE, first_name: 'Имя' + i, date_of_birth: '2000-01-01' }));
  assert.deepEqual(possibleDuplicateGroups(rows), []);
});

// Скорость скана на 70 000 картах (V3) не должна менять ответ уверенного правила:
// «одна правка» без таблицы Левенштейна и запомненная нормализация — те же ответы.
test('withinOneEdit отвечает ровно как levenshtein(x, y) <= 1; memoNormalizer — как normalizeName', () => {
  const ALPHA = ['а', 'б', 'е', 'ё', 'и', 'a', 'b', 'z', ' '];
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const word = () => Array.from({ length: Math.floor(rnd() * 7) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  for (let i = 0; i < 20000; i++) {
    const x = word();
    // половина пар — близкие (одна-две правки), иначе совпадений почти не будет
    let y = x;
    if (rnd() < 0.5) y = word();
    else {
      const p = Math.floor(rnd() * (x.length + 1)), c = ALPHA[Math.floor(rnd() * ALPHA.length)];
      const op = Math.floor(rnd() * 3);
      y = op === 0 ? x.slice(0, p) + c + x.slice(p) : op === 1 ? x.slice(0, p) + x.slice(p + 1) : x.slice(0, p) + c + x.slice(p + 1);
    }
    assert.equal(withinOneEdit(x, y), levenshtein(x, y) <= 1, JSON.stringify([x, y]));
  }
  const norm = memoNormalizer();
  for (const s of ['  Азиз ', 'АЗИЗ', 'Фёдор', 'Абдулла-Азиз', null, undefined, '', 'Фёдор']) assert.equal(norm(s), normalizeName(s), String(s));
});

test('duplicateScan: оба списка, новые группы сверху, id в группе по возрастанию; пустой ввод не падает', () => {
  const rows = [
    ...OWNER_ROWS,
    { id: 1, phone: PHONE, first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 50, phone: '901234567', first_name: 'Азиз', date_of_birth: '1980-03-04' },
    { id: 7, phone: '+998 97 700 11 22', full_name: 'Эргашев Жахонгир', date_of_birth: '1990-04-01' },
    { id: 8, phone: '+998 97 700 33 44', full_name: 'Эргашев Жахонгир', date_of_birth: '1990-04-01' },
  ];
  const scan = duplicateScan(rows);
  assert.deepEqual(scan.sure, [[1, 50]]);
  assert.deepEqual(scan.possible.map((g) => g.ids), [[102, 103], [7, 8]], 'группа с самой новой картой — первой');
  assert.deepEqual(duplicateScan([]), { sure: [], possible: [] });
  assert.deepEqual(duplicateScan(null), { sure: [], possible: [] });
  assert.deepEqual(possibleDuplicateGroups([null, {}, { phone: PHONE, date_of_birth: '1980-03-04' }]), []);
});
