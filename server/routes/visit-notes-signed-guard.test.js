// CABINET_FIX_V1_R4 (ревью 4, п. 2) — ПОДПИСАННАЯ ВЕРСИЯ ДОКУМЕНТА СТРОКИ НЕ
// СТИРАЕТСЯ ЗАПИСЬЮ ИЗ ДРУГОГО ОКНА.
//
// Записи кабинета врача (visit_services.notes, JSON с историей версий) пишет
// браузер целиком. Две вкладки (или два компьютера) на одной строке: вторая
// подписывает, первая жмёт «Сохранить» со своей старой копией — и история
// ["signed"] становилась ["draft"]: подписанная версия пропадала. Блокировка
// подписи в браузере видит только свою вкладку, поэтому гарантия — на сервере:
// запись, в истории которой нет подписанной версии, уже сохранённой у строки,
// отказывается (409) словами. Прочие записи notes (не-JSON кабинета, правки
// без notes) — как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { signedVersionsDropped } from '../services/domain/cabinet-notes.js';

const NOTES = (history, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history, ...extra });
const SIGNED = { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', by: 2, byName: 'Врач', fields: { chief_complaint: 'Кашель' } };
const DRAFT = { kind: 'draft', savedAt: '2026-10-02T09:00:00.000Z', fields: { chief_complaint: 'Кашель, правка' } };

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,1)').run(2, 'doc', hashPassword('password1'), 'Врач', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Консультация',100000)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-10-02T07:00:00Z', 'arrived')").run();
  const line = db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes) VALUES (?,1,1,2,1,100000,100000,'in_progress',?)");
  line.run(1, NOTES([SIGNED]));                    // подписанный документ
  line.run(2, 'Комментарий регистратуры');          // notes не кабинета
  line.run(3, NOTES([DRAFT]));                      // только черновик
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const update = (base, cookie, id, values) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ table: 'visit_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] }),
});
const notesOf = (db, id) => db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(id).notes;

test('правило: запись, в истории которой нет уже сохранённой подписанной версии, — потеря; дописывание и чужие notes — нет', () => {
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([DRAFT])), true, 'черновик поверх подписи');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([])), true);
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([SIGNED, DRAFT])), false, 'черновик после подписи');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([SIGNED, { ...SIGNED, savedAt: '2026-10-02T10:00:00.000Z' }])), false, 'новая версия');
  assert.equal(signedVersionsDropped(NOTES([DRAFT]), NOTES([])), false, 'подписи не было');
  assert.equal(signedVersionsDropped('Комментарий', NOTES([])), false, 'прежние notes — не кабинет');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), 'Комментарий'), false, 'новые notes — не кабинет');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), null), false);
  assert.equal(signedVersionsDropped('{"history":[{"kind":"signed","savedAt":"x"}]}', NOTES([])), false, 'JSON не кабинета (без метки)');
});

test('сервер: «Сохранить» со старой копией (без подписи другого окна) — 409 словами, документ цел; с подписью в истории — записывается', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const before = notesOf(db, 1);
    const r = await update(base, cookie, 1, { notes: NOTES([DRAFT]) });
    assert.equal(r.status, 409, 'стирание подписанной версии не отказано');
    const body = await r.json();
    assert.equal(body.error.code, 'signed_conflict');
    assert.match(body.error.message, /подписан в другом окне/);
    assert.equal(notesOf(db, 1), before, 'подписанная версия стёрта');
    const ok = await update(base, cookie, 1, { notes: NOTES([SIGNED, DRAFT]) });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(notesOf(db, 1)).history.map((e) => e.kind), ['signed', 'draft']);
  } finally { server.close(); db.close(); }
});

test('сервер: прочие записи строки — как прежде (notes не кабинета, правка без notes, строка без подписи)', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    assert.equal((await update(base, cookie, 2, { notes: 'Комментарий, правка' })).status, 200, 'notes не кабинета');
    assert.equal(notesOf(db, 2), 'Комментарий, правка');
    assert.equal((await update(base, cookie, 1, { status: 'completed' })).status, 200, 'правка без notes на подписанной строке');
    assert.equal((await update(base, cookie, 3, { notes: NOTES([]) })).status, 200, 'строка без подписи');
  } finally { server.close(); db.close(); }
});
