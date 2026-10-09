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
//   • CRM_UNIFY_V1 (ревью задач 5–6, I-2) — «В ЭТОТ ДЕНЬ НЕ ПРИХОДИЛ» — ТОЛЬКО
//     ЯСНО (clearlyAbsent): в день записи (каждый, у карточки «на дату» — её
//     дата) ни у пациента, ни у карт с тем же ОСНОВНЫМ номером (phoneMatchKey,
//     последние 9 цифр: дубль карты, ребёнок на номере мамы) нет живого визита
//     с доказательством прихода (cameBy) или с ЛЮБЫМ счётом (и нулевым:
//     бесплатный повторный приём), и нет госпитализации, поступившей в этот
//     день. Ошибиться в сторону «не ставить» безопасно: карточка остаётся
//     ждать, её разберёт оператор.
//     CRM_UNIFY_V1 (финальное ревью, A-P4) — госпитализация, ОХВАТЫВАЮЩАЯ день:
//     поступил в этот день или раньше и не выписан до него (отменённая — только
//     поступившая в этот день);
//   • CRM_UNIFY_V1 (финальное ревью, A-I4) — карточка «на дату», у пациента в
//     этот день ОТМЕНЁННЫЙ визит: отменённый приём — не неявка.
// Доказательство прихода (cameBy) — отметка «Пришёл», деньги, работа, закрытые
// строки, талон, товар (arrivedByEvidence) и ещё счёт по акту и долг у кассы
// (rpc/billing.js зовёт по ним crmVisitEvidence: человек стоял у окна).
// Отменённый визит и визит «Не пришёл» доказательством не бывают никогда.
// Предоплата мешает «Не пришёл», но приходом не считается (это решает
// visit-status.js по дню визита).
//
// ДЕНЬГИ: меняется только ступень карточки. Статус визита, строки заявки,
// визиты и счета проход не трогает.
//
// CRM_UNIFY_V1 (ревью задач 5–6, I-5) — updated_at НЕ МЕНЯЕТСЯ: «Не пришёл»,
// поставленный сервером, — не контакт с пациентом. Иначе давняя карточка,
// которую проход тронул при запуске, выглядела бы свежей для окна повторного
// обращения (contact-window.js): звонок через час молча не заводил карточку, а
// посторонний приход на стойку закрывал карточку двухсотдневной давности.
//
// САМОИСПРАВЛЕНИЕ: доказательство, пришедшее позже (вчерашний визит оплатили
// сегодня, порция соседнего здания доехала через crmFromSync), поднимает «Не
// пришёл» в «Пришёл» правилом прихода (visit-status.js): по строкам и привязке
// этого визита, и (ревью, I-1) любую сидовую «Не пришёл» пациента, чей день —
// дата, ждущая строка или живая запись — этот день (liftMissed).
//
// При запуске и раз в час (server/index.js). Не бросает: ошибка — в лог.
import { openStageKeys, noShowStageKey, scheduledStageKey, SEED_NO_SHOW_STAGE } from './config.js';
import { arrivedByEvidence } from './booking-mirror.js';
import { EVIDENCE_SERVICE_STATUSES } from './visit-status.js';   // CRM_UNIFY_V1 (задача 14) — cameSurely
import { localDate, today } from '../domain/day.js';
import { phoneMatchKey } from './visit-link.js';   // CRM_UNIFY_V1 (ревью, I-2) — одно правило номера

const holes = (a) => a.map(() => '?').join(',');
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

/**
 * CRM_UNIFY_V1 (ревью задач 5–6, I-2) — «был ли пациент в клинике в этот день»
 * в ШИРОКОМ смысле: если да — «Не пришёл» неясен и не ставится. Возвращает
 * (pid, day) → boolean с кэшем на один проход. Карты с тем же основным номером
 * собираются один раз за проход (все номера карт — одним чтением), и только
 * если до них дошло.
 */
function presentOn(db) {
  const visitsOn = db.prepare(`SELECT id, status FROM visits
                                WHERE patient_id = ? AND ${localDate('visit_date')} = date(?) AND ${LIVE_VISIT_SQL}`);
  const invoiced = db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? LIMIT 1');
  // CRM_UNIFY_V1 (финальное ревью, A-P4) — госпитализация, охватывающая день.
  let admitted = null;
  try {
    const q = db.prepare(`SELECT 1 FROM admissions
                           WHERE patient_id = @id
                             AND (${localDate('admitted_at')} = date(@d)
                                  OR (status <> 'cancelled' AND ${localDate('admitted_at')} <= date(@d)
                                      AND (discharged_at IS NULL OR discharged_at = '' OR ${localDate('discharged_at')} >= date(@d))))
                           LIMIT 1`);
    admitted = { get: (id, d) => q.get({ id, d }) };
  } catch { admitted = null; }   // сборка без стационара
  const phoneOf = db.prepare('SELECT phone FROM patients WHERE id = ?');
  let byKey = null;
  const mates = (pid) => {
    const p = phoneOf.get(pid);
    const key = phoneMatchKey(p && p.phone);
    if (!key) return [pid];
    if (!byKey) {
      byKey = new Map();
      for (const r of db.prepare("SELECT id, phone FROM patients WHERE phone IS NOT NULL AND phone <> ''").all()) {
        const k = phoneMatchKey(r.phone);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(Number(r.id));
      }
    }
    return [...new Set([Number(pid), ...(byKey.get(key) || [])])];
  };
  const here = (id, d) => (admitted && !!admitted.get(id, d))
    || visitsOn.all(id, d).some((v) => cameBy(db, v) || !!invoiced.get(v.id));
  const memo = new Map();
  return (pid, d) => {
    const k = pid + '|' + d;
    if (!memo.has(k)) memo.set(k, here(pid, d) || mates(pid).some((id) => id !== Number(pid) && here(id, d)));
    return memo.get(k);
  };
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
    const cameOn = presentOn(db);
    // CRM_UNIFY_V1 (финальное ревью, A-I4) — отменённый в этот день визит пациента.
    const cancelledOn = db.prepare(`SELECT 1 FROM visits WHERE patient_id = ? AND ${localDate('visit_date')} = date(?)
                                      AND status = 'cancelled' LIMIT 1`);
    // CRM_UNIFY_V1 (ревью, I-5) — без updated_at: переход сервера — не движение карточки.
    const write = db.prepare('UPDATE crm_requests SET status = ? WHERE id = ? AND status = ?');
    db.transaction(() => {
      for (const L of leads) {
        const books = links ? bookingsOf.all(L.id, L.id) : bookingsOf.all(L.id);
        let miss;
        if (books.length) {
          miss = books.every((b) => b.day < d0 && !cameBy(db, b))
            && !books.some((b) => cameOn(L.patient_id, b.day));
        } else {
          const d = String(L.scheduled_date || '').slice(0, 10);
          miss = !!d && d < d0 && !cameOn(L.patient_id, d) && !cancelledOn.get(L.patient_id, d);
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
