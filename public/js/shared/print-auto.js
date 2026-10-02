// PRINT_AUTO_V1 (владелец, 2026-10-02) — ПЕЧАТЬ В ОДИН ШАГ.
//
// «when pressed print its showing htm file but without pre selected print
// option with printer selection, the elder doctors can use thats why we need
// to decrease steps». Владелец выбрал: «Печать» сразу открывает окно принтера
// (Chrome помнит последний принтер — врач жмёт «Печать», затем Enter). Тихой
// печати без окна — нет.
//
// Почему не печаталось: printableSheet (views/doc-settings.js) писал бланк во
// всплывающее окно и window.print() не звал. Скрипт печати несла только
// запасная обёртка doc-render.js, а оформленные бланки doc-variants.js
// (заключение, диагностика, анализы, счёт, чек, квитанция) шли без него.
//
// ensureAutoPrint(html) — один помощник на все такие окна: перед последним
// </body> ставит скрипт, который после загрузки и шрифтов (как рабочие окна
// kitchen-sheet.js, report-print.js) вызывает window.focus(); window.print(),
// а после печати закрывает окно. В HTML, где печать уже есть (window.print),
// не добавляет ничего — двойной печати не бывает.
//
// Тег — голый <script> со словами window.print(): его вырезают предпросмотр
// «Документов» (documents.js) и запасной предпросмотр (doc-settings.js) — шаблон
// <script>…</script> — и PDF для Telegram (telegram/render.js stripAutoPrint —
// шаблон со словами window.print()). Модуль чистый: его читают и браузер, и Node.

export const AUTO_PRINT_SCRIPT = '<script>/* PRINT_AUTO_V1 */'
    + "window.addEventListener('load',function(){"
    + '(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){'
    + 'setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);});});'
    + "window.addEventListener('afterprint',function(){setTimeout(function(){try{window.close();}catch(e){}},300);});"
    + '</scr' + 'ipt>';

const PRINT_CALL_RE = /window\.print\s*\(/;
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Есть ли в HTML своя печать: window.print( внутри <script>…</script>.
 * PRINT_AUTO_V1 (ревью) — только в теле скрипта: те же слова в тексте
 * документа (заключение, где врач их написал) или в onclick кнопки «Печать»
 * окна «Открыть» — не печать при открытии.
 */
export function hasAutoPrint(html) {
    for (const m of String(html == null ? '' : html).matchAll(SCRIPT_RE)) {
        if (PRINT_CALL_RE.test(m[1])) return true;
    }
    return false;
}

/** Вставка перед последним </body> (нет его — в конец). */
function beforeBodyEnd(s, chunk) {
    const at = s.toLowerCase().lastIndexOf('</body>');
    return at < 0 ? s + chunk : s.slice(0, at) + chunk + s.slice(at);
}

/** HTML окна печати → тот же HTML, который печатается сам; печать уже есть — без изменений. */
export function ensureAutoPrint(html) {
    const s = String(html == null ? '' : html);
    if (hasAutoPrint(s)) return s;
    return beforeBodyEnd(s, AUTO_PRINT_SCRIPT);
}

// ---------------------------------------------------------------------------
// «Открыть» — окно, которое только ПОКАЗЫВАЕТ документ (координатор, 02.10):
// архив документов, ссылка-название в списке документов карты, результат в
// истории болезни, предпросмотр шаблона, документы, которые открываются сами
// после сохранения (мастера записи, касса после оплаты) — печать сразу только
// по нажатой «Печать». Окно печати само не открывается: убирается и скрипт
// помощника, и свой скрипт запасной обёртки doc-render.js. Печать — кнопкой
// «Печать» в углу окна: одно нажатие, на бумагу кнопка не попадает.
// ---------------------------------------------------------------------------

/** HTML без скриптов, которые зовут window.print(); прочие скрипты остаются. */
export function withoutAutoPrint(html) {
    return String(html == null ? '' : html)
        .replace(SCRIPT_RE, (m, body) => (PRINT_CALL_RE.test(body) ? '' : m));
}

const VIEW_PRINT_CLASS = 'pa-view-print';
const escText = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Окно «Открыть»: документ без печати при открытии и с кнопкой «Печать».
 * printLabel — подпись на языке экрана (переводит вызывающий); accent — цвет
 * клиники (#rgb / #rrggbb, иначе свой).
 */
export function viewOnlySheet(html, { printLabel = 'Печать', accent = '' } = {}) {
    const s = withoutAutoPrint(html);
    if (s.includes('class="' + VIEW_PRINT_CLASS + '"')) return s;
    const color = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(accent || '')) ? accent : '#167873';
    const chunk = '<style>.' + VIEW_PRINT_CLASS + '{position:fixed;top:16px;right:16px;z-index:10;'
        + 'padding:9px 18px;border:0;border-radius:10px;background:' + color + ';color:#fff;'
        + 'font:600 13.5px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.18)}'
        + '@media print { .' + VIEW_PRINT_CLASS + ' { display: none !important; } }</style>'
        + '<button type="button" class="' + VIEW_PRINT_CLASS + '" onclick="window.print()">' + escText(printLabel) + '</button>';
    return beforeBodyEnd(s, chunk);
}
