import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeName, firstNameOf, phoneKey, idKey, namesMatch,
  duplicateGroups, duplicateIdSet, mrnOrder, mrnSeriesRefusal,
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
