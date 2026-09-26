// TELEPHONY_V1 — RPC раздела «Телефония» в настройках.
//
// Why RPC and not /api/db: telephony_settings is deliberately NOT registered
// in schema-registry.js, so the secret is unreachable through the query
// endpoint by construction (telegram_settings' own rule, same reasoning).
// Nothing returned here ever contains api_secret — only api_secret_set.

import { hasAnyRole } from '../roles.js';
// CALLCENTER_OPERATOR_V1 — звонок, журнал и запись спрашивают МАТРИЦУ ПРАВ,
// а список ролей ниже остаётся правилом перехода для ролей, которых в ней ещё
// не настраивали (server/services/grants.js).
import { grantAllows, requireGrant, grantAllowsAdminOr, isAdminUser } from '../grants.js';
import { canSeeAllLeads } from '../crm/visibility.js';   // CRM_HEAD_MERGE_TAGS_V1
import { publicSettings, saveSettings, getCredentials, listDispositions, SettingsError, forgetBinotel } from '../telephony/settings.js';
import { binotelCall } from '../telephony/binotel.js';
import { wakePolling } from '../telephony/poller.js';
// TELEPHONY_PROVIDERS_V1 — провайдеры кроме Binotel.
import { listProviders, saveProvider, deleteProvider, testProvider, ProviderError, KINDS,
         getProviderRow, pbxOptions, providerConfig, providerSecrets, providerKind } from '../telephony/providers.js';
// CALL_FROM_CRM_V1 — один разъём набора на все телефонии.
import { dialCall } from '../telephony/dial.js';
// CALL_RECORDING_V1 — разбор ссылки на запись и история станции.
import { recordingUrlOf } from '../telephony/recording.js';
import { pbxHistory, pbxRecordingUrl, pbxAuth, normalizeDomain } from '../telephony/onlinepbx.js';
import { normalizeMzDomain } from '../telephony/moizvonki.js';   // ADMIN_ROWS_GRANTABLE_V1 (ревью I2)

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// The credentials open the clinic's whole call history at Binotel, so the
// section is admin-only in full, reads included — the telegram-token rule.
// hasAnyRole, not user.role: an admin whose PRIMARY role is doctor
// (ADMIN_DOCTOR_V1) must not be locked out of a settings screen.
//
// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — РАЗДЕЛ ВЫДАЁТСЯ ИЗ «РОЛЕЙ» (ключ
// `settings.telephony`): «Просмотр» — настройки, подключения и журнал,
// «Изменение» — сохранить и проверить, «Удаление» — удалить подключение и
// стереть Binotel. Роль, которая ключ не настраивала, — как вчера: только
// администратор. КЛЮЧИ И СЕКРЕТЫ не-администратор не видит ни на каком уровне
// (ключ Binotel приходит пустым с api_key_set; секреты провайдеров не уходили
// никогда), а пустое поле ключа при его сохранении ключ не стирает.
const TEL_KEY = 'settings.telephony';
function requireLevel(db, user, need) {
  if (!grantAllowsAdminOr(db, user, TEL_KEY, need)) {
    throw new RpcError('Настройки телефонии недоступны вашей роли. Права выдаёт администратор в «Настройки → Роли».', 403);
  }
}

// Ключ Binotel — тоже учётные данные: не-администратору он не показывается.
function maskedFor(user, settings) {
  if (isAdminUser(user)) return settings;
  return { ...settings, api_key: '', api_key_set: !!(settings && settings.api_key), secrets_hidden: true };
}

export function telephonySettingsGet(db, _args, user) {
  requireLevel(db, user, 'view');
  return maskedFor(user, publicSettings(db));
}

