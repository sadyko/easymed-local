// CRM_UNIFY_V1 — ЗАДАЧИ ИДУТ ЗА КАРТОЧКОЙ; ответственный обязан её видеть.
//
// Владелец: «операторы не видят свои задачи». Задача оставалась у прежнего
// оператора, когда карточку брали, передавали или сливали: красный счётчик её
// считал, а открыть карточку он не мог. И ответственным можно было назначить
// того, кто карточку не видит. Правила Р16 и Р17 плана
// docs/plans/2026-10-09-crm-unify.md; код — server/services/crm/tasks-follow.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { crmMergeLeads } from '../services/rpc/crm-merge.js';
import { isReadOnlyRpc } from '../services/control/gate.js';

const task = (db, rid, assignee, text = 'Перезвонить', done = null) =>
  Number(db.prepare('INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at) VALUES (?,?,?,?,?)')
    .run(rid, text, '2026-01-01T09:00:00Z', assignee, done).lastInsertRowid);
const who = (db, id) => db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(id).assignee_id;
const upd = (t, by, id, values) => t.dbq(by, { table: 'crm_requests', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const ASSIGNEE_REFUSAL = 'Ответственным можно назначить только того, кто видит эту карточку: её оператора или руководителя.';

test('«Взять в работу»: задачи без исполнителя переходят взявшему; поручение руководителя конкретному человеку — нет', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: null });
    const free = task(t.db, rid, null);
    const toB = task(t.db, rid, 4, 'Поручено Б');
    const r = await upd(t, 'cc', rid, { assigned_to: 3 });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).assigned_to, 3);
    assert.equal(who(t.db, free), 3);
    assert.equal(who(t.db, toB), 4, 'поручение конкретному человеку переехало');
  } finally { t.close(); }
});

test('передача А → Б: открытые задачи А — к Б; задача руководителя и закрытая — на месте', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const a = task(t.db, rid, 3);
    const none = task(t.db, rid, null, 'Без исполнителя');
    const head = task(t.db, rid, 5, 'Руководителю');
    const done = task(t.db, rid, 3, 'Сделано', '2026-01-02T09:00:00Z');
    const r = await upd(t, 'head', rid, { assigned_to: 4 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([who(t.db, a), who(t.db, none), who(t.db, head), who(t.db, done)], [4, 4, 5, 3]);
  } finally { t.close(); }
});

test('передача нескольких карточек одной правкой: задачи каждой идут за своей карточкой', async () => {
  const t = await startCrmApp();
  try {
    const r1 = addLead(t.db, { assigned: 3, name: 'Первая' });
    const r2 = addLead(t.db, { assigned: null, name: 'Вторая' });
    const other = addLead(t.db, { assigned: 3, name: 'Не задета' });
    const a1 = task(t.db, r1, 3);
    const a2 = task(t.db, r2, null);
    const keep = task(t.db, other, 3);
    const r = await t.dbq('boss', { table: 'crm_requests', op: 'update', values: { assigned_to: 4 },
      filters: [{ col: 'id', op: 'in', val: [r1, r2] }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([who(t.db, a1), who(t.db, a2), who(t.db, keep)], [4, 4, 3]);
  } finally { t.close(); }
});

test('правка карточки без смены оператора и «Отказ» задачи не трогают', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const none = task(t.db, rid, null);
    assert.equal((await upd(t, 'cc', rid, { note: 'перезвонить вечером' })).status, 200);
    assert.equal((await upd(t, 'cc', rid, { assigned_to: 3, note: 'то же' })).status, 200);
    assert.equal(who(t.db, none), null, 'задача без исполнителя ушла, хотя оператор не сменился');
  } finally { t.close(); }
});

test('карточку отпустили в стопку (никому) — задачи не двигаются', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const a = task(t.db, rid, 3);
    const r = await upd(t, 'cc', rid, { assigned_to: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).assigned_to, null);
    assert.equal(who(t.db, a), 3);
  } finally { t.close(); }
});

test('чужую карточку оператор не взял — и задачи её не сдвинулись', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const none = task(t.db, rid, null);
    await upd(t, 'cc2', rid, { assigned_to: 4 });
    assert.equal(t.lead(rid).assigned_to, 3);
    assert.equal(who(t.db, none), null);
  } finally { t.close(); }
});

test('слияние: задачи оператора влитой карточки — к оператору оставшейся', async () => {
  const t = await startCrmApp();
  try {
    const keep = addLead(t.db, { assigned: 3, patient: null, phone: '+998 91 555 66 77' });
    const lose = addLead(t.db, { assigned: 4, patient: null, phone: '915556677' });
    const b = task(t.db, lose, 4);
    const none = task(t.db, lose, null, 'Без исполнителя');
    const head = task(t.db, lose, 5, 'Руководителю');
    const done = task(t.db, lose, 4, 'Сделано', '2026-01-02T09:00:00Z');
    crmMergeLeads(t.db, { keep_id: keep, merge_ids: [lose] }, { id: 1, role: 'admin', extra_roles: [] });
    assert.equal(who(t.db, b), 3, 'задача Б осталась у Б на чужой карточке');
    assert.deepEqual([who(t.db, none), who(t.db, head), who(t.db, done)], [3, 5, 4]);
    const rows = t.db.prepare('SELECT DISTINCT request_id FROM crm_tasks').all().map((x) => x.request_id);
    assert.deepEqual(rows, [keep]);
  } finally { t.close(); }
});

