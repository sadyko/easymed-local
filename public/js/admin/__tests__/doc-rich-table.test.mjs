// DOC_RICH_FORMAT_V1 (T3, правило F6) — ТАБЛИЦА В ДОКУМЕНТЕ КАБИНЕТА ВРАЧА.
//
// Владелец: «простая таблица» — без объединения ячеек. Кнопка «Таблица» в
// панели оформления вставляет table.a4-tbl (первая строка — заголовок th), под
// курсором в ячейке — панель «+ строка», «+ столбец», «− строка», «− столбец»,
// «Удалить таблицу»; Tab / Shift+Tab — по ячейкам, Tab в последней — новая
// строка; Enter в ячейке — перенос строки в ней.
//
// Таблица может быть разрезана по страницам бланка (T2): строки на странице 2
// лежат в копии table[data-cont-split], заголовок там — повтор [data-cont-head].
// Операции работают с таблицей ЦЕЛИКОМ — по всем её половинам. Здесь — логика
// (views/blank-table.js) на маленьком DOM с разбором разметки (mini-dom.mjs);
// кнопки, панель и клавиши в настоящем бланке — headless Chrome (отчёт T3).
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom, El } from './cabinet-harness.mjs';
import { miniDocument, el } from './mini-dom.mjs';
import { htmlToText, sanitizeStoredHtml } from '../../shared/rich-text.js';

installFakeDom();
const TB = await import('../views/blank-table.js');
const SPLIT = await import('../views/blank-split.js');
const WS = await import('../views/service-workspace.js');

const linesOf = (e) => { const t = htmlToText(e.innerHTML); return t ? t.split('\n').length : 0; };
const capFits = (f, cap) => () => linesOf(f) <= cap;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const count = (html, re) => (html.match(re) || []).length;
const BR3 = '<th><br></th><th><br></th><th><br></th>';

