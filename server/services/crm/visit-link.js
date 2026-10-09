// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — ОДНА ТОЧКА СВЯЗИ ВИЗИТА С CRM
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «объединить календарь, CRM и регистрацию». До этого файла визит
// находил заявку ДВУМЯ путями с разными правилами: ensure_visit
// (settleCrmOnBooking — строки дня и любые заявки без строк) и calendar_book /
// booking_lines_add (attachVisitToCrm — только заявка «на этот день», строкам
// visit_id не ставил, и зеркало их дублировало; наутро обход доски уносил
// ОПЛАТИВШЕГО пациента в «Не пришёл»). Теперь шаг один, его зовут все двери
// записи и регистрации (docs/specs/2026-10-09-crm-unify-design.md).
//
// ПРАВИЛО:
//   A. строки заявок пациента на ЭТОТ день, не занятые живым визитом, берут
//      этот визит — зеркало (mirrorVisit) после этого находит их, а не заводит
//      вторые. Строки БЕЗ ДАТЫ («консультация, когда придёт») — только у
//      ensure_visit (регистрация, мастер визита, «Записать на дату»: опция
//      undated): запись календаря и booking_lines_add их не берут, иначе
//      консультация «когда придёт» вставала с ценой в смету анализа через неделю;
//   B. заявка, которая уже держит этот визит (строками или привязкой);
//   C. открытые заявки пациента, которые ЖДУТ этот приход: без ждущих строк,
//      или с датой / строкой на этот день (без даты — только с undated) —
//      любой роли, любой давности;
//   D. ни одной — по телефону: ОДНА открытая заявка БЕЗ пациента (самая новая
//      из ждущих этот приход) с ключом ОСНОВНОГО номера записанного — и этот
//      номер у ОДНОЙ карты. Второй номер записанного (phone_secondary) заявок не
//      ищет: обычно это номер родственника. Владельцы номера считаются с
//      запасом (patientIdsWithPhoneKey). Пишется ТОЛЬКО patient_id и ступень:
//      ни строк, ни visit_id, ни привязки. Но следующая дверь (ensure_visit,
//      booking_lines_add) уже видит карточку пациента и ведёт её строки в его
//      счёт — поэтому единственность номера и есть защита денег;
//   E. нет и такой — только «чистый» колл-центр: свежая открытая заявка
//      пациента, иначе новая («Звонок», оператор — он же);
//   F. привязка записи (crm_booking_links) — для C и E, не для телефона;
//   G. ступень: только из живых колонок и только вперёд — в «Колонку записи»
//      (scheduledStageKey); дата заявки — ближайший ЖДУЩИЙ день: прежняя
//      остаётся, только если у заявки есть ждущие строки, дата не прошла и не
//      позже этого визита; иначе — день визита (прошедшая дата «Перезвонить»
//      наутро уносила записанную карточку в «Не пришёл»). След в
//      crm_booking_undo для discard_empty_visit.
//
// ВИЗИТ УЖЕ «ПРИШЁЛ» (arrived, своего здания): только шаг A — строки этого дня
// берут визит, как прежде у ensure_visit, — и затем правило прихода
// (crmVisitStatus → 'arrived'): строки закрываются, карточка — как при отметке
// прихода. «Записан» пришедшему не ставится. Отменённый и неявочный визит шаг
// не трогает.
//
// ВНЕ ВИДИМОСТИ ТОГО, КТО ЗАПИСЫВАЕТ, И НИЧЕГО НАРУЖУ: оператор Б записал
// пациента оператора А — карточка А двигается, а функция не возвращает ничего,
// поэтому ответ записи не может раскрыть чужую карточку.
//
// СИНХРОНИЗАЦИЯ ЗДАНИЙ: визит соседа (sync_origin) шаг не трогает — связь
// делается в здании записи. Приход и деньги по такому визиту доходят до заявок
// через crmFromSync (branch-sync/records.js → crm/visit-status.js), как раньше.
//
// НЕ БРОСАЕТ: заявка не вправе отказать в записи. Ошибка — в лог.

import { openStageKeys, scheduledStageKey, SEED_NO_SHOW_STAGE } from './config.js';
import { visitRow, requestOfVisit, isCallcenterUser, PRE_ARRIVAL } from './booking-mirror.js';
import { crmVisitStatus, ARRIVED_STATUSES } from './visit-status.js';
import { today } from '../domain/day.js';
import { phoneKey, phoneLikePattern, digitsOf } from '../../../public/js/admin/views/crm-phone-match.js';

// До окна повторного обращения (задача 6) колл-центр по-прежнему берёт заявку
// не старше 30 дней — то же, что attachVisitToCrm.
export const CALLCENTER_ATTACH_DAYS = 30;
export const MIN_PHONE_KEY_DIGITS = 7;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const holes = (a) => a.map(() => '?').join(',');

