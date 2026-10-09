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
// CRM_UNIFY_V1 — canEditCrm живёт здесь (перенесён из crm/booking-mirror-db.js):
// правило «может вести карточку» (crm/tasks-follow.js) зовёт его, а
// booking-mirror-db.js сам зовёт tasks-follow.js — нейтральный модуль
// разрывает круг импорта.
import { grantAllowsOr } from '../grants.js';
import { sectionLevel } from '../roles.js';

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
/**
 * V3120_FIX — может ли человек ВЕСТИ заявки. Роль с «CRM: просмотр» видит
 * доску, но не ведёт её. Настроенный ключ «crm» (матрица прав) — его уровень;
 * не настроенный — прежний уровень раздела (sections/levels): только явный
 * «просмотр» закрывает запись. Ненастроенная роль пишет, как и раньше, — по
 * списку ролей реестра. Зовут дверь /api/db (crm/booking-mirror-db.js) и
 * правило «может вести карточку» (crm/tasks-follow.js, CRM_UNIFY_V1).
 */
export function canEditCrm(db, user) {
  try {
    // CRM_UNIFY_V1 (финальное ревью) — РАЗДЕЛ CRM ДОЛЖЕН БЫТЬ ВЫДАН. Ненастроенный
    // ключ решает то же правило, что меню (permissions.js isModuleAllowed('crm')):
    // раздел «crm» есть в правах роли (своя роль клиники заменяет основу,
    // ненастроенная своя — права основы, дополнительные роли прибавляются —
    // sectionLevel) и это не «просмотр». Прежде роль БЕЗ раздела (уровень null)
    // считалась ведущей заявки: ей предлагали задачи и отдавали карточки, а
    // экрана CRM у неё нет. Администратор проходит, как прежде (grantAllowsOr);
    // штатные регистратура (editor) и колл-центр (admin) — тоже: раздел им выдан
    // сидом прав.
    return grantAllowsOr(db, user, 'crm', 'edit', () => {
      const lvl = sectionLevel(db, user, 'crm');   // null — раздела нет
      return lvl != null && lvl !== 'viewer';
    });
  } catch {
    return true;   // права не прочитались — решает реестр, как до этой проверки
  }
}

export function leadVisible(db, user, assignedTo, { lifted } = {}) {
  const sc = rowScope('crm_requests');
  if (!sc) return true;
  if (lifted === undefined ? scopeLifted(sc, user, db) : lifted) return true;
  if (assignedTo == null) return !!sc.nullVisible;
  return Number(assignedTo) === Number(user && user.id);
}
