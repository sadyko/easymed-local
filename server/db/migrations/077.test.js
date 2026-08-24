// CRM_CONFIG_V1 (мигр. 077) — миграция трогает ЖИВУЮ таблицу заявок, поэтому
// проверяется не «таблицы появились», а четыре обещания:
//   1. доска выглядит ровно так же — те же 8 колонок, ключи, подписи, цвета,
//      порядок;
//   2. ни одна существующая заявка и ни одна её строка услуги не потерялась
//      при пересборке (каскад ON DELETE у crm_request_services — реальная
//      ловушка, см. комментарий в самой миграции);
//   3. колонка-конверсия ровно одна, и это гарантия схемы, а не кода;
//   4. старые CHECK сняты, но ключ «из воздуха» по-прежнему не вставить —
//      теперь это делает внешний ключ.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '077_crm_config.sql'), 'utf8');

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// База БЕЗ 077 — как в 071.test.js: миграции до 076 накатываются во временный
// каталог, чтобы завести данные СТАРОЙ схемой и только потом прогнать 077.
function dbBefore077() {
  const db = openDb(':memory:');
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'mig077-'));
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && !x.startsWith('077'))) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

// Ровно так же, как это делает migrate(): один файл — одна транзакция.
// Важно именно так: PRAGMA defer_foreign_keys действует только внутри неё.
const apply077 = (db) => db.transaction(() => db.exec(SQL))();

// --------------------------------------------------------------------------
// 1. Доска не изменилась
// --------------------------------------------------------------------------

test('077 сеет ровно сегодняшние 8 колонок канбана — ключ, подпись, цвет, порядок', () => {
  const db = fresh();
  const rows = db.prepare('SELECT key, label, color, position, is_active, kind FROM crm_stages ORDER BY position').all();
  // Списком, а не поштучно: это дословная копия STATUSES из views/crm.js.
  // Если кто-то поменяет здесь подпись или цвет, доска в день выката станет
  // другой — и тест обязан это заметить.
  assert.deepEqual(rows, [
    { key: 'in_process',    label: 'В обработке',           color: 'info',   position: 1, is_active: 1, kind: 'open' },
    { key: 'recall',        label: 'Перезвонить',           color: 'warn',   position: 2, is_active: 1, kind: 'open' },
    { key: 'scheduled',     label: 'Записан',               color: 'purple', position: 3, is_active: 1, kind: 'open' },
    { key: 'approved',      label: 'Подтверждён',           color: 'teal',   position: 4, is_active: 1, kind: 'open' },
    { key: 'came',          label: 'Пришёл',                color: 'ok',     position: 5, is_active: 1, kind: 'won' },
    { key: 'no_show',       label: 'Не пришёл',             color: 'crit',   position: 6, is_active: 1, kind: 'lost' },
    { key: 'stopped',       label: 'Обработка остановлена', color: '',       position: 7, is_active: 1, kind: 'lost' },
    { key: 'not_qualified', label: 'Нецелевой',             color: '',       position: 8, is_active: 1, kind: 'lost' },
  ]);
});

test('077 kind воспроизводит CONVERT_STATUS / ACTIVE_STATUSES / LOST_STATUSES', () => {
  const db = fresh();
  const keys = (kind) => db.prepare('SELECT key FROM crm_stages WHERE kind = ? ORDER BY position').all(kind).map((r) => r.key);
  // Это не подписи, а поведение: три константы views/crm.js переезжают в
  // данные без единого расхождения.
  assert.deepEqual(keys('won'),  ['came']);                                              // CONVERT_STATUS
  assert.deepEqual(keys('open'), ['in_process', 'recall', 'scheduled', 'approved']);     // ACTIVE_STATUSES
  assert.deepEqual(keys('lost'), ['no_show', 'stopped', 'not_qualified']);               // LOST_STATUSES
});

test('077 сеет сегодняшние 7 источников плюс telephony', () => {
  const db = fresh();
  const rows = db.prepare('SELECT key, label, is_active FROM crm_sources ORDER BY position').all();
  assert.deepEqual(rows.map((r) => r.key),
    ['call', 'instagram', 'telegram', 'website', 'walk_in', 'referral', 'other', 'telephony']);
  assert.deepEqual(rows.map((r) => r.label),
    ['Звонок', 'Instagram', 'Telegram', 'Сайт', 'Пришёл сам', 'Рекомендация', 'Другое', 'Телефония']);
  assert.ok(rows.every((r) => r.is_active === 1));
});

