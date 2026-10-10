// CRM_CONFIG_V1 — RPC для настроек CRM-канбана: колонки, источники и
// маршрутизация звонков (миграция 077, services/crm/config.js).
//
// Why RPC and not /api/db: saving the board is not "update these rows". It is
// one transaction with rules the query endpoint cannot express — exactly one
// conversion column, at least one visible column, a column with leads may be
// hidden but not deleted. Через /api/db эти правила пришлось бы проверять в
// браузере, то есть не проверять вовсе.

import { grantAllowsAdminOr } from '../grants.js';   // ADMIN_ROWS_GRANTABLE_V1
import { crmConfig, saveConfig, CrmConfigError } from '../crm/config.js';
import { withTemplate } from '../server-message.js';   // CRM_UNIFY_V1 — фраза с числом переводится на экране

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Saving reshapes the board for everyone in the clinic at once, so it is
// admin-only. hasAnyRole, not user.role: an admin whose PRIMARY role is doctor
// (ADMIN_DOCTOR_V1) must not be locked out of a settings screen.
//
// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — СОХРАНЕНИЕ ВЫДАЁТСЯ ИЗ «РОЛЕЙ» (ключ
// `settings.crm`): «Изменение» добавляет, переименовывает, скрывает и
// переставляет колонки, источники и метки; «Удаление» ещё и убирает их (не
// прислать существующий ключ в целом списке — это и есть удаление). Колонку
// или источник с заявками по-прежнему удалить нельзя никому (config.js).
// Ненастроенный ключ — как вчера: только администратор.
const CRM_KEY = 'settings.crm';
function requireLevel(db, user, need) {
  if (!grantAllowsAdminOr(db, user, CRM_KEY, need)) {
    throw new RpcError(need === 'delete'
      ? 'Удалять колонки, источники и метки может роль с «CRM-канбан: Удаление». Скройте их вместо удаления или попросите администратора.'
      : 'Настройки CRM-канбана недоступны вашей роли. Права выдаёт администратор в «Настройки → Роли».', 403);
  }
}

// Удаляет ли сохранение хоть одну существующую строку списка. CLINIC_API_STEP7_V1 —
// `kept(x)`: строки, которые сохранение не удаляет, даже если их не прислали
// (свой источник подключения API, services/crm/config.js).
function removesAny(current, sent, kept = null) {
  if (!Array.isArray(sent)) return false;
  const keep = new Set(sent.map((x) => x && x.key).filter(Boolean));
  return (current || []).some((x) => x && x.key && !keep.has(x.key) && !(kept && kept(x)));
}

/**
 * Everything the board AND the settings screen need, in one call.
 *
 * No role guard beyond being logged in, on purpose: this is the vocabulary the
 * kanban is drawn from — column names and colours, not clinical data. The
 * board is ALL_STAFF (schema-registry.js), and an operator who could see the
 * cards but not their column labels would be looking at a broken screen.
 *
 * @returns {{stages: object[], sources: object[], routing: object[]}}
 */
export function crmConfigGet(db) {
  return crmConfig(db);
}

/**
 * Saves whichever of the three lists the screen sent, in one transaction.
 *
 * args: { stages?: [{key,label,color,kind,is_active}], — WHOLE ordered array
 *         sources?: [{key,label,is_active}],           — WHOLE ordered array
 *         tags?: [{key,label,color,is_active}],        — WHOLE ordered array (CRM_HEAD_MERGE_TAGS_V1, may be empty)
 *         routing?: [{provider?,disposition,action,stage_key}], — upsert only
 *         settings?: {booked_stage?, won_stage?, window_hours?} } — CRM_UNIFY_V1:
 *           «Колонка записи», «Колонка конверсии (пришёл)» (перенос вида won
 *           одной транзакцией) и окно повторного обращения; уровень — тот же
 *           «CRM-канбан: Изменение», что у колонок (по умолчанию — администратор)
 *
 * Always answers with the full config, never just what was posted: hiding a
 * column switches the routing rules that fed it off, and a screen redrawing
 * only its own card would show the owner a stale routing table.
 */
export function crmConfigSave(db, args, user) {
  requireLevel(db, user, 'edit');
  const a = args || {};
  const cur = crmConfig(db);
  if (removesAny(cur.stages, a.stages) || removesAny(cur.sources, a.sources, (x) => !!(x.api && x.api.owned)) || removesAny(cur.tags, a.tags)) {
    requireLevel(db, user, 'delete');
  }
  try {
    // CRM_UNIFY_V1 — кто сохранил (crm_settings.changed_by) — вошедший, а не тело запроса.
    return saveConfig(db, a, { actorId: user && Number(user.id) > 0 ? Number(user.id) : null });
  } catch (e) {
    // config.js speaks in whole Russian sentences with a status already on
    // them — the screen shows them verbatim, so they must not be re-wrapped
    // into a generic "bad request" (telephony's SettingsError pattern).
    if (e instanceof CrmConfigError) {
      const err = new RpcError(e.message, e.status);
      // CRM_UNIFY_V1 — собранная фраза («В колонке «X» карточек: N…») едет
      // шаблоном и значениями: экран переводит шаблон (V3120_I18N).
      throw e.template ? withTemplate(err, e.template, e.params) : err;
    }
    throw e;
  }
}
