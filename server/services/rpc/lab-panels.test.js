// LAB_PANEL_DEDUP_V1 — панель лаборатории одним вызовом (rpc/lab-panels.js).
//
// Клиника: каждый показатель панели мазка лежал в базе трижды. Три
// сохранения через /api/db, шедшие одновременно, читали один список прежних
// строк и удаляли только его — строки всех трёх оставались. Здесь — то, что
// держит новый путь:
//   • сохранения подряд и одновременно (три запроса разом) — одна копия;
//   • ошибка вставки — прежние показатели и шапка панели целы (откат);
//   • два показателя с одним разделом и именем — отказ ru-фразой с шаблоном;
//   • «Удалить» убирает панель с показателями, результаты анализов целы;
//   • права — как у записи этих таблиц через /api/db, услуга одна на панель;
//   • вставка раньше удаления: отметка «подтверждено для прибора» (триггер
//     мигр. 233) наследуется от прежней строки, как и раньше;
//   • это запись: в READ_ONLY_RPCS и ALWAYS_ALLOWED её нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc } from '../control/gate.js';
import { RPC } from './index.js';
import { labPanelSave, labPanelDelete } from './lab-panels.js';

const NAMES = ['Лейкоциты', 'Эпит. клетки', 'Микрофлора', 'Гонококки', 'Трихомонады'];
const LAB = { id: 2, role: 'lab' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 50000, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (51, 'Фибриноген', 30000, 'lab', 1, 1)").run();
  return db;
}
const rowsOf = (db, panelId) => db.prepare('SELECT id, name, group_label, sort_order FROM lab_panel_analytes WHERE panel_id = ? ORDER BY sort_order, id').all(panelId);
const perName = (db) => {
  const by = {};
  for (const r of db.prepare('SELECT name FROM lab_panel_analytes').all()) by[r.name] = (by[r.name] || 0) + 1;
  return by;
};
const ONE_EACH = Object.fromEntries(NAMES.map((n) => [n, 1]));
const panelArgs = (extra = {}) => ({ name: 'Анализ гинекологического мазка', modality: 'lab', has_narrative: false, service_id: '50', active: true, device_id: null, ...extra });
const analytes = (names = NAMES) => names.map((name) => ({ name, unit: null, value_type: 'numeric', decimals: 0, group_label: null, device_code: '', device_code_confirmed: 0 }));

test('новая панель и три пересохранения — по одной строке на показатель, новые id, порядок 0..N-1', () => {
  const db = fresh();
  const first = labPanelSave(db, { panel: panelArgs(), analytes: analytes() }, LAB);
  assert.equal(first.analytes, NAMES.length);
  const p = db.prepare('SELECT * FROM lab_panels WHERE id = ?').get(first.id);
  assert.equal(p.service_id, 50, 'id услуги из строки выбора — числом');
  assert.equal(p.has_narrative, 0);
  assert.equal(p.active, 1);
  let before = rowsOf(db, first.id).map((r) => r.id);
  for (let i = 0; i < 3; i++) {
    const again = labPanelSave(db, { panel: panelArgs({ id: first.id }), analytes: analytes() }, LAB);
    assert.equal(again.id, first.id);
    const now = rowsOf(db, first.id);
    assert.deepEqual(now.map((r) => r.name), NAMES);
    assert.deepEqual(now.map((r) => r.sort_order), [0, 1, 2, 3, 4]);
    assert.ok(now.every((r) => !before.includes(r.id)), 'строки пересозданы, прежних не осталось');
    before = now.map((r) => r.id);
  }
  assert.deepEqual(perName(db), ONE_EACH);
});

test('три «Сохранить панель» разом (сервер отвечает по одному) — одна копия, каждое ответило «сохранено»', async (t) => {
  const db = fresh();
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2, ?, ?, ?, ?)').run('lab', hashPassword('password1'), 'Лаборант', 'lab');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lab', password: 'password1' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (name, body) => fetch(base + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

  const created = await call('lab_panel_save', { panel: panelArgs(), analytes: analytes() });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.data.id;
  const all = await Promise.all([1, 2, 3].map(() => call('lab_panel_save', { panel: panelArgs({ id }), analytes: analytes() })));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
  assert.deepEqual(perName(db), ONE_EACH, 'одна копия после трёх одновременных сохранений');

  // Одна услуга — одна панель: вторая панель на ту же услугу — 409 с именем
  // ограничения (экран называет по нему панель-владельца, savePanelReason).
  const twin = await call('lab_panel_save', { panel: panelArgs({ name: 'Мазок (новая)' }), analytes: analytes() });
  assert.equal(twin.status, 409);
  assert.match(twin.json.error.message, /lab_panels\.service_id/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 1, 'отказ — ничего не записано');

  // «Удалить» через ту же дверь, затем новая панель на ту же услугу проходит.
  const del = await call('lab_panel_delete', { id });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const again = await call('lab_panel_save', { panel: panelArgs({ name: 'Мазок (новая)' }), analytes: analytes() });
  assert.equal(again.status, 200, JSON.stringify(again.json));
});

