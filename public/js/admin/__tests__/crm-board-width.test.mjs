// CRM_BOARD_WIDTH_V1 (2026-09-05) — ШИРИНА КОЛОНКИ ДОСКИ ЗАЯВОК.
//
// Владелец: «can you increase the width of the cards or width of the columns or
// both», со снимком доски, на котором ФИО ложились в две и три строки:
// «Носирова Мамлакат Асроровна», «Раимқулова Мухлиса», «Эгамбердиева Умида
// Хайрулла қизи». Колонка была minmax(215px, 1fr), и карточка CRM_CARD_V2
// подгонялась под её минимум — вёрстка исправна, читать нечем.
//
// ЭТОТ ФАЙЛ ДЕРЖИТ ЧИСЛА И ИХ ИСТОЧНИК. Тесты ниже не проверяют «в CSS написано
// 258px» — они берут вилку и обвязку ИЗ CSS, считают внутреннюю ширину карточки
// и сверяют её с шириной, которая настоящему имени настоящим шрифтом
// действительно нужна.
//
// ОТКУДА ВЗЯТЫ ШИРИНЫ СТРОК (таблица MEASURED ниже). Они сняты офлайн-замером
// из тех самых файлов шрифта, что лежат в public/fonts и уезжают в клинику:
// woff2 распакован, прочитаны cmap/hmtx/HVAR/fvar/GSUB, и для каждой строки
// просуммированы настоящие advance-ширины глифов —
//   • имя: 15px, wght 700 (HVAR-дельты переменной оси, а не «жирный на глаз»);
//   • номер: 13.5px, wght 600, letter-spacing .01em и подстановка `tnum` —
//     у карточки font-variant-numeric: tabular-nums, а собственные цифры Onest
//     пропорциональные, так что мерить «как набрано» значило бы промахнуться
//     на 8px;
//   • перенос — тем же жадным правилом, что и в браузере: по пробелам, слева
//     направо; «сколько нужно на N строк» — наименьшая ширина, при которой
//     жадный перенос даёт не больше N строк.
// Числа устаревают ровно в одном случае — если сменится шрифт. Поэтому файлы
// шрифта пришпилены хэшем (последний тест): смена шрифта роняет этот тест с
// требованием пересчитать, а не тихо оставляет вёрстку на старых числах.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STAGES } from '../crm-settings-logic.js';

// ---------------------------------------------------------------------------
// Поддельный DOM. Тот же, что в crm-card.test.mjs, плюс то, без чего нельзя
// проверить ПЕРЕТАСКИВАНИЕ: связь с родителем (closest), dataset, cloneNode,
// прямоугольники и слушатели на document.
// ---------------------------------------------------------------------------
function matches(node, sel) {
    return String(sel).split(',').map((s) => s.trim()).some((s) => {
        if (!s) return false;
        if (s.startsWith('[') && s.endsWith(']')) {
            const k = s.slice(1, -1);
            return node.attrs && k in node.attrs;
        }
        if (s.startsWith('.')) return String(node.className || '').split(/\s+/).includes(s.slice(1));
        return node.tagName === s.toUpperCase();
    });
}
class F {
    constructor(t) {
        this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; this.parent = null;
    }
    appendChild(c) { this.children.push(c); if (c) c.parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'value') this.value = String(v);
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); } }
    dispatchEvent(e) { for (const fn of (this._l[e.type] || []).slice()) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {} scrollTo() {} select() {}
    remove() { if (this.parent) this.parent.removeChild(this); }
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parent; } return null; }
    cloneNode() { const c = new F(this.tagName); c.className = this.className; c.attrs = { ...this.attrs }; c.style = { ...this.style }; return c; }
    getBoundingClientRect() { const r = this._rect || { left: 0, top: 0, width: 240, height: 120 }; return { ...r, right: r.left + r.width, bottom: r.top + r.height }; }
    querySelector(sel) {
        const stack = [...this.children];
        while (stack.length) { const n = stack.shift(); if (n && matches(n, sel)) return n; if (n && n.children) stack.push(...n.children); }
        return null;
    }
    querySelectorAll() { return []; }
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const docListeners = {};
let elementAtPoint = null;
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    addEventListener(t, fn) { (docListeners[t] || (docListeners[t] = [])).push(fn); },
    removeEventListener(t, fn) { const a = docListeners[t]; if (a) { const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); } },
    getElementById() { return null; },
    elementFromPoint() { return elementAtPoint; },
};
const fire = (type, ev) => { for (const fn of (docListeners[type] || []).slice()) fn({ type, preventDefault() {}, stopPropagation() {}, ...ev }); };

