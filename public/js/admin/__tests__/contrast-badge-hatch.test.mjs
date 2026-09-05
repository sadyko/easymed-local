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
    // WORKING_WINDOW_V1 — токен-псевдоним (--window-line: var(--ink-200)) тоже
    // цвет, просто названный по назначению, а не по оттенку. Без этого прохода
    // hex() падал бы на нём с «токен не найден», и правило, которое им
    // пользуется, пришлось бы проверять сырым значением — то есть мимо смысла.
    for (let pass = 0; pass < 4; pass++) {
        for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)\s*;/g)) {
            if (!map[m[1]] && map[m[2]]) map[m[1]] = map[m[2]];
        }
    }
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
    // WORKING_WINDOW_V1 — грунт переехал с --ink-50 на собственный токен
    // --page-ground и стал заметно серее: на ink-50 белая карточка давала
    // 1.09:1, то есть рабочего окна не было видно (жалоба владельца «remove the
    // white background»). Проверка осталась той же по смыслу — грунт ОДИН и он
    // назван, — но теперь она требует именно этот токен: если кто-то вернёт
    // ink-50, окно снова исчезнет, и все числа ниже поедут молча.
    assert.strictEqual(hex(ground), hex('var(--page-ground)'),
        'грунт страницы сменился — все числа ниже считаются против него');
    assert.ok(ratio(ground, '#ffffff') >= 1.15,
        `грунт ${hex(ground)} снова почти белый (${ratio(ground, '#ffffff')}:1) — «белый лист» вернулся`);
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
    // поверх сетки: рамка, тень, текст. PASTEL_IDENTITY_V1 сделал её заливку
    // пастельной (цвет врача), поэтому «она белая» больше не проверка —
    // проверка в том, что штриховку нерабочего часа НЕЛЬЗЯ спутать НИ С ОДНОЙ
    // заливкой карточки. Считаем это против всей шкалы, а не против белого.
    const appt = rule(VIEWS, '.rcal-appt');
    assert.ok(appt.border, 'у занятого слота пропала рамка');
    const fills = ['#ffffff', ...pastelHues().map((h) => T['--pastel-' + h + '-bg'])];
    for (const fill of fills) {
        const vs = ratio(dark, fill);
        assert.ok(vs >= 1.5, `штриховка нерабочего часа против заливки карточки ${hex(fill)}: ${vs}:1 — их можно спутать`);
    }
});

// ═══ 4. РАБОЧЕЕ ОКНО ════════════════════════════════════════════════════════
// WORKING_WINDOW_V1 (2026-09-05, владелец: «remove the white background. add a
// frame only to a working window»).
//
// Жалоба звучит как вкусовая, но за ней стоят числа. Грунт страницы ink-50
// (#f3f5f7) и белая карточка отличались на 1.09:1, рамка карточки ink-100 по
// этому грунту давала 1.06:1, а тень --shadow-xs — 4% чёрного на два пикселя.
// То есть рабочей области НЕ БЫЛО ВИДНО: экран читался одним белым листом, и
// глазу не за что было зацепиться, где кончается поле и начинается работа.
//
// Здесь закреплены ровно три вещи, из которых состоит «одно окно на сером
// поле», и все три — числами:
//   поле НЕ белое · окно белое и отличимо от поля · рамка окна видна.
// Плюс запрет на окно внутри окна: вложенная карточка не имеет права рисовать
// вторую тень (в образце внутренности разделены заливкой, а не рамками).

/** Правило, которого может и не быть (в отличие от rule(), который на это падает). */
function ruleIf(css, selector) {
    try { return rule(css, selector); } catch { return null; }
}

test('поле страницы НЕ белое, а рабочее окно — белое: их видно друг на друге', () => {
    const ground = rule(MAIN, 'body.admin').background;
    assert.notStrictEqual(hex(ground), '#ffffff', 'грунт страницы снова белый — «white background», на который жаловался владелец');

    const card = rule(MAIN, '.card');
    assert.strictEqual(hex(card.background), '#ffffff', 'рабочее окно перестало быть белым — белое достаётся ИМЕННО ему');

    // Окно на поле. 1.2:1 — та же нижняя планка «форму видно», что и у
    // счётчика в меню выше: ниже неё край перестаёт существовать.
    // 1.15:1 — не круглое число, а потолок, заданный ДРУГИМ концом системы:
    // грунт нельзя сделать темнее, не потеряв серый чип счётчика в меню
    // (ink-200 на нём как раз 1.21:1). Поэтому окно держат ТРИ вещи вместе —
    // светлота, рамка и тень, — и каждая проверена отдельно. Было 1.09:1.
    const windowOnGround = ratio(card.background, ground);
    assert.ok(windowOnGround >= 1.15, `белое окно на сером поле: ${windowOnGround}:1 — окна не видно`);

    // Верхняя панель — хром, а не поверхность: белой полосой она достраивала
    // тот же сплошной лист сверху.
    const bar = rule(MAIN, '.appbar');
    assert.notStrictEqual(hex(bar.background), '#ffffff', 'верхняя панель снова белая — лист восстановился');
    assert.strictEqual(hex(bar.background), hex(ground), 'верхняя панель лежит не на грунте страницы, а на своей подложке');
    assert.ok(!bar['border-bottom'] || /^(0|none)/.test(bar['border-bottom']),
        'под верхней панелью снова линейка — это шов, ровно тот, что убрали слева у колонки меню');
});

