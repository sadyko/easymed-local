// PATIENT_FILE_ATTACH_V1 — РЕЗЕРВНАЯ КОПИЯ, КОТОРАЯ НЕ СОДЕРЖИТ ФАЙЛОВ, ЭТО
// НЕ РЕЗЕРВНАЯ КОПИЯ.
//
// createBackup() копировала только базу (db.backup → один .db). Сканы,
// фотографии направлений и вложения переписки лежат в <dataDir>/storage, и в
// копию не попадали НИ РАЗУ — при том, что «Сброс к заводским настройкам» эту
// папку удаляет (applyFactoryReset). То есть продукт умел стирать файлы и не
// умел их спасать, а узнать об этом клиника могла ровно одним способом:
// восстановиться и обнаружить в каждой карте документы, которые не
// открываются.
//
// Проверяется против НАСТОЯЩЕГО кода копий, а не против пересказа: те же
// createBackup / pruneBackupsByKind / processPendingAction, которыми пользуется
// экран «Настройки → Резервные копии».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createBackup, listBackups, pruneBackupsByKind, requestRestore, processPendingAction } from './backup.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-files-'));
  const db = openDb(path.join(dir, 'easymed.db'));
  migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Пациент','MRN-1',1)").run().lastInsertRowid;
  const rel = `patients/${pid}/docs/1757000000000-abc123-napravlenie.pdf`;
  const abs = path.join(dir, 'storage', 'clinic-docs', ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'SKAN-NAPRAVLENIYA');
  db.prepare("INSERT INTO visit_documents (patient_id, title, file_name, file_path, doc_type) VALUES (?,?,?,?, 'upload')")
    .run(pid, 'Направление', 'napravlenie.pdf', rel);
  return { dir, db, pid, rel, abs };
}

test('копия содержит и базу, и файлы пациентов', async () => {
  const f = fixture();
  try {
    const entry = await createBackup(f.db, f.dir, 'daily');
    assert.equal(entry.files, 1, 'снимок посчитал файл');

    const sidecar = path.join(f.dir, 'backups', entry.name.replace(/\.db$/, '') + '.files');
    const copied = path.join(sidecar, 'clinic-docs', ...f.rel.split('/'));
    assert.ok(fs.existsSync(copied), 'файл документа лежит в копии рядом с базой');
    assert.equal(fs.readFileSync(copied, 'utf8'), 'SKAN-NAPRAVLENIYA');

    // Снимок НЕ становится «ещё одной копией» в списке: restore-RPC умеет
    // указывать только на то, что вернул listBackups.
    const listed = listBackups(f.dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, entry.name);
  } finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('восстановление возвращает файлы — карта после него не полна ссылками в пустоту', async () => {
  const f = fixture();
  try {
    const entry = await createBackup(f.db, f.dir, 'manual');
    assert.ok((await requestRestore(f.db, f.dir, entry.name)).ok);

    // Катастрофа между копией и восстановлением: файлы потеряны
    // (переустановка Windows, «почистили диск», сброс к заводским).
    fs.rmSync(path.join(f.dir, 'storage'), { recursive: true, force: true });
    f.db.close();

    const out = processPendingAction(f.dir);
    assert.equal(out.action, 'restore');
    assert.equal(out.files, 1, 'файл вернулся вместе с базой');
    assert.equal(fs.readFileSync(f.abs, 'utf8'), 'SKAN-NAPRAVLENIYA');

    // И строка документа снова указывает на существующий файл.
    const db2 = openDb(path.join(f.dir, 'easymed.db'));
    const row = db2.prepare('SELECT file_path FROM visit_documents LIMIT 1').get();
    assert.equal(row.file_path, f.rel);
    db2.close();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('восстановление СЛИВАЕТ файлы: то, что появилось после копии, не пропадает', async () => {
  const f = fixture();
  try {
    const entry = await createBackup(f.db, f.dir, 'manual');
    const laterRel = `patients/${f.pid}/docs/1757999999999-def456-pozzhe.pdf`;
    const laterAbs = path.join(f.dir, 'storage', 'clinic-docs', ...laterRel.split('/'));
    fs.writeFileSync(laterAbs, 'POZDNIY-FAYL');

    assert.ok((await requestRestore(f.db, f.dir, entry.name)).ok);
    f.db.close();
    processPendingAction(f.dir);

    assert.equal(fs.readFileSync(f.abs, 'utf8'), 'SKAN-NAPRAVLENIYA', 'старый файл на месте');
    assert.equal(fs.readFileSync(laterAbs, 'utf8'), 'POZDNIY-FAYL',
      'файл, появившийся после копии, откатом базы не уничтожается');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('устаревшая копия уносит свой снимок файлов — иначе диск занят навсегда', async () => {
  const f = fixture();
  try {
    const dir = path.join(f.dir, 'backups');
    const names = [];
    // KEEP_BY_KIND.manual = 10 — делаем одиннадцать и проверяем, что вместе с
    // вытесненной копией ушёл и её снимок.
    for (let i = 0; i < 11; i++) {
      const e = await createBackup(f.db, f.dir, 'manual', new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      names.push(e.name);
      // mtime строго по возрастанию, чтобы порядок вытеснения был определённым
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      fs.utimesSync(path.join(dir, e.name), t, t);
    }
    pruneBackupsByKind(dir);

    const oldest = names[0];
    assert.ok(!fs.existsSync(path.join(dir, oldest)), 'самая старая копия удалена');
    assert.ok(!fs.existsSync(path.join(dir, oldest.replace(/\.db$/, '') + '.files')),
      'её снимок файлов удалён вместе с ней');
    const newest = names[names.length - 1];
    assert.ok(fs.existsSync(path.join(dir, newest.replace(/\.db$/, '') + '.files')),
      'снимок оставшейся копии на месте');
  } finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
