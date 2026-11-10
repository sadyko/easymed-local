// TG_LAB_MATRIX_V1 (3.23.0) — бактериальный посев (панель-таблица) уходит
// пациенту в Telegram ТАБЛИЦЕЙ, как на бумаге, а не списком «строка · графа ++++».
//
// Бот собирал группу бланка { title, tests } без таблицы и не читал
// lab_panels.kind / matrix_json — общий шаблон (doc-variants.js grp) печатал
// список. Теперь buildLab берёт активную панель услуги и раскладывает в группу
// ту же часть, что и печать в браузере (shared/lab-matrix.js matrixGroupPart).
// Путь — как в renderPdf, без Chrome: buildDocument → buildSheetHtml → stripAutoPrint.
// Данные — выдуманные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { labPanelSave } from '../rpc/lab-panels.js';
import { saveLabResults } from '../rpc/lab.js';
import { buildSheetHtml } from '../../../public/js/shared/doc-render.js';
import { cellName } from '../../../public/js/shared/lab-matrix.js';
import { buildDocument } from './documents.js';
import { loadServerDocSettings, stripAutoPrint } from './render.js';

const LAB = { id: 2, role: 'lab' };
const LAB_ENTRY = { role: 'lab' };   // entered_by — без сотрудника (в базе стенда его нет)
const MATRIX = {
  scale: '−, +, ++, +++, ++++',
  sections: [
    { title: 'Раздел А', columns: ['графа 1', 'графа 2', 'графа 3'], rows: ['строка 1', 'строка 2', 'строка 3'] },
  ],
};
const VALUES = [['строка 1', 'графа 1', '++++'], ['строка 1', 'графа 2', '+'], ['строка 1', 'графа 3', '+++'],
  ['строка 2', 'графа 1', '++'], ['строка 2', 'графа 2', '++'], ['строка 2', 'графа 3', '++'],
  ['строка 3', 'графа 1', '+++'], ['строка 3', 'графа 2', '+++'], ['строка 3', 'графа 3', '+++']];

