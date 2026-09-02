import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { backupBeforeMigrate } from './db/backup.js';   // SUPERVISED_INSTALL_V1
import { processPendingAction, pruneBackupsByKind, scheduleDailyBackups } from './services/backup.js';   // SYSTEM_SETTINGS_V1
import { bootstrapAdmin } from './services/auth.js';
import { autoCloseStaleShifts } from './services/rpc/cashier.js';   // SHIFT_AUTOCLOSE_V1
import { startTelegramBot } from './services/telegram/index.js';   // TELEGRAM_BOT_V1
import { schedulePolling } from './services/telephony/poller.js';   // TELEPHONY_V1
import { createApp } from './app.js';
import { setDataDir, setAppVersion } from './services/control/config.js';   // SUPERVISED_INSTALL_V1 / UPDATE_DELIVERY_V1
import { scheduleCheckin } from './services/control/checkin.js';   // LICENCE_CORE_V1
import { scheduleUpdater } from './services/control/updater.js';   // UPDATE_DELIVERY_V1
import { scheduleRelayPublish } from './services/branch-sync/relay.js';   // BRANCH_SYNC_RELAY_V1
import { scheduleBranchPull } from './services/branch-sync/schedule-pull.js';   // BRANCH_SYNC_HOURLY_V1
import { readPairing } from './services/branch-sync/pairing.js';
import { runBranchSync } from './services/rpc/branch-sync.js';
import { recordEvent, pruneOpsEvents } from './services/ops-log.js';   // OPS_EVENTS_V1

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// SUPERVISED_INSTALL_V1 — where the clinic's data lives.
//
// It must be settable from outside because the application directory is about to
// become versioned: C:\EasyMed\versions\2.4.0\ gets replaced wholesale by an
// update, and anything inside it is thrown away with the old version. The
// database, the licence and uploaded files have to sit somewhere an update never
// touches.
//
// A relative value resolves against ROOT rather than the working directory. A
// Windows service starts with cwd = C:\Windows\system32; resolving there would
// quietly create a second, empty database, and the clinic would open the app to
// an empty patient list while their real records sat on disk, unreferenced.
export function resolveDataDir(env = process.env, root = ROOT, { mkdir = false } = {}) {
  const raw = String(env.EASYMED_DATA_DIR || '').trim();
  const dir = raw ? path.resolve(root, raw) : path.join(root, 'data');
  if (mkdir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // A bare ENOTDIR/EEXIST from mkdirSync names the path but not the setting
      // that put it there. On a headless Windows service this exception reaches
      // a log file, not a console — a clinic manager who mistyped EASYMED_DATA_DIR
      // into the service config needs the setting named to know what to fix.
      throw new Error(`EASYMED_DATA_DIR ("${dir}") could not be created: ${e.message}`);
    }
  }
  return dir;
}

const DATA_DIR = resolveDataDir(process.env, ROOT, { mkdir: true });

// SUPERVISED_INSTALL_V1 — published immediately, not later inside createApp().
//
// startTelegramBot() runs at boot, well before createApp() is called, and the
// Telegram modules read the data directory from this same config. Publishing it
// only in createApp() meant the bot started with the DEFAULT path while the rest
// of the app used the configured one — so on a service install with
// EASYMED_DATA_DIR set, patient documents sent over Telegram were written inside
// the versioned application folder, which an update deletes wholesale.
setDataDir(DATA_DIR);

// SUPERVISED_INSTALL_V1 — the version stamped into a pre-migration backup's
// filename (see db/backup.js). Read straight from package.json rather than
// imported, and defaulted rather than thrown, because a version tag that can't
// be read is not worth failing boot over — the backup itself still protects
// the database either way, it just gets a '0.0.0' label instead of '2.4.0'.
function readAppVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const APP_VERSION = readAppVersion(ROOT);
// UPDATE_DELIVERY_V1 — published so update_status (rpc/updates.js) can report
// current_version; see config.js's own comment for why that file reads it
// back through getAppVersion() rather than this module importing it back.
setAppVersion(APP_VERSION);

