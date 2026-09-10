// ACT_TABLE_V1 — РЕЕСТР ТАБЛИЦЕЙ НА ДИСК.
//
// Кнопка называется «Excel», а файл — .csv, и это не подмена: Excel открывает
// такой файл двойным щелчком, а настоящий .xlsx потребовал бы библиотеки ради
// одной таблицы. Точка с запятой и BOM — потому что русский Excel читает
// запятую как десятичный знак, а без BOM показывает кракозябры.

export function downloadCsv(text, filename) {
    const blob = new Blob([String.fromCharCode(0xFEFF) + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'export.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
