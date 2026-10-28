// DOC_RICH_FORMAT_V1 (T4) — ШАБЛОНЫ ЗАКЛЮЧЕНИЙ: ПАНЕЛЬ ОФОРМЛЕНИЯ И ТАБЛИЦА В
// РАЗДЕЛАХ ШАБЛОНА.
//
// Владелец (dev-сервер): «i cannot add tables in the templates» — в окне
// «Шаблоны заключений» → «Новый шаблон» разделы (Жалобы, Анамнез, Осмотр…)
// без панели оформления. Теперь над разделами — та же панель, что у документа
// (Ж/К/Ч/З, цвет, подсветка, A+/A−, списки, ⌫, «Таблица»), и тот же набор
// таблицы (blank-table.js: вставка, строки, столбцы, Tab, Enter, отмена), а
// раздел хранит очищенную разметку.
//
// Окно шаблонов — страница кабинета (не iframe): здесь — его форма на стенде
// кабинета (cabinet-harness), а таблица в разделе — на маленьком DOM с
// разбором разметки (mini-dom.mjs). Щелчки, выделение и вид — headless Chrome.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom, El, CONFIRMS, answerConfirm } from './cabinet-harness.mjs';
import { miniDocument, el, HIDE_ATTRS } from './mini-dom.mjs';
import { sanitizeStoredHtml, richHasContent } from '../../shared/rich-text.js';
import { NOTES_BASE_KEY, notesWriteRefusal } from '../../shared/cabinet-notes.js';
HIDE_ATTRS.add('data-split-id');

installFakeDom();
const TB = await import('../views/blank-table.js');
const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

// ─── фальшивый сервер: шаблоны и записи кабинета ─────────────────────────────
const NOTES = new Map();
let TEMPLATES = [];
const SAVED = [];
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u !== '/api/db') return ok(null);
    if (body.table === 'consultation_templates') {
        if (body.op === 'select') return ok(TEMPLATES);
        if (body.op === 'insert' || body.op === 'update') { SAVED.push(body); return ok(body.op === 'insert' ? { id: 900 } : null); }
        return ok(null);
    }
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
    return ok(body.op === 'select' && !body.single ? [] : null);
};

// ─── стенд: окно шаблонов и поиск по дереву фальшивых элементов ──────────────
const all = (root, pred, out = []) => { for (const c of root.children || []) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const byText = (root, text) => all(root, (e) => e.tagName === 'BUTTON' && String(e.textContent).includes(text))[0];
const byAttr = (root, a, v) => all(root, (e) => e.getAttribute && e.getAttribute(a) !== null && (v === undefined || e.getAttribute(a) === v));
// Ревью T4 — клавиши идут, как в браузере: от элемента вверх к документу; слушатели
// документа — по порядку подписки, stopPropagation останавливает. Селектор «td,th»
// (ячейка под курсором) стенд понимает списком через запятую.
const DOC_L = {};
document.addEventListener = (t, fn) => { (DOC_L[t] || (DOC_L[t] = [])).push(fn); };
document.removeEventListener = (t, fn) => { const a = DOC_L[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); };
const _matches = El.prototype.matches;
El.prototype.matches = function (sel) { return String(sel).split(',').some((s) => _matches.call(this, s.trim())); };
function fire(target, type, init = {}) {
    let stop = false;
    const ev = { type, target, isTrusted: true, defaultPrevented: false, ...init, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stop = true; } };
    for (let n = target; n && !stop; n = n.parentElement) for (const fn of [...((n._l && n._l[type]) || [])]) { ev.currentTarget = n; fn(ev); }
    if (!stop) for (const fn of [...(DOC_L[type] || [])]) { ev.currentTarget = document; fn(ev); }
    return ev;
}
async function openModal(rows) {
    TEMPLATES = rows;
    for (const c of [...document.body.children]) c.remove();
    for (const k of Object.keys(DOC_L)) delete DOC_L[k];
    delete document.getSelection;
    WS.openTemplateLibraryModal(null, { manage: true });
    await tick(5);
    return document.body;
}
const modalOpen = () => all(document.body, (e) => e.className === 'modal').length === 1;