const store = new Map();
const fakeLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener() {}, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
// Кадры НЕ прокручиваем: единственный их потребитель здесь — автопрокрутка
// доски у края при перетаскивании, а вызов колбэка на месте закрутил бы
// бесконечный цикл (tick заказывает следующий кадр сам).
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let LEADS = [];
const WRITES = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (u.startsWith('/api/rpc/')) return jsonOk({});
    if (u.startsWith('/api/db')) {
        if (body && body.op && body.op !== 'select') WRITES.push(body);
        if (body && body.table === 'crm_requests' && body.op === 'select') return jsonOk(LEADS);
        return jsonOk([]);
    }
    return jsonOk([]);
};

const { renderCrm } = await import('../views/crm.js');

async function board(leads) {
    LEADS = leads;
    const root = mk('div');
    await renderCrm(root, { onNavigate() {} });
    await tick();
    return root;
}

// ---------------------------------------------------------------------------
// CSS — читаем то же, что грузит браузер
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_DIR = path.resolve(HERE, '..', '..', '..', 'css');
const strip = (s) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const VIEWS = strip(fs.readFileSync(path.join(CSS_DIR, 'admin-views.css'), 'utf8'));
const ADMIN = strip(fs.readFileSync(path.join(CSS_DIR, 'admin.css'), 'utf8'));
const CRM_JS = fs.readFileSync(path.resolve(HERE, '..', 'views', 'crm.js'), 'utf8');

function rule(css, selector) {
    const out = {};
    let at = 0, found = 0;
    for (;;) {
        const i = css.indexOf(selector + ' {', at);
        if (i === -1) break;
        at = i + selector.length;
        const before = css[i - 1];
        if (before && !'\n};'.includes(before)) continue;
        found++;
        for (const part of css.slice(i + selector.length + 2, css.indexOf('}', i)).split(';')) {
            const j = part.indexOf(':');
            if (j === -1) continue;
            out[part.slice(0, j).trim()] = part.slice(j + 1).trim();
        }
    }
    assert.ok(found > 0, `правило «${selector}» пропало из CSS`);
    return out;
}
const px = (v) => { const n = parseFloat(String(v)); assert.ok(Number.isFinite(n), `не число: ${v}`); return n; };
/** «10px 12px» → боковое поле */
const sidePad = (v) => { const p = String(v).trim().split(/\s+/); return px(p.length === 1 ? p[0] : p[1]); };

const BOARD = rule(VIEWS, '.crm-board');
const COL = rule(VIEWS, '.crm-col');
const LIST = rule(VIEWS, '.crm-col-list');
const CARD = rule(VIEWS, '.crm-card');
const CARD_BASE = rule(ADMIN, '.card');

const track = /minmax\(\s*([\d.]+)px\s*,\s*([\d.]+)px\s*\)/.exec(BOARD['grid-auto-columns'] || '');
assert.ok(track, 'у .crm-board пропала вилка minmax(min, max) — ширина колонки больше ниоткуда не следует');
const COL_MIN = parseFloat(track[1]);
const COL_MAX = parseFloat(track[2]);
const GAP = px(BOARD.gap);

// Обвязка между краем колонки и текстом карточки — считается, а не вписывается.
const CHROME = 2 * px(CARD_BASE.border) + 2 * sidePad(COL.padding)      // колонка: рамка + поля
             + 2 * sidePad(LIST.padding)                                // список карточек
             + 2 * px(CARD.border) + 2 * sidePad(CARD.padding);         // карточка: рамка + поля
const CONTENT_MIN = COL_MIN - CHROME;
const CONTENT_MAX = COL_MAX - CHROME;
const OLD_COL = 215;   // как было до этой правки
const OLD_CONTENT = OLD_COL - CHROME;

