// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — слияние дублей заявок CRM.
//
// Проверяется то, что сказано владельцу: услуги, задачи, заметки и метки
// переезжают в оставшуюся карточку, а не уходят каскадом вместе с влитыми;
// ступень — самая продвинутая; дата/источник/звонок — самой ранней; разные
// пациенты не сливаются; сливают администратор и руководитель колл-центра;
// всё — одной транзакцией с записью в журнале.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmMergeLeads, crmDuplicateGroups, stageRanker, suggestSurvivor } from './crm-merge.js';
import { listStages } from '../crm/config.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const BOSS = { id: 1, role: 'admin', extra_roles: [] };
const OP = { id: 2, role: 'callcenter', extra_roles: [] };
const HEAD = { id: 3, role: 'callcenter', extra_roles: [], custom_role_code: 'head_cc' };
const DOC_HEAD = { id: 4, role: 'doctor', extra_roles: [], custom_role_code: 'doc_head' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', null);
  u.run(2, 'op', 'x', 'Оператор', 'callcenter', null);
  u.run(3, 'head', 'x', 'Руководитель', 'callcenter', 'head_cc');
  u.run(4, 'dh', 'x', 'Врач-руководитель', 'doctor', 'doc_head');
  const perm = db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)');
  perm.run('head_cc', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
  perm.run('doc_head', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (500, 'Каримова Азиза', 'M-500'), (501, 'Каримов Бахтиёр', 'M-501')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (77, 'Консультация', 100000), (78, 'УЗИ', 150000)").run();
  return db;
}
const lead = (db, o) => Number(db.prepare(`INSERT INTO crm_requests
  (full_name, phone, status, source, note, patient_id, assigned_to, created_by, created_at, service_id, scheduled_date)
  VALUES (@full_name, @phone, @status, @source, @note, @patient_id, @assigned_to, @created_by, @created_at, @service_id, @scheduled_date)`)
  .run({ full_name: 'Лид', phone: '+998 33 322 22 88', status: 'in_process', source: 'call', note: '', patient_id: null,
    assigned_to: null, created_by: null, created_at: '2026-09-14T10:00:00Z', service_id: null, scheduled_date: null, ...o }).lastInsertRowid);
const line = (db, rid, sid, date, status = 'pending') => Number(db.prepare(
  'INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,?,?,?)').run(rid, sid, date, status).lastInsertRowid);
const task = (db, rid, text) => Number(db.prepare('INSERT INTO crm_tasks (request_id, text) VALUES (?,?)').run(rid, text).lastInsertRowid);

/** Три карточки как в базе клиники (номер 33 322 22 88): две «Пришёл» с картой, одна «Не пришёл» без. */
function devLikeThree(db) {
  const a = lead(db, { phone: '333222288', status: 'came', patient_id: 500, created_at: '2026-09-14T10:06:57Z', note: 'Первая', source: 'call' });
  const b = lead(db, { phone: '+998 33 322 22 88', status: 'no_show', created_at: '2026-09-15T15:19:35Z', note: 'Просила перезвонить', source: 'instagram', assigned_to: 2, scheduled_date: '2026-09-16' });
  const c = lead(db, { phone: '+998333222288', status: 'came', patient_id: 500, created_at: '2026-09-17T13:52:31Z', source: 'telegram' });
  line(db, a, 77, '2026-09-14', 'done');
  const lb = line(db, b, 78, '2026-10-02');
  const tb = task(db, b, 'Перезвонить про УЗИ');
  const tc = task(db, c, 'Выслать адрес');
  return { a, b, c, lb, tb, tc };
}

test('RPC зарегистрированы; список дублей — чтение для заблокированной клиники, слияние — нет', () => {
  assert.equal(typeof getRpc('crm_duplicate_groups'), 'function');
  assert.equal(typeof getRpc('crm_merge_leads'), 'function');
  assert.equal(isReadOnlyRpc('crm_duplicate_groups'), true);
  assert.equal(isReadOnlyRpc('crm_merge_leads'), false);
});

test('дубли: три карточки одного номера в четырёх записях — одна группа, предложена дошедшая с картой, самая ранняя', () => {
  const db = seed();
  try {
    const { a, b, c } = devLikeThree(db);
    lead(db, { phone: '901112233' });            // одиночка — не группа
    lead(db, { phone: '12' });                   // обрывок номера — не группа
    lead(db, { phone: '12' });
    const { groups } = crmDuplicateGroups(db, {}, BOSS);
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.deepEqual(g.cards.map((x) => x.id), [a, b, c]);
    assert.equal(g.conflict, false);
    assert.equal(g.suggested_id, a, 'заранее выбрана не та карточка');
    assert.equal(g.cards[1].tasks, 1);
    assert.equal(g.cards[1].lines, 1);
    assert.equal(g.cards[0].patient_mrn, 'M-500');
  } finally { db.close(); }
});

test('слияние трёх: услуги и задачи ПЕРЕЕЗЖАЮТ (не уходят каскадом), заметки с припиской, журнал', () => {
  const db = seed();
  try {
    const { a, b, c, lb, tb, tc } = devLikeThree(db);
    const res = crmMergeLeads(db, { keep_id: a, merge_ids: [b, c] }, BOSS);
    assert.equal(res.kept_id, a);
    assert.deepEqual(res.merged_ids, [b, c]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'влитые карточки остались');

    // Строка услуги и задачи влитых — у оставшейся.
    assert.equal(db.prepare('SELECT request_id FROM crm_request_services WHERE id = ?').get(lb).request_id, a, 'строка услуги ушла каскадом');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE request_id = ?').get(a).n, 2);
    assert.deepEqual(db.prepare('SELECT id FROM crm_tasks WHERE request_id = ? ORDER BY id').all(a).map((x) => x.id), [tb, tc], 'задачи ушли каскадом');

    const kept = res.lead;
    assert.equal(kept.status, 'came', 'ступень — не самая продвинутая');
    assert.equal(kept.patient_id, 500);
    assert.equal(kept.assigned_to, 2, 'оператор не взят с первой непустой карточки');
    assert.equal(kept.created_at, '2026-09-14T10:06:57Z');
    assert.equal(kept.source, 'call');
    assert.equal(kept.phone, '333222288');
    // Зеркало: первая живая строка — УЗИ на 02.10 (консультация выполнена).
    assert.equal(kept.service_id, 78);
    assert.equal(kept.scheduled_date, '2026-10-02');
    const lines = String(kept.note).split('\n');
    assert.equal(lines[0], 'Первая');
    assert.match(lines[1], new RegExp('^Просила перезвонить — из заявки №' + b + ' от \\d\\d\\.\\d\\d$'));
    assert.equal(lines.length, 2, 'пустая заметка дала пустую строку');

    const log = db.prepare('SELECT * FROM crm_merge_log').all();
    assert.equal(log.length, 1);
    assert.equal(log[0].kept_id, a);
    assert.deepEqual(JSON.parse(log[0].merged_ids), [b, c]);
    assert.equal(log[0].actor_id, 1);
    assert.equal(log[0].actor_name, 'Админ');
    const snap = JSON.parse(log[0].snapshot);
    assert.equal(snap.merged.find((x) => x.id === b).note, 'Просила перезвонить');
    assert.deepEqual(snap.merged.find((x) => x.id === b).line_ids, [lb]);
    assert.deepEqual(snap.merged.find((x) => x.id === b).task_ids, [tb]);
  } finally { db.close(); }
});

test('самая ранняя даёт created_at/source/call_id; имя оставшейся, а пустое — первое непустое', () => {
  const db = seed();
  try {
    db.prepare("INSERT INTO calls (id, general_call_id, started_at, external_number) VALUES (9, 'g9', '2026-09-10T08:00:00Z', '998901234567')").run();
    const early = lead(db, { phone: '901234567', full_name: 'Ранняя', created_at: '2026-09-10T08:01:00Z', source: 'telephony', status: 'recall' });
    db.prepare('UPDATE crm_requests SET call_id = 9 WHERE id = ?').run(early);
    const keep = lead(db, { phone: '+998 90 123 45 67', full_name: '', created_at: '2026-09-12T08:00:00Z', source: 'instagram', status: 'in_process' });
    const res = crmMergeLeads(db, { keep_id: keep, merge_ids: [early] }, BOSS);
    assert.equal(res.lead.created_at, '2026-09-10T08:01:00Z');
    assert.equal(res.lead.source, 'telephony');
    assert.equal(res.lead.call_id, 9);
    assert.equal(res.lead.full_name, 'Ранняя');
    assert.equal(res.lead.status, 'recall', '«Перезвонить» стоит в воронке дальше «В обработке»');
  } finally { db.close(); }
});

test('разные пациенты на одном номере — слияние запрещено, ничего не тронуто', () => {
  const db = seed();
  try {
    const a = lead(db, { phone: '901112233', patient_id: 500 });
    const b = lead(db, { phone: '901112233', patient_id: 501 });
    task(db, b, 'Задача Б');
    const { groups } = crmDuplicateGroups(db, {}, BOSS);
    assert.equal(groups[0].conflict, true);
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, BOSS), (e) => e.status === 409 && /разным пациентам/.test(e.message));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2);
    assert.equal(db.prepare('SELECT request_id FROM crm_tasks').get().request_id, b);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_merge_log').get().n, 0);
  } finally { db.close(); }
});

