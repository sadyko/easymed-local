// LAB_MATRIX_PANEL_V1 (решение владельца 2026-11-07, п. 7) — панель-таблица бак.
// посева на настоящем экране и сервере (lab-real-app-harness.mjs):
//   • «Панели»: вид «Таблица (бак. посев)», разделы, графы, строки (добавить, поднять,
//     убрать) — «Сохранить панель» пишет таблицу прежним атомарным lab_panel_save;
//   • «Внести результаты»: сетка — раздел, его графы, степень в ячейке; «Сохранить
//     всё» пишет ячейки строками lab_results;
//   • «Бланк»: таблица посева — строка-заголовок раздела, графы, «+» по центру.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, toasts, printed, startApp, settle, tick, walk, textOf, byClass, byTag, buttonByText } from './lab-real-app-harness.mjs';

const { setFullAccess } = await import('../permissions.js');
const { mountLabPanels } = await import('../views/lab-panels.js');
const { renderLaboratory } = await import('../views/laboratory.js');
const { matrixEditor, editorMatrix, matrixPayload } = await import('../views/lab-matrix-editor.js');
const { buildSheetHtml } = await import('../../shared/doc-render.js');
setFullAccess(true);

const MATRIX = {
  scale: ['−', '+', '++', '+++', '++++'],
  sections: [
    { title: 'Определяемые микроорганизмы', columns: ['Положительный', 'Отрицательный'], rows: ['E. coli', 'S. aureus'] },
    { title: 'Антибиограмма', columns: ['Резистентный', 'Чувствительный'], rows: ['Ампициллин', 'Цефтриаксон'] },
  ],
};
const input = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input', target: el, currentTarget: el }); };
const change = (el, v) => { el.value = v; el.dispatchEvent({ type: 'change', target: el, currentTarget: el }); };
const attr = (root, name, value) => walk(root).find((n) => n.getAttribute && n.getAttribute(name) === value);

