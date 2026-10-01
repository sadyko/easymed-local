// LIS_INGEST_V1 — RPC для экрана «Анализаторы».
//
// Сами устройства читаются и правятся обычным /api/db: они объявлены в реестре
// схемы, и второй путь записи означал бы второй набор правил доступа. Здесь
// живёт только то, чего таблицей не выразить: перечень профилей, перезапуск
// слушателей, разбор лотка и удаление прибора (сообщения держат его внешним
// ключом — LIS_ANALYZER_LIST_V1, ревью C2).
import { listProfiles, getProfile, aliasesOf } from '../../lis/profiles/index.js';   // getProfile, aliasesOf: LIS_REAL_ANALYZERS_V1_PROFILES
import { pageInt } from './page-args.js';   // V3120_FINAL — числа и поиск из аргументов
import { startLisListeners, listenerStatus } from '../../lis/index.js';
import { ingestMessage } from '../../lis/ingest.js';
import { resolveMessage, OVERSIZE_DETAIL_PREFIX } from '../../lis/inbox.js';
import { mshOf } from '../../lis/hl7.js';   // LIS_REAL_ANALYZERS_V1_WIRE — тип и MSH-4 без исключений
import { readResult, wireFor, readEnvelope } from '../../lis/wire.js';   // LIS_REAL_ANALYZERS_V1_WIRE — тот же провод, что у приёма; readEnvelope: ревью R1, п. 6
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';
import { hasAnyRole } from '../roles.js';   // ЭФФЕКТИВНЫЕ роли, как в lab-stats.js — не голая строка user.role
import { rpcT } from '../server-message.js';   // LIS_ANALYZER_LIST_V1 (ревью C2) — отказ с названиями панелей переводится
import { today, utcDayRange } from '../domain/day.js';   // LIS_REAL_ANALYZERS_V1_SERVICE — «сегодня» местного дня клиники

class LisError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Тот же круг ролей, что правит панели: лаборатория настраивает свою технику.
 *
 * hasAnyRole, а не LAB_SECTION_ROLES.includes(user.role): у сотрудника бывает
 * несколько ролей (roles.js, effectiveRoles), и лаборант с основной ролью
 * «медсестра» и дополнительной «лаборатория» по голой строке user.role сюда не
 * проходил — получал 403 на список моделей и не мог завести прибор. Ровно так
 * это уже решено в lab-stats.js: одна дверь для всех лабораторных RPC.
 */
function guard(user) {
  if (!hasAnyRole(user, LAB_SECTION_ROLES)) throw new LisError('Недостаточно прав', 403);
}

/**
 * Профили для выпадающих списков: экран «Анализаторы» выбирает модель, а
 * редактор панелей берёт отсюда каналы для колонки «Поле анализатора».
 */
export function lisProfiles(db, args, user) {
  guard(user);
  return listProfiles().map((p) => ({
    key: p.key,
    vendor: p.vendor,
    model: p.model,
    kind: p.kind,
    transports: p.transports,
    defaultPort: p.defaultPort || 2575,
    // Откуда список каналов: экран обязан сказать лаборанту, что набор типовой,
    // а не изображать знание протокола, которого у нас нет.
    channelsSource: p.channelsSource || 'conventional',
    channels: p.channels,
    // LIS_REAL_ANALYZERS_V1_PROFILES — данные профиля для экрана: как прибор
    // может назвать себя, провод, по одному тесту в сообщении (серия), кто
    // звонит ('listen' / 'unknown') и откуда известен провод ('documented',
    // 'driver', 'siblings'; у прежних профилей — null). Прежние профили провода
    // не называют — 'default'.
    aliases: aliasesOf(p),
    wire: p.wire || 'default',
    oneTestPerMessage: !!p.oneTestPerMessage,
    connect: p.connect || 'listen',
    wireSource: p.wireSource || null,
  }));
}

/**
 * Живая лента: что приборы прислали за последнее время, ЧЬЁ это и что легло в
 * бланк.
 *
 * Экран «Анализаторы» без неё отвечает только на вопрос «настроен ли прибор».
 * Лаборанту нужен другой: «мою пробу приняли?» — а на него отвечает связка
 * «время → номер пробы → ПАЦИЕНТ → значения». Поэтому имя пациента здесь
 * обязательное поле, а не украшение: номер пробы сам по себе не говорит
 * человеку ничего.
 *
 * Значения берутся из бланка (`source = 'analyzer'`), а не из сырого сообщения:
 * показывать надо то, что РЕАЛЬНО легло, иначе лента врала бы про
 * неподтверждённые сопоставления.
 */
