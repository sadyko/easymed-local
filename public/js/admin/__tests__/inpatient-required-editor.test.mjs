// INPATIENT_REQUIRED_V1 — редактор документов истории болезни: обязательные разделы
// открыты и отмечены, «Опубликовать» с пустым разделом спрашивает «Сохранить как есть»
// (черновик — никогда), диагноз первичного осмотра и подсказка эпикриза следуют
// переключателям клиники.
//
// Владелец: «in the required fields of the title and other user cannot understand
// which fields he is not filled, cn we add visual cues for that?»
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (как в required-marks.test.mjs: родитель, фокус, слушатели документа) ──
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.parentNode = null;
    }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
    // INPATIENT_REQUIRED_V1 (ревью) — как настоящий DOM: узел переезжает, а не копируется.
    insertBefore(n, ref) {
        if (n.parentNode) n.parentNode.removeChild(n);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
        n.parentNode = this; return n;
    }
    replaceChild(n, old) {
        if (n.parentNode) n.parentNode.removeChild(n);
        const i = this.children.indexOf(old);
        if (i < 0) throw new Error('NotFoundError: заменяемого узла нет среди детей');
        this.children[i] = n; n.parentNode = this; old.parentNode = null; return old;
    }
    insertAdjacentElement(where, n) {
        const p = this.parentNode;
        if (where !== 'afterend' || !p) return null;
        p.children.splice(p.children.indexOf(this) + 1, 0, n); n.parentNode = p; return n;
    }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); }
    dispatchEvent(e) { for (const fn of (this._l[e.type] || []).slice()) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    focus() { globalThis.document.activeElement = this; }
    blur() {}
    scrollIntoView() {}
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
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'), activeElement: null,
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
    execCommand: () => false,
};
// Настройки документов (бланк клиники) тест подставляет сам.
const LS = {};
globalThis.localStorage = { getItem: (k) => (k in LS ? LS[k] : (k === 'admin.lang' ? 'ru' : null)), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {},
    CLINIC: { name_ru: 'Клиника Тест' }, open: () => null,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
const hasCls = (el, c) => String((el && el.className) || '').split(/\s+/).includes(c);
const topEl = () => BODY.children[BODY.children.length - 1];
// Убрать окна со страницы так, как это делает браузер: узел теряет родителя (по нему окно
// документа знает, что прежнее закрыто).
const resetBody = () => { for (const c of BODY.children.splice(0)) c.parentNode = null; };

// ─── «сервер» ───────────────────────────────────────────────────────────────
let SETTINGS = null;
// INPATIENT_REQUIRED_V1 (ревью) — обещание, которого ждёт ответ настроек: так тест держит
// inpatient_settings_get «в пути» (медленный или зависший сервер).
let SETTINGS_GATE = null;
let REVIEWS = [];
const rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });
    if (!u.startsWith('/api/rpc/')) return ok([]);
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: body });
    if (name === 'inpatient_settings_get') {
        if (SETTINGS_GATE) await SETTINGS_GATE;
        return SETTINGS ? ok(SETTINGS) : fail('нет');
    }
    if (name === 'admission_reviews_list') return ok({ reviews: REVIEWS });
    if (name === 'admission_review_save') return ok({ review: { id: 9 }, admission: { id: 7, status: 'admitted' } });
    return ok({});
};

const { buildReviewEditor, openAdmissionReviewModal } = await import('../views/admission-modal.js');
const { rulesFromSettings } = await import('../../shared/inpatient-required.js');
const ADM = { id: 7, patients: { full_name: 'Тестов Пациент' } };
const rules = (settings, docs = []) => rulesFromSettings({ settings, docs });
const secOf = (ed, key) => walk({ children: ed.fields.filter(Boolean) }).find((e) => e.attrs && e.attrs['data-sec'] === key);
const inputOf = (ed, key) => walk({ children: ed.fields.filter(Boolean) }).find((e) => e.attrs && e.attrs['data-field'] === key);
const INTAKE_COMPLAINTS = () => rules({}, [{ kind: 'intake', required_sections: ['complaints'] }]);

