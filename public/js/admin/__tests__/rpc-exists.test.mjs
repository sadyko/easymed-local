// RPC_EXISTS_V1 (2026-09-16) — ЭКРАН НЕ ЗОВЁТ RPC, КОТОРОГО НА СЕРВЕРЕ НЕТ.
//
// Картотека пациентов у КАЖДОГО показывала «визитов не было» и «0 сум», потому
// что числа она просила у `patient_base_aggregates` — а такого обработчика на
// сервере не существовало вовсе. Ответ 501 экран глотал (вызов обёрнут в
// try/catch), и пустота выглядела как правда. Ровно так же молчат и другие
// кнопки, зовущие несуществующие RPC.
//
// Тест статический: вытаскивает каждый `supabase.rpc('имя')` из public/js и
// сверяет с картой обработчиков server/services/rpc/index.js.
//
// ЧТО ЗАМОРОЖЕНО. Оставшиеся вызовы — из экранов облачной сборки, которых в
// офлайн-версии нет (закупки по партиям, маркетинг, чат поддержки, кабинет
// врача в облаке). Они перечислены поимённо: список может только СОКРАЩАТЬСЯ —
// новый неизвестный вызов валит тест.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.join(HERE, '..', '..');                       // public/js
const RPC_INDEX = path.join(HERE, '..', '..', '..', '..', 'server', 'services', 'rpc', 'index.js');

// Вызовы, живущие в облачных остатках. Каждая строка — «экран есть на диске, но
// в офлайн-сборке он либо отключён, либо ведёт в тупик»; чинить их надо вместе
// с самим экраном, а не подпоркой в этом списке.
const KNOWN_CLOUD_LEFTOVERS = new Set([
    'admin_reset_user_password',      // employee-editor.js / section-crud.js — сброс пароля делает /api/users; settings:users уводит в #employees (RPC_PORT_V1)
    // claim_*/release_*/restore_* скидок — RPC_PORT_V1: калькулятор больше их не зовёт.
    // 'create_requisition' — реализован (DEPARTMENTS_V1): заявка отдела на склад.
    'dispose_batch_stock',
    'get_or_create_batch',
    'get_or_create_batch_v2',
    'current_user_is_admin',          // employee-editor.js — офлайн решает роль на сервере
    'current_user_can_manage_staff',
    'mark_support_read_user',         // чат поддержки: кнопка убрана из admin.html
    'send_support_message',
    // 'update_my_doctor_profile' — реализован (RPC_PORT_V1, rpc/doctor-profile.js).
]);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== '__tests__') walk(p, out); }
        else if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(p);
    }
    return out;
}

function serverRpcNames() {
    const src = fs.readFileSync(RPC_INDEX, 'utf8');
    const body = src.slice(src.indexOf('export const RPC = {'), src.length);
    return new Set([...body.matchAll(/^\s{2}([a-z0-9_]+):\s/gm)].map((m) => m[1]));
}

test('каждый RPC, который зовёт экран, есть на сервере', () => {
    const known = serverRpcNames();
    assert.ok(known.size > 100, 'карту обработчиков не удалось прочитать: ' + known.size);
    const missing = new Map();
    for (const file of walk(JS_ROOT)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/supabase\.rpc\(\s*'([a-z0-9_]+)'/g)) {
            const name = m[1];
            if (known.has(name) || KNOWN_CLOUD_LEFTOVERS.has(name)) continue;
            const where = path.relative(JS_ROOT, file).replace(/\\/g, '/');
            if (!missing.has(name)) missing.set(name, where);
        }
    }
    assert.deepEqual([...missing.entries()], [],
        'этих обработчиков нет на сервере — экран получит 501 и промолчит');
});

test('замороженный список только сокращается: в нём нет того, что уже реализовано', () => {
    const known = serverRpcNames();
    const stale = [...KNOWN_CLOUD_LEFTOVERS].filter((n) => known.has(n));
    assert.deepEqual(stale, [], 'обработчик появился — уберите имя из списка облачных остатков');
});
