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
//   A. строки заявок пациента на ЭТОТ день (или без даты), не занятые живым
//      визитом, берут этот визит — зеркало (mirrorVisit) после этого находит
//      их, а не заводит вторые;
//   B. заявка, которая уже держит этот визит (строками или привязкой);
//   C. открытые заявки пациента, которые ЖДУТ этот приход: без ждущих строк,
//      или с датой / строкой на этот день — любой роли, любой давности;
//   D. ни одной — по телефону: открытая заявка БЕЗ пациента, тот же phoneKey,
//      и он у ОДНОЙ карты (phone и phone_secondary). Пишется ТОЛЬКО
//      patient_id и ступень: ни строк, ни visit_id, ни привязки — общий
//      семейный номер не переносит услуги на чужой счёт;
//   E. нет и такой — только «чистый» колл-центр: свежая открытая заявка
//      пациента, иначе новая («Звонок», оператор — он же);
//   F. привязка записи (crm_booking_links) — для C и E, не для телефона;
//   G. ступень: только из живых колонок и только вперёд — в «Колонку записи»
//      (scheduledStageKey); дата заявки — ближайший день; след в
//      crm_booking_undo для discard_empty_visit.
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
import { phoneKey, phoneLikePattern } from '../../../public/js/admin/views/crm-phone-match.js';

// До окна повторного обращения (задача 6) колл-центр по-прежнему берёт заявку
// не старше 30 дней — то же, что attachVisitToCrm.
export const CALLCENTER_ATTACH_DAYS = 30;
export const MIN_PHONE_KEY_DIGITS = 7;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const holes = (a) => a.map(() => '?').join(',');

/** Карты пациентов с этим ключом номера — в phone ИЛИ phone_secondary. */
export function patientIdsWithPhoneKey(db, key) {
  if (!key || key.length < MIN_PHONE_KEY_DIGITS) return [];
  const like = phoneLikePattern(key);
  return db.prepare('SELECT id, phone, phone_secondary FROM patients WHERE phone LIKE ? OR phone_secondary LIKE ?')
    .all(like, like)
    .filter((p) => phoneKey(p.phone || '') === key || phoneKey(p.phone_secondary || '') === key)
    .map((p) => Number(p.id));
}

function patientPhoneKeys(db, patientId) {
  const p = db.prepare('SELECT phone, phone_secondary FROM patients WHERE id = ?').get(patientId);
  if (!p) return [];
  return [...new Set([p.phone, p.phone_secondary].map((x) => phoneKey(x || ''))
    .filter((k) => k.length >= MIN_PHONE_KEY_DIGITS))];
}

/** Ждёт ли заявка ЭТОТ приход: без ждущих строк, или дата / строка на этот день (или без даты). */
export function waitsForDay(db, requestId, day) {
  return !!db.prepare(`
    SELECT 1 FROM crm_requests r
     WHERE r.id = ?
       AND (NOT EXISTS (SELECT 1 FROM crm_request_services l WHERE l.request_id = r.id AND l.status = 'pending')
            OR date(r.scheduled_date) = date(?)
            OR EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending'
                          AND (l.scheduled_date IS NULL OR l.scheduled_date = '' OR date(l.scheduled_date) = date(?))))`)
    .get(requestId, day, day);
}

/** Открытые заявки без пациента с номером этого пациента — только если номер у ОДНОЙ карты. */
export function phoneLeadsFor(db, patientId, open) {
  if (!open.length) return [];
  const out = [];
  for (const key of patientPhoneKeys(db, patientId)) {
    const owners = patientIdsWithPhoneKey(db, key);
    if (owners.length !== 1 || owners[0] !== Number(patientId)) continue;
    const rows = db.prepare(`SELECT id, phone FROM crm_requests
                              WHERE patient_id IS NULL AND phone LIKE ? AND status IN (${holes(open)})
                              ORDER BY updated_at DESC, id DESC`).all(phoneLikePattern(key), ...open);
    for (const r of rows) if (phoneKey(r.phone || '') === key && !out.includes(r.id)) out.push(r.id);
  }
  return out;
}

/**
 * Связать визит с CRM. Ничего не возвращает (см. шапку) и не бросает.
 * @param {object} db
 * @param {number} visitId
 * @param {object} user — тот, кто записал (роль решает только шаг E)
 */
export function crmLinkVisit(db, visitId, user) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || !v.patient_id || !PRE_ARRIVAL.includes(v.status)) return;
    db.transaction(() => linkTx(db, v, user))();
  } catch (e) {
    console.error('[crm-link] визит', visitId, 'не связан с заявкой:', e && e.message);
  }
}

function linkTx(db, v, user) {
  const open = openStageKeys(db);
  if (!open.length) return;
  const uid = user && Number(user.id) > 0 ? Number(user.id) : null;
  const callcenter = isCallcenterUser(user);
  const touched = new Map();   // request_id → 'lines' | 'held' | 'patient' | 'phone' | 'callcenter' | 'created'

  // A. Строки этого дня. «Не пришёл» (сидовая) в выборке: её строки можно
  //    записать заново, но ступень меняет только приход.
  const lookIn = [...new Set([...open, SEED_NO_SHOW_STAGE])];
  const mine = db.prepare(`SELECT id, status FROM crm_requests WHERE patient_id = ? AND status IN (${holes(lookIn)})
                            ORDER BY updated_at DESC, id DESC`).all(v.patient_id, ...lookIn);
  const linkLines = db.prepare(`
    UPDATE crm_request_services SET visit_id = ?
     WHERE request_id = ? AND status = 'pending'
       AND (visit_id IS NULL OR NOT EXISTS (SELECT 1 FROM visits x WHERE x.id = crm_request_services.visit_id
                                                AND x.status NOT IN ('cancelled', 'no_show')))
       AND (scheduled_date IS NULL OR scheduled_date = '' OR date(scheduled_date) = date(?))`);
  for (const r of mine) if (linkLines.run(v.id, r.id, v.day).changes) touched.set(r.id, 'lines');

  // B. Заявка, которая уже держит визит.
  const held = requestOfVisit(db, v.id);
  if (held && !touched.has(held)) touched.set(held, 'held');

  // C. Открытые заявки пациента, ждущие этот приход.
  for (const r of mine) {
    if (touched.has(r.id) || !open.includes(r.status)) continue;
    if (waitsForDay(db, r.id, v.day)) touched.set(r.id, 'patient');
  }

  // D. По телефону — только patient_id.
  if (!touched.size) {
    for (const id of phoneLeadsFor(db, v.patient_id, open)) {
      if (!waitsForDay(db, id, v.day)) continue;
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
  const read = db.prepare('SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?');
  const write = db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
  for (const [id, via] of touched) {
    if (via === 'created') continue;
    const r = read.get(id);
    if (!r || !open.includes(r.status)) continue;
    const at = open.indexOf(r.status);
    const status = (schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : r.status;
    const was = String(r.scheduled_date || '').trim().slice(0, 10);
    const when = (!was || was > v.day) ? v.day : was;
    if (status === r.status && when === r.scheduled_date) continue;
    write.run(status, when, id);
    try {
      db.prepare(`INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(v.id, id, r.status, r.scheduled_date ?? null, status, when);
    } catch { /* сборка без 186 — возвращать будет нечего */ }
  }
  try { db.prepare("DELETE FROM crm_booking_undo WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')").run(); }
  catch { /* сборка без 186 */ }
}
