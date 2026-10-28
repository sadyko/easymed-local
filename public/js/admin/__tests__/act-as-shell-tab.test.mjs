// ADMIN_ACT_AS_V1 (ревью-2, 2026-10-28) — НОМЕР ВКЛАДКИ — ОТ ТОГО /me, ПО КОТОРОМУ СОБРАН ЭКРАН.
//
// Настоящий admin.js (стенд act-as-shell-harness.mjs). Загрузка спрашивает /me
// дважды: сначала проверка связи (pingSupabase), потом восстановление сессии
// (rehydrateUserFromSession), и экран собирается по ВТОРОМУ. Если между ними
// другая вкладка вошла от имени (или вернулась), номер вкладки из первого /me
// не совпал бы с экраном. Номер ставит /me, который собирает экран, — поверх
// раннего.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootShell, settle } from './act-as-shell-harness.mjs';

const ADMIN = { id: 1, username: 'boss', full_name: 'Петров П.', role: 'admin', is_active: true, is_doctor: false,
    extra_roles: [], custom_role_code: null, department_id: null, must_change_password: false, acting_admin: null };
const ACTING = { id: 3, username: 'doc', full_name: 'Иванова А.', role: 'doctor', is_active: true, is_doctor: true,
    extra_roles: [], custom_role_code: null, department_id: null, must_change_password: false,
    acting_admin: { id: 1, full_name: 'Петров П.' } };
// Первый /me — ещё администратор (номер 0); второй и дальше — уже от имени сотрудника (номер 7).
const S = await bootShell({ meBody: (n) => (n === 0 ? { user: ADMIN, act_as_id: 0 } : { user: ACTING, act_as_id: 7 }) });

test('экран собран по второму /me (сотрудник) — и запросы несут его номер 7, а не 0 из первого', async () => {
    const u = globalThis.window.easymed && globalThis.window.easymed.state.user;
    assert.ok(u, 'оболочка поднялась');
    assert.equal(u.id, 3, 'экран — сотрудника');
    assert.ok(S.CALLS.filter((c) => c.url.startsWith('/api/auth/me')).length >= 2, 'загрузка спрашивает /me дважды');
    S.CALLS.length = 0;
    const { supabase } = await import('../../supabase.js');
    await supabase.rpc('procedures_list', {});
    await supabase.from('visits').select('id');
    await settle(10);
    const api = S.CALLS.filter((c) => !c.url.startsWith('/api/auth/'));
    assert.ok(api.length >= 2, JSON.stringify(S.CALLS.map((c) => c.url)));
    for (const c of api) assert.equal(c.headers['x-em-act-as'], '7', c.url);
});

test('глушим таймеры оболочки', () => { S.stopTimers(); });
