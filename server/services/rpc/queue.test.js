import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueQueueNumbers } from './queue.js';

const REG = { id: 1, role: 'registrar' };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (1,'r','x','Reg','registrar',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty, is_doctor) VALUES (2,'d1','x','Др. Азиза','doctor',1,'Терапевт',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty, is_doctor) VALUES (3,'d2','x','Др. Борис','doctor',1,'ЛОР',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'Приём терапевта',50000,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2,'Приём ЛОРа',60000,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (3,'ОАК',30000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (4,'Биохимия',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (5,'Рентген',80000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (6,'УЗИ',90000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (7,'Капельница',20000,'procedure')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П1')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'П2')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,'2026-08-07T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (2,2,'2026-08-07T10:00:00Z','scheduled')").run();
  return db;
}
function addLine(db, { visit = 1, svc, doctor = null, when = null }) {
  return db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, scheduled_at) VALUES (?,?,?,1,0,0,\'added\',?)')
    .run(visit, svc, doctor, when).lastInsertRowid;
}

test('queue: consultations queue per doctor; labs share one number per patient', () => {
  const db = freshDb();
  const cons1 = addLine(db, { svc: 1, doctor: 2 });            // терапевт
  const lab1  = addLine(db, { svc: 3 });                       // ОАК
  const lab2  = addLine(db, { svc: 4 });                       // Биохимия (тот же пациент)
  const t = issueQueueNumbers(db, { p_ids: [cons1, lab1, lab2] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));
  assert.equal(by.get(cons1).number, 1);
  assert.match(by.get(cons1).queue_key, /^doc:2:/);
  assert.equal(by.get(cons1).label, 'Др. Азиза');
  // обе лаборатории — ОДНО место в очереди лаборатории
  assert.equal(by.get(lab1).number, by.get(lab2).number);
  assert.equal(by.get(lab1).label, 'Лаборатория');

  // второй пациент: у терапевта №2… а у ЛОРа — своя очередь, №1
  const p2cons = addLine(db, { visit: 2, svc: 1, doctor: 2 });
  const p2lor  = addLine(db, { visit: 2, svc: 2, doctor: 3 });
  const p2lab  = addLine(db, { visit: 2, svc: 3 });
  const t2 = issueQueueNumbers(db, { p_ids: [p2cons, p2lor, p2lab] }, REG);
  const by2 = new Map(t2.map(x => [x.visit_service_id, x]));
  assert.equal(by2.get(p2cons).number, 2);   // очередь терапевта
  assert.equal(by2.get(p2lor).number, 1);    // очередь ЛОРа — отдельная
  assert.equal(by2.get(p2lab).number, 2);    // лаборатория: второй пациент — №2
});

test('queue: imaging WITHOUT a doctor queues per apparatus; procedures per doctor or room', () => {
  const db = freshDb();
  const xr1 = addLine(db, { svc: 5 });                    // Рентген п1
  const uz1 = addLine(db, { svc: 6 });                    // УЗИ п1
  const xr2 = addLine(db, { visit: 2, svc: 5 });          // Рентген п2
  const prD = addLine(db, { svc: 7, doctor: 2 });         // процедура с врачом
  const prR = addLine(db, { visit: 2, svc: 7 });          // процедура без врача -> кабинет
  const t = issueQueueNumbers(db, { p_ids: [xr1, uz1, xr2, prD, prR] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));
  assert.equal(by.get(xr1).number, 1);                    // рентген-аппарат
  assert.equal(by.get(uz1).number, 1);                    // УЗИ — своя очередь
  assert.equal(by.get(xr2).number, 2);                    // второй на рентген
  assert.match(by.get(prD).queue_key, /^doc:2:/, 'процедура врача — его же очередь');
  assert.equal(by.get(prR).label, 'Процедурный кабинет');
  assert.equal(by.get(prR).number, 1);
});

// QUEUE_IMG_DOCTOR_V1 — диагностику ведёт врач, а не аппарат.
//
// До этого у одного УЗИ-специалиста заводилась отдельная линия на КАЖДУЮ
// услугу: в живой базе 18 талонов на 9 услуг, и все девять очередей начинались
// с №1. Пациенты у одной двери держали 1, 1, 2 — порядка из этого не следует.
test('queue: диагностика с врачом — ОДНА очередь врача на все его услуги', () => {
  const db = freshDb();
  const uzi   = addLine(db, { visit: 1, svc: 6, doctor: 2 });   // УЗИ, врач 2
  const xray  = addLine(db, { visit: 2, svc: 5, doctor: 2 });   // другая услуга, тот же врач
  const other = addLine(db, { visit: 2, svc: 6, doctor: 3 });   // та же услуга, другой врач
  const t = issueQueueNumbers(db, { p_ids: [uzi, xray, other] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));

  assert.match(by.get(uzi).queue_key, /^doc:2:/);
  assert.match(by.get(xray).queue_key, /^doc:2:/, 'разные услуги одного врача — одна линия');
  assert.equal(by.get(uzi).number, 1);
  assert.equal(by.get(xray).number, 2, 'второй пациент к тому же врачу получает №2, а не №1');

  assert.match(by.get(other).queue_key, /^doc:3:/, 'у другого врача своя линия');
  assert.equal(by.get(other).number, 1);
});

test('queue: два исследования одному пациенту у одного врача — ОДИН номер', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 5, doctor: 2 });
  const b = addLine(db, { visit: 1, svc: 6, doctor: 2 });
  const t = issueQueueNumbers(db, { p_ids: [a, b] }, REG);
  assert.equal(t[0].number, 1);
  assert.equal(t[1].number, 1, 'в одну дверь человек стоит один раз');
});

