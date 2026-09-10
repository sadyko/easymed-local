// CASE_OVERVIEW_V1 — обзор госпитализации: шапка, стрелки, главное действие, блоки, выписка со счётом.
//
// Владелец: «list of the patients → pressed opens a patients dashboard and
// main action → opens the documents to fill for the doctor. but in the
// dashboard we can see status of the patient, services prescription, and
// discharge button with generating the payments».
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в title-sheet.test.mjs) ───────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
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
    remove() { if (this._parent) this._parent.removeChild(this); }
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {}, open: () => null };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const allBtns = (root, label) => walk(root).filter((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const lastToast = () => { const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop(); return t ? t.textContent : ''; };
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ───────────────────────────────────────────────────────────────
const OV = {
    now: '2026-09-08T12:00:00Z',
    admission: { id: 11, admission_no: 'H-7', status: 'active', department: 'Хирургия', admitted_at: '2026-09-06T09:00:00Z', admission_type: 'planned',
        ward_name: 'Хирургия', bed_code: 'X-2', attending_name: 'Юсупов А.', attending_doctor_id: 5, planned_discharge_at: null, discharged_at: null, days: 3 },
    patient: { id: 101, full_name: 'Иванов Иван Иванович', mrn: 'ID-1', date_of_birth: '1994-11-15', gender: 'male', allergies: 'пенициллин', blood_type: 'O(I) Rh+' },
    title_sheet: { complete: true, bmi: 27, sheet: { temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, height_cm: 172, weight_kg: 80 } },
    diagnosis: { referral: 'K35.8', clinical: 'Острый аппендицит', clinical_at: '2026-09-06T10:00:00Z', outcome: null },
    diet: { current: { diet_code: '1', name: 'Стол №1 (щадящий)', since: '2026-09-06T11:00:00Z' }, meals_today: { eaten: 2, refused: 1 } },
    orders: { active: 2, by_kind: { med: 2 }, today: { due: 4, given: 2, refused: 0, missed: 1, held: 0 }, list: [{ id: 1, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/м', freq_code: '2x', prn: false }] },
    services: { count: 2, billed: 0, unbilled: 2, sum_total: 950000, sum_unbilled: 950000, list: [
        { id: 1, kind: 'service', name: 'Аппендэктомия', quantity: 1, total: 900000, invoiced: false },
        // CASE_ROWS_TIDY_V1 — проживание едет родом, а не текстом технической пометки
        { id: 2, kind: 'accommodation', name: '', quantity: 16, unit_price: 250000, total: 4000000, invoiced: false },
    ] },
    operation: { state: 'planned', at: null, has_surgery_service: true, docs: ['preop'] },
    bill: { accommodation: { stay_units: 3, invoiced: { units: 0, total: 0 }, current: { units: 3, rate: 100000, gross: 300000, net: 300000, mode: 'daily' } }, invoices: [], total: 0, paid: 0, debt: 0 },
    docs: { progress: { done: 3, total: 9, overdue: 1, draft: 1 }, next_kind: 'rationale', overdue: 1, incomplete: ['title', 'rationale'] },
    discharge: { status: 'active', requested_at: null, planned_at: null, outcome: null, discharged_at: null },
    neighbours: { index: 1, total: 3, mine: false, prev: { id: 10, full_name: 'Алиев А.' }, next: { id: 12, full_name: 'Каримов К.' } },
    // VITALS_NEWS_V1 — ряд по возрастанию; news считает сервер той же шкалой (shared/news2.js).
    vitals: (() => {
        const mk = (o) => Object.assign({ id: null, source: 'vital', consciousness: 'alert', on_oxygen: 0, measured_by_name: 'Медсестра Петрова' }, o);
        const s0 = mk({ source: 'title', measured_at: '2026-09-06T09:00:00Z', temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, resp_rate: null, spo2: null, consciousness: null, measured_by_name: '' });
        const s1 = mk({ id: 1, measured_at: '2026-09-07T08:00:00Z', temp_c: 37.4, bp_sys: 128, bp_dia: 82, pulse_bpm: 92, resp_rate: 18, spo2: 96 });
        const s2 = mk({ id: 2, measured_at: '2026-06-08T08:00:00Z', temp_c: 38.1, bp_sys: 138, bp_dia: 88, pulse_bpm: 104, resp_rate: 21, spo2: 94 });
        const score = (r) => ({ total: r === s2 ? 5 : r === s1 ? 1 : 0, band: r === s2 ? 'medium' : r === s1 ? 'low' : 'none', complete: r !== s0, red: false, measured: r === s0 ? 3 : 6,
            parts: r === s2 ? { resp_rate: 2, spo2: 1, on_oxygen: 0, bp_sys: 0, pulse_bpm: 1, consciousness: 0, temp_c: 1 }
                 : r === s1 ? { resp_rate: 0, spo2: 0, on_oxygen: 0, bp_sys: 0, pulse_bpm: 1, consciousness: 0, temp_c: 0 }
                 : { resp_rate: null, spo2: null, on_oxygen: 0, bp_sys: 0, pulse_bpm: 0, consciousness: null, temp_c: 0 } });
        const series = [s0, s1, s2].map((r) => Object.assign({}, r, { news: score(r) }));
        return { count: 2, series, last: series[2], prev: series[1], news: series[2].news, trend: 5, can_add: true };
    })(),
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
    if (name === 'admission_overview') return ok(OV);
    if (name === 'admission_vitals_add') return ok({ vital: { id: 3, news: { total: 1, band: 'low', complete: false, parts: {} } }, summary: OV.vitals });
    if (name === 'admission_vitals_list') return ok({ rows: OV.vitals.series.filter((r) => r.source !== 'title').slice().reverse() });
    if (name === 'admission_discharge_request') return ok({ admission: { id: 11, status: 'discharging' }, bill: { invoice_number: 'INV-7', total_amount: 1250000, items: 3 } });
    return ok({});
};

async function render(onNavigate) {
    const { renderCaseOverview } = await import('../views/case-overview.js');
    const container = mkEl('div');
    BODY.appendChild(container);
    await renderCaseOverview(container, { payload: { admissionId: 11 }, onNavigate });
    await settle();
    return container;
}

test('шапка: пациент, день, койка, лечащий врач, аллергия; стрелки ведут к соседям; пациент и вкладка — в документы', async () => {
    const navs = [];
    const root = await render((view, payload) => navs.push({ view, payload }));
    const t = textOf(root);
    for (const piece of ['Иванов Иван Иванович', '3-й день', 'Хирургия', 'X-2', 'Юсупов А.', 'H-7', 'Аллергия: пенициллин', '2 из 3', 'Мужской', 'ID-1']) {
        assert.ok(t.includes(piece), 'в шапке нет: ' + piece);
    }
    const arrows = walk(root).filter((e) => e.tagName === 'BUTTON' && e.className.includes('btn-sm') && (e._parent && e._parent.className === 'co-nav'));
    assert.equal(arrows.length, 2, 'должно быть две стрелки');
    arrows[0].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 10 } }, '«‹» ведёт к предыдущему');
    arrows[1].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 12 } }, '«›» ведёт к следующему');

    walk(root).find((e) => e.className === 'co-av').click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11 } }, 'пациент ведёт в документы');
    // CASE_HEAD_TRIM_V1 — вкладок «Обзор / Документы» и главного действия в шапке нет.
    assert.equal(walk(root).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('reg-tab')).length, 0, 'вкладки в шапке убраны');
    assert.equal(walk(root).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('co-main')).length, 0, 'главное действие в шапке убрано');
});

