// ADMIN_ACT_AS_V1 (2026-10-28) — ОБЫЧНЫЙ ВХОД: ОБОЛОЧКА КАК БЫЛА.
//
// Настоящий admin.js (стенд act-as-shell-harness.mjs), /me — администратор
// без входа от имени: полосы нет, блока «Работа от имени сотрудника» в окне
// аватара нет, «Сменить пароль» — на месте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootShell, descendants, labelOf } from './act-as-shell-harness.mjs';

const ADMIN = { id: 1, username: 'boss', full_name: 'Петров П.', role: 'admin', is_active: true, is_doctor: false,
    extra_roles: [], custom_role_code: null, department_id: null, must_change_password: false, acting_admin: null };
const S = await bootShell({ meBody: { user: ADMIN } });

test('без входа от имени: полосы нет, «Сменить пароль» есть, блока «от имени» нет', () => {
    assert.ok(globalThis.window.easymed, 'оболочка поднялась');
    assert.equal(globalThis.window.easymed.state.user.acting_admin, null);
    assert.equal(S.byId('act-as-banner'), null);
    assert.equal(S.byId('act-as-account'), null);
    const buttons = descendants(S.USER_POP).filter((n) => n.tagName === 'BUTTON').map(labelOf);
    assert.ok(buttons.some((t) => /Сменить пароль/.test(t)), buttons.join(' | '));
    assert.deepEqual(S.ALERTS, []);
    assert.equal(S.reloads(), 0);
});

test('глушим таймеры оболочки', () => { S.stopTimers(); });
