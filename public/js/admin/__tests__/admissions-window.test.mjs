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
//   6. ОСМОТР И ЛЕЧАЩИЙ ВРАЧ (Задача 3). Кнопку осмотра видит только тот, кому
//      сервер разрешит её нажать; после осмотра экран сам спрашивает лечащего
//      врача; осмотренный без лечащего стоит в собственной очереди.

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
// INPATIENT_REVIEW_V1 — что этому человеку разрешает СЕРВЕР. Экран спрашивает
// это одним запросом на отрисовку и рисует кнопки по ответу.
let capsAnswer = { admit: true, cancel_order: true, examine: false, set_attending: false };

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
        if (name === 'inpatient_capabilities') return ok({ roles: [], can: capsAnswer });
        if (name === 'admission_reviews_list') return ok({ admission_id: body.admission_id, reviews: [] });
        if (name === 'admission_review_save') {
            return ok({
                review: { id: 501, kind: body.kind, published_at: body.publish ? '2026-09-04T11:00:00Z' : null },
                admission: { id: body.admission_id, status: body.publish && body.kind === 'primary' ? 'examined' : 'admitted' },
                published: !!body.publish,
            });
        }
        // ATTENDING_PICKER_V1 — список лечащих врачей приходит С СЕРВЕРА тем же
        // правилом, которым сервер потом проверяет выбранного (rpc/inpatient-
        // reviews.js admissionAttendingCandidates): экран его не собирает.
        if (name === 'admission_attending_candidates') {
            return ok({ doctors: [{ id: 77, full_name: 'Юсупов А.', specialty: 'Терапия' }], dismissed: 0 });
        }
        if (name === 'admission_set_attending') {
            return ok({ admission: { id: body.admission_id, status: 'active', attending_doctor_id: body.doctor_id } });
        }
        return ok({});
    }
    if (u === '/api/db') {
        if (body.table === 'admissions') return ok(admissionsRows);
        if (body.table === 'beds') return ok(BEDS);
        if (body.table === 'wards') return ok([{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }]);
        if (body.table === 'patients') return ok([]);
        if (body.table === 'users') return ok([{ id: 77, full_name: 'Юсупов А.', specialty: 'Терапия', role: 'doctor', is_doctor: true, license_number: '' }]);
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

// ─── 6. INPATIENT_REVIEW_V1 (Задача 3): осмотр и лечащий врач ───────────────
//
// Что здесь проверяется:
//   • КНОПКУ ОСМОТРА ВИДИТ ТОЛЬКО ТОТ, КТО ВПРАВЕ. Право приходит с сервера
//     (inpatient_capabilities), а не считается в браузере: вторая копия матрицы
//     прав разошлась бы с первой молча. Обычный врач видит подпись «Ждёт
//     главного врача» — и не видит кнопки, которая ответила бы ему отказом.
//   • ОСМОТР УХОДИТ НА СЕРВЕР ПУБЛИКАЦИЕЙ, а не сохранением: publish:true, и
//     «Сохранить черновик» рядом — это ДРУГОЙ запрос.
//   • ПОСЛЕ ОСМОТРА ЭКРАН САМ СПРАШИВАЕТ ЛЕЧАЩЕГО ВРАЧА: искать того же
//     пациента заново в другом списке — потерянный шаг.
//   • ОЧЕРЕДЬ «ЖДУТ ЛЕЧАЩЕГО ВРАЧА» существует: это единственное состояние, в
//     котором пациент лежит, койка считается занятой, а лечения нет.
//   • КТО ОСМОТРЕЛ И КТО ЛЕЧИТ — видно на строке.

const EXAMINED = {
    id: 14, admission_no: 'ADM-00014', status: 'examined', patient_id: 104,
    ward_id: 1, bed_id: 9, department: '', admission_type: 'planned', stay_mode: 'round',
    ordered_at: '2026-09-03T07:00:00Z', admitted_at: '2026-09-03T08:00:00Z',
    examined_at: '2026-09-03T10:00:00Z', attending_doctor_id: null,
    patients: { mrn: 'M-104', full_name: 'Каримова Дилноза' }, wards: { name: 'Терапия' },
    beds: { code: 'T-4' }, users: null, examined: { full_name: 'Главный врач' }, attending: null,
};

test('главный врач видит «Провести первичный осмотр», обычный врач — нет', async () => {
    capsAnswer = { examine: true, set_attending: true, admit: true };
    let root = await renderScreen();
    const exam = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Ждут первичного осмотра'));
    assert.ok(findBtn(exam, 'Провести первичный осмотр'), 'главному врачу кнопка обязана быть видна');

    // Обычный врач: сервер на этот шаг ответит отказом, и экран не предлагает
    // его вовсе — вместо кнопки подпись, кого ждут.
    capsAnswer = { examine: false, set_attending: false, admit: false };
    root = await renderScreen();
    const exam2 = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Ждут первичного осмотра'));
    assert.equal(findBtn(exam2, 'Провести первичный осмотр'), undefined, 'кнопка, которая ответит отказом, — тупик');
    assert.ok(textOf(exam2).includes('Ждёт главного врача'), 'экран обязан сказать, кого ждут');
});

test('осмотр публикуется одним запросом, а черновик — другим', async () => {
    capsAnswer = { examine: true, set_attending: true };
    const root = await renderScreen();
    findBtn(root, 'Провести первичный осмотр').click();
    await settle();

    let overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Сидоров Сидор'), 'пациент — якорь и в окне осмотра');
    for (const label of ['Жалобы', 'Объективно', 'Диагноз', 'План обследования и лечения']) {
        assert.ok(textOf(overlay).includes(label), 'в форме осмотра нет поля «' + label + '»');
    }

    // Без диагноза первичный осмотр не публикуется — и на сервер не уходит.
    findBtn(overlay, 'Опубликовать осмотр').click();
    await settle();
    assert.match(lastToast(), /диагноз/i);
    assert.equal(rpcCalls.filter((c) => c.name === 'admission_review_save').length, 0);

    // Черновик — отдельный запрос, publish:false, окно НЕ закрывается.
    const inputs = walk(overlay).filter((e) => e.tagName === 'TEXTAREA' || e.tagName === 'INPUT');
    inputs.forEach((el, i) => { el.value = 'т' + i; });
    findBtn(overlay, 'Сохранить черновик').click();
    await settle();
    const draft = rpcCalls.find((c) => c.name === 'admission_review_save');
    assert.ok(draft, 'черновик не ушёл на сервер');
    assert.equal(draft.args.publish, false);
    assert.equal(draft.args.admission_id, 13);
    assert.equal(draft.args.kind, 'primary');

    // Публикация — тот же RPC с publish:true.
    findBtn(overlay, 'Опубликовать осмотр').click();
    await settle();
    const pub = rpcCalls.filter((c) => c.name === 'admission_review_save').pop();
    assert.equal(pub.args.publish, true);
    assert.ok(pub.args.diagnosis, 'диагноз уходит на сервер');
});

test('после публикации осмотра экран сразу спрашивает лечащего врача', async () => {
    capsAnswer = { examine: true, set_attending: true };
    const root = await renderScreen();
    findBtn(root, 'Провести первичный осмотр').click();
    await settle();

    let overlay = BODY.children[BODY.children.length - 1];
    walk(overlay).filter((e) => e.tagName === 'INPUT').forEach((el) => { el.value = 'Пневмония'; });
    findBtn(overlay, 'Опубликовать осмотр').click();
    await settle();

    overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Назначить лечащего врача'),
        'после осмотра маршрут ждёт лечащего врача — окно обязано открыться само');

    // Без выбранного врача запрос не уходит.
    findBtn(overlay, 'Назначить').click();
    await settle();
    assert.equal(rpcCalls.filter((c) => c.name === 'admission_set_attending').length, 0);

    const sel = walk(overlay).find((e) => e.tagName === 'SELECT');
    sel.value = '77';
    findBtn(overlay, 'Назначить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_set_attending');
    assert.ok(call, 'admission_set_attending не вызван');
    assert.equal(call.args.doctor_id, 77);
    assert.equal(call.args.admission_id, 13);
});