const TABLE3 = (cells) => '<table class="a4-tbl"><thead><tr>' + cells.slice(0, 3).map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
    + [3, 6].map((i) => '<tr>' + cells.slice(i, i + 3).map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

// ─── панель оформления ───────────────────────────────────────────────────────
test('T4: «Новый шаблон» — над разделами панель оформления (те же кнопки, что у документа, и «Таблица»), окно размера и панель таблицы', async () => {
    const root = await openModal([]);
    byText(root, 'Новый шаблон').dispatch('click');
    const bar = byAttr(root, 'data-tpl-fmt')[0];
    assert.ok(bar, 'панели оформления в форме шаблона нет');
    for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'foreColor', 'hiliteColor', 'fontSize:5', 'fontSize:2', 'insertUnorderedList', 'insertOrderedList', 'removeFormat']) {
        assert.ok(bar.innerHTML.includes('data-cmd="' + cmd + '"'), 'нет кнопки ' + cmd);
    }
    assert.match(bar.innerHTML, /<button type="button" data-cmd="table" title="Таблица" aria-label="Таблица"[^>]*><svg /, 'нет кнопки «Таблица»');
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(bar.innerHTML), 'эмодзи в панели');
    const secs = byAttr(root, 'data-tpl-sec');
    assert.deepEqual(secs.map((s) => s.getAttribute('data-tpl-sec')), ['chief_complaint', 'hpi', 'physical_exam', 'therapy_text', 'recommendations_text', 'conclusion_text']);
    assert.ok(all(root, (e) => e.getAttribute && e.getAttribute('data-bk-tblpick') !== null).length === 1, 'окна размера нет');
    assert.ok(all(root, (e) => e.getAttribute && e.getAttribute('data-bk-tbl') !== null).length === 1, 'панели таблицы нет');
    // раздел — обычный текст (не pre-wrap), выше прежних 260 px, подсказка на месте
    assert.equal(secs[0].style.whiteSpace, 'normal');
    assert.ok(!secs[0].style.maxHeight || secs[0].style.maxHeight !== '260px');
    assert.ok(secs[0].getAttribute('data-ph'));
    // закрытие окна снимает окно размера и панель таблицы со страницы
    all(root, (e) => e.className === 'modal-close')[0].dispatch('click');
    assert.equal(all(root, (e) => e.getAttribute && (e.getAttribute('data-bk-tblpick') !== null || e.getAttribute('data-bk-tbl') !== null)).length, 0, 'окно размера и панель остались после закрытия');
});

test('T4: шаблон для каждого рода (приём, диагностика, история болезни) — панель над разделами', async () => {
    const root = await openModal([]);
    byText(root, 'Новый шаблон').dispatch('click');
    for (const dt of ['1', '2']) {
        const btn = byAttr(root, 'data-dt', dt)[0];
        btn.dispatch('click');
        assert.ok(byAttr(root, 'data-tpl-fmt').length === 1, 'род ' + dt + ': панели нет');
        assert.ok(byAttr(root, 'data-tpl-sec').length > 0);
    }
});

