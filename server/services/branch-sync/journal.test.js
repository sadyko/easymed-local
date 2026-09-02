// journal.test.js — BRANCH_RECORDS_V1: что уезжает соседу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent, markPublished, markConfirmed, pruneJournal, SHIPPED, REFS, CODE_REFS } from './journal.js';
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

// changed — какие колонки мы правили. Снимок строки (data) уезжает целиком, но
// авторство теперь адресное: без него приёмник записывал бы нашу метку на
// КАЖДУЮ колонку снимка и объявлял нас автором того, чего мы не касались.
test('changed: уезжают ровно те колонки, что правили, и по одному разу', () => {
  const db = fresh(); warm(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', first.upto, first.clock, first.seed);   // сосед эту строку уже знает

  for (let i = 0; i < 3; i++) db.prepare('UPDATE patients SET phone = ? WHERE id = ?').run('+9989' + i, id);
  db.prepare("UPDATE patients SET address = 'Ташкент' WHERE id = ?").run(id);

  const recs = buildBatch(db, { self: 'B', peer: 'C' }).records.filter(r => r.tbl === 'patients');
  assert.equal(recs.length, 1, 'одна строка — одна запись');
  assert.deepEqual([...recs[0].changed].sort(), ['address', 'phone'],
    'обе колонки правили ЗДЕСЬ — обе и должны считаться нашими');
  assert.equal(recs[0].data.full_name, 'Иванов', 'а данные едут полной строкой: у соседа её может не быть вовсе');
  db.close();
});

test('changed: новая строка едет как «вся строка» (*)', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'patients');
  assert.deepEqual(rec.changed, ['*'], 'у соседа этой строки нет — авторские в ней все колонки');
  db.close();
});

test('changed: холодный засев едет как «вся строка» (*)', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Старожил')").run();
  db.prepare('DELETE FROM sync_journal').run();   // как на живой клинике после 083+084
  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'patients');
  assert.deepEqual(rec.changed, ['*'], 'засев читает таблицы, а не журнал: что там менялось, неизвестно');
  db.close();
});

test('changed: правка служебной колонки не поднимает строку в сеть вовсе', () => {
  const db = fresh(); warm(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', first.upto, first.clock, first.seed);
  db.prepare("UPDATE patients SET updated_at = '2026-09-02T00:00:00Z' WHERE id = ?").run(id);
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C' }).records, [],
    'касание updated_at не сетевое событие — раньше было, и вдобавок защищало строку от соседей');
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

// --- Задача 7b: подтверждённая доставка -------------------------------------
//
// Отметок стало две. «Выложено» (pub_seq) значит только «блоб лежит на
// сервере»: сосед мог его не читать, и следующая выгрузка блоб ЗАМЕЩАЕТ.
// Поэтому срез собирается от «подтверждено» (sent_seq), и всё, о чём сосед не
// отчитался, повторяется в каждом следующем блобе. Раньше здесь терялась
// целая ночь работы филиала.

test('7b: выложенное, но не подтверждённое, уезжает ЕЩЁ РАЗ', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(first.records.length > 0, true);

  markPublished(db, 'C', first.upto, first.clock, first.seed);   // 2xx от релея, и только
  const again = buildBatch(db, { self: 'B', peer: 'C' });
  assert.deepEqual(again.records.map(r => r.uid), first.records.map(r => r.uid),
    'сосед не подтвердил — содержимое обязано лежать и в следующем блобе');
  assert.equal(again.upto, first.upto, 'докуда доходит срез, от повтора не меняется');

  markConfirmed(db, 'C', first.upto);                            // квитанция приехала
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C' }).records, [],
    'подтверждённое по узкому каналу второй раз не гоняем');
  db.close();
});

test('7b: неподтверждённый хвост журнала чистка не трогает', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markPublished(db, 'C', b.upto, b.clock, b.seed);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n > 0, true,
    'вычистив хвост по одному лишь 2xx, повторить его было бы нечем');

  pruneJournal(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n > 0, true,
    'чистка идёт по ПОДТВЕРЖДЁННОМУ горизонту, а он ещё на нуле');

  markConfirmed(db, 'C', b.upto);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0,
    'а вот теперь хвост не нужен никому');
  db.close();
});

test('7b: подтвердить больше выложенного нельзя — квитанция приезжает снаружи', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markPublished(db, 'C', b.upto, b.clock, b.seed);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров')").run();   // это ещё не выкладывали

  markConfirmed(db, 'C', 999999);
  const row = db.prepare("SELECT pub_seq, sent_seq FROM sync_peers WHERE node = 'C'").get();
  assert.equal(row.sent_seq, row.pub_seq,
    'сосед со сломанной сборкой не должен уметь перепрыгнуть нас через невыложенное');
  assert.equal(buildBatch(db, { self: 'B', peer: 'C' }).records.some(r => r.data && r.data.full_name === 'Петров'), true,
    'иначе Петров не уехал бы никогда, а журнал его бы уже вычистил');
  db.close();
});