test('шапка документов: пациент ведёт обратно в обзор', async () => {
    const { caseHead } = await import('../views/case-overview.js');
    const navs = [];
    const head = caseHead(OV, { active: 'documents', onNavigate: (view, payload) => navs.push({ view, payload }) });
    walk(head).find((e) => e.className === 'co-name').click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 11 } });
});

test('«Следующий шаг» открывает документы НА СЛЕДУЮЩЕМ ШАГЕ; «Лист назначений» — на лист', async () => {
    const navs = [];
    const root = await render((view, payload) => navs.push({ view, payload }));
    // CASE_DASH_QUIET_V1 — отдельной ссылки «Заполнить документ» больше нет:
    // к документу ведёт его собственное имя, и это на одно действие в подвале
    // меньше при том же числе способов туда попасть.
    const next = walk(root).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('co-next-go'))[0];
    assert.ok(next, 'имя следующего документа не ведёт к нему');
    assert.ok(textOf(next).includes('Обоснование клинического диагноза'), 'кнопка названа не именем документа: ' + textOf(next));
    next.click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11, kind: 'rationale' } });
    findBtn(root, 'Лист назначений').click();
    assert.equal(navs.pop().view, 'mar-sheet');
});

test('блоки: статус, диагноз, состояние, стол, назначения, услуги, операция, счёт, история, выписка', async () => {
    const root = await render(() => {});
    const t = textOf(root);
    // CASE_DASH_TIDY_V1 — полосы плиток больше нет: она не несла ни одного
    // числа, которого не было бы в панелях. Числа проверяются там, где они
    // теперь и живут.
    // CASE_LISTS_AS_STATS_V1 — назначения и услуги показаны ЧИСЛАМИ: обзор
    // отвечает «как идут дела», а имена лежат во вкладках истории болезни.
    for (const piece of ['Пациент сейчас', 'K35.8', 'Острый аппендицит', 'Стол №1', 'съедено 2', 'отказ 1',
        'введено', 'пропущено', 'начислено', 'не выставлено',
        'Запланирована', 'Оформлено 3 из 9', 'просрочено 1', 'Обоснование клинического диагноза']) {
        assert.ok(t.includes(piece), 'в блоках нет: ' + piece);
    }
    // Порядок чтения — как на схеме владельца.
    const order = ['Пациент сейчас', 'Выписка и счёт', 'Операция', 'Назначения и услуги', 'Следующий шаг']
        .map((s) => t.indexOf(s));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'блоки идут не в порядке схемы: ' + order.join(','));

    // CASE_DASH_QUIET_V1 — койко-дни назывались дважды и разными числами.
    assert.ok(!t.includes('Койко-дней'), 'койко-дни снова названы дважды');

    // Полоса плиток убрана целиком.
    assert.equal(walk(root).filter((e) => String(e.className || '').split(/\s+/).includes('co-tile')).length, 0,
        'полоса плиток вернулась');

    // Ни одно число не сказано дважды: день в отделении — только в шапке,
    // документы — только в «Следующем шаге», дозы — только в «Назначениях».
    assert.ok(!t.includes('День в отделении'), 'день в отделении снова сказан отдельной плиткой');
    assert.ok(!t.includes('Дозы сегодня'), 'дозы снова сказаны отдельной плиткой');

    // Стол переехал в «Пациент сейчас» и остался действием.
    const diet = walk(root).find((e) => String(e.className || '').split(/\s+/).includes('co-diet'));
    assert.ok(diet, 'стол пропал вместе с плитками');
    assert.ok(textOf(diet).includes('Стол №1'), 'стол не назван: ' + textOf(diet));
    let p = diet._parent; let inNow = false;
    while (p) { if (String(p.getAttribute && p.getAttribute('aria-label') || '') === 'Пациент сейчас') { inNow = true; break; } p = p._parent; }
    assert.ok(inNow, 'стол встал не в панель «Пациент сейчас»');
    assert.ok(walk(diet).some((e) => e.tagName === 'BUTTON'), 'стол перестал быть действием');
});

