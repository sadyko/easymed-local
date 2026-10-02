// JOURNALS_V1 — карточки журналов в «Отчётах»: договор экрана и сервера.
//
// Браузер зовёт run_report с kind карточки и аргументами её опций, сервер
// обязан знать и вид, и аргументы. Страница целиком без DOM не поднимается,
// поэтому проверяются определения, чистые функции и места в исходнике.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = globalThis.document || { documentElement: {}, addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null };
globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };

const { REPORT_DEFS, reportKinds, defaultReportOptions, reportArgs, servicesMissing } = await import('../views/reports-hub.js');
const { REPORT_GROUP } = await import('../../shared/permission-catalog.js');
const { ICON_MAP } = await import('../icon-map.js');
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { runReport } = await import('../../../../server/services/rpc/reports.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');
const def = (kind) => REPORT_DEFS.find((d) => d.kind === kind);

test('две карточки журналов: табличные, со значками, обе — группа «Журналы»', () => {
  for (const kind of ['service_journal', 'inpatient_register']) {
    const d = def(kind);
    assert.ok(d, 'нет карточки ' + kind);
    assert.ok(ICON_MAP[d.icon], kind + ': нет значка ' + d.icon);
    assert.ok(!d.mode && !d.rpc && !d.open, kind + ': журнал — обычный табличный отчёт run_report');
    assert.deepEqual(reportKinds(d), [kind]);
    assert.equal(REPORT_GROUP[kind], 'reports.journals');
  }
  assert.equal(def('service_journal').title, 'Журнал услуг');
  assert.equal(def('inpatient_register').title, 'Реестр стационарных пациентов');
});

test('«Журнал услуг»: «Услуги» — окно выбора, «Тип» — Все / Стационар / Амбулатория; по умолчанию — пусто и «Все»', () => {
  const d = def('service_journal');
  const svc = d.options.find((o) => o.arg === 'service_ids');
  assert.equal(svc.type, 'services');
  assert.equal(svc.label, 'Услуги');
  const care = d.options.find((o) => o.arg === 'kind_of_care');
  assert.equal(care.label, 'Тип');
  assert.deepEqual(care.choices, [['all', 'Все'], ['inpatient', 'Стационар'], ['outpatient', 'Амбулатория']]);
  assert.deepEqual(defaultReportOptions(d), { service_ids: [], kind_of_care: 'all' });
  assert.deepEqual(reportArgs(d, 'service_journal', { service_ids: [3, 7], kind_of_care: 'inpatient' }), { service_ids: [3, 7], kind_of_care: 'inpatient' });
  // Два открытия конструктора не делят один массив выбора.
  assert.notEqual(defaultReportOptions(d).service_ids, defaultReportOptions(d).service_ids);
});

test('пустой выбор услуг — отчёт не строится: подсказка вместо запроса', () => {
  const d = def('service_journal');
  assert.equal(servicesMissing(d, 'service_journal', { service_ids: [] }), true);
  assert.equal(servicesMissing(d, 'service_journal', {}), true);
  assert.equal(servicesMissing(d, 'service_journal', { service_ids: [1] }), false);
  assert.equal(servicesMissing(def('inpatient_register'), 'inpatient_register', {}), false);
  assert.equal(servicesMissing(def('total_revenue'), 'total_revenue', {}), false);
  const gen = hub.slice(hub.indexOf('async function generate()'), hub.indexOf('const token = ++st.reqSeq;'));
  assert.match(gen, /if \(servicesMissing\(rep, st\.kind, st\.opts\)\) \{\s*toast\(tr\('Выберите услуги\.'\), 'info'\);/);
});

test('сервер знает оба вида и отвечает колонками журналов', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const admin = { id: 1, role: 'admin' };
    const j = runReport(db, { kind: 'service_journal', from: '2026-01-01', to: '2026-01-31', ...reportArgs(def('service_journal'), 'service_journal', { service_ids: [1], kind_of_care: 'all' }) }, admin);
    assert.equal(j.columns[0], '№');
    assert.ok(j.columns.includes('Ич. рақам (Пор. № пациента)') && j.columns.includes('Заключение'));
    const reg = runReport(db, { kind: 'inpatient_register', from: '2026-01-01', to: '2026-01-31' }, admin);
    assert.equal(reg.columns[0], 'ИБ №');
    assert.deepEqual(reg.summable_columns, ['Сумма оплаты']);
  } finally { db.close(); }
});