/**
 * Карты, которые МОГУТ владеть этим номером, — счёт С ЗАПАСОМ: цифры phone ИЛИ
 * phone_secondary СОДЕРЖАТ ключ (а с ним и '998'+ключ), как у поиска заявок
 * (leadMatchesQuery). Поле с двумя номерами («+998 91 …, +998 90 …») — тоже
 * владелец. Лишний владелец только делает совпадение реже — безопасная
 * сторона; недосчитанный отдаёт заявку не тому члену семьи.
 *
 * LIKE-шаблон по цифрам подряд (phoneLikePattern) — грубый отбор: всякое поле,
 * где цифры ключа идут подряд, под него попадает при любых разделителях.
 */
export function patientIdsWithPhoneKey(db, key) {
  const k = String(key || '');
  if (k.length < MIN_PHONE_KEY_DIGITS) return [];
  const like = phoneLikePattern(k);
  return db.prepare('SELECT id, phone, phone_secondary FROM patients WHERE phone LIKE ? OR phone_secondary LIKE ?')
    .all(like, like)
    .filter((p) => digitsOf(p.phone).includes(k) || digitsOf(p.phone_secondary).includes(k))
    .map((p) => Number(p.id));
}

/** Ключ ОСНОВНОГО номера карты ('' — нет или короче 7 цифр). */
function primaryPhoneKey(db, patientId) {
  const p = db.prepare('SELECT phone FROM patients WHERE id = ?').get(patientId);
  const k = p ? phoneKey(p.phone || '') : '';
  return k.length >= MIN_PHONE_KEY_DIGITS ? k : '';
}

/**
 * Ждёт ли заявка ЭТОТ приход: без ждущих строк, или дата / строка на этот день.
 * Строка без даты («когда придёт») считается, только если undated.
 */
export function waitsForDay(db, requestId, day, { undated = false } = {}) {
  const undatedSql = undated ? "l.scheduled_date IS NULL OR l.scheduled_date = '' OR " : '';
  return !!db.prepare(`
    SELECT 1 FROM crm_requests r
     WHERE r.id = ?
       AND (NOT EXISTS (SELECT 1 FROM crm_request_services l WHERE l.request_id = r.id AND l.status = 'pending')
            OR date(r.scheduled_date) = date(?)
            OR EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending'
                          AND (${undatedSql}date(l.scheduled_date) = date(?))))`)
    .get(requestId, day, day);
}

/**
 * ОДНА открытая заявка без пациента с ОСНОВНЫМ номером этого пациента — самая
 * новая из ждущих этот приход; только если номер у ОДНОЙ карты. null — нет.
 */
export function phoneLeadFor(db, patientId, open, day, { undated = false } = {}) {
  if (!open.length) return null;
  const key = primaryPhoneKey(db, patientId);
  if (!key) return null;
  const owners = patientIdsWithPhoneKey(db, key);
  if (owners.length !== 1 || owners[0] !== Number(patientId)) return null;
  const rows = db.prepare(`SELECT id, phone FROM crm_requests
                            WHERE patient_id IS NULL AND phone LIKE ? AND status IN (${holes(open)})
                            ORDER BY created_at DESC, id DESC`).all(phoneLikePattern(key), ...open);
  for (const r of rows) {
    if (phoneKey(r.phone || '') === key && waitsForDay(db, r.id, day, { undated })) return Number(r.id);
  }
  return null;
}

/**
 * Связать визит с CRM. Ничего не возвращает (см. шапку) и не бросает.
 * @param {object} db
 * @param {number} visitId
 * @param {object} user — тот, кто записал (роль решает только шаг E)
 * @param {{undated?: boolean}} [opts] — undated: брать строки без даты (только ensure_visit)
 */
export function crmLinkVisit(db, visitId, user, { undated = false } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || !v.patient_id) return;
    const arrived = ARRIVED_STATUSES.includes(v.status);
    if (!arrived && !PRE_ARRIVAL.includes(v.status)) return;   // отменён / не пришёл
    const linked = db.transaction(() => linkTx(db, v, user, { undated: !!undated, arrived }))();
    // Визит уже «Пришёл»: только что взятые строки закрывает правило прихода.
    if (arrived && linked) crmVisitStatus(db, { visitId: v.id, from: null, to: v.status });
  } catch (e) {
    console.error('[crm-link] визит', visitId, 'не связан с заявкой:', e && e.message);
  }
}

