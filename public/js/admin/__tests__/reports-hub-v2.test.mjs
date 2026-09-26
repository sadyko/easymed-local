// REPORTS_V2 — карточки новых отчётов, их виды и фильтры.
//
// Карточка — договор двух сторон: браузер зовёт run_report с kind вида и с
// аргументами фильтров из определения, сервер обязан знать и этот kind, и эти
// значения. Разъехались — вид открывается и молча показывает «unknown report
// kind» или 400. Поэтому для КАЖДОГО табличного определения каждый вид и
// каждое значение каждого фильтра прогоняются через настоящий runReport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Страница «Отчёты» грузит i18n, которому при импорте нужен document.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = globalThis.document || { documentElement: {}, addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null };
globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };

const { REPORT_DEFS, reportKinds, defaultReportOptions, optionsFor, reportArgs, selectChoices } = await import('../views/reports-hub.js');
const { ICON_MAP } = await import('../icon-map.js');
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { runReport } = await import('../../../../server/services/rpc/reports.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

const tableDefs = REPORT_DEFS.filter((d) => !d.mode && !d.open);
const def = (kind) => REPORT_DEFS.find((d) => d.kind === kind);

test('каждый вид и каждое значение фильтра табличной карточки известны серверу', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    for (const d of tableDefs) {
      assert.ok(ICON_MAP[d.icon], 'нет значка ' + d.icon + ' у «' + d.title + '»');
      for (const kind of reportKinds(d)) {
        const base = { kind, from: '2026-01-01', to: '2026-01-31', ...reportArgs(d, kind, defaultReportOptions(d)) };
        const r = runReport(db, base, { id: 1, role: 'admin' });
        assert.equal(r.columns[0], 'Здание', kind + ': первая колонка — «Здание»');
        for (const o of optionsFor(d, kind)) {
          for (const [value] of o.choices) {
            assert.doesNotThrow(() => runReport(db, { ...base, [o.arg]: value }, { id: 1, role: 'admin' }),
              kind + ': значение ' + o.arg + '=' + value + ' не принято сервером');
          }
        }
      }
    }
  } finally { db.close(); }
});

test('«Рефералы»: сводка и детализация, фильтр «Все / Внутренние / Внешние»', () => {
  const d = def('referrals');
  assert.deepEqual(reportKinds(d), ['referrals', 'referrals_detail']);
  const o = (d.options || []).find((x) => x.arg === 'referrer');
  assert.ok(o, 'нет фильтра направивших');
  assert.deepEqual(o.choices.map((c) => c[0]), ['all', 'internal', 'external']);
  assert.equal(defaultReportOptions(d).referrer, 'all');
});

