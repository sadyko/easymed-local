// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — чтение заявок CRM, которое нельзя
// выразить через /api/db: сравнение номера по ОДНОМУ ключу (последние девять
// цифр, phoneKey в crm-phone-match.js). В базе номер записан четырьмя способами
// («942846494», «+998…», «998…», «+998 91 566 22 78»), и фильтр реестра их не
// уравняет — поэтому правило живёт здесь, на сервере, в одном месте, и его же
// зовёт телефония (services/crm/lead-from-call.js).
//
// ЧУЖИЕ ЗАЯВКИ. Правило CRM_OWNERSHIP_V1 (schema-registry: crm_requests.scope)
// действует и здесь: оператор видит свои и ничьи, администратор — все. Для
// проверки дубля о чужих карточках сообщается только сам факт — «есть у другого
// оператора», — без имени, номера, стадии, хозяина и кнопки «Открыть».

import { leadsForPhone } from '../crm/lead-from-call.js';
import { canRead, readableColumns } from '../../db/schema-registry.js';
import { leadVisible, canSeeAllLeads } from '../crm/visibility.js';   // CRM_HEAD_MERGE_TAGS_V1
import { digitsOf, nameKey, leadMatchesQuery, phoneKey, isWholeUzPhone, uzLocalDigits, phoneLikePattern, MIN_PHONE_DIGITS }
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

/**
 * Видна ли заявка этому человеку — то же правило, что у компилятора запросов.
 * CRM_HEAD_MERGE_TAGS_V1: с базой — чтобы право `crm.all` (руководитель
 * колл-центра) открывало поиск и проверку дубля так же, как доску.
 */
export function leadVisibleTo(db, user, assignedTo, opts) {
  return leadVisible(db, user, assignedTo, opts);
}

/**
 * crm_leads_by_phone { phone } → [{ id, full_name, phone, status, stage_label,
 *   stage_kind, created_at, assigned_to, assigned_name, can_open: true }], новые
 *   сверху, и в конце — { can_open: false, foreign: true }, если у номера есть
 *   карточки, которых вызывающему видеть нельзя.
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
  // Ревью W2-M3: о чужих карточках — ТОЛЬКО факт «есть у другого оператора»,
  // одной строкой на все: ни хозяина, ни стадии, ни даты. Этого хватает, чтобы
  // не завести дубль, и не больше, чем разрешает CRM_OWNERSHIP_V1.
  const out = [];
  let foreign = false;
  const lifted = canSeeAllLeads(db, user);   // ревью I4 — один раз на запрос, а не на строку
  for (const r of rows) {
    if (!leadVisibleTo(db, user, r.assigned_to, { lifted })) { foreign = true; continue; }
    if (out.length >= 20) continue;
    out.push({
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      status: r.status,
      stage_label: r.stage_label || r.status,
      stage_kind: r.stage_kind || 'open',
      created_at: r.created_at,
      assigned_to: r.assigned_to ?? null,
      assigned_name: r.assigned_to != null ? (names.get(r.assigned_to) || '') : '',
      can_open: true,
    });
  }
  if (foreign) out.push({ can_open: false, foreign: true });
  return out;
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

  // Ревью W2-M6 — в запросе 4+ цифры: это номер, и кандидатов отбирает LIKE
  // (цифры по порядку, любые разделители между). Шаблон — те цифры, которые
  // обязаны стоять в номере при любом совпадении leadMatchesQuery: ключ целого
  // узбекского номера или местная часть набранного куска.
  const d = digitsOf(q);
  const byPhone = d.length >= MIN_PHONE_DIGITS;
  const pattern = byPhone ? phoneLikePattern(isWholeUzPhone(d) ? phoneKey(d) : uzLocalDigits(d)) : null;
  const cand = db.prepare(`
    SELECT r.id, r.full_name, r.phone, r.assigned_to, p.full_name AS patient_name
      FROM crm_requests r LEFT JOIN patients p ON p.id = r.patient_id
     ${byPhone ? 'WHERE r.phone LIKE ?' : ''}
     ORDER BY r.id DESC`).all(...(byPhone ? [pattern] : []));
  const ids = [];
  const lifted = canSeeAllLeads(db, user);   // ревью I4 — один раз на запрос, а не на строку
  for (const r of cand) {
    if (!leadVisibleTo(db, user, r.assigned_to, { lifted })) continue;
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

// ---------------------------------------------------------------------------
// CRM_HEAD_MERGE_TAGS_V1 (ревью I5) — crm_visit_links { visit_ids } →
//   [{ visit_id, request_id }]: «из какой заявки эта запись» для сетки
//   календаря (views/room-calendar.js).
//
// Строки услуг CRM теперь видны только вместе со своей заявкой (своя или ничья;
// всем — администратору и руководителю колл-центра). Но метку «колл-центр» на
// записи календаря смотрят регистратура и врачи, которые заявок не ведут, и
// почти всякая запись колл-центра сделана оператором, то есть «чужая». Метка
// нужна им как ФАКТ, поэтому отдаётся только он: номер визита и номер заявки,
// без имени, телефона, ступени и заметки. Открыть саму заявку по номеру они
// по-прежнему не могут — это решает правило доски.
// ---------------------------------------------------------------------------
const VISIT_LINKS_MAX = 500;

export function crmVisitLinks(db, args, user) {
  if (!canRead('crm_request_services', effectiveRoles(user))) {
    throw new RpcError('Заявки CRM вам недоступны.', 403);
  }
  const raw = Array.isArray(args && args.visit_ids) ? args.visit_ids : [];
  const ids = [...new Set(raw.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, VISIT_LINKS_MAX);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT visit_id, MIN(request_id) AS request_id
      FROM crm_request_services
     WHERE visit_id IN (${ids.map(() => '?').join(',')})
     GROUP BY visit_id
     ORDER BY visit_id`).all(...ids);
}
