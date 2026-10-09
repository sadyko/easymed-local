// CRM_UNIFY_V1 — ФИНАЛЬНОЕ РЕВЬЮ (задачи и права): находки «FINDING tasks».
//
//   1. upsert в crm_tasks обходил правило исполнителя (Р17) и метки created_by:
//      экран upsert задач не делает — дверь /api/db его не принимает вовсе
//      (403, безликий отказ).
//   2. Роль БЕЗ раздела CRM считалась «ведущей заявки» (canEditCrm: уровень null
//      ≠ 'viewer'): ей предлагали задачи и отдавали карточки, хотя экрана CRM у
//      неё нет. Теперь то же правило, что у меню (permissions.js
//      isModuleAllowed('crm')): раздел CRM выдан и не «просмотр»; администратор
//      — как прежде. Штатные регистратура и колл-центр — как прежде.
//   3. Держатель задачи потерял право вести карточку («crm.all» сняли, роль —
//      «просмотр», уволен) — задачи уходят хозяину карточки
//      (rehomeOrphanTasks): при запуске, раз в час и сразу после правки прав
//      ролей через /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { hashPassword } from '../services/auth.js';
import { canWorkLead, canOwnLead, staffById, staffCanWorkLead, rehomeOrphanTasks, scheduleCrmTaskRehome } from '../services/crm/tasks-follow.js';
import { canEditCrm } from '../services/crm/visibility.js';

const task = (db, rid, assignee, due = '2026-01-01T09:00:00Z') =>
  Number(db.prepare('INSERT INTO crm_tasks (request_id, text, due_at, assignee_id) VALUES (?,?,?,?)')
    .run(rid, 'Перезвонить', due, assignee).lastInsertRowid);
const who = (db, id) => db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = ?').get(id).assignee_id;

function seedViewer(db) {
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('cc_view', 'КЦ просмотр', 'callcenter')").run();
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('cc_view', JSON.stringify({ sections: ['crm'], levels: { crm: 'viewer' } }));
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, custom_role_code) VALUES (?,?,?,?,?,?,?)')
    .run(6, 'viewer', hashPassword('password1'), 'Наблюдатель', 'callcenter', 0, 'cc_view');
}
const NO_CRM_REGISTRAR = JSON.stringify({ sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } });

// ── 1. upsert в crm_tasks ────────────────────────────────────────────────

test('upsert в crm_tasks не принимается никем — безликий отказ 403, задачи не появляется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    for (const [by, assignee] of [['head', 9], ['head', 4], ['boss', 10], ['boss', 3], ['cc', 3], ['cc', 9]]) {
      const up = await t.dbq(by, { table: 'crm_tasks', op: 'upsert', onConflict: 'id',
        values: { request_id: rid, text: `upsert ${by} ${assignee}`, due_at: '2026-01-01T09:00:00Z', assignee_id: assignee } });
      assert.equal(up.status, 403, `${by} → ${assignee}: ${up.text}`);
      assert.equal(up.json.error && up.json.error.message, 'not allowed', 'отказ не безликий: ' + up.text);
    }
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, 0, 'upsert всё-таки завёл задачу');
    // Вставка и правка — по-прежнему: кассира, врача, чужого оператора — отказ.
    for (const bad of [9, 10, 4]) {
      const ins = await t.dbq('head', { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'x', due_at: '2026-01-01T09:00:00Z', assignee_id: bad } });
      assert.equal(ins.status, 403, 'insert ' + bad + ' ' + ins.text);
    }
    const ok = await t.dbq('head', { table: 'crm_tasks', op: 'insert', values: { request_id: rid, text: 'ok', due_at: '2026-01-01T09:00:00Z', assignee_id: 3 } });
    assert.equal(ok.status, 200, ok.text);
  } finally { t.close(); }
});

test('upsert в crm_requests с хозяином, который заявки вести не может, — отказ', async () => {
  const t = await startCrmApp();
  try {
    const up = await t.dbq('head', { table: 'crm_requests', op: 'upsert', onConflict: 'id', values: { full_name: 'X', phone: '1', status: 'in_process', assigned_to: 9 } });
    assert.equal(up.status, 403, up.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0);
  } finally { t.close(); }
});

// ── 2. Кто «ведёт заявки»: раздел CRM выдан и не «просмотр» ──────────────

