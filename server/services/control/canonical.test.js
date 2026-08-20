import { test } from 'node:test';
import assert from 'node:assert';
import { canonical } from './canonical.js';

test('key order in the source object does not change the bytes', () => {
  const a = canonical({ b: 2, a: 1 });
  const b = canonical({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2}');
});

test('nested objects are sorted too', () => {
  assert.equal(canonical({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('array order is preserved — it is data, not key order', () => {
  assert.equal(canonical({ modules: ['telegram', 'crm'] }), '{"modules":["telegram","crm"]}');
});

test('undefined properties are dropped, null is kept', () => {
  assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
});

test('non-ASCII survives a round trip', () => {
  const s = canonical({ name: 'Нурафшон Мед' });
  assert.equal(JSON.parse(s).name, 'Нурафшон Мед');
});

test('empty object and empty array serialise to their empty forms', () => {
  assert.equal(canonical({}), '{}');
  assert.equal(canonical([]), '[]');
  assert.equal(canonical({ empty: {}, list: [] }), '{"empty":{},"list":[]}');
});

test('objects inside arrays are sorted too — array position is untouched, only key order inside each element changes', () => {
  const s = canonical({ list: [{ b: 1, a: 2 }, { d: 3, c: 4 }] });
  assert.equal(s, '{"list":[{"a":2,"b":1},{"c":4,"d":3}]}');
});

test('integer-like keys do not change canonical order — sort is on the key set, not on construction order', () => {
  // JS enumerates array-index-like keys ("2", "10") ahead of string keys, in ascending
  // numeric order, before any explicit sort runs (Object.keys order depends on how the
  // object was built). If canonical() ever relied on that native order instead of
  // re-sorting, two licences with the same fields assigned in a different sequence
  // (e.g. a numeric id set before or after other fields) could produce different bytes,
  // and one of an otherwise-identical pair of licences would fail to verify.
  const builtHighFirst = { 10: 'b', 2: 'a', z: 'c', a: 'd' };
  const builtLowFirst = {};
  builtLowFirst.a = 'd';
  builtLowFirst.z = 'c';
  builtLowFirst[2] = 'a';
  builtLowFirst[10] = 'b';
  assert.equal(canonical(builtHighFirst), canonical(builtLowFirst));
  assert.equal(canonical(builtHighFirst), '{"10":"b","2":"a","a":"d","z":"c"}');
});

test('calling canonical twice on the same input gives byte-identical output', () => {
  const payload = { clinic: 'x', modules: ['a', 'b'], meta: { z: 1, a: 2 } };
  assert.equal(canonical(payload), canonical(payload));
});

test('a Date has no enumerable own keys and collapses to {} — licence payloads must carry dates as ISO strings, never Date instances', () => {
  assert.equal(canonical({ issuedAt: new Date(0) }), '{"issuedAt":{}}');
});
