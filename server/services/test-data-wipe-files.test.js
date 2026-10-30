// TEST_DATA_WIPE_V1 — после транзакции: файлы документов визитов, VACUUM
// (удалённое действительно уходит из файла базы) и строка итога для журнала.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir, closeOnExit, closeRegistered } from '../test-helpers/tmpdir.js';
import { GB } from './disk-guard.js';
import {
  removeVisitDocFiles, vacuumAfterWipe, runTestDataWipe, summaryLine, estimateWipeBytes, wipeTestData,
} from './test-data-wipe.js';

test.after(closeRegistered);

// Диск машины разработчика — не данные теста (на этом ПК ~5 ГБ свободно).
const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
const FULL = () => ({ free: 10 * 1024 * 1024, total: 1000 * GB });
const MARK = 'WIPE-MARKER-7f3a9c';

function put(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function clinic() {
  const dir = tmpDir('em-wipe-');
  const db = closeOnExit(openDb(path.join(dir, 'easymed.db')));
  migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Учебный', 1)").run().lastInsertRowid;
  // Тысяча учебных визитов с заметной меткой — чтобы было что сжимать и что искать в файле.
  const ins = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, notes) VALUES (?, 1, '2026-10-01T09:00:00Z', ?)");
  let visit = 0;
  db.transaction(() => { for (let i = 0; i < 1000; i++) visit = ins.run(pid, `${MARK} ${i} ` + 'z'.repeat(400)).lastInsertRowid; })();
  // Поправка 8: карточка CRM, которую учебная запись перевела в «Записан».
  const card = db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Учебная карточка', '+998900000001', 'scheduled')").run().lastInsertRowid;
  db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, created_request) VALUES (?, ?, 1)').run(visit, card);
  return { dir, db, pid, card };
}

const usedBytes = (db) => (db.pragma('page_count', { simple: true }) - db.pragma('freelist_count', { simple: true }))
  * db.pragma('page_size', { simple: true });

test('файлы документов уходят только из patients/<id>/docs; фото и прочее остаются', () => {
  const dir = tmpDir('em-wipe-files-');
  const root = path.join(dir, 'storage', 'clinic-docs', 'patients');
  put(path.join(root, '5', 'docs', '1-a-scan.pdf'));
  put(path.join(root, '5', 'docs', '2-b-photo.jpg'));
  put(path.join(root, '6', 'docs', '3-c.pdf'));
  put(path.join(root, 'legacy-photo-key.jpg'));          // прежнее фото пациента (PATIENT_PHOTO_V1)
  put(path.join(root, '5', 'other', 'keep.txt'));
  put(path.join(dir, 'storage', 'patient-photos', '5.jpg'));
  put(path.join(dir, 'storage', 'clinic-docs', 'branch', 'licence.pdf'));
  assert.deepEqual(removeVisitDocFiles(dir), { removed: 3, failed: 0 });
  assert.equal(fs.existsSync(path.join(root, '5', 'docs')), false);
  assert.equal(fs.existsSync(path.join(root, '6', 'docs')), false);
  for (const kept of [path.join(root, 'legacy-photo-key.jpg'), path.join(root, '5', 'other', 'keep.txt'),
    path.join(dir, 'storage', 'patient-photos', '5.jpg'), path.join(dir, 'storage', 'clinic-docs', 'branch', 'licence.pdf')]) {
    assert.ok(fs.existsSync(kept), kept);
  }
});

test('нет папки хранилища — ничего не удалено и ничего не брошено', () => {
  assert.deepEqual(removeVisitDocFiles(tmpDir('em-wipe-none-')), { removed: 0, failed: 0 });
});

// Ссылки — junction на Windows (прав администратора не нужно), обычная
// ссылка на папку в других системах. Всё «чужое» лежит в той же временной
// папке теста: даже ошибка удаления не вышла бы за её пределы.
test('ссылки (junction, symlink) не открываются и не удаляются: за пределами папок документов ничего не тронуто', () => {
  const dir = tmpDir('em-wipe-links-');
  const root = path.join(dir, 'storage', 'clinic-docs', 'patients');
  const outside = (name) => path.join(dir, 'outside', name);
  put(path.join(outside('a'), 'secret-a.pdf'));
  put(path.join(outside('b'), 'docs', 'secret-b.pdf'));
  put(path.join(outside('c'), 'secret-c.pdf'));
  fs.mkdirSync(path.join(root, '7'), { recursive: true });
  fs.symlinkSync(outside('a'), path.join(root, '7', 'docs'), 'junction');        // папка документов — ссылка
  fs.symlinkSync(outside('b'), path.join(root, '8'), 'junction');                // папка пациента — ссылка
  put(path.join(root, '9', 'docs', 'own.pdf'));
  put(path.join(root, '9', 'docs', 'nested', 'own-2.pdf'));
  fs.symlinkSync(outside('c'), path.join(root, '9', 'docs', 'sub'), 'junction'); // ссылка внутри папки документов

  // Удалены два настоящих файла; три ссылки остались на месте и посчитаны
  // как «не удалено» — за ними могли лежать документы.
  assert.deepEqual(removeVisitDocFiles(dir), { removed: 2, failed: 3 });
  for (const kept of [path.join(outside('a'), 'secret-a.pdf'), path.join(outside('b'), 'docs', 'secret-b.pdf'), path.join(outside('c'), 'secret-c.pdf')]) {
    assert.ok(fs.existsSync(kept), `чужой файл цел: ${kept}`);
  }
  assert.equal(fs.existsSync(path.join(root, '9', 'docs', 'own.pdf')), false);
  assert.equal(fs.existsSync(path.join(root, '9', 'docs', 'nested')), false, 'вложенная настоящая папка убрана');
  for (const link of [path.join(root, '7', 'docs'), path.join(root, '8'), path.join(root, '9', 'docs', 'sub')]) {
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `ссылка осталась на месте: ${link}`);
  }
});