// SUPERVISED_INSTALL_V1 — importing this file must not have side effects.
//
// server/index.datadir.test.js needs to import resolveDataDir from this module
// without booting a server: before this guard, ANY import of index.js ran the
// whole boot sequence below — opened the real data/easymed.db, started the
// Telegram poller against the clinic's live bot token, and tried to listen on
// :8000, which the already-running dev instance holds, so the EADDRINUSE
// handler further down would call process.exit(1) and kill the test process
// mid-run. `node server/index.js` (npm start, and later the Windows service)
// makes this file the process entry point; `import './index.js'` from a test
// does not. That distinction is what isMain checks.
// Compared as REAL paths, and that is not fussiness — it is the difference
// between the clinic's service booting and silently not booting.
//
// Under the supervised install the service runs
// C:\EasyMed\current\server\index.js, where `current` is a junction to
// versions\<v>\. Node's ESM loader resolves import.meta.url THROUGH the
// junction to the real versions\<v>\ path, while argv[1] stays exactly as
// typed. A plain string comparison therefore fails, isMain is false, and node
// exits with code 0, no output and no error: the service appears to start and
// never runs. Reproduced directly before this line was written.
//
// realpathSync resolves the junction on both sides, so they agree whether or not
// --preserve-symlinks-main was passed. The launcher passes it too, but a guard
// that depends on someone remembering a flag is not a guard.
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1]
  && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));

