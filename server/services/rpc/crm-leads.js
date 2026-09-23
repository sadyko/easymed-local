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
import { canRead, rowScope, readableColumns } from '../../db/schema-registry.js';
import { digitsOf, nameKey, leadMatchesQuery, MIN_PHONE_DIGITS }
  from '../../../public/js/admin/views/crm-phone-match.js';
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

// ---------------------------------------------------------------------------
// crm_search { q, limit? } — поиск по ВСЕМ заявкам, а не по загруженным.
//
// Доска грузит последние 800 заявок (views/crm.js load()), и в базе клиники
// 1 191 карточка старше их не находилась поиском никогда. Правило совпадения —
// то же, что у доски (leadMatchesQuery в crm-phone-match.js): номер по цифрам
// с одним ключом, имя — без учёта пробелов, и имя привязанного пациента.
//
// Ответ — строки ТОЙ ЖЕ формы, что отдаёт доске /api/db:
//   crm_requests.* (читаемые колонки) + patients {id, full_name, mrn} |
//   users {full_name} (оператор) | services {id, name, price}; новые сверху.
// Чужие заявки оператору не отдаются (CRM_OWNERSHIP_V1), как и через /api/db.
// ---------------------------------------------------------------------------
const SEARCH_LIMIT = 200;

export function crmSearch(db, args, user) {
  requireBoardRead(user);
  const q = String((args && args.q) || '').trim().slice(0, 100);
  // Одна буква находит полбазы — это не поиск, а выгрузка.
  if (digitsOf(q).length < MIN_PHONE_DIGITS && nameKey(q).length < 2) return [];
  const limit = Math.max(1, Math.min(SEARCH_LIMIT, Number(args && args.limit) || SEARCH_LIMIT));

  const cand = db.prepare(`
    SELECT r.id, r.full_name, r.phone, r.assigned_to, p.full_name AS patient_name
      FROM crm_requests r LEFT JOIN patients p ON p.id = r.patient_id
     ORDER BY r.id DESC`).all();
  const ids = [];
  for (const r of cand) {
    if (!leadVisibleTo(user, r.assigned_to)) continue;
    if (!leadMatchesQuery(r, q)) continue;
    ids.push(r.id);
    if (ids.length >= limit) break;
  }
  if (!ids.length) return [];

  const cols = readableColumns('crm_requests').map((c) => `r."${c}"`).join(', ');
  const rows = db.prepare(`
    SELECT ${cols},
           p.id AS _p_id, p.full_name AS _p_name, p.mrn AS _p_mrn,
           u.full_name AS _u_name,
           s.id AS _s_id, s.name AS _s_name, s.price AS _s_price
      FROM crm_requests r
      LEFT JOIN patients p ON p.id = r.patient_id
      LEFT JOIN users    u ON u.id = r.assigned_to
      LEFT JOIN services s ON s.id = r.service_id
     WHERE r.id IN (${ids.map(() => '?').join(',')})
     ORDER BY r.id DESC`).all(...ids);
  return rows.map((x) => {
    const { _p_id, _p_name, _p_mrn, _u_name, _s_id, _s_name, _s_price, ...row } = x;
    row.patients = _p_id != null ? { id: _p_id, full_name: _p_name, mrn: _p_mrn } : null;
    row.users = _u_name != null ? { full_name: _u_name } : null;
    row.services = _s_id != null ? { id: _s_id, name: _s_name, price: _s_price } : null;
    return row;
  });
}
