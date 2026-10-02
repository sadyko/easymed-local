// PRINT_AUTO_V1 (владелец, 02.10) — ПЕЧАТЬ В ОДИН ШАГ.
//
// «when pressed print its showing htm file but without pre selected print
// option with printer selection, the elder doctors can use thats why we need
// to decrease steps». Владелец выбрал: «Печать» сразу открывает окно принтера.
//
// Причина: printableSheet (doc-settings.js) писал HTML во всплывающее окно и
// window.print() не звал. Скрипт печати был только у запасной обёртки
// (doc-render.js), а оформленные бланки (doc-variants.js — заключение,
// диагностика, анализы, счёт, чек, квитанция) шли без него: врач видел
// страницу и искал, где печатать. Те же бланки у кассы (receipt-print.js).
//
// Проверяется: общий помощник ensureAutoPrint (скрипт ровно один раз, у бланка
// со своим скриптом — не второй), printableSheet на настоящих бланках, три
// пути чеков кассы, запасной предпросмотр при заблокированном окне и то, что
// предпросмотр «Документов» и PDF для Telegram скрипт по-прежнему вырезают.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- окружение браузера: ровно то, что нужно doc-settings.js при импорте и печати ---
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
const opened = [];   // HTML, записанный во всплывающие окна
let popupBlocked = false;
const openWin = () => {
  if (popupBlocked) return null;
  const w = { _html: '', document: { open() {}, write(h) { w._html += h; }, close() { opened.push(w._html); } }, focus() {}, print() {}, close() {} };
  return w;
};
// Запасной предпросмотр (окно заблокировано): оверлей с iframe и кнопками.
const overlays = [];
function fakeOverlay() {
  const frame = {
    printed: 0, focused: 0, written: '',
    contentWindow: { focus() { frame.focused++; }, print() { frame.printed++; }, addEventListener(t, fn) { if (t === 'load') frame.onload = fn; } },
  };
  frame.contentDocument = { readyState: 'loading', fonts: { ready: Promise.resolve() }, open() {}, write(h) { frame.written += h; }, close() {} };
  const btn = (cls) => ({ cls, onclick: null, focused: 0, focus() { this.focused++; } });
  const parts = { '.modal-backdrop': btn('backdrop'), '.modal-close': btn('close'), '.btn': btn('btn'), '.btn-primary': btn('primary'), iframe: frame };
  const el = { style: {}, className: '', innerHTML: '', removed: false, parts, querySelector: (sel) => parts[sel] || null, remove() { el.removed = true; } };
  overlays.push(el);
  return el;
}
globalThis.document = {
  createElement: (tag) => (String(tag).toLowerCase() === 'div' ? fakeOverlay() : { style: {}, appendChild() {}, setAttribute() {} }),
  createTextNode: () => ({}), head: { appendChild() {} }, body: { appendChild() {}, children: [] }, documentElement: {},
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, open: openWin, addEventListener() {}, dispatchEvent() { return true; }, easymed: { state: { user: { id: 1 } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: null }), headers: { getSetCookie: () => [] } });

