// journal.test.js — BRANCH_RECORDS_V1: что уезжает соседу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent, pruneJournal } from './journal.js';
import { parseStamp } from './hlc.js';
import { applyBatch } from './records.js';

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
  markSent(db, 'C', batch.upto, batch.clock, batch.seed);
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

test('услуга уезжает КОДОМ справочника, а не своим локальным id', () => {
  const db = fresh(); warm(db);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)').run(vid, sid);
  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'visit_services');
  assert.equal(rec.data.service_id, undefined, 'id услуги у соседа означал бы ДРУГУЮ услугу');
  assert.equal(rec.refs.service_code, 'S-9', 'справочник синхронизирует catalogue.js — общее у обеих сторон только код');
  db.close();
});

// --- ревью Задачи 4 (328d1a0+c72645e): C1 — холодный засев страницами ---

test('C1: холодный засев страницами — limit меньше общего числа строк отдаёт всё по частям', () => {
  const db = fresh();
  const names = ['А', 'Б', 'В', 'Г', 'Д'];
  for (const n of names) db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(n);

  const seen = [];
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const b = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
    seen.push(...b.records.map(r => r.data.full_name));
    markSent(db, 'C', b.upto, b.clock, b.seed);
    done = b.seed.done;
  }
  assert.equal(done, true, 'засев обязан когда-нибудь завершиться, а не зависнуть');
  assert.deepEqual(seen.sort(), [...names].sort(),
    'все пять пациентов доехали, а не только первая страница — это и есть дыра «5000 из 18000»');
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C', limit: 2 }).records, [], 'засев закончен — сосед тёплый, повторов нет');
  db.close();
});

test('C1: под лимитом порядок «родитель раньше ребёнка» сохраняется даже постранично', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)').run(vid, sid).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '140')").run(vsid);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'WBC', '6')").run(vsid);

  const all = [];
  let done = false;
  for (let i = 0; i < 20 && !done; i++) {
    const b = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
    all.push(...b.records);
    markSent(db, 'C', b.upto, b.clock, b.seed);
    done = b.seed.done;
  }
  assert.equal(all.length, 5, 'пациент + визит + услуга + два анализа');
  const pos = (pred) => all.findIndex(pred);
  assert.equal(pos(r => r.tbl === 'patients') < pos(r => r.tbl === 'visits'), true, 'пациент раньше визита');
  assert.equal(pos(r => r.tbl === 'visits') < pos(r => r.tbl === 'visit_services'), true, 'визит раньше услуги');
  const vsPos = pos(r => r.tbl === 'visit_services');
  for (let i = 0; i < all.length; i++) {
    if (all[i].tbl === 'lab_results') assert.equal(vsPos < i, true, 'результат анализа приезжает после своей услуги');
  }
  db.close();
});

test('C1: правка, случившаяся ПОКА идёт засев, не теряется под замороженным полом', () => {
  const db = fresh();
  const ids = ['А', 'Б', 'В', 'Г'].map(n => db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(n).lastInsertRowid);

  const first = buildBatch(db, { self: 'B', peer: 'C', limit: 1 });
  assert.equal(first.seed.done, false, 'страница меньше пациентов — засев ещё не закончен');
  markSent(db, 'C', first.upto, first.clock, first.seed);

  // Правка ПОСЛЕ старта засева, но ДО его конца: её seq обязан лечь ВЫШЕ
  // пола, замороженного в самом начале (Minor 9) — иначе после засева, когда
  // sent_seq станет этим полом, правка окажется НИЖЕ него и не уедет никогда.
  db.prepare("UPDATE patients SET phone = '+998900000001' WHERE id = ?").run(ids[0]);

  let done = false;
  for (let i = 0; i < 20 && !done; i++) {
    const b = buildBatch(db, { self: 'B', peer: 'C', limit: 1 });
    markSent(db, 'C', b.upto, b.clock, b.seed);
    done = b.seed.done;
  }

  const warmBatch = buildBatch(db, { self: 'B', peer: 'C' });
  const edited = warmBatch.records.find(r => r.tbl === 'patients' && r.data && r.data.phone === '+998900000001');
  assert.notEqual(edited, undefined, 'правка эпохи засева обязана приехать первой же тёплой порцией, а не потеряться');
  db.close();
});

// --- C2 — надгробие переживает чистку журнала у забытого соседа ---

