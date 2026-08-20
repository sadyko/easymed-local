// SOLE_BRANCH_V1 — soleBranchId() is the single gate every "auto-pick the branch"
// call site asks. It must answer ONLY when there is exactly one branch: guessing
// with several branches would silently file staff/patients under the wrong one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soleBranchId, _setStateForTest, getSelectedBranchIds } from '../branch-context.js';

test('one branch available -> returns its id', () => {
    _setStateForTest({ available: [{ id: 7, name: 'Main Branch' }], selected: [7] });
    assert.equal(soleBranchId(), 7);
});

test('one branch available but DEselected -> still returns it', () => {
    // The branch picker can end up with nothing ticked; there is still only one
    // branch to file under, so the answer must not change.
    _setStateForTest({ available: [{ id: 7, name: 'Main Branch' }], selected: [] });
    assert.deepEqual(getSelectedBranchIds(), []);
    assert.equal(soleBranchId(), 7);
});

test('several branches -> null (never guess)', () => {
    _setStateForTest({ available: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], selected: [1] });
    assert.equal(soleBranchId(), null);
});

test('several branches with only one selected -> still null', () => {
    // A filtered view is not the same as a single-branch clinic; the editor must
    // keep asking rather than inherit whatever the picker happens to show.
    _setStateForTest({ available: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], selected: [2] });
    assert.equal(soleBranchId(), null);
});

test('no branches configured -> null', () => {
    _setStateForTest({ available: [], selected: [] });
    assert.equal(soleBranchId(), null);
});

test('branch-restricted staffer with exactly one assigned branch -> returns it', () => {
    _setStateForTest({ available: [{ id: 4, name: 'Filial 2' }], selected: [4], restricted: true });
    assert.equal(soleBranchId(), 4);
});

test('id 0 is a real id, not "no branch"', () => {
    // A falsy-but-valid id must not be reported as absent by callers doing
    // `soleBranchId() != null`.
    _setStateForTest({ available: [{ id: 0, name: 'Zero' }], selected: [] });
    assert.equal(soleBranchId(), 0);
    assert.notEqual(soleBranchId(), null);
});
