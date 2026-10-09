// CRM_UNIFY_V1 — ЗАДАЧИ ИДУТ ЗА КАРТОЧКОЙ; ответственный обязан её видеть.
//
// Владелец: «операторы не видят свои задачи». Задача оставалась у прежнего
// оператора, когда карточку брали, передавали или сливали: красный счётчик её
// считал, а открыть карточку он не мог. И ответственным можно было назначить
// того, кто карточку не видит. Правила Р16 и Р17 плана
// docs/plans/2026-10-09-crm-unify.md; код — server/services/crm/tasks-follow.js.
//
// РЕВЬЮ ЗАДАЧИ 10 (2026-10-09), решение контролёра — ОДНО ПРАВИЛО «может вести
// карточку» (crm/tasks-follow.js canWorkLead): активен, пишет задачи CRM по
// реестру, «CRM: изменение» (не просмотр), видит карточку. По нему — список
// «Ответственный», отказ двери, новый хозяин карточки и задачи, идущие за ней:
// к новому хозяину уходят открытые задачи без исполнителя, прежнего хозяина и
// тех, кто эту карточку вести больше не может. Остаются только у тех, кто её
// по-прежнему ведёт (руководитель, администратор, «crm.all»). Случаи R1–R10 —
// находки ревью.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { hashPassword } from '../services/auth.js';
import { crmMergeLeads } from '../services/rpc/crm-merge.js';
import { isReadOnlyRpc } from '../services/control/gate.js';

const task = (db, rid, assignee, text = 'Перезвонить', done = null) =>
  Number(db.prepare('INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at) VALUES (?,?,?,?,?)')
    .run(rid, text, '2026-01-01T09:00:00Z', assignee, done).lastInsertRowid);
const who = (db, id) => db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(id).assignee_id;
const upd = (t, by, id, values) => t.dbq(by, { table: 'crm_requests', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const sel = (t, by, table, id) => t.dbq(by, { table, op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: id }] });
const ASSIGNEE_REFUSAL = 'Ответственным можно назначить только того, кто может вести эту карточку: её оператора или руководителя.';
const OWNER_REFUSAL = 'Передать заявку можно только сотруднику, который может вести заявки CRM: активному и с правом их изменять.';
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };

// Роль клиники на основе колл-центра с «CRM: просмотр» — видит доску, но не ведёт её.
function seedViewer(db) {
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('cc_view', 'КЦ просмотр', 'callcenter')").run();
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('cc_view', JSON.stringify({ sections: ['crm'], levels: { crm: 'viewer' } }));
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, custom_role_code) VALUES (?,?,?,?,?,?,?)')
    .run(6, 'viewer', hashPassword('password1'), 'Наблюдатель', 'callcenter', 0, 'cc_view');
}

// CRM_UNIFY_V1 (ревью задачи 10, R2) — ПРАВИЛО ИЗМЕНЕНО НАМЕРЕННО: раньше
// задача, поручённая Б на ничьей карточке, оставалась у Б, когда карточку брал
// А, — и Б терял к ней дорогу (карточка А ему не видна). Теперь она идёт к А;
// остаётся только у того, кто карточку по-прежнему ведёт (руководитель).
test('«Взять в работу»: задачи без исполнителя и тех, кто карточку больше не видит, — взявшему; руководителя — на месте', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: null });
    const free = task(t.db, rid, null);
    const toB = task(t.db, rid, 4, 'Поручено Б');
    const head = task(t.db, rid, 5, 'Руководителю');
    const boss = task(t.db, rid, 1, 'Администратору');
    const r = await upd(t, 'cc', rid, { assigned_to: 3 });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).assigned_to, 3);
    assert.equal(who(t.db, free), 3);
    assert.equal(who(t.db, toB), 3, 'CRM_UNIFY_V1: задача Б осталась у Б на карточке, которую Б не видит');
    assert.deepEqual([who(t.db, head), who(t.db, boss)], [5, 1], 'задача того, кто карточку ведёт, уехала');
  } finally { t.close(); }
});

