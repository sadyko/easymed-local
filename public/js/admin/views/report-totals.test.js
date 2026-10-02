import test from 'node:test';
import assert from 'node:assert/strict';
import { isSummableHeader, reportTotals, localizeReport, reportSheets, clipPreviewText, PREVIEW_TEXT_CAP } from './report-totals.js';

test('деньги и количества суммируются', () => {
  for (const h of ['Сумма без скидки', 'Оплачено', 'Остаток / долг', 'Total', 'Discount', 'Кол-во', 'Выручка']) {
    assert.equal(isSummableHeader(h), true, h);
  }
});

test('проценты, средние, возраст, годы, id и даты — не суммируются', () => {
  for (const h of ['Скидка, %', 'Процент врача', 'Средний чек', 'Avg', 'Возраст', 'Год', 'ID пациента', 'Дата оплаты', '№ счёта', 'Доля, %']) {
    assert.equal(isSummableHeader(h), false, h);
  }
});

// --- табличная часть: колонки массивом (reports-hub) ---
const COLS = [{ label: 'Пациент' }, { label: 'Сумма' }, { label: 'Скидка, %' }, { label: 'Оплачено' }];
const ROWS = [
  ['Иванов', 100000, 10, 100000],
  ['Петров', 50000, 0, 0],
  ['Сидоров', 30000, 5, 30000],
];
const get = (r, _c, ci) => r[ci];
const numeric = (_c, ci) => ci > 0;

test('итог считается по суммируемым колонкам и пропускает остальные', () => {
  assert.deepEqual(reportTotals(COLS, ROWS, get, numeric), [null, 180000, null, 130000]);
});

test('текстовая колонка итога не получает, даже если заголовок «денежный»', () => {
  const totals = reportTotals(COLS, ROWS, get, () => false);
  assert.deepEqual(totals, [null, null, null, null]);
});

test('пустые и нечисловые ячейки не ломают сумму', () => {
  const rows = [['А', 100, 0, null], ['Б', null, 0, ''], ['В', '—', 0, 50]];
  assert.deepEqual(reportTotals(COLS, rows, get, numeric), [null, 100, null, 50]);
});

test('колонка без единого числа итога не показывает', () => {
  const rows = [['А', null, null, null]];
  assert.deepEqual(reportTotals(COLS, rows, get, numeric), [null, null, null, null]);
});

test('копеечный хвост float не всплывает в итоге', () => {
  const rows = [['А', 0.1, 0, 0], ['Б', 0.2, 0, 0]];
  assert.equal(reportTotals(COLS, rows, get, numeric)[1], 0.3);
});

test('итог берётся по ВСЕМ строкам, а не по показанным', () => {
  const many = Array.from({ length: 500 }, () => ['x', 1000, 0, 0]);
  assert.equal(reportTotals(COLS, many, get, numeric)[1], 500000);
});

// REPORT_TOTALS (ревью I-5) — «доля» в заголовке — это деньги («Доля врача» —
// сумма гонорара), а не процент; ставка («Ставка врача») — процент, хотя
// знака % в заголовке нет.
test('денежные «доли» суммируются; ставка и «доля, %» — нет', () => {
  for (const h of ['Доля врача', 'Оплачено (доля оплаты счёта)', 'Доля за услуги', 'Стационарная доля', 'Доля врача (гонорар)', 'Услуг по фикс. ставке']) {
    assert.equal(isSummableHeader(h), true, h);
  }
  for (const h of ['Ставка врача', 'ставка', 'Доля, %', 'Доля врача, %']) {
    assert.equal(isSummableHeader(h), false, h);
  }
});

// REPORTS_AUDIT_FIX_V1 — список складываемых колонок называет сервер, а
// строки вне итога (отменённые счета, DEP-/CARD-) футер пропускает.
test('сервер назвал складываемые колонки — «Цена» и «Пациентов» не складываются, даже без знака %', () => {
  const cols = [{ label: 'Услуга' }, { label: 'Цена' }, { label: 'Пациентов' }, { label: 'Сумма' }];
  const rows = [['A', 50000, 3, 150000], ['B', 20000, 2, 40000]];
  // Угадывание по заголовку их сложило бы.
  assert.deepEqual(reportTotals(cols, rows, get, numeric), [null, 70000, 5, 190000]);
  assert.deepEqual(reportTotals(cols, rows, get, numeric, { summable: ['Сумма'] }), [null, null, null, 190000]);
});

test('строки вне итога не складываются', () => {
  assert.deepEqual(reportTotals(COLS, ROWS, get, numeric, { skipRows: [1] }), [null, 130000, null, 130000]);
});

