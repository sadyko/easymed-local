// Остатки ревью лаборатории 3.21 (rev-lab2), закрытые в 3.22.0:
//   • L-3 — выключенная строка панели с тем же именем в другом разделе не добавляет
//     бланку лишний старый результат (считаются только активные строки, как в листе);
//   • L-4 — панель, привязанная к ВЫКЛЮЧЕННОЙ услуге, при сохранении остаётся
//     привязанной (раньше выбор молча становился «не привязана»: главное здание
//     отвязывало панель, филиал получал 409 на каждое сохранение).
// Настоящий экран и сервер (lab-real-app-harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, toasts, printed, startApp, settle, walk, textOf, byClass, buttonByText } from './lab-real-app-harness.mjs';

const { setFullAccess } = await import('../permissions.js');
const { renderLaboratory } = await import('../views/laboratory.js');
const { mountLabPanels } = await import('../views/lab-panels.js');
setFullAccess(true);

test('L-3: выключенная строка того же имени в другом разделе — на бланке одна строка, самая новая', async (t) => {
  const app = await startApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, mrn, gender, date_of_birth) VALUES (77, 'Тест Пациент', 'T-1', 'female', '1990-01-01')").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Мазок', 50000, 'lab', 1, 1)").run();
    db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (900, 'Мазок', 50, 'lab', 1)").run();
    db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, group_label, value_type, sort_order, active) VALUES (900, 'Лейкоциты', 'U', 'text', 0, 1), (900, 'Лейкоциты', 'V', 'text', 1, 0)").run();
    db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status, sample_collected_at) VALUES (2382, 10, 50, 'resulted', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes) VALUES (2382, 'Лейкоциты', 'старое', 'normal', ''), (2382, 'Лейкоциты', 'новое', 'normal', '')").run();
  });
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { root.remove(); app.close(); });
  await renderLaboratory(root, { tabId: 't-1' });
  await settle(16);
  printed.length = 0;
  buttonByText(root, 'Бланк').click();
  await settle(24);
  const html = printed[printed.length - 1] || '';
  const tbody = (html.split('<tbody>')[1] || '').split('</tbody>')[0];
  const values = [...tbody.matchAll(/<span class="val[^"]*">([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(values, ['новое'], 'лишней старой строки нет');
});

test('L-4: панель на выключенной услуге — «Сохранить панель» оставляет привязку', async (t) => {
  const app = await startApp((db) => {
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (55, 'Старый мазок', 1, 'lab', 1, 0)").run();
    db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (905, 'Старый мазок', 55, 'lab', 1)").run();
    db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (905, 'Лейкоциты', 'text', 0)").run();
  });
  const root = body.appendChild(document.createElement('div'));
  t.after(() => { root.remove(); app.close(); });
  await mountLabPanels(root);
  await settle(8);
  const item = walk(root).find((n) => n._l && n._l.click && textOf(n).trim().startsWith('Старый мазок'));
  if (item) { item.click(); await settle(8); }
  assert.ok(textOf(root).includes('Привязанная услуга выключена'), 'выбор услуги не показывает выключенную привязку');
  toasts.length = 0;
  buttonByText(root, 'Сохранить панель').click();
  await settle(16);
  assert.ok(toasts.includes('Панель сохранена'), JSON.stringify(toasts));
  assert.equal(app.db.prepare('SELECT service_id FROM lab_panels WHERE id = 905').get().service_id, 55);
  void byClass;
});