test('конструктор: состояние из сохранённой таблицы; строку добавить, поднять, убрать; в сервер — без пустых', () => {
  const m = editorMatrix({ kind: 'matrix', matrix_json: JSON.stringify(MATRIX) });
  assert.equal(m.scale, '−, +, ++, +++, ++++');
  assert.deepEqual(m.sections[0].columns, ['Положительный', 'Отрицательный', '']);
  const el = matrixEditor(m);
  buttonByText(el, 'Добавить строку').click();
  input(attr(el, 'data-matrix-row', '0:2'), 'Candida');
  walk(el).filter((n) => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Поднять строку')[2].click();
  assert.deepEqual(m.sections[0].rows, ['E. coli', 'Candida', 'S. aureus']);
  walk(el).filter((n) => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Убрать строку')[0].click();
  assert.deepEqual(m.sections[0].rows, ['Candida', 'S. aureus']);
  buttonByText(el, 'Добавить раздел').click();
  assert.equal(m.sections.length, 3);
  const out = matrixPayload(m);
  assert.deepEqual(out.sections[0].columns, ['Положительный', 'Отрицательный']);
  assert.deepEqual(out.sections[2], { title: '', columns: [], rows: [] }, 'пустой раздел сервер не сохранит (normalizeMatrix пропускает)');
  assert.deepEqual(editorMatrix({ kind: '' }).sections.length, 1, 'новая таблица — с одним пустым разделом');
});

function seedPanels(db) {
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Бак. посев мочи', 90000, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (960, 'Бак. посев мочи', 60, 'lab', 1)").run();
}

test('«Панели»: вид «Таблица (бак. посев)» — конструктор вместо показателей; «Сохранить панель» пишет таблицу', async (t) => {
  const app = await startApp(seedPanels);
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { root.remove(); app.close(); });
  await mountLabPanels(root);
  await settle(8);
  const item = walk(root).find((n) => (n.tagName === 'BUTTON' || n.tagName === 'DIV' || n.tagName === 'A') && textOf(n).trim().startsWith('Бак. посев мочи') && n._l && n._l.click);
  if (item) { item.click(); await settle(8); }
  const kind = attr(root, 'data-panel-kind', '');
  assert.ok(kind, 'нет выбора вида панели');
  change(kind, 'matrix');
  await settle(4);
  assert.ok(attr(root, 'data-matrix-editor', ''), 'конструктор таблицы не показан');
  input(attr(root, 'data-matrix-title', '0'), 'Определяемые микроорганизмы');
  input(attr(root, 'data-matrix-col', '0:0'), 'Положительный');
  input(attr(root, 'data-matrix-col', '0:1'), 'Отрицательный');
  input(attr(root, 'data-matrix-row', '0:0'), 'E. coli');
  toasts.length = 0;
  buttonByText(root, 'Сохранить панель').click();
  await settle(16);
  assert.ok(toasts.includes('Панель сохранена'), JSON.stringify(toasts));
  const p = app.db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE id = 960').get();
  assert.equal(p.kind, 'matrix');
  assert.deepEqual(JSON.parse(p.matrix_json).sections, [{ title: 'Определяемые микроорганизмы', columns: ['Положительный', 'Отрицательный'], rows: ['E. coli'] }]);
  assert.deepEqual(app.db.prepare('SELECT name FROM lab_panel_analytes WHERE panel_id = 960 ORDER BY sort_order').all().map((r) => r.name),
    ['E. coli · Положительный', 'E. coli · Отрицательный']);
});

function seedVisit(db) {
  db.prepare("INSERT INTO patients (id, full_name, mrn, gender, date_of_birth) VALUES (77, 'Тест Пациент', 'T-1', 'female', '1990-01-01')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Бак. посев мочи', 90000, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active, kind, matrix_json) VALUES (960, 'Бак. посев мочи', 60, 'lab', 1, 'matrix', ?)").run(JSON.stringify(MATRIX));
  const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, group_label, value_type, value_options, sort_order) VALUES (960, ?, ?, 'select', '−, +, ++, +++, ++++', ?)");
  let i = 0;
  for (const s of MATRIX.sections) for (const r of s.rows) for (const c of s.columns) a.run(r + ' · ' + c, s.title, i++);
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status, sample_collected_at) VALUES (3001, 10, 60, 'collected', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
}

test('«Внести результаты»: сетка разделов со степенями; «Сохранить всё» пишет ячейки; «Бланк» — таблица посева', async (t) => {
  const app = await startApp(seedVisit);
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { for (const m of byClass(body, 'modal')) m.remove(); root.remove(); app.close(); });
  await renderLaboratory(root, { tabId: 't-1' });
  await settle(16);
  buttonByText(root, 'Внести результаты').click();
  await settle(16);
  const modal = byClass(body, 'modal').pop();
  assert.ok(modal && attr(modal, 'data-matrix-section', ''), 'лист — не сеткой');
  const cells = walk(modal).filter((n) => n.tagName === 'SELECT' && n.getAttribute('data-matrix-cell'));
  assert.equal(cells.length, 8, 'по ячейке на строку и графу каждого раздела');
  assert.deepEqual(byTag(modal, 'th').map((th) => textOf(th).trim()).slice(0, 3), ['Определяемые микроорганизмы', 'Положительный', 'Отрицательный']);
  change(cells.find((c) => c.getAttribute('data-matrix-cell') === 'E. coli · Положительный'), '+++');
  change(cells.find((c) => c.getAttribute('data-matrix-cell') === 'Ампициллин · Резистентный'), '++');
  toasts.length = 0;
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
  assert.deepEqual(app.db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = 3001 ORDER BY id').all().map((r) => [r.parameter, r.value]),
    [['E. coli · Положительный', '+++'], ['Ампициллин · Резистентный', '++']]);

  printed.length = 0;
  buttonByText(root, 'Бланк').click();
  await settle(24);
  const html = printed[printed.length - 1] || '';
  assert.match(html, /<table class="res mx">/);
  assert.match(html, /<tr class="mx-sec"><th colspan="3">Антибиограмма<\/th><\/tr>/);
  assert.match(html, /<td class="pname">E\. coli<\/td><td class="c mx-v">\+\+\+<\/td><td class="c mx-v"><\/td>/);
});

