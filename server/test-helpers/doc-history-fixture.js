// DOC_HISTORY_V1 — стенд проверок истории изменений документа приёма
// (routes/doc-history-*.test.js): клиника с врачами, главным врачом, медсестрой,
// регистратурой и лаборантом, визит со строками и живой сервер.
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { notesBaseOf, NOTES_BASE_KEY } from '../services/domain/cabinet-notes.js';

export const BOSS = 1, DOC = 3, DOC2 = 4, HDOC = 5, NURSE = 6, REG = 7, LAB = 8;
export const DOCN = (current, history = [], extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history, ...extra });
export const draft = (fields, savedAt = new Date().toISOString()) => ({ kind: 'draft', savedAt, fields, tab: 't1' });
export const signed = (fields, savedAt) => ({ kind: 'signed', savedAt, fields, by: DOC, byName: 'Иванова А.' });
export const OLD_SIGNED = signed({ chief_complaint: 'Головная боль' }, '2026-10-01T08:00:00.000Z');
export const IMG = (ch) => 'data:image/jpeg;base64,' + ch.repeat(60 * 1024);

/**
 * Строки визита: 1 — новый документ врача DOC; 2 — подписан до журнала; 3 — процедура
 * с документом; 4 — строка врача DOC2; 5 — без исполнителя; 6 — процедура без документа.
 * cutDoctor — роли «врач» закрыты данные пациентов (только склад).
 */
export async function startDocHistoryServer({ cutDoctor = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, is_doctor, is_active, must_change_password)
                        VALUES (?,?,?,?,?,?,?,1,0)`);
  const pw = hashPassword('password1');
  u.run(BOSS, 'boss', pw, 'Петров П.', 'admin', '[]', 0);
  u.run(DOC, 'doc', pw, 'Иванова А.', 'doctor', '[]', 1);
  u.run(DOC2, 'doc2', pw, 'Сидоров С.', 'doctor', '[]', 1);
  u.run(HDOC, 'hdoc', pw, 'Главврач Г.', 'doctor', '["head_doctor"]', 1);
  u.run(NURSE, 'nurse', pw, 'Медсестра Н.', 'nurse', '[]', 0);
  u.run(REG, 'reg', pw, 'Регистратор Р.', 'registrar', '[]', 0);
  u.run(LAB, 'lab', pw, 'Лаборант Л.', 'lab', '[]', 0);
  if (cutDoctor) db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('doctor', JSON.stringify({ sections: ['inventory'], levels: {}, grants: {} }));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Пациент')").run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (90, 'Процедурный', 'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1, 'Консультация', 100000, 'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type, department_id) VALUES (2, 'Инъекция', 50000, 'procedure', 90)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-11-18T07:00:00Z', 'arrived')").run();
  const line = db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes)
                           VALUES (?, 1, ?, ?, 1, 100000, 100000, ?, ?)`);
  line.run(1, 1, DOC, 'in_progress', null);
  line.run(2, 1, DOC, 'completed', DOCN({ chief_complaint: 'Головная боль' }, [OLD_SIGNED]));
  line.run(3, 2, DOC, 'queued', DOCN({ chief_complaint: 'Инъекция' }, [OLD_SIGNED]));
  line.run(4, 1, DOC2, 'in_progress', null);
  line.run(5, 1, null, 'in_progress', null);
  line.run(6, 2, null, 'queued', null);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tabs = new Map();   // вход «от имени»: номер, который шлёт вкладка (X-Em-Act-As)
  const call = async (cookie, method, path, body) => {
    const tab = cookie && tabs.has(cookie) ? { 'X-Em-Act-As': String(tabs.get(cookie)) } : {};
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...tab },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const login = async (username) => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
    assert.equal(res.status, 200, 'вход ' + username);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const actAs = async (cookie, userId) => {
    const r = await call(cookie, 'POST', '/api/auth/act-as', { user_id: userId });
    if (r.status === 200) tabs.set(cookie, r.json.act_as_id);
    return r;
  };
  const notesOf = (id) => db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(id).notes;
  /** Запись документа строки так, как пишет кабинет: с основой (сравнить и заменить). */
  const write = (cookie, id, notes, extra = {}) => call(cookie, 'POST', '/api/db', {
    table: 'visit_services', op: 'update', values: { notes, ...extra, [NOTES_BASE_KEY]: notesBaseOf(notesOf(id)) }, filters: [{ col: 'id', op: 'eq', val: id }],
  });
  const revs = (id) => db.prepare('SELECT * FROM visit_document_revisions WHERE visit_service_id = ? ORDER BY rev_no').all(id);
  const rpc = (cookie, name, args) => call(cookie, 'POST', '/api/rpc/' + name, args);
  const close = () => { server.close(); db.close(); };
  return { db, base, call, login, actAs, notesOf, write, revs, rpc, close };
}