test('обязательный раздел открыт, отмечен, не убирается; строка сверху его называет', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: INTAKE_COMPLAINTS() });
    await settle();
    const sec = secOf(ed, 'complaints');
    assert.ok(!sec.className.split(' ').includes('a4-sec-off'), 'обязательный раздел свёрнут');
    assert.ok(sec.className.split(' ').includes('rq-empty'));
    assert.ok(!walk(sec).some((e) => e.tagName === 'BUTTON' && (e.attrs['aria-label'] || '') === 'Убрать раздел'), 'обязательный раздел можно убрать');
    // Необязательный раздел убирается, как прежде.
    const obj = secOf(ed, 'objective');
    assert.ok(walk(obj).some((e) => e.tagName === 'BUTTON' && (e.attrs['aria-label'] || '') === 'Убрать раздел'));
    assert.ok(!hasCls(obj, 'rq-empty'), 'необязательный раздел отмечен');
    // Подпись раздела — со звездой (класс) и скрытым «обязательно».
    const tag = walk(sec).find((e) => hasCls(e, 'a4-sec-tag'));
    assert.ok(hasCls(tag, 'rq-req') && textOf(tag).includes('обязательно'));
    assert.ok(textOf(ed.topNote).includes('Жалобы'));
    // Отметки живые: печатают в разделе — событие input — отметка ушла.
    const inp = inputOf(ed, 'complaints');
    inp.innerHTML = '<p>кашель</p>'; inp.dispatchEvent({ type: 'input' });
    assert.ok(!sec.className.split(' ').includes('rq-empty'));
    assert.equal(ed.topNote.hidden, true);
    // Стёрли (в разделе остались пустой абзац и невидимый пробел) — снова пусто: то же правило, что у сервера.
    inp.innerHTML = '<p>​<br></p>'; inp.dispatchEvent({ type: 'input' });
    assert.ok(sec.className.split(' ').includes('rq-empty'), 'пустой абзац счёлся текстом');
    // «Не заполнено» — рядом с полем, не внутри: в текст документа (и в печать) оно не попадает.
    assert.ok(!walk(inp).some((e) => hasCls(e, 'rq-msg')), 'отметка попала в текст раздела');
});

test('«Опубликовать» с пустым обязательным разделом спрашивает; «Дописать» — не публикует; «Сохранить как есть» — публикует; черновик не спрашивает', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: INTAKE_COMPLAINTS() });
    await settle();
    rpcCalls.length = 0;
    let p = ed.submit(); await settle();
    const dlg = topEl();
    assert.ok(textOf(dlg).includes('Заполнено не всё') && textOf(dlg).includes('Жалобы'));
    findBtn(dlg, 'Дописать').click();
    assert.equal(await p, false);
    assert.ok(!rpcCalls.some((c) => c.name === 'admission_review_save'));
    assert.equal(document.activeElement, inputOf(ed, 'complaints'), '«Дописать» не поставил курсор в пустой раздел');
    p = ed.submit(); await settle();
    findBtn(topEl(), 'Сохранить как есть').click();
    assert.equal(await p, true);
    assert.equal(rpcCalls.find((c) => c.name === 'admission_review_save').args.publish, true);
    rpcCalls.length = 0;
    const before = BODY.children.length;
    await ed.secondary(); await settle();
    assert.equal(BODY.children.filter((c) => c.attrs && c.attrs['data-dialog'] === 'required-missing').length, 0, 'черновик открыл окно');
    assert.ok(BODY.children.length <= before + 1, 'черновик открыл окно');
    assert.equal(rpcCalls.find((c) => c.name === 'admission_review_save').args.publish, false);
});

test('первичный осмотр: диагноз обязателен (умолчание) — жёсткий запрет; переключатель выключен — публикуется без диагноза', async () => {
    let ed = buildReviewEditor({ admission: ADM, kind: 'primary', rules: rules({}) });
    await settle();
    assert.equal(ed.diagnosisRequired, true);
    assert.ok(textOf(ed.topNote).includes('Диагноз'));
    const p = ed.submit(); await settle();
    const dlg = topEl();
    assert.ok(textOf(dlg).includes('Диагноз'));
    assert.ok(textOf(dlg).includes('так настроено в клинике'));
    assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined);
    findBtn(dlg, 'Дописать').click();
    assert.equal(await p, false);
    ed = buildReviewEditor({ admission: ADM, kind: 'primary', rules: rules({ primary_needs_diagnosis: 0 }) });
    await settle();
    assert.equal(ed.diagnosisRequired, false);
    assert.equal(ed.topNote.hidden, true, 'без требований строки «Не заполнено» нет');
    rpcCalls.length = 0;
    assert.equal(await ed.submit(), true);
    assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save'));
});