test('бланк без таблицы — как прежде; разделы с разным числом граф выравниваются пустыми ячейками', () => {
  const html = buildSheetHtml({ type: 'lab', s: { clinicName: 'К', accent: '#0f766e' }, data: { patientName: 'Т', groups: [{
    title: 'Посев', tests: [], matrix: { scale: ['+'], sections: [
      { title: 'А', columns: ['1', '2'], rows: [{ name: 'x', cells: ['+', ''] }] },
      { title: 'Б', columns: ['Рост'], rows: [{ name: 'y', cells: ['++'] }] },
    ] } }] } });
  assert.match(html, /<td class="pname">y<\/td><td class="c mx-v">\+\+<\/td><td><\/td>/);
});

// Ревью S3, H-1 — степень в ячейке можно СНЯТЬ. Лаборатория внесла «Ампициллин ·
// Резистентный = ++», увидела ошибку, очистила ячейку и поставила «Чувствительный
// = ++». «Сохранить всё» пропускал пустые ячейки, старое «++» оставалось в базе, и
// бланк печатал «++» в ОБЕИХ графах — противоречивая антибиограмма на руках у пациента.
test('ревью H-1: очищенная ячейка таблицы сохраняется пустой — бланк печатает отметку только в новой графе', async (t) => {
  const app = await startApp(seedVisit);
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { for (const m of byClass(body, 'modal')) m.remove(); root.remove(); app.close(); });
  await renderLaboratory(root, { tabId: 't-1' });
  await settle(16);
  const open = async () => { buttonByText(root, 'Внести результаты').click(); await settle(16); return byClass(body, 'modal').pop(); };
  const cell = (m, name) => walk(m).find((n) => n.tagName === 'SELECT' && n.getAttribute('data-matrix-cell') === name);
  let modal = await open();
  change(cell(modal, 'Ампициллин · Резистентный'), '++');
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
  modal = await open();
  assert.equal(cell(modal, 'Ампициллин · Резистентный').value, '++', 'сохранённая степень видна в сетке');
  change(cell(modal, 'Ампициллин · Резистентный'), '');
  change(cell(modal, 'Ампициллин · Чувствительный'), '++');
  toasts.length = 0;
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
  assert.ok(toasts.some((x) => x.includes('Результаты сохранены')), JSON.stringify(toasts));
  const rows = app.db.prepare("SELECT parameter, value FROM lab_results WHERE visit_service_id = 3001 AND TRIM(COALESCE(value, '')) <> '' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.parameter, r.value]), [['Ампициллин · Чувствительный', '++']], 'снятая степень осталась в базе');
  printed.length = 0;
  buttonByText(root, 'Бланк').click();
  await settle(24);
  const html = printed[printed.length - 1] || '';
  assert.match(html, /<td class="pname">Ампициллин<\/td><td class="c mx-v"><\/td><td class="c mx-v">\+\+<\/td>/);

  // Снять ВСЕ отметки и сохранить — тоже правка, а не «добавьте хотя бы один результат».
  modal = await open();
  change(cell(modal, 'Ампициллин · Чувствительный'), '');
  toasts.length = 0;
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 3001 AND TRIM(COALESCE(value, '')) <> ''").get().c, 0);
});

test('ревью H-1: пустая ячейка, у которой не было значения, не пишется (строк-пустышек нет)', async (t) => {
  const app = await startApp(seedVisit);
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { for (const m of byClass(body, 'modal')) m.remove(); root.remove(); app.close(); });
  await renderLaboratory(root, { tabId: 't-1' });
  await settle(16);
  buttonByText(root, 'Внести результаты').click();
  await settle(16);
  const modal = byClass(body, 'modal').pop();
  change(walk(modal).find((n) => n.tagName === 'SELECT' && n.getAttribute('data-matrix-cell') === 'E. coli · Положительный'), '+');
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
  assert.deepEqual(app.db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = 3001').all().map((r) => [r.parameter, r.value]),
    [['E. coli · Положительный', '+']]);
});
