// LAB_PANEL_DEDUP_V1 — лист «Внести результаты» и бланк, когда строки панели
// уже задвоены (настоящий экран лаборатории на настоящем сервере).
//
// Клиника: панель мазка держала каждый показатель трижды. Лист показывал 15
// строк вместо 5, сохранённое значение сопоставлялось по имени и вставало во
// все три копии, а правка любой копии, кроме последней, молча терялась.
// Корзина у строки и «Добавить свой показатель» перерисовывали раздел и
// стирали всё набранное, «Закрыть» и щелчок мимо окна закрывали без вопроса —
// и на бланк попадали Лейкоциты / Эпит. клетки / Микрофлора, а Гонококки и
// Трихомонады пропадали. Здесь:
//   • одна строка на показатель (раздел бланка + имя), даже если копии в базе;
//   • правка сохраняется;
//   • корзина и «Добавить свой показатель» набранное не стирают;
//   • закрыть окно с несохранённым вводом — только после вопроса;
//   • бланк — одна строка на показатель, свежая побеждает (как карта и «Документы»);
//   • «Документы» видят лабораторную услугу по общему правилу (не только is_lab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, toasts, printed, confirms, answerConfirm, pressKey, startApp, settle, tick, walk, textOf, byClass, buttonByText } from './lab-real-app-harness.mjs';

const { setFullAccess } = await import('../permissions.js');
const { renderLaboratory } = await import('../views/laboratory.js');
const { fetchLabByVisit } = await import('../views/patient-documents.js');
setFullAccess(true);

const NAMES = ['Лейкоциты', 'Эпит. клетки', 'Микрофлора', 'Гонококки', 'Трихомонады'];
const ASK = 'Внесённые результаты не сохранены. Закрыть без сохранения?';

function seed(db, { copies = 3, status = 'collected' } = {}) {
  db.prepare("INSERT INTO patients (id, full_name, mrn, gender, date_of_birth) VALUES (77, 'Тест Пациент', 'T-1', 'female', '1990-01-01')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 50000, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (900, 'Анализ гинекологического мазка', 50, 'lab', 1)").run();
  const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (900, ?, 'numeric', ?)");
  for (let c = 0; c < copies; c++) NAMES.forEach((n, i) => a.run(n, i));   // копия за копией, как их и оставляли сохранения
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, sample_collected_at) VALUES (2382, 10, 50, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(status);
}
const results = (db) => db.prepare('SELECT id, parameter, value FROM lab_results WHERE visit_service_id = 2382 ORDER BY id').all();

async function mount(seedFn) {
  const app = await startApp(seedFn);
  const root = body.appendChild(document.createElement('div'));
  await renderLaboratory(root, { tabId: 't-1' });
  await settle(16);
  return { ...app, root, close: () => { for (const m of byClass(body, 'modal')) m.remove(); root.remove(); app.close(); } };
}
async function openSheet(root) {
  for (const m of byClass(body, 'modal')) m.remove();
  const btn = buttonByText(root, 'Внести результаты');
  assert.ok(btn, '«Внести результаты» на карточке');
  btn.click();
  await settle(16);
  return byClass(body, 'modal').pop();
}
const lines = (modal) => byClass(modal, 'le-row').map((row) => ({
  name: textOf(byClass(row, 'le-name')[0] || row), input: byClass(row, 'le-val')[0], del: byClass(row, 'lw-del')[0],
}));
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input', target: el, currentTarget: el }); };
const open = (modal) => byClass(body, 'modal').includes(modal);
async function saveAll(modal) {
  toasts.length = 0;
  buttonByText(modal, 'Сохранить всё').click();
  await settle(24);
}

test('панель с тройными строками: лист — по одной строке на показатель', async (t) => {
  const app = await mount((db) => seed(db));
  t.after(() => app.close());
  const modal = await openSheet(app.root);
  assert.deepEqual(lines(modal).map((l) => l.name), NAMES, 'пять строк, а не пятнадцать');
});

test('правка показателя сохраняется (прежде правка первой из копий терялась)', async (t) => {
  const app = await mount((db) => seed(db));
  t.after(() => app.close());
  let modal = await openSheet(app.root);
  for (const l of lines(modal)) type(l.input, l.name === 'Лейкоциты' ? '5-7' : 'есть');
  await saveAll(modal);
  assert.equal(results(app.db).length, NAMES.length, 'по строке результата на показатель');
  modal = await openSheet(app.root);
  const leu = lines(modal).find((l) => l.name === 'Лейкоциты');
  assert.equal(leu.input.value, '5-7');
  type(leu.input, '9-11');
  await saveAll(modal);
  assert.ok(toasts.some((m) => /Результаты сохранены/.test(m)), JSON.stringify(toasts));
  const now = results(app.db);
  assert.equal(now.length, NAMES.length, 'правка не добавила строк');
  assert.equal(now.find((r) => r.parameter === 'Лейкоциты').value, '9-11');
});

