// CABINET_FIX_V1_R5 (2026-10-02) — РЕВЬЮ 5: ЗАПИСИ КАБИНЕТА — «СРАВНИТЬ И
// ЗАМЕНИТЬ»: СТАРАЯ КОПИЯ НИЧЕГО НЕ ПЕРЕЗАПИСЫВАЕТ (ВТОРАЯ ВКЛАДКА, ПОЗДНЯЯ
// ПОДПИСЬ); ПОЗДНЯЯ ПОДПИСЬ ДОДЕЛЫВАЕТ СВОЁ; ПРОБЕЛЫ ЗАПОРА ЗАГРУЗКИ.
//
// Фальшивый сервер держит то же правило, что /api/db: notesWriteRefusal из
// public/js/shared/cabinet-notes.js (основа записи — __notes_base).
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, CONFIRMS, TOASTS, answerConfirm } from './cabinet-harness.mjs';
import { notesWriteRefusal, NOTES_BASE_KEY } from '../../shared/cabinet-notes.js';

// ревью 5, F — тест, который повис бы, падает по сроку, а не держит весь файл
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
globalThis.DOMParser = class {
    parseFromString(s) {
        const inner = String(s).replace(/^<div id="[^"]+">/, '').replace(/<\/div>$/, '');
        return { getElementById: () => ({ innerHTML: inner }), createTreeWalker: () => ({ nextNode: () => null }) };
    }
};

// ─── фальшивый сервер ─────────────────────────────────────────────────────────
const NOTES = new Map();
const HOLD = new Map();
const LOG = [];
const hold = (key) => { let release; HOLD.set(key, new Promise((r) => { release = r; })); return () => { HOLD.delete(key); release(); }; };
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('visit_document_archive')) LOG.push({ kind: 'archive', body });
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) {
                if (HOLD.has('read:' + id)) await HOLD.get('read:' + id);
                return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            }
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            if (HOLD.has('write:' + id)) await HOLD.get('write:' + id);
            const values = { ...(body.values || {}) };
            const base = values[NOTES_BASE_KEY];
            delete values[NOTES_BASE_KEY];
            if (Object.prototype.hasOwnProperty.call(values, 'notes')) {
                const refusal = notesWriteRefusal(NOTES.has(id) ? NOTES.get(id) : null, values.notes, base);
                if (refusal) { LOG.push({ kind: '409', id, reason: refusal.reason }); return resp(false, 409, { error: { code: 'notes_conflict', reason: refusal.reason, message: refusal.message } }); }
                NOTES.set(id, values.notes);
            }
            LOG.push({ kind: 'line', id, values });
            return ok(null);
        }
        if (body.table === 'visits' && body.op === 'update') { LOG.push({ kind: 'visit', id, values: body.values }); return ok(null); }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
const parsed = (id) => JSON.parse(NOTES.get(id));
const kinds = (id) => parsed(id).history.map((e) => e.kind);
const SIGNED = (fields, at = '2026-10-01T08:00:00.000Z') => ({ kind: 'signed', savedAt: at, by: null, byName: 'Каримов Алишер', fields });

function cabinet(id, notes = notesOf(null), { container = new El('div'), type = 'conclusion' } = {}) {
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' } } };
    if (notes != null) NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}
async function opened(id, notes, o) { const ctx = cabinet(id, notes, o); await WS.hydrateLine(ctx); return ctx; }
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const put = (ctx, k, v) => { field(ctx, k).innerHTML = v; };
const typeIn = (ctx, k, v) => { put(ctx, k, v); field(ctx, k).dispatch('input'); };
const touch = (ctx) => ctx.container.dispatch('pointerdown');

// ─── A: основа записи ────────────────────────────────────────────────────────
test('A: каждая запись несёт основу; два сохранения подряд — оба проходят (основа обновляется от записанного)', async () => {
    const a = await opened(1, notesOf({ chief_complaint: 'Кашель' }));
    put(a, 'chief_complaint', 'Кашель 1');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    put(a, 'chief_complaint', 'Кашель 2');
    assert.ok(await WS.saveDraft(a, { silent: true }), 'второе сохранение отказано — основа не обновилась');
    assert.equal(parsed(1).current.chief_complaint, 'Кашель 2');
    const sent = LOG.filter((e) => e.kind === 'line' && e.id === 1);
    assert.equal(sent.length, 2);
});