test('077 сеет маршрутизацию по словарю Binotel: 5 создают лид, 10 — нет', () => {
  const db = fresh();
  const rows = db.prepare('SELECT disposition, action, stage_key FROM crm_call_routing WHERE provider = ?').all('binotel');
  const by = Object.fromEntries(rows.map((r) => [r.disposition, r]));
  assert.equal(rows.length, 15);
  // Разговор состоялся -> первая открытая колонка по порядку.
  for (const d of ['ANSWER', 'TRANSFER']) {
    assert.deepEqual(by[d], { disposition: d, action: 'create', stage_key: 'in_process' });
  }
  // Не дозвонились -> «Перезвонить». Самый дорогой звонок в клинике.
  for (const d of ['NOANSWER', 'BUSY', 'CANCEL']) {
    assert.deepEqual(by[d], { disposition: d, action: 'create', stage_key: 'recall' });
  }
  // Всё остальное из словаря вендора — не разговор, а состояние линии или
  // сообщение: лид не заводится, и колонка не названа.
  for (const d of ['ONLINE', 'CONGESTION', 'CHANUNAVAIL', 'VM', 'VM-SUCCESS',
                   'SMS-SENDING', 'SMS-SUCCESS', 'SMS-FAILED', 'SUCCESS', 'FAILED']) {
    assert.deepEqual(by[d], { disposition: d, action: 'ignore', stage_key: null });
  }
});

// --------------------------------------------------------------------------
// 2. Пересборка ничего не потеряла
// --------------------------------------------------------------------------

