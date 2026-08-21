import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { bootstrapAdmin } from './services/auth.js';
import { autoCloseStaleShifts } from './services/rpc/cashier.js';   // SHIFT_AUTOCLOSE_V1
import { startTelegramBot } from './services/telegram/index.js';   // TELEGRAM_BOT_V1
import { createApp } from './app.js';
import { setDataDir } from './services/control/config.js';   // SUPERVISED_INSTALL_V1

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
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = openDb(path.join(DATA_DIR, 'easymed.db'));
  // SHIFT_AUTOCLOSE_V1 — кассовые смены живут до конца дня (00:00): закрываем
  // просроченные при старте и раз в час (перекрывает полночь, пока сервер жив;
  // если сервер был выключен — закрытие догонит при старте или первом RPC).
  setTimeout(() => { try { autoCloseStaleShifts(db); } catch (e) { console.warn('[shift-autoclose]', e.message); } }, 3000);
  setInterval(() => { try { autoCloseStaleShifts(db); } catch (e) { console.warn('[shift-autoclose]', e.message); } }, 60 * 60 * 1000);
  migrate(db);
  const firstRunPassword = bootstrapAdmin(db);

  // Expired sessions: prune at startup, then hourly. unref() so the timer
  // never blocks shutdown.
  const pruneSessions = () =>
    db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')").run();
  pruneSessions();
  setInterval(pruneSessions, 3600 * 1000).unref();

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