test('выбор услуг помнится в браузере и открывает окно выбора; новый выбор сбрасывает результат', () => {
  // JOURNALS_V1_RJ2C (ревью F7) — выбор помнится у каждого сотрудника свой.
  assert.match(hub, /import \{ openReportServicePicker, loadRememberedServices, rememberServices, browserStorage, servicesButtonText, currentUserId \} from '\.\/report-service-picker\.js\?v=jrn3';/);
  assert.match(hub, /if \(o\.type === 'services'\) st\.opts\[o\.arg\] = loadRememberedServices\(browserStorage\(\), rep\.kind, currentUserId\(\)\);/);
  const fn = hub.slice(hub.indexOf('function servicesOption(o)'), hub.indexOf('function resetResult()'));
  assert.ok(fn.length > 100, 'нет servicesOption');
  assert.match(fn, /openReportServicePicker\(\{/);
  assert.match(fn, /loadCatalog: loadServiceCatalog/);
  assert.match(fn, /rememberServices\(browserStorage\(\), rep\.kind, next, currentUserId\(\)\);/);
  assert.match(fn, /paintChoices\(\); resetResult\(\);/);
  assert.match(hub, /if \(o\.type === 'services'\) \{ choiceRow\.appendChild\(servicesOption\(o\)\); continue; \}/);
  assert.match(hub, /supabase\.from\('services'\)\.select\('id, name, active'\)/);
});

test('предпросмотр обрезает длинный текст до 300 знаков и переносит его; итог и Excel — по исходным строкам', () => {
  assert.match(hub, /import \{ reportTotals, localizeReport, reportSheets, clipPreviewText \} from '\.\/report-totals\.js\?v=rt3';/);
  const cells = hub.slice(hub.indexOf('h(\'tbody\', null, ...shown.map('), hub.indexOf('hasTotals ? h(\'tfoot\''));
  assert.match(cells, /clipPreviewText\(String\(v\)\)/);
  assert.match(cells, /whiteSpace: long \? 'normal' : 'nowrap'/);
});

test('«Печать» рядом со «Скачать Excel»: страница из уже полученного ответа, без второго запроса', () => {
  assert.match(hub, /import \{ reportPrintHtml \} from '\.\/report-print\.js\?v=jrn4';/);
  const btn = hub.slice(hub.indexOf('const printBtn = h('), hub.indexOf('const generateBtn = h('));
  assert.ok(btn.length > 100, 'нет кнопки «Печать»');
  assert.match(btn, /reportPrintHtml\(r, \{ title: printTitle\(\), \.\.\.\(st\.resultMeta \|\| \{ from: st\.from, to: st\.to \}\) \}, reportTx\(\)\)/);
  assert.match(btn, /window\.open\('', '_blank'\)/);
  assert.doesNotMatch(btn, /supabase\.rpc/);
  assert.match(btn, /if \(rep\.mode === 'charts' && !rep\.exports\) printBtn\.style\.display = 'none';/);
  assert.match(hub, /downloadBtn,\s*printBtn,/);
  assert.match(hub, /printBtn\.disabled = downloadBtn\.disabled;/);
  assert.match(hub, /downloadBtn\.disabled = true;\s*printBtn\.disabled = true;/);
  assert.match(hub, /st\.resultMeta = \{ from: args\.from, to: args\.to, places \};/);
  // report-print.js и конструктор читают ОДИН модуль report-totals.js (тот же адрес).
  const printSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'report-print.js'), 'utf8');
  assert.match(printSrc, /from '\.\/report-totals\.js\?v=rt3';/);
});

// JOURNALS_V1 (проверка в браузере 02.10) — «Скачать Excel» бросал
// «Cannot set properties of null (setting 'disabled')»: после await у события
// уже нет currentTarget (браузер обнуляет его, когда обработка события
// закончилась), и finally не возвращал кнопку — она оставалась серой до нового
// «Сформировать отчёт». Кнопку берём в переменную ДО первого await.
test('«Скачать Excel»: кнопка берётся до await и снова доступна после выгрузки', () => {
  const uses = hub.match(/ev\.currentTarget/g) || [];
  const captured = hub.match(/async \(ev\) => \{\s*const btn = ev\.currentTarget;/g) || [];
  assert.ok(captured.length >= 2, 'обе кнопки Excel (конструктор и отчёт кассира) берут кнопку до await');
  assert.equal(uses.length, captured.length, 'ev.currentTarget прочитан не в первой строке обработчика — после await он null');
  assert.equal((hub.match(/finally \{ btn\.disabled = false; \}/g) || []).length, captured.length);
});

// Каждая задача, менявшая reports-hub.js, меняет и его штамп в admin.js: модуль
// с прежним адресом браузер взял бы из своего кэша модулей.
test('штамп reports-hub.js в admin.js — последний в серии журналов', () => {
  const admin = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin.js'), 'utf8');
  assert.match(admin, /from '\.\/admin\/views\/reports-hub\.js\?v=jrn8';/);
});