test('первичный осмотр: жёсткое окно называет только диагноз, а мягкие разделы спрашиваются потом', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'primary', rules: rules({}, [{ kind: 'primary', required_sections: ['objective'] }]) });
    await settle();
    assert.ok(textOf(ed.topNote).includes('Объективно') && textOf(ed.topNote).includes('Диагноз'));
    let p = ed.submit(); await settle();
    const hard = topEl();
    assert.ok(!textOf(hard).includes('Объективно'), 'жёсткое окно называет мягкий раздел');
    findBtn(hard, 'Дописать').click();
    assert.equal(await p, false);
    // Диагноз вписан — дальше обычный вопрос про пустой раздел.
    ed.diagnosisInput.value = 'J18.9'; ed.diagnosisInput.dispatchEvent({ type: 'input' });
    assert.ok(!textOf(ed.topNote).includes('Диагноз'), 'диагноз вписан, а строка его называет');
    rpcCalls.length = 0;
    p = ed.submit(); await settle();
    const soft = topEl();
    assert.ok(textOf(soft).includes('Объективно'));
    findBtn(soft, 'Сохранить как есть').click();
    assert.equal(await p, true);
    assert.equal(rpcCalls.find((c) => c.name === 'admission_review_save').args.diagnosis, 'J18.9');
});

test('выписной эпикриз: подсказка «только по опубликованному» — только когда переключатель включён', async () => {
    const on = buildReviewEditor({ admission: ADM, kind: 'discharge', rules: rules({}) });
    const off = buildReviewEditor({ admission: ADM, kind: 'discharge', rules: rules({ discharge_needs_epicrisis: 0 }) });
    const txt = (ed) => ed.fields.filter(Boolean).map(textOf).join(' ');
    assert.ok(txt(on).includes('ОПУБЛИКОВАННОМУ'));
    assert.ok(!txt(off).includes('ОПУБЛИКОВАННОМУ'));
    await settle();
});

test('умолчания: у документа без обязательных разделов ни отметок, ни вопроса — как сегодня', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake' });
    await settle();
    assert.equal(ed.topNote.hidden, true);
    assert.ok(!walk({ children: ed.fields.filter(Boolean) }).some((e) => hasCls(e, 'rq-req') || hasCls(e, 'rq-empty')));
    rpcCalls.length = 0;
    assert.equal(await ed.submit(), true);
    assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save'));
});

test('сохранённая раскладка не сворачивает обязательный раздел; переименованный раздел назван своим именем', async () => {
    REVIEWS = [{
        id: 5, kind: 'intake', published_at: null, complaints: '', objective: '<p>живот мягкий</p>', diagnosis: '', plan: '', body: '',
        sections_json: JSON.stringify({ secs: ['objective'], titles: { complaints: 'Жалобы при поступлении' } }),
    }];
    try {
        const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: INTAKE_COMPLAINTS() });
        await settle();
        const sec = secOf(ed, 'complaints');
        assert.ok(!hasCls(sec, 'a4-sec-off'), 'черновик со своей раскладкой свернул обязательный раздел');
        assert.ok(hasCls(sec, 'rq-empty'));
        assert.ok(textOf(ed.topNote).includes('Жалобы при поступлении'), textOf(ed.topNote));
    } finally { REVIEWS = []; }
});

test('бланк клиники заполнил обязательный раздел — отметки нет', async () => {
    LS['easymed:doc-settings:v1'] = JSON.stringify({ caseDocBlanks: { intake: { complaints: '<p>Жалоб нет</p>' } } });
    try {
        const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: INTAKE_COMPLAINTS() });
        await settle();
        assert.ok(!hasCls(secOf(ed, 'complaints'), 'rq-empty'), 'раздел с бланком отмечен пустым');
        assert.equal(ed.topNote.hidden, true);
    } finally { delete LS['easymed:doc-settings:v1']; }
});

