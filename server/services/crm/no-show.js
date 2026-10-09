// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — «НЕ ПРИШЁЛ» СТАВИТ СЕРВЕР (Р11)
// ═══════════════════════════════════════════════════════════════════════════
//
// Дизайн: «запись прошла, визит не начат, не оплачен, не отмечен». Раньше это
// делал браузер при каждой загрузке доски (views/crm.js CRM_AUTO_NOSHOW_V1) по
// дате карточки: колонку «записан» он угадывал первой видимой и уносил
// «Перезвонить», оплаты не видел, записи календаря без строк пропускал.
//
// ПРАВИЛО — ТОЛЬКО ОДНОЗНАЧНЫЕ СЛУЧАИ:
//   • только в сидовую «Не пришёл» — как отметка «Не пришёл» в календаре
//     (visit-status.js): первая проигрышная колонка может быть «Отказ»;
//   • только карточки С ПАЦИЕНТОМ и только из «Колонки записи» и дальше
//     (scheduledStageKey — одно правило с экраном, crm-booked-stage.js).
//     «Перезвонить», всё до «Колонки записи» и карточки без пациента — работа
//     оператора, их проход не трогает никогда. Закрытые (конверсия, проигрышные)
//     — тем более: после смены «Колонки конверсии» история идёт за ролью
//     (config.js saveCrmSettings), прежняя конверсия пустая;
//   • карточка ЕЩЁ ЖДЁТ — не трогается: её дата сегодня или позже, или ждущая
//     строка на сегодня или позже;
//   • карточка С ЗАПИСЬЮ (живой визит держат её ждущие строки или привязка
//     crm_booking_links): все живые записи в прошлом, ни у одной нет
//     доказательства прихода, и в эти дни пациент не пришёл другим визитом
//     (в том числе в соседнем здании);
//   • карточка «НА ДАТУ» без живой записи: дата прошла, и в этот день у
//     пациента нет визита с доказательством прихода.
// Доказательство прихода (cameBy) — отметка «Пришёл», деньги, работа, закрытые
// строки, талон, товар (arrivedByEvidence) и ещё счёт по акту и долг у кассы
// (rpc/billing.js зовёт по ним crmVisitEvidence: человек стоял у окна).
// Отменённый визит и визит «Не пришёл» доказательством не бывают никогда.
// Предоплата мешает «Не пришёл», но приходом не считается (это решает
// visit-status.js по дню визита).
//
// ДЕНЬГИ: меняется только ступень карточки (и updated_at — серверный переход
// это движение карточки, Р2). Статус визита, строки заявки, визиты и счета
// проход не трогает.
//
// САМОИСПРАВЛЕНИЕ: доказательство, пришедшее позже (вчерашний визит оплатили
// сегодня, порция соседнего здания доехала через crmFromSync), поднимает «Не
// пришёл» в «Пришёл» правилом прихода (visit-status.js): карточку с записью — по
// строкам и привязке, карточку «на дату» — settleLineless по дню визита.
//
// При запуске и раз в час (server/index.js). Не бросает: ошибка — в лог.
import { openStageKeys, noShowStageKey, scheduledStageKey, SEED_NO_SHOW_STAGE } from './config.js';
import { arrivedByEvidence } from './booking-mirror.js';
import { EVIDENCE_SERVICE_STATUSES } from './visit-status.js';   // CRM_UNIFY_V1 (задача 14) — cameSurely
import { localDate, today } from '../domain/day.js';

const holes = (a) => a.map(() => '?').join(',');
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
// Мёртвый визит доказательством не бывает (visit-status.js DEAD_VISIT_STATUSES).
const LIVE_VISIT_SQL = "status NOT IN ('cancelled', 'no_show')";

/**
 * Был ли пациент на этом (живом) визите: отметка, деньги, работа, акт, долг.
 * ШИРОКО — для «Не пришёл»: любой намёк на приход (и предоплата) мешает
 * объявить неявку. CRM_UNIFY_V1 (задача 14) — экспорт; рядом его строгая пара
 * cameSurely для разового исправления.
 */
export function cameBy(db, v) {
  if (v.status === 'arrived') return true;
  if (arrivedByEvidence(db, v.id)) return true;
  try {
    return !!db.prepare("SELECT 1 FROM invoices WHERE visit_id = ? AND (payer_id IS NOT NULL OR status = 'debt') LIMIT 1").get(v.id);
  } catch { return false; }   // сборка без 054
}

/**
 * CRM_UNIFY_V1 (задача 14) — НЕСОМНЕННЫЙ приход на этом живом визите дня v.day:
 * СТРОГАЯ пара cameBy — чтобы ПЕРЕВЕСТИ карточку в конверсию (разовое
 * исправление, crm/unify-repair.js). Ошибка здесь объявила бы конверсией того,
 * кто не приходил, поэтому считается только то, что бывает лишь с человеком в
 * клинике в день визита или позже:
 *   • отметка «Пришёл» (calendar_book);
 *   • работа над услугой (EVIDENCE_SERVICE_STATUSES: проба, приём, результат);
 *   • платёж, сделанный в день визита или позже, по счёту, который не
 *     возвращён (paid_amount > 0) и не аннулирован — предоплата не приход;
 *   • счёт по акту или долг у кассы, выставленный в день визита или позже —
 *     акт мастер визита выставляет и при записи, на будущие дни.
 * Не считается (в отличие от cameBy): предоплата, товар и талон очереди (их
 * ставят и заранее), закрытые строки заявки ('done' ставила и прежняя запись,
 * до прихода), неоплаченный счёт. Визит соседнего здания считается, как и в
 * cameBy, — по тем же признакам, приехавшим с порцией обмена (статус визита,
 * строки визита, счёт и платежи).
 */
