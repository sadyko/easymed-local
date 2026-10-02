// CABINET_FIX_V1_R4 (ревью 4, п. 2) — ПОДПИСАННАЯ ВЕРСИЯ ДОКУМЕНТА СТРОКИ НЕ
// СТИРАЕТСЯ ЗАПИСЬЮ ИЗ ДРУГОГО ОКНА.
// CABINET_FIX_V1_R5 (ревью 5, A) — ЗАПИСЬ ЗАПИСЕЙ КАБИНЕТА — «СРАВНИТЬ И ЗАМЕНИТЬ».
//
// Записи кабинета врача (visit_services.notes, JSON с историей версий) пишет
// браузер целиком. Окно со старой копией (вторая вкладка, другой компьютер,
// подпись, дошедшая после срока) писало поверх более новой записи: черновики —
// «кто последний, тот и прав», подписанная версия терялась. Теперь запись
// записей кабинета несёт ОСНОВУ — отпечаток сохранённых notes, с которых её
// сделали (__notes_base); сервер сравнивает её с тем, что лежит у строки, и
// при расхождении отказывает (409). Если у строки лежит JSON кабинета, запись
// обязана быть JSON кабинета с совпавшей основой и всеми подписанными версиями;
// иначе — 409 (пустое, null, текст, JSON без истории — тоже). Прочие строки и
// записи без notes — как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { signedVersionsDropped, notesWriteRefusal, notesBaseOf, NOTES_BASE_KEY } from '../services/domain/cabinet-notes.js';
import { refuseNotesWrite } from './db.js';

const NOTES = (history, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history, ...extra });
const SIGNED = { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', by: 2, byName: 'Врач', fields: { chief_complaint: 'Кашель' } };
const SIGNED2 = { kind: 'signed', savedAt: '2026-10-02T10:00:00.000Z', by: 2, byName: 'Врач', fields: { chief_complaint: 'Кашель 2' } };
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
  for (let i = 4; i <= 9; i++) line.run(i, NOTES([SIGNED]));
  line.run(10, null);                               // записей ещё нет
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const update = (base, cookie, id, values, filters = [{ col: 'id', op: 'eq', val: id }]) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ table: 'visit_services', op: 'update', values, filters }),
});
const notesOf = (db, id) => db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(id).notes;
const withBase = (db, id, values) => ({ ...values, [NOTES_BASE_KEY]: notesBaseOf(notesOf(db, id)) });

test('правило: запись, в истории которой нет уже сохранённой подписанной версии, — потеря; дописывание и чужие notes — нет', () => {
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([DRAFT])), true, 'черновик поверх подписи');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([])), true);
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([SIGNED, DRAFT])), false, 'черновик после подписи');
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([SIGNED, { ...SIGNED, savedAt: '2026-10-02T10:00:00.000Z' }])), false, 'новая версия');
  assert.equal(signedVersionsDropped(NOTES([DRAFT]), NOTES([])), false, 'подписи не было');
  // CABINET_FIX_V1_R5 (F, M19) — сверка по savedAt, а не по числу подписей: одна подпись вместо другой — потеря
  assert.equal(signedVersionsDropped(NOTES([SIGNED]), NOTES([SIGNED2])), true, 'подписанная версия подменена другой (то же число)');
});

test('правило «сравнить и заменить» (ревью 5): основа совпала — можно; расходится, нет её, запись не кабинета — нельзя; строки не кабинета — как прежде', () => {
  const stored = NOTES([SIGNED]);
  const b = notesBaseOf(stored);
  assert.equal(notesWriteRefusal(stored, NOTES([SIGNED, DRAFT]), b), null);
  assert.equal(notesWriteRefusal(stored, NOTES([SIGNED, DRAFT]), notesBaseOf(NOTES([]))).reason, 'stale', 'чужая основа');
  assert.equal(notesWriteRefusal(stored, NOTES([SIGNED, DRAFT]), undefined).reason, 'stale', 'без основы');
  for (const bad of ['', null, 'Комментарий', JSON.stringify({ __service_workspace_v1: 1, current: {} }), JSON.stringify({ __service_workspace_v1: 1, current: {}, history: {} }), JSON.stringify({ __service_workspace_v1: true, current: {}, history: [SIGNED, DRAFT] })]) {
    assert.ok(notesWriteRefusal(stored, bad, b), 'записи кабинета заменены на ' + JSON.stringify(bad));
  }
  assert.equal(notesWriteRefusal(stored, NOTES([DRAFT]), b).reason, 'signed_dropped');
  assert.equal(notesWriteRefusal('Комментарий', 'Комментарий, правка', undefined), null, 'notes не кабинета — без основы');
  assert.equal(notesWriteRefusal(null, NOTES([DRAFT]), notesBaseOf(null)), null, 'первая запись кабинета');
  assert.equal(notesWriteRefusal(NOTES([DRAFT]), NOTES([DRAFT]), notesBaseOf(null)).reason, 'stale', 'две первые записи из двух окон — вторая видит первую');
  assert.notEqual(notesBaseOf(NOTES([DRAFT])), notesBaseOf(NOTES([{ ...DRAFT, fields: { chief_complaint: 'Кашель, правкa' } }])), 'основа различает версии');
  // только черновики (подписей нет): запись не кабинета стёрла бы их — отказ «не кабинет», а не «подпись»
  const drafts = NOTES([DRAFT]);
  for (const bad of ['', null, 'Комментарий', JSON.stringify({ __service_workspace_v1: 1, current: {} })]) {
    const r = notesWriteRefusal(drafts, bad, notesBaseOf(drafts));
    assert.equal(r && r.reason, 'not_cabinet', 'черновики кабинета заменены на ' + JSON.stringify(bad));
  }
  // у строки текст (заметка), окно прочитало прежний текст: первая запись кабинета со старой основой — отказ
  assert.equal((notesWriteRefusal('Заметка, правка медсестры', NOTES([DRAFT]), notesBaseOf('Заметка')) || {}).reason, 'stale', 'заметка, изменённая после чтения, стёрта первой записью кабинета');
});