// ─── прежние шаблоны простым текстом ─────────────────────────────────────────
test('T4: прежний шаблон простым текстом — строки в разделе видны строками; без правки сохраняется как был', async () => {
    const legacy = { id: 7, name: 'Старый', scope: 'shared', doc_type: '0', author_id: null, author_name: 'Врач', updated_at: '2026-10-01', body: { physical_exam: 'Почки: норма' + NL + 'Печень: <не увеличена>' } };
    globalThis.window.easymed = { state: { user: { id: 'u1', is_admin: true } } };   // правит администратор
    try {
        const root = await openModal([legacy]);
        // просмотр
        const view = all(root, (e) => e.className === 'tplm-sec-b')[0];
        assert.ok(view, 'просмотра нет');
        assert.equal(view.innerHTML, 'Почки: норма<br>Печень: &lt;не увеличена&gt;');
        // правка: раздел показывает строки; тело черновика не трогается, пока не правили
        const draft = WS.tplDraftFrom(legacy);
        assert.equal(WS.tplSaveBody(draft).physical_exam, legacy.body.physical_exam, 'старый шаблон без правки изменился');
        byText(all(root, (e) => e.className === 'tplm-detail')[0], 'Изменить').dispatch('click');
        const ex = byAttr(root, 'data-tpl-sec', 'physical_exam')[0];
        assert.equal(ex.innerHTML, 'Почки: норма<br>Печень: &lt;не увеличена&gt;');
        assert.ok(!ex.classList.contains('is-empty'));
        assert.ok(byAttr(root, 'data-tpl-sec', 'hpi')[0].classList.contains('is-empty'), 'у пустого раздела нет подсказки');
        // «Сохранить шаблон» без правки — тело как было (простой текст со «\n»)
        SAVED.length = 0;
        byText(root, 'Сохранить шаблон').dispatch('click');
        await tick(10);
        assert.equal(SAVED.length, 1, 'шаблон не сохранён');
        assert.deepEqual(SAVED[0].values.body, legacy.body);
        // правка раздела — в шаблон уходит очищенная разметка
        byText(all(root, (e) => e.className === 'tplm-detail')[0], 'Изменить').dispatch('click');
        const ex2 = byAttr(root, 'data-tpl-sec', 'physical_exam')[0];
        ex2.innerHTML = 'Почки: норма<br>Печень: <b onclick="x()">не</b> увеличена<script>x()</script>';
        ex2.dispatch('input');
        SAVED.length = 0;
        byText(root, 'Сохранить шаблон').dispatch('click');
        await tick(10);
        assert.deepEqual(SAVED[0].values.body, { physical_exam: 'Почки: норма<br>Печень: <b>не</b> увеличена' });
    } finally {
        delete globalThis.window.easymed;
    }
});

// ─── таблица в разделе шаблона ───────────────────────────────────────────────
test('T4: в разделе шаблона — таблица 3×3: вставка, строки и столбцы, значение раздела — очищенная разметка с a4-tbl', () => {
    const doc = miniDocument();
    const box = el(doc, '<div class="tplm-textarea" data-tpl-sec="physical_exam" contenteditable="true">Анализы:</div>');
    doc.body.appendChild(box);
    const parts = [box];
    const r = TB.insertTable(box, box.firstChild, 8, 3, 3, parts);
    assert.equal(r.host, box);
    const cells = ['Показатель', 'Результат', 'Норма', 'HGB', '140', '120–160', 'WBC', '6.1', '4–9'];
    box.querySelectorAll('th').concat(box.querySelectorAll('td')).forEach((c, i) => { c.innerHTML = cells[i]; });
    assert.equal(WS.tplSecValue(box), 'Анализы:' + TABLE3(cells) + '<div><br></div>');
    TB.addRow(box.querySelectorAll('td')[2], parts);
    TB.addColumn(box.querySelector('th'), parts);
    assert.deepEqual(box.querySelectorAll('tr').map((tr) => tr.children.length), [4, 4, 4, 4]);
    TB.removeColumn(box.querySelectorAll('th')[1], parts);
    TB.removeRow(box.querySelectorAll('tr')[2].firstChild, parts);
    assert.equal(WS.tplSecValue(box), 'Анализы:' + TABLE3(cells) + '<div><br></div>');
    // значение — очищенное: чужое не проходит, пустой раздел — пусто, пустая таблица — содержание
    box.innerHTML = '<b onclick="x()">ok</b><img src=x onerror=y>';
    assert.equal(WS.tplSecValue(box), '<b>ok</b>');
    box.innerHTML = '<br>';
    assert.equal(WS.tplSecValue(box), '');
    box.innerHTML = TB.buildTable(doc, 2, 2).outerHTML;
    assert.ok(richHasContent(WS.tplSecValue(box)) && WS.tplSecValue(box).startsWith('<table class="a4-tbl">'));
});

