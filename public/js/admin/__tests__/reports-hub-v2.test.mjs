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

const { REPORT_DEFS, reportKinds, defaultReportOptions, optionsFor, reportArgs } = await import('../views/reports-hub.js');
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
  assert.match(hub, /supabase\.rpc\('run_report', \{ kind: st\.kind, \.\.\.args, \.\.\.reportArgs\(rep, st\.kind, st\.opts\) \}\)/);
  assert.match(hub, /XLSX\.writeFile\(wb, `\$\{st\.kind\}_/);
  // Смена вида или фильтра сбрасывает результат — старая таблица не уйдёт в Excel под новым именем.
  assert.match(hub, /function resetResult\(\) \{\s*st\.result = null;\s*downloadBtn\.disabled = true;/);
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

test('«По врачам»: два вида — врачи и врачи × услуги', () => {
  const d = def('by_doctors');
  assert.ok(d, 'нет карточки «По врачам»');
  assert.deepEqual(reportKinds(d), ['by_doctors', 'doctor_services']);
  assert.ok(ICON_MAP[d.icon]);
});

test('«Закупки и склад»: четыре вида, «Разрез» — только у расхода', () => {
  const d = def('procurement');
  assert.equal(d.title, 'Закупки и склад');
  assert.deepEqual(reportKinds(d), ['procurement', 'stock_consumption', 'stock_statement', 'stock_expiry']);
  assert.deepEqual(optionsFor(d, 'stock_consumption').map((o) => o.arg), ['by']);
  assert.deepEqual(optionsFor(d, 'stock_statement'), []);
  // Чужой фильтр не уезжает на сервер.
  assert.deepEqual(reportArgs(d, 'stock_statement', { by: 'holder' }), {});
  assert.deepEqual(reportArgs(d, 'stock_consumption', { by: 'holder' }), { by: 'holder' });
  assert.deepEqual(optionsFor(d, 'stock_consumption')[0].choices.map((c) => c[0]), ['lines', 'holder', 'patient']);
});
