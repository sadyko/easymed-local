// PHONE_INPUT_V1 — the rules every phone field in the app now shares.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_COUNTRY, detectCountry, phoneDigits, isCodeOnly, formatPhone, fmtPhone, countryByIso,
} from '../phone-format.js';

test('the default country is Uzbekistan', () => {
    assert.equal(DEFAULT_COUNTRY.iso, 'UZ');
    assert.equal(DEFAULT_COUNTRY.code, '998');
});

test('detectCountry prefers the longest matching dialling code', () => {
    // '998…' must not resolve to KZ/RU '+7' or anything else short.
    assert.equal(detectCountry('998909610004').iso, 'UZ');
    assert.equal(detectCountry('79161234567').iso, 'KZ');   // first '7' entry wins
    assert.equal(detectCountry('996700123456').iso, 'KG');
    assert.equal(detectCountry('93701234567').iso, 'AF');
    assert.equal(detectCountry('12125550123').iso, 'US');
    assert.equal(detectCountry('44207123456'), null);       // unlisted country
});

test('phoneDigits strips everything but digits', () => {
    assert.equal(phoneDigits('+998 90 961-00-04'), '998909610004');
    assert.equal(phoneDigits(null), '');
    assert.equal(phoneDigits(undefined), '');
});

test('formatPhone groups the national part per country', () => {
    assert.equal(formatPhone('998909610004'), '+998 90 961 00 04');   // UZ 2-3-2-2
    assert.equal(formatPhone('+998909610004'), '+998 90 961 00 04');  // already formatted input
    assert.equal(formatPhone('996700123456'), '+996 700 123 456');    // KG 3-3-3
    assert.equal(formatPhone('12125550123'), '+1 212 555 0123');      // US 3-3-4
});

test('formatPhone keeps overflow digits rather than dropping them', () => {
    // A number longer than the grouping pattern still round-trips in full.
    assert.equal(phoneDigits(formatPhone('9989096100041234')), '9989096100041234');
});

test('formatPhone returns empty for blank and for a bare dialling code', () => {
    assert.equal(formatPhone(''), '');
    assert.equal(formatPhone('+998'), '');
    assert.equal(formatPhone('998'), '');
});

test('formatPhone falls back to a plain +digits for unlisted countries', () => {
    assert.equal(formatPhone('44207123456'), '+44207123456');
});

// This is the rule that stops a pre-filled «+998» from being saved as a real
// phone number on every patient, employee and supplier record.
test('isCodeOnly: an untouched field is blank, one real digit is not', () => {
    assert.equal(isCodeOnly(''), true);
    assert.equal(isCodeOnly('+998'), true);
    assert.equal(isCodeOnly('+998 '), true);
    assert.equal(isCodeOnly('+7'), true);
    assert.equal(isCodeOnly('+998 9'), false);
    assert.equal(isCodeOnly('+998 90 961 00 04'), false);
});

test('isCodeOnly does not blank a short number from an unlisted country', () => {
    // No country matches, so there is no code to mistake the digits for.
    assert.equal(isCodeOnly('+44'), false);
});

test('fmtPhone renders the code alone when there is no national part', () => {
    assert.equal(fmtPhone(countryByIso('UZ'), ''), '+998');
    assert.equal(fmtPhone(countryByIso('UZ'), '90'), '+998 90');
});
