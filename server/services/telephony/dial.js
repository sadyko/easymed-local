// CALL_FROM_CRM_V1 (2026-09-17) — ОДИН РАЗЪЁМ НАБОРА НА ВСЮ ПРОГРАММУ.
//
// Владелец: «can we build a telephone into a crm so using pbx or binotel we can
// make calls? <…> so we can make actual calls from the system using api of the
// telephony and breakdown by call-center users».
//
// ПОЧЕМУ ОДИН ФАЙЛ, А НЕ КНОПКА НА КАЖДЫЙ ЭКРАН. Звонок начинается в четырёх
// местах (заявка CRM, карта пациента, очередь, обзвон после визита) и уходит к
// разным телефониям. Если каждый экран будет сам выбирать провайдера и сам
// разбирать отказы, то правило «кому можно звонить» и словарь отказов разъедутся
// по экранам — ровно так разъехались когда-то отчёты. Здесь один вход:
// dialCall(db, {extension, phone}) и ОДИН словарь причин.
//
// ЧТО ОДИНАКОВОГО У BINOTEL И onlinePBX. Обе звонят «через АТС»: программа
// просит станцию соединить внутренний номер сотрудника с номером пациента —
// сначала звонит трубка у оператора, он снимает её, и тогда набирается пациент.
// Поэтому разъём и возможен: снаружи вызов один, различается только драйвер.
//
// «МОИ ЗВОНКИ» — ТРЕТИЙ ДРАЙВЕР ЗА ТЕМ ЖЕ РАЗЪЁМОМ, и он устроен иначе: станции
// нет, команда уходит на смартфон сотрудника, и звонит его сим-карта. Отсюда
// единственное различие, которое видно снаружи: внутренний номер там не нужен и
// не спрашивается (см. dialCall).
//
// ПОЧЕМУ НЕ ПИШЕМ СВОЮ СТРОКУ В calls. Звонок всё равно приедет — вебхуком или
// опросом истории, вместе с длительностью и исходом, которых в момент набора
// ещё нет. Своя строка означала бы две записи об одном звонке и двойной счёт в
// разборе по операторам. Связь держится сама собой: у набранного звонка
// internal_number — это внутренний номер оператора, а generalCallID, который
// вернул Binotel, — тот же, что приедет в calls.general_call_id.
//
// НИЧЕГО НЕ ЛОГИРУЕТ: ключи телефонии идут в теле запроса (см. binotel.js).
import { binotelDial } from './binotel.js';
import { pbxCallNow, normalizeDomain } from './onlinepbx.js';
import { mzDial, normalizeMzDomain } from './moizvonki.js';
import { getCredentials, readSettingsRow } from './settings.js';
import { listProviders, getProviderRow, pbxOptions, providerConfig, providerSecrets } from './providers.js';

// Словарь отказов — СЛОВАМИ КЛИНИКИ. Оператор видит их вместо кода ошибки, и
// каждый говорит, что делать дальше.
export const DIAL_MESSAGES = {
  no_provider:     'Линия для звонков не выбрана или выключена. Проверьте настройки — раздел «Телефония».',
  no_extension:    'Не указан номер, с которого звонить: ни у вас в карточке сотрудника, ни у самой линии в настройках телефонии.',
  no_phone:        'У этой записи нет телефона, по которому можно позвонить.',
  bad_credentials: 'Телефония не приняла ключ доступа. Проверьте настройки подключения.',
  offline:         'Нет связи с телефонией. Проверьте интернет на этом компьютере.',
  server_error:    'Телефония ответила ошибкой. Попробуйте ещё раз через минуту.',
  bad_response:    'Ответ телефонии не удалось разобрать. Попробуйте ещё раз.',
  rate_limited:    'Телефония просит звонить реже: подождите несколько секунд.',
  not_auth:        'Телефония не приняла ключ доступа. Проверьте настройки подключения.',
};

export function dialMessage(reason) {
  return DIAL_MESSAGES[reason] || DIAL_MESSAGES.server_error;
}

/**
 * Номер в том виде, в каком его принимает станция: только цифры, плюс — только
 * ведущий. В базе телефон лежит как его набрала регистратура («+998 90 123-45-67»,
 * «90 123 45 67»), и отдавать станции скобки с пробелами нельзя.
 *
 * Внутренний номер (3–4 цифры) сюда не попадает: звонить «наружу» на добавочный
 * незачем, а перепутать их легко, поэтому короткие номера отсекаются выше по
 * длине — см. dialCall.
 */
export function dialableNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D+/g, '');
  if (!digits) return '';
  return (plus ? '+' : '') + digits;
}

/**
 * Через что звоним. Возвращает {kind:'binotel'} | {kind:'onlinepbx', row} |
 * {kind:'moizvonki', row} | null, если звонить не через что.
 *
 * ПРАВИЛО ВЫБОРА, когда включено несколько. Binotel живёт в telephony_settings —
 * это главная линия клиники, её ключ вводят при установке; остальные заводятся
 * строкой в telephony_providers позже и рядом. Поэтому при прочих равных
 * выбирается Binotel, а из остальных — первый включённый с заполненным адресом.
 * Правило намеренно ПРОСТОЕ и объяснимое вслух: если клинике нужно иначе, это
 * решается выключением лишнего в настройках, а не догадкой кода.
 */
