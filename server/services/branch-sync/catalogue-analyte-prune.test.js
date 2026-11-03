// LAB_PANEL_DEDUP_V1 — приём справочника в филиале больше не копит копии
// показателей лабораторных панелей.
//
// Редактор панелей при каждом сохранении пересоздаёт строки показателей с
// новыми id. Прежде прежняя строка филиала оставалась закреплённой за мёртвым
// id главного здания, новая вставлялась рядом, и каждое пересохранение панели в
// главном здании давало филиалу ещё одну копию каждого показателя. Здесь:
//   • три пересохранения в главном — в филиале по одной строке, те же id и та же
//     своя настройка анализатора филиала (ревью H1: строки усыновляются, не удаляются);
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

// Ревью H1: строки филиала не удаляются и не пересоздаются, а УСЫНОВЛЯЮТСЯ новыми строками
// главного здания — id те же, своя настройка анализатора филиала (не едет) цела.
const branchIds = (db) => db.prepare('SELECT a.id FROM lab_panel_analytes a JOIN lab_panels p ON p.id = a.panel_id WHERE p.name = ? ORDER BY a.id').all(PANEL).map((r) => r.id);

test('главное здание пересохраняет панель трижды — в филиале по одной строке на показатель, id те же', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  sync();
  assert.deepEqual(perName(branch), ONE_EACH);
  const ids = branchIds(branch);
  for (let i = 0; i < 3; i++) {
    save(NAMES, id);
    main.prepare('UPDATE lab_panel_analytes SET ref_low = ? WHERE panel_id = ?').run(i + 1, id);   // пересохранение с правкой — приём состоится
    const s = sync();
    assert.deepEqual(perName(branch), ONE_EACH, 'после пересохранения ' + (i + 1));
    assert.deepEqual(branchIds(branch), ids, 'строки филиала усыновлены, а не пересозданы');
    assert.equal(s.adopted.lab_panel_analytes, NAMES.length, 'новые строки главного усыновили прежние');
    assert.equal(s.created.lab_panel_analytes, undefined, 'ничего не вставлено');
    assert.equal(s.removed, undefined, 'ничего не удалено');
    assert.deepEqual(branch.prepare('SELECT DISTINCT ref_low FROM lab_panel_analytes WHERE id IN (' + ids.join(',') + ')').all().map((r) => r.ref_low), [i + 1], 'правка главного доехала');
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
  assert.ok(changesLabel({ ok: true, ...s }).includes('удалено: показатели — 10'), changesLabel({ ok: true, ...s }));
  assert.ok(!analyteMaps(branch).some((m) => m.remote_id > 90000), 'мёртвые соответствия убраны');
  assert.equal(sync().changed, 0, 'дальше — без изменений');
});

