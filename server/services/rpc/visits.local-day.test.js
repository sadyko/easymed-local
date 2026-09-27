// BILLING_AUDIT_FIX_V1 (A1, A8) — ДЕНЬ ВИЗИТА — МЕСТНЫЙ ДЕНЬ КЛИНИКИ.
//
// Клиника работает в UTC+5. Мастер визита хранит «сегодня 00:00» местного
// времени и отправляет его toISOString() — это ВЧЕРА 19:00Z. ensure_visit брал
// день как rawDate.slice(0,10), то есть ВЧЕРАШНИЙ, и искал визит дня по тем же
// первым десяти символам visit_date: сегодняшняя услуга ложилась во вчерашний
// визит пациента, а если его не было — заводился второй визит «сегодня».
//
// Часовой пояс задаётся здесь явно (TZ до первого запроса к базе): SQLite
// берёт 'localtime' у среды процесса, и тест обязан проверять UTC+5 на любой
// машине, а не только на той, где он написан.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { ensureVisit } = await import('./visits.js');

const REG = { id: 1, role: 'registrar' };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (1,'r','x','Reg','registrar',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (2,'d','x','Doc','doctor',1,'')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  return db;
}

test('A1: полночь по местному (вчера 19:00Z) — это СЕГОДНЯ, а не вчерашний визит', async () => {
  const db = freshDb();
  // Вчера (26.09) пациент был в 15:00 местного = 10:00Z.
  const yesterday = await ensureVisit(db, { patient_id: 1, date: '2026-09-26T10:00:00Z' }, REG);
  assert.equal(yesterday.created, true);
  // Сегодня (27.09) мастер шлёт местную полночь: 2026-09-26T19:00:00.000Z.
  const today = await ensureVisit(db, { patient_id: 1, date: '2026-09-26T19:00:00.000Z' }, REG);
  assert.equal(today.created, true, 'сегодняшняя услуга не ложится во вчерашний визит');
  assert.notEqual(today.visit.id, yesterday.visit.id);
  assert.equal(db.prepare("SELECT date(visit_date,'localtime') d FROM visits WHERE id=?").get(today.visit.id).d, '2026-09-27');
});

test('A1: визит дня, заведённый днём, находится и местной полночью того же дня', async () => {
  const db = freshDb();
  // Сегодня (27.09) в 10:00 местного = 05:00Z пациент уже пришёл.
  const morning = await ensureVisit(db, { patient_id: 1, date: '2026-09-27T05:00:00Z' }, REG);
  // Мастер добавляет услугу «на сегодня» — местная полночь 27.09 = 26.09T19:00Z.
  const again = await ensureVisit(db, { patient_id: 1, date: '2026-09-26T19:00:00.000Z' }, REG);
  assert.equal(again.created, false, 'второго визита сегодня нет');
  assert.equal(again.visit.id, morning.visit.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits').get().n, 1);
});

test('A1: запись колл-центра на 03:00 местного (22:00Z накануне) — день записи, а не вчера', async () => {
  const db = freshDb();
  const late = await ensureVisit(db, { patient_id: 1, date: '2026-09-27T22:00:00Z' }, REG);   // 28.09 03:00 местного
  const day = await ensureVisit(db, { patient_id: 1, date: '2026-09-28T06:00:00Z' }, REG);    // 28.09 11:00 местного
  assert.equal(day.created, false);
  assert.equal(day.visit.id, late.visit.id);
  const prev = await ensureVisit(db, { patient_id: 1, date: '2026-09-27T12:00:00Z' }, REG);   // 27.09 17:00 местного
  assert.equal(prev.created, true, '27.09 — другой день');
});

test('A1: голая дата YYYY-MM-DD — это уже местный день', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-09-27' }, REG);
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-09-26T19:30:00Z' }, REG);   // 27.09 00:30 местного
  assert.equal(b.created, false);
  assert.equal(b.visit.id, a.visit.id);
});

test('A8: визит соседнего здания (sync_origin) не забирает приход в этом здании', async () => {
  const db = freshDb();
  const theirs = db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (1, '2026-09-27T05:00:00Z', 'scheduled', 'B')").run().lastInsertRowid;
  const ours = await ensureVisit(db, { patient_id: 1, date: '2026-09-27T07:00:00Z' }, REG);
  assert.equal(ours.created, true, 'в этом здании заводится свой визит');
  assert.notEqual(ours.visit.id, theirs);
  assert.equal(ours.visit.sync_origin, null);
  const again = await ensureVisit(db, { patient_id: 1, date: '2026-09-27T09:00:00Z' }, REG);
  assert.equal(again.visit.id, ours.visit.id, 'а свой визит дня по-прежнему один');
});
