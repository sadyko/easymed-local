// ADMISSION_ORDER_V1 — окно медсестры «Стационар».
//
// Что здесь проверяется и почему именно это:
//   1. ЗАЯВКА ВИДНА. Обещание «Заявка появится в стационаре для оформления»
//      висело в кабинете врача, а экрана, который его выполняет, не было.
//      Тест держит обещание: и заявка регистратуры, и направление врача
//      оказываются в одном списке «Ждут размещения».
//   2. ПОДПИСЬ ПРАВДИВА. Заявка ('ordered') раньше подписывалась «Отменено» —
//      экран сообщал, что госпитализации не будет, ровно про того пациента,
//      которого ждут. Тест утверждает подпись и запрещает старую.
//   3. ПАЦИЕНТ — ЯКОРЬ. Имя обязано быть САМЫМ КРУПНЫМ на строке: это защита
//      от «не того пациента», а не типографика, и она должна ломать тест, а не
//      тихо съезжать при следующей правке стилей.
//   4. КОЙКА ЗАНИМАЕТСЯ ОТСЮДА. Выбор койки уходит в admission_admit с теми
//      самыми аргументами, а отказ сервера доходит до человека словами.
//   5. РАЗДЕЛ ДОСТУПЕН МЕДСЕСТРЕ. Именно этого не было: ключ `beds` держал
//      один admin, и окно, построенное для медсестры, ей не открывалось.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM ────────────────────────────────────────────────────────
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
    click() { for (const fn of this._l.click || []) fn({ currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { }
    focus() {} blur() {}
    // Как в настоящем DOM: textContent — это ВЕСЬ текст поддерева. Наивный
    // геттер (только собственный _text) врал бы ровно там, где это дороже
    // всего: modal() запоминает подпись кнопки через textContent и возвращает
    // её после отказа сервера — с наивным геттером кнопка «Положить» после
    // отказа осталась бы безымянной, и тест сообщил бы о несуществующей ошибке.
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {} };
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const allBtns = (root, label) => walk(root).filter((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const lastToast = () => {
    const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop();
    return t ? t.textContent : '';
};
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── данные, которые отдаёт «сервер» ────────────────────────────────────────
// Три состояния маршрута сразу: заявка регистратуры, направление врача,
// пациент на койке. Именно так выглядит смена, а не по одному состоянию за раз.
const ORDER_REG = {
    id: 11, admission_no: 'ADM-00011', status: 'ordered', patient_id: 101,
    ward_id: 1, bed_id: null, department: 'Терапевтическое', admission_type: 'planned',
    stay_mode: 'round', planned_at: null, ordered_at: '2026-09-04T08:00:00Z',
    patients: { mrn: 'M-101', full_name: 'Иванов Иван Иванович' }, wards: { name: 'Терапия' }, beds: null, users: null,
};
const ORDER_DOC = {
    id: 12, admission_no: 'ADM-00012', status: 'ordered', patient_id: 102,
    ward_id: null, bed_id: null, department: '', admission_type: 'emergency',
    stay_mode: 'round', planned_at: null, ordered_at: '2026-09-04T09:00:00Z',
    patients: { mrn: 'M-102', full_name: 'Петрова Мария' }, wards: null, beds: null,
    users: { full_name: 'Врач Направивший' },
};
const IN_BED = {
    id: 13, admission_no: 'ADM-00013', status: 'admitted', patient_id: 103,
    ward_id: 1, bed_id: 5, department: '', admission_type: 'planned', stay_mode: 'round',
    ordered_at: '2026-09-03T07:00:00Z', admitted_at: '2026-09-03T08:00:00Z',
    patients: { mrn: 'M-103', full_name: 'Сидоров Сидор' }, wards: { name: 'Терапия' },
    beds: { code: 'T-1' }, users: null,
};

const BEDS = [
    { id: 5, code: 'T-1', status: 'occupied', ward_id: 1, type: 'standard', wards: { name: 'Терапия' } },
    { id: 6, code: 'T-2', status: 'free', ward_id: 1, type: 'standard', wards: { name: 'Терапия' } },
    { id: 7, code: 'T-3', status: 'cleaning', ward_id: 1, type: 'standard', wards: { name: 'Терапия' } },
    { id: 8, code: 'S-1', status: 'free', ward_id: 2, type: 'standard', wards: { name: 'Хирургия' } },
];

let admissionsRows = [ORDER_REG, ORDER_DOC, IN_BED];
let rpcCalls = [];
let admitAnswer = () => ({ ok: true, data: { admission: { id: 11, status: 'admitted' } } });

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        rpcCalls.push({ name, args: body });
        if (name === 'admission_admit') {
            const a = admitAnswer();
            return a.ok ? ok(a.data) : fail(a.message);
        }
        return ok({});
    }
    if (u === '/api/db') {
        if (body.table === 'admissions') return ok(admissionsRows);
        if (body.table === 'beds') return ok(BEDS);
        if (body.table === 'wards') return ok([{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }]);
        if (body.table === 'patients') return ok([]);
        return ok([]);
    }
    return ok([]);
};

const view = await import('../views/admissions.js');
const perms = await import('../permissions.js');

async function renderScreen() {
    BODY.children.length = 0;
    rpcCalls = [];
    const container = mkEl('div');
    await view.renderAdmissions(container);
    await settle();
    return container;
}

// ─── 1. Заявка видна — и от регистратуры, и от врача ────────────────────────

test('заявка регистратуры и направление врача попадают в один список «Ждут размещения»', async () => {
    const root = await renderScreen();
    const txt = textOf(root);

    assert.ok(txt.includes('Ждут размещения'), 'списка «Ждут размещения» нет на экране');
    assert.ok(txt.includes('Иванов Иван Иванович'), 'заявка регистратуры не видна');
    assert.ok(txt.includes('Петрова Мария'), 'направление врача (request_admission) не видно');
    // Оба — в одном списке, а не в двух разных очередях.
    const card = walk(root).find((e) => textOf(e).includes('Ждут размещения') && e.className === 'card');
    assert.ok(card, 'карточка списка не найдена');
    assert.ok(textOf(card).includes('Иванов Иван Иванович') && textOf(card).includes('Петрова Мария'),
        'заявка регистратуры и направление врача должны стоять в одной очереди');
    assert.ok(textOf(card).includes('пациентов: 2'), 'счётчик очереди должен считать обе заявки');
});

test('лежащий пациент — в «В отделении» и в «Ждут первичного осмотра», сгруппирован по палате', async () => {
    const root = await renderScreen();
    const inWard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('В отделении'));
    assert.ok(inWard, 'списка «В отделении» нет');
    assert.ok(textOf(inWard).includes('Сидоров Сидор'), 'пациент на койке не показан');
    assert.ok(textOf(inWard).includes('Терапия'), 'группировка по палате пропала');
    assert.ok(textOf(inWard).includes('койка T-1'), 'номер койки не показан');
    // Заявки в этот список не просачиваются: у них койки нет.
    assert.ok(!textOf(inWard).includes('Иванов Иван Иванович'), 'заявка не должна считаться лежащей');

    const exam = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Ждут первичного осмотра'));
    assert.ok(exam, 'очереди первичного осмотра нет');
    assert.ok(textOf(exam).includes('Сидоров Сидор'), 'размещённый пациент обязан ждать осмотра главного врача');
});

// ─── 2. Подпись состояния ───────────────────────────────────────────────────

test('РЕГРЕССИЯ: заявка подписана «Ждёт размещения», а не «Отменена»', async () => {
    const root = await renderScreen();
    const txt = textOf(root);
    // Старая ошибка: 'ordered' попадал в ветку «иначе» и подписывался отменой.
    assert.ok(!/Отменен|Отменён|Отменено/.test(txt),
        'на экране не должно быть слова «отменено»: все три списка — про ОТКРЫТЫЕ госпитализации');

    const { admissionStatusLabel } = await import('../../shared/admission-status.js');
    assert.strictEqual(admissionStatusLabel('ordered'), 'Ждёт размещения');
    assert.strictEqual(admissionStatusLabel('cancelled'), 'Отменена');

    // …и подпись лежащего пациента берётся из той же карты.
    const inWard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('В отделении'));
    assert.ok(textOf(inWard).includes(admissionStatusLabel('admitted')),
        'состояние лежащего пациента должно называться словами из общей карты');
});

