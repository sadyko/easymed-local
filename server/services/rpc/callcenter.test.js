// CALLCENTER_REPORT_V1 — отчёт колл-центра.
//
// Считается по crm_requests: когда заявку завели, кто её завёл, чем она
// кончилась и стал ли человек пациентом. Всё, что связано со ВРЕМЕНЕМ, берётся
// в местном времени клиники — заявки хранятся в UTC, и при UTC+5 «пик в 14:00»
// без перевода превратился бы в «09:00», то есть в час, когда стойка ещё пустая.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { callcenterReport } from './callcenter.js';

const USER = { id: 1, role: 'admin' };

// Смещение спрашиваем у базы, чтобы тест шёл в любой зоне.
function offsetHours(db) {
  return db.prepare("SELECT CAST(strftime('%H','2026-08-17T12:00:00Z','localtime') AS INTEGER) - 12 AS h").get().h;
}
// Заявка, созданная в указанный МЕСТНЫЙ час указанного местного дня.
function addLead(db, { day, localHour, status = 'came', by = 1, patient = null, source = 'call', service = null, scheduled = null }) {
  const off = offsetHours(db);
  const utcH = ((localHour - off) % 24 + 24) % 24;
  const at = `${day}T${String(utcH).padStart(2, '0')}:30:00Z`;
  return db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, created_by, created_at, patient_id, service_id, scheduled_date)
                     VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('Лид', '998900000000', source, status, by, at, patient, service, scheduled).lastInsertRowid;
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'v','x','registrar','Sabirova Visola')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'a','x','admin','Administrator')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (500,'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (77,'Консультация гинеколога',100000)").run();
  return db;
}
const RANGE = { from: '2026-08-10', to: '2026-08-20' };

test('пиковый час считается в МЕСТНОМ времени, а не в UTC', () => {
  const db = seed();
  for (let i = 0; i < 3; i++) addLead(db, { day: '2026-08-17', localHour: 14 });
  addLead(db, { day: '2026-08-17', localHour: 9 });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.peak.hour, '14', 'пик должен быть 14:00 по клинике');
  const at14 = r.byHour.find((x) => x.hour === '14');
  assert.equal(at14.count, 3);
  assert.equal(r.byHour.length, 24, 'все 24 часа присутствуют, чтобы график не «схлопывался»');
  db.close();
});

test('KPI: всего, дошли, конверсия и переход в карту пациента', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'came', patient: 500 });
  addLead(db, { day: '2026-08-17', localHour: 11, status: 'came' });
  addLead(db, { day: '2026-08-17', localHour: 12, status: 'scheduled' });
  addLead(db, { day: '2026-08-17', localHour: 13, status: 'no_show' });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.kpi.total, 4);
  assert.equal(r.kpi.came, 2);
  assert.equal(r.kpi.came_pct, 50);
  assert.equal(r.kpi.no_show, 1);
  assert.equal(r.kpi.became_patient, 1);
  assert.equal(r.kpi.became_patient_pct, 25);
  db.close();
});

test('по операторам — сколько завёл и сколько из них дошло', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 10, by: 1, status: 'came' });
  addLead(db, { day: '2026-08-17', localHour: 11, by: 1, status: 'no_show' });
  addLead(db, { day: '2026-08-17', localHour: 12, by: 2, status: 'came' });

  const r = callcenterReport(db, RANGE, USER);
  const visola = r.byOperator.find((o) => o.name === 'Sabirova Visola');

  assert.equal(visola.count, 2);
  assert.equal(visola.came, 1);
  assert.equal(visola.came_pct, 50);
  db.close();
});

// Период обязан резать по МЕСТНОЙ дате — иначе заявка, принятая вечером
// последнего дня месяца, попадёт в следующий отчёт (или пропадёт из обоих).
test('период фильтрует по местной дате', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 12 });
  addLead(db, { day: '2026-08-25', localHour: 12 });

  assert.equal(callcenterReport(db, { from: '2026-08-01', to: '2026-08-20' }, USER).kpi.total, 1);
  assert.equal(callcenterReport(db, { from: '2026-08-01', to: '2026-08-31' }, USER).kpi.total, 2);
  db.close();
});

test('воронка, источники, дни недели и услуги', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'came', service: 77 });   // понедельник
  addLead(db, { day: '2026-08-17', localHour: 11, status: 'came', service: 77 });
  addLead(db, { day: '2026-08-18', localHour: 11, status: 'stopped', source: 'instagram' });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.byStatus.find((s) => s.status === 'came').count, 2);
  assert.equal(r.bySource.find((s) => s.source === 'instagram').count, 1);
  assert.equal(r.byWeekday.length, 7, 'все 7 дней, чтобы пустые были видны');
  assert.equal(r.byWeekday.find((w) => w.weekday === '1').count, 2);   // 0=вс, 1=пн
  assert.equal(r.topServices[0].name, 'Консультация гинеколога');
  assert.equal(r.topServices[0].count, 2);
  db.close();
});

