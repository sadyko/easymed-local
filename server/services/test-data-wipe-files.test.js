// TEST_DATA_WIPE_V1 — место до удаления, после транзакции: файлы документов
// визитов, VACUUM (удалённое действительно уходит из файла базы) и строка
// итога для журнала.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir, closeOnExit, closeRegistered } from '../test-helpers/tmpdir.js';
import { GB, RESERVE_BYTES } from './disk-guard.js';
import {
  removeVisitDocFiles, vacuumAfterWipe, runTestDataWipe, summaryLine, estimateWipeBytes, wipeTestData,
  WIPE_NO_SPACE_TEMPLATE,
} from './test-data-wipe.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';
import { snapshotStorage, storageSnapshotDir } from './backup.js';

test.after(closeRegistered);

// Ревью C4: файл документа удаляется, только если он есть в копии «Перед
// удалением тестовых данных» (снимок хранилища рядом с копией базы). Здесь —
// тот же снимок, что делает createBackup (snapshotStorage), без самой базы.
let copySeq = 0;
function copyNow(dir) {
  const name = `wipe-20261030-1000${String(copySeq++ % 60).padStart(2, '0')}.db`;
  snapshotStorage(dir, name);
  return name;
}

// Диск машины разработчика — не данные теста (на этом ПК ~5 ГБ свободно).
const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
const FULL = () => ({ free: 10 * 1024 * 1024, total: 1000 * GB });
// Место было до удаления и кончилось к VACUUM: первый вопрос диску — проверка
// до транзакции, второй — перед VACUUM.
const roomyThenFull = () => { let calls = 0; return () => (calls++ === 0 ? ROOMY() : FULL()); };
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
  assert.deepEqual(removeVisitDocFiles(dir, { backup: copyNow(dir) }), { removed: 3, failed: 0 });
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
  assert.deepEqual(removeVisitDocFiles(dir, { backup: copyNow(dir) }), { removed: 2, failed: 3 });
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
  assert.deepEqual(removeVisitDocFiles(dir, { backup: copyNow(dir) }), { removed: 0, failed: 1 });
  assert.ok(fs.existsSync(path.join(elsewhere, '5', 'docs', 'x.pdf')));
});

test('VACUUM: файл базы меньше, удалённых строк в нём больше нет (и в журнале -wal)', () => {
  const { dir, db, card } = clinic();
  const file = path.join(dir, 'easymed.db');
  const lastVisit = db.prepare('SELECT MAX(id) AS m FROM visits').get().m;
  const insVs = db.prepare("INSERT INTO visit_services (visit_id, quantity, unit_price, total, status) VALUES (?, 1, 100, 100, 'added')");
  for (let i = 0; i < 3; i++) insVs.run(lastVisit);
  const vsMax = db.prepare('SELECT MAX(id) AS m FROM visit_services').get().m;
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
  // Номера строк визита идут дальше учебных и после VACUUM (sqlite_sequence
  // цел): штрихкод пробы, выданный однажды, не достанется новой пробе.
  const v = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (1, 1, '2026-10-31T09:00:00Z')").run().lastInsertRowid;
  const vs = insVs.run(v).lastInsertRowid;
  assert.ok(vs > vsMax, `новая строка визита ${vs} > учебных ${vsMax}`);
});

