// MAR_NURSE_V1 — рабочее место медсестры: задачи листа назначений.
//
// Что здесь проверяется и почему именно это:
//   1. ПАЦИЕНТ — ЯКОРЬ. Слева люди, справа задачи выбранного человека, и имя
//      на строке крупнее всего остального. Это защита от «не того пациента», а
//      не раскладка: она должна ломать тест, а не тихо съезжать.
//   2. ЧЕТЫРЕ ГРУППЫ СРОЧНОСТИ приходят с сервера и остаются четырьмя:
//      Просрочено / Сейчас / Позже / По требованию.
//   3. «5 ПРАВ» И АЛЛЕРГИЯ. Подтверждение показывает ровно пять пунктов в
//      закреплённом порядке и красный баннер аллергии, если она есть в карте
//      пациента (patients.allergies).
//   4. ОТКАЗ И ПРОПУСК — ПЕРВОГО КЛАССА. «Не введено» требует выбрать, что
//      случилось, и написать причину; без причины запрос не уходит вовсе.
//      Именно этого пути нет в референсе, и это его худшая дыра.
//   5. PRN ОТМЕЧАЕТСЯ БЕЗ ЧАСА: у «по требованию» плановых точек нет, и слот
//      в запросе сервер отвергнет.
//   6. ДОПОЛНИТЕЛЬНЫЙ РАСХОД (брак / перерасход) уезжает в отметку.
//   7. РАЗДЕЛ ОТКРЫВАЕТСЯ МЕДСЕСТРЕ и не открывается кассе.
//   8а. ПИТАНИЕ — ЗДЕСЬ ЖЕ, НО НИЖЕ ЛЕКАРСТВ (DIET_TABLES_V1). Приёмы пищи
//      медсестра отмечает на своём рабочем месте, а не на третьем экране, куда
//      она зайдёт вечером и заполнит по памяти. Но полоса питания стоит ПОСЛЕ
//      четырёх групп назначений и подписана мельче: несъеденный обед — важная
//      запись, пропущенный антибиотик — вред пациенту, и порядок на экране
//      обязан говорить это сам. Проверяется и то, и другое.
//   8. СВОЮ ОТМЕТКУ СНИМАЮТ ЗДЕСЬ ЖЕ (UNMARK_WINDOW_V1): список «Сделано»
//      показывает кнопку РОВНО там, где сервер разрешил (`undo.allowed`), а где
//      не разрешил — его же словами объясняет, кого звать. Своих часов и своей
//      копии правила у экрана нет: они разошлись бы с сервером молча.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у admissions-window.test.mjs) ───────
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
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
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
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const lastToast = () => {
    const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop();
    return t ? t.textContent : '';
};
const settle = () => new Promise((r) => setTimeout(r, 30));

const nurse = await import('../views/mar-nurse.js');
const perms = await import('../permissions.js');
const { todayLocal } = await import('../views/mar-sheet.js');

const {
    MAR_TASK_GROUPS, MAR_DONE_GROUP, OMISSION_OPTIONS, EXTRA_KINDS,
    patientsFromTasks, tasksForAdmission, fiveRights, allergyOf, extraPayload,
    bedLine, canUndo, undoRefusal, doneLine, renderMarNurse, canOpenMarNurse,
} = nurse;

// ─── данные «сервера» ───────────────────────────────────────────────────────

const TODAY = todayLocal();

const patientA = {
    admission_id: 13, patient_id: 103, patient_name: 'Сидоров Сидор',
    ward_id: 1, ward_name: 'Терапия', bed_id: 5, bed_code: 'T-1',
};
const patientB = {
    admission_id: 14, patient_id: 104, patient_name: 'Каримова Дилноза',
    ward_id: 1, ward_name: 'Терапия', bed_id: 6, bed_code: 'T-2',
};

const TASK_OVERDUE = {
    ...patientA, order_id: 1, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/в',
    source: 'clinic', freq_code: '2x', prn: 0, service_id: null, stock_item_id: 55,
    date: TODAY, slot: 6, due_at: `${TODAY} 06:00`, state: 'missed', late_min: 130,
};
const TASK_NOW = {
    ...patientA, order_id: 2, kind: 'proc', name: 'Перевязка', dose: '', route: null,
    source: 'clinic', freq_code: '1x', prn: 0, service_id: null, stock_item_id: null,
    date: TODAY, slot: 10, due_at: `${TODAY} 10:00`, state: 'delayed', late_min: 20,
};
const TASK_PRN = {
    ...patientA, order_id: 3, kind: 'med', name: 'Кеторол', dose: '1 мл', route: 'в/м',
    source: 'clinic', freq_code: 'prn', prn: 1, service_id: null, stock_item_id: 55,
    date: TODAY, given_today: 1,
};
const TASK_LATER = {
    ...patientB, order_id: 5, kind: 'med', name: 'Омепразол', dose: '20 мг', route: 'внутрь',
    source: 'clinic', freq_code: '1x', prn: 0,
    date: TODAY, slot: 22, due_at: `${TODAY} 22:00`, state: 'pending', late_min: 0,
};