test('077 переносит существующие заявки в новую таблицу без единого изменения', () => {
  const db = dbBefore077();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (7,'Пациент Один','+998 90 111 22 33')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5,'reg','x','registrar')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (3,'УЗИ', 150000)").run();

  // Все восемь старых статусов и несколько источников — чтобы перенос
  // проверялся на КАЖДОМ значении, которое могло лежать в базе клиники.
  const statuses = ['in_process', 'recall', 'scheduled', 'approved', 'came', 'no_show', 'stopped', 'not_qualified'];
  const ins = db.prepare(`INSERT INTO crm_requests
      (full_name, phone, source, note, status, patient_id, assigned_to, created_by,
       created_at, updated_at, service_id, scheduled_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  statuses.forEach((st, i) => {
    ins.run(`Заявка ${i}`, `+998 90 000 00 0${i}`, ['call', 'instagram', 'walk_in', 'other'][i % 4],
      `примечание ${i}`, st, 7, 5, 5, `2026-08-0${i + 1}T09:00:00Z`, `2026-08-0${i + 1}T10:00:00Z`,
      3, `2026-09-0${i + 1}`);
  });
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, note) VALUES (1, 3, ?, ?, ?)')
    .run('2026-09-01', 'pending', 'строка услуги');
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, note) VALUES (2, 3, ?, ?, ?)')
    .run('2026-09-02', 'done', 'вторая строка');

  const cols = 'id, full_name, phone, source, note, status, patient_id, assigned_to, created_by, created_at, updated_at, service_id, scheduled_date';
  const before = db.prepare(`SELECT ${cols} FROM crm_requests ORDER BY id`).all();
  const childrenBefore = db.prepare('SELECT * FROM crm_request_services ORDER BY id').all();

  apply077(db);

  assert.deepEqual(db.prepare(`SELECT ${cols} FROM crm_requests ORDER BY id`).all(), before);
  // Дочерние строки — отдельная проверка, а не придирка: DROP TABLE родителя
  // при включённых внешних ключах ВЫПОЛНЯЕТ ON DELETE CASCADE, и без
  // копирования их бы стёрло целиком.
  assert.deepEqual(db.prepare('SELECT * FROM crm_request_services ORDER BY id').all(), childrenBefore);
  assert.equal(childrenBefore.length, 2);
  // call_id — новая колонка; у перенесённых заявок звонка не было.
  assert.ok(db.prepare('SELECT COUNT(*) n FROM crm_requests WHERE call_id IS NULL').get().n === before.length);
  // Временные копии за собой убраны.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '\\_crm%' ESCAPE '\\'").get().n, 0);
});

test('077 сохраняет автонумерацию: следующая заявка не наступает на существующую', () => {
  const db = dbBefore077();
  db.prepare("INSERT INTO crm_requests (full_name, status) VALUES ('Первая','recall')").run();
  db.prepare("INSERT INTO crm_requests (full_name, status) VALUES ('Вторая','recall')").run();
  db.prepare('DELETE FROM crm_requests WHERE id = 2').run();
  apply077(db);
  const id = db.prepare("INSERT INTO crm_requests (full_name) VALUES ('Третья')").run().lastInsertRowid;
  assert.equal(id, 3);
});

test('077 восстанавливает оба индекса, снесённые вместе со старой таблицей', () => {
  const db = fresh();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='crm_requests' AND sql IS NOT NULL")
    .all().map((r) => r.name).sort();
  assert.deepEqual(names, ['idx_crm_requests_patient', 'idx_crm_requests_status']);
});

// --------------------------------------------------------------------------
// 3. Конверсия ровно одна
// --------------------------------------------------------------------------

test('077 не даёт завести вторую колонку-конверсию', () => {
  const db = fresh();
  // Новая колонка kind='won' рядом с 'came' — регистрация пациента получила бы
  // два входа. Частичный UNIQUE не даёт этому случиться на уровне схемы.
  assert.throws(
    () => db.prepare("INSERT INTO crm_stages (key, label, kind, position) VALUES ('paid','Оплатил','won',9)").run(),
    /UNIQUE/,
  );
  // Перевести существующую колонку в 'won' — та же развилка, тот же отказ.
  assert.throws(() => db.prepare("UPDATE crm_stages SET kind='won' WHERE key='approved'").run(), /UNIQUE/);
});

test('077 не ограничивает число колонок open и lost', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_stages (key, label, color, kind, position) VALUES ('waiting_pay','Ждёт оплаты','warn','open',9)").run();
  db.prepare("INSERT INTO crm_stages (key, label, color, kind, position) VALUES ('duplicate','Дубль','','lost',10)").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_stages').get().n, 10);
});

test('077 разрешает передать конверсию другой колонке одной транзакцией', () => {
  const db = fresh();
  // Частичный индекс проверяется построчно, поэтому «сначала снять, потом
  // назначить» работает — а «назначить, потом снять» нет. Экран настроек
  // обязан знать этот порядок (config.js saveStages его и соблюдает).
  db.transaction(() => {
    db.prepare("UPDATE crm_stages SET kind='open' WHERE key='came'").run();
    db.prepare("UPDATE crm_stages SET kind='won' WHERE key='approved'").run();
  })();
  assert.equal(db.prepare("SELECT key FROM crm_stages WHERE kind='won'").get().key, 'approved');
});

// --------------------------------------------------------------------------
// 4. CHECK снят, но ключ «из воздуха» по-прежнему не вставить
// --------------------------------------------------------------------------

test('077 снимает CHECK со статуса и источника — новая колонка работает без релиза', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_stages (key, label, color, kind, position) VALUES ('waiting_pay','Ждёт оплаты','warn','open',9)").run();
  db.prepare("INSERT INTO crm_sources (key, label, position) VALUES ('billboard','Билборд',9)").run();
  const id = db.prepare("INSERT INTO crm_requests (full_name, status, source) VALUES ('Новая','waiting_pay','billboard')").run().lastInsertRowid;
  const row = db.prepare('SELECT status, source FROM crm_requests WHERE id = ?').get(id);
  assert.deepEqual(row, { status: 'waiting_pay', source: 'billboard' });
});

test('077 меняет CHECK на внешний ключ: несуществующая колонка по-прежнему отвергается', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("INSERT INTO crm_requests (full_name, status) VALUES ('Ниоткуда','no_such_stage')").run(),
    /FOREIGN KEY/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO crm_requests (full_name, source) VALUES ('Ниоткуда','no_such_source')").run(),
    /FOREIGN KEY/,
  );
});

test('077 связывает заявку со звонком, и удаление звонка её не уносит', () => {
  const db = fresh();
  const callId = db.prepare("INSERT INTO calls (general_call_id, started_at, external_number, disposition) VALUES ('BC-77','2026-08-24T14:32:00Z','+998901112233','NOANSWER')").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, call_id) VALUES ('+998901112233','+998901112233','telephony','recall',?)").run(callId).lastInsertRowid;
  db.prepare('DELETE FROM calls WHERE id = ?').run(callId);
  const row = db.prepare('SELECT call_id, status FROM crm_requests WHERE id = ?').get(id);
  // ON DELETE SET NULL: заявка переживает удаление записи о звонке.
  assert.deepEqual(row, { call_id: null, status: 'recall' });
});

test('077 не даёт правилу «создавать» остаться без колонки', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("INSERT INTO crm_call_routing (provider, disposition, action, stage_key) VALUES ('binotel','WEIRD','create',NULL)").run(),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare("UPDATE crm_call_routing SET stage_key = NULL WHERE disposition = 'ANSWER'").run(),
    /CHECK/,
  );
});

test('077 не даёт маршруту указывать на несуществующую колонку', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("INSERT INTO crm_call_routing (provider, disposition, action, stage_key) VALUES ('binotel','WEIRD','create','no_such_stage')").run(),
    /FOREIGN KEY/,
  );
});
