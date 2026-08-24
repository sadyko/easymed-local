// TELEPHONY_V1 (docs/plans/2026-08-23-binotel-telephony.md, Task 2) — tests
// for every pure decision behind Settings → «Телефония». Pure node, no fake
// DOM, no locale pin needed: unlike the __tests__/*.mjs view fixtures,
// nothing here touches i18n.js — every label is asserted as the literal
// Russian source string these functions return (translation happens later,
// in h()'s text-child path, and is not this file's concern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DASH, textOrDash, secretPlaceholder, formatDuration, dispositionLabel,
    callDirection, normalizeInterval, webhookUrl, timeLabel, isNotImplemented,
    shapeCalls, statusTime, shapeDispositions, pluralRu,
} from './telephony-logic.js';

// --- textOrDash --------------------------------------------------------------

test('textOrDash: real strings pass, everything absent becomes the em-dash', () => {
    assert.equal(textOrDash('+998901234567'), '+998901234567');
    for (const bad of [null, undefined, '', '   ', 42, {}]) {
        assert.equal(textOrDash(bad), DASH, `input=${JSON.stringify(bad)}`);
    }
});

// --- secretPlaceholder -------------------------------------------------------

test('secretPlaceholder: «сохранён» semantics when set, an invitation when not', () => {
    assert.equal(secretPlaceholder(true), 'сохранён — введите новый, чтобы заменить');
    assert.equal(secretPlaceholder(false), 'secret из письма Binotel');
    // The RPC field is api_secret_set:true/false, but a thin reply must read as "not set".
    assert.equal(secretPlaceholder(undefined), 'secret из письма Binotel');
});

// --- formatDuration ----------------------------------------------------------

test('formatDuration: м:сс with padded seconds, minutes keep counting past an hour', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(42), '0:42');
    assert.equal(formatDuration(134), '2:14');
    assert.equal(formatDuration('134'), '2:14');   // the server may serialize numbers as strings
    assert.equal(formatDuration(3661), '61:01');   // no format switch mid-table
    assert.equal(formatDuration(59.9), '0:59');    // floor, never a 60-second minute
});

test('formatDuration: garbage/negative/missing → em-dash, never NaN:NaN', () => {
    for (const bad of [null, undefined, '', 'долго', -5, NaN, {}]) {
        assert.equal(formatDuration(bad), DASH, `input=${JSON.stringify(bad)}`);
    }
});

// --- dispositionLabel --------------------------------------------------------

test('dispositionLabel: the documented Binotel vocabulary in human Russian', () => {
    assert.equal(dispositionLabel('ANSWER'), 'Отвечен');
    assert.equal(dispositionLabel('TRANSFER'), 'Переведён');
    assert.equal(dispositionLabel('BUSY'), 'Абонент занят');
    assert.equal(dispositionLabel('NOANSWER'), 'Без ответа');
    assert.equal(dispositionLabel('CANCEL'), 'Отменён');
    assert.equal(dispositionLabel('ONLINE'), 'Идёт разговор');
    assert.equal(dispositionLabel('VM'), 'Голосовая почта');
});

test('dispositionLabel: case-insensitive; unknown words pass raw; missing → em-dash', () => {
    assert.equal(dispositionLabel('answer'), 'Отвечен');
    assert.equal(dispositionLabel(' Busy '), 'Абонент занят');
    // A word this client has not learned identifies the outcome better than a dash.
    assert.equal(dispositionLabel('CONGESTION'), 'CONGESTION');
    for (const bad of [null, undefined, '', '  ', 7]) {
        assert.equal(dispositionLabel(bad), DASH, `input=${JSON.stringify(bad)}`);
    }
});

// --- callDirection -----------------------------------------------------------

test('callDirection: 0 = incoming, 1 = outgoing, both also as numeric strings', () => {
    assert.deepEqual(callDirection(0), { icon: 'PhoneIn', label: 'Входящий' });
    assert.deepEqual(callDirection(1), { icon: 'PhoneOut', label: 'Исходящий' });
    assert.deepEqual(callDirection('0'), { icon: 'PhoneIn', label: 'Входящий' });
    assert.deepEqual(callDirection('1'), { icon: 'PhoneOut', label: 'Исходящий' });
});

test('callDirection: anything else is a neutral phone, never a wrong arrow', () => {
    for (const bad of [null, undefined, '', 'in', 2, -1, NaN]) {
        assert.deepEqual(callDirection(bad), { icon: 'Phone', label: DASH }, `input=${JSON.stringify(bad)}`);
    }
});

// --- normalizeInterval -------------------------------------------------------

test('normalizeInterval: whole seconds ≥ 10 pass, as number or trimmed string', () => {
    assert.equal(normalizeInterval(10), 10);
    assert.equal(normalizeInterval(30), 30);
    assert.equal(normalizeInterval('30'), 30);
    assert.equal(normalizeInterval(' 15 '), 15);
});

