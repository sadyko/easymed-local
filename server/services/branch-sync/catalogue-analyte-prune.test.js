// LAB_PANEL_DEDUP_V1 — приём справочника в филиале больше не копит копии
// показателей лабораторных панелей.
//
// Редактор панелей при каждом сохранении пересоздаёт строки показателей с
// новыми id. Прежде прежняя строка филиала оставалась закреплённой за мёртвым
// id главного здания, новая вставлялась рядом, и каждое пересохранение панели в
// главном здании давало филиалу ещё одну копию каждого показателя. Здесь:
//   • три пересохранения в главном — в филиале по одной строке;
//   • копии, накопленные прежним приёмом, уходят со следующей синхронизацией;
//   • показатель, удалённый в главном, удаляется и в филиале;
//   • свой показатель филиала и своя панель филиала — остаются;
//   • выгрузка без показателей ничего не удаляет; холостой прогон — тоже, но
//     считает (иначе приём, где меняется только это, не случился бы);
//   • панель удалена в главном и заведена новая на ту же услугу — приём
//     проходит (одна услуга — одна панель), старая панель филиала отвязана;
//   • экран синхронизации называет удалённое.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { exportCatalogue, applyCatalogue, commitCatalogue } from './catalogue.js';
import { labPanelSave, labPanelDelete } from '../rpc/lab-panels.js';
import { changesLabel } from '../../../public/js/admin/branch-sync-logic.js';

const NAMES = ['Лейкоциты', 'Эпит. клетки', 'Микрофлора', 'Гонококки', 'Трихомонады'];
const ADMIN = { id: 1, role: 'admin' };
const PANEL = 'Анализ гинекологического мазка';

function pair() {
  const main = openDb(':memory:'); migrate(main);
  const branch = openDb(':memory:'); migrate(branch);
  main.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 50000, 'lab', 1, 1)").run();
  const save = (names = NAMES, id = null, extra = {}) => labPanelSave(main, {
    panel: { id, name: PANEL, modality: 'lab', service_id: 50, active: true, ...extra },
    analytes: names.map((name) => ({ name, value_type: 'numeric' })),
  }, ADMIN).id;
  const sync = () => commitCatalogue(branch, exportCatalogue(main));
  return { main, branch, save, sync };
}
const perName = (db, panelName = PANEL) => {
  const by = {};
  for (const r of db.prepare('SELECT a.name FROM lab_panel_analytes a JOIN lab_panels p ON p.id = a.panel_id WHERE p.name = ?').all(panelName)) by[r.name] = (by[r.name] || 0) + 1;
  return by;
};
const ONE_EACH = Object.fromEntries(NAMES.map((n) => [n, 1]));
const branchPanel = (db) => db.prepare('SELECT * FROM lab_panels WHERE name = ?').get(PANEL);
const analyteMaps = (db) => db.prepare("SELECT remote_id, local_id FROM branch_sync_map WHERE table_name = 'lab_panel_analytes' ORDER BY remote_id").all();

test('главное здание пересохраняет панель трижды — в филиале по одной строке на показатель', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  sync();
  assert.deepEqual(perName(branch), ONE_EACH);
  for (let i = 0; i < 3; i++) {
    save(NAMES, id);
    const s = sync();
    assert.deepEqual(perName(branch), ONE_EACH, 'после пересохранения ' + (i + 1));
    assert.equal(s.removed.lab_panel_analytes, NAMES.length, 'прежние строки названы удалёнными');
    assert.ok(changesLabel({ ok: true, ...s }).includes('удалено: показатели — 5'), changesLabel({ ok: true, ...s }));
  }
  // Соответствия — только на живые строки главного здания и на живые свои.
  const liveRemote = new Set(main.prepare('SELECT id FROM lab_panel_analytes').all().map((r) => r.id));
  const liveLocal = new Set(branch.prepare('SELECT id FROM lab_panel_analytes').all().map((r) => r.id));
  assert.ok(analyteMaps(branch).every((m) => liveRemote.has(m.remote_id) && liveLocal.has(m.local_id)), JSON.stringify(analyteMaps(branch)));
  assert.equal(analyteMaps(branch).length, NAMES.length);
});

