// DOC_HISTORY_V1 (3.25.0, решение владельца) — ИСТОРИЯ ИЗМЕНЕНИЙ ДОКУМЕНТА ПРИЁМА: ЗАПИСЬ ВЕРСИЙ.
//
// Сервер, по живому маршруту:
//   • каждая запись /api/db, меняющая содержание документа (visit_services.notes),
//     оставляет версию — время и сотрудника ставит сервер (присланные by/byName/savedAt
//     ни при чём), вид, разделы, снимок; тот же текст ещё раз — версии нет;
//   • подпись — «Подписан», правка подписанного — «Исправлен после подписи», списки —
//     «Изменение назначений и диагнозов», «Выполнено» медсестры — «Отметка медсестры»;
//   • снимки исследования — только отпечатки (добавлено / убрано);
//   • документ до журнала получает «Версию до журнала изменений» при первой записи;
//   • вход «от имени» — версия сотрудника, рядом администратор;
//   • версии через /api/db не меняет, не удаляет и не читает никто, администратор тоже;
//   • копия подписанного документа (visit_document_archive) версию не дублирует,
//     а запись мимо журнала — догоняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { notesBaseOf, NOTES_BASE_KEY } from '../services/domain/cabinet-notes.js';
import { startDocHistoryServer, BOSS, DOC, NURSE, DOCN, draft, signed, OLD_SIGNED, IMG } from '../test-helpers/doc-history-fixture.js';

test('черновик: версия — время и сотрудник от сервера; тот же текст ещё раз, правка без notes и отказанная запись — без версии', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const forged = { kind: 'draft', savedAt: '2020-01-01T00:00:00.000Z', by: 999, byName: 'Подделка', fields: { chief_complaint: 'Кашель' } };
    const t0 = Date.now();
    let r = await t.write(doc, 1, DOCN({ chief_complaint: 'Кашель' }, [forged]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = t.revs(1);
    assert.equal(list.length, 1);
    const v = list[0];
    assert.equal(v.kind, 'draft');
    assert.equal(v.via, 'cabinet');
    assert.equal(v.rev_no, 1);
    assert.equal(v.user_id, DOC, 'сотрудник — из сессии');
    assert.equal(v.user_name, 'Иванова А.');
    assert.equal(v.user_role, 'doctor');
    assert.equal(v.acting_admin_id, null);
    assert.ok(Math.abs(Date.parse(v.created_at) - t0) < 60000, 'время ставит сервер, а не браузер: ' + v.created_at);
    assert.deepEqual(JSON.parse(v.sections), ['chief_complaint']);
    assert.equal(v.doc_type, 'conclusion');
    const snap = JSON.parse(v.snapshot);
    assert.equal(snap.fields.chief_complaint, 'Кашель');
    assert.ok(!('history' in snap), 'история черновиков в снимок не копируется');

    r = await t.write(doc, 1, DOCN({ chief_complaint: 'Кашель' }, [forged, draft({ chief_complaint: 'Кашель' })]));
    assert.equal(r.status, 200);
    assert.equal(t.revs(1).length, 1, 'тот же текст ещё раз — версии нет');
    r = await t.call(doc, 'POST', '/api/db', { table: 'visit_services', op: 'update', values: { status: 'in_progress' }, filters: [{ col: 'id', op: 'eq', val: 1 }] });
    assert.equal(r.status, 200);
    assert.equal(t.revs(1).length, 1, 'правка без notes — версии нет');
    r = await t.call(doc, 'POST', '/api/db', { table: 'visit_services', op: 'update', values: { notes: DOCN({ chief_complaint: 'Другое' }, []), [NOTES_BASE_KEY]: notesBaseOf(null) }, filters: [{ col: 'id', op: 'eq', val: 1 }] });
    assert.equal(r.status, 409);
    assert.equal(t.revs(1).length, 1, 'отказанная запись (старая основа) оставила версию');
  } finally { t.close(); }
});

