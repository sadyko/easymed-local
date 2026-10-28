// META_LEADS_V1_POLL — опрос Graph API за новыми заявками.
//
// Форма — telephony/poller.js, один в один: таймер unref, проход никогда не
// бросает, защита от наложения проходов, пробуждение по сохранению настроек,
// лицензионный модуль проверяется КАЖДЫЙ проход (модуль, выданный на следующем
// check-in, включается без перезапуска). Модуль — `crm`: заявкам из Meta
// больше некуда идти, без доски CRM интеграция бессмысленна.
//
// Один проход:
//   1. выключено / нет модуля / нет токена — тихо выходим;
//   2. FIX_318_V1 (H1) — какие формы: режим «выбранные» — отмеченные в
//      настройках; режим «все» — формы страницы, ПЕРЕЧИТАННЫЕ сейчас
//      (/{page}/leadgen_forms по всем страницам ответа), а не список с
//      последней «Проверить связь»: экран обещает «все формы страницы, включая
//      новые». Свежий список ложится и в настройки (экран его видит). Список не
//      прочитался — опрашиваем известные формы, причина — в last_error;
//   3. для каждой формы — /{form}/leads новее ЕЁ отметки минус 10 минут
//      (meta_form_cursors, мигр. 256; перекрытие ловит заявку, которую Meta
//      показала с опозданием, а повтор бесплатен — leadgen_id уникален). Форма
//      без отметки — от since_ts («забирать с»: включение или «за N дней»);
//   4. каждая заявка — parseLead → fileLead (журнал + CRM); сломанная заявка
//      попадает в журнал со статусом error и не роняет проход;
//   5. отметка формы двигается на её самую свежую заявку, только если ЭТА
//      форма прочиталась целиком. Прежде курсор был один на все формы: форма с
//      заявками старше чужой свежей отметки теряла их навсегда (ревью R1).
//      Отказ сети — слово в last_error, следующий проход по расписанию.
//      Недействительный токен выключает опрос (recordPoll): долбить Meta им
//      бессмысленно.
//
// Заявки читаются токеном СТРАНИЦЫ, если Meta выдала его при подключении, иначе
// основным (токен страницы, вставленный напрямую): право leads_retrieval
// действует на страницу.

import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';
import { graphGetAll } from './graph.js';
import { readSettingsRow, getTokens, recordPoll, formsToPoll, refreshForms, readFormCursors, advanceFormCursor } from './settings.js';
import { parseLead, fileLead as fileLeadDefault, recordLeadError } from './leads.js';
import { fetchPageForms } from './connect.js';

// FIX_318_V1 (H1) — перекрытие окна опроса формы: 10 минут до её отметки.
export const CURSOR_OVERLAP_S = 600;

const INITIAL_DELAY_MS = 20_000;
const MIN_DELAY_MS = 60_000;
const DEFAULT_MINUTES = 2;
// Поля заявки: ответы формы и откуда она (объявление, кампания, площадка).
export const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,platform';
// Страниц за проход на одну форму (по 100 заявок). Больше — только при первом
// заборе истории у очень большого аккаунта; тогда проход берёт самые свежие
// и говорит об этом словом 'truncated' в last_error, не останавливая курсор.
const MAX_PAGES = 50;

function defaultHasModule(db) {
  try { return controlState(db, getDataDir()).has('crm'); } catch { return false; }
}

let inFlight = false;

/** Один проход. Никогда не бросает — для таймера и для тестов. */
export async function pollOnce(db, opts = {}) {
  if (inFlight) return;
  inFlight = true;
  try {
    await performPoll(db, opts);
  } catch (e) {
    console.warn('[meta] poll failed, will retry next tick:', e && e.message);
  } finally {
    inFlight = false;
  }
}