test('корзина у строки и «Добавить свой показатель» не стирают набранное', async (t) => {
  const app = await mount((db) => seed(db));
  t.after(() => app.close());
  const modal = await openSheet(app.root);
  for (const l of lines(modal)) if (l.name === 'Гонококки' || l.name === 'Трихомонады') type(l.input, 'не обн.');
  const leu = lines(modal).find((l) => l.name === 'Лейкоциты');
  type(leu.input, '5-7');
  lines(modal).find((l) => l.name === 'Микрофлора').del.click();   // раздел перерисован
  await tick(10);
  const after = Object.fromEntries(lines(modal).map((l) => [l.name, l.input.value]));
  assert.deepEqual(after, { 'Лейкоциты': '5-7', 'Эпит. клетки': '', 'Гонококки': 'не обн.', 'Трихомонады': 'не обн.' });
  buttonByText(modal, 'Добавить свой показатель').click();          // и ещё раз
  await tick(10);
  const again = lines(modal);
  assert.equal(again.length, 5, 'добавлена своя строка');
  assert.deepEqual(again.slice(0, 4).map((l) => l.input.value), ['5-7', '', 'не обн.', 'не обн.']);
  await saveAll(modal);
  assert.deepEqual(results(app.db).map((r) => r.parameter + '=' + r.value), ['Лейкоциты=5-7', 'Гонококки=не обн.', 'Трихомонады=не обн.']);
});

test('закрыть окно с несохранённым вводом — только после вопроса («Закрыть», ×, щелчок мимо, Escape); без ввода — без вопроса', async (t) => {
  const app = await mount((db) => seed(db));
  t.after(() => { answerConfirm(true); app.close(); });
  let modal = await openSheet(app.root);
  type(lines(modal)[3].input, 'не обн.');
  answerConfirm(false);   // «Отмена» — окно остаётся
  const ways = {
    'Закрыть': () => buttonByText(modal, 'Закрыть').click(),
    '×': () => byClass(modal, 'modal-close')[0].click(),
    'щелчок мимо окна': () => byClass(modal, 'modal-backdrop')[0].click(),
    'Escape': () => pressKey('Escape'),
  };
  for (const [name, act] of Object.entries(ways)) {
    confirms.length = 0;
    act();
    assert.deepEqual(confirms, [ASK], name + ': вопрос задан');
    assert.ok(open(modal), name + ': «Отмена» — окно открыто');
    assert.equal(lines(modal)[3].input.value, 'не обн.', name + ': набранное на месте');
  }
  answerConfirm(true);    // «ОК» — закрыть без сохранения
  confirms.length = 0;
  pressKey('Escape');
  assert.deepEqual(confirms, [ASK]);
  assert.ok(!open(modal), 'закрыто после «ОК»');
  assert.equal(results(app.db).length, 0, 'ничего не сохранено');

  // Без несохранённого ввода — закрывается сразу, Escape после закрытия молчит.
  modal = await openSheet(app.root);
  confirms.length = 0;
  buttonByText(modal, 'Закрыть').click();
  assert.deepEqual(confirms, [], 'без ввода — без вопроса');
  assert.ok(!open(modal));
  pressKey('Escape');
  assert.deepEqual(confirms, [], 'слушатель Escape снят вместе с окном');
});

test('бланк: одна строка на показатель, свежая побеждает — как в карте пациента и «Документах»', async (t) => {
  const app = await mount((db) => {
    seed(db, { status: 'resulted' });
    // Ровно последствие копий: каждый показатель записан трижды.
    const r = db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes) VALUES (2382, ?, ?, 'normal', '')");
    for (const v of ['1', '2', '3']) for (const n of NAMES) r.run(n, n === 'Лейкоциты' ? v + '-7' : 'v' + v);
  });
  t.after(() => app.close());
  printed.length = 0;
  buttonByText(app.root, 'Бланк').click();
  await settle(24);
  const html = printed[printed.length - 1] || '';
  const tbody = (html.split('<tbody>')[1] || '').split('</tbody>')[0];
  const rows = tbody.split('<tr>').slice(1).map((tr) => ((tr.match(/<td class="pname">([^<]*)/) || [])[1] || '').trim() + '=' + ((tr.match(/<span class="val[^"]*">([^<]*)/) || [])[1] || '').trim());
  assert.deepEqual(rows, ['Лейкоциты=3-7', 'Эпит. клетки=v3', 'Микрофлора=v3', 'Гонококки=v3', 'Трихомонады=v3']);
});

// DIAG_ROUTE_V1 (решение владельца 2026-11-03: «маршрут решает группа, а не название») —
// отделение «Лаборатория» анализом услугу с группой больше не делает: «Мазок по отделению»
// группы «Хирургия» — не анализ (в очередь лаборатории он тоже не попадает). Анализом его
// делает группа «Лаборатория» или привязанная панель («Мазок по панели»).
test('«Документы»: услуга лаборатории по группе или по панели (не только is_lab) попадает в результаты визита; отделение группу не перебивает', async (t) => {
  const app = await startApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Тест Пациент')").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, date('now'), 'arrived')").run();
    const dept = Number(db.prepare("INSERT INTO departments (name, kind) VALUES ('Лаборатория', 'laboratory')").run().lastInsertRowid);
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (60, 'Мазок по отделению', 1, 'other', 0, 1)").run();
    db.prepare('UPDATE services SET department_id = ? WHERE id = 60').run(dept);
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (61, 'Мазок по панели', 1, 'other', 0, 1)").run();
    db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (901, 'Мазок по панели', 61, 'lab', 1)").run();
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (62, 'Консультация', 1, 'other', 0, 1)").run();
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (63, 'Мазок по группе', 1, 'lab', 1, 1)").run();
    for (const [vs, svc] of [[3001, 60], [3002, 61], [3003, 62], [3004, 63]]) {
      db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (?, 10, ?, 'resulted')").run(vs, svc);
      db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'Лейкоциты', '5')").run(vs);
    }
  });
  t.after(() => app.close());
  const byVisit = await fetchLabByVisit([10]);
  const names = (byVisit[10] || []).map((r) => r.panelName).sort();
  assert.deepEqual(names, ['Мазок по группе', 'Мазок по панели'], 'группа «Лаборатория» и панель; отделение и консультация — нет');
});
