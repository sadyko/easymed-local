// STOCK_LOG_V1 — ЖУРНАЛ ДВИЖЕНИЙ: ЧТО ЭКРАН ОБЯЗАН ПОКАЗАТЬ И ЧЕГО НЕ ДЕЛАТЬ.
//
// Что закреплено здесь и почему именно это:
//   1. «КТО» — ИМЯ, А НЕ ПРОЧЕРК. До этой задачи колонка рисовала «—» у КАЖДОЙ
//      строки: запрос просил встраивание `users(…)`, реестр регистрирует его
//      как `created_by`, компилятор отвечал 403 — и вид молча откатывался на
//      выборку без имени. Отказ выглядел как «данных нет», и это главное, что
//      этот файл больше не даст вернуть.
//   2. «КОМУ», «ПАРТИЯ», «СРОК» — НОВЫЕ КОЛОНКИ, и получатель разбирается по
//      виду: сотрудник / кабинет / отдел, а на строке расхода — пациент.
//   3. ФИЛЬТР ПО ДАТАМ ДОЕЗЖАЕТ ДО СЕРВЕРА. Отбор за март не может получиться
//      из последних трёхсот строк, написанных в сентябре, — значит период
//      обязан уходить в запрос, а не применяться в браузере. Проверяется по
//      аргументам НАСТОЯЩЕГО вызова RPC.
//   4. ЭКРАН НЕ ФИЛЬТРУЕТ ЧУЖОЕ. Область видимости считает сервер; экран лишь
//      называет её словами («видны ваши движения»). Молчание на этом месте
//      читалось бы как «в клинике движений нет».
//   5. ОБРЕЗАННЫЙ СПИСОК ГОВОРИТ, ЧТО ОН ОБРЕЗАН.
//   6. ПОЛЕ ПОИСКА ПЕРЕЖИВАЕТ СОБСТВЕННЫЙ ПОИСК (SEARCH_ALIVE_V1). Строка
//      фильтров строится ОДИН раз; перерисовывается только область
//      результатов. Иначе через полсекунды после первой буквы поле, в котором
//      печатают, исчезает вместе с текстом и фокусом, и «парацетамол»
//      набирается в пустоту.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у mar-nurse.test.mjs) ───────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
        // SEARCH_ALIVE_V1 — у стенда появились каретка и фокус: без них он не
        // отличает живое поле ввода от заново созданного пустого.
        this.selectionStart = 0; this.selectionEnd = 0;
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); blurDetached(c); return c; }
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
    focus() { globalThis.document.activeElement = this; }
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
// SEARCH_ALIVE_V1 — узел, ВЫНУТЫЙ ИЗ ДЕРЕВА, ТЕРЯЕТ ФОКУС: так делает браузер,
// и ровно в этом состоит вред перерисовки строки фильтров. Не было бы этого —
// стенд считал бы, что фокус пережил пересоздание поля, и проверка ничего бы
// не ловила.
function blurDetached(node) {
    const doc = globalThis.document;
    if (!doc || !doc.activeElement || !node || typeof node !== 'object') return;
    const holds = (e) => e === doc.activeElement || ((e && e.children) || []).some(holds);
    if (holds(node)) doc.activeElement = null;
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
    activeElement: null,   // SEARCH_ALIVE_V1
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null,
    easymed: { state: { user: { id: 4, role: 'nurse', full_name: 'Медсестра Алиева' } } }, confirm: () => true };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findAll = (root, tag) => walk(root).filter((e) => e.tagName === tag);
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
// SEARCH_ALIVE_V1 — поле поиска ищем КАЖДЫЙ РАЗ ЗАНОВО, по экрану: в этом и
// смысл проверки — тот ли это узел, в который человек печатал.
const searchInput = (root) => walk(root).find((e) => e.tagName === 'INPUT' && /Поиск/.test(e.attrs.placeholder || ''));

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let ANSWER = null;
let FAIL = null;
let ONFETCH = null;   // что успевает случиться, пока журнал ждёт ответ

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (ONFETCH) { const f = ONFETCH; ONFETCH = null; f(); }
        if (FAIL) return { ok: false, status: 400, json: async () => ({ error: { message: FAIL } }), headers: { getSetCookie: () => [] } };
        return { ok: true, status: 200, json: async () => ({ data: ANSWER }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderStockLog, journalQuery, receiverCell, HOLDER_LABEL } = await import('../views/stock-log.js');

// Строки в том виде, в каком их отдаёт rpc/stock-log.js.
const RECEIVE = {
    id: 1, created_at: '2026-09-20T08:00:00Z', kind: 'receive', view_kind: 'receive',
    reference_type: 'manual', reference_id: null,
    product_id: 7, product_name: 'Перчатки', unit: 'уп', qty: 40, unit_cost: 20000, note: '',
    actor_id: 1, actor_name: 'Админ Админов',
    holder_type: '', holder_id: null, holder_name: '',
    batch_no: 'A-117', expiry_date: '2027-05-30', patient_name: '',
};
const TO_DEPT = {
    id: 2, created_at: '2026-09-21T09:00:00Z', kind: 'dispense', view_kind: 'issue',
    reference_type: 'issue', reference_id: null,
    product_id: 7, product_name: 'Перчатки', unit: 'уп', qty: -5, unit_cost: 20000, note: 'на неделю',
    actor_id: 2, actor_name: 'Кладовщик Каримов',
    holder_type: 'department', holder_id: 11, holder_name: 'Кардиология',
    batch_no: '', expiry_date: '', patient_name: '',
};
const TO_STAFF = { ...TO_DEPT, id: 3, holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева', note: '' };
const TO_ROOM = { ...TO_DEPT, id: 4, holder_type: 'room', holder_id: 101, holder_name: 'Кабинет 101', note: '' };
const TO_PATIENT = {
    id: 5, created_at: '2026-09-21T10:00:00Z', kind: 'dispense', view_kind: 'dispense',
    reference_type: 'visit', reference_id: 900,
    product_id: 7, product_name: 'Перчатки', unit: 'уп', qty: -0.02, unit_cost: 20000, note: '',
    actor_id: 4, actor_name: 'Медсестра Алиева',
    holder_type: 'department', holder_id: 11, holder_name: 'Кардиология',
    batch_no: '', expiry_date: '', patient_name: 'Сидоров Сидор',
};

const answer = (movements, extra = {}) => ({
    scope: 'all', departments: [], limit: 200, offset: 0, truncated: false,
    count: movements.length, movements, ...extra,
});

async function open(data) {
    rpcCalls.length = 0; FAIL = null; ANSWER = data;
    const root = mkEl('div');
    await renderStockLog(root);
    await settle();
    return root;
}

// ───────────────────────────────────────────────────────────────────────────

test('журнал спрашивает у сервера свой RPC, а не собирает таблицу запросом из браузера', async () => {
    await open(answer([RECEIVE]));
    assert.deepEqual(rpcCalls.map((c) => c.name), ['stock_movements_list'],
        'экран должен звать stock_movements_list — область видимости считает сервер');
    assert.deepEqual(rpcCalls[0].args, { limit: 200 });
});

test('колонки: «Кому», «Партия» и «Срок» стоят в шапке рядом со старыми', async () => {
    const root = await open(answer([RECEIVE]));
    const heads = findAll(root, 'TH').map((th) => textOf(th).trim());
    assert.deepEqual(heads, ['Когда', 'Товар', 'Тип', 'Кол-во', 'Цена за ед.', 'Кому', 'Партия', 'Срок', 'Основание', 'Кто']);
});

test('«Кто» — имя сотрудника, а не прочерк: ни одна строка не теряет автора', async () => {
    const root = await open(answer([RECEIVE, TO_DEPT, TO_PATIENT]));
    const rows = findAll(root, 'TR').filter((tr) => findAll(tr, 'TD').length);
    assert.equal(rows.length, 3);
    const who = rows.map((tr) => textOf(findAll(tr, 'TD')[9]).trim());
    assert.deepEqual(who, ['Админ Админов', 'Кладовщик Каримов', 'Медсестра Алиева']);
    assert.equal(who.includes('—'), false, 'колонка «Кто» снова рисует прочерк — это и был сломанный внешний ключ');
});

test('партия и срок годности видны в строке прихода', async () => {
    const root = await open(answer([RECEIVE]));
    const cells = findAll(root, 'TD').map((td) => textOf(td).trim());
    assert.equal(cells[6], 'A-117');
    assert.equal(cells[7], '2027-05-30');
    // Строка без партии показывает прочерк, а не пустоту.
    const root2 = await open(answer([TO_DEPT]));
    const c2 = findAll(root2, 'TD').map((td) => textOf(td).trim());
    assert.equal(c2[6], '—');
    assert.equal(c2[7], '—');
});

test('«Кому» называет получателя и его вид — сотрудник, кабинет, отдел', () => {
    assert.equal(textOf(receiverCell(TO_STAFF)).replace(/\s+/g, ' ').trim(), 'Медсестра Алиева Сотрудник');
    assert.equal(textOf(receiverCell(TO_ROOM)).replace(/\s+/g, ' ').trim(), 'Кабинет 101 Кабинет');
    assert.equal(textOf(receiverCell(TO_DEPT)).replace(/\s+/g, ' ').trim(), 'Кардиология Отдел');
    assert.equal(textOf(receiverCell(RECEIVE)).trim(), '—', 'у прихода получателя нет — склад не держатель');
    assert.deepEqual(Object.keys(HOLDER_LABEL).sort(), ['department', 'room', 'staff']);
});

test('расход на пациента назван ПАЦИЕНТОМ: товар ушёл к человеку, а не в кабинет', () => {
    assert.equal(textOf(receiverCell(TO_PATIENT)).replace(/\s+/g, ' ').trim(), 'Сидоров Сидор Пациент');
});

test('получатель ушёл из «Основания»: там остаётся причина, а без причины — прочерк', async () => {
    const root = await open(answer([TO_DEPT, TO_ROOM]));
    const rows = findAll(root, 'TR').filter((tr) => findAll(tr, 'TD').length);
    assert.equal(textOf(findAll(rows[0], 'TD')[8]).trim(), 'на неделю');
    assert.equal(textOf(findAll(rows[1], 'TD')[8]).trim(), '—');
});

test('фильтр по датам ДОЕЗЖАЕТ ДО СЕРВЕРА — иначе журнала за март не будет вовсе', async () => {
    const root = await open(answer([RECEIVE]));
    const dates = findAll(root, 'INPUT').filter((i) => i.attrs.type === 'date');
    assert.equal(dates.length, 2, 'у журнала должно быть два поля даты — «с» и «по»');
    assert.deepEqual(dates.map((i) => i.attrs.title), ['Дата с', 'Дата по']);
    // DATE_LIMITS_V1 — границ у полей нет: срок годности и прошлые периоды
    // набираются руками, правило «не в будущем» принадлежит другим полям.
    assert.equal(dates.some((i) => i.hasAttribute('max')), false, 'журнал не должен запрещать будущую дату');

    rpcCalls.length = 0;
    dates[0].value = '2026-03-01';
    dates[0].dispatchEvent({ type: 'change' });
    await settle();
    assert.equal(rpcCalls.at(-1).args.from, '2026-03-01');

    dates[1].value = '2026-03-31';
    dates[1].dispatchEvent({ type: 'change' });
    await settle();
    assert.deepEqual(rpcCalls.at(-1).args, { limit: 200, from: '2026-03-01', to: '2026-03-31' });
});

test('тип движения тоже уходит в запрос, а не отсеивается в браузере', async () => {
    const root = await open(answer([RECEIVE]));
    const sel = findAll(root, 'SELECT')[0];
    const values = findAll(sel, 'OPTION').map((o) => o.attrs.value);
    assert.deepEqual(values, ['all', 'receive', 'issue', 'dispense', 'adjust', 'void']);
    rpcCalls.length = 0;
    sel.value = 'issue';
    sel.dispatchEvent({ type: 'change' });
    await settle();
    assert.equal(rpcCalls.at(-1).args.kind, 'issue');
    // «Все типы» не уезжает на сервер как вид — это отсутствие отбора.
    sel.value = 'all';
    sel.dispatchEvent({ type: 'change' });
    await settle();
    assert.equal('kind' in rpcCalls.at(-1).args, false);
});

test('поиск товара — параметр запроса, а не фильтр поверх обрезанной выборки', async () => {
    await open(answer([RECEIVE]));
    assert.deepEqual(journalQuery(), { limit: 200 });
});

test('область видимости названа словами: «видны ваши движения», а не пустой экран без объяснения', async () => {
    const own = await open(answer([TO_STAFF], { scope: 'own' }));
    assert.match(textOf(own), /Видны ваши движения/);
    const dept = await open(answer([TO_DEPT], { scope: 'department', departments: [11] }));
    assert.match(textOf(dept), /Видны движения вашего отдела/);
    const all = await open(answer([RECEIVE], { scope: 'all' }));
    assert.equal(/Видны ваши движения|Видны движения вашего отдела/.test(textOf(all)), false,
        'администратору незачем объяснять, что он видит всё');
});

test('пустой журнал — это строка «нет подходящих движений», а не пустая таблица', async () => {
    const root = await open(answer([]));
    assert.match(textOf(root), /Нет подходящих движений/);
});

test('обрезанный список говорит, что он обрезан, и даёт показать ещё', async () => {
    const root = await open(answer([RECEIVE, TO_DEPT], { truncated: true, count: 2, limit: 200 }));
    assert.match(textOf(root).replace(/\s+/g, ' '), /Показаны последние 2 — журнал длиннее/);
    const more = findBtn(root, 'Показать ещё');
    assert.ok(more, 'кнопки «Показать ещё» нет — список обрезан и уйти дальше некуда');
    rpcCalls.length = 0;
    more.click();
    await settle();
    assert.equal(rpcCalls.at(-1).args.limit, 400, 'кнопка должна просить следующую порцию');
});

test('отказ сервера виден: экран говорит о нём, а не рисует пустой журнал', async () => {
    rpcCalls.length = 0; ANSWER = null; FAIL = 'база недоступна';
    const root = mkEl('div');
    await renderStockLog(root);
    await settle();
    assert.match(textOf(root), /Не удалось загрузить движения/);
    FAIL = null;
});

// STOCK_LOG_V1 — ЗАКУПОЧНАЯ ЦЕНА НЕ ЕДЕТ ВМЕСТЕ С ОБЛАСТЬЮ ВИДИМОСТИ.
//
// Журнал был экраном администратора и кладовщика, и колонка «Цена за ед.» —
// закупочная цена — была там уместна. Область видимости («своё / свой отдел /
// вся клиника») открыла журнал медсестре и заведующей, и та же колонка молча
// показала заведующей отделением, почём клиника закупает. Расширение области
// видимости не должно быть расширением видимости ДЕНЕГ: это разные вопросы, и
// решались они одной строкой разметки.
test('закупочная цена видна только тому, кто видит всю клинику', async () => {
    const all = await open(answer([RECEIVE], { scope: 'all' }));
    assert.ok(findAll(all, 'TH').map((th) => textOf(th).trim()).includes('Цена за ед.'),
        'администратор потерял колонку цены — её убирают у отдела, а не у всех');
    assert.match(textOf(all), /20 000/);

    for (const scope of ['department', 'own']) {
        const root = await open(answer([RECEIVE], { scope }));
        const heads = findAll(root, 'TH').map((th) => textOf(th).trim());
        assert.deepEqual(heads, ['Когда', 'Товар', 'Тип', 'Кол-во', 'Кому', 'Партия', 'Срок', 'Основание', 'Кто'],
            'область «' + scope + '» видит закупочную цену клиники');
        assert.equal(/20 000/.test(textOf(root)), false,
            'колонку убрали из шапки, а число осталось в строке — область «' + scope + '»');
        // И строка не разъезжается с шапкой: ячеек ровно столько же.
        const row = findAll(root, 'TR').filter((tr) => findAll(tr, 'TD').length)[0];
        assert.equal(findAll(row, 'TD').length, heads.length);
    }
});

// И ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ ПРАВИЛА: ЦЕНУ СНИМАЕТ СЕРВЕР.
//
// Колонка выше — правило разметки; сервер теперь не присылает закупочную цену
// вовсе никому, кроме области «вся клиника» (rpc/stock-log.js). Экран обязан
// пережить такой ответ: строка с unit_cost = null рисуется целиком, а у
// администратора на месте цены стоит прочерк, а не «null» и не пустая ячейка.
test('строка без закупочной цены рисуется целиком — сервер снял её, экран не сломался', async () => {
    const stripped = { ...RECEIVE, unit_cost: null };
    const all = await open(answer([stripped], { scope: 'all' }));
    const cells = findAll(all, 'TD').map((td) => textOf(td).trim());
    assert.equal(cells.length, 10, 'строка разъехалась с шапкой при пустой цене');
    assert.equal(cells[4], '—', 'на месте снятой цены — «' + cells[4] + '», а должен быть прочерк');
    assert.match(textOf(all), /Перчатки/);

    for (const scope of ['department', 'own']) {
        const root = await open(answer([stripped], { scope }));
        assert.match(textOf(root), /Перчатки/, 'область «' + scope + '» перестала видеть строки');
        assert.equal(/null/.test(textOf(root)), false, 'в таблице напечаталось «null» — область «' + scope + '»');
    }
});

// STOCK_LOG_V1 — У ЖУРНАЛА СВОЙ СЧЁТЧИК ЗАПРОСОВ.
//
// Оболочка держит до трёх смонтированных панелей, и «Журнал движений» живёт
// рядом с «Закупками». Общий fetchGuard закупок означал, что перерисовка
// любой их вкладки отменяет отрисовку журнала: журнал оставался пустым, а
// причины на экране не было. Тот же довод и то же решение, что у «Моих
// запасов» (views/my-stock.js).
test('чужая перерисовка не отменяет журнал: счётчик запросов у него свой', async () => {
    const root = await open(answer([RECEIVE]));
    const { fetchGuard } = await import('../views/inventory-shared.js');
    // Пока журнал ждёт ответ, соседняя панель «Закупок» перерисовывает себя.
    ONFETCH = () => { fetchGuard.token += 1; };
    const sel = findAll(root, 'SELECT')[0];
    sel.value = 'issue';
    sel.dispatchEvent({ type: 'change' });
    await settle();
    assert.match(textOf(root), /Перчатки/,
        'журнал отменил САМ СЕБЯ из-за перерисовки соседней панели — и остался пустым молча');
});

// I2 / SEARCH_DEBOUNCE_V1 — КАЖДЫЙ СИМВОЛ НЕ ПЕРЕСЧИТЫВАЕТ КЛИНИКУ.
//
// better-sqlite3 синхронна: запрос журнала блокирует сервер целиком, и поиск
// «на каждый символ» означал бы, что клиника замирает на всё время, пока
// кладовщик набирает название товара.
//
// Задержка здесь НЕ СВОЯ. Она одна на все поисковые поля программы и живёт в
// ui.js (h() оборачивает 'input' у полей с подсказкой «Поиск…», 500 мс) —
// поэтому чинить тут нечего, а закрепить есть что: переименуй кто-нибудь
// подсказку на «Найти товар», и поле молча выпадет из общего правила, а
// заметит это клиника, а не тест.
test('поиск ждёт паузы в наборе: три символа подряд — ОДИН запрос, а не три', async () => {
    const root = await open(answer([RECEIVE]));
    const q = walk(root).find((e) => e.tagName === 'INPUT' && /Поиск/.test(e.attrs.placeholder || ''));
    assert.ok(q, 'поля поиска на экране нет — тест смотрит не туда');

    rpcCalls.length = 0;
    for (const typed of ['п', 'пе', 'пер']) { q.value = typed; q.dispatchEvent({ type: 'input' }); }
    await settle();
    assert.equal(rpcCalls.length, 0, 'запрос ушёл, не дождавшись паузы: набор из трёх символов — три блокировки базы');

    await new Promise((r) => setTimeout(r, 700));
    assert.equal(rpcCalls.length, 1, 'на три символа ушло запросов: ' + rpcCalls.length);
    assert.equal(rpcCalls[0].args.q, 'пер', 'ушёл не последний набранный текст');
});

// SEARCH_ALIVE_V1 — ПОЛЕ, В КОТОРОМ ПЕЧАТАЮТ, ПЕРЕЖИВАЕТ СВОЙ СОБСТВЕННЫЙ
// ПОИСК.
//
// Задержка набора (SEARCH_DEBOUNCE_V1) и перерисовка всего экрана вместе дают
// поломку, которой поодиночке нет ни у той, ни у другой: человек набирает
// «парацетамол», через полсекунды после первых букв уходит запрос, ответ
// перерисовывает экран целиком — и поле ввода ПЕРЕСОЗДАЁТСЯ. Дальше буквы
// летят в узел, которого на экране уже нет: текст обрывается на середине
// слова, каретка пропадает, и клиника видит это на первом же поиске.
//
// Лечится не подкладыванием фокуса обратно, а тем, что узел не умирает:
// органы управления строятся один раз, перерисовывается только область
// результатов (тот же приём, что у очереди лаборатории — views/laboratory.js,
// refs.searchInp живёт в шапке окна, а paintRows() трогает только список).
test('поиск не убивает поле, в котором печатают: узел тот же, текст и каретка на месте, фокус не потерян', async () => {
    const root = await open(answer([RECEIVE]));
    const q = searchInput(root);
    assert.ok(q, 'поля поиска на экране нет — тест смотрит не туда');
    q.focus();

    rpcCalls.length = 0;
    ANSWER = answer([TO_DEPT]);   // сервер ответит ДРУГИМИ строками — видно, что список обновился
    for (const typed of ['пара', 'парацет', 'парацетамол']) { q.value = typed; q.dispatchEvent({ type: 'input' }); }
    q.setSelectionRange(11, 11);
    await new Promise((r) => setTimeout(r, 700));   // пауза набора, ответ сервера, перерисовка

    assert.equal(rpcCalls.length, 1, 'запросов ушло: ' + rpcCalls.length);
    assert.equal(rpcCalls[0].args.q, 'парацетамол');
    assert.equal(searchInput(root), q,
        'поле поиска ПЕРЕСОЗДАНО: остаток слова человек допечатывает в узел, которого уже нет на экране');
    assert.equal(q.value, 'парацетамол', 'набранный текст пропал вместе со старым узлом');
    assert.equal(document.activeElement, q, 'фокус выбросило из поля поиска на середине слова');
    assert.equal(q.selectionStart, 11, 'каретка сброшена');
    assert.match(textOf(root), /Кардиология/, 'область результатов не обновилась — перерисовали не то');
});

test('смена фильтра перерисовывает список и не уводит фокус с органа управления', async () => {
    const root = await open(answer([RECEIVE]));
    const kind = findAll(root, 'SELECT')[0];
    const q = searchInput(root);
    kind.focus();

    ANSWER = answer([TO_DEPT]);
    kind.value = 'issue';
    kind.dispatchEvent({ type: 'change' });
    await settle();

    assert.equal(findAll(root, 'SELECT')[0], kind, 'фильтр пересоздан — список закрылся бы прямо под рукой');
    assert.equal(document.activeElement, kind, 'перерисовка увела фокус с фильтра, которым только что пользовались');
    assert.equal(searchInput(root), q, 'смена фильтра снесла поле поиска вместе с набранным');
    assert.match(textOf(root), /Кардиология/, 'список не обновился');
});

test('«Показать ещё» дорисовывает журнал и не отбирает поле поиска у того, кто в нём печатает', async () => {
    const root = await open(answer([RECEIVE], { truncated: true, count: 1 }));
    const q = searchInput(root);
    q.value = 'пар';
    q.focus();

    const more = findBtn(root, 'Показать ещё');
    assert.ok(more, 'кнопки «Показать ещё» нет — тест смотрит не туда');
    ANSWER = answer([RECEIVE, TO_DEPT], { truncated: false, count: 2 });
    more.click();
    await settle();

    // Сам щелчок фокуса не двигает (это делает браузер, а не экран): здесь
    // ловится ровно одно — перерисовка выдернула поле из дерева вместе с
    // текстом и фокусом.
    assert.equal(searchInput(root), q, 'кнопка «Показать ещё» пересоздала поле поиска');
    assert.equal(q.value, 'пар', 'набранное в поиске стёрлось кнопкой «Показать ещё»');
    assert.equal(document.activeElement, q, 'перерисовка по кнопке выбросила фокус из поля поиска');
    assert.match(textOf(root), /Кардиология/, 'журнал не дорисовался');
});

// PROCUREMENT_FILTERS_V1 — отступ окна журнала: строка о видимости и таблица
// стояли вплотную к рамке (у .card своего отступа нет — он в .card-pad-sm).
test('отступы: результаты журнала — внутри .card-pad-sm, шапка с фильтрами во всю ширину', async () => {
    const root = await open(answer([RECEIVE], { scope: 'own' }));
    const card = walk(root).find((e) => e.className === 'card');
    assert.ok(card, 'окна журнала нет');
    assert.equal(card.children[0].className, 'card-header');
    const body = card.children[1];
    assert.equal(body.className, 'card-pad-sm', 'результаты стоят вплотную к рамке');
    assert.equal(findAll(body, 'TABLE').length, 1);
    // Строка о видимости — первой, внутри отступа, а не вплотную к рамке.
    assert.match(textOf(body.children[0]), /Видны ваши движения/);
});
