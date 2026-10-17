// ═══════════════════════════════════════════════════════════════════════════
// CRM_ONE_WAY_V1 (2026-10-17) — УСЛУГИ ЗАПИСИ ЖИВУТ ТОЛЬКО В ВИЗИТЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «Fix the root first», после отмены — «Back to the card, no date».
// Спецификация — docs/specs/2026-10-17-crm-one-way-booking-design.md (O1–O10),
// план — docs/plans/2026-10-17-crm-one-way.md.
//
// До этого файла услуга записи жила ДВАЖДЫ: строкой карточки (crm_request_services)
// и строкой визита (visit_services), а зеркало записи (booking-mirror.js mirrorVisit,
// CRM_CALENDAR_MIRROR_V1) гоняло копии туда и обратно. Отмена, восстановление и
// перенос то удваивали счёт (M1, M2, C1, двойники CRM_TWIN_LINE), то теряли услугу
// (M8). Теперь направление одно:
//
//   • ЖЕЛАНИЕ — строка карточки без визита (visit_id и visit_service_id пусты):
//     услуга, может быть день и врач — то, что записал колл-центр;
//   • СТРОКА ЗАПИСИ — строка карточки, которая указывает на ОДНУ строку визита
//     (visit_id + visit_service_id). Две карточки могут указывать на одну строку
//     визита (сайт и звонок про одну консультацию) — счёт по ней один;
//   • СТРОКА ВИЗИТА — единственное место, где услуга записи есть для денег,
//     календаря, кассы и врача.
//   • ОТПУЩЕННОЕ ЖЕЛАНИЕ — запись отменили (O4) или её строку визита сняли в другом
//     окне (O3): строка карточки без дня, без визита, с отметкой
//     released_from_visit_id (миграция 246). Сама она ни в какой визит не садится,
//     пока оператор не назначит ей день или не запишет снова (правка снимает отметку).
//
// visit_service_auto = 1 (миграция 187) — строку визита завела CRM под это желание
// (O1). Такая строка, пока свободна, уступает место строке человека той же услуги
// (wishYields, сеть R7b crm/booked-twin.js, pruneAutoLinesOnInvoice): желание не
// даёт второй строки рядом со строкой той же услуги ни тогда, когда приходит первым,
// ни тогда, когда вторым.
//
// НИКАКОЙ ПУТЬ CRM НЕ ВСТАВЛЯЕТ, НЕ УДАЛЯЕТ И НЕ ПРАВИТ СТРОКУ ВИЗИТА, кроме O1 (одна
// строка на желание, и её уступка строке человека) и O3 (карточка сама добавила или
// убрала свободную строку своей записи). Отсюда в карточку ничего не копируется (O2):
// услуги визита карточка показывает списком «Записи пациента» (rpc/crm-card-bookings.js).
//
// НЕ БРОСАЕТ, кроме bookedLineEditRefusal (его текст — отказ двери /api/db): CRM не
// вправе отказать ни в записи, ни в строке сметы. Ошибка — в лог.
import {
  visitRow, PRE_ARRIVAL, lineKey, vsFree, visitHasWork, insertBookingLine, bookingLineRefusal,
  relinkHeld, deleteVs, requestOfVisit, sameService, touchRequest, beforeArrival, repriceOwnLine,
} from './booking-mirror.js';
import { openStageKeys, SEED_NO_SHOW_STAGE } from './config.js';
import { sameBookedService } from '../../../public/js/shared/same-service.js';