test('R1: А отпустил карточку в стопку, Б взял — задача А идёт к Б, а не сиротеет у А', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const a = task(t.db, rid, 3, 'А: перезвонить');
    assert.equal((await upd(t, 'cc', rid, { assigned_to: null })).status, 200);
    assert.equal(who(t.db, a), 3, 'в стопке задачи не двигаются');
    assert.equal((await upd(t, 'cc2', rid, { assigned_to: 4 })).status, 200);
    assert.equal(t.lead(rid).assigned_to, 4);
    assert.equal(who(t.db, a), 4);
    assert.equal((await sel(t, 'cc', 'crm_tasks', a)).json.data.length, 0, 'у А в счётчике чужая задача');
    assert.equal((await sel(t, 'cc2', 'crm_tasks', a)).json.data.length, 1);
  } finally { t.close(); }
});

test('R2: оператор В поставил себе задачу на ничьей карточке, А её взял — задача В идёт к А', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: null });
    const r = await t.dbq('cc2', { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'Перезвоню сам', due_at: '2026-12-01T09:00:00Z', assignee_id: 4 } });
    assert.equal(r.status, 200, r.text);
    const id = t.db.prepare('SELECT MAX(id) id FROM crm_tasks').get().id;
    assert.equal((await upd(t, 'cc', rid, { assigned_to: 3 })).status, 200);
    assert.equal(who(t.db, id), 3);
    assert.equal((await sel(t, 'cc2', 'crm_tasks', id)).json.data.length, 0, 'В считает задачу карточки, которую не видит');
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

test('R3: слияние ничьей карточки с задачей оператора В в карточку А — задача В идёт к А', async () => {
  const t = await startCrmApp();
  try {
    const keep = addLead(t.db, { assigned: 3, patient: null, phone: '+998 91 555 66 77' });
    const pool = addLead(t.db, { assigned: null, patient: null, phone: '915556677' });
    const c = task(t.db, pool, 4, 'В на ничьей');
    const head = task(t.db, pool, 5, 'Руководителю');
    crmMergeLeads(t.db, { keep_id: keep, merge_ids: [pool] }, ADMIN);
    assert.equal(who(t.db, c), 3);
    assert.equal(who(t.db, head), 5, 'задача руководителя уехала');
    assert.equal((await sel(t, 'cc2', 'crm_tasks', c)).json.data.length, 0);
  } finally { t.close(); }
});

test('слияние: оператор, который заявки вести не может, не становится хозяином — карточка в стопку, задачи на месте', async () => {
  const t = await startCrmApp();
  try {
    // оставшаяся ничья, влитая — у уволенного оператора Б
    const keep = addLead(t.db, { assigned: null, patient: null, phone: '+998 91 555 66 77' });
    const lose = addLead(t.db, { assigned: 4, patient: null, phone: '915556677' });
    const b = task(t.db, lose, 4);
    t.db.prepare('UPDATE users SET is_active = 0 WHERE id = 4').run();
    crmMergeLeads(t.db, { keep_id: keep, merge_ids: [lose] }, ADMIN);
    assert.equal(t.lead(keep).assigned_to, null, 'хозяином слитой карточки стал уволенный');
    assert.equal(who(t.db, b), 4);
    // у оставшейся — свой хозяин, и он может вести: он и остаётся, задачи Б — к нему
    const keep2 = addLead(t.db, { assigned: 3, patient: null, phone: '+998 93 111 22 33' });
    const lose2 = addLead(t.db, { assigned: 4, patient: null, phone: '931112233' });
    const b2 = task(t.db, lose2, 4);
    crmMergeLeads(t.db, { keep_id: keep2, merge_ids: [lose2] }, ADMIN);
    assert.equal(t.lead(keep2).assigned_to, 3);
    assert.equal(who(t.db, b2), 3);
  } finally { t.close(); }
});