test('queue: аппарат без врача (рентген) остаётся очередью аппарата', () => {
  const db = freshDb();
  const xr = addLine(db, { svc: 5 });
  const t = issueQueueNumbers(db, { p_ids: [xr] }, REG);
  assert.match(t[0].queue_key, /^img:5:/, 'без врача ключ по услуге, как раньше');
  assert.equal(t[0].label, 'Рентген');
});

test('queue: подпись диагностики с врачом — имя врача, а не название аппарата', () => {
  const db = freshDb();
  const uzi = addLine(db, { svc: 6, doctor: 2 });
  const t = issueQueueNumbers(db, { p_ids: [uzi] }, REG);
  assert.equal(t[0].label, 'Др. Азиза');
});

test('queue: reprint reuses the same numbers (idempotent)', () => {
  const db = freshDb();
  const a = addLine(db, { svc: 1, doctor: 2 });
  const b = addLine(db, { svc: 3 });
  const first  = issueQueueNumbers(db, { p_ids: [a, b] }, REG);
  const second = issueQueueNumbers(db, { p_ids: [a, b] }, REG);
  assert.deepEqual(
    second.map(t => [t.visit_service_id, t.queue_key, t.number]),
    first.map(t => [t.visit_service_id, t.queue_key, t.number]));
});

test('queue: different days count separately', () => {
  const db = freshDb();
  const today = addLine(db, { svc: 1, doctor: 2, when: '2026-08-07T09:00:00Z' });
  const tomorrow = addLine(db, { svc: 1, doctor: 2, when: '2026-08-08T09:00:00Z' });
  const t = issueQueueNumbers(db, { p_ids: [today, tomorrow] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));
  assert.equal(by.get(today).number, 1);
  assert.equal(by.get(tomorrow).number, 1);   // завтра очередь начинается заново
  assert.notEqual(by.get(today).queue_key, by.get(tomorrow).queue_key);
});

// QUEUE_ONE_DOCTOR_LINE_V1 — у врача ОДНА очередь на весь его день.
//
// Приём, процедура и диагностика одного врача считались тремя линиями
// (doc: / proc:doc: / img:doc:), и каждая начиналась с №1. В живой базе у ЛОРа
// вышло два разных пациента с талоном №7 на один и тот же день: один в приёме,
// другой на «Кукушке». Регистратура искала седьмого не в той колонке.
test('queue: приём, процедура и диагностика одного врача — ОДНА очередь', () => {
  const db = freshDb();
  const cons = addLine(db, { visit: 1, svc: 1, doctor: 2 });   // приём
  const proc = addLine(db, { visit: 2, svc: 7, doctor: 2 });   // процедура того же врача
  const img  = addLine(db, { visit: 2, svc: 6, doctor: 2 });   // и его же диагностика
  const t = issueQueueNumbers(db, { p_ids: [cons, proc, img] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));

  assert.match(by.get(cons).queue_key, /^doc:2:/);
  assert.equal(by.get(proc).queue_key, by.get(cons).queue_key, 'процедура — та же линия');
  assert.equal(by.get(img).queue_key,  by.get(cons).queue_key, 'диагностика — та же линия');

  assert.equal(by.get(cons).number, 1);
  assert.equal(by.get(proc).number, 2, 'второй пациент к тому же врачу — №2, а не свой №1');
  assert.equal(by.get(img).number, 2, 'у второго пациента приём и диагностика — один номер');

  // Подпись у всех одна: это одна дверь.
  assert.equal(by.get(proc).label, 'Др. Азиза');
});