test('ответственный обязан видеть карточку: на карточке А — А или руководитель; Б — отказ 403', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const ins = (by, assignee) => t.dbq(by, { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'Т', due_at: '2026-12-01T09:00:00Z', assignee_id: assignee } });
    const before = t.db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n;
    const refused = await ins('head', 4);
    assert.equal(refused.status, 403, 'задачу поставили тому, кто карточку не видит');
    assert.equal(refused.json.error.message, ASSIGNEE_REFUSAL);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, before, 'отказ, но задача записана');
    assert.equal((await ins('head', 3)).status, 200);
    assert.equal((await ins('head', 5)).status, 200);
    assert.equal((await ins('boss', 1)).status, 200);
    assert.equal((await ins('cc', 3)).status, 200);
    // кассир доску задач не ведёт — его не назначить
    assert.equal((await ins('boss', 9)).status, 403);
    const id = t.db.prepare('SELECT MAX(id) id FROM crm_tasks').get().id;
    const re = await t.dbq('head', { table: 'crm_tasks', op: 'update', values: { assignee_id: 4 }, filters: [{ col: 'id', op: 'eq', val: id }] });
    assert.equal(re.status, 403);
    assert.equal(who(t.db, id), 3);
    // пакет: одна строка на того, кто не видит, — отказ всему пакету
    const batch = await t.dbq('head', { table: 'crm_tasks', op: 'insert', values: [
      { request_id: rid, text: 'x', assignee_id: 3 }, { request_id: rid, text: 'y', assignee_id: 4 }] });
    assert.equal(batch.status, 403);
    // на ничьей карточке её видят все, кто ведёт доску
    const free = addLead(t.db, { assigned: null });
    const r2 = await t.dbq('cc', { table: 'crm_tasks', op: 'insert', values: { request_id: free, text: 'Т', due_at: '2026-12-01T09:00:00Z', assignee_id: 4 } });
    assert.equal(r2.status, 200, r2.text);
    // …кроме тех, кто доску задач не ведёт (врач)
    const r4 = await t.dbq('boss', { table: 'crm_tasks', op: 'insert', values: { request_id: free, text: 'Т', assignee_id: 10 } });
    assert.equal(r4.status, 403);
    // без исполнителя — как раньше
    const r3 = await t.dbq('cc', { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'Т' } });
    assert.equal(r3.status, 200, r3.text);
  } finally { t.close(); }
});

test('отказ не выдаёт чужую карточку: вставка на невидимую — прежний безликий отказ', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const r = await t.dbq('cc2', { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'Т', assignee_id: 4 } });
    assert.equal(r.status, 403);
    assert.notEqual(r.json.error.message, ASSIGNEE_REFUSAL, 'отказ подтвердил, что карточка существует');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, 0);
  } finally { t.close(); }
});

test('правка задачи без смены исполнителя проходит и у старой «осиротевшей» задачи', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const orphan = task(t.db, rid, 4, 'Старое поручение');
    const r = await t.dbq('head', { table: 'crm_tasks', op: 'update', values: { text: 'Поправил', assignee_id: 4 },
      filters: [{ col: 'id', op: 'eq', val: orphan }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.db.prepare('SELECT text FROM crm_tasks WHERE id = ?').get(orphan).text, 'Поправил');
    // исполнитель отмечает своё поручение (orOwn) — без исполнителя в правке
    const done = await t.dbq('cc2', { table: 'crm_tasks', op: 'update', values: { done_at: '2026-10-09T10:00:00Z' },
      filters: [{ col: 'id', op: 'eq', val: orphan }] });
    assert.equal(done.status, 200, done.text);
    assert.ok(t.db.prepare('SELECT done_at FROM crm_tasks WHERE id = ?').get(orphan).done_at);
  } finally { t.close(); }
});

test('crm_task_assignees: на карточке А — А, админ и руководитель; на ничьей — все, кто ведёт доску; на чужой — пусто', async () => {
  const t = await startCrmApp();
  try {
    const mine = addLead(t.db, { assigned: 3 });
    const free = addLead(t.db, { assigned: null });
    const ids = (r) => { assert.equal(r.status, 200, r.text); return r.json.data.map((p) => p.id).sort((x, y) => x - y); };
    assert.deepEqual(ids(await t.rpc('crm_task_assignees', 'head', { request_id: mine })), [1, 3, 5]);
    assert.deepEqual(ids(await t.rpc('crm_task_assignees', 'cc', { request_id: mine })), [1, 3, 5]);
    assert.deepEqual(ids(await t.rpc('crm_task_assignees', 'cc', { request_id: free })), [1, 2, 3, 4, 5]);
    assert.deepEqual((await t.rpc('crm_task_assignees', 'cc2', { request_id: mine })).json.data, []);
    assert.deepEqual((await t.rpc('crm_task_assignees', 'cc', { request_id: 999999 })).json.data, []);
    // форма строки — только номер и имя
    const one = (await t.rpc('crm_task_assignees', 'boss', { request_id: mine })).json.data.find((p) => p.id === 3);
    assert.deepEqual(one, { id: 3, full_name: 'Оператор А' });
    // уволенный (не активный) не предлагается
    t.db.prepare('UPDATE users SET is_active = 0 WHERE id = 4').run();
    assert.deepEqual(ids(await t.rpc('crm_task_assignees', 'cc', { request_id: free })), [1, 2, 3, 5]);
    // кассиру задачи CRM недоступны
    const kassa = await t.rpc('crm_task_assignees', 'kassa', { request_id: free });
    assert.equal(kassa.status, 403);
    assert.equal(kassa.json.error.message, 'Задачи CRM вам недоступны.');
  } finally { t.close(); }
});

test('crm_task_assignees — чтение: работает и у клиники с просроченной лицензией', () => {
  assert.equal(isReadOnlyRpc('crm_task_assignees'), true);
});
