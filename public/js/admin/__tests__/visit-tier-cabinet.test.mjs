// VISIT_TIER_ON_JOIN_V1 (3.23.0, ревью потока G) — КАБИНЕТ ВРАЧА: СМЕТА, СТРОКА И СЧЁТ — ОДНА
// ЦЕНА ВИЗИТА.
//
// «Добавить» на карточке «Услуги приёма» открывает каталог на дне визита приёма
// (packageDay), и смета каталога после VISIT_TIER_ON_JOIN_V1 спрашивает цену на ЭТОТ день.
// А строку пишет addOwnService — своей котировкой: с visit_id, но БЕЗ дня (сервер брал
// сегодня). Касса считает ярус по дню визита без самого визита (billing.js quoteTier).
// Числа ревью: УЗИ 80 000 / второй 20 000 через 3–5 дн.; прошлый УЗИ 7 дней назад; врач
// добавляет УЗИ к приёму 3 дня назад (4 дня после прошлого — второй визит):
//   • смета — «Второй визит» 20 000;
//   • строка — первичная 80 000 (сегодня — 7 дней, окно прошло): пациент переплатил 60 000,
//     а счёт врача отказан («Тариф визита в строке … не совпадает с расчётом сервера»).
// Теперь addOwnService спрашивает на день визита приёма, а каталог кабинета получает visitId
// (строки самого визита — не «прошлый визит»).
//
// Стенд: поддельный DOM кабинета (cabinet-harness.mjs), котировка и строка визита — через
// настоящий реестр RPC и настоящую SQLite; запись документа кабинета (notes) — заглушкой.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, TOASTS } from './cabinet-harness.mjs';

const test = (name, opts, fn) => (typeof opts === 'function' ? nodeTest(name, { timeout: 30000 }, opts) : nodeTest(name, { timeout: 30000, ...opts }, fn));
const HERE = path.dirname(fileURLToPath(import.meta.url));

installFakeDom();
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
globalThis.DOMParser = class {
    parseFromString(s) {
        const inner = String(s).replace(/^<div id="[^"]+">/, '').replace(/<\/div>$/, '');
        return { getElementById: () => ({ innerHTML: inner }), createTreeWalker: () => ({ nextNode: () => null }) };
    }
};
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
globalThis.window.dispatchEvent = () => true;

process.env.LIS_ENABLED = '0';
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { createInvoiceForVisit } = await import('../../../../server/services/rpc/billing.js');

const DOCTOR = { id: 5, role: 'doctor', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
let DB = null;
const NOTES = new Map();
const QUOTES = [];
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u === '/api/rpc/service_price_quote') {
        QUOTES.push(body);
        try { return ok(getRpc('service_price_quote')(DB, body, DOCTOR)); } catch (e) { return resp(false, e.status || 500, { error: { message: e.message } }); }
    }
    if (u.startsWith('/api/rpc/')) return ok({ id: 1 });
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        // Строка визита врача — в настоящую базу, как дверь /api/db.
        if (body.table === 'visit_services' && body.op === 'insert') {
            const { sql, params, meta } = compile(body, DOCTOR, { db: DB });
            const info = DB.prepare(sql).run(...params);
            const row = DB.prepare(`SELECT ${readableColumns('visit_services').map((c) => `"${c}"`).join(', ')} FROM visit_services WHERE rowid = ?`).get(info.lastInsertRowid);
            return ok(meta.single ? row : [row]);
        }
        // Документ кабинета (notes строки приёма) — заглушка.
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            if (body.values && Object.prototype.hasOwnProperty.call(body.values, 'notes')) NOTES.set(id, body.values.notes);
            return ok(null);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });

// Визит сервер находит по местному дню SQLite, а кабинет — по часам JS: в прогоне tz-late
// (сдвинут только пояс JS) дни расходятся, проверка дней не имеет смысла.
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TZ_SPLIT = (() => {
    const db = openDb(':memory:');
    const iso = '2030-01-07T00:30:00Z';
    const sql = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') AS v").get(iso).v;
    db.close();
    const d = new Date(iso);
    return sql === `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` ? false
        : 'пояс JS не совпадает с поясом SQLite (предзагрузка tz-late) — дни визитов не сверить';
})();
const dayAt = (off, hh = 10) => { const d = new Date(); d.setHours(hh, 0, 0, 0); d.setDate(d.getDate() + off); return d; };

