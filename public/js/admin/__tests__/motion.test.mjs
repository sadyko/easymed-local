// MOTION_REVEAL_V1 (2026-09-05) — тесты общего помощника движения
// (public/js/admin/motion.js, план — задача 8).
//
// Что здесь действительно проверяется — по одному предложению на решение:
//
//   * ПОМОЩНИК ПОКАЗЫВАЕТ и снимает показанное с наблюдения: наблюдатель
//     живёт ровно столько, сколько в нём есть смысл, а не до конца сессии;
//   * НА ЭКРАН — ОДИН НАБЛЮДАТЕЛЬ: пятьсот строк таблицы не заводят пятьсот
//     наблюдателей (ради этого помощник и общий);
//   * «МЕНЬШЕ ДВИЖЕНИЯ» — это НЕ «анимация покороче»: наблюдателя нет вовсе,
//     содержимое видно сразу;
//   * НЕТ IntersectionObserver (киоск, старый WebView) — содержимое видно
//     сразу. Это главный тест файла: помощник появления, который отказал,
//     оставляет клинику перед ПУСТЫМ экраном, и такой отказ хуже, чем
//     отсутствие анимации;
//   * НАБЛЮДАТЕЛЬ СОЗДАН, НО МОЛЧИТ — сторожевой таймер всё равно показывает:
//     живой IntersectionObserver отвечает сразу после observe(), молчащий
//     сломан;
//   * ВНУТРИ ДИАЛОГА не наблюдаем ничего: появление окна уже переход;
//   * ЗАГОЛОВОК ТАБЛИЦЫ не появляется: шапка — рамка экрана, а не содержимое;
//   * ПОСЛЕ ПОЯВЛЕНИЯ от помощника не остаётся классов: забытый .reveal-in
//     задаёт transform: none и молча отменил бы подъём карточки при
//     наведении;
//   * СЛОВАРЬ ОДИН: в правилах, которые эта работа завела и переписала, нет
//     ни одной длительности литералом — только токены --dur-*/--ease-*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');       // …/public
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');

// ---------------------------------------------------------------------------
// Поддельный DOM. Ровно столько, сколько трогает motion.js: класс-лист,
// style, атрибуты, родитель и querySelectorAll по одному атрибуту.
// ---------------------------------------------------------------------------
class E {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this.className = '';
        this.style = {};
        this.attrs = {};
        this.children = [];
        this.parentNode = null;
    }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i > -1) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
    }
    get classList() {
        const self = this;
        const parts = () => String(self.className || '').split(/\s+/).filter(Boolean);
        return {
            contains: (c) => parts().includes(c),
            add(c) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); },
            remove(c) { self.className = parts().filter((x) => x !== c).join(' '); },
            toggle(c, on) { if (on) this.add(c); else this.remove(c); },
        };
    }
    descendants() {
        const out = [];
        for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
        return out;
    }
    // Достаточно ровно того селектора, которым пользуется приложение.
    querySelectorAll(sel) {
        const attr = /^\[([a-z-]+)\]$/.exec(String(sel));
        if (attr) return this.descendants().filter((n) => attr[1] in n.attrs);
        const cls = /^\.([a-z0-9_-]+)$/i.exec(String(sel));
        if (cls) return this.descendants().filter((n) => n.classList.contains(cls[1]));
        return [];
    }
}

const has = (el, cls) => String(el.className || '').split(/\s+/).includes(cls);

// Токены читаются ИЗ ТОГО ЖЕ ФАЙЛА, что и в приложении: тест не имеет права
// знать «140», он обязан знать «--dur-2».
const CSS = read('css/admin.css');
function tokenValue(name) {
    const m = new RegExp('\\' + name + ':\\s*([^;]+);').exec(CSS);
    assert.ok(m, 'токен ' + name + ' пропал из admin.css — движению не на чем стоять');
    return m[1].trim();
}
const TOKENS = {
    '--dur-1': tokenValue('--dur-1'),
    '--dur-2': tokenValue('--dur-2'),
    '--dur-3': tokenValue('--dur-3'),
    '--ease-out': tokenValue('--ease-out'),
};

let reduceMotion = false;
let observers = [];

class FakeIO {
    constructor(cb, opts) {
        this.cb = cb; this.opts = opts;
        this.observed = new Set();
        this.unobserved = [];
        this.disconnected = false;
        observers.push(this);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); this.unobserved.push(el); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    /** Сказать помощнику, что элементы вошли в экран. */
    fire(els) { this.cb(els.map((target) => ({ target, isIntersecting: true })), this); }
}

