// LAB_PANEL_DEDUP_V1 — «Сохранить панель», нажатая несколько раз, даёт ОДНУ копию.
//
// Клиника (одно здание): каждый показатель панели мазка лежал в базе трижды,
// лист «Внести результаты» показывал каждую копию отдельной строкой, а бланк
// терял анализы. Воспроизведено на этом стенде (настоящий экран, настоящий
// сервер, медленный ответ): у прежнего сохранения было три запроса через
// /api/db (прочитать старые строки, вставить новые, удалить прочитанные), и
// второе сохранение, начатое до конца первого, оставляло строки обоих. Гасла
// только НАЖАТАЯ кнопка — а выбор панели в списке, «Пустой», «Нормы по полу»
// во время сохранения рисовали новую, живую: три нажатия — три копии.
//
// Здесь:
//   • три быстрых нажатия — одна копия, кнопка неактивна всё время записи;
//   • клик, дошедший до обработчика мимо неактивной кнопки, — не пишет;
//   • перерисовка редактора во время сохранения — новая кнопка тоже неактивна;
//   • новая панель — одна панель, а не три;
//   • «Удалить» панель с показателями работает и тоже гасит кнопки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ui, body, toasts, startApp, slow, holdRpc, settle, tick, walk, textOf, byTag, buttonByText } from './lab-real-app-harness.mjs';

const { setFullAccess } = await import('../permissions.js');
const { mountLabPanels } = await import('../views/lab-panels.js');
setFullAccess(true);

const NAMES = ['Лейкоциты', 'Эпит. клетки', 'Микрофлора', 'Гонококки', 'Трихомонады'];
const ONE_EACH = Object.fromEntries(NAMES.map((n) => [n, 1]));
const DELAY = 120;

function seedPanel(db) {
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 50000, 'lab', 1, 1)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, modality, active) VALUES (900, 'Анализ гинекологического мазка', 50, 'lab', 1)").run();
  const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (900, ?, 'numeric', ?)");
  NAMES.forEach((n, i) => a.run(n, i));
}
const perName = (db) => {
  const by = {};
  for (const r of db.prepare('SELECT name FROM lab_panel_analytes').all()) by[r.name] = (by[r.name] || 0) + 1;
  return by;
};
const saves = (calls) => calls.filter((c) => c.url === '/api/rpc/lab_panel_save').length;
async function until(cond, ms = 6000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await tick(20); }
  return true;
}

async function mount(seed = seedPanel) {
  const app = await startApp(seed);
  const root = body.appendChild(document.createElement('div'));
  await mountLabPanels(root);
  await settle(8);
  return { ...app, root, close: () => { root.remove(); app.close(); } };
}
const saveBtn = (root) => buttonByText(root, 'Сохранить панель');
// Запись закончена: сохранение ответило и редактор перерисован после него.
const idle = (root) => { const b = saveBtn(root); return !!b && !b.disabled; };

test('три быстрых нажатия «Сохранить панель» на медленном сервере — одна копия, кнопка неактивна до конца', async (t) => {
  const app = await mount();
  t.after(() => { slow(0); app.close(); });
  slow(DELAY);
  toasts.length = 0;
  const b = saveBtn(app.root);
  b.click();
  assert.equal(b.disabled, true, 'сразу после нажатия кнопка неактивна');
  await tick(10); b.click(); await tick(10); b.click();
  assert.ok(await until(() => idle(app.root) && toasts.includes('Панель сохранена')), 'сохранение закончилось: ' + JSON.stringify(toasts));
  await settle(6);
  assert.deepEqual(perName(app.db), ONE_EACH);
  assert.equal(saves(app.calls), 1, 'на сервер ушло одно сохранение');
});

test('клик, дошедший до обработчика мимо неактивной кнопки, второго сохранения не запускает', async (t) => {
  const app = await mount();
  t.after(() => { ui.raw = false; slow(0); app.close(); });
  slow(DELAY);
  ui.raw = true;   // как без защиты кнопки: каждый клик доходит до обработчика
  toasts.length = 0;
  const b = saveBtn(app.root);
  b.click(); await tick(10); b.click(); await tick(10); b.click();
  assert.ok(toasts.includes('Панель ещё сохраняется — подождите.'), 'второе нажатие названо: ' + JSON.stringify(toasts));
  assert.ok(await until(() => idle(app.root) && toasts.includes('Панель сохранена')));
  await settle(6);
  assert.deepEqual(perName(app.db), ONE_EACH, 'одна копия (до LAB_PANEL_DEDUP_V1 — три)');
  assert.equal(saves(app.calls), 1);
});