// Закрытые точки. Право снятия сервер уже посчитал и прислал готовым — экран
// его не выводит, а показывает (UNMARK_WINDOW_V1).
const REFUSAL = 'Свою отметку можно снять в течение 15 мин после записи — это время вышло. '
    + 'Дальше снимает старшая медсестра или администратор: позовите её.';
const DONE_MINE = {
    ...patientA, order_id: 7, kind: 'med', name: 'Гепарин', dose: '5000 ЕД', route: 'п/к',
    source: 'clinic', freq_code: '2x', prn: 0, stock_item_id: 55,
    administration_id: 701, status: 'given', date: TODAY, slot: 10,
    given_at: `${TODAY}T09:58:00Z`, given_by: 2, given_by_name: 'Медсестра',
    undo: { allowed: true, scope: 'own', window_min: 15, left_min: 12 },
};
const DONE_LATE = {
    ...patientA, order_id: 8, kind: 'med', name: 'Анальгин', dose: '1 мл', route: 'в/м',
    source: 'clinic', freq_code: '1x', prn: 0, stock_item_id: 55,
    administration_id: 702, status: 'refused', date: TODAY, slot: 8,
    given_at: `${TODAY}T05:00:00Z`, given_by: 2, given_by_name: 'Медсестра',
    undo: { allowed: false, scope: 'late', window_min: 15, message: REFUSAL },
};

const DUE = {
    date: TODAY, now: new Date().toISOString(), ward_id: null,
    counts: { overdue: 1, now: 1, later: 1, prn: 1, done: 2 },
    groups: {
        overdue: [TASK_OVERDUE], now: [TASK_NOW], later: [TASK_LATER], prn: [TASK_PRN],
        done: [DONE_MINE, DONE_LATE],
    },
};

const PATIENTS = [
    { id: 103, allergies: 'Пенициллин, новокаин' },
    { id: 104, allergies: '' },
];

// DIET_TABLES_V1 — лист питания выбранного пациента на сегодня. Разовость
// разворачивает СЕРВЕР (admission_meals_list): «какие приёмы входят в
// 5-разовое» — факт диетологии, а не свойство массива, и браузер его не считает.
const MEALS = {
    13: {
        admission_id: 13, meal_date: TODAY, diet_code: '9', meals_per_day: 5,
        meals: [
            { meal_key: 'breakfast', mark: { status: 'eaten', marked_by: 2 } },
            { meal_key: 'breakfast2', mark: null },
            { meal_key: 'lunch', mark: null },
            { meal_key: 'tea', mark: null },
            { meal_key: 'dinner', mark: null },
        ],
    },
    14: {
        admission_id: 14, meal_date: TODAY, diet_code: null, meals_per_day: null,
        meals: [
            { meal_key: 'breakfast', mark: null },
            { meal_key: 'lunch', mark: null },
            { meal_key: 'tea', mark: null },
            { meal_key: 'dinner', mark: null },
        ],
    },
};

let rpcCalls = [];
let dbCalls = [];
let markWarnings = [];
let markAnswer = () => ({ ok: true, data: { administration: { id: 900 }, already: false, warnings: markWarnings } });
let unmarkWarnings = [];
let unmarkAnswer = () => ({ ok: true, data: { administration: { id: 701 }, already: false, warnings: unmarkWarnings } });

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (name === 'treatment_tasks_due') return ok(DUE);
        if (name === 'admission_meals_list') return ok(MEALS[body.admission_id] || null);
        if (name === 'admission_meal_mark') {
            // Сервер идемпотентен по (госпитализация · дата · приём) — здесь то
            // же: повтор перезаписывает свою строку, а не заводит вторую.
            const sheet = MEALS[body.admission_id];
            const meal = sheet && sheet.meals.find((m) => m.meal_key === body.meal_key);
            if (!meal) return fail('Неизвестный приём пищи.');
            meal.mark = { status: body.status, marked_by: 2 };
            return ok({ meal: { ...meal.mark, meal_key: body.meal_key } });
        }
        if (name === 'treatment_admin_mark') {
            const a = markAnswer();
            return a.ok ? ok(a.data) : fail(a.message);
        }
        if (name === 'treatment_admin_unmark') {
            const a = unmarkAnswer();
            return a.ok ? ok(a.data) : fail(a.message);
        }
        return ok({});
    }
    if (u === '/api/db') {
        dbCalls.push(body);
        if (body.table === 'wards') return ok([{ id: 1, name: 'Терапия' }]);
        if (body.table === 'patients') return ok(PATIENTS);
        return ok([]);
    }
    return ok([]);
};

