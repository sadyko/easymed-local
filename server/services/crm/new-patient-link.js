// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — НОВАЯ КАРТА НАХОДИТ ЗАЯВКУ КОЛЛ-ЦЕНТРА
// (RPC crm_link_new_patient)
// ═══════════════════════════════════════════════════════════════════════════
//
// Колл-центр записывает человека, у которого карты ещё нет: заявка без
// пациента, строки на день прихода. Регистратура заводит карту, и смета
// (pendingCrmLines в crm-lines.js — заявки ПО patient_id) обязана сразу
// увидеть записанные услуги. Раньше это делал браузер (linkCrmRequestsToPatient
// в data.js): все открытые заявки с номером, без проверки «номер у одной карты»
// и только среди карточек, видимых регистратору. Теперь — сервер, по правилу
// шага записи (visit-link.js, шаг D), сразу после вставки карты (savePatient).
//
// ПРАВИЛО:
//   • карта заведена ЗДЕСЬ и только что (не старше NEW_PATIENT_MINUTES): это
//     дверь для новой карты, а не проход по давним;
//   • номер — по ОДНОМУ строгому правилу шага записи (visit-link.js, ревью 3,
//     финальное ревью): ОСНОВНОЙ номер карты — целый узбекский номер без букв,
//     ключ — последние 9 цифр (phoneMatchKey); второй номер заявок не ищет
//     (обычно это номер родственника);
//   • ключ у ОДНОЙ карты — владельцы считаются с запасом, по всем номерам карт,
//     экстренному контакту, опекунам и связям опекунства (patientIdsWithPhoneKey):
//     общий семейный номер не отдаёт заявку никому;
//   • у карты ещё нет ни одной заявки — повторный вызов не проходит номер
//     частями, по заявке за раз;
//   • ОДНА заявка: ЕДИНСТВЕННАЯ ОТКРЫТАЯ без пациента с тем же ключом (две и
//     больше — семья на одном номере: ни одной), и её имя, если есть, — имя
//     или фамилия карты (soleMatchingLead, финальное ревью A-C1). Два номера
//     в поле и добавочный автоматически не связываются.
//     Закрытая («Пришёл», «Отказ», «Не пришёл») — история, её не трогают;
//   • пишется ТОЛЬКО patient_id (и updated_at, как у всякой правки карточки):
//     ни ступени, ни строк, ни visit_id, ни привязки записи. Деньги карточка
//     ведёт только с записью — шагом связи визита.
//
// ВНЕ ВИДИМОСТИ ТОГО, КТО РЕГИСТРИРУЕТ, И НИЧЕГО НАРУЖУ: ответ всегда
// { ok: true } — ни номера, ни имени, ни числа заявок, ни даже того, нашлась ли
// она. Звать вправе тот, кто вправе заводить пациентов (то же правило, что у
// вставки в patients через /api/db).

import { canWrite } from '../../db/schema-registry.js';
import { writeGrantAllows, writeGrantNarrows } from '../../db/write-grant.js';
import { effectiveRoles } from '../roles.js';
import { openStageKeys } from './config.js';
// CRM_UNIFY_V1 (ревью 3 задачи 1) — номер, отбор заявок и владельцы — одно
// строгое правило с шагом записи (visit-link.js).
// CRM_UNIFY_V1 (финальное ревью, A-C1) — и заявка по номеру — то же правило
// (soleMatchingLead): единственная на ключ, имя подходит карте.
import { soleMatchingLead } from './visit-link.js';

/** Сколько минут карта считается только что заведённой. */
export const NEW_PATIENT_MINUTES = 10;

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/**
 * Может ли человек заводить пациентов — правило вставки в patients из
 * компилятора запросов (query-compiler.js, mayWrite): роль из реестра, если
 * своя роль клиники её не сужает, или право плитки.
 */
export function mayCreatePatient(db, user) {
  if (!user) return false;
  if (canWrite('patients', 'insert', effectiveRoles(user))) return !writeGrantNarrows('patients', user, db, 'insert');
  return writeGrantAllows('patients', 'insert', user, db);
}

/**
 * crm_link_new_patient { patient_id } → { ok: true }.
 * Связать только что заведённую карту с заявкой колл-центра по номеру.
 */
export function crmLinkNewPatient(db, args, user) {
  if (!mayCreatePatient(db, user)) throw new RpcError('Недостаточно прав для этого действия.', 403);
  const pid = Number(args && args.patient_id);
  if (!Number.isInteger(pid) || pid <= 0) throw new RpcError('Пациент не найден.', 400);
  db.transaction(() => linkNewPatient(db, pid))();
  return { ok: true };
}

function linkNewPatient(db, pid) {
  const p = db.prepare(`SELECT id, phone FROM patients
                         WHERE id = ? AND sync_origin IS NULL
                           AND julianday(created_at) >= julianday('now', '-${NEW_PATIENT_MINUTES} minutes')`).get(pid);
  if (!p) return;
  if (db.prepare('SELECT 1 FROM crm_requests WHERE patient_id = ? LIMIT 1').get(pid)) return;
  const open = openStageKeys(db);
  if (!open.length) return;
  // CRM_UNIFY_V1 (финальное ревью, A-C1) — единственная заявка на ключ номера,
  // с подходящим именем, владельцы ключа — ровно {эта карта}.
  const hit = soleMatchingLead(db, pid, open);
  if (!hit) return;
  db.prepare(`UPDATE crm_requests SET patient_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ? AND patient_id IS NULL`).run(pid, hit);
}
