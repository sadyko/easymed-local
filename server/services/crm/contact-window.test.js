// CRM_UNIFY_V1 — ОКНО ПОВТОРНОГО ОБРАЩЕНИЯ (решение владельца 4, Р2–Р5): одно
// правило для звонка (lead-from-call.js), записи (visit-link.js, шаг E), стойки
// (deskCloses), ожидания прихода (waitsForDay) и правила прихода (settleLineless).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { contactDecision, firstStageKey, reopenLead, leadInWindow, inWindowSql, windowArg } from './contact-window.js';
import { saveConfig } from './config.js';

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
/** Карточка с последним движением `agoH` часов назад (updated_at; created_at — давно). */
const lead = (db, status, agoH, { created = null } = {}) => {
  const id = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Л', '998900000000', ?)").run(status).lastInsertRowid);
  db.prepare('UPDATE crm_requests SET updated_at = ?, created_at = ? WHERE id = ?').run(agoH == null ? '' : iso(agoH), created ?? iso(9999), id);
  return id;
};
const decide = (db, ids) => { const d = contactDecision(db, ids); return [d.action, d.lead ? d.lead.id : null]; };

test('открытая в окне — та же; открытая после окна — вернуть в начало; закрытая в окне — без новой; иначе новая', () => {
  const db = fresh();
  const a = lead(db, 'recall', 10);
  assert.deepEqual(decide(db, [a]), ['same', a]);
  const b = lead(db, 'recall', 24 * 21);
  assert.deepEqual(decide(db, [b]), ['reopen', b]);
  const c = lead(db, 'came', 5);
  assert.deepEqual(decide(db, [c]), ['closed', c]);
  // CRM_UNIFY_V1 (ревью задач 5–6, I-3) — ОБНОВЛЕНО НАМЕРЕННО: сидовая «Не пришёл»
  // не закрытая — в окне та же, после окна возвращается в начало.
  const d = lead(db, 'no_show', 5);
  assert.deepEqual(decide(db, [d]), ['same', d], '«Не пришёл» в окне — та же карточка');
  const d2 = lead(db, 'no_show', 500);
  assert.deepEqual(decide(db, [d2]), ['reopen', d2]);
  const lost = lead(db, 'stopped', 5);
  assert.deepEqual(decide(db, [lost]), ['closed', lost], '«Отказ» — закрытая');
  const e = lead(db, 'came', 100);
  assert.deepEqual(decide(db, [e]), ['new', null]);
  assert.deepEqual(decide(db, []), ['new', null]);
  db.close();
});

test('открытая важнее закрытой, даже если закрытая свежее; из открытых — с последним движением', () => {
  const db = fresh();
  const won = lead(db, 'came', 1);
  const live = lead(db, 'recall', 10);
  assert.deepEqual(decide(db, [won, live]), ['same', live]);
  const stale = lead(db, 'in_process', 500);
  assert.deepEqual(decide(db, [stale, live, won]), ['same', live], 'выбрана не самая свежая открытая');
  const db2 = fresh();
  const won2 = lead(db2, 'came', 1);
  const old2 = lead(db2, 'recall', 500);
  assert.deepEqual(decide(db2, [won2, old2]), ['reopen', old2], 'давняя открытая карточка проиграла свежей закрытой');
  db.close(); db2.close();
});

test('окно — из настройки «CRM-канбан»; последнее движение — updated_at, без него — created_at', () => {
  const db = fresh();
  const a = lead(db, 'recall', 30);
  assert.deepEqual(decide(db, [a]), ['same', a]);
  saveConfig(db, { settings: { window_hours: 24 } });
  assert.deepEqual(decide(db, [a]), ['reopen', a]);
  const b = lead(db, 'recall', null, { created: iso(2) });   // updated_at пуст — считается created_at
  assert.equal(leadInWindow(db, b), true);
  assert.equal(leadInWindow(db, a), false);
  assert.equal(leadInWindow(db, a, 48), true, 'окно, переданное явно, не учтено');
  db.close();
});

test('одно SQL-правило: inWindowSql + windowArg', () => {
  const db = fresh();
  const a = lead(db, 'recall', 71);
  const b = lead(db, 'recall', 73);
  const q = db.prepare(`SELECT id FROM crm_requests r WHERE ${inWindowSql('r')} ORDER BY id`);
  assert.deepEqual(q.all(windowArg(72)).map((r) => r.id), [a]);
  assert.deepEqual(q.all(windowArg(80)).map((r) => r.id), [a, b]);
  assert.equal(windowArg(0), '-72 hours', 'пустое окно — по умолчанию 72');
  db.close();
});

test('вернуть в начало — первая открытая ВИДИМАЯ колонка; отметка движения обновляется; закрытую не трогает', () => {
  const db = fresh();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'in_process'").run();
  assert.equal(firstStageKey(db), 'recall');
  const id = lead(db, 'approved', 500);
  const before = db.prepare('SELECT updated_at FROM crm_requests WHERE id = ?').get(id).updated_at;
  assert.equal(reopenLead(db, id), true);
  const r = db.prepare('SELECT status, updated_at FROM crm_requests WHERE id = ?').get(id);
  assert.equal(r.status, 'recall');
  assert.ok(r.updated_at > before, 'возврат не отмечен движением — окно не начнётся заново');
  const missed = lead(db, 'no_show', 500);   // CRM_UNIFY_V1 (ревью, I-3) — «Не пришёл» возвращается
  assert.equal(reopenLead(db, missed), true);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(missed).status, 'recall');
  const won = lead(db, 'came', 500);
  assert.equal(reopenLead(db, won), false);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(won).status, 'came', 'закрытая карточка открылась');
  db.close();
});

test('нет ни одной открытой видимой колонки — вернуть некуда: карточка остаётся как была', () => {
  const db = fresh();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE kind = 'open'").run();
  assert.equal(firstStageKey(db), null);
  const id = lead(db, 'recall', 500);
  assert.equal(reopenLead(db, id), false);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(id).status, 'recall');
  db.close();
});
