// CRM_PHONE_V1 (2026-10-17) — ТЕЛЕФОН ВНУТРИ CRM: четыре вызова рабочего места телефониста.
//
// Владелец: «there is a easyphone, I want it to be inside the easymed, not in
// separate adress» → на вопрос, где именно: «inside the CRM».
//
// ОТКУДА ЭТО. До этого дня эти четыре вызова были маршрутами ОТДЕЛЬНОЙ программы
// EasyPhone (phone/index.js, порт 8020, EASYPHONE_V1): /api/me, /api/my-extension,
// /api/extensions, /api/calls. Программа жила на своём адресе, ссылки на неё из
// EasyMed не было, и адрес набирали руками. Теперь рабочее место — панель раздела
// «CRM · Заявки» (views/crm-phone.js), а её сервер — обычные RPC за теми же воротами.
//
// ВОРОТА ТЕ ЖЕ, ЧТО БЫЛИ, и это главное, что здесь нельзя потерять. У EasyPhone
// они стоили разбора настоящей дыры (CALLCENTER_OPERATOR_V1): журнал звонков —
// это вся история обращений клиники с номерами и записями разговоров, и право
// ПОЗВОНИТЬ его не открывает. Три права — три двери:
//   crm.dial (edit)    — набор и своя трубка;
//   crm.calls (view)   — журнал;
//   crm.recording      — ссылка на запись: её проверяет telephony_call_recording,
//                        а журнал лишь говорит флагом may_hear, рисовать ли кнопку.
// Набор и запись — telephony_dial и telephony_call_recording (rpc/telephony.js),
// как и прежде: второго разъёма не заводится.
//
// SOFTPHONE_V1 (2026-10-28) — ещё два вызова для телефона в самом браузере:
// вход своего внутреннего номера в АТС (telephony_webrtc_me) и «кто звонит»
// (telephony_caller). Двери — те же права: набор и журнал.
import { grantAllows } from '../grants.js';
import { candidateExtensions, dialProvider, dialMessage } from '../telephony/dial.js';
import { pbxCall } from '../telephony/onlinepbx.js';
import { getProviderRow, pbxOptions, providerConfig, listProviders } from '../telephony/providers.js';
import { callerInfo } from '../telephony/live.js';   // SOFTPHONE_V1 — «кто звонит», как у «Звонит»
import { RpcError } from './telephony.js';

// Зеркало DIAL_ROLES / CALL_LOG_ROLES из rpc/telephony.js — ПРЕЖНЕЕ ПОВЕДЕНИЕ для
// ролей, которым эти ключи ещё не настраивали (CALLCENTER_OPERATOR_V1). Иначе двери
// разошлись бы в день, когда клиника выдала телефон своей роли: кнопка на доске
// работала бы, а панель отвечала «недоступна».
export const PHONE_ROLES = Object.freeze(['admin', 'registrar', 'callcenter']);

const mayDial = (db, user) => grantAllows(db, user, 'crm.dial', 'edit', PHONE_ROLES);
const mayLog  = (db, user) => grantAllows(db, user, 'crm.calls', 'view', PHONE_ROLES);
const mayHear = (db, user) => grantAllows(db, user, 'crm.recording', 'edit', PHONE_ROLES);

// Фразы отказов — те же, что стояли на дверях EasyPhone; в словаре i18n они уже есть.
const DENY_DIAL = 'Звонить из программы можно тем, кому выдано право «Позвонить пациенту» («Настройки → Роли»).';
const DENY_LOG = 'Журнал звонков открыт тем, кому выдано право «Журнал звонков» («Настройки → Роли»).';
const DENY_WORKPLACE = 'Программа телефонии доступна тем, кому выдано право звонить из программы или смотреть журнал звонков («Настройки → Роли»).';

/**
 * Кто я и чем звоню. Открыто тому, у кого есть ХОТЬ ОДНО из двух прав: человек,
 * которому выдали журнал без набора, иначе упирался бы в «недоступно» на пустой
 * панели — при открытом ему журнале. Три флага — чтобы экран рисовал только то,
 * что сервер потом не откажет.
 */