/** @returns {boolean} взял ли визит хоть одну строку (шаг A) */
function linkTx(db, v, user, { undated, arrived }) {
  const open = openStageKeys(db);
  if (!open.length) return false;
  const uid = user && Number(user.id) > 0 ? Number(user.id) : null;
  const callcenter = isCallcenterUser(user);
  const touched = new Map();   // request_id → 'lines' | 'held' | 'patient' | 'phone' | 'callcenter' | 'created'

  // A. Строки этого дня (без даты — только с undated). «Не пришёл» (сидовая)
  //    в выборке: её строки можно записать заново, но ступень меняет только приход.
  const lookIn = [...new Set([...open, SEED_NO_SHOW_STAGE])];
  const mine = db.prepare(`SELECT id, status FROM crm_requests WHERE patient_id = ? AND status IN (${holes(lookIn)})
                            ORDER BY updated_at DESC, id DESC`).all(v.patient_id, ...lookIn);
  const linkLines = db.prepare(`
    UPDATE crm_request_services SET visit_id = ?
     WHERE request_id = ? AND status = 'pending'
       AND (visit_id IS NULL OR NOT EXISTS (SELECT 1 FROM visits x WHERE x.id = crm_request_services.visit_id
                                                AND x.status NOT IN ('cancelled', 'no_show')))
       AND (${undated ? "scheduled_date IS NULL OR scheduled_date = '' OR " : ''}date(scheduled_date) = date(?))`);
  for (const r of mine) if (linkLines.run(v.id, r.id, v.day).changes) touched.set(r.id, 'lines');

  // Визит уже «Пришёл» — дальше правило прихода (crmVisitStatus в crmLinkVisit),
  // а не «Записан».
  // CRM_UNIFY_V1, задача 3: регистрация на стойке (desk) по такому визиту идёт
  // дальше по всем шагам — сюда добавить «&& !desk».
  if (arrived) return touched.size > 0;

  // B. Заявка, которая уже держит визит.
  const held = requestOfVisit(db, v.id);
  if (held && !touched.has(held)) touched.set(held, 'held');

  // C. Открытые заявки пациента, ждущие этот приход.
  for (const r of mine) {
    if (touched.has(r.id) || !open.includes(r.status)) continue;
    if (waitsForDay(db, r.id, v.day, { undated })) touched.set(r.id, 'patient');
  }

  // D. По телефону — одна заявка, только patient_id.
  if (!touched.size) {
    const id = phoneLeadFor(db, v.patient_id, open, v.day, { undated });
    if (id) {
      db.prepare(`UPDATE crm_requests SET patient_id = ?, updated_at = ${NOW_SQL} WHERE id = ? AND patient_id IS NULL`)
        .run(v.patient_id, id);
      touched.set(id, 'phone');
    }
  }

  // E. Колл-центр: свежая открытая или новая.
  if (!touched.size && callcenter) {
    const recent = db.prepare(`SELECT id FROM crm_requests WHERE patient_id = ? AND status IN (${holes(open)})
                                 AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-${CALLCENTER_ATTACH_DAYS} days')
                               ORDER BY created_at DESC, id DESC LIMIT 1`).get(v.patient_id, ...open);
    if (recent) touched.set(recent.id, 'callcenter');
    else {
      const p = db.prepare('SELECT full_name, phone FROM patients WHERE id = ?').get(v.patient_id) || {};
      const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, assigned_to, created_by, scheduled_date)
                                    VALUES (?, ?, 'call', ?, ?, ?, ?, ?)`)
        .run(p.full_name || '—', p.phone || '', scheduledStageKey(db) || open[0], v.patient_id, uid, uid, v.day).lastInsertRowid);
      touched.set(id, 'created');
    }
  }

  // F. Привязка записи — для C и E (A держит визит строками, D — только пациент).
  if (!held) {
    const pick = [...touched].find(([, via]) => via === 'patient' || via === 'callcenter' || via === 'created');
    if (pick) {
      db.prepare(`INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source, created_by, created_request)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(v.id, pick[0], callcenter ? 'callcenter' : 'match', uid, pick[1] === 'created' ? 1 : 0);
    }
  }

  // G. Ступень и дата — только живым и только вперёд.
  const scheduled = scheduledStageKey(db);
  const schedAt = scheduled ? open.indexOf(scheduled) : -1;
  const todayDay = today(db);
  const read = db.prepare('SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?');
  const pendingOf = db.prepare("SELECT COUNT(*) AS n FROM crm_request_services WHERE request_id = ? AND status = 'pending'");
  const write = db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
  for (const [id, via] of touched) {
    if (via === 'created') continue;
    const r = read.get(id);
    if (!r || !open.includes(r.status)) continue;
    const at = open.indexOf(r.status);
    const status = (schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : r.status;
    const was = String(r.scheduled_date || '').trim().slice(0, 10);
    const keep = !!was && was >= todayDay && was <= v.day && pendingOf.get(id).n > 0;
    const when = keep ? was : v.day;
    if (status === r.status && when === r.scheduled_date) continue;
    write.run(status, when, id);
    try {
      db.prepare(`INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(v.id, id, r.status, r.scheduled_date ?? null, status, when);
    } catch { /* сборка без 186 — возвращать будет нечего */ }
  }
  try { db.prepare("DELETE FROM crm_booking_undo WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')").run(); }
  catch { /* сборка без 186 */ }
  return [...touched.values()].includes('lines');
}