test('у рабочего окна есть видимая рамка и тень — и они на токенах, а не на глаз', () => {
    const card = rule(MAIN, '.card');
    const ground = rule(MAIN, 'body.admin').background;

    const edge = card.border.match(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/);
    assert.ok(edge, `не разобрать рамку окна: ${card.border}`);
    // Рамку видно С ОБЕИХ сторон: и на сером поле, и на белом нутре окна.
    const onGround = ratio(edge[0], ground);
    const onWhite = ratio(edge[0], '#ffffff');
    assert.ok(onGround >= 1.2, `рамка окна на сером поле: ${onGround}:1 — линии нет (было 1.06:1 на ink-100)`);
    assert.ok(onWhite >= 1.2, `рамка окна изнутри: ${onWhite}:1`);

    assert.ok(/var\(--shadow-window\)/.test(card['box-shadow'] || ''),
        `тень окна снова задана мимо токена: ${card['box-shadow']}`);
    // Тень не должна быть косметической: --shadow-xs (4% на 2px) не читается.
    const shadow = MAIN.match(/--shadow-window:\s*([^;]+);/);
    assert.ok(shadow, 'токен --shadow-window пропал из :root');
    const alphas = [...shadow[1].matchAll(/rgba\([^)]*?,\s*([0-9.]+)\)/g)].map((m) => parseFloat(m[1]));
    // Первое слагаемое тени пишется как `0 1px 2px` — без «px» у нуля, поэтому
    // разбор обязан принимать и голый 0, иначе размытие «не находится» и тест
    // проходит на пустом списке.
    const blurs = [...shadow[1].matchAll(/(?:0|\d+px)\s+\d+px\s+(\d+)px/g)].map((m) => parseInt(m[1], 10));
    assert.ok(Math.max(...alphas) >= 0.06, `тень окна прозрачнее 6% (${Math.max(...alphas)}) — её не будет видно`);
    assert.ok(Math.max(...blurs) >= 12, `тень окна размыта на ${Math.max(...blurs)}px — это контур, а не мягкая тень`);
});

test('окна внутри окна нет: вложенная карточка не рисует вторую тень', () => {
    const nested = rule(MAIN, '.card .card,\n.card .list-container,\n.list-container .card');
    assert.strictEqual(nested['box-shadow'], 'none',
        'вложенная поверхность снова с тенью — экран получает рамку в рамке вместо одного окна');
    assert.ok(nested['border-color'], 'у вложенной поверхности не задана более слабая линия');
    // И она действительно СЛАБЕЕ рамки окна, иначе «вложенность» ничем не
    // отличается от отдельного окна.
    const outer = rule(MAIN, '.card').border.match(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/)[0];
    assert.ok(ratio(nested['border-color'], '#ffffff') < ratio(outer, '#ffffff'),
        'линия вложенной поверхности не слабее рамки окна');
});

// ═══ 5. ПАСТЕЛЬНАЯ ШКАЛА ════════════════════════════════════════════════════
// PASTEL_IDENTITY_V1 (2026-09-05, владелец: «make cards of the kanban and the
// calendar bookings and the queue colorful. using pastel colors»).
//
// Шкала проходится ЦЕЛИКОМ И ПРОГРАММНО: оттенки не перечислены здесь списком,
// они ВЫЧИТЫВАЮТСЯ из :root. Это не изящество ради изящества — это условие
// задачи: девятый оттенок, добавленный через полгода, обязан попасть под
// проверку сам, без правки теста. Ровно так же нельзя добавить оттенок и
// «забыть» дать ему класс: соответствие токенов и классов проверяется в обе
// стороны.
//
// Пороги — те же, что и везде в этом файле: текст 4.5:1 (WCAG 1.4.3), край
// чипа 3:1 (1.4.11). Плюс два своих: заливка обязана отличаться от белого нутра
// окна (иначе цветной карточки просто не видно) и от серого поля страницы
// (колонка канбана лежит на нём, а не на белом).