test('«Выписка» подаёт заявку с generate_bill и говорит, какой счёт ушёл в кассу', async () => {
    rpcCalls.length = 0;
    const root = await render(() => {});
    const btn = allBtns(root, 'Выписка').find((b) => b.className.includes('btn'));
    assert.ok(btn, 'кнопки «Выписка» нет');
    btn.click();
    await settle();
    const modal = topOverlay();
    assert.ok(modal && textOf(modal).includes('Заявка на выписку'), 'окно заявки не открылось');
    assert.ok(textOf(modal).includes('Счёт будет сформирован сразу'), 'окно должно предупредить, что счёт формируется');
    findBtn(modal, 'Подать заявку').click();
    await settle(); await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_discharge_request');
    assert.ok(call, 'заявка не ушла');
    assert.equal(call.args.generate_bill, true);
    assert.equal(call.args.admission_id, 11);
    assert.ok(lastToast().includes('INV-7'), 'подтверждение должно называть счёт: ' + lastToast());
    assert.ok(lastToast().includes('1 250 000'), 'и сумму');
});

// ─── DEBT_FLOW_V1 — «Долг» только когда он оформлен ─────────────────────────
test('DEBT_FLOW_V1: неоплаченный счёт лежащего — «К оплате» (жёлтый), оформленный долг — «Долг» (красный)', async () => {
    const saved = OV.bill;
    try {
        OV.bill = { accommodation: null, invoices: [{ id: 1, status: 'unpaid' }], total: 500000, paid: 0, debt: 500000, debt_marked: 0 };
        let root = await render(() => {});
        let big = walk(root).find((e) => String(e.className).includes('co-big'));
        assert.ok(textOf(big).includes('К оплате'), 'неоплаченный счёт лежащего назван долгом: ' + textOf(big));
        assert.ok(String(big.className).includes('co-warn') && !String(big.className).includes('co-crit'), 'тон должен быть warn, а не crit: ' + big.className);

        OV.bill = { accommodation: null, invoices: [{ id: 1, status: 'debt' }], total: 500000, paid: 120000, debt: 380000, debt_marked: 380000 };
        root = await render(() => {});
        big = walk(root).find((e) => String(e.className).includes('co-big'));
        assert.ok(textOf(big).includes('Долг'), 'оформленный долг не назван долгом: ' + textOf(big));
        assert.ok(String(big.className).includes('co-crit'), 'долг обязан быть красным: ' + big.className);
        assert.ok(textOf(big).replace(/\s/g, '').includes('380000'), 'сумма долга — остаток по счёту-долгу: ' + textOf(big));
    } finally {
        OV.bill = saved;
    }
});

// ─── CASE_HEAD_TIDY_V1 / CASE_ROUTE_SUB_V1 ──────────────────────────────────
test('CASE_HEAD_ACTION_V2: «Выписка» — главная пульсирующая кнопка в правом нижнем углу шапки', async () => {
    const root = await render(() => {});
    const btn = allBtns(root, 'Выписка').find((b) => b.className.includes('btn'));
    assert.ok(btn, 'кнопки «Выписка» нет');
    assert.ok(btn.className.includes('btn-primary'), 'выписка должна быть первичной кнопкой: ' + btn.className);
    assert.ok(btn.className.includes('btn-pulse'), 'выписка должна пульсировать (btn-pulse): ' + btn.className);
    // CASE_HEAD_ACTION_V2 — кнопка в правом нижнем углу ШАПКИ: последняя ячейка строки фактов (co-fields-act).
    let p = btn._parent; let inAct = false; let inHead = false;
    while (p) { const c = String(p.className || ''); if (c.includes('co-fields-act')) inAct = true; if (c.includes('co-head')) inHead = true; p = p._parent; }
    assert.ok(inAct && inHead, 'кнопка выписки не в правом нижнем углу шапки');
    assert.equal(walk(root).filter((e) => String(e.className || '').includes('co-fab')).length, 0, 'плавающей кнопки быть не должно');
    assert.equal(walk(root).filter((e) => String(e.className || '').includes('co-bar')).length, 0, 'полоса-подвал шапки должна исчезнуть');
});

test('CASE_ROUTE_SUB_V1: номер госпитализации читается из подмаршрута адреса, а без номера обзор уводит в список стационара', async () => {
    const { renderCaseOverview } = await import('../views/case-overview.js');
    const c1 = mkEl('div'); BODY.appendChild(c1);
    await renderCaseOverview(c1, { payload: { sub: '11' }, onNavigate: () => {} });
    await settle();
    assert.ok(textOf(c1).includes('Иванов Иван Иванович'), 'по #case-overview/11 обзор не открыл госпитализацию 11');

    const navs = [];
    const c2 = mkEl('div'); BODY.appendChild(c2);
    await renderCaseOverview(c2, { payload: null, onNavigate: (v, p) => navs.push({ v, p }) });
    await settle();
    assert.ok(textOf(c2).includes('К списку пациентов'), 'без номера нет кнопки к списку');
    assert.deepEqual(navs[0], { v: 'admissions', p: { sub: 'patients' } }, 'без номера обзор обязан увести в список пациентов стационара');
});