test('T4: вставка из Excel в раздел шаблона — простая таблица a4-tbl', () => {
    const doc = miniDocument();
    const box = el(doc, '<div class="tplm-textarea" data-tpl-sec="hpi" contenteditable="true"><div class="WordSection1"><table border="1"><tbody><tr><td colspan="2">A</td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div></div>');
    TB.normalizePasted(box);
    assert.equal(WS.tplSecValue(box), '<table class="a4-tbl"><tbody><tr><td>A</td><td><br></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
});

// ─── сохранить → использовать → документ → запись ────────────────────────────
test('T4: шаблон с таблицей, собранной в разделе, — сохраняется, вставляется в документ, доходит до бланка и записи', async () => {
    const cells = ['Показатель', 'Результат', 'Норма', 'HGB', '140', '120–160', 'WBC', '6.1', '4–9'];
    const doc = miniDocument();
    const box = el(doc, '<div class="tplm-textarea" data-tpl-sec="physical_exam" contenteditable="true">Анализы:</div>');
    TB.insertTable(box, box.firstChild, 8, 3, 3, [box]);
    box.querySelectorAll('th').concat(box.querySelectorAll('td')).forEach((c, i) => { c.innerHTML = cells[i]; });
    const body = WS.tplSaveBody({ doc_type: 0, body: { physical_exam: WS.tplSecValue(box), hpi: '' } });
    assert.ok(body.physical_exam.includes(TABLE3(cells)), 'в шаблон ушла не таблица: ' + body.physical_exam);
    assert.ok(!('hpi' in body), 'пустой раздел ушёл в шаблон');
    // «Использовать» в приёме
    const id = 501;
    NOTES.set(id, JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history: [] }));
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'П', firstName: 'Т', mrn: 'P-' + id, __service: { id, name: 'Приём', doctorName: 'Врач', doctorSpec: 'Терапевт' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]'); if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    await WS.hydrateLine(ctx);
    await tick(5);
    assert.equal(WS.tplApply(ctx, { doc_type: '0', body }), 'conclusion');
    const form = container.querySelector('.a4-input[data-field="physical_exam"]');
    assert.ok(form.innerHTML.includes(TABLE3(cells)), 'шаблон вставил не таблицу: ' + form.innerHTML);
    assert.ok(WS.docSnapshot(ctx, 'conclusion').exam.includes(TABLE3(cells)), 'на бланке нет таблицы');
    assert.ok(await WS.saveDraft(ctx, { silent: true }), 'черновик не записан');
    assert.ok(JSON.parse(NOTES.get(id)).current.physical_exam.includes(TABLE3(cells)), 'в запись ушла не таблица');
});

// ─── просмотр шаблона в списке ───────────────────────────────────────────────
test('T4: просмотр шаблона в списке — оформление и таблица как в документе (только чтение)', async () => {
    const cells = ['A', 'B', 'C', '1', '2', '3', '4', '5', '6'];
    const t = { id: 8, name: 'С таблицей', scope: 'shared', doc_type: '0', author_id: null, author_name: 'Врач', updated_at: '2026-10-28', body: { physical_exam: '<b>Анализы</b>' + TABLE3(cells) + '<ul><li>пункт</li></ul>' } };
    const root = await openModal([t]);
    const view = all(root, (e) => e.className === 'tplm-sec-b')[0];
    assert.equal(view.innerHTML, sanitizeStoredHtml(t.body.physical_exam));
    assert.ok(!view.getAttribute('contenteditable'), 'просмотр правится');
});