// V3120_FIX (I18N + EXCEL) — отчёт на языке экрана и выгрузка с «Итого».
import { STRINGS } from '../i18n-strings.js';
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const txFor = (lang) => {
  const tr = (s) => (STRINGS[s] && STRINGS[s][lang]) || s;
  return {
    lang, tr,
    trf: (tpl, params) => Object.entries(params || {}).reduce((out, [k, v]) => out.split('{' + k + '}').join(String(v)), tr(tpl)),
    monthName: (m) => MONTHS_EN[m],
  };
};
const REPORT = {
  columns: ['Где', 'Услуга', 'Вознаграждение', 'Ставка врача'],
  rows: [['Амбулатория', 'Приём', 1000, 30], ['Корректировка', 'Корректировка за август 2026', -250, null]],
  cells_t: [[1, 1, 'Корректировка за {month}', { month: '2026-08' }]],
  notes: ['Закрыт месяц: август 2026 (2026-09-27) — …', 'Вознаграждение за направления — как и прежде, только по оплаченным счетам.'],
  notes_t: [{ template: 'Закрытые месяцы (в скобках — день закрытия): {months} — их суммы показаны по записи на момент закрытия и не меняются. Изменения после закрытия — строками «Корректировка за …» в первом открытом месяце.', params: { months: '2026-08 (2026-09-27)' } }, null],
  summable_columns: ['Вознаграждение'],
  total_skip_rows: [],
};

test('localizeReport: заголовки, перечисления, шаблоны ячеек и примечаний — на языке экрана', () => {
  const en = localizeReport(REPORT, txFor('en'));
  assert.equal(en.columns[0], STRINGS['Где'].en);
  assert.equal(en.rows[0][0], STRINGS['Амбулатория'].en, 'колонка-перечисление переводится');
  assert.equal(en.rows[0][1], 'Приём', 'данные клиники (название услуги) не трогаются');
  assert.equal(en.rows[1][1], 'Adjustment for August 2026');
  assert.match(en.notes[0], /August 2026 \(2026-09-27\)/);
  assert.equal(en.notes[1], STRINGS['Вознаграждение за направления — как и прежде, только по оплаченным счетам.'].en);
  const ru = localizeReport(REPORT, txFor('ru'));
  assert.equal(ru.rows[1][1], 'Корректировка за август 2026', 'по-русски — текст сервера как есть');
  assert.equal(ru.notes[0], REPORT.notes[0]);
});

test('reportSheets: строка «Итого» по тем же правилам, что под таблицей, и лист примечаний', () => {
  const s = reportSheets(REPORT, txFor('uz'));
  assert.equal(s.report.length, 1 + 2 + 1);
  const total = s.report[s.report.length - 1];
  assert.equal(total[0], STRINGS['Итого'].uz);
  assert.equal(total[2], 750);
  assert.equal(total[3], null, 'ставка не складывается');
  assert.equal(s.notes[0][0], STRINGS['Примечания'].uz);
  assert.equal(s.notes.length, 3);
  const skipped = reportSheets({ ...REPORT, total_skip_rows: [1] }, txFor('en'));
  assert.equal(skipped.report[skipped.report.length - 1][2], 1000, 'строки вне итога не складываются');
  assert.equal(reportSheets({ ...REPORT, notes: [], notes_t: [] }, txFor('en')).notes, null);
});

// JOURNALS_V1 — длинный текст (заключение врача) на экране — до 300 знаков;
// в Excel и при печати — целиком.
test('JOURNALS_V1: длинный текст на экране — до 300 знаков с «…», короткий — как есть', () => {
  assert.equal(PREVIEW_TEXT_CAP, 300);
  const out = clipPreviewText('а'.repeat(450));
  assert.equal(out.length, 300);
  assert.ok(out.endsWith('…'));
  assert.equal(clipPreviewText('а'.repeat(300)), 'а'.repeat(300));
  assert.equal(clipPreviewText('Гепатомегалия'), 'Гепатомегалия');
  assert.equal(clipPreviewText(null), '');
});

test('JOURNALS_V1: «Пол», «Тип палаты», «Кто направил» — слова словаря; Excel несёт заключение целиком', () => {
  const dict = { 'Муж.': 'Male', 'Полулюкс': 'Semi-lux', 'сам': 'self-referred' };
  const tx = { tr: (s) => dict[s] || s, trf: (t) => t, lang: 'en', monthName: () => '' };
  const r = { columns: ['ФИО', 'Пол', 'Тип палаты', 'Кто направил', 'Заключение'], rows: [['Азизов', 'Муж.', 'Полулюкс', 'сам', 'Х'.repeat(400)]] };
  assert.deepEqual(localizeReport(r, tx).rows[0].slice(0, 4), ['Азизов', 'Male', 'Semi-lux', 'self-referred']);
  assert.equal(reportSheets(r, tx).report[1][4].length, 400);
});