export function telephonySettingsSave(db, args, user) {
  requireLevel(db, user, 'edit');
  const a = { ...(args || {}) };
  // Не-администратор ключа не видел — пустое поле значит «оставить как есть».
  if (!isAdminUser(user) && typeof a.api_key === 'string' && a.api_key.trim() === '') delete a.api_key;
  let out;
  try {
    out = saveSettings(db, a, user && user.id ? user.id : null);
  } catch (e) {
    if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
    throw e;
  }
  // The poller re-reads settings every tick anyway; waking it makes «включить»
  // act in seconds instead of at the end of the previous interval —
  // wakeTelegramBot's reasoning, applied here.
  wakePolling();
  return maskedFor(user, out);
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
  requireLevel(db, user, 'edit');
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
  requireLevel(db, user, 'view');
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
  requireLevel(db, user, 'view');
  return listDispositions(db);
}

// ---------------------------------------------------------------------------
// TELEPHONY_PROVIDERS_V1 — карточки провайдеров: список, сохранение, удаление,
// проверка. Всё — администратору, как и остальная телефония. Секреты наружу
// не выходят (secret_set), а сохранение с пустым секретом не стирает
// сохранённый — та же защита, что у Binotel.
// ---------------------------------------------------------------------------
// FORGET_BINOTEL_V1 — «удалить» Binotel: его строка настроек остаётся, но
// становится пустой, как в новой клинике. Админское действие, как и все
// остальные в этом разделе.
export function telephonyForgetBinotel(db, _args, user) {
  requireLevel(db, user, 'delete');
  const out = forgetBinotel(db);
  // Опрос просыпается сразу: иначе выключённая линия ещё интервал стучалась бы
  // к вендору со стёртым ключом и писала бы себе ошибку.
  wakePolling();
  return out;
}

export function telephonyProvidersList(db, _args, user) {
  requireLevel(db, user, 'view');
  return { kinds: Object.entries(KINDS).map(([k, v]) => ({ kind: k, label: v.label })), providers: listProviders(db) };
}

// KEY_GUARD_V1 (2026-09-17) — НЕВЕРНЫЙ КЛЮЧ НЕ ДОЛЖЕН ЛОМАТЬ РАБОЧУЮ ЛИНИЮ.
//
// Что случилось у клиники и почему это стоило дня работы. В настройках был
// сохранён новый ключ API onlinePBX — и он оказался не тем. Сохранение при этом
// СТИРАЕТ выданную станцией пару ключей (правильно: они выданы под старый ключ),
// а новый ключ станция не принимает. В итоге линия, которая только что работала,
// начинает на КАЖДЫЙ запрос отвечать «Wrong api key»: не идут ни звонки, ни
// записи, ни опрос журнала. Причём молча — сохранение прошло «успешно».
//
// Поэтому теперь ключ ПРОВЕРЯЕТСЯ ДО СОХРАНЕНИЯ. Не подошёл — не сохраняем: у
// клиники остаётся прежний, работающий, и человек видит словами, что ключ не
// тот. Это ровно та защита, которой не хватило: «сохранил и всё сломалось» не
// должно быть возможным в разделе, где одна опечатка глушит телефонию.
//
// Проверка — только при СМЕНЕ секрета: сохранение названия или добавочного
// номера не должно ходить к вендору.
// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности I2) — АДРЕС МЕНЯЕТСЯ ТОЛЬКО
// ВМЕСТЕ С КЛЮЧОМ. Проверка связи и опрос шлют СОХРАНЁННЫЙ ключ на СОХРАНЁННЫЙ
// (или только что введённый) адрес. Роль с «Телефония: Изменение» ключа не
// видит — и не должна получить его, подставив свой адрес. Поэтому
// не-администратор меняет адрес подключения (при сохранении и при проверке)
// только введя ключ заново в том же запросе. Хост onlinePBX зашит
// (api2.onlinepbx.ru, домен — лишь часть пути), Binotel — тоже
// (api.binotel.com); у «Моих Звонков» адрес — сам хост, и он ещё и прибит к
// *.moizvonki.ru (moizvonki.js normalizeMzDomain).
function domainChangeRefusal(existing, a, user) {
  if (!existing || isAdminUser(user)) return null;
  const typed = a && a.config && typeof a.config.domain === 'string' ? a.config.domain.trim() : '';
  if (!typed) return null;
  const kind = providerKind(existing);
  const norm = kind === 'moizvonki' ? normalizeMzDomain(typed) : normalizeDomain(typed);
  if (norm && norm === String(providerConfig(existing).domain || '')) return null;
  const secretFields = (KINDS[kind] && KINDS[kind].secretFields) || [];
  const reentered = secretFields.some((f) => a.secret && typeof a.secret[f] === 'string' && a.secret[f].trim());
  return reentered ? null : 'Адрес подключения меняется только вместе с ключом API: введите ключ заново.';
}

