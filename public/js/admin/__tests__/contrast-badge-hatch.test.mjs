// CONTRAST_GUARD_V1 (2026-09-05) — два места, где цвет НЕСЁТ СМЫСЛ, и где он
// дважды молча сползал до невидимого.
//
// Такие поломки не ловятся ни одним существующим тестом и не видны автору:
// правило есть, класс проставлен, элемент в DOM, разметка «работает». Не
// работает только глаз, и то не у всех и не на всяком мониторе. Поэтому
// считаем числа, а не проверяем наличие правила.
//
//   1. Красный счётчик у пункта меню (.nav-badge.alert). Когда активный пункт
//      стал залитой бирюзовой кнопкой, обычный счётчик починили (V3), а
//      тревожный забыли: --crit-500 на --primary-600 = 1.41:1 при норме 3:1.
//      Красная метка пропадала ровно на открытом разделе — и на свёрнутой
//      колонке, где цифру и так убирают (font-size: 0), а значит точка и есть
//      всё сообщение целиком.
//   2. Штриховка «врач сейчас не принимает» (.rcal-slot.off): --ink-25 по
//      --ink-50 = 1.04:1. На мониторе регистратуры нерабочего часа не видно
//      вовсе, и узнают о нём кликом и отказом.
//   3. SIDEBAR_SEAMLESS_V1 (2026-09-05) — колонка меню лишилась собственной
//      подложки и стала прозрачной: теперь она лежит на грунте страницы
//      var(--ink-50), а не на белом. Каждое число из пунктов 1-2 считалось
//      «против белой колонки», и молча поехало бы вместе с грунтом, поэтому
//      грунт здесь больше НЕ КОНСТАНТА — он читается из CSS (sidebarGround()
//      ниже) и заодно доказывает, что подложки и шва действительно нет.
//
// Порог: 3:1 — WCAG 2.2, 1.4.11 «Non-text Contrast», нижняя граница для
// элемента, который что-то сообщает не текстом. Для текста внутри таблетки —
// 4.5:1 (1.4.3): цифра мелкая и жирным её не спасти.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_DIR = path.resolve(HERE, '..', '..', '..', 'css');
// Переводы строк нормализуем: в репозитории core.autocrlf=true, а селекторы
// ниже ищутся вместе с переносом внутри — на свежем клоне под Windows поиск по
// '\n' иначе не нашёл бы ничего и тест «прошёл» бы, ничего не проверив.
// Комментарии вырезаем: rule() ниже режет тело правила по ';' и берёт всё до
// первого ':' как имя свойства — комментарий ВНУТРИ блока (а их в этих файлах
// много, объяснения живут рядом с правилом) приклеился бы к имени, и свойство
// просто «пропало» бы, а тест «прошёл» бы, ничего не проверив.
const readCss = (f) => fs.readFileSync(path.join(CSS_DIR, f), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const MAIN = readCss('admin.css');
const VIEWS = readCss('admin-views.css');

// --- цвет ------------------------------------------------------------------

/** Значения токенов берём ИЗ САМОГО CSS: тест обязан считать те цвета, что в файле. */
function tokens(css) {
    const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
    const map = {};
    for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) map[m[1]] = m[2];
    return map;
}
const T = tokens(MAIN);

