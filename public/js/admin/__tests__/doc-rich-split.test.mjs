// DOC_RICH_FORMAT_V1 (T2, правило F5) — РАЗБИВКА НА СТРАНИЦЫ ПОНИМАЕТ ОФОРМЛЕНИЕ.
//
// Бланк кабинета делит раздел, пересёкший границу листа A4: что влезло — в поле,
// остальное — в продолжение на следующей странице. Раньше это шло через
// innerText, и список, таблица, жирный становились строками текста — а потом
// эти строки уходили в форму и в notes.
//
// Здесь — разрез и слияние узлами (views/blank-split.js) на маленьком DOM с
// разбором разметки (mini-dom.mjs). Вёрстки в Node нет, поэтому высоту
// «меряет» сама проверка: строки поля — по общему правилу строк htmlToText
// (пункт списка, строка таблицы, <br>, блок — строка). Логике разреза всё равно,
// чем мерить: она спрашивает fits() и кладёт узлы. Путь бланка целиком —
// headless Chrome (отчёт T2).
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom } from './cabinet-harness.mjs';
import { miniDocument, el } from './mini-dom.mjs';
import { htmlToText, sanitizeStoredHtml } from '../../shared/rich-text.js';

installFakeDom();
const SPLIT = await import('../views/blank-split.js');
const { fieldIsRich, blankCuts, splitAt, joinCont, splitRichField, firstAtom, insertCaretMark, takeCaretMark, mergedFieldClone, contIsBlank } = SPLIT;
const WS = await import('../views/service-workspace.js');

const linesOf = (e) => { const t = htmlToText(e.innerHTML); return t ? t.split('\n').length : 0; };
const capFits = (f, cap) => () => linesOf(f) <= cap;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const items = (a, b) => range(a, b).map((i) => '<li>Пункт ' + i + '</li>').join('');
const rows = (a, b) => range(a, b).map((i) => '<tr><td>П' + i + '</td><td>' + i + '0 г/л</td></tr>').join('');
const HEAD = '<tr><th>Показатель</th><th>Результат</th></tr>';
const RESTBL = (a, b) => '<table class="a4-restbl"><thead>' + HEAD + '</thead><tbody>' + rows(a, b) + '</tbody></table>';
const A4TBL = (a, b) => '<table class="a4-tbl"><tbody>' + HEAD + rows(a, b) + '</tbody></table>';
const MIXED = '<div><b>Жалобы</b> на кашель</div>'
    + 'строка <i>один</i><br>строка два<br>'
    + '<ol><li>Диета</li><li>Режим</li><li>Контроль</li></ol>'
    + RESTBL(1, 5)
    + '<p>Итог <span style="color: red">важно</span></p>'
    + '<div>конец<br>совсем</div>';

function setup(html, key = 'physical_exam', cls = 'sec-b rich') {
    const doc = miniDocument();
    const f = el(doc, '<div class="' + cls + '" data-field="' + key + '" contenteditable="true">' + html + '</div>');
    doc.body.appendChild(f);
    const cont = doc.createElement('div');
    return { doc, f, cont };
}
/** Продолжение на странице так, как его ставит бланк: обёртка с режимом и поле [data-cont-of]. */
function placeCont(doc, cont, key = 'physical_exam', mode = 'rich', cls = 'sec-b rich') {
    const wrap = doc.createElement('div');
    wrap.setAttribute('data-cont-wrap', key);
    wrap.setAttribute('data-cont-mode', mode);
    cont.className = cls;
    cont.setAttribute('data-cont-of', key);
    wrap.appendChild(cont);
    doc.body.appendChild(wrap);
    return wrap;
}
const count = (html, re) => (html.match(re) || []).length;