async function renderScreen() {
    BODY.children.length = 0;
    rpcCalls = []; dbCalls = []; markWarnings = []; unmarkWarnings = [];
    const container = mkEl('div');
    await renderMarNurse(container, { onNavigate: () => {} });
    await settle();
    return container;
}

// ─── 1. Чистые правила ──────────────────────────────────────────────────────

test('четыре группы срочности — те же, что считает сервер, и в том же порядке', () => {
    assert.deepEqual(MAR_TASK_GROUPS.map(([k]) => k), ['overdue', 'now', 'later', 'prn']);
    assert.deepEqual(MAR_TASK_GROUPS.map(([, l]) => l), ['Просрочено', 'Сейчас', 'Позже', 'По требованию']);
});

test('люди собираются из плоского ответа, и просроченные — первыми', () => {
    const people = patientsFromTasks(DUE);
    assert.deepEqual(people.map((p) => p.admission_id), [13, 14],
        'у кого просрочено, тот наверху: сначала решают, к кому идти');
    assert.equal(people[0].counts.overdue, 1);
    assert.equal(people[0].counts.prn, 1);
    assert.equal(people[0].total, 3);
    assert.equal(people[1].counts.later, 1);
    assert.equal(bedLine(people[0]), 'Терапия · койка T-1');
});

test('задачи режутся по выбранному пациенту, а не по всему отделению', () => {
    const mine = tasksForAdmission(DUE, 13);
    assert.deepEqual(mine.overdue.map((t) => t.name), ['Цефтриаксон']);
    assert.deepEqual(mine.now.map((t) => t.name), ['Перевязка']);
    assert.deepEqual(mine.later.map((t) => t.name), []);
    assert.deepEqual(mine.prn.map((t) => t.name), ['Кеторол']);
    assert.deepEqual(tasksForAdmission(DUE, 14).later.map((t) => t.name), ['Омепразол']);
});

test('«5 прав» — пять пунктов в закреплённом порядке', () => {
    const rights = fiveRights(TASK_OVERDUE, patientA);
    assert.deepEqual(rights.map((r) => r.key), ['patient', 'drug', 'dose', 'route', 'time'],
        'порядок сверки читают сверху вниз, вслух, у койки — переставлять его нельзя');
    assert.deepEqual(rights.map((r) => r.label), ['Пациент', 'Препарат', 'Доза', 'Путь введения', 'Время']);
    assert.ok(rights[0].value.includes('Сидоров Сидор') && rights[0].value.includes('T-1'),
        'пациент называется именем И койкой: одного имени в палате на четверых мало');
    assert.equal(rights[1].value, 'Цефтриаксон');
    assert.equal(rights[2].value, '1 г');
    assert.equal(rights[3].value, 'в/в');
    assert.equal(rights[4].value, `${TODAY} 06:00`);
    // У процедуры дозы и пути нет — прочерк, а не пустое место.
    assert.equal(fiveRights(TASK_NOW, patientA)[2].value, '—');
    assert.equal(fiveRights(TASK_NOW, patientA)[3].value, '—');
});

test('аллергия читается из карты пациента, а пустая строка аллергией не считается', () => {
    const map = new Map([[103, 'Пенициллин, новокаин'], [104, '  ']]);
    assert.equal(allergyOf(map, 103), 'Пенициллин, новокаин');
    assert.equal(allergyOf(map, 104), '');
    assert.equal(allergyOf(map, 999), '');
});