// ---------------------------------------------------------------------------
// ЗАМЕРЫ (px). Метод — в шапке файла.
// ---------------------------------------------------------------------------
const MEASURED = {
    // Имена: [во сколько px встаёт в ОДНУ строку, сколько нужно на ≤2 строки]
    names: {
        'Носирова Мамлакат Асроровна':          { one: 237.6, twoLines: 152 },   // снимок владельца
        'Раимқулова Мухлиса':                   { one: 159.9, twoLines: 60 },    // снимок владельца
        'Эгамбердиева Умида Хайрулла қизи':     { one: 275.0, twoLines: 160 },   // снимок владельца
        'Абдурахмонова Мамлакат Икромжон қизи': { one: 320.2, twoLines: 198 },   // самое длинное в корпусе 1200 ФИО
        'Абдурахмонов Шухратбек Улугбек ўғли':  { one: 299.3, twoLines: 186 },   // из crm-card.test.mjs
    },
    // Строка телефона целиком: иконка 13 + зазор 6 + сам номер.
    phoneRow: 13 + 6 + 134.1,
    // Номер, ставший ЗАГОЛОВКОМ (лид от АТС): 15px/700, tabular-nums.
    phoneAsTitle: 149.5,
    // «Телефона нет» на трёх языках — 13.5px/500, с иконкой и зазором.
    noPhoneRow: { ru: 13 + 6 + 124.2, uz: 13 + 6 + 143.4, en: 13 + 6 + 113.9 },
    // Доля корпуса из 1200 узбекских ФИО, влезающая в две строки.
    corpusFitsTwoLines: { 155: 78.3, 170: 95.6, 186: 99.4, 198: 100 },
};

// ═══ 1. ИМЯ ═════════════════════════════════════════════════════════════════

test('длинное узбекское ФИО помещается в ДВЕ строки — на минимальной ширине колонки, а не на удачной', () => {
    for (const [name, m] of Object.entries(MEASURED.names)) {
        assert.ok(CONTENT_MIN >= m.twoLines,
            `«${name}» просит ${m.twoLines}px на две строки, а в самой узкой колонке (${COL_MIN}px) под текст ` +
            `остаётся ${CONTENT_MIN}px — значит на доске оно снова трёхстрочное`);
    }
});

test('короткое ФИО из двух слов встаёт в ОДНУ строку', () => {
    const m = MEASURED.names['Раимқулова Мухлиса'];
    assert.ok(CONTENT_MIN >= m.one,
        `«Раимқулова Мухлиса» это ${m.one}px в одну строку, а под текст остаётся ${CONTENT_MIN}px: ` +
        'имя из двух слов на двух строках — ровно то, на что владелец и жаловался');
});

test('на прежних 215px эти же имена не помещались — числа описывают настоящую жалобу, а не подогнаны', () => {
    assert.ok(OLD_CONTENT < MEASURED.names['Эгамбердиева Умида Хайрулла қизи'].twoLines,
        'выходит, что и старая колонка держала имя в две строки — тогда правка чинит не то, на что жаловались');
    assert.ok(OLD_CONTENT < MEASURED.names['Раимқулова Мухлиса'].one);
    assert.strictEqual(MEASURED.corpusFitsTwoLines[155], 78.3,
        'на 155px в две строки помещались 78% корпуса — каждое пятое имя было трёхстрочным');
    assert.strictEqual(MEASURED.corpusFitsTwoLines[198], 100);
});

test('верхняя граница вилки выведена из имени, а не выбрана «покрасивее»', () => {
    assert.ok(COL_MAX > COL_MIN, 'вилка схлопнулась в одну ширину');
    const longest = MEASURED.names['Эгамбердиева Умида Хайрулла қизи'].one;
    assert.ok(CONTENT_MAX >= longest,
        `максимум колонки (${COL_MAX}px) не даёт самому длинному имени со снимка (${longest}px) встать в одну строку`);
    // И не шире, чем это нужно: иначе карточка заявки превращается в страницу.
    assert.ok(CONTENT_MAX < longest + 40,
        `максимум ${COL_MAX}px шире, чем нужно самому длинному имени, — лишние пиксели карточке ничего не покупают`);
});

// ═══ 2. НОМЕР ═══════════════════════════════════════════════════════════════

