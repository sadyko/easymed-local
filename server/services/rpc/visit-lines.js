// LIVE_AUDIT_FIX_V1 — remove_own_visit_line: ВРАЧ СНИМАЕТ СВОЮ НЕВЫСТАВЛЕННУЮ УСЛУГУ.
//
// Кабинет врача («Услуги приёма» → крестик, service-workspace.js
// removeOwnService) удалял строку visit_services напрямую через /api/db. Реестр
// даёт удаление строк визита только администратору и регистратуре, поэтому у
// врача отказ глотался молча: строка исчезала из списка кабинета, но оставалась
// в визите и в счёте — пациенту выставляли услугу, которую врач снял.
//
// Правило живёт здесь одним местом, а удаление строк визита через /api/db
// остаётся за стойкой. Снять можно только:
//   • СВОЮ строку — врач-исполнитель (doctor_id) или тот, кто её завёл
//     (created_by). Администратор и регистратура снимают любую — ровно то,
//     что им и так разрешает реестр;
//   • НЕ ВЫСТАВЛЕННУЮ — без invoice_item_id (выставленную снимают отменой
//     счёта в кассе);
//   • НЕ НАЧАТУЮ — status 'added' (начатая работа — уже история приёма);
//   • УСЛУГУ, а не выданный товар (clinic_item_id): товар возвращается на склад
//     void_dispensed_visit_item, иначе остаток разойдётся;
//   • БЕЗ ДОКУМЕНТОВ И РЕЗУЛЬТАТОВ по строке.
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'doctor'];
const ANY_LINE_ROLES = ['admin', 'registrar'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Строки, которые держат услугу: с ними строка уже не «просто добавлена».
const CHILDREN = [
  ['lab_results', 'по услуге уже есть результаты анализа'],
  ['visit_documents', 'по услуге уже есть документ'],
  ['lab_device_messages', 'по услуге уже пришли данные анализатора'],
];

export function removeOwnVisitLine(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Снимать услугу с визита может врач, регистратура или администратор.', 403);
  const id = Number(args && args.visit_service_id);
  if (!isPosInt(id)) throw new RpcError('visit_service_id must be a positive integer.', 400);
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
    if (!row) throw new RpcError('Услуга визита не найдена.', 404);
    if (!hasAnyRole(user, ANY_LINE_ROLES)) {
      const mine = Number(row.doctor_id) === Number(user.id) || Number(row.created_by) === Number(user.id);
      if (!mine) throw new RpcError('Снять можно только свою услугу.', 403);
    }
    if (row.invoice_item_id != null) throw new RpcError('Услуга уже в счёте — снимите её отменой счёта в кассе.', 400);
    if (row.status !== 'added') throw new RpcError('Работа по услуге уже начата — снять её нельзя.', 400);
    if (row.clinic_item_id != null) throw new RpcError('Это выданный товар — верните его через «Вернуть на склад».', 400);
    for (const [table, why] of CHILDREN) {
      let has = false;
      try { has = !!db.prepare(`SELECT 1 FROM ${table} WHERE visit_service_id = ? LIMIT 1`).get(id); }
      catch { has = false; }   // таблицы нет в этой сборке — держать нечему
      if (has) throw new RpcError('Снять нельзя: ' + why + '.', 400);
    }
    try { db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(id); } catch { /* нет таблицы */ }
    db.prepare('DELETE FROM visit_services WHERE id = ?').run(id);
    return { removed: true, id };
  });
  return run();
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE_AUDIT_FIX_V1 — visit_set_referral_source: ИСТОЧНИК НАПРАВЛЕНИЯ ВИЗИТА
// ═══════════════════════════════════════════════════════════════════════════
//
// Вкладка «Детали» окна визита сохраняла источник направления обычным UPDATE
// через /api/db, а visits.referral_source_id там не пишется (реестр,
// VISITS_ONE_DOOR_V1): поле молча выбрасывалось, и окно говорило «Visit saved».
// Ставится источник визита при записи (ensure_visit) и автоматически
// (visit_set_doctor_referrer); поправить его руками — работа стойки: те же
// роли, что правят источник в карте пациента (patients.update — admin,
// registrar). null — «никто не направлял».
const REFERRAL_ROLES = ['admin', 'registrar'];

export function visitSetReferralSource(db, args, user) {
  if (!hasAnyRole(user, REFERRAL_ROLES)) {
    throw new RpcError('Источник направления визита меняют регистратура или администратор.', 403);
  }
  const visitId = Number(args && args.visit_id);
  if (!isPosInt(visitId)) throw new RpcError('visit_id must be a positive integer.', 400);
  const raw = args ? args.referral_source_id : undefined;
  if (raw === undefined) throw new RpcError('referral_source_id is required (null — никто не направлял).', 400);
  const sourceId = raw === null || raw === '' ? null : Number(raw);
  if (sourceId !== null && !isPosInt(sourceId)) throw new RpcError('referral_source_id must be a positive integer or null.', 400);
  const run = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM visits WHERE id = ?').get(visitId)) throw new RpcError('Визит не найден.', 404);
    if (sourceId !== null && !db.prepare('SELECT 1 FROM referral_sources WHERE id = ?').get(sourceId)) {
      throw new RpcError('Источник направления не найден.', 400);
    }
    db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = ?').run(sourceId, visitId);
    return { visit_id: visitId, referral_source_id: sourceId };
  });
  return run();
}
