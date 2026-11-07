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
import { exportCatalogue, applyCatalogue, commitCatalogue, TABLES } from './catalogue.js';
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

// ═══ Ревью H2 (проба r4) — «Удалить» в филиале панели главного здания и своя панель на той же
// услуге: следующая синхронизация заводила панель главного заново на прежнюю услугу, UNIQUE
// (мигр. 048) ронял ВЕСЬ приём справочника — цены, сотрудники, права, пароли — при каждом запуске.
const LAB = { id: 2, role: 'lab' };
const MAIN_ONLY = 'Эта панель приходит из главного здания: удалить её или сменить у неё услугу можно только там.';
const asBranch = (db) => db.prepare("UPDATE branch_identity SET role = 'secondary', letter = 'B'").run();

test('H2 (а): в филиале панель главного здания не удаляется и не переносится на другую услугу — 409; коды анализатора правятся', () => {
  const { main, branch, save, sync } = pair();
  save();
  labPanelSave(main, { panel: { name: 'Другая панель главного', modality: 'lab', service_id: null, active: true }, analytes: [{ name: 'А' }] }, LAB);   // выгрузка не пустеет
  sync();
  asBranch(branch);
  const bp = branchPanel(branch);
  assert.throws(() => labPanelDelete(branch, { id: bp.id }, LAB), (e) => e.status === 409 && e.message === MAIN_ONLY);
  branch.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (900, 'Своя услуга филиала', 1, 'lab', 1, 1)").run();
  const args = (service_id) => ({ panel: { id: bp.id, name: PANEL, modality: 'lab', service_id, active: true },
    analytes: NAMES.map((name) => ({ name, value_type: 'numeric', device_code: 'X' + name.length, device_code_confirmed: 1 })) });
  assert.throws(() => labPanelSave(branch, args(900), LAB), (e) => e.status === 409 && e.message === MAIN_ONLY, 'перенос на свою услугу');
  assert.throws(() => labPanelSave(branch, args(null), LAB), (e) => e.status === 409, 'отвязка от услуги');
  assert.equal(branchPanel(branch).service_id, bp.service_id, 'панель на месте');
  assert.equal(labPanelSave(branch, args(bp.service_id), LAB).analytes, NAMES.length, 'своя настройка анализатора на той же услуге — можно');
  // Главная установка (не филиал) удаляет как прежде.
  const mp = main.prepare('SELECT id FROM lab_panels WHERE name = ?').get(PANEL);
  assert.equal(labPanelDelete(main, { id: mp.id }, LAB).deleted, true);
  // Панель, которую главное здание удалило (приём выключил и отвязал её), — уже своя: удаляется.
  sync();
  assert.deepEqual(branch.prepare('SELECT service_id, active FROM lab_panels WHERE id = ?').get(bp.id), { service_id: null, active: 0 });
  assert.equal(labPanelDelete(branch, { id: bp.id }, LAB).deleted, true);
  // Своя панель филиала — как прежде.
  const own = labPanelSave(branch, { panel: { name: 'Своя', modality: 'lab', service_id: 900, active: true }, analytes: [{ name: 'А' }] }, LAB).id;
  assert.equal(labPanelDelete(branch, { id: own }, LAB).deleted, true);
});