// ─── VITALS_NEWS_V1 — панель «Показатели» ───────────────────────────────────
test('VITALS_NEWS_V1: панель показателей — балл NEWS, уровень с рекомендацией, плитки с нормой и динамика', async () => {
    const root = await render(() => {});
    const card = walk(root).find((e) => String(e.className || '').includes('vt-card'));
    assert.ok(card, 'панели показателей нет');
    const t = textOf(card);
    // CASE_DASH_FIT_V2 — чипы по параметрам убраны: они перечисляли те же
    // пять показателей, что стоят плитками строкой ниже, и обзор из-за них
    // не помещался в экран. Очки за сознание и кислород входят в общий балл.
    for (const piece of ['Показатели', 'последнее измерение', '5', 'NEWS', 'Средний риск', 'в течение 1 часа',
        'ухудшение +5', '38,1 °C', '138/88', '104 уд', '21 /мин', '94 %',
        'норма 36,0–37,2 °C', 'норма < 140/90', 'норма 60–90 уд/мин', 'норма 12–20 /мин', 'норма ≥ 95 %']) {
        assert.ok(t.includes(piece), 'в панели нет: ' + piece + ' — ' + t.slice(0, 500));
    }
    // CASE_DASH_QUIET_V1 — графика NEWS в баннере больше нет: без шкалы и
    // подписей он повторял балл и слово уровня. Искорки остались у плиток
    // показателей — там они читаются вместе со значением и нормой.
    // Искорка рисуется через createElementNS и несёт класс АТРИБУТОМ, а не
    // свойством: искать её по className — значит не найти никогда.
    const cls = (e) => String(e.className || (e.getAttribute && e.getAttribute('class')) || '');
    assert.ok(!walk(card).some((e) => cls(e).split(/\s+/).includes('vt-trend-l')),
        'график динамики NEWS вернулся в баннер');
    assert.ok(walk(card).some((e) => cls(e).includes('vt-spark')),
        'искорки пропали и у плиток показателей');
    // И самих чипов в панели больше нет.
    assert.ok(!walk(card).some((e) => cls(e).split(/s+/).includes('vt-chip')),
        'чипы по параметрам вернулись — это те же числа, что на плитках');
    // Тон плиток — по очкам: ЧДД (+2) и температура (+1) подсвечены, АД (0) — нет.
    const tiles = walk(card).filter((e) => String(e.className || '').split(/\s+/).includes('vt-tile'));
    assert.equal(tiles.length, 5, 'пять плиток');
    const byLabel = (l) => tiles.find((x) => textOf(x).includes(l));
    assert.ok(byLabel('ЧДД').className.includes('vt-warn2'), 'ЧДД +2 — оранжевая: ' + byLabel('ЧДД').className);
    assert.ok(byLabel('Температура').className.includes('vt-warn'), 'температура +1 — жёлтая');
    assert.ok(byLabel('АД').className.includes('vt-ok'), 'АД 0 — спокойная: ' + byLabel('АД').className);
    // Искорки нарисованы по ряду: у температуры три точки → ломаная.
    const sparks = walk(byLabel('Температура')).filter((e) => e.tagName === 'PATH');
    assert.ok(sparks.length >= 1, 'у плитки нет искорки');
    // Баннер — тон уровня.
    const banner = walk(card).find((e) => String(e.className || '').includes('vt-banner'));
    assert.ok(banner.className.includes('vt-band-medium'), banner.className);
});