const holes = (a) => a.map(() => '?').join(',');
const ids = (a) => [...new Set((a || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/** Строка в форме правила «та же услуга» (public/js/shared/same-service.js). */
const lineOf = (r) => ({
  serviceId: r.service_id ?? null,
  consultationTypeId: r.service_id == null ? (r.consultation_type_id ?? null) : null,
  doctorId: r.doctor_id ?? null,
});

function needsDoctorOf(db, row) {
  if (row.service_id == null) return true;   // консультация по виду приёма — всегда с врачом
  const s = db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(row.service_id);
  return !!(s && Number(s.requires_doctor));
}

/**
 * O1 — строка визита `x` — та же услуга, что желание `wish`: то же правило, что у сети
 * R7b и окон регистрации (sameBookedService; равно sameService зеркала во всех клетках —
 * server/routes/crm-link-all-twin.test.js). Желание без врача — та же услуга у любого врача.
 */
export function sameAsWish(db, wish, x) {
  return sameBookedService(lineOf(wish), lineOf(x), { needsDoctor: needsDoctorOf(db, wish) });
}

/**
 * O1 — КУДА ЖЕЛАНИЕ САДИТСЯ В ВИЗИТЕ v, НЕ ЗАВОДЯ ВТОРОЙ СТРОКИ:
 *   1. строка той же услуги, на которую не указывает ни одна живая строка карточки
 *      (её поставила регистратура, колл-центр в календаре, касса — раньше нас);
 *   2. строка той же услуги, на которую уже указывают живые строки карточек — и другой
 *      (вторая карточка того же человека на ту же консультацию), и ЭТОЙ ЖЕ (два одинаковых
 *      желания, карточки после слияния, отпущенное желание, которому назначили день записи
 *      той же услуги): счёт один. Прежнее правило зеркала (homeFor); «две строки одной
 *      карточки — две услуги» пробовали (e0e6f44e) и вернули (9140fbe6): два одинаковых
 *      желания давали 300 000 вместо 150 000. Два анализа одного дня ставит регистратура —
 *      строками визита, а не желаниями;
 * null — нужна новая строка.
 */
export function wishHome(db, v, line) {
  const rows = db.prepare(`SELECT * FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'
                              AND clinic_item_id IS NULL ORDER BY id`).all(v.id)
    .filter((x) => lineKey(x) && sameAsWish(db, line, x));
  if (!rows.length) return null;
  const holders = db.prepare("SELECT id, request_id FROM crm_request_services WHERE visit_service_id = ? AND status <> 'cancelled' AND id <> ?");
  const free = rows.find((x) => !holders.all(x.id, line.id).length);
  return Number((free || rows[0]).id);
}

const POINT = `UPDATE crm_request_services
                  SET visit_id = ?, visit_service_id = ?, visit_service_auto = ?, scheduled_date = ?,
                      released_from_visit_id = NULL, released_vs_id = NULL
                WHERE id = ?`;

/**
 * O1 — ЖЕЛАНИЕ БЕРЁТ ВИЗИТ. Указывает на строку той же услуги (wishHome) или заводит
 * ровно одну строку визита 'added' (цена — правилом регистратуры и кассы, auto = 1).
 * Хирургию, снятое с продажи и выключенный вид приёма в запись не ставит (то же правило,
 * что у booking_lines_add): желание остаётся желанием. Визит соседнего здания строк не
 * получает (BRANCH_MONEY_GUARD_V1) — желание только указывает на уже приехавшую строку.
 * Старая ссылка строки на строку отменённого визита (отмена до CRM_ONE_WAY_V1)
 * перезаписывается: строка отменённого визита остаётся там, где была, — она история.
 * Разбор ревью (I5) — визит ДО ПРИХОДА, по которому уже выставлен счёт или начата работа:
 * строки визита ведёт касса, и новую строку желание сюда не ставит (только указывает на
 * готовую) — она сядет при приходе (attachHeldLines). Пришедшему визиту — ставит: касса
 * видит её в «Ждут счёта».
 * Зовётся внутри транзакции звонящего. @returns {number|null} id строки визита
 */
export function attachWish(db, v, line, { actorId = null, arrival = false } = {}) {
  if (!v || !line || !lineKey(line)) return null;
  let vsId = wishHome(db, v, line);
  let auto = 0;
  if (!vsId) {
    if (v.sync_origin != null) return null;
    if (!arrival && beforeArrival(db, v) && visitHasWork(db, v.id)) return null;   // I5 — до прихода при счёте строки ставит касса
    if (bookingLineRefusal(db, { serviceId: line.service_id, consultationTypeId: line.consultation_type_id })) return null;
    vsId = insertBookingLine(db, {
      visit: v, serviceId: line.service_id, consultationTypeId: line.consultation_type_id,
      doctorId: line.doctor_id, createdBy: actorId,
    });
    auto = 1;
  }
  db.prepare(POINT).run(v.id, vsId, auto, v.day, line.id);
  return vsId;
}

/**
 * O1 — несколько желаний в один визит, по порядку строк. holdUnplaced (шаг связи) — строка,
 * которой в визит садиться нечем (без услуги) или нельзя (хирургия, снятое с продажи), всё
 * равно держит визит (visit_id, без строки визита), как держала до CRM_ONE_WAY_V1: карточка
 * знает свой записанный день, а приход такую строку не закрывает — она ждёт (правило 'done').
 * @returns {number} сколько строк взяли визит
 */
export function attachWishes(db, v, lines, { holdUnplaced = false, ...opts } = {}) {
  let n = 0;
  const hold = db.prepare('UPDATE crm_request_services SET visit_id = ?, visit_service_id = NULL WHERE id = ?');
  for (const l of lines || []) {
    if (attachWish(db, v, l, opts)) { n++; continue; }
    if (holdUnplaced && v.sync_origin == null) { hold.run(v.id, l.id); n++; }
  }
  return n;
}

/**
 * O1 — СТРОКИ, КОТОРЫЕ ДЕРЖАТ ВИЗИТ БЕЗ СТРОКИ ВИЗИТА (visit_id есть, visit_service_id
 * пуст): так их оставляло зеркало до CRM_ONE_WAY_V1, когда визит уже пришёл или был при
 * счёте, — и ставило в визит при приходе (placeHeldLines). Здесь то же самое правилом O1:
 * при приходе (crm/visit-status.js) такая строка садится в визит. Новых таких строк не
 * бывает: шаг связи сажает желание сразу. Не бросает.
 */
export function attachHeldLines(db, visitId, { actorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!v || (!PRE_ARRIVAL.includes(v.status) && v.status !== 'arrived')) return 0;
    const lines = db.prepare(`SELECT * FROM crm_request_services
                               WHERE visit_id = ? AND status = 'pending' AND visit_service_id IS NULL ORDER BY id`).all(v.id);
    if (!lines.length) return 0;
    return db.transaction(() => attachWishes(db, v, lines, { actorId, arrival: true }))();   // приход: и при счёте
  } catch (e) {
    console.error('[crm-one-way] строки, державшие визит', visitId, 'не сели в визит:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

// ─── O1: строка желания уступает строке человека ───────────────────────────

/** Живая строка карточки этого визита, державшая СТРОКУ CRM (auto = 1) той же услуги, что `x`. */
function autoLineFor(db, V, x) {
  return db.prepare(`SELECT * FROM crm_request_services
                      WHERE visit_id = ? AND status <> 'cancelled'
                        AND visit_service_auto = 1 AND visit_service_id IS NOT NULL AND visit_service_id <> ?
                      ORDER BY id`).all(V, x.id).find((l) => sameService(db, l, x));
}

/**
 * Строка CRM уступает место строке визита `x` (её поставил человек): строки карточек
 * переходят на `x` (все — её могут делить две карточки), свободная строка CRM уходит.
 * false — строка CRM уже не свободна (счёт, работа) или не этого визита.
 */
function yieldAutoLine(db, V, x, auto) {
  const old = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(auto.visit_service_id);
  if (!old || old.visit_id !== V || !vsFree(db, old)) return false;
  db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 0 WHERE id = ?').run(x.id, auto.id);
  relinkHeld(db, old.id, x.id);
  deleteVs(db, old.id);
  return true;
}

/**
 * O1 (вторым) — СТРОКА ЖЕЛАНИЯ УСТУПАЕТ СТРОКЕ ЧЕЛОВЕКА. В визит своего здания (до
 * прихода или «Пришёл») встала строка, на которую не указывает ни одна строка карточки
 * (регистратура, касса — в смету или сразу в счёт), а рядом свободная строка, которую
 * CRM завела под желание той же услуги: вторая строка — двойной счёт. Желание теперь
 * указывает на строку человека (её количество, пакет, цена), строка CRM уходит. Прежнее
 * правило зеркала (yieldAutoLine / replaceAutoTwins) — без копирования. Не бросает.
 * @returns {number} сколько строк CRM уступило
 */
export function wishYields(db, visitId) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || (!PRE_ARRIVAL.includes(v.status) && v.status !== 'arrived')) return 0;
    return db.transaction(() => {
      let n = 0;
      const getVs = db.prepare('SELECT id FROM visit_services WHERE id = ?');
      const referenced = db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ? LIMIT 1');
      for (const x of db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(v.id)) {
        if (!getVs.get(x.id)) continue;   // уступила место выше в этом же проходе
        if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null || x.status === 'cancelled') continue;
        if (referenced.get(x.id)) continue;
        const auto = autoLineFor(db, v.id, x);
        if (auto && yieldAutoLine(db, v.id, x, auto)) n++;
      }
      return n;
    })();
  } catch (e) {
    console.error('[crm-one-way] строки визита', visitId, 'не разобраны:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

/**
 * CRM_UNIFY_V1 (финальное ревью, A-C2) · CRM_ONE_WAY_V1 — ЖЕЛАНИЕ СБЫЛОСЬ. В визит встала
 * строка человека `x`, а у живой карточки, которая держит этот визит (строкой записи или
 * привязкой, кроме «только для воронки»), есть ждущее желание той же услуги без строки
 * визита — на день визита или без дня. Это оно: желание указывает на `x`. Иначе оно
 * осталось бы ждать и село бы в следующий визит — вторая оплата той же консультации.
 * Строку визита не ставит и не снимает. ОТПУЩЕННОЕ желание (отмена, снятая строка) — не
 * берёт никогда (O4). Сначала желание этого дня, потом без дня.
 */
function adoptOne(db, reqId, v, x) {
  const cand = db.prepare(`
    SELECT * FROM crm_request_services l
     WHERE l.request_id = ? AND l.status = 'pending' AND l.visit_service_id IS NULL
       AND l.released_from_visit_id IS NULL
       AND (l.visit_id IS NULL OR l.visit_id = ?
            OR NOT EXISTS (SELECT 1 FROM visits w WHERE w.id = l.visit_id AND w.status NOT IN ('cancelled', 'no_show')))
       AND (l.scheduled_date IS NULL OR l.scheduled_date = '' OR date(l.scheduled_date) = date(?))
     ORDER BY (l.scheduled_date IS NULL OR l.scheduled_date = ''), l.id`).all(reqId, v.id, v.day)
    .find((l) => sameService(db, l, x));
  if (!cand) return null;
  db.prepare(POINT).run(v.id, x.id, 0, v.day, cand.id);
  return Number(cand.id);
}

/**
 * Желания карточки визита берут строки человека `vsIds` (нет списка — все строки визита,
 * на которые не указывает ни одна строка карточки). Только визит своего здания до прихода
 * или «Пришёл», только открытая карточка. @returns {number} сколько желаний взяло строку
 */
export function adoptWishes(db, visitId, vsIds = null) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || (!PRE_ARRIVAL.includes(v.status) && v.status !== 'arrived')) return 0;
    const reqId = requestOfVisit(db, v.id);
    if (!reqId) return 0;
    const st = db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(reqId);
    if (!st || !openStageKeys(db).includes(st.status)) return 0;
    const pick = vsIds == null ? null : new Set(ids(vsIds));
    const referenced = db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ? LIMIT 1');
    return db.transaction(() => {
      let n = 0;
      for (const x of db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(v.id)) {
        if (pick && !pick.has(Number(x.id))) continue;
        if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null || x.status === 'cancelled') continue;
        if (referenced.get(x.id)) continue;
        if (adoptOne(db, reqId, v, x)) n++;
      }
      if (n) touchRequest(db, reqId);
      return n;
    })();
  } catch (e) {
    console.error('[crm-one-way] желания карточки визита', visitId, 'не разобраны:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

/**
 * Решение владельца (2026-10-17, к открытому вопросу R2) — УСЛУГА, ДОБАВЛЕННАЯ В ЗАПИСЬ КОЛЛ-ЦЕНТРА, —
 * СТРОКА ЗАПИСИ КАРТОЧКИ. Колл-центр добавил услугу к записи в КАЛЕНДАРЕ (booking_lines_add
 * пользователем «только колл-центр») — к визиту, который держит карточка (строкой или привязкой
 * колл-центра / шага C; привязка «только для воронки» строк не даёт — O9); или кто угодно добавил услугу в запись, которую карточка держит ПРИВЯЗКОЙ КОЛЛ-ЦЕНТРА
 * (crm_booking_links.source = 'callcenter'), — у карточки появляется строка записи, указывающая на эту
 * строку визита (не копия: одна строка визита, один счёт). Тогда отмена записи возвращает её в карточку
 * без дня, как и её собственные строки (O4). Своя запись регистратуры (шаг C, C′) — только история:
 * её услуги карточка видит «Записями пациента» (O2).
 * Только запись своего здания до прихода, только живая карточка того же пациента; строка визита, на
 * которую уже указывает строка карточки (желание, другая карточка), не дублируется. Не бросает.
 * @param {number[]|null} vsIds — добавленные строки визита (null — все строки визита)
 * @returns {number} сколько строк записи заведено
 */
export function bookLinesOnCard(db, visitId, vsIds = null, { callcenter = false } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v) || v.sync_origin != null) return 0;
    let rid = null;
    // Привязка «только для воронки» (C′, телефон) строк не даёт никогда (O9, ред. 2: «Отказ» и партнёр
    // её не видят) — только карточка, держащая запись строкой или привязкой колл-центра / шага C.
    if (callcenter) rid = requestOfVisit(db, v.id);
    if (!rid) {
      try {
        const l = db.prepare("SELECT request_id FROM crm_booking_links WHERE visit_id = ? AND source = 'callcenter'").get(v.id);
        rid = l ? l.request_id : null;
      } catch { rid = null; }   // сборка без 187/189
    }
    if (!rid) return 0;
    const card = db.prepare('SELECT id, status, patient_id FROM crm_requests WHERE id = ?').get(rid);
    if (!card || card.patient_id == null || Number(card.patient_id) !== Number(v.patient_id)) return 0;
    if (![...openStageKeys(db), SEED_NO_SHOW_STAGE].includes(card.status)) return 0;
    const pick = vsIds == null ? null : new Set(ids(vsIds));
    const held = db.prepare("SELECT 1 FROM crm_request_services WHERE visit_service_id = ? AND status <> 'cancelled' LIMIT 1");
    const ins = db.prepare(`INSERT INTO crm_request_services
                              (request_id, service_id, consultation_type_id, doctor_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto)
                            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)`);
    let n = 0;
    db.transaction(() => {
      for (const x of db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(v.id)) {
        if (pick && !pick.has(Number(x.id))) continue;
        if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null || x.status === 'cancelled') continue;
        if (held.get(x.id)) continue;
        ins.run(card.id, x.service_id ?? null, x.service_id != null ? null : (x.consultation_type_id ?? null), x.doctor_id ?? null, v.day, v.id, x.id);
        n++;
      }
    })();
    if (n) touchRequest(db, card.id);
    return n;
  } catch (e) {
    console.error('[crm-one-way] услуги записи колл-центра', visitId, 'не стали строками карточки:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

/**
 * В визит встали строки человека (/api/db, касса): сначала строка желания уступает (O1),
 * потом желание, которое сбылось, указывает на свою строку; строка в записи, которую карточка
 * держит привязкой колл-центра, — строка записи этой карточки (решение владельца R2). Не бросает.
 */
export function onVisitLinesAdded(db, visitId, vsIds = null) {
  wishYields(db, visitId);
  adoptWishes(db, visitId, vsIds);
  bookLinesOnCard(db, visitId, vsIds);
}

// ─── O3 / O4 / O5: отпустить и вернуть ─────────────────────────────────────

const RELEASE = `UPDATE crm_request_services
                    SET released_from_visit_id = ?, released_vs_id = ?, scheduled_date = NULL,
                        visit_id = NULL, visit_service_id = NULL
                  WHERE id = ?`;

/** Карточки строк `lineIds`: дата карточки — по оставшимся записям (cardDateOf внутри touchRequest). */
function touchCardsOf(db, requestIds) {
  for (const r of new Set(requestIds)) { try { touchRequest(db, r); } catch { /* карточку удалили */ } }
}

/**
 * O3 — КАРТОЧКА УБРАЛА УСЛУГУ ИЗ СВОЕЙ ЗАПИСИ (строка записи → 'cancelled' дверью /api/db,
 * дубль при слиянии карточек). Её строка визита уходит, если она свободна (не в счёте, не
 * начата, без талона и результатов), визит до прихода и без работы — и на неё не указывает
 * ни одна ДРУГАЯ живая строка карточки (вторая карточка той же записи её по-прежнему ждёт).
 * Иначе строка визита остаётся: её правят касса и регистратура. Только в миг правки —
 * никогда «потом» (round-3 M8: восстановленный визит опустошался).
 * @param {{lineId:number, vsId:number}[]} pairs
 * @returns {number[]} визиты, из которых ушла строка
 */
export function removeFromBooking(db, pairs) {
  const out = new Set();
  try {
    const others = db.prepare("SELECT 1 FROM crm_request_services WHERE visit_service_id = ? AND status <> 'cancelled' AND id <> ? LIMIT 1");
    db.transaction(() => {
      for (const p of pairs || []) {
        const vs = p && p.vsId ? db.prepare('SELECT * FROM visit_services WHERE id = ?').get(Number(p.vsId)) : null;
        if (!vs) continue;
        const v = visitRow(db, vs.visit_id);
        if (!beforeArrival(db, v) || visitHasWork(db, v.id)) continue;
        if (others.get(vs.id, Number(p.lineId) || 0) || !vsFree(db, vs)) continue;
        deleteVs(db, vs.id);
        out.add(v.id);
      }
    })();
  } catch (e) {
    console.error('[crm-one-way] строки записи не убраны из визита:', e && e.message);   // CRM_ONE_WAY_V1
  }
  return [...out];
}

/**
 * O3 — СТРОКУ ВИЗИТА СНЯЛИ В ДРУГОМ ОКНЕ (календарь, регистратура, касса, кабинет врача):
 * строки записи, которые на неё указывали, становятся ОТПУЩЕННЫМИ желаниями без дня
 * (правило O4) — не удаляются и сами в визит не возвращаются. Ждущие строки визита
 * `visitId`, чья строка визита исчезла, снята или уехала в другой визит. Не бросает.
 */
export function releaseOrphans(db, visitId) {
  try {
    const V = Number(visitId);
    if (!Number.isInteger(V) || V <= 0) return 0;
    const rows = db.prepare(`
      SELECT l.id, l.request_id FROM crm_request_services l
        LEFT JOIN visit_services vs ON vs.id = l.visit_service_id
       WHERE l.visit_id = ? AND l.status = 'pending' AND l.visit_service_id IS NOT NULL
         AND (vs.id IS NULL OR vs.visit_id <> l.visit_id OR vs.status = 'cancelled')`).all(V);
    if (!rows.length) return 0;
    db.transaction(() => { for (const r of rows) db.prepare(RELEASE).run(V, null, r.id); })();
    touchCardsOf(db, rows.map((r) => r.request_id));
    return rows.length;
  } catch (e) {
    console.error('[crm-one-way] строки записи снятой услуги визита', visitId, 'не отпущены:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

/**
 * O3 — касса снимает строку визита `vsId` визита `visitId` (в своей транзакции, до или
 * после DELETE): ждущие строки записи, указывавшие на неё, — отпущенные желания.
 */
export function releaseVisitLine(db, vsId, visitId) {
  const rows = db.prepare("SELECT id, request_id FROM crm_request_services WHERE visit_service_id = ? AND status = 'pending'").all(Number(vsId));
  for (const r of rows) db.prepare(RELEASE).run(Number(visitId) || null, null, r.id);
  return rows.map((r) => r.request_id);
}

/**
 * O4 — ЗАПИСЬ ОТМЕНЕНА: НАЗАД В КАРТОЧКУ БЕЗ ДНЯ. Каждая ждущая строка карточки, которая
 * держит визит, — отпущенное желание: без дня, без визита, без строки визита, с отметкой
 * визита и строки визита (released_vs_id — для O5). Строки самого визита остаются в нём
 * как были (история; не едут, в счёт не идут). Закрытые приходом ('done') — история, не
 * трогаются. Зовётся из правила отмены (crm/visit-status.js) в его транзакции.
 */
export function releaseCancelled(db, visitId) {
  const V = Number(visitId);
  const rows = db.prepare(`
    SELECT l.id, l.request_id,
           CASE WHEN vs.id IS NOT NULL AND vs.visit_id = l.visit_id AND vs.status <> 'cancelled' THEN vs.id END AS keep
      FROM crm_request_services l
      LEFT JOIN visit_services vs ON vs.id = l.visit_service_id
     WHERE l.visit_id = ? AND l.status = 'pending'`).all(V);
  for (const r of rows) db.prepare(RELEASE).run(V, r.keep ?? null, r.id);
  return rows.length;
}

/**
 * O5 — ОТМЕНУ ОТМЕНИЛИ (ошибочная отмена, визит снова «Записан» / «Подтверждён»): желания,
 * отпущенные этим визитом и с тех пор не тронутые (без дня, без визита, с отметкой), снова
 * указывают на свои строки визита — те никуда не уезжали. Строку визита, которой больше нет
 * (или снятую), желание не получает: остаётся отпущенным. Не бросает.
 */
export function restoreReleased(db, visitId) {
  try {
    const v = visitRow(db, visitId);
    if (!v || !PRE_ARRIVAL.includes(v.status)) return 0;
    const rows = db.prepare(`
      SELECT l.id, l.request_id, l.released_vs_id, l.visit_service_auto FROM crm_request_services l
        JOIN visit_services vs ON vs.id = l.released_vs_id AND vs.visit_id = ? AND vs.status <> 'cancelled'
       WHERE l.released_from_visit_id = ? AND l.status = 'pending' AND l.visit_id IS NULL
         AND (l.scheduled_date IS NULL OR l.scheduled_date = '')`).all(v.id, v.id);
    if (!rows.length) return 0;
    db.transaction(() => {
      for (const r of rows) db.prepare(POINT).run(v.id, r.released_vs_id, Number(r.visit_service_auto) ? 1 : 0, v.day, r.id);
    })();
    return rows.length;
  } catch (e) {
    console.error('[crm-one-way] отпущенные строки визита', visitId, 'не возвращены:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}

/**
 * O4 — ПРАВКА ОПЕРАТОРА СНИМАЕТ ОТМЕТКУ ОТПУСКА. `before` — строки до правки (id → строка),
 * `values` — что прислала дверь /api/db. Сменились день, врач или услуга — желание снова
 * обычное: назначенный день его и запишет.
 */
export function clearReleaseOnEdit(db, before, values) {
  const keys = ['scheduled_date', 'doctor_id', 'service_id', 'consultation_type_id'].filter((k) => Object.prototype.hasOwnProperty.call(values || {}, k));
  if (!keys.length || !before) return 0;
  let n = 0;
  for (const [id, r] of before) {
    if (r.released_from_visit_id == null) continue;
    if (!keys.some((k) => String(values[k] ?? '') !== String(r[k] ?? ''))) continue;
    n += db.prepare('UPDATE crm_request_services SET released_from_visit_id = NULL, released_vs_id = NULL WHERE id = ?').run(Number(id)).changes;
  }
  return n;
}

// ─── O6 / O7: перенос и правка строки визита ───────────────────────────────

/**
 * O6 — ПЕРЕНОС ВИЗИТА В КАЛЕНДАРЕ (день, время, врач). Строки визита остаются в своём визите
 * (перенос двигает визит, а не строки), и строки записи следуют сами — они указывают на
 * строки визита. Здесь только их видимые поля: день строки записи — день визита; врач строк,
 * стоявших на прежнем враче записи, — новый; свободные строки визита на прежнем враче едут
 * с ним (цена переоценивается только у строки CRM — M5). Прежнее правило календаря
 * (mirrorReschedule), только у записи до прихода, привязанной к карточке. Дату карточки
 * ставит crmBookingMoved (crm/visit-link.js). Не бросает.
 */
export function followVisitMove(db, visitId, { oldDoctorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v)) return;
    db.transaction(() => {
      const lines = db.prepare("SELECT id, request_id, doctor_id FROM crm_request_services WHERE visit_id = ? AND status = 'pending'").all(v.id);
      if (!lines.length && !requestOfVisit(db, v.id)) return;   // запись не из карточки — прежнее поведение календаря
      db.prepare("UPDATE crm_request_services SET scheduled_date = ? WHERE visit_id = ? AND status = 'pending'").run(v.day, v.id);
      if (oldDoctorId && v.doctor_id && Number(oldDoctorId) !== Number(v.doctor_id)) {
        db.prepare("UPDATE crm_request_services SET doctor_id = ? WHERE visit_id = ? AND status = 'pending' AND doctor_id = ?")
          .run(v.doctor_id, v.id, oldDoctorId);
        for (const vs of db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND doctor_id = ?').all(v.id, oldDoctorId)) {
          if (!vsFree(db, vs) || !lineKey(vs)) continue;
          db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(v.doctor_id, vs.id);
          repriceOwnLine(db, vs.id);
        }
      }
      // Дата карточки — crm/visit-link.js crmBookingMoved (тихо: ступень и updated_at не
      // трогаются — перенос не контакт с пациентом; повтор ревью F-9).
    })();
  } catch (e) {
    console.error('[crm-one-way] перенос записи', visitId, 'не отражён в карточке:', e && e.message);   // CRM_ONE_WAY_V1
  }
}

/**
 * O6 / O3 — СТРОКУ ЗАПИСИ ИЗ КАРТОЧКИ НЕ ПЕРЕНОСЯТ. День, врач, услуга и визит строки
 * записи — это день, врач и услуга строки визита; менять их из карточки значило бы снова
 * держать услугу в двух местах. Перенос — в календаре (строки едут с визитом), убрать
 * услугу из записи — крестиком в карточке (O3). Отказ, только если правка что-то меняет
 * (сохранение карточки ради комментария пишет те же значения). Строка, чей визит отменён
 * или «Не пришёл», — уже не запись: правится. @returns {string|null} текст отказа
 */
export const BOOKED_LINE_LOCKED = 'Услуга уже записана: перенос, смену врача и услуги делают в календаре, а убрать услугу из записи можно крестиком в карточке.';
export function bookedLineEditRefusal(db, lineIds, values) {
  const list = ids(lineIds);
  if (!list.length || !values || typeof values !== 'object') return null;
  const keys = ['scheduled_date', 'doctor_id', 'service_id', 'consultation_type_id', 'visit_id']
    .filter((k) => Object.prototype.hasOwnProperty.call(values, k));
  if (!keys.length) return null;
  const rows = db.prepare(`SELECT l.* FROM crm_request_services l
                             JOIN visits x ON x.id = l.visit_id AND x.status NOT IN ('cancelled', 'no_show')
                            WHERE l.id IN (${holes(list)}) AND l.status = 'pending'`).all(...list);
  for (const r of rows) {
    if (keys.some((k) => String(values[k] ?? '') !== String(r[k] ?? ''))) return BOOKED_LINE_LOCKED;
  }
  return null;
}

/**
 * O3 — КАРТОЧКА ДОБАВИЛА УСЛУГУ В СВОЮ ЗАПИСЬ (строка карточки с visit_id через /api/db:
 * вставка новой строки на день записи, «Записать на дату» связывает строки дня с визитом).
 * Ждущая строка с визитом, но без строки визита, садится в визит правилом O1 — если визит
 * этого же пациента, своего здания, до прихода или «Пришёл», и не визит, который карточка
 * держит только по телефону (P-6). Иначе visit_id снимается: строка остаётся желанием
 * (прежде зеркало ставило строку в любой визит, номер которого прислал браузер).
 * @param {number[]} lineIds — строки, которые надо проверить (любые; лишние пропускаются)
 */
export function attachCardLines(db, lineIds, { actorId = null } = {}) {
  const list = ids(lineIds);
  if (!list.length) return 0;
  try {
    const rows = db.prepare(`SELECT l.*, r.patient_id AS card_patient FROM crm_request_services l
                               JOIN crm_requests r ON r.id = l.request_id
                              WHERE l.id IN (${holes(list)}) AND l.status = 'pending'
                                AND l.visit_id IS NOT NULL AND l.visit_service_id IS NULL`).all(...list);
    if (!rows.length) return 0;
    let n = 0;
    const touched = [];
    db.transaction(() => {
      for (const l of rows) {
        const v = visitRow(db, l.visit_id);
        let ok = !!v && v.sync_origin == null && l.card_patient != null && Number(l.card_patient) === Number(v.patient_id)
          && (PRE_ARRIVAL.includes(v.status) || v.status === 'arrived');
        if (ok) {
          try {
            ok = !db.prepare("SELECT 1 FROM crm_booking_links WHERE visit_id = ? AND request_id = ? AND source = 'phone'").get(v.id, l.request_id);
          } catch { /* сборка без 189 */ }
        }
        if (ok && attachWish(db, v, l, { actorId })) { n++; touched.push(l.request_id); continue; }
        // Визит свой, но строке в нём сесть нельзя (хирургия, снятое с продажи, при счёте до
        // прихода) — строка держит визит без строки визита, как до CRM_ONE_WAY_V1: сядет при
        // приходе (attachHeldLines) или будет ждать. Чужой или мёртвый визит — не держит.
        if (ok) { touched.push(l.request_id); continue; }
        db.prepare('UPDATE crm_request_services SET visit_id = NULL WHERE id = ?').run(l.id);
      }
    })();
    touchCardsOf(db, touched);
    return n;
  } catch (e) {
    console.error('[crm-one-way] строки карточки не сели в запись:', e && e.message);   // CRM_ONE_WAY_V1
    return 0;
  }
}