test('7b: квитанция несуществующему соседу ничего не заводит', () => {
  const db = fresh();
  markConfirmed(db, 'Z', 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'Z'").get().n, 0,
    'соседу, которому мы ни разу не выгружались, нечего было и получать');
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
  // Отматывается и updated_at: с Задачи 7d метка засева идёт от времени
  // ПОСЛЕДНЕЙ правки строки (updated_at там, где он есть), а created_at —
  // запасной вариант. Строка, созданная в 2020-м и с тех пор не тронутая,
  // должна и уехать с меткой 2020 года.
  db.prepare("UPDATE patients SET created_at = '2020-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z' WHERE id = ?")
    .run(survivorId);
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

test('N4: I4 — испорченная дата в журнале не чеканит метку эпохи 1970, а берёт время самой строки', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  db.prepare("UPDATE sync_journal SET at = 'garbage' WHERE tbl = 'patients'").run();
  const batch = buildBatch(db, { self: 'B', peer: 'C', clock: () => 1234 });
  const rec = batch.records.find(r => r.tbl === 'patients');
  const stamp = parseStamp(rec.stamp);
  assert.notEqual(stamp.ms, 0, 'NaN от Date.parse("garbage") не должен стать эпохой 1970: такая метка проиграла бы всему');
  // С Задачи 7d запасной вариант честнее часов вызова: у строки есть
  // СОБСТВЕННОЕ время правки (updated_at/created_at), и оно ближе к правде,
  // чем «сейчас» у того, кто собирает порцию.
  const rowAt = Date.parse(db.prepare("SELECT updated_at FROM patients WHERE full_name = 'Иванов'").get().updated_at);
  assert.equal(stamp.ms, rowAt, 'метка берётся из самой строки, а не из часов вызова');
  db.close();
});

// BRANCH_RECORDS_V1 (ревю Задачи 5b) — ТЕСТ ДРЕЙФА МЕЖДУ СПИСКОМ И ТРИГГЕРАМИ.
//
// Перечень отправляемых колонок живёт в ДВУХ местах сразу: в SHIPPED/REFS/
// CODE_REFS (что уезжает) и в CASE-списке каждого *_journal_upd (что считается
// изменённым). Разъехаться им нельзя, и обе половины дрейфа молчаливы:
//
//   * колонка в SHIPPED, но не в триггере — её правка не попадает в cols,
//     значит не попадает в changed, значит приёмник её НЕ ПРИМЕНИТ — правка
//     тихо остаётся в одном здании навсегда (правка ТОЛЬКО этой колонки
//     вообще не даёт записи в журнале);
//   * колонка в триггере, но не в SHIPPED — каждое её касание поднимает
//     строку в сеть и «защищает» её от соседей ради поля, которое не едет.
//
// Списки читаются из sqlite_master — то есть из того, что ДЕЙСТВИТЕЛЬНО лежит
// в базе после миграций, а не из текста файла 084: триггер, пересозданный
// позднейшей миграцией, должен проверяться тоже.
test('дрейф: список колонок в триггере и список отправляемых колонок — одно и то же', () => {
  const db = fresh();
  for (const tbl of Object.keys(SHIPPED)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(tbl + '_journal_upd');
    assert.ok(row && row.sql, tbl + ': триггер ' + tbl + '_journal_upd обязан существовать');

    // NEW.<col> IS NOT OLD.<col> — единственная форма, которой триггер
    // объявляет колонку изменённой. Стоит кому-то написать её иначе —
    // этот тест упадёт, и это правильно: форма здесь — часть договора.
    const inTrigger = new Set();
    for (const m of row.sql.matchAll(/NEW\.(\w+)\s+IS\s+NOT\s+OLD\.(\w+)/gi)) {
      assert.equal(m[1], m[2], tbl + ': сравниваются РАЗНЫЕ колонки — ' + m[1] + ' и ' + m[2]);
      inTrigger.add(m[1]);
    }

    const shipped = new Set([
      ...SHIPPED[tbl],
      ...Object.keys(REFS[tbl] || {}),
      ...Object.keys(CODE_REFS[tbl] || {}),
    ]);
    assert.deepEqual(
      [...inTrigger].sort(),
      [...shipped].sort(),
      tbl + ': список в триггере разошёлся с SHIPPED ∪ REFS ∪ CODE_REFS — '
        + 'колонка, добавленная в одно место и забытая в другом, теряет правки молча',
    );
  }
  db.close();
});

// --- Задача 7b: страницы засева подтверждаются по номеру ---------------------
//
// Курсор засева двигался по ВЫГРУЗКЕ, а блоб узла замещается следующей: у
// клиники на 70 000 пациентов сосед, выключенный на ночь, пропускал страницу
// целиком, и дыра приходилась на старых пациентов, которых никто не трогает,
// то есть была невидимой. Теперь у страницы есть номер, и курсор двигает
// только квитанция с этим номером.

test('7b: невыложенная… то есть неподтверждённая страница засева уезжает снова, и ТА ЖЕ', () => {
  const db = fresh();
  for (const name of ['Первый', 'Второй', 'Третий', 'Четвёртый']) {
    db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(name);
  }
  const first = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
  assert.equal(first.seed.page, 1, 'первая страница засева');
  const names = first.records.map(r => r.data.full_name).sort();
  markPublished(db, 'C', first.upto, first.clock, first.seed);

  const again = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
  assert.equal(again.seed.page, 1, 'страница не подтверждена — номер тот же');
  assert.deepEqual(again.records.map(r => r.data.full_name).sort(), names,
    'и строки те же: набор заморожен на начало засева, иначе сосед отсеял бы страницу и потерял её');

  markConfirmed(db, 'C', again.upto, again.seed.page);
  const second = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
  assert.equal(second.seed.page, 2, 'подтверждение сдвинуло курсор на следующую страницу');
  assert.equal(second.records.some(r => names.includes(r.data.full_name)), false,
    'вторая страница — про другие строки');
  db.close();
});

test('7b: строка, заведённая ПОСЛЕ начала засева, в засев не попадает — её везёт журнал', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Старожил')").run();
  // Время в created_at — секундной точности, поэтому «до» и «после» в одном
  // тесте надо разводить явно, иначе обе строки попадают в одну секунду и
  // граница засева ничего не разделяет.
  const minuteAgo = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  db.prepare("UPDATE patients SET created_at = ? WHERE full_name = 'Старожил'").run(minuteAgo);
  const first = buildBatch(db, { self: 'B', peer: 'C', limit: 50, clock: () => Date.now() - 30000 });
  markPublished(db, 'C', first.upto, first.clock, first.seed);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Новенький')").run();

  const again = buildBatch(db, { self: 'B', peer: 'C', limit: 50 });
  assert.deepEqual(again.records.map(r => r.data.full_name), ['Старожил'],
    'иначе «страница 1» во второй выгрузке — уже другой набор, и отсев по номеру терял бы новичка');
  markConfirmed(db, 'C', again.upto, again.seed.page);

  const warm = buildBatch(db, { self: 'B', peer: 'C', limit: 50 });
  assert.equal(warm.seed, null, 'засев закончен');
  assert.equal(warm.records.some(r => r.data.full_name === 'Новенький'), true,
    'а новичок приезжает журналом: его seq выше замороженного пола');
  db.close();
});