async function performPoll(db, opts = {}) {
  const { hasModule = defaultHasModule, fetchImpl, timeoutMs, kekPath, fileLeadImpl = fileLeadDefault } = opts;
  const row = readSettingsRow(db);
  if (!row || !row.enabled) return;
  if (!hasModule(db)) return;

  let tokens;
  try { tokens = getTokens(db, { kekPath }); }
  catch (e) {
    // Файл ключа шифрования испорчен или пропал — это не сеть и не Meta:
    // слово 'kek', экран скажет «обратитесь к поставщику», опрос не выключаем.
    console.warn('[meta] token unreadable:', e && e.message);
    recordPoll(db, { ok: false, error: 'kek' });
    return;
  }
  const token = tokens.pageToken || tokens.token;
  if (!token) return;

  // since_ts — нижняя граница для форм без своей отметки; опрос её не двигает.
  const floor = Number(row.since_ts) || 0;
  let failure = '';
  let truncated = false;

  let forms;
  if (row.forms_mode !== 'selected' && row.page_id) {
    const fr = await fetchPageForms(row.page_id, { token, fetchImpl, timeoutMs });
    if (fr.ok) {
      forms = refreshForms(db, fr.forms);
    } else {
      // Недействительный токен и нет сети — формы ответят тем же: проход окончен.
      if (fr.reason === 'bad_token' || fr.reason === 'offline') { recordPoll(db, { ok: false, error: fr.reason }); return; }
      failure = fr.reason || 'server_error';   // список не обновился — опрашиваем известные формы
      forms = formsToPoll(db);
    }
  } else {
    forms = formsToPoll(db);
  }

  const cursors = readFormCursors(db);
  for (const f of forms) {
    const own = cursors.has(f.id) ? cursors.get(f.id) : null;
    const since = own != null ? Math.max(0, own - CURSOR_OVERLAP_S) : floor;
    const r = await graphGetAll(`${f.id}/leads`, {
      fields: LEAD_FIELDS, limit: 100,
      filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }],
    }, { token, fetchImpl, timeoutMs, maxPages: MAX_PAGES });
    // Увиденные заявки подшиваем даже при отказе на поздней странице: они
    // идемпотентны по leadgen_id, а отметка формы при отказе всё равно не двинется.
    let maxTs = own;
    for (const raw of (Array.isArray(r.data) ? r.data : [])) {
      const lead = parseLead(raw, { formName: f.name });
      if (!lead.form_id) lead.form_id = f.id;
      try {
        fileLeadImpl(db, lead);
      } catch (e) {
        // Одна неподшитая заявка — одна строка журнала с ошибкой, не проход и не цикл.
        console.warn('[meta] lead not filed:', lead.leadgen_id, e && e.message);
        recordLeadError(db, lead, e && e.message ? e.message : String(e));
      }
      const ts = Math.floor(Date.parse(lead.created_time) / 1000);
      if (Number.isFinite(ts) && (maxTs == null || ts > maxTs)) maxTs = ts;
    }
    if (!r.ok) {
      failure = r.reason || 'server_error';
      if (failure === 'bad_token') break;   // остальные формы ответят тем же
      continue;
    }
    if (r.truncated) truncated = true;
    if (maxTs != null && maxTs !== own) advanceFormCursor(db, f.id, maxTs);
  }
  if (failure) recordPoll(db, { ok: false, error: failure });
  else recordPoll(db, { ok: true, error: truncated ? 'truncated' : '' });
}

// --------------------------------------------------------------------------
// Расписание — форма telephony/poller.js schedulePolling.
// --------------------------------------------------------------------------

let timer = null;
let stopped = false;
let armFn = null;

/** Шаг цикла — период из настроек; перечитывается каждый проход, чтобы правка действовала без перезапуска. */
export function nextDelayMs(db) {
  let row = null;
  try { row = readSettingsRow(db); } catch { row = null; }
  const min = row && Number(row.poll_minutes);
  const minutes = Number.isFinite(min) && min >= 1 ? min : DEFAULT_MINUTES;
  return Math.max(MIN_DELAY_MS, minutes * 60 * 1000);
}

/** Из rpc/meta.js после сохранения: «включить» начинает опрос через секунды, а не через период. */
export function wakePolling() {
  if (armFn) armFn(0);
}

/** Запуск в процессе сервера (server/index.js). Возвращает { stop }. Таймеры unref — остановку клиники не держат. */
export function schedulePolling(db, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, ...tickOpts } = opts;
  stopped = false;
  const arm = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  const tick = () => {
    pollOnce(db, tickOpts)
      .catch((e) => console.warn('[meta] scheduled poll failed:', e && e.message))
      .finally(() => arm(nextDelayMs(db)));
  };
  armFn = arm;
  arm(initialDelayMs);
  console.log('[meta] lead poller scheduled');
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      armFn = null;
    },
  };
}