// ─── 3. Пациент — якорь ─────────────────────────────────────────────────────

test('имя пациента — САМОЕ КРУПНОЕ на строке (защита от «не того пациента»)', async () => {
    const root = await renderScreen();
    const nameEl = walk(root).find((e) => e.tagName === 'DIV' && e.textContent === 'Иванов Иван Иванович');
    assert.ok(nameEl, 'имя пациента не нарисовано отдельным узлом');
    const nameSize = parseFloat(nameEl.style.fontSize);
    assert.ok(nameSize >= 16, `имя пациента должно быть крупным, а не ${nameEl.style.fontSize}`);

    // Ничто на экране очереди не может быть крупнее имени пациента.
    const bigger = walk(root).filter((e) => e !== nameEl && e.style && e.style.fontSize && parseFloat(e.style.fontSize) > nameSize);
    assert.deepStrictEqual(bigger.map((e) => e.textContent || e.tagName), [],
        'ничто на строке не должно быть крупнее имени пациента');
});

// ─── 4. Койка занимается отсюда ─────────────────────────────────────────────

test('«Положить на койку» → выбор койки → admission_admit с этой заявкой и этой койкой', async () => {
    const root = await renderScreen();
    admitAnswer = () => ({ ok: true, data: { admission: { id: 11, status: 'admitted' } } });

    const put = allBtns(root, 'Положить на койку')[0];
    assert.ok(put, 'у заявки нет кнопки «Положить на койку»');
    put.click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    const modalTxt = textOf(overlay);
    assert.ok(modalTxt.includes('Иванов Иван Иванович'), 'в окне выбора койки пациент обязан быть виден');
    // Заявка названа в палате «Терапия» — показаны её койки, чужая палата не предлагается.
    assert.ok(modalTxt.includes('T-2'), 'свободная койка палаты заявки не показана');
    assert.ok(!modalTxt.includes('S-1'), 'койка чужой палаты не должна предлагаться');
    // Занятая и убираемая койки ВИДНЫ (иначе экран выглядит сломанным), но с причиной.
    assert.ok(modalTxt.includes('T-1') && modalTxt.includes('Занята'), 'занятая койка должна быть видна и названа занятой');
    assert.ok(modalTxt.includes('T-3') && modalTxt.includes('Уборка'), 'койка на уборке должна называть причину');

    const bedBtn = allBtns(overlay, 'T-2')[0];
    bedBtn.click();
    findBtn(overlay, 'Положить').click();
    await settle();

    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'admission_admit не вызван');
    assert.deepStrictEqual(call.args, { admission_id: 11, bed_id: 6 });
});