test('7b: пустой засев закрывается сразу — подтверждать в нём нечего', () => {
  const db = fresh();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  assert.deepEqual(b.records, [], 'клиника, где ещё никого не завели');
  markPublished(db, 'C', b.upto, b.clock, b.seed);
  assert.equal(db.prepare("SELECT seed_floor FROM sync_peers WHERE node = 'C'").get().seed_floor, null,
    'иначе узел ждал бы квитанцию за ноль строк вечно, а пустой срез в блоб даже не кладётся');
  db.prepare("INSERT INTO patients (full_name) VALUES ('Первый пациент')").run();
  assert.equal(buildBatch(db, { self: 'B', peer: 'C' }).records.length > 0, true,
    'и первый же заведённый пациент уезжает журналом');
  db.close();
});

test('7b: номер страницы из будущего курсор не двигает', () => {
  const db = fresh();
  for (const name of ['А', 'Б', 'В', 'Г']) db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(name);
  const first = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
  markPublished(db, 'C', first.upto, first.clock, first.seed);

  markConfirmed(db, 'C', first.upto, 7);   // сосед со сломанной сборкой
  const after = buildBatch(db, { self: 'B', peer: 'C', limit: 2 });
  assert.equal(after.seed.page, 1,
    'перепрыгнув страницу, мы оставили бы у соседа дыру, которую уже нечем закрыть');
  db.close();
});

test('7b: молчуна забывают по КВИТАНЦИИ, а не по нашей выгрузке', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markPublished(db, 'C', b.upto, b.clock, b.seed);
  // Выгрузки идут исправно (last_ok свежий), а квитанций нет уже 40 дней:
  // сосед выключен навсегда. Раньше last_ok держал бы его в списке вечно, а с
  // ним — и наш журнал, и его недосеянный засев.
  db.prepare("UPDATE sync_peers SET last_ack = ? WHERE node = 'C'")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());
  pruneJournal(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'C'").get().n, 0,
    'сосед, который сорок дней ничего не подтверждает, забыт — по возвращении он получит засев заново');
  db.close();
});