export function lisRecent(db, args, user) {
  guard(user);
  const limit = pageInt(args && args.limit, { def: 30, min: 1, max: 200 });   // V3120_FINAL — не число → 400, не 500

  const rows = db.prepare(`
    SELECT m.id, m.received_at, m.sample_id, m.status, m.detail, m.peer,
           m.visit_service_id, m.resolved_at,
           m.device_id,   -- LIS_REAL_ANALYZERS_V1 (экран): серия в ленте — по прибору и заказу (groupSeries)
           d.name  AS device_name,
           s.name  AS service_name,
           p.full_name AS patient_name,
           v.id    AS visit_id
      FROM lab_device_messages m
      LEFT JOIN lab_devices    d  ON d.id  = m.device_id
      LEFT JOIN visit_services vs ON vs.id = m.visit_service_id
      LEFT JOIN services       s  ON s.id  = vs.service_id
      LEFT JOIN visits         v  ON v.id  = vs.visit_id
      LEFT JOIN patients       p  ON p.id  = v.patient_id
     WHERE m.kind = 'result'   -- LIS_REAL_ANALYZERS_V1_SERVICE: утренний контроль (тридцать тестов на два уровня) не вытесняет пробы пациентов
     ORDER BY m.id DESC
     LIMIT ?`).all(limit);

  const valuesFor = db.prepare(`
    SELECT parameter, value, unit, flag
      FROM lab_results
     WHERE visit_service_id = ? AND source = 'analyzer'
     ORDER BY id`);

  return rows.map((r) => ({
    ...r,
    values: r.visit_service_id ? valuesFor.all(r.visit_service_id) : [],
  }));
}

/**
 * Перечитать устройства и поднять слушатели заново — после правки настроек.
 * Без этого клиника перезапускала бы Easy-Med целиком ради смены порта.
 */
export async function lisRestart(db, args, user) {
  guard(user);
  const running = await startLisListeners(db);
  return { ok: true, listeners: running.length };
}

/**
 * Привязать сообщение из лотка к заказу вручную.
 *
 * Номер пробы набирают руками (решение D2), значит опечатка — штатное событие,
 * а не сбой. Здесь тот же приём прогоняется повторно с номером, который назвал
 * человек: второй путь записи означал бы второй набор правил, и однажды они
 * разошлись бы.
 *
 * LIS_MINDRAY_CODES_V1 (ревью R9) — ответ `{ ok, code, status, detail }`:
 * status и detail — той строки лотка, которую приём только что записал. ACK
 * «AA» значит «принято и сохранено», а не «бланк заполнен»: по одному ему экран
 * говорил «Сообщение применено», хотя в бланке не хватало строк.
 */
