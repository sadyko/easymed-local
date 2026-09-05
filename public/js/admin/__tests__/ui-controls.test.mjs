// UI_SELECT_V1 / UI_DATEFIELD_V1 (2026-09-05) — списки и календари рисует
// программа, и родное поле остаётся источником правды.
//
// ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО И ПОЧЕМУ ИМЕННО ЭТО.
//
// Замена делается НАБЛЮДЕНИЕМ сразу во всех ста пяти видах, поэтому цена
// ошибки — вся программа, а не один экран. Опасность у такой замены ровно
// одна и всегда одна и та же: видимая часть начинает жить своей жизнью, а
// форма отправляет старое значение. Отсюда и проверки — не «нарисовалась
// кнопка», а КОНТРАКТ, на который опираются сто пятьдесят мест вызова:
//   • родной <select> остаётся в разметке и хранит значение;
//   • выбор мышью ставит sel.value и посылает change — это то, что слушают
//     формы, и без этого экран «работает», а данные не сохраняются;
//   • подпись поля следует за значением, в том числе когда значение или сами
//     варианты поставили СНАРУЖИ (предзаполнение формы, дозагрузка списка).
// Для даты добавляется второе: человек видит слова на своём языке, а в поле
// лежит «ГГГГ-ММ-ДД» — тот вид, который читают полсотни мест и база.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- крохотный DOM: ровно то, чего касаются эти два модуля ------------------
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = []; this.attrs = {}; this.className = ''; this._t = '';
        this.style = {}; this.dataset = {}; this._l = {}; this.parentNode = null;
        this.disabled = false; this.required = false;
    }
    // Настоящий DOM ПЕРЕНОСИТ узел, а не копирует: без отцепления от прежнего
    // родителя select остался бы и на старом месте, и внутри обёртки — то есть
    // тест «на месте поля ровно один элемент» проверял бы фальшивку.
    _detach(c) { if (c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c); else if (c.parentNode === this) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); } }
    appendChild(c) { if (c == null) return c; this._detach(c); c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) if (c != null) this.appendChild(c); }
    insertBefore(node, ref) {
        this._detach(node);
        node.parentNode = this;
        const i = this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        return node;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceChildren(...cs) { this.children.length = 0; for (const c of cs) if (c != null) this.appendChild(c); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'type') this.type = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); } }
    dispatchEvent(e) { for (const fn of (this._l[e.type] || []).slice()) fn({ ...e, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    focus() {} blur() {} scrollIntoView() {}
    getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 136, width: 200, height: 36 }; }
    get textContent() { return this._t || this.children.map((c) => c.textContent || '').join(''); }
    set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() {
        const self = this;
        const list = () => String(self.className || '').split(/\s+/).filter(Boolean);
        return {
            contains: (c) => list().includes(c),
            add(c) { if (!list().includes(c)) self.className = (self.className ? self.className + ' ' : '') + c; },
            remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
            toggle(c, on) { if (on === undefined ? !list().includes(c) : on) this.add(c); else this.remove(c); },
        };
    }
    get options() { return this.descendants().filter((n) => n.tagName === 'OPTION'); }
    descendants(out = []) { for (const c of this.children) { out.push(c); if (c.descendants) c.descendants(out); } return out; }
    closest(sel) {
        const want = sel.replace(/[[\]]/g, '');
        let n = this;
        while (n) { if (n.attrs && want in n.attrs) return n; n = n.parentNode; }
        return null;
    }
    contains(n) { return n === this || this.descendants().includes(n); }
    matches(sel) {
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1).split(':')[0]);
        if (sel.startsWith('input[type=')) return this.tagName === 'INPUT' && this.getAttribute('type') === sel.match(/"([^"]+)"/)[1];
        return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim());
        return this.descendants().filter((n) => parts.some((p) => {
            if (p.includes(':not(')) {
                const [base, not] = [p.slice(0, p.indexOf(':not(')), p.slice(p.indexOf(':not(') + 5, -1)];
                return n.matches(base) && !n.matches(not);
            }
            return n.matches(p);
        }));
    }
}
function mk(tag) {
    const el = new El(tag);
    // Значки собираются через <template>.innerHTML — тот же приём, что в
    // остальных экранных тестах; без него падает первый же Icon().
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const svg = new El('svg'); svg._t = String(v); el.content.firstChild = svg; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; },
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.Node = El;
globalThis.Event = class { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } };
globalThis.window = { innerHeight: 900, innerWidth: 1440, addEventListener() {}, removeEventListener() {}, location: { hostname: 'localhost' } };
globalThis.localStorage = { getItem: () => 'ru', setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const { enhanceSelect } = await import('../ui-select.js');
const { enhanceDateField } = await import('../ui-datefield.js');

function selectWith(values) {
    const sel = mk('select');
    for (const [value, label] of values) {
        const o = mk('option');
        o.setAttribute('value', value);
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
    }
    const host = mk('div');
    host.appendChild(sel);
    return { sel, host };
}
const text = (n) => (n ? n.textContent : '');
const rowsOf = (pop) => pop.querySelectorAll('.uisel-row').filter((r) => !r.classList.contains('is-clear'));
const lastPop = (cls) => document.body.children.filter((c) => c.classList.contains(cls)).slice(-1)[0] || null;

test('родной <select> остаётся в разметке и хранит значение', () => {
    const { sel, host } = selectWith([['', '— не выбрано —'], ['1', 'Иванов'], ['2', 'Петров']]);
    const wrap = enhanceSelect(sel);

    assert.ok(wrap, 'поле не обёрнуто');
    assert.equal(sel.parentNode, wrap, 'родное поле обязано уехать ВНУТРЬ обёртки, а не исчезнуть');
    assert.ok(sel.classList.contains('uisel-native'), 'родное поле не спрятано классом');
    assert.equal(host.children.length, 1, 'на месте поля стоит ровно один элемент');
    assert.equal(host.children[0], wrap);
});

test('выбор мышью ставит значение и посылает change — на этом держатся формы', () => {
    const { sel } = selectWith([['', '—'], ['1', 'Иванов'], ['2', 'Петров']]);
    const wrap = enhanceSelect(sel);
    const seen = [];
    sel.addEventListener('change', () => seen.push(sel.value));

    wrap.querySelector('.uisel-field').click();
    const pop = lastPop('uisel-pop');
    assert.ok(pop, 'список не открылся');
    const rows = rowsOf(pop);
    assert.deepEqual(rows.map(text).map((s) => s.trim()), ['Иванов', 'Петров'],
        'пустой вариант — подсказка, а не строка выбора');

    rows[1].dispatchEvent({ type: 'mousedown' });
    assert.equal(sel.value, '2', 'значение не попало в родное поле — форма отправит старое');
    assert.deepEqual(seen, ['2'], 'change не отправлен: экран покажет выбор, а обработчик его не увидит');
    assert.equal(text(wrap.querySelector('.uisel-val')).trim(), 'Петров');
});

test('подпись следует за значением и за поздно приехавшими вариантами', () => {
    const { sel } = selectWith([['', '— врач —']]);
    const wrap = enhanceSelect(sel);
    const val = wrap.querySelector('.uisel-val');
    assert.equal(text(val).trim(), '— врач —', 'пустое поле показывает подсказку');
    assert.ok(val.classList.contains('is-empty'), 'подсказка обязана отличаться от выбранного значения');

    // Списки в программе дозагружаются запросом — варианты приходят ПОСЛЕ.
    const o = mk('option'); o.setAttribute('value', '7'); o.value = '7'; o.textContent = 'Каримова';
    sel.appendChild(o);
    sel.value = '7';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(text(wrap.querySelector('.uisel-val')).trim(), 'Каримова');
    assert.ok(!wrap.querySelector('.uisel-val').classList.contains('is-empty'));
});

test('поиск появляется только у длинного списка', () => {
    const short = selectWith([['1', 'а'], ['2', 'б'], ['3', 'в']]);
    const wrapShort = enhanceSelect(short.sel);
    wrapShort.querySelector('.uisel-field').click();
    assert.equal(lastPop('uisel-pop').querySelector('.uisel-search'), null,
        'у списка из трёх строк поиск — лишний шаг');
    document.body.replaceChildren();

    const many = selectWith(Array.from({ length: 12 }, (_, i) => [String(i + 1), 'Врач ' + (i + 1)]));
    const wrapMany = enhanceSelect(many.sel);
    wrapMany.querySelector('.uisel-field').click();
    const pop = lastPop('uisel-pop');
    assert.ok(pop.querySelector('.uisel-search'), 'в длинном списке без поиска ищут глазами');

    const search = pop.querySelector('.uisel-search');
    search.value = 'Врач 1';
    search.dispatchEvent({ type: 'input' });
    const shown = rowsOf(pop).map(text).map((s) => s.trim());
    assert.deepEqual(shown, ['Врач 1', 'Врач 10', 'Врач 11', 'Врач 12']);
    document.body.replaceChildren();
});

test('отказ работает без правок в местах вызова', () => {
    const { sel } = selectWith([['1', 'а']]);
    sel.setAttribute('data-no-enhance', '');
    sel.dataset.noEnhance = '';
    assert.equal(enhanceSelect(sel), null, 'data-no-enhance не сработал');

    const multi = selectWith([['1', 'а']]);
    multi.sel.multiple = true;
    assert.equal(enhanceSelect(multi.sel), null, 'список с множественным выбором трогать нечем — своей замены у него нет');
});

// --------------------------- поле даты -------------------------------------

function dateInput(value, attrs = {}) {
    const el = mk('input');
    el.setAttribute('type', 'date');
    el.value = value || '';
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (attrs.required != null) el.required = true;
    const host = mk('div');
    host.appendChild(el);
    return { el, host };
}

test('человек видит дату словами, а в поле лежит ГГГГ-ММ-ДД', () => {
    const { el } = dateInput('2019-05-02');
    const wrap = enhanceDateField(el);
    assert.ok(wrap, 'поле даты не обёрнуто');
    assert.equal(el.value, '2019-05-02', 'значение обязано остаться машинным');
    const shown = text(wrap.querySelector('.uidate-val')).trim();
    assert.match(shown, /2/, 'подпись пустая: ' + JSON.stringify(shown));
    assert.match(shown, /2019/);
    assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(shown), 'подпись осталась машинной датой: ' + shown);
});

