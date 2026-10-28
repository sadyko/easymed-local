// ADMIN_ACT_AS_V1 (2026-10-28) — ОБОЛОЧКА, КОГДА АДМИНИСТРАТОР РАБОТАЕТ ОТ ИМЕНИ.
//
// Настоящий admin.js (стенд act-as-shell-harness.mjs): /me отдаёт сотрудника с
// acting_admin. Проверяется то, что видит человек:
//   • полоса «Вы работаете от имени: …» над `.app` и «Вернуться» в ней;
//   • окно аватара: кто работает на самом деле, «Вернуться», и НЕТ «Сменить
//     пароль» (R6);
//   • «Вернуться» → DELETE /api/auth/act-as → перезагрузка;
//   • вход от имени кончился сам: 409 act_as_ended на запросах экрана (rpc,
//     db, прямой fetch — разом) → причина один раз, DELETE один раз,
//     перезагрузка одна.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootShell, descendants, labelOf, settle } from './act-as-shell-harness.mjs';

const ACTING = { id: 3, username: 'doc', full_name: 'Иванова А.', role: 'doctor', is_active: true, is_doctor: true,
    extra_roles: [], custom_role_code: null, department_id: null, must_change_password: false,
    acting_admin: { id: 1, full_name: 'Петров П.' } };
const S = await bootShell({ meBody: { user: ACTING } });

test('оболочка поднялась под сотрудником и знает, кто работает на самом деле', () => {
    const u = globalThis.window.easymed && globalThis.window.easymed.state.user;
    assert.ok(u, 'boot() дошёл до startApp()');
    assert.equal(u.id, 3);
    assert.deepEqual(u.acting_admin, { id: 1, full_name: 'Петров П.' });
});

test('полоса над .app: «Вы работаете от имени: Иванова А. (Врач) · все действия записываются · Вернуться…»', () => {
    const banner = S.byId('act-as-banner');
    assert.ok(banner, 'полосы нет');
    assert.equal(S.BODY.children.indexOf(banner) + 1, S.BODY.children.indexOf(S.APP), 'полоса — прямо над .app');
    const text = labelOf(banner);
    assert.match(text, /Вы работаете от имени: Иванова А\. \(Врач\)/);
    assert.match(text, /все действия записываются/);
    assert.match(text, /Вернуться к своей учётной записи/);
});

test('окно аватара: администратор и «Вернуться»; «Сменить пароль» нет (R6)', () => {
    const block = S.byId('act-as-account');
    assert.ok(block, 'блока «Работа от имени сотрудника» нет');
    assert.match(labelOf(block), /Администратор: Петров П\./);
    const buttons = descendants(S.USER_POP).filter((n) => n.tagName === 'BUTTON').map(labelOf);
    assert.ok(buttons.some((t) => /Вернуться к своей учётной записи/.test(t)), buttons.join(' | '));
    assert.ok(!buttons.some((t) => /Сменить пароль/.test(t)), 'работая от имени, пароль не меняют: ' + buttons.join(' | '));
    assert.ok(buttons.some((t) => /Log out|Выйти/.test(t)), 'выход остаётся: ' + buttons.join(' | '));
});

test('«Вернуться» в полосе → DELETE /api/auth/act-as → перезагрузка под администратором', async () => {
    S.CALLS.length = 0;
    const back = descendants(S.byId('act-as-banner')).find((n) => n.tagName === 'BUTTON');
    back.click();
    await settle(20);
    assert.deepEqual(S.CALLS.filter((c) => c.url === '/api/auth/act-as').map((c) => c.method), ['DELETE']);
    assert.equal(S.reloads(), 1);
});

test('авто-конец: 409 act_as_ended на трёх запросах разом — причина один раз, DELETE один раз, перезагрузка одна', async () => {
    const before = S.reloads();
    S.CALLS.length = 0;
    S.server(({ url }) => (url.startsWith('/api/auth/') ? null
        : { status: 409, body: { error: { code: 'act_as_ended', message: 'Работа от имени сотрудника закончилась — программа вернётся к вашей учётной записи.', reason: 'Сотрудник недоступен' } } }));
    const { supabase } = await import('../../supabase.js');
    const [rpc, db, direct] = await Promise.all([
        supabase.rpc('procedures_list', {}),
        supabase.from('visits').select('id'),
        fetch('/api/users'),
    ]);
    await settle(30);
    assert.equal(rpc.error.code, 'act_as_ended');
    assert.equal(db.error.status, 409);
    assert.equal(direct.status, 409);
    assert.equal(S.ALERTS.length, 1, S.ALERTS.join(' | '));
    assert.match(S.ALERTS[0], /Работа от имени сотрудника закончилась/);
    assert.match(S.ALERTS[0], /Причина: Сотрудник недоступен/);
    assert.deepEqual(S.CALLS.filter((c) => c.url === '/api/auth/act-as').map((c) => c.method), ['DELETE']);
    assert.equal(S.reloads() - before, 1);
    S.server(null);
});

test('глушим таймеры оболочки', () => { S.stopTimers(); });