export function lisMessageAttach(db, args, user) {
  guard(user);
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 10) — номера — только целое больше
  // нуля: голый Number() принимал true, «0x7b», [123] и «1e0». У заказа можно
  // с этикетки: «LAB-000123».
  const id = positiveIntArg(args && args.id);
  const vsId = positiveIntArg(args && args.visit_service_id, { label: true });
  if (!id || !vsId) throw new LisError('Нужны номер сообщения и номер заказа');

  const msg = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);
  if (!msg) throw new LisError('Сообщение не найдено', 404);

  // LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — переросшее сообщение лежит в
  // лотке обрезанным: только первые 64 КБ (mllp.js, index.js). Прогнать его
  // через приём значит положить в бланк обрезанное число — доказано: PLT «25»
  // вместо 250. Отказ, и строка лотка остаётся ждать: верное значение даст
  // только повтор пробы с прибора. Экран у такой строки «Привязать» не
  // показывает; этот отказ — для старой вкладки и прямого вызова.
  if (msg.status === 'rejected' && String(msg.detail || '').startsWith(OVERSIZE_DETAIL_PREFIX)) {
    throw new LisError('Сообщение пришло не целиком — привязать его нельзя. Попросите анализатор отправить эту пробу ещё раз.', 409);
  }

  // LIS_REAL_ANALYZERS_V1_SAMPLE — служебное сообщение (контроль качества,
  // калибровка, запрос рабочего списка) — не проба пациента: у QC BS-200 в
  // OBR-2 стоит номер теста. Привязать его к заказу значило бы положить
  // контрольный материал в бланк пациента.
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 6) — и по содержимому: строки до
  // мигр. 233 по умолчанию kind = 'result', и старый контроль качества BS-200
  // (MSH-16 = 2) или запрос рабочего списка прошли бы в бланк пациента. Вид —
  // тем же проводом, что у приёма (профиль строки и имя сообщения).
  const dev = msg.device_id ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(msg.device_id) : null;
  const head = mshOf(msg.raw);
  const env = readEnvelope(msg.raw, wireFor({ profile: dev ? getProfile(dev.profile) : null, facility: head.facility, app: head.app }));
  if ((msg.kind && msg.kind !== 'result') || env.service) {
    throw new LisError('Служебное сообщение прибора (контроль качества, калибровка или запрос) к заказу не привязывается', 409);
  }

  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 10) — строку, которую уже разобрал
  // человек или которая уже принята (applied), второй раз не прогоняем: в
  // лотке её нет, а прогон записал бы ещё одну строку и снова тронул бланк.
  if (msg.resolved_at || msg.status === 'applied') {
    throw new LisError('Сообщение уже разобрано или принято — привязать его ещё раз нельзя', 409);
  }

  // LIS_REAL_ANALYZERS_V1_SAMPLE — номер заказа уходит в приём ЯВНО
  // (sampleIdOverride), а сырое сообщение идёт как пришло (инвариант 2).
  // Раньше здесь регуляркой подменялся OBR-3, но у BS-200 номер — в OBR-2, а
  // в OBR-3 — место в штативе, и этикетка LAB- в любом поле бьёт подмену:
  // привязка ложилась бы не туда. Правила сопоставления и запреты (D4, D7) —
  // те же; правило голых цифр — нет: номер назвал человек.
  // Приём пишет ровно одну строку лотка, и better-sqlite3 синхронный: между
  // этими двумя чтениями никто другой не пишет, поэтому самая новая строка
  // после ingestMessage — его. «id > before» — страховка, а не надежда.
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM lab_device_messages').get().m;
  // LIS_ANALYZER_LIST_V1 (ревью M4) — { touch: false }: сообщение пришло
  // тогда, а нажал человек сейчас; прибор, выключенный неделю назад, после
  // разбора лотка иначе выглядел бы «на связи».
  const code = ingestMessage(db, msg.raw, msg.peer, msg.device_id, { touch: false, sampleIdOverride: vsId });
  const rec = db.prepare('SELECT status, detail FROM lab_device_messages WHERE id > ? ORDER BY id DESC LIMIT 1').get(before);
  resolveMessage(db, id);
  return { ok: code === 'AA', code, status: rec ? rec.status : null, detail: rec ? rec.detail || '' : '' };
}

/** Отклонить строку лотка: сообщение остаётся, но перестаёт требовать внимания. */
export function lisMessageDismiss(db, args, user) {
  guard(user);
  const id = Number(args && args.id);
  if (!id) throw new LisError('Нужен номер сообщения');
  const msg = db.prepare('SELECT id FROM lab_device_messages WHERE id = ?').get(id);
  if (!msg) throw new LisError('Сообщение не найдено', 404);
  resolveMessage(db, id);
  return { ok: true };
}

// LIS_MINDRAY_CODES_V1 — сколько последних сообщений читать ради списка кодов.
// Сотня покрывает любой режим прибора и не тянет месяцы гистограмм.
const CODES_SCAN_LIMIT = 100;

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — сколько начала каждого сообщения
// читать ради кодов. Коды (NM, ST, IS) идут в начале, картинки (ED, base64
// гистограмм) — в конце, и сотня проб по нескольку мегабайт разбиралась бы
// целиком ради строк, которых в «Поле анализатора» всё равно не будет.
// Столько же начала лоток хранит от переросшего сообщения (mllp.js).
const CODES_HEAD_CHARS = 64 * 1024;

/**
 * Начало сообщения для списка кодов: не больше CODES_HEAD_CHARS знаков, а у
 * сообщения длиннее — только до последнего конца сегмента (CR или LF) перед
 * границей. Оборванная строка отбрасывается: из половины сегмента вышел бы
 * код, которого прибор не присылал («777-» вместо «777-3»). База отдаёт на знак
 * больше границы — по нему и видно, что сообщение длиннее.
 */
function codesHead(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= CODES_HEAD_CHARS) return s;
  const head = s.slice(0, CODES_HEAD_CHARS);
  const cut = Math.max(head.lastIndexOf('\r'), head.lastIndexOf('\n'));
  return cut > 0 ? head.slice(0, cut) : '';
}

/**
 * Ревью R8 — номер прибора из аргументов: целое больше нуля, числом или
 * строкой из цифр (пробелы вокруг обрезаются). Всё прочее — null, и вызов
 * получает 400. Голый Number() принимал true, [1] и «0x1» за единицу — ответ
 * приходил про чужой прибор, — а 1.5, -1 и 1e308 доходили до базы и
 * возвращались 404 «не найден» вместо «вызов неверен».
 */
