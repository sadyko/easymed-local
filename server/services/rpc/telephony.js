// TELEPHONY_V1 — RPC раздела «Телефония» в настройках.
//
// Why RPC and not /api/db: telephony_settings is deliberately NOT registered
// in schema-registry.js, so the secret is unreachable through the query
// endpoint by construction (telegram_settings' own rule, same reasoning).
// Nothing returned here ever contains api_secret — only api_secret_set.

import { hasAnyRole } from '../roles.js';
import { publicSettings, saveSettings, getCredentials, listDispositions, SettingsError } from '../telephony/settings.js';
import { binotelCall } from '../telephony/binotel.js';
import { wakePolling } from '../telephony/poller.js';
// TELEPHONY_PROVIDERS_V1 — провайдеры кроме Binotel.
import { listProviders, saveProvider, deleteProvider, testProvider, ProviderError, KINDS,
         getProviderRow, pbxOptions, providerConfig } from '../telephony/providers.js';
// CALL_FROM_CRM_V1 — один разъём набора на все телефонии.
import { dialCall } from '../telephony/dial.js';
// CALL_RECORDING_V1 — разбор ссылки на запись и история станции.
import { recordingUrlOf } from '../telephony/recording.js';
import { pbxHistory, pbxRecordingUrl } from '../telephony/onlinepbx.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// The credentials open the clinic's whole call history at Binotel, so the
// section is admin-only in full, reads included — the telegram-token rule.
// hasAnyRole, not user.role: an admin whose PRIMARY role is doctor
// (ADMIN_DOCTOR_V1) must not be locked out of a settings screen.
function requireAdmin(user) {
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Настройки телефонии доступны только администратору.', 403);
  }
}

export function telephonySettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

export function telephonySettingsSave(db, args, user) {
  requireAdmin(user);
  let out;
  try {
    out = saveSettings(db, args || {}, user && user.id ? user.id : null);
  } catch (e) {
    if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
    throw e;
  }
  // The poller re-reads settings every tick anyway; waking it makes «включить»
  // act in seconds instead of at the end of the previous interval —
  // wakeTelegramBot's reasoning, applied here.
  wakePolling();
  return out;
}

// binotel.js's fixed reason vocabulary mapped onto the sentences the screen
// shows verbatim (ENROLL_MESSAGES' pattern in licence.js). One sentence per
// DISTINCT next action the admin could take; server_error and bad_response
// share the admin's remedy ("later") but are kept apart so support can tell
// "Binotel is down" from "Binotel changed its answers".
const TEST_MESSAGES = {
  bad_credentials: 'Ключ или секрет не подходят. Проверьте данные, выданные Binotel.',
  offline:         'Нет связи с Binotel. Проверьте интернет на этом компьютере.',
  server_error:    'Binotel ответил ошибкой. Попробуйте позже.',
  bad_response:    'Ответ Binotel не удалось разобрать. Попробуйте позже.',
};

/**
 * «Проверить подключение». Uses the just-typed credentials when the fields
 * are filled, the SAVED ones otherwise — so the button can prove a new pair
 * BEFORE the admin saves it over a working one. Async: routes/rpc.js has
 * awaited handlers since telegram_test_connection. binotelCallImpl is the
 * test seam — the RPC signature is (db, args, user), so the transport cannot
 * be injected any other way (licenceEnroll's pattern).
 */
export async function telephonyTest(db, args, user, { binotelCallImpl = binotelCall } = {}) {
  requireAdmin(user);
  const saved = getCredentials(db);
  const typed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const key = typed(args && args.api_key) || saved.key;
  const secret = typed(args && args.api_secret) || saved.secret;
  if (!key || !secret) {
    return { ok: false, reason: 'bad_credentials', message: TEST_MESSAGES.bad_credentials };
  }

  // The cheapest question Binotel answers with these credentials: calls of
  // the last minute. The content is irrelevant — only whether the key/secret
  // opened the door.
  const r = await binotelCallImpl('stats/all-incoming-calls-since',
    { timestamp: Math.floor(Date.now() / 1000) - 60 }, { key, secret });
  if (!r.ok) return { ok: false, reason: r.reason, message: TEST_MESSAGES[r.reason] || TEST_MESSAGES.server_error };
  return { ok: true };
}

