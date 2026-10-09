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
//   D. ни одной — по телефону, ОДНИМ СТРОГИМ ПРАВИЛОМ (ревью 3): ОДНА
//      открытая заявка БЕЗ пациента (самая новая из ждущих этот приход), у
//      которой поле номера и ОСНОВНОЙ номер записанного — оба ОДИН номер с
//      равным ключом (phoneMatchKey), и владельцы ключа — ровно {записанный}
//      (patientIdsWithPhoneKey: все номера карт, экстренный контакт, опекуны и
//      связи опекунства). Второй номер записанного (phone_secondary) заявок не
//      ищет: обычно это номер родственника. Пишется ТОЛЬКО patient_id и ступень:
//      ни строк, ни visit_id, ни привязки. Но следующая дверь (ensure_visit,
//      booking_lines_add) уже видит карточку пациента и ведёт её строки в его
//      счёт — поэтому единственность номера и есть защита денег;
//   E. нет и такой — только «чистый» колл-центр: свежая открытая заявка
//      пациента, иначе новая («Звонок», оператор — он же);
//   F. привязка записи (crm_booking_links) — для C и E, не для телефона;
//   G. ступень: только из живых колонок и только вперёд — в «Колонку записи»
//      (scheduledStageKey); дата заявки — cardDateOf (booking-mirror.js), ОДНО
//      правило со сверкой зеркала (ревью 3, D4): ближайший с сегодняшнего дня
//      записанный день, иначе ближайшая ждущая строка с сегодняшнего дня, иначе
//      день этого визита. Прошедшая дата «Перезвонить» наутро уносила
//      записанную карточку в «Не пришёл», будущая, на которую ничто не записано,
//      — послезавтра, а два разных правила перекидывали дату на каждом клике.
//      След в crm_booking_undo для discard_empty_visit.
//
// ВИЗИТ УЖЕ «ПРИШЁЛ» (arrived, своего здания): только шаг A — строки этого дня
// берут визит, как прежде у ensure_visit, — и затем правило прихода
// (crmVisitStatus → 'arrived'): строки закрываются, карточка — как при отметке
// прихода. «Записан» пришедшему не ставится. Отменённый и неявочный визит шаг
// не трогает. Регистрация на стойке по такому визиту идёт по всем шагам (ниже).
//
// РЕГИСТРАЦИЯ НА СТОЙКЕ = «ПРИШЁЛ» (CRM_UNIFY_V1, задача 3; решение владельца 1,
// Р1, Р8). Быстрая регистрация и «пришёл сейчас» (registerWalkIn) шлют
// ensure_visit с desk: true и без book. Сервер верит этому только от
// регистратуры и администратора (основная или дополнительная роль) и только по
// визиту СЕГОДНЯШНЕГО местного дня (deskArrival); иначе desk молча не значит
// ничего. На стойке:
//   C. берутся ВСЕ открытые карточки пациента, не только ждущие этот день, —
//      первый приход закрывает карточку;
//   D. по телефону — любая открытая карточка без пациента (те же сторожа
//      номера), не только ждущая этот день;
//   E. колл-центр карточку не заводит (пациент без карточки её не получает,
//      решение 2);
//   G. карточка — в «Пришёл» (wonStageKey) с прежней датой; строки других
//      дней остаются в карточке и в календаре как записи;
//   затем правило прихода (crmVisitStatus → 'arrived'): строки этого визита
//   закрываются, карточки без строк этого дня — тоже. «Отказ», «Пришёл» и
//   прочие закрытые не трогаются. Предоплата, будущий визит и визит соседа
//   приходом не становятся.
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

import { openStageKeys, scheduledStageKey, wonStageKey, SEED_NO_SHOW_STAGE } from './config.js';
import { visitRow, requestOfVisit, isCallcenterUser, PRE_ARRIVAL, cardDateOf } from './booking-mirror.js';
import { crmVisitStatus, ARRIVED_STATUSES } from './visit-status.js';
import { hasAnyRole } from '../roles.js';   // CRM_UNIFY_V1 — стойка (deskArrival)
import { today } from '../domain/day.js';
import { phoneLikePattern, digitsOf } from '../../../public/js/admin/views/crm-phone-match.js';

// До окна повторного обращения (задача 6) колл-центр по-прежнему берёт заявку
// не старше 30 дней — то же, что attachVisitToCrm.
export const CALLCENTER_ATTACH_DAYS = 30;
/** CRM_UNIFY_V1 (Р1) — кому сервер верит «пациент у стойки». */
export const DESK_ROLES = Object.freeze(['admin', 'registrar']);
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const holes = (a) => a.map(() => '?').join(',');

// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (ревью 3) — НОМЕР ТЕЛЕФОНА: ОДНО СТРОГОЕ ПРАВИЛО
// ═══════════════════════════════════════════════════════════════════════════
//
// Ревью 2 резало поле на номера (phoneKeysOf), и каждое исправление разрезания
// открывало новую ошибку: неразрывный пробел и тире рвали номер, два номера
// через пробел склеивались в один, российский ключ держал код страны. Теперь
// резать нечего:
//   1. цифры поля — все цифры, остальное выброшено (любые разделители);
//   2. поле — ОДИН номер, только если цифр от 7 до 12; иначе это «не один
//      номер» (пусто, коротко, два номера, добавочный) — автоматически такое не
//      связывается никогда, это делает оператор руками;
//   3. ключ — последние 9 цифр одного номера (+7 / 8 / 998 / 0 не важны);
//      короче 9 — ключа нет;
//   4. заявка — пациенту, только если её поле и ОСНОВНОЙ номер пациента — оба
//      один номер с равным ключом;
//   5. владельцы ключа — карты, у которых цифры phone, phone_secondary,
//      emergency_contact_phone или номера опекуна (patient_guardians.phone)
//      СОДЕРЖАТ ключ, и все, кто связан с ними опекунством в любую сторону,
//      даже без номера в строке опекунства. С запасом — безопасная сторона;
//   6. связь — только если владельцы ровно {этот пациент}.

const SINGLE_MIN_DIGITS = 7;
const SINGLE_MAX_DIGITS = 12;
export const PHONE_KEY_DIGITS = 9;

/** Ключ одного номера: последние 9 цифр; '' — поле не один номер или ключ короче 9. */
export function phoneMatchKey(raw) {
  const d = digitsOf(raw);
  if (d.length < SINGLE_MIN_DIGITS || d.length > SINGLE_MAX_DIGITS) return '';
  return d.length >= PHONE_KEY_DIGITS ? d.slice(-PHONE_KEY_DIGITS) : '';
}

/**
 * Карты, которые МОГУТ владеть номером с этим ключом (правило 5). LIKE по
 * цифрам ключа через «%» (phoneLikePattern) — грубый отбор с запасом: всякое
 * поле, чьи цифры содержат ключ, под него попадает при любых разделителях.
 */
export function patientIdsWithPhoneKey(db, key) {
  const k = String(key ?? '');
  if (!/^\d+$/.test(k) || k.length < PHONE_KEY_DIGITS) return [];
  const like = phoneLikePattern(k);
  const has = (x) => digitsOf(x).includes(k);
  const ids = new Set();
  for (const p of db.prepare(`SELECT id, phone, phone_secondary, emergency_contact_phone FROM patients
                               WHERE phone LIKE ? OR phone_secondary LIKE ? OR emergency_contact_phone LIKE ?`).all(like, like, like)) {
    if (has(p.phone) || has(p.phone_secondary) || has(p.emergency_contact_phone)) ids.add(Number(p.id));
  }
  for (const g of db.prepare('SELECT patient_id, guardian_patient_id, phone FROM patient_guardians WHERE phone LIKE ?').all(like)) {
    if (!has(g.phone)) continue;
    for (const id of [g.patient_id, g.guardian_patient_id]) if (id != null) ids.add(Number(id));
  }
  // Опекунство в обе стороны, и без номера в строке (ревью 3, D5): ребёнок,
  // чья мама — опекун-карта, владеет и её номером.
  if (ids.size) {
    const list = [...ids];
    for (const g of db.prepare(`SELECT patient_id, guardian_patient_id FROM patient_guardians
                                 WHERE patient_id IN (${holes(list)}) OR guardian_patient_id IN (${holes(list)})`).all(...list, ...list)) {
      for (const id of [g.patient_id, g.guardian_patient_id]) if (id != null) ids.add(Number(id));
    }
  }
  return [...ids];
}

/** Ключ — у ОДНОЙ карты, и это patientId (правило 6). */
export function keyOwnedOnlyBy(db, patientId, key) {
  if (!key) return false;
  const owners = patientIdsWithPhoneKey(db, key);
  return owners.length === 1 && owners[0] === Number(patientId);
}

/**
 * Открытые заявки БЕЗ пациента, чьё поле номера — один номер с этим ключом
 * (правило 4). Самые новые первыми. Только отбор — владельцев ключа проверяет
 * звонящий (keyOwnedOnlyBy).
 */