/** Все оттенки, объявленные в :root, — по токену -bg. Список НЕ зашит. */
function pastelHues() {
    const root = MAIN.slice(MAIN.indexOf(':root'), MAIN.indexOf('}', MAIN.indexOf(':root')));
    return [...root.matchAll(/--pastel-([a-z0-9]+)-bg\s*:/g)].map((m) => m[1]);
}

test('пастельная шкала есть, и она НЕ подменяет собой семантику', () => {
    const hues = pastelHues();
    assert.ok(hues.length >= 6, `в шкале ${hues.length} оттенков — владелец просил «шесть-восемь»`);
    assert.ok(hues.length === new Set(hues).size, 'оттенок объявлен дважды: ' + hues.join(', '));

    // Семантические пары обязаны СТОЯТЬ РЯДОМ И ЦЕЛЫМИ. Пастель — про «чьё
    // это», семантика — про «насколько плохо»; подменить вторую первой значит
    // потерять единственный способ сказать «тревога».
    for (const t of ['--ok-50', '--ok-500', '--ok-700', '--warn-50', '--warn-500', '--warn-700',
        '--crit-50', '--crit-500', '--crit-700', '--info-50', '--info-500', '--info-700']) {
        assert.ok(T[t], `семантический токен ${t} исчез — пастель не имеет права его заменять`);
    }
    // И ни один пастельный токен не равен семантическому: одинаковый цвет с
    // двумя разными смыслами — это и есть «статус потерялся».
    const semantic = new Set(['--ok-500', '--ok-700', '--warn-500', '--warn-700', '--crit-500', '--crit-700', '--info-500', '--info-700'].map((t) => hex(T[t])));
    for (const h of hues) {
        for (const part of ['bg', 'fg', 'line']) {
            const v = T[`--pastel-${h}-${part}`];
            if (!v) continue;
            assert.ok(!semantic.has(hex(v)), `--pastel-${h}-${part} совпал с семантическим цветом — цвет получил два смысла`);
        }
    }
});

test('КАЖДЫЙ оттенок шкалы читаем: текст 4.5:1, край 3:1, заливка видна на белом', () => {
    const ground = rule(MAIN, 'body.admin').background;
    const hues = pastelHues();
    const report = [];
    for (const h of hues) {
        const bg = T[`--pastel-${h}-bg`];
        const fg = T[`--pastel-${h}-fg`];
        const line = T[`--pastel-${h}-line`];
        assert.ok(bg && fg && line, `у оттенка «${h}» нет полного набора bg/fg/line — неполный оттенок хуже отсутствующего`);

        const text = ratio(fg, bg);
        assert.ok(text >= 4.5, `${h}: текст на заливке ${text}:1 при норме 4.5:1 (WCAG 1.4.3)`);
        const edge = ratio(line, bg);
        assert.ok(edge >= 3, `${h}: край чипа на своей заливке ${edge}:1 при норме 3:1 (WCAG 1.4.11)`);

        // Карточка приёма лежит на БЕЛОМ нутре окна, колонка канбана — на
        // СЕРОМ поле. Заливка обязана быть видна в обоих случаях.
        const onWhite = ratio(bg, '#ffffff');
        assert.ok(onWhite >= 1.15, `${h}: заливка на белом листе ${onWhite}:1 — цветной карточки не видно`);
        // На СЕРОМ поле пастель не проверяется — и не должна: ни одна из трёх
        // досок не кладёт цветную карточку прямо на страницу. Календарь рисует
        // их внутри белой сетки, очередь — внутри белой карточки, канбан —
        // внутри белого рабочего окна (views/crm.js оборачивает доску в .card
        // именно поэтому). Пастель и грунт обе светлые, и требовать от них
        // контраста значило бы либо утемнить пастель до крика, либо утемнить
        // страницу до сумерек. Проверяем то, что есть на самом деле: пастель
        // на белом.

        // И она остаётся ПАСТЕЛЬЮ, а не заливкой в полную силу: тёмный
        // прямоугольник в расписании кричал бы громче любого статуса.
        assert.ok(luminance(hex(bg)) > 0.7, `${h}: заливка ${bg} слишком тёмная для пастели`);
        report.push(`${h}: fg/bg ${text} · line/bg ${edge} · bg/white ${onWhite}`);
    }
    // Числа печатаются: их же владелец видит на странице визуальной проверки.
    console.log('  ' + report.join('\n  '));
});