test('H2 (б): услугу панели главного держит своя панель филиала — приём справочника проходит, панель — без услуги, экран это называет', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  sync();
  const bp = branchPanel(branch);
  // Состояние, до которого филиал доходил «Удалить» (3.21 до этой правки, или вкладка старой
  // версии): панель главного удалена здесь, своя панель — на той же услуге.
  labPanelDelete(branch, { id: bp.id }, LAB);
  const own = labPanelSave(branch, { panel: { name: 'Мазок (свой)', modality: 'lab', service_id: bp.service_id, active: true }, analytes: [{ name: 'Лейкоциты' }] }, LAB).id;
  main.prepare('UPDATE services SET price = 130 WHERE id = 50').run();   // посторонняя правка главного едет тем же приёмом
  for (let k = 1; k <= 2; k++) {
    const payload = exportCatalogue(main);
    const preview = applyCatalogue(branch, payload, { dryRun: true });
    assert.ok(k === 1 ? preview.changed > 0 : preview.changed === 0, 'холостой прогон ' + k + ': ' + preview.changed);
    // Ревью lab2 L-5 (выпуск 3.22.0) — и без изменений холостой прогон знает, что панель главного
    // всё ещё без услуги: rpc/branch-sync.js отдаёт это экрану и на пути «изменений не было».
    assert.equal(preview.unlinked && preview.unlinked.lab_panels, 1, 'холостой прогон ' + k + ': unlinked');
    const s = commitCatalogue(branch, payload);
    if (k === 1) {
      assert.equal(s.unlinked.lab_panels, 1);
      assert.ok(changesLabel({ ok: true, ...s }).includes('приехало без услуги: лабораторные панели — 1 — услуга уже занята своей панелью этого здания'), changesLabel({ ok: true, ...s }));
    }
  }
  assert.equal(branch.prepare("SELECT price FROM services WHERE name = 'Анализ гинекологического мазка'").get().price, 130, 'цена главного доехала');
  const back = branch.prepare('SELECT * FROM lab_panels WHERE name = ?').get(PANEL);
  assert.ok(back && back.id !== own, 'панель главного заведена снова');
  assert.equal(back.service_id, null, '— без услуги: её держит своя панель филиала');
  assert.deepEqual(perName(branch), ONE_EACH, 'с показателями');
  assert.equal(branch.prepare('SELECT service_id FROM lab_panels WHERE id = ?').get(own).service_id, bp.service_id, 'своя панель филиала не тронута');
  // Своя панель отпустила услугу — следующая синхронизация привязывает панель главного.
  branch.prepare('UPDATE lab_panels SET service_id = NULL WHERE id = ?').run(own);
  const s = sync();
  assert.equal(s.unlinked, undefined);
  assert.equal(branch.prepare('SELECT service_id FROM lab_panels WHERE id = ?').get(back.id).service_id, bp.service_id);
  assert.equal(sync().changed, 0);
  void id;
});

test('H2 (б): главное здание переносит услугу с одной своей панели на другую — приём проходит, со второй синхронизацией всё на месте', () => {
  const { main, branch, save, sync } = pair();
  main.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Мазок (запасная)', 1, 'lab', 1, 1)").run();
  const first = labPanelSave(main, { panel: { name: 'Первая', modality: 'lab', service_id: null, active: true }, analytes: [{ name: 'Лейкоциты' }] }, LAB).id;
  const second = save();   // id больше: на услуге 50
  sync();
  // В главном: услуга 50 — первой панели (меньший id, едет раньше), вторая — на услугу 60.
  main.prepare('UPDATE lab_panels SET service_id = NULL WHERE id = ?').run(second);
  main.prepare('UPDATE lab_panels SET service_id = 50 WHERE id = ?').run(first);
  main.prepare('UPDATE lab_panels SET service_id = 60 WHERE id = ?').run(second);
  const s1 = sync();
  assert.equal(s1.unlinked.lab_panels, 1, 'первая пока без услуги');
  sync();
  const svc = (name) => branch.prepare('SELECT s.name FROM lab_panels p LEFT JOIN services s ON s.id = p.service_id WHERE p.name = ?').get(name).name;
  assert.equal(svc('Первая'), 'Анализ гинекологического мазка');
  assert.equal(svc(PANEL), 'Мазок (запасная)');
  assert.equal(sync().changed, 0);
});

// ═══ Ревью M1 (проба r2) — смешанные версии: главное 3.21 удаляет панель и заводит замену на
// ту же услугу, филиал ещё на 3.20. Приём 3.20 (61679d07) не знал отвязки исчезнувших, удаления
// исчезнувших показателей, занятой услуги и колонки retired_at — здесь он воспроизведён тем же
// applyCatalogue без этих свойств (ревью прогоняло настоящий файл 61679d07 — итог тот же).
function asReceiver320(fn) {
  const saved = TABLES.map((s) => ({ s, copy: { ...s, columns: [...s.columns] } }));
  for (const s of TABLES) {
    delete s.unlinkMissing; delete s.yieldUnique; delete s.pruneMissing; delete s.narrow;
    s.columns = s.columns.filter((c) => c !== 'retired_at');
  }
  try { return fn(); } finally {
    for (const { s, copy } of saved) { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, copy); }
  }
}
const withBranches = (db) => db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B', 'issue')").run();
const replacePanel = (main, id) => {
  const out = labPanelDelete(main, { id }, LAB);
  labPanelSave(main, { panel: { name: 'Мазок (новая)', modality: 'lab', service_id: 50, active: true }, analytes: NAMES.map((name) => ({ name })) }, LAB);
  main.prepare('UPDATE services SET price = 120 WHERE id = 50').run();   // посторонняя правка едет тем же приёмом
  return out;
};

