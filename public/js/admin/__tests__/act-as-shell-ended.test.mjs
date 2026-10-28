// ADMIN_ACT_AS_V1 (2026-10-28) — ВХОД ОТ ИМЕНИ КОНЧИЛСЯ, ПОКА СТРАНИЦЫ НЕ БЫЛО.
//
// Настоящий admin.js (стенд act-as-shell-harness.mjs): /me отвечает
// администратором и act_as_ended (2 часа истекли, пока вкладка была закрыта).
// Оболочка называет причину, говорит серверу «Вернуться» и перезагружается —
// не рисуя экран администратора поверх незакрытого входа от имени.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootShell } from './act-as-shell-harness.mjs';

const ADMIN = { id: 1, username: 'boss', full_name: 'Петров П.', role: 'admin', is_active: true, is_doctor: false,
    extra_roles: [], custom_role_code: null, department_id: null, must_change_password: false, acting_admin: null };
const S = await bootShell({ meBody: { user: ADMIN, act_as_ended: { reason: 'Истекло' } } });

test('/me с act_as_ended: причина, DELETE /api/auth/act-as, перезагрузка; оболочка не рисуется', () => {
    assert.equal(S.ALERTS.length, 1, S.ALERTS.join(' | '));
    assert.match(S.ALERTS[0], /Работа от имени сотрудника закончилась/);
    assert.match(S.ALERTS[0], /Причина: Истекло/);
    assert.deepEqual(S.CALLS.filter((c) => c.url === '/api/auth/act-as').map((c) => c.method), ['DELETE']);
    assert.equal(S.reloads(), 1);
    assert.equal((globalThis.window.easymed || {}).state, undefined, 'экран не собирался — через мгновение страница перезагрузится');
    assert.equal(S.byId('act-as-banner'), null);
});

test('глушим таймеры оболочки', () => { S.stopTimers(); });
