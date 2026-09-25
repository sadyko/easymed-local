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
// CRM_HEAD_MERGE_TAGS_V1 — отчёт считает операторов по тому, кто ВЕДЁТ заявку
// (assigned_to); по умолчанию ведёт тот, кто завёл — так прежние проверки
// «кто сколько довёл» читаются как раньше.
function addLead(db, { day, localHour, status = 'came', by = 1, assigned, patient = null, source = 'call', service = null, scheduled = null }) {
  const off = offsetHours(db);
  const utcH = ((localHour - off) % 24 + 24) % 24;
  const at = `${day}T${String(utcH).padStart(2, '0')}:30:00Z`;
  return db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, created_by, assigned_to, created_at, patient_id, service_id, scheduled_date)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('Лид', '998900000000', source, status, by, assigned === undefined ? by : assigned, at, patient, service, scheduled).lastInsertRowid;
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

// CRM_LINKS_V1 (2026-09-20) — ВОРОНКА НАСТРАИВАЕТСЯ, А ОТЧЁТ СЧИТАЛ ПО
// ЗАШИТОМУ СПИСКУ. Клиника завела свою проигрышную колонку — и заявки в ней
// пропадали из «потеряно»: в отчёте сумма по воронке не сходилась с общим
// числом заявок, и понять, куда делись люди, было нельзя.
test('CRM_LINKS_V1: своя проигрышная колонка считается потерей, как и сидовые', () => {
  const db = seed();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('refused_price','Дорого','crit',9,1,'lost')").run();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'stopped' });
  addLead(db, { day: '2026-08-17', localHour: 11, status: 'refused_price' });
  addLead(db, { day: '2026-08-17', localHour: 12, status: 'no_show' });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.kpi.lost, 2, 'заявка из добавленной клиникой колонки не попала в «потеряно»');
  assert.equal(r.kpi.no_show, 1, '«не пришёл» обязан остаться отдельным показателем, а не слиться с потерями');
  db.close();
});

test('CRM_LINKS_V1: конверсия считается по колонке-конверсии справочника', () => {
  const db = seed();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('waiting_pay','Ждёт оплаты','info',9,1,'open')").run();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'came', by: 1 });
  addLead(db, { day: '2026-08-17', localHour: 11, status: 'waiting_pay', by: 1 });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.kpi.came, 1);
  assert.equal(r.kpi.lost, 0, 'живая колонка посчитана потерей');
  const op = r.byOperator.find((x) => x.name === 'Sabirova Visola');
  assert.equal(op.came, 1, 'у оператора не сошлось число доведённых до визита');
  db.close();
});

// CRM_LINKS_V1 (2026-09-20) — ПОДПИСИ ВОРОНКИ И ИСТОЧНИКОВ БЕРУТСЯ ИЗ
// СПРАВОЧНИКОВ, А НЕ ИЗ ТРЕТЬЕГО СЛОВАРЯ В КОДЕ ОТЧЁТА.
//
// Словарей было три: crm_stages/crm_sources в базе, DEFAULT_* на клиенте и
// STATUS_RU/SOURCE_RU здесь. Третий уже разошёлся с первым: ключ источника в
// базе — 'walk_in', а в словаре отчёта лежал 'walkin', и «Пришёл сам»
// печатался в отчёте и в выгрузке Excel голым кодом. Переименование колонки на
// экране настроек до отчёта не доезжало вовсе.
test('CRM_LINKS_V1: источник печатается подписью справочника, а не кодом', () => {
  const db = seed();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'came', source: 'walk_in' });

  const r = callcenterReport(db, RANGE, USER);

  const src = r.bySource.find((x) => x.source === 'walk_in');
  assert.ok(src, 'источник пропал из отчёта');
  assert.equal(src.label, 'Пришёл сам',
    'источник напечатан кодом: словарь отчёта разошёлся со справочником CRM');
  const conv = r.sourceConv.find((x) => x.count === 1);
  assert.equal(conv.name, 'Пришёл сам', 'в конверсии по источникам тот же код вместо подписи');
  // Выгрузка Excel — та же подпись: стойка сводит её руками, и код в столбце
  // «Источник» означает ручную расшифровку на каждой строке.
  assert.ok(r.rows.some((row) => row.includes('Пришёл сам')), 'в выгрузке Excel источник остался кодом');
  db.close();
});

