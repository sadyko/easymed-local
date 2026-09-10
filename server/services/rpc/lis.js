// LIS_INGEST_V1 — RPC для экрана «Анализаторы».
//
// Сами устройства читаются и правятся обычным /api/db: они объявлены в реестре
// схемы, и второй путь записи означал бы второй набор правил доступа. Здесь
// живёт только то, чего таблицей не выразить: перечень профилей, перезапуск
// слушателей и разбор лотка.
import { listProfiles } from '../../lis/profiles/index.js';
import { startLisListeners } from '../../lis/index.js';
import { ingestMessage } from '../../lis/ingest.js';
import { resolveMessage } from '../../lis/inbox.js';
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';

class LisError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Тот же круг ролей, что правит панели: лаборатория настраивает свою технику. */
function guard(user) {
  if (!user || !LAB_SECTION_ROLES.includes(user.role)) throw new LisError('Недостаточно прав', 403);
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
  const limit = Math.min(Math.max(Number((args && args.limit) || 30), 1), 200);

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
  const code = ingestMessage(db, retagged, msg.peer, msg.device_id);
  resolveMessage(db, id);
  return { ok: code === 'AA', code };
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