test('дополнительный расход собирается в форму сервера, и брак не выставляется пациенту', () => {
    assert.equal(extraPayload([], 55), null);
    assert.equal(extraPayload([{ kind: 'waste', qty: '', note: '' }], 55), null, 'строка без количества не расход');
    assert.equal(extraPayload([{ kind: 'нечто', qty: 2, note: '' }], 55), null, 'неизвестный род расхода не проходит');
    assert.equal(extraPayload([{ kind: 'waste', qty: 2, note: 'ампула' }], null), null,
        'без позиции склада списывать нечего — и сервер записал бы это текстом');

    // Форма — та, которую читает parseExtraConsumption (rpc/treatment-orders.js):
    // массив позиций склада, а не своя структура.
    assert.deepEqual(extraPayload([{ kind: 'waste', qty: '2', note: 'разбита ампула' }], 55),
        [{ product_id: 55, qty: 2, billable: false, name: 'разбита ампула' }],
        'брак списывается со склада, но в счёт пациенту не идёт');
    assert.deepEqual(extraPayload([{ kind: 'overuse', qty: '1', note: '' }], 55),
        [{ product_id: 55, qty: 1, billable: true, name: 'Перерасход' }],
        'перерасход выставляется, как всякий расходник');
    assert.deepEqual(EXTRA_KINDS.map(([k]) => k), ['waste', 'overuse']);
});

// ─── 1б. Своя отметка снимается здесь же (UNMARK_WINDOW_V1) ─────────────────

test('«Сделано» — не пятая группа срочности: работы в нём нет и в счётчик задач он не идёт', () => {
    assert.deepEqual(MAR_TASK_GROUPS.map(([k]) => k), ['overdue', 'now', 'later', 'prn']);
    assert.deepEqual(MAR_DONE_GROUP, ['done', 'Сделано']);

    const people = patientsFromTasks(DUE);
    assert.equal(people[0].counts.done, 2);
    assert.equal(people[0].total, 3, 'сделанное — не задача');

    // Пациент, у которого на сегодня ВСЁ отмечено, из списка не исчезает: пока
    // открыто окно самоисправления, к нему есть зачем вернуться.
    const onlyDone = { groups: { done: [DONE_MINE] } };
    const solo = patientsFromTasks(onlyDone);
    assert.deepEqual(solo.map((p) => p.admission_id), [13]);
    assert.equal(solo[0].total, 0);
    assert.equal(solo[0].counts.done, 1);

    assert.deepEqual(tasksForAdmission(DUE, 13).done.map((t) => t.name), ['Гепарин', 'Анальгин']);
    assert.deepEqual(tasksForAdmission(DUE, 14).done, [], 'чужое сделанное в список не попадает');
});

test('право снятия берётся у сервера, а не считается заново в браузере', () => {
    assert.equal(canUndo(DONE_MINE), true);
    assert.equal(undoRefusal(DONE_MINE), '');
    assert.equal(canUndo(DONE_LATE), false);
    assert.equal(undoRefusal(DONE_LATE), REFUSAL);
    // Ответа нет вовсе (старый сервер) — кнопки тоже нет: молчание не «можно».
    assert.equal(canUndo({ administration_id: 5 }), false);
    // Статус называется словом, а не галочкой.
    assert.equal(doneLine(DONE_MINE), 'Введено · Медсестра');
    assert.equal(doneLine(DONE_LATE), 'Отказ пациента · Медсестра');
});

// ─── 2. Экран ───────────────────────────────────────────────────────────────

test('экран спрашивает задачи на сегодня и ставит пациентов слева со значком просрочки', async () => {
    const root = await renderScreen();
    const calls = rpcCalls.filter((c) => c.name === 'treatment_tasks_due');
    assert.equal(calls.length, 1, 'один запрос задач на открытие');
    assert.equal(calls[0].args.date, TODAY);
    assert.equal('ward_id' in calls[0].args, false, 'без фильтра отделение не передаётся');

    const list = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Пациенты'));
    assert.ok(list, 'списка пациентов нет');
    assert.ok(textOf(list).includes('Сидоров Сидор') && textOf(list).includes('Каримова Дилноза'));
    assert.ok(textOf(list).includes('просрочено: 1'), 'значок просрочки на карточке пациента: ' + textOf(list));

    // ИМЯ — САМОЕ КРУПНОЕ НА СТРОКЕ.
    const name = walk(list).find((e) => (e._text || '') === 'Сидоров Сидор');
    assert.ok(name, 'имя пациента не найдено');
    const nameBox = walk(list).find((e) => e.children.includes(name));
    assert.equal(nameBox.style.fontSize, '17px', 'имя пациента крупнее подписи под ним');
    const bed = walk(list).find((e) => (e._text || '').includes('койка T-1'));
    const bedBox = walk(list).find((e) => e.children.includes(bed));
    assert.equal(bedBox.style.fontSize, '12.5px', 'койка — подпись под именем, а не соперник ему');
});