if (isMain) {
  // SYSTEM_SETTINGS_V1 — a restore or factory reset the admin requested from
  // the settings screen is applied HERE, before openDb: Windows will not
  // rename a file this process already holds open, so "before the first
  // handle exists" is the mechanism, not just an ordering preference.
  // processPendingAction never throws — a marker it cannot act on is set
  // aside as .bad and the clinic boots on whatever database it has.
  const pending = processPendingAction(DATA_DIR);
  if (pending.action === 'restore') console.log(`  Restored database from backup: ${pending.backup}`);
  if (pending.action === 'factory_reset') console.log('  Factory reset applied — this is now a fresh install.');

  const db = openDb(path.join(DATA_DIR, 'easymed.db'));
  // SHIFT_AUTOCLOSE_V1 — кассовые смены живут до конца дня (00:00): закрываем
  // просроченные при старте и раз в час (перекрывает полночь, пока сервер жив;
  // если сервер был выключен — закрытие догонит при старте или первом RPC).
  setTimeout(() => { try { autoCloseStaleShifts(db); } catch (e) { console.warn('[shift-autoclose]', e.message); } }, 3000);
  setInterval(() => { try { autoCloseStaleShifts(db); } catch (e) { console.warn('[shift-autoclose]', e.message); } }, 60 * 60 * 1000);

  // SUPERVISED_INSTALL_V1 — back up before touching the schema, and only then.
  //
  // Guarded on there being unapplied migrations so an ordinary restart does not
  // copy a multi-MB database every time the clinic reboots its PC — only an
  // update, which is the one moment a rollback point is actually needed.
  //
  // Top-level await IS legal here even though this sits inside `if (isMain) {`:
  // a block statement (if/for/try/...) does not open a new function scope, so
  // code inside it is still the module's top-level code as far as the "await
  // only works at the top level" rule is concerned — verified directly against
  // this Node version before relying on it, rather than assumed. What top-level
  // await cannot do is cross into a nested function body (e.g. an arrow
  // passed to .then or setTimeout); nothing here does that.
  try {
    if (pendingMigrations(db).length) {
      const out = await backupBeforeMigrate(db, path.join(DATA_DIR, 'easymed.db'), APP_VERSION);
      console.log(`  Database backed up before update: ${out}`);
      // Its OWN try/catch, deliberately separate from the one below. Pruning
      // old backups is disk hygiene, not correctness, and it runs AFTER the
      // line above already told the operator the backup succeeded — a
      // failure here must never be reported as "no rollback point exists"
      // when one plainly does, sitting right there on disk.
      //
      // SYSTEM_SETTINGS_V1 — kind-aware since the daily/manual backups
      // arrived: the old pruneBackups(dir, 3) counted ALL .db files against
      // one limit of three, so fourteen daily copies would have evicted every
      // pre-update rollback point (and vice versa) the day this shipped.
      try {
        pruneBackupsByKind(path.join(DATA_DIR, 'backups'));
      } catch (e) {
        console.warn('[backup] could not prune old backups (the new backup is fine):', e.message);
      }
    }
  } catch (e) {
    // A clinic must not be unable to start because a backup could not be
    // written — a clinic that cannot open at all is worse than one that
    // migrates unprotected for one run. But it must be LOUD: the next
    // migrate() below is now unprotected, and silence here is how a future
    // "just restore the backup" support call discovers there isn't one.
    console.error('[backup] FAILED — migrations will run WITHOUT a rollback point:', e.message);
  }

  migrate(db);
  const firstRunPassword = bootstrapAdmin(db);

  // Expired sessions: prune at startup, then hourly. unref() so the timer
  // never blocks shutdown.
  const pruneSessions = () =>
    db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')").run();
  pruneSessions();
  setInterval(pruneSessions, 3600 * 1000).unref();

  // OPS_EVENTS_V1 — same prune-at-startup-then-hourly shape as sessions just
  // above. Bounds the table against a clinic whose integration is stuck
  // hammering 500s or retrying a doomed login between restarts.
  pruneOpsEvents(db);
  setInterval(() => pruneOpsEvents(db), 3600 * 1000).unref();

  // TELEGRAM_BOT_V1 — опросник Telegram живёт внутри этого же процесса, чтобы у
  // клиники был один `npm start`. Он сам проверяет, включён ли бот в настройках,
  // и молчит, пока администратор его не включил. Все ошибки цикл ловит внутри:
  // недоступный Telegram не должен мешать регистратуре работать.
  startTelegramBot(db);

  // TELEPHONY_V1 — the Binotel call poller, in this same process for the same
  // one-`npm start` reason as the bot above. Its tick decides for itself
  // whether to do anything (settings enabled + callcenter module granted +
  // credentials saved), so scheduling it unconditionally costs an idle clinic
  // one settings read every 30 seconds and nothing else. unref'd timers —
  // it can never hold a shutdown open.
  schedulePolling(db);

    const PORT = Number(process.env.PORT || 8000);
  const server = createApp(db, { dataDir: DATA_DIR }).listen(PORT, '0.0.0.0', () => {
    // OPS_EVENTS_V1 — recorded here, not earlier: this callback only fires
    // once the port is actually bound, i.e. the clinic really did start (as
    // opposed to migrate()/bootstrapAdmin() completing but EADDRINUSE
    // aborting the process a few lines below before a single request could
    // ever be served).
    recordEvent(db, 'boot');
    console.log('');
    console.log('Easy-Med Local is running.');
    console.log(`  On this PC:      http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  On the network:  http://${ip}:${PORT}`);
    if (firstRunPassword) {
      console.log('');
      console.log('FIRST RUN - admin account created:');
      console.log('  username: admin');
      console.log(`  password: ${firstRunPassword}`);
      console.log('  The app will require a new password at first sign-in.');
    }
  });

  // Without this, double-starting on Windows prints a success banner and then
  // dies silently — an operator double-clicking the start script twice would
  // never know. Fail loudly with a plain-language message instead.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`Easy-Med could not start: port ${PORT} is already in use.`);
      console.error('');
      console.error('Another Easy-Med is still running on this PC.');
      console.error('');
      // The old text here said 'check for an open Easy-Med window', which is a
      // dead end in exactly the case that produces this error most often:
      // CLOSING THE TERMINAL WINDOW DOES NOT STOP THE SERVER. node keeps
      // running, keeps the port, and there is no window left to find. The owner
      // hit this twice, and the second time the only way forward was to ask.
      // A message about a problem has to name the way out of it.
      console.error('Closing the terminal window does NOT stop it - the server');
      console.error('keeps running in the background and keeps holding the port.');
      console.error('');
      console.error('To stop it, run stop-easymed.bat (it sits next to');
      console.error('start-easymed.bat), or paste this into PowerShell:');
      console.error('');
      console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -State Listen |`);
      console.error('    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
      process.exit(1);
    }
    throw err;
  });

  // LICENCE_CORE_V1 — the daily call home. Placed after listen() is called,
  // never awaited: scheduleCheckin only arms two unref()'d timers (first
  // fires ~60s from now, then every 24h — or EASYMED_CHECKIN_INTERVAL_MS on
  // a test install, see checkinIntervalMs) and returns immediately, so a dead
  // or slow control plane can never be the reason a clinic's own server is
  // slow to start or fails to bind its port.
  scheduleCheckin(db, DATA_DIR);

  // UPDATE_DELIVERY_V1 — the minute-granularity timer that notices when the
  // clinic's chosen install hour arrives. tickUpdater is documented never to
  // throw (every failure is "try again tomorrow"), but a timer callback has
  // no caller to hand a rejection to anyway — scheduleUpdater already wraps
  // each tick in its own try/catch (mirroring scheduleCheckin just above) so
  // a bug here can only ever cost a missed update check, never the running
  // clinic. appRoot is passed explicitly as THIS process's own ROOT rather
  // than letting updater.js recompute it from its own module path — the two
  // must never be able to disagree about what "the app directory" is.
  //
  // NODE_NATIVE_UPDATES_V1 — `port` used to be passed too, because
  // apply-update.ps1 health-checked whatever port it was handed, and a
  // pinned-port clinic (port.txt) health-checked on the default 8000 refused
  // every update (found on the owner's own 8712 test clinic 2026-08-23). The
  // apply no longer health-checks anything: it repoints the junction in this
  // process and exits 75. Nothing about updating depends on which port this
  // server bound any more.
  scheduleUpdater(db, DATA_DIR, { appRoot: ROOT });

  // SYSTEM_SETTINGS_V1 — the daily database copy, same shape as the two
  // schedulers above: unref'd timers, every tick self-contained. First tick
  // ~5 minutes after boot on purpose — a clinic PC powered on in the morning
  // and shut down before the first full hour still gets its backup for the day.
  scheduleDailyBackups(db, DATA_DIR);

  // BRANCH_SYNC_RELAY_V1 — the main branch's encrypted catalogue copy on the
  // vendor server, refreshed in the background. Same shape as the schedulers
  // above (unref'd timers, self-contained ticks) and, like them, it decides for
  // itself whether it has anything to do: an install that is not the main
  // branch, or whose owner never enabled the fallback route, returns
  // immediately and touches no network at all.
  //
  // It must be a background job rather than a button, because of which
  // direction the fallback runs: the branch that CANNOT reach the main branch
  // is the one that needs the copy, so the copy has to already be there before
  // it asks. The catalogue is uploaded only when its content hash changed (or
  // the copy is a day old — see relay.js REFRESH_MS, which is about the
  // vendor's retention sweep, not about freshness).
  scheduleRelayPublish(db, DATA_DIR);

  // BRANCH_SYNC_HOURLY_V1 — обратная сторона того же расписания. Главный
  // филиал выкладывал копию по часам и раньше, а ЗАБИРАТЬ её было некому:
  // единственным путём вниз оставалась кнопка администратора. Филиал жил на
  // том справочнике, который кто-то однажды не поленился нажать.
  //
  // Роль проверяется на каждом такте внутри scheduleBranchPull, а не здесь:
  // установку связывают филиалом без перезапуска сервера.
  scheduleBranchPull(db, {
    isSecondary: () => {
      try { return readPairing(DATA_DIR)?.role === 'secondary'; } catch { return false; }
    },
    syncImpl: (database) => runBranchSync(database),
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