test('«Ждут лечащего врача» — отдельная очередь, и на строке видно, кто осмотрел', async () => {
    capsAnswer = { examine: true, set_attending: true };
    admissionsRows = [ORDER_REG, ORDER_DOC, IN_BED, EXAMINED];
    const root = await renderScreen();
    admissionsRows = [ORDER_REG, ORDER_DOC, IN_BED];

    const card = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Ждут лечащего врача'));
    assert.ok(card, 'осмотренный пациент без лечащего врача обязан быть виден отдельно');
    assert.ok(textOf(card).includes('Каримова Дилноза'));
    assert.ok(textOf(card).includes('Главный врач'), 'на строке видно, кто осмотрел');
    assert.ok(findBtn(card, 'Назначить лечащего врача'), 'кнопка назначения — здесь');
    // Осмотренный лежит: он и в «В отделении», и подписан «лечащий врач не назначен».
    const inWard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('В отделении'));
    assert.ok(textOf(inWard).includes('Каримова Дилноза'));
    assert.ok(textOf(inWard).includes('лечащий врач не назначен'),
        'лежащий пациент без лечащего врача — недоделанная работа отделения, и видно её отсюда');
});

// ─── 7. ADMISSION_EMBED_FIX — РАЗДЕЛ ОТКРЫВАЕТСЯ, А НЕ ОТКАЗЫВАЕТ ───────────
//
// ЧТО БЫЛО. Владелец сообщил: «заявки стационара недоступны». Права были ни
// при чём (тест 5 выше всегда проходил, и миграция 092 всегда раздавала ключ
// `beds`). Отказывал ЗАПРОС: load() просил `patients(mrn, full_name, phone)`,
// а реестр (server/db/schema-registry.js) разрешает у этого embed'а ровно
// ['id','mrn','full_name']. Компилятор на неразрешённое поле не «пропускает
// лишнее», а отказывает ВСЕМУ запросу — `unknown embed column`, 400
// (server/db/query-compiler.js). load() бросал, экран рисовал одну серую
// строку, и три очереди смены выглядели как пустой раздел.
//
// Мимо тестов это прошло потому, что фальшивый транспорт выше отвечает на
// /api/db, НЕ РАЗБИРАЯ select: экран, ни разу не работавший на настоящем
// сервере, проходил все проверки. Поэтому регрессия ниже берёт СТРОКУ ЗАПРОСА
// ИЗ ИСХОДНИКА ЭКРАНА и прогоняет её через НАСТОЯЩИЙ компилятор с НАСТОЯЩИМ
// реестром — единственный способ поймать этот класс ошибки не на проде.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../../server/db/query-compiler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const ADMISSIONS_SRC = fs.readFileSync(path.join(REPO, 'public/js/admin/views/admissions.js'), 'utf8');