// QUEUE_LOCAL_DAY_V1 — день очереди в МЕСТНОМ времени, а не в UTC.
//
// Услуга «на 16 августа» без времени хранится как местная полночь. В UTC+5 это
// 2026-08-15T19:00Z, и прежний срез строки UTC отправлял талон в очередь
// ПРЕДЫДУЩЕГО дня. Тесты идут от местного времени машины, поэтому дату строим
// из локальной полуночи так же, как это делает мастер записи.
function localMidnightIso(y, m, d) {
  // new Date(y, m-1, d) — локальная полночь; toISOString даёт её UTC-запись.
  return new Date(y, m - 1, d).toISOString();
}

test('queue: услуга на местную полночь попадает в СВОЙ день, а не в предыдущий', () => {
  const db = freshDb();
  const iso = localMidnightIso(2026, 8, 16);
  const line = addLine(db, { svc: 1, doctor: 2, when: iso });

  const [t] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  assert.equal(t.queue_key, 'doc:2:2026-08-16',
    'ключ обязан нести день приёма, а не день из UTC-записи');
  // Ровно та ловушка, из-за которой 399 талонов уехали на сутки назад.
  assert.ok(!t.queue_key.endsWith('2026-08-15'), 'талон не должен уезжать во вчера');
  db.close();
});

test('queue: услуга со временем не меняет поведения', () => {
  const db = freshDb();
  // 15:30 по местному — день очевиден при любом часовом поясе.
  const iso = new Date(2026, 7, 16, 15, 30).toISOString();
  const line = addLine(db, { svc: 1, doctor: 2, when: iso });

  const [t] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  assert.equal(t.queue_key, 'doc:2:2026-08-16');
  db.close();
});

test('queue: соседние дни — отдельные линии, каждая со своей нумерацией', () => {
  const db = freshDb();
  const d16 = addLine(db, { svc: 1, doctor: 2, when: localMidnightIso(2026, 8, 16) });
  const d17 = addLine(db, { visit: 2, svc: 1, doctor: 2, when: localMidnightIso(2026, 8, 17) });

  const t = issueQueueNumbers(db, { p_ids: [d16, d17] }, REG);
  const by = new Map(t.map((x) => [x.visit_service_id, x]));
  assert.equal(by.get(d16).queue_key, 'doc:2:2026-08-16');
  assert.equal(by.get(d17).queue_key, 'doc:2:2026-08-17');
  // Номер у каждого дня начинается заново — иначе два дня делят одну нумерацию.
  assert.equal(by.get(d16).number, 1);
  assert.equal(by.get(d17).number, 1);
  db.close();
});

test('queue: повторная печать не выдаёт новый номер и не меняет ключ', () => {
  const db = freshDb();
  const line = addLine(db, { svc: 1, doctor: 2, when: localMidnightIso(2026, 8, 16) });

  const [first] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  const [again] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  // Талон уже на руках у пациента: и номер, и очередь обязаны совпасть.
  assert.equal(again.number, first.number);
  assert.equal(again.queue_key, first.queue_key);
  db.close();
});