test('A (P-2): две вкладки, только черновики: вкладка A сохранила, устаревшая B — отказ, текст A цел, текст B на экране; второе «Сохранить» B — осознанно поверх', async () => {
    const a = await opened(2, notesOf({ chief_complaint: 'Исходно' }), { container: new El('div') });
    const b = await opened(2, null, { container: new El('div') });
    touch(a);
    put(a, 'chief_complaint', 'ТЕКСТ-A');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    touch(b);
    put(b, 'chief_complaint', 'ТЕКСТ-B');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(b, { silent: true }), false, 'устаревшая вкладка перезаписала черновик другой');
    assert.equal(parsed(2).current.chief_complaint, 'ТЕКСТ-A', 'черновик вкладки A стёрт');
    assert.ok(TOASTS.some((t) => /Документ изменился, пока шло сохранение.*Ваш текст остался на экране/.test(t)), TOASTS.join(' | '));
    assert.ok(!TOASTS.some((t) => /в другом окне/.test(t)));
    assert.equal(field(b, 'chief_complaint').innerHTML, 'ТЕКСТ-B', 'текст вкладки B пропал с экрана');
    assert.ok(await WS.saveDraft(b, { silent: true }));
    assert.equal(parsed(2).current.chief_complaint, 'ТЕКСТ-B');
});

// ─── R4-1 / D: поздняя подпись ───────────────────────────────────────────────
test('R4-1: подпись не ответила в срок; пока ответа нет, строка не пишется; черновик другого окна лёг ПЕРВЫМ, поздняя подпись — ВТОРОЙ: отказ, черновик цел', async () => {
    WS.__setTimingForTests({ signTimeoutMs: 50 });
    try {
        LOG.length = 0;
        const a = await opened(3, notesOf(null));
        WS.applyFields(a, { chief_complaint: 'ВЕРСИЯ-1' });
        answerConfirm(true); TOASTS.length = 0;
        const release = hold('write:3');
        await WS.signDocument(a);
        assert.ok(TOASTS.some((t) => /Сервер не ответил вовремя/.test(t)), TOASTS.join(' | '));
        assert.ok(WS.lineWritePending(3), 'строка не заперта, пока ответа на подпись нет');
        assert.ok(a.container.querySelectorAll('[data-ws-finish]').every((b) => !b.disabled), 'кнопка заперта — а должна оставаться доступной');
        put(a, 'chief_complaint', 'ВЕРСИЯ-2');
        TOASTS.length = 0;
        assert.equal(await WS.saveDraft(a, { silent: true }), false, 'черновик записан, пока подпись «в пути»');
        assert.ok(TOASTS.some((t) => /ещё не ответил на прошлое сохранение/.test(t)));
        // другое окно сохранило черновик, пока подпись этой вкладки висела
        const other = JSON.parse(NOTES.get(3));
        other.current = { chief_complaint: 'ДРУГОЕ-ОКНО' };
        other.history = [{ kind: 'draft', savedAt: '2026-10-02T09:30:00.000Z', fields: other.current }];
        NOTES.set(3, JSON.stringify(other));
        TOASTS.length = 0;
        release(); await tick(20);
        assert.equal(parsed(3).current.chief_complaint, 'ДРУГОЕ-ОКНО', 'поздняя подпись перезаписала черновик, легший раньше');
        assert.ok(LOG.some((e) => e.kind === '409' && e.id === 3));
        assert.ok(TOASTS.some((t) => /Подпись не прошла: документ изменился/.test(t)), TOASTS.join(' | '));
        assert.equal(WS.lineWritePending(3), false);
        assert.equal(field(a, 'chief_complaint').innerHTML, 'ВЕРСИЯ-2', 'текст врача пропал с экрана');
        assert.ok(await WS.saveDraft(a, { silent: true }));
        assert.equal(parsed(3).current.chief_complaint, 'ВЕРСИЯ-2');
    } finally { WS.__setTimingForTests({ signTimeoutMs: 30000 }); }
});

