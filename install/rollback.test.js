// V3120_FIX — возврат версии вместе с базой (install/rollback.mjs).
//
// Строит настоящую установку во временной папке: versions\<v> с разными
// наборами миграций, junction `current`, настоящие SQLite-базы с
// schema_migrations. Всё под os.tmpdir(); реальная клиника не трогается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tmpDir } from '../server/test-helpers/tmpdir.js';
import {
  planRollback, findMatchingBackup, runRecover, runAuto, recordRollback, restoreDb, dbInUse,
  PENDING_NAME, ROLLED_BACK_NAME, RESULT_NAME, readJson,
} from './rollback.mjs';

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const OLD = ['001_init.sql', '002_more.sql'];
const NEW = [...OLD, '003_guard.sql'];

function makeDb(file, applied, marker) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY); CREATE TABLE t (v TEXT);');
  for (const n of applied) db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(n);
  db.prepare('INSERT INTO t (v) VALUES (?)').run(marker);
  db.close();
}
const markerOf = (file) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare('SELECT v FROM t').get().v; } finally { db.close(); }
};

function install({ oldV = '3.10.0', newV = '3.11.0', newMigrations = NEW, current = newV } = {}) {
  const root = tmpDir('em-rollback-');
  for (const [v, list] of [[oldV, OLD], [newV, newMigrations]]) {
    const mig = path.join(root, 'versions', v, 'server', 'db', 'migrations');
    fs.mkdirSync(mig, { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', v, 'server', 'index.js'), `// ${v}\n`);
    for (const f of list) fs.writeFileSync(path.join(mig, f), '-- sql\n');
  }
  fs.symlinkSync(path.join(root, 'versions', current), path.join(root, 'current'), LINK);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  makeDb(path.join(dataDir, 'easymed.db'), newMigrations, 'LIVE-after-update');
  const backup = path.join(dataDir, 'backups', `pre-${newV}.db`);
  makeDb(backup, OLD, 'BEFORE-update');
  return { root, dataDir, backup, oldV, newV };
}
const cur = (root) => path.basename(fs.realpathSync(path.join(root, 'current')));
const answers = (...list) => () => list.shift() ?? '';
const quiet = () => {};

test('planRollback: видит новые миграции и находит копию, подходящую старой версии', () => {
  const inst = install();
  // Более свежая, но НЕ подходящая копия (в ней уже миграция 3.11) — выбирать нельзя.
  const partial = path.join(inst.dataDir, 'backups', 'pre-3.11.0.1.db');
  makeDb(partial, NEW, 'PARTIAL');
  const plan = planRollback({ root: inst.root, to: inst.oldV });
  assert.equal(plan.from, '3.11.0');
  assert.deepEqual(plan.newMigrations, ['003_guard.sql']);
  assert.equal(plan.backup.name, 'pre-3.11.0.db');
  assert.equal(plan.backup.checked, true, 'копия выбрана по содержимому, а не по имени');
});

test('findMatchingBackup без чтения SQLite: правило по имени (ближайшая версия после целевой)', () => {
  const inst = install();
  const b = findMatchingBackup({ dataDir: inst.dataDir, root: inst.root, from: '3.11.0', to: '3.10.0', sqlite: null });
  assert.equal(b.name, 'pre-3.11.0.db');
  assert.equal(b.checked, false);
});

test('recover «д»: база из копии, прежняя сохранена как rollback-*.db, current назад, откат отмечен', () => {
  const inst = install();
  fs.writeFileSync(path.join(inst.dataDir, PENDING_NAME), JSON.stringify({ version: '3.11.0', from: '3.10.0', backup: inst.backup }));
  const log = [];
  const code = runRecover({ root: inst.root, to: inst.oldV, ask: answers('д'), log: (s) => log.push(s) });
  assert.equal(code, 0, log.join('\n'));
  assert.equal(cur(inst.root), '3.10.0');
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'BEFORE-update');
  const saved = fs.readdirSync(path.join(inst.dataDir, 'backups')).filter((f) => /^rollback-\d{8}-\d{6}\.db$/.test(f));
  assert.equal(saved.length, 1, 'прежняя база сохранена, не удалена');
  assert.equal(markerOf(path.join(inst.dataDir, 'backups', saved[0])), 'LIVE-after-update');
  assert.ok(fs.existsSync(inst.backup), 'копия перед обновлением осталась на месте');
  assert.ok(log.join('\n').includes('ПОСЛЕ'), 'человеку сказано, что станет с данными после копии');

  const result = readJson(path.join(inst.dataDir, RESULT_NAME));
  assert.equal(result.ok, false);
  assert.equal(result.version, '3.11.0');
  assert.equal(result.db, 'restored');
  assert.equal(fs.existsSync(path.join(inst.dataDir, PENDING_NAME)), false);
  assert.equal(readJson(path.join(inst.dataDir, ROLLED_BACK_NAME)).version, '3.11.0');
});

test('recover «о»: отмена — ничего не меняется', () => {
  const inst = install();
  const code = runRecover({ root: inst.root, to: inst.oldV, ask: answers('о'), log: quiet });
  assert.equal(code, 2);
  assert.equal(cur(inst.root), '3.11.0');
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'LIVE-after-update');
  assert.equal(fs.existsSync(path.join(inst.dataDir, ROLLED_BACK_NAME)), false);
});