// Last 20 by call time — the settings screen's proof-of-life list. `raw`
// stays server-side on purpose: it is vendor diagnostics, not something to
// ship to a browser with every refresh.
export function telephonyRecentCalls(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT c.id, c.general_call_id, c.started_at, c.call_type, c.external_number,
           c.internal_number, c.waitsec, c.billsec, c.disposition, c.is_new_call,
           c.patient_id, p.full_name AS patient_name, c.source, c.provider, c.provider_id
      FROM calls c
      LEFT JOIN patients p ON p.id = c.patient_id
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT 20`).all();
}

// TELEPHONY_ROUTING_V1 — «Звонки → заявки»: which call outcomes exist at all,
// each already carrying its own routing rule
// (docs/plans/2026-08-24-telephony-owns-its-routing.md, task 3).
//
// Admin-only like the rest of this section, and for a sharper reason than
// symmetry: the seen_count of every disposition is a summary of the clinic's
// call traffic, and the rules it carries decide what the whole call centre
// sees on its board tomorrow.
//
// ONE call, not two: the screen needs the outcome AND its current rule for
// every row, and merging two replies in the browser is how a rule ends up
// drawn next to the wrong outcome. The merge is a join — it belongs where the
// tables are.
export function telephonyDispositions(db, _args, user) {
  requireAdmin(user);
  return listDispositions(db);
}

// ---------------------------------------------------------------------------
// TELEPHONY_PROVIDERS_V1 — карточки провайдеров: список, сохранение, удаление,
// проверка. Всё — администратору, как и остальная телефония. Секреты наружу
// не выходят (secret_set), а сохранение с пустым секретом не стирает
// сохранённый — та же защита, что у Binotel.
// ---------------------------------------------------------------------------
export function telephonyProvidersList(db, _args, user) {
  requireAdmin(user);
  return { kinds: Object.entries(KINDS).map(([k, v]) => ({ kind: k, label: v.label })), providers: listProviders(db) };
}

export function telephonyProviderSave(db, args, user) {
  requireAdmin(user);
  let out;
  try { out = saveProvider(db, args || {}, user && user.id ? user.id : null); }
  catch (e) { if (e instanceof ProviderError) throw new RpcError(e.message, e.status); throw e; }
  wakePolling();
  return out;
}

export function telephonyProviderDelete(db, args, user) {
  requireAdmin(user);
  try { return deleteProvider(db, args && args.id); }
  catch (e) { if (e instanceof ProviderError) throw new RpcError(e.message, e.status); throw e; }
}

export async function telephonyProviderTest(db, args, user, seams = {}) {
  requireAdmin(user);
  return testProvider(db, args || {}, seams);
}

// ---------------------------------------------------------------------------
// CALL_FROM_CRM_V1 (2026-09-17) — ПОЗВОНИТЬ ИЗ ПРОГРАММЫ.
//
// Единственный вызов этого раздела, доступный НЕ администратору: звонит
// регистратура и колл-центр, ради них всё и делалось. Сами настройки телефонии
// остаются админскими — оператор может позвонить, но не может увидеть ключ,
// которым звонок подписан.
//
// ВНУТРЕННИЙ НОМЕР БЕРЁТСЯ ИЗ СЕССИИ, А НЕ ИЗ ЗАПРОСА. Это не удобство, а
// правило: приезжай номер с экрана, любой оператор мог бы позвонить «от имени»
// чужой трубки — и разбор по операторам врал бы ровно там, где его читают как
// отчёт о работе смены.
//
// Кому звонить, решает ЭКРАН (заявка, карта пациента, очередь), поэтому номер
// пациента приходит аргументом. Проверка номера — в dial.js, одна на всех.
const DIAL_ROLES = ['admin', 'registrar', 'callcenter'];

export async function telephonyDial(db, args, user, seams = {}) {
  if (!hasAnyRole(user, DIAL_ROLES)) {
    throw new RpcError('Звонить из программы могут регистратура и колл-центр.', 403);
  }
  const me = db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(user && user.id ? user.id : 0);
  const r = await dialCall(db, {
    extension: (me && me.pbx_extension) || '',
    phone: (args && args.phone) || '',
  }, seams);
  if (!r.ok) {
    // Причина — слово из словаря dial.js, сообщение уже написано словами
    // клиники. 400 значит «поправьте у себя» (нет номера, не настроено),
    // 502 — «телефония не ответила»: разные причины и разные действия.
    const mine = r.reason === 'no_extension' || r.reason === 'no_provider' || r.reason === 'no_phone';
    throw new RpcError(r.message, mine ? 400 : 502);
  }
  return { ok: true, provider: r.provider, call_id: r.call_id };
}

// ---------------------------------------------------------------------------
// CALL_RECORDING_V1 (2026-09-17) — ЗВОНКИ ЭТОГО ЧЕЛОВЕКА, С ЗАПИСЯМИ.
//
// Владелец: «also include into a card the audio record of the call».
//
// Почему RPC, а не обычный запрос к базе: таблица calls намеренно НЕ заведена в
// реестре таблиц — через общий доступ к базе её не спросить (там сырые ответы
// вендора, а в них бывает и номер, и служебные поля). Здесь отдаётся ровно то,
// что нужно карточке, и ничего больше: raw наружу не выходит.
//
// КТО ЗВОНИЛ — ИМЕНЕМ. Внутренний номер звонка сверяется с внутренним номером
// сотрудника (миграция 134), поэтому в карточке видно «Насиба А.», а не «102».
// Совпадения может не быть (номер сменили, звонок входящий на общую линию) —
// тогда остаётся сам номер, и это честнее выдуманного имени.
const CALL_LOG_ROLES = ['admin', 'registrar', 'callcenter'];

export function crmLeadCalls(db, args, user) {
  if (!hasAnyRole(user, CALL_LOG_ROLES)) {
    throw new RpcError('Журнал звонков доступен регистратуре и колл-центру.', 403);
  }
  // Номер сверяется ПО ЦИФРАМ: в заявке он записан как его набрала регистратура,
  // а телефония отдаёт свой формат — «+998 90 123-45-67» и «998901234567» это
  // один и тот же человек.
  const digits = String((args && args.phone) || '').replace(/\D+/g, '');
  if (digits.length < 7) return [];
  // Сравниваем по ХВОСТУ из девяти цифр: у одного и того же номера городской
  // код то есть, то нет, и точное равенство теряло бы половину звонков.
  const tail = digits.slice(-9);
  const limit = Math.max(1, Math.min(50, Number((args && args.limit) || 20)));
  return db.prepare(`
    SELECT c.id, c.started_at, c.call_type, c.billsec, c.waitsec, c.disposition,
           c.internal_number, c.recording_url, u.full_name AS operator_name
      FROM calls c
      LEFT JOIN users u ON u.pbx_extension IS NOT NULL
                       AND u.pbx_extension <> ''
                       AND u.pbx_extension = c.internal_number
     WHERE replace(replace(replace(replace(c.external_number,' ',''),'-',''),'(',''),')','') LIKE ?
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT ?`).all('%' + tail, limit);
}

// ---------------------------------------------------------------------------
// CALLCENTER_SHIFT_V1 (2026-09-17) — РАЗБОР ЗВОНКОВ ПО ОПЕРАТОРАМ.
//
// Владелец: «breakdown by call-center users».
//
// СЧИТАЕТСЯ ПО САМИМ ЗВОНКАМ, А НЕ ПО ОТМЕТКАМ. Внутренний номер в звонке —
// это и есть подпись оператора (миграция 134), поэтому в отчёт не нужно ничего
// отмечать руками: он показывает то, что было на линии, а не то, что кто-то
// вспомнил записать. Звонки с номера, который никому не принадлежит (общая
// линия, уволенный сотрудник), собираются отдельной строкой «Не опознан» —
// прятать их значило бы, что сумма по операторам не сходится с журналом.
//
// АДМИНИСТРАТОРУ. Это отчёт о работе людей: кто сколько отговорил за смену.
// Оператору чужие цифры не нужны, а заведующей нужны все — поэтому здесь тот
// же admin-only, что и у остальной телефонии.
export function telephonyOperatorStats(db, args, user) {
  requireAdmin(user);
  // Границы периода приходят готовыми ISO-строками: «сегодня» у клиники
  // местное, и считать его на сервере по UTC значило бы показывать смену,
  // сдвинутую на пять часов.
  const from = String((args && args.from) || '').slice(0, 30);
  const to   = String((args && args.to) || '').slice(0, 30);
  if (!from || !to) throw new RpcError('Не указан период.', 400);
  return db.prepare(`
    SELECT COALESCE(u.full_name, '') AS operator_name,
           COALESCE(NULLIF(c.internal_number, ''), '') AS extension,
           COUNT(*)                                                   AS calls,
           SUM(CASE WHEN c.call_type = 1 THEN 1 ELSE 0 END)           AS outgoing,
           SUM(CASE WHEN COALESCE(c.billsec, 0) > 0 THEN 1 ELSE 0 END) AS answered,
           SUM(COALESCE(c.billsec, 0))                                AS talk_sec
      FROM calls c
      LEFT JOIN users u ON u.pbx_extension IS NOT NULL
                       AND u.pbx_extension <> ''
                       AND u.pbx_extension = c.internal_number
     WHERE c.started_at >= @from AND c.started_at < @to
     GROUP BY operator_name, extension
     ORDER BY calls DESC`).all({ from, to });
}

// ---------------------------------------------------------------------------
// CALL_RECORDING_V1 — ЗАПИСЬ ЭТОГО РАЗГОВОРА, ПО ТРЕБОВАНИЮ.
//
// Владелец: «we dont have any audios uploaded to the system. we cannot play the
// records».
//
// ПОЧЕМУ ПО ТРЕБОВАНИЮ, А НЕ ЗАРАНЕЕ. У onlinePBX нет поля «ссылка на запись» в
// истории — проверено на живой станции: в ответе только номера, время и причина
// завершения. Ссылку станция выдаёт отдельным запросом ПРО ОДИН звонок, и в
// адресе стоит подпись, которая живёт недолго. Складывать такие адреса заранее
// на все звонки значило бы хранить тысячи ссылок, половина из которых протухнет
// раньше, чем кто-нибудь нажмёт «прослушать».
//
// Поэтому: нажали «Прослушать» — спросили станцию про этот звонок — отдали
// адрес браузеру. Он ведёт на mp3, понимает перемотку и ключа не требует.
//
// Для Binotel и «Моих Звонков» ссылка приезжает вместе со звонком и лежит в
// самой строке — тогда станцию не тревожим вовсе.
export async function telephonyCallRecording(db, args, user, { pbxRecordingUrlImpl = pbxRecordingUrl } = {}) {
  if (!hasAnyRole(user, CALL_LOG_ROLES)) {
    throw new RpcError('Записи разговоров доступны регистратуре и колл-центру.', 403);
  }
  const id = Number((args && args.call_id) || 0);
  const call = id ? db.prepare('SELECT id, general_call_id, provider, provider_id, billsec, recording_url FROM calls WHERE id = ?').get(id) : null;
  if (!call) throw new RpcError('Звонок не найден.', 404);
  if (call.recording_url) return { url: call.recording_url };
  if (!Number(call.billsec)) return { url: '', reason: 'no_talk' };
  if (String(call.provider) !== 'onlinepbx') return { url: '', reason: 'not_supported' };

  const row = call.provider_id ? getProviderRow(db, call.provider_id) : null;
  if (!row) return { url: '', reason: 'no_line' };
  // Идентификатор звонка у станции — то, что стоит после «onlinepbx:» (так его
  // кладёт normalizePbxCall). Без этого запрос уйдёт с чужим номером.
  const uuid = String(call.general_call_id || '').replace(/^onlinepbx:/, '');
  const r = await pbxRecordingUrlImpl(providerConfig(row).domain, uuid, pbxOptions(db, row));
  const url = (r && r.ok && typeof r.data === 'string' && /^https?:\/\//.test(r.data)) ? r.data : '';
  if (!url) return { url: '', reason: 'not_found' };
  return { url };
}