test('номер помещается целиком и с запасом — многоточию взяться неоткуда', () => {
    assert.ok(CONTENT_MIN >= MEASURED.phoneRow,
        `строка телефона просит ${MEASURED.phoneRow.toFixed(1)}px, а есть ${CONTENT_MIN}px`);
    // Запас, а не «впритык»: на старой ширине его было 1.9px, и любая правка
    // полей карточки молча превращала номер в «+998 94 566 9…».
    assert.ok(CONTENT_MIN - MEASURED.phoneRow >= 20,
        `под номером всего ${(CONTENT_MIN - MEASURED.phoneRow).toFixed(1)}px запаса — столько же, сколько было до правки`);
    assert.ok(OLD_CONTENT - MEASURED.phoneRow < 5, 'проверка самих чисел: до правки номер стоял впритык');
});

test('карточка без имени: номер-заголовок и «телефона нет» на трёх языках помещаются', () => {
    assert.ok(CONTENT_MIN >= MEASURED.phoneAsTitle,
        'номер, ставший заголовком (лид от АТС), обрезается многоточием');
    for (const [lang, w] of Object.entries(MEASURED.noPhoneRow)) {
        assert.ok(CONTENT_MIN >= w, `«телефона нет» на ${lang} (${w.toFixed(1)}px) не помещается в ${CONTENT_MIN}px`);
    }
    // Узбекское «Telefon koʻrsatilmagan» — 162.4px — не помещалось в старые 155px:
    // на снимке владельца оно и стояло обрезанным.
    assert.ok(OLD_CONTENT < MEASURED.noPhoneRow.uz);
});

// ═══ 3. ДОСКА: МАЛО СТУПЕНЕЙ И МНОГО ════════════════════════════════════════

// Рабочее окно доски на обычном ноутбуке — считается из шелла, а не из головы:
// экран − боковая панель − поля страницы − поля и рамка белого окна.
function boardWindow(screen) {
    const sidebar = px(rule(ADMIN, ':root')['--sidebar-w']);
    const contentPad = sidePad(rule(ADMIN, '.content').padding);
    const windowPad = sidePad(rule(ADMIN, '.card-pad-sm').padding);
    return screen - sidebar - 2 * contentPad - 2 * windowPad - 2 * px(CARD_BASE.border);
}
/** Ширина трека при N ступенях в окне w — правило раскладки grid для minmax(min, max). */
function trackWidth(n, w) {
    const gaps = (n - 1) * GAP;
    if (n * COL_MAX + gaps <= w) return COL_MAX;
    if (n * COL_MIN + gaps <= w) return (w - gaps) / n;
    return COL_MIN;
}
const totalWidth = (n, w) => n * trackWidth(n, w) + (n - 1) * GAP;

test('воронка из трёх ступеней заполняет окно, а не жмётся в углу', () => {
    for (const screen of [1366, 1440]) {
        const w = boardWindow(screen);
        const fill = totalWidth(3, w) / w;
        assert.ok(fill >= 0.9,
            `на экране ${screen}px три ступени занимают ${(100 * fill).toFixed(0)}% окна (${totalWidth(3, w).toFixed(0)} из ${w}px)`);
        assert.ok(totalWidth(3, w) <= w + 0.5, 'три ступени не помещаются в окно — доска поехала бы вбок без нужды');
    }
});

test('воронка по умолчанию (восемь ступеней) прокручивается вбок, и прокрутке есть чем работать', () => {
    const stages = DEFAULT_STAGES.filter((s) => s.is_active).length;
    assert.strictEqual(stages, 8, 'воронка по умолчанию перестала быть восьмиступенчатой — числа ниже про другую доску');
    for (const screen of [1366, 1440, 1920]) {
        const w = boardWindow(screen);
        assert.strictEqual(trackWidth(stages, w), COL_MIN,
            `на ${screen}px восемь ступеней должны сжаться до минимума — иначе имя опять не помещается`);
        assert.ok(totalWidth(stages, w) > w, `на ${screen}px восемь ступеней внезапно помещаются целиком`);
    }
    assert.strictEqual(BOARD['overflow-x'], 'auto',
        'доска перестала прокручиваться вбок — восемь ступеней просто не увидеть');
    // Ступеней может быть и больше: их число настраивается, и разметка про него
    // ничего не знает — треки создаются по одному на колонку.
    assert.strictEqual(BOARD['grid-auto-flow'], 'column');
});