export function cameSurely(db, v) {
  if (v.status === 'arrived') return true;
  const marks = EVIDENCE_SERVICE_STATUSES.map(() => '?').join(',');
  if (db.prepare(`SELECT 1 FROM visit_services WHERE visit_id = ? AND status IN (${marks}) LIMIT 1`)
    .get(v.id, ...EVIDENCE_SERVICE_STATUSES)) return true;
  if (db.prepare(`SELECT 1 FROM invoices i JOIN payments p ON p.invoice_id = i.id
                   WHERE i.visit_id = ? AND i.paid_amount > 0 AND i.status NOT IN ('void', 'refunded')
                     AND p.amount > 0 AND ${localDate('p.paid_at')} >= date(?) LIMIT 1`).get(v.id, v.day)) return true;
  try {
    return !!db.prepare(`SELECT 1 FROM invoices
                          WHERE visit_id = ? AND (payer_id IS NOT NULL OR status = 'debt') AND status NOT IN ('void', 'refunded')
                            AND ${localDate('created_at')} >= date(?) LIMIT 1`).get(v.id, v.day);
  } catch { return false; }   // сборка без 054
}

/** Один проход. Возвращает id карточек, ушедших в «Не пришёл». */
export function crmNoShowSweep(db, { day = null } = {}) {
  const moved = [];
  try {
    if (noShowStageKey(db) !== SEED_NO_SHOW_STAGE) return moved;
    const open = openStageKeys(db);
    const booked = scheduledStageKey(db);
    const waiting = booked && open.includes(booked) ? open.slice(open.indexOf(booked)) : [];
    if (!waiting.length) return moved;
    const d0 = day || today(db);
    // Кандидаты: с пациентом, из «Колонки записи» и дальше, ничего не ждут впереди.
    const leads = db.prepare(`
      SELECT r.id, r.status, r.patient_id, r.scheduled_date FROM crm_requests r
       WHERE r.status IN (${holes(waiting)}) AND r.patient_id IS NOT NULL
         AND NOT (r.scheduled_date IS NOT NULL AND r.scheduled_date <> '' AND date(r.scheduled_date) >= date(?))
         AND NOT EXISTS (SELECT 1 FROM crm_request_services l
                          WHERE l.request_id = r.id AND l.status = 'pending' AND date(l.scheduled_date) >= date(?))`)
      .all(...waiting, d0, d0);
    if (!leads.length) return moved;
    let links = true;
    try { db.prepare('SELECT 1 FROM crm_booking_links LIMIT 1').get(); } catch { links = false; }   // сборка без 187
    const bookingsOf = db.prepare(`
      SELECT v.id, v.status, ${localDate('v.visit_date')} AS day FROM visits v
       WHERE v.id IN (SELECT visit_id FROM crm_request_services
                       WHERE request_id = ? AND status = 'pending' AND visit_id IS NOT NULL
                      ${links ? 'UNION SELECT visit_id FROM crm_booking_links WHERE request_id = ?' : ''})
         AND v.${LIVE_VISIT_SQL}`);
    const dayVisits = db.prepare(`SELECT id, status FROM visits
                                   WHERE patient_id = ? AND ${localDate('visit_date')} = date(?) AND ${LIVE_VISIT_SQL}`);
    const cameOn = (pid, d) => dayVisits.all(pid, d).some((x) => cameBy(db, x));
    const write = db.prepare(`UPDATE crm_requests SET status = ?, updated_at = ${NOW_SQL} WHERE id = ? AND status = ?`);
    db.transaction(() => {
      for (const L of leads) {
        const books = links ? bookingsOf.all(L.id, L.id) : bookingsOf.all(L.id);
        let miss;
        if (books.length) {
          miss = books.every((b) => b.day < d0 && !cameBy(db, b))
            && !books.some((b) => cameOn(L.patient_id, b.day));
        } else {
          const d = String(L.scheduled_date || '').slice(0, 10);
          miss = !!d && d < d0 && !cameOn(L.patient_id, d);
        }
        if (miss && write.run(SEED_NO_SHOW_STAGE, L.id, L.status).changes) moved.push(L.id);
      }
    })();
  } catch (e) {
    console.error('[crm-no-show] проход не выполнен:', e && e.message);
    return [];
  }
  return moved;
}

/** При запуске и раз в час. Таймер unref: остановке сервера не мешает. */
export function scheduleCrmNoShow(db, { everyMs = 3600 * 1000 } = {}) {
  crmNoShowSweep(db);
  const h = setInterval(() => crmNoShowSweep(db), everyMs);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
}
