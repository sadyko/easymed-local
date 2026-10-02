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

/** Есть ли в HTML своя печать (window.print). */
export function hasAutoPrint(html) {
    return PRINT_CALL_RE.test(String(html == null ? '' : html));
}

/** HTML окна печати → тот же HTML, который печатается сам; печать уже есть — без изменений. */
export function ensureAutoPrint(html) {
    const s = String(html == null ? '' : html);
    if (hasAutoPrint(s)) return s;
    const at = s.toLowerCase().lastIndexOf('</body>');
    return at < 0 ? s + AUTO_PRINT_SCRIPT : s.slice(0, at) + AUTO_PRINT_SCRIPT + s.slice(at);
}