function installDom({ io = true } = {}) {
    reduceMotion = false;
    observers = [];
    const html = new E('html');
    globalThis.document = { documentElement: html, body: new E('body') };
    globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => TOKENS[k] || '' });
    globalThis.window = { matchMedia: (q) => ({ matches: /reduce/.test(q) && reduceMotion }) };
    if (io) globalThis.IntersectionObserver = FakeIO;
    else delete globalThis.IntersectionObserver;
    // Без requestAnimationFrame помощник показывает в том же кадре — тесту
    // так виднее, а в приложении кадр всё равно есть.
    delete globalThis.requestAnimationFrame;
}

installDom();
const motion = await import('../motion.js');

function rows(n, { tag = 'tr', into = null } = {}) {
    const root = into || new E(tag === 'tr' ? 'tbody' : 'div');
    for (let i = 0; i < n; i++) {
        const el = new E(tag);
        el.setAttribute('data-reveal', '');
        root.appendChild(el);
    }
    return root;
}

// ===========================================================================

test('элемент появляется, когда вошёл в экран, и тут же снимается с наблюдения', () => {
    installDom();
    const root = rows(3);
    const c = motion.revealOn(root, '[data-reveal]');

    assert.equal(c.mode, 'observed');
    assert.equal(observers.length, 1, 'наблюдатель не создан');
    assert.equal(observers[0].observed.size, 3);
    // До появления они спрятаны — но спрятал их ИМЕННО помощник, а не разметка.
    for (const el of root.children) assert.ok(has(el, 'reveal-init'), 'элемент не подготовлен к появлению');

    const first = root.children[0];
    observers[0].fire([first]);

    assert.ok(has(first, 'reveal-in'), 'вошедший в экран элемент не показан');
    assert.deepEqual(observers[0].unobserved, [first], 'показанный элемент остался под наблюдением');
    assert.equal(observers[0].observed.size, 2, 'наблюдение не сузилось');
    // Соседи ещё ждут своей очереди — в этом и смысл появления при прокрутке.
    assert.ok(!has(root.children[1], 'reveal-in'));
});

test('после появления от помощника не остаётся классов — карточка снова своя', (t) => {
    installDom();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = rows(2, { tag: 'div' });
    motion.revealOn(root, '[data-reveal]');
    observers[0].fire([...root.children]);

    assert.ok(has(root.children[0], 'reveal-in'));
    // Уборка одна на пачку и приходит после самой длинной ступени словаря.
    t.mock.timers.tick(5000);
    for (const el of root.children) {
        assert.ok(!has(el, 'reveal-init'), 'скрывающий класс остался жить на элементе');
        assert.ok(!has(el, 'reveal-in'), '.reveal-in остался и отменяет собственный transform карточки');
        assert.equal(el.style.transitionDelay, '', 'задержка перехода осталась на элементе');
    }
});

test('«меньше движения»: наблюдателя нет вовсе, содержимое видно сразу', () => {
    installDom();
    reduceMotion = true;
    const root = rows(4);
    const c = motion.revealOn(root, '[data-reveal]');

    assert.equal(c.mode, 'immediate');
    assert.equal(c.observer, null);
    assert.equal(observers.length, 0, 'при просьбе «меньше движения» заведён наблюдатель');
    for (const el of root.children) {
        assert.ok(!has(el, 'reveal-init'), 'элемент спрятан — экран останется пустым');
    }
});

test('нет IntersectionObserver — ничего не прячем: киоск показывает содержимое', () => {
    installDom({ io: false });
    const root = rows(6);
    const c = motion.revealOn(root, '[data-reveal]');

    assert.equal(c.mode, 'immediate');
    assert.equal(c.observer, null);
    assert.equal(c.revealed, 6);
    for (const el of root.children) {
        assert.ok(!has(el, 'reveal-init'),
            'без IntersectionObserver элемент остался с opacity: 0 — это белый экран, а не «без анимации»');
    }
});

test('наблюдатель создан, но молчит — сторожевой таймер всё равно показывает', (t) => {
    installDom();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = rows(3, { tag: 'div' });
    motion.revealOn(root, '[data-reveal]');
    for (const el of root.children) assert.ok(has(el, 'reveal-init'));

    // Живой наблюдатель отвечает сразу после observe(). Этот не ответил ни разу.
    t.mock.timers.tick(2000);
    for (const el of root.children) assert.ok(has(el, 'reveal-in'), 'молчащий наблюдатель оставил элемент спрятанным');
    assert.equal(observers[0].disconnected, true, 'сломанный наблюдатель не снят');
});

