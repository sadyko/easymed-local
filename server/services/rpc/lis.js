// LIS_INGEST_V1 — RPC для экрана «Анализаторы».
//
// Сами устройства читаются и правятся обычным /api/db: они объявлены в реестре
// схемы, и второй путь записи означал бы второй набор правил доступа. Здесь
// живёт только то, чего таблицей не выразить: перечень профилей, перезапуск
// слушателей, разбор лотка и удаление прибора (сообщения держат его внешним
// ключом — LIS_ANALYZER_LIST_V1, ревью C2).
import { listProfiles } from '../../lis/profiles/index.js';
import { pageInt } from './page-args.js';   // V3120_FINAL — числа и поиск из аргументов
import { startLisListeners, listenerStatus } from '../../lis/index.js';
import { ingestMessage } from '../../lis/ingest.js';
import { resolveMessage } from '../../lis/inbox.js';
import { parseMessage } from '../../lis/hl7.js';   // LIS_MINDRAY_CODES_V1 — тот же разбор, что у приёма
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';
import { hasAnyRole } from '../roles.js';   // ЭФФЕКТИВНЫЕ роли, как в lab-stats.js — не голая строка user.role
import { rpcT } from '../server-message.js';   // LIS_ANALYZER_LIST_V1 (ревью C2) — отказ с названиями панелей переводится

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
  const id = Number(args && args.id);
  const vsId = Number(args && args.visit_service_id);
  if (!id || !vsId) throw new LisError('Нужны номер сообщения и номер заказа');

  const msg = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);
  if (!msg) throw new LisError('Сообщение не найдено', 404);

  // Подменяется ТОЛЬКО номер пробы в OBR-3; всё остальное сообщение идёт как
  // пришло, поэтому применяются те же правила сопоставления и те же запреты.
  const retagged = msg.raw.replace(/^(OBR\|[^|]*\|[^|]*\|)[^|]*/m, '$1' + vsId);
  // Приём пишет ровно одну строку лотка, и better-sqlite3 синхронный: между
  // этими двумя чтениями никто другой не пишет, поэтому самая новая строка
  // после ingestMessage — его. «id > before» — страховка, а не надежда.
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM lab_device_messages').get().m;
  const code = ingestMessage(db, retagged, msg.peer, msg.device_id);
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

/**
 * Ревью R8 — номер прибора из аргументов: целое больше нуля, числом или
 * строкой из цифр (пробелы вокруг обрезаются). Всё прочее — null, и вызов
 * получает 400. Голый Number() принимал true, [1] и «0x1» за единицу — ответ
 * приходил про чужой прибор, — а 1.5, -1 и 1e308 доходили до базы и
 * возвращались 404 «не найден» вместо «вызов неверен».
 */
function deviceIdArg(v) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) n = Number(v.trim());
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

  const ids = dev.profile
    ? db.prepare('SELECT id FROM lab_devices WHERE profile = ?').all(dev.profile).map((r) => r.id)
    : [dev.id];
  const rows = db.prepare(`SELECT raw, received_at FROM lab_device_messages
                            WHERE device_id IN (${ids.map(() => '?').join(',')})
                            ORDER BY id DESC LIMIT ?`).all(...ids, CODES_SCAN_LIMIT);

  const seen = new Map();
  for (const r of rows) {
    let msg;
    try { msg = parseMessage(r.raw); } catch { continue; }
    for (const o of msg.observations) {
      if (o.valueType.toUpperCase() === 'ED') continue;
      if (!o.code && !o.name) continue;
      const k = (o.code + '^' + o.name).toUpperCase();
      // Строки идут от свежих к старым: первое появление — последний раз.
      if (!seen.has(k)) {
        seen.set(k, { code: o.code, name: o.name, system: o.system, value_type: o.valueType, unit: o.unit, last_at: r.received_at });
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
 */
export function lisListeners(db, args, user) {
  guard(user);
  return listenerStatus();
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