test('CRM_LINKS_V1: колонку переименовали — отчёт называет её новым именем', () => {
  const db = seed();
  db.prepare("UPDATE crm_stages SET label = 'Дошёл' WHERE key = 'came'").run();
  db.prepare("UPDATE crm_sources SET label = 'Входящий звонок' WHERE key = 'call'").run();
  addLead(db, { day: '2026-08-17', localHour: 10, status: 'came', source: 'call' });

  const r = callcenterReport(db, RANGE, USER);

  assert.equal(r.byStatus.find((x) => x.status === 'came').label, 'Дошёл',
    'переименование колонки не доехало до отчёта');
  assert.equal(r.bySource.find((x) => x.source === 'call').label, 'Входящий звонок',
    'переименование источника не доехало до отчёта');
  db.close();
});

// CRM_LINKS_V1 — «ЗАВИСШАЯ» ЭТО ТА, С КОТОРОЙ ЕЩЁ НЕ ЗАКОНЧИЛИ РАБОТАТЬ.
//
// Отбор стоял зашитой парой ('in_process','recall'), и клиника, добавившая
// свою колонку в начало воронки («Ждём документы», «Уточняем»), теряла её
// заявки из виду совсем: в отчёте они не зависшие, а на доске их никто не
// перебирает — лид просто лежит, пока о нём случайно не вспомнят.
//
// Граница та же, что у ночной автоматики «Не пришёл» (views/crm.js): «Записан»
// делит воронку надвое. ДО него заявку ещё ведёт оператор, и молчание три дня
// и есть «зависла». С «Записан» пациента уже ЖДУТ в конкретный день, и
// молчание там не значит ничего: такую заявку разбирает автоматика по дате, а
// не этот список.
test('CRM_LINKS_V1: своя колонка до «Записан» тоже считается зависшей', () => {
  const db = seed();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('awaiting_docs','Ждём документы','info',2,1,'open')").run();
  const old = (status, name) => {
    const id = addLead(db, { day: '2026-08-17', localHour: 10, status });
    db.prepare("UPDATE crm_requests SET updated_at = datetime('now','localtime','-10 days'), full_name = ? WHERE id = ?").run(name, id);
    return id;
  };
  old('awaiting_docs', 'Своя колонка');
  old('in_process', 'Сидовая');
  old('scheduled', 'Записанный');

  const r = callcenterReport(db, RANGE, USER);
  const names = r.stale.oldest.map((x) => x.name);
  assert.ok(names.includes('Своя колонка'),
    'заявка из колонки клиники до «Записан» не считается зависшей — её не увидит никто: ' + JSON.stringify(names));
  assert.ok(names.includes('Сидовая'), 'сидовая колонка выпала из отбора');
  assert.ok(!names.includes('Записанный'),
    'записанного пациента объявили зависшим: его ждут в конкретный день, и этим занята автоматика по дате');
  assert.equal(r.stale.total, 2);
  db.close();
});

// И «зависшие заявки» зовут колонку так же, как её зовёт доска. Словарь отчёта
// подписывал 'in_process' как «В работе», а справочник — как «В обработке»:
// одна и та же колонка называлась в клинике двумя именами.
test('CRM_LINKS_V1: в «зависших» колонка названа так же, как на доске', () => {
  const db = seed();
  const id = addLead(db, { day: '2026-08-17', localHour: 10, status: 'in_process' });
  db.prepare("UPDATE crm_requests SET updated_at = '2026-01-01T10:00:00Z' WHERE id = ?").run(id);

  const r = callcenterReport(db, RANGE, USER);
  assert.equal(r.stale.oldest[0].status, 'В обработке',
    'список зависших зовёт колонку по-своему — в клинике у одной колонки два имени');
  db.close();
});