test('чтение редакции: отметок нет, раздел убирать и так нечем', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'primary', mode: 'view', rules: rules({}, [{ kind: 'primary', required_sections: ['complaints'] }]) });
    await settle();
    assert.equal(ed.topNote.hidden, true);
    assert.equal(ed.diagnosisRequired, false);
    assert.ok(!walk({ children: ed.fields.filter(Boolean) }).some((e) => hasCls(e, 'rq-req') || hasCls(e, 'rq-empty')));
});

test('окно документа: строка «Не заполнено» первой, диагноз в рамке со звездой, «Дописать» ставит курсор в поле диагноза', async () => {
    resetBody();
    await openAdmissionReviewModal({ admission: ADM, kind: 'primary', rules: rules({}) });
    await settle();
    const modal = BODY.children.find((c) => c.className === 'modal');
    const body = walk(modal).find((e) => hasCls(e, 'modal-body'));
    assert.ok(body.children[0].attrs && 'data-rq-summary' in body.children[0].attrs, 'строка «Не заполнено» не первая в окне');
    const dxBox = walk(modal).find((e) => hasCls(e, 'dx-ed'));
    assert.ok(hasCls(dxBox, 'rq-empty'), 'пустой диагноз не в рамке');
    const dxLabel = walk(modal).find((e) => e.tagName === 'LABEL' && textOf(e).includes('Диагноз'));
    assert.ok(hasCls(dxLabel, 'rq-req'), 'у диагноза нет звезды');
    assert.ok(!walk(dxLabel).some((e) => hasCls(e, 'req')), 'две звезды у диагноза');
    findBtn(modal, 'Опубликовать осмотр').click();
    await settle();
    const dlg = topEl();
    assert.equal(dlg.attrs['data-dialog'], 'required-missing');
    findBtn(dlg, 'Дописать').click();
    await settle();
    assert.ok(hasCls(document.activeElement, 'dx-type-in'), '«Дописать» не поставил курсор в поле диагноза');
    assert.ok(BODY.children.includes(modal), 'окно документа закрылось вместе с вопросом');
});

test('окно документа читает правила клиники само: переключатель выключен — без звезды и без вопроса', async () => {
    resetBody();
    SETTINGS = { settings: { primary_needs_diagnosis: 0 }, docs: [] };
    try {
        await openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        await settle();
        const modal = BODY.children.find((c) => c.className === 'modal');
        const dxLabel = walk(modal).find((e) => e.tagName === 'LABEL' && textOf(e).includes('Диагноз'));
        assert.ok(!hasCls(dxLabel, 'rq-req') && !walk(dxLabel).some((e) => hasCls(e, 'req')), 'звезда у необязательного диагноза');
        rpcCalls.length = 0;
        findBtn(modal, 'Опубликовать осмотр').click();
        await settle();
        assert.ok(!BODY.children.some((c) => c.attrs && c.attrs['data-dialog'] === 'required-missing'), 'вопрос при выключенном переключателе');
        assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save' && c.args.publish === true));
    } finally { SETTINGS = null; }
});

// ─── INPATIENT_REQUIRED_V1 (ревью) ──────────────────────────────────────────
const modalsIn = () => BODY.children.filter((c) => c.className === 'modal');
const gate = () => { let release = null; SETTINGS_GATE = new Promise((r) => { release = r; }); return () => { SETTINGS_GATE = null; release(); }; };
// В памяти экрана — сегодняшние правила: прежнее окно прочитало «настроек нет».
async function primeDefaultRules() {
    resetBody();
    SETTINGS = null;
    await openAdmissionReviewModal({ admission: { id: 70, patients: {} }, kind: 'intake' });
    await settle();
    resetBody();
}

test('окно документа открывается сразу, не дожидаясь настроек клиники; двойное нажатие — одно окно', async () => {
    await primeDefaultRules();
    const release = gate();
    try {
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });   // второй щелчок по той же кнопке
        await settle();
        assert.equal(modalsIn().length, 1, 'настройки «в пути» — окно не открылось (или открылось дважды)');
        release();
        await settle();
        assert.equal(modalsIn().length, 1, 'пришли настройки — открылось второе окно на тот же черновик');
        // Закрыли — то же окно открывается снова; другой документ той же госпитализации — тоже.
        findBtn(modalsIn()[0], 'Закрыть').click();
        assert.equal(modalsIn().length, 0);
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        openAdmissionReviewModal({ admission: ADM, kind: 'daily' });
        await settle();
        assert.equal(modalsIn().length, 2);
    } finally { if (SETTINGS_GATE) release(); resetBody(); }
});