export function telephonyPhoneMe(db, _args, user) {
  const dial = mayDial(db, user);
  const log = mayLog(db, user);
  if (!dial && !log) throw new RpcError(DENY_WORKPLACE, 403);
  const me = db.prepare('SELECT id, full_name, pbx_extension, pbx_extension_assigned FROM users WHERE id = ?').get(user && user.id ? user.id : 0) || {};
  const via = dialProvider(db);
  return {
    id: me.id ?? null,
    full_name: me.full_name || '',
    extension: me.pbx_extension || '',
    // SOFTPHONE_V1 — номер, назначенный в карточке сотрудника: только на нём
    // включается телефон Easy-Med. Панель по нему объясняет, почему выключатель
    // не работает («Моя трубка» на другом номере или номер не назначен).
    softphone_extension: String(me.pbx_extension_assigned || '').trim(),
    // SOFTPHONE_V1 (M1) — телефон Easy-Med входит только в onlinePBX: у клиники на
    // Binotel или «Моих Звонках» выключателя нет вовсе. Та же линия, что у входа.
    softphone_available: !!onlinePbxLine(db),
    line: via ? via.kind : null,
    // Живые трубки из журнала — из них оператор выбирает свою, если станция молчит.
    seen_extensions: dial ? candidateExtensions(db, 12) : [],
    may_dial: dial,
    may_log: log,
    // Слушать записи, не видя журнала, всё равно неоткуда.
    may_hear: log && mayHear(db, user),
  };
}

/**
 * Мой внутренний номер. Пишет ТОЛЬКО себе: чужую трубку назначать нельзя — иначе
 * звонок уйдёт от чужого имени, и разбор смены соврёт.
 */
export function telephonyMyExtension(db, args, user) {
  if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
  const ext = String((args && args.extension) || '').trim();
  if (ext && !/^[0-9*#]{1,12}$/.test(ext)) throw new RpcError('Внутренний номер — это цифры, не длиннее двенадцати.', 400);
  db.prepare('UPDATE users SET pbx_extension = ? WHERE id = ?').run(ext || null, user.id);
  return { ok: true, extension: ext };
}

// SOFTPHONE_V1 — тексты отказов (ru — ключ словаря; uz/en — в i18n-strings.js).
const SP_NO_EXT = 'Сначала выберите свой внутренний номер в «Моя трубка» — телефон Easy-Med входит в АТС под ним.';
const SP_ACTING = 'Принимать звонки от чужого имени нельзя — вернитесь к своей учётной записи.';
const SP_NO_WEBRTC = 'АТС не дала этому внутреннему номеру вход из браузера — включите его в кабинете onlinePBX или выберите другой номер.';
const SP_NO_LINE = 'Линия onlinePBX не подключена («Настройки → Телефония»).';
const SP_NOT_ASSIGNED = 'Телефон Easy-Med включается только на внутреннем номере, который администратор назначил вам в карточке сотрудника.';

// Адрес АТС для браузера — только *.onpbx.ru с портом или без: политика страницы
// (CSP в app.js) пускает лишь wss://*.onpbx.ru:*, и другой адрес браузер молча не
// откроет — а пароль трубки к тому времени уже ушёл бы.
const PBX_WS_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.onpbx\.ru(:\d{1,5})?$/i;

// Записи трубок из ответа user/get.json. Обычно — массив; объектом (по номеру,
// одна запись или {data:[…]}) — разбираем так же: свой номер ищется по num.
function pbxUsers(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data)) return data.data;
  if (data.num !== undefined) return [data];
  return Object.values(data);
}

// Включённая линия onlinePBX — одна на вход телефона Easy-Med, «кто я» и трубки станции.
function onlinePbxLine(db) {
  return (listProviders(db) || []).find((p) => p.enabled && p.kind === 'onlinepbx') || null;
}