test('справа — задачи выбранного пациента в четырёх группах и красный баннер аллергии', async () => {
    const root = await renderScreen();
    const txt = textOf(root);
    for (const [, label] of MAR_TASK_GROUPS) assert.ok(txt.includes(label), 'нет группы «' + label + '»');
    assert.ok(txt.includes('Цефтриаксон') && txt.includes('Перевязка') && txt.includes('Кеторол'),
        'задачи выбранного пациента');
    assert.ok(!txt.includes('Омепразол'), 'чужая задача в списке выбранного пациента появиться не может');
    assert.ok(txt.includes('Аллергия') && txt.includes('Пенициллин'), 'аллергия видна ещё до открытия окна');

    // Аллергии спрошены ОДНИМ запросом на всех показанных пациентов.
    const q = dbCalls.filter((c) => c.table === 'patients');
    assert.equal(q.length, 1, 'аллергии грузятся одним запросом, а не по одному на окно');

    // Второй пациент — без аллергии, и баннера у него быть не должно.
    const list = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Пациенты'));
    const btn = walk(list).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('Каримова Дилноза'));
    btn.click();
    await settle();
    const txt2 = textOf(root);
    assert.ok(txt2.includes('Омепразол'), 'переключение пациента меняет правую половину');
    assert.ok(!txt2.includes('Аллергия'), 'у пациента без аллергии красного баннера быть не должно');
});

// ─── 3. «5 прав» и подтверждение ────────────────────────────────────────────

test('«Выполнить» показывает пять прав, аллергию и отмечает дозу как введённую', async () => {
    const root = await renderScreen();
    const overdueCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Просрочено'));
    findBtn(overdueCard, 'Выполнить').click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    const txt = textOf(overlay);
    assert.ok(txt.includes('Подтвердите введение'));
    for (const label of ['Пациент', 'Препарат', 'Доза', 'Путь введения', 'Время']) {
        assert.ok(txt.includes(label), 'в подтверждении нет права «' + label + '»');
    }
    assert.ok(txt.includes('Сидоров Сидор') && txt.includes('T-1'), 'пациент назван именем и койкой');
    assert.ok(txt.includes('Цефтриаксон') && txt.includes('1 г') && txt.includes('в/в'));
    assert.ok(txt.includes(`${TODAY} 06:00`), 'время дозы по расписанию');
    assert.ok(txt.includes('Аллергия') && txt.includes('Пенициллин'),
        'красный баннер аллергии — последнее место, где неверный препарат ещё можно не ввести');

    rpcCalls = [];
    findBtn(overlay, 'Подтвердить введение').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
    assert.ok(call, 'отметка не ушла на сервер');
    assert.equal(call.args.order_id, 1);
    assert.equal(call.args.status, 'given');
    assert.equal(call.args.date, TODAY);
    assert.equal(call.args.slot, 6, 'час дозы уходит на сервер: ключ отметки это (назначение, дата, слот)');
    assert.equal('extra' in call.args, false, 'пустой дополнительный расход не отправляется');
});

test('дополнительный расход у койки уезжает в отметку', async () => {
    const root = await renderScreen();
    const overdueCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Просрочено'));
    findBtn(overdueCard, 'Выполнить').click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Дополнительный расход (брак / перерасход)'),
        'строки брака и перерасхода записывает тот, кто стоит у койки');
    const qty = walk(overlay).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'number');
    const note = walk(overlay).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('Что случилось'));
    const kind = walk(overlay).find((e) => e.tagName === 'SELECT');
    kind.value = 'waste'; qty.value = '2'; note.value = 'разбита ампула';

    rpcCalls = [];
    findBtn(overlay, 'Подтвердить введение').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
    assert.deepEqual(call.args.extra, [{ product_id: 55, qty: 2, billable: false, name: 'разбита ампула' }],
        'форма расхода — та, которую читает сервер, а не своя');
});

test('у назначения без позиции склада расход не предлагают, а объясняют', async () => {
    const root = await renderScreen();
    const nowCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Сейчас'));
    findBtn(nowCard, 'Выполнить').click();   // Перевязка: stock_item_id = null
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('у назначения не указана позиция склада'),
        'пустая форма расхода была бы обещанием, которого сервер не выполнит');
    rpcCalls = [];
    findBtn(overlay, 'Подтвердить введение').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
    assert.equal('extra' in call.args, false);
});

