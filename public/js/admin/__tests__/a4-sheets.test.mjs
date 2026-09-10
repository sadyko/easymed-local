// A4_SHEETS_V1 — документ раскладывается по ЛИСТАМ, и ничего при этом не теряет.
//
// Владелец: «so when user writes, separate a4 list is created not dotted line
// with text "here is second page"».
//
// Проверяется то, из-за чего эта раскладка опасна: она ПЕРЕНОСИТ УЗЛЫ между
// листами и делит текст раздела. Ошибка здесь означает не кривой вид, а
// потерянный текст — и заметят его через месяц, когда документ понадобится.
//
// Меряет раскладка настоящую вёрстку, которой в Node нет. Поэтому здесь свой
// маленький DOM, где высота элемента — это его свойство: логика раскладки от
// этого не меняется, а проверить её становится можно.
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM: ровно та поверхность, которой пользуется раскладка ──────
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.className = '';
        this.children = [];
        this.attrs = {};
        this.style = {};
        this.parentNode = null;
        this._h = 0;                       // высота: то, что в браузере меряется
        this.ownerDocument = DOC;
    }
    get firstChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this; this.children.push(c); return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
    insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
        node.parentNode = this; return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    get isConnected() { return true; }
    contains(el) { return el === this || this.all().includes(el); }
    all(out = []) { for (const c of this.children) { out.push(c); c.all(out); } return out; }
    matches(sel) {
        if (/^[a-z]+$/i.test(sel)) return this.tagName === sel.toUpperCase();
        if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1));
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
        if (m) return m[2] === undefined ? this.getAttribute(m[1]) !== null : this.getAttribute(m[1]) === m[2];
        return false;
    }
    querySelector(sel) { return this.all().find((e) => e.matches(sel)) || null; }
    querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
    closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; }
    // Высота с потомками: раскладка меряет коробку блока целиком.
    getBoundingClientRect() {
        const own = this._h || 0;
        const kids = this.children.reduce((a, c) => a + c.getBoundingClientRect().height, 0);
        return { height: own + kids, top: 0, bottom: own + kids };
    }
}
const DOC = { createElement: (t) => new El(t) };
globalThis.document = DOC;
globalThis.getComputedStyle = () => ({ marginTop: '0', marginBottom: '0' });

const { layoutA4Sheets, flushA4Sheets, A4_H, A4_PAD } = await import('../views/a4-sheets.js');

const CAP = A4_H - A4_PAD * 2;

/** Лист с шапкой и потоком, как его строит рабочий экран. */
function makeStack({ headH = 0, blocks = [] } = {}) {
    const stack = new El('div');
    const paper = new El('div'); paper.className = 'a4-paper';
    if (headH) { const lh = new El('div'); lh.className = 'a4-lh'; lh._h = headH; paper.appendChild(lh); }
    const flow = new El('div'); flow.className = 'a4-flow cw-doc-body';
    paper.appendChild(flow);
    stack.appendChild(paper);
    for (const b of blocks) flow.appendChild(b);
    return stack;
}

/** Раздел документа: подпись и редактируемое поле с абзацами. */
function section(key, paragraphHeights, tagH = 30) {
    const sec = new El('div'); sec.className = 'a4-sec cd-sec';
    const tag = new El('span'); tag.className = 'a4-sec-tag'; tag._h = tagH;
    sec.appendChild(tag);
    const field = new El('div');
    field.className = 'a4-input';
    field.setAttribute('data-a4-field', key);
    field.setAttribute('contenteditable', 'true');
    for (const hgt of paragraphHeights) { const p = new El('p'); p._h = hgt; field.appendChild(p); }
    sec.appendChild(field);
    return sec;
}

const sheets = (stack) => stack.querySelectorAll('.a4-paper');
const textOf = (stack) => stack.querySelectorAll('p').length;