const { ensureAutoPrint, hasAutoPrint, AUTO_PRINT_SCRIPT, withoutAutoPrint, viewOnlySheet } = await import('../../shared/print-auto.js');
const { printableSheet } = await import('../views/doc-settings.js?v=noqr1');
const { buildSheetHtml } = await import('../../shared/doc-render.js');
const { printInvoiceCheck, printInvoiceSheetById, printSlip } = await import('../views/receipt-print.js?v=rp1');
const { stripAutoPrint } = await import('../../../../server/services/telegram/render.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const prints = (html) => (String(html).match(/window\.print\s*\(/g) || []).length;
const scripts = (html) => (String(html).match(/<script\b/gi) || []).length;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const S = { clinicName: 'Клиника «Шифо»', accent: '#167873', variant: {} };

// ---------------------------------------------------------------------------
// ensureAutoPrint — общий помощник
// ---------------------------------------------------------------------------
test('ensureAutoPrint: скрипт печати перед </body> ровно один раз; печать после загрузки и шрифтов, окно закрывается после печати', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><p>Бланк</p></body></html>';
  const out = ensureAutoPrint(html);
  assert.equal(prints(out), 1);
  assert.equal(scripts(out), 1);
  assert.ok(out.includes(AUTO_PRINT_SCRIPT));
  assert.ok(out.indexOf(AUTO_PRINT_SCRIPT) < out.lastIndexOf('</body>'), 'скрипт — внутри body, перед </body>');
  assert.ok(out.startsWith('<!doctype html><html><head><title>x</title></head><body><p>Бланк</p>'), 'документ не тронут');
  // Как у рабочих окон (kitchen-sheet, report-print): после загрузки и шрифтов, focus + print.
  assert.match(AUTO_PRINT_SCRIPT, /^<script>/, 'тег без атрибутов — его вырезают и «Документы», и Telegram');
  assert.match(AUTO_PRINT_SCRIPT, /addEventListener\('load'/);
  assert.match(AUTO_PRINT_SCRIPT, /document\.fonts/);
  assert.match(AUTO_PRINT_SCRIPT, /window\.focus\(\);\s*window\.print\(\);/);
  assert.match(AUTO_PRINT_SCRIPT, /addEventListener\('afterprint'[\s\S]*window\.close\(\)/, 'после печати окно закрывается');
  assert.match(AUTO_PRINT_SCRIPT, /PRINT_AUTO_V1/);
  assert.ok(hasAutoPrint(out));
  assert.ok(!hasAutoPrint(html));
});

test('ensureAutoPrint: второй раз не добавляет; HTML со своим скриптом печати не трогает; без </body> — в конец; </BODY> — тоже находит', () => {
  const html = '<html><body>Бланк</body></html>';
  const once = ensureAutoPrint(html);
  assert.equal(ensureAutoPrint(once), once, 'двойной печати нет');
  const own = '<html><body>Лист<script>window.onload=function(){window.print();};</script></body></html>';
  assert.equal(ensureAutoPrint(own), own, 'у окна уже есть печать — не второй скрипт');
  assert.equal(prints(ensureAutoPrint('<p>фрагмент</p>')), 1);
  assert.ok(ensureAutoPrint('<p>фрагмент</p>').endsWith(AUTO_PRINT_SCRIPT));
  const upper = ensureAutoPrint('<HTML><BODY>x</BODY></HTML>');
  assert.ok(upper.endsWith(AUTO_PRINT_SCRIPT + '</BODY></HTML>'));
  // Последний </body>: строка «</body>» внутри текста бланка раньше — не место для скрипта.
  const two = ensureAutoPrint('<body><pre>&lt;/body&gt;</pre></body>');
  assert.ok(two.endsWith(AUTO_PRINT_SCRIPT + '</body>'));
  assert.equal(ensureAutoPrint(null), AUTO_PRINT_SCRIPT);
});

// ---------------------------------------------------------------------------
// printableSheet — «Печать» кабинета, кассы, лаборатории
// ---------------------------------------------------------------------------
test('printableSheet: оформленные бланки (заключение, диагностика, анализы, счёт, чек, квитанция) печатаются сразу — скрипт ровно один', () => {
  const DATA = {
    conclusion: { patientName: 'Азизов Б.', complaints: 'Головная боль', __editor: true },
    diag: { patientName: 'Азизов Б.', service: 'УЗИ брюшной полости', description: 'Печень не увеличена.', conclusion: 'Норма', __editor: true },
    lab: null,
    invoice: { docNo: 'INV-1', items: [{ name: 'Консультация', qty: 1, price: 100000 }], total: 100000 },
    fiscal: { docNo: 'INV-1', items: [{ name: 'Консультация', qty: 1, price: 100000 }], total: 100000 },
    check: { docNo: 'CHK-1', items: [{ name: 'Консультация', qty: 1, price: 100000 }], total: 100000 },
    slip: { title: 'Квитанция', docNo: 'D-1', rows: [['Пациент', 'Азизов Б.']], amount: 100000 },
  };
  for (const [type, data] of Object.entries(DATA)) {
    const designed = buildSheetHtml({ type, s: S, data });
    assert.equal(prints(designed), 0, type + ': оформленный бланк сам скрипта не несёт — потому и не печатался');
    opened.length = 0;
    printableSheet({ type, data, settings: S });
    assert.equal(opened.length, 1, type + ': окно открыто');
    assert.equal(prints(opened[0]), 1, type + ': window.print — ровно один раз');
    assert.ok(opened[0].includes(AUTO_PRINT_SCRIPT), type + ': скрипт общего помощника');
  }
});

test('printableSheet: запасная обёртка уже печатает сама — второго скрипта нет', () => {
  const own = buildSheetHtml({ type: 'case_doc', s: S, bodyHtml: '<p>Маршрутный лист</p>', title: 'Маршрутный лист' });
  assert.equal(prints(own), 1, 'обёртка doc-render.js печатает сама');
  opened.length = 0;
  printableSheet({ type: 'case_doc', title: 'Маршрутный лист', bodyHtml: '<p>Маршрутный лист</p>', settings: S });
  assert.equal(opened.length, 1);
  assert.equal(prints(opened[0]), 1, 'не два вызова печати');
  assert.ok(!opened[0].includes(AUTO_PRINT_SCRIPT));
});

test('предпросмотр «Документов» и PDF для Telegram собирают бланк без скрипта помощника (buildSheetHtml не трогаем)', () => {
  const designed = buildSheetHtml({ type: 'conclusion', s: S, data: { patientName: 'Азизов Б.', __editor: true } });
  assert.ok(!designed.includes('PRINT_AUTO_V1'));
  const ds = src('public/js/admin/views/doc-settings.js');
  assert.match(ds, /export function renderPreviewHtml\(type, settings\) \{\s*return buildSheetHtml\(\{ type, s: settings \}\);/);
});

// ---------------------------------------------------------------------------
// Вырезание скрипта: «Документы» (предпросмотр) и Telegram (PDF)
// ---------------------------------------------------------------------------
test('«Документы» и запасной предпросмотр вырезают скрипт помощника; Telegram — тоже', () => {
  const ensured = ensureAutoPrint(buildSheetHtml({ type: 'diag', s: S, data: { service: 'УЗИ', description: 'x', __editor: true } }));
  const fallback = buildSheetHtml({ type: 'case_doc', s: S, bodyHtml: '<p>x</p>' });
  // Тот же шаблон, что в documents.js (buildPreviewFrame) и doc-settings.js (openInlinePrintPreview).
  const PREVIEW_RE = /<script>[\s\S]*?<\/script>/g;
  const docs = src('public/js/admin/views/documents.js');
  assert.ok(docs.includes(".replace(/<script>[\\s\\S]*?<\\/script>/g, '')"), 'documents.js вырезает скрипты тем же шаблоном');
  for (const html of [ensured, fallback]) {
    const stripped = html.replace(PREVIEW_RE, '');
    assert.equal(prints(stripped), 0);
    assert.equal(scripts(stripped), 0);
    const tg = stripAutoPrint(html);
    assert.equal(prints(tg), 0, 'Telegram: window.print не попадает в headless Chrome');
    assert.equal(scripts(tg), 0);
    assert.ok(tg.includes('</body>'), 'документ остался документом');
  }
});

// ---------------------------------------------------------------------------
// Касса: три пути receipt-print.js идут через printableSheet → помощник
// ---------------------------------------------------------------------------
function fakeSupabase(tables) {
  return {
    from(t) {
      const filters = [];
      let one = false, strict = false;
      const b = {
        select() { return b; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
        in(c, vs) { filters.push((r) => (vs || []).map(String).includes(String(r[c]))); return b; },
        order() { return b; },
        single() { one = true; strict = true; return b; },
        maybeSingle() { one = true; return b; },
        then(res, rej) {
          const rows = (tables[t] || []).filter((r) => filters.every((f) => f(r)));
          const data = one ? (rows[0] || null) : rows;
          return Promise.resolve({ data, error: strict && !data ? { message: 'not found' } : null }).then(res, rej);
        },
      };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
}
const SB = fakeSupabase({
  invoices: [{ id: 1, invoice_number: 'INV-A-26-00001', subtotal: 150000, discount_amount: 0, total_amount: 150000, paid_amount: 150000, status: 'paid', patient_id: 1, created_at: '2026-10-02T07:00:00Z' }],
  invoice_items: [{ id: 11, invoice_id: 1, description: 'Консультация терапевта', quantity: 1, unit_price: 150000, total: 150000, discount_amount: 0 }],
  patients: [{ id: 1, full_name: 'Азизов Бахтиёр', mrn: 'P-1', date_of_birth: '1980-05-01', gender: 'male', phone: '+998901112233' }],
  payments: [{ id: 1, invoice_id: 1, amount: 150000, method: 'cash', paid_at: '2026-10-02T07:05:00Z' }],
  visit_services: [],
});

// PRINT_AUTO_V1 (ревью, решение координатора) — печать сразу — только по
// нажатой «Печать»: кнопка «Печать чека» (printInvoiceCheck) и счёт по кнопке
// (printInvoiceSheetById по умолчанию). Квитанция (printSlip) открывается сама
// после операции (продажа карты, депозит, замена услуги) — только показ.
test('касса: чек и счёт по кнопке — печать сразу; счёт, открытый сам (autoPrint: false), и квитанция — только показ', async () => {
  opened.length = 0;
  assert.deepEqual(await printInvoiceCheck({ supabase: SB, printableSheet, invoiceId: 1, cashierName: 'Кассир' }), { ok: true });
  assert.deepEqual(await printInvoiceSheetById({ supabase: SB, printableSheet, invoiceId: 1 }), { ok: true });
  assert.deepEqual(await printInvoiceSheetById({ supabase: SB, printableSheet, invoiceId: 1, autoPrint: false }), { ok: true });
  assert.equal(printSlip(printableSheet, { kind: 'deposit', deposit: { deposit_number: 'DEP-1', amount: 50000, method: 'cash', status: 'paid' }, patient: { full_name: 'Азизов Бахтиёр', mrn: 'P-1' }, balance: 50000 }), true);
  assert.equal(opened.length, 4, 'четыре окна');
  for (const [i, name] of ['чек', 'счёт'].entries()) {
    assert.match(opened[i], /Азизов Бахтиёр/, name + ': бланк этого пациента');
    assert.equal(prints(opened[i]), 1, name + ': window.print — ровно один раз');
    assert.ok(opened[i].includes(AUTO_PRINT_SCRIPT), name + ': скрипт общего помощника');
  }
  for (const [i, name] of [[2, 'счёт, открытый сам'], [3, 'квитанция']]) {
    assert.match(opened[i], /Азизов Бахтиёр/, name + ': бланк этого пациента');
    assert.equal(scripts(opened[i]), 0, name + ': окно печати само не открывается');
    assert.match(opened[i], /class="pa-view-print" onclick="window\.print\(\)"/, name + ': «Печать» в окне');
  }
});

// ---------------------------------------------------------------------------
// Окно заблокировано: запасной предпросмотр печатает сам, «Печать» — одним нажатием
// ---------------------------------------------------------------------------
test('окно заблокировано: предпросмотр без скриптов, печать открывается сама один раз, «Печать» в фокусе и печатает ещё раз', async () => {
  popupBlocked = true;
  try {
    overlays.length = 0;
    printableSheet({ type: 'conclusion', data: { patientName: 'Азизов Б.', __editor: true }, settings: S });
    assert.equal(overlays.length, 1, 'вместо окна — предпросмотр в приложении');
    const { iframe: frame, '.btn-primary': printBtn } = overlays[0].parts;
    assert.match(frame.written, /Азизов Б\./);
    assert.equal(scripts(frame.written), 0, 'скрипты вырезаны: печать зовёт приложение, а не бланк');
    assert.ok(printBtn.focused >= 1, '«Печать» в фокусе — Enter печатает');
    assert.equal(frame.printed, 0, 'печать — после загрузки бланка');
    frame.contentDocument.readyState = 'complete';
    if (frame.onload) frame.onload();
    await tick(400);
    assert.equal(frame.printed, 1, 'окно печати открылось само — один раз');
    printBtn.onclick();
    assert.equal(frame.printed, 2, '«Печать» — одно нажатие');
  } finally { popupBlocked = false; }
});

// ---------------------------------------------------------------------------
// PRINT_AUTO_V1 (координатор, 02.10) — «Открыть» НЕ печатает: окно только
// показывает документ (без скрипта печати — ни помощника, ни своего у
// обёртки), а «Печать» в углу окна печатает одним нажатием и на бумагу не
// попадает. «Печать» кабинета и касса — по-прежнему сразу.
// ---------------------------------------------------------------------------
test('withoutAutoPrint / viewOnlySheet: скрипты печати убраны, прочие скрипты целы; кнопка «Печать» одна, на бумаге скрыта, подпись экранирована', () => {
  const other = '<script>var x = 1;</script>';
  const html = '<html><body><p>Бланк</p>' + other + '<script>window.onload=function(){window.print();};</script></body></html>';
  assert.equal(withoutAutoPrint(html), '<html><body><p>Бланк</p>' + other + '</body></html>');
  assert.equal(withoutAutoPrint(ensureAutoPrint('<body>x</body>')), '<body>x</body>', 'скрипт помощника — тоже');
  const view = viewOnlySheet(html, { printLabel: 'Печать <b>', accent: '#0a7d6e' });
  assert.equal(scripts(view), 1, 'остался только не-печатный скрипт');
  assert.ok(view.includes(other));
  assert.equal((view.match(/class="pa-view-print"/g) || []).length, 1, 'одна кнопка');
  assert.match(view, /<button type="button" class="pa-view-print" onclick="window\.print\(\)">Печать &lt;b&gt;<\/button>/);
  assert.match(view, /@media print\s*\{\s*\.pa-view-print\s*\{\s*display:\s*none\s*!important;?\s*\}\s*\}/, 'на бумаге кнопки нет');
  assert.match(view, /#0a7d6e/, 'цвет клиники');
  assert.ok(view.indexOf('pa-view-print') < view.lastIndexOf('</body>'));
  assert.doesNotMatch(viewOnlySheet('<body>x</body>', { accent: 'red;}</style><script>alert(1)</script>' }), /alert/, 'цвет — только #rrggbb');
  assert.equal(viewOnlySheet(viewOnlySheet('<body>x</body>')), viewOnlySheet('<body>x</body>'), 'вторую кнопку не добавляет');
});

test('«Открыть» (autoPrint: false): документ без скрипта печати — и оформленный бланк, и обёртка со своим скриптом; «Печать» — с ним', () => {
  const CASES = [
    ['conclusion', { data: { patientName: 'Азизов Б.', __editor: true } }],
    ['diag', { data: { patientName: 'Азизов Б.', service: 'УЗИ', description: 'x', conclusion: 'Норма', __editor: true } }],
    ['lab', { data: null }],
    ['conclusion', { title: 'Заключение врача', bodyHtml: '<h3>Заключение врача</h3><p>Азизов Б.</p>' }],   // обёртка doc-render.js
  ];
  for (const [type, extra] of CASES) {
    opened.length = 0;
    printableSheet({ type, settings: S, autoPrint: false, ...extra });
    assert.equal(opened.length, 1, type + ': окно открыто');
    assert.equal(scripts(opened[0]), 0, type + ': ни одного скрипта — окно печати не откроется само');
    assert.ok(!opened[0].includes('PRINT_AUTO_V1'), type + ': без помощника');
    assert.equal((opened[0].match(/class="pa-view-print"/g) || []).length, 1, type + ': «Печать» в окне — одна кнопка');
    assert.match(opened[0], /onclick="window\.print\(\)">Печать<\/button>/, type + ': кнопка печатает одним нажатием');
    opened.length = 0;
    printableSheet({ type, settings: S, ...extra });
    assert.equal(prints(opened[0]), 1, type + ': «Печать» — печать сразу, один вызов');
    assert.equal(scripts(opened[0]), 1);
    assert.ok(!opened[0].includes('pa-view-print'), type + ': у «Печать» кнопки в окне нет — печать уже идёт');
  }
});

test('«Открыть» при заблокированном окне: предпросмотр не печатает сам; «Печать» предпросмотра — одно нажатие', async () => {
  popupBlocked = true;
  try {
    overlays.length = 0;
    printableSheet({ type: 'diag', data: { patientName: 'Азизов Б.', service: 'УЗИ', conclusion: 'Норма', __editor: true }, settings: S, autoPrint: false });
    assert.equal(overlays.length, 1);
    const { iframe: frame, '.btn-primary': printBtn } = overlays[0].parts;
    assert.match(frame.written, /Азизов Б\./);
    assert.ok(!frame.written.includes('pa-view-print'), 'у предпросмотра своя «Печать» — вторая не нужна');
    frame.contentDocument.readyState = 'complete';
    if (frame.onload) frame.onload();
    await tick(400);
    assert.equal(frame.printed, 0, 'окно печати само не открылось');
    printBtn.onclick();
    assert.equal(frame.printed, 1);
  } finally { popupBlocked = false; }
});

// Кто «Открыть», а кто «Печать» — по месту в исходнике (экраны без DOM не поднимаются).
const sliceFn = (text, start, end) => {
  const a = text.indexOf(start);
  assert.ok(a >= 0, 'нет ' + start);
  const b = text.indexOf(end, a + start.length);
  return text.slice(a, b < 0 ? undefined : b);
};
test('«Открыть» — без печати: архив документов, ссылка в списке документов карты, результат в истории болезни', () => {
  const archive = sliceFn(src('public/js/admin/views/docs-archive.js'), 'async function openDoc(d)', 'async function loadDocs()');
  assert.match(archive, /printableSheet\(\{ type, data: d\.body, title: d\.title \|\| 'Документ', settings: loadDocSettings\(\), autoPrint: false \}\)/);
  const tabs = sliceFn(src('public/js/admin/views/case-file-tabs.js'), 'async function openResultDoc(', '\n}\n');
  assert.equal((tabs.match(/printableSheet\(\{/g) || []).length, 2);
  assert.equal((tabs.match(/autoPrint: false/g) || []).length, 2, 'и анализ, и заключение диагностики');
  const card = src('public/js/admin/views/patient-card.js');
  // Ссылка-название документа — «Открыть»; кнопка «Печать» той же строки — печать сразу.
  assert.match(card, /onclick: \(ev\) => \{ ev\.preventDefault\(\); openRow\(d, VIEW_ONLY\); \}/);
  assert.match(card, /title: 'Печать',\s*onclick: \(\) => openRow\(d\),/);
  assert.match(card, /const openRow = \(d, view\) => d\._lab \? printLabDay\(d, view\) : \(d\._ws \? printWsDoc\(d, view\) : openDoc\(d, view\)\);/);
  assert.match(card, /const VIEW_ONLY = \{ autoPrint: false \};/);
  for (const fn of ['async function openDoc(d, view = null)', 'async function printLabDay(doc, view = null)', 'function printWsDoc(d, view = null)']) {
    const body = sliceFn(card, fn, '\n        }\n');
    assert.match(body, /printableSheet\(\{[\s\S]*?\.\.\.view/, fn + ': вид окна — от вызывающего');
  }
});

test('«Печать» — печать сразу: кабинет врача и лаборатория не просят «только показать»; по умолчанию printableSheet печатает', () => {
  for (const rel of ['public/js/admin/views/service-workspace.js', 'public/js/admin/views/laboratory.js']) {
    assert.doesNotMatch(src(rel), /autoPrint:\s*false/, rel);
  }
  const ds = src('public/js/admin/views/doc-settings.js');
  assert.match(ds, /autoPrint = true/, 'по умолчанию printableSheet печатает');
});

// ---------------------------------------------------------------------------
// PRINT_AUTO_V1 (ревью 02.10, решение координатора) — печать сразу ТОЛЬКО там,
// где человек нажал «Печать». Документ, который открывается сам после
// сохранения (мастера записи, касса после оплаты), «Открыть» и предпросмотр
// шаблона — только показ, «Печать» — кнопкой окна. Мастер с N счетами иначе
// поднимал N окон печати (а при заблокированных окнах — N самопечатающих
// предпросмотров).
// ---------------------------------------------------------------------------
test('«уже печатает» — только скрипт: слова window.print( в тексте документа не мешают помощнику', () => {
  const doc = '<html><body><p>Пример: window.print(); — это текст, не скрипт</p></body></html>';
  assert.equal(hasAutoPrint(doc), false);
  const out = ensureAutoPrint(doc);
  assert.ok(out.includes(AUTO_PRINT_SCRIPT));
  assert.equal(scripts(out), 1);
  assert.equal(hasAutoPrint('<body><script>window.print()</script></body>'), true);
  assert.equal(hasAutoPrint('<body><SCRIPT type="text/javascript">setTimeout(function(){ window.print (); }, 1)</SCRIPT></body>'), true);
  assert.equal(hasAutoPrint('<body><script>var a = 1;</script><p>window.print(</p></body>'), false, 'печать в тексте после скрипта — не печать');
  assert.equal(hasAutoPrint('<body><button onclick="window.print()">Печать</button></body>'), false, 'кнопка окна «Открыть» — не самопечать');
  // Бланк, в тексте которого врач написал «window.print()», всё равно печатается сразу.
  opened.length = 0;
  printableSheet({ type: 'diag', settings: S, data: { patientName: 'Азизов Б.', service: 'УЗИ', description: 'window.print()', conclusion: 'Норма', __editor: true } });
  assert.equal(scripts(opened[0]), 1);
  assert.ok(opened[0].includes(AUTO_PRINT_SCRIPT));
});

test('предпросмотр шаблона в «Документах» — только показ', () => {
  const docs = src('public/js/admin/views/documents.js');
  assert.match(docs, /onclick: \(\) => printableSheet\(\{\s*type:\s*state\.active,\s*settings: state\.s,\s*autoPrint: false,/);
});

test('мастера записи и касса: документы, открытые сами после сохранения, — только показ; кнопки «Печать» — печать сразу', () => {
  const spm = src('public/js/admin/views/service-picker-modal.js');
  assert.match(spm, /printableSheet\(\{ type: 'invoice', idLine: invNo, autoPrint: false, data: \{/, 'счёт пациента мастера');
  assert.match(spm, /printableSheet\(\{ type: 'act', idLine: actNo, autoPrint: false, data: \{/, 'акт плательщику мастера');
  const wiz = src('public/js/admin/views/visit-wizard.js');
  assert.match(wiz, /printInvoiceSheetById\(\{ supabase, printableSheet, invoiceId: pInv\.id, withPerformer: true, extraPatient, extraBilling, autoPrint: false \}\)/, 'счета мастера — в цикле');
  assert.match(sliceFn(wiz, 'function printAkt(', '\n    }\n'), /printableSheet\(\{ \.\.\.actSheet\(\{[\s\S]*\}\), autoPrint: false \}\);/, 'акты мастера');
  const vm = src('public/js/admin/views/visit-modal.js');
  assert.match(vm, /function openInvoicePrintWindow\(state, inv, lineItems, \{ autoPrint = true \} = \{\}\)/);
  assert.match(sliceFn(vm, 'function openInvoicePrintWindow(', '\n}\n'), /printInvoiceSheetById\(\{[\s\S]*?autoPrint,[\s\S]*?\}\)/);
  assert.match(vm, /openInvoicePrintWindow\(state, inv, \(res\.items \|\| \[\]\)\.map\([\s\S]*?\}\)\), \{ autoPrint: false \}\);/, 'счёт, созданный в окне визита, — открывается сам');
  assert.match(vm, /onclick: \(\) => openInvoicePrintWindow\(state, inv, null\),/, '«Print receipt» — печать сразу');
  const desk = src('public/js/admin/views/cashier-desk.js');
  assert.match(sliceFn(desk, 'async function printFiscalCheck(', '\n}\n'), /printableSheet\(\{ type: 'fiscal', idLine: inv\.invoice_number \|\| String\(inv\.id\), autoPrint: false, data: \{/, 'чек после оплаты');
  assert.doesNotMatch(sliceFn(desk, 'async function printInvoiceSheet(', '\n}\n'), /autoPrint/, '«Печать счёта» — печать сразу');
  assert.match(sliceFn(desk, 'function payAfterBilling(', '\n}\n'), /printableSheet: viewOnlyPrint,/, 'акт после «Выставить счёт» плательщику');
  assert.match(desk, /const viewOnlyPrint = \(opts\) => printableSheet\(\{ \.\.\.opts, autoPrint: false \}\);/);
  const rp = src('public/js/admin/views/receipt-print.js');
  assert.match(sliceFn(rp, 'export function printSlip(', '\n}\n'), /printableSheet\(\{ type: 'slip', idLine: data\.docNo, data, autoPrint: false \}\)/);
});

// Каждый вызов printableSheet в экранах — на своём месте: печать сразу (нажата
// «Печать») или только показ (открылся сам, «Открыть», предпросмотр). Новый
// вызов без решения роняет эту проверку. view — сколько раз в файле стоит
// autoPrint: false (и у косвенных вызовов: printInvoiceSheetById, VIEW_ONLY).
const CALLERS = {
  'admission-modal.js':      { calls: 1, view: 0 },   // «Печать» документа истории болезни
  'case-file-tabs.js':       { calls: 2, view: 2 },   // «Открыть» результата и заключения
  'case-workspace.js':       { calls: 1, view: 0 },   // «Печать» реестра акта
  'cashier-desk.js':         { calls: 3, view: 2 },   // «Печать счёта» — печать; чек после оплаты — показ; viewOnlyPrint — акт после «Выставить счёт»
  'docs-archive.js':         { calls: 1, view: 1 },   // «Открыть»
  'documents.js':            { calls: 1, view: 1 },   // предпросмотр шаблона
  'fast-registration.js':    { calls: 1, view: 0 },   // «Печать»
  'laboratory.js':           { calls: 1, view: 0 },   // «Бланк», «Отчёт», галочка «Распечатать бланк результатов»
  'patient-card.js':         { calls: 3, view: 1 },   // вид окна — от вызывающего (...view): название — показ, «Печать» — печать
  'patient-documents.js':    { calls: 3, view: 0 },   // «Print» (анализы, заключение)
  'payer-act.js':            { calls: 1, view: 0 },   // вызывающий передаёт принтер (касса — показ)
  'receipt-print.js':        { calls: 3, view: 1 },   // чек — печать; счёт — autoPrint вызывающего; квитанция — показ
  'service-picker-modal.js': { calls: 2, view: 2 },   // счёт и акт мастера после сохранения
  'service-workspace.js':    { calls: 2, view: 0 },   // «Печать» кабинета; маршрутный лист (обёртка, печатает сама)
  'title-sheet.js':          { calls: 1, view: 0 },   // «Печать» бумаг при поступлении
  'visit-wizard.js':         { calls: 1, view: 2 },   // акт и счета мастера (printInvoiceSheetById) после сохранения
};
test('все вызовы printableSheet в экранах разобраны: печать сразу или только показ', () => {
  const dir = path.join(ROOT, 'public', 'js', 'admin', 'views');
  const found = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'doc-settings.js')) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');   // и хвостовые комментарии (у адресов «//» без пробела перед)
    const calls = (code.match(/\bprintableSheet\(\s*\{|\bprintableSheet\(actSheet\(/g) || []).length;
    if (!calls) continue;
    found[f] = { calls, view: (code.match(/autoPrint:\s*false/g) || []).length };
  }
  assert.deepEqual(found, CALLERS, 'новый или изменённый вызов printableSheet: нажата «Печать» — по умолчанию; открылся сам, «Открыть», предпросмотр — autoPrint: false; впишите его в CALLERS');
});
