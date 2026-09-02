// 084.test.js — BRANCH_RECORDS_V1: журнал пишется САМ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();   // засев миграции 083 не мешает
  return db;
}

test('084: создание пациента попадает в журнал без участия кода', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const rows = db.prepare("SELECT tbl, op, uid FROM sync_journal WHERE tbl = 'patients'").all();
  assert.equal(rows.length >= 1 && rows.length <= 2, true,
    'один INSERT даёт одну или две записи (ins + upd uid-триггера) — третьей взяться неоткуда');
  assert.equal(rows.every((r) => r.op === 'put'), true);
  assert.equal(rows.every((r) => typeof r.uid === 'string' && r.uid.length === 32), true,
    'в журнале НИКОГДА нет записи без uid — иначе NOT NULL уронил бы регистрацию');
  db.close();
});

test('084: правка пишется отдельной записью', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  db.prepare("UPDATE patients SET phone = '+998900000000' WHERE id = ?").run(id);
  const after = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  assert.equal(after > before, true, 'правку обязаны увидеть соседи');
  db.close();
});

test('084: правка одной служебной колонки (updated_at) тоже журналируется', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  db.prepare("UPDATE patients SET updated_at = '2026-09-02T00:00:00Z' WHERE id = ?").run(id);
  const after = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  assert.equal(after, before + 1,
    'колонка выглядит "служебной", но триггер не различает колонки — это опора для правила защиты в Задаче 5');
  db.close();
});

test('084: seq — AUTOINCREMENT: после удаления хвоста журнала номера не переиспользуются', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Первый')").run();
  const maxBefore = db.prepare('SELECT MAX(seq) m FROM sync_journal').get().m;
  db.prepare('DELETE FROM sync_journal').run();   // Задача 5 подчищает хвост после отправки батча
  db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run();
  const minAfter = db.prepare('SELECT MIN(seq) m FROM sync_journal').get().m;
  assert.equal(minAfter > maxBefore, true,
    'обычный INTEGER PRIMARY KEY переиспользовал бы seq=1 — тогда правка упала бы НИЖЕ sent_seq соседа и никогда бы не уехала');
  db.close();
});

test('084: sync_seen существует с ключом (tbl, uid, col)', () => {
  const db = fresh();
  const cols = db.prepare("PRAGMA table_info(sync_seen)").all().map(c => c.name);
  assert.deepEqual(cols, ['tbl', 'uid', 'col', 'stamp']);
  db.prepare("INSERT INTO sync_seen (tbl, uid, col, stamp) VALUES ('patients','p1','phone','s1')").run();
  assert.throws(() => db.prepare("INSERT INTO sync_seen (tbl, uid, col, stamp) VALUES ('patients','p1','phone','s2')").run(),
    /UNIQUE|PRIMARY/, 'вторая метка для той же (tbl, uid, col) должна заменять, а не дублировать строку');
  db.close();
});

test('084: удаление записывается по uid УДАЛЁННОЙ строки', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  const del = db.prepare("SELECT uid FROM sync_journal WHERE op = 'del'").get();
  assert.equal(del.uid, uid, 'без uid соседи не поймут, что удалять');
  db.close();
});

test('084: журнал ведётся для всех четырёх таблиц', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')")
    .run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)')
    .run(vid, sid).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, value) VALUES (?, '5.2')").run(vsid);

  const tables = db.prepare('SELECT DISTINCT tbl FROM sync_journal ORDER BY tbl').all().map(r => r.tbl);
  assert.deepEqual(tables, ['lab_results', 'patients', 'visit_services', 'visits']);
  db.close();
});

test('084: таблицы ожидания и соседей существуют с нужными ключами', () => {
  const db = fresh();
  const pend = db.prepare("PRAGMA table_info(sync_pending)").all().map(c => c.name);
  assert.deepEqual(pend, ['tbl', 'uid', 'stamp', 'record', 'waits_tbl', 'waits_uid', 'received_at']);
  const peers = db.prepare("PRAGMA table_info(sync_peers)").all().map(c => c.name);
  assert.deepEqual(peers, ['node', 'sent_seq', 'last_ok', 'seed_floor', 'seed_tbl', 'seed_at', 'seed_id']);
  // Один и тот же (tbl, uid) в ожидании — одна строка: более поздняя замещает.
  db.prepare("INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid) VALUES ('visits','v1','s1','{}','patients','p1')").run();
  assert.throws(() => db.prepare("INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid) VALUES ('visits','v1','s2','{}','patients','p1')").run(), /UNIQUE|PRIMARY/);
  db.close();
});

test('084: удаление оставляет надгробие в sync_tombstones — независимо от журнала', () => {
  const db = fresh();
  const cols = db.prepare("PRAGMA table_info(sync_tombstones)").all().map(c => c.name);
  assert.deepEqual(cols, ['seq', 'tbl', 'uid', 'at']);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  const tomb = db.prepare("SELECT uid, seq FROM sync_tombstones WHERE tbl = 'patients'").get();
  assert.equal(tomb.uid, uid, 'холодный засев читает ЭТУ таблицу, не журнал — журнал у отправителя может быть уже вычищен');
  // UNIQUE(tbl, uid) — второй записи о том же удалении взяться неоткуда, но
  // сама вставка идёт INSERT OR REPLACE и не должна падать, случись такое.
  // REPLACE удаляет старую строку и вставляет новую — seq у неё БОЛЬШЕ
  // прежнего (это нормально и даже желательно: страница засева видит только
  // рост seq, а не переиспользование).
  db.prepare("INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('patients', ?)").run(uid);
  const after = db.prepare("SELECT COUNT(*) n, MAX(seq) s FROM sync_tombstones WHERE tbl = 'patients' AND uid = ?").get(uid);
  assert.equal(after.n, 1, 'REPLACE не должен оставлять дубль строки');
  assert.equal(after.s > tomb.seq, true, 'REPLACE обязан выдать НОВЫЙ seq, а не сохранить старый (N1)');
  db.close();
});

test('084: seq у sync_tombstones — AUTOINCREMENT: после чистки всех надгробий номера не переиспользуются', () => {
  const db = fresh();
  const id1 = db.prepare("INSERT INTO patients (full_name) VALUES ('Первый')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id1);
  const maxBefore = db.prepare('SELECT MAX(seq) m FROM sync_tombstones').get().m;
  db.prepare('DELETE FROM sync_tombstones').run();   // таблица опустела целиком, как после pruneJournal (N1 review)
  const id2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id2);
  const minAfter = db.prepare('SELECT MIN(seq) m FROM sync_tombstones').get().m;
  assert.equal(minAfter > maxBefore, true,
    'обычный rowid переиспользовал бы seq=1 — курсор соседа, остановившийся посреди фазы надгробий, молча пропустил бы новое надгробие');
  db.close();
});