test('ошибка вставки показателя — откат: прежние строки, нормы и шапка панели целы', () => {
  const db = fresh();
  const { id } = labPanelSave(db, { panel: panelArgs(), analytes: analytes().map((a, i) => ({ ...a, ref_low: i, ref_high: i + 10 })) }, LAB);
  const before = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? ORDER BY id').all(id);
  db.exec("CREATE TRIGGER t_boom BEFORE INSERT ON lab_panel_analytes WHEN NEW.name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  assert.throws(() => labPanelSave(db, { panel: panelArgs({ id, name: 'Переименовано' }), analytes: analytes(['Лейкоциты', 'BOOM']) }, LAB), /boom/);
  assert.deepEqual(db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? ORDER BY id').all(id), before);
  assert.equal(db.prepare('SELECT name FROM lab_panels WHERE id = ?').get(id).name, 'Анализ гинекологического мазка');
});

test('один раздел и одно имя дважды — отказ с шаблоном; то же имя в другом разделе — можно', () => {
  const db = fresh();
  const dup = [...analytes(['Лейкоциты', 'Эпит. клетки']), { name: '  Лейкоциты ', group_label: null }];
  let err = null;
  try { labPanelSave(db, { panel: panelArgs(), analytes: dup }, LAB); } catch (e) { err = e; }
  assert.ok(err, 'отказ');
  assert.equal(err.status, 400);
  assert.equal(err.template, 'Показатель «{name}» записан в панели дважды — оставьте одну строку и сохраните снова.');
  assert.deepEqual(err.params, { name: 'Лейкоциты' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0, 'отказ до записи');

  let err2 = null;
  try { labPanelSave(db, { panel: panelArgs(), analytes: [{ name: 'Лейкоциты', group_label: 'U' }, { name: 'Лейкоциты', group_label: ' U ' }] }, LAB); } catch (e) { err2 = e; }
  assert.deepEqual(err2 && err2.params, { name: 'U / Лейкоциты' }, 'раздел назван в отказе');

  const ok = labPanelSave(db, { panel: panelArgs(), analytes: [{ name: 'Лейкоциты', group_label: 'U' }, { name: 'Лейкоциты', group_label: 'V' }, { name: '   ' }] }, LAB);
  assert.equal(ok.analytes, 2, 'разные разделы — разные строки; строка без имени не сохраняется');
});

test('права — как у /api/db: роли раздела лаборатории пишут, регистратура и касса — 403', () => {
  const db = fresh();
  for (const role of ['admin', 'doctor', 'nurse', 'lab']) {
    const r = labPanelSave(db, { panel: panelArgs({ name: 'П ' + role, service_id: null }), analytes: analytes(['A']) }, { id: 1, role });
    assert.ok(r.id, role);
  }
  for (const role of ['registrar', 'cashier', 'inventory', 'callcenter']) {
    assert.throws(() => labPanelSave(db, { panel: panelArgs({ service_id: null }), analytes: analytes() }, { id: 9, role }), (e) => e.status === 403, role);
    assert.throws(() => labPanelDelete(db, { id: 1 }, { id: 9, role }), (e) => e.status === 403, role);
  }
  assert.throws(() => labPanelSave(db, { panel: panelArgs({ id: 99999 }), analytes: analytes() }, LAB), (e) => e.status === 404);
  assert.throws(() => labPanelSave(db, { panel: panelArgs({ name: '  ' }), analytes: analytes() }, LAB), (e) => e.status === 400);
});

test('«Удалить» панель с показателями: панель и строки ушли, результаты анализов те же', () => {
  const db = fresh();
  const { id } = labPanelSave(db, { panel: panelArgs(), analytes: analytes() }, LAB);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (2382, 10, 50, 'resulted')").run();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (2382, 'Лейкоциты', '5-7')").run();
  const results = db.prepare('SELECT * FROM lab_results ORDER BY id').all();
  const out = labPanelDelete(db, { id }, LAB);
  assert.deepEqual(out, { deleted: true, analytes: NAMES.length });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panel_analytes').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM lab_results ORDER BY id').all(), results);
  assert.throws(() => labPanelDelete(db, { id }, LAB), (e) => e.status === 404, 'второй раз — «не найдена»');
});

test('вставка раньше удаления: подтверждение «для прибора» наследуется от прежней строки (триггер мигр. 233)', () => {
  const db = fresh();
  const dev = Number(db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('BS-200', 'mindray-bs-200')").run().lastInsertRowid);
  const row = { name: 'Глюкоза', device_code: '12', device_code_confirmed: 1, device_code_confirmed_device_id: dev, device_code_confirmed_epoch: 0 };
  const { id } = labPanelSave(db, { panel: panelArgs({ service_id: '51', device_id: dev }), analytes: [row] }, LAB);
  const stamp = () => db.prepare('SELECT device_code_confirmed_device_id d, device_code_confirmed_epoch e FROM lab_panel_analytes WHERE panel_id = ?').all(id);
  assert.deepEqual(stamp(), [{ d: dev, e: 0 }]);
  // Вкладка, открытая до обновления, отметку прибора не знает (не прислала) —
  // база берёт её у прежней строки с тем же кодом и именем, как и при прежнем
  // сохранении через /api/db.
  labPanelSave(db, { panel: panelArgs({ id, service_id: '51', device_id: dev }), analytes: [{ name: 'Глюкоза', device_code: '12', device_code_confirmed: 1 }] }, LAB);
  assert.deepEqual(stamp(), [{ d: dev, e: 0 }]);
  // 0 — «подтверждено ни для какого прибора»: так и записано.
  labPanelSave(db, { panel: panelArgs({ id, service_id: '51', device_id: dev }), analytes: [{ ...row, device_code_confirmed_device_id: 0 }] }, LAB);
  assert.deepEqual(stamp(), [{ d: null, e: null }]);
});

test('это записи: зарегистрированы, не в READ_ONLY_RPCS и не проходят сквозь блокировку лицензии', () => {
  for (const name of ['lab_panel_save', 'lab_panel_delete']) {
    assert.equal(typeof RPC[name], 'function', name);
    assert.equal(isReadOnlyRpc(name), false, name);
    assert.equal(isAlwaysAllowedRpc(name), false, name);
  }
});