test('предупреждение склада доходит до того, кто стоит у койки', async () => {
    const root = await renderScreen();
    markWarnings = [{ code: 'stock_dose', message: 'не списано: на складе нет остатка' }];
    const overdueCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Просрочено'));
    findBtn(overdueCard, 'Выполнить').click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    findBtn(overlay, 'Подтвердить введение').click();
    await settle();
    assert.match(lastToast(), /не списано/i,
        'пустой остаток не отменяет медицинскую запись, но молчать о нём нельзя');
});

// ─── 4. Отказ и пропуск ─────────────────────────────────────────────────────

test('«Не введено» требует причину, и без неё запрос не уходит вовсе', async () => {
    const root = await renderScreen();
    const overdueCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Просрочено'));
    findBtn(overdueCard, 'Не введено').click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    const txt = textOf(overlay);
    assert.ok(txt.includes('Доза не введена'));
    for (const [, label] of OMISSION_OPTIONS) {
        assert.ok(txt.includes(label), 'в окне нет варианта «' + label + '»');
    }
    assert.ok(txt.includes('Причина'), 'причина спрашивается прямо здесь');

    rpcCalls = [];
    findBtn(overlay, 'Записать').click();
    await settle();
    assert.match(lastToast(), /причину/i);
    assert.equal(rpcCalls.filter((c) => c.name === 'treatment_admin_mark').length, 0,
        'без причины отметка не отправляется — сервер откажет, но сказать это должно окно');

    const statusSel = walk(overlay).find((e) => e.tagName === 'SELECT');
    statusSel.value = 'refused';
    const reason = walk(overlay).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('пациент отказался'));
    reason.value = 'пациент отказался, тошнота';
    findBtn(overlay, 'Записать').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
    assert.ok(call, 'отказ не ушёл на сервер');
    assert.equal(call.args.status, 'refused');
    assert.equal(call.args.reason, 'пациент отказался, тошнота');
    assert.equal(call.args.order_id, 1);
    assert.equal(call.args.slot, 6);
});

test('«по требованию» отмечается БЕЗ часа — плановых точек у него нет', async () => {
    const root = await renderScreen();
    const prnCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('По требованию'));
    assert.ok(textOf(prnCard).includes('Кеторол'));
    rpcCalls = [];
    findBtn(prnCard, 'Выполнить').click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    findBtn(overlay, 'Подтвердить введение').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
    assert.ok(call, 'отметка PRN не ушла');
    assert.equal(call.args.order_id, 3);
    assert.equal('slot' in call.args, false, 'слот у «по требованию» сервер отвергнет — его и не шлём');
    assert.equal(call.args.date, TODAY);
});

// ─── 5. Права ───────────────────────────────────────────────────────────────

test('задачи медсестры открывает отделение и не открывает касса', () => {
    const nurseRole = { name: 'Медсестра', permissions: { sections: ['patients', 'labs', 'procedures', 'queue', 'beds'], levels: { beds: 'editor' } } };
    const cashier = { name: 'Кассир', permissions: { sections: ['cashier', 'patients', 'queue'], levels: { cashier: 'admin' } } };

    perms.setEffectiveFromRole(nurseRole);
    assert.strictEqual(canOpenMarNurse(), true, 'экран построен для медсестры — ей он и открывается');
    assert.strictEqual(perms.isRouteAllowed('mar-nurse'), true);
    assert.strictEqual(perms.isRouteAllowed('kitchen-sheet'), true, 'порционник идёт тем же ключом стационара');

    perms.setEffectiveFromRole(cashier);
    assert.strictEqual(canOpenMarNurse(), false);
    assert.strictEqual(perms.isRouteAllowed('mar-nurse'), false);
    assert.strictEqual(perms.isRouteAllowed('kitchen-sheet'), false, 'заказ на кухню — не документ кассы');

    perms.setFullAccess('Admin');
    assert.strictEqual(canOpenMarNurse(), true);
});

// ─── 8. Снятие своей отметки на экране ──────────────────────────────────────

