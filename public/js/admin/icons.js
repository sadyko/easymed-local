// COOLICONS_V1 — один набор иконок на весь интерфейс.
//
// Раньше здесь лежали 77 контуров, нарисованных вручную. Теперь рисунки берутся
// из набора coolicons (public/assets/icons/coolicons/, 442 файла, CC BY 4.0 —
// см. ATTRIBUTION.md рядом с ними), а этот файл остался тем же самым фасадом:
//
//     icon('Patients', { size: 18 })   →  HTMLElement (<svg>)
//     iconHtml('Clock', { size: 16 })  →  строка '<svg …>…</svg>'
//     I.Check({ size: 14 })            →  то же, что iconHtml('Check', …)
//
// Подпись не изменилась ни в одном знаке — поэтому ни один из 88 экранов не
// пришлось трогать. Размер, толщина обводки и атрибуты доступности считаются
// ровно так же, как считались до замены.
//
// ---------------------------------------------------------------------------
// ПОЧЕМУ ИНЛАЙН-SVG, А НЕ СПРАЙТ И НЕ <img>
// ---------------------------------------------------------------------------
// Рассматривались три способа доставки; у набора есть готовый спрайт (324 КБ) и
// готовые PNG, то есть выбор был настоящий:
//
//   <img src="…/Check.svg"> — отпадает сразу: картинка не умеет currentColor.
//     Иконка в тёмной шапке и та же иконка на светлой карточке должны быть
//     разного цвета; с <img> пришлось бы держать по файлу на каждый цвет темы.
//
//   Спрайт + <use href="/assets/icons/sprite.svg#Check"> — цвет умеет, один
//     запрос вместо многих. Отпал по конкретной причине: onboarding.js находит
//     пункт меню, сравнивая атрибут d ПЕРВОГО контура внутри отрисованной
//     иконки с тем, что вернул iconHtml() (см. iconFirstPath/resolveNav — это
//     единственный способ узнать пункт меню, не завися от языка интерфейса).
//     Внутри <use> контуров нет: они лежат в теневом дереве спрайта. Подсказки
//     онбординга молча перестали бы находить меню — то есть «замена иконок»
//     сломала бы функцию, к иконкам отношения не имеющую.
//
//   Инлайн-SVG — выбран. Цвет наследуется из currentColor, ни одного сетевого
//     запроса (приложение работает без интернета, и один незагрузившийся спрайт
//     — это пустые квадраты на всех экранах сразу), контуры видны в DOM, так
//     что onboarding.js продолжает работать как работал.
//
// Цена — 43 КБ JS с контурами (icon-paths.js). Спрайт не вендорится вовсе:
// возить оба представления одного и того же набора незачем.
//
// В icon-paths.js попадают только те иконки, что названы в icon-map.js, — 76
// файлов из 442. Остальные всё равно лежат в public/assets/icons/coolicons/ и
// едут в релиз: добавить иконку — это строка в карте и перегенерация, без
// похода на сайт набора и без интернета у того, кто это делает.

import { ICON_MAP } from './icon-map.js';
import { ICON_BODIES } from './icon-paths.js';

const NS = 'http://www.w3.org/2000/svg';

// Толщина 1.75, а не авторские 2: контуры набора нарисованы под 2, но весь
// интерфейс до замены рисовался в 1.75, и переход на 2 сделал бы каждый экран
// заметно жирнее. Значение по умолчанию сохранено ровно тем, каким было; вызовы
// вида Icon('X', { stroke: 2 }) работают, потому что толщина живёт на внешнем
// <svg>, а с контуров она снята генератором.
const DEFAULT_SIZE = 18;
const DEFAULT_STROKE = 1.75;

function svg(size, stroke, body) {
    return `<svg xmlns="${NS}" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** Имена, которые умеет рисовать этот модуль. */
export const ICON_NAMES = Object.freeze(Object.keys(ICON_MAP).sort());

/** Есть ли такая иконка. Дешевле, чем ловить исключение. */
export function hasIcon(name) {
    return Object.prototype.hasOwnProperty.call(ICON_MAP, name)
        && Object.prototype.hasOwnProperty.call(ICON_BODIES, ICON_MAP[name]);
}

// ---------------------------------------------------------------------------
// Неизвестное имя обязано быть заметным
// ---------------------------------------------------------------------------
// Старый модуль на неизвестное имя молча рисовал кружок, и четыре имени —
// Copy, Drop, Key, Minus — годами так и рисовались кружком: их звали с экранов,
// а в наборе их не было, и никто этого не заметил. Молчаливая заглушка
// выглядит как решение дизайнера, а не как ошибка.
//
// Три уровня, по убыванию строгости:
//
//   1. Тест icons.test.mjs обходит ВСЕ вызовы Icon('…') в public/js и падает,
//      если имени нет в карте. Это и есть настоящая защита: опечатка не
//      проходит npm test, то есть не попадает даже в коммит.
//   2. Вне браузера (node --test, любой инструмент) — исключение. Ни один тест
//      не должен «пройти» на несуществующей иконке.
//   3. В браузере — console.error и ЗАМЕТНАЯ заглушка (перечёркнутый круг), а
//      не пустой квадрат и не исключение. Бросить здесь означало бы уронить
//      отрисовку целого экрана в клинике из-за иконки; для медицинской системы
//      это несоразмерная цена. Заглушку видно с первого взгляда, а причина
//      лежит в консоли полным текстом.
//
// Строгий режим можно включить или выключить принудительно:
// globalThis.EASYMED_ICONS_STRICT = true | false.

const MISSING_BODY = '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>';

function isStrict() {
    if (globalThis.EASYMED_ICONS_STRICT === true) return true;
    if (globalThis.EASYMED_ICONS_STRICT === false) return false;
    return typeof window === 'undefined';
}

function missing(name, size, stroke) {
    /* i18n-exempt-start: текст для разработчика в консоли и в исключении, а не
       на экране — он называет файл и команду, которые надо поправить, и в
       словаре интерфейса ему делать нечего. */
    const msg = `icons.js: неизвестное имя иконки «${name}». `
        + 'Добавьте строку в public/js/admin/icon-map.js и выполните '
        + 'node scripts/build-icon-paths.mjs';
    /* i18n-exempt-end */
    if (isStrict()) throw new Error(msg);
    console.error(msg);
    return svg(size, stroke, MISSING_BODY);
}

/**
 * Разметка иконки строкой.
 *
 * @param {string} name  имя из icon-map.js
 * @param {{ size?: number, stroke?: number }} [opts]
 */
export function iconHtml(name, { size = DEFAULT_SIZE, stroke = DEFAULT_STROKE } = {}) {
    const coolPath = ICON_MAP[name];
    const body = coolPath && ICON_BODIES[coolPath];
    if (!body) return missing(name, size, stroke);
    return svg(size, stroke, body);
}

/** Та же иконка элементом. */
export function icon(name, opts = {}) {
    const wrap = document.createElement('span');
    wrap.className = 'i';
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = iconHtml(name, opts);
    return wrap.firstElementChild;
}

export const I = new Proxy({}, { get: (_, name) => (opts = {}) => iconHtml(String(name), opts) });