// ─── что считается разметкой ─────────────────────────────────────────────────
test('F5: простой текст (строки: текст, <br>, <div>, <p>) — не разметка и делится прежним алгоритмом; оформление — разметка', () => {
    const doc = miniDocument();
    assert.equal(fieldIsRich(el(doc, '<div data-field="x">Кашель<br>три дня</div>')), false);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x">а<div>б</div><div><br></div><p>в</p></div>')), false);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x">Кашель\nтри дня</div>')), false);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x">а <b>б</b></div>')), true);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x"><div><span style="color: red">к</span></div></div>')), true);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x"><ul><li>1</li></ul></div>')), true);
    assert.equal(fieldIsRich(el(doc, '<div data-field="x">' + A4TBL(1, 1) + '</div>')), true);
});

// ─── список ───────────────────────────────────────────────────────────────────
test('F5: длинный ul делится между пунктами li — продолжение того же вида; слияние возвращает один список, пункты по порядку', () => {
    const { f, cont } = setup('<ul>' + items(1, 12) + '</ul>');
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 5) }));
    assert.equal(f.innerHTML, '<ul>' + items(1, 5) + '</ul>');
    assert.equal(cont.innerHTML, '<ul data-cont-split="1">' + items(6, 12) + '</ul>');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before, 'слияние не вернуло список как был');
    assert.equal(f.querySelectorAll('ul').length, 1);
    assert.equal(cont.childNodes.length, 0);
});

test('F5: ol продолжает нумерацию (start), в том числе от своего start; слияние — один ol, без start продолжения', () => {
    let { f, cont } = setup('<ol>' + items(1, 12) + '</ol>');
    let before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 5) }));
    assert.equal(cont.innerHTML, '<ol data-cont-split="1" start="6">' + items(6, 12) + '</ol>');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
    ({ f, cont } = setup('<ol start="3">' + items(3, 14) + '</ol>'));
    before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 5) }));
    assert.equal(cont.firstChild.getAttribute('start'), '8', '3 + 5 оставшихся = 8');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before, 'start оригинала не тронут');
});

// ─── таблица ──────────────────────────────────────────────────────────────────
test('F5: таблица делится по строкам tr; на новой странице — та же таблица (класс) и повтор заголовка thead; слияние без второго заголовка', () => {
    const { f, cont } = setup('<div><b>ОАК от 01.10.2026:</b></div>' + RESTBL(1, 10));
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 6) }));
    // строка подписи + заголовок + 4 строки = 6
    assert.equal(f.innerHTML, '<div><b>ОАК от 01.10.2026:</b></div>' + RESTBL(1, 4));
    assert.equal(cont.innerHTML, '<table class="a4-restbl" data-cont-split="1">'
        + '<thead data-cont-head="1" contenteditable="false">' + HEAD + '</thead>'
        + '<tbody data-cont-split="1">' + rows(5, 10) + '</tbody></table>');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
    assert.equal(count(f.innerHTML, /<thead/g), 1);
    assert.equal(count(f.innerHTML, /<th>/g), 2);
});

test('F5: таблица документа (a4-tbl, заголовок — строка th в tbody) — заголовок повторяется своим разделом, слияние его выбрасывает', () => {
    const { f, cont } = setup(A4TBL(1, 9));
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 4) }));
    assert.equal(f.innerHTML, A4TBL(1, 3));
    assert.equal(cont.innerHTML, '<table class="a4-tbl" data-cont-split="1">'
        + '<tbody data-cont-head="1" contenteditable="false">' + HEAD + '</tbody>'
        + '<tbody data-cont-split="1">' + rows(4, 9) + '</tbody></table>');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
    assert.equal(count(f.innerHTML, /<th>Показатель/g), 1);
});

test('F5: таблица не делится до первой строки данных — заголовок без строк не остаётся; таблица целиком уезжает без повтора заголовка', () => {
    const { f, cont } = setup('<div>Текст</div>' + RESTBL(1, 3));
    const before = f.innerHTML;
    // влезает только первая строка: разрез перед таблицей
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 2) }));
    assert.equal(f.innerHTML, '<div>Текст</div>');
    assert.equal(cont.innerHTML, RESTBL(1, 3), 'таблица целиком — тот же узел, без меток');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
    // места разреза таблицы — только между строками данных, со второй
    const cuts = blankCuts(f).filter((n) => n.nodeType === 1 && n.tagName === 'TR');
    assert.deepEqual(cuts.map((r) => r.textContent.slice(0, 2)), ['П2', 'П3']);
});