test('VITALS_NEWS_V1: «Добавить измерение» открывает окно, считает балл на лету и шлёт admission_vitals_add с полями', async () => {
    rpcCalls.length = 0;
    const root = await render(() => {});
    const add = allBtns(root, 'Добавить измерение')[0];
    assert.ok(add, 'кнопки «Добавить измерение» нет');
    add.click();
    await settle();
    const modal = BODY.children[BODY.children.length - 1];
    const mt = textOf(modal);
    assert.ok(mt.includes('Добавить измерение') && mt.includes('Иванов Иван Иванович'), mt.slice(0, 300));
    const inputs = walk(modal).filter((e) => e.tagName === 'INPUT' && e.attrs['data-key']);
    const byKey = (k) => inputs.find((e) => e.attrs['data-key'] === k);
    // VITALS_STEPPER_V1 — поля начинаются нормой, и балл сразу посчитан.
    assert.deepEqual(['temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'resp_rate', 'spo2'].map((k) => byKey(k).value), ['36.6', '120', '80', '72', '16', '98']);
    byKey('temp_c').value = '39,2'; byKey('temp_c').dispatchEvent({ type: 'input' });
    byKey('pulse_bpm').value = '118'; byKey('pulse_bpm').dispatchEvent({ type: 'input' });
    byKey('resp_rate').value = '26'; byKey('resp_rate').dispatchEvent({ type: 'input' });
    const preview = walk(modal).find((e) => String(e.className || '').includes('vt-preview'));
    assert.ok(textOf(preview).includes('NEWS 7') && textOf(preview).includes('Высокий риск'), 'балл на лету: ' + textOf(preview));
    assert.ok(textOf(preview).includes('измерение полное') || !textOf(preview).includes('неполное'), 'все поля заполнены нормой — измерение полное: ' + textOf(preview));

    const submit = walk(modal).find((e) => e.tagName === 'BUTTON' && /Записать/.test(textOf(e)));
    submit.click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_vitals_add');
    assert.ok(call, 'admission_vitals_add не вызван');
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.temp_c, '39,2');
    assert.equal(call.args.pulse_bpm, '118');
    assert.equal(call.args.resp_rate, '26');
    assert.equal(call.args.spo2, '98', 'нетронутое поле уходит нормой');
    assert.equal(call.args.consciousness, 'alert');
    assert.equal(call.args.on_oxygen, false);
    assert.ok(call.args.measured_at, 'время измерения уходит явно');
    // И обзор перечитан.
    assert.ok(rpcCalls.filter((c) => c.name === 'admission_overview').length >= 2);
});

test('VITALS_NEWS_V1: без измерений панель говорит об этом и зовёт внести первое', async () => {
    const saved = OV.vitals;
    try {
        OV.vitals = { count: 0, series: [], last: null, prev: null, news: { total: 0, band: 'none', parts: {}, complete: false, measured: 0 }, trend: 0, can_add: true };
        const root = await render(() => {});
        const card = walk(root).find((e) => String(e.className || '').includes('vt-card'));
        assert.ok(textOf(card).includes('Измерений ещё нет'), textOf(card).slice(0, 300));
        assert.ok(allBtns(root, 'Добавить измерение')[0], 'кнопка внести первое измерение');
        assert.equal(walk(card).filter((e) => String(e.className || '').includes('vt-tile')).length, 0, 'плиток без данных нет');
    } finally {
        OV.vitals = saved;
    }
});


// ─── VITALS_DYNAMICS_V1 — плитка нажимается и открывает динамику ─────────────
test('VITALS_DYNAMICS_V1: плитки — кнопки с цветом показателя и гладкой кривой; нажатие открывает динамику с графиком и таблицей', async () => {
    rpcCalls.length = 0;
    const root = await render(() => {});
    const tiles = walk(root).filter((e) => String(e.className || '').split(/\s+/).includes('vt-tile'));
    assert.equal(tiles.length, 5);
    for (const tile of tiles) {
        assert.equal(tile.tagName, 'BUTTON', 'плитка обязана быть кнопкой');
        assert.ok(tile.attrs['data-metric'], 'у плитки нет data-metric — цвет показателя не назначится');
    }
    // VITALS_TILES_FILL_V1 — плитка залита цветом показателя ВСЕГДА; отклонение — кольцо.
    for (const x of tiles) assert.ok(x.className.includes('vt-fill'), 'плитка не залита: ' + x.attrs['data-metric']);
    const temp = tiles.find((x) => x.attrs['data-metric'] === 'temp_c');
    assert.ok(temp.className.includes('vt-abn'), 'температура +1 — с кольцом отклонения: ' + temp.className);
    const bp = tiles.find((x) => x.attrs['data-metric'] === 'bp');
    assert.ok(!bp.className.includes('vt-abn'), 'АД 0 — без кольца');
    const curve = walk(temp).find((e) => e.tagName === 'PATH' && e.attrs.fill === 'none');
    assert.ok(curve && /C/.test(curve.attrs.d), 'кривая обязана быть гладкой (Безье), а не ломаной: ' + (curve && curve.attrs.d));

    temp.click();
    await settle();
    const modal = BODY.children[BODY.children.length - 1];
    const mt = textOf(modal);
    assert.ok(mt.includes('Динамика показателей') && mt.includes('Иванов Иван Иванович'), mt.slice(0, 300));
    assert.ok(rpcCalls.some((c) => c.name === 'admission_vitals_list' && c.args.admission_id === 11), 'полная история спрашивается с сервера');
    // VITALS_ONE_WINDOW_V1 — без вкладок: пять карточек с графиком, нажатая — подсвечена.
    assert.equal(walk(modal).filter((e) => String(e.className || '').split(/\s+/).includes('vd-tab')).length, 0, 'вкладок быть не должно');
    const cards = walk(modal).filter((e) => String(e.className || '').split(/\s+/).includes('vd-card'));
    assert.equal(cards.length, 5, 'пять карточек показателей');
    assert.deepEqual(cards.map((c) => c.attrs['data-metric']), ['temp_c', 'bp', 'pulse_bpm', 'resp_rate', 'spo2']);
    assert.ok(cards[0].className.includes('vd-focus'), 'нажатая плитка (температура) подсвечена');
    for (const c of cards) {
        assert.ok(walk(c).some((e) => e.tagName === 'RECT'), 'полоса нормы на графике ' + c.attrs['data-metric']);
        assert.ok(walk(c).filter((e) => e.tagName === 'CIRCLE').length >= 1, 'точки измерений ' + c.attrs['data-metric']);
    }
    assert.ok(textOf(cards[0]).includes('38,1 °C') && textOf(cards[4]).includes('94 %'), 'в шапке карточки — последнее значение');
    // Одна таблица со всеми колонками: три строки, новые сверху.
    const ths = walk(modal).filter((e) => e.tagName === 'TH').map(textOf);
    for (const col of ['Время', 'Температура', 'АД', 'Пульс', 'ЧДД', 'SpO₂', 'NEWS', 'Кто измерил']) assert.ok(ths.some((x) => x.includes(col)), 'нет колонки ' + col);
    const rowsEl = walk(modal).filter((e) => e.tagName === 'TR').slice(1);
    assert.equal(rowsEl.length, 3, 'строк таблицы: ' + rowsEl.length);
    const first = textOf(rowsEl[0]);
    for (const piece of ['38,1 °C', '138/88', '104 уд', '21 /мин', '94 %', 'Медсестра Петрова']) assert.ok(first.includes(piece), 'в первой строке нет: ' + piece + ' — ' + first);
    assert.ok(textOf(rowsEl[2]).includes('при поступлении'), 'точка титульного листа подписана');
});


// ─── CASE_PANELS_TIDY_V1 — одна первичная кнопка, панели одного вида ─────────
test('CASE_PANELS_TIDY_V1: единственная первичная кнопка — «Выписка» в шапке; действия панелей контурные; без счетов крупная цифра — накопленное к оплате', async () => {
    const root = await render(() => {});
    const primaries = walk(root).filter((e) => e.tagName === 'BUTTON' && String(e.className || '').includes('btn-primary'));
    // textOf несёт и разметку значка — сравниваем по вхождению слова.
    const labels = primaries.map((b) => textOf(b));
    const rest = labels.filter((l) => !l.includes('Добавить измерение'));
    assert.equal(rest.length, 1, 'первичной должна быть только выписка: ' + rest.length);
    assert.ok(rest[0].includes('Выписка'), 'первичная кнопка — не выписка');
    // CASE_ACTIONS_GHOST_V1 — действия карточек: призрачные, с шевроном, в подвале справа.
    // CASE_DASH_QUIET_V1 — одно действие на панель: «Услуги госпитализации»
    // убраны (карточка открывается из списка стационара), «Заполнить документ»
    // заменено именем документа, панель операции у неоперируемого не рисуется.
    for (const label of ['Лист назначений', 'История болезни']) {
        const b = allBtns(root, label)[0];
        assert.ok(b, 'нет действия ' + label);
        assert.ok(b.className.includes('co-act') && !b.className.includes('btn'), label + ' — должно быть призрачным действием: ' + b.className);
        assert.ok(walk(b).some((e) => e.tagName === 'SVG' || String(e._t || '').includes('<svg')), label + ' — без шеврона');
        let p = b._parent; let inFoot = false;
        while (p) { if (String(p.className || '').includes('co-panel-f')) inFoot = true; p = p._parent; }
        assert.ok(inFoot, label + ' — не в подвале карточки');
    }
    const t = textOf(root);
    assert.ok(!t.includes('Выписать и выставить счёт'), 'дубль кнопки выписки в панели счёта');
    // Счетов нет, но есть 950 000 услуг и 300 000 проживания → 1 250 000 накоплено.
    assert.ok(t.includes('Накоплено к оплате'), 'без счетов панель обязана назвать накопленное');
    assert.ok(t.replace(/\u00a0/g, ' ').includes('1 250 000'), 'сумма = услуги + проживание: ' + t.slice(t.indexOf('Накоплено'), t.indexOf('Накоплено') + 80));
});


// ─── CASE_LISTS_AS_STATS_V1 — обзор не перечисляет, а считает ────────────────
//
// Владелец: «make cards of prescription statuses, not actual services and
// invoices, just amount and the summ». До этого здесь стояли два списка —
// назначения поимённо и услуги построчно с ценами; это была третья копия того,
// что и так лежит во вкладках, обрезанная шириной колонки.
test('CASE_LISTS_AS_STATS_V1: обзор показывает числа и суммы, а не строки назначений и услуг', async () => {
    const root = await render(() => {});
    const t = textOf(root).replace(/\u00a0/g, ' ');

    // Имён нет ни у назначения, ни у услуги: за ними — вкладки.
    assert.ok(!t.includes('Цефтриаксон'), 'обзор снова перечисляет назначения поимённо');
    assert.ok(!t.includes('Аппендэктомия'), 'обзор снова перечисляет услуги строками');
    assert.equal(walk(root).filter((e) => String(e.className || '').split(/\s+/).includes('co-row-svc')).length, 0,
        'строки услуг вернулись в обзор');

    // Зато есть числа, ради которых обзор и открывают.
    const stats = walk(root).filter((e) => String(e.className || '').split(/\s+/).includes('co-stat'));
    assert.ok(stats.length >= 6, 'карточек состояний меньше, чем состояний: ' + stats.length);
    const st = stats.map((e) => textOf(e).replace(/\u00a0/g, ' '));
    assert.ok(st.some((x) => x.includes('2') && x.includes('введено')), 'введено: ' + st.join(' | '));
    assert.ok(st.some((x) => x.includes('1') && x.includes('пропущено')), 'пропущено: ' + st.join(' | '));
    // Ожидает — ОСТАТОК: назначено 4, введено 2, пропущено 1 → ждёт одна доза.
    assert.ok(st.some((x) => x.includes('1') && x.includes('ожидает')), 'ожидает: ' + st.join(' | '));
    // Деньги — суммой СЕРВЕРА (sum_total / sum_unbilled), а не сложением строк
    // на экране: два способа сложить одни и те же деньги расходятся молча.
    assert.ok(st.some((x) => x.includes('950 000') && x.includes('начислено')), 'начислено: ' + st.join(' | '));
    assert.ok(st.some((x) => x.includes('950 000') && x.includes('не выставлено')), 'не выставлено: ' + st.join(' | '));
});

// ─── VITALS_STEPPER_V1 — кнопки «−» и «+» ───────────────────────────────────
test('VITALS_STEPPER_V1: у каждого поля кнопки слева и справа; шаг 0,1 у температуры и 1 у остальных, границы не переступает', async () => {
    const root = await render(() => {});
    allBtns(root, 'Добавить измерение')[0].click();
    await settle();
    const modal = BODY.children[BODY.children.length - 1];
    const steps = walk(modal).filter((e) => String(e.className || '').split(/\s+/).includes('vt-step'));
    assert.equal(steps.length, 6, 'шесть полей-шагомеров');
    for (const st of steps) {
        const kids = (st.children || []).filter((c) => c.tagName === 'BUTTON' || c.tagName === 'INPUT');
        assert.deepEqual(kids.map((c) => c.tagName), ['BUTTON', 'INPUT', 'BUTTON'], 'кнопка — число — кнопка');
        assert.equal(kids[0].attrs['aria-label'], 'Меньше');
        assert.equal(kids[2].attrs['aria-label'], 'Больше');
    }
    const inputs = walk(modal).filter((e) => e.tagName === 'INPUT' && e.attrs['data-key']);
    const stepOf = (k) => steps.find((st) => (st.children || []).some((c) => c.attrs && c.attrs['data-key'] === k));
    const btnsOf = (k) => (stepOf(k).children || []).filter((c) => c.tagName === 'BUTTON');
    const val = (k) => inputs.find((e) => e.attrs['data-key'] === k).value;

    // Температура: шаг 0,1.
    btnsOf('temp_c')[1].click();
    assert.equal(val('temp_c'), '36.7');
    btnsOf('temp_c')[0].click(); btnsOf('temp_c')[0].click();
    assert.equal(val('temp_c'), '36.5');
    // Пульс: шаг 1, и балл пересчитывается сразу.
    btnsOf('pulse_bpm')[1].click();
    assert.equal(val('pulse_bpm'), '73');
    const preview = walk(modal).find((e) => String(e.className || '').includes('vt-preview'));
    assert.ok(textOf(preview).includes('NEWS'), 'после шага балл пересчитан: ' + textOf(preview));
    // Граница: SpO₂ не поднимается выше 100.
    const up = btnsOf('spo2')[1];
    for (let i = 0; i < 5; i++) up.click();
    assert.equal(val('spo2'), '100', 'выше физического предела шагомер не уходит');
});

// ─── CASE_DIARY_ACT_V1 — дневник наблюдения заметной кнопкой ─────────────────
//
// Владелец (2026-09-08): «add to here the main style button of kundalik».
// Дневник — единственная запись обзора, которую делают КАЖДЫЙ ДЕНЬ, пока
// пациент лежит; остальные действия панели — переходы. Поэтому у него залитая
// кнопка, и она исчезает после выписки: дневник выписанного никто не ведёт.
test('CASE_DIARY_ACT_V1: «Дневник наблюдения» — заметная кнопка в «Следующем шаге», ведёт в документы на дневник и пропадает после выписки', async () => {
    const navs = [];
    const root = await render((view, payload) => navs.push({ view, payload }));
    const b = allBtns(root, 'Дневник наблюдения')[0];
    assert.ok(b, 'кнопки дневника нет в обзоре');
    assert.ok(String(b.className).includes('co-act-main'), 'дневник должен быть заметным действием: ' + b.className);
    assert.ok(!String(b.className).includes('btn-primary'), 'это действие панели, а не кнопка формы: ' + b.className);

    // Стоит в подвале панели «Следующий шаг», рядом с призрачным переходом.
    let p = b._parent; let foot = null;
    while (p) { if (String(p.className || '').includes('co-panel-f')) { foot = p; break; } p = p._parent; }
    assert.ok(foot, 'дневник не в подвале карточки');
    // Подвал «Следующего шага» теперь несёт ровно дневник: переход к документу
    // ушёл на его имя.
    let panelEl2 = foot._parent;
    while (panelEl2 && !String(panelEl2.className || '').includes('co-panel')) panelEl2 = panelEl2._parent;
    assert.ok(panelEl2 && (panelEl2.getAttribute('aria-label') || '') === 'Следующий шаг',
        'дневник встал не в «Следующий шаг»: ' + (panelEl2 ? panelEl2.getAttribute('aria-label') : ''));
    // Заметная кнопка на панели ровно одна — иначе главной не будет ни одной.
    const filled = walk(foot).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('co-act-main'));
    assert.equal(filled.length, 1, 'на панели больше одной залитой кнопки: ' + filled.length);

    b.click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11, kind: 'round' } },
        'дневник должен открывать документы на дневнике наблюдения');

    const saved = OV.admission.status;
    try {
        OV.admission = { ...OV.admission, status: 'discharged' };
        const out = await render(() => {});
        assert.equal(allBtns(out, 'Дневник наблюдения').length, 0, 'выписанному предлагают вести дневник');
    } finally {
        OV.admission = { ...OV.admission, status: saved };
    }
});