test('колонок на доске ровно столько, сколько ступеней в воронке, и геометрии в разметке не осталось', async () => {
    const root = await board([{ id: 1, status: 'in_process', source: 'call', full_name: 'Носирова Мамлакат Асроровна', phone: '998945669203', created_at: '2026-09-03T10:12:00Z' }]);
    const cols = byClass(root, 'crm-col');
    assert.strictEqual(cols.length, DEFAULT_STAGES.filter((s) => s.is_active).length);
    const brd = walk(root).find((n) => 'data-crm-board' in n.attrs);
    assert.ok(brd, 'доска потеряла data-crm-board — перетаскивание перестанет находить её для автопрокрутки');
    assert.ok(hasClass(brd, 'crm-board'), 'доска потеряла класс .crm-board — вместе с ним ушла вся её раскладка');
    assert.ok(!/gridTemplateColumns|minmax\(/.test(CRM_JS),
        'ширина колонки снова задана инлайном в crm.js — число уехало от расчёта, который его объясняет');
    assert.ok(!/215px/.test(CRM_JS));
    // Колонка и список карточек тоже держат поля в CSS: из них считается
    // внутренняя ширина карточки, и разъехаться этим двум местам нельзя.
    assert.strictEqual(byClass(root, 'crm-col-list').length, cols.length);
    for (const c of cols) assert.ok(!c.style.padding, 'поля колонки вернулись в разметку');
});

// ═══ 4. ПЕРЕТАСКИВАНИЕ ══════════════════════════════════════════════════════

test('карточку по-прежнему можно перетащить в другую колонку', async () => {
    const root = await board([{ id: 7, status: 'in_process', source: 'call', full_name: 'Носирова Мамлакат Асроровна', phone: '998945669203', created_at: '2026-09-03T10:12:00Z' }]);
    const card = byClass(root, 'crm-card')[0];
    assert.ok(card, 'карточки на доске нет — тащить нечего');
    card._rect = { left: 40, top: 100, width: COL_MIN - 34, height: 120 };
    const target = byClass(root, 'crm-col').find((c) => c.dataset.col === 'recall');
    assert.ok(target, 'колонка «Перезвонить» пропала с доски');
    const brd = card.closest('[data-crm-board]');
    assert.ok(brd, 'карточка не находит доску — автопрокрутка у края работать не будет');
    brd._rect = { left: 0, top: 0, width: 1102, height: 600 };

    // Фоновая автоматика load() («не пришёл» по просроченной записи) тоже пишет
    // в crm_requests — считаем только то, что написал сам жест.
    WRITES.length = 0;
    card.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', pointerId: 1, clientX: 60, clientY: 120, target: card, preventDefault() {}, stopPropagation() {} });
    elementAtPoint = target;
    fire('pointermove', { clientX: 400, clientY: 160 });   // больше порога в 7px — жест начался
    fire('pointermove', { clientX: 420, clientY: 165 });
    fire('pointerup', { clientX: 420, clientY: 165 });
    await tick(60);

    const upd = WRITES.find((w) => w.table === 'crm_requests' && w.op === 'update'
        && (w.filters || []).some((f) => f.col === 'id' && f.val === 7));
    assert.ok(upd, 'перетаскивание не дошло до базы: статус заявки не изменился');
    assert.strictEqual(upd.values.status, 'recall', 'заявка уехала не в ту колонку, над которой её отпустили');
});

// ═══ 5. ЧИСЛА НЕ УСТАРЕЛИ ═══════════════════════════════════════════════════

test('шрифт тот же, из которого сняты ширины', () => {
    const dir = path.join(CSS_DIR, '..', 'fonts');
    const h = crypto.createHash('sha256');
    for (const f of ['onest-cyrillic-ext.woff2', 'onest-cyrillic.woff2', 'onest-latin-ext.woff2', 'onest-latin.woff2']) {
        h.update(fs.readFileSync(path.join(dir, f)));
    }
    assert.strictEqual(h.digest('hex'), 'debb7b4826569978a37890e190fa15eb817a761cd715d97ae4b2028ca543ff62',
        'файлы Onest изменились — таблицу MEASURED в шапке этого файла нужно пересчитать, ' +
        'иначе ширина колонки описывает шрифт, которого в клинике больше нет');
    // И карточка всё ещё печатает имя тем размером, на котором мерили.
    assert.strictEqual(px(rule(VIEWS, '.crm-card-name')['font-size']), 15);
    assert.strictEqual(px(rule(VIEWS, '.crm-card-tel-n')['font-size']), 13.5);
});