test('normalizeInterval: below the floor, fractions and garbage → null (refuse, never clamp)', () => {
    for (const bad of [9, '9', 0, -30, 10.5, '10.5', '', '  ', null, undefined, 'raz', true, NaN]) {
        assert.equal(normalizeInterval(bad), null, `input=${JSON.stringify(bad)}`);
    }
});

// --- webhookUrl --------------------------------------------------------------

test('webhookUrl: absolute http(s) origin + the fixed receiver path', () => {
    assert.equal(webhookUrl('https://clinic.example.uz'), 'https://clinic.example.uz/api/telephony/binotel');
    assert.equal(webhookUrl('https://clinic.example.uz/'), 'https://clinic.example.uz/api/telephony/binotel');
    assert.equal(webhookUrl('https://clinic.example.uz///'), 'https://clinic.example.uz/api/telephony/binotel');
    assert.equal(webhookUrl('http://203.0.113.5:8000'), 'http://203.0.113.5:8000/api/telephony/binotel');
});

test('webhookUrl: no scheme / empty / garbage → null — better no URL than a dead one', () => {
    for (const bad of ['clinic.example.uz', '10.4.1.193:8000', '', '   ', null, undefined, 42, 'ftp://x.uz']) {
        assert.equal(webhookUrl(bad), null, `input=${JSON.stringify(bad)}`);
    }
});

// --- timeLabel / statusTime --------------------------------------------------

test('timeLabel: unix seconds, unix ms, numeric strings and ISO all land on DD.MM.YYYY HH:mm', () => {
    const at = new Date(2026, 7, 23, 9, 5, 0);   // local time, matching formatRuDateTime's rendering
    const sec = Math.floor(at.getTime() / 1000);
    assert.equal(timeLabel(sec), '23.08.2026 09:05');
    assert.equal(timeLabel(at.getTime()), '23.08.2026 09:05');
    assert.equal(timeLabel(String(sec)), '23.08.2026 09:05');
    assert.equal(timeLabel(at.toISOString()), '23.08.2026 09:05');
});

test('timeLabel: garbage/missing → em-dash, never "Invalid Date"', () => {
    for (const bad of [null, undefined, '', 'вчера', {}, -1, 0]) {
        assert.equal(timeLabel(bad), DASH, `input=${JSON.stringify(bad)}`);
    }
    assert.equal(statusTime(null), DASH);
});

// --- isNotImplemented --------------------------------------------------------

test('isNotImplemented: the rpc route\'s 501 code, and the shim\'s own (501) message fallback', () => {
    assert.equal(isNotImplemented({ code: 'rpc_not_implemented', message: 'RPC not implemented: telephony_settings_get' }), true);
    assert.equal(isNotImplemented({ message: 'RPC failed (501)' }), true);
    assert.equal(isNotImplemented({ message: 'RPC failed (404)' }), false);
    assert.equal(isNotImplemented({ code: 'forbidden', message: 'нет доступа' }), false);
    assert.equal(isNotImplemented(null), false);
    assert.equal(isNotImplemented(undefined), false);
});

// --- shapeCalls --------------------------------------------------------------

test('shapeCalls: the contract shape {calls:[…]} and a bare array both work; anything else → []', () => {
    const row = { started_at: 1756000000, call_type: 0, external_number: '+998901234567', billsec: 134, disposition: 'ANSWER' };
    assert.equal(shapeCalls({ calls: [row] }).length, 1);
    assert.equal(shapeCalls([row]).length, 1);
    for (const bad of [null, undefined, {}, { calls: 'x' }, 'x', 42]) {
        assert.deepEqual(shapeCalls(bad), [], `input=${JSON.stringify(bad)}`);
    }
});

test('shapeCalls: caps at 20 rows and drops non-object entries', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ billsec: i }));
    assert.equal(shapeCalls({ calls: rows }).length, 20);
    assert.equal(shapeCalls({ calls: [null, 'x', { billsec: 1 }] }).length, 1);
});

test('shapeCalls: a full row shapes into ready-to-render display fields', () => {
    const at = new Date(2026, 7, 23, 14, 30, 0);
    const [c] = shapeCalls({ calls: [{
        started_at: Math.floor(at.getTime() / 1000),
        call_type: 1,
        external_number: '+998901234567',
        internal_number: '101',
        billsec: 134,
        waitsec: 6,
        disposition: 'NOANSWER',
        patient_id: 'p-1',
        patient_name: 'Иванов Иван',
    }] });
    assert.equal(c.time, '23.08.2026 14:30');
    assert.deepEqual(c.direction, { icon: 'PhoneOut', label: 'Исходящий' });
    assert.equal(c.external, '+998901234567');
    assert.equal(c.internal, '101');
    assert.equal(c.duration, '2:14');
    assert.equal(c.disposition, 'Без ответа');
    assert.equal(c.patient_id, 'p-1');
    assert.equal(c.patient_name, 'Иванов Иван');
});