// ─── CASE_HEAD_BADGE_V1 — аллергия справа, обычное состояние без значка ─────
//
// Владелец (2026-09-08): «can you transfer allergiya, to the right side as a
// badge and remove the davolanmoqda ... and will be space and everighin will
// fil into a view port». Обе правки экономят шапке по строке.
test('CASE_HEAD_BADGE_V1: аллергия — значок справа, «Лечение» в шапке не показывается, а «Оформляется выписка» показывается', async () => {
    const root = await render(() => {});
    const allergy = walk(root).find((e) => String(e.className || '').split(/\s+/).includes('co-allergy'));
    assert.ok(allergy, 'значка аллергии нет');
    assert.ok(textOf(allergy).includes('пенициллин'), 'значок не называет аллерген');
    // Стоит СПРАВА — в том же блоке, что стрелки по соседям.
    let p = allergy._parent; let side = false;
    while (p) { if (String(p.className || '').includes('co-head-side')) { side = true; break; } p = p._parent; }
    assert.ok(side, 'аллергия осталась строкой под именем, а не значком справа');

    // Обычное состояние «Лечение» в шапке не горит: оно горело бы всегда.
    const nameRow = walk(root).find((e) => String(e.className || '').includes('co-name-row'));
    assert.ok(nameRow && !textOf(nameRow).includes('Лечение'),
        'обычное состояние вернулось в шапку: ' + (nameRow ? textOf(nameRow) : ''));

    // А состояние, которое НОВОСТЬ, показывается.
    const saved = OV.admission.status;
    try {
        OV.admission = { ...OV.admission, status: 'discharging' };
        const out = await render(() => {});
        const row2 = walk(out).find((e) => String(e.className || '').includes('co-name-row'));
        assert.ok(row2 && textOf(row2).includes('Оформляется выписка'),
            'состояние-новость перестало показываться: ' + (row2 ? textOf(row2) : ''));
    } finally {
        OV.admission = { ...OV.admission, status: saved };
    }
});