test('C2: забытый сосед по возвращении получает и надгробие, и presence со своей НАСТОЯЩЕЙ меткой (не «сейчас»)', () => {
  const db = fresh();
  const survivorId = db.prepare("INSERT INTO patients (full_name) VALUES ('Остаётся')").run().lastInsertRowid;
  // Старая правка — чтобы отличить «метка от created_at» от «метка от
  // надгробия, прошедшего первым» (ревью Задачи 4, N2): 2020 год не спутать
  // с «сейчас» ни при какой раскладке.
  db.prepare("UPDATE patients SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(survivorId);
  const xId = db.prepare("INSERT INTO patients (full_name) VALUES ('X')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(xId);   // у X теперь и presence нет, и есть надгробие

  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('D', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());   // D молчит 40 дней

  // pruneJournal напрямую, а не через buildBatch+markSent постороннего соседа:
  // тот прогнал бы survivor/X через хвост ЖУРНАЛА (его `at` — время ЗАПИСИ,
  // всегда «сейчас») и поднял бы часы узла ДО того, как мы вообще посмотрим
  // на засев D — тогда 2020 год «испортился» бы этим посторонним шагом, а не
  // порядком фаз внутри seedPage, который здесь и проверяется.
  pruneJournal(db);   // обязана забыть D (ревью Задачи 4/5, C2 в связке с прошлым фиксом)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'D'").get().n, 0);

  const forD = buildBatch(db, { self: 'B', peer: 'D' });
  const delRec = forD.records.find(r => r.op === 'del');
  const survivorRec = forD.records.find(r => r.op === 'put' && r.data.full_name === 'Остаётся');
  assert.notEqual(delRec, undefined, 'надгробие X обязано попасть в засев — иначе D решит, что X ещё существует');
  assert.notEqual(survivorRec, undefined, 'и живая строка тоже должна доехать');

  // N2: presence несёт метку от СВОЕГО created_at, а не «сейчас», раздутого
  // надгробием, прошедшим первым в старом порядке фаз.
  const stamp = parseStamp(survivorRec.stamp);
  assert.equal(Math.abs(stamp.ms - Date.parse('2020-01-01T00:00:00Z')) < 2000, true,
    'метка присутствия обязана нести её собственное время правки: ' + stamp.ms + ' vs ' + Date.parse('2020-01-01T00:00:00Z'));

  // Круглый путь до приёмника: D применяет свою порцию и должна остаться без
  // X — порядок применения решают метки и надгробия (records.js), не порядок
  // записей внутри порции.
  const receiver = fresh();
  applyBatch(receiver, forD.records, { self: 'D' });
  assert.equal(receiver.prepare("SELECT 1 FROM patients WHERE full_name = 'X'").get(), undefined, 'X не должен появиться у соседа');
  assert.notEqual(receiver.prepare("SELECT 1 FROM patients WHERE full_name = 'Остаётся'").get(), undefined, 'живая строка обязана приехать');
  receiver.close();
  db.close();
});

// --- C3 — панель анализов не схлопывается в одну безымянную строку ---

test('C3: параметр анализа и границы нормы уезжают — два аналита остаются различимы', () => {
  const db = fresh(); warm(db);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run().lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)').run(vid, sid).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, ref_low, ref_high) VALUES (?, 'HGB', '142', 120, 160)").run(vsid);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, ref_low, ref_high) VALUES (?, 'WBC', '6.2', 4, 9)").run(vsid);

  const recs = buildBatch(db, { self: 'B', peer: 'C' }).records.filter(r => r.tbl === 'lab_results');
  assert.equal(recs.length, 2, 'два аналита — две записи, а не одна, перезаписанная другой');
  const byParam = Object.fromEntries(recs.map(r => [r.data.parameter, r.data]));
  assert.equal(byParam.HGB.value, '142');
  assert.equal(byParam.WBC.value, '6.2');
  assert.equal(byParam.HGB.ref_low, 120);
  assert.equal(byParam.HGB.ref_high, 160);
  db.close();
});

test('C3: круглый путь до приёмника — два аналита приезжают как две строки, а не одна', () => {
  const db = fresh(); warm(db);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run().lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)').run(vid, sid).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '142')").run(vsid);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'WBC', '6.2')").run(vsid);

  const batch = buildBatch(db, { self: 'B', peer: 'C' });

  const receiver = fresh();
  // Код услуги приёмник уже знает — этим в реальности занимается catalogue.js
  // (Этап 1); здесь заводим строку руками, ровно так, как её застал бы приём.
  receiver.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run();
  applyBatch(receiver, batch.records, { self: 'C' });

  const rows = receiver.prepare('SELECT parameter, value FROM lab_results').all();
  assert.equal(rows.length, 2, 'два аналита обязаны прийти как две строки, а не одна перезаписанная другой');
  const byParam = Object.fromEntries(rows.map(r => [r.parameter, r.value]));
  assert.equal(byParam.HGB, '142');
  assert.equal(byParam.WBC, '6.2');
  receiver.close();
  db.close();
});

