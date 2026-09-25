// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — ВИДИТ ЛИ ЧЕЛОВЕК ВСЮ ДОСКУ ЗАЯВОК.
//
// Владелец: «Руководитель колл-центра» — галочка в «Ролях» «Видит все заявки и
// передаёт их» (ключ `crm.all`) для любой роли клиники. Видит все карточки,
// передаёт их, видит показатели операторов и просроченные задачи всей команды;
// удалять карточки — только администратор.
//
// Ответ берётся из ТОГО ЖЕ правила, что сужает /api/db (schema-registry.js
// crm_requests.scope → db/row-scope.js scopeLifted): администратор по роли ИЛИ
// выданное право `crm.all`. Поэтому доска, поиск, проверка дубля, слияние,
// отчёт и показатели звонков не могут разойтись в ответе «кто видит всё».
import { rowScope } from '../../db/schema-registry.js';
import { scopeLifted } from '../../db/row-scope.js';

export const CRM_ALL_KEY = 'crm.all';

/** Администратор или обладатель права `crm.all`. */
export function canSeeAllLeads(db, user) {
  return scopeLifted(rowScope('crm_requests'), user, db);
}

/**
 * Видна ли заявка с этим хозяином — то же правило, что у компилятора запросов.
 *
 * Ревью I4: `lifted` — ответ canSeeAllLeads, посчитанный ОДИН раз на запрос.
 * Вызывающий, который перебирает сотни строк (поиск, проверка дубля), обязан
 * его передать: право читается из role_permissions несколькими запросами, и
 * на каждую строку поиск оператора становился в десятки раз медленнее.
 */
export function leadVisible(db, user, assignedTo, { lifted } = {}) {
  const sc = rowScope('crm_requests');
  if (!sc) return true;
  if (lifted === undefined ? scopeLifted(sc, user, db) : lifted) return true;
  if (assignedTo == null) return !!sc.nullVisible;
  return Number(assignedTo) === Number(user && user.id);
}
