// DOC_HISTORY_V1 (3.25.0, решение владельца) — ДОКУМЕНТ ПРИЁМА МЕНЯЕТ ВРАЧ СТРОКИ ИЛИ АДМИНИСТРАТОР.
//
// Реестр /api/db открывает visit_services.notes администратору, регистратуре, врачу,
// лаборатории и медсестре — на любой строке. Теперь запись документа через /api/db —
// только «своей» строки (doctor_id = я) или администратором; остальным 403 словами.
// Заметка медсестры («Выполнено» процедуры) идёт своей дверью и работает как прежде;
// прочие правки строки (статус) — тоже. Вход «от имени» — права сотрудника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_EDIT_REFUSAL } from '../../public/js/shared/doc-history.js';
import { startDocHistoryServer, BOSS, DOC, DOC2, REG, DOCN, draft } from '../test-helpers/doc-history-fixture.js';

test('права записи: чужой врач, медсестра, лаборант, регистратура — 403 словами; врач строки и администратор — пишут; строку без исполнителя — только администратор', async () => {
  const t = await startDocHistoryServer();
  try {
    const f = { chief_complaint: 'Кашель' };
    const before = t.notesOf(1);
    for (const who of ['doc2', 'nurse', 'lab', 'reg']) {
      const c = await t.login(who);
      const r = await t.write(c, 1, DOCN(f, [draft(f)]));
      assert.equal(r.status, 403, who + ': ' + JSON.stringify(r.json));
      assert.equal(r.json.error.code, 'forbidden');
      assert.equal(r.json.error.message, DOC_EDIT_REFUSAL);
      assert.equal(t.notesOf(1), before, who + ' переписал документ');
    }
    assert.equal(t.revs(1).length, 0, 'отказанные записи оставили версии');
    const doc = await t.login('doc');
    assert.equal((await t.write(doc, 1, DOCN(f, [draft(f)]))).status, 200, 'врач строки');
    const boss = await t.login('boss');
    const g = { ...f, hpi: 'Дополнил администратор' };
    assert.equal((await t.write(boss, 1, DOCN(g, [draft(g)]))).status, 200, 'администратор');
    assert.equal(t.revs(1)[1].user_id, BOSS);
    assert.equal(t.revs(1)[1].user_role, 'admin');
    // строка без исполнителя
    assert.equal((await t.write(doc, 5, DOCN(f, [draft(f)]))).status, 403, 'строка без исполнителя — не «своя»');
    assert.equal((await t.write(boss, 5, DOCN(f, [draft(f)]))).status, 200);
    // несколько строк одной правкой, среди них чужая — отказ целиком
    const multi = await t.call(doc, 'POST', '/api/db', { table: 'visit_services', op: 'update', values: { notes: 'x' }, filters: [{ col: 'id', op: 'in', val: [4, 6] }] });
    assert.equal(multi.status, 403, JSON.stringify(multi.json));
    assert.equal(t.notesOf(4), null);
  } finally { t.close(); }
});

test('права записи: прочие правки строки и «Выполнено» медсестры — как прежде; другой врач пишет свою строку', async () => {
  const t = await startDocHistoryServer();
  try {
    const nurse = await t.login('nurse');
    const st = await t.call(nurse, 'POST', '/api/db', { table: 'visit_services', op: 'update', values: { status: 'in_progress' }, filters: [{ col: 'id', op: 'eq', val: 3 }] });
    assert.equal(st.status, 200, 'правка статуса медсестрой: ' + JSON.stringify(st.json));
    const done = await t.rpc(nurse, 'procedure_complete', { kind: 'outpatient', id: 3, notes: 'в/в капельно' });
    assert.equal(done.status, 200, '«Выполнено» медсестры на строке с документом врача: ' + JSON.stringify(done.json));
    assert.equal(JSON.parse(t.notesOf(3)).nurseNote, 'в/в капельно');
    const doc2 = await t.login('doc2');
    const f = { chief_complaint: 'Своя строка' };
    assert.equal((await t.write(doc2, 4, DOCN(f, [draft(f)]))).status, 200, 'другой врач — свою строку');
    assert.equal(t.revs(4)[0].user_id, DOC2);
  } finally { t.close(); }
});

test('вход «от имени» — права сотрудника: от имени врача строки — можно, от имени регистратора — 403', async () => {
  const f = { chief_complaint: 'Кашель' };
  const t = await startDocHistoryServer();
  try {
    const boss = await t.login('boss');
    assert.equal((await t.actAs(boss, DOC)).status, 200);
    assert.equal((await t.write(boss, 1, DOCN(f, [draft(f)]))).status, 200, 'от имени врача строки');
  } finally { t.close(); }
  const t2 = await startDocHistoryServer();
  try {
    const boss = await t2.login('boss');
    assert.equal((await t2.actAs(boss, REG)).status, 200);
    const r = await t2.write(boss, 1, DOCN(f, [draft(f)]));
    assert.equal(r.status, 403, 'от имени регистратора документ врача не меняется: ' + JSON.stringify(r.json));
    assert.equal(r.json.error.message, DOC_EDIT_REFUSAL);
    assert.equal(t2.notesOf(1), null);
  } finally { t2.close(); }
});