// --- ревью Задачи 4 (e3f035f): N1 — надгробия по seq, не по rowid ---

test('N1: возобновлённый курсор фазы надгробий не теряет новую запись после того, как таблица опустела (seq, не rowid)', () => {
  const db = fresh(); warm(db, 'C');   // тёплый посторонний сосед — есть кому не мешать чистке
  const id1 = db.prepare("INSERT INTO patients (full_name) VALUES ('Первый')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id1);   // presence нет ни одного — курсор D сразу в фазе надгробий

  const first = buildBatch(db, { self: 'B', peer: 'D', limit: 1 });
  assert.equal(first.seed.tbl, 'sync_tombstones', 'без единой presence-строки курсор сразу в фазе надгробий');
  markSent(db, 'D', first.upto, first.clock, first.seed);

  // Чистка вычищает ВСЕ надгробия разом — таблица пустеет. С обычным rowid
  // (без AUTOINCREMENT) следующий INSERT получил бы rowid=1 — тот самый номер,
  // что курсор D уже прошёл.
  db.prepare('UPDATE sync_tombstones SET at = ?').run(new Date(Date.now() - 61 * 86400000).toISOString());
  pruneJournal(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_tombstones').get().n, 0, 'обе (пока одна) записи старше 60 дней вычищены целиком');

  const id2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id2);   // новое надгробие — родилось ПОСЛЕ чистки

  const second = buildBatch(db, { self: 'B', peer: 'D', limit: 5000 });
  assert.equal(second.records.some(r => r.op === 'del'), true,
    'новое надгробие обязано попасть в засев — с переиспользованным rowid курсор молча пропустил бы его');
  db.close();
});

// --- N4 — регрессии на защиты, которые до этого проверялись только вручную ---

test('N4: markSent без seed для холодного соседа падает и не заводит строку в sync_peers (I5 — транзакция целиком)', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  assert.throws(() => markSent(db, 'C', 0, null), /without seed info/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'C'").get().n, 0,
    'ошибка обязана откатить ВСЁ — иначе сосед считался бы наполовину заведённым');
  db.close();
});

test('N4: markSent без seed для соседа В ПРОЦЕССЕ засева падает и не сдвигает курсор', () => {
  const db = fresh();
  for (const n of ['А', 'Б', 'В']) db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(n);
  const first = buildBatch(db, { self: 'B', peer: 'C', limit: 1 });
  markSent(db, 'C', first.upto, first.clock, first.seed);
  const before = db.prepare("SELECT * FROM sync_peers WHERE node = 'C'").get();
  assert.equal(before.seed_floor != null, true, 'сосед действительно посреди засева');

  const next = buildBatch(db, { self: 'B', peer: 'C', limit: 1 });
  assert.throws(() => markSent(db, 'C', next.upto, next.clock), /without seed info/);
  const after = db.prepare("SELECT * FROM sync_peers WHERE node = 'C'").get();
  assert.deepEqual(after, before, 'ошибка обязана откатить транзакцию целиком — курсор не сдвинулся ни на страницу');
  db.close();
});

test('N4: I6 — соседей не осталось после чистки забытых, журнал вычищается целиком', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('C', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());   // единственный сосед молчит 40 дней
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n > 0, true);
  pruneJournal(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_peers').get().n, 0, 'единственный сосед забыт');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0, 'держать хвост больше некому — I6');
  db.close();
});

test('N4: I4 — испорченная дата в журнале не чеканит метку эпохи 1970, а падает на часы вызова', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  db.prepare("UPDATE sync_journal SET at = 'garbage' WHERE tbl = 'patients'").run();
  const batch = buildBatch(db, { self: 'B', peer: 'C', clock: () => 1234 });
  const rec = batch.records.find(r => r.tbl === 'patients');
  const stamp = parseStamp(rec.stamp);
  assert.equal(stamp.ms, 1234, 'NaN от Date.parse("garbage") не должен стать эпохой 1970 — используем часы вызова');
  db.close();
});
