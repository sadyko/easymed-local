// js/admin/__tests__/employee-branch.test.mjs
// Pure-logic mirror of EMP_BRANCH_SCOPE_V1 / EMP_BRANCH_VALIDATION_V1 / EMP_ROLE_OWNER_EQUIV_V1
// in employee-editor.js. Run: node --test js/admin/__tests__/employee-branch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';

function clampToActorBranches(ids, { isOwner, actorBranches }) {
    if (isOwner) return [...ids];
    const allowed = new Set(actorBranches);
    return [...ids].filter((id) => allowed.has(id));
}
function deriveBranchIds(emp, ctx) {
    let ids = clampToActorBranches([...emp.branches], ctx);
    const scoped = !ctx.isOwner && ctx.restricted;
    if (scoped && ids.length === 0 && !emp.__id) ids = [...ctx.actorBranches];
    return ids;
}
function requireBranchOk(emp, branchIds) {
    const isAdminEmp = (emp.role || '').toLowerCase() === 'admin';
    return isAdminEmp || branchIds.length > 0;
}
function roleAssignAllowed(roleName, isOwner) {
    return !((roleName || '').toLowerCase() === 'admin' && !isOwner);
}

const A = 'a', B = 'b', C = 'c';

test('owner: branches pass through unclamped', () => {
    const ctx = { isOwner: true, restricted: false, actorBranches: [] };
    assert.deepStrictEqual(deriveBranchIds({ branches: new Set([A, C]), __id: 'x' }, ctx), [A, C]);
});
test('branch admin: foreign branch is dropped', () => {
    const ctx = { isOwner: false, restricted: true, actorBranches: [A, B] };
    assert.deepStrictEqual(deriveBranchIds({ branches: new Set([A, C]), __id: 'x' }, ctx), [A]);
});
test('branch admin creating NEW staff with nothing ticked -> forced onto actor branches', () => {
    const ctx = { isOwner: false, restricted: true, actorBranches: [A, B] };
    assert.deepStrictEqual(deriveBranchIds({ branches: new Set([]), __id: null }, ctx), [A, B]);
});
test('branch admin EDITING existing staff with nothing valid -> stays empty (no force)', () => {
    const ctx = { isOwner: false, restricted: true, actorBranches: [A, B] };
    assert.deepStrictEqual(deriveBranchIds({ branches: new Set([C]), __id: 'x' }, ctx), []);
});
test('require >=1 branch: non-admin employee with zero branches fails', () => {
    assert.strictEqual(requireBranchOk({ role: 'doctor' }, []), false);
    assert.strictEqual(requireBranchOk({ role: 'doctor' }, [A]), true);
});
test('require >=1 branch: clinic-admin employee is exempt', () => {
    assert.strictEqual(requireBranchOk({ role: 'admin' }, []), true);
});
test('owner-equivalent role: non-owner cannot assign admin role', () => {
    assert.strictEqual(roleAssignAllowed('admin', false), false);
    assert.strictEqual(roleAssignAllowed('Admin', false), false);
});
test('owner-equivalent role: owner may assign admin; anyone may assign a plain role', () => {
    assert.strictEqual(roleAssignAllowed('admin', true), true);
    assert.strictEqual(roleAssignAllowed('nurse', false), true);
});