// SOFTPHONE_V1 (M10) — «выключен» станция пишет по-разному: 0, «0», false, «false».
const PBX_OFF = new Set(['0', 'false']);
const pbxUserOff = (u) => u.enabled === false || u.enabled === 0 || PBX_OFF.has(String(u.enabled).trim().toLowerCase());

// SOFTPHONE_V1 (I1) — временные беды станции (нет связи, «реже», ошибка станции,
// неразборчивый ответ, неизвестная причина — её dialMessage и называет ошибкой
// станции) несут код STATION_UNAVAILABLE: routes/rpc.js отдаёт его в error.code, и
// браузер повторит вход сам, с паузой. Неверный ключ и прочие постоянные отказы
// этого кода не несут — повтор их не вылечит.
export const STATION_UNAVAILABLE = 'station_unavailable';
const PBX_PERMANENT = new Set(['bad_credentials', 'not_auth']);

// SOFTPHONE_V1 (M5) — ОДИН ВОПРОС К СТАНЦИИ НА ОПЕРАТОРА В МИНУТУ.
// Каждая загрузка страницы у каждого оператора спрашивала user/get.json. Когда
// ключ подключения протух, одновременные загрузки (перезапуск сервера, «обновить»
// у всей смены) каждая выпускали новый ключ (new=true) и выбивали его друг у
// друга — «драка за ключ» из ONLINEPBX_KEY_SHARE_V1 (telephony/onlinepbx.js).
// Поэтому удачный ответ живёт WEBRTC_CACHE_MS в памяти процесса под ключом
// «оператор + выбранный номер + назначенный + линия», а одновременные вопросы с
// тем же ключом ждут один ответ станции. Только память: в базу и журнал кэш не
// пишется никогда (в нём пароль трубки); любой отказ оператору очищает его кэш;
// неудача станции не кэшируется. WeakMap по базе — у каждой базы (и стенда) свой.
//
// «Минуту» — буквально (ревью): пароль трубки не остаётся в памяти до следующего
// вопроса или перезапуска. Запись удаляет свой таймер (unref — работу процесса он
// не продлевает), а каждый вопрос заодно выметает просроченные (таймер мог не
// успеть: сон компьютера, занятый процесс). Удалённая или заменённая запись свой
// таймер снимает — висящих таймеров не остаётся.
export const WEBRTC_CACHE_MS = 60_000;
const webrtcCache = new WeakMap();   // db → { done: Map(userId → {key, at, value, cancel}), flight: Map(key → Promise) }
function webrtcCacheOf(db) {
  let c = webrtcCache.get(db);
  if (!c) { c = { done: new Map(), flight: new Map() }; webrtcCache.set(db, c); }
  return c;
}
function dropWebrtc(cache, uid) {
  const entry = cache.done.get(uid);
  if (!entry) return;
  cache.done.delete(uid);
  entry.cancel();
}
function sweepWebrtc(cache, at) {
  for (const [uid, entry] of [...cache.done]) if (at - entry.at >= WEBRTC_CACHE_MS) dropWebrtc(cache, uid);
}
function keepWebrtc(cache, uid, key, at, value, timers) {
  dropWebrtc(cache, uid);
  const entry = { key, at, value, cancel: () => {} };
  const handle = timers.set(() => { if (cache.done.get(uid) === entry) cache.done.delete(uid); }, WEBRTC_CACHE_MS);
  if (handle && typeof handle.unref === 'function') handle.unref();
  entry.cancel = () => timers.clear(handle);
  cache.done.set(uid, entry);
}
const REAL_TIMERS = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };

/** Для стендов: сколько входов в АТС сейчас в памяти этой базы. */
export function webrtcCacheSize(db) {
  const c = webrtcCache.get(db);
  return c ? c.done.size : 0;
}