function seed({ kind = 'matrix', active = true } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Бак. посев (проба)', 90000, 'lab', 1, 1);
           INSERT INTO patients (id, full_name, phone, gender, date_of_birth) VALUES (7, 'Тестов Тест', '+998 90 000 00 00', 'male', '1994-11-15');
           INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, '2026-11-08', 'scheduled');
           INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (4274, 20, 60, 'in_progress');`);
  const panel = kind === 'matrix'
    ? { name: 'Бак. посев', modality: 'lab', has_narrative: false, service_id: '60', active: true, device_id: null, kind: 'matrix', matrix: MATRIX }
    : { name: 'Бак. посев', modality: 'lab', has_narrative: false, service_id: '60', active: true, device_id: null };
  const { id: panelId } = labPanelSave(db, { panel }, LAB);
  if (!active) db.prepare('UPDATE lab_panels SET active = 0 WHERE id = ?').run(panelId);
  return { db, panelId };
}
function saveCells(db, vals) {
  saveLabResults(db, { visit_service_id: 4274, rows: vals.map(([r, c, v]) => ({ parameter: cellName(r, c), value: v })) }, LAB_ENTRY);
  db.exec("UPDATE lab_results SET verified_at = '2026-11-09T10:00:00Z' WHERE visit_service_id = 4274");
}
function pdfHtml(db, doc, s = loadServerDocSettings(db)) {
  return stripAutoPrint(buildSheetHtml({ type: doc.type, s, data: doc.data, title: doc.title, idLine: doc.idLine }));
}
const matrixTable = (html) => (html.match(/<table class="res mx">[\s\S]*?<\/table>/) || [''])[0];

test('TG_LAB_MATRIX_V1: посев уходит в бот таблицей — графы, строки, степени; списка «строка · графа» нет', () => {
  const { db } = seed();
  saveCells(db, VALUES);
  const doc = buildDocument(db, 'lab:4274', 7);
  const g = doc.data.groups[0];
  assert.ok(g.matrix, 'группа бланка без таблицы — бот печатает список');
  assert.equal(g.matrix.filled, 9);
  assert.deepEqual(g.matrix.sections[0].rows[0], { name: 'строка 1', cells: ['++++', '+', '+++'] });
  assert.equal(g.tests.length, 9, 'tests остаются (по ним бланк знает, что результаты есть)');
  const html = pdfHtml(db, doc);
  assert.ok(html.includes('class="res mx"'), 'в PDF нет таблицы посева');
  const t = matrixTable(html);
  assert.match(t, /<th class="c">графа 1<\/th><th class="c">графа 2<\/th><th class="c">графа 3<\/th>/);
  assert.match(t, /<td class="pname">строка 1<\/td><td class="c mx-v">\+\+\+\+<\/td><td class="c mx-v">\+<\/td><td class="c mx-v">\+\+\+<\/td>/);
  assert.ok(!html.includes('строка 1 · графа 1'), 'в PDF остались строки списка «строка · графа»');
  db.close();
});

test('TG_LAB_MATRIX_V1: вариант бланка «компактный» — тоже таблица', () => {
  const { db } = seed();
  saveCells(db, VALUES);
  const doc = buildDocument(db, 'lab:4274', 7);
  const base = loadServerDocSettings(db);
  const html = pdfHtml(db, doc, { ...base, variant: { ...(base.variant || {}), lab: 'compact' } });
  assert.ok(html.includes('class="lgrp"'), 'стенд не тот: бланк не компактный');
  assert.ok(html.includes('class="res mx"'), 'компактный бланк без таблицы посева');
  assert.ok(!html.includes('строка 2 · графа 3'));
  db.close();
});

test('TG_LAB_MATRIX_V1: обычная панель — как прежде, списком, без таблицы', () => {
  const { db } = seed({ kind: 'plain' });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, flag, verified_at) VALUES (4274, 'HGB', '140', 'г/л', 'normal', '2026-11-09T10:00:00Z')").run();
  const doc = buildDocument(db, 'lab:4274', 7);
  assert.equal(doc.data.groups[0].matrix, undefined);
  assert.deepEqual(Object.keys(doc.data.groups[0]).sort(), ['tests', 'title']);
  const html = pdfHtml(db, doc);
  assert.ok(!html.includes('class="res mx"'));
  assert.ok(html.includes('HGB'));
  db.close();
});

test('TG_LAB_MATRIX_V1: панель-таблица снята с работы (не активна) — бланк списком, как прежде', () => {
  const { db } = seed({ active: false });
  db.prepare('INSERT INTO lab_results (visit_service_id, parameter, value, flag, verified_at) VALUES (?,?,?,?,?)')
    .run(4274, cellName('строка 1', 'графа 1'), '++', 'normal', '2026-11-09T10:00:00Z');
  const doc = buildDocument(db, 'lab:4274', 7);
  assert.equal(doc.data.groups[0].matrix, undefined, 'неактивная панель напечатана таблицей');
  const html = pdfHtml(db, doc);
  assert.ok(!html.includes('class="res mx"'));
  assert.ok(html.includes('строка 1 · графа 1'), 'список показателей пропал');
  db.close();
});

test('TG_LAB_MATRIX_V1: снятая степень — пустая клетка, отметка только в новой графе', () => {
  const { db } = seed();
  saveCells(db, [['строка 1', 'графа 1', '++']]);
  // Лаборант снял степень и поставил её в соседнюю графу (тот же порядок, что «Сохранить всё»).
  const was = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = 4274').get();
  saveLabResults(db, { visit_service_id: 4274, rows: [
    { id: was.id, parameter: cellName('строка 1', 'графа 1'), value: '' },
    { parameter: cellName('строка 1', 'графа 2'), value: '++' },
  ] }, LAB_ENTRY);
  db.exec("UPDATE lab_results SET verified_at = '2026-11-09T11:00:00Z' WHERE visit_service_id = 4274");
  const doc = buildDocument(db, 'lab:4274', 7);
  assert.deepEqual(doc.data.groups[0].matrix.sections[0].rows[0], { name: 'строка 1', cells: ['', '++', ''] });
  assert.match(matrixTable(pdfHtml(db, doc)), /<td class="pname">строка 1<\/td><td class="c mx-v"><\/td><td class="c mx-v">\+\+<\/td><td class="c mx-v"><\/td>/);
  db.close();
});

test('TG_LAB_MATRIX_V1: таблица панели испорчена — бланк списком, документ всё равно собирается', () => {
  const { db, panelId } = seed();
  saveCells(db, VALUES);
  db.prepare("UPDATE lab_panels SET matrix_json = '{не json' WHERE id = ?").run(panelId);
  const doc = buildDocument(db, 'lab:4274', 7);
  assert.ok(doc, 'документ не собран');
  assert.equal(doc.data.groups[0].matrix, undefined);
  assert.equal(doc.data.groups[0].tests.length, 9);
  db.close();
});

// TG_LAB_MATRIX_V1 — значение прибора в боте — с тем же округлением, что на бумаге
// (LAB_ROUND_V1, labShownValue): «4.152122» → «4.15»; настройка выключена — полное.
test('TG_LAB_MATRIX_V1: значение анализатора в боте округлено, как на бланке; ручной ввод — как набран', () => {
  const { db } = seed({ kind: 'plain' });
  const ins = db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, raw_value, source, flag, verified_at) VALUES (4274, ?, ?, ?, ?, 'normal', '2026-11-09T10:00:00Z')");
  ins.run('WBC', '4.152122', null, 'analyzer');      // записано полным (до обновления)
  ins.run('RBC', '4.16', '4.156', 'analyzer');       // округлено прибором, полное — в raw_value
  ins.run('PLT', '4.152122', null, 'manual');        // ручной ввод не трогается
  const val = () => Object.fromEntries(buildDocument(db, 'lab:4274', 7).data.groups[0].tests.map((t) => [t.name, t.value]));
  assert.deepEqual(val(), { WBC: '4.15', RBC: '4.16', PLT: '4.152122' });
  db.prepare('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1').run();
  assert.deepEqual(val(), { WBC: '4.152122', RBC: '4.156', PLT: '4.152122' });
  db.close();
});
