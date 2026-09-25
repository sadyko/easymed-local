// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — КТО ВИДИТ ВСЕ СТРОКИ ТАБЛИЦЫ С ВЛАДЕЛЬЦЕМ.
//
// Ограничение по владельцу (CRM_OWNERSHIP_V1, schema-registry `scope`) снимали
// только РОЛИ из кода: `allRoles: ['admin']`. Руководитель колл-центра — это не
// роль, а ПРАВО, которое клиника выдаёт своей роли галочкой в «Настройки →
// Роли» (`crm.all`, справочник public/js/shared/permission-catalog.js). Поэтому
// у правила появилась вторая половина:
//   allGrant — ключ справочника; кому он выдан на «Изменение», тот видит всё.
//
// ОДИН ОТВЕТ НА ВСЮ ПРОГРАММУ. Этот предикат зовут компилятор запросов (доска,
// список, выгрузка, правка и удаление через /api/db), поиск и проверка дубля
// (rpc/crm-leads.js), слияние дублей, показатели звонков и отчёт колл-центра —
// через services/crm/visibility.js canSeeAllLeads. Второго описания «кто видит
// всё» появиться не должно: разойдись они — руководитель видел бы карточку на
// доске и не находил её поиском.
//
// Без базы (вызов компилятора без контекста — старые тесты, служебные пути)
// право не читается, и правило остаётся самым узким: по ролям из кода.
import { effectiveRoles } from '../services/roles.js';
import { grantAllows } from '../services/grants.js';

/** Снято ли ограничение по владельцу для этого человека. */
export function scopeLifted(sc, user, db) {
  if (!sc) return true;
  const roles = effectiveRoles(user);
  if ((sc.allRoles || []).some((r) => roles.includes(r))) return true;
  if (!sc.allGrant || !db) return false;
  try {
    return grantAllows(db, user, sc.allGrant, 'edit', sc.allRoles || []);
  } catch {
    return false;   // права не прочитались — самый узкий доступ, а не весь
  }
}