test('D: подпись дошла после срока, и между ними ничего — подпись доделывает своё: архив, заключение визита, «дошла с опозданием»; врача из строки не уводит', async () => {
    WS.__setTimingForTests({ signTimeoutMs: 50 });
    try {
        LOG.length = 0;
        const a = await opened(4, notesOf(null));
        const NAV = []; a.onNavigate = (v) => NAV.push(v);
        WS.applyFields(a, { chief_complaint: 'Жалобы', conclusion_text: 'Здоров' });
        answerConfirm(true); TOASTS.length = 0;
        const release = hold('write:4');
        await WS.signDocument(a);
        assert.equal(LOG.filter((e) => e.kind === 'archive').length, 0);
        put(a, 'chief_complaint', 'Жалобы, набрано после срока');   // врач продолжает работать в строке
        TOASTS.length = 0;
        release(); await tick(20);
        assert.deepEqual(kinds(4), ['signed']);
        assert.equal(LOG.filter((e) => e.kind === 'archive').length, 1, 'поздняя подпись без копии в архиве');
        assert.ok(TOASTS.some((t) => /Подпись дошла до сервера с опозданием — документ подписан/.test(t)), TOASTS.join(' | '));
        assert.equal(WS.lineWritePending(4), false);
        // поздний ответ не уводит врача из строки, где он, может быть, уже пишет дальше
        await tick(700);
        assert.deepEqual(NAV, [], 'поздняя подпись увела врача к списку услуг');
        assert.equal(field(a, 'chief_complaint').innerHTML, 'Жалобы, набрано после срока', 'набранное после срока пропало с экрана');
        put(a, 'chief_complaint', 'Жалобы, позже');
        assert.ok(await WS.saveDraft(a, { silent: true }), 'после поздней подписи строка не пишется');
        assert.deepEqual(kinds(4), ['signed', 'draft']);
    } finally { WS.__setTimingForTests({ signTimeoutMs: 30000 }); }
});

test('D: «Завершить приём», пока ответа на прошлую подпись нет, — объяснение, без второй записи', async () => {
    WS.__setTimingForTests({ signTimeoutMs: 50 });
    try {
        LOG.length = 0;
        const a = await opened(5, notesOf(null));
        WS.applyFields(a, { chief_complaint: 'Жалобы' });
        answerConfirm(true);
        const release = hold('write:5');
        await WS.signDocument(a);
        CONFIRMS.length = 0; TOASTS.length = 0;
        await WS.signDocument(a);
        assert.deepEqual(CONFIRMS, [], 'спросила «подписать?» ещё раз, пока прошлая подпись без ответа');
        assert.ok(TOASTS.some((t) => /ещё не ответил/.test(t)), TOASTS.join(' | '));
        release(); await tick(20);
        assert.equal(LOG.filter((e) => e.kind === 'line' && e.id === 5).length, 1);
    } finally { WS.__setTimingForTests({ signTimeoutMs: 30000 }); }
});

// ─── E: сроки ────────────────────────────────────────────────────────────────
test('E: черновик перед подписью («Завершить приём») и перечитывание устаревшей копии — со сроком, без вечного ожидания', async () => {
    WS.__setTimingForTests({ writeTimeoutMs: 50, signTimeoutMs: 50 });
    try {
        const a = await opened(6, notesOf(null));
        WS.applyFields(a, { chief_complaint: 'Жалобы' });
        answerConfirm(true); TOASTS.length = 0;
        const release = hold('write:6');
        const done = await Promise.race([WS.finishVisit(a).then(() => 'done'), tick(2000).then(() => 'hang')]);
        assert.equal(done, 'done', '«Завершить приём» повисла на записи черновика');
        assert.ok(TOASTS.some((t) => /Сервер не ответил вовремя/.test(t)));
        release(); await tick(20);
        const b = await opened(7, notesOf({ chief_complaint: 'Текст' }));
        WS.invalidateLine(7);
        const releaseRead = hold('read:7');
        TOASTS.length = 0;
        const s = await Promise.race([WS.signDocument(b).then(() => 'done'), tick(2000).then(() => 'hang')]);
        assert.equal(s, 'done', 'подпись повисла на перечитывании');
        assert.ok(TOASTS.some((t) => /Сервер не ответил/.test(t)), TOASTS.join(' | '));
        releaseRead(); await tick(10);
    } finally { WS.__setTimingForTests({ writeTimeoutMs: 30000, signTimeoutMs: 30000 }); }
});