function deviceIdArg(v) {
  return positiveIntArg(v);
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 10) — целое больше нуля, числом или
 * строкой из цифр (пробелы вокруг обрезаются); с label — и с этикетки
 * «LAB-000123». Всё прочее — null (вызов получает 400).
 */
function positiveIntArg(v, { label = false } = {}) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) n = Number(v.trim());
  else if (label && typeof v === 'string') { const m = /^\s*LAB-(\d+)\s*$/i.exec(v); if (m) n = Number(m[1]); }
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Коды, которые прибор ДЕЙСТВИТЕЛЬНО присылал, — для «Поле анализатора» в
 * редакторе панелей (решение владельца 2026-09-28: сначала присланное, потом
 * типовой список модели, потом свой код).
 *
 * Типового списка мало: он собран со скриншотов и догадок, а Mindray пишет
 * «6690-2^WBC^LN», и кода «6690-2» в нём нет. Здесь — факт из провода.
 *
 * Приборы той же модели читаются вместе: приём принимает пробу с любого из
 * одинаковых приборов (ingest.js), значит, и коды у них одни. Картинки (ED)
 * не предлагаются — в бланк они не кладутся. Неразбираемое пропускается:
 * мусор на порту кодов не имеет.
 */
export function lisDeviceCodes(db, args, user) {
  guard(user);
  const id = deviceIdArg(args && args.device_id);
  if (!id) throw new LisError('Нужен номер прибора');
  const dev = db.prepare('SELECT id, profile FROM lab_devices WHERE id = ?').get(id);
  if (!dev) throw new LisError('Прибор не найден', 404);
  // LIS_REAL_ANALYZERS_V1_WIRE — читается тем же проводом, что у приёма: у
  // BS-200 код — номер теста (OBX-3), у Autobio по сети — OBX-4; сообщения
  // переадресателя (MSH-4 = LabPC) — проводом forwarder. Приборы одной модели
  // делят профиль, а значит, и провод.
  const profile = getProfile(dev.profile);

  const ids = dev.profile
    ? db.prepare('SELECT id FROM lab_devices WHERE profile = ?').all(dev.profile).map((r) => r.id)
    : [dev.id];
  // LIS_DISCOVERY_FIX_V1 — из базы только начало (substr), а не мегабайты
  // картинок: на знак больше границы, чтобы codesHead видел, что обрезано.
  // LIS_REAL_ANALYZERS_V1_SERVICE — только пробы (kind = 'result'): коды
  // контроля качества и калибровки в «Поле анализатора» не предлагаются.
  const rows = db.prepare(`SELECT substr(raw, 1, ?) AS head, received_at FROM lab_device_messages
                            WHERE device_id IN (${ids.map(() => '?').join(',')}) AND kind = 'result'
                            ORDER BY id DESC LIMIT ?`).all(CODES_HEAD_CHARS + 1, ...ids, CODES_SCAN_LIMIT);

  const seen = new Map();
  for (const r of rows) {
    const head = codesHead(r.head);
    // Только пробы ORU^R01 — как прежде, когда здесь стоял parseMessage:
    // мусор и неподдержанный тип кодов не имеют.
    const msh = mshOf(head);
    if (msh.type !== 'ORU^R01') continue;
    const { observations } = readResult(head, wireFor({ profile, facility: msh.facility, app: msh.app }));   // app: ревью R1, п. 11
    for (const o of observations) {
      if (o.valueType.toUpperCase() === 'ED') continue;
      if (!o.code && !o.name) continue;
      const k = (o.code + '^' + o.name).toUpperCase();
      // Строки идут от свежих к старым: первое появление — последний раз.
      // LIS_REAL_ANALYZERS_V1_WIRE — label: подпись строки (BS-200: имя теста
      // из OBX-4, «12 · GLU»), только показ: сохраняется и сравнивается код.
      if (!seen.has(k)) {
        seen.set(k, { code: o.code, name: o.name, system: o.system, value_type: o.valueType, unit: o.unit, last_at: r.received_at, label: o.label || '' });
      } else if (!seen.get(k).label && o.label) {
        seen.get(k).label = o.label;
      }
    }
  }
  return [...seen.values()];
}

