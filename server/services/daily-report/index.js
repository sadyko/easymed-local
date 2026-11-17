// DAILY_REPORT_BOT_V1 (2026-11-13) — расписание и отправка отчёта в группу.
//
// Раз в минуту сервер смотрит: включено ли, задан ли токен и группа, настало ли
// время (местное время клиники, 'HH:MM') и не ушёл ли уже отчёт сегодня. Отметка
// «сегодня отправлено» (last_sent_day) — в базе, а не в памяти: перезапуск
// сервера после 21:00 не шлёт отчёт второй раз. Сбой (нет интернета, бота убрали
// из группы) — текст ошибки на экран настроек и новая попытка через 10 минут,
// а не каждую минуту.
//
// Сервер был выключен в момент отправки — отчёт уйдёт, когда он поднимется в тот
// же день: «время настало» — это «уже не раньше», а не «ровно в эту минуту».
import { sendMessage, TelegramError } from '../telegram/api.js';
import { today } from '../domain/day.js';
import { readSettingsRow, getDecryptedToken, recordAttempt, sectionsOf } from './settings.js';
import { buildReport, reportDay } from './report.js';

const TICK_MS = 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/** Местное время клиники 'HH:MM' — тем же 'localtime', что today(). */
export function localHm(db) {
  return db.prepare("SELECT strftime('%H:%M','now','localtime') t").get().t;
}

/**
 * Пора ли слать по расписанию. Чистая функция: row — строка настроек,
 * now — { day, hm, ms }. Токен проверяет вызывающий (он зашифрован).
 */
export function isDue(row, now) {
  if (!row || !row.enabled || !row.bot_token_enc || !row.chat_id) return false;
  if (now.hm < (row.send_time || '21:00')) return false;
  if (row.last_sent_day === now.day) return false;
  const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN;
  if (!Number.isNaN(last) && now.ms - last < RETRY_MS) return false;
  return true;
}

/**
 * Включили или сменили время, когда сегодняшнее время отправки уже прошло:
 * первый отчёт — в следующий раз по расписанию, а не прямо сейчас. Иначе
 * настройка бота (сохранить, поправить время) сама слала бы отчёт в группу
 * совета директоров. Проверить сразу — кнопка «Отправить сейчас».
 */
export function armForNextRun(db) {
  const row = readSettingsRow(db);
  if (!row || !row.enabled) return;
  const day = today(db);
  if (localHm(db) >= row.send_time && row.last_sent_day !== day) {
    db.prepare('UPDATE daily_report_settings SET last_sent_day = ? WHERE id = 1').run(day);
  }
}

// DAILY_REPORT_FAIL_V1 (2026-11-17) — ЛЮБОЙ СБОЙ — ЭТО ПОПЫТКА, И ОТПРАВКА ОДНА ЗА РАЗ.
//
// buildReport стоял вне try: сбой сводки руководителя (её запрос — самый тяжёлый
// в отчёте) не записывал попытку, tick глотал ошибку, isDue оставался true — и
// тяжёлый запрос повторялся каждую минуту до полуночи; на экране настроек ни
// слова, «Отправить сейчас» отвечал 500. Теперь сбой сборки или отправки пишет
// last_attempt_at и last_error (дальше — обычная пауза 10 минут, isDue), а
// «Отправить сейчас» получает ответ { ok: false, error } словами.
//
// Флаг running берёг только tick от второго tick. «Отправить сейчас» в ту же
// минуту, что и расписание, уходила вторым сообщением в группу совета
// директоров. Замок — на базу, у самой отправки: кто пришёл вторым, не шлёт
// (tick — тихо, «Отправить сейчас» — словами «Отчёт уже отправляется»). Замок
// берётся до первого await, поэтому два вызова в одну и ту же секунду его
// не проскакивают.
const BUILD_FAILED = 'Отчёт не собран: сбой на сервере. Подробности — в журнале сервера.';
const BUSY = 'Отчёт уже отправляется — подождите минуту.';
const sending = new WeakSet();

/**
 * Собрать и отправить отчёт. scheduled — по расписанию (ставит «сегодня
 * отправлено»); иначе — «Отправить сейчас» с экрана, расписание не трогает.
 * Возвращает { ok, day, error?, busy? } и не бросает.
 */
export async function sendReport(db, opts = {}) {
  if (sending.has(db)) return { ok: false, busy: true, error: BUSY };
  sending.add(db);
  try {
    return await sendOnce(db, opts);
  } catch (e) {
    console.error('[daily-report] отчёт не собран или не отправлен:', e && (e.stack || e.message));
    try { recordAttempt(db, { ok: false, error: BUILD_FAILED }); } catch (e2) {
      console.error('[daily-report] попытка не записана:', e2 && e2.message);
    }
    return { ok: false, error: BUILD_FAILED };
  } finally {
    sending.delete(db);
  }
}

async function sendOnce(db, { scheduled = false, deps = {} } = {}) {
  const row = readSettingsRow(db);
  const todayDay = today(db);
  if (!row || !row.bot_token_enc) return { ok: false, error: 'Токен бота не задан.' };
  if (!row.chat_id) return { ok: false, error: 'Группа не выбрана.' };
  let token;
  try { token = getDecryptedToken(db); } catch (e) {
    const error = 'Сохранённый токен не читается: ' + e.message;
    recordAttempt(db, { ok: false, error });
    return { ok: false, error };
  }
  const { day, text } = buildReport(db, { day: reportDay(db, row.period), sections: sectionsOf(row.sections) });
  try {
    await sendMessage(token, row.chat_id, text, {}, deps);
    recordAttempt(db, { ok: true, day: todayDay, scheduled });
    return { ok: true, day };
  } catch (e) {
    const error = e instanceof TelegramError ? groupHint(e.message) : (e && e.message) || String(e);
    recordAttempt(db, { ok: false, error });
    return { ok: false, day, error };
  }
}

/** Отказ Telegram словами, понятными администратору клиники. */
export function groupHint(msg) {
  const m = String(msg || '');
  if (/chat not found/i.test(m)) return 'Группа не найдена: добавьте бота в группу и выберите её заново («Найти группу»).';
  if (/kicked|not a member|bot was blocked/i.test(m)) return 'Бота убрали из группы. Добавьте его обратно.';
  if (/not enough rights|have no rights/i.test(m)) return 'У бота нет права писать в группу. Разрешите ему отправлять сообщения.';
  if (/Unauthorized/i.test(m)) return 'Telegram не принял токен: бот удалён или токен заменён в @BotFather.';
  return m;
}

let timer = null;
let running = false;

/** Один проход расписания (тестам — без таймера). */
export async function tick(db, deps = {}) {
  if (running) return null;
  running = true;
  try {
    const row = readSettingsRow(db);
    if (!isDue(row, { day: today(db), hm: localHm(db), ms: Date.now() })) return null;
    const res = await sendReport(db, { scheduled: true, deps });
    return res && res.busy ? null : res;   // DAILY_REPORT_FAIL_V1 — отчёт уже уходит «Отправить сейчас»
  } catch (e) {
    console.warn('[daily-report]', e && e.message);
    return null;
  } finally { running = false; }
}

export function scheduleDailyReport(db) {
  if (timer) return;
  timer = setInterval(() => { tick(db).catch(() => {}); }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