test('shapeCalls: an all-absent row renders as em-dashes with no patient link, never a throw', () => {
    const [c] = shapeCalls({ calls: [{}] });
    assert.equal(c.time, DASH);
    assert.deepEqual(c.direction, { icon: 'Phone', label: DASH });
    assert.equal(c.external, DASH);
    assert.equal(c.internal, DASH);
    assert.equal(c.duration, DASH);
    assert.equal(c.disposition, DASH);
    assert.equal(c.patient_id, null);
    assert.equal(c.patient_name, null);
});

test('shapeCalls: patient_name only when a real non-empty string — the RPC marks it optional', () => {
    assert.equal(shapeCalls({ calls: [{ patient_id: 'p-1', patient_name: '' }] })[0].patient_name, null);
    assert.equal(shapeCalls({ calls: [{ patient_id: 'p-1', patient_name: '  ' }] })[0].patient_name, null);
    assert.equal(shapeCalls({ calls: [{ patient_id: 'p-1' }] })[0].patient_name, null);
    assert.equal(shapeCalls({ calls: [{ patient_id: 'p-1', patient_name: 'Иванов' }] })[0].patient_name, 'Иванов');
});

// --- shapeDispositions (TELEPHONY_ROUTING_V1) --------------------------------

test('shapeDispositions: the contract array, the {dispositions} envelope, and junk all shape safely', () => {
    const row = { disposition: 'ANSWER', seen_count: 3, last_seen_at: '2026-08-24T11:30:00Z',
        documented: true, action: 'create', stage_key: 'in_process' };
    assert.deepEqual(shapeDispositions([row]), [row]);
    assert.deepEqual(shapeDispositions({ dispositions: [row] }), [row]);
    // {} is what a clinic still on an older build answers — an empty card,
    // never a throw.
    for (const junk of [null, undefined, {}, 'nope', 7, { dispositions: 'no' }]) {
        assert.deepEqual(shapeDispositions(junk), [], JSON.stringify(junk));
    }
    // A row with no disposition is not an outcome anybody can set a rule for.
    assert.deepEqual(shapeDispositions([{}, { disposition: '  ' }, { disposition: 5 }]), []);
});

test('shapeDispositions: a half-built row degrades to «seen never, no rule, creates nothing»', () => {
    const [r] = shapeDispositions([{ disposition: '  NOANSWER  ' }]);
    assert.deepEqual(r, {
        disposition: 'NOANSWER', seen_count: 0, last_seen_at: null,
        documented: false, action: 'ignore', stage_key: null,
    });
    // 'ignore' for anything that is not literally 'create': silence is what
    // leadFromCall does with a rule it cannot read, and the screen must show
    // what the system does rather than a friendlier guess.
    for (const bad of ['CREATE', 'make', '', null, 1, true]) {
        assert.equal(shapeDispositions([{ disposition: 'X', action: bad }])[0].action, 'ignore', String(bad));
    }
    assert.equal(shapeDispositions([{ disposition: 'X', action: 'create' }])[0].action, 'create');
});

test('shapeDispositions: the count can never render as «-1 звонок» or «1.5 звонка»', () => {
    const n = (v) => shapeDispositions([{ disposition: 'X', seen_count: v }])[0].seen_count;
    assert.equal(n(12), 12);
    assert.equal(n('12'), 12, 'a JSON number that arrived as text still counts');
    for (const bad of [-1, 0, 0.4, 'many', null, undefined, NaN, {}]) {
        assert.equal(n(bad), 0, JSON.stringify(bad));
    }
    assert.equal(n(1.9), 1, 'floored, not rounded up — never claim a call that did not happen');
});

test('shapeDispositions: stage_key and last_seen_at are null unless they are real strings', () => {
    const [r] = shapeDispositions([{ disposition: 'X', stage_key: '', last_seen_at: '   ' }]);
    assert.equal(r.stage_key, null);
    assert.equal(r.last_seen_at, null);
    const [r2] = shapeDispositions([{ disposition: 'X', stage_key: 7, last_seen_at: 1755000000 }]);
    assert.equal(r2.stage_key, null);
    assert.equal(r2.last_seen_at, null);
});

// --- pluralRu ---------------------------------------------------------------

test('pluralRu: the «звонок / звонка / звонков» line agrees with its number', () => {
    const f = (n) => pluralRu(n, 'звонок', 'звонка', 'звонков');
    for (const n of [1, 21, 101, 131]) assert.equal(f(n), 'звонок', `n=${n}`);
    for (const n of [2, 3, 4, 22, 104]) assert.equal(f(n), 'звонка', `n=${n}`);
    // 11-14 are the trap every hand-rolled version gets wrong.
    for (const n of [0, 5, 11, 12, 13, 14, 25, 111]) assert.equal(f(n), 'звонков', `n=${n}`);
});
