// CRM_UNIFY_V1 — общий стенд серверных тестов плана docs/plans/2026-10-09-crm-unify.md:
// настоящая база (все миграции), настоящее приложение и вход под ролями.
// Не тестовый файл — его импортируют (как crm-harness.mjs у клиента).
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
/** Местный день со сдвигом: 'YYYY-MM-DD'. */
export function localDay(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Местное время дня → ISO (UTC). */
export function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
export const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// id, логин, имя, роль, своя роль клиники
export const USERS = [
  [1, 'boss', 'Админ', 'admin', null],
  [2, 'reg', 'Регистратура', 'registrar', null],
  [3, 'cc', 'Оператор А', 'callcenter', null],
  [4, 'cc2', 'Оператор Б', 'callcenter', null],
  [5, 'head', 'Руководитель КЦ', 'callcenter', 'head_cc'],
  [9, 'kassa', 'Кассир', 'cashier', null],
  [10, 'doc', 'Иванов', 'doctor', null],
];

export async function startCrmApp(seed = () => {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, custom_role_code) VALUES (?,?,?,?,?,?,?)');
  for (const [id, login, name, role, custom] of USERS) u.run(id, login, hashPassword('password1'), name, role, role === 'doctor' ? 1 : 0, custom);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('head_cc', 'Руководитель колл-центра', 'callcenter')").run();
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('head_cc', JSON.stringify({ sections: ['crm'], levels: { crm: 'editor' }, grants: { 'crm.all': 'edit' } }));
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (30,'Консультация терапевта',100000,'consultation',1,30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент Тест','+998 90 909 26 38')").run();
  seed(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const [, login] of USERS) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: login, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + login);
    cookies[login] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: res.status, text, json };
  };
  return {
    db, server,
    rpc: (name, who, args) => call('/api/rpc/' + name, who, args),
    dbq: (who, desc) => call('/api/db', who, desc),
    lead: (id) => db.prepare('SELECT * FROM crm_requests WHERE id = ?').get(id),
    close: () => { server.close(); db.close(); },
  };
}

/** Карточка напрямую в базу. */
export function addLead(db, { status = 'in_process', patient = 77, phone = '+998 90 909 26 38', assigned = null,
  date = null, name = 'Лид', updated = null } = {}) {
  const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, status, patient_id, assigned_to, scheduled_date)
                                VALUES (?,?,?,?,?,?)`).run(name, phone, status, patient, assigned, date).lastInsertRowid);
  if (updated) db.prepare('UPDATE crm_requests SET updated_at = ?, created_at = ? WHERE id = ?').run(updated, updated, id);
  return id;
}
export function addLine(db, rid, { svc = 40, day = null, doctor = null, visit = null } = {}) {
  return Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, visit_id)
                            VALUES (?,?,?,'pending',?,?)`).run(rid, svc, day, doctor, visit).lastInsertRowid);
}
export const linesOf = (db, rid) => db.prepare(`SELECT id, service_id, scheduled_date, status, visit_id FROM crm_request_services
                                                WHERE request_id = ? AND status <> 'cancelled' ORDER BY id`).all(rid);
