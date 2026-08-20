// QUEUE_LOCAL_DAY_V1 (мигр. 071) — перенос уже выданных талонов в их день.
//
// Миграция трогает живые талоны, поэтому проверяется не «что-то поменялось», а
// три обещания: номер не меняется, прошлое не переписывается, дубликат номера
// не создаётся ни при каких данных.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '071_queue_local_day_backfill.sql'), 'utf8');

// База БЕЗ 071: применяем миграции до 070, чтобы сначала завести «кривые»
// талоны, а потом прогнать саму миграцию и увидеть, что она делает.
function dbBefore071() {
  const db = openDb(':memory:');
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'mig071-'));
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && !x.startsWith('071'))) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П1'),(2,'П2')").run();
  return db;
}

// Местная полночь нужного дня в том виде, в каком её пишет мастер записи.
const midnight = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};
const localDay = (db, iso) => db.prepare("SELECT date(?, 'localtime') d").get(iso).d;

function line(db, { patient, iso, key, no }) {
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,'scheduled')").run(patient, iso).lastInsertRowid;
  return db.prepare(
    `INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, scheduled_at, queue_key, queue_no)
     VALUES (?, NULL, 1, 0, 0, 'added', ?, ?, ?)`).run(v, iso, key, no).lastInsertRowid;
}
const keyOf = (db, id) => db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id=?').get(id);

test('071 переносит будущий талон в его день и НЕ меняет номер', () => {
  const db = dbBefore071();
  const iso = midnight(1);                 // завтра, местная полночь
  const real = localDay(db, iso);
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());
  const id = line(db, { patient: 1, iso, key: 'lab:' + wrong, no: 7 });

  db.exec(SQL);

  const r = keyOf(db, id);
  assert.equal(r.queue_key, 'lab:' + real, 'ключ переехал в свой день');
  assert.equal(r.queue_no, 7, 'номер на руках у пациента не изменился');
  db.close();
});

test('071 НЕ трогает прошедшие дни', () => {
  const db = dbBefore071();
  const iso = midnight(-3);                // три дня назад
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());
  const id = line(db, { patient: 1, iso, key: 'lab:' + wrong, no: 5 });

  db.exec(SQL);

  // В той очереди уже никто не стоит: переписывать историю — риск без выгоды.
  assert.equal(keyOf(db, id).queue_key, 'lab:' + wrong);
  db.close();
});

test('071 НЕ переносит строку, если номер в целевом дне занят другим пациентом', () => {
  const db = dbBefore071();
  const iso = midnight(1);
  const real = localDay(db, iso);
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());

  // Второй пациент уже стоит под №3 в ПРАВИЛЬНОМ дне.
  line(db, { patient: 2, iso, key: 'lab:' + real, no: 3 });
  const moving = line(db, { patient: 1, iso, key: 'lab:' + wrong, no: 3 });

  db.exec(SQL);

  // Перенос создал бы двух пациентов с №3 в одной очереди — миграция обязана
  // оставить строку как есть, а не «починить» ценой дубликата.
  assert.equal(keyOf(db, moving).queue_key, 'lab:' + wrong, 'конфликтная строка не тронута');
  const dup = db.prepare(`SELECT COUNT(*) c FROM (
      SELECT vs.queue_key, vs.queue_no FROM visit_services vs JOIN visits v ON v.id=vs.visit_id
       WHERE vs.queue_no IS NOT NULL GROUP BY vs.queue_key, vs.queue_no
      HAVING COUNT(DISTINCT v.patient_id) > 1)`).get().c;
  assert.equal(dup, 0, 'дубликатов номера не появилось');
  db.close();
});

test('071 переносит, если тот же номер в целевом дне занят ТЕМ ЖЕ пациентом', () => {
  const db = dbBefore071();
  const iso = midnight(1);
  const real = localDay(db, iso);
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());

  // Один пациент, один номер — так и должно быть: все его анализы под №4.
  line(db, { patient: 1, iso, key: 'lab:' + real, no: 4 });
  const moving = line(db, { patient: 1, iso, key: 'lab:' + wrong, no: 4 });

  db.exec(SQL);
  assert.equal(keyOf(db, moving).queue_key, 'lab:' + real);
  db.close();
});

test('071 идемпотентна: повторный прогон ничего не меняет', () => {
  const db = dbBefore071();
  const iso = midnight(1);
  const real = localDay(db, iso);
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());
  const id = line(db, { patient: 1, iso, key: 'proc:room:' + wrong, no: 2 });

  db.exec(SQL);
  const after = keyOf(db, id);
  db.exec(SQL);
  assert.deepEqual(keyOf(db, id), after);
  assert.equal(after.queue_key, 'proc:room:' + real);
  db.close();
});

test('071 сохраняет префикс очереди (врач/лаборатория/кабинет не подменяются)', () => {
  const db = dbBefore071();
  const iso = midnight(1);
  const real = localDay(db, iso);
  const wrong = localDay(db, new Date(new Date(iso).getTime() - 86400000).toISOString());
  const a = line(db, { patient: 1, iso, key: 'doc:31:' + wrong, no: 1 });
  const b = line(db, { patient: 2, iso, key: 'img:445:' + wrong, no: 1 });

  db.exec(SQL);
  assert.equal(keyOf(db, a).queue_key, 'doc:31:' + real);
  assert.equal(keyOf(db, b).queue_key, 'img:445:' + real);
  db.close();
});
