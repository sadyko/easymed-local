// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ЗАПИСИ ПАЦИЕНТА» В КАРТОЧКЕ CRM
// ═══════════════════════════════════════════════════════════════════════════
//
// «Показывать, а не копировать» (docs/specs/2026-10-16-crm-link-all-doors-design.md,
// Revision 2): услуги записи больше не копируются в карточку строками — копии
// зеркало записи считало своими, и они оборачивались двойным счётом. Карточка
// показывает свои записи СПИСКОМ: каждый живой или прошлый визит, который она
// держит — строкой (crm_request_services.visit_id или строкой визита
// visit_service_id), привязкой записи любого вида (crm_booking_links, и «только
// для воронки» — C′, телефон, стойка), — день и время, врач, состояние и услуги
// (название, количество, статус строки). ЦЕН НЕТ: это список для колл-центра, а
// не касса. Править запись — в календаре.
//
// Состояние записи — одно из пяти, как его видят люди:
//   cancelled — отменена; no_show — «Не пришёл»; arrived — отметка «Пришёл» или
//   несомненный приход (cameSurely: работа над услугой, оплата в день визита и
//   позже); confirmed — «Подтверждён»; scheduled — «Записан».
//
// Видит тот, кто видит карточку: то же правило строк, что у /api/db для
// crm_requests (crm/visibility.js leadVisible). Чужая карточка — «не найдена»,
// без подробностей (I8). Только чтение.
//
// CRM_LINK_ALL_V1 (повторное ревью приватности, PRIV-3) — ТОЛЬКО ВИЗИТЫ ПАЦИЕНТА
// КАРТОЧКИ. Оператор перевёл карточку на другого пациента — визиты прежнего (врач,
// услуги) она больше не показывает, чем бы их ни держала (строкой, привязкой). Карточка
// без пациента записей не показывает. Привязки «только для воронки» к чужим визитам при
// смене пациента снимает сама база (миграция 246).
import { canRead } from '../../db/schema-registry.js';
import { effectiveRoles } from '../roles.js';
import { leadVisible } from '../crm/visibility.js';
import { localDate } from '../domain/day.js';
import { cameSurely } from '../crm/no-show.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Сколько записей показывает карточка (последние по дате). */
export const CARD_BOOKINGS_MAX = 60;

function stateOf(db, v) {
  if (v.status === 'cancelled') return 'cancelled';
  if (v.status === 'no_show') return 'no_show';
  if (v.status === 'arrived') return 'arrived';
  try { if (cameSurely(db, { id: v.id, status: v.status, day: v.day })) return 'arrived'; } catch { /* сборка без платежей */ }
  return v.status === 'confirmed' ? 'confirmed' : 'scheduled';
}

/**
 * crm_card_bookings { request_id } → { request_id, bookings: [{ visit_id, start, day, status,
 *   doctor: {id, name} | null, services: [{ name, quantity, status }] }] }
 */
export function crmCardBookings(db, args, user) {
  if (!canRead('crm_requests', effectiveRoles(user))) throw new RpcError('Заявки CRM вам недоступны.', 403);
  const rid = Number(args && args.request_id);
  if (!Number.isInteger(rid) || rid <= 0) throw new RpcError('Заявка не найдена.', 400);
  const lead = db.prepare('SELECT id, assigned_to, patient_id FROM crm_requests WHERE id = ?').get(rid);
  if (!lead || !leadVisible(db, user, lead.assigned_to)) throw new RpcError('Заявка не найдена.', 404);
  if (lead.patient_id == null) return { request_id: rid, bookings: [] };   // CRM_LINK_ALL_V1 (PRIV-3)

  let links = '';
  try { db.prepare('SELECT 1 FROM crm_booking_links LIMIT 1').get(); links = 'UNION SELECT visit_id FROM crm_booking_links WHERE request_id = @rid'; }
  catch { links = ''; }   // сборка без 187
  const visits = db.prepare(`
    SELECT v.id, v.status, v.visit_date, v.doctor_id, ${localDate('v.visit_date')} AS day, u.full_name AS doctor_name
      FROM visits v LEFT JOIN users u ON u.id = v.doctor_id
     WHERE v.id IN (SELECT visit_id FROM crm_request_services WHERE request_id = @rid AND status <> 'cancelled' AND visit_id IS NOT NULL
                    UNION SELECT vs.visit_id FROM crm_request_services l JOIN visit_services vs ON vs.id = l.visit_service_id
                           WHERE l.request_id = @rid AND l.status <> 'cancelled'
                    ${links})
       AND v.patient_id = @pid   -- CRM_LINK_ALL_V1 (PRIV-3) — только визиты пациента карточки
     ORDER BY v.visit_date DESC, v.id DESC
     LIMIT ${CARD_BOOKINGS_MAX}`).all({ rid, pid: lead.patient_id });
  const lines = db.prepare(`
    SELECT x.quantity, x.status, COALESCE(s.name, ct.name_ru, ct.name, '') AS name
      FROM visit_services x
      LEFT JOIN services s ON s.id = x.service_id
      LEFT JOIN consultation_types ct ON ct.id = x.consultation_type_id
     WHERE x.visit_id = ? AND x.status <> 'cancelled' AND x.clinic_item_id IS NULL
     ORDER BY x.id`);
  const bookings = visits.reverse().map((v) => ({
    visit_id: v.id,
    start: v.visit_date,
    day: v.day,
    status: stateOf(db, v),
    doctor: v.doctor_id ? { id: v.doctor_id, name: v.doctor_name || '' } : null,
    services: lines.all(v.id).map((l) => ({ name: l.name, quantity: Number(l.quantity) || 1, status: l.status })),
  }));
  return { request_id: rid, bookings };
}
