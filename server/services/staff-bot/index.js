// STAFF_ATTENDANCE_V1 — поллер бота сотрудников (EasyMed Staff).
//
// Зеркало doctor-bot/index.js: длинный опрос getUpdates, а не webhook. Сервер
// клиники стоит во внутренней сети и снаружи не виден — webhook потребовал бы
// открыть его в интернет. Опрос ходит только НАРУЖУ, к api.telegram.org, и
// работает за любым NAT. Интернет нужен только боту; без него отметки не
// приходят, а остальная программа работает как прежде.
import { getUpdates, TelegramError } from '../telegram/api.js';
import { botIdOfToken } from '../doctor-bot/settings.js';
import { getDecryptedToken, clashMessage } from './settings.js';
import { handleUpdate } from './flow.js';

const OFFSET_KEY = 'updates_offset';
const POLL_TIMEOUT = 25;
const IDLE_RECHECK_MS = 5000;

let running = false;
let stopping = false;
let wakeIdle = null;
let clashWarned = false;

function readState(db, key, dflt = '') {
  const r = db.prepare('SELECT value FROM staff_bot_state WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function writeState(db, key, value) {
  db.prepare(`INSERT INTO staff_bot_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value));
}

export function botConfig(db) {
  let row;
  try { row = db.prepare('SELECT enabled FROM staff_bot_settings WHERE id = 1').get(); }
  catch { return null; }   // сборка без миграции 304
  if (!row || !row.enabled) return null;
  let token = '';
  try { token = getDecryptedToken(db); } catch (e) { console.warn('[staff-bot] token unreadable:', e.message); return null; }
  if (!token) return null;
  // Токен другого бота клиники (сохранён в его настройках после нашего) — не
  // опрашиваем: два поллера одного токена отнимают друг у друга сообщения.
  if (clashMessage(db, botIdOfToken(token))) {
    if (!clashWarned) { clashWarned = true; console.warn('[staff-bot] token belongs to another clinic bot — staff bot not polling'); }
    return null;
  }
  clashWarned = false;
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

export function wakeStaffBot() { if (wakeIdle) wakeIdle(); }
export function isStaffBotRunning() { return running; }

export function startStaffBot(db, { pollTimeout = POLL_TIMEOUT } = {}) {
  if (running) return;
  running = true;
  stopping = false;
  loop(db, pollTimeout).catch((e) => {
    console.error('[staff-bot] poller stopped by an uncaught error:', (e && e.stack) || e);
    running = false;
  });
  console.log('[staff-bot] poller started');
}

export async function stopStaffBot() {
  stopping = true;
  running = false;
  wakeStaffBot();
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
        catch (e) { console.warn('[staff-bot] update', u.update_id, 'not handled:', (e && e.message) || e); }
      }
    } catch (e) {
      const unauthorized = e instanceof TelegramError && e.status === 401;
      console.warn('[staff-bot] poll:', (e && e.message) || e);
      await sleep(unauthorized ? 60000 : backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  running = false;
}