test('окно документа: настройки пришли позже — отметки и обязательные разделы поправляются; «Опубликовать» ждёт настроек', async () => {
    await primeDefaultRules();
    const release = gate();
    SETTINGS = { settings: { primary_needs_diagnosis: 0 }, docs: [{ kind: 'primary', required_sections: ['objective'] }] };
    try {
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        await settle();
        const modal = modalsIn()[0];
        const dxLabel = walk(modal).find((e) => e.tagName === 'LABEL' && textOf(e).includes('Диагноз'));
        assert.ok(hasCls(dxLabel, 'rq-req'), 'пока настроек нет — сегодняшние правила: диагноз обязателен');
        const obj = walk(modal).find((e) => e.attrs && e.attrs['data-sec'] === 'objective');
        assert.ok(hasCls(obj, 'a4-sec-off'));
        rpcCalls.length = 0;
        findBtn(modal, 'Опубликовать осмотр').click();
        await settle();
        assert.ok(!BODY.children.some((c) => c.attrs && c.attrs['data-dialog'] === 'required-missing'),
            'публикация не дождалась правил клиники и спросила по умолчаниям');
        assert.ok(!rpcCalls.some((c) => c.name === 'admission_review_save'), 'публикация ушла до правил клиники');
        release();
        await settle();
        // Правила пришли: диагноз не обязателен, «Объективно» открыт, отмечен, без крестика.
        assert.ok(!hasCls(dxLabel, 'rq-req'), 'звезда диагноза осталась при выключенном переключателе');
        assert.ok(!textOf(walk(modal).find((e) => hasCls(e, 'dx-ed'))).includes('обязателен'), 'карточка диагноза всё ещё называет его обязательным');
        assert.ok(!hasCls(obj, 'a4-sec-off') && hasCls(obj, 'rq-empty'), 'обязательный по правилам клиники раздел не открыт и не отмечен');
        assert.ok(!walk(obj).some((e) => e.tagName === 'BUTTON' && (e.attrs['aria-label'] || '') === 'Убрать раздел'), 'обязательный раздел можно убрать');
        // Нажатая до ответа публикация спрашивает уже по правилам клиники — мягко и про раздел.
        const dlg = topEl();
        assert.equal(dlg.attrs['data-dialog'], 'required-missing');
        assert.ok(textOf(dlg).includes('Объективно') && !textOf(dlg).includes('Диагноз'), textOf(dlg));
        findBtn(dlg, 'Сохранить как есть').click();
        await settle();
        assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save' && c.args.publish === true));
        // Следующее окно сразу рисуется последними прочитанными правилами — без звезды диагноза.
        resetBody();
        const release2 = gate();
        try {
            openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
            await settle();
            const label2 = walk(modalsIn()[0]).find((e) => e.tagName === 'LABEL' && textOf(e).includes('Диагноз'));
            assert.ok(!hasCls(label2, 'rq-req'), 'новое окно забыло прочитанные правила клиники');
        } finally { release2(); }
    } finally { if (SETTINGS_GATE) release(); SETTINGS = null; resetBody(); }
});