// ─── E: [U] и загрузка версии в форму ───────────────────────────────────────
test('E (R4-3): «Возобновить» / «Загрузить в форму» после набора — смена языка показывает загруженную версию, а не прежний набор', async () => {
    const root = new El('div');
    const a = await opened(8, notesOf({ chief_complaint: 'СОХРАНЕНО' }), { container: root });
    typeIn(a, 'chief_complaint', 'НАБРАНО');
    WS.applyFields(a, { chief_complaint: 'ВЕРСИЯ-ИЗ-ИСТОРИИ' });   // так «Возобновить» и «Загрузить в форму» кладут версию
    const b = await opened(8, null, { container: root });
    assert.equal(field(b, 'chief_complaint').innerHTML, 'ВЕРСИЯ-ИЗ-ИСТОРИИ', 'вернулся прежний набор');
});

test('F (M4): после подписи несохранённое забыто — перерисовка показывает запись сервера (и её поздние правки), а не старый набор', async () => {
    const root = new El('div');
    // раздел «Жалобы» включён (у пустого документа разделы выключены и набранное в них не собирается)
    const a = await opened(9, notesOf({ chief_complaint: 'Исходно' }), { container: root });
    typeIn(a, 'chief_complaint', 'ПОДПИСАНО-A');
    answerConfirm(true);
    await WS.signDocument(a);
    assert.equal(parsed(9).history.at(-1).fields.chief_complaint, 'ПОДПИСАНО-A', 'подписано не набранное — проверка ничего не проверяет');
    const later = JSON.parse(NOTES.get(9));
    later.current = { chief_complaint: 'ПОЗЖЕ-ДРУГАЯ-ВКЛАДКА' };
    NOTES.set(9, JSON.stringify(later));
    const b = await opened(9, null, { container: root });
    assert.equal(field(b, 'chief_complaint').innerHTML, 'ПОЗЖЕ-ДРУГАЯ-ВКЛАДКА', 'после подписи вернулся старый несохранённый набор');
});

test('F (M16): несохранённое одной строки не попадает в другую строку того же корня', async () => {
    const root = new El('div');
    const a = await opened(10, notesOf({ chief_complaint: 'СВОЁ-10' }), { container: root });
    typeIn(a, 'chief_complaint', 'ЧУЖОЙ-10');
    const b = await opened(11, notesOf({ chief_complaint: 'СВОЁ-11' }), { container: root });
    assert.equal(field(b, 'chief_complaint').innerHTML, 'СВОЁ-11', 'несохранённое строки 10 легло в строку 11');
});

// ─── E: пробелы запора загрузки ──────────────────────────────────────────────
test('E: пока строка грузится — снимки исследования и «×» раздела отказывают (а не пропадают молча при загрузке)', async () => {
    const release = hold('read:12');
    const ctx = cabinet(12, notesOf({ chief_complaint: 'СОХРАНЕНО' }));
    const loading = WS.hydrateLine(ctx);
    await tick(5);
    TOASTS.length = 0;
    await WS.diagAddImages(ctx, [{ type: 'image/jpeg' }]);
    assert.equal(WS.wsRemoveSection(ctx, 'complaints'), false, '«×» во время загрузки прошло');
    assert.ok(TOASTS.filter((t) => /ещё загружается/.test(t)).length >= 2, TOASTS.join(' | '));
    release(); await loading;
    assert.equal(field(ctx, 'chief_complaint').innerHTML, 'СОХРАНЕНО');
});

