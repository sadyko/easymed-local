// PRINT_VISIT_DATE_V1 (3.21.0) — ДАТА В ПЕЧАТИ ПРОТОКОЛА — ДЕНЬ ПРИЁМА.
//
// Часть 2 — кабинет врача на НАСТОЯЩЕЙ форме (cabinet-harness.mjs): экран
// (шапка формы и бланк), «Печать» (docSnapshot) и архивная копия при подписи
// (visit_document_archive) датированы днём приёма — и у заключения, и у листа
// диагностики; «Тип визита» — ступень цены строки, а не «Первичный приём».
// Пояс задан явно — день МЕСТНЫЙ.
process.env.TZ = 'Asia/Tashkent';

const { default: nodeTest } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { readFileSync } = await import('node:fs');
const { installFakeDom, El } = await import('./cabinet-harness.mjs');

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
const ARCHIVE = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('/visit_document_archive')) ARCHIVE.push(body);
        if (u.endsWith('/refunded_lines')) return ok({ line_ids: [] });
        return ok({ id: 1 });
    }
    if (u === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.op === 'update') { if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const { dateNumeric } = await import('../../shared/date-words.js');

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
globalThis.window.easymed = { state: { user: DOCTOR } };
const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const TODAY = dateNumeric(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d; };
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });

function cabinet(id, svc = {}, notes = notesOf({ chief_complaint: 'Кашель', conclusion_text: 'Здоров' }), type = 'conclusion') {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, onNavigate: () => {},
        patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
            __service: { id, name: 'Услуга ' + id, doctorName: 'Иванова А.', doctorSpec: 'Терапевт', ...svc } } };
    NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}

test('приём 3 дня назад — заключение: шапка формы, «Печать» и архивная копия при подписи — день приёма', async () => {
    const day = daysAgo(3);
    const want = dateNumeric(day);
    const ctx = cabinet(71, { visitDate: day.toISOString() });
    await WS.hydrateLine(ctx);
    const lh = ctx.container.querySelector('.a4-lh-date');
    assert.ok(lh && lh.textContent.includes(want), 'шапка формы — не день приёма: ' + (lh && lh.textContent));
    const snap = WS.docSnapshot(ctx, 'conclusion');
    assert.equal(snap.issueDate, want, '«Печать» датирована не днём приёма');
    for (const v of ['classic', 'compact']) {
        const t = text(renderDesignedVariant('conclusion', v, S, snap));
        assert.ok(t.includes(want), v + ': на листе нет дня приёма');
        assert.ok(!t.includes(TODAY), v + ': на листе сегодняшний день');
    }
    ARCHIVE.length = 0;
    await WS.signDocument(ctx);
    assert.equal(ARCHIVE.length, 1, 'архивная копия не записана');
    assert.equal(ARCHIVE[0].doc_type, 'protocol');
    assert.equal(ARCHIVE[0].body.issueDate, want, 'архивная копия датирована днём подписи');
});

