// REP_BOT_V1 (2026-10-30) — поллер Telegram-бота для медпредставителей.
//
// Зеркало doctor-bot/index.js без уведомлений: бот только отвечает. Свои
// таблицы (rep_bot_settings, rep_bot_state), свой токен. Запускается из
// server/index.js рядом с двумя другими ботами.
import { getUpdates, TelegramError } from '../telegram/api.js';
import { botIdOfToken } from '../doctor-bot/settings.js';
import { getDecryptedToken, clashMessage } from './settings.js';
import { handleUpdate } from './flow.js';

const OFFSET_KEY = 'updates_offset';
const POLL_TIMEOUT = 25;           // секунд держим длинный опрос
const IDLE_RECHECK_MS = 5000;      // как часто перечитывать «включён ли бот»

let running = false;
let stopping = false;
let wakeIdle = null;
let samebotWarned = false;

function readState(db, key, dflt = '') {
  const r = db.prepare('SELECT value FROM rep_bot_state WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function writeState(db, key, value) {
  db.prepare(`INSERT INTO rep_bot_state (key, value, updated_at)
              VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

export function botConfig(db) {
  let row;
  try { row = db.prepare('SELECT enabled FROM rep_bot_settings WHERE id = 1').get(); }
  catch { return null; }   // сборка без миграции 260 — бота нет
  if (!row || !row.enabled) return null;
  let token = '';
  try { token = getDecryptedToken(db); } catch (e) {
    console.warn('[rep-bot] token unreadable:', e.message);
    return null;
  }
  if (!token) return null;
  // Токен другого бота клиники: второй поллер отнимал бы у него сообщения (409).
  if (clashMessage(db, botIdOfToken(token))) {
    if (!samebotWarned) { samebotWarned = true; console.warn('[rep-bot] token belongs to another clinic bot — rep bot not polling'); }
    return null;
  }
  samebotWarned = false;
  return { token };
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
function idleSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakeIdle = null; resolve(); }, ms);
    if (t.unref) t.unref();
    wakeIdle = () => { clearTimeout(t); wakeIdle = null; resolve(); };
  });
}

export function wakeRepBot() { if (wakeIdle) wakeIdle(); }
export function isRepBotRunning() { return running; }

export function startRepBot(db, { pollTimeout = POLL_TIMEOUT } = {}) {
  if (running) return;
  running = true;
  stopping = false;
  loop(db, pollTimeout).catch((e) => {
    console.error('[rep-bot] poller stopped by an uncaught error:', (e && e.stack) || e);
    running = false;
  });
  console.log('[rep-bot] poller started');
}

export async function stopRepBot() {
  stopping = true;
  running = false;
  wakeRepBot();
}

async function loop(db, pollTimeout) {
  let backoff = 1000;
  while (!stopping) {
    const cfg = botConfig(db);
    if (!cfg) { await idleSleep(IDLE_RECHECK_MS); continue; }
    try {
      const offset = Number(readState(db, OFFSET_KEY, '0')) || 0;
      const updates = await getUpdates(cfg.token, { offset, timeout: pollTimeout });
      backoff = 1000;
      for (const u of updates) {
        writeState(db, OFFSET_KEY, u.update_id + 1);
        try { await handleUpdate(db, cfg.token, u); }
        catch (e) { console.warn('[rep-bot] update', u.update_id, 'not handled:', (e && e.message) || e); }
      }
    } catch (e) {
      const unauthorized = e instanceof TelegramError && e.status === 401;
      console.warn('[rep-bot] poll:', (e && e.message) || e);
      await sleep(unauthorized ? 60000 : backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  running = false;
}