test('сервер: запись со старой основой (подпись другого окна, поздняя подпись) — 409 словами, документ цел; с совпавшей основой — записывается', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const before = notesOf(db, 1);
    const r = await update(base, cookie, 1, { notes: NOTES([SIGNED, DRAFT]), [NOTES_BASE_KEY]: notesBaseOf(NOTES([])) });
    assert.equal(r.status, 409, 'запись со старой основой не отказана');
    const body = await r.json();
    assert.equal(body.error.code, 'notes_conflict');
    assert.match(body.error.message, /изменился/);
    assert.equal(notesOf(db, 1), before, 'документ изменён');
    const ok = await update(base, cookie, 1, withBase(db, 1, { notes: NOTES([SIGNED, DRAFT]) }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(notesOf(db, 1)).history.map((e) => e.kind), ['signed', 'draft']);
    // подпись со статусом — то же правило
    const late = await update(base, cookie, 1, { notes: NOTES([SIGNED, SIGNED2]), status: 'completed', [NOTES_BASE_KEY]: notesBaseOf(NOTES([SIGNED])) });
    assert.equal(late.status, 409, 'поздняя подпись со старой основой записалась поверх черновика');
    assert.deepEqual(JSON.parse(notesOf(db, 1)).history.map((e) => e.kind), ['signed', 'draft']);
  } finally { server.close(); db.close(); }
});

test('сервер: записи кабинета не заменяются пустым, null, текстом, JSON без истории или с меткой true; без основы; несколько строк сразу', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const bad = ['', null, 'Комментарий', JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'x' } }), JSON.stringify({ __service_workspace_v1: 1, current: {}, history: {} }), JSON.stringify({ __service_workspace_v1: true, current: {}, history: [DRAFT] })];
    let id = 4;
    for (const notes of bad) {
      const before = notesOf(db, id);
      const r = await update(base, cookie, id, withBase(db, id, { notes }));
      assert.equal(r.status, 409, 'записи кабинета заменены на ' + JSON.stringify(notes));
      assert.equal(notesOf(db, id), before);
      id++;
    }
    const nobase = await update(base, cookie, 3, { notes: NOTES([DRAFT, { ...DRAFT, savedAt: '2026-10-02T11:00:00.000Z' }]) });
    assert.equal(nobase.status, 409, 'запись записей кабинета без основы прошла');
    const multi = await update(base, cookie, 1, { notes: NOTES([SIGNED, DRAFT]) }, [{ col: 'id', op: 'in', val: [1, 3] }]);
    assert.equal(multi.status, 409, 'записи кабинета нескольких строк одной правкой');
    // строки с ОДИНАКОВЫМИ записями: основа совпадает у обеих, запись правильная — и всё же
    // документ одной строки не ложится в другую одной правкой
    const before4 = notesOf(db, 4), before5 = notesOf(db, 5);
    const twin = await update(base, cookie, 4, withBase(db, 4, { notes: NOTES([SIGNED, DRAFT]) }), [{ col: 'id', op: 'in', val: [4, 5] }]);
    assert.equal(twin.status, 409, 'записи кабинета двух строк с одинаковыми notes — одной правкой');
    assert.equal(notesOf(db, 4), before4);
    assert.equal(notesOf(db, 5), before5);
    // только черновики: текст с совпавшей основой стёр бы их
    const drafts = notesOf(db, 3);
    const txt = await update(base, cookie, 3, withBase(db, 3, { notes: 'Комментарий' }));
    assert.equal(txt.status, 409, 'черновики кабинета заменены текстом');
    assert.equal((await txt.json()).error.reason, 'not_cabinet');
    assert.equal(notesOf(db, 3), drafts);
  } finally { server.close(); db.close(); }
});

