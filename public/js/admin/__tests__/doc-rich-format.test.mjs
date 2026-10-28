// DOC_RICH_FORMAT_V1 (2026-10-28) — ОФОРМЛЕНИЕ В ДОКУМЕНТЕ КАБИНЕТА ВРАЧА
// ХРАНИТСЯ И ПОКАЗЫВАЕТСЯ (задача T1: правила F1–F4, F7, F8).
//
// Владелец (снимок): маркеры списков «•» и «1.» в «Осмотре» висят левее текста,
// за рамкой раздела; таблица должна сохраняться в шаблонах. Корень — две вещи:
// у вариантов бланка `*{padding:0}` снимает отступ списка, а оформление вообще
// не доживало до перерисовки: бланк переносил в форму innerText, buildBlankData
// пропускал поле через _blankStrip, варианты рисовали esc(текста).
//
// Здесь — путь целиком на DOM-стенде кабинета: ввод в бланке → форма →
// «Сохранить» (notes) → открытие → перерисовка → печать → архив → шаблоны;
// варианты бланка и общий рендерер печати — по их разметке. Без DOMParser:
// разметка раздела чистится общей rich-text.js (без DOM), а не им.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, answerConfirm } from './cabinet-harness.mjs';
import { notesWriteRefusal, NOTES_BASE_KEY } from '../../shared/cabinet-notes.js';

installFakeDom();
delete globalThis.DOMParser;

// ─── фальшивый сервер (как в cabinet-review-r4) ───────────────────────────────
const NOTES = new Map();
const LOG = [];
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('/visit_document_archive')) LOG.push({ kind: 'archive', body });
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            const values = { ...(body.values || {}) };
            const base = values[NOTES_BASE_KEY];
            delete values[NOTES_BASE_KEY];
            if (Object.prototype.hasOwnProperty.call(values, 'notes')) {
                const refusal = notesWriteRefusal(NOTES.has(id) ? NOTES.get(id) : null, values.notes, base);
                if (refusal) return resp(false, 409, { error: { code: 'notes_conflict', reason: refusal.reason, message: refusal.message } });
            }
            if (values.notes != null) NOTES.set(id, values.notes);
            return ok(null);
        }
        if (body.table === 'visits' && body.op === 'update') { LOG.push({ kind: 'visit', id, values: body.values }); return ok(null); }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = await import('../views/service-workspace.js');
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const { buildSheetHtml } = await import('../../shared/doc-render.js');
const { caseDocPrintBody } = await import('../views/case-doc-a4.js');
const DV_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'doc-variants.js'), 'utf8');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
const SIGNED = (fields, at = '2026-10-01T08:00:00.000Z') => ({ kind: 'signed', savedAt: at, by: null, byName: 'Каримов Алишер', fields });

function cabinet(id, notes = notesOf(null), { type = 'conclusion' } = {}) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' } } };
    if (notes != null) NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}
async function opened(id, notes, o) { const ctx = cabinet(id, notes, o); await WS.hydrateLine(ctx); await tick(5); return ctx; }
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const frameDoc = (ctx) => ctx.container.querySelector('iframe').contentDocument;
const frameField = (ctx, k) => frameDoc(ctx).body.querySelector('[data-field="' + k + '"]');
/** Врач пишет в бланке: разметка в поле iframe, событие input. */
function typeInBlank(ctx, k, html) {
    const el = frameField(ctx, k);
    assert.ok(el, 'в бланке нет поля ' + k);
    el.ownerDocument = frameDoc(ctx);
    el.innerHTML = html;
    el.dispatch('input');
    return el;
}

const LIST = '<ul><li>Живот мягкий</li><li>Печень у края рёберной дуги</li></ul>';
const OLIST = '<ol><li>Диета</li><li>Контроль через месяц</li></ol>';
const RESTBL = '<div><b>Общий анализ крови от 01.10.2026:</b></div>'
    + '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead>'
    + '<tbody><tr><td>HGB</td><td>140 г/л</td><td>120–160</td></tr></tbody></table>';
// Всё, что не должно дожить ни до одного листа.
const XSS = '<b>ok</b><img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">ссылка</a>'
    + '<span onclick="steal()" style="color: red; background: url(http://evil/x.png)">s</span><iframe src="//evil"></iframe>'
    + '<svg onload=alert(4)></svg> хвост <img src=y onerror=alert(5)//';