test('копии, накопленные прежним приёмом, уходят со следующей синхронизацией', () => {
  const { branch, save, sync } = pair();
  save();
  sync();
  // Состояние филиала до исправления: ещё две копии, закреплённые за мёртвыми id главного.
  const p = branchPanel(branch);
  const ins = branch.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (?, ?, 'numeric', ?)");
  const map = branch.prepare("INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES ('lab_panel_analytes', ?, ?)");
  let dead = 90000;
  for (let c = 0; c < 2; c++) NAMES.forEach((n, i) => map.run(++dead, Number(ins.run(p.id, n, i).lastInsertRowid)));
  assert.equal(Object.values(perName(branch)).reduce((a, b) => a + b, 0), 15);
  const s = sync();
  assert.deepEqual(perName(branch), ONE_EACH);
  assert.equal(s.removed.lab_panel_analytes, 10);
  assert.ok(!analyteMaps(branch).some((m) => m.remote_id > 90000), 'мёртвые соответствия убраны');
  assert.equal(sync().changed, 0, 'дальше — без изменений');
});

test('показатель, удалённый в главном, удаляется в филиале; свой показатель и своя панель филиала остаются', () => {
  const { branch, save, sync } = pair();
  const id = save();
  sync();
  const p = branchPanel(branch);
  branch.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (?, 'Свой показатель филиала', 'numeric', 9)").run(p.id);
  const own = Number(branch.prepare("INSERT INTO lab_panels (name, modality, active) VALUES ('Своя панель филиала', 'lab', 1)").run().lastInsertRowid);
  branch.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (?, 'Лейкоциты', 'numeric', 0)").run(own);
  save(NAMES.filter((n) => n !== 'Трихомонады'), id);
  sync();
  const left = perName(branch);
  assert.equal(left['Трихомонады'], undefined, 'удалённый в главном — удалён');
  assert.equal(left['Свой показатель филиала'], 1, 'свой показатель филиала в панели главного — на месте');
  assert.deepEqual(perName(branch, 'Своя панель филиала'), { 'Лейкоциты': 1 }, 'своя панель филиала не тронута');
});

test('выгрузка без показателей (старая главная, филиал) ничего не удаляет', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  sync();
  save(NAMES, id);
  const payload = exportCatalogue(main);
  for (const variant of [{ ...payload, lab_panel_analytes: [] }, (() => { const p = { ...payload }; delete p.lab_panel_analytes; return p; })()]) {
    const s = branch.transaction(() => applyCatalogue(branch, variant))();
    assert.equal(s.removed, undefined);
    assert.deepEqual(perName(branch), ONE_EACH);
  }
});

test('холостой прогон ничего не меняет, но считает удаление изменением', () => {
  const { main, branch, save, sync } = pair();
  save();
  sync();
  const p = branchPanel(branch);
  const ins = branch.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (?, ?, 'numeric', ?)");
  const map = branch.prepare("INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES ('lab_panel_analytes', ?, ?)");
  NAMES.forEach((n, i) => map.run(91000 + i, Number(ins.run(p.id, n, i).lastInsertRowid)));
  const before = { rows: branch.prepare('SELECT * FROM lab_panel_analytes ORDER BY id').all(), map: branch.prepare('SELECT * FROM branch_sync_map ORDER BY table_name, remote_id').all() };
  const preview = applyCatalogue(branch, exportCatalogue(main), { dryRun: true });
  assert.ok(preview.changed >= NAMES.length, 'приём, где меняется только это, не пропускается: ' + preview.changed);
  assert.equal(preview.removed.lab_panel_analytes, NAMES.length);
  assert.deepEqual({ rows: branch.prepare('SELECT * FROM lab_panel_analytes ORDER BY id').all(), map: branch.prepare('SELECT * FROM branch_sync_map ORDER BY table_name, remote_id').all() }, before);
});

test('панель удалена в главном и заведена новая на ту же услугу — приём проходит, старая панель филиала отвязана', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  sync();
  const old = branchPanel(branch);
  labPanelDelete(main, { id }, ADMIN);
  labPanelSave(main, { panel: { name: 'Мазок (новая)', modality: 'lab', service_id: 50, active: true }, analytes: NAMES.map((name) => ({ name })) }, ADMIN);
  const s = sync();
  assert.equal(s.deactivated.lab_panels, 1);
  const fresh = branch.prepare("SELECT * FROM lab_panels WHERE name = 'Мазок (новая)'").get();
  const localSvc = branch.prepare("SELECT id FROM services WHERE name = 'Анализ гинекологического мазка'").get().id;
  assert.equal(fresh.service_id, localSvc, 'новая панель главного — на той же услуге');
  assert.deepEqual(perName(branch, 'Мазок (новая)'), ONE_EACH);
  const was = branch.prepare('SELECT service_id, active FROM lab_panels WHERE id = ?').get(old.id);
  assert.deepEqual(was, { service_id: null, active: 0 }, 'прежняя панель филиала отвязана и выключена');
  assert.deepEqual(perName(branch), ONE_EACH, 'её показатели целы');
  assert.equal(sync().changed, 0, 'дальше — без изменений');
});