// Один вопрос станции о своём номере → { extension, user, password, ws_url, sip_domain }.
async function askStationWebrtc(db, line, ext, pbxCallImpl) {
  const row = getProviderRow(db, line.id);
  // Поля — СТРОКОЙ через запятую: массивом onlinePBX webrtc не отдаёт (проверено 2026-10-28).
  const r = await pbxCallImpl(providerConfig(row).domain, 'user/get.json', { num: ext, fields: 'num,name,enabled,webrtc' }, pbxOptions(db, row));
  if (!r || !r.ok) {
    const reason = r && r.reason;
    const err = new RpcError(dialMessage(reason), 400);
    if (!PBX_PERMANENT.has(reason)) err.code = STATION_UNAVAILABLE;
    throw err;
  }
  // Только запись СВОЕГО номера: станция может прислать и чужие — их пароли не наши.
  const u = pbxUsers(r.data).find((x) => x && typeof x === 'object' && String(x.num) === ext);
  const w = u && !pbxUserOff(u) ? u.webrtc : null;
  if (!w || !w.host || !w.user || !w.password) throw new RpcError(SP_NO_WEBRTC, 409);
  const host = String(w.host);
  if (!PBX_WS_HOST.test(host)) throw new RpcError(SP_NO_WEBRTC, 409);
  return { extension: ext, user: String(w.user), password: String(w.password), ws_url: 'wss://' + host, sip_domain: host.replace(/:\d+$/, '') };
}

/**
 * SOFTPHONE_V1 — вход телефона Easy-Med в АТС под СВОИМ внутренним номером.
 * Номер — из users.pbx_extension (не из запроса): чужой номер — чужие звонки.
 * Пароль не пишется ни в журнал, ни в базу: он только уходит владельцу номера.
 *
 * И только номер, НАЗНАЧЕННЫЙ в карточке сотрудника (pbx_extension_assigned,
 * миграция 259; решение владельца «Only admin assigns»): «Моя трубка» сотрудник
 * выбирает сам, а пароль SIP работает в любой SIP-программе и после увольнения.
 * Выбран не назначенный номер — отказ, и станцию о пароле не спрашивают.
 *
 * Отказ станции — 400 словами клиники (dialMessage), как у «Позвонить»
 * (telephonyDial): маршрут RPC прячет всё, что 500 и выше, за «Ошибка сервера»,
 * и оператор не узнал бы, что дело в станции. Текст станции (comment) не
 * пересказывается: перевести его нечем, а причина и так названа.
 */
export async function telephonyWebrtcMe(db, _args, user, { pbxCallImpl = pbxCall, now = Date.now, timers = REAL_TIMERS } = {}) {
  const uid = user && user.id;
  try {
    if (user && user.acting_admin) throw new RpcError(SP_ACTING, 403);
    if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
    const me = db.prepare('SELECT pbx_extension, pbx_extension_assigned FROM users WHERE id = ?').get(uid) || {};
    const ext = String(me.pbx_extension || '').trim();
    if (!ext) throw new RpcError(SP_NO_EXT, 400);
    const assigned = String(me.pbx_extension_assigned || '').trim();
    if (ext !== assigned) throw new RpcError(SP_NOT_ASSIGNED, 403);
    const line = onlinePbxLine(db);
    if (!line) throw new RpcError(SP_NO_LINE, 400);
    // M5 — проверки выше идут на КАЖДЫЙ вопрос; из кэша — только ответ станции.
    const key = [uid, ext, assigned, line.id].join('|');
    const cache = webrtcCacheOf(db);
    sweepWebrtc(cache, now());
    const hit = cache.done.get(uid);
    if (hit && hit.key === key) return { ...hit.value };
    let flight = cache.flight.get(key);
    if (!flight) {
      flight = askStationWebrtc(db, line, ext, pbxCallImpl).finally(() => cache.flight.delete(key));
      cache.flight.set(key, flight);
    }
    const value = await flight;
    keepWebrtc(cache, uid, key, now(), value, timers);
    return { ...value };
  } catch (e) {
    const cache = webrtcCache.get(db);
    if (cache) dropWebrtc(cache, uid);   // любой отказ — кэш этого оператора пуст, таймер снят
    throw e;
  }
}

