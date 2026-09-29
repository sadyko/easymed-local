// LIS_DISCOVERY_FIX_V1 (мигр. 229) — прибор узнаётся по адресу и по тому, КАК
// ОН СЕБЯ НАЗВАЛ: sending_app = MSH-3 первого сообщения. Бэкфилл пишет строкам
// только имя, адрес — никогда: строка без адреса узнаёт его при первой пробе,
// которую примет (решение владельца 2026-09-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '229_lab_device_sending_app.sql'), 'utf8');
// Бэкфилл — последнее предложение файла: повторный накат проверяется им одним
// (ALTER TABLE второй раз не выполнить, и миграции второй раз не катятся).
const BACKFILL = SQL.slice(SQL.indexOf('UPDATE lab_devices'));

function dbBefore229() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig229-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 229)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

const MSH = (app) => `MSH|^~\\&|${app}|Mindray|||20260929120000||ORU^R01|1|P|2.3.1`;
const MSG = (app) => [MSH(app), 'OBR|1||LAB-000123|00001^Automated Count^99MRC', 'OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F'].join('\r');

test('229: колонка sending_app, по умолчанию NULL — «прибор ещё не называл себя»', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const col = db.prepare('PRAGMA table_info(lab_devices)').all().find((c) => c.name === 'sending_app');
    assert.ok(col, 'колонка есть');
    assert.equal(col.type, 'TEXT');
    const id = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Руками', 'mindray-bc-5300')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT sending_app FROM lab_devices WHERE id = ?').get(id).sending_app, null);
  } finally { db.close(); }
});

test('229: бэкфилл — MSH-3 первого сообщения, компонент 1, без пробелов; адрес не трогается', () => {
  const db = dbBefore229();
  try {
    const dev = db.prepare("INSERT INTO lab_devices (id, name, profile, host, discovered) VALUES (?, ?, '', ?, ?)");
    dev.run(1, 'BC-5300', '10.0.0.9', 1);
    dev.run(2, 'Гематология', '', 0);
    dev.run(3, 'Первым пришёл мусор', '10.0.0.30', 1);
    dev.run(4, 'Ни разу не выходил на связь', '', 0);
    dev.run(5, 'С пробелами', '10.0.0.50', 1);
    dev.run(6, 'MSH-3 пуст', '10.0.0.60', 1);
    dev.run(7, 'MSH без полей после MSH-3', '10.0.0.70', 1);
    const msg = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (?, '10.0.0.1', ?, ?)");
    msg.run(1, MSG('BC-5300'), 'unmatched');
    msg.run(1, MSG('BS-240'), 'unmatched');             // второе сообщение — уже не «как назвался первым»
    msg.run(2, MSG('BC-2800^X^Y'), 'unmapped');         // компонент 1 поля MSH-3
    msg.run(3, 'мусор, а не HL7', 'rejected');
    msg.run(3, MSG('AutoLumo A1000'), 'unmatched');     // первое из сообщений, начинающихся с MSH|
    msg.run(5, MSG(' BC-20 '), 'applied');
    msg.run(6, MSG('^Mindray'), 'unmatched');           // имени нет — и строка его не получает
    msg.run(6, MSG('BC-5300'), 'unmatched');
    msg.run(7, 'MSH|^~\\&|BC-3000\rOBR|1||LAB-000123|x', 'unmatched');   // сегмент кончился раньше MSH-4
    msg.run(null, MSG('BC-9999'), 'unmatched');         // без прибора — никому

    db.exec(SQL);
    const row = (id) => db.prepare('SELECT sending_app, host FROM lab_devices WHERE id = ?').get(id);
    assert.equal(row(1).sending_app, 'BC-5300', 'первое сообщение, а не последнее');
    assert.equal(row(2).sending_app, 'BC-2800', 'компонент 1: «BC-2800^X^Y» → «BC-2800»');
    assert.equal(row(3).sending_app, 'AutoLumo A1000', 'мусор пропускается — берётся первое MSH');
    assert.equal(row(4).sending_app, null, 'кто не присылал — тот и не назывался');
    assert.equal(row(5).sending_app, 'BC-20', 'пробелы вокруг имени обрезаются');
    assert.equal(row(6).sending_app, null, 'пустое имя первого сообщения не записывается');
    assert.equal(row(7).sending_app, 'BC-3000', 'поле MSH-3 кончается на конце сегмента');
    assert.equal(row(2).host, '', 'строке без адреса бэкфилл адреса не пишет');
    assert.equal(row(4).host, '');
    assert.equal(row(1).host, '10.0.0.9', 'адрес найденной строки не меняется');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM lab_devices WHERE host <> ''").get().c, 5);
  } finally { db.close(); }
});

test('229: имя пишется только туда, где его нет; повторный накат ничего не меняет', () => {
  const db = dbBefore229();
  try {
    const dev = db.prepare("INSERT INTO lab_devices (id, name, profile, host) VALUES (?, ?, '', '')");
    dev.run(1, 'Пустая строка вместо имени');
    dev.run(2, 'Имя уже есть');
    dev.run(3, 'Нет сообщений');
    const msg = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (?, '127.0.0.1', ?, 'unmatched')");
    msg.run(1, MSG('BC-5300'));
    msg.run(2, MSG('BS-240'));

    db.exec(SQL);
    db.prepare("UPDATE lab_devices SET sending_app = '' WHERE id = 1").run();
    db.prepare("UPDATE lab_devices SET sending_app = 'CL-900i' WHERE id = 2").run();
    db.exec(BACKFILL);
    const app = (id) => db.prepare('SELECT sending_app FROM lab_devices WHERE id = ?').get(id).sending_app;
    assert.equal(app(1), 'BC-5300', 'пустая строка — то же, что «не знаем»');
    assert.equal(app(2), 'CL-900i', 'известное имя бэкфилл не перезаписывает');
    assert.equal(app(3), null);

    const before = db.prepare('SELECT id, name, host, sending_app FROM lab_devices ORDER BY id').all();
    db.exec(BACKFILL);
    assert.deepEqual(db.prepare('SELECT id, name, host, sending_app FROM lab_devices ORDER BY id').all(), before, 'повторный бэкфилл ничего не меняет');
    assert.ok(!/ALTER TABLE/.test(BACKFILL), 'повторяется только бэкфилл: ' + BACKFILL.slice(0, 80));
  } finally { db.close(); }
});