function hex(value) {
    const v = String(value).trim();
    const m = v.match(/^var\((--[a-z0-9-]+)(?:\s*,\s*(#[0-9a-fA-F]{3,8}))?\)$/);
    if (m) {
        const tok = T[m[1]];
        assert.ok(tok || m[2], `токен ${m[1]} не найден в :root и запасного значения нет`);
        return hex(tok || m[2]);
    }
    const h = v.match(/^#([0-9a-fA-F]{3,8})$/);
    assert.ok(h, `не цвет: ${v}`);
    let s = h[1];
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    return '#' + s.slice(0, 6).toLowerCase();
}

function luminance(h) {
    const c = [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** Контраст по WCAG, округлённый вниз до сотых — как его считают проверялки. */
function ratio(a, b) {
    const x = luminance(hex(a)), y = luminance(hex(b));
    return Math.floor(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
}

// --- разбор правил ---------------------------------------------------------

/**
 * Объявления ВСЕХ правил с таким селектором, слитые по порядку файла.
 *
 * Именно по порядку, а не «последнее правило»: у .rcal-appt в файле два блока
 * (фон и рамка в одном, курсор в другом), и «последнее» вернуло бы только
 * курсор. Браузер их складывает — складываем и мы, поздние объявления
 * перекрывают ранние.
 */
function rule(css, selector) {
    const out = {};
    let found = 0;
    let at = 0;
    for (;;) {
        const idx = css.indexOf(selector + ' {', at);
        if (idx === -1) break;
        at = idx + selector.length;
        // Не хвост чужого селектора: '.nav-badge' не должен ловить
        // '.sidebar-body .nav-item .nav-badge'.
        const before = css[idx - 1];
        if (before && !'\n};'.includes(before)) continue;
        found += 1;
        const body = css.slice(idx + selector.length + 2, css.indexOf('}', idx));
        for (const part of body.split(';')) {
            const i = part.indexOf(':');
            if (i === -1) continue;
            out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
    }
    assert.ok(found > 0, `правило «${selector}» пропало из CSS — переименовали или удалили`);
    return out;
}

/** Числовое значение токена-длины из :root ('--nav-gutter' → 8). */
function lengthToken(name) {
    const root = MAIN.slice(MAIN.indexOf(':root'), MAIN.indexOf('}', MAIN.indexOf(':root')));
    const m = root.match(new RegExp(name + '\\s*:\\s*(-?[0-9.]+)px\\s*;'));
    assert.ok(m, 'токен ' + name + ' пропал из :root');
    return parseFloat(m[1]);
}

/** Пиксели из значения: '8px', голый '0' или 'var(--nav-gutter)'. */
function px(value) {
    const v = String(value).trim();
    const t = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (t) return lengthToken(t[1]);
    if (v === '0') return 0;
    const m = v.match(/^(-?[0-9.]+)px$/);
    assert.ok(m, 'не длина в px: ' + v);
    return parseFloat(m[1]);
}

/**
 * Грунт, на котором лежит колонка меню, — и заодно проверка, что колонка
 * перестала быть панелью. Если кто-то вернёт ей фон или правую границу, тест
 * упадёт ЗДЕСЬ, до всякой арифметики: дальше считать было бы уже не то.
 */
function sidebarGround() {
    const side = rule(MAIN, '.sidebar');
    const bg = side.background;
    assert.ok(!bg || bg === 'transparent' || bg === 'none',
        'у колонки меню снова своя подложка (' + bg + ') — это и есть панель, шов вернулся');
    for (const k of Object.keys(side)) {
        assert.ok(!/^border(-right)?$/.test(k) || /^(0|none)/.test(side[k]),
            'у колонки меню снова граница (' + k + ': ' + side[k] + ') — это шов');
        assert.ok(k !== 'box-shadow' || /^none/.test(side[k]),
            'у колонки меню снова тень — она опять читается отдельной поверхностью');
    }
    // Прозрачная колонка показывает грунт страницы — его и возвращаем.
    return rule(MAIN, 'body.admin').background;
}

test('санитарная проверка самого счётчика контраста', () => {
    assert.strictEqual(ratio('#000000', '#ffffff'), 21);
    assert.strictEqual(ratio('#ffffff', '#ffffff'), 1);
    // Ровно та пара, ради которой всё это написано.
    assert.strictEqual(ratio('var(--crit-500)', 'var(--primary-600)'), 1.4);
});

// --- 1. красный счётчик ----------------------------------------------------

test('красный счётчик виден на ВЫБРАННОМ пункте меню — том самом, где он и пропадал', () => {
    const filled = rule(MAIN, '.sidebar-collapsed .nav-item.active,\n.sidebar-collapsed .nav-item.active:hover').background
        || 'var(--primary-600)';
    const alert = rule(VIEWS, '.sidebar-body .nav-item.active .nav-badge.alert');

    const pill = ratio(alert.background, filled);
    assert.ok(pill >= 3, `таблетка на залитом пункте: ${pill}:1 при норме 3:1 (WCAG 1.4.11)`);

    const digits = ratio(alert.color, alert.background);
    assert.ok(digits >= 4.5, `цифра в таблетке: ${digits}:1 при норме 4.5:1 (WCAG 1.4.3)`);

    // И она по-прежнему КРАСНАЯ, а не просто контрастная: это тревога, а не
    // ещё один счётчик. Красный канал заметно сильнее двух остальных.
    const red = hex(alert.color === '#fff' || alert.color === '#ffffff' ? alert.background : alert.color);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(red.slice(1 + i, 3 + i), 16));
    assert.ok(r > g + 60 && r > b + 60, `цвет тревоги ${red} перестал быть красным`);
});

test('красный счётчик виден и на НЕвыбранном пункте — там он прямо на грунте колонки', () => {
    const alert = rule(VIEWS, '.sidebar-body .nav-item .nav-badge.alert');
    // Не '#ffffff': колонка прозрачна (SIDEBAR_SEAMLESS_V1), под ней грунт
    // страницы. Читаем его из CSS, чтобы число не разошлось с экраном.
    const sidebar = sidebarGround();
    const pill = ratio(alert.background, sidebar);
    assert.ok(pill >= 3, `таблетка на грунте колонки: ${pill}:1 при норме 3:1`);
    const digits = ratio(alert.color, alert.background);
    assert.ok(digits >= 4.5, `цифра в таблетке: ${digits}:1 при норме 4.5:1`);
});

test('обычный счётчик пережил смену грунта — и как форма, и как цифра', () => {
    // Он был ink-100 на белой колонке; на грунте ink-50 та же таблетка дала бы
    // 1.09:1, то есть перестала бы быть таблеткой. Цифру держит её
    // собственный контраст, но чип обязан читаться чипом.
    const chip = rule(VIEWS, '.sidebar-body .nav-item .nav-badge');
    const ground = sidebarGround();
    const digits = ratio(chip.color, chip.background);
    assert.ok(digits >= 4.5, `цифра счётчика: ${digits}:1 при норме 4.5:1`);
    // Цифра читается и без таблетки — на случай, если чип кто-то ослабит.
    const digitsOnGround = ratio(chip.color, ground);
    assert.ok(digitsOnGround >= 4.5, `цифра прямо на грунте: ${digitsOnGround}:1`);
    const shape = ratio(chip.background, ground);
    assert.ok(shape > 1.2, `таблетка счётчика на грунте: ${shape}:1 — формы не видно`);
});

test('на свёрнутой колонке точка тревоги видна — цифры там нет, точка и есть всё сообщение', () => {
    // Свёрнутая колонка убирает число (font-size: 0), поэтому «прочитать
    // счётчик» там нельзя в принципе: либо точку видно, либо тревоги нет.
    const dot = rule(MAIN, '.sidebar-collapsed .nav-badge');
    assert.match(dot['font-size'], /^0/, 'цифра на рейке вернулась — тест ниже рассуждает про точку');

    const alert = rule(MAIN, '.sidebar-collapsed .nav-badge.alert,\n.sidebar-collapsed .nav-item.active .nav-badge.alert');
    const filled = 'var(--primary-600)';

    // Приём — кольцо противоположного цвета: тогда точке не нужно
    // перекрикивать фон, ей достаточно перекрикивать собственное кольцо.
    const ring = alert['box-shadow'];
    assert.ok(ring, 'у точки тревоги нет кольца — на бирюзовой заливке её снова не будет видно');
    const ringColor = ring.match(/(var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})\s*$/);
    assert.ok(ringColor, `не разобрать цвет кольца: ${ring}`);

    const ringVsFilled = ratio(ringColor[1], filled);
    assert.ok(ringVsFilled >= 3, `кольцо на залитом пункте: ${ringVsFilled}:1 при норме 3:1`);
    const coreVsRing = ratio(alert.background, ringColor[1]);
    assert.ok(coreVsRing >= 3, `ядро точки на своём кольце: ${coreVsRing}:1 при норме 3:1`);
    // На невыбранном пункте кольца не видно вовсе — там всё держит само ядро.
    // Грунт читаем из CSS: он больше не белый (SIDEBAR_SEAMLESS_V1).
    const coreVsGround = ratio(alert.background, sidebarGround());
    assert.ok(coreVsGround >= 3, `ядро точки на грунте колонки: ${coreVsGround}:1 при норме 3:1`);

    // Кольцо съедает точку: 8px под 2px кольцом — это уже крапинка.
    assert.ok(parseFloat(alert.width) >= 10, `точка ${alert.width} под кольцом 2px слишком мелкая`);
});

// --- 3. колонка меню без шва ------------------------------------------------

test('колонка меню больше не отдельная поверхность — ни подложки, ни границы, ни тени', () => {
    // sidebarGround() и есть эта проверка; здесь она названа вслух, чтобы при
    // падении было видно, ЧТО именно вернули.
    const ground = sidebarGround();
    assert.strictEqual(hex(ground), hex('var(--ink-50)'),
        'грунт страницы сменился — все числа ниже считаются против него');
    // Внутренние линейки — тоже часть «панели»: шапка колонки отделялась от
    // меню чертой ровно того же цвета, что и правая граница.
    const brand = rule(MAIN, '.sidebar-brand');
    assert.ok(!brand['border-bottom'], 'под знаком бренда снова линейка — колонка опять с собственной шапкой');
});

test('выбранный пункт виден на новом грунте — и как кнопка, и как надпись', () => {
    const fill = rule(MAIN, '.nav-item.active,\n.nav-item.active:hover');
    const ground = sidebarGround();

    // Заливка против грунта. Норма 3:1 — WCAG 1.4.11: «вы здесь» сообщается
    // формой и цветом, а не текстом. Против белой колонки было 5.35:1.
    const button = ratio(fill.background, ground);
    assert.ok(button >= 3, `залитый пункт на грунте колонки: ${button}:1 при норме 3:1`);

    // Надпись на заливке — обычный текст, 4.5:1.
    const label = ratio(fill.color, fill.background);
    assert.ok(label >= 4.5, `надпись выбранного пункта: ${label}:1 при норме 4.5:1`);

    // Замок «модуль не куплен» на той же заливке: не текст, 3:1.
    const lock = rule(MAIN, '.sidebar .nav-item.active .nav-lock-icon');
    const lockRatio = ratio(lock.color, fill.background);
    assert.ok(lockRatio >= 3, `замок на залитом пункте: ${lockRatio}:1 при норме 3:1`);

    // Контур фокуса на заливке: белый по бирюзовому.
    const focus = rule(MAIN, '.nav-item.active:focus-visible');
    const ring = focus.outline.match(/#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\)/);
    assert.ok(ring, `не разобрать контур фокуса: ${focus.outline}`);
    const focusRatio = ratio(ring[0], fill.background);
    assert.ok(focusRatio >= 3, `контур фокуса на заливке: ${focusRatio}:1 при норме 3:1`);
});

test('у пункта меню есть горизонтальные поля — и от них ничего не подрезает', () => {
    const item = rule(MAIN, '.sidebar .nav-item');
    const left = px(item['margin-left']);
    const right = px(item['margin-right']);
    assert.ok(left > 0 && right > 0,
        `пункт меню снова от края до края (поля ${left}/${right}px) — заливка упирается в стенки колонки`);
    assert.strictEqual(left, right, 'поля пункта несимметричны');

    // Поля БЕЗ этой строки дают переполнение: width: 100% считается от ширины
    // контейнера, а margin прибавляется сверху — «таблетку» подрезало бы
    // (.sidebar-body: overflow-y: auto, значит по горизонтали тоже не visible).
    assert.strictEqual(item.width, 'auto',
        'у пункта с полями осталась width: 100% — длинное меню поедет горизонтально');
    const nav = rule(MAIN, '.sidebar-body .nav');
    assert.strictEqual(nav.display, 'flex', 'контейнер пунктов не флекс — stretch не сработает и width: auto сожмёт кнопку по тексту');
    assert.ok(parseFloat(nav.gap) > 0, 'между пунктами нет вертикального зазора');
});

test('заголовок раздела и пункт меню выведены из одного числа', () => {
    // Раньше 14px у заголовка против 12px у пункта — «почти». После вреза
    // пунктов такое «почти» становится видно, поэтому отступ заголовка теперь
    // ВЫЧИСЛЯЕТСЯ: врез + собственный padding пункта.
    const gutter = lengthToken('--nav-gutter');
    const item = rule(MAIN, '.nav-item');
    const pad = parseFloat(item.padding.split(/\s+/)[1]);
    const section = rule(MAIN, '.nav-section');
    const m = section.padding.match(/calc\(var\(--nav-gutter\)\s*\+\s*([0-9.]+)px\)/);
    assert.ok(m, `отступ заголовка раздела снова задан отдельно: ${section.padding}`);
    assert.strictEqual(parseFloat(m[1]), pad,
        'слагаемое в заголовке разошлось с padding пункта — надпись раздела съедет с иконок');
    assert.ok(gutter > 0);
});

test('на свёрнутой рейке заливка тоже не упирается в края', () => {
    const item = rule(MAIN, '.sidebar-collapsed .nav-item');
    const left = px(item['margin-left']);
    const right = px(item['margin-right']);
    assert.ok(left > 0 && right > 0,
        `на 68px рейке залитая кнопка снова во всю ширину (поля ${left}/${right}px) — читается как сбой вёрстки`);

    // Врез задаёт ТОЛЬКО поле пункта. Если вернуть padding контейнеру, оба
    // отступа сложатся и от кнопки на рейке останется полоска.
    const nav = rule(MAIN, '.sidebar-collapsed .nav');
    assert.strictEqual(px(nav['padding-left']), 0, 'padding рейки сложится с полем пункта — кнопка станет полоской');
    assert.strictEqual(px(nav['padding-right']), 0, 'padding рейки сложится с полем пункта — кнопка станет полоской');

    // Проверяем итог в пикселях, а не «правило есть»: 68px рейка минус два поля.
    const rail = lengthToken('--sidebar-w');   // 248 в :root; ширину рейки берём из её собственного правила
    const collapsed = rule(MAIN, '.sidebar-collapsed');
    const railW = px(collapsed['--sidebar-w']);
    const pill = railW - left - right;
    assert.ok(pill >= 40, `кнопка на рейке ${pill}px при рейке ${railW}px — слишком узкая для иконки 18px с воздухом`);
    assert.ok(rail > railW);
});

// --- 2. нерабочие часы -----------------------------------------------------

test('«врач сейчас не принимает» видно на белой сетке — и штриховка остаётся штриховкой', () => {
    const off = rule(VIEWS, '.rcal-slot.off');
    const stops = [...off.background.matchAll(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
    assert.ok(stops.length >= 2, `не разобрать штриховку: ${off.background}`);

    const uniq = [...new Set(stops.map(hex))];
    assert.strictEqual(uniq.length, 2, `в штриховке ${uniq.length} цвета — ожидались ровно два`);
    const dark = uniq.slice().sort((a, b) => luminance(a) - luminance(b))[0];

    // Против рабочего слота: он белый (.rcal-slot без .off ничем не залит).
    const vsWorking = ratio(dark, '#ffffff');
    assert.ok(vsWorking >= 3, `тёмная полоска против рабочего слота: ${vsWorking}:1 при норме 3:1 (WCAG 1.4.11)`);

    // Сама с собой: без этого «штриховка» — просто ровная заливка, и от
    // выключенного слота её не отличить.
    const stripes = ratio(uniq[0], uniq[1]);
    assert.ok(stripes >= 3, `полоски между собой: ${stripes}:1 — узора не видно`);

    // Но не чёрная стена: сетка на весь день не должна кричать.
    assert.ok(luminance(dark) > 0.1, `штриховка ${dark} слишком тёмная — расписание станет шумным`);

    // От ЗАНЯТОГО слота отличается не фоном, а тем, что занятый — карточка
    // поверх сетки. Проверяем, что она осталась карточкой.
    const appt = rule(VIEWS, '.rcal-appt');
    assert.match(appt.background, /white|#fff/i, 'занятый слот перестал быть белой карточкой — теперь его можно спутать со штриховкой');
    assert.ok(appt.border, 'у занятого слота пропала рамка');
});
