// CRM_HEAD_MERGE_TAGS_V1 — разбор ревью слияния дублей (2026-09-25).
//
// I1 — сливаются только карточки одного номера (иначе это удаление в обход
//      права «удалять — только администратор»).
// I2 — живая заявка не хоронится в закрытой: случай из базы клиники, где
//      старая «Пришёл» (№19) поглощала свежую заявку в работе (№337).
// I3 — разные имена на одном номере: предупреждение и имя в приписке.
// M1 — задача, переехавшая на карточку другого оператора, видна исполнителю.
// M3 — запрет разных пациентов — по ВЫБРАННЫМ карточкам, а не по всей группе.
// I4 — поиск оператора не читает права на каждую строку.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { crmMergeLeads, crmDuplicateGroups } from './crm-merge.js';
import { crmSearch, crmLeadsByPhone } from './crm-leads.js';

const BOSS = { id: 1, role: 'admin', extra_roles: [] };
const OP = { id: 2, role: 'callcenter', extra_roles: [] };
const OP2 = { id: 5, role: 'callcenter', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin');
  u.run(2, 'op', 'x', 'Оператор Лола', 'callcenter');
  u.run(5, 'op2', 'x', 'Оператор Зара', 'callcenter');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (500, 'Каримова Азиза'), (501, 'Каримов Бахтиёр')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (77, 'Консультация', 100000), (78, 'УЗИ', 150000)").run();
  db.prepare("INSERT INTO crm_tags (key, label, color) VALUES ('vip', 'VIP', 'purple')").run();
  return db;
}
const lead = (db, o) => Number(db.prepare(`INSERT INTO crm_requests
  (id, full_name, phone, status, source, note, patient_id, assigned_to, created_by, created_at)
  VALUES (@id, @full_name, @phone, @status, @source, @note, @patient_id, @assigned_to, @created_by, @created_at)`)
  .run({ id: null, full_name: 'Каримова Азиза', phone: '+998 90 111 22 33', status: 'in_process', source: 'call', note: '',
    patient_id: null, assigned_to: null, created_by: null, created_at: '2026-09-14T10:00:00Z', ...o }).lastInsertRowid);

test('I1: карточки разных номеров не сливаются — 409, ничего не удалено', () => {
  const db = seed();
  try {
    const a = lead(db, { phone: '901112233' });
    const b = lead(db, { phone: '909998877' });
    const c = lead(db, { phone: '12' });
    const d = lead(db, { phone: '12' });
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, BOSS), (e) => e.status === 409 && /одним и тем же номером/.test(e.message));
    assert.throws(() => crmMergeLeads(db, { keep_id: c, merge_ids: [d] }, BOSS), (e) => e.status === 409, 'обрывок номера сошёл за «один номер»');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 4);
    // Один номер в разной записи — можно.
    const e = lead(db, { phone: '+998 90 111 22 33' });
    assert.doesNotThrow(() => crmMergeLeads(db, { keep_id: a, merge_ids: [e] }, BOSS));
  } finally { db.close(); }
});

test('I2: №19 «Пришёл» и №337 в работе — предложена 337; влить 337 в 19 нельзя; 19 вливается в 337 без переписывания истории', () => {
  const db = seed();
  try {
    lead(db, { id: 19, status: 'came', patient_id: 500, created_at: '2026-01-10T09:00:00Z', created_by: 1, note: 'Была на УЗИ', source: 'website' });
    db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (19, 78, '2026-01-11', 'done')").run();
    db.prepare("INSERT INTO crm_request_tags (request_id, tag_key) VALUES (19, 'vip')").run();
    lead(db, { id: 337, status: 'recall', assigned_to: 2, created_at: '2026-09-20T08:00:00Z', created_by: 2, source: 'call' });
    db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (337, 77, '2026-09-30', 'pending')").run();

    const g = crmDuplicateGroups(db, {}, BOSS).groups[0];
    assert.equal(g.suggested_id, 337, 'предложена закрытая карточка, а живая заявка рядом');
    assert.equal(g.cards.find((c) => c.id === 337).stage_kind, 'open');

    assert.throws(() => crmMergeLeads(db, { keep_id: 19, merge_ids: [337] }, BOSS),
      (e) => e.status === 409 && /в работе/.test(e.message), 'живую заявку похоронили в закрытой');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2);

    const res = crmMergeLeads(db, { keep_id: 337, merge_ids: [19] }, BOSS);
    assert.equal(res.lead.status, 'recall', 'заявка в работе ушла из живых колонок');
    assert.equal(res.lead.created_at, '2026-09-20T08:00:00Z', 'дата обращения переписана — отчёты прошлых месяцев поменялись бы');
    assert.equal(res.lead.created_by, 2);
    assert.equal(res.lead.source, 'call');
    assert.equal(res.lead.patient_id, 500, 'пациент закрытой карточки не перешёл');
    assert.equal(res.lead.assigned_to, 2);
    assert.match(res.lead.note, /^Была на УЗИ — из заявки №19 от \d\d\.\d\d, «Каримова Азиза»$/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE request_id = 337').get().n, 2, 'услуги закрытой не переехали');
    assert.equal(res.lead.service_id, 77, 'зеркало — первая живая строка');
    assert.deepEqual(db.prepare('SELECT tag_key FROM crm_request_tags WHERE request_id = 337').all().map((r) => r.tag_key), ['vip']);
  } finally { db.close(); }
});

