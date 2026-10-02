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
import { signedVersionsDropped, notesWriteRefusal, notesBaseOf, NOTES_BASE_KEY, notesCompatValue } from '../services/domain/cabinet-notes.js';
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
  // CABINET_FIX_V1_R6 — без основы (вкладка, открытая до обновления) — правило ревью 4, а не отказ
  assert.equal(notesWriteRefusal(stored, NOTES([SIGNED, DRAFT]), undefined), null, 'без основы, подписи целы — отказ (вкладка 3.15.0 не сохранит ничего)');
  assert.equal((notesWriteRefusal(stored, NOTES([DRAFT]), undefined) || {}).reason, 'signed_dropped', 'без основы, подпись потеряна');
  assert.equal((notesWriteRefusal(stored, NOTES([SIGNED2]), undefined) || {}).reason, 'signed_dropped', 'без основы, подпись подменена');
  for (const bad of ['', null, 'Комментарий', JSON.stringify({ __service_workspace_v1: 1, current: {} })]) {
    assert.equal((notesWriteRefusal(stored, bad, undefined) || {}).reason, 'not_cabinet', 'без основы, записи кабинета заменены на ' + JSON.stringify(bad));
  }
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

test('совместимость (ревью 6): запись без основы, где нет заметки медсестры, получает сохранённую; с основой и с заметкой — как прислана', () => {
  const stored = NOTES([SIGNED], { nurseNote: 'в/в капельно' });
  const next = NOTES([SIGNED, DRAFT]);
  const carried = notesCompatValue(stored, next, undefined);
  assert.ok(carried, 'заметка медсестры не перенесена');
  assert.equal(JSON.parse(carried).nurseNote, 'в/в капельно');
  assert.deepEqual(JSON.parse(carried).history, JSON.parse(next).history);
  assert.equal(notesCompatValue(stored, next, notesBaseOf(stored)), null, 'с основой запись не переписывается');
  assert.equal(notesCompatValue(stored, NOTES([SIGNED, DRAFT], { nurseNote: '' }), undefined), null, 'заметка в записи есть (пусть пустая) — решает запись');
  assert.equal(notesCompatValue(NOTES([SIGNED]), next, undefined), null, 'заметки не было');
  assert.equal(notesCompatValue('Заметка', next, undefined), null, 'строка не кабинета');
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

test('сервер: записи кабинета не заменяются пустым, null, текстом, JSON без истории или с меткой true; несколько строк сразу', async () => {
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

// CABINET_FIX_V1_R6 (ревью 6, п. 1) — вкладка, открытая до обновления (3.15.0), основы
// не шлёт: её записи проходят по правилу ревью 4 (JSON кабинета, все подписи целы),
// заметка медсестры, которой в её записи нет, переносится сервером.
test('сервер (совместимость, ревью 6): запись без основы — правило ревью 4: подписи целы — 200; подпись потеряна, не кабинет — 409; заметка медсестры сохраняется', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    // подписи целы → 200, лежит ровно присланное
    const keep = NOTES([SIGNED, DRAFT]);
    const r1 = await update(base, cookie, 1, { notes: keep });
    assert.equal(r1.status, 200, 'вкладка 3.15.0 не сохранила черновик на подписанной строке');
    assert.equal(notesOf(db, 1), keep);
    // и подпись (вторая версия) со статусом → 200
    const r1b = await update(base, cookie, 1, { notes: NOTES([SIGNED, SIGNED2]), status: 'completed' });
    assert.equal(r1b.status, 200, 'вкладка 3.15.0 не подписала');
    // подпись потеряна → 409
    const before4 = notesOf(db, 4);
    const r4 = await update(base, cookie, 4, { notes: NOTES([DRAFT]) });
    assert.equal(r4.status, 409, 'без основы подписанная версия стёрта');
    assert.equal((await r4.json()).error.reason, 'signed_dropped');
    assert.equal(notesOf(db, 4), before4);
    // не кабинет → 409
    for (const [id, notes] of [[5, 'Комментарий'], [6, ''], [7, null]]) {
      const before = notesOf(db, id);
      const r = await update(base, cookie, id, { notes });
      assert.equal(r.status, 409, 'без основы записи кабинета заменены на ' + JSON.stringify(notes));
      assert.equal(notesOf(db, id), before);
    }
    // заметка медсестры, которой нет в записи вкладки, — сохраняется
    db.prepare('UPDATE visit_services SET notes = ? WHERE id = 8').run(NOTES([SIGNED], { nurseNote: 'в/в капельно' }));
    const r8 = await update(base, cookie, 8, { notes: NOTES([SIGNED, DRAFT]) });
    assert.equal(r8.status, 200);
    const s8 = JSON.parse(notesOf(db, 8));
    assert.equal(s8.nurseNote, 'в/в капельно', 'заметка медсестры стёрта записью вкладки 3.15.0');
    assert.deepEqual(s8.history.map((e) => e.kind), ['signed', 'draft']);
    // с основой — «сравнить и заменить», запись ложится ровно как прислана
    const exact = NOTES([SIGNED, DRAFT, { ...DRAFT, savedAt: '2026-10-02T12:00:00.000Z' }], { nurseNote: 'в/в капельно' });
    const r8b = await update(base, cookie, 8, withBase(db, 8, { notes: exact }));
    assert.equal(r8b.status, 200);
    assert.equal(notesOf(db, 8), exact);
    // пустая строка: первая и вторая запись без основы
    assert.equal((await update(base, cookie, 10, { notes: NOTES([DRAFT]) })).status, 200, 'первая запись');
    assert.equal((await update(base, cookie, 10, { notes: NOTES([{ ...DRAFT, savedAt: '2026-10-02T13:00:00.000Z' }]) })).status, 200, 'вторая запись вкладки 3.15.0 отказана');
    assert.equal((await update(base, cookie, 10, { notes: NOTES([SIGNED]), status: 'completed' })).status, 200, 'подпись вкладки 3.15.0 отказана');
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
    // CABINET_FIX_V1_R6 (п. 7) — /api/db пишет любые таблицы: слова — общие, без «снимков»
    // (кабинет называет снимки сам, по коду too_large); у копии подписи — про снимки.
    assert.ok(!/снимк/.test(body.error.message), '/api/db говорит о снимках для любой таблицы: ' + body.error.message);
    const arch = await fetch(base + '/api/rpc/visit_document_archive', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ visit_service_id: 1, doc_type: 'diag', title: 'x', body: { images: Array.from({ length: 30 }, () => photo) } }) });
    assert.equal(arch.status, 413);
    assert.match((await arch.json()).error.message, /снимк/);
    // прочие /api — прежний предел
    const other = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doc', password: 'x'.repeat(200 * 1024) }) });
    assert.equal(other.status, 413, 'предел поднят для всех /api');
  } finally { server.close(); db.close(); }
});

// CABINET_FIX_V1_R6 (п. 7) — тело до 8 МБ разбирается только для вошедшего: без сессии
// /api/db и копия подписи отвечают 401, не читая тела.
test('сервер (ревью 6): без входа большое тело /api/db и копии подписи не разбирается — 401, а не 413/400', async () => {
  const { db, server, base } = await startServer();
  try {
    const nine = '{"table":"visit_services","op":"update","values":{"notes":"' + 'A'.repeat(9 * 1024 * 1024) + '"}}';
    for (const url of ['/api/db', '/api/rpc/visit_document_archive']) {
      const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: nine });
      assert.equal(r.status, 401, url + ': без входа тело разобрано (' + r.status + ')');
      const bad = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'emsid=nope' }, body: '{not json' });
      assert.equal(bad.status, 401, url + ': чужая сессия, тело разобрано (' + bad.status + ')');
    }
    // вошедший — как прежде
    const cookie = await login(base, 'doc');
    const ok = await update(base, cookie, 2, { notes: 'Комментарий, правка' });
    assert.equal(ok.status, 200);
  } finally { server.close(); db.close(); }
});