// Ревью H1 (probe r1): у филиала СВОЙ анализатор — коды прибора и их подтверждение
// (device_code, device_code_confirmed, …_device_id, …_epoch) — колонки здания, они не едут.
// Пересохранение панели в главном здании прежде удаляло эти строки вместе с настройкой
// (результаты анализатора филиала молча уходили в лоток). Синхронизация — как rpc/branch-sync.js:
// холостой прогон, затем приём, только если что-то меняется.
for (const seq of ['a', 'b']) {
  test(`пересохранение панели в главном здании не стирает настройку анализатора филиала (r1, последовательность ${seq})`, () => {
    const A = [{ code: 'WBC', name: 'Лейкоциты', value_type: 'numeric' }, { code: 'RBC', name: 'Эритроциты', value_type: 'numeric' }];
    const main = openDb(':memory:'); migrate(main);
    const branch = openDb(':memory:'); migrate(branch);
    try {
      const sync = () => {
        const payload = exportCatalogue(main);
        const preview = applyCatalogue(branch, payload, { dryRun: true });
        return preview.changed ? commitCatalogue(branch, payload) : { changed: 0 };
      };
      main.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'ОАК', 1, 'lab', 1, 1)").run();
      const mainId = labPanelSave(main, { panel: { name: 'ОАК', modality: 'lab', service_id: 50, active: 1 }, analytes: A }, ADMIN).id;
      sync();
      branch.prepare("INSERT INTO lab_devices (id, name, profile, transport, enabled, model_confirmed) VALUES (7, 'BC-20 филиала', 'mindray-bc-20', 'mllp', 1, 1)").run();
      const bp = branch.prepare("SELECT id, service_id FROM lab_panels WHERE name = 'ОАК'").get();
      labPanelSave(branch, { panel: { id: bp.id, name: 'ОАК', modality: 'lab', service_id: bp.service_id, active: 1, device_id: 7 },
        analytes: A.map((a) => ({ ...a, device_code: a.code, device_code_confirmed: 1, device_code_confirmed_device_id: 7, device_code_confirmed_epoch: 0 })) }, ADMIN);
      const rows = () => branch.prepare('SELECT id, name, device_code dc, device_code_confirmed ok, device_code_confirmed_device_id dev FROM lab_panel_analytes WHERE panel_id = ? ORDER BY id').all(bp.id);
      const setUp = rows();
      assert.deepEqual(setUp.map((r) => [r.name, r.dc, r.ok, r.dev]), [['Лейкоциты', 'WBC', 1, 7], ['Эритроциты', 'RBC', 1, 7]]);
      if (seq === 'b') {
        main.prepare('UPDATE services SET price = 2 WHERE id = 50').run();
        sync();
        assert.deepEqual(rows(), setUp, 'посторонняя правка главного');
      }
      for (let k = 1; k <= 2; k++) {
        labPanelSave(main, { panel: { id: mainId, name: 'ОАК', modality: 'lab', service_id: 50, active: 1 }, analytes: A.map((a) => ({ ...a, ref_low: k, ref_high: 9 })) }, ADMIN);
        const s = sync();
        const after = rows();
        assert.deepEqual(after.map((r) => [r.name, r.dc, r.ok, r.dev]), [['Лейкоциты', 'WBC', 1, 7], ['Эритроциты', 'RBC', 1, 7]], 'пересохранение ' + k + ': ' + JSON.stringify(s));
        assert.deepEqual(after.map((r) => r.id), setUp.map((r) => r.id), 'одна строка на показатель, id те же');
        assert.equal(s.removed, undefined);
        assert.deepEqual(branch.prepare('SELECT DISTINCT ref_low FROM lab_panel_analytes WHERE panel_id = ?').all(bp.id).map((r) => r.ref_low), [k], 'правка главного доехала');
      }
    } finally { main.close(); branch.close(); }
  });
}

// Ревью H1 — один показатель в нескольких «Разделах бланка» (мазок U/V/C): усыновляется строка
// своего раздела, а не какая придётся (иначе коды прибора переезжали бы между разделами).
test('мазок U/V/C: пересохранение в главном — каждая строка филиала остаётся своему разделу', () => {
  const { main, branch, sync } = pair();
  const A = ['U', 'V', 'C'].map((g) => ({ name: 'Лейкоциты', group_label: g, value_type: 'text' }));
  const id = labPanelSave(main, { panel: { name: PANEL, modality: 'lab', service_id: 50, active: true }, analytes: A }, ADMIN).id;
  sync();
  const before = branch.prepare('SELECT id, group_label FROM lab_panel_analytes ORDER BY id').all();
  branch.prepare('UPDATE lab_panel_analytes SET device_code = group_label').run();   // своя пометка филиала на каждой строке
  labPanelSave(main, { panel: { id, name: PANEL, modality: 'lab', service_id: 50, active: true }, analytes: [...A].reverse().map((a) => ({ ...a, unit: 'в п/зр' })) }, ADMIN);
  const s = sync();
  const after = branch.prepare('SELECT id, group_label, device_code, unit FROM lab_panel_analytes ORDER BY id').all();
  assert.deepEqual(after.map((r) => [r.id, r.group_label, r.device_code, r.unit]), before.map((r) => [r.id, r.group_label, r.group_label, 'в п/зр']), JSON.stringify(s));
  assert.equal(s.adopted.lab_panel_analytes, 3);
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
