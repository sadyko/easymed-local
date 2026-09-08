// 023 расширяла services.type на 'radiology'. 109 убрала «Рентген» из
// ИНТЕРФЕЙСА, но не из CHECK — сужать его значило бы пересобирать таблицу.
//
// Файл переписан, а не удалён: вторая половина проверки — что таблица services
// после ПЕРЕСБОРКИ остаётся ссылочно целой — стоит ровно столько же, сколько
// стоила при 023, и теперь охраняет пересборку из 109. Именно она уносит с
// собой триггеры и внешние ключи, если сделать её небрежно.
//
// Почему 'radiology' больше нет: своей ветки в маршрутизаторе очереди у него не
// было — он падал в тот же else, что и 'other'. Два пункта в списке, одно
// поведение. Услуг с этим типом не было ни в одной базе, поэтому удаление не
// задело ни одной строки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('services принимает типы, которыми пишет код, и ссылки целы', () => {
  const db = openDb(':memory:'); migrate(db);

  // CHECK в базе ШИРЕ, чем список разделов в интерфейсе, и это осознанно:
  // сузить его значило бы пересобрать таблицу, а пересборка при включённых
  // внешних ключах роняет запуск программы у клиники с данными (миграция 109).
  // Пятёрку держит код; здесь проверяется, что база принимает то, что код пишет.
  for (const t of ['consultation', 'lab', 'procedure', 'imaging', 'other']) {
    const id = db.prepare('INSERT INTO services (name, type) VALUES (?,?)').run('svc-' + t, t).lastInsertRowid;
    assert.equal(db.prepare('SELECT type FROM services WHERE id=?').get(id).type, t);
  }
  assert.throws(() => db.prepare('INSERT INTO services (name, type) VALUES (?,?)').run('X', 'bogus'),
    /CHECK|constraint/i, 'выдуманный тип принимается базой');

  // Пересборка не порвала внешние ключи: на услугу ссылается строка визита.
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Consult', 50000)").run().lastInsertRowid;
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-12T09:00:00Z')").run(p).lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)").run(v, s);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'пересборка порвала ссылки на services');

  // И триггеры 048 пережили пересборку: тип и признак «лабораторная» держатся
  // друг за друга. Их DROP TABLE уносит молча — эта строка ловит именно это.
  const lab = db.prepare("INSERT INTO services (name, is_lab) VALUES ('ОАК', 1)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT type FROM services WHERE id=?').get(lab).type, 'lab',
    'триггеры синхронизации type/is_lab не пережили пересборку таблицы');
  db.close();
});