// ─── смешанные блоки ─────────────────────────────────────────────────────────
test('F5: смешанные блоки — для любой высоты страницы разрез влезает, ничего не теряется, слияние точно возвращает поле', () => {
    const total = linesOf(setup(MIXED).f);
    for (let cap = 1; cap <= total + 1; cap += 1) {
        const { f, cont } = setup(MIXED);
        const before = f.innerHTML;
        const did = splitRichField(f, cont, { fits: capFits(f, cap) });
        if (did) {
            assert.ok(linesOf(f) <= cap, 'cap ' + cap + ': на первой странице больше, чем влезает');
            assert.ok(f.firstChild, 'cap ' + cap + ': поле опустело');
            assert.ok(cont.firstChild, 'cap ' + cap + ': продолжение пустое');
            assert.ok(!/data-cont/.test(f.innerHTML), 'cap ' + cap + ': метки в поле');
        } else {
            assert.equal(f.innerHTML, before, 'cap ' + cap + ': без разреза поле изменилось');
        }
        joinCont(f, cont, 'rich');
        assert.equal(f.innerHTML, before, 'cap ' + cap + ': слияние не точное');
    }
});

test('F5: строки текста до <br> — свои места разреза: <br> остаётся в конце первой части, продолжение начинается без пустой строки', () => {
    const { f, cont } = setup('а <b>б</b><br>в<br>г');
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 2) }));
    assert.equal(f.innerHTML, 'а <b>б</b><br>в<br>');
    assert.equal(cont.innerHTML, 'г');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
});

test('F5: div со строками и блоками внутри делится по ним же (копия div с меткой), слияние склеивает', () => {
    const { f, cont } = setup('<div style="text-align: center">раз<br>два<br>три<ul><li>а</li><li>б</li></ul></div>');
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 4) }));
    assert.equal(f.innerHTML, '<div style="text-align: center">раз<br>два<br>три<ul><li>а</li></ul></div>');
    assert.equal(cont.innerHTML, '<div style="text-align: center" data-cont-split="1"><ul data-cont-split="1"><li>б</li></ul></div>');
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, before);
});

test('F5: пробелы между блоками не становятся местом разреза (пустой строкой в начале продолжения)', () => {
    const { f } = setup('<ul>\n<li>а</li>\n<li>б</li>\n</ul>\n<p>в</p>\n<p>г</p>');
    const before = f.innerHTML;
    const cuts = blankCuts(f);
    assert.ok(cuts.every((n) => !(n.nodeType === 3 && !n.data.trim())), 'разрез по пробелу');
    for (const c of cuts) {
        const cont = f.ownerDocument.createElement('div');
        assert.ok(splitAt(f, c, cont));
        joinCont(f, cont, 'rich');
        assert.equal(f.innerHTML, before);
    }
});

// ─── блок выше страницы, ничего не влезло ───────────────────────────────────
test('F5: блок, который не влез, уезжает целиком; блок выше целой страницы остаётся на первой странице', () => {
    let { f, cont } = setup('<p>Вступление</p><div>огромный блок без мест разреза</div>');
    let before = f.innerHTML;
    // не влез — уезжает целиком
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 1), tooTall: () => false }));
    assert.equal(cont.innerHTML, '<div>огромный блок без мест разреза</div>');
    joinCont(f, cont, 'rich');
    // выше страницы — остаётся: разреза нет, поле как было
    const seen = [];
    assert.equal(splitRichField(f, cont, { fits: capFits(f, 1), tooTall: (n) => { seen.push(n); return n.tagName === 'DIV'; } }), false);
    assert.equal(f.innerHTML, before);
    assert.equal(cont.childNodes.length, 0);
    assert.equal(seen.length, 1, 'высота проверяется один раз — у блока на границе');
    // у списка «блок» на границе — его первый пункт, у таблицы — первая строка данных
    ({ f, cont } = setup('<p>x</p><ul><li>а</li><li>б</li></ul>'));
    let atom = null;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 1), tooTall: (n) => { atom = n; return false; } }));
    assert.equal(atom.tagName + ':' + atom.textContent, 'LI:а');
    joinCont(f, cont, 'rich');
    ({ f } = setup(RESTBL(1, 3)));
    assert.equal(firstAtom(f.firstChild).textContent, 'П110 г/л');
});