test('слияние: журнал помнит прежних исполнителей задач', async () => {
  const t = await startCrmApp();
  try {
    const keep = addLead(t.db, { assigned: null, patient: null, phone: '+998 91 555 66 77' });
    const lose = addLead(t.db, { assigned: 3, patient: null, phone: '915556677' });
    const k = task(t.db, keep, 4, 'В на оставшейся');
    const a = task(t.db, lose, 3);
    const n = task(t.db, lose, null, 'Без исполнителя');
    crmMergeLeads(t.db, { keep_id: keep, merge_ids: [lose] }, ADMIN);
    // задача В на ничьей оставшейся — к новому хозяину; у влитой хозяин тот же
    // (А), её задачи не двигаются — как у карточки без смены оператора
    assert.deepEqual([who(t.db, k), who(t.db, a), who(t.db, n)], [3, 3, null]);
    const snap = JSON.parse(t.db.prepare('SELECT snapshot FROM crm_merge_log ORDER BY id DESC LIMIT 1').get().snapshot);
    assert.deepEqual(snap.kept.task_assignees, [[k, 4]]);
    assert.deepEqual(snap.merged[0].task_assignees, [[a, 3], [n, null]]);
  } finally { t.close(); }
});

test('R4/R10: карточку не передать тому, кто заявки вести не может (кассир, врач, уволенный, несуществующий) — задачи на месте', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare('UPDATE users SET is_active = 0 WHERE id = 4').run();
    for (const to of [9, 10, 4, 99999, 'abc']) {
      const rid = addLead(t.db, { assigned: 3 });
      const a = task(t.db, rid, 3);
      const r = await upd(t, 'head', rid, { assigned_to: to });
      assert.equal(r.status, 403, `передали ${JSON.stringify(to)}: ${r.text}`);
      assert.equal(r.json.error.message, OWNER_REFUSAL);
      assert.equal(t.lead(rid).assigned_to, 3);
      assert.equal(who(t.db, a), 3);
    }
    // и новую карточку на такого не завести
    const ins = await t.dbq('boss', { table: 'crm_requests', op: 'insert', values: { full_name: 'Новая', phone: '901234567', assigned_to: 9 } });
    assert.equal(ins.status, 403, ins.text);
    // руководителю и себе — можно
    const rid = addLead(t.db, { assigned: 3 });
    assert.equal((await upd(t, 'boss', rid, { assigned_to: 5 })).status, 200);
    assert.equal((await upd(t, 'head', rid, { assigned_to: 5 })).status, 200);
  } finally { t.close(); }
});

test('R5: роль с «CRM: просмотр» не предлагается, не назначается ответственным и карточку не получает', async () => {
  const t = await startCrmApp(seedViewer);
  try {
    const free = addLead(t.db, { assigned: null });
    const list = await t.rpc('crm_task_assignees', 'cc', { request_id: free });
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.json.data.some((p) => p.id === 6), 'наблюдатель в списке «Ответственный»');
    const ins = await t.dbq('cc', { table: 'crm_tasks', op: 'insert', values: { request_id: free, text: 'Т', assignee_id: 6 } });
    assert.equal(ins.status, 403, ins.text);
    assert.equal(ins.json.error.message, ASSIGNEE_REFUSAL);
    const rid = addLead(t.db, { assigned: 3 });
    const a = task(t.db, rid, 3);
    const pass = await upd(t, 'head', rid, { assigned_to: 6 });
    assert.equal(pass.status, 403, pass.text);
    assert.equal(pass.json.error.message, OWNER_REFUSAL);
    assert.equal(who(t.db, a), 3);
    // старая задача наблюдателя на ничьей карточке уходит к взявшему
    const old = task(t.db, free, 6, 'Старая задача наблюдателя');
    assert.equal((await upd(t, 'cc', free, { assigned_to: 3 })).status, 200);
    assert.equal(who(t.db, old), 3);
  } finally { t.close(); }
});