test('T4: стили — списки и таблица в разделе шаблона и в просмотре, подсказка пустого раздела, панель над разделами', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const full = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
    const css = full.slice(full.indexOf('.tplm-'));   // стили окна шаблонов (короткий вывод при отказе)
    assert.match(css, /\.tplm-textarea ul, \.tplm-textarea ol, \.tplm-sec-b ul, \.tplm-sec-b ol \{[^}]*padding-left: 2\dpx/);
    assert.match(css, /\.tplm-textarea table\.a4-tbl th,[^{]*\{[^}]*border: 1px solid/);
    assert.match(css, /\.tplm-sec-b table\.a4-tbl th,/);
    assert.match(css, /\.tplm-textarea:empty::before, \.tplm-textarea\.is-empty::before \{[^}]*content: attr\(data-ph\)/);
    assert.match(css, /\.tplm-fmt \{[^}]*position: sticky/);
    assert.match(css, /\.tplm-sec-b \{[^}]*white-space: normal/);
    // ревью T4 (LOW) — «Заключение» диагностики: панель погашена, подсказка видна
    assert.match(css, /\.tplm-fmt\.is-plain button \{[^}]*opacity/);
    assert.match(css, /\.tplm-fmt\.is-plain \.tplm-fmt-hint \{[^}]*display: inline/);
});

// ─── ревью T4 (MEDIUM): Escape набора таблицы не закрывает окно с черновиком ──
async function draftWithText() {
    const root = await openModal([]);
    byText(root, 'Новый шаблон').dispatch('click');
    const name = all(root, (e) => e.className === 'tplm-input')[0];
    name.value = 'Черновик'; name.dispatch('input');
    const box = byAttr(root, 'data-tpl-sec', 'physical_exam')[0];
    box.innerHTML = 'Важный текст черновика'; box.dispatch('input');
    return { root, name, box };
}
test('ревью T4: Escape на «Вставить таблицу» и в полях окна размера закрывает только окно размера — окно шаблонов и черновик на месте', async () => {
    const { root, name } = await draftWithText();
    const pick = byAttr(root, 'data-bk-tblpick')[0];
    const ins = byAttr(pick, 'data-bk-tblins')[0];
    pick.style.display = 'block';   // окно размера открыто (openPicker)
    CONFIRMS.length = 0;
    const ev = fire(ins, 'keydown', { key: 'Escape' });
    assert.ok(modalOpen(), 'Escape в окне размера закрыл окно шаблонов');
    assert.equal(pick.style.display, 'none', 'окно размера не закрылось');
    assert.ok(ev.defaultPrevented, 'Escape окна размера не помечен обработанным');
    assert.equal(name.value, 'Черновик');
    assert.equal(CONFIRMS.length, 0, 'вопрос о несохранённом — без закрытия окна');
    pick.style.display = 'block';
    const num = all(pick, (e) => e.tagName === 'INPUT')[0];
    fire(num, 'keydown', { key: 'Escape' });
    assert.ok(modalOpen(), 'Escape в поле числа закрыл окно шаблонов');
    assert.equal(pick.style.display, 'none');
});

test('ревью T4: Escape с курсором в ячейке таблицы раздела (панель таблицы видна) — только панель; окно шаблонов на месте', async () => {
    const { root, box } = await draftWithText();
    box.setAttribute('contenteditable', 'true');   // браузер пишет атрибут строчными, стенд — как задано
    const table = new El('table'); const tr0 = new El('tr'); const td = new El('td'); const txt = new El('span');
    td.appendChild(txt); tr0.appendChild(td); table.appendChild(tr0); box.appendChild(table);
    document.getSelection = () => ({ rangeCount: 1, anchorNode: txt, anchorOffset: 0 });   // курсор — в тексте ячейки
    const panel = byAttr(root, 'data-bk-tbl')[0];
    panel.style.display = 'block';
    CONFIRMS.length = 0;
    fire(td, 'keydown', { key: 'Escape' });
    assert.ok(modalOpen(), 'Escape в ячейке закрыл окно шаблонов');
    assert.equal(panel.style.display, 'none', 'панель таблицы не скрылась');
    // панель уже скрыта, курсор всё ещё в ячейке — Escape по-прежнему не закрывает окно
    fire(td, 'keydown', { key: 'Escape' });
    assert.ok(modalOpen(), 'второй Escape в ячейке закрыл окно шаблонов');
    // Escape на панели таблицы — её, дальше не идёт
    panel.style.display = 'block';
    const ev = fire(all(panel, (e) => e.tagName === 'BUTTON')[0], 'keydown', { key: 'Escape' });
    assert.ok(ev.defaultPrevented && modalOpen() && panel.style.display === 'none');
    assert.equal(CONFIRMS.length, 0);
});