test('кто сливает: администратор и руководитель колл-центра — да; оператор и роль без права вести доску — нет', () => {
  const db = seed();
  try {
    const a = lead(db, { phone: '901112233' });
    const b = lead(db, { phone: '901112233', assigned_to: 2 });
    assert.throws(() => crmDuplicateGroups(db, {}, OP), (e) => e.status === 403);
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, OP), (e) => e.status === 403);
    // crm.all на основе врача: доску он видит, но заявки реестр ему править не даёт.
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, DOC_HEAD), (e) => e.status === 403);
    const res = crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, HEAD);
    assert.equal(res.lead.assigned_to, 2);
    assert.equal(db.prepare('SELECT actor_name FROM crm_merge_log').get().actor_name, 'Руководитель');
  } finally { db.close(); }
});

test('проверка ввода: нет карточки — 404, пустой список — 400, себя с собой не сливают', () => {
  const db = seed();
  try {
    const a = lead(db, { phone: '901112233' });
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [9999] }, BOSS), (e) => e.status === 404);
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [] }, BOSS), (e) => e.status === 400);
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [a] }, BOSS), (e) => e.status === 400);
    assert.throws(() => crmMergeLeads(db, { merge_ids: [a] }, BOSS), (e) => e.status === 400);
  } finally { db.close(); }
});

