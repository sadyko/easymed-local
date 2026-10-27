// REFERRALS_CRM_V1 (2026-10-26) — поллер Telegram-бота для врачей-источников.
//
// Зеркало telegram/index.js (пациентский бот), только таблицы свои:
// doctor_bot_settings (включён ли, токен), doctor_bot_state (смещение
// getUpdates). Два бота — два поллера с разными токенами; общий у них только
// клиент Bot API. Запускается из server/index.js рядом с пациентским.
import { getUpdates, TelegramError } from '../telegram/api.js';
import { getDecryptedToken } from './settings.js';
import { handleUpdate } from './flow.js';
import { runNotifyScan } from './notify.js';

const OFFSET_KEY = 'updates_offset';
const POLL_TIMEOUT = 25;           // секунд держим длинный опрос
const IDLE_RECHECK_MS = 5000;      // как часто перечитывать «включён ли бот»
const NOTIFY_INTERVAL_MS = 30000;  // как часто искать пришедших пациентов

let running = false;
let stopping = false;
let wakeIdle = null;

function readState(db, key, dflt = '') {
  const r = db.prepare('SELECT value FROM doctor_bot_state WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function writeState(db, key, value) {
  db.prepare(`INSERT INTO doctor_bot_state (key, value, updated_at)
              VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

export function botConfig(db) {
  let row;
  try { row = db.prepare('SELECT enabled FROM doctor_bot_settings WHERE id = 1').get(); }
  catch { return null; }   // сборка без миграции 253 — бота нет
  if (!row || !row.enabled) return null;
  let token = '';
  try { token = getDecryptedToken(db); } catch (e) {
    console.warn('[doctor-bot] token unreadable:', e.message);
    return null;
  }
  return token ? { token } : null;
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
function idleSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakeIdle = null; resolve(); }, ms);
    if (t.unref) t.unref();
    wakeIdle = () => { clearTimeout(t); wakeIdle = null; resolve(); };
  });
}

export function wakeDoctorBot() { if (wakeIdle) wakeIdle(); }
export function isDoctorBotRunning() { return running; }

export function startDoctorBot(db, { pollTimeout = POLL_TIMEOUT } = {}) {
  if (running) return;
  running = true;
  stopping = false;
  loop(db, pollTimeout).catch((e) => {
    console.error('[doctor-bot] poller stopped by an uncaught error:', (e && e.stack) || e);
    running = false;
  });
  console.log('[doctor-bot] poller started');
}

export async function stopDoctorBot() {
  stopping = true;
  running = false;
  wakeDoctorBot();
}

async function loop(db, pollTimeout) {
  let backoff = 1000;
  let lastNotify = 0;
  while (!stopping) {
    const cfg = botConfig(db);
    if (!cfg) { await idleSleep(IDLE_RECHECK_MS); continue; }

    if (Date.now() - lastNotify > NOTIFY_INTERVAL_MS) {
      lastNotify = Date.now();
      try { await runNotifyScan(db, cfg.token); }
      catch (e) { console.warn('[doctor-bot] notify scan:', (e && e.message) || e); }
    }

    try {
      const offset = Number(readState(db, OFFSET_KEY, '0')) || 0;
      const updates = await getUpdates(cfg.token, { offset, timeout: pollTimeout });
      backoff = 1000;
      for (const u of updates) {
        writeState(db, OFFSET_KEY, u.update_id + 1);
        try { await handleUpdate(db, cfg.token, u); }
        catch (e) { console.warn('[doctor-bot] update', u.update_id, 'not handled:', (e && e.message) || e); }
      }
    } catch (e) {
      const unauthorized = e instanceof TelegramError && e.status === 401;
      console.warn('[doctor-bot] poll:', (e && e.message) || e);
      await sleep(unauthorized ? 60000 : backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  running = false;
}
