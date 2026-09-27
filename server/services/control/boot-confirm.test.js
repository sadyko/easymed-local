// V3120_FIX — «установлено» только после того, как новая версия ответила.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir, closeOnExit } from '../../test-helpers/tmpdir.js';
import { readJsonFile } from './checkin.js';
import { applyUpdate, scheduleUpdater } from './updater.js';
import {
  confirmBoot, reconcileUpdateAtBoot, armBootConfirmation, syncRecoverCmd, writePending, readPending,
  PENDING_NAME, ROLLED_BACK_NAME, RESULT_NAME,
} from './boot-confirm.js';

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const ok200 = async () => ({ status: 200 });

function workspace() {
  const dataDir = tmpDir('em-bootconf-');
  const db = closeOnExit(openDb(':memory:'));
  migrate(db);
  return { dataDir, db };
}
function setConsent(db, version) {
  db.prepare("INSERT INTO control_state (key, value, updated_at) VALUES ('update_consent', ?, 'x')").run(JSON.stringify({ version, hour: 3 }));
  db.prepare("INSERT INTO control_state (key, value, updated_at) VALUES ('update_scheduled_at', '2026-01-01T03:00:00Z', 'x')").run();
}
const consent = (db) => db.prepare("SELECT value FROM control_state WHERE key='update_consent'").get();
const result = (dataDir) => readJsonFile(path.join(dataDir, RESULT_NAME));

test('confirmBoot: 200 → ok:true и pending удалён', async () => {
  const { dataDir } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0', backup: 'b.db', detail: 'Switched.' });
  assert.equal(await confirmBoot(dataDir, { runningVersion: '2.4.0', healthUrl: 'http://x', fetchImpl: ok200 }), true);
  const r = result(dataDir);
  assert.equal(r.ok, true);
  assert.equal(r.version, '2.4.0');
  assert.equal(r.from, '2.3.0');
  assert.match(r.detail, /answered \/api\/health/);
  assert.equal(readPending(dataDir), null);
});