test('пятьсот строк — ОДИН наблюдатель, а не пятьсот', () => {
    installDom();
    const root = rows(500);
    const c = motion.revealOn(root, '[data-reveal]');

    assert.equal(observers.length, 1, 'наблюдателей стало ' + observers.length + ' — по одному на строку');
    assert.equal(c.observed, 500);
    assert.equal(observers[0].observed.size, 500);

    // И входят они пачкой, в один проход, а не пятьюстами отдельными правками.
    observers[0].fire([...root.children]);
    for (const el of root.children) assert.ok(has(el, 'reveal-in'));
    // Лесенка задержек ограничена: последняя строка не ждёт пятисот ступеней.
    const delays = root.children.map((el) => parseFloat(el.style.transitionDelay || '0'));
    const step = parseFloat(TOKENS['--dur-1']);
    assert.ok(Math.max(...delays) <= step * 4 + 0.001,
        'задержка выросла до ' + Math.max(...delays) + 'ms — последняя строка появится через минуту');
});

test('внутри диалога не наблюдаем ничего — появление окна уже переход', () => {
    installDom();
    const overlay = new E('div');
    overlay.className = 'modal';
    const card = new E('div');
    card.className = 'modal-card';
    overlay.appendChild(card);
    const inner = rows(3, { tag: 'div', into: card });

    const c = motion.revealOn(overlay, '[data-reveal]');
    assert.equal(c.observed, 0, 'помощник полез внутрь диалога');
    assert.equal(observers.length, 0);
    for (const el of inner.children) assert.ok(!has(el, 'reveal-init'));
});

test('диалог узнаётся и через closest — путь настоящего браузера', () => {
    installDom();
    const host = new E('div');
    const el = new E('div');
    el.setAttribute('data-reveal', '');
    el.closest = (sel) => (String(sel).includes('[role="dialog"]') ? host : null);
    host.appendChild(el);

    const c = motion.revealOn(host, '[data-reveal]');
    assert.equal(c.observed, 0, 'closest сказал «это диалог», а помощник всё равно наблюдает');
});

test('заголовок таблицы не появляется — шапка это рамка экрана', () => {
    installDom();
    const table = new E('table');
    const thead = new E('thead');
    const headRow = new E('tr');
    headRow.setAttribute('data-reveal', '');
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = new E('tbody');
    table.appendChild(tbody);
    rows(2, { into: tbody });

    const c = motion.revealOn(table, '[data-reveal]');
    assert.equal(c.observed, 2, 'наблюдаемых ' + c.observed + ' — в счёт попала шапка');
    assert.ok(!has(headRow, 'reveal-init'), 'строка заголовка спрятана');
});

test('повторная отрисовка не копит наблюдателей: прошлый снимается сам', () => {
    installDom();
    const root = rows(3);
    motion.revealOn(root, '[data-reveal]');
    const first = observers[0];
    motion.revealOn(root, '[data-reveal]');

    assert.equal(observers.length, 2);
    assert.equal(first.disconnected, true, 'наблюдатель прошлой отрисовки продолжает жить');
    assert.equal(observers[1].disconnected, false);
});

test('снятие помощника показывает всё, что осталось спрятанным', () => {
    installDom();
    const root = rows(4, { tag: 'div' });
    const c = motion.revealOn(root, '[data-reveal]');
    c.disconnect();

    assert.equal(observers[0].disconnected, true);
    for (const el of root.children) {
        assert.ok(!has(el, 'reveal-init'),
            'панель ушла в кэш экранов прозрачной — вернувшись, сотрудник увидит пустоту');
    }
    assert.equal(motion.stopReveal(root), false, 'снятый помощник остался в реестре');
});

test('прокрутка к якорю: плавно обычно, мгновенно при просьбе «меньше движения»', () => {
    installDom();
    const seen = [];
    const target = { scrollIntoView: (o) => seen.push(o) };

    motion.smoothScrollTo(target, { block: 'start' });
    assert.equal(seen[0].behavior, 'smooth');

    reduceMotion = true;
    motion.smoothScrollTo(target, { block: 'start' });
    assert.equal(seen[1].behavior, 'auto', 'просьбу «меньше движения» прокрутка не услышала');
});

test('закрытие окна убирает его ДАЖЕ там, где анимации нет', () => {
    installDom();
    const body = new E('body');
    const overlay = new E('div');
    overlay.className = 'modal';
    body.appendChild(overlay);
    let done = 0;

    motion.fadeOutAndRemove(overlay, () => { done++; });
    assert.equal(body.children.length, 0, 'окно не закрылось — без el.animate закрытие обязано быть немедленным');
    assert.equal(done, 1);
});

