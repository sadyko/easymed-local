// ONEST_TYPOGRAPHY_V1 — @font-face CSS for PRINT documents
// (docs/plans/2026-08-31-onest-typography-design.md).
//
// Печатные окна — это ОТДЕЛЬНЫЕ документы (window.open + document.write,
// либо file:// у серверного PDF-рендера) — admin.css туда не попадает, и
// без собственного @font-face документ печатался бы системным шрифтом.
// Этот модуль отдаёт те же четыре сабсета, что admin.css, одним блоком CSS,
// который каждый строитель печатной формы вставляет в свой <style>.
//
// Почему src через new URL(import.meta.url), а не '/fonts/...':
//   - в браузере база — http://host/js/shared/ → абсолютный
//     http://host/fonts/…, работает и в popup-окне, и в iframe-превью;
//   - в Node (Telegram-бот рендерит PDF через Chrome --print-to-pdf по
//     file://-адресу временного HTML) база — file://…/public/js/shared/ →
//     file://…/public/fonts/…, и Chrome читает шрифт прямо с диска.
//   Корневой '/fonts/…' в file://-контексте указывал бы на корень ДИСКА и
//   молча падал бы в системный шрифт — ровно та порча, ради которой этот
//   комментарий написан.
//
// unicode-range сохранён с Google Fonts (v11) байт-в-байт: диапазоны — то,
// что позволяет браузеру собирать кириллицу и латиницу из разных файлов в
// один ритм. oʻ/gʻ узбекской латиницы (U+02BB) и тутук белгиси (U+02BC)
// покрывает сабсет latin (U+02BB-02BC) — проверено парсингом диапазонов.
//
// Размеры печатных форм этот модуль НЕ трогает и не диктует: печать получает
// только СЕМЕЙСТВО — метрики бланков остаются их собственными (см. дизайн-док).

const FONTS_BASE = new URL('../../fonts/', import.meta.url).href;

const face = (file, ranges) => `@font-face {
  font-family: 'Onest';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('${FONTS_BASE}${file}') format('woff2');
  unicode-range: ${ranges};
}`;

export const PRINT_FONT_FACE_CSS = [
    face('onest-cyrillic-ext.woff2', 'U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F'),
    face('onest-cyrillic.woff2', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'),
    face('onest-latin-ext.woff2', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'),
    face('onest-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'),
].join('\n');

// Единый стек печатных форм: Onest первым, дальше — то, что было fallback'ом
// до унификации, чтобы полуобновлённый клиент не остался вовсе без шрифта.
export const PRINT_FONT_STACK = `'Onest', "Helvetica Neue", Arial, "Segoe UI", sans-serif`;
