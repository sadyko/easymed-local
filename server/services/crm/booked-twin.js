// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R7b, ДЕФЕКТ G7: ВТОРОЙ КОПИИ ЗАПИСАННОЙ УСЛУГИ НЕТ
// ═══════════════════════════════════════════════════════════════════════════
//
// Колл-центр записал пациента на сегодня в календаре (booking_lines_add) —
// строка визита 'added' стоит в смете. Пациент пришёл, регистратура оформила
// ту же консультацию (быстрая регистрация, мастер визита) — дверь /api/db
// вставила ВТОРУЮ строку той же услуги: визит держал её дважды, касса брала
// дважды. Замену строки зеркала (visit_service_auto = 1) строкой регистратуры
// делало и раньше зеркало (booking-mirror.js yieldAutoLine); строку
// booking_lines_add (зеркало связывает её с auto = 0) — не делал никто.
//
// ПРАВИЛО (одна дверь — /api/db, routes/db.js, сразу после вставки одной
// строки visit_services и ДО сверки зеркала): новая строка регистратуры Y
// занимает место строки записи X той же услуги, а X уходит. Строки заявки,
// державшие X, переходят на Y (relinkHeld). Касса видит одну строку — ту, что
// поставила регистратура (её цена, пакет, плательщик), и её id уже у экрана.
//
// X — СТРОКА ЗАПИСИ, только если всё сразу:
//   • тот же визит, своё здание (sync_origin пуст), визит до прихода или уже
//     «Пришёл»; до прихода — любой день, «Пришёл» — только сегодня;
//   • заведена раньше Y (id меньше), 'added', без счёта, без детей (результаты,
//     документы, талон), не товар — vsFree; количество 1 у обеих;
//   • та же услуга (sameService: тот же ключ; у услуги с врачом — тот же врач,
//     или у X врача нет). CRM_LINK_ALL_V1 (повторное ревью денег, S1) — правило
//     взято из public/js/shared/same-service.js: его же берут окна регистрации,
//     прицепляя свою строку к строке записи, — правило одно, и экран не пропустит
//     вторую строку, под которой сеть уберёт строку записи из его счёта. Оно равно
//     sameService зеркала во всех клетках (server/routes/crm-link-all-twin.test.js);
//   • её поставила ЗАПИСЬ: завёл пользователь «только колл-центр»
//     (isCallcenterUser — booking_lines_add), или её держит строка заявки как
//     строку зеркала (visit_service_auto = 1).
// После замены строка Y — строка регистратуры (auto = 0, завёл регистратор):
// вторая вставка той же услуги — настоящий повтор, и он остаётся вторым.
// Выставленное, оплаченное и начатое не трогается никогда. Не бросает.
import { visitRow, PRE_ARRIVAL, lineKey, isCallcenterUser, vsFree, relinkHeld, deleteVs } from './booking-mirror.js';
import { sameBookedService } from '../../../public/js/shared/same-service.js';
import { today } from '../domain/day.js';

/** Строка visit_services в форме правила «та же услуга» (shared/same-service.js). */
const lineOf = (r) => ({ serviceId: r.service_id ?? null, consultationTypeId: r.service_id == null ? (r.consultation_type_id ?? null) : null, doctorId: r.doctor_id ?? null });

function creatorIsCallcenter(db, userId) {
  if (!userId) return false;
  const u = db.prepare('SELECT role, extra_roles FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  let extra = u.extra_roles;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { extra = []; } }
  return isCallcenterUser({ role: u.role, extra_roles: Array.isArray(extra) ? extra : [] });
}

/**
 * @param {object} db
 * @param {number} vsId — только что вставленная строка visit_services (Y)
 * @returns {number|null} id ушедшей строки записи (X) или null
 */
export function retireBookedTwin(db, vsId) {
  try {
    const y = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(Number(vsId));
    if (!y || !lineKey(y) || y.status !== 'added' || y.invoice_item_id != null) return null;
    if (y.clinic_item_id != null || y.sync_origin != null || Number(y.quantity || 1) !== 1) return null;
    const v = visitRow(db, y.visit_id);
    if (!v || v.sync_origin != null) return null;
    const pre = PRE_ARRIVAL.includes(v.status);
    if (!pre && !(v.status === 'arrived' && v.day === today(db))) return null;
    const svc = y.service_id != null ? db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(y.service_id) : null;
    const needsDoctor = !!(svc && Number(svc.requires_doctor));
    const autoHeld = db.prepare(`SELECT 1 FROM crm_request_services
                                  WHERE visit_service_id = ? AND visit_service_auto = 1 AND status <> 'cancelled' LIMIT 1`);
    const x = db.prepare(`SELECT * FROM visit_services
                           WHERE visit_id = ? AND id < ? AND status = 'added' AND invoice_item_id IS NULL
                             AND clinic_item_id IS NULL AND sync_origin IS NULL AND COALESCE(quantity, 1) = 1
                           ORDER BY id`).all(v.id, y.id)
      .find((c) => sameBookedService(lineOf(c), lineOf(y), { needsDoctor }) && vsFree(db, c) && (creatorIsCallcenter(db, c.created_by) || !!autoHeld.get(c.id)));
    if (!x) return null;
    db.transaction(() => {
      relinkHeld(db, x.id, y.id);
      deleteVs(db, x.id);
    })();
    return Number(x.id);
  } catch (e) {
    console.error('[crm-twin] строка записи для', vsId, 'не разобрана:', e && e.message);   // CRM_LINK_ALL_V1
    return null;
  }
}