export function dialProvider(db) {
  const settings = readSettingsRow(db);
  const creds = getCredentials(db);

  // Все линии, с которых ВООБЩЕ можно позвонить: включена и ключи на месте.
  const lines = [];
  if (settings && settings.enabled && creds && creds.key && creds.secret) {
    lines.push({ key: 'binotel', kind: 'binotel', row: null, lastCall: (settings && settings.last_call_at) || '' });
  }
  for (const p of listProviders(db)) {
    if (!p.enabled) continue;
    const full = getProviderRow(db, p.id);
    const cfg = providerConfig(full);
    const ok = (p.kind === 'onlinepbx' && normalizeDomain(cfg.domain))
            || (p.kind === 'moizvonki' && normalizeMzDomain(cfg.domain));
    if (ok) lines.push({ key: 'pbx:' + p.id, kind: p.kind, row: full, lastCall: p.last_call_at || '' });
  }
  if (!lines.length) return null;

  // 1. ВЫБОР КЛИНИКИ, если он сделан. Названа линия, которой больше нет или
  //    которую выключили — молча подставлять другую нельзя: человек думает, что
  //    звонит с одной линии, а звонит с другой. Отказ скажет об этом словами.
  const chosen = String((settings && settings.dial_provider) || '').trim();
  if (chosen) {
    const found = lines.find((l) => l.key === chosen);
    return found ? { kind: found.kind, row: found.row } : null;
  }

  // 2. Выбора нет — берём ЖИВУЮ линию: ту, по которой в журнале самый свежий
  //    звонок. Раньше здесь стояло «Binotel — главная», и в клинике с мёртвым
  //    Binotel и рабочим onlinePBX каждый звонок уходил в никуда (владелец:
  //    «why i cant call from pbx in the system?»). Свежесть журнала — проверяемый
  //    факт о том, чем клиника пользуется; старшинство — догадка.
  const live = lines.slice().sort((a, b) => String(b.lastCall || '').localeCompare(String(a.lastCall || '')))[0];
  return { kind: live.kind, row: live.row };
}

/**
 * Позвонить. Внутренний номер — сотрудника, внешний — пациента.
 *
 * @returns {Promise<{ok:true, provider:string, call_id:string}
 *                  |{ok:false, reason:string, message:string}>}
 * Не бросает НИКОГДА: отказ — это слово из словаря выше, а не исключение.
 */
export async function dialCall(db, { extension = '', phone = '' } = {}, seams = {}) {
  const { binotelDialImpl = binotelDial, pbxCallNowImpl = pbxCallNow, mzDialImpl = mzDial } = seams;

  const ext = String(extension || '').trim();

  const to = dialableNumber(phone);
  // Семь цифр — короче любого городского номера в стране; такой «телефон» в
  // карточке значит опечатку или добавочный, и набирать его станцией нельзя.
  if (to.replace(/\D+/g, '').length < 7) return fail('no_phone');

  const via = dialProvider(db);
  if (!via) return fail('no_provider');

  // ОДИН НОМЕР НА КЛИНИКУ — обычный случай, а не исключение. Владелец: «pbx
  // should have one number». У станции есть свой номер, с которого она звонит
  // наружу (настройка линии, default_extension), и у большинства сотрудников
  // личного добавочного нет и не будет. Поэтому: свой добавочный, если он есть
  // (тогда в журнале видно, кто звонил), иначе — номер линии. Отказ остаётся
  // только там, где не задано ни то ни другое.
  //
  // У «Моих Звонков» добавочных нет вовсе: там звонит смартфон сотрудника, а
  // «кто звонит» — учётная запись (владелец: «my calls for personal numbers
  // only»). Требовать добавочный там значило бы запретить звонить.
  const lineExt = via.row ? String(providerConfig(via.row).default_extension || '').trim() : '';
  const from = ext || lineExt;
  if (via.kind !== 'moizvonki' && !from) return fail('no_extension');

  if (via.kind === 'binotel') {
    const { key, secret } = getCredentials(db);
    const r = await binotelDialImpl(from, to, { key, secret });
    if (!r.ok) return fail(r.reason);
    return { ok: true, provider: 'binotel', call_id: r.call_id || '' };
  }

  const cfg = providerConfig(via.row);

  if (via.kind === 'moizvonki') {
    // MOIZVONKI_V1 — подпись запроса решает, ЧЕЙ телефон зазвонит. Пока у
    // клиники одна учётная запись на всех, звонок уходит с её телефона; когда
    // у операторов появятся свои учётки, сюда придёт имя оператора, и разбор
    // по операторам станет таким же честным, как у станций.
    const sec = providerSecrets(via.row);
    const r = await mzDialImpl(normalizeMzDomain(cfg.domain), to, {
      userName: cfg.user_name || '', apiKey: sec.api_key || '',
    });
    if (!r.ok) return fail(r.reason);
    return { ok: true, provider: 'moizvonki', call_id: r.call_id || '' };
  }

  const r = await pbxCallNowImpl(normalizeDomain(cfg.domain), from, to, pbxOptions(db, via.row));
  if (!r.ok) return fail(r.reason);
  // onlinePBX отвечает идентификатором вызова в data.data; его формат у них
  // свой, и связывать по нему журнал мы не обещаем — отдаём как есть.
  const id = r.data && (r.data.data || r.data.uuid);
  return { ok: true, provider: 'onlinepbx', call_id: id == null ? '' : String(id) };
}

function fail(reason) {
  const r = reason || 'server_error';
  return { ok: false, reason: r, message: dialMessage(r) };
}