// strict — вся опасная разметка шла через очистку (раздел-разметка): и текст <script> вырезан.
// Без strict — путь простого текста («Заключение» исследования): экранированный текст безвреден.
function assertClean(html, where, { strict = true } = {}) {
    assert.ok(!/<[^>]*alert\(/i.test(html), where + ': тег с alert(: ' + (html.match(/<[^>]*alert\([^>]*>?/i) || [''])[0]);
    if (strict) assert.ok(!/alert\(2\)/.test(html), where + ': содержимое <script> осталось');
    assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(html), where + ': обработчик on* в теге');
    assert.ok(!/<[^>]*javascript:/i.test(html), where + ': javascript: в теге');
    if (strict) assert.ok(!/javascript:/i.test(html), where + ': javascript: ссылка');
    assert.ok(!/<iframe|<script|<img/i.test(html), where + ': опасный тег');
    assert.ok(!/<[^>]*url\(http:\/\/evil/i.test(html), where + ': url() в style');
}
const VARIANTS = [['conclusion', 'classic'], ['conclusion', 'compact'], ['diag', 'classic'], ['diag', 'compact']];
const styleOf = (html) => (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];

// ─── buildBlankData: что из формы — разметка, что — текст ────────────────────
test('F1: поле с оформлением идёт на лист очищенной разметкой; набранное без оформления — текстом, как раньше', () => {
    assert.equal(WS._blankRich(LIST), LIST);
    assert.equal(WS._blankRich('<b>Ж</b>ивот мягкий'), '<b>Ж</b>ивот мягкий');
    assert.equal(WS._blankRich('<div style="text-align: center">по центру</div>'), '<div style="text-align: center">по центру</div>');
    assert.equal(WS._blankRich('<span style="color: rgb(25, 113, 194)">синий</span>'), '<span style="color: rgb(25, 113, 194)">синий</span>');
    // только строки (br, div, p) — прежний текст: лист рисует его pre-wrap, текстовые места получают его же
    assert.equal(WS._blankRich('Кашель<br>три дня'), 'Кашель\nтри дня');
    assert.equal(WS._blankRich('а<div>б</div><div><br></div><div>в</div>'), 'а\nб\n\nв');
    assert.equal(WS._blankRich('SpO2 &lt;95%'), 'SpO2 <95%');
    assert.equal(WS._blankRich('Кашель'), 'Кашель');
    // буквально набранное «<b>» (в форме — «&lt;b&gt;») — текст, а не тег листа
    assert.equal(WS._blankRich('пишут &lt;b&gt; руками'), '<div>пишут &lt;b&gt; руками</div>');
    assert.ok(renderDesignedVariant('conclusion', 'classic', S, { rich: 1, exam: WS._blankRich('пишут &lt;b&gt; руками'), activeFields: ['physical_exam'] }).includes('<div>пишут &lt;b&gt; руками</div>'));
    // пустые теги — пусто (F8); опасное — вырезано
    assert.equal(WS._blankRich('<ul><li><br></li></ul>'), '');
    assert.equal(WS._blankRich('<div><br></div>'), '');
    assert.equal(WS._blankRich(XSS).indexOf('<b>ok</b>'), 0);
    assertClean(WS._blankRich(XSS), '_blankRich');
});

// ─── ввод в бланке → форма ────────────────────────────────────────────────────
test('F1/F2: список, набранный в бланке, ложится в форму очищенной разметкой, а не плоским текстом', async () => {
    const ctx = await opened(1, notesOf({ physical_exam: 'черновик' }));
    typeInBlank(ctx, 'physical_exam', LIST);
    assert.equal(field(ctx, 'physical_exam').innerHTML, LIST);
    // цвет и размер так, как их пишет Chrome со styleWithCSS; прежний <font> — span style
    typeInBlank(ctx, 'physical_exam', 'Тоны <span style="color: rgb(25, 113, 194);">ясные</span>, <span style="font-size: x-large;">ритм</span> <font color="#1971c2" size="2">правильный</font>');
    assert.equal(field(ctx, 'physical_exam').innerHTML,
        'Тоны <span style="color: rgb(25, 113, 194)">ясные</span>, <span style="font-size: x-large">ритм</span> <span style="color: #1971c2; font-size: small">правильный</span>');
    // вставленное в бланк опасное — не доходит даже до формы
    typeInBlank(ctx, 'physical_exam', XSS);
    assertClean(field(ctx, 'physical_exam').innerHTML, 'форма');
    // пустое поле (Chrome оставляет <br>) — пусто
    typeInBlank(ctx, 'physical_exam', '<br>');
    assert.equal(field(ctx, 'physical_exam').innerHTML, '');
});

test('F1: перевод строки в поле с pre-wrap — строка (<br>); поле .rich — как есть; без настоящего DOM продолжение дописывается блоком (запасной путь)', async () => {
    const ctx = await opened(2, notesOf({ physical_exam: 'черновик', hpi: 'черновик' }));
    // Shift+Enter в pre-wrap Chrome пишет «\n», и раньше innerText видел строку
    typeInBlank(ctx, 'physical_exam', 'строка1\nстрока2 <b>жирно</b>');
    assert.equal(field(ctx, 'physical_exam').innerHTML, 'строка1<br>строка2 <b>жирно</b>');
    const el = frameField(ctx, 'hpi');
    el.classList.add('rich');   // white-space:normal — «\n» там пробел
    typeInBlank(ctx, 'hpi', 'а\nб <b>в</b>');
    assert.equal(field(ctx, 'hpi').innerHTML, 'а\nб <b>в</b>');
    // A4_TEXT_SPLIT_V1 — части склеиваются по порядку. DOC_RICH_FORMAT_V1 (T2): в
    // браузере копии частей СЛИВАЮТСЯ (один список, одна таблица) — это проверяет
    // doc-rich-split.test.mjs на DOM с узлами. У El этого стенда нет cloneNode,
    // и здесь виден запасной путь T1: продолжение своим <div>, без потерь.
    const doc = frameDoc(ctx);
    const cont = new El('div');
    cont.setAttribute('data-cont-of', 'physical_exam');
    cont.ownerDocument = doc;
    cont.innerHTML = 'три<br>четыре';
    doc.body.appendChild(cont);
    typeInBlank(ctx, 'physical_exam', '<b>раз</b><br>два');
    assert.equal(field(ctx, 'physical_exam').innerHTML, '<b>раз</b><br>два<div>три<br>четыре</div>');
    cont.remove();
});

test('«Диагноз» остаётся строкой простого текста', async () => {
    const ctx = await opened(3, notesOf({ primary_diagnosis: 'Гастрит' }));
    typeInBlank(ctx, 'primary_diagnosis', '<b>Гастрит</b>, обострение');
    assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Гастрит, обострение');
});

test('F4: в бланке включается styleWithCSS — цвет и размер ложатся style, а не <font>', async () => {
    const ctx = await opened(4, notesOf({ physical_exam: 'черновик' }));
    const doc = frameDoc(ctx);
    const calls = [];
    doc.execCommand = (...a) => { calls.push(a); return true; };
    WS.applyFields(ctx, { hpi: 'анамнез' });   // перерисовка бланка
    await tick(5);
    assert.ok(calls.some((c) => c[0] === 'styleWithCSS' && c[2] === true), 'styleWithCSS не включён: ' + JSON.stringify(calls));
});

// ─── форма → «Сохранить» → открытие → перерисовка → печать → архив ───────────
test('F2: список проходит весь путь — форма, сохранение, открытие, бланк, печать, архив, лист из архива', async () => {
    const a = await opened(5, notesOf({ physical_exam: 'черновик', conclusion_text: 'черновик' }));
    typeInBlank(a, 'physical_exam', LIST);
    typeInBlank(a, 'conclusion_text', OLIST);
    assert.ok(await WS.saveDraft(a, { silent: true }), 'черновик не записан');
    const saved = JSON.parse(NOTES.get(5));
    assert.equal(saved.current.physical_exam, LIST, 'в notes ушёл не список');
    // открытие в новом экране
    const b = await opened(5, null);
    assert.equal(field(b, 'physical_exam').innerHTML, LIST, 'открытие потеряло список');
    // снимок (печать и архив — одно) и лист
    const snap = WS.docSnapshot(b, 'conclusion');
    assert.equal(snap.exam, LIST);
    assert.equal(snap.conclusionText, OLIST);
    for (const v of ['classic', 'compact']) {
        const html = renderDesignedVariant('conclusion', v, S, snap);
        assert.ok(html.includes('class="sec-b rich" data-field="physical_exam">' + LIST), v + ': список не на листе');
        assert.ok(html.includes(OLIST), v + ': заключение-список не на листе');
    }
    const printed = buildSheetHtml({ type: 'conclusion', s: S, data: snap });
    assert.ok(printed.includes(LIST), 'печать потеряла список');
    // подпись → архив
    LOG.length = 0;
    answerConfirm(true);
    await WS.signDocument(b);
    const arch = LOG.find((e) => e.kind === 'archive');
    assert.ok(arch, 'архив не записан');
    assert.equal(arch.body.body.exam, LIST, 'в архив ушёл не список');
    // лист из архива (карта пациента, «Документы», Telegram — buildSheetHtml по телу)
    assert.ok(buildSheetHtml({ type: 'conclusion', s: S, data: arch.body.body }).includes(LIST), 'лист из архива без списка');
    // текстовые места — текст без тегов
    const visit = LOG.find((e) => e.kind === 'visit');
    assert.equal(visit && visit.values.conclusion, 'Диета\nКонтроль через месяц', 'в visits.conclusion ушла разметка');
});

test('F2: открытие записи с опасной разметкой — в форму только очищенное', async () => {
    const ctx = await opened(6, notesOf({ physical_exam: XSS, hpi: 'SpO2 <95%' }));
    assertClean(field(ctx, 'physical_exam').innerHTML, 'открытие');
    assert.ok(field(ctx, 'physical_exam').innerHTML.startsWith('<b>ok</b>'));
    // прежний простой текст — разметкой с экранированным «<» (показ — «SpO2 <95%»: doc-rich-roundtrip)
    assert.equal(field(ctx, 'hpi')._html, 'SpO2 &lt;95%');
    assertClean(JSON.stringify(WS.docSnapshot(ctx, 'conclusion')), 'снимок');
});

// ─── F7: вставка результата ───────────────────────────────────────────────────
test('F7: таблица результата, вставленная «Вставить в документ», остаётся таблицей — в бланке, после правки, в печати и после сохранения', async () => {
    const ctx = await opened(7, notesOf({ physical_exam: 'Осмотр без особенностей' }));
    WS.a4InsertHtml(ctx, RESTBL, 'physical_exam');
    assert.ok(field(ctx, 'physical_exam').innerHTML.includes('<table class="a4-restbl">'), 'вставка не в поле');
    await tick(5);
    let snap = WS.docSnapshot(ctx, 'conclusion');
    assert.ok(snap.exam.includes('<table class="a4-restbl"><thead><tr><th>Показатель</th>'), 'снимок без таблицы: ' + snap.exam);
    assert.ok(snap.exam.includes('<td>HGB</td><td>140 г/л</td>'), 'ячейки слиплись');
    // врач дописывает под таблицей прямо в бланке — таблица жива
    typeInBlank(ctx, 'physical_exam', 'Осмотр без особенностей<br>' + RESTBL + '<div>Динамика положительная</div>');
    assert.ok(field(ctx, 'physical_exam').innerHTML.includes('<table class="a4-restbl">'), 'правка в бланке съела таблицу');
    snap = WS.docSnapshot(ctx, 'conclusion');
    for (const v of ['classic', 'compact']) assert.ok(renderDesignedVariant('conclusion', v, S, snap).includes('<td>HGB</td>'), v + ': таблицы нет на листе');
    assert.ok(await WS.saveDraft(ctx, { silent: true }));
    assert.ok(JSON.parse(NOTES.get(7)).current.physical_exam.includes('<table class="a4-restbl">'), 'таблица не сохранилась');
    // «Лабораторные» (раздел старых шаблонов и вставки анализа) — тоже
    WS.a4InsertHtml(ctx, RESTBL, 'labs_text');
    assert.ok(WS.docSnapshot(ctx, 'conclusion').labs.includes('<table class="a4-restbl">'));
});

// ─── шаблоны ──────────────────────────────────────────────────────────────────
test('F2: шаблон со списком и таблицей — «Из текущего документа» → сохранение → «Использовать» → бланк → печать', async () => {
    const src = await opened(8, notesOf({ physical_exam: 'черновик' }));
    typeInBlank(src, 'physical_exam', LIST + RESTBL);
    // «Из текущего документа» берёт поля формы (collectFields), «Сохранить» — tplSaveBody
    const collected = WS.collectFields(src, { always: ['physical_exam'] });
    const body = WS.tplSaveBody({ doc_type: '0', body: { physical_exam: collected.physical_exam } });
    assert.equal(body.physical_exam, LIST + RESTBL, 'шаблон сохранил не разметку');
    // «Использовать» в другом приёме
    const dst = await opened(9, notesOf({ chief_complaint: 'Кашель' }));
    assert.equal(WS.tplApply(dst, { doc_type: '0', body }), 'conclusion');
    assert.equal(field(dst, 'physical_exam').innerHTML, LIST + RESTBL, 'шаблон вставил не разметку');
    const snap = WS.docSnapshot(dst, 'conclusion');
    const printed = buildSheetHtml({ type: 'conclusion', s: S, data: snap });
    assert.ok(printed.includes(LIST) && printed.includes('<table class="a4-restbl">'), 'печать шаблона без списка или таблицы');
    // в поле с текстом шаблон дописывается — и тоже разметкой
    WS.tplApply(dst, { doc_type: '0', body: { physical_exam: OLIST } });
    assert.ok(field(dst, 'physical_exam').innerHTML.endsWith('<br><br>' + OLIST), field(dst, 'physical_exam').innerHTML);
    // шаблон без разметки, но с «<»: очищенное — это разметка, и в поле оно идёт
    // разметкой (innerHTML), а не текстом — иначе врач видел бы «&lt;»
    WS.tplApply(dst, { doc_type: '0', body: { hpi: 'SpO2 <95%' } });
    assert.equal(field(dst, 'hpi')._html, 'SpO2 &lt;95%');
    // чужой опасный шаблон вычищается
    WS.tplApply(dst, { doc_type: '0', body: { therapy_text: XSS } });
    assertClean(field(dst, 'therapy_text').innerHTML, 'шаблон');
});

// ─── F3: варианты бланка ──────────────────────────────────────────────────────
test('F3: у каждого варианта — отступ списка и рамки таблицы; правило перебивает *{padding:0}', () => {
    for (const [type, v] of VARIANTS) {
        const css = styleOf(renderDesignedVariant(type, v, S, { patientName: 'Азизов', service: 'УЗИ', __editor: false }));
        assert.match(css, /\*\{margin:0;padding:0;box-sizing:border-box;\}/, type + '/' + v + ': сброс на месте');
        // селектор с атрибутом [data-field] — специфичность выше нулевой у «*»
        assert.match(css, /\[data-field\] ul,\s*\[data-field\] ol[^{]*\{[^}]*padding-left:\s*2\dpx/, type + '/' + v + ': у списка нет отступа');
        assert.match(css, /\[data-field\] ul[^{]*\{[^}]*list-style:\s*disc/, type + '/' + v + ': маркер списка');
        assert.match(css, /\[data-field\] ol[^{]*\{[^}]*list-style:\s*decimal/, type + '/' + v + ': номер списка');
        assert.match(css, /\[data-field\] table\.a4-tbl,\s*\[data-field\] table\.a4-restbl[^{]*\{[^}]*border-collapse:\s*collapse/, type + '/' + v + ': таблица');
        assert.match(css, /\[data-field\] table\.a4-tbl th,[^{]*\{[^}]*border:\s*1px solid/, type + '/' + v + ': рамки ячеек');
        assert.match(css, /\.rich\{[^}]*white-space:\s*normal/, type + '/' + v + ': разметка рисуется не pre-wrap');
        // ul.recs (рекомендации печати) не задеты: их правило осталось без маркера
        if (type === 'conclusion') assert.match(css, /ul\.recs\{\s*list-style:none/, v + ': ul.recs изменён');
    }
});

test('F1/F3: разметка раздела — в .rich на каждом варианте и на экране, и в печати', () => {
    for (const editor of [true, false]) {
        for (const v of ['classic', 'compact']) {
            const c = renderDesignedVariant('conclusion', v, S, { rich: 1, __editor: editor, exam: LIST, complaint: '<b>Кашель</b>', activeFields: ['chief_complaint', 'physical_exam'] });
            assert.ok(c.includes('class="sec-b rich" data-field="physical_exam">' + LIST), v + (editor ? ' экран' : ' печать') + ': осмотр');
            assert.ok(c.includes('class="sec-b rich" data-field="chief_complaint"><b>Кашель</b>'), v + ': жалобы');
            const d = renderDesignedVariant('diag', v, S, { rich: 1, __editor: editor, patientName: 'Азизов', service: 'УЗИ', description: LIST + RESTBL, conclusion: 'Без патологии' });
            assert.ok(d.includes('data-field="instrumental_text">' + LIST + RESTBL), v + ': описание диагностики');
            assert.match(d, /class="sec-b rich" data-field="instrumental_text"/, v + ': описание диагностики не .rich');
        }
    }
});

test('F1: прежний простой текст — как раньше: pre-wrap, экранирован, без .rich', () => {
    const plain = 'Живот <мягкий>\nПечень у края';
    for (const v of ['classic', 'compact']) {
        const html = renderDesignedVariant('conclusion', v, S, { exam: plain, activeFields: ['physical_exam'] });
        assert.ok(html.includes('<div class="sec-b" data-field="physical_exam">Живот &lt;мягкий&gt;\nПечень у края</div>'), v + ': простой текст');
        assert.match(styleOf(html), /\.sec-b\{[^}]*white-space:pre-wrap/, v + ': pre-wrap пропал');
        const d = renderDesignedVariant('diag', v, S, { patientName: 'Азизов', service: 'УЗИ', description: 'Почки <в норме>\nКонтуры ровные', conclusion: 'Без патологии' });
        assert.ok(d.includes('<div class="sec-b" data-field="instrumental_text"><p>Почки &lt;в норме&gt;</p><p>Контуры ровные</p></div>'), v + ': описание абзацами, как было');
        // и в снимке T1 (rich: 1) раздел без разметки — тот же простой текст
        assert.ok(renderDesignedVariant('conclusion', v, S, { rich: 1, exam: plain, activeFields: ['physical_exam'] })
            .includes('<div class="sec-b" data-field="physical_exam">Живот &lt;мягкий&gt;\nПечень у края</div>'), v + ': простой текст снимка T1');
    }
});

test('ревью T1 (LOW 5): архив до T1 (без метки rich) — разделы текстом, набранное буквально «<b>» — не жирный', () => {
    const old = { patientName: 'Азизов', exam: 'Hb <b>ниже</b> нормы', recsText: '<i>Диета</i>', activeFields: ['physical_exam'] };
    for (const v of ['classic', 'compact']) {
        const html = renderDesignedVariant('conclusion', v, S, old);
        assert.ok(html.includes('<div class="sec-b" data-field="physical_exam">Hb &lt;b&gt;ниже&lt;/b&gt; нормы</div>'), v + ': старый текст стал разметкой');
        assert.ok(html.includes('<li>&lt;i&gt;Диета&lt;/i&gt;</li>'), v + ': старые рекомендации стали разметкой');
        const d = renderDesignedVariant('diag', v, S, { patientName: 'Азизов', service: 'УЗИ', description: 'Hb <b>ниже</b>', conclusion: 'Норма' });
        assert.ok(d.includes('<p>Hb &lt;b&gt;ниже&lt;/b&gt;</p>'), v + ': старое описание стало разметкой');
    }
    // тот же путь, что карта пациента, «Документы» и Telegram: тело архива → buildSheetHtml
    assert.ok(buildSheetHtml({ type: 'conclusion', s: S, data: old }).includes('Hb &lt;b&gt;ниже&lt;/b&gt; нормы'));
});

test('F1: рекомендации в печати — разметка как есть; простой текст — прежний список ul.recs', () => {
    for (const v of ['classic', 'compact']) {
        const rich = renderDesignedVariant('conclusion', v, S, { rich: 1, recsText: OLIST });
        assert.ok(rich.includes('data-field="recommendations_text">' + OLIST), v + ': рекомендации-разметка');
        assert.ok(!/<ul class="recs"><li>(<ol>|Диета)/.test(rich), v + ': разметка рекомендаций ушла в ul.recs');
        const plain = renderDesignedVariant('conclusion', v, S, { recsText: 'Диета\nКонтроль' });
        assert.ok(plain.includes('<ul class="recs"><li>Диета</li><li>Контроль</li></ul>'), v + ': простые рекомендации — не прежний список');
    }
});

test('«Диагноз» в бланке — простой текст: разметка в нём показывается текстом', () => {
    for (const v of ['classic', 'compact']) {
        const html = renderDesignedVariant('conclusion', v, S, { dx: '<b>Гастрит</b>', dxText: '<b>Гастрит</b>', dxAuto: '' });
        assert.ok(html.includes('&lt;b&gt;Гастрит&lt;/b&gt;'), v);
    }
});

test('XSS: опасная разметка вырезана на каждом пути показа — варианты (экран и печать), печать, архив, история болезни', () => {
    for (const editor of [true, false]) {
        for (const v of ['classic', 'compact']) {
            const c = renderDesignedVariant('conclusion', v, S, { rich: 1, __editor: editor, exam: XSS, complaint: XSS, recsText: XSS, conclusionText: XSS, labs: XSS, instrumental: XSS, therapy: XSS, hpi: XSS });
            assertClean(c, 'conclusion/' + v + (editor ? '/экран' : '/печать'));
            assert.ok(c.includes('<b>ok</b>'), 'оформление вырезано вместе с опасным');
            const d = renderDesignedVariant('diag', v, S, { rich: 1, __editor: editor, patientName: 'А', service: 'УЗИ', description: XSS, conclusion: 'Без патологии' });
            assertClean(d, 'diag/' + v + (editor ? '/экран' : '/печать'));
            // «Заключение» исследования — строка простого текста: опасное в нём — экранированный текст
            const dc = renderDesignedVariant('diag', v, S, { rich: 1, __editor: editor, patientName: 'А', service: 'УЗИ', description: 'Почки', conclusion: XSS, conclusionBody: XSS, conclusionAuto: '' });
            assertClean(dc, 'diag-заключение/' + v + (editor ? '/экран' : '/печать'), { strict: false });
        }
    }
    assertClean(buildSheetHtml({ type: 'conclusion', s: S, data: { rich: 1, exam: XSS, recsText: XSS } }), 'buildSheetHtml');
    assertClean(caseDocPrintBody([{ title: 'Осмотр', html: XSS }]), 'история болезни');
});

test('F3: печать истории болезни (case_doc) — у списков и таблиц есть свои правила', () => {
    const body = caseDocPrintBody([{ title: 'Осмотр', html: LIST + '<table class="a4-tbl"><tbody><tr><th>A</th></tr><tr><td>1</td></tr></tbody></table>' }]);
    const html = buildSheetHtml({ type: 'case_doc', s: { ...S, paperBg: '#fff', accentSoft: '#eef6f5' }, bodyHtml: body, title: 'История болезни' });
    assert.ok(html.includes(LIST) && html.includes('<table class="a4-tbl">'));
    const css = styleOf(html);
    assert.match(css, /\.body ul,\s*\.body ol\s*\{[^}]*padding-left:\s*2\dpx/, 'у списка истории болезни нет отступа');
    assert.match(css, /\.body table\.a4-tbl,\s*\.body table\.a4-restbl\s*\{[^}]*border-collapse:\s*collapse/, 'у таблицы нет правил');
    assert.match(css, /\.body table\.a4-tbl th,[^{]*\{[^}]*border:\s*1px solid/, 'у ячеек нет рамок');
    // собранная история болезни (case-docs.js) печатает те же разделы своим листом
    const CD_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'case-docs.js'), 'utf8');
    assert.match(CD_SRC, /\.part \.pv ul, \.part \.pv ol \{[^}]*padding-left: 2\dpx/, 'собранная история: у списка нет отступа');
    assert.match(CD_SRC, /\.part \.pv table\.a4-tbl th,[^{]*\{[^}]*border: 1px solid/, 'собранная история: у ячеек нет рамок');
});

test('варианты бланка остаются без DOM: Telegram рисует их на сервере', () => {
    for (const w of ['document.', 'window.', 'DOMParser', 'localStorage']) assert.ok(!DV_SRC.includes(w), 'doc-variants.js тянет ' + w);
});

// ─── текстовые места ──────────────────────────────────────────────────────────
test('F2: «Вставить результаты» и снимок истории — текст без тегов, без двойного экранирования', async () => {
    const f = { chief_complaint: '<i>Кашель</i> 3 дня', physical_exam: '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>', recommendations_text: '<b>Диета</b>', primary_diagnosis: 'Бронхит' };
    NOTES.set(10, notesOf(null, { history: [SIGNED(f)] }));
    const body = new El('div');
    const out = await WS.fillServiceConclusion(body, { id: 10 });
    assert.equal(out.html, '<div>Осмотр: Живот мягкий; SpO2 &lt;95%. Диагноз: Бронхит. Рекомендации: Диета</div>');
    const t = body.textContent;
    assert.ok(t.includes('Кашель 3 дня') && t.includes('Живот мягкий'), t);
    assert.ok(!/<\/?(i|b|ul|li)>|&lt;|&amp;/.test(t), 'сводка показывает разметку: ' + t);
    // окно записи истории («Снимок»)
    const ctx = await opened(11, notesOf({ chief_complaint: 'x' }));
    const before = document.body.children.length;
    WS.openSnapshot(ctx, { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', fields: f });
    const modal = document.body.children[before];
    assert.ok(modal, 'окно снимка не открылось');
    const mt = modal.textContent;
    assert.ok(mt.includes('Кашель 3 дня') && mt.includes('SpO2 <95%'), mt);
    assert.ok(!/<\/?(i|b|ul|li)>|&lt;/.test(mt), 'снимок показывает разметку: ' + mt);
    modal.remove();
    // ревью T1 (LOW 4) — подпись черновика в истории — текст, а не разметка
    assert.equal(WS.historyRowMeta({ kind: 'draft', fields: { chief_complaint: '<b>Кашель</b><div>3 дня</div>' } }).subtitle, 'Кашель 3 дня');
    assert.equal(WS.historyRowMeta({ kind: 'draft', fields: { chief_complaint: '<br>' } }).subtitle, null);
});

// ─── ревью T1 ──────────────────────────────────────────────────────────────────
test('ревью T1 (MEDIUM 3): перевод строки шаблона с оформлением (редактор шаблона — pre-wrap) — строка на листе', async () => {
    const TPL = '<b>Почки</b>: норма\nПечень: норма';
    assert.equal(WS._blankRich(TPL), '<b>Почки</b>: норма<br>Печень: норма');
    // структура списка не получает <br> между пунктами
    assert.equal(WS._blankRich('<ul>\n<li>a</li>\n<li>b</li>\n</ul>'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    const ctx = await opened(40, notesOf({ chief_complaint: 'Кашель' }));
    WS.tplApply(ctx, { doc_type: '0', body: { physical_exam: TPL, hpi: 'Строка 1\nСтрока 2' } });
    assert.equal(field(ctx, 'physical_exam').innerHTML, '<b>Почки</b>: норма<br>Печень: норма', 'в форме — одной строкой');
    const snap = WS.docSnapshot(ctx, 'conclusion');
    assert.equal(snap.exam, '<b>Почки</b>: норма<br>Печень: норма');
    assert.equal(snap.hpi, 'Строка 1\nСтрока 2', 'шаблон без оформления — прежний текст');
    assert.ok(renderDesignedVariant('conclusion', 'classic', S, snap).includes('data-field="physical_exam"><b>Почки</b>: норма<br>Печень: норма</div>'));
});

test('ревью T1 (T3): пустая таблица — содержание раздела: бланк, форма и шаблон её не стирают; «текст» раздела — по тексту', async () => {
    const EMPTY = '<table class="a4-tbl"><tbody><tr><th></th><th></th></tr><tr><td></td><td></td></tr></tbody></table>';
    assert.equal(WS._blankRich(EMPTY), EMPTY, 'лист стёр пустую таблицу');
    assert.equal(WS._blankRich('<ul><li><br></li></ul>'), '', 'пустой список — пусто, как прежде');
    // бланк → форма (одна часть поля)
    const ctx = await opened(41, notesOf({ physical_exam: 'черновик' }));
    typeInBlank(ctx, 'physical_exam', EMPTY);
    assert.equal(field(ctx, 'physical_exam').innerHTML, EMPTY, 'форма стёрла пустую таблицу');
    assert.ok(await WS.saveDraft(ctx, { silent: true }));
    assert.equal(JSON.parse(NOTES.get(41)).current.physical_exam, EMPTY);
    // шаблон «бланк для заполнения» сохраняется и вставляется
    assert.equal(WS.tplSaveBody({ doc_type: '0', body: { physical_exam: EMPTY } }).physical_exam, EMPTY, 'шаблон с пустой таблицей не сохранился');
    // «есть ли текст»: пустая таблица — не текст — переподпись называет раздел пропавшим
    assert.deepEqual(WS.lostOnResign({ physical_exam: 'Живот мягкий' }, { physical_exam: EMPTY }), ['Осмотр']);
});

test('ревью T1: образец — только предпросмотру; документ с данными (и пустой) — всегда свой', () => {
    const SAMPLE = /Рахимов|Алиев Бобур|Юлдашева|Юсупова Н|О\. Юсупов/;
    for (const v of ['classic', 'compact']) {
        assert.ok(!SAMPLE.test(renderDesignedVariant('lab', v, S, { patientName: 'Эргашев Жахонгир', groups: [] })), v + ': анализ без групп напечатан образцом');
        assert.ok(!SAMPLE.test(renderDesignedVariant('invoice', v, S, { patientName: 'Эргашев Жахонгир', items: [] })), v + ': счёт без позиций напечатан образцом');
        assert.match(renderDesignedVariant('lab', v, S, null), /Рахимов/, v + ': предпросмотр анализа без образца');
        assert.match(renderDesignedVariant('invoice', v, S, null), /Рахимов/, v + ': предпросмотр счёта без образца');
    }
    assert.ok(!SAMPLE.test(renderDesignedVariant('fiscal', 'classic', S, { patientName: 'Эргашев Жахонгир', items: [] })), 'фискальный чек образцом');
    assert.ok(!SAMPLE.test(renderDesignedVariant('check', 'classic', S, { patientName: 'Эргашев Жахонгир', items: [] })), 'квитанция образцом');
    // тело без данных — документ вызывающего, а не образец заключения
    const body = buildSheetHtml({ type: 'conclusion', s: S, bodyHtml: '<p>Эргашев Жахонгир — тело</p>' });
    assert.ok(body.includes('Эргашев Жахонгир — тело') && !SAMPLE.test(body), 'bodyHtml заменён образцом');
    assert.match(buildSheetHtml({ type: 'conclusion', s: S }), /Алиев Бобур/, 'предпросмотр «Документов» потерял образец');
});

test('ревью T1: лист приёма из подписанной записи (карта пациента) — этот пациент, разделы записи, без образца', async () => {
    const { notesDocData } = await import('../../shared/cabinet-doc.js');
    const fields = { chief_complaint: '<b>Кашель</b>', physical_exam: LIST, primary_diagnosis: 'Средней тяжести', icd10: 'J20.9', conclusion_text: 'SpO2 &lt;95%' };
    const data = notesDocData(fields, {
        head: { patientName: 'Эргашев Жахонгир', mrn: 'MRN-1', doctorName: 'Каримов Алишер', service: 'Приём терапевта', issueDate: '01.10.2026' },
        diagnoses: [{ code: 'J20.9', name: 'Острый бронхит', type: 'main' }],
        prescriptions: [{ name: 'Амброксол', dose: '30 мг' }],
    });
    for (const v of ['classic', 'compact']) {
        const html = buildSheetHtml({ type: 'conclusion', s: { ...S, variant: { conclusion: v } }, data });
        const t = html.replace(/<style[\s\S]*?<\/style>/g, '');
        assert.ok(t.includes('Эргашев'), v + ': на листе не этот пациент');
        assert.ok(!/Алиев Бобур|О\. Юсупов|Периодические головные боли/.test(t), v + ': на листе образец');
        assert.ok(t.includes(LIST) && t.includes('<b>Кашель</b>'), v + ': разделы записи потеряли оформление');
        assert.ok(t.includes('J20.9 — Острый бронхит') && t.includes('Средней тяжести'), v + ': диагноз записи');
        assert.ok(t.includes('SpO2 &lt;95%') && t.includes('Амброксол'), v + ': заключение и рецепт записи');
    }
});