test('в «Сделано» кнопка стоит у своей свежей отметки, а у остывшей — причина', async () => {
    const root = await renderScreen();
    const doneCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Сделано'));
    assert.ok(doneCard, 'списка «Сделано» нет: снимать промах было бы негде');
    assert.ok(textOf(doneCard).includes('отметок: 2'));
    assert.ok(textOf(doneCard).includes('Гепарин') && textOf(doneCard).includes('Анальгин'));

    const rows = doneCard.children.filter((c) => textOf(c).includes('Гепарин') || textOf(c).includes('Анальгин'));
    const mine = rows.find((r) => textOf(r).includes('Гепарин'));
    const late = rows.find((r) => textOf(r).includes('Анальгин'));
    assert.ok(findBtn(mine, 'Снять отметку'), 'у своей свежей отметки кнопки нет');
    assert.equal(findBtn(late, 'Снять отметку'), undefined, 'кнопка стоит там, где сервер откажет');
    // Не серая кнопка, а СЛОВА сервера: медсестра должна знать, кого звать.
    assert.ok(textOf(late).includes('старшая медсестра'), 'причина отказа: ' + textOf(late));
    assert.ok(textOf(late).includes('позовите'));

    // Сделанное — внизу: сверху то, что надо сделать.
    const cards = walk(root).filter((e) => e.className === 'card');
    assert.ok(cards.indexOf(doneCard) > cards.findIndex((e) => textOf(e).includes('Просрочено')));
});

test('снятие требует причины, а запрос уходит с номером отметки', async () => {
    const root = await renderScreen();
    const doneCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Сделано'));
    const mine = doneCard.children.find((c) => textOf(c).includes('Гепарин'));
    findBtn(mine, 'Снять отметку').click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    const txt = textOf(overlay);
    assert.ok(txt.includes('Сидоров Сидор') && txt.includes('Гепарин'), 'окно называет пациента и препарат');
    assert.ok(txt.includes('Отметка не исчезнет'), 'окно говорит, что снятие остаётся в истории');

    // Без причины запрос НЕ УХОДИТ вовсе.
    rpcCalls = [];
    findBtn(overlay, 'Снять отметку').click();
    await settle();
    assert.equal(rpcCalls.filter((c) => c.name === 'treatment_admin_unmark').length, 0);
    assert.ok(lastToast().includes('Укажите причину'), 'молчаливого отказа быть не должно: ' + lastToast());

    const reason = walk(overlay).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('не ту строку'));
    reason.value = 'нажала не ту строку';
    findBtn(overlay, 'Снять отметку').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_admin_unmark');
    assert.ok(call, 'снятие не ушло на сервер');
    assert.deepEqual(call.args, { administration_id: 701, reason: 'нажала не ту строку' });
    assert.ok(lastToast().includes('Отметка снята'));
    // Экран перечитывает задачи: снятая отметка возвращает час в работу.
    assert.ok(rpcCalls.filter((c) => c.name === 'treatment_tasks_due').length >= 1);
});

test('«строка уже в счёте» доходит до того, кто снял отметку', async () => {
    const root = await renderScreen();
    unmarkWarnings = [{ code: 'invoiced', line_id: 3, message: 'Строка уже в счёте — уберите её через кассу.' }];
    const doneCard = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Сделано'));
    const mine = doneCard.children.find((c) => textOf(c).includes('Гепарин'));
    findBtn(mine, 'Снять отметку').click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    walk(overlay).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('не ту строку')).value = 'ошиблась';
    findBtn(overlay, 'Снять отметку').click();
    await settle();
    // Медицинская запись снята, а деньги остались — молчать об этом нельзя.
    assert.ok(lastToast().includes('через кассу'), 'предупреждение о счёте: ' + lastToast());
});

// ─── 3. Питание (DIET_TABLES_V1) ────────────────────────────────────────────

/** Заголовки карточек в порядке, в каком их читают сверху вниз. */
const headings = (root) => walk(root).filter((e) => e.tagName === 'H3').map((e) => textOf(e));
const headingIndex = (root, label) => headings(root).findIndex((x) => x.includes(label));

test('полоса питания стоит ПОСЛЕ четырёх групп назначений и ДО списка сделанного', async () => {
    const root = await renderScreen();
    const meals = headingIndex(root, 'Питание сегодня');
    assert.ok(meals > -1, 'полосы питания на экране медсестры нет: ' + headings(root).join(' | '));
    // Лекарства — первое, чем этот экран отвечает на вопрос «что сделать
    // сейчас». Питание, поднятое над ними, стоило бы дозы.
    for (const group of ['Просрочено', 'Сейчас', 'Позже', 'По требованию']) {
        assert.ok(headingIndex(root, group) < meals, 'группа «' + group + '» оказалась ниже питания');
    }
    assert.ok(meals < headingIndex(root, 'Сделано'), 'полоса питания уехала под список сделанного');
});