test('recover «н», затем «д»: только программа, база не тронута', () => {
  const inst = install();
  const code = runRecover({ root: inst.root, to: inst.oldV, ask: answers('н', 'д'), log: quiet });
  assert.equal(code, 0);
  assert.equal(cur(inst.root), '3.10.0');
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'LIVE-after-update');
});

test('recover без изменений устройства базы: база не трогается и не спрашивается', () => {
  const inst = install({ newMigrations: OLD });
  let asked = 0;
  const code = runRecover({ root: inst.root, to: inst.oldV, ask: () => { asked++; return 'д'; }, log: quiet });
  assert.equal(code, 0);
  assert.equal(asked, 0);
  assert.equal(cur(inst.root), '3.10.0');
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'LIVE-after-update');
});

test('recover: нет подходящей копии — по умолчанию отмена', () => {
  const inst = install();
  fs.rmSync(inst.backup);
  const code = runRecover({ root: inst.root, to: inst.oldV, ask: answers(''), log: quiet });
  assert.equal(code, 2);
  assert.equal(cur(inst.root), '3.11.0');
});

test('recover при запущенном сервере (база открыта) — отказ, ничего не изменено', { skip: process.platform !== 'win32' && 'Windows-only file locking' }, () => {
  const inst = install();
  const db = new Database(path.join(inst.dataDir, 'easymed.db'));
  try {
    assert.equal(dbInUse(inst.dataDir), true);
    const code = runRecover({ root: inst.root, to: inst.oldV, ask: answers('д'), log: quiet });
    assert.equal(code, 1);
    assert.equal(cur(inst.root), '3.11.0');
  } finally {
    db.close();
  }
  assert.equal(dbInUse(inst.dataDir), false);
});

test('restoreDb: ошибка копирования возвращает всё на место', () => {
  const inst = install();
  assert.throws(() => restoreDb({
    dataDir: inst.dataDir, backupFile: inst.backup,
    copyFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  }), /disk full/);
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'LIVE-after-update');
  assert.equal(fs.readdirSync(path.join(inst.dataDir, 'backups')).some((f) => f.startsWith('rollback-')), false);
});

test('auto: новая версия упала до проверки здоровья — возврат версии и базы без вопросов', () => {
  const inst = install();
  fs.writeFileSync(path.join(inst.dataDir, PENDING_NAME), JSON.stringify({ version: '3.11.0', from: '3.10.0', backup: inst.backup }));
  const code = runAuto({ root: inst.root, log: quiet });
  assert.equal(code, 0);
  assert.equal(cur(inst.root), '3.10.0');
  assert.equal(markerOf(path.join(inst.dataDir, 'easymed.db')), 'BEFORE-update');
  const result = readJson(path.join(inst.dataDir, RESULT_NAME));
  assert.equal(result.ok, false);
  assert.match(result.detail, /crashed at start/);
});

test('auto: без незавершённого обновления — ничего не делает (код 3)', () => {
  const inst = install();
  assert.equal(runAuto({ root: inst.root, log: quiet }), 3);
  assert.equal(cur(inst.root), '3.11.0');
  // pending на ДРУГУЮ версию (не ту, что сейчас в current) — тоже не наше дело.
  fs.writeFileSync(path.join(inst.dataDir, PENDING_NAME), JSON.stringify({ version: '9.9.9', from: '3.10.0' }));
  assert.equal(runAuto({ root: inst.root, log: quiet }), 3);
});

test('recordRollback: неотправленный «успех» уходящей версии превращается в ok:false', () => {
  const inst = install();
  fs.writeFileSync(path.join(inst.dataDir, RESULT_NAME), JSON.stringify({ version: '3.11.0', from: '3.10.0', ok: true }));
  recordRollback({ dataDir: inst.dataDir, from: '3.11.0', to: '3.10.0', by: 'recover.cmd', dbRestored: false });
  const r = readJson(path.join(inst.dataDir, RESULT_NAME));
  assert.equal(r.ok, false);
  assert.equal(r.version, '3.11.0');
  assert.equal(r.from, '3.10.0');
});

test('recordRollback: чужой (не про уходящую версию) результат не трогается', () => {
  const inst = install();
  const other = { version: '3.9.0', from: '3.8.0', ok: true };
  fs.writeFileSync(path.join(inst.dataDir, RESULT_NAME), JSON.stringify(other));
  recordRollback({ dataDir: inst.dataDir, from: '3.11.0', to: '3.10.0', by: 'recover.cmd', dbRestored: false });
  assert.deepEqual(readJson(path.join(inst.dataDir, RESULT_NAME)), other);
});