test('сбой посередине откатывает всё: ни переезда строк, ни удаления', () => {
  const db = seed();
  try {
    const a = lead(db, { phone: '901112233' });
    const b = lead(db, { phone: '901112233' });
    const t = task(db, b, 'Задача');
    db.exec('DROP TABLE crm_merge_log');   // журнал не пишется — транзакция обязана откатиться
    assert.throws(() => crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, BOSS));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2);
    assert.equal(db.prepare('SELECT request_id FROM crm_tasks WHERE id = ?').get(t).request_id, b);
  } finally { db.close(); }
});

test('ранжирование ступеней: дошедшая > живые по порядку > проигранные', () => {
  const db = seed();
  try {
    const rank = stageRanker(listStages(db));
    assert.ok(rank('came') > rank('approved'));
    assert.ok(rank('approved') > rank('recall'));
    assert.ok(rank('recall') > rank('no_show'));
    assert.ok(rank('no_show') > rank('нет_такой'));
    // С пациентом — раньше, чем без, при равной ступени.
    assert.equal(suggestSurvivor([
      { id: 1, status: 'recall', patient_id: null, created_at: '1' },
      { id: 2, status: 'in_process', patient_id: 500, created_at: '2' },
    ], rank), 2);
  } finally { db.close(); }
});
