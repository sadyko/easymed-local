// DOC_HISTORY_V1 (3.25.0, решение владельца) — «ИСТОРИЯ ИЗМЕНЕНИЙ»: КТО ВИДИТ (RPC document_history_*).
//
// Видят врач строки, главный врач (надстройка head_doctor) и администратор; другой
// врач, медсестра, регистратура — 403 словами. Роли, которой закрыты данные
// пациентов, история не отдаётся даже врачу строки. Список — без снимков; одна
// версия — со снимком и только своей строки. Обе двери — только чтение (лицензия
// не запирает их у просроченной клиники).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_HISTORY_DENIED } from '../../public/js/shared/doc-history.js';
import { PATIENT_DATA_DENIED } from '../db/patient-data-gate.js';
import { isReadOnlyRpc } from '../services/control/gate.js';
import { startDocHistoryServer, BOSS, DOC, DOCN, draft } from '../test-helpers/doc-history-fixture.js';

test('история: врач строки, главный врач и администратор — видят; другой врач, медсестра, регистратура — 403; просмотр одной версии', async () => {
  const t = await startDocHistoryServer();
  try {
    const doc = await t.login('doc');
    const f = { chief_complaint: 'Кашель' };
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)]))).status, 200);
    const g = { ...f, hpi: 'Неделю' };
    assert.equal((await t.write(doc, 1, DOCN(g, [draft(g)]))).status, 200);
    for (const who of ['doc', 'hdoc', 'boss']) {
      const c = who === 'doc' ? doc : await t.login(who);
      const r = await t.rpc(c, 'document_history_list', { visit_service_id: 1 });
      assert.equal(r.status, 200, who + ': ' + JSON.stringify(r.json));
      const list = r.json.data.revisions;
      assert.deepEqual(list.map((x) => x.rev_no), [1, 2]);
      assert.deepEqual(list[1].sections, ['hpi']);
      assert.equal(list[1].kind, 'draft');
      assert.deepEqual(list[1].user, { id: DOC, name: 'Иванова А.', role: 'doctor' });
      assert.equal(list[1].acting_admin, null);
      assert.ok(!('snapshot' in list[1]), 'список — без снимков');
    }
    for (const who of ['doc2', 'nurse', 'reg']) {
      const c = await t.login(who);
      const r = await t.rpc(c, 'document_history_list', { visit_service_id: 1 });
      assert.equal(r.status, 403, who + ': ' + JSON.stringify(r.json));
      assert.equal(r.json.error.message, DOC_HISTORY_DENIED);
      const one = await t.rpc(c, 'document_history_get', { visit_service_id: 1, id: t.revs(1)[0].id });
      assert.equal(one.status, 403, who + ' (одна версия): ' + JSON.stringify(one.json));
    }
    const v = await t.rpc(doc, 'document_history_get', { visit_service_id: 1, id: t.revs(1)[1].id });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.data.snapshot.fields.hpi, 'Неделю');
    assert.equal(v.json.data.kind, 'draft');
    // версия другой строки по номеру своей — нет
    const boss = await t.login('boss');
    assert.equal((await t.write(boss, 4, DOCN(f, [draft(f)]))).status, 200);
    const other = await t.rpc(doc, 'document_history_get', { visit_service_id: 1, id: t.revs(4)[0].id });
    assert.equal(other.status, 404, JSON.stringify(other.json));
    assert.equal((await t.rpc(doc, 'document_history_list', {})).status, 400);
    assert.equal((await t.rpc(doc, 'document_history_get', { visit_service_id: 1 })).status, 400);
    assert.equal((await t.rpc(doc, 'document_history_list', { visit_service_id: 999 })).status, 404);
    // чтение истории документ не трогает
    const notes = t.notesOf(1);
    await t.rpc(doc, 'document_history_list', { visit_service_id: 1 });
    assert.equal(t.notesOf(1), notes);
  } finally { t.close(); }
});

test('история: вход «от имени» — права сотрудника; администратор назван «вместо»', async () => {
  const t = await startDocHistoryServer();
  try {
    const boss = await t.login('boss');
    assert.equal((await t.actAs(boss, DOC)).status, 200);
    const f = { chief_complaint: 'Кашель (от имени)' };
    assert.equal((await t.write(boss, 1, DOCN(f, [draft(f)]))).status, 200);
    const h = await t.rpc(boss, 'document_history_list', { visit_service_id: 1 });
    assert.equal(h.status, 200, 'от имени врача строки история видна: ' + JSON.stringify(h.json));
    assert.deepEqual(h.json.data.revisions[0].acting_admin, { id: BOSS, name: 'Петров П.' });
    assert.deepEqual(h.json.data.revisions[0].user, { id: DOC, name: 'Иванова А.', role: 'doctor' });
  } finally { t.close(); }
});

test('история: роли закрыты данные пациентов — не отдаётся даже врачу строки', async () => {
  const t = await startDocHistoryServer({ cutDoctor: true });
  try {
    const doc = await t.login('doc');
    const r = await t.rpc(doc, 'document_history_list', { visit_service_id: 1 });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.error.message, PATIENT_DATA_DENIED);
  } finally { t.close(); }
});

test('обе двери истории — только чтение (просроченная лицензия их не запирает), правящих дверей нет', async () => {
  assert.equal(isReadOnlyRpc('document_history_list'), true);
  assert.equal(isReadOnlyRpc('document_history_get'), true);
  const { RPC } = await import('../services/rpc/index.js');
  assert.deepEqual(Object.keys(RPC).filter((n) => /^document_history/.test(n)).sort(), ['document_history_get', 'document_history_list']);
});