// ---------------------------------------------------------------------------
// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — ОПЕРАТОРЫ ПО ТОМУ, КТО ВЕДЁТ, И «СОЗДАЛ».
// ---------------------------------------------------------------------------
function seedTeam() {
  const db = seed();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'o1','x','callcenter','Оператор Нигора')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name,custom_role_code) VALUES (4,'h','x','callcenter','Руководитель','head_cc')").run();
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('head_cc','Руководитель колл-центра','callcenter')").run();
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('head_cc', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
  // Регистратура (1) завела три заявки: две ведёт Нигора (3), одну — никто.
  addLead(db, { day: '2026-08-17', localHour: 10, by: 1, assigned: 3, status: 'came' });
  addLead(db, { day: '2026-08-17', localHour: 11, by: 1, assigned: 3, status: 'no_show' });
  addLead(db, { day: '2026-08-17', localHour: 12, by: 1, assigned: null, status: 'in_process' });
  // Нигора сама завела одну, её ведёт администратор (2).
  addLead(db, { day: '2026-08-17', localHour: 13, by: 3, assigned: 2, status: 'came' });
  return db;
}
const HEAD = { id: 4, role: 'callcenter', extra_roles: [], custom_role_code: 'head_cc' };
const NIGORA = { id: 3, role: 'callcenter', extra_roles: [] };

test('CRM_HEAD_MERGE_TAGS_V1: операторы считаются по тому, кто ведёт; «Создал» — отдельно', () => {
  const db = seedTeam();
  const r = callcenterReport(db, RANGE, USER);
  const by = Object.fromEntries(r.byOperator.map((o) => [o.name, o]));
  assert.equal(by['Оператор Нигора'].count, 2, 'Нигора ведёт две заявки');
  assert.equal(by['Оператор Нигора'].came, 1);
  assert.equal(by['Оператор Нигора'].created, 1, 'Нигора сама завела одну');
  assert.equal(by['Sabirova Visola'].count, 0, 'регистратура ничего не ведёт');
  assert.equal(by['Sabirova Visola'].created, 3, 'регистратура завела три');
  assert.equal(by['Administrator'].count, 1);
  assert.equal(by['Не назначен'].count, 1, 'общая стопка пропала — сумма не сходится');
  assert.equal(r.byOperator.reduce((s, o) => s + o.count, 0), r.kpi.total);
  const cols = r.columns;
  assert.ok(cols.includes('Оператор') && cols.includes('Создал'));
  const adminLead = r.rows.find((x) => x[cols.indexOf('Оператор')] === 'Administrator');
  const row = Object.fromEntries(cols.map((c, i) => [c, adminLead[i]]));
  assert.equal(row['Создал'], 'Оператор Нигора', 'в Excel «Создал» — не тот человек');
  db.close();
});

test('CRM_HEAD_MERGE_TAGS_V1: оператор видит только свою строку и свои/ничьи заявки; руководитель — всех', () => {
  const db = seedTeam();
  const mine = callcenterReport(db, RANGE, NIGORA);
  assert.deepEqual(mine.byOperator.map((o) => o.name), ['Оператор Нигора'], 'оператору отдали чужие цифры');
  assert.equal(mine.rows.length, 3, 'в строках Excel — чужая заявка (или не хватает своей/ничьей)');
  assert.ok(!mine.rows.some((x) => x[mine.columns.indexOf('Оператор')] === 'Administrator'));
  assert.equal(mine.kpi.total, 4, 'итоги воронки — числа клиники, они общие');

  const head = callcenterReport(db, RANGE, HEAD);
  assert.equal(head.byOperator.length, 4, 'руководитель колл-центра видит не всех операторов');
  assert.equal(head.rows.length, 4);
  db.close();
});
