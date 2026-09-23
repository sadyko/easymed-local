// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — чтение заявок CRM, которое нельзя
// выразить через /api/db: сравнение номера по ОДНОМУ ключу (последние девять
// цифр, phoneKey в crm-phone-match.js). В базе номер записан четырьмя способами
// («942846494», «+998…», «998…», «+998 91 566 22 78»), и фильтр реестра их не
// уравняет — поэтому правило живёт здесь, на сервере, в одном месте, и его же
// зовёт телефония (services/crm/lead-from-call.js).
//
// ЧУЖИЕ ЗАЯВКИ. Правило CRM_OWNERSHIP_V1 (schema-registry: crm_requests.scope)
// действует и здесь: оператор видит свои и ничьи, администратор — все. Для
// проверки дубля чужая карточка всё-таки называется — иначе оператор завёл бы
// вторую, не зная о первой, — но без имени и номера и без кнопки «Открыть».

import { leadsForPhone } from '../crm/lead-from-call.js';
import { canRead, rowScope } from '../../db/schema-registry.js';
import { effectiveRoles } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function requireBoardRead(user) {
  if (!canRead('crm_requests', effectiveRoles(user))) {
    throw new RpcError('Заявки CRM вам недоступны.', 403);
  }
}

/** Видна ли заявка этому человеку — то же правило, что у компилятора запросов. */
export function leadVisibleTo(user, assignedTo) {
  const sc = rowScope('crm_requests');
  if (!sc) return true;
  const roles = effectiveRoles(user);
  if ((sc.allRoles || []).some((r) => roles.includes(r))) return true;
  if (assignedTo == null) return !!sc.nullVisible;
  return Number(assignedTo) === Number(user && user.id);
}

/**
 * crm_leads_by_phone { phone } → [{ id, full_name, phone, status, stage_label,
 *   stage_kind, created_at, assigned_to, assigned_name, can_open }], новые сверху.
 *
 * Спрашивает окно новой заявки ПЕРЕД вставкой: «у этого номера уже есть
 * карточка?». Все стадии — открытые и закрытые: владельцу нужно предупреждение
 * «Открыть существующую / Создать всё равно» в обоих случаях.
 */
export function crmLeadsByPhone(db, args, user) {
  requireBoardRead(user);
  const rows = leadsForPhone(db, (args && args.phone) || '');
  if (!rows.length) return [];
  const names = new Map(db.prepare(
    `SELECT id, full_name FROM users WHERE id IN (${rows.map(() => '?').join(',')})`)
    .all(...rows.map((r) => r.assigned_to ?? 0)).map((u) => [u.id, u.full_name]));
  return rows.slice(0, 20).map((r) => {
    const can = leadVisibleTo(user, r.assigned_to);
    return {
      id: r.id,
      full_name: can ? r.full_name : '',
      phone: can ? r.phone : '',
      status: r.status,
      stage_label: r.stage_label || r.status,
      stage_kind: r.stage_kind || 'open',
      created_at: r.created_at,
      assigned_to: r.assigned_to ?? null,
      assigned_name: r.assigned_to != null ? (names.get(r.assigned_to) || '') : '',
      can_open: can,
    };
  });
}
