// TELEGRAM_BOT_V1 — фоновый опросник Telegram, живущий внутри сервера.
//
// Почему внутри, а не отдельным процессом: у клиники на компьютере регистратуры
// должен быть ОДИН `npm start`. Прежняя версия этой функции держала два
// процесса — TelegramBot.exe и рендерер на :5003 — и любой из них мог тихо
// оказаться незапущенным, что и было главной эксплуатационной болью.
//
// Расплата за это — обязательство никогда не уронить сервер: цикл опроса ловит
// АБСОЛЮТНО все ошибки. Недоступный Telegram, битый токен, сбой Chrome — всё
// это записывается в лог и приводит к повторной попытке, но не всплывает
// наружу и не может помешать регистратуре работать.

import { getUpdates, TelegramError } from './api.js';
import { getDecryptedToken } from './settings.js';
import { handleUpdate } from './flow.js';
import { runPushScan } from './push.js';

const OFFSET_KEY = 'updates_offset';
const POLL_TIMEOUT = 25;          // секунд держим длинный опрос
const IDLE_RECHECK_MS = 5000;     // как часто перечитывать «включён ли бот»
                                  // (обычно не ждём: настройки будят цикл сами)
const PUSH_INTERVAL_MS = 30000;   // как часто искать готовые документы

let running = false;
let stopping = false;
let currentAbort = null;

function readState(db, key, dflt = '') {
  const r = db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function writeState(db, key, value) {
  db.prepare(`INSERT INTO telegram_state (key, value, updated_at)
              VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

function botConfig(db) {
  const row = db.prepare('SELECT enabled FROM telegram_settings WHERE id = 1').get();
  if (!row || !row.enabled) return null;
  let token = '';
  try { token = getDecryptedToken(db); } catch (e) {
    console.warn('[telegram] token unreadable:', e.message);
    return null;
  }
  return token ? { token } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.() ?? setTimeout(r, ms));

// Прерываемое ожидание.
//
// Пока бот выключен, цикл спит. Без возможности разбудить его администратор
// сохранил бы токен и сидел, глядя на молчащего бота, до конца паузы — и
// решил бы, что нужно перезапускать сервер. Настройки будят цикл сразу.
let wakeIdle = null;
function idleSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakeIdle = null; resolve(); }, ms);
    if (t.unref) t.unref();
    wakeIdle = () => { clearTimeout(t); wakeIdle = null; resolve(); };
  });
}

// Вызывается из раздела настроек сразу после сохранения токена: бот начинает
// отвечать пациентам за секунды, а не после перезапуска сервера.
export function wakeTelegramBot() {
  if (wakeIdle) wakeIdle();
}

export function isRunning() { return running; }

// Запуск. Возвращается сразу — цикл живёт сам по себе.
export function startTelegramBot(db, { pollTimeout = POLL_TIMEOUT } = {}) {
  if (running) return;
  running = true;
  stopping = false;
  loop(db, pollTimeout).catch((e) => {
    // Сюда попасть нельзя: loop() ловит всё сам. Если всё же попали — это
    // ошибка в самом опроснике, и сервер обязан продолжить работу без бота.
    console.error('[telegram] poller stopped by an uncaught error:', e && e.stack || e);
    running = false;
  });
  console.log('[telegram] poller started');
}

export async function stopTelegramBot() {
  stopping = true;
  if (currentAbort) { try { currentAbort.abort(); } catch { /* уже завершён */ } }
  running = false;
}

async function loop(db, pollTimeout) {
  let backoff = 1000;
  let lastPush = 0;

  while (!stopping) {
    const cfg = botConfig(db);
    if (!cfg) {
      // Бот выключен в настройках — это не ошибка, просто ждём. Сохранение
      // токена в настройках прерывает это ожидание немедленно.
      await idleSleep(IDLE_RECHECK_MS);
      continue;
    }

    // Рассылка готовых документов идёт в том же цикле: отдельный таймер мог бы
    // выстрелить, пока опрос держит соединение, и два потока писали бы в одну
    // очередь одновременно.
    if (Date.now() - lastPush > PUSH_INTERVAL_MS) {
      lastPush = Date.now();
      try { await runPushScan(db, cfg.token); }
      catch (e) { console.warn('[telegram] push scan:', (e && e.message) || e); }
    }

    try {
      const offset = Number(readState(db, OFFSET_KEY, '0')) || 0;
      const updates = await getUpdates(cfg.token, { offset, timeout: pollTimeout });
      backoff = 1000;

      for (const u of updates) {
        // Сдвигаем offset ДО обработки: обновление, на котором мы падаем, не
        // должно повторяться вечно и блокировать всю очередь.
        writeState(db, OFFSET_KEY, u.update_id + 1);
        try {
          await handleUpdate(db, cfg.token, u);
        } catch (e) {
          console.warn('[telegram] update', u.update_id, 'not handled:', (e && e.message) || e);
        }
      }
    } catch (e) {
      // 401 — токен отозвали. Долбиться в Telegram раз в секунду бессмысленно и
      // выглядит как злоупотребление, поэтому ждём дольше.
      const unauthorized = e instanceof TelegramError && e.status === 401;
      console.warn('[telegram] poll:', (e && e.message) || e);
      await sleep(unauthorized ? 60000 : backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  running = false;
  console.log('[telegram] poller stopped');
}