test('ревью T4: окно с несохранённым черновиком закрывается только после «Закрыть без сохранения?» (Escape, щелчок мимо окна, «×»); без правок — сразу', async () => {
    // без правок — без вопроса
    let root = await openModal([]);
    byText(root, 'Новый шаблон').dispatch('click');
    CONFIRMS.length = 0;
    fire(document.body, 'keydown', { key: 'Escape' });
    assert.ok(!modalOpen(), 'чистый черновик: Escape не закрыл окно');
    assert.equal(CONFIRMS.length, 0, 'чистый черновик: лишний вопрос');
    // правки — вопрос; «Отмена» вопроса — окно и черновик на месте
    const closers = [
        ['Escape', (r) => fire(document.body, 'keydown', { key: 'Escape' })],
        ['щелчок мимо окна', (r) => all(r, (e) => e.className === 'modal-backdrop')[0].dispatch('click')],
        ['«×»', (r) => all(r, (e) => e.className === 'modal-close')[0].dispatch('click')],
    ];
    try {
        for (const [how, act] of closers) {
            ({ root } = await draftWithText());
            CONFIRMS.length = 0;
            answerConfirm(false);
            act(root);
            assert.equal(CONFIRMS.length, 1, how + ': нет вопроса');
            assert.equal(CONFIRMS[0], 'Шаблон не сохранён. Закрыть без сохранения?');
            assert.ok(modalOpen(), how + ': окно закрылось после «Отмена»');
            assert.equal(byAttr(root, 'data-tpl-sec', 'physical_exam')[0].innerHTML, 'Важный текст черновика');
            answerConfirm(true);
            act(root);
            assert.ok(!modalOpen(), how + ': окно не закрылось после «ОК»');
        }
    } finally { answerConfirm(true); }
    // «Отмена» формы — осознанный отказ от черновика, без вопроса
    ({ root } = await draftWithText());
    CONFIRMS.length = 0;
    byText(all(root, (e) => e.tagName === 'FOOTER')[0], 'Отмена').dispatch('click');
    assert.equal(CONFIRMS.length, 0);
    assert.equal(byAttr(root, 'data-tpl-sec').length, 0);
});

// ─── ревью T4 (LOW): «Заключение» диагностики — только текст ─────────────────
test('ревью T4: «Заключение» шаблона диагностики (primary_diagnosis) — без таблицы и оформления: панель погашена с подсказкой', async () => {
    const root = await openModal([]);
    byText(root, 'Новый шаблон').dispatch('click');
    byAttr(root, 'data-dt', '1')[0].dispatch('click');
    const bar = byAttr(root, 'data-tpl-fmt')[0];
    assert.ok(bar.innerHTML.includes('В заключении — только текст'), 'подсказки нет');
    const dx = byAttr(root, 'data-tpl-sec', 'primary_diagnosis')[0];
    const instr = byAttr(root, 'data-tpl-sec', 'instrumental_text')[0];
    assert.ok(!bar.classList.contains('is-plain'), 'панель погашена до фокуса');
    dx.dispatch('focus');
    assert.ok(bar.classList.contains('is-plain'), 'в «Заключении» панель не погашена');
    instr.dispatch('focus');
    assert.ok(!bar.classList.contains('is-plain'), 'в разделе с оформлением панель погашена');
    // таблица: в «Заключение» — нет, в прочие разделы — да
    const doc = miniDocument();
    const env = WS.templateTableEnv(doc);
    const dxBox = el(doc, '<div data-tpl-sec="primary_diagnosis" contenteditable="true">Заключение</div>');
    const exBox = el(doc, '<div data-tpl-sec="instrumental_text" contenteditable="true">УЗИ</div>');
    assert.equal(env.tablesOn(dxBox), false);
    assert.equal(env.tablesOn(exBox), true);
});
