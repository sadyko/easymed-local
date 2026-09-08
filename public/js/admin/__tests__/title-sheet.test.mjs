// TITLE_SHEET_V1 — титульный лист: печать, форма, окно размещения, редактор.
//
// Владелец: «when request of hospitalization is accepted and patient is
// admitting to the bed, nurse should collect the title list, with personal
// information and anthropometric data of the patient, and it goes as a title
// list when history is collected».
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в admissions-window.test.mjs) ─────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { }
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {},
    CLINIC: { name_ru: 'Клиника Тест', legal_name: 'ООО Тест', address: 'Ташкент, ул. Мира 1', phone: '+998 71 200 00 00', logo_url: '' },
    open: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const inputs = (root) => walk(root).filter((e) => e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT');
const byPlaceholder = (root, ph) => inputs(root).find((e) => (e.attrs.placeholder || '') === ph);
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ───────────────────────────────────────────────────────────────
const VIEW = {
    admission: { id: 11, admission_no: 'H-7', status: 'admitted', department: 'Терапия', admitted_at: '2026-09-08T09:00:00Z',
        admission_type: 'emergency', admission_diagnosis: 'J18.9', chief_complaint: 'кашель', ward_name: 'Терапия', bed_code: 'T-2' },
    patient: { id: 101, full_name: 'Иванов Иван Иванович', mrn: 'ID-1', date_of_birth: '1994-11-15', gender: 'male', phone: '+998901112233',
        address: 'Ташкент', national_id: 'AA1234567', occupation: 'учитель', emergency_contact_name: 'Иванова А.', emergency_contact_phone: '+998900000000',
        blood_type: 'O(I) Rh+', allergies: 'пенициллин' },
    sheet: { height_cm: 172, weight_kg: 80, temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full',
        referred_from: 'Поликлиника №3', note: '', filled_by_name: 'Медсестра Петрова', filled_at: '2026-09-08T09:20:00Z' },
    bmi: 27.0, complete: true, missing: [],
};
const rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });
    if (!u.startsWith('/api/rpc/')) return fail('unexpected ' + u);
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: body });
    if (name === 'admission_title_sheet_get') return ok(Object.assign({}, VIEW, { sheet: null, bmi: null, complete: false, missing: ['height_cm'] }));
    if (name === 'admission_admit') return ok({ admission: { id: body.admission_id, status: 'admitted' }, title_sheet: body.title_sheet ? { height_cm: 172 } : null });
    if (name === 'admission_title_sheet_save') return ok(Object.assign({}, VIEW, { complete: true }));
    return fail('unknown rpc ' + name);
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. ПЕЧАТЬ
// ═══════════════════════════════════════════════════════════════════════════
test('печать: шапка клиники, номер истории, три блока, подпись медсестры', async () => {
    const { titleSheetPrintSection, titleSheetPrintHtml } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(VIEW);
    for (const piece of ['Клиника Тест', 'ООО Тест', 'ул. Мира 1', 'История болезни № H-7', 'Титульный лист',
        'Иванов Иван Иванович', '15.11.1994', 'Мужской', 'AA1234567', 'O(I) Rh+', 'пенициллин',
        'Экстренная', 'J18.9', 'Поликлиника №3', 'T-2',
        '172', '80', '27', '36.6', '120/80', '72', 'не выявлено', 'полная',
        'Медсестра Петрова']) {
        assert.ok(s.includes(piece), 'в печати нет: ' + piece);
    }
    const html = titleSheetPrintHtml(VIEW, { fontFaceCss: '/*font*/' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('/*font*/'));
    assert.ok(html.includes('@page { size: A4'));
});

test('печать: незаполненный лист говорит об этом, а не рисует пустые клетки как факт', async () => {
    const { titleSheetPrintSection } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(Object.assign({}, VIEW, { sheet: null, bmi: null, complete: false, missing: ['height_cm'] }));
    assert.ok(s.includes('Титульный лист не заполнен'));
    assert.ok(!s.includes('Медсестра Петрова'));
    assert.ok(s.includes('Иванов Иван Иванович'), 'личные данные из карточки печатаются и без листа');
});

test('печать: значения экранируются', async () => {
    const { titleSheetPrintSection } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(Object.assign({}, VIEW, { patient: Object.assign({}, VIEW.patient, { address: '<b>x</b>' }) }));
    assert.ok(s.includes('&lt;b&gt;x&lt;/b&gt;'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ФОРМА
// ═══════════════════════════════════════════════════════════════════════════
test('форма: личные данные подставляются из карточки, ИМТ считается по мере ввода, чтение отдаёт лист и пациента', async () => {
    const { titleSheetForm } = await import('../views/title-sheet.js');
    const form = titleSheetForm({ bed: { id: 6, code: 'T-2', ward_name: 'Терапия' } });
    form.fill(Object.assign({}, VIEW, { sheet: null, bmi: null }));
    const root = mkEl('div');
    for (const f of form.fields) root.appendChild(f);
    assert.equal(form.inputs.phone.value, '+998901112233');
    assert.ok(textOf(root).includes('T-2'), 'палата · койка из выбранной койки');
    assert.ok(textOf(root).includes('Экстренная'));

    form.inputs.height.value = '172';
    form.inputs.height.dispatchEvent({ type: 'input' });
    form.inputs.weight.value = '72,5';
    form.inputs.weight.dispatchEvent({ type: 'input' });
    assert.equal(form.inputs.bmi.value, '24.5');

    const ped = walk(root).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'radio' && e.attrs.value === 'none');
    ped.dispatchEvent({ type: 'change' });
    const out = form.read();
    assert.equal(out.sheet.height_cm, '172');
    assert.equal(out.sheet.weight_kg, '72,5');
    assert.equal(out.sheet.pediculosis, 'none');
    assert.equal(out.sheet.sanitation, '');
    assert.equal(out.patient.phone, '+998901112233');
    assert.equal(out.patient.gender, 'male');
    assert.ok(!('full_name' in out.patient), 'ФИО лист не отправляет');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ОКНО РАЗМЕЩЕНИЯ
// ═══════════════════════════════════════════════════════════════════════════
test('окно размещения: «Положить» шлёт admission_admit с койкой и листом; «Назад» зовёт onBack', async () => {
    const { openAdmissionTitleSheetModal } = await import('../views/title-sheet.js');
    rpcCalls.length = 0;
    let done = 0; let back = 0;
    openAdmissionTitleSheetModal({
        admission: { id: 11, status: 'ordered', department: 'Терапия', patients: { full_name: 'Иванов Иван Иванович', mrn: 'ID-1' } },
        bed: { id: 6, code: 'T-2', ward_name: 'Терапия' },
        onDone: async () => { done += 1; }, onBack: () => { back += 1; },
    });
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Титульный лист'));
    assert.ok(textOf(overlay).includes('Иванов Иван Иванович'));
    const height = byPlaceholder(overlay, 'см');
    height.value = '172';
    findBtn(overlay, 'Положить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'admission_admit не вызван');
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.bed_id, 6);
    assert.equal(call.args.title_sheet.sheet.height_cm, '172');
    assert.equal(done, 1);

    rpcCalls.length = 0;
    openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: {} }, bed: { id: 6, code: 'T-2' }, onBack: () => { back += 1; } });
    await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Назад').click();
    await settle();
    assert.equal(back, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. РЕДАКТОР В ИСТОРИИ БОЛЕЗНИ
// ═══════════════════════════════════════════════════════════════════════════
test('редактор в истории болезни: «Сохранить» шлёт admission_title_sheet_save, есть «Печать»', async () => {
    const { buildTitleSheetEditor } = await import('../views/title-sheet.js');
    rpcCalls.length = 0;
    let done = 0;
    const ed = buildTitleSheetEditor({ admission: { id: 11 }, onDone: async () => { done += 1; } });
    await settle();
    assert.equal(ed.title, 'Титульный лист');
    assert.equal(ed.submitLabel, 'Сохранить');
    assert.equal(ed.secondaryLabel, 'Печать');
    const root = mkEl('div');
    for (const f of ed.fields) root.appendChild(f);
    assert.equal(byPlaceholder(root, 'см').value, '', 'листа ещё нет — поле пустое');
    byPlaceholder(root, 'см').value = '170';
    const ok = await ed.submit();
    assert.equal(ok, true);
    const call = rpcCalls.find((c) => c.name === 'admission_title_sheet_save');
    assert.ok(call);
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.sheet.height_cm, '170');
    assert.equal(done, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. СОБРАННАЯ ИСТОРИЯ
// ═══════════════════════════════════════════════════════════════════════════
test('собранная история начинается титульным листом, а список пробелов остаётся', async () => {
    const { caseFilePrintHtml } = await import('../views/case-docs.js');
    const html = caseFilePrintHtml({ cover: { admission_no: 'H-7', assembled_by: 'Врач', assembled_at: '2026-09-08T12:00:00Z' },
        documents: [], gaps: ['consent'], title_sheet: VIEW });
    assert.ok(html.indexOf('Титульный лист') < html.indexOf('В комплекте не хватает'), 'лист должен идти первым');
    assert.ok(html.includes('Клиника Тест'));
    assert.ok(html.includes('Медсестра Петрова'));
    assert.ok(html.includes('Согласие на госпитализацию'), 'пробелы комплекта пропали');
    // Старый снимок без листа печатается прежней обложкой — без падения.
    const old = caseFilePrintHtml({ cover: { admission_no: 'H-1' }, documents: [], gaps: [] });
    assert.ok(old.includes('H-1'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ДОКУМЕНТЫ ПРИ ПОСТУПЛЕНИИ (INPATIENT_DOCS_V1)
// ═══════════════════════════════════════════════════════════════════════════
test('документы при поступлении: три кнопки печати шлют род бумаги и данные пациента; галочки уходят с листом', async () => {
    const { titleSheetForm } = await import('../views/title-sheet.js');
    const printed = [];
    const form = titleSheetForm({ bed: { id: 6, code: 'T-2', ward_name: 'Терапия' }, onPrint: (type, data) => printed.push({ type, data }) });
    form.fill(Object.assign({}, VIEW, { sheet: null, bmi: null }));
    const root = mkEl('div');
    for (const f of form.fields) root.appendChild(f);
    assert.ok(textOf(root).includes('Документы при поступлении'));
    const prints = walk(root).filter((e) => e.tagName === 'BUTTON' && textOf(e).includes('Печать'));
    assert.equal(prints.length, 3, 'кнопок печати должно быть три');
    prints[0].click();
    assert.equal(printed[0].type, 'inpatient_contract');
    assert.equal(printed[0].data.patientName, 'Иванов Иван Иванович');
    assert.equal(printed[0].data.department, 'Терапия');
    assert.equal(printed[0].data.bed, 'T-2');
    assert.equal(printed[0].data.doctorName, '', 'лечащий врач ещё не назначен — на бумаге линия');
    prints[2].click();
    assert.equal(printed[1].type, 'inpatient_memo');

    const ticks = walk(root).filter((e) => e.tagName === 'INPUT' && e.attrs.type === 'checkbox');
    assert.equal(ticks.length, 3);
    ticks[0].checked = true;
    ticks[0].dispatchEvent({ type: 'change' });
    const out = form.read();
    assert.equal(out.sheet.contract_signed, true);
    assert.equal(out.sheet.consent_signed, false);
    assert.equal(out.sheet.memo_given, false);

    // Сохранённые отметки подставляются обратно — и только они.
    form.fill(Object.assign({}, VIEW, { sheet: Object.assign({}, VIEW.sheet, { memo_given_at: '2026-09-08T09:30:00Z' }) }));
    assert.equal(form.read().sheet.memo_given, true);
    assert.equal(form.read().sheet.contract_signed, false);
});

test('печать титульного листа и строка чек-листа называют, какие бумаги подписаны', async () => {
    const { titleSheetPrintSection, papersSummary } = await import('../views/title-sheet-print.js');
    const sheet = Object.assign({}, VIEW.sheet, { contract_signed_at: '2026-09-08T12:10:00Z', consent_signed_at: null, memo_given_at: '2026-09-08T12:11:00Z' });
    const s = titleSheetPrintSection(Object.assign({}, VIEW, { sheet }));
    assert.ok(s.includes('Документы при поступлении'));
    assert.ok(s.includes('Договор — подписан'));
    assert.ok(s.includes('Согласие — не подписано'));
    assert.ok(s.includes('Памятка — выдана'));
    assert.equal(papersSummary(sheet, { withDates: false }), 'Договор — подписан · Согласие — не подписано · Памятка — выдана');
});

test('дизайнер «Документы» знает три бумаги: варианты и тексты по умолчанию', async () => {
    const { DOC_VARIANTS, DEFAULT_DOC_SETTINGS } = await import('../views/doc-settings.js?v=noqr1');
    const { INPATIENT_DOC_DEFAULT_TEXT } = await import('../../shared/doc-render.js');
    for (const t of ['inpatient_contract', 'inpatient_consent', 'inpatient_memo']) {
        assert.ok(Array.isArray(DOC_VARIANTS[t]) && DOC_VARIANTS[t].length === 1, 'нет варианта для ' + t);
    }
    assert.equal(DEFAULT_DOC_SETTINGS.inpatientMemoText, INPATIENT_DOC_DEFAULT_TEXT.inpatientMemoText);
    assert.equal(DEFAULT_DOC_SETTINGS.inpatientContractText, INPATIENT_DOC_DEFAULT_TEXT.inpatientContractText);
});
