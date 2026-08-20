import { test } from 'node:test';
import assert from 'node:assert';
import { branchScope, BRANCH_PATHS } from '../branch-filter.js';
import { _setStateForTest } from '../branch-context.js?v=bc3';

// Chainable mock recording .in() and .or() (the direct path uses .or() with a
// legacy null-inclusion; embed paths use .in('rel.col', ids)).
function mockQ() {
  const calls = [];
  const q = {
    calls,
    in(col, vals) { calls.push(['in', col, vals]); return q; },
    or(expr)      { calls.push(['or', expr]); return q; },
    eq(col, val)  { calls.push(['eq', col, val]); return q; },
  };
  return q;
}
const A = 'aaa', B = 'bbb', C = 'ccc';
const NIL = '00000000-0000-0000-0000-000000000000';

test('direct subset (owner narrows) -> .or(in + is.null)', () => {
  _setStateForTest({ available: [A, B, C], selected: [A], restricted: false });
  const q = mockQ();
  branchScope(q, 'invoices');
  assert.deepStrictEqual(q.calls, [['or', `branch_id.in.(${A}),branch_id.is.null`]]);
});

test('all-selected, not restricted -> untouched', () => {
  _setStateForTest({ available: [A, B, C], selected: [A, B, C], restricted: false });
  const q = mockQ();
  branchScope(q, 'invoices');
  assert.deepStrictEqual(q.calls, []);
});

test('users direct path filters on users.branch_id', () => {
  _setStateForTest({ available: [A, B, C], selected: [B], restricted: false });
  const q = mockQ();
  branchScope(q, 'users');
  assert.deepStrictEqual(q.calls, [['or', `branch_id.in.(${B}),branch_id.is.null`]]);
});

test('rooms embed path -> .in(floors.branch_id, ids)', () => {
  _setStateForTest({ available: [A, B, C], selected: [B], restricted: false });
  const q = mockQ();
  branchScope(q, 'rooms');
  assert.deepStrictEqual(q.calls, [['in', 'floors.branch_id', [B]]]);
});

test('beds embed path -> .in(wards.branch_id, ids)', () => {
  _setStateForTest({ available: [A, B, C], selected: [B], restricted: false });
  const q = mockQ();
  branchScope(q, 'beds');
  assert.deepStrictEqual(q.calls, [['in', 'wards.branch_id', [B]]]);
});

test('restricted user, ALWAYS filters even with full selection', () => {
  _setStateForTest({ available: [A, B], selected: [A, B], restricted: true });
  const q = mockQ();
  branchScope(q, 'invoices');
  assert.deepStrictEqual(q.calls, [['or', `branch_id.in.(${A},${B}),branch_id.is.null`]]);
});

test('restricted user with EMPTY selection -> fail closed (matches nothing)', () => {
  _setStateForTest({ available: [], selected: [], restricted: true });
  const q = mockQ();
  branchScope(q, 'invoices');
  assert.deepStrictEqual(q.calls, [['eq', 'branch_id', NIL]]);
});

test('restricted user, empty selection, embed table -> fail closed on rel.col', () => {
  _setStateForTest({ available: [], selected: [], restricted: true });
  const q = mockQ();
  branchScope(q, 'rooms');
  assert.deepStrictEqual(q.calls, [['eq', 'floors.branch_id', NIL]]);
});

test('owner, empty selection -> unchanged (treated as all)', () => {
  _setStateForTest({ available: [A, B], selected: [], restricted: false });
  const q = mockQ();
  branchScope(q, 'invoices');
  assert.deepStrictEqual(q.calls, []);
});

test('unknown table while narrowing -> unchanged', () => {
  _setStateForTest({ available: [A, B, C], selected: [B], restricted: false });
  const q = mockQ();
  branchScope(q, 'no_such_table');
  assert.deepStrictEqual(q.calls, []);
});

test('BRANCH_PATHS has the new isolation entries', () => {
  for (const k of ['users', 'floors', 'wards', 'departments', 'rooms', 'beds']) {
    assert.ok(BRANCH_PATHS[k], `missing path: ${k}`);
  }
  assert.strictEqual(BRANCH_PATHS.rooms.rel, 'floors');
  assert.strictEqual(BRANCH_PATHS.beds.rel, 'wards');
});