test('давняя ошибка: сохранённое имя раздела ложится на подпись, а не на «+ Добавить»; «обязательно» на месте', async () => {
    REVIEWS = [{
        id: 5, kind: 'intake', published_at: null, complaints: '', objective: '', diagnosis: '', plan: '', body: '',
        sections_json: JSON.stringify({ secs: ['complaints'], titles: { complaints: 'Жалобы при поступлении', objective: 'Статус' } }),
    }];
    try {
        const ed = buildReviewEditor({ admission: ADM, kind: 'intake', reviewId: 5, rules: INTAKE_COMPLAINTS() });
        await settle();
        const sec = secOf(ed, 'complaints');
        const tag = walk(sec).find((e) => hasCls(e, 'a4-sec-tag'));
        const add = walk(sec).find((e) => hasCls(e, 'a4-sec-add') && e.tagName === 'BUTTON');
        assert.ok(textOf(tag).includes('Жалобы при поступлении'), 'подпись раздела не назвала сохранённое имя: ' + textOf(tag));
        assert.ok(textOf(tag).includes('обязательно'), 'переименование подписи стёрло скрытое «обязательно»');
        assert.ok(hasCls(tag, 'rq-req'));
        assert.ok(textOf(add).includes('+ Добавить'), 'сохранённое имя затёрло кнопку «+ Добавить»: ' + textOf(add));
        // Необязательный раздел тоже назван своим именем и в свёрнутой строке.
        const objAdd = walk(secOf(ed, 'objective')).find((e) => hasCls(e, 'a4-sec-add') && e.tagName === 'BUTTON');
        assert.ok(textOf(objAdd).includes('+ Добавить') && textOf(objAdd).includes('Статус'), textOf(objAdd));
    } finally { REVIEWS = []; }
});

test('раздел, разложенный по двум листам A4: пусто ли — по всему разделу; печать в продолжении пересчитывает отметки', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: INTAKE_COMPLAINTS() });
    await settle();
    // Рабочий экран: стопка листов, первый лист несёт документ, второй — хвост «Жалоб»
    // (a4-sheets.js: [data-a4-cont] того же ключа, тоже contenteditable).
    const stack = mkEl('div');
    const sheet = (cls) => { const p = mkEl('div'); p.className = cls; const flow = mkEl('div'); flow.className = 'a4-flow'; p.appendChild(flow); stack.appendChild(p); return flow; };
    const flow1 = sheet('a4-paper');
    for (const f of ed.fields.filter(Boolean)) flow1.appendChild(f);
    const flow2 = sheet('a4-paper a4-paper-next');
    const wrap = mkEl('div'); wrap.className = 'a4-cont-wrap';
    const cont = mkEl('div'); cont.className = 'a4-input'; cont.setAttribute('data-a4-cont', 'complaints'); cont.setAttribute('contenteditable', 'true');
    wrap.appendChild(cont); flow2.appendChild(wrap);
    const sec = secOf(ed, 'complaints');
    const inp = inputOf(ed, 'complaints');
    // Первый лист пуст, текст — на втором: раздел не пуст.
    cont.innerHTML = '<p>кашель</p>';
    inp.innerHTML = ''; inp.dispatchEvent({ type: 'input' });
    assert.ok(!hasCls(sec, 'rq-empty'), 'раздел с текстом на втором листе отмечен пустым');
    assert.equal(ed.topNote.hidden, true);
    // Стёрли текст в продолжении — событие input всплывает к стопке листов — отметка вернулась.
    cont.innerHTML = '<p><br></p>';
    stack.dispatchEvent({ type: 'input', target: cont });
    assert.ok(hasCls(sec, 'rq-empty'), 'правка в продолжении не пересчитала отметки');
    cont.innerHTML = '<p>одышка</p>';
    stack.dispatchEvent({ type: 'input', target: cont });
    assert.ok(!hasCls(sec, 'rq-empty'));
    // «Опубликовать» с текстом только во втором окне раздела не спрашивает.
    rpcCalls.length = 0;
    assert.equal(await ed.submit(), true);
    assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save'));
});