test('питание подписано мельче назначений — приоритет виден размером, а не только порядком', async () => {
    const root = await renderScreen();
    const sized = (label) => walk(root).find((e) => e.style && e.style.fontSize && textOf(e).trim() === label);
    const drug = sized('Цефтриаксон');
    const meal = sized('Обед');
    assert.ok(drug && meal, 'не найдены строки препарата и приёма пищи');
    assert.equal(drug.style.fontSize, '15px');
    assert.equal(meal.style.fontSize, '13.5px', 'приём пищи не должен быть крупнее препарата');
});

test('в шапке полосы названы стол и разовость — то же, что напечатает кухня', async () => {
    const root = await renderScreen();
    const call = rpcCalls.find((c) => c.name === 'admission_meals_list');
    assert.ok(call, 'лист питания не запрошен');
    assert.deepEqual(call.args, { admission_id: 13, meal_date: TODAY });

    const card = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Питание сегодня'));
    const txt = textOf(card);
    assert.ok(txt.includes('Стол №9'), 'стол пациента в полосе питания не назван: ' + txt);
    assert.ok(txt.includes('5-разовое'), 'разовость питания не названа');
    // Пять приёмов — по разовости, а не «все, какие бывают»: шестого нет.
    for (const meal of ['Завтрак', 'Второй завтрак', 'Обед', 'Полдник', 'Ужин']) {
        assert.ok(txt.includes(meal), 'нет приёма пищи «' + meal + '»');
    }
    assert.ok(!txt.includes('На ночь'), 'ночной приём в 5-разовое питание не входит');
    // Уже отмеченный завтрак назван словом, а не галочкой.
    assert.ok(txt.includes('Съеден'), 'отметка сервера не показана');
    assert.ok(txt.includes('Не отмечено'), 'неотмеченный приём обязан говорить это словом');
});

test('медсестра отмечает обед — отметка уходит на сервер и возвращается на экран', async () => {
    const root = await renderScreen();
    const card = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Питание сегодня'));
    const row = card.children.find((c) => textOf(c).includes('Обед'));
    const sel = walk(row).find((e) => e.tagName === 'SELECT');
    assert.ok(sel, 'у приёма пищи нет выбора отметки');

    rpcCalls = [];
    sel.value = 'eaten';
    sel.dispatchEvent({ type: 'change', currentTarget: sel });
    await settle();

    const call = rpcCalls.find((c) => c.name === 'admission_meal_mark');
    assert.ok(call, 'отметка приёма пищи не ушла на сервер');
    assert.deepEqual(call.args, { admission_id: 13, meal_date: TODAY, meal_key: 'lunch', status: 'eaten' });

    // Экран перечитывает лист и показывает то, что ответил сервер, а не то,
    // что нажали: расхождение между ними — как раз то, чем врут листы питания.
    assert.ok(rpcCalls.some((c) => c.name === 'admission_meals_list'), 'лист питания не перечитан');
    const after = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Питание сегодня'));
    const lunch = after.children.find((c) => textOf(c).includes('Обед'));
    assert.ok(textOf(lunch).includes('Съеден'), 'отметка не вернулась в строку: ' + textOf(lunch));
    // Отказ и НПО — не пустая строка: их предлагают наравне с «съеден».
    assert.ok(textOf(lunch).includes('Отказ') && textOf(lunch).includes('НПО'),
        'медсестре нечем сказать, что пациент не ел');

    // Возврат к «Отметить…» ничего не отправляет: это не отметка, а её отсутствие.
    rpcCalls = [];
    const sel2 = walk(lunch).find((e) => e.tagName === 'SELECT');
    sel2.value = '';
    sel2.dispatchEvent({ type: 'change', currentTarget: sel2 });
    await settle();
    assert.equal(rpcCalls.filter((c) => c.name === 'admission_meal_mark').length, 0);
});

test('выбор другого пациента перечитывает ЕГО лист питания, а не оставляет чужой', async () => {
    const root = await renderScreen();
    const people = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Пациенты'));
    rpcCalls = [];
    findBtn(people, 'Каримова Дилноза').click();
    await settle();

    const call = rpcCalls.filter((c) => c.name === 'admission_meals_list').pop();
    assert.ok(call, 'лист питания второго пациента не запрошен');
    assert.equal(call.args.admission_id, 14, 'на экране остался бы лист питания предыдущего пациента');

    const card = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Питание сегодня'));
    const txt = textOf(card);
    // Стол ей не назначен — кухня всё равно её кормит, и полоса это говорит.
    assert.ok(txt.includes('Стол не назначен'), 'пустое место вместо стола: ' + txt);
    assert.ok(txt.includes('Завтрак') && !txt.includes('Второй завтрак'),
        '4-разовое питание не разворачивают в пятиразовое');
});
