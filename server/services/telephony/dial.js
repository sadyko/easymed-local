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
 * AUTO_EXTENSION_V1 (2026-09-17) — ЧЬЮ ТРУБКУ ПОДНИМАТЬ, ЕСЛИ НИКТО НЕ СКАЗАЛ.
 *
 * Владелец: «я не знаю какой включен, прошу сделай так чтобы пользователь только
 * настроил авторизацию и это сработало».
 *
 * Знать, какой аппарат сейчас в сети, клиника не обязана — и не может: софтфон
 * закрыли, компьютер уснул, человек ушёл на обед. Список внутренних номеров у
 * станции спросить можно, но кто из них ЖИВ прямо сейчас — она не говорит.
 *
 * Зато это знает СОБСТВЕННЫЙ журнал звонков клиники: если с номера недавно
 * разговаривали, значит аппарат на нём был подключён. Поэтому кандидаты — это
 * внутренние номера, которые реально отвечали за последние две недели, от
 * самого свежего к более старым: сверху тот, кто работает сегодня.
 *
 * Дальше dialCall пробует их по очереди, пока станция не примет вызов. Это
 * никого не беспокоит: отказ «нет подключённого телефона» приходит ДО того, как
 * кому-либо позвонили.
 */
export function candidateExtensions(db, limit = 6) {
  try {
    return db.prepare(`
      SELECT internal_number AS ext, MAX(started_at) AS last_at
        FROM calls
       WHERE internal_number <> ''
         AND length(internal_number) BETWEEN 2 AND 5
         AND internal_number GLOB '[0-9]*'
         AND billsec > 0
         AND started_at > datetime('now', '-14 day')
       GROUP BY internal_number
       ORDER BY last_at DESC
       LIMIT ?`).all(limit).map((r) => String(r.ext));
  } catch (e) {
    // Журнала может не быть вовсе (новая установка) — это не повод падать.
    return [];
  }
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
  // СТАНЦИИ НАБИРАЮТ ЦИФРЫ, А НЕ «+». Плюс — это способ ЗАПИСАТЬ номер, а не
  // набрать его: в собственном журнале onlinePBX номера лежат без него
  // («998771050404»), и примеры набора у Binotel тоже без. Мы же храним номера
  // пациентов в виде «+998 …», и именно этот плюс уезжал на станцию, когда
  // звонили из карточки. Убираем ровно на границе с телефонией — внутри
  // программы номер остаётся таким, каким его видит человек.
  const dial = to.replace(/\D+/g, '');
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
  // ПОРЯДОК ПОПЫТОК. Сначала то, что назвали люди: свой добавочный оператора
  // (тогда в журнале видно, кто звонил), потом номер линии из настроек. И
  // только если их нет или на них некому снять трубку — живые номера из
  // собственного журнала клиники. Настройка остаётся главнее догадки, но её
  // отсутствие больше не мешает позвонить.
  const tried = [];
  for (const cand of [ext, lineExt, ...candidateExtensions(db)]) {
    const v = String(cand || '').trim();
    if (v && !tried.includes(v)) tried.push(v);
  }
  if (via.kind !== 'moizvonki' && !tried.length) return fail('no_extension');

  // Одна попытка набора с конкретной трубки; ответ драйвера отдаётся как есть.
  const attempt = async (fromExt) => {
    if (via.kind === 'binotel') {
      const { key, secret } = getCredentials(db);
      return binotelDialImpl(fromExt, dial, { key, secret });
    }
    const c = providerConfig(via.row);
    return pbxCallNowImpl(normalizeDomain(c.domain), fromExt, dial, pbxOptions(db, via.row));
  };

  // ПЕРЕБИРАЕМ ТОЛЬКО ПО ОДНОЙ ПРИЧИНЕ: «на этом номере нет подключённого
  // телефона». Прочие отказы (неверный ключ, нет связи, запрещены исходящие)
  // повторять восемь раз бессмысленно и вредно — это стук в дверь вендора без
  // единого шанса на успех.
  const NO_DEVICE = /no registered user|no push token|not registered/i;
  if (via.kind !== 'moizvonki') {
    let last = null;
    for (const fromExt of tried) {
      const r = await attempt(fromExt);
      if (r.ok) {
        const id = via.kind === 'binotel' ? (r.call_id || '') : ((r.data && (r.data.data || r.data.uuid)) || '');
        // `from` возвращается наверх: оператор должен знать, какая трубка сейчас
        // зазвонит, особенно когда номер выбрала программа, а не человек.
        return { ok: true, provider: via.kind, call_id: String(id || ''), from: fromExt };
      }
      last = r;
      if (!NO_DEVICE.test(String(r.comment || ''))) break;
    }
    return fail(last ? last.reason : 'server_error', last ? last.comment : '');
  }

  const cfg = providerConfig(via.row);

  {
    // MOIZVONKI_V1 — подпись запроса решает, ЧЕЙ телефон зазвонит. Пока у
    // клиники одна учётная запись на всех, звонок уходит с её телефона; когда
    // у операторов появятся свои учётки, сюда придёт имя оператора, и разбор
    // по операторам станет таким же честным, как у станций.
    const sec = providerSecrets(via.row);
    const r = await mzDialImpl(normalizeMzDomain(cfg.domain), dial, {
      userName: cfg.user_name || '', apiKey: sec.api_key || '',
    });
    if (!r.ok) return fail(r.reason, r.comment);
    return { ok: true, provider: 'moizvonki', call_id: r.call_id || '' };
  }
}