// ─── INPATIENT_REQUIRED_V1 (ревью): окно закрыли, пока сохранение ждало правил клиники ──
// «Положить», «Сохранить» и «Опубликовать» ждут inpatient_settings_get до 10 с. Человек за
// это время закрыл окно или ушёл к другому документу — сохранение не уходит за его спиной.
// Окно, которое осталось открытым, сохраняет как раньше.
test('(ревью) окно документа закрыли, пока «Опубликовать» ждал правил, — ничего не публикуется; открытое — публикует', async () => {
    await primeDefaultRules();
    SETTINGS = { settings: { primary_needs_diagnosis: 0 }, docs: [] };
    let release = gate();
    try {
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        await settle();
        const win = modalsIn()[0];
        rpcCalls.length = 0;
        findBtn(win, 'Опубликовать осмотр').click();
        await settle();
        findBtn(win, 'Закрыть').click();
        assert.equal(modalsIn().length, 0);
        release();
        await settle();
        assert.ok(!rpcCalls.some((c) => c.name === 'admission_review_save'), 'закрытое окно опубликовало осмотр');
        assert.ok(!BODY.children.some((c) => c.attrs && c.attrs['data-dialog'] === 'required-missing'), 'закрытое окно спросило «Заполнено не всё»');
        // То же, но окно не закрывали — публикует, как раньше.
        release = gate();
        openAdmissionReviewModal({ admission: ADM, kind: 'primary' });
        await settle();
        rpcCalls.length = 0;
        findBtn(modalsIn()[0], 'Опубликовать осмотр').click();
        await settle();
        release();
        await settle();
        assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save' && c.args.publish === true));
    } finally { if (SETTINGS_GATE) release(); SETTINGS = null; resetBody(); }
});

test('(ревью) окно размещения закрыли, пока «Положить» ждал правил, — пациента не кладут; открытое — кладёт', async () => {
    const { openAdmissionTitleSheetModal } = await import('../views/title-sheet.js');
    resetBody();
    SETTINGS = { settings: { admitting_at_placement: 0, title_required: 0 }, docs: [] };
    let release = gate();
    try {
        let done = 0;
        openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: {} }, bed: { id: 6, code: 'T-2' }, onDone: async () => { done += 1; } });
        await settle();
        const win = modalsIn()[0];
        rpcCalls.length = 0;
        findBtn(win, 'Положить').click();
        await settle();
        findBtn(win, 'Закрыть').click();
        assert.equal(modalsIn().length, 0);
        release();
        await settle();
        assert.ok(!rpcCalls.some((c) => c.name === 'admission_admit'), 'закрытое окно положило пациента');
        assert.equal(done, 0);
        release = gate();
        openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: {} }, bed: { id: 6, code: 'T-2' }, onDone: async () => { done += 1; } });
        await settle();
        rpcCalls.length = 0;
        findBtn(modalsIn()[0], 'Положить').click();
        await settle();
        release();
        await settle();
        assert.ok(rpcCalls.some((c) => c.name === 'admission_admit'), 'открытое окно не положило пациента');
    } finally { if (SETTINGS_GATE) release(); SETTINGS = null; resetBody(); }
});

test('(ревью) рабочий экран: лист и документ убрали со страницы, пока «Сохранить» / «Опубликовать» ждали правил, — ничего не сохраняется', async () => {
    const { buildTitleSheetEditor } = await import('../views/title-sheet.js');
    resetBody();
    const mount = (ed) => {
        const host = mkEl('div');
        BODY.appendChild(host);
        host.appendChild(ed.topNote);
        for (const f of ed.fields.filter(Boolean)) host.appendChild(f);
        return host;
    };
    const cases = [
        { build: (rules) => buildTitleSheetEditor({ admission: { id: 11 }, rules }), rpc: 'admission_title_sheet_save' },
        { build: (rules) => buildReviewEditor({ admission: ADM, kind: 'intake', rules }), rpc: 'admission_review_save' },
    ];
    try {
        for (const c of cases) {
            for (const leave of [true, false]) {
                let resolve = null;
                const later = new Promise((r) => { resolve = r; });
                const ed = c.build(later);
                const host = mount(ed);
                await settle();
                rpcCalls.length = 0;
                const p = ed.submit();
                await settle();
                if (leave) host.remove();   // ушли к другому документу: панель очищена
                resolve(rules({ title_required: 0 }));
                const ok = await p;
                await settle();
                if (leave) {
                    assert.equal(ok, false, c.rpc);
                    assert.ok(!rpcCalls.some((x) => x.name === c.rpc), 'убранный редактор сохранил: ' + c.rpc);
                    assert.ok(!BODY.children.some((x) => x.attrs && x.attrs['data-dialog'] === 'required-missing'), 'убранный редактор спросил');
                } else {
                    assert.equal(ok, true, c.rpc);
                    assert.ok(rpcCalls.some((x) => x.name === c.rpc), 'редактор на странице не сохранил: ' + c.rpc);
                }
                resetBody();
            }
        }
    } finally { resetBody(); }
});