test('выбор дня пишет ГГГГ-ММ-ДД и посылает change', () => {
    document.body.replaceChildren();
    const { el } = dateInput('2026-02-10');
    const wrap = enhanceDateField(el);
    const seen = [];
    el.addEventListener('change', () => seen.push(el.value));

    wrap.querySelector('.uidate-field').click();
    const pop = lastPop('uidate-pop');
    assert.ok(pop, 'календарь не открылся');
    const days = pop.querySelectorAll('.uidate-day');
    assert.equal(days.length, 42, 'сетка обязана быть шесть недель на семь дней — иначе окно прыгает');

    const target = days.find((d) => text(d).trim() === '19' && !d.classList.contains('is-out'));
    target.click();
    assert.equal(el.value, '2026-02-19');
    assert.deepEqual(seen, ['2026-02-19']);
    document.body.replaceChildren();
});

test('ограничения поля закрывают дни, а обязательное поле нельзя очистить', () => {
    document.body.replaceChildren();
    const { el } = dateInput('2026-02-10', { min: '2026-02-05', max: '2026-02-20', required: '' });
    const wrap = enhanceDateField(el);
    wrap.querySelector('.uidate-field').click();
    const pop = lastPop('uidate-pop');

    const inMonth = pop.querySelectorAll('.uidate-day').filter((d) => !d.classList.contains('is-out'));
    const off = inMonth.filter((d) => d.classList.contains('is-off')).map((d) => Number(text(d).trim()));
    assert.ok(off.includes(1) && off.includes(4), 'дни до min обязаны быть закрыты: ' + off.join(','));
    assert.ok(off.includes(21) && off.includes(28), 'дни после max обязаны быть закрыты: ' + off.join(','));
    assert.ok(!off.includes(10), 'выбранный день закрыт — окно противоречит собственному значению');

    const labels = pop.querySelectorAll('.uidate-foot').map(text).join(' ');
    assert.ok(!/Очистить/.test(labels),
        'у обязательного поля «очистить» — предложение сделать форму неверной');
    document.body.replaceChildren();
});