test('перерисовка редактора во время сохранения (выбор панели в списке, «Пустой») — новая кнопка тоже неактивна, копия одна', async (t) => {
  const app = await mount();
  t.after(() => { slow(0); app.close(); });
  slow(DELAY / 3);
  // Сервер «ещё отвечает» на сохранение, пока тест его не отпустит.
  const release = holdRpc('lab_panel_save');
  const first = saveBtn(app.root);
  first.click();
  // Человек не видит ответа и щёлкает панель в списке — редактор перерисован.
  const item = walk(app.root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('nav-item') && textOf(n).includes('мазка'));
  item.click();
  await settle(8);
  const fresh = saveBtn(app.root);
  assert.notEqual(fresh, first, 'редактор перерисован — кнопка новая');
  assert.equal(fresh.disabled, true, 'новая кнопка неактивна, пока идёт запись');
  fresh.click();
  buttonByText(app.root, 'Пустой').click();   // ещё одна перерисовка
  await tick(5);
  assert.equal(saveBtn(app.root).disabled, true, 'и после «Пустой» — неактивна');
  saveBtn(app.root).click();
  release();
  assert.ok(await until(() => idle(app.root)));
  await settle(6);
  assert.deepEqual(perName(app.db), ONE_EACH, 'одна копия (до LAB_PANEL_DEDUP_V1 — три)');
  assert.equal(saves(app.calls), 1, 'на сервер ушло одно сохранение из трёх нажатий');
});

test('новая панель («Пустая»): три быстрых нажатия — одна панель с одной копией строк', async (t) => {
  const app = await mount((db) => {
    db.prepare("INSERT INTO services (id, name, price, type, is_lab, active) VALUES (50, 'Анализ гинекологического мазка', 50000, 'lab', 1, 1)").run();
  });
  t.after(() => { ui.raw = false; slow(0); app.close(); });
  buttonByText(app.root, 'Пустая').click(); await settle(4);
  for (let i = 0; i < NAMES.length; i++) { buttonByText(app.root, 'Пустой').click(); await tick(5); }
  const field = (label, tag) => {
    const f = walk(app.root).find((n) => n.className === 'field' && n.children[0] && textOf(n.children[0]).trim() === label);
    return f ? byTag(f, tag)[0] : null;
  };
  const set = (el, v, ev = 'input') => { el.value = v; el.dispatchEvent({ type: ev, target: el, currentTarget: el }); };
  set(field('Название панели', 'input'), 'Анализ гинекологического мазка');
  set(field('Привязанная услуга', 'select'), '50', 'change');
  walk(app.root).filter((n) => n.tagName === 'INPUT' && String(n.className).includes('param')).forEach((inp, i) => set(inp, NAMES[i]));
  slow(DELAY);
  ui.raw = true;
  toasts.length = 0;
  const b = saveBtn(app.root);
  b.click(); await tick(5); b.click(); await tick(5); b.click();
  assert.ok(await until(() => idle(app.root) && toasts.includes('Панель сохранена')));
  await settle(6);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 1);
  assert.deepEqual(perName(app.db), ONE_EACH);
  assert.ok(!toasts.some((m) => /уже привязана/.test(m)), 'второе нажатие не упёрлось в «услуга уже привязана»: ' + JSON.stringify(toasts));
});

test('«Удалить» панель с показателями: панель и строки ушли, кнопки неактивны, пока идёт удаление', async (t) => {
  const app = await mount((db) => {
    seedPanel(db);
    // Ровно клиника: каждый показатель трижды.
    const a = db.prepare("INSERT INTO lab_panel_analytes (panel_id, name, value_type, sort_order) VALUES (900, ?, 'numeric', ?)");
    for (let c = 0; c < 2; c++) NAMES.forEach((n, i) => a.run(n, i));
  });
  t.after(() => { slow(0); app.close(); });
  slow(DELAY);
  toasts.length = 0;
  const del = buttonByText(app.root, 'Удалить');
  del.click();
  assert.equal(del.disabled, true, '«Удалить» неактивна, пока идёт удаление');
  assert.equal(saveBtn(app.root).disabled, true, '«Сохранить панель» — тоже');
  assert.ok(await until(() => toasts.includes('Панель удалена')), JSON.stringify(toasts));
  await settle(8);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM lab_panel_analytes').get().n, 0);
  assert.ok(!toasts.some((m) => /Не удалось удалить/.test(m)), JSON.stringify(toasts));
});