test('строки для Excel — по одной на заявку, с местным часом', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 14, status: 'came', patient: 500, service: 77, scheduled: '2026-08-19' });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.rows.length, 1);
  const row = Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]]));
  assert.equal(row['Дата'], '2026-08-17');
  assert.equal(row['Час'], '14');
  assert.equal(row['Оператор'], 'Sabirova Visola');
  assert.equal(row['Стал пациентом'], 'да');
  assert.equal(row['Услуга'], 'Консультация гинеколога');
  db.close();
});

// Пустой период — это ноль, а не падение и не деление на ноль в процентах.
test('пустой период не роняет отчёт', () => {
  const db = seed();
  const r = callcenterReport(db, { from: '2020-01-01', to: '2020-01-31' }, USER);
  assert.equal(r.kpi.total, 0);
  assert.equal(r.kpi.came_pct, 0);
  assert.equal(r.peak.hour, null);
  assert.deepEqual(r.rows, []);
  assert.equal(r.byHour.length, 24);
  db.close();
});

// CC_BY_SERVICE_TYPE_V1 — спрос по группам услуг.
test('заявки группируются по типу услуги, а услуги без типа не теряются', () => {
  const db = seed();
  const type = db.prepare("INSERT INTO service_types (name) VALUES ('Консультации')").run().lastInsertRowid;
  const lab  = db.prepare("INSERT INTO service_types (name) VALUES ('Лаборатория')").run().lastInsertRowid;
  const s1 = db.prepare('INSERT INTO services (name, price, type_id) VALUES (?,?,?)').run('Консультация гинеколога', 100, type).lastInsertRowid;
  const s2 = db.prepare('INSERT INTO services (name, price, type_id) VALUES (?,?,?)').run('Консультация уролога', 100, type).lastInsertRowid;
  const s3 = db.prepare('INSERT INTO services (name, price, type_id) VALUES (?,?,?)').run('ОАК', 50, lab).lastInsertRowid;
  const s4 = db.prepare('INSERT INTO services (name, price) VALUES (?,?)').run('Без типа', 10).lastInsertRowid;

  const req = (id) => db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, created_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
    .run('Пациент ' + id, '99890' + id, 'in_process').lastInsertRowid;
  const line = (r, s) => db.prepare('INSERT INTO crm_request_services (request_id, service_id) VALUES (?,?)').run(r, s);

  const r1 = req(1); line(r1, s1); line(r1, s2);   // две консультации в одной заявке
  const r2 = req(2); line(r2, s3);
  const r3 = req(3); line(r3, s4);

  const out = callcenterReport(db, { from: '2000-01-01', to: '2100-01-01' }, { id: 1, role: 'admin' });
  const by = Object.fromEntries(out.byServiceType.map((x) => [x.name, x.count]));

  // Двенадцать строк консультаций разных врачей — это ОДИН спрос: приём.
  assert.equal(by['Консультации'], 2);
  assert.equal(by['Лаборатория'], 1);
  // Услуга без типа не прячется: пропавшая из суммы заявка читается как ошибка отчёта.
  assert.equal(by['Без группы'], 1);
  // Сортировка по убыванию — самое востребованное сверху.
  assert.equal(out.byServiceType[0].name, 'Консультации');
  db.close();
});

// CC_LAST30_V1 — фиксированное окно в 30 дней и тренд неделя-к-неделе.
test('30 дней не зависят от выбранного периода и включают пустые дни', () => {
  const db = seed();
  const add = (daysAgo, n) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO crm_requests (full_name, phone, status, created_at)
                  VALUES (?,?,'in_process', datetime('now','localtime','-' || ? || ' days'))`)
        .run('П' + daysAgo + '_' + i, '998900000' + i, daysAgo);
    }
  };
  add(1, 5);    // прошлая неделя
  add(2, 3);
  add(9, 2);    // позапрошлая

  // Фильтр периода намеренно узкий — на 30-дневный ряд он влиять не должен.
  const out = callcenterReport(db, { from: '2026-08-18', to: '2026-08-18' }, { id: 1, role: 'admin' });

  assert.equal(out.last30.length, 30, 'ровно 30 дней, включая пустые');
  const sum = out.last30.reduce((n, x) => n + x.count, 0);
  assert.equal(sum, 10, 'ряд считает все заявки окна, а не только выбранный день');
  assert.ok(out.last30.some((x) => x.count === 0), 'пустые дни занимают своё место');
  // Ряд идёт по возрастанию и заканчивается сегодняшним днём.
  assert.ok(out.last30[0].day < out.last30.at(-1).day);
});

test('тренд сравнивает последние 7 дней с предыдущими 7', () => {
  const db = seed();
  const add = (daysAgo, n) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO crm_requests (full_name, phone, status, created_at)
                  VALUES (?,?,'in_process', datetime('now','localtime','-' || ? || ' days'))`)
        .run('П' + daysAgo + '_' + i, '99890' + daysAgo + i, daysAgo);
    }
  };
  add(2, 8);    // текущая семёрка
  add(10, 4);   // предыдущая семёрка

  const out = callcenterReport(db, { from: '2026-01-01', to: '2100-01-01' }, { id: 1, role: 'admin' });
  assert.equal(out.trend.current, 8);
  assert.equal(out.trend.previous, 4);
  assert.equal(out.trend.direction, 'up');
  assert.equal(out.trend.delta_pct, 100);
});