test('сервер: заметка строки изменилась после чтения — первая запись кабинета со старой основой не стирает её', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const read = notesBaseOf(notesOf(db, 2));   // кабинет прочитал «Комментарий регистратуры»
    db.prepare("UPDATE visit_services SET notes = 'Комментарий регистратуры, правка' WHERE id = 2").run();
    const r = await update(base, cookie, 2, { notes: NOTES([DRAFT]), [NOTES_BASE_KEY]: read });
    assert.equal(r.status, 409, 'первая запись кабинета со старой основой стёрла новую заметку');
    assert.equal(notesOf(db, 2), 'Комментарий регистратуры, правка');
  } finally { server.close(); db.close(); }
});

test('сторож записей: строки не прочитать (роль без чтения) — отказ, а не пропуск; одна строка — простым чтением сервера', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Пациент')").run();
    db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Консультация',100000)").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-10-02T07:00:00Z', 'arrived')").run();
    const line = db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, notes) VALUES (?,1,1,1,100000,100000,'in_progress',?)");
    line.run(1, NOTES([SIGNED]));
    line.run(2, NOTES([SIGNED]));
    const nobody = { id: 99, role: 'nobody' };   // чтение отбора не пройдёт
    const meta = { table: 'visit_services', op: 'update' };
    const many = refuseNotesWrite(db, meta, { table: 'visit_services', op: 'update', values: { notes: NOTES([SIGNED, DRAFT]) }, filters: [{ col: 'id', op: 'in', val: [1, 2] }] }, nobody, notesBaseOf(NOTES([SIGNED])));
    assert.equal(many && many.reason, 'unread', 'строки не прочитаны — правка пропущена');
    const one = refuseNotesWrite(db, meta, { table: 'visit_services', op: 'update', values: { notes: 'x' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, nobody, undefined);
    assert.ok(one, 'одна строка: чтение с отбором прав не прошло — и запись пропущена');
  } finally { db.close(); }
});

test('сервер: прочие записи строки — как прежде (notes не кабинета, правка без notes, первая запись кабинета с основой пустой строки)', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    assert.equal((await update(base, cookie, 2, { notes: 'Комментарий, правка' })).status, 200, 'notes не кабинета');
    assert.equal(notesOf(db, 2), 'Комментарий, правка');
    assert.equal((await update(base, cookie, 1, { status: 'completed' })).status, 200, 'правка без notes на подписанной строке');
    assert.equal((await update(base, cookie, 10, withBase(db, 10, { notes: NOTES([DRAFT]) }))).status, 200, 'первая запись кабинета');
    assert.equal((await update(base, cookie, 10, { notes: NOTES([DRAFT]), [NOTES_BASE_KEY]: notesBaseOf(null) })).status, 409, 'второе «первое» сохранение из другого окна');
  } finally { server.close(); db.close(); }
});

// CABINET_FIX_V1_R5 (ревью 5, C) — /api/db принимал не больше 100 КБ, а записи
// кабинета несут снимки исследования: строка со снимком не сохранялась и не
// подписывалась («Некорректный запрос»). Здесь тело НЕ разобрано заранее — как
// в браузере.
test('сервер (C): записи кабинета со снимками (~1,5 МБ) сохраняются; слишком большой документ — понятный отказ, а не «Некорректный запрос»', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const photo = 'data:image/jpeg;base64,' + 'A'.repeat(300 * 1024);
    const big = NOTES([SIGNED, DRAFT], { diagImages: [photo, photo, photo, photo, photo] });
    const r = await update(base, cookie, 1, withBase(db, 1, { notes: big }));
    assert.equal(r.status, 200, 'записи со снимками не сохранились: ' + r.status);
    assert.equal(notesOf(db, 1), big);
    const huge = NOTES([SIGNED, DRAFT], { diagImages: Array.from({ length: 30 }, () => photo) });
    const r2 = await update(base, cookie, 1, withBase(db, 1, { notes: huge }));
    assert.equal(r2.status, 413);
    const body = await r2.json();
    assert.equal(body.error.code, 'too_large');
    assert.match(body.error.message, /слишком большой/);
    assert.ok(!/Некорректный запрос/.test(body.error.message));
    // прочие /api — прежний предел
    const other = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doc', password: 'x'.repeat(200 * 1024) }) });
    assert.equal(other.status, 413, 'предел поднят для всех /api');
  } finally { server.close(); db.close(); }
});