test('M1: главное без филиалов удаляет панель как прежде — приём 3.20 при замене падает (так воспроизведена проба r2)', () => {
  const { main, branch, save } = pair();
  const id = save();
  asReceiver320(() => commitCatalogue(branch, exportCatalogue(main)));
  assert.deepEqual(replacePanel(main, id), { deleted: true, analytes: NAMES.length });
  assert.equal(main.prepare('SELECT COUNT(*) n FROM lab_panels WHERE id = ?').get(id).n, 0, 'стёрта');
  assert.throws(() => asReceiver320(() => commitCatalogue(branch, exportCatalogue(main))), /UNIQUE constraint failed: lab_panels\.service_id/);
});

test('M1: главное с филиалами панель СПИСЫВАЕТ — приём 3.20 принимает замену, цена доезжает; 3.21 — тоже, и прячет списанную', () => {
  for (const receiver of ['3.20', '3.21']) {
    const { main, branch, save } = pair();
    withBranches(main);
    const id = save();
    const apply = () => (receiver === '3.20' ? asReceiver320(() => commitCatalogue(branch, exportCatalogue(main))) : commitCatalogue(branch, exportCatalogue(main)));
    apply();
    const out = replacePanel(main, id);
    assert.deepEqual(out, { deleted: true, retired: true, analytes: 0 }, receiver);
    const retired = main.prepare('SELECT active, service_id, device_id, retired_at FROM lab_panels WHERE id = ?').get(id);
    assert.equal(retired.active, 0); assert.equal(retired.service_id, null); assert.equal(retired.device_id, null);
    assert.match(retired.retired_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(main.prepare('SELECT COUNT(*) n FROM lab_panel_analytes WHERE panel_id = ?').get(id).n, NAMES.length, 'показатели списанной — на месте');
    for (let k = 1; k <= 2; k++) apply();   // ни разу не падает
    assert.equal(branch.prepare("SELECT price FROM services WHERE name = 'Анализ гинекологического мазка'").get().price, 120, receiver + ': цена доехала');
    const svcOf = (name) => branch.prepare('SELECT service_id, active FROM lab_panels WHERE name = ?').get(name);
    assert.ok(svcOf('Мазок (новая)').service_id != null, receiver + ': замена — на услуге');
    assert.deepEqual(svcOf(PANEL), { service_id: null, active: 0 }, receiver + ': прежняя — выключена и отвязана');
    if (receiver === '3.21') {
      assert.ok(branch.prepare('SELECT retired_at FROM lab_panels WHERE name = ?').get(PANEL).retired_at, 'метка списания доехала — экран филиала её прячет');
    }
  }
});

test('M1: списанную панель не оживляет ни вкладка до «Удалить», ни повторное «Удалить»', () => {
  const { main, save } = pair();
  withBranches(main);
  const id = save();
  labPanelDelete(main, { id }, LAB);
  assert.throws(() => labPanelSave(main, { panel: { id, name: PANEL, modality: 'lab', service_id: 50, active: true }, analytes: [{ name: 'А' }] }, LAB), (e) => e.status === 404);
  assert.throws(() => labPanelDelete(main, { id }, LAB), (e) => e.status === 404);
  assert.equal(main.prepare('SELECT service_id FROM lab_panels WHERE id = ?').get(id).service_id, null);
});

// Ревью L7 — панель, которую приём отвязал (главное её удалило), остаётся «панелью главного»
// по мёртвому соответствию: здание снова включало её или привязывало к своей услуге — и каждая
// синхронизация отвязывала её опять. Теперь после отвязки она своя.
test('L7: отвязанная приёмом панель — своя: её можно снова включить и привязать, синхронизация не трогает', () => {
  const { main, branch, save, sync } = pair();
  const id = save();
  labPanelSave(main, { panel: { name: 'Другая панель главного', modality: 'lab', service_id: null, active: true }, analytes: [{ name: 'А' }] }, LAB);   // выгрузка не пустеет
  sync();
  asBranch(branch);
  const bp = branchPanel(branch);
  labPanelDelete(main, { id }, LAB);
  sync();
  assert.deepEqual(branch.prepare('SELECT service_id, active FROM lab_panels WHERE id = ?').get(bp.id), { service_id: null, active: 0 });
  assert.equal(branch.prepare("SELECT COUNT(*) n FROM branch_sync_map WHERE table_name = 'lab_panels' AND local_id = ?").get(bp.id).n, 0, 'соответствие снято');
  labPanelSave(branch, { panel: { id: bp.id, name: PANEL, modality: 'lab', service_id: bp.service_id, active: true },
    analytes: NAMES.map((name) => ({ name, value_type: 'numeric' })) }, LAB);   // своя панель: 409 больше нет
  sync(); sync();
  assert.deepEqual(branch.prepare('SELECT service_id, active FROM lab_panels WHERE id = ?').get(bp.id), { service_id: bp.service_id, active: 1 }, 'синхронизация её не трогает');
  assert.equal(sync().changed, 0);
});