function setup(html, key = 'physical_exam') {
    const doc = miniDocument();
    const f = el(doc, '<div class="sec-b rich" data-field="' + key + '" contenteditable="true">' + html + '</div>');
    doc.body.appendChild(f);
    return { doc, f };
}
function placeCont(doc, cont, key = 'physical_exam') {
    const wrap = doc.createElement('div');
    wrap.setAttribute('data-cont-wrap', key);
    wrap.setAttribute('data-cont-mode', 'rich');
    cont.className = 'sec-b rich';
    cont.setAttribute('data-cont-of', key);
    cont.setAttribute('contenteditable', 'true');
    wrap.appendChild(cont);
    doc.body.appendChild(wrap);
    return cont;
}
/** Таблица 1 заголовок + n строк данных, 3 столбца, текст «r.c». */
const TBL = (n) => '<table class="a4-tbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>'
    + range(1, n).map((r) => '<tr>' + range(1, 3).map((c) => '<td>' + r + '.' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
/** Разрезанная по страницам таблица: поле + продолжение, как их оставляет разбивка. */
function splitTable(n = 8, cap = 5, before = '<div>Анализы:</div>') {
    const { doc, f } = setup(before + TBL(n));
    const cont = doc.createElement('div');
    assert.ok(SPLIT.splitRichField(f, cont, { fits: capFits(f, cap) }), 'таблица не разрезалась');
    placeCont(doc, cont);
    return { doc, f, cont, parts: [f, cont] };
}
const td = (root, r, c) => [...root.querySelectorAll('tr')].find((tr) => tr.textContent.startsWith(r + '.')).children[c];
const mergedHtml = (parts) => SPLIT.mergedFieldClone(parts).innerHTML;

// ─── вставка ──────────────────────────────────────────────────────────────────
test('F6: «Таблица» строки × столбцы — table.a4-tbl, первая строка — заголовок th, в пустых ячейках <br>, предел 15 × 8', () => {
    const doc = miniDocument();
    const t = TB.buildTable(doc, 3, 4);
    assert.equal(t.outerHTML, '<table class="a4-tbl"><thead><tr>' + '<th><br></th>'.repeat(4) + '</tr></thead><tbody>'
        + ('<tr>' + '<td><br></td>'.repeat(4) + '</tr>').repeat(2) + '</tbody></table>');
    assert.equal(TB.buildTable(doc, 99, 99).querySelectorAll('tr').length, TB.TBL_MAX_ROWS);
    assert.equal(TB.buildTable(doc, 99, 99).querySelector('tr').children.length, TB.TBL_MAX_COLS);
    assert.equal(TB.buildTable(doc, 0, 0).outerHTML, '<table class="a4-tbl"><thead><tr><th><br></th></tr></thead><tbody></tbody></table>');
    assert.deepEqual([TB.TBL_MAX_ROWS, TB.TBL_MAX_COLS], [15, 8]);
});

test('F6: вставка в курсор — строка делится, таблица между частями, после неё абзац, курсор — в первой ячейке заголовка', () => {
    let { f } = setup('Живот <b>мяг|кий</b>, печень у края'.replace('|', ''));
    const text = f.querySelector('b').firstChild;   // «мягкий» — курсор после «мяг»
    let r = TB.insertTable(f, text, 3, 2, 2);
    assert.equal(f.innerHTML, 'Живот <b>мяг</b><table class="a4-tbl"><thead><tr><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody></table><b>кий</b>, печень у края');
    assert.equal(r.caret.node.tagName, 'TH');
    assert.equal(r.caret.offset, 0);
    assert.equal(r.caret.node, f.querySelector('th'));
    // в конце поля — абзац после таблицы
    ({ f } = setup('Осмотр'));
    r = TB.insertTable(f, f.firstChild, 6, 2, 1);
    assert.ok(f.innerHTML.endsWith('</table><div><br></div>'), f.innerHTML);
    assert.ok(f.innerHTML.startsWith('Осмотр<table'), f.innerHTML);
    // пустое поле
    ({ f } = setup('<br>'));
    TB.insertTable(f, f, 0, 2, 2);
    assert.ok(/^<table class="a4-tbl">/.test(f.innerHTML) && /<\/table><br>$/.test(f.innerHTML), f.innerHTML);
    // абзац — делится, вторая половина — своим абзацем (тот же стиль)
    ({ f } = setup('<div style="text-align: center">раз два</div>'));
    TB.insertTable(f, f.firstChild.firstChild, 3, 2, 2);
    assert.ok(/^<div style="text-align: center">раз<\/div><table[\s\S]*<\/table><div style="text-align: center"> два<\/div>$/.test(f.innerHTML), f.innerHTML);
    // курсор в ячейке другой таблицы или в списке — новая таблица после неё, не внутрь
    ({ f } = setup(TBL(1) + '<ul><li>пункт</li></ul>'));
    TB.insertTable(f, f.querySelector('td').firstChild, 1, 2, 2);
    assert.equal(f.querySelectorAll('table').length, 2);
    assert.equal(f.children[1].tagName, 'TABLE', 'вторая таблица — сразу после первой');
    assert.ok(!f.querySelectorAll('td').some((c) => c.querySelector('table')), 'таблица внутри ячейки');
    TB.insertTable(f, f.querySelector('li').firstChild, 2, 2, 2);
    assert.equal(f.querySelector('ul').nextSibling.tagName, 'TABLE');
    assert.ok(!f.querySelectorAll('li').some((c) => c.querySelector('table')));
});

test('F6: пустая только что вставленная таблица доживает до формы (sync) и проходит очистку как есть', () => {
    const { f } = setup('Анализы:');
    TB.insertTable(f, f.firstChild, 8, 3, 3);
    const html = WS._blankFieldHtml([f]);
    assert.ok(html.includes('<table class="a4-tbl"><thead><tr>' + BR3 + '</tr></thead>'), html);
    assert.equal(sanitizeStoredHtml(html), html, 'очистка что-то выбросила');
    // очистка: класс a4-tbl и разметка таблицы — да, прочее — нет
    assert.equal(sanitizeStoredHtml('<table class="a4-tbl x" border="1" onclick="a()"><thead><tr><th colspan="2" style="color: red">A</th></tr></thead><tbody><tr><td rowspan="3">1</td></tr></tbody></table>'),
        '<table class="a4-tbl"><thead><tr><th style="color: red">A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
});

// ─── строки ───────────────────────────────────────────────────────────────────
test('F6: «+ строка» — под текущей; из заголовка — первой строкой данных; курсор — в ту же колонку новой строки', () => {
    const { f } = setup(TBL(2));
    const parts = [f];
    let at = TB.addRow(td(f, 1, 1), parts);
    assert.deepEqual(f.querySelector('tbody').children.map((r) => r.textContent), ['1.11.21.3', '', '2.12.22.3']);
    assert.equal(at.node.tagName, 'TD');
    assert.equal(at.node, f.querySelectorAll('tr')[2].children[1]);
    at = TB.addRow(f.querySelector('th'), parts);
    assert.equal(f.querySelector('tbody').firstChild.textContent, '', 'из заголовка — первой строкой данных');
    assert.equal(f.querySelector('thead').children.length, 1, 'заголовок остался один');
    assert.equal(at.node, f.querySelector('tbody').firstChild.children[0]);
});

test('F6: «− строка» — текущая строка данных; заголовок не удаляется, пока есть строки; последняя строка данных — можно; пустая таблица — удаляется', () => {
    const { f } = setup('<div>до</div>' + TBL(2));
    const parts = [f];
    assert.equal(TB.canRemoveRow(f.querySelector('th'), parts), false);
    assert.equal(TB.removeRow(f.querySelector('th'), parts), null, 'заголовок удалился при строках');
    let at = TB.removeRow(td(f, 1, 2), parts);
    assert.deepEqual(f.querySelector('tbody').children.map((r) => r.textContent), ['2.12.22.3']);
    assert.equal(at.node, td(f, 2, 2), 'курсор — в ту же колонку следующей строки');
    at = TB.removeRow(td(f, 2, 0), parts);
    assert.equal(f.querySelector('tbody').children.length, 0, 'последняя строка данных удалена');
    assert.equal(at.node.tagName, 'TH');
    assert.equal(TB.canRemoveRow(f.querySelector('th'), parts), true);
    at = TB.removeRow(f.querySelector('th'), parts);
    assert.equal(f.querySelector('table'), null, 'таблица без строк осталась');
    assert.equal(at.node, f);
});

// ─── столбцы ──────────────────────────────────────────────────────────────────
test('F6: «+ столбец» справа от текущего и «− столбец» — во всех строках, заголовок th, данные td; последний столбец — таблица удаляется', () => {
    const { f } = setup(TBL(2) + '<div>после</div>');
    const parts = [f];
    let at = TB.addColumn(td(f, 1, 0), parts);
    for (const tr of f.querySelectorAll('tr')) assert.equal(tr.children.length, 4);
    assert.equal(f.querySelector('thead').firstChild.children[1].tagName, 'TH');
    assert.equal(at.node, td(f, 1, 1));
    assert.equal(td(f, 2, 1).innerHTML, '<br>');
    at = TB.removeColumn(td(f, 2, 3), parts);   // «Норма»
    for (const tr of f.querySelectorAll('tr')) assert.equal(tr.children.length, 3);
    assert.equal(f.querySelector('th').parentNode.textContent, 'ПоказательРезультат');
    assert.equal(at.node, td(f, 2, 2));
    TB.removeColumn(td(f, 1, 0), parts);
    TB.removeColumn(td(f, 1, 0), parts);
    at = TB.removeColumn(f.querySelector('td'), parts);
    assert.equal(f.querySelector('table'), null, 'последний столбец — таблица удалена');
    assert.equal(f.innerHTML, '<div>после</div>');
    assert.equal(at.node, f);
});

// ─── разрезанная таблица ─────────────────────────────────────────────────────
test('F6 + F5: на разрезанной таблице строки — в своей половине, столбцы — во всех строках всех половин и в повторе заголовка; форма — одна таблица', () => {
    const { f, cont, parts } = splitTable(8, 5);
    assert.ok(cont.querySelector('[data-cont-head]') && cont.querySelector('tbody[data-cont-split]'));
    assert.deepEqual(TB.tableChain(cont.querySelector('td'), parts).length, 2);
    // строка на странице 2 — в копию tbody
    let at = TB.addRow(td(cont, 5, 0), parts);
    assert.equal(at.node.parentNode.parentNode.getAttribute('data-cont-split'), '1');
    // столбец из страницы 2 — и на странице 1, и в заголовке, и в его повторе
    at = TB.addColumn(td(cont, 6, 1), parts);
    for (const tr of [...f.querySelectorAll('tr'), ...cont.querySelectorAll('tr')]) assert.equal(tr.children.length, 4, tr.outerHTML);
    assert.equal(cont.querySelector('[data-cont-head]').querySelectorAll('th').length, 4);
    let html = mergedHtml(parts);
    assert.equal(count(html, /<table/g), 1);
    assert.equal(count(html, /<th>/g) + count(html, /<th /g), 4, 'заголовок один, 4 столбца');
    assert.equal(count(html, /<tr>/g), 10, 'заголовок + 8 + новая');
    // столбец со страницы 1 убирается и на странице 2
    TB.removeColumn(td(f, 1, 3), parts);
    for (const tr of [...f.querySelectorAll('tr'), ...cont.querySelectorAll('tr')]) assert.equal(tr.children.length, 3);
    // строку на странице 2 можно удалить; повтор заголовка — не строка
    TB.removeRow(td(cont, 8, 0), parts);
    html = mergedHtml(parts);
    assert.ok(!/>8\.1</.test(html));
    assert.equal(TB.canRemoveRow(cont.querySelector('[data-cont-head]').querySelector('th'), parts), false, 'повтор заголовка не удаляется');
});

test('F6 + F5: «Удалить таблицу» — все её половины, и копии на следующих страницах; есть ли в ней текст — по всем половинам', () => {
    const { f, cont, parts } = splitTable(8, 5);
    const chain = TB.tableChain(td(f, 1, 0), parts);
    assert.equal(TB.tableHasText(chain), true);
    const at = TB.deleteTable(td(cont, 7, 1), parts);
    assert.equal(f.querySelector('table'), null);
    assert.equal(cont.querySelector('table'), null, 'копия на странице 2 осталась');
    assert.equal(f.innerHTML, '<div>Анализы:</div>');
    assert.equal(at.node, f);
    assert.equal(at.offset, 1);
    const { f: g } = setup(TB.buildTable(miniDocument(), 2, 2).outerHTML);
    assert.equal(TB.tableHasText(TB.tableChain(g.querySelector('td'), [g])), false, 'пустая таблица — без вопроса');
});

// ─── клавиши ──────────────────────────────────────────────────────────────────
test('F6: Tab / Shift+Tab — следующая/предыдущая ячейка через половины таблицы, повтор заголовка пропускается; на краях — null', () => {
    const { f, cont, parts } = splitTable(8, 5);
    const lastP1 = [...f.querySelectorAll('td')].pop();
    const firstP2 = td(cont, 4, 0);
    assert.equal(lastP1.textContent, '3.3');
    assert.equal(TB.cellStep(lastP1, parts, false), firstP2, 'Tab из последней ячейки страницы 1 — в первую строку данных страницы 2');
    assert.equal(TB.cellStep(firstP2, parts, true), lastP1, 'Shift+Tab — обратно');
    assert.equal(TB.cellStep(f.querySelectorAll('th')[2], parts, false), td(f, 1, 0), 'из заголовка — в первую строку');
    assert.equal(TB.cellStep(f.querySelector('th'), parts, true), null, 'Shift+Tab в первой ячейке');
    const last = [...cont.querySelectorAll('td')].pop();
    assert.equal(TB.cellStep(last, parts, false), null, 'Tab в последней ячейке — новая строка (вызывающий)');
    const at = TB.addRow(last, parts);
    assert.equal(at.node, [...cont.querySelectorAll('tr')].pop().children[2]);
    assert.equal(TB.cellStep(last, parts, false), [...cont.querySelectorAll('tr')].pop().children[0], 'после новой строки Tab идёт в её первую ячейку');
});

test('F6: Enter в ячейке — перенос строки в ней (<br>), а не абзац снаружи; в конце ячейки — видимая пустая строка', () => {
    const { f } = setup(TBL(1));
    const cell = td(f, 1, 1);
    let at = TB.insertCellBreak(cell.firstChild, 1);
    assert.equal(cell.innerHTML, '1<br>.2');
    assert.deepEqual([at.node, at.offset], [cell, 2]);
    const c2 = td(f, 1, 2);
    at = TB.insertCellBreak(c2.firstChild, 3);
    assert.equal(c2.innerHTML, '1.3<br><br>');
    assert.deepEqual([at.node, at.offset], [c2, 2]);
    assert.equal(f.querySelectorAll('table').length, 1);
});

// ─── шаблоны ──────────────────────────────────────────────────────────────────
// «Из текущего документа» берёт поля формы (collectFields), «Сохранить» —
// tplSaveBody, «Использовать» — tplApply: таблица — та же, и пустая тоже.
test('F6: шаблон «Из текущего документа» → «Использовать» — таблица (и пустая) в шаблоне и в новом документе', async () => {
    const NOTES = new Map();
    globalThis.fetch = async (url, opts) => {
        const body = JSON.parse((opts && opts.body) || '{}');
        const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
        if (String(url) === '/api/db' && body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            const idF = (body.filters || []).find((x) => x.col === 'id');
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(Number(idF && idF.val)) ? { notes: NOTES.get(Number(idF.val)) } : null);
            return ok([]);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    };
    const open = async (id, cur) => {
        NOTES.set(id, JSON.stringify({ __service_workspace_v1: 1, current: cur, history: [] }));
        const container = new El('div');
        const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'П' + id, firstName: 'Т', mrn: 'P-' + id, __service: { id, name: 'Услуга', doctorName: 'Врач', doctorSpec: 'Терапевт' } } };
        WS.activateWorkspace(ctx);
        container.appendChild(WS.soapForm(ctx));
        const wrap = container.querySelector('[data-blank-wrap]'); if (wrap) wrap.style.display = '';
        WS.setDocType(ctx, 'conclusion');
        await WS.hydrateLine(ctx);
        await new Promise((r) => setTimeout(r, 5));
        return ctx;
    };
    const form = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
    const FILLED = '<div>ОАК:</div><table class="a4-tbl"><thead><tr><th>Показатель</th><th>Результат</th></tr></thead><tbody><tr><td>HGB</td><td>140</td></tr></tbody></table><div><br></div>';
    const EMPTY = '<table class="a4-tbl"><thead><tr><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody></table>';
    const src = await open(301, { physical_exam: 'черновик', hpi: 'черновик' });
    form(src, 'physical_exam').innerHTML = FILLED;
    form(src, 'hpi').innerHTML = EMPTY;
    const collected = WS.collectFields(src, { always: ['physical_exam', 'hpi'] });
    const body = WS.tplSaveBody({ doc_type: '0', body: { physical_exam: collected.physical_exam, hpi: collected.hpi } });
    assert.ok(body.physical_exam.includes('<table class="a4-tbl"><thead><tr><th>Показатель</th>'), 'шаблон сохранил не таблицу: ' + body.physical_exam);
    assert.ok(body.hpi && body.hpi.includes('<table class="a4-tbl">'), 'пустая таблица не сохранилась в шаблон: ' + body.hpi);
    const dst = await open(302, { chief_complaint: 'Кашель' });
    WS.tplApply(dst, { doc_type: '0', body });
    assert.ok(form(dst, 'physical_exam').innerHTML.includes('<td>HGB</td><td>140</td>'), form(dst, 'physical_exam').innerHTML);
    assert.ok(form(dst, 'hpi').innerHTML.includes('<table class="a4-tbl">'), 'пустая таблица шаблона не вставилась');
    const snap = WS.docSnapshot(dst, 'conclusion');
    assert.ok(snap.exam.includes('<table class="a4-tbl">') && snap.hpi.includes('<table class="a4-tbl">'));
    // бланк кабинета: в панели оформления — «Таблица»; окно размера и панель таблицы — в документе; на бумагу не идут
    const fdoc = dst.container.querySelector('iframe').contentDocument;
    const fbar = fdoc.body.querySelector('[data-bk-fmt]');
    assert.ok(fbar, 'панели оформления нет');
    assert.match(fbar.innerHTML, /<button type="button" data-cmd="table" title="Таблица" aria-label="Таблица"[^>]*><svg /, 'кнопки «Таблица» нет');
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(fbar.innerHTML), 'эмодзи в панели');
    assert.ok(fdoc.body.querySelector('[data-bk-tblpick]') && fdoc.body.querySelector('[data-bk-tbl]'), 'окна размера или панели таблицы нет');
    const css = fdoc.head.children.map((s) => s.textContent || '').join('');
    assert.ok(css.includes('@media print{[data-bk-fmt],[data-bk-tbl],[data-bk-tblpick]{display:none !important;}}'), 'панели печатаются');
});