test('подпись — «Подписан»; правка подписанного — «Исправлен после подписи»; переподпись с изменениями — тоже', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const f1 = { chief_complaint: 'Кашель' };
    const s1 = signed(f1, '2026-11-18T09:00:00.000Z');
    assert.equal((await t.write(doc, 1, DOCN(f1, [draft(f1)]))).status, 200);
    assert.equal((await t.write(doc, 1, DOCN(f1, [s1]), { status: 'completed' })).status, 200);
    let list = t.revs(1);
    assert.deepEqual(list.map((x) => x.kind), ['draft', 'signed']);
    assert.equal(list[1].signed_n, 1);
    assert.deepEqual(JSON.parse(list[1].sections), [], 'подпись того же текста — разделы не менялись');
    const f2 = { ...f1, hpi: 'Неделю' };
    assert.equal((await t.write(doc, 1, DOCN(f2, [s1, draft(f2)]))).status, 200);
    list = t.revs(1);
    assert.equal(list[2].kind, 'amended', 'правка после подписи');
    assert.deepEqual(JSON.parse(list[2].sections), ['hpi']);
    const f3 = { ...f2, conclusion_text: 'ОРВИ' };
    assert.equal((await t.write(doc, 1, DOCN(f3, [s1, signed(f3, '2026-11-18T10:00:00.000Z')]))).status, 200);
    list = t.revs(1);
    assert.equal(list[3].kind, 'amended', 'переподпись с изменениями — исправление после подписи');
    assert.equal(list[3].signed_n, 2);
  } finally { t.close(); }
});

test('назначения и диагнозы — «Изменение назначений и диагнозов»; снимки — только отпечатки, добавлено и убрано', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const f = { chief_complaint: 'Кашель' };
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)]))).status, 200);
    const rx = [{ name: 'Амоксициллин', dose: '500 мг', freq: '3 р/д', dur: '7 дней', notes: '', nurse: '' }];
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)], { prescriptions: rx }))).status, 200);
    const dx = [{ code: 'J20.9', name: 'Острый бронхит', type: 'main' }];
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)], { prescriptions: rx, diagnoses: dx }))).status, 200);
    let list = t.revs(1);
    assert.deepEqual(list.map((x) => x.kind), ['draft', 'lists', 'lists']);
    assert.deepEqual(JSON.parse(list[1].sections), ['prescriptions']);
    assert.deepEqual(JSON.parse(list[2].sections), ['diagnoses']);
    assert.equal(JSON.parse(list[2].snapshot).prescriptions[0].name, 'Амоксициллин');

    const A = IMG('A'), B = IMG('B'), C = IMG('C');
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)], { prescriptions: rx, diagnoses: dx, diagImages: [A, B], docType: 'diag' }))).status, 200);
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)], { prescriptions: rx, diagnoses: dx, diagImages: [A, C], docType: 'diag' }))).status, 200);
    list = t.revs(1);
    const add = list[3], swap = list[4];
    assert.deepEqual(JSON.parse(add.sections), ['images', 'docType']);
    assert.equal(add.images_added, 2);
    assert.equal(add.images_removed, 0);
    assert.equal(add.doc_type, 'diag');
    assert.equal(swap.images_added, 1);
    assert.equal(swap.images_removed, 1);
    for (const x of [add, swap]) {
      assert.ok(x.snapshot.length < 2000, 'снимок версии со снимками исследования — ' + x.snapshot.length + ' символов');
      assert.ok(!/base64|AAAA/.test(x.snapshot), 'данные снимка скопированы в версию');
      assert.equal(JSON.parse(x.snapshot).images.length, 2);
    }
  } finally { t.close(); }
});

test('документ до журнала: первая запись после обновления оставляет «Версию до журнала изменений», затем саму правку; до неё документ не тронут', async () => {
  const t = await startDocHistoryServer();
  try {
    const before = t.notesOf(2);
    assert.deepEqual(t.revs(2), [], 'миграция версий задним числом не заводит');
    const doc = await t.login('doc');
    const f = { chief_complaint: 'Головная боль, мигрень' };
    assert.equal(t.notesOf(2), before);
    assert.equal((await t.write(doc, 2, DOCN(f, [OLD_SIGNED, draft(f)]))).status, 200);
    const list = t.revs(2);
    assert.deepEqual(list.map((x) => [x.rev_no, x.kind, x.via]), [[1, 'baseline', 'baseline'], [2, 'amended', 'cabinet']]);
    assert.equal(list[0].user_id, null, 'кто писал до журнала — не известно');
    assert.equal(JSON.parse(list[0].snapshot).fields.chief_complaint, 'Головная боль');
    assert.equal(JSON.parse(list[0].snapshot).signed[0].byName, 'Иванова А.', 'подпись из записи документа видна в версии до журнала');
    assert.equal(list[0].signed_n, 1);
    assert.equal(list[1].user_id, DOC);
  } finally { t.close(); }
});