test('queue: битая дата даёт ключ no-date, а не падение', () => {
  const db = freshDb();
  // visits.visit_date объявлен NOT NULL, поэтому «даты нет» недостижимо —
  // достижимо «дата не разбирается». date() вернёт NULL, и выдача талона
  // обязана это пережить: сломанная строка не должна ронять регистратуру.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (9,1,'не дата','scheduled')").run();
  const line = addLine(db, { visit: 9, svc: 1, doctor: 2 });

  const [t] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  assert.equal(t.queue_key, 'doc:2:no-date');
  assert.equal(t.number, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// QUEUE_SURGERY_NO_TICKET_V1 — операция не занимает очередь
// ---------------------------------------------------------------------------
// В каталоге хирургия — это ТИП услуги, а services.type у неё 'other', и врач
// проставлен. Значит проверять надо ровно то, что раньше ломалось: строка с
// врачом больше не встаёт в его приёмную линию — и вообще никуда.
function withSurgery(db) {
  db.prepare("INSERT INTO service_types (id, name) VALUES (10,'Хирургия'),(11,'Консультации')").run();
  db.prepare("INSERT INTO services (id, name, price, type, type_id, requires_doctor) VALUES (20,'Аденоидэктомия',900000,'other',10,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, type_id, requires_doctor) VALUES (21,'Конизация шейки матки',700000,'other',10,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, type_id, requires_doctor) VALUES (22,'Приём хирурга',60000,'consultation',11,1)").run();
  return db;
}
const keyOf = (db, id) => db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id=?').get(id);

test('queue: операции талон не выдаётся вовсе', () => {
  const db = withSurgery(freshDb());
  const surg = addLine(db, { svc: 20, doctor: 2 });
  const t = issueQueueNumbers(db, { p_ids: [surg] }, REG);

  assert.deepEqual(t, [], 'в ответе нет талона на операцию');
  const row = keyOf(db, surg);
  assert.equal(row.queue_no, null, 'номер не выдан');
  assert.equal(row.queue_key, null, 'очередь не назначена');
  db.close();
});

test('queue: операция не съедает номер в линии врача', () => {
  const db = withSurgery(freshDb());
  const surg = addLine(db, { svc: 20, doctor: 2 });        // операция у врача 2
  const cons = addLine(db, { visit: 2, svc: 1, doctor: 2 }); // приём у него же
  const t = issueQueueNumbers(db, { p_ids: [surg, cons] }, REG);

  assert.equal(t.length, 1, 'талон один — только на приём');
  assert.equal(t[0].visit_service_id, cons);
  // Раньше операция забирала №1, и первый настоящий пациент в коридоре
  // получал №2, не понимая, кто был первым.
  assert.equal(t[0].number, 1);
  assert.match(t[0].queue_key, /^doc:2:/);
  db.close();
});

test('queue: приём хирурга — обычная очередь, талон выдаётся', () => {
  const db = withSurgery(freshDb());
  // Отсекать надо тип «Хирургия», а не врача: консультация того же хирурга
  // лежит под типом «Консультации» и остаётся нормальной очередью.
  const [t] = issueQueueNumbers(db, { p_ids: [addLine(db, { svc: 22, doctor: 2 })] }, REG);
  assert.match(t.queue_key, /^doc:2:/);
  assert.equal(t.label, 'Др. Азиза');
  db.close();
});

test('queue: лаборатория сильнее хирургии — анализ талон получает', () => {
  const db = withSurgery(freshDb());
  // Гистология из операционного материала может лежать под типом «Хирургия»,
  // но у окна забора очередь настоящая. Порядок проверок это гарантирует.
  db.prepare("INSERT INTO services (id, name, price, type, type_id, is_lab) VALUES (23,'Гистология',150000,'lab',10,1)").run();
  const [t] = issueQueueNumbers(db, { p_ids: [addLine(db, { svc: 23, doctor: 2 })] }, REG);
  assert.match(t.queue_key, /^lab:/);
  assert.equal(t.label, 'Лаборатория');
  db.close();
});

test('queue: уже выданный талон на операцию перепечатывается как был', () => {
  const db = withSurgery(freshDb());
  const line = addLine(db, { svc: 20, doctor: 2 });
  // Талон, выданный до этого правила: бумага на руках у пациента, и
  // перепечатка чека обязана показать тот же номер, а не потерять его.
  db.prepare("UPDATE visit_services SET queue_key='doc:2:2026-08-07', queue_no=4 WHERE id=?").run(line);

  const [t] = issueQueueNumbers(db, { p_ids: [line] }, REG);
  assert.equal(t.number, 4);
  assert.equal(t.queue_key, 'doc:2:2026-08-07');
  db.close();
});

test('queue: счёт из одних операций не роняет выдачу талонов', () => {
  const db = withSurgery(freshDb());
  const a = addLine(db, { svc: 20, doctor: 2 });
  const b = addLine(db, { svc: 21, doctor: 3 });
  // Пустой ответ — это нормальный ответ: печать чека просто не покажет блок
  // очереди, а не упадёт.
  assert.deepEqual(issueQueueNumbers(db, { p_ids: [a, b] }, REG), []);
  db.close();
});