// ─── E: entryDx, удаление записи истории ─────────────────────────────────────
test('E: код записи «J20» не «съедает» строку «J20.9 — …» (граница кода)', () => {
    assert.equal(WS.entryDx({ icd10: 'J20', primary_diagnosis: 'J20.9 — Острый бронхит<br>Текст' }, []), 'J20\nJ20.9 — Острый бронхит\nТекст');
    assert.equal(WS.entryDx({ icd10: 'J20.9', primary_diagnosis: 'J20.9 — Острый бронхит<br>Текст' }, []), 'J20.9 — Острый бронхит\nТекст');
});

test('E: удаление записи истории — по самой записи (savedAt), а не по номеру: после перечитывания удаляется та, что выбрана', async () => {
    const R1 = { kind: 'referral', savedAt: '2026-10-02T08:00:00.000Z', service: { name: 'R1' } };
    const R2 = { kind: 'referral', savedAt: '2026-10-02T09:00:00.000Z', service: { name: 'R2' } };
    const R0 = { kind: 'referral', savedAt: '2026-10-02T07:00:00.000Z', service: { name: 'R0' } };
    const ctx = await opened(13, notesOf(null, { history: [R1, R2] }));
    // другая вкладка дописала запись в начало истории; эта перечитала записи
    const other = JSON.parse(NOTES.get(13)); other.history = [R0, R1, R2]; NOTES.set(13, JSON.stringify(other));
    WS.invalidateLine(13);
    answerConfirm(true);
    await WS.deleteHistoryEntry(ctx, R2);
    assert.deepEqual(parsed(13).history.map((e) => e.service.name), ['R0', 'R1'], 'удалена не та запись');
    TOASTS.length = 0;
    await WS.deleteHistoryEntry(ctx, R2);   // уже нет
    assert.ok(TOASTS.some((t) => /уже изменилась/.test(t)));
    assert.deepEqual(parsed(13).history.map((e) => e.service.name), ['R0', 'R1']);
});

// ─── прочее ──────────────────────────────────────────────────────────────────
test('заметка медсестры, лежавшая текстом до первого сохранения кабинета, не пропадает (уходит в nurseNote)', async () => {
    const ctx = await opened(14, 'Заметка медсестры: в/в');
    put(ctx, 'chief_complaint', 'Жалобы');
    assert.ok(await WS.saveDraft(ctx, { silent: true }));
    assert.equal(parsed(14).nurseNote, 'Заметка медсестры: в/в');
});

test('открытие документа диагностики не стирает «Заключение» (до ревью 2, код не первой строкой)', async () => {
    const ctx = await opened(15, notesOf({ instrumental_text: 'Почки', primary_diagnosis: 'Эхопризнаков патологии нет' }, { docType: 'diag', diagnoses: [{ code: 'N28.9', name: 'Болезнь почки', type: 'main' }] }), { type: 'diag' });
    assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Эхопризнаков патологии нет');
});

test('подписи ревью 5 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'Документ изменился, пока шло сохранение. Ваш текст остался на экране — нажмите «Сохранить» ещё раз.',
        'Подпись не прошла: документ изменился, пока шло сохранение. Ваш текст остался на экране — сохраните и подпишите ещё раз.',
        'Сервер не ответил вовремя. Ждём ответа — сохранять можно будет, когда он придёт.',
        'Сервер ещё не ответил на прошлое сохранение — подождите и повторите.',
        'Сохранение дошло до сервера с опозданием — документ сохранён.',
        'Подпись дошла до сервера с опозданием — документ подписан.',
        'Эта запись уже изменилась — список обновлён.',
        'Документ изменился в другом окне или раньше этого сохранения — обновите его и сохраните ещё раз.',
        'В строке — документ кабинета врача; эта правка стёрла бы его.',
        'Записи строки не прочитаны — правка не выполнена.',
        'Документ слишком большой для сохранения (больше 8 МБ) — уберите часть снимков или замените их снимками поменьше и сохраните снова.',
        'Запрос слишком большой — сократите данные и повторите.',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