test('мало места ещё до удаления — отказ no_space: база, файлы и запрет на удаление денег не тронуты', () => {
  const { dir, db } = clinic();
  const doc = path.join(dir, 'storage', 'clinic-docs', 'patients', '1', 'docs', '1-a-scan.pdf');
  put(doc);
  assert.throws(() => runTestDataWipe(db, dir, { diskSpaceImpl: FULL }), (e) => {
    assert.equal(e.code, 'no_space');
    assert.ok(e.need_bytes >= estimateWipeBytes(db) + RESERVE_BYTES, 'нужно — рост журнала и запас');
    assert.equal(e.free_bytes, 10 * 1024 * 1024);
    assert.equal(e.template, WIPE_NO_SPACE_TEMPLATE);
    assert.equal(e.params.free, 0);
    assert.ok(e.params.need >= 1);
    assert.match(e.message, /^Недостаточно места на диске: нужно \d+,\d ГБ, свободно 0,0 ГБ\. Тестовые данные не удалены\.$/);
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 1000, 'визиты на месте');
  assert.ok(fs.existsSync(doc), 'файл документа на месте');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'patient_deposits_no_delete'").get(), 'запрет на удаление денег на месте');
  assert.equal(db.inTransaction, false);
});

test('фраза отказа «нет места» — в словаре на трёх языках', () => {
  const e = STRINGS[WIPE_NO_SPACE_TEMPLATE];
  assert.ok(e && e.ru === WIPE_NO_SPACE_TEMPLATE && e.uz && e.en, 'статья словаря');
  for (const lang of ['uz', 'en']) {
    assert.ok(e[lang].includes('{need}') && e[lang].includes('{free}'), lang);
  }
});

test('мало места к VACUUM — VACUUM не делается, удаление при этом состоялось', () => {
  const { dir, db } = clinic();
  const r = runTestDataWipe(db, dir, { diskSpaceImpl: roomyThenFull() });
  assert.equal(r.deleted.visits, 1000);
  assert.equal(r.vacuum.done, false);
  assert.equal(r.vacuum.reason, 'no_space');
  assert.ok(r.vacuum.need_bytes > r.vacuum.free_bytes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});

test('платформа не сказала, сколько места, — VACUUM делается, как копии (disk-guard: null — не мешать)', () => {
  const { dir, db } = clinic();
  assert.equal(vacuumAfterWipe(db, dir, { diskSpaceImpl: () => null }).done, true);
  // И проверка до удаления тоже не мешает.
  assert.equal(runTestDataWipe(db, dir, { diskSpaceImpl: () => null }).deleted.visits, 1000);
});

test('VACUUM не удался — не бросает, причина в итоге, журнал сжат', () => {
  const { dir, db } = clinic();
  db.pragma('query_only = ON');   // VACUUM — запись: SQLite откажет
  let r;
  try { r = vacuumAfterWipe(db, dir, { diskSpaceImpl: ROOMY }); } finally { db.pragma('query_only = OFF'); }
  assert.equal(r.done, false);
  assert.equal(r.reason, 'failed');
  assert.equal(r.after_bytes, fs.statSync(path.join(dir, 'easymed.db')).size);
  const wal = path.join(dir, 'easymed.db-wal');
  assert.equal(fs.existsSync(wal) ? fs.statSync(wal).size : 0, 0);
});

test('файл документа «только для чтения» удаляется', () => {
  const dir = tmpDir('em-wipe-ro-');
  const file = path.join(dir, 'storage', 'clinic-docs', 'patients', '5', 'docs', '1-a-scan.pdf');
  put(file);
  fs.chmodSync(file, 0o444);
  assert.deepEqual(removeVisitDocFiles(dir, { backup: copyNow(dir) }), { removed: 1, failed: 0 });
  assert.equal(fs.existsSync(file), false);
});

// ── ревью C4: файл документа уходит, только если он есть в копии ────────────

function docsClinic(prefix) {
  const dir = tmpDir(prefix);
  const docs = path.join(dir, 'storage', 'clinic-docs', 'patients', '5', 'docs');
  return { dir, docs, inCopy: (backup, name) => path.join(storageSnapshotDir(dir, backup), 'clinic-docs', 'patients', '5', 'docs', name) };
}

test('снимок копии лежит там, где его ищет удаление: backups/<имя копии без .db>.files/<как в storage>', () => {
  const { dir, docs, inCopy } = docsClinic('em-wipe-snap-');
  put(path.join(docs, '1-a.pdf'), 'abc');
  const backup = copyNow(dir);
  assert.equal(storageSnapshotDir(dir, backup), path.join(dir, 'backups', backup.replace(/\.db$/, '') + '.files'));
  assert.equal(fs.readFileSync(inCopy(backup, '1-a.pdf'), 'utf8'), 'abc');
});

test('файл есть в копии — удаляется; в копии его нет (ссылка не сделалась) — остаётся и считается «не удалено»', () => {
  const { dir, docs, inCopy } = docsClinic('em-wipe-copied-');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  put(path.join(docs, '2-b.pdf'), 'bbb');
  const backup = copyNow(dir);
  fs.rmSync(inCopy(backup, '2-b.pdf'));   // антивирус не дал сделать ссылку, копирование тоже не прошло
  assert.deepEqual(removeVisitDocFiles(dir, { backup }), { removed: 1, failed: 1 });
  assert.equal(fs.existsSync(path.join(docs, '1-a.pdf')), false);
  assert.equal(fs.readFileSync(path.join(docs, '2-b.pdf'), 'utf8'), 'bbb', 'без пути назад файл не удаляется');
});

test('файл загружен после копии — остаётся и считается «не удалено»', () => {
  const { dir, docs } = docsClinic('em-wipe-after-');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  const backup = copyNow(dir);
  put(path.join(docs, '3-c.pdf'), 'загружен между копией и перезапуском');
  assert.deepEqual(removeVisitDocFiles(dir, { backup }), { removed: 1, failed: 1 });
  assert.ok(fs.existsSync(path.join(docs, '3-c.pdf')));
});

test('в копии файл другого размера — не тот файл: остаётся', () => {
  const { dir, docs, inCopy } = docsClinic('em-wipe-size-');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  const backup = copyNow(dir);
  fs.rmSync(inCopy(backup, '1-a.pdf'));            // ссылка на тот же файл — новый файл на его месте
  put(inCopy(backup, '1-a.pdf'), 'другой размер');
  assert.deepEqual(removeVisitDocFiles(dir, { backup }), { removed: 0, failed: 1 });
  assert.equal(fs.readFileSync(path.join(docs, '1-a.pdf'), 'utf8'), 'aaa');
});

test('копия не названа или её снимка нет — не удаляется ничего', () => {
  const { dir, docs } = docsClinic('em-wipe-nocopy-');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  assert.deepEqual(removeVisitDocFiles(dir), { removed: 0, failed: 1 });
  assert.deepEqual(removeVisitDocFiles(dir, { backup: 'wipe-20261030-235959.db' }), { removed: 0, failed: 1 });
  assert.ok(fs.existsSync(path.join(docs, '1-a.pdf')));
});

test('снимок копии или папка в нём — ссылка: такой «копии» не верим, файлы остаются', () => {
  const { dir, docs } = docsClinic('em-wipe-snaplink-');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  // Где-то вне копии лежит файл того же размера по тому же пути.
  const elsewhere = path.join(dir, 'elsewhere');
  put(path.join(elsewhere, 'clinic-docs', 'patients', '5', 'docs', '1-a.pdf'), 'aaa');
  const whole = 'wipe-20261030-110000.db';
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.symlinkSync(elsewhere, storageSnapshotDir(dir, whole), 'junction');
  assert.deepEqual(removeVisitDocFiles(dir, { backup: whole }), { removed: 0, failed: 1 });

  const part = 'wipe-20261030-110001.db';
  fs.mkdirSync(path.join(storageSnapshotDir(dir, part), 'clinic-docs', 'patients'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'clinic-docs', 'patients', '5'), path.join(storageSnapshotDir(dir, part), 'clinic-docs', 'patients', '5'), 'junction');
  assert.deepEqual(removeVisitDocFiles(dir, { backup: part }), { removed: 0, failed: 1 });
  assert.ok(fs.existsSync(path.join(docs, '1-a.pdf')));
});

test('полное удаление передаёт имя копии файлам: файл из копии ушёл, загруженный после — нет', () => {
  const { dir, db } = clinic();
  const docs = path.join(dir, 'storage', 'clinic-docs', 'patients', '1', 'docs');
  put(path.join(docs, '1-a.pdf'), 'aaa');
  const backup = copyNow(dir);
  put(path.join(docs, '2-b.pdf'), 'bbb');
  const r = runTestDataWipe(db, dir, { diskSpaceImpl: ROOMY, backup });
  assert.deepEqual(r.files, { removed: 1, failed: 1 });
  assert.ok(fs.existsSync(path.join(docs, '2-b.pdf')));
  assert.match(summaryLine(r), /files 1 \(не удалено 1\)/);
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
  // Итог, прочитанный с диска (test-data-wipe-result.json), — числа только числами.
  assert.match(summaryLine({ files: { removed: '4' }, vacuum: { done: true } }), /, files 4, vacuum 0→0 Б$/);
  assert.match(summaryLine({ files: { removed: 2, failed: '1' } }), /, files 2 \(не удалено 1\)$/);
});