test('что помещается — стоит на первом листе, и второго листа не заводится', () => {
    const stack = makeStack({ headH: 120, blocks: [section('a', [200]), section('b', [300])] });
    assert.equal(layoutA4Sheets(stack), 1);
    assert.equal(sheets(stack).length, 1, 'лист размножился без надобности');
});

test('раздел, не влезающий целиком, ДЕЛИТСЯ по абзацам: хвост на втором листе', () => {
    // Шапка 120 + подпись 30 + семь абзацев по 200 = 1550 при ёмкости 1027.
    const stack = makeStack({ headH: 120, blocks: [section('objective', [200, 200, 200, 200, 200, 200, 200])] });
    const pages = layoutA4Sheets(stack);
    assert.equal(pages, 2, 'страниц вышло: ' + pages);
    const all = sheets(stack);
    assert.equal(all.length, 2, 'листов вышло: ' + all.length);

    // Ни один абзац не пропал.
    assert.equal(textOf(stack), 7, 'абзацы потерялись при делении');

    // Первый лист не переполнен, на втором — продолжение ТОГО ЖЕ поля.
    const first = all[0].getBoundingClientRect().height;
    assert.ok(first <= 1123, 'первый лист выше страницы: ' + first);
    const cont = all[1].querySelector('[data-a4-cont]');
    assert.ok(cont, 'на втором листе нет продолжения раздела');
    assert.equal(cont.getAttribute('data-a4-cont'), 'objective', 'продолжение потеряло, чьё оно');
    assert.equal(cont.getAttribute('contenteditable'), 'true', 'хвост нельзя дописать — документ стал наполовину читаемым');
});

test('СХЛОПЫВАНИЕ возвращает хвост в своё поле — иначе вторая страница не дойдёт до сервера', () => {
    const stack = makeStack({ headH: 120, blocks: [section('objective', [200, 200, 200, 200, 200, 200, 200])] });
    layoutA4Sheets(stack);
    flushA4Sheets(stack);

    assert.equal(sheets(stack).length, 1, 'лишние листы остались после схлопывания');
    const field = stack.querySelector('[data-a4-field="objective"]');
    assert.equal(field.children.length, 7, 'в поле вернулись не все абзацы: ' + field.children.length);
    assert.equal(stack.querySelectorAll('[data-a4-cont]').length, 0, 'продолжение осталось висеть');
});

test('раскладка ИДЕМПОТЕНТНА: второй прогон не плодит листы и не теряет текста', () => {
    const stack = makeStack({ headH: 120, blocks: [section('objective', [200, 200, 200, 200, 200, 200, 200])] });
    const first = layoutA4Sheets(stack);
    const second = layoutA4Sheets(stack);
    assert.equal(second, first, 'второй прогон дал другое число листов');
    assert.equal(textOf(stack), 7, 'абзацы потерялись на втором прогоне');
});

test('раздел ВЫШЕ страницы делить нечем — он остаётся целым, а не обрезается', () => {
    // Один абзац в полторы страницы: делить по абзацам нечего.
    const stack = makeStack({ headH: 0, blocks: [section('objective', [CAP + 400])] });
    layoutA4Sheets(stack);
    assert.equal(textOf(stack), 1, 'единственный абзац пропал');
    assert.equal(stack.querySelectorAll('[data-a4-cont]').length, 0, 'нечего было делить, а деление случилось');
});

test('первая страница не остаётся пустой: содержимое начинается на ней', () => {
    // Именно этим болел прежний расчёт: он считал прямых детей листа (шапку и
    // тело целиком) и ставил разрыв ПЕРЕД телом — первая страница выходила
    // пустой, а документ начинался со второй.
    const stack = makeStack({ headH: 120, blocks: [section('objective', [200, 200, 200, 200, 200, 200, 200])] });
    layoutA4Sheets(stack);
    const firstFlow = sheets(stack)[0].querySelector('.a4-flow');
    assert.ok(firstFlow.children.length > 0, 'на первом листе нет ни одного блока документа');
    assert.ok(firstFlow.getBoundingClientRect().height > 200, 'первый лист почти пуст');
});