export function phoneLeadCandidates(db, key, open) {
  if (!key || !open || !open.length) return [];
  return db.prepare(`SELECT id, phone FROM crm_requests
                      WHERE patient_id IS NULL AND phone LIKE ? AND status IN (${holes(open)})
                      ORDER BY created_at DESC, id DESC`).all(phoneLikePattern(key), ...open)
    .filter((r) => phoneMatchKey(r.phone) === key)
    .map((r) => Number(r.id));
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
 * новая из ждущих этот приход (на стойке, desk, — самая новая из открытых);
 * только если основной номер — один номер и его ключ у ОДНОЙ карты. null — нет.
 * Сначала ищется заявка (дёшево), владельцы ключа считаются, только если она
 * есть (ревью 2, скорость).
 */
export function phoneLeadFor(db, patientId, open, day, { undated = false, desk = false } = {}) {
  if (!open.length) return null;
  const p = db.prepare('SELECT phone FROM patients WHERE id = ?').get(patientId);
  const key = phoneMatchKey(p && p.phone);
  if (!key) return null;
  const hit = phoneLeadCandidates(db, key, open).find((id) => desk || waitsForDay(db, id, day, { undated }));
  if (!hit) return null;
  return keyOwnedOnlyBy(db, patientId, key) ? hit : null;
}

/**
 * CRM_UNIFY_V1 (Р1) — ВЕРИТЬ ЛИ «ПАЦИЕНТ У СТОЙКИ». desk приходит из браузера,
 * поэтому сервер проверяет сам: прислал его регистратор или администратор
 * (основная или дополнительная роль), и визит — сегодняшнего местного дня.
 * Колл-центру, врачу, будущему и прошедшему дню — нет. Без book решает дверь
 * (ensure_visit передаёт desk только без записи на время).
 */
export function deskArrival(db, v, user, desk) {
  return desk === true && !!v && v.day === today(db) && hasAnyRole(user, DESK_ROLES);
}

/**
 * Связать визит с CRM. Ничего не возвращает (см. шапку) и не бросает.
 * @param {object} db
 * @param {number} visitId
 * @param {object} user — тот, кто записал (роль решает шаг E и стойку)
 * @param {{undated?: boolean, desk?: boolean}} [opts] — undated: брать строки
 *        без даты (только ensure_visit); desk: регистрация на стойке (только
 *        ensure_visit без book; верится по deskArrival — CRM_UNIFY_V1)
 */
export function crmLinkVisit(db, visitId, user, { undated = false, desk = false } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || !v.patient_id) return;
    const arrived = ARRIVED_STATUSES.includes(v.status);
    if (!arrived && !PRE_ARRIVAL.includes(v.status)) return;   // отменён / не пришёл
    const atDesk = deskArrival(db, v, user, desk);   // CRM_UNIFY_V1 (Р1)
    const linked = db.transaction(() => linkTx(db, v, user, { undated: !!undated, arrived, desk: atDesk }))();
    // CRM_UNIFY_V1 — стойка: пациент здесь — правило прихода (строки этого
    // визита закрываются, карточки без строк этого дня — тоже).
    if (atDesk) crmVisitStatus(db, { visitId: v.id, from: null, to: ARRIVED_STATUSES[0] });
    // Визит уже «Пришёл»: только что взятые строки закрывает правило прихода.
    else if (arrived && linked) crmVisitStatus(db, { visitId: v.id, from: null, to: v.status });
  } catch (e) {
    console.error('[crm-link] визит', visitId, 'не связан с заявкой:', e && e.message);
  }
}

/** @returns {boolean} взял ли визит хоть одну строку (шаг A) */
function linkTx(db, v, user, { undated, arrived, desk }) {
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
  // а не «Записан». CRM_UNIFY_V1 — регистрация на стойке (desk) по такому
  // визиту идёт дальше по всем шагам: карточку другого дня закрывает и она.
  if (arrived && !desk) return touched.size > 0;

  // B. Заявка, которая уже держит визит.
  const held = requestOfVisit(db, v.id);
  if (held && !touched.has(held)) touched.set(held, 'held');

  // C. Открытые заявки пациента, ждущие этот приход. CRM_UNIFY_V1 (Р8) — на
  //    стойке ВСЕ открытые: первый приход закрывает карточку.
  for (const r of mine) {
    if (touched.has(r.id) || !open.includes(r.status)) continue;
    if (desk || waitsForDay(db, r.id, v.day, { undated })) touched.set(r.id, 'patient');
  }

  // D. По телефону — одна заявка, только patient_id (на стойке — любая открытая).
  if (!touched.size) {
    const id = phoneLeadFor(db, v.patient_id, open, v.day, { undated, desk });   // CRM_UNIFY_V1 — desk
    if (id) {
      db.prepare(`UPDATE crm_requests SET patient_id = ?, updated_at = ${NOW_SQL} WHERE id = ? AND patient_id IS NULL`)
        .run(v.patient_id, id);
      touched.set(id, 'phone');
    }
  }

  // E. Колл-центр: свежая открытая или новая. Не на стойке (решение 2).
  if (!touched.size && callcenter && !desk) {   // CRM_UNIFY_V1 — !desk
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

  // G. Ступень и дата — только живым и только вперёд. CRM_UNIFY_V1 (Р1, Р8) —
  //    на стойке ступень — «Пришёл», дата карточки остаётся прежней: строки
  //    других дней остаются в карточке и в календаре как записи.
  const scheduled = scheduledStageKey(db);
  const schedAt = scheduled ? open.indexOf(scheduled) : -1;
  const won = desk ? wonStageKey(db) : null;   // CRM_UNIFY_V1
  const read = db.prepare('SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?');
  const write = db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
  for (const [id, via] of touched) {
    if (via === 'created') continue;
    const r = read.get(id);
    if (!r || !open.includes(r.status)) continue;
    let status = r.status;
    let when = r.scheduled_date;
    if (desk) {
      status = won;   // CRM_UNIFY_V1 — стойка: пациент здесь
    } else {
      const at = open.indexOf(r.status);
      if (schedAt >= 0 && at >= 0 && at < schedAt) status = scheduled;
      when = cardDateOf(db, id, v.day);   // CRM_UNIFY_V1 (ревью 3, D4) — одно правило со сверкой зеркала
    }
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