test('R6: держатель «осиротевшей» задачи не узнаёт, чья карточка, — любая смена исполнителя безликим отказом', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 4 });        // карточка Б
    const orphan = task(t.db, rid, 3, 'Старая задача А'); // задача А с прежних времён
    const probe = (x) => t.dbq('cc', { table: 'crm_tasks', op: 'update', values: { assignee_id: x }, filters: [{ col: 'id', op: 'eq', val: orphan }] });
    for (const x of [2, 4, 5, 1, 9]) {
      const r = await probe(x);
      assert.equal(r.status, 403, `проба ${x}: ${r.text}`);
      assert.equal(r.json.error.message, 'not allowed', `проба ${x} ответила не безлико`);
    }
    assert.equal(who(t.db, orphan), 3);
    // сохранить свою задачу (тот же исполнитель) и отметить «сделано» — можно
    assert.equal((await probe(3)).status, 200);
    const done = await t.dbq('cc', { table: 'crm_tasks', op: 'update', values: { done_at: '2026-10-09T10:00:00Z' }, filters: [{ col: 'id', op: 'eq', val: orphan }] });
    assert.equal(done.status, 200, done.text);
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
    // правка нескольких задач разом — то же правило
    const ids2 = t.db.prepare('SELECT id FROM crm_tasks WHERE request_id = ?').all(rid).map((x) => x.id);
    const bulk = await t.dbq('head', { table: 'crm_tasks', op: 'update', values: { assignee_id: 4 }, filters: [{ col: 'id', op: 'in', val: ids2 }] });
    assert.equal(bulk.status, 403);
    assert.equal(bulk.json.error.message, ASSIGNEE_REFUSAL);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_tasks WHERE assignee_id = 4').get().n, 0);
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

// CRM_UNIFY_V1 (задача 12) — вид «Задачи» читает задачу вместе с её карточкой
// (embed crm_requests). Ограничение заявок ложится в JOIN: задачу на карточке,
// которую человек не видит (старое поручение, orOwn), он получает, а карточку —
// пустой. Иначе через задачу раскрывалась бы чужая карточка.
test('crm_tasks + crm_requests(...): задача видна исполнителю, а карточка чужого оператора приходит пустой', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, name: 'Карточка А' });
    const own = addLead(t.db, { assigned: 4, name: 'Карточка Б' });
    task(t.db, rid, 4, 'Старое поручение Б');
    task(t.db, own, 4, 'Своя задача Б');
    // ровно TASK_LIST_SELECT вида (public/js/admin/views/crm-tasks.js; его сверяет crm-tasks-view.test.mjs)
    const cols = 'id, request_id, text, due_at, assignee_id, done_at, users(full_name), crm_requests(id, full_name, phone, status, assigned_to)';
    const r = await t.dbq('cc2', { table: 'crm_tasks', op: 'select', columns: cols, filters: [{ col: 'done_at', op: 'is', val: null }] });
    assert.equal(r.status, 200, r.text);
    const byText = Object.fromEntries(r.json.data.map((x) => [x.text, x]));
    assert.equal(r.json.data.length, 2);
    assert.equal(byText['Старое поручение Б'].crm_requests, null, 'через задачу раскрыта чужая карточка');
    assert.equal(byText['Своя задача Б'].crm_requests.full_name, 'Карточка Б');
    assert.equal(byText['Своя задача Б'].users.full_name, 'Оператор Б');
    // администратор видит обе карточки
    const a = await t.dbq('boss', { table: 'crm_tasks', op: 'select', columns: cols, filters: [] });
    assert.ok(a.json.data.every((x) => x.crm_requests && x.crm_requests.id), 'администратору карточка не пришла');
  } finally { t.close(); }
});