test('длительности берутся из токенов admin.css, а не из своих чисел', () => {
    installDom();
    assert.equal(motion.durMs('--dur-2'), parseFloat(TOKENS['--dur-2']));
    assert.equal(motion.easing('--ease-out'), TOKENS['--ease-out']);
    // Токена нет — запасное значение, а не падение экрана.
    assert.equal(motion.durMs('--dur-nope', 7), 7);
});

// ===========================================================================
// СЛОВАРЬ ОДИН. В правилах, которые завела и переписала эта работа, не должно
// быть ни одной длительности литералом — иначе через месяц у приложения снова
// будет 79 разных «сколько это длится».
// ===========================================================================

function section(css, name) {
    const i = css.indexOf(name);
    assert.ok(i > -1, 'секция ' + name + ' пропала');
    const rest = css.slice(i);
    const end = rest.indexOf('/* ============================================================\n   MOTION_', 10);
    return end > -1 ? rest.slice(0, end) : rest;
}

const TIMED = /(transition|animation)(-duration)?\s*:\s*([^;]+);/g;

test('новые правила движения написаны токенами, а не числами', () => {
    const views = read('css/admin-views.css');

    const owned = [
        section(CSS, 'MOTION_REVEAL_V1 (2026-09-05) — содержимое появляется'),
        section(CSS, 'MOTION_DIALOG_V1 (2026-09-05)'),
        // Правила, переписанные в admin-views.css: строка сохраняется целиком.
        ...views.split('\n').filter((l) =>
            /\.fade-in\s*\{/.test(l)
            || /\.reg-base-tbl tbody tr\.row-click td/.test(l)
            || /\.q-filters \.q-search input \{/.test(l)
            || /\.q-filters \.q-chips button \{/.test(l)),
        // …и следующая строка блока .q-chips button, где сам переход.
        views.split('\n')[views.split('\n').findIndex((l) => /\.q-filters \.q-chips button \{/.test(l)) + 4] || '',
    ].join('\n');

    let m;
    TIMED.lastIndex = 0;
    let checked = 0;
    while ((m = TIMED.exec(owned))) {
        const decl = m[3];
        checked++;
        assert.ok(/var\(--dur-[123]\)/.test(decl),
            'длительность мимо словаря: ' + m[0].trim());
        assert.ok(!/\b\d+(\.\d+)?m?s\b/.test(decl),
            'длительность литералом: ' + m[0].trim());
        assert.ok(/var\(--ease-/.test(decl),
            'кривая мимо словаря: ' + m[0].trim());
    }
    assert.ok(checked >= 5, 'проверено всего ' + checked + ' правил — тест перестал находить свои блоки');
});

test('скрывающий класс не написан ни в одной разметке — иначе выключенный JS = пустой экран', () => {
    const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out); }
            else if (/\.(js|mjs|html)$/.test(e.name) && !/motion\.js$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
        }
        return out;
    };
    const bad = walk(PUB).filter((f) => /['"`][^'"`]*\breveal-init\b/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(bad, [], 'скрывающий класс проставлен в разметке: ' + bad.join(', '));
});

test('экраны просят появление у ОБЩЕГО помощника, а не заводят свой наблюдатель', () => {
    const screens = ['js/admin/views/patients.js', 'js/admin/views/queue.js', 'js/admin/views/dashboard.js'];
    for (const rel of screens) {
        const src = read(rel);
        assert.ok(/from '\.\.\/motion\.js/.test(src), rel + ' не подключил общий помощник');
        assert.ok(/revealOn\(/.test(src), rel + ' не просит появления');
        assert.ok(!/new IntersectionObserver/.test(src), rel + ' завёл СВОЙ наблюдатель — помощник затем и общий');
    }
});

test('возврат на экран остаётся МГНОВЕННЫМ, хотя якоря теперь едут', () => {
    // html { scroll-behavior: smooth } делает плавным всё, что просит
    // behavior: 'auto' — в том числе восстановление позиции при возврате на
    // экран. Возврат туда, где стоял, — не переход, а состояние: он обязан
    // произойти в том же кадре, иначе кэш панелей теряет смысл.
    assert.ok(/html \{ scroll-behavior: smooth; \}/.test(CSS), 'прокрутка к якорям перестала быть плавной');
    // Комментарии снимаем: решение «здесь стояла всегда-ложная проверка, вот
    // чем она была плоха» обязано остаться в коде. Смотрим на то, что исполняется.
    const lines = read('js/admin.js').split('\n');
    const shell = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(' ');
    assert.ok(/behavior: 'instant'/.test(shell), 'восстановление прокрутки больше не просит мгновенности явно');
    assert.ok(!/'instant' in window/.test(shell),
        "вернулась всегда-ложная проверка 'instant' in window — она просит 'auto', то есть плавно");
});