test('F5: ничего не влезло — разреза нет, поле не тронуто (вызывающий переносит блок целиком)', () => {
    const { f, cont } = setup(MIXED);
    const before = f.innerHTML;
    assert.equal(splitRichField(f, cont, { fits: () => false }), false);
    assert.equal(f.innerHTML, before);
    assert.equal(cont.childNodes.length, 0);
    // одно целое без мест разреза
    const one = setup('<ul><li>единственный</li></ul>');
    assert.deepEqual(blankCuts(one.f), []);
    assert.equal(splitRichField(one.f, one.cont, { fits: () => false }), false);
});

// ─── повторные проходы ───────────────────────────────────────────────────────
test('F5: повторные проходы (слить → разрезать) идемпотентны — не копят заголовков и пустых списков', () => {
    const { f, cont } = setup('<p>Начало</p><ol>' + items(1, 8) + '</ol>' + RESTBL(1, 8) + A4TBL(1, 4));
    const pass = () => { if (cont.firstChild) joinCont(f, cont, 'rich'); splitRichField(f, cont, { fits: capFits(f, 14) }); return f.innerHTML + '|' + cont.innerHTML; };
    const first = pass();
    for (let i = 0; i < 4; i += 1) assert.equal(pass(), first, 'проход ' + (i + 2));
    const all = f.innerHTML + cont.innerHTML;
    assert.equal(count(all, /<thead/g), 2, 'заголовок таблицы — оригинал и один повтор');
    assert.equal(count(all, /<ol/g), 1);
});

test('F5: продолжение с оформлением делится дальше (третья страница); слияние частей по порядку возвращает поле', () => {
    const { doc, f, cont } = setup('<ol>' + items(1, 30) + '</ol>' + RESTBL(1, 20));
    const before = f.innerHTML;
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 10) }));
    const cont2 = doc.createElement('div');
    assert.ok(splitRichField(cont, cont2, { fits: capFits(cont, 10) }));
    assert.equal(cont.firstChild.getAttribute('start'), '11');
    assert.equal(cont2.firstChild.getAttribute('start'), '21');
    const cont3 = doc.createElement('div');
    assert.ok(splitRichField(cont2, cont3, { fits: capFits(cont2, 10) }));
    assert.equal(count(cont3.innerHTML, /<thead/g), 1, 'на третьей странице заголовок один');
    for (const c of [cont, cont2, cont3]) joinCont(f, c, 'rich');
    assert.equal(f.innerHTML, before);
});

// ─── слияние после правок ────────────────────────────────────────────────────
test('F5: правка в продолжении (новый пункт, новая строка таблицы) доживает до слияния — в тот же список и ту же таблицу', () => {
    let { doc, f, cont } = setup('<ul>' + items(1, 6) + '</ul><p>x</p>');
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 3) }));
    const li = doc.createElement('li'); li.appendChild(doc.createTextNode('Новый'));
    cont.querySelector('ul[data-cont-split]').appendChild(li);
    joinCont(f, cont, 'rich');
    assert.equal(f.innerHTML, '<ul>' + items(1, 6) + '<li>Новый</li></ul><p>x</p>');
    ({ doc, f, cont } = setup(RESTBL(1, 6)));
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 4) }));
    cont.querySelector('tbody[data-cont-split]').appendChild(el(doc, '<tr><td>Новая</td><td>1</td></tr>'));
    joinCont(f, cont, 'rich');
    assert.equal(f.querySelectorAll('table').length, 1);
    assert.equal(f.querySelectorAll('tbody').length, 1);
    assert.equal(f.querySelector('tbody').lastChild.textContent, 'Новая1');
    assert.equal(count(f.innerHTML, /<thead/g), 1);
});