// ЧТО СТАНЦИЯ СКАЗАЛА — ПО-РУССКИ И ПО ДЕЛУ.
//
// onlinePBX отвечает по-английски и терминами, которые регистратуре ничего не
// говорят. Здесь переводятся те ответы, которые клиника реально видит, — с
// указанием, что делать. Незнакомый ответ показывается как есть: чужой текст
// лучше пустоты.
const STATION_SAID = [
  [/no registered user and no push token/i,
   'На этом внутреннем номере сейчас нет подключённого телефона: аппарат выключен, либо приложение АТС закрыто. Включите телефон оператора или укажите в настройках другой внутренний номер.'],
  [/not found|no such user|unknown user/i,
   'Станция не знает такого внутреннего номера. Проверьте номер в настройках телефонии.'],
  [/denied|forbidden|not allowed/i,
   'Станция не разрешает исходящие с этого номера. Откройте их в панели onlinePBX для этой учётной записи.'],
  [/no gate|no trunk|gate not found/i,
   'У станции не выбрана линия для исходящих звонков. Укажите её в панели onlinePBX.'],
];

function stationSaid(comment) {
  const said = String(comment || '').trim();
  if (!said) return '';
  for (const [re, ru] of STATION_SAID) if (re.test(said)) return ru;
  return 'Станция ответила: ' + said.slice(0, 160);
}

function fail(reason, comment = '') {
  const r = reason || 'server_error';
  const said = stationSaid(comment);
  // ПОРЯДОК ВАЖЕН, и вот почему. Если ответ станции удалось ПЕРЕВЕСТИ (мы знаем
  // эту причину), он и есть ответ: он точнее нашей общей фразы и говорит, что
  // делать. Если перевести не удалось, впереди идёт НАША фраза — оператор
  // читает по-русски, — а чужой текст остаётся в скобках для того, кто будет
  // разбираться: «Телефония не приняла ключ доступа… (станция: Wrong api key)».
  // Раньше здесь оставался только английский, и владелец справедливо спросил:
  // «what is this?»
  const known = said && said !== 'Станция ответила: ' + String(comment || '').trim().slice(0, 160);
  if (known) return { ok: false, reason: r, message: said };
  const raw = String(comment || '').trim().slice(0, 120);
  return { ok: false, reason: r, message: raw ? `${dialMessage(r)} (станция: ${raw})` : dialMessage(r) };
}