// ─── CASE_DASH_FIT_V1 — обзор помещается в экран ────────────────────────────
//
// Владелец (2026-09-09): «now only need to fix height». Панели кончались на
// разной высоте, а нижние уезжали за край: сетка росла по содержимому, а не
// по экрану.
test('CASE_DASH_FIT_V1: сетка обзора получает измеренную высоту, ряды делят её поровну, прокрутка — внутри панели', async () => {
    const root = await render(() => {});
    const zone = walk(root).find((e) => String(e.className || '').split(/\s+/).includes('co-z'));
    assert.ok(zone, 'сетки обзора нет');
    // Высоту МЕРЯЕТ скрипт: у обвязки без вёрстки мерить нечего, поэтому
    // проверяется проводка — что сетка передана замерщику и что замерщик
    // считает от настоящего верха, а не от постоянного числа.
    const src = (await import('node:fs')).readFileSync(
        (await import('node:path')).join((await import('node:path')).dirname(
            (await import('node:url')).fileURLToPath(import.meta.url)), '..', 'views', 'case-overview.js'), 'utf8');
    assert.ok(src.includes('state.disposeFit = fitZone(zone);'), 'сетка не передана замерщику высоты');
    assert.ok(src.includes('zone.getBoundingClientRect().top'), 'высота считается не от настоящего верха сетки');
    assert.ok(src.includes("zone.style.setProperty('--co-fit'"), 'измеренная высота не доезжает до стилей');

    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path2.dirname(fileURLToPath(import.meta.url));
    const css = fs2.readFileSync(path2.join(dir, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
    assert.ok(/\.co-z\{[^}]*height:var\(--co-fit,auto\)/.test(css), 'сетка снова растёт по содержимому');
    assert.ok(/\.co-z\{[^}]*grid-auto-rows:minmax\(0,1fr\)/.test(css), 'ряды перестали делить высоту поровну');
    assert.ok(/\.co-z\{[^}]*align-items:stretch/.test(css), 'панели снова кончаются на разной высоте');
    assert.ok(/\.co-panel-b\{[^}]*overflow-y:auto/.test(css), 'длинный список снова утащит за собой всю страницу');
    // Подвал панели с действием остаётся ВНЕ прокрутки: ради действия панель и читают.
    assert.ok(!/\.co-panel-f\{[^}]*overflow/.test(css), 'подвал панели попал в прокрутку');
});

// ─── CASE_NAV_TAB_V1 — стрелки оставляют вас на той же вкладке ──────────────
//
// Владелец (2026-09-09): «when navigation in the documents its not opening the
// list but throws to the stationary menu». Стрелки всегда вели на ОБЗОР, и
// врач, писавший документы подряд по палате, вылетал из документов на каждом
// переходе.
test('CASE_NAV_TAB_V1: из документов стрелки ведут в документы соседа, из обзора — в обзор', async () => {
    const { caseHead } = await import('../views/case-overview.js');
    const navs = [];
    const nav = (view, payload) => navs.push({ view, payload });

    const fromDocs = caseHead(OV, { active: 'documents', onNavigate: nav });
    const arrows = (root) => walk(root).filter((e) => e.tagName === 'BUTTON' && e._parent && String(e._parent.className) === 'co-nav');
    assert.equal(arrows(fromDocs).length, 2, 'стрелок по соседям должно быть две');
    arrows(fromDocs)[0].click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 10 } },
        'из документов «‹» уводит из документов');
    arrows(fromDocs)[1].click();
    assert.equal(navs.pop().view, 'case-file', 'из документов «›» уводит из документов');

    const fromOv = caseHead(OV, { active: 'overview', onNavigate: nav });
    arrows(fromOv)[0].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 10 } },
        'из обзора стрелка ведёт не в обзор');
});