test('F5: оригинал на первой странице удалён — продолжение остаётся своим списком и таблицей, без меток и с заголовком', () => {
    const { f, cont } = setup('<p>x</p><ol>' + items(1, 6) + '</ol>' + RESTBL(1, 6));
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 12) }));
    assert.ok(cont.querySelector('table[data-cont-split]'), 'таблица разделена');
    f.removeChild(f.querySelector('table'));
    joinCont(f, cont, 'rich');
    assert.ok(!/data-cont|contenteditable/.test(f.innerHTML), f.innerHTML);
    assert.equal(count(f.innerHTML, /<thead/g), 1, 'у таблицы продолжения свой заголовок');
});

test('F5: слияние строк — <br> между частями ставится, только когда обе стороны строчные', () => {
    const doc = miniDocument();
    const j = (a, b, mode) => { const t = el(doc, '<div>' + a + '</div>'); joinCont(t, el(doc, '<div>' + b + '</div>'), mode); return t.innerHTML; };
    assert.equal(j('а<br>б', 'в', 'text'), 'а<br>б<br>в', 'простой текст: части — строки, как «\\n» раньше');
    assert.equal(j('а', '<div>в</div>', 'text'), 'а<div>в</div>');
    assert.equal(j('<div>а</div>', 'в', 'text'), '<div>а</div>в');
    assert.equal(j('а<br>', 'в', 'rich'), 'а<br>в', 'разрез по блокам оставил <br> — второй не нужен');
    assert.equal(j('а', 'в', 'rich'), 'а<br>в', 'конечный <br> стёрт правкой — строки не слипаются');
    assert.equal(j('<ul><li>а</li></ul>', '<ul data-cont-split="1"><li>б</li></ul>', 'rich'), '<ul><li>а</li><li>б</li></ul>');
    assert.ok(contIsBlank(el(doc, '<div><br></div>')));
    assert.ok(!contIsBlank(el(doc, '<div><ul><li><br></li></ul></div>')));
});

// ─── курсор ───────────────────────────────────────────────────────────────────
test('F5: курсор — метка в DOM: ставится в выделение, переезжает вместе с текстом, снимается, текст снова цел', () => {
    const { f, cont } = setup('<ul>' + items(1, 8) + '<li>Печень у края</li></ul>');
    const li = f.querySelectorAll('li')[8];
    const mark = insertCaretMark(li.firstChild, 6);
    assert.ok(mark && mark.getAttribute('data-caret-mark') === '1');
    assert.equal(li.innerHTML, 'Печень<span data-caret-mark="1"></span> у края');
    assert.ok(fieldIsRich(f));
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 5) }));
    assert.ok(cont.contains(mark), 'метка не уехала с пунктом');
    const at = takeCaretMark(cont);
    assert.equal(at.node.nodeType, 3);
    assert.equal(at.node.data, 'Печень у края', 'текстовый узел не склеен обратно');
    assert.equal(at.offset, 6);
    assert.equal(li.childNodes.length, 1);
    assert.ok(!/data-caret-mark/.test(cont.innerHTML + f.innerHTML));
    // слияние и новый разрез метку тоже переносят
    const m2 = insertCaretMark(at.node, 2);
    joinCont(f, cont, 'rich');
    assert.ok(f.contains(m2));
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 5) }));
    assert.equal(takeCaretMark(cont).offset, 2);
});

