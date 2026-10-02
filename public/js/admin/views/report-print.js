// JOURNALS_V1_PRINT (2026-10-02) — «ПЕЧАТЬ» ЛЮБОГО ТАБЛИЧНОГО ОТЧЁТА.
//
// Владелец («Excel + Print»): рядом со «Скачать Excel» — «Печать». Страница
// строится из УЖЕ полученного ответа run_report — второго запроса нет; на ней
// заголовок, период, здания или филиалы (если выбрано подмножество), ВСЕ
// строки (не 300 предпросмотра) и итог — те же складываемые колонки и та же
// строка «Итого», что у Excel (reportSheets). Колонок больше 8 — альбомный лист.
//
// Модуль чистый: язык экрана приходит словарём tx ({ tr, trf, lang,
// monthName } — как у report-totals.js), окно открывает вызывающий. Данные
// клиники экранируются; HTML из данных не вставляется никогда.
import { reportSheets } from './report-totals.js?v=rt3';
import { PRINT_FONT_FACE_CSS, PRINT_FONT_STACK } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1 — семейство печати

/** Колонок больше — лист альбомный. */
export const PRINT_PORTRAIT_MAX_COLS = 8;
/**
 * JOURNALS_V1_RJ2C (ревью F8) — строк на печати не больше: журнал на 60 000
 * строк открывал окно печати такого же размера. Сверх предела печатаются первые
 * строки и предупреждение наверху; Excel — без предела. «Итого» — по ВСЕМ
 * строкам ответа: его считает reportSheets по ответу целиком.
 */
export const PRINT_ROW_CAP = 5000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 'ГГГГ-ММ-ДД…' → 'дд.мм.гггг'; прочее — как есть. */
export function dmy(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(ymd || '');
}

// Размеры печатного листа — бумажные метрики в pt: шкала экрана (12.5…40 px)
// к печати не относится (TYPE_SCALE_V1, исключение для печатных документов).
// Перенос в ячейках — break-word, не anywhere: anywhere сжимает минимальную
// ширину колонки до буквы, и при длинном заключении имена рвутся по буквам.
/* type-scale-exempt-start: печатный лист отчёта — бумажные метрики (pt), шкала экрана к печати не относится */
const PRINT_CSS = `
body { font-family: ${PRINT_FONT_STACK}; color: #111; margin: 0; }
h1 { font-size: 14pt; margin: 0 0 3pt; }
.rp-sub { font-size: 9pt; color: #444; margin: 0 0 8pt; }
.rp-cap { font-size: 9pt; font-weight: 700; margin: 0 0 8pt; padding: 4pt 6pt; border: 0.8pt solid #333; }
.rp-tbl { width: 100%; border-collapse: collapse; font-size: 8pt; }
.rp-tbl th { text-align: left; border-bottom: 1.2pt solid #333; padding: 3pt 4pt; font-weight: 700; vertical-align: bottom; }
.rp-tbl td { border-bottom: 0.5pt solid #ccc; padding: 3pt 4pt; vertical-align: top; overflow-wrap: break-word; }
.rp-tbl .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rp-tbl tfoot td { font-weight: 800; border-top: 1.2pt solid #333; border-bottom: 0; }
tr { page-break-inside: avoid; break-inside: avoid; }
thead { display: table-header-group; }
`;
/* type-scale-exempt-end */

/**
 * Печатная страница отчёта.
 * @param {object} r     ответ run_report ({ columns, rows, summable_columns, total_skip_rows, … })
 * @param {object} meta  { title, from, to, places: { kind: 'buildings'|'branches', list: [подписи] } }
 * @param {object} tx    { tr, trf, lang, monthName }
 */
export function reportPrintHtml(r, meta, tx) {
    const res = r || {};
    const m = meta || {};
    const rows = res.rows || [];
    // Заголовки, слова-перечисления, шаблоны ячеек и строка «Итого» — те же,
    // что у Excel: одна функция на обе выгрузки.
    const [head, ...rest] = reportSheets(res, tx).report;
    // JOURNALS_V1_RJ2C — печатаются первые PRINT_ROW_CAP строк; итог — из
    // reportSheets, то есть по всем строкам ответа, а не по напечатанным.
    const capped = rows.length > PRINT_ROW_CAP;
    const body = rest.slice(0, Math.min(rows.length, PRINT_ROW_CAP));
    const totals = rest.length > rows.length ? rest[rows.length] : null;
    // JOURNALS_V1_RJ2C (ревью, п. 2) — у отчёта с «Итого» строка говорит прямо,
    // что итог под напечатанными строками — по всем строкам отчёта.
    const capParams = { n: PRINT_ROW_CAP.toLocaleString('ru-RU'), total: rows.length.toLocaleString('ru-RU') };
    const capLine = !capped ? ''
        : totals
            ? tx.trf('Напечатаны первые {n} строк из {total}; «Итого» — по всем {total} строкам. Полный отчёт выгрузите в Excel.', capParams)
            : tx.trf('Напечатаны первые {n} строк из {total} — полный отчёт выгрузите в Excel.', capParams);
    const isNum = head.map((_, ci) => {
        const probe = rows.find((x) => x[ci] != null && x[ci] !== '');
        return typeof (probe && probe[ci]) === 'number';
    });
    const cell = (v, ci) => {
        if (v == null || v === '') return '';
        return isNum[ci] && typeof v === 'number' ? esc(Number(v).toLocaleString('ru-RU')) : esc(v);
    };
    const td = (v, ci) => `<td${isNum[ci] ? ' class="num"' : ''}>${cell(v, ci)}</td>`;
    const period = tx.trf('Период: {from} — {to}', { from: dmy(m.from), to: dmy(m.to) });
    const list = m.places && Array.isArray(m.places.list) ? m.places.list : [];
    const places = list.length
        ? tx.trf(m.places.kind === 'branches' ? 'Филиалы: {list}' : 'Здания: {list}', { list: list.join(', ') })
        : '';
    const orientation = head.length > PRINT_PORTRAIT_MAX_COLS ? 'landscape' : 'portrait';
    return `<!doctype html><html lang="${esc(tx.lang || 'ru')}"><head><meta charset="utf-8">
<title>${esc(m.title || '')}</title>
<style>
${PRINT_FONT_FACE_CSS}
@page { size: A4 ${orientation}; margin: 10mm; }
${PRINT_CSS}
</style></head><body>
<h1>${esc(m.title || '')}</h1>
<p class="rp-sub">${esc(period)}${places ? ' · ' + esc(places) : ''}</p>
${capLine ? `<p class="rp-cap">${esc(capLine)}</p>` : ''}
<table class="rp-tbl">
<thead><tr>${head.map((c, ci) => `<th${isNum[ci] ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map((row) => `<tr>${row.map(td).join('')}</tr>`).join('\n')}</tbody>
${totals ? `<tfoot><tr>${totals.map((v, ci) => (ci === 0 ? `<td>${esc(v)}</td>` : td(v, ci))).join('')}</tr></tfoot>` : ''}
</table>
<script>window.onload = function () { (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { try { window.focus(); window.print(); } catch (e) {} }); };</scr` + `ipt>
</body></html>`;
}