test('папка хранилища — ссылка: по ней не идём, ничего не удалено', () => {
  const dir = tmpDir('em-wipe-linkroot-');
  const elsewhere = path.join(dir, 'elsewhere');
  put(path.join(elsewhere, '5', 'docs', 'x.pdf'));
  fs.mkdirSync(path.join(dir, 'storage', 'clinic-docs'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(dir, 'storage', 'clinic-docs', 'patients'), 'junction');
  assert.deepEqual(removeVisitDocFiles(dir), { removed: 0, failed: 1 });
  assert.ok(fs.existsSync(path.join(elsewhere, '5', 'docs', 'x.pdf')));
});

test('VACUUM: файл базы меньше, удалённых строк в нём больше нет (и в журнале -wal)', () => {
  const { dir, db, card } = clinic();
  const file = path.join(dir, 'easymed.db');
  db.pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(fs.readFileSync(file).includes(MARK), 'метка учебных визитов лежит в файле до удаления');
  const r = runTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(r.deleted.visits, 1000);
  assert.equal(r.vacuum.done, true);
  assert.ok(r.vacuum.after_bytes < r.vacuum.before_bytes, `файл уменьшился: ${r.vacuum.before_bytes} → ${r.vacuum.after_bytes}`);
  assert.equal(fs.readFileSync(file).includes(MARK), false, 'удалённое стёрто из файла базы');
  const wal = file + '-wal';
  assert.equal(fs.existsSync(wal) && fs.readFileSync(wal).includes(MARK), false, 'и из журнала');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 1, 'карта пациента цела');
  // Поправка 9(а): итог несёт число карточек CRM без учебной записи; стадия карточки та же.
  assert.equal(r.crm_cards_unbooked, 1);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(card).status, 'scheduled');
  assert.match(summaryLine(r), /карточек CRM без учебной записи: 1 \(стадии не менялись\)/);
});

test('мало места — VACUUM не делается, удаление при этом состоялось', () => {
  const { dir, db } = clinic();
  const r = runTestDataWipe(db, dir, { diskSpaceImpl: FULL });
  assert.equal(r.deleted.visits, 1000);
  assert.equal(r.vacuum.done, false);
  assert.equal(r.vacuum.reason, 'no_space');
  assert.ok(r.vacuum.need_bytes > r.vacuum.free_bytes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});

test('платформа не сказала, сколько места, — VACUUM делается, как копии (disk-guard: null — не мешать)', () => {
  const { dir, db } = clinic();
  assert.equal(vacuumAfterWipe(db, dir, { diskSpaceImpl: () => null }).done, true);
});

// Поправка 9(б): место проверяется ДО удаления (просьба и запуск, C4) — одна
// большая транзакция раздувает журнал базы примерно на объём удаляемого.
test('оценка роста журнала (-wal) за удаление: не меньше настоящего, оставляемые таблицы в неё не входят', () => {
  const { dir, db } = clinic();
  // Большие карты пациентов остаются — в оценку они не входят.
  const insP = db.prepare("INSERT INTO patients (full_name, branch_id, notes) VALUES (?, 1, ?)");
  db.transaction(() => { for (let i = 0; i < 1000; i++) insP.run('Карта ' + i, 'p'.repeat(3000)); })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const used = usedBytes(db);
  const est = estimateWipeBytes(db);
  wipeTestData(db);
  const wal = fs.statSync(path.join(dir, 'easymed.db-wal')).size;
  assert.ok(wal > 0, 'удаление писало в журнал');
  assert.ok(est >= wal, `оценка ${est} Б не меньше журнала ${wal} Б`);
  assert.ok(est < used, `оценка ${est} Б меньше всей базы ${used} Б: карты пациентов в неё не входят`);
});

test('строка итога для журнала: только числа и имена таблиц', () => {
  const line = summaryLine({
    deleted: { visits: 12, invoices: 7, payments: 9 },
    cleared: { products: 3, crm_request_services: 2 },
    crm_cards_unbooked: 5,
    files: { removed: 4, failed: 1 },
    vacuum: { done: true, before_bytes: 2000, after_bytes: 500 },
  });
  assert.match(line, /^Тестовые данные удалены: visits 12, visit_services 0, /);
  assert.match(line, /invoices 7, payments 9/);
  assert.match(line, /products_reset 3, crm_lines_unlinked 2, карточек CRM без учебной записи: 5 \(стадии не менялись\), files 4 \(не удалено 1\), vacuum 2000→500 Б$/);
  // Нет поля (итог без карточек) — ноль, а не «undefined».
  assert.match(summaryLine({ deleted: {}, cleared: {} }), /карточек CRM без учебной записи: 0 \(стадии не менялись\)$/);
});