test('F5: метка курсора — в начале и в конце текста, в пустом пункте; в самом списке или таблице не ставится; лишние снимаются', () => {
    const doc = miniDocument();
    const box = el(doc, '<div><ul><li>абв</li><li><br></li></ul></div>');
    const t = box.querySelector('li').firstChild;
    insertCaretMark(t, 0);
    assert.deepEqual(((a) => [a.node === t, a.offset])(takeCaretMark(box)), [true, 0]);
    insertCaretMark(t, 3);
    assert.deepEqual(((a) => [a.node === t, a.offset])(takeCaretMark(box)), [true, 3]);
    const empty = box.querySelectorAll('li')[1];
    insertCaretMark(empty, 0);
    assert.equal(empty.innerHTML, '<span data-caret-mark="1"></span><br>');
    assert.deepEqual(((a) => [a.node === empty, a.offset])(takeCaretMark(box)), [true, 0]);
    assert.equal(insertCaretMark(box.querySelector('ul'), 1), null, 'метка в ul ломала бы список');
    insertCaretMark(t, 1); insertCaretMark(t.nextSibling.nextSibling, 1);
    assert.ok(takeCaretMark(box));
    assert.ok(!/data-caret-mark/.test(box.innerHTML), 'лишняя метка осталась');
    assert.equal(takeCaretMark(box), null);
});

// ─── форма: поле целиком ─────────────────────────────────────────────────────
test('F5: форма получает поле целиком — каждый список и таблица один раз, слиты, без меток продолжения и курсора', () => {
    const { doc, f, cont } = setup(MIXED);
    const before = f.innerHTML;
    // 6 строк до таблицы + заголовок + 2 строки данных: разрез внутри таблицы
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 9) }));
    placeCont(doc, cont);
    assert.ok(cont.querySelector('[data-cont-head]') && cont.querySelector('[data-cont-split]'), 'разрез прошёл внутри таблицы');
    insertCaretMark(cont.querySelector('td').firstChild, 1);
    const merged = mergedFieldClone([f, cont]);
    assert.equal(merged.innerHTML, before, 'слитая копия — не то поле');
    assert.ok(cont.querySelector('[data-caret-mark]'), 'копия тронула живое продолжение');
    const html = WS._blankFieldHtml([f, cont]);
    assert.equal(html, sanitizeStoredHtml(before));
    assert.equal(count(html, /<table/g), 1);
    assert.equal(count(html, /<thead/g), 1);
    assert.equal(count(html, /<ol/g), 1);
    assert.ok(!/data-|contenteditable|start=/.test(html), html);
});

test('F5: набранное в продолжении — в том же списке и той же таблице формы; простой текст — строками; пустое продолжение не добавляет строк', () => {
    let { doc, f, cont } = setup('<ol>' + items(1, 6) + '</ol>');
    assert.ok(splitRichField(f, cont, { fits: capFits(f, 3) }));
    placeCont(doc, cont);
    const li = doc.createElement('li'); li.appendChild(doc.createTextNode('Сон'));
    cont.firstChild.appendChild(li);
    assert.equal(WS._blankFieldHtml([f, cont]), '<ol>' + items(1, 6) + '<li>Сон</li></ol>');
    // простой текст (A4_TEXT_SPLIT_V1): части — строки
    ({ doc, f, cont } = setup('строка1<br>строка2', 'hpi', 'sec-b'));
    cont.innerHTML = 'строка3';
    placeCont(doc, cont, 'hpi', 'text', 'sec-b');
    assert.equal(WS._blankFieldHtml([f, cont]), 'строка1<br>строка2<br>строка3');
    cont.innerHTML = 'три <b>жирно</b>';
    assert.equal(WS._blankFieldHtml([f, cont]), 'строка1<br>строка2<br>три <b>жирно</b>');
    cont.innerHTML = '<br>';
    assert.equal(WS._blankFieldHtml([f, cont]), 'строка1<br>строка2');
    // продолжение без оригинала — своим списком, без start и меток
    ({ doc, f, cont } = setup('<p>текст</p>'));
    cont.innerHTML = '<ol data-cont-split="1" start="6"><li>x</li></ol>';
    placeCont(doc, cont);
    assert.equal(WS._blankFieldHtml([f, cont]), '<p>текст</p><ol><li>x</li></ol>');
});
