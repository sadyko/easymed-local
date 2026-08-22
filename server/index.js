import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { backupBeforeMigrate, pruneBackups } from './db/backup.js';   // SUPERVISED_INSTALL_V1
import { bootstrapAdmin } from './services/auth.js';
import { autoCloseStaleShifts } from './services/rpc/cashier.js';   // SHIFT_AUTOCLOSE_V1
import { startTelegramBot } from './services/telegram/index.js';   // TELEGRAM_BOT_V1
import { createApp } from './app.js';
import { setDataDir } from './services/control/config.js';   // SUPERVISED_INSTALL_V1
import { scheduleCheckin } from './services/control/checkin.js';   // LICENCE_CORE_V1
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
      try {
        pruneBackups(path.join(DATA_DIR, 'backups'), 3);
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

  // DEV_KEY_FINGERPRINT — refuse to let a development signing key reach a clinic
  // unnoticed. The placeholder key that ships in licence.js by default cannot verify
  // anything (its private half was discarded), so a dev machine installs a throwaway
  // key just to be usable. That key must never leave this machine: anyone holding its
  // private half could license themselves.
  //
  // This is a loud warning rather than a hard refusal because refusing to boot would
  // brick the developer's own instance, which is the only place the key is legitimate.
  const DEV_KEY_FINGERPRINT = 'd81d431a2ddf105e';
  try {
    const src = fs.readFileSync(path.join(ROOT, 'server/services/control/licence.js'), 'utf8');
    const pem = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
    if (pem && createHash('sha256').update(pem[0]).digest('hex').startsWith(DEV_KEY_FINGERPRINT)) {
      console.warn('');
      console.warn('  ###################################################################');
      console.warn('  ##  WARNING: this build carries the DEVELOPMENT licence key.     ##');
      console.warn('  ##  Do NOT install it at a clinic. Generate a real key with       ##');
      console.warn('  ##  `node scripts/make-licence.mjs keygen` and replace the        ##');
      console.warn('  ##  public half in server/services/control/licence.js first.      ##');
      console.warn('  ###################################################################');
      console.warn('');
    }
  } catch { /* the check must never stop the server starting */ }

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
      console.log('  Log in and change this password.');
    }
  });

  // Without this, double-starting on Windows prints a success banner and then
  // dies silently — an operator double-clicking the start script twice would
  // never know. Fail loudly with a plain-language message instead.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`Easy-Med could not start: port ${PORT} is already in use.`);
      console.error('Easy-Med is probably already running on this PC - check for');
      console.error('an open Easy-Med window before starting it again.');
      process.exit(1);
    }
    throw err;
  });

  // LICENCE_CORE_V1 — the daily call home. Placed after listen() is called,
  // never awaited: scheduleCheckin only arms two unref()'d timers (first
  // fires ~60s from now, then every 24h) and returns immediately, so a dead
  // or slow control plane can never be the reason a clinic's own server is
  // slow to start or fails to bind its port.
  scheduleCheckin(db, DATA_DIR);
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