// Достаём аргумент .select(...) из load() — вместе со склейкой строк.
function selectFromSource(src) {
    const at = src.indexOf('.select(');
    assert.ok(at > -1, 'в admissions.js больше нет .select( — тест смотрит не туда');
    let depth = 0, end = -1;
    for (let i = at + '.select'.length; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (!depth) { end = i; break; } }
    }
    assert.ok(end > -1, 'скобки .select( не закрылись');
    const arg = src.slice(at + '.select('.length, end);
    // Аргумент — одна или несколько строк в кавычках, склеенных плюсом
    // ('a, b' + 'c'). Берём СОДЕРЖИМОЕ кавычек и склеиваем: так разбор не
    // зависит ни от переносов, ни от отступов, ни от комментариев рядом.
    const parts = [...arg.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    assert.ok(parts.length, 'в .select( не нашлось ни одной строки');
    return parts.join('');
}


const ADMISSION_SELECT = selectFromSource(ADMISSIONS_SRC);
const compileAdmissions = (columns, user) => compile({
    table: 'admissions', op: 'select', columns,
    filters: [{ col: 'status', op: 'in', val: ['ordered', 'admitted', 'examined', 'active'] }],
    order: [{ col: 'id', asc: false }], limit: 500,
}, user);
// Люди смены — так, как их видит сервер. «Главный врач» и «старшая медсестра» —
// НАДСТРОЙКИ (миграция 091): их носят в extra_roles ПОВЕРХ основной профессии,
// и сервер авторизует по объединению (roles.js effectiveRoles).
const SHIFT_USERS = [
    { role: 'nurse' },
    { role: 'nurse',  extra_roles: ['senior_nurse'] },
    { role: 'doctor', extra_roles: ['head_doctor'] },
    { role: 'doctor' },
    { role: 'registrar' },
    { role: 'admin' },
];
const whoIs = (u) => [u.role, ...(u.extra_roles || [])].join('+');

test('РЕГРЕССИЯ: запрос экрана «Стационар» принимается реестром — для каждой роли смены', () => {
    assert.ok(ADMISSION_SELECT.includes('patients('), 'разобрали не ту строку: ' + ADMISSION_SELECT);
    // Именно этих людей миграция 092 пускает в раздел ключом `beds`.
    for (const user of SHIFT_USERS) {
        assert.doesNotThrow(() => compileAdmissions(ADMISSION_SELECT, user),
            'запрос экрана «Стационар» отвергнут сервером для ' + whoIs(user) + ': раздел не откроется НИ У КОГО');
    }
});