/**
 * SOFTPHONE_V1 — кто звонит на мой телефон Easy-Med: пациент и открытая заявка
 * по номеру, тем же поиском, что у «Звонит».
 *
 * M4 — ДВЕРЬ — ТОЛЬКО ПРАВО НАБОРА. Спрашивает это лишь телефон Easy-Med, а по
 * любому номеру ответ — имя пациента и номер его карты. Право «Журнал звонков»
 * такого поиска не открывает: журнал показывает только тех, кто звонил.
 */
export function telephonyCaller(db, args, user) {
  if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
  const number = String((args && args.number) || '').replace(/[^\d+]/g, '');
  if (!number) return { patient: null, lead: null };
  return callerInfo(db, number);
}

/**
 * Внутренние номера у самой станции — чтобы выбирать из настоящего, а не вспоминать.
 * Только onlinePBX отдаёт такой список; у других линий — пусто, и экран берёт
 * seen_extensions. Отказ станции — словом в error, а не исключением: пустой список
 * не беда, «не выбран» работает.
 */
export async function telephonyExtensions(db, _args, user, { pbxCallImpl = pbxCall } = {}) {
  if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
  const line = onlinePbxLine(db);
  if (!line) return { extensions: [], error: '' };
  const row = getProviderRow(db, line.id);
  const r = await pbxCallImpl(providerConfig(row).domain, 'user/get.json', {}, pbxOptions(db, row));
  const list = r.ok && Array.isArray(r.data)
    ? r.data.filter((u) => u && u.enabled !== false).map((u) => String(u.num))
    : [];
  return { extensions: list, error: r.ok ? '' : String(r.comment || r.reason || '') };
}

/**
 * Журнал — один запрос на весь экран: последние звонки с именем пациента и именем
 * оператора (по внутреннему номеру). Панель спрашивает его каждые несколько секунд,
 * поэтому лишних запросов быть не должно.
 *
 * ССЫЛКА НА ЗАПИСЬ — ТРЕТЬЕ ПРАВО, и в журнал она едет только при нём. Адрес у
 * Binotel и «Моих Звонков» прямой: уехав сюда без права, он отдал бы голос пациента
 * каждому, кто журнал открыл, и ворота telephony_call_recording остались бы замком
 * на распахнутой двери. Флаг has_recording остаётся честным — кнопка «Прослушать»
 * рисуется по нему и по may_hear (crm_lead_calls делает ровно то же в карточке).
 */
export function telephonyCallLog(db, args, user) {
  if (!mayLog(db, user)) throw new RpcError(DENY_LOG, 403);
  // Предел зажат в 1..200; по умолчанию 60. Ноль — это один, а не «по умолчанию»:
  // число, которое прислали, не подменяется другим молча.
  const raw = args && args.limit;
  const n = Number(raw);
  const limit = raw == null || raw === '' || !Number.isFinite(n) ? 60 : Math.max(1, Math.min(200, Math.floor(n)));
  const hear = mayHear(db, user);
  const rows = db.prepare(`
      SELECT c.id, c.started_at, c.call_type, c.external_number, c.internal_number,
             c.waitsec, c.billsec, c.disposition, c.recording_url, c.patient_id,
             p.full_name AS patient_name, p.mrn AS patient_mrn,
             u.full_name AS operator_name
        FROM calls c
        LEFT JOIN patients p ON p.id = c.patient_id
        LEFT JOIN users u ON u.pbx_extension IS NOT NULL AND u.pbx_extension <> ''
                         AND u.pbx_extension = c.internal_number
       ORDER BY c.started_at DESC, c.id DESC
       LIMIT ?`).all(limit);
  return {
    may_hear: hear,
    may_dial: mayDial(db, user),
    calls: rows.map((c) => ({ ...c, recording_url: hear ? c.recording_url : null, has_recording: !!c.recording_url })),
  };
}
