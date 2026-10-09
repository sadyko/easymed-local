// FINAL_MONEY_FIX_V1 (M6) — ДЕНЬ ПРИХОДА — МЕСТНЫЙ ДЕНЬ КЛИНИКИ.
//
// Приход закрывает заявки БЕЗ СТРОК того же пациента на день визита
// (settleLineless). День брался как substr(visit_date, 1, 10) — день по UTC.
// Визит на 00:30 по местному (UTC+5) хранится вчерашним 19:30Z, и заявку на
// сегодня он не закрывал, а вчерашнюю — закрывал. ensure_visit и отчёты
// считают день по местному времени (domain/day.js localDate) — здесь так же.
//
// Часовой пояс задаётся явно (TZ до первого запроса к базе): SQLite берёт
// 'localtime' у среды процесса — как в rpc/visits.local-day.test.js.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { crmVisitStatus } = await import('./visit-status.js');

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Пациент')").run();
  return db;
}
// CRM_UNIFY_V1 (финальное ревью, A-I3) — ОБНОВЛЕНО НАМЕРЕННО: приход закрывает только
// карточку, заведённую в день визита или раньше, — карточки заведены до визита.
const addReq = (db, date, name) =>
  db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date, created_at) VALUES (?,?,'scheduled',1,?,'2026-08-01T00:00:00Z')")
    .run(name, '998900000000', date).lastInsertRowid;
const status = (db, id) => db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(id).status;

test('M6: приход в 00:30 по местному закрывает заявку без строк на СЕГОДНЯ, а не на вчера', () => {
  const db = freshDb();
  // 2026-08-10 00:30 в UTC+5 = 2026-08-09T19:30:00Z.
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1,'2026-08-09T19:30:00Z','scheduled')").run().lastInsertRowid;
  const todayReq = addReq(db, '2026-08-10', 'на сегодня');
  const yesterdayReq = addReq(db, '2026-08-09', 'на вчера');

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(status(db, todayReq), 'came', 'заявка на день визита не закрылась приходом');
  assert.equal(status(db, yesterdayReq), 'scheduled', 'приход закрыл заявку на вчерашний день (день по UTC)');
  db.close();
});