/**
 * LIS_ANALYZER_LIST_V1 — какие порты слушаются прямо сейчас и какие не
 * поднялись. Экран показывает это у приборов, которые ждут первого сообщения:
 * «порт 2575 слушается» — с нашей стороны всё готово, дело в настройке прибора;
 * «порт 5100 не слушается» — его заняла другая программа.
 *
 * LIS_REAL_ANALYZERS_V1_DIAL — и dialing: соединения, которые Easy-Med держит с
 * приборами сам (lab_devices.dial = 1), — { device_id, host, port, state, since,
 * last_rx_at, code, retry_at } (lis/index.js listenerStatus). Живое состояние,
 * а не база: «подключено с 10:02 · сигнал 2 с назад», «повтор через 30 с».
 *
 * LIS_REAL_ANALYZERS_V1 (экран) — now: «сейчас» сервера (ISO, UTC). Метки
 * лотка и звонков ставит сервер, и экран меряет их его часами: часы
 * лабораторного ПК могут отставать, и серия, просроченная по серверу, иначе
 * пряталась бы в «Идёт приём результатов».
 */
export function lisListeners(db, args, user) {
  guard(user);
  return { ...listenerStatus(), now: new Date().toISOString() };   // LIS_REAL_ANALYZERS_V1 (экран) — часы сервера
}

/**
 * LIS_REAL_ANALYZERS_V1_SERVICE — служебные сообщения у прибора за сегодня
 * (местный день клиники): контроль качества, калибровка, запросы рабочего
 * списка. Таблица «Анализаторы» показывает «контроль: 12 · запросы: 40»; если
 * запросов много — подсказку выключить запрос в настройках LIS прибора: Easy-Med
 * заказов не отдаёт. Чистое чтение (READ_ONLY_RPCS); идёт по частичному индексу
 * idx_lab_device_messages_service (мигр. 233), а не по сырым пробам.
 * @returns {Array<{device_id:number, qc:number, calibration:number, query:number}>}
 *   только приборы, у которых сегодня было служебное; по номеру прибора
 */
export function lisServiceCounts(db, args, user) {
  guard(user);
  const [lo, hi] = utcDayRange(db, today(db));
  const rows = db.prepare(`SELECT device_id, kind, COUNT(*) AS n FROM lab_device_messages
                            WHERE kind <> 'result' AND device_id IS NOT NULL AND received_at >= ? AND received_at < ?
                            GROUP BY device_id, kind`).all(lo, hi);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.device_id)) by.set(r.device_id, { device_id: r.device_id, qc: 0, calibration: 0, query: 0 });
    by.get(r.device_id)[r.kind] = r.n;
  }
  return [...by.values()].sort((a, b) => a.device_id - b.device_id);
}

/**
 * LIS_ANALYZER_LIST_V1 (ревью C2) — удалить прибор.
 *
 * Экран удалял прибор голым DELETE через /api/db, и у найденного анализатора
 * это не срабатывало НИ РАЗУ: у него всегда есть сообщения, а
 * lab_device_messages.device_id и lab_panels.device_id ссылаются на
 * lab_devices без ON DELETE (мигр. 123) — SQLite отказывал по внешнему ключу.
 *
 * Панель, привязанная к прибору, — отказ с её названием, а не тихая отвязка:
 * пробы такой панели перестали бы ложиться в бланки, и лаборатория узнала бы
 * об этом от врача. Выключенная панель тоже называется — ключ держит и её.
 *
 * Сообщения прибора остаются целиком (инвариант 2): они отвязываются от
 * строки, а не удаляются. Всё — одной транзакцией; потом, как lis_restart,
 * слушатели перечитывают приборы: порт удалённого больше слушать незачем.
 */
export async function lisDeviceDelete(db, args, user) {
  guard(user);
  const id = deviceIdArg(args && args.id);
  if (!id) throw new LisError('Нужен номер прибора');

  const detached = db.transaction(() => {
    if (!db.prepare('SELECT id FROM lab_devices WHERE id = ?').get(id)) throw new LisError('Прибор не найден', 404);
    const panels = db.prepare('SELECT name FROM lab_panels WHERE device_id = ? ORDER BY name, id').all(id);
    if (panels.length) {
      const err = rpcT(LisError, 'Прибор привязан к панелям: {panels} — сначала выберите у них другой анализатор.',
        { panels: panels.map((p) => '«' + p.name + '»').join(', ') }, 409);
      err.code = 'device_in_use';   // по коду экран показывает отказ его же словами
      throw err;
    }
    const n = db.prepare('UPDATE lab_device_messages SET device_id = NULL WHERE device_id = ?').run(id).changes;
    db.prepare('DELETE FROM lab_devices WHERE id = ?').run(id);
    return n;
  })();

  await startLisListeners(db);
  return { ok: true, detached };
}