test('confirmBoot: 503 или сеть недоступна — не подтверждено, pending остаётся, успеха нет', async () => {
  const { dataDir } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  assert.equal(await confirmBoot(dataDir, { runningVersion: '2.4.0', healthUrl: 'http://x', fetchImpl: async () => ({ status: 503 }) }), false);
  assert.equal(await confirmBoot(dataDir, { runningVersion: '2.4.0', healthUrl: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
  assert.equal(result(dataDir), null);
  assert.ok(readPending(dataDir));
});

test('confirmBoot: pending на другую версию эта версия не подтверждает', async () => {
  const { dataDir } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  assert.equal(await confirmBoot(dataDir, { runningVersion: '2.3.0', healthUrl: 'http://x', fetchImpl: ok200 }), false);
});

test('reconcile: запустилась прежняя версия при непогашенном pending — ok:false и согласие снято', () => {
  const { dataDir, db } = workspace();
  setConsent(db, '2.4.0');
  writePending(dataDir, { version: '2.4.0', from: '2.3.0', backup: 'pre-2.4.0.db' });
  assert.equal(reconcileUpdateAtBoot(db, dataDir, { runningVersion: '2.3.0' }), 'rolled_back');
  const r = result(dataDir);
  assert.equal(r.ok, false);
  assert.equal(r.version, '2.4.0');
  assert.match(r.detail, /never confirmed/);
  assert.equal(readPending(dataDir), null);
  assert.equal(consent(db), undefined, 'та же версия не поставится снова этой же ночью');
});

test('reconcile: pending на ЭТУ версию — ждём подтверждения, ничего не пишем', () => {
  const { dataDir, db } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  assert.equal(reconcileUpdateAtBoot(db, dataDir, { runningVersion: '2.4.0' }), 'awaiting');
  assert.equal(result(dataDir), null);
});

test('reconcile: отметка отката снимает согласие только на откаченную версию', () => {
  const { dataDir, db } = workspace();
  setConsent(db, '2.5.0');
  fs.writeFileSync(path.join(dataDir, ROLLED_BACK_NAME), JSON.stringify({ version: '2.4.0', to: '2.3.0' }));
  reconcileUpdateAtBoot(db, dataDir, { runningVersion: '2.3.0' });
  assert.ok(consent(db), 'согласие на ДРУГУЮ версию не трогаем');
  assert.equal(fs.existsSync(path.join(dataDir, ROLLED_BACK_NAME)), false);

  fs.writeFileSync(path.join(dataDir, ROLLED_BACK_NAME), JSON.stringify({ version: '2.5.0', to: '2.3.0' }));
  reconcileUpdateAtBoot(db, dataDir, { runningVersion: '2.3.0' });
  assert.equal(consent(db), undefined);
});

test('armBootConfirmation: пробует health, пока не ответит', async () => {
  const { dataDir, db } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  let calls = 0;
  const { state, done } = armBootConfirmation(db, dataDir, {
    runningVersion: '2.4.0', port: 1, delayMs: 1, intervalMs: 1,
    fetchImpl: async (url) => { calls++; assert.equal(url, 'http://127.0.0.1:1/api/health'); return { status: calls < 3 ? 503 : 200 }; },
  });
  assert.equal(state, 'awaiting');
  assert.equal(await done, true);
  assert.equal(calls, 3);
  assert.equal(result(dataDir).ok, true);
});

test('scheduleUpdater при запуске подтверждает новую версию', async (t) => {
  const { dataDir, db } = workspace();
  writePending(dataDir, { version: '9.9.9', from: '9.9.8' });
  const handle = scheduleUpdater(db, dataDir, {
    runningVersion: '9.9.9', intervalMs: 3_600_000, exitImpl: () => {},
    bootConfirm: { delayMs: 1, intervalMs: 1, fetchImpl: ok200 },
  });
  t.after(() => clearInterval(handle.interval));
  for (let i = 0; i < 50 && !result(dataDir); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(result(dataDir).ok, true);
});

test('applyUpdate: отказ до переключения не оставляет pending (иначе запуск счёл бы это падением)', async () => {
  const root = tmpDir('em-bootconf-apply-');
  for (const v of ['0.1.3', '0.1.4']) {
    fs.mkdirSync(path.join(root, 'versions', v, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', v, 'server', 'index.js'), '//\n');
  }
  fs.symlinkSync(path.join(root, 'versions', '0.1.3'), path.join(root, 'current'), LINK);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const db = closeOnExit(openDb(path.join(dataDir, 'easymed.db')));
  migrate(db);
  const res = await applyUpdate(db, dataDir, {
    root, version: '0.1.4', exitImpl: () => {},
    symlinkSync: (target, link, type) => {
      if (target.endsWith('0.1.4')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.symlinkSync(target, link, type);
    },
  });
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(dataDir, PENDING_NAME)), false);
  assert.equal(result(dataDir).ok, false);
});

test('syncRecoverCmd: кладёт в корень recover.cmd запущенной версии, если он отличается', () => {
  const root = tmpDir('em-bootconf-sync-');
  const app = path.join(root, 'versions', '2.4.0');
  fs.mkdirSync(path.join(app, 'install'), { recursive: true });
  fs.writeFileSync(path.join(app, 'install', 'recover.cmd'), 'NEW');
  fs.symlinkSync(app, path.join(root, 'current'), LINK);
  fs.writeFileSync(path.join(root, 'recover.cmd'), 'OLD');
  assert.equal(syncRecoverCmd(app), true);
  assert.equal(fs.readFileSync(path.join(root, 'recover.cmd'), 'utf8'), 'NEW');
  assert.equal(syncRecoverCmd(app), false, 'тот же файл второй раз не переписываем');
  // Не версионная раскладка (папка разработчика) — ничего.
  assert.equal(syncRecoverCmd(tmpDir('em-bootconf-dev-')), false);
});

// V3120_FINAL — подтверждение БЕЗ fetch к собственному порту. Порт клиники
// закреплён port.txt, и если он в «плохом» списке fetch (6000, 6665–6669,
// 10080, 5060…), fetch отказывает всегда: версия не подтверждалась, а позже
// первый же сбой откатывал её вместе с базой. Теперь проверка — внутри
// процесса: сервер слушает + база отвечает на SELECT 1.
test('armBootConfirmation с server: подтверждает на «плохом» для fetch порту, fetch не зовётся', async () => {
  const { dataDir, db } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  let fetched = false;
  const server = { listening: true };
  const { done } = armBootConfirmation(db, dataDir, {
    runningVersion: '2.4.0', port: 6666, delayMs: 1, intervalMs: 1, server,
    fetchImpl: async () => { fetched = true; throw new TypeError('fetch failed: bad port'); },
  });
  assert.equal(await done, true);
  assert.equal(fetched, false);
  assert.equal(result(dataDir).ok, true);
});

test('armBootConfirmation с server: не слушает или база мертва — не подтверждено', async () => {
  const { dataDir, db } = workspace();
  writePending(dataDir, { version: '2.4.0', from: '2.3.0' });
  const server = { listening: false };
  const { done } = armBootConfirmation(db, dataDir, { runningVersion: '2.4.0', delayMs: 1, intervalMs: 1, maxTries: 3, server });
  assert.equal(await done, false);
  assert.ok(readPending(dataDir), 'pending остаётся');

  const w2 = workspace();
  writePending(w2.dataDir, { version: '2.4.0', from: '2.3.0' });
  const deadDb = { prepare: () => { throw new Error('SQLITE_IOERR'); } };
  const r2 = armBootConfirmation(w2.db, w2.dataDir, { runningVersion: '2.4.0', delayMs: 1, intervalMs: 1, maxTries: 2, server: { listening: true }, probeDb: deadDb });
  assert.equal(await r2.done, false);
});