test('приём 3 дня назад — лист диагностики: «Выдан» на экране, в «Печати» и в архиве — день приёма', async () => {
    const day = daysAgo(3);
    const want = dateNumeric(day);
    const ctx = cabinet(72, { visitDate: day.toISOString(), name: 'УЗИ почек' },
        notesOf({ instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' }, { docType: 'diag' }), 'diag');
    await WS.hydrateLine(ctx);
    const snap = WS.docSnapshot(ctx, 'diag');
    assert.equal(snap.dateOut, want, 'у листа диагностики нет dateOut — бланк печатает сегодня');
    assert.equal(snap.issueDate, want);
    for (const v of ['classic', 'compact']) {
        const t = text(renderDesignedVariant('diag', v, S, snap));
        assert.ok(t.includes(want), v + ': на листе нет дня приёма');
        assert.ok(!t.includes(TODAY), v + ': на листе сегодняшний день');
    }
    ARCHIVE.length = 0;
    await WS.signDocument(ctx);
    assert.equal(ARCHIVE.length, 1, 'архивная копия не записана');
    assert.equal(ARCHIVE[0].doc_type, 'diag');
    assert.equal(ARCHIVE[0].body.dateOut, want, 'архивный лист диагностики датирован днём подписи');
});

test('визит в 00:30 по местному (вчерашний день UTC) — лист датирован МЕСТНЫМ днём', async () => {
    const local = new Date(2026, 9, 31, 0, 30);   // 31.10.2026 00:30 Ташкент = 30.10.2026 19:30Z
    assert.equal(local.toISOString(), '2026-10-30T19:30:00.000Z', 'стенд: пояс не Ташкент');
    const ctx = cabinet(73, { visitDate: local.toISOString() });
    await WS.hydrateLine(ctx);
    assert.equal(WS.docSnapshot(ctx, 'conclusion').issueDate, '31.10.2026');
});

test('нет дня визита — день первой подписи записи (переподпись не двигает дату)', async () => {
    const SIGNED = { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', by: 3, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель' } };
    const ctx = cabinet(74, {}, notesOf({ chief_complaint: 'Кашель' }, { history: [SIGNED] }));
    await WS.hydrateLine(ctx);
    assert.equal(WS.docSnapshot(ctx, 'conclusion').issueDate, '01.10.2026');
});

test('«Тип визита» — ступень цены строки: повторный — печатается, первичная ступень и консультация — строки нет', async () => {
    const t = async (id, priceTier) => {
        const ctx = cabinet(id, { visitDate: daysAgo(1).toISOString(), priceTier });
        await WS.hydrateLine(ctx);
        const snap = WS.docSnapshot(ctx, 'conclusion');
        return { snap, html: text(renderDesignedVariant('conclusion', 'classic', S, snap)) };
    };
    const rep = await t(75, 'repeat');
    assert.equal(rep.snap.visitType, 'Повторный визит');
    assert.match(rep.html, /Тип визита Повторный визит/);
    const sec = await t(76, 'secondary');
    assert.match(sec.html, /Тип визита Второй визит/);
    for (const [id, tier] of [[77, 'primary'], [78, null]]) {
        const r = await t(id, tier);
        assert.ok(!r.html.includes('Тип визита') && !r.html.includes('Первичный приём'), String(tier) + ': выдуманный «Тип визита»');
    }
});

test('очередь кабинета передаёт в приём день визита и ступень цены строки', () => {
    const src = readFileSync(new URL('../views/consultation.js', import.meta.url), 'utf8');
    const load = (src.match(/async function loadServices\(\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(load, /consultation_type_id, price_tier,/, 'очередь не читает price_tier');
    assert.match(load, /priceTier:\s+r\.price_tier \|\| null,/);
    const open = (src.match(/async function openWorkspace\(r\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(open, /visitDate:\s+r\.visitDate \|\| null,/);
    assert.match(open, /priceTier:\s+r\.priceTier \|\| null,/, 'приём не получает ступень цены строки');
});

// PRINT_VISIT_DATE_V1 (ревью M1) — день визита, но не позже первой подписи (пока подписи
// нет — не позже сегодня): «Мои приёмы» показывают будущие записи, и «Начать» на них есть.
test('приём записан на послезавтра, проведён сегодня — шапка, «Печать» и архив — сегодня, не будущий день', async () => {
    const ahead = dateNumeric(daysAgo(-2));
    const ctx = cabinet(79, { visitDate: daysAgo(-2).toISOString() });
    const before = ctx.container.querySelector('.a4-lh-date');
    assert.ok(before && before.textContent.includes(TODAY), 'шапка формы до чтения записей — будущий день: ' + (before && before.textContent));
    await WS.hydrateLine(ctx);
    const lh = ctx.container.querySelector('.a4-lh-date');
    assert.ok(lh && lh.textContent.includes(TODAY) && !lh.textContent.includes(ahead), 'шапка формы — будущий день: ' + (lh && lh.textContent));
    const snap = WS.docSnapshot(ctx, 'conclusion');
    assert.equal(snap.issueDate, TODAY, '«Печать» датирована будущим днём');
    ARCHIVE.length = 0;
    await WS.signDocument(ctx);
    assert.equal(ARCHIVE.length, 1, 'архивная копия не записана');
    assert.equal(ARCHIVE[0].body.issueDate, TODAY, 'архивная копия датирована будущим днём');
});

test('подписано заранее (вчера) для визита послезавтра — при новом открытии шапка и «Печать» — день подписи', async () => {
    const signedDay = daysAgo(1);
    const SIGNED = { kind: 'signed', savedAt: signedDay.toISOString(), by: 3, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель' } };
    const ctx = cabinet(80, { visitDate: daysAgo(-2).toISOString() }, notesOf({ chief_complaint: 'Кашель' }, { history: [SIGNED] }));
    await WS.hydrateLine(ctx);
    const want = dateNumeric(signedDay);
    assert.equal(WS.docSnapshot(ctx, 'conclusion').issueDate, want, '«Печать» — не день подписи');
    const lh = ctx.container.querySelector('.a4-lh-date');
    assert.ok(lh && lh.textContent.includes(want), 'шапка формы не пересчитана по подписи: ' + (lh && lh.textContent));
});