test('рост с нуля не даёт деления на ноль', () => {
  const db = seed();
  db.prepare(`INSERT INTO crm_requests (full_name, phone, status, created_at)
              VALUES ('Один','998900000001','in_process', datetime('now','localtime','-1 days'))`).run();

  const out = callcenterReport(db, { from: '2026-01-01', to: '2100-01-01' }, { id: 1, role: 'admin' });
  assert.equal(out.trend.previous, 0);
  // Процент от нуля не считается — интерфейс показывает «рост с нуля».
  assert.equal(out.trend.delta_pct, null);
  assert.equal(out.trend.direction, 'up');
});

// CC_OPS_V1 — три показателя для стойки.
test('конверсия по источникам считает не объём, а доведённых до визита', () => {
  const db = seed();
  const req = (src, status, i) => db.prepare(
    `INSERT INTO crm_requests (full_name, phone, source, status, created_at)
     VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run('П' + i, '9989000' + i, src, status);
  // Instagram: много заявок, мало визитов. Звонок: наоборот.
  req('instagram', 'in_process', 1); req('instagram', 'in_process', 2);
  req('instagram', 'no_show', 3);    req('instagram', 'came', 4);
  req('call', 'came', 5);            req('call', 'came', 6);

  const out = callcenterReport(db, { from: '2000-01-01', to: '2100-01-01' }, { id: 1, role: 'admin' });
  const by = Object.fromEntries(out.sourceConv.map((x) => [x.name, x]));
  assert.equal(by['Instagram'].count, 4);
  assert.equal(by['Instagram'].came_pct, 25);
  // Канал с меньшим объёмом, но лучшей конверсией — именно то, что по
  // столбикам объёма неразличимо.
  assert.equal(by['Звонок'].count, 2);
  assert.equal(by['Звонок'].came_pct, 100);
});

test('зависшие заявки считаются по последнему касанию и только в активных статусах', () => {
  const db = seed();
  const mk = (status, daysAgo, name) => db.prepare(
    `INSERT INTO crm_requests (full_name, phone, status, created_at, updated_at)
     VALUES (?,?,?, datetime('now','localtime','-' || ? || ' days'), datetime('now','localtime','-' || ? || ' days'))`)
    .run(name, '99890' + name.length + daysAgo, status, daysAgo, daysAgo);

  mk('in_process', 10, 'Давний');       // висит
  mk('recall', 4, 'Перезвонить');       // висит
  mk('in_process', 1, 'Вчерашний');     // тронут вчера — НЕ висит
  mk('came', 30, 'Пришёл');             // закрыт — не висит, сколько бы ни лежал
  mk('not_qualified', 40, 'Нецелевой'); // тоже закрыт

  const out = callcenterReport(db, { from: '2100-01-01', to: '2100-01-02' }, { id: 1, role: 'admin' });
  assert.equal(out.stale.total, 2, 'только активные и только нетронутые 3+ дня');
  const names = out.stale.oldest.map((x) => x.name);
  assert.ok(names.includes('Давний') && names.includes('Перезвонить'));
  assert.ok(!names.includes('Пришёл'), 'закрытая заявка не зависшая');
  // Период фильтра намеренно в будущем: зависшие не зависят от диапазона.
  assert.equal(out.stale.buckets.find((b) => b.label === '7–14 дней').count, 1);
});

test('запись вперёд перечисляет 14 дней подряд, включая пустые', () => {
  const db = seed();
  const r = db.prepare(
    `INSERT INTO crm_requests (full_name, phone, status, scheduled_date, created_at)
     VALUES ('Записанный','998900000001','scheduled', date('now','localtime','+2 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run().lastInsertRowid;
  db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status)
              VALUES (?, 77, date('now','localtime','+2 days'), 'pending')`).run(r);

  const out = callcenterReport(db, { from: '2000-01-01', to: '2000-01-02' }, { id: 1, role: 'admin' });
  assert.equal(out.forwardBook.length, 14);
  assert.equal(out.forwardBook[0].count, 0, 'сегодня записей нет');
  assert.equal(out.forwardBook[2].count, 1, 'послезавтра — один');
  // Дыра в расписании обязана быть видна: это и есть повод звонить.
  assert.ok(out.forwardBook.some((x) => x.count === 0));
});
