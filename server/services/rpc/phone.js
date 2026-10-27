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
import { grantAllows } from '../grants.js';
import { candidateExtensions, dialProvider } from '../telephony/dial.js';
import { pbxCall } from '../telephony/onlinepbx.js';
import { getProviderRow, pbxOptions, providerConfig, listProviders } from '../telephony/providers.js';
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
  const me = db.prepare('SELECT id, full_name, pbx_extension FROM users WHERE id = ?').get(user && user.id ? user.id : 0) || {};
  const via = dialProvider(db);
  return {
    id: me.id ?? null,
    full_name: me.full_name || '',
    extension: me.pbx_extension || '',
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

/**
 * Внутренние номера у самой станции — чтобы выбирать из настоящего, а не вспоминать.
 * Только onlinePBX отдаёт такой список; у других линий — пусто, и экран берёт
 * seen_extensions. Отказ станции — словом в error, а не исключением: пустой список
 * не беда, «не выбран» работает.
 */
export async function telephonyExtensions(db, _args, user, { pbxCallImpl = pbxCall } = {}) {
  if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
  const line = (listProviders(db) || []).find((p) => p.enabled && p.kind === 'onlinepbx');
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
