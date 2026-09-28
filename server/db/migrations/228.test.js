// LIS_ANALYZER_LIST_V1 (мигр. 228) — прибор «добавлен» или «найден, ждёт
// нажатия»; «на связи» — по самому позднему сообщению прибора.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '228_lab_device_added.sql'), 'utf8');
// Бэкфилл — последнее предложение файла: повторный накат проверяется им одним
// (ALTER TABLE второй раз не выполнить, и миграции второй раз не катятся).
const BACKFILL = SQL.slice(SQL.indexOf('UPDATE lab_devices'));

function dbBefore228() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig228-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 228)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

// profile у lab_devices — NOT NULL без умолчания (мигр. 123): вставка без него
// упала бы на NOT NULL раньше, чем дошла бы до проверяемого CHECK.
test('228: колонка added, по умолчанию 1 — всё, что заводит человек, уже добавлено', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const id = db.prepare("INSERT INTO lab_devices (name, profile, transport, port) VALUES ('Руками','mindray-bc-5300','mllp',2575)").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT added FROM lab_devices WHERE id = ?').get(id).added, 1);
    assert.throws(() => db.prepare("INSERT INTO lab_devices (name, profile, added) VALUES ('Мусор', '', 2)").run(), /CHECK/);
  } finally { db.close(); }
});

// Модель находки проверил человек («Добавить» или «Изменить» с выбранной
// моделью) — пометка «найден сам — проверьте модель» больше не нужна. Приём
// эту колонку не читает: правило адреса и модели в discover.js — на discovered.
test('228: колонка model_confirmed, по умолчанию 0; мусор не проходит', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const id = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Находка', 'mindray-bc-5300')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT model_confirmed FROM lab_devices WHERE id = ?').get(id).model_confirmed, 0);
    assert.throws(() => db.prepare("INSERT INTO lab_devices (name, profile, model_confirmed) VALUES ('Мусор', '', 2)").run(), /CHECK/);
  } finally { db.close(); }
});

test('228: существующие приборы остаются добавленными; «на связи» — по самому позднему сообщению', () => {
  const db = dbBefore228();
  try {
    const dev = db.prepare("INSERT INTO lab_devices (id, name, profile, last_seen_at) VALUES (?, ?, '', ?)");
    dev.run(1, 'Без отметки, но слал', null);
    dev.run(2, 'Отметка старее сообщений', '2026-09-10T17:56:20Z');
    dev.run(3, 'Отметка новее сообщений', '2026-09-20T10:00:00Z');
    dev.run(4, 'Ни разу не выходил на связь', null);
    const msg = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (?, '127.0.0.1', 'MSH|', 'unmatched', ?)");
    msg.run(1, '2026-09-11T08:00:00Z'); msg.run(1, '2026-09-12T08:00:00Z');
    msg.run(2, '2026-09-14T08:02:50Z');
    msg.run(3, '2026-09-15T08:00:00Z');

    db.exec(SQL);
    const seen = (id) => db.prepare('SELECT last_seen_at, added FROM lab_devices WHERE id = ?').get(id);
    assert.equal(seen(1).last_seen_at, '2026-09-12T08:00:00Z');
    assert.equal(seen(2).last_seen_at, '2026-09-14T08:02:50Z', '«kjkj» слал до 14.09, а выглядел молчащим с 10.09');
    assert.equal(seen(3).last_seen_at, '2026-09-20T10:00:00Z', 'более свежая отметка не откатывается назад');
    assert.equal(seen(4).last_seen_at, null, 'кто не выходил на связь — тот и не выходил');
    for (const id of [1, 2, 3, 4]) assert.equal(seen(id).added, 1, 'из таблицы ничего не выпадает само');

    const before = db.prepare('SELECT id, last_seen_at, added FROM lab_devices ORDER BY id').all();
    db.exec(BACKFILL);
    assert.deepEqual(db.prepare('SELECT id, last_seen_at, added FROM lab_devices ORDER BY id').all(), before, 'повторный бэкфилл ничего не меняет');
  } finally { db.close(); }
});

// Ревью M7 — бэкфилл одним проходом; мусор и метки из будущего не в счёт.
test('228 (ревью M7): мусор (rejected) и метка из будущего — не связь; повторный накат ничего не меняет', () => {
  const db = dbBefore228();
  try {
    const dev = db.prepare("INSERT INTO lab_devices (id, name, profile, last_seen_at) VALUES (?, ?, '', ?)");
    dev.run(1, 'Пробы и мусор после них', null);
    dev.run(2, 'Только мусор', null);
    dev.run(3, 'Пробы и метка из будущего', null);
    dev.run(4, 'Только метка из будущего', '2026-09-01T00:00:00Z');
    const msg = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (?, '127.0.0.1', 'MSH|', ?, ?)");
    msg.run(1, 'unmatched', '2026-09-12T08:00:00Z');
    msg.run(1, 'rejected', '2026-09-13T09:00:00Z');   // неразобранное не доказывает, что говорил анализатор (как в ingest.js)
    msg.run(2, 'rejected', '2026-09-14T09:00:00Z');
    msg.run(3, 'applied', '2026-09-13T08:00:00Z');
    msg.run(3, 'unmapped', '2999-01-01T00:00:00Z');   // часы компьютера уезжали вперёд
    msg.run(4, 'unmatched', '2999-01-01T00:00:00Z');
    msg.run(null, 'unmatched', '2026-09-20T08:00:00Z');   // без прибора — никому

    db.exec(SQL);
    const seen = (id) => db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = ?').get(id).last_seen_at;
    assert.equal(seen(1), '2026-09-12T08:00:00Z', 'мусор после проб отметку не двигает');
    assert.equal(seen(2), null, 'одним мусором прибор «на связь» не выходит');
    assert.equal(seen(3), '2026-09-13T08:00:00Z', 'метка из будущего не копируется — берётся самая поздняя настоящая');
    assert.equal(seen(4), '2026-09-01T00:00:00Z', 'будущее не затирает прежнюю отметку');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_lab_device_messages_device'").get(),
      'индекс по прибору: бэкфилл, удаление прибора и lis_device_codes не читают весь лоток');

    const before = db.prepare('SELECT id, last_seen_at FROM lab_devices ORDER BY id').all();
    db.exec(BACKFILL);
    assert.deepEqual(db.prepare('SELECT id, last_seen_at FROM lab_devices ORDER BY id').all(), before, 'повторный бэкфилл ничего не меняет');
    assert.ok(!/CREATE INDEX|ALTER TABLE/.test(BACKFILL), 'повторяется только бэкфилл: ' + BACKFILL.slice(0, 80));
  } finally { db.close(); }
});
