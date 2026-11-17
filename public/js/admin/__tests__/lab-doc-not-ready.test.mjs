// LAB_DOC_NOT_READY_V1 (решение владельца, 3.25.0) — раздел «Документы» на настоящем
// сервере (lab-real-app-harness.mjs: экран на поддельной DOM, запросы — в createApp на
// базе в памяти).
//
// Владелец: «the saved laboratory analyses (but not confirmed) are available in the
// documents section». Решение: внесённый, но не подтверждённый анализ — «Не готов»:
// он в списке (видно, что анализ делается), но БЕЗ значений, и не открывается и не
// печатается, пока лаборатория его не подтвердит. Здесь проверяется, что значения
// такого анализа не приходят в браузер ни одним запросом раздела — ни лентой
// (documents_feed), ни архивом пациента (/api/db lab_results), — и что окно печати
// предлагает только выданное.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, printed, startApp, settle, walk, textOf, byTag } from './lab-real-app-harness.mjs';

const { setFullAccess } = await import('../permissions.js');
const { renderPatientDocuments, fetchLabByVisit } = await import('../views/patient-documents.js');
setFullAccess(true);

function seed(db) {
  // Раздел «Документы» лаборанту стенда (сеяная роль lab его не имеет).
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'lab'").get();
  const p = JSON.parse(row.permissions);
  p.sections = [...new Set([...(p.sections || []), 'patient-documents'])];
  p.levels = { ...(p.levels || {}), 'patient-documents': 'viewer' };
  db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'lab'").run(JSON.stringify(p));

  db.prepare("INSERT INTO patients (id, full_name, mrn, gender, date_of_birth) VALUES (77, 'Тестова Пациентка', 'T-77', 'female', '1990-01-01')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 77, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Общий анализ крови', 1, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (51, 'Гормоны щитовидной железы', 1, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status, verified_at) VALUES (4001, 10, 50, 'completed', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (4002, 10, 51, 'resulted')").run();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes) VALUES (4001, 'Лейкоциты', '6.1', 'normal', '')").run();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes) VALUES (4002, 'Тиреотропин', '7.77', 'high', '')").run();
}

// Каждый ответ сервера, пришедший в «браузер», — текстом: значения не подтверждённого
// анализа не должны встретиться ни в одном.
async function start() {
  const app = await startApp(seed);
  const answers = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = await inner(url, init);
    if (String(url).startsWith('/api/')) { try { answers.push(await r.clone().text()); } catch { /* не текст */ } }
    return r;
  };
  return { ...app, answers };
}
const leaked = (answers) => answers.filter((a) => a.includes('7.77') || a.includes('Тиреотропин'));
const pickDialog = () => walk(body).find((n) => n.hasAttribute && n.hasAttribute('data-lab-print-pick'));
const pickedOrders = (dlg) => walk(dlg).filter((n) => n.tagName === 'INPUT' && n.hasAttribute('data-pick-order')).map((b) => b.getAttribute('data-pick-order'));

test('архив: значения читаются только у подтверждённого; не подтверждённый — в списке «не готов» без значений', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const notReady = {};
  const byVisit = await fetchLabByVisit([10], { notReady });
  assert.deepEqual((byVisit[10] || []).map((r) => [r.vsId, r.testName, r.value]), [[4001, 'Лейкоциты', '6.1']]);
  assert.deepEqual((notReady[10] || []).map((x) => [x.vsId, x.name]), [[4002, 'Гормоны щитовидной железы']]);
  assert.deepEqual(leaked(app.answers), [], 'значения не подтверждённого анализа пришли в браузер');
});

test('лента: не подтверждённый — «Не готов», без значений и без «Печать»; подтверждённый — со значением и «Печать», окно печати — только выданное', async (t) => {
  const app = await start();
  t.after(() => { for (const n of [...body.children]) n.remove(); app.close(); });
  const root = body.appendChild(document.createElement('div'));
  await renderPatientDocuments(root, { onNavigate() {} });
  await settle(20);
  const rowOf = (name) => byTag(root, 'button').find((b) => textOf(b).includes(name) && textOf(b).includes('Тестова'));
  const pending = rowOf('Гормоны щитовидной железы');
  const issued = rowOf('Общий анализ крови');
  assert.ok(pending && issued, 'строк ленты нет: ' + textOf(root).slice(0, 400));
  assert.ok(textOf(pending).includes('Не готов'), 'не сказано, что анализ не готов: ' + textOf(pending));
  assert.ok(!textOf(pending).includes('Готовится'));
  assert.ok(!walk(pending).some((n) => n.getAttribute && n.getAttribute('role') === 'button'), 'у не подтверждённого анализа кнопка «Печать»');
  assert.ok(!textOf(root).includes('7.77') && !textOf(root).includes('Тиреотропин'), 'значение не подтверждённого анализа на экране');
  assert.ok(textOf(issued).includes('6.1') && textOf(issued).includes('Выдан'));
  assert.deepEqual(leaked(app.answers), [], 'значения не подтверждённого анализа пришли в браузер');

  const printBtn = walk(issued).find((n) => n.getAttribute && n.getAttribute('role') === 'button');
  assert.ok(printBtn, 'у подтверждённого анализа нет «Печать»');
  printed.length = 0;
  printBtn.dispatchEvent({ type: 'click', currentTarget: printBtn, target: printBtn, preventDefault() {}, stopPropagation() {} });
  await settle(20);
  const dlg = pickDialog();
  assert.ok(dlg, 'окно выбора не открылось');
  assert.deepEqual(pickedOrders(dlg), ['4001'], 'не подтверждённый анализ предложен к печати');
  byTag(dlg, 'button').find((b) => textOf(b).includes('Печать')).click();
  await settle(20);
  const html = printed[printed.length - 1] || '';
  assert.ok(html.includes('Лейкоциты'), 'выданный анализ не напечатан');
  assert.ok(!html.includes('Тиреотропин') && !html.includes('7.77'), 'не подтверждённый анализ на бланке');
  assert.deepEqual(leaked(app.answers), []);
});

test('архив пациента: не подтверждённый анализ назван «Не готов» без значений; «Lab report» печатает только выданное', async (t) => {
  const app = await start();
  t.after(() => { for (const n of [...body.children]) n.remove(); app.close(); });
  const root = body.appendChild(document.createElement('div'));
  await renderPatientDocuments(root, { onNavigate() {} });
  await settle(20);
  byTag(root, 'button').find((b) => textOf(b).includes('Гормоны щитовидной железы') && textOf(b).includes('Тестова')).click();
  await settle(24);
  const card = walk(root).find((n) => n.hasAttribute && n.hasAttribute('data-lab-not-ready'));
  assert.ok(card, 'в архиве не сказано, какие анализы не готовы: ' + textOf(root).slice(0, 400));
  assert.ok(textOf(card).includes('Гормоны щитовидной железы') && textOf(card).includes('Не готов'));
  assert.ok(!textOf(root).includes('7.77') && !textOf(root).includes('Тиреотропин'));

  printed.length = 0;
  byTag(root, 'button').find((b) => textOf(b).includes('Lab report')).click();
  await settle(20);
  const dlg = pickDialog();
  assert.ok(dlg, 'окно выбора не открылось');
  assert.deepEqual(pickedOrders(dlg), ['4001']);
  assert.deepEqual(leaked(app.answers), [], 'значения не подтверждённого анализа пришли в браузер');
});
