import test from 'node:test';
import assert from 'node:assert/strict';
import { digitsOf, phoneLikePattern, filterPhoneMatches, uzLocalDigits, MIN_PHONE_DIGITS } from './crm-phone-match.js';

// ---------------------------------------------------------------------------
// digitsOf
// ---------------------------------------------------------------------------
test('digitsOf: strips every non-digit', () => {
  assert.equal(digitsOf('+998 90 961-00-04'), '998909610004');
  assert.equal(digitsOf('(90) 961.00.04'), '909610004');
});

test('digitsOf: null/undefined/empty -> empty string', () => {
  assert.equal(digitsOf(null), '');
  assert.equal(digitsOf(undefined), '');
  assert.equal(digitsOf(''), '');
});

// ---------------------------------------------------------------------------
// phoneLikePattern
// ---------------------------------------------------------------------------
test('phoneLikePattern: interleaves % so any stored formatting matches', () => {
  assert.equal(phoneLikePattern('9610'), '%9%6%1%0%');
});

// ---------------------------------------------------------------------------
// filterPhoneMatches
// ---------------------------------------------------------------------------
const rows = [
  { id: 1, full_name: 'Иванов', phone: '+998 90 961 00 04' },
  { id: 2, full_name: 'Петрова', phone: '+998 95 076 80 08' },
  { id: 3, full_name: 'Безномера', phone: null },
];

test('filterPhoneMatches: typed digits must be a CONTIGUOUS run of stored digits', () => {
  assert.deepEqual(filterPhoneMatches(rows, '998909610004').map(r => r.id), [1]);
  assert.deepEqual(filterPhoneMatches(rows, '950768008').map(r => r.id), [2]);
  assert.deepEqual(filterPhoneMatches(rows, '9610').map(r => r.id), [1]);
});

test('filterPhoneMatches: subsequence-only match is rejected', () => {
  // '9899' is a subsequence of 998909610004 (SQL %9%8%9%9% would match it)
  // but not a contiguous run — the post-filter must drop it.
  assert.deepEqual(filterPhoneMatches(rows, '9899'), []);
});

test('filterPhoneMatches: tolerates null phones and null/undefined row list', () => {
  assert.deepEqual(filterPhoneMatches(null, '9610'), []);
  assert.deepEqual(filterPhoneMatches(undefined, '9610'), []);
});

test('filterPhoneMatches: caps the result at 6 rows', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, phone: '+998 90 961 00 04' }));
  assert.equal(filterPhoneMatches(many, '9610').length, 6);
});

test('MIN_PHONE_DIGITS is 4', () => {
  assert.equal(MIN_PHONE_DIGITS, 4);
});

// ---------------------------------------------------------------------------
// uzLocalDigits / short-form tolerance (CRM_V10)
// ---------------------------------------------------------------------------
test('uzLocalDigits: strips the 998 country code when enough digits remain', () => {
  assert.equal(uzLocalDigits('998909610004'), '909610004');
  assert.equal(uzLocalDigits('9989'), '9989');          // remainder too short — keep as typed
});

test('uzLocalDigits: strips a single leading 0 (local dialing habit)', () => {
  assert.equal(uzLocalDigits('0950768008'), '950768008');
  assert.equal(uzLocalDigits('0950'), '0950');          // remainder too short — keep as typed
});

test('filterPhoneMatches: full-form input finds a SHORT-form stored phone', () => {
  const shortRows = [{ id: 7, full_name: 'Короткий', phone: '90 961 00 04' }];
  assert.deepEqual(filterPhoneMatches(shortRows, '998909610004').map(r => r.id), [7]);
});

test('filterPhoneMatches: 0-prefixed input finds the stored international phone', () => {
  assert.deepEqual(filterPhoneMatches(rows, '0950768008').map(r => r.id), [2]);
});

test('filterPhoneMatches: operator code 99 is not mangled by the 998 strip', () => {
  const op99 = [{ id: 9, full_name: 'Оператор99', phone: '+998 99 890 60 04' }];
  assert.deepEqual(filterPhoneMatches(op99, '998906004').map(r => r.id), [9]);   // typed «99 890 60 04»
});