test('F6: панель оформления и таблицы — и на продолжении раздела ([data-cont-of]); в строке «Диагноз» таблицы нет', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'service-workspace.js'), 'utf8');
    const block = src.slice(src.indexOf('// WS_BLOCK_FMT_V1 — floating formatting bar'), src.indexOf('// PAPER_ACTIONS_BLANK_V1'));
    assert.ok(block.length > 500, 'блок панели оформления не найден');
    assert.ok(!/closest\('\[data-field\]'\)/.test(block), 'панель оформления по-прежнему только для [data-field]');
    assert.equal((block.match(/closest\('\[data-field\],\[data-cont-of\]'\)/g) || []).length, 3, 'фокус, прокрутка и сохранение — и для продолжения');
    assert.match(src, /const _TBL_OFF = new Set\(\['primary_diagnosis', 'doctor_phone', 'icd10'\]\)/);
});

// ─── печать ───────────────────────────────────────────────────────────────────
test('F6: печать — тонкие рамки ячеек и фон заголовка у a4-tbl во всех вариантах бланка; цвета печатаются (print-color-adjust)', async () => {
    const { renderDesignedVariant } = await import('../views/doc-variants.js');
    const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
    for (const [type, v] of [['conclusion', 'classic'], ['conclusion', 'compact'], ['diag', 'classic'], ['diag', 'compact']]) {
        const html = renderDesignedVariant(type, v, S, { rich: 1, exam: TBL(1), description: TBL(1), patientName: 'А', service: 'УЗИ', conclusion: 'Норма', activeFields: ['physical_exam'] });
        const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
        assert.ok(html.includes('<table class="a4-tbl"><thead>'), type + '/' + v + ': таблицы нет на листе');
        assert.match(css, /table\.a4-tbl th,[^{]*\{[^}]*border:\s*1px solid/, type + '/' + v + ': рамки');
        assert.match(css, /table\.a4-tbl th,[^{]*table\.a4-restbl th[^{]*\{[^}]*background:\s*#[0-9a-f]{6}/i, type + '/' + v + ': фон заголовка');
        assert.match(css, /@media print\{[^]*print-color-adjust:\s*exact/, type + '/' + v + ': фон заголовка не печатается');
    }
});
