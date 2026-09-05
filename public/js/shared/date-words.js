// MONTH_WORDS_V1 (2026-09-05) — как в этом продукте пишется дата. Один файл.
//
// ПОЧЕМУ ОН ПОЯВИЛСЯ. Владелец прислал снимок узбекского интерфейса, где на
// месте даты рождения стояло «1994 M11 15». Это не «сырая дата из базы»: так
// Intl отвечает за КОРНЕВУЮ локаль, когда в сборке браузера нет данных
// запрошенного языка. Клиника ставит ту Windows и тот Chrome, какие есть; на
// одной машине данные для uz будут, на соседней — нет, и дата в одном и том же
// продукте на одном и том же экране читается то словом, то кодом.
//
// Поэтому здесь Intl не спрашивают вовсе. Названия месяцев берутся из общего
// словаря (admin/i18n-strings.js) — узбекские написания там уже выверены
// («noyabr», «sentabr», «oktabr») и совпадают с CLDR буква в букву, так что
// транслитерацию не пришлось выдумывать. Порядок слов задан таблицей шаблонов
// ниже — тоже побайтово по CLDR:
//
//   ru  «15 ноября 1994 г.»    · со временем «… г. в 09:05»
//   uz  «15-noyabr, 1994»      · со временем «…, 09:05»
//   en  «15 November 1994»     · со временем «… at 09:05»
//
// Русский и английский собраны тем же способом сознательно: болезнь одна на
// все языки, и держать два языка на Intl, а один на словаре означало бы два
// разных класса поведения в одном приложении. Тест сверяет весь год с Intl на
// машине, где данные ЕСТЬ, — русский и английский вид не мог измениться.
//
// МОДУЛЬ ЧИСТЫЙ. Ни DOM, ни localStorage, ни языка «по умолчанию»: язык всегда
// приходит аргументом. Это условие того, что печатные бланки (shared/
// doc-render.js, views/doc-variants.js, views/receipt-print.js), которые
// собирает и сервер для Telegram-бота, могут им пользоваться. Приложение берёт
// язык интерфейса за них: admin/i18n.js → monthName, admin/ui.js → fmtDate.

// ?v=svceditor1 — ТОТ ЖЕ URL, что у admin/i18n.js: в браузере адрес модуля и есть
// его тождество, и без совпадающей метки словарь (≈ 6600 строк) грузился бы вторым
// экземпляром. Меняете метку там — меняйте и здесь.
import { STRINGS } from '../admin/i18n-strings.js?v=svceditor1';

// Ключ словаря — русское слово; оно же и есть русский ответ, поэтому русская
// колонка не может разъехаться со своим ключом.
// Две формы, как в самих языках: внутри даты («15 ноября», «15-noyabr») и сам
// по себе («Ноябрь 2026», «Noyabr 2026»).
export const MONTH_KEYS_FORMAT = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
export const MONTH_KEYS_STANDALONE = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const PATTERN = {
    ru: { date: (d, m, y) => `${d} ${m} ${y} г.`, withTime: (s, hm) => `${s} в ${hm}` },
    uz: { date: (d, m, y) => `${d}-${m}, ${y}`,   withTime: (s, hm) => `${s}, ${hm}` },
    en: { date: (d, m, y) => `${d} ${m} ${y}`,    withTime: (s, hm) => `${s} at ${hm}` },
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Язык, который этот модуль умеет писать. Чужой код — русский, как и раньше. */
export function normalizeLang(lang) {
    return PATTERN[lang] ? lang : 'ru';
}

/**
 * Название месяца (0–11).
 * @param {number} month 0 = январь
 * @param {{lang?: string, standalone?: boolean}} [opts]
 */
export function monthWord(month, opts = {}) {
    const i = Number(month);
    if (!Number.isInteger(i) || i < 0 || i > 11) return '';
    const lang = normalizeLang(opts.lang);
    const key = (opts.standalone ? MONTH_KEYS_STANDALONE : MONTH_KEYS_FORMAT)[i];
    const e = STRINGS[key];
    // Пропажа записи в словаре портит только нерусские языки: русское слово —
    // это сам ключ. Молча показать русский месяц в узбекском интерфейсе плохо,
    // но показать пустоту хуже.
    return (e && (e[lang] || e.en)) || key;
}

/**
 * Значение (Date | ISO-строка | 'YYYY-MM-DD') → Date, либо null.
 * Дата без времени разбирается в МЕСТНУЮ полночь: иначе день уезжает на сутки
 * назад в любом часовом поясе восточнее Гринвича — то есть в Ташкенте всегда.
 */
export function toDateValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
}

/** «15 ноября 1994 г.» / «15-noyabr, 1994» / «15 November 1994». */
export function dateWords(value, opts = {}) {
    const dt = toDateValue(value);
    if (!dt) return null;
    const pat = PATTERN[normalizeLang(opts.lang)];
    const out = pat.date(dt.getDate(), monthWord(dt.getMonth(), { lang: opts.lang }), dt.getFullYear());
    return opts.withTime ? pat.withTime(out, pad2(dt.getHours()) + ':' + pad2(dt.getMinutes())) : out;
}

/**
 * «05.09.2026» (со временем — «05.09.2026, 09:05»).
 *
 * Печатный бланк — официальная бумага: там дата стоит цифрами и одинаково на
 * всех языках. Раньше её собирал toLocaleDateString() БЕЗ локали, то есть по
 * языку компьютера: тот же счёт печатался «05.09.2026» в одной клинике и
 * «05/09/2026» в другой. Форма зафиксирована здесь; вид совпадает с прежним
 * ru-RU побайтово.
 */
export function dateNumeric(value, opts = {}) {
    const dt = toDateValue(value);
    if (!dt) return '';
    const out = `${pad2(dt.getDate())}.${pad2(dt.getMonth() + 1)}.${dt.getFullYear()}`;
    return opts.withTime ? `${out}, ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}` : out;
}
