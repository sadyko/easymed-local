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