test('оттенки шкалы РАЗЛИЧИМЫ между собой — иначе цвет ничего не сообщает', () => {
    const hues = pastelHues();
    const bgs = hues.map((h) => hex(T[`--pastel-${h}-bg`]));
    assert.strictEqual(new Set(bgs).size, bgs.length, 'два оттенка шкалы совпали по заливке: ' + bgs.join(', '));
    // Совпадения мало — важна и различимость. Пастели светлые, между собой они
    // отличаются не яркостью, а тоном, поэтому сравниваем каналы, а не яркость.
    for (let i = 0; i < bgs.length; i++) {
        for (let j = i + 1; j < bgs.length; j++) {
            const a = [0, 2, 4].map((k) => parseInt(bgs[i].slice(1 + k, 3 + k), 16));
            const b = [0, 2, 4].map((k) => parseInt(bgs[j].slice(1 + k, 3 + k), 16));
            const dist = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
            assert.ok(dist >= 12, `оттенки «${hues[i]}» и «${hues[j]}» почти совпадают (${bgs[i]} / ${bgs[j]})`);
        }
    }
});

test('у каждого оттенка есть класс-носитель, и лишних классов нет', () => {
    const hues = pastelHues();
    for (const h of hues) {
        const cls = ruleIf(MAIN, `.pastel-${h}`);
        assert.ok(cls, `оттенок «${h}» объявлен в :root, но класса .pastel-${h} нет — экраны его не увидят`);
        assert.strictEqual(cls['--p-bg'], `var(--pastel-${h}-bg)`, `.pastel-${h} берёт заливку мимо своего токена`);
        assert.strictEqual(cls['--p-fg'], `var(--pastel-${h}-fg)`, `.pastel-${h} берёт текст мимо своего токена`);
        assert.strictEqual(cls['--p-line'], `var(--pastel-${h}-line)`, `.pastel-${h} берёт край мимо своего токена`);
    }
    const classes = [...MAIN.matchAll(/\.pastel-([a-z0-9]+)\s*\{/g)].map((m) => m[1]);
    for (const c of classes) {
        assert.ok(hues.includes(c), `класс .pastel-${c} есть, а токенов --pastel-${c}-* нет — он покрасит в ничто`);
    }
    assert.strictEqual(classes.length, hues.length, 'число классов не сошлось с числом оттенков');
});

// ═══ 6. ТРИ ДОСКИ НА ЭТОЙ ШКАЛЕ ═════════════════════════════════════════════

test('карточка приёма красится оттенком, а статус остаётся ОТДЕЛЬНЫМ признаком', () => {
    const appt = rule(VIEWS, '.rcal-appt');
    // Заливка — переменная оттенка, но с БЕЛЫМ запасным значением: приём без
    // врача обязан остаться белым, а не «покрасившимся в никуда».
    assert.match(appt.background, /var\(--p-bg,\s*var\(--white\)\)/,
        `заливка карточки приёма перестала быть оттенком с белым запасом: ${appt.background}`);
    assert.match(appt.border, /var\(--p-line,/, `рамка карточки приёма не следует за оттенком: ${appt.border}`);
    assert.ok(!/status/i.test(appt.background), 'в заливку карточки просочился статус');
});

test('ОТМЕНА видна без цвета: штриховка вместо заливки плюс зачёркнутая фамилия', () => {
    const x = rule(VIEWS, '.rcal-appt.rcal-appt-x');
    const stops = [...String(x.background).matchAll(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
    assert.ok(/repeating-linear-gradient/.test(x.background) && stops.length >= 2,
        `отменённый приём снова красится ровной заливкой: ${x.background}`);

    const uniq = [...new Set(stops.map(hex))];
    assert.strictEqual(uniq.length, 2, `в штриховке отмены ${uniq.length} цвета — ожидались ровно два`);
    const stripes = ratio(uniq[0], uniq[1]);
    assert.ok(stripes >= 1.5, `полоски отмены между собой ${stripes}:1 — узора не видно, это ровная заливка`);

    // ГЛАВНОЕ ЧИСЛО: узор обязан отличаться от КАЖДОЙ пастели, а не только от
    // белого. Иначе «отменён» стал бы просто ещё одним врачом.
    const dark = uniq.slice().sort((a, b) => luminance(a) - luminance(b))[0];
    for (const h of pastelHues()) {
        const vs = ratio(dark, T[`--pastel-${h}-bg`]);
        assert.ok(vs >= 1.5, `отменённый приём против оттенка «${h}»: ${vs}:1 — их не различить`);
    }
    assert.ok(ratio(dark, '#ffffff') >= 1.5, 'отменённый приём не отличается от белой карточки без врача');

    // И второй, вовсе не цветовой признак — на случай монохромного монитора.
    assert.match(VIEWS, /\.rcal-appt-x \.rcal-appt-p \{[^}]*text-decoration:\s*line-through/,
        'зачёркивание фамилии у отменённого приёма пропало — остался бы один цветовой признак');
});

test('очередь: шапка карточки красится оттенком, и подпись на ней читаема', () => {
    const head = rule(VIEWS, '.q-card .q-head');
    assert.match(head.background, /var\(--p-bg,/, `шапка карточки очереди не красится оттенком: ${head.background}`);
    const title = rule(VIEWS, '.q-card .q-title');
    assert.match(title.color, /var\(--p-fg,/, 'подпись назначения не берёт цвет своего оттенка');

    // Текст на заливке — 4.5:1 для КАЖДОГО оттенка (шапка красится любым).
    for (const h of pastelHues()) {
        const r = ratio(T[`--pastel-${h}-fg`], T[`--pastel-${h}-bg`]);
        assert.ok(r >= 4.5, `подпись в шапке очереди, оттенок «${h}»: ${r}:1`);
    }
});

test('канбан: колонка красится оттенком, а карточка заявки остаётся белой', () => {
    const col = rule(VIEWS, '.crm-col');
    assert.match(col.background, /var\(--p-bg,/, `колонка воронки не красится оттенком: ${col.background}`);
    // Белая карточка на цветной колонке — та же пара, что окно на поле.
    for (const h of pastelHues()) {
        const r = ratio('#ffffff', T[`--pastel-${h}-bg`]);
        assert.ok(r >= 1.15, `белая карточка заявки на колонке «${h}»: ${r}:1 — карточки не видно`);
    }
    const n = rule(VIEWS, '.crm-col .crm-col-n');
    assert.match(n.color, /var\(--p-fg,/, 'счётчик колонки не берёт цвет своего оттенка');
});

// CRM_CARD_V2 (2026-09-05) — карточка заявки лежит НА пастельной колонке, а не
// на белом листе, и это меняет два числа, которые на белом были верны:
//
//   * ЕЁ КРАЙ. Карточка была обведена --ink-100 (#e7ebee) — линия, рассчитанная
//     на белый фон. На заливке колонки того же семейства светлот она даёт около
//     1.1:1, то есть края нет вовсе, и восемь карточек в колонке сливаются в
//     одно поле. Теперь край берётся из --p-line — той самой переменной, что
//     колонка уже выставила себе, — и потому гарантированно отличается от НЕЁ.
//   * ЕЁ ТЕКСТ. Иерархия карточки построена на светлоте (имя ink-900, номер
//     ink-800, подписи ink-500), и «сделать подписи потише» — самый простой
//     способ увести их под порог. Считаем каждый уровень, а не самый тёмный.
test('карточка заявки читается на КАЖДОЙ пастельной колонке: край виден, все три уровня текста — тоже', () => {
    const card = rule(VIEWS, '.crm-card');
    assert.match(card.background, /var\(--white/, `карточка заявки перестала быть белой: ${card.background}`);
    assert.match(card.border, /var\(--p-line,/,
        `край карточки не следует за оттенком колонки (${card.border}) — на пастели он пропадает`);

    for (const h of pastelHues()) {
        const bg = T[`--pastel-${h}-bg`];
        const fill = ratio('#ffffff', bg);
        assert.ok(fill >= 1.15, `белая карточка на колонке «${h}»: ${fill}:1 — карточки не видно`);
        const edge = ratio(T[`--pastel-${h}-line`], bg);
        assert.ok(edge >= 3, `край карточки на колонке «${h}»: ${edge}:1 при норме 3:1 (WCAG 1.4.11)`);
    }

    // Текст — на СВОЕЙ (белой) заливке: 4.5:1, WCAG 1.4.3. Мелкий и жирным не
    // спасаемый — как раз тот случай, ради которого порог и написан.
    for (const sel of ['.crm-card-name', '.crm-card-tel-n', '.crm-card-kicker',
                       '.crm-card-note', '.crm-card-when', '.crm-move-sel',
                       '.crm-card-name-none', '.crm-card-lbl']) {
        const r = ratio(rule(VIEWS, sel).color, '#ffffff');
        assert.ok(r >= 4.5, `${sel}: ${r}:1 на белой карточке при норме 4.5:1`);
    }
    // Значки — не текст: 3:1 (WCAG 1.4.11). Стрелка переключателя ступени и
    // значок телефона обязаны быть видны, иначе управление выглядит подписью.
    for (const sel of ['.crm-card-tel-i', '.crm-move-chev']) {
        const r = ratio(rule(VIEWS, sel).color, '#ffffff');
        assert.ok(r >= 3, `${sel}: ${r}:1 на белой карточке при норме 3:1`);
    }
});

// ═══ 7. ШАПКА КОЛОНКИ МЕНЮ ══════════════════════════════════════════════════
// BRAND_PLATE_V1 (2026-09-05, владелец: «can we make something about this place
// too? its not looking appealing»).
//
// Жалоба про «место», а не про правило, поэтому здесь закреплены ровно те
// четыре вещи, из которых это место состояло, — и все четыре числами либо
// разбором разметки, а не «правило есть»:
//
//   ЗНАК НЕ ГРОМЧЕ РАЗДЕЛА. Единственный в продукте градиент и единственная
//   ЦВЕТНАЯ тень жили именно тут. Тень цветом бренда под знаком бренда — это
//   подсветка: она уводила глаз с выбранного пункта на логотип. Теперь заливка
//   плоская и та же, что у выбранного пункта: один акцент, использованный
//   дважды. Проверяем ОТСУТСТВИЕ градиента и цветной тени — иначе они вернутся
//   молча, ровно так же, как появились.
//
//   ОБЕ СТРОКИ ЧИТАЕМЫ НА ГРУНТЕ. Это не вкусовщина: --ink-400 на белой
//   колонке давал 4.65:1, а на --page-ground даёт 3.10:1 — имя клиники ушло
//   под порог WCAG 1.4.3 в тот день, когда колонка стала прозрачной, и никто
//   этого не увидел. Считаем обе строки и точку «·» против грунта, читая его
//   тем же sidebarGround(), что и всё выше.
//
//   ИМЯ КЛИНИКИ ВПЕРЕДИ. В системе, которую клиника покупает, её имя не может
//   стоять ниже имени поставщика. Порядок проверяется по РАЗМЕТКЕ, вес — по
//   размеру, начертанию и светлоте: «выше по коду» без веса ничего не значит.
//
//   ДЛИННОЕ ИМЯ НЕ ОБРЕЗАЕТСЯ. Обрезать можно только то, что можно прочитать
//   иначе, — а подсказки-title у этой строки нет (её мог бы поставить только
//   admin.js). Значит перенос, а не многоточие, и обёртка, которой разрешено
//   сжиматься, иначе длинное имя вынесет стрелку сворачивания за край.

const HTML = fs.readFileSync(path.join(path.resolve(CSS_DIR, '..'), 'admin.html'), 'utf8')
    .replace(/\r\n/g, '\n');
/** Разметка шапки — от .sidebar-brand до начала списка пунктов. */
const BRAND_HTML = (() => {
    const i = HTML.indexOf('class="sidebar-brand"');
    assert.ok(i > -1, 'в admin.html пропала шапка колонки меню (.sidebar-brand)');
    const j = HTML.indexOf('id="sidebar-body"', i);
    return HTML.slice(i, j > -1 ? j : i + 3000);
})();
const TYPE_STEPS = [12.5, 13.5, 15, 17, 20, 24, 30, 40];

test('знак бренда стал плоским: ни градиента, ни цветной тени — и он виден на грунте', () => {
    const mark = rule(MAIN, '.brand-mark');
    const ground = sidebarGround();

    assert.ok(!/gradient/i.test(mark.background),
        `у знака снова градиент (${mark.background}) — единственный в продукте, всё остальное плоское`);
    assert.ok(!mark['box-shadow'] || /^none/.test(mark['box-shadow']),
        `у знака снова тень (${mark['box-shadow']}) — она была ЦВЕТНОЙ и читалась подсветкой логотипа`);

    // Заливка — токен, а не свой оттенок: знак обязан ездить вместе с палитрой.
    assert.match(mark.background, /^var\(--[a-z0-9-]+\)$/,
        `заливка знака задана мимо токена: ${mark.background}`);
    // И ровно та же, что у выбранного пункта меню: в колонке ОДИН акцент.
    const active = rule(MAIN, '.nav-item.active,\n.nav-item.active:hover');
    assert.strictEqual(hex(mark.background), hex(active.background),
        'знак красится не тем же акцентом, что выбранный пункт — в колонке снова два разных ярких пятна');

    // Форму видно на грунте: 3:1 — WCAG 1.4.11, знак сообщает не текстом.
    const shape = ratio(mark.background, ground);
    assert.ok(shape >= 3, `знак на грунте колонки: ${shape}:1 при норме 3:1 (WCAG 1.4.11)`);
    // «+» внутри знака — тоже не текст, порог тот же.
    const glyph = ratio(mark.color, mark.background);
    assert.ok(glyph >= 3, `«+» на заливке знака: ${glyph}:1 при норме 3:1`);
    console.log(`  знак: заливка/грунт ${shape}:1 · «+»/заливка ${glyph}:1`);
});

test('обе строки шапки читаемы НА ГРУНТЕ — там, где имя клиники и ушло под порог', () => {
    const ground = sidebarGround();
    const clinic = rule(MAIN, '.brand-sub');     // имя клиники (admin.js кладёт clinic.name)
    const vendor = rule(MAIN, '.brand-name');    // «Easy·Med»
    const dot = rule(MAIN, '.brand-name .dot');

    const cl = ratio(clinic.color, ground);
    assert.ok(cl >= 4.5, `имя клиники на грунте: ${cl}:1 при норме 4.5:1 (WCAG 1.4.3)`);
    const vd = ratio(vendor.color, ground);
    assert.ok(vd >= 4.5, `подпись поставщика на грунте: ${vd}:1 при норме 4.5:1`);
    // Точка «·» — часть слова, а не украшение: порог у неё тот же, текстовый.
    const dt = ratio(dot.color, ground);
    assert.ok(dt >= 4.5, `точка «·» в «Easy·Med» на грунте: ${dt}:1 при норме 4.5:1`);

    // Именно тот цвет, на котором всё сломалось: --ink-400 здесь больше не
    // проходит, и тест обязан это ЗНАТЬ, а не верить на слово.
    assert.ok(ratio('var(--ink-400)', ground) < 4.5,
        'ink-400 на грунте вдруг проходит 4.5:1 — грунт посветлел, и пороги выше считались зря');
    console.log(`  строки: клиника ${cl}:1 · поставщик ${vd}:1 · точка ${dt}:1`);
});

test('имя КЛИНИКИ стоит первым и весит не меньше имени поставщика', () => {
    // 1) Порядок — по разметке, а не по CSS: переставить строки местами
    //    визуально (order / column-reverse) значило бы соврать читалке экрана.
    const iClinic = BRAND_HTML.indexOf('class="brand-sub"');
    const iVendor = BRAND_HTML.indexOf('class="brand-name"');
    assert.ok(iClinic > -1 && iVendor > -1, 'в шапке пропала одна из двух строк');
    assert.ok(iClinic < iVendor,
        'имя поставщика снова стоит выше имени клиники — в системе, которую клиника покупает');
    const wrap = rule(MAIN, '.brand-text');
    assert.ok(!wrap.order && !/column-reverse/.test(String(wrap['flex-direction'])),
        'порядок строк переставлен стилями — разметка и экран разошлись');

    const clinic = rule(MAIN, '.brand-sub');
    const vendor = rule(MAIN, '.brand-name');
    const ground = sidebarGround();

    // 2) Вес: размер, начертание и контраст — все три в пользу клиники.
    assert.ok(parseFloat(clinic['font-size']) > parseFloat(vendor['font-size']),
        `имя клиники ${clinic['font-size']} не крупнее «Easy·Med» ${vendor['font-size']}`);
    assert.ok(parseInt(clinic['font-weight'], 10) >= parseInt(vendor['font-weight'], 10),
        'имя клиники набрано тоньше имени поставщика');
    assert.ok(ratio(clinic.color, ground) > ratio(vendor.color, ground),
        'имя клиники не темнее имени поставщика — «равный вес» получился только на словах');

    // 3) И оно больше не набрано ПРОПИСНЫМИ вразрядку: так набирают рубрику,
    //    а имя клиники — не рубрика.
    assert.ok(!clinic['text-transform'] || clinic['text-transform'] === 'none',
        `имя клиники снова прописными (${clinic['text-transform']}) — это набор рубрики, а не имени`);

    // 4) Оба размера — из шкалы (TYPE_SCALE_V1 стережёт весь репозиторий, но
    //    здесь это часть самого решения, а не побочность).
    for (const [what, decl] of [['имя клиники', clinic], ['«Easy·Med»', vendor]]) {
        const size = parseFloat(decl['font-size']);
        assert.ok(TYPE_STEPS.includes(size), `${what}: ${size}px мимо шкалы ${TYPE_STEPS.join('/')}`);
    }
});

test('длинное имя клиники переносится, а не обрезается, и не выносит стрелку за край', () => {
    const clinic = rule(MAIN, '.brand-sub');

    // Обрезать нечем: подсказки-title у строки нет и появиться она может
    // только из admin.js. Значит многоточия быть не должно.
    const line = BRAND_HTML.slice(BRAND_HTML.indexOf('class="brand-sub"'),
        BRAND_HTML.indexOf('class="brand-name"'));
    assert.ok(!/title=/.test(line),
        'у строки имени клиники появился title — тогда обрезать можно, и это правило пора переписать');
    for (const prop of ['text-overflow', '-webkit-line-clamp', 'line-clamp']) {
        assert.ok(!clinic[prop], `имя клиники обрезается (${prop}: ${clinic[prop]}) без подсказки-title`);
    }
    assert.ok(!clinic['white-space'] || !/nowrap/.test(clinic['white-space']),
        'имени клиники запрещён перенос — длинное имя поедет за край колонки');
    // Одно длинное слово без пробелов обязано переноситься внутри себя.
    assert.match(String(clinic['overflow-wrap']), /anywhere|break-word/,
        'длинное слово в имени клиники ничем не переносится — оно распирает колонку');

    // Обёртке двух строк разрешено сжиматься: без min-width: 0 флекс-элемент
    // не уходит ниже своего содержимого, и стрелку сворачивания вынесло бы.
    const text = rule(MAIN, '.brand-text');
    assert.strictEqual(px(text['min-width']), 0,
        'у обёртки строк нет min-width: 0 — длинное имя вытолкнет стрелку за край колонки');

    // Пустая строка (клиника ещё не определилась) не занимает места.
    const empty = ruleIf(MAIN, '.brand-sub:empty');
    assert.ok(empty && empty.display === 'none',
        'пустая строка имени клиники держит место — до загрузки клиники в шапке зияет пустая полоса');
});

test('на свёрнутой рейке остаётся ЗНАК — и он в неё помещается', () => {
    // Стрелку на рейке прячут, значит знак — единственный способ раскрыть
    // меню обратно. Спрятать заодно и его — сложить колонку навсегда.
    const hidden = rule(MAIN, '.sidebar-collapsed .sidebar-brand > div:not(.brand-mark)');
    assert.strictEqual(hidden.display, 'none', 'на рейке снова видны строки шапки — 68px на них не хватит');
    assert.strictEqual(rule(MAIN, '.sidebar-collapsed .sidebar-toggle').display, 'none',
        'на рейке снова стрелка — она там не помещается, и её работу делает сам знак');

    // Ни одно правило свёрнутой колонки не имеет права спрятать сам знак.
    for (const m of MAIN.matchAll(/\.sidebar-collapsed[^{}]*\{([^}]*)\}/g)) {
        if (!/\.brand-mark/.test(m[0])) continue;
        if (/:not\(\.brand-mark\)/.test(m[0])) continue;
        assert.ok(!/display\s*:\s*none/.test(m[1]),
            'правило свёрнутой колонки прячет знак: ' + m[0].split('{')[0].trim());
    }

    const mark = rule(MAIN, '.brand-mark');
    const railW = px(rule(MAIN, '.sidebar-collapsed')['--sidebar-w']);
    const w = px(mark.width);
    assert.ok(w > 0 && w <= railW - 16, `знак ${w}px на рейке ${railW}px — упирается в края`);
    // И он не съёживается, когда рядом длинное имя.
    assert.match(String(mark.flex), /^0 0 auto$/, 'знак сжимаем — длинное имя клиники его расплющит');
});

test('стрелка сворачивания осталась кнопкой и остаётся видимой с клавиатуры', () => {
    // Это <button> в разметке, а не div с обработчиком: Tab и Enter приходят
    // от браузера, а не от нашего кода.
    assert.match(BRAND_HTML, /<button[^>]*id="sidebar-toggle"/,
        'стрелка сворачивания перестала быть <button> — с клавиатуры до неё не добраться');
    assert.match(BRAND_HTML, /id="sidebar-toggle"[^>]*aria-label="/,
        'у стрелки нет подписи для читалки — иконка молчит');
    // Знак тоже управляется с клавиатуры: на рейке он единственный орган
    // управления, оставшийся в шапке.
    assert.match(BRAND_HTML, /id="sidebar-logo"[^>]*tabindex="0"/,
        'до знака не добраться с клавиатуры — на свёрнутой рейке меню было бы не раскрыть');

    // Контур фокуса общий (:focus-visible ниже по файлу) и виден на грунте.
    const focus = rule(MAIN, '.btn:focus-visible,\n.nav-item:focus-visible,\na:focus-visible,\nbutton:focus-visible,\ninput:focus-visible,\nselect:focus-visible,\ntextarea:focus-visible,\n[role="button"]:focus-visible');
    const ring = focus.outline.match(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/);
    assert.ok(ring, `не разобрать контур фокуса: ${focus.outline}`);
    const r = ratio(ring[0], sidebarGround());
    assert.ok(r >= 3, `контур фокуса на грунте колонки: ${r}:1 при норме 3:1`);
});

test('шапку от меню отделяет воздух, а не линейка — и его больше, чем между пунктами', () => {
    const brand = rule(MAIN, '.sidebar-brand');
    const pads = brand.padding.split(/\s+/).map(px);
    const bottom = pads.length === 4 ? pads[2] : pads[0];
    const gap = parseFloat(rule(MAIN, '.sidebar-body .nav').gap);
    assert.ok(bottom >= gap * 4,
        `под шапкой ${bottom}px при зазоре между пунктами ${gap}px — шапка читается первым пунктом меню`);
    // Линейки по-прежнему нет (её проверяет и тест раздела 3 — здесь названо
    // вслух, потому что воздух её ЗАМЕНЯЕТ, а не дополняет).
    assert.ok(!brand['border-bottom'], 'под шапкой снова линейка — воздух её не заменил, а получил в довесок');
});