export async function telephonyProviderSave(db, args, user, { pbxAuthImpl = pbxAuth } = {}) {
  requireLevel(db, user, 'edit');
  const a = args || {};
  const existing = a.id ? getProviderRow(db, a.id) : null;
  const moved = domainChangeRefusal(existing, a, user);
  if (moved) throw new RpcError(moved, 403);
  const kind = existing ? providerKind(existing) : String(a.kind || '');
  const typedKey = String((a.secret && a.secret.auth_key) || '').trim();
  const oldSecret = existing ? providerSecrets(existing) : {};

  if (kind === 'onlinepbx' && typedKey && typedKey !== oldSecret.auth_key) {
    const domain = String((a.config && a.config.domain) || (existing ? providerConfig(existing).domain : '')).trim();
    const check = await pbxAuthImpl(domain, typedKey);
    if (!check.ok) {
      throw new RpcError(
        'Ключ API не подошёл — станция его не приняла. Прежние настройки оставлены без изменений: возьмите ключ в личном кабинете onlinePBX («Интеграция → API») и вставьте его целиком, без пробелов.',
        400);
    }
  }

  let out;
  try { out = saveProvider(db, a, user && user.id ? user.id : null); }
  catch (e) { if (e instanceof ProviderError) throw new RpcError(e.message, e.status); throw e; }
  wakePolling();
  return out;
}

export function telephonyProviderDelete(db, args, user) {
  requireLevel(db, user, 'delete');
  try { return deleteProvider(db, args && args.id); }
  catch (e) { if (e instanceof ProviderError) throw new RpcError(e.message, e.status); throw e; }
}