test('конструктор зовёт run_report ВЫБРАННЫМ видом и с выбранными фильтрами, и так же называет файл', () => {
  // Ревью M1 — вид и фильтры берутся ДО ожидания ответа.
  assert.match(hub, /const reqKind = st\.kind;\s*const reqArgs = reportArgs\(rep, reqKind, st\.opts\);/);
  assert.match(hub, /supabase\.rpc\('run_report', \{ kind: reqKind, \.\.\.args, \.\.\.reqArgs \}\)/);
  assert.match(hub, /XLSX\.writeFile\(wb, `\$\{st\.kind\}_/);
  // Смена вида или фильтра сбрасывает результат — старая таблица не уйдёт в Excel под новым именем.
  assert.match(hub, /function resetResult\(\) \{\s*st\.reqSeq\+\+;[^\n]*\s*st\.result = null;\s*downloadBtn\.disabled = true;/);
});

test('«По услугам»: табличная карточка с фильтрами «Счета» и «Группа» (пять групп)', () => {
  const d = def('by_services');
  assert.ok(d, 'нет карточки «По услугам»');
  assert.deepEqual(reportKinds(d), ['by_services']);
  const paid = d.options.find((o) => o.arg === 'paid');
  assert.deepEqual(paid.choices.map((c) => c[0]), ['all', 'paid']);
  const group = d.options.find((o) => o.arg === 'group');
  assert.deepEqual(group.choices.map((c) => c[0]), ['all', 'consultation', 'lab', 'imaging', 'procedure', 'other']);
  // SERVICE_VOCABULARY — пять групп не называются «Тип».
  assert.equal(group.label, 'Группа');
});

test('«По врачам»: три вида — врачи, врачи × услуги и детализация', () => {
  const d = def('by_doctors');
  assert.ok(d, 'нет карточки «По врачам»');
  assert.deepEqual(reportKinds(d), ['by_doctors', 'doctor_services', 'doctor_lines']);
  assert.ok(ICON_MAP[d.icon]);
});

// DOCTOR_LINES_SPECIALTY_V1 — фильтр «Врач» — выпадающий список (type 'select'):
// первый вариант «все» (пусто — аргумент не уезжает), остальные — от сервера.
test('«По врачам»: фильтр врача — выпадающий список у «Врачей и услуг» и детализации, не у сводки', () => {
  const d = def('by_doctors');
  assert.deepEqual(optionsFor(d, 'by_doctors').map((o) => o.arg), []);
  for (const kind of ['doctor_services', 'doctor_lines']) {
    const o = optionsFor(d, kind).find((x) => x.arg === 'doctor_id');
    assert.ok(o, kind + ': нет фильтра врача');
    assert.equal(o.type, 'select');
    assert.deepEqual(o.choices, [['', 'Все врачи']]);
  }
  assert.equal(defaultReportOptions(d).doctor_id, '');
  assert.deepEqual(reportArgs(d, 'doctor_lines', { doctor_id: '' }), {});
  assert.deepEqual(reportArgs(d, 'doctor_lines', { doctor_id: '7' }), { doctor_id: '7' });
  assert.deepEqual(reportArgs(d, 'by_doctors', { doctor_id: '7' }), {});
  const o = optionsFor(d, 'doctor_lines')[0];
  assert.deepEqual(selectChoices(o, [['7', 'Иванов'], ['', 'дубль']]), [['', 'Все врачи'], ['7', 'Иванов']]);
  assert.deepEqual(selectChoices(o, null), [['', 'Все врачи']]);
  // Варианты грузит конструктор тем же RPC, что закрыт воротами отчёта.
  assert.match(hub, /supabase\.rpc\('report_choices', \{ kind: st\.kind, arg: o\.arg \}\)/);
});

test('«По специальностям»: табличная карточка, один вид', () => {
  const d = def('by_specialty');
  assert.ok(d, 'нет карточки «По специальностям»');
  assert.deepEqual(reportKinds(d), ['by_specialty']);
  assert.ok(ICON_MAP[d.icon]);
});

test('«Закупки и склад»: четыре вида, «Разрез» — только у расхода, «Категория» — у всех', () => {
  const d = def('procurement');
  assert.equal(d.title, 'Закупки и склад');
  assert.deepEqual(reportKinds(d), ['procurement', 'stock_consumption', 'stock_statement', 'stock_expiry']);
  assert.deepEqual(optionsFor(d, 'stock_consumption').map((o) => o.arg), ['by', 'category']);
  // PROCUREMENT_FILTERS_V1 — категория у всех четырёх видов.
  for (const kind of reportKinds(d)) {
    assert.ok(optionsFor(d, kind).some((o) => o.arg === 'category'), kind + ': нет фильтра категории');
  }
  assert.deepEqual(optionsFor(d, 'stock_statement').map((o) => o.arg), ['category']);
  const cat = optionsFor(d, 'stock_expiry').find((o) => o.arg === 'category');
  assert.deepEqual(cat.choices.map((c) => c[0]),
    ['all', 'medicines', 'consumables', 'equipment', 'lab_supplies', 'dental', 'radiology', 'office_it', 'facility']);
  assert.equal(defaultReportOptions(d).category, 'all');
  // Чужой фильтр не уезжает на сервер.
  assert.deepEqual(reportArgs(d, 'stock_statement', { by: 'holder', category: 'dental' }), { category: 'dental' });
  assert.deepEqual(reportArgs(d, 'stock_consumption', { by: 'holder', category: 'all' }), { by: 'holder', category: 'all' });
  assert.deepEqual(optionsFor(d, 'stock_consumption')[0].choices.map((c) => c[0]), ['lines', 'holder', 'patient']);
});

test('M1: устаревший ответ выбрасывается, переключатели выключены на время запроса', () => {
  const i = hub.indexOf('async function generate()');
  const gen = hub.slice(i, hub.indexOf('overlay.appendChild', i));
  // Номер запроса берётся до await, ответ сверяется с ним и с видом после.
  assert.ok(gen.indexOf('const token = ++st.reqSeq;') > -1 && gen.indexOf('const token = ++st.reqSeq;') < gen.indexOf('await supabase.rpc'));
  assert.match(gen, /if \(token !== st\.reqSeq \|\| st\.kind !== reqKind\) return;/);
  // Сброс результата делает любой ответ в пути устаревшим.
  assert.match(hub, /function resetResult\(\) \{\s*st\.reqSeq\+\+;/);
  // Переключатели: выключены и не срабатывают, пока идёт запрос.
  assert.match(hub, /disabled: st\.generating \|\| null/);
  assert.equal((hub.match(/if \(st\.generating \|\| st\.(kind === v\.kind|opts\[o\.arg\] === value)\) return;/g) || []).length, 2);
  // Выгрузка называет файл выбранным видом, а берёт результат, который пришёл для него.
  assert.match(hub, /XLSX\.writeFile\(wb, `\$\{st\.kind\}_/);
});