test('I3: разные имена — флаг группы и имя влитой карточки в приписке, даже без заметки', () => {
  const db = seed();
  try {
    const a = lead(db, { full_name: 'Каримова Азиза', created_at: '2026-09-10T08:00:00Z' });
    const b = lead(db, { full_name: 'Каримов Бахтиёр', created_at: '2026-09-11T08:00:00Z' });
    lead(db, { full_name: '+998 90 111 22 33', created_at: '2026-09-12T08:00:00Z' });
    const g = crmDuplicateGroups(db, {}, BOSS).groups[0];
    assert.equal(g.names_differ, true);
    const res = crmMergeLeads(db, { keep_id: b, merge_ids: [a] }, BOSS);
    assert.match(res.lead.note, /^— из заявки №\d+ от \d\d\.\d\d, «Каримова Азиза»$/, 'имя второго человека пропало бесследно');
    // Одинаковые имена в разной записи — не повод тревожить.
    const db2 = seed();
    lead(db2, { full_name: 'Буронова  Феруза' });
    lead(db2, { full_name: 'буронова феруза' });
    assert.equal(crmDuplicateGroups(db2, {}, BOSS).groups[0].names_differ, false);
    db2.close();
  } finally { db.close(); }
});

test('M3: в группе есть карточка другого пациента — остальные сливаются, если её не выбирать', () => {
  const db = seed();
  try {
    const a = lead(db, { patient_id: 500 });
    const b = lead(db, {});
    const c = lead(db, { patient_id: 501, full_name: 'Каримов Бахтиёр' });
    assert.equal(crmDuplicateGroups(db, {}, BOSS).groups[0].conflict, true);
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b, c] }, BOSS), (e) => e.status === 409);
    crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, BOSS);
    assert.deepEqual(db.prepare('SELECT id FROM crm_requests ORDER BY id').all().map((r) => r.id), [a, c]);
  } finally { db.close(); }
});

test('M1: задача переехала на карточку другого оператора — исполнитель её видит и закрывает, чужие — нет', () => {
  const db = seed();
  try {
    const keep = lead(db, { assigned_to: 5 });
    const gone = lead(db, { assigned_to: 2 });
    const t = Number(db.prepare("INSERT INTO crm_tasks (request_id, text, assignee_id) VALUES (?, 'Перезвонить', 2)").run(gone).lastInsertRowid);
    const other = Number(db.prepare("INSERT INTO crm_tasks (request_id, text, assignee_id) VALUES (?, 'Задача Зары', 5)").run(keep).lastInsertRowid);
    crmMergeLeads(db, { keep_id: keep, merge_ids: [gone] }, BOSS);
    const run = (desc, user) => { const q = compile(desc, user, { db }); return desc.op === 'select' ? db.prepare(q.sql).all(...q.params) : db.prepare(q.sql).run(...q.params).changes; };
    const seen = run({ op: 'select', table: 'crm_tasks', columns: 'id, assignee_id', filters: [] }, OP).map((r) => r.id);
    assert.deepEqual(seen, [t], 'исполнитель потерял свою задачу или увидел чужую');
    assert.equal(run({ op: 'update', table: 'crm_tasks', values: { done_at: '2026-09-25T10:00:00Z' }, filters: [{ col: 'id', op: 'eq', val: t }] }, OP), 1);
    assert.equal(run({ op: 'update', table: 'crm_tasks', values: { done_at: '2026-09-25T10:00:00Z' }, filters: [{ col: 'id', op: 'eq', val: other }] }, OP), 0);
    // Новую задачу на чужую карточку оператор по-прежнему не поставит.
    const q = compile({ op: 'insert', table: 'crm_tasks', values: { request_id: keep, text: 'x', assignee_id: 2 } }, OP, { db });
    assert.equal(db.prepare(q.sql).run(...q.params).changes, 0);
    assert.equal(run({ op: 'select', table: 'crm_tasks', columns: 'id', filters: [] }, OP2).length, 2);
  } finally { db.close(); }
});

// I4 — право «видит всё» читается из role_permissions несколькими запросами.
// Поиск по тысяче карточек не должен повторять их на каждую строку.
test('I4: поиск и проверка дубля читают права один раз на запрос, а не на строку', () => {
  const db = seed();
  try {
    const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, assigned_to) VALUES (?, '901112233', 'in_process', ?)");
    for (let i = 0; i < 400; i++) ins.run('Лид ' + i, i % 3 === 0 ? 5 : (i % 3 === 1 ? 2 : null));
    const real = db.prepare.bind(db);
    let grantReads = 0;
    db.prepare = (sql) => { if (/role_permissions/.test(sql)) grantReads++; return real(sql); };
    const found = crmSearch(db, { q: '901112233' }, OP);
    const searchReads = grantReads;
    grantReads = 0;
    const dup = crmLeadsByPhone(db, { phone: '901112233' }, OP);
    db.prepare = real;
    assert.ok(found.length > 0 && found.length <= 200);
    assert.ok(found.every((r) => r.assigned_to == null || r.assigned_to === 2), 'поиск отдал чужую заявку');
    assert.ok(searchReads <= 10, 'поиск читает права на каждую строку: ' + searchReads + ' обращений к role_permissions');
    assert.ok(grantReads <= 10, 'проверка дубля читает права на каждую строку: ' + grantReads);
    assert.equal(dup[dup.length - 1].foreign, true);
  } finally { db.close(); }
});
