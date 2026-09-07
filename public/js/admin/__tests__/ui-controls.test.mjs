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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

test('спрятанное родное поле выпадает из обхода Tab — иначе он «через раз»', () => {
    // KEYBOARD_FLOW_V1. Родное поле спрятано clip-path'ом и opacity: 0 — но из
    // порядка обхода ТАК не выпадают: браузер убирает из него только
    // display:none и visibility:hidden. Пока этого не было, на каждый список
    // приходилось ДВА нажатия Tab, и первое уводило фокус на невидимое поле —
    // на экране не двигалось ничего, и владелец сообщил это как «Tab не
    // работает».
    const { sel } = selectWith([['', '—'], ['1', 'Иванов']]);
    enhanceSelect(sel);
    assert.equal(sel.tabIndex, -1, 'родной <select> остался остановкой Tab');

    const { el: inp } = dateInput();
    enhanceDateField(inp);
    assert.equal(inp.tabIndex, -1, 'родное поле даты осталось остановкой Tab');

    // …а видимая часть обхода не теряет: это обычная <button>.
    const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin.css'), 'utf8');
    assert.ok(/\.uisel-native,\s*\.uidate-native \{[^}]*opacity:\s*0/.test(css),
        'родное поле перестали прятать — тогда и tabindex не нужен, проверьте оба места');
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

test('поле не растягивается во всю строку — это ломало каждый фильтр-дату', () => {
    // Здесь стояло width: 100%, и поиск по дате рождения занял ВСЮ строку
    // списка пациентов, вытеснив поиск по фамилии; в отчётах так же расползались
    // «с» и «по». Родное поле шириной со своё содержимое, и обёртка обязана
    // вести себя так же. Проверяется САМО ПРАВИЛО: раскладку в этом крохотном
    // DOM воспроизвести нечем, а правило — ровно то место, где ошибка и была.
    const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('.uisel, .uidate {');
    assert.notEqual(at, -1, 'правило обёртки переписали — тест смотрит не туда');
    const rule = css.slice(at, css.indexOf('}', at));
    // Именно `width`, а не `max-width`: потолок в 100 % как раз нужен, чтобы
    // длинная подпись не выталкивала поле за край строки.
    assert.ok(!/(^|[^-])width:\s*100%/.test(rule), 'обёртка снова тянется во всю строку: ' + rule.trim());
    assert.ok(/width:\s*auto/.test(rule), 'ширина обёртки задана не по содержимому');
    assert.ok(/\.uidate\s*\{[^}]*min-width/.test(css), 'у поля даты нет минимальной ширины');
});

test('пустое поле говорит, ЧТО оно фильтрует, а не «выберите дату»', () => {
    document.body.replaceChildren();
    const { el } = dateInput('', { title: 'Поиск по дате рождения' });
    const wrap = enhanceDateField(el);
    // DATE_TYPING_V1 — поле стало полем ввода, и подпись пустого поля живёт
    // в placeholder, а не в отдельной строке.
    assert.equal(wrap.querySelector('.uidate-field').placeholder, 'Поиск по дате рождения',
        'подпись не объясняет, что это за календарь — именно об этом владелец и спросил');
});

test('человек видит дату словами, а в поле лежит ГГГГ-ММ-ДД', () => {
    const { el } = dateInput('2019-05-02');
    const wrap = enhanceDateField(el);
    assert.ok(wrap, 'поле даты не обёрнуто');
    assert.equal(el.value, '2019-05-02', 'значение обязано остаться машинным');
    const shown = String(wrap.querySelector('.uidate-field').value).trim();
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

    wrap.querySelector('.uidate-ic').click();
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
    wrap.querySelector('.uidate-ic').click();
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
test('дату НАБИРАЮТ: 12.04.1978 доходит до поля, а 31 февраля — нет', () => {
    // DATE_TYPING_V1. Поле было кнопкой: набрать дату было нельзя вовсе, только
    // листать календарь по месяцу. От сентября 2026 до апреля 1978 — 581
    // нажатие стрелки, и это на КАЖДОГО пациента. Владелец: «holy shit, this is
    // terrible UX».
    document.body.replaceChildren();
    const { el } = dateInput('');
    const wrap = enhanceDateField(el);
    const seen = [];
    el.addEventListener('change', () => seen.push(el.value));
    const f = wrap.querySelector('.uidate-field');

    for (const typed of ['12.04.1978', '12/04/1978', '12041978', '12 04 1978']) {
        el.value = ''; seen.length = 0;
        f.value = typed;
        f.dispatchEvent({ type: 'input', target: f, currentTarget: f });
        assert.equal(el.value, '1978-04-12', 'не разобрано: ' + typed);
    }

    // Несуществующий день до базы доходить не должен: её ограничение поймает
    // его позже и грубее — отказом сохранения на полностью заполненной форме.
    el.value = '';
    f.value = '31.02.1978';
    f.dispatchEvent({ type: 'input', target: f, currentTarget: f });
    assert.equal(el.value, '', '31 февраля принято как дата');

    // Двузначный год не достраиваем: «78» — это и 1978, и 2078.
    el.value = '';
    f.value = '12.04.78';
    f.dispatchEvent({ type: 'input', target: f, currentTarget: f });
    assert.equal(el.value, '', 'год из двух цифр достроен догадкой');
    document.body.replaceChildren();
});

test('в календаре год и месяц ВЫБИРАЮТ, а не долистывают', () => {
    document.body.replaceChildren();
    const { el } = dateInput('2026-09-11');
    const wrap = enhanceDateField(el);
    wrap.querySelector('.uidate-ic').click();
    const pop = lastPop('uidate-pop');

    const picks = pop.querySelectorAll('.uidate-pick');
    assert.equal(picks.length, 2, 'в шапке календаря нет выбора месяца и года');
    const years = picks[1].children.map((o) => Number(text(o).trim()));
    assert.ok(years.length >= 100,
        'список лет короче века — до года рождения пациента им не добраться: ' + years.length);
    assert.ok(years.includes(1978), 'в списке лет нет 1978');
    assert.ok(years[0] > years[years.length - 1], 'ближние годы обязаны быть сверху');
    document.body.replaceChildren();
});

// ===========================================================================
// DATE_NUMERIC_V1 — дата рождения цифрами, календарь на месте
// ===========================================================================

test('дата с data-date-numeric показывается цифрами, а не словами', () => {
    // Дату рождения СВЕРЯЮТ с паспортом, где она цифрами. Сличать «ноября»
    // с «11» — лишняя работа глазами, и делать её приходится на каждом пациенте.
    document.body.replaceChildren();
    const { el } = dateInput('1994-11-15', { 'data-date-numeric': '' });
    const wrap = enhanceDateField(el);
    assert.equal(wrap.querySelector('.uidate-field').value, '15.11.1994');
    document.body.replaceChildren();
});

test('без пометки дата по-прежнему словами — её читают, а не сверяют', () => {
    document.body.replaceChildren();
    const { el } = dateInput('1994-11-15');
    const wrap = enhanceDateField(el);
    const shown = wrap.querySelector('.uidate-field').value;
    assert.ok(/ноябр/i.test(shown), 'ожидалась словесная запись, получено: ' + shown);
    document.body.replaceChildren();
});

test('у даты рождения есть календарь и он открывается', () => {
    // Владелец показал снимок этого поля с календарём: «can you make this type».
    // Набор руками остаётся быстрее, но поправить день, когда месяц и год уже
    // стоят, проще щелчком.
    document.body.replaceChildren();
    const { el } = dateInput('1994-11-15', { 'data-date-numeric': '' });
    const wrap = enhanceDateField(el);
    const btn = wrap.querySelector('.uidate-ic');
    assert.ok(btn, 'значка календаря нет');
    assert.equal(btn.tagName, 'BUTTON', 'календарь перестал быть кнопкой');
    btn.dispatchEvent({ type: 'click', target: btn, currentTarget: btn,
        preventDefault() {}, stopPropagation() {} });
    assert.ok(lastPop('uidate-pop'), 'календарь не открылся');
    document.body.replaceChildren();
});

test('точки в дате расставляются сами', () => {
    document.body.replaceChildren();
    const { el } = dateInput('', { 'data-date-numeric': '' });
    const wrap = enhanceDateField(el);
    const f = wrap.querySelector('.uidate-field');
    for (const [typed, shown] of [['1', '1'], ['15', '15'], ['151', '15.1'],
                                  ['1511', '15.11'], ['15111994', '15.11.1994']]) {
        f.value = typed;
        f.dispatchEvent({ type: 'input', target: f, currentTarget: f });
        assert.equal(f.value, shown, 'набрали «' + typed + '»');
    }
    assert.equal(el.value, '1994-11-15');
    document.body.replaceChildren();
});

test('поле ГОВОРИТ, что не так с датой, а не молчит', () => {
    document.body.replaceChildren();
    const { el } = dateInput('', { 'data-date-numeric': '' });
    const wrap = enhanceDateField(el);
    const f = wrap.querySelector('.uidate-field');
    const err = wrap.querySelector('.uidate-err');
    assert.ok(err, 'месту под ошибку неоткуда взяться');
    assert.equal(err.getAttribute('aria-live'), 'polite', 'ошибку не прочитают вслух');

    const say = (typed) => {
        f.value = typed;
        f.dispatchEvent({ type: 'input', target: f, currentTarget: f });
        return String(err._t || '');
    };
    assert.match(say('15.13.1994'), /месяц/i, 'о несуществующем месяце молчит');
    assert.match(say('45.11.1994'), /день/i, 'о несуществующем дне молчит');
    assert.match(say('31.02.1994'), /не существует/i, 'о 31 февраля молчит');
    assert.match(say('15.11.2999'), /будущ/i, 'дата рождения в будущем принята молча');
    assert.ok(wrap.classList.contains('is-bad'), 'поле не помечено как ошибочное');
    assert.equal(say('15.1'), '', 'ругается на недонабранную дату');
    assert.equal(say('15.11.1994'), '');
    assert.equal(el.value, '1994-11-15');
    document.body.replaceChildren();
});

test('место под значок календаря не отбирается правилом .field input', () => {
    // Живой промах. `.uidate-field { padding-left: 38px }` — один класс, а
    // `.field input { padding: 0 12px }` — класс И элемент, то есть вес больше.
    // Внутри формы побеждал второй, отступ схлопывался до 12 px, и текст
    // заезжал под значок: владелец увидел «🗓5.11.1994» вместо «15.11.1994».
    // Снаружи `.field` поле выглядело правильно — потому и не попадалось.
    //
    // Проверяем не пиксели (их тут посчитать нечем), а ВЕС селектора: правило
    // обязано быть записано двумя классами.
    const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin.css'), 'utf8');
    const rule = /\.uidate \.uidate-field \{[^}]*padding-left: 38px/.test(css);
    assert.ok(rule, 'правило отступа снова записано одним классом — текст заедет под значок');
    assert.ok(!/^\.uidate-field \{[^}]*padding-left/m.test(css),
        'вернулась одноклассовая запись, которую перебивает .field input');
});
