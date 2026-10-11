// PUBLIC_API_V1 — RPC ЗАЯВОК И ОНЛАЙН-ЗАПИСИ ИЗ API: окно «Онлайн-запись через
// API» в карточке CRM (список, карты-кандидаты, «Подтвердить запись»,
// «Предложить другое время», «Отклонить», «Взять в работу»), строки онлайн-записи
// на доске и состояние обмена для экрана «API и подключения».
//
// ВОРОТА — ТЕ ЖЕ, ЧТО У КАРТОЧКИ CRM: видит заявку тот, кому /api/db отдаёт её
// карточку (compile — тот же отбор строк: оператор колл-центра — свои и ничьи);
// решает — тот, кто может править карточку (admin, регистратура, колл-центр —
// schema-registry crm_requests.update). Отдельной строки в «Ролях» нет: это
// работа с карточкой заявки.
//
// Лицензия: чтения — в READ_ONLY_RPCS (control/gate.js); решения — записи
// (при блокировке 402). Филиал: заявки из API живут в главном здании — решения
// в филиале 409.
import { compile } from '../../db/query-compiler.js';
import { hasAnyRole } from '../roles.js';
import { grantAllowsAdminOr } from '../grants.js';
import { getDataDir } from '../control/config.js';
import { canEditCrm } from '../crm/visibility.js';   // ревью 8a, I2 — тот же запрет «CRM: просмотр», что у /api/db
import { API_BOOKING_MESSAGES as MSG } from '../../../public/js/shared/api-booking.js';
import {
  requestRow, requestsOfCard, cardCandidates, boardMarks, confirmBooking, offerOtherTime, declineBooking, acceptRequest,
} from '../api/bookings.js';
import { syncStatus, wakePublicSync } from '../api/public-sync.js';
import { RPC_MESSAGES as API_RPC_MESSAGES } from './api-connections.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const WRITE_ROLES = Object.freeze(['admin', 'registrar', 'callcenter']);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Карточки из списка, которые /api/db отдал бы этому человеку. */
function visibleCards(db, user, ids) {
  const list = [...new Set(ids.map(posInt).filter(Boolean))];
  if (!list.length) return new Set();
  try {
    const sel = compile({ table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'in', val: list }] }, user, { db });
    return new Set(db.prepare(sel.sql).all(...sel.params).map((r) => r.id));
  } catch { return new Set(); }
}
function requireCard(db, user, crmRequestId) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  if (!crmRequestId || !visibleCards(db, user, [crmRequestId]).has(crmRequestId)) throw new RpcError(MSG.noAccess, 403);
}
function requireWriter(db, user, crmRequestId) {
  requireCard(db, user, crmRequestId);
  if (!hasAnyRole(user, WRITE_ROLES)) throw new RpcError(MSG.noEdit, 403);
  // Ревью 8a, I2: роль с CRM «Просмотр» (уровень раздела или строка матрицы)
  // /api/db править карточку не даёт (V3120_FIX) — решения по заявке тоже нет.
  if (!canEditCrm(db, user)) throw new RpcError(MSG.noEdit, 403);
  try {
    compile({ table: 'crm_requests', op: 'update', values: { note: '' }, filters: [{ col: 'id', op: 'eq', val: crmRequestId }] }, user, { db });
  } catch { throw new RpcError(MSG.noEdit, 403); }
}
function requireMain(db) {
  try {
    const i = db.prepare('SELECT role FROM branch_identity WHERE id = 1').get();
    if (i && i.role === 'secondary') throw new RpcError(MSG.mainOnly, 409);
  } catch (e) { if (e instanceof RpcError) throw e; }
}
/** Заявка и проверка её карточки — для решений. */
function forDecision(db, args, user) {
  requireMain(db);
  const row = requestRow(db, args && args.id);
  requireWriter(db, user, row.crm_request_id);
  return row;
}

/** Может ли человек решать по заявкам этой карточки здесь (главное здание, право править карточку). */
function mayDecide(db, user, crmRequestId) {
  try { requireMain(db); requireWriter(db, user, crmRequestId); return true; } catch { return false; }
}

export function apiBookingList(db, args, user) {
  const id = posInt(args && args.crm_request_id);
  requireCard(db, user, id);
  // Ревью 8a, I2: кнопки решений — только тому, кому сервер их разрешит; прочие
  // (медсестра, врач, «CRM: просмотр», филиал) видят заявку без кнопок.
  return { items: requestsOfCard(db, id, Date.now(), { decide: mayDecide(db, user, id) }) };
}

export function apiBookingCandidates(db, args, user) {
  const row = requestRow(db, args && args.id);
  requireCard(db, user, row.crm_request_id);
  return { items: cardCandidates(db, row.id) };
}

export async function apiBookingConfirm(db, args, user) {
  const row = forDecision(db, args, user);
  const out = await confirmBooking(db, { id: row.id, patientId: args && args.patient_id }, user);
  wakePublicSync();
  return { id: row.id, status: out.request.status, visit_id: out.visit.id, visit_date: out.visit.visit_date,
    already: !!out.already, ...(out.cross_branch ? { cross_branch: out.cross_branch } : {}) };
}

export function apiBookingOffer(db, args, user) {
  const row = forDecision(db, args, user);
  const out = offerOtherTime(db, { id: row.id, start: args && args.start, patientId: args && args.patient_id }, user);
  wakePublicSync();
  return { id: out.id, status: out.status, offered_start: out.offered_start, offer_until: out.offer_until };
}

export function apiBookingDecline(db, args, user) {
  const row = forDecision(db, args, user);
  const out = declineBooking(db, { id: row.id, reason: args && args.reason }, user);
  wakePublicSync();
  return { id: out.id, status: out.status, decline_reason: out.decline_reason };
}

export function apiRequestAccept(db, args, user) {
  const row = forDecision(db, args, user);
  const out = acceptRequest(db, { id: row.id }, user);
  wakePublicSync();
  return { id: out.id, status: out.status };
}

/** Строки онлайн-записи на карточках доски — только у карточек, которые человек видит. */
export function apiBoardMarks(db, _args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  const all = boardMarks(db);
  const seen = visibleCards(db, user, Object.keys(all));
  const marks = {};
  for (const [k, v] of Object.entries(all)) if (seen.has(Number(k))) marks[k] = v;
  return { marks };
}

/** Состояние обмена с публичным сервером — экрану «API и подключения» (строка «API: Просмотр» или администратор). */
export function apiSyncStatus(db, _args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.api', 'view')) throw new RpcError(API_RPC_MESSAGES.noAccess, 403);
  return syncStatus(db, getDataDir());
}