test('«Выполнено» медсестры — «Отметка медсестры»; строка без документа и та же заметка — без версии', async () => {
  const t = await startDocHistoryServer();
  try {
    const nurse = await t.login('nurse');
    let r = await t.rpc(nurse, 'procedure_complete', { kind: 'outpatient', id: 3, notes: 'в/в капельно' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = t.revs(3);
    assert.deepEqual(list.map((x) => x.kind), ['baseline', 'nurse']);
    assert.equal(list[1].via, 'nurse');
    assert.equal(list[1].user_id, NURSE);
    assert.equal(list[1].user_role, 'nurse');
    assert.deepEqual(JSON.parse(list[1].sections), ['nurseNote']);
    assert.equal(JSON.parse(t.notesOf(3)).nurseNote, 'в/в капельно', 'заметка легла в документ');
    r = await t.rpc(nurse, 'procedure_complete', { kind: 'outpatient', id: 6, notes: 'сделано' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(t.revs(6).length, 0, 'строка без документа кабинета — не документ');
    r = await t.rpc(nurse, 'procedure_complete', { kind: 'outpatient', id: 3, notes: 'в/в капельно' });
    assert.equal(r.status, 200);
    assert.equal(t.revs(3).length, 2, 'та же заметка ещё раз — версии нет');
  } finally { t.close(); }
});

test('версии через /api/db не меняет, не удаляет, не заводит и не читает никто — администратор тоже (403)', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const f = { chief_complaint: 'Кашель' };
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)]))).status, 200);
    const stored = t.revs(1);
    assert.equal(stored.length, 1);
    const boss = await t.login('boss');
    for (const c of [boss, doc]) {
      const T = 'visit_document_revisions';
      const tries = [
        { table: T, op: 'update', values: { kind: 'signed' }, filters: [{ col: 'id', op: 'eq', val: stored[0].id }] },
        { table: T, op: 'delete', filters: [{ col: 'id', op: 'eq', val: stored[0].id }] },
        { table: T, op: 'insert', values: { visit_service_id: 1, rev_no: 9, kind: 'draft', via: 'cabinet', snapshot: '{}', content_hash: 'x' } },
        { table: T, op: 'upsert', values: { id: stored[0].id, kind: 'signed' }, onConflict: 'id' },
        { table: T, op: 'select', columns: '*' },
      ];
      for (const body of tries) {
        const r = await t.call(c, 'POST', '/api/db', body);
        assert.equal(r.status, 403, body.op + ': ' + JSON.stringify(r.json));
      }
    }
    assert.deepEqual(t.revs(1), stored, 'версии изменились');
  } finally { t.close(); }
});

test('вход «от имени»: версия — сотрудника, рядом администратор, который действовал', async () => {
  const t = await startDocHistoryServer();
  try {
    const boss = await t.login('boss');
    const a = await t.actAs(boss, DOC);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    const f = { chief_complaint: 'Кашель (от имени)' };
    const r = await t.write(boss, 1, DOCN(f, [draft(f)]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const v = t.revs(1)[0];
    assert.equal(v.user_id, DOC);
    assert.equal(v.user_name, 'Иванова А.');
    assert.equal(v.acting_admin_id, BOSS);
    assert.equal(v.acting_admin_name, 'Петров П.');
  } finally { t.close(); }
});

test('копия подписанного документа (visit_document_archive): версию не дублирует; запись мимо журнала — догоняет', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const f = { chief_complaint: 'Кашель' };
    assert.equal((await t.write(doc, 1, DOCN(f, [signed(f, '2026-11-18T09:00:00.000Z')]), { status: 'completed' })).status, 200);
    assert.equal(t.revs(1).length, 1);
    const archive = () => t.rpc(doc, 'visit_document_archive', { visit_service_id: 1, doc_type: 'protocol', title: 'Протокол', body: { chief_complaint: 'Кашель' } });
    let r = await archive();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(t.revs(1).length, 1, 'копия подписи продублировала версию');
    // документ изменён мимо журнала (не через двери сервера) — подпись догоняет историю
    t.db.prepare('UPDATE visit_services SET notes = ? WHERE id = 1').run(DOCN({ chief_complaint: 'Кашель, правка мимо журнала' }, [signed(f, '2026-11-18T09:00:00.000Z')]));
    r = await archive();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = t.revs(1);
    assert.equal(list.length, 2);
    assert.equal(list[1].via, 'archive');
    assert.equal(list[1].kind, 'amended');
    assert.equal(list[1].user_id, DOC);
    assert.deepEqual(JSON.parse(list[1].sections), ['chief_complaint']);
    // строка без версий (документ до журнала) — подпись заводит «Версию до журнала изменений»
    r = await t.rpc(doc, 'visit_document_archive', { visit_service_id: 2, doc_type: 'protocol', title: 'Протокол', body: { chief_complaint: 'Головная боль' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(t.revs(2).map((x) => x.kind), ['baseline']);
  } finally { t.close(); }
});