test('отказ сервера доходит до человека словами и окно не закрывается', async () => {
    const root = await renderScreen();
    admitAnswer = () => ({ ok: false, message: 'Койка на уборке — сначала подтвердите уборку.' });

    allBtns(root, 'Положить на койку')[0].click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    allBtns(overlay, 'T-2')[0].click();
    findBtn(overlay, 'Положить').click();
    await settle();

    assert.match(lastToast(), /Койка на уборке/);
    // Кнопка снова активна: человек может выбрать другую койку, а не начинать заново.
    const submit = findBtn(overlay, 'Положить');
    assert.ok(!submit.hasAttribute('disabled'), 'после отказа кнопку надо вернуть в работу');
});

test('«Отменить» открывает окно с обязательной причиной', async () => {
    const root = await renderScreen();
    allBtns(root, 'Отменить')[0].click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Причина отмены'), 'окно отмены обязано спрашивать причину');

    // Пустая причина не уходит на сервер вовсе.
    findBtn(overlay, 'Отменить заявку').click();
    await settle();
    assert.match(lastToast(), /причину отмены/i);
    assert.strictEqual(rpcCalls.filter((c) => c.name === 'admission_order_cancel').length, 0,
        'без причины запрос отправлять нельзя');
});

// ─── 5. Раздел доступен медсестре и недоступен кассиру ──────────────────────

test('окно «Стационар» открывается медсестре и не открывается кассиру', () => {
    // Строки ролей — в том виде, в каком их отдаёт role_permissions после
    // миграции 092 (сама миграция проверяется в server/services/rpc/admission-order.test.js).
    const nurse = { name: 'Медсестра', permissions: { sections: ['patients', 'labs', 'dashboard', 'procedures', 'queue', 'beds'], levels: { beds: 'editor' } } };
    const cashier = { name: 'Кассир', permissions: { sections: ['cashier', 'patients', 'dashboard', 'reports-hub', 'queue'], levels: { cashier: 'admin' } } };

    perms.setEffectiveFromRole(nurse);
    assert.strictEqual(view.canOpenAdmissions(), true, 'медсестра обязана открывать окно, которое для неё и построено');
    assert.strictEqual(perms.isRouteAllowed('admissions'), true, 'маршрут #admissions должен пускать медсестру');
    assert.strictEqual(perms.isModuleAllowed('beds'), true, 'доска коек идёт тем же ключом');

    perms.setEffectiveFromRole(cashier);
    assert.strictEqual(view.canOpenAdmissions(), false, 'кассиру стационар не выдан');
    assert.strictEqual(perms.isRouteAllowed('admissions'), false, 'маршрут #admissions обязан отказать кассиру');

    // Полный доступ (администратор клиники / супер-админ) открывает всё.
    perms.setFullAccess('Admin');
    assert.strictEqual(view.canOpenAdmissions(), true);
});