test('штатные роли — как прежде: администратор, регистратура, колл-центр, руководитель КЦ ведут заявки', async () => {
  const t = await startCrmApp(seedViewer);
  try {
    for (const id of [1, 2, 3, 4, 5]) assert.equal(canEditCrm(t.db, staffById(t.db, id)), true, 'id ' + id);
    assert.equal(canEditCrm(t.db, staffById(t.db, 6)), false, '«CRM: просмотр» ведёт заявки');
    // Своя роль клиники, ещё НЕ настроенная (строки прав нет), — права основы.
    t.db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('reg2', 'Старший регистратор', 'registrar')").run();
    t.db.prepare("UPDATE users SET custom_role_code = 'reg2' WHERE id = 2").run();
    assert.equal(canEditCrm(t.db, staffById(t.db, 2)), true, 'ненастроенная своя роль отняла CRM у регистратуры');
    // Администратор основной ролью врача, «admin» — дополнительной (ADMIN_DOCTOR_V1).
    t.db.prepare("UPDATE users SET extra_roles = '[\"admin\"]' WHERE id = 10").run();
    assert.equal(canEditCrm(t.db, staffById(t.db, 10)), true, 'администратор-врач перестал вести заявки');
  } finally { t.close(); }
});

test('регистратура БЕЗ раздела CRM заявки не ведёт: не предлагается, ни карточку, ни задачу не получает, сама не пишет', async () => {
  const t = await startCrmApp((db) => db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'").run(NO_CRM_REGISTRAR));
  try {
    const reg = staffById(t.db, 2);
    assert.equal(canEditCrm(t.db, reg), false);
    assert.equal(canWorkLead(t.db, reg, null), false, 'роль без экрана CRM «может вести» ничью карточку');
    assert.equal(canOwnLead(t.db, 2), false);
    const free = addLead(t.db, { assigned: null });
    const list = await t.rpc('crm_task_assignees', 'head', { request_id: free });
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.json.data.some((p) => p.id === 2), 'регистратура без CRM в списке «Ответственный»: ' + list.text);
    assert.ok(list.json.data.some((p) => p.id === 3), 'колл-центр пропал из списка');
    const rid = addLead(t.db, { assigned: 3 });
    const tk = task(t.db, rid, 3);
    const give = await t.dbq('head', { table: 'crm_requests', op: 'update', values: { assigned_to: 2 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(give.status, 403, give.text);
    assert.deepEqual([t.lead(rid).assigned_to, who(t.db, tk)], [3, 3]);
    const ins = await t.dbq('head', { table: 'crm_tasks', op: 'insert', values: { request_id: free, text: 'x', due_at: '2026-01-01T09:00:00Z', assignee_id: 2 } });
    assert.equal(ins.status, 403, ins.text);
    const own = await t.dbq('reg', { table: 'crm_requests', op: 'update', values: { status: 'recall' }, filters: [{ col: 'id', op: 'eq', val: free }] });
    assert.notEqual(own.status, 200, 'роль без раздела CRM правит заявки: ' + own.text);
  } finally { t.close(); }
});

// ── 3. Задачи того, кто потерял право вести карточку, — хозяину ─────────

test('«crm.all» сняли, роль — «просмотр», уволен: задачи держателя уходят хозяину карточки; повтор — ничего', async () => {
  for (const lose of ['grant', 'viewer', 'inactive']) {
    const t = await startCrmApp(seedViewer);
    try {
      const rid = addLead(t.db, { assigned: 3 });
      const headTask = task(t.db, rid, 5);
      const own = task(t.db, rid, 3);
      const done = Number(t.db.prepare("INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at) VALUES (?, 'закрыта', '2026-01-01T09:00:00Z', 5, '2026-01-02T09:00:00Z')").run(rid).lastInsertRowid);
      assert.equal(rehomeOrphanTasks(t.db), 0, 'руководитель ведёт карточку — задача его');
      if (lose === 'grant') {
        t.db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'head_cc'")
          .run(JSON.stringify({ sections: ['crm'], levels: { crm: 'editor' }, grants: {} }));
      } else if (lose === 'viewer') {
        t.db.prepare("UPDATE users SET custom_role_code = 'cc_view' WHERE id = 5").run();
      } else {
        t.db.prepare('UPDATE users SET is_active = 0 WHERE id = 5').run();
      }
      assert.equal(staffCanWorkLead(t.db, 5, 3), false, lose);
      const stamp = t.lead(rid).updated_at;
      assert.equal(rehomeOrphanTasks(t.db), 1, lose);
      assert.deepEqual([who(t.db, headTask), who(t.db, own), who(t.db, done)], [3, 3, 5],
        `${lose}: задача не ушла хозяину (или тронута закрытая)`);
      assert.equal(t.lead(rid).updated_at, stamp, 'перенос задач освежил карточку');
      assert.equal(rehomeOrphanTasks(t.db), 0, 'повтор снова что-то двигает');
    } finally { t.close(); }
  }
});

test('хозяин карточки сам вести её не может (уволен) — задачи на месте, пока руководитель не передаст карточку', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const tk = task(t.db, rid, 3);
    t.db.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
    assert.equal(rehomeOrphanTasks(t.db), 0);
    assert.equal(who(t.db, tk), 3);
    const give = await t.dbq('head', { table: 'crm_requests', op: 'update', values: { assigned_to: 4 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(give.status, 200, give.text);
    assert.equal(who(t.db, tk), 4, 'задача не пошла за карточкой к новому оператору');
  } finally { t.close(); }
});

test('правка прав роли через /api/db сразу отдаёт задачи хозяину карточки', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const headTask = task(t.db, rid, 5);
    const r = await t.dbq('boss', { table: 'role_permissions', op: 'update',
      values: { permissions: JSON.stringify({ sections: ['crm'], levels: { crm: 'editor' }, grants: {} }) },
      filters: [{ col: 'role', op: 'eq', val: 'head_cc' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(who(t.db, headTask), 3, 'задача осталась у руководителя без «crm.all» до следующего часа');
  } finally { t.close(); }
});

test('rehomeOrphanTasks: 20 000 карточек и 5 000 задач — быстро и один раз', async () => {
  const t = await startCrmApp();
  try {
    const db = t.db;
    const insLead = db.prepare("INSERT INTO crm_requests (full_name, phone, status, assigned_to) VALUES ('Л', '', 'in_process', ?)");
    const insTask = db.prepare("INSERT INTO crm_tasks (request_id, text, due_at, assignee_id) VALUES (?, 'т', '2026-01-01T09:00:00Z', ?)");
    const ids = [];
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) ids.push(Number(insLead.run(i % 3 === 0 ? null : (i % 2 ? 3 : 4)).lastInsertRowid));
      for (let i = 0; i < 5000; i++) {
        const rid = ids[(i * 4) % ids.length];
        // свой оператор, руководитель, чужой оператор, кассир, без исполнителя
        insTask.run(rid, [3, 5, 4, 9, null][i % 5]);
      }
    })();
    const t0 = Date.now();
    const moved = rehomeOrphanTasks(db);
    const ms = Date.now() - t0;
    assert.ok(moved > 0, 'нечего было двигать — тест не проверяет ничего');
    assert.ok(ms < 3000, `перенос занял ${ms} мс`);
    // Ни одной открытой задачи на карточке с хозяином у того, кто её вести не может.
    const left = db.prepare(`SELECT t.assignee_id a, r.assigned_to o FROM crm_tasks t JOIN crm_requests r ON r.id = t.request_id
                              WHERE t.done_at IS NULL AND r.assigned_to IS NOT NULL`).all()
      .filter((x) => x.a == null || !staffCanWorkLead(db, x.a, x.o));
    assert.deepEqual(left, []);
    const t1 = Date.now();
    assert.equal(rehomeOrphanTasks(db), 0);
    assert.ok(Date.now() - t1 < 3000);
  } finally { t.close(); }
});

test('scheduleCrmTaskRehome: проход сразу при запуске, таймер не держит процесс', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const tk = task(t.db, rid, 9);
    const h = scheduleCrmTaskRehome(t.db, { everyMs: 3600 * 1000 });
    try {
      assert.equal(who(t.db, tk), 3, 'проход при запуске не отдал задачу кассира хозяину');
      assert.equal(typeof h.hasRef === 'function' ? h.hasRef() : false, false, 'таймер держит процесс');
    } finally { clearInterval(h); }
  } finally { t.close(); }
});