export async function telephonyProviderTest(db, args, user, seams = {}) {
  requireLevel(db, user, 'edit');
  const a = args || {};
  const moved = domainChangeRefusal(a.id ? getProviderRow(db, a.id) : null, a, user);
  if (moved) throw new RpcError(moved, 403);
  return testProvider(db, a, seams);
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
//
// CALLCENTER_OPERATOR_V1 — КТО ЗВОНИТ, РЕШАЕТ МАТРИЦА, А НЕ ЭТОТ СПИСОК.
// Список остался, но сменил роль: он — ПРЕЖНЕЕ ПОВЕДЕНИЕ для ролей, которым
// ключ `crm.dial` ещё не настраивали (правило перехода, grants.js). Клиника,
// которая ничего не трогала, после обновления звонит ровно теми же людьми; а
// своя роль клиники («Старший регистратор», «Оператор») получает право
// галочкой, чего списком в коде не добиться было никак.
const DIAL_ROLES = ['admin', 'registrar', 'callcenter'];

export async function telephonyDial(db, args, user, seams = {}) {
  requireGrant(db, user, 'crm.dial', 'edit', DIAL_ROLES, 'звонить из программы');
  const me = db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(user && user.id ? user.id : 0);
  const r = await dialCall(db, {
    extension: (me && me.pbx_extension) || '',
    phone: (args && args.phone) || '',
  }, seams);
  if (!r.ok) {
    // ВСЕГДА 400, И ЭТО РЕШЕНИЕ. Раньше отказ телефонии отдавался как 502, а
    // маршрут RPC (routes/rpc.js) нарочно прячет ВСЁ, что 500 и выше, за общей
    // фразой «RPC failed» — чтобы наружу не утекали внутренности. В итоге
    // оператор видел «RPC failed» вместо ответа станции, и владелец справедливо
    // спрашивал, что не так.
    //
    // Отказ телефонии — не внутренняя поломка, а сообщение человеку: «нет
    // номера», «нет связи», «станция не приняла ключ», «на номере нет
    // телефона». Все они написаны словами клиники в dial.js и не содержат ни
    // ключей, ни адресов, поэтому прятать их не от кого.
    throw new RpcError(r.message, 400);
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
//
// CALLCENTER_OPERATOR_V1 — и здесь список из кода стал правилом перехода:
// журнал открывает ключ `crm.calls`, запись разговора — `crm.recording`. Они
// РАЗНЫЕ намеренно: строка «звонил, 2 минуты» и голос пациента в наушниках —
// это разный объём доверия, и клиника вправе выдать одно без другого.
const CALL_LOG_ROLES = ['admin', 'registrar', 'callcenter'];

export function crmLeadCalls(db, args, user) {
  requireGrant(db, user, 'crm.calls', 'view', CALL_LOG_ROLES, 'смотреть журнал звонков');
  // Номер сверяется ПО ЦИФРАМ: в заявке он записан как его набрала регистратура,
  // а телефония отдаёт свой формат — «+998 90 123-45-67» и «998901234567» это
  // один и тот же человек.
  const digits = String((args && args.phone) || '').replace(/\D+/g, '');
  if (digits.length < 7) return [];
  // Сравниваем по ХВОСТУ из девяти цифр: у одного и того же номера городской
  // код то есть, то нет, и точное равенство теряло бы половину звонков.
  const tail = digits.slice(-9);
  const limit = Math.max(1, Math.min(50, Number((args && args.limit) || 20)));
  // САМА ССЫЛКА НА ЗАПИСЬ В ЖУРНАЛ НЕ ЕДЕТ, и это то, ради чего право
  // «Прослушать» существует отдельно. Адрес записи у Binotel и «Моих Звонков»
  // прямой и ничем не подписан: доехав до карточки, он отдаёт голос пациента
  // каждому, кто журнал открыл, — и отдельные ворота telephony_call_recording
  // остались бы замком на распахнутой двери.
  //
  // Флаг has_recording при этом честный: кнопка «Прослушать» рисуется по нему,
  // а нажатие уходит в ворота записи и получает внятный отказ. Строка «звонил,
  // 2 минуты, запись есть» и сам голос — разный объём доверия, и клиника
  // вправе выдать первое без второго.
  const mayHear = grantAllows(db, user, 'crm.recording', 'edit', CALL_LOG_ROLES);
  const rows = db.prepare(`
    SELECT c.id, c.started_at, c.call_type, c.billsec, c.waitsec, c.disposition,
           c.internal_number, c.recording_url, u.full_name AS operator_name
      FROM calls c
      LEFT JOIN users u ON u.pbx_extension IS NOT NULL
                       AND u.pbx_extension <> ''
                       AND u.pbx_extension = c.internal_number
     WHERE replace(replace(replace(replace(c.external_number,' ',''),'-',''),'(',''),')','') LIKE ?
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT ?`).all('%' + tail, limit);
  return rows.map((c) => ({ ...c, recording_url: mayHear ? c.recording_url : null, has_recording: !!c.recording_url }));
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
  // CRM_HEAD_MERGE_TAGS_V1 — и руководителю колл-центра (право `crm.all`):
  // «видит показатели каждого оператора» — это и есть его работа. Предикат тот
  // же, что снимает сужение доски (services/crm/visibility.js canSeeAllLeads).
  if (!canSeeAllLeads(db, user)) {
    throw new RpcError('Показатели операторов видят администратор и руководитель колл-центра.', 403);
  }
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
  requireGrant(db, user, 'crm.recording', 'edit', CALL_LOG_ROLES, 'слушать записи разговоров');
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
