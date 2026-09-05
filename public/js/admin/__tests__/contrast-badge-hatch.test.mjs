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
const readCss = (f) => fs.readFileSync(path.join(CSS_DIR, f), 'utf8').replace(/\r\n/g, '\n');

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

test('красный счётчик виден и на НЕвыбранном пункте — там он на белой колонке', () => {
    const alert = rule(VIEWS, '.sidebar-body .nav-item .nav-badge.alert');
    const sidebar = '#ffffff';
    const pill = ratio(alert.background, sidebar);
    assert.ok(pill >= 3, `таблетка на белой колонке: ${pill}:1 при норме 3:1`);
    const digits = ratio(alert.color, alert.background);
    assert.ok(digits >= 4.5, `цифра в таблетке: ${digits}:1 при норме 4.5:1`);
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
    // На белой колонке кольцо не видно вовсе — там всё держит само ядро.
    const coreVsWhite = ratio(alert.background, '#ffffff');
    assert.ok(coreVsWhite >= 3, `ядро точки на белой колонке: ${coreVsWhite}:1 при норме 3:1`);

    // Кольцо съедает точку: 8px под 2px кольцом — это уже крапинка.
    assert.ok(parseFloat(alert.width) >= 10, `точка ${alert.width} под кольцом 2px слишком мелкая`);
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
