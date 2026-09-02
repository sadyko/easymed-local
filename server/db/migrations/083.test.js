// 083.test.js — BRANCH_RECORDS_V1: uid есть у всех и ни у кого не повторяется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

const TABLES = ['patients', 'visits', 'visit_services', 'lab_results'];

test('083: у каждой существующей строки появляется uid', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run();
  for (const t of TABLES) {
    const missing = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uid IS NULL`).get().n;
    assert.equal(missing, 0, t + ': строка без uid никуда не поедет');
  }
  db.close();
});

test('083: новая строка получает uid без участия прикладного кода', () => {
  const db = openDb(':memory:');
  migrate(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  assert.match(uid, /^[0-9a-f]{32}$/, 'uid проставлен триггером: ' + uid);
  db.close();
});

test('083: uid уникален — две записи под одним uid означали бы двойной приём', () => {
  const db = openDb(':memory:');
  migrate(db);
  const a = db.prepare("INSERT INTO patients (full_name) VALUES ('А')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(a).uid;
  db.prepare("INSERT INTO patients (full_name) VALUES ('Б')").run();
  assert.throws(
    () => db.prepare('UPDATE patients SET uid = ? WHERE full_name = ?').run(uid, 'Б'),
    /UNIQUE/,
    'база обязана отказать, а не выбрать одну из двух молча');
  db.close();
});

// Три теста выше все мигрируют ПУСТУЮ базу: у пациента там ровно одна строка,
// и её uid ставит ТРИГГЕР при INSERT, а не засев. Для visits/visit_services/
// lab_results таблицы вовсе пустые, так что «нет строки с uid IS NULL» на них
// истинно тривиально — удали все четыре строки UPDATE из 083_sync_uid.sql, и
// эти три теста не заметят разницы. Единственный путь, которым это обновление
// реально пройдут работающие клиники — база, заполненная НИЖЕ 083, на которую
// потом накатывается 083 (тот же приём, что и «70 000 legacy MRN» в 080.test.js).
test('083: засев проставляет uid всем УЖЕ существующим строкам — единственный путь, который пройдут живые клиники', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-083-'));
  try {
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (src) => {
      if (fs.statSync(src).isDirectory()) return true;
      const m = /^(\d{3,})_.*\.sql$/.exec(path.basename(src));
      return m ? Number(m[1]) < 83 : false;   // строго ниже 083 — её самой в базе ещё нет
    } });
    const db = openDb(':memory:');
    migrate(db, dir);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('patients') WHERE name='uid'").get().n, 0,
      'sanity: на этой базе колонки uid ещё нет — иначе тест ничего не проверяет');

    const N = 500;
    db.transaction(() => {
      const insPatient = db.prepare("INSERT INTO patients (full_name) VALUES (?)");
      const insVisit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, date('now','localtime'), 'scheduled')");
      const svcId = db.prepare(
        "INSERT INTO services (name, code, price, type, active) VALUES ('Общий анализ крови', 'CBC', 50000, 'lab', 1)"
      ).run().lastInsertRowid;
      const insVS = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)');
      const insLab = db.prepare('INSERT INTO lab_results (visit_service_id, value) VALUES (?, ?)');
      for (let i = 1; i <= N; i++) {
        const patientId = insPatient.run('Пациент ' + i).lastInsertRowid;
        const visitId = insVisit.run(patientId).lastInsertRowid;
        const visitServiceId = insVS.run(visitId, svcId).lastInsertRowid;
        insLab.run(visitServiceId, String(i));
      }
    })();

    fs.cpSync(path.join(MIGRATIONS_DIR, '083_sync_uid.sql'), path.join(dir, '083_sync_uid.sql'));
    migrate(db, dir);   // throws if the migration fails

    for (const t of TABLES) {
      const row = db.prepare(
        `SELECT COUNT(*) total, COUNT(uid) with_uid, COUNT(DISTINCT uid) distinct_uid FROM ${t}`
      ).get();
      assert.equal(row.total, N, t + ': ожидали ровно ' + N + ' строк');
      assert.equal(row.total - row.with_uid, 0, t + ': засев обязан закрыть КАЖДУЮ существующую строку, не только новые');
      assert.equal(row.distinct_uid, row.total, t + ': совпавший uid — это одна и та же запись под двумя именами');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// BRANCH_ORIGIN_V1 — «откуда запись». Отдельная колонка, а не буква MRN:
// MRN говорит, где ЗАВЕДЁН пациент, а работа принадлежит тому зданию, где
// сделана. NULL по умолчанию — это и есть «своё»: миграция не смеет объявить
// уже существующие строки клиники чужими.
test('083: sync_origin есть у всех четырёх таблиц и по умолчанию пуст — своя работа', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of TABLES) {
    const col = db.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('${t}') WHERE name='sync_origin'`).get();
    assert.ok(col, t + ': без колонки рабочие списки не отличат своё от чужого');
    assert.equal(col.type, 'TEXT', t + ': хранится буква узла');
    assert.equal(col.notnull, 0, t + ': NULL и есть «заведено здесь»');
    assert.equal(col.dflt_value, null, t + ': умолчание — пусто, а не выдуманная буква');
  }
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Свой')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT sync_origin FROM patients WHERE id = ?').get(id).sync_origin, null,
    'строка, заведённая здесь, ничем не помечается');
  db.close();
});