/** УЗИ 80 000 / второй 20 000 через 3–5 дн.; прошлый УЗИ `prevDaysAgo` дн. назад; приём врача — `visitDaysAgo` дн. назад. */
function seed({ prevDaysAgo, visitDaysAgo }) {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Администратор','admin')").run();
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates) VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{\"service_id\":22,\"pct\":10}]')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Тестов Тест')").run();
    db.prepare(`INSERT INTO services (id, name, price, type, active, requires_doctor, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to)
                VALUES (22,'УЗИ брюшной полости',80000,'imaging',1,1,20000,3,5,10000,6,10)`).run();
    const v0 = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (3, 5, ?, 'arrived', 1)").run(dayAt(-prevDaysAgo).toISOString()).lastInsertRowid);
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, unit_price, total, status, price_tier, created_by) VALUES (?, 22, 5, 80000, 80000, 'completed', 'primary', 5)").run(v0);
    const at = dayAt(-visitDaysAgo);
    const v1 = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (3, 5, ?, 'arrived', 1)").run(at.toISOString()).lastInsertRowid);
    // Строка приёма врача (консультация), на которой открыт кабинет.
    const own = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, unit_price, total, status, created_by) VALUES (?, NULL, 5, 0, 0, 'in_progress', 5)").run(v1).lastInsertRowid);
    if (DB) DB.close();
    DB = db;
    return { visitId: v1, ownLine: own, visitDate: at.toISOString() };
}
function cabinet({ visitId, ownLine, visitDate }) {
    const container = new El('div');
    const ctx = { container, visitServiceId: ownLine, visitId,
        patient: { id: 3, lastName: 'Тестов', firstName: 'Тест', mrn: 'P-3',
            __service: { id: ownLine, name: 'Приём', doctorId: 5, doctorName: 'Узистов Улугбек', doctorSpec: 'УЗИ', visitDate } } };
    NOTES.set(ownLine, JSON.stringify({ __service_workspace_v1: 1, current: null, history: [] }));
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    return ctx;
}
const UZI = { id: 22, name: 'УЗИ брюшной полости', price: 80000 };
const added = () => DB.prepare("SELECT id, price_tier, unit_price FROM visit_services WHERE service_id = 22 AND status = 'added'").get();

test('приём 3 дня назад, прошлый УЗИ 7 дней назад (к приёму 4 дня, окно 3–5): строка — «второй», 20 000; счёт — 20 000; котировка — на день приёма', { skip: TZ_SPLIT }, async () => {
    const s = seed({ prevDaysAgo: 7, visitDaysAgo: 3 });
    QUOTES.length = 0; TOASTS.length = 0;
    const ctx = cabinet(s);
    await WS.hydrateLine(ctx);
    await WS.addOwnService(ctx, UZI, null);
    const q = QUOTES[QUOTES.length - 1];
    assert.ok(q, 'котировка не спрошена');
    assert.equal(q.date, ymd(dayAt(-3)), 'котировка не на день приёма — сервер посчитал на сегодня');
    assert.equal(Number(q.visit_id), s.visitId);
    const line = added();
    assert.ok(line, 'строка не легла: ' + JSON.stringify(TOASTS));
    assert.deepEqual([line.price_tier, line.unit_price], ['secondary', 20000], 'строка не по ярусу дня приёма (переплата 60 000)');
    const inv = createInvoiceForVisit(DB, { visit_id: s.visitId, visit_service_ids: [line.id] }, ADMIN);
    assert.equal(inv.items[0].unit_price, 20000, 'счёт — не цена строки');
});

test('приём 3 дня назад, прошлый УЗИ 4 дня назад (к приёму 1 день — раньше окна): строка «первичный», 80 000; счёт 80 000', { skip: TZ_SPLIT }, async () => {
    const s = seed({ prevDaysAgo: 4, visitDaysAgo: 3 });
    QUOTES.length = 0; TOASTS.length = 0;
    const ctx = cabinet(s);
    await WS.hydrateLine(ctx);
    await WS.addOwnService(ctx, UZI, null);
    const line = added();
    assert.ok(line, 'строка не легла: ' + JSON.stringify(TOASTS));
    assert.deepEqual([line.price_tier, line.unit_price], ['primary', 80000], 'на сегодня (4 дня) — второй визит, а приём был через 1 день после прошлого');
    const inv = createInvoiceForVisit(DB, { visit_id: s.visitId, visit_service_ids: [line.id] }, ADMIN);
    assert.equal(inv.items[0].unit_price, 80000);
});

test('каталог кабинета получает visitId приёма — смета не считает строки самого приёма «прошлым визитом»', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
    const card = src.match(/function servicesCard\(ctx\)[\s\S]*?\n\}/);
    assert.ok(card, 'servicesCard не найден');
    const call = card[0].match(/openServicePickerModal\(\{[\s\S]*?\n\s*\}\)/);
    assert.ok(call, 'вызов каталога не найден');
    assert.match(call[0], /visitId:\s*ctx\.visitId/, 'каталог кабинета без visitId — смета и строка расходятся');
});

nodeTest.after(() => { if (DB) DB.close(); DB = null; });
