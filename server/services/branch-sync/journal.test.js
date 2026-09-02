// journal.test.js — BRANCH_RECORDS_V1: что уезжает соседу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent, pruneJournal } from './journal.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}

// Все тесты ниже, кроме «холодного соседа», начинают с ТЁПЛОГО соседа:
// строка в sync_peers уже есть. Без неё первая порция — засев из таблиц.
function warm(db, peer = 'C') {
  db.prepare("INSERT OR IGNORE INTO sync_peers (node, sent_seq, last_ok) VALUES (?, 0, ?)").run(peer, new Date().toISOString());
}

test('порция несёт ПОЛНУЮ строку, а не поля, которые менялись', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов', '+998901112233')").run();
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  const rec = batch.records.find(r => r.tbl === 'patients');
  assert.equal(rec.data.full_name, 'Иванов');
  assert.equal(rec.data.phone, '+998901112233');
  db.close();
});

test('строка, изменённая много раз, уезжает ОДИН раз', () => {
  const db = fresh(); warm(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  for (let i = 0; i < 5; i++) db.prepare('UPDATE patients SET phone = ? WHERE id = ?').run('+9989' + i, id);
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(batch.records.filter(r => r.tbl === 'patients').length, 1, 'уезжает состояние, а не история правок');
  db.close();
});

test('удалённая строка уезжает как удаление, без данных', () => {
  const db = fresh(); warm(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'patients');
  assert.equal(rec.op, 'del');
  assert.equal(rec.data, undefined, 'данных удалённой строки у нас уже нет');
  db.close();
});

test('markSent сдвигает отметку, и следующая порция пуста', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(first.records.length > 0, true);
  markSent(db, 'C', first.upto, first.clock);
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C' }).records, [], 'дважды одно и то же по узкому каналу не гоняем');
  db.close();
});

test('метка — от времени ПРАВКИ, и растёт при переводе часов назад между порциями', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', first.upto, first.clock);
  db.prepare("UPDATE patients SET phone = '+998900000000' WHERE full_name = 'Иванов'").run();
  const second = buildBatch(db, { self: 'B', peer: 'C', clock: () => 1 });   // часы машины «ушли в 1970»
  const a = first.records[0].stamp, b = second.records[0].stamp;
  assert.equal(b > a, true, 'метка не откатилась вместе с часами: ' + a + ' -> ' + b);
  db.close();
});

test('холодному соседу уезжают строки, существовавшие ДО журнала', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Старожил')").run();
  db.prepare('DELETE FROM sync_journal').run();   // как на живой клинике после 083+084
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(batch.records.some(r => r.tbl === 'patients' && r.data.full_name === 'Старожил'), true,
    'иначе «у соседа просто нет этого пациента» — неотличимо от поломки транспорта');
  markSent(db, 'C', batch.upto, batch.clock);
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C' }).records, [], 'засев не повторяется');
  db.close();
});

test('отданный всем хвост журнала вычищается; заброшенный сосед чистку не держит', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b.upto, b.clock);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0, 'единственный сосед всё получил');
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров')").run();
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('D', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());   // 40 дней молчит
  const b2 = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b2.upto, b2.clock);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0);
  db.close();
});

test('заброшенный сосед по возвращении получает холодный засев, а не дыру', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b.upto, b.clock);
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('D', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());   // 40 дней молчит
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров')").run();
  const b2 = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b2.upto, b2.clock);   // чистка: журнал ниже позиции D вычищен
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'D'").get().n, 0,
    'молчавший 40 дней сосед забыт, а не оставлен с устаревшим sent_seq');
  const forD = buildBatch(db, { self: 'B', peer: 'D' });
  const names = forD.records.filter(r => r.tbl === 'patients').map(r => r.data.full_name);
  assert.deepEqual(names.sort(), ['Иванов', 'Петров'],
    'без строки в sync_peers D снова холодный — засев из таблиц покрывает и то, что уже вычищено из журнала');
  db.close();
});

test('деньги из visit_services не уезжают', () => {
  const db = fresh(); warm(db);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 50000, 50000)').run(vid, sid);
  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'visit_services');
  assert.equal(rec.data.status !== undefined, true, 'статус нужен: на нём лабораторная очередь');
  assert.equal(rec.data.unit_price, undefined, 'цена — Фаза 3');
  assert.equal(rec.data.total, undefined, 'сумма — Фаза 3');
  assert.equal(rec.refs.visit_id.length, 32, 'родитель — по uid, локальный id у соседа другой');
  db.close();
});