test('РЕГРЕССИЯ: именно `phone` и ронял раздел — реестр отвергает его отказом всему запросу', () => {
    // Отрицательный контроль: верните лишнее поле — и тест выше снова покраснеет.
    const withPhone = ADMISSION_SELECT.replace('patients(mrn, full_name)', 'patients(mrn, full_name, phone)');
    assert.notEqual(withPhone, ADMISSION_SELECT, 'форма запроса изменилась — проверьте контроль');
    assert.throws(() => compileAdmissions(withPhone, { role: 'nurse' }), /unknown embed column/,
        'реестр перестал отвергать лишнее поле — тогда и защищать больше нечего');
    // …и в самом экране его нет. Комментарии снимаем: запись «здесь просили
    // phone, вот чем это кончилось» обязана остаться в коде.
    const exec = ADMISSIONS_SRC.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/patients\([^)]*phone/.test(exec),
        'в admissions.js вернулся `phone`: раздел «Стационар» снова не откроется');
});

test('РЕГРЕССИЯ: отказ загрузки виден КАК СБОЙ, а не как «пациентов нет»', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u === '/api/db') return { ok: false, status: 400, json: async () => ({ error: { message: 'unknown embed column' } }), headers: { getSetCookie: () => [] } };
        return realFetch(url, opts);
    };
    let root;
    try { root = await renderScreen(); } finally { globalThis.fetch = realFetch; }
    const txt = textOf(root);
    assert.ok(txt.includes('Список госпитализаций не загрузился'), 'сбой обязан назваться сбоем');
    assert.ok(txt.includes('это сбой запроса') || txt.includes('Это сбой запроса'),
        'экран не отличает «отдел пуст» от «экран сломан» — владелец увидит пустоту и решит, что заявок нет');
    assert.ok(txt.includes('unknown embed column'), 'причина отказа спрятана от того, кто чинит');
    assert.ok(findBtn(root, 'Повторить'), 'после сбоя человеку нечем попробовать снова');
});

// ─── 8. ТРИ ОЧЕРЕДИ ВИДИТ КАЖДЫЙ, КОМУ РАЗДЕЛ ВЫДАН ────────────────────────

const SHIFT_ROLES = {
    'Медсестра':      ['patients', 'labs', 'dashboard', 'procedures', 'queue', 'beds'],
    'Старшая медсестра': ['patients', 'dashboard', 'queue', 'beds', 'discharge'],
    'Главный врач':   ['patients', 'dashboard', 'consultation', 'beds'],
    'Регистратура':   ['patients', 'dashboard', 'appointments', 'beds'],
};

test('экран рисует свои очереди каждой роли, которой раздел выдан', async () => {
    for (const [name, sections] of Object.entries(SHIFT_ROLES)) {
        perms.setEffectiveFromRole({ name, permissions: { sections, levels: { beds: 'editor' } } });
        assert.strictEqual(perms.isRouteAllowed('admissions'), true, name + ': маршрут #admissions отказал');
        const root = await renderScreen();
        const txt = textOf(root);
        for (const queue of ['Ждут размещения', 'В отделении', 'Ждут первичного осмотра']) {
            assert.ok(txt.includes(queue), name + ': очереди «' + queue + '» нет на экране');
        }
        assert.ok(!txt.includes('Список госпитализаций не загрузился'), name + ': экран открылся сбоем');
        assert.ok(txt.includes('Иванов Иван Иванович'), name + ': заявка не видна');
    }
    perms.setFullAccess('Admin');
});

test('кассиру раздел отказывает чисто — маршрутом, а не пустым экраном', () => {
    perms.setEffectiveFromRole({ name: 'Кассир', permissions: { sections: ['cashier', 'patients', 'dashboard', 'queue'], levels: { cashier: 'admin' } } });
    assert.strictEqual(perms.isRouteAllowed('admissions'), false, 'кассира обязан останавливать МАРШРУТ');
    assert.strictEqual(perms.isModuleAllowed('beds'), false, 'и доска коек тем же ключом');
    assert.strictEqual(view.canOpenAdmissions(), false);
    perms.setFullAccess('Admin');
});
