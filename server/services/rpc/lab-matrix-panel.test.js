// LAB_MATRIX_PANEL_V1 (решение владельца 2026-11-07, п. 7) — панель-таблица
// бактериального посева: устройство таблицы сохраняется прежним атомарным
// lab_panel_save, показатели панели — ячейки «строка · графа» раздела со шкалой
// степеней; результаты — обычные строки lab_results; бланк собирает таблицу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { labPanelSave } from './lab-panels.js';
import { saveLabResults } from './lab.js';
import { normalizeMatrix, matrixAnalytes, matrixGrid, panelMatrix, cellName, DEFAULT_SCALE } from '../../../public/js/shared/lab-matrix.js';

const LAB = { id: 2, role: 'lab' };
const MATRIX = {
  scale: '−, +, ++, +++, ++++',
  sections: [
    { title: 'Определяемые микроорганизмы', columns: ['Положительный', 'Отрицательный'], rows: ['E. coli', 'S. aureus'] },
    { title: 'Антибиограмма', columns: 'Резистентный, Чувствительный', rows: ['Ампициллин', 'Цефтриаксон', 'Ципрофлоксацин'] },
  ],
};
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Бак. посев мочи', 90000, 'lab', 1, 1);
           INSERT INTO services (id, name, price, type, is_lab, active) VALUES (61, 'ОАК', 30000, 'lab', 1, 1);`);
  return db;
}
const panelArgs = (extra = {}) => ({ name: 'Бак. посев мочи', modality: 'lab', has_narrative: false, service_id: '60', active: true, device_id: null, kind: 'matrix', matrix: MATRIX, ...extra });
const analytesOf = (db, id) => db.prepare('SELECT name, group_label, value_type, value_options FROM lab_panel_analytes WHERE panel_id = ? ORDER BY sort_order').all(id);

test('normalizeMatrix: шкала по умолчанию, графы 1–3, разделы и строки — без пустых и повторов', () => {
  const ok = normalizeMatrix({ sections: [{ title: ' Посев ', columns: ['Рост'], rows: ['E. coli', ' '] }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.matrix, { scale: [...DEFAULT_SCALE], sections: [{ title: 'Посев', columns: ['Рост'], rows: ['E. coli'] }] });
  for (const [m, re] of [
    [{ sections: [] }, /пуста/],
    [{ sections: [{ title: 'А', columns: ['1', '2', '3', '4'], rows: ['x'] }] }, /от 1 до {n} граф/],
    [{ sections: [{ title: 'А', columns: ['1'], rows: [] }] }, /нет ни одной строки/],
    [{ sections: [{ title: 'А', columns: ['1'], rows: ['x', 'x'] }] }, /дважды/],
    [{ sections: [{ title: 'А', columns: ['1'], rows: ['x'] }, { title: 'А', columns: ['2'], rows: ['y'] }] }, /Раздел «\{name\}» записан дважды/],
    [{ sections: [{ title: 'А', columns: ['Рост'], rows: ['x'] }, { title: 'Б', columns: ['Рост'], rows: ['x'] }] }, /уже есть в разделе/],
    [{ sections: [{ columns: ['1'], rows: ['x'] }] }, /нет названия/],
  ]) {
    const r = normalizeMatrix(m);
    assert.equal(r.ok, false, JSON.stringify(m));
    assert.match(r.error.text, re);
  }
});

test('lab_panel_save: панель-таблица — kind и matrix_json; показатели — ячейки раздела со шкалой степеней', () => {
  const db = fresh();
  const { id, analytes } = labPanelSave(db, { panel: panelArgs(), analytes: [{ name: 'присланное браузером не читается' }] }, LAB);
  const p = db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE id = ?').get(id);
  assert.equal(p.kind, 'matrix');
  assert.deepEqual(JSON.parse(p.matrix_json).sections[1].columns, ['Резистентный', 'Чувствительный']);
  assert.equal(analytes, 2 * 2 + 3 * 2);
  const rows = analytesOf(db, id);
  assert.deepEqual(rows[0], { name: 'E. coli · Положительный', group_label: 'Определяемые микроорганизмы', value_type: 'select', value_options: '−, +, ++, +++, ++++' });
  assert.deepEqual(rows.map((r) => r.name).slice(4, 6), ['Ампициллин · Резистентный', 'Ампициллин · Чувствительный']);
  // Правка: строку убрали, добавили другую — показатели пересобраны одной транзакцией, без копий.
  const m2 = { ...MATRIX, sections: [MATRIX.sections[0], { ...MATRIX.sections[1], rows: ['Цефтриаксон', 'Меропенем'] }] };
  labPanelSave(db, { panel: panelArgs({ id, matrix: m2 }) }, LAB);
  assert.deepEqual(analytesOf(db, id).map((r) => r.name).slice(4), ['Цефтриаксон · Резистентный', 'Цефтриаксон · Чувствительный', 'Меропенем · Резистентный', 'Меропенем · Чувствительный']);
  db.close();
});

test('lab_panel_save: таблица с ошибкой — 400 словами, панель не сохранена; обычная панель — как прежде (kind пусто)', () => {
  const db = fresh();
  assert.throws(() => labPanelSave(db, { panel: panelArgs({ matrix: { sections: [{ title: 'А', columns: ['1', '2', '3', '4'], rows: ['x'] }] } }) }, LAB),
    (e) => e.status === 400 && /от 1 до 3 граф/.test(e.message), 'шаблон с подставленным числом');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_panels').get().c, 0);
  const { id } = labPanelSave(db, { panel: { ...panelArgs({ service_id: '61', name: 'ОАК' }), kind: '' },
    analytes: [{ name: 'Лейкоциты', value_type: 'numeric', decimals: 1 }] }, LAB);
  assert.deepEqual({ ...db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE id = ?').get(id) }, { kind: '', matrix_json: null });
  db.close();
});

test('значения ячеек — обычные строки lab_results (save_lab_results); бланк собирает из них таблицу', () => {
  const db = fresh();
  const { id } = labPanelSave(db, { panel: panelArgs() }, LAB);
  db.exec(`INSERT INTO patients (id, full_name) VALUES (7, 'Т'); INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, '2026-11-07', 'scheduled');
           INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (100, 20, 60, 'in_progress');`);
  saveLabResults(db, { visit_service_id: 100, rows: [
    { parameter: cellName('E. coli', 'Положительный'), value: '+++', flag: 'abnormal' },
    { parameter: cellName('Ампициллин', 'Резистентный'), value: '++', flag: 'abnormal' },
    { parameter: cellName('Цефтриаксон', 'Чувствительный'), value: '+', flag: 'normal' },
  ] }, { role: 'lab' });
  const matrix = panelMatrix(db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE id = ?').get(id));
  const grid = matrixGrid(matrix, db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = 100').all());
  assert.equal(grid.filled, 3);
  assert.deepEqual(grid.sections[0].rows, [{ name: 'E. coli', cells: ['+++', ''] }, { name: 'S. aureus', cells: ['', ''] }]);
  assert.deepEqual(grid.sections[1].rows.map((r) => r.cells), [['++', ''], ['', '+'], ['', '']]);
  assert.equal(panelMatrix({ kind: '', matrix_json: null }), null, 'обычная панель — не таблица');
  assert.equal(matrixAnalytes(matrix).length, 10);
  db.close();
});

// TG_LAB_MATRIX_V1 (3.23.0) — общая часть группы бланка: одна на лабораторию, карту,
// «Документы», бот в Telegram и историю болезни.
test('matrixGroupPart: панель-таблица — { matrix } из результатов; обычная, испорченная, без панели — {}', async () => {
  const { matrixGroupPart } = await import('../../../public/js/shared/lab-matrix.js');
  const panel = { kind: 'matrix', matrix_json: JSON.stringify(MATRIX) };
  const results = [{ parameter: cellName('E. coli', 'Положительный'), value: '+++' }, { parameter: cellName('E. coli', 'Положительный'), value: '' }];
  const part = matrixGroupPart(panel, results);
  assert.deepEqual(Object.keys(part), ['matrix']);
  assert.deepEqual(part.matrix, matrixGrid(panelMatrix(panel), results), 'не та таблица, что у бланка лаборатории');
  assert.deepEqual(part.matrix.sections[0].rows[0], { name: 'E. coli', cells: ['', ''] }, 'снятая степень (последняя запись) — пустая клетка');
  assert.deepEqual({ group: 1, ...matrixGroupPart({ kind: '', matrix_json: null }, results) }, { group: 1 });
  assert.deepEqual(matrixGroupPart({ kind: 'matrix', matrix_json: '{испорчено' }, results), {});
  assert.deepEqual(matrixGroupPart(null, results), {});
  assert.deepEqual(matrixGroupPart(undefined, []), {});
});
