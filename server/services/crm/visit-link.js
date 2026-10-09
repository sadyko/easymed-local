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
//      консультация «когда придёт» вставала с ценой в смету анализа через неделю.
//      CRM_UNIFY_V1 (ревью задачи 3, R3) — строки берутся у ВСЕХ карточек
//      пациента, кроме проигрышных («Отказ», «Не квалифицирован»…; сидовая «Не
//      пришёл» — как прежде, берётся): и у закрытой в «Пришёл». Первый приход
//      закрывает карточку, а её строка другого дня остаётся записью и обязана
//      дойти до визита и кассы своего дня. Ступень закрытой карточки шаг не
//      меняет никогда — она не открывается (G только у живых);
//   B. заявка, которая уже держит этот визит (строками или привязкой);
//   C. открытые заявки пациента, которые ЖДУТ этот приход: без ждущих строк,
//      или с датой / строкой на этот день (без даты — только с undated) —
//      любой роли, любой давности;
//   D. ни одной — по телефону, ОДНИМ СТРОГИМ ПРАВИЛОМ (ревью 3; финальное
//      ревью — soleMatchingLead): ЕДИНСТВЕННАЯ открытая заявка БЕЗ пациента на
//      ключ (две и больше — семья: ни одной), ждущая этот приход, у которой
//      поле номера и ОСНОВНОЙ номер записанного — оба целый узбекский номер с
//      равным ключом (phoneMatchKey), имя подходит карте (leadNameFits), и
//      владельцы ключа — ровно {записанный} (patientIdsWithPhoneKey: все номера
//      карт, экстренный контакт, опекуны, связи опекунства и «Родственники»).
//      Второй номер записанного (phone_secondary) заявок не
//      ищет: обычно это номер родственника. Пишется ТОЛЬКО patient_id и ступень:
//      ни строк, ни visit_id, ни привязки. Но следующая дверь (ensure_visit,
//      booking_lines_add) уже видит карточку пациента и ведёт её строки в его
//      счёт — поэтому единственность номера и есть защита денег;
//   E. нет и такой — только «чистый» колл-центр, по ОКНУ ПОВТОРНОГО ОБРАЩЕНИЯ
//      (CRM_UNIFY_V1, задача 6; решение владельца 4, contact-window.js):
//      открытая карточка пациента в окне — та же; после окна — та же,
//      возвращённая в начало воронки (история внутри) и записанная; открытой
//      нет, закрытая в окне — новой нет, закрытую не трогаем, привязки нет
//      (Р5); иначе новая («Звонок», оператор — он же);
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
//   C. открытые карточки пациента, которые стойка ЗАКРЫВАЕТ (deskCloses,
//      решение контролёра по ревью задачи 3, R5): (а) ждут сегодня — ждущая
//      строка на сегодня или без даты, дата карточки сегодня, привязка записи
//      к этому визиту (любой давности); или (б) двигались в окне повторного
//      обращения (updated_at, иначе created_at; windowHours, 72 ч). Старая
//      карточка, ждущая не сегодня («Новый лид» трёхмесячной давности,
//      «Перезвонить» три недели назад), остаётся как была. CRM_UNIFY_V1
//      (задача 6; Р8, Р11) — тем же правилом и сидовая «Не пришёл»: её ставит
//      сервер наутро после пропущенной записи (crm/no-show.js), и пациент,
//      пришедший на день позже, — это приход. Давний «Не пришёл» — история;
//   D. по телефону — то же правило deskCloses. Карточка по телефону получает
//      ТОЛЬКО patient_id и ступень: её строки в визит не идут (правило денег —
//      общий семейный номер не ставит услуги в чужой счёт);
//   E. колл-центр карточку не заводит (пациент без карточки её не получает,
//      решение 2);
//   G. карточка — в «Пришёл» (wonStageKey) с прежней датой (и из сидовой «Не
//      пришёл», взятой шагом C); строки других дней остаются в карточке и в
//      календаре как записи;
//   затем (deskArrive) — СНАЧАЛА ДЕНЬГИ, ПОТОМ ВОРОНКА (ревью задачи 3, R1/R2):
//   зеркало ведёт взятые строки в визит ('added' — касса их видит, как до
//   задачи 3), и только потом правило прихода (crmVisitStatus → 'arrived'):
//   строки этого визита закрываются, карточки без строк этого дня — тоже.
//   Что правило прихода сменило в карточках, пишется в след crm_booking_undo
//   (discard_empty_visit возвращает, R6). «Отказ», «Пришёл» и прочие закрытые
//   не трогаются. Предоплата, будущий визит и визит соседа приходом не
//   становятся. СТУПЕНЬ КАРТОЧКИ НИКОГДА НЕ РЕШАЕТ СУДЬБУ УСЛУГ: закрыть
//   карточку — учёт воронки; строки визита и касса живут по своим правилам
//   (booking-mirror.js: замена строки зеркала строкой регистратуры и разбор
//   при первом счёте — при любом статусе строки заявки).
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

import { openStageKeys, scheduledStageKey, wonStageKey, windowHours, SEED_NO_SHOW_STAGE } from './config.js';
// CRM_UNIFY_V1 (задача 6) — окно повторного обращения: одно правило «двигалась
// ли карточка в окне» (inWindowSql) и одно решение по новому обращению.
import { contactDecision, reopenLead, inWindowSql, windowArg, leadInWindow, firstStageKey } from './contact-window.js';
import { missedRecentlySql, missedRecentlyArgs } from './contact-window.js';   // CRM_UNIFY_V1 (финальное ревью) — одно правило опоздания
import { visitRow, requestOfVisit, isCallcenterUser, PRE_ARRIVAL, cardDateOf, mirrorVisit } from './booking-mirror.js';
import { crmVisitStatus, ARRIVED_STATUSES } from './visit-status.js';
import { hasAnyRole } from '../roles.js';   // CRM_UNIFY_V1 — стойка (deskArrival)
// CRM_UNIFY_V1 (финальное ревью, B) — «может вести карточку»: одно правило
// с /api/db (tasks-follow.js); шаг E не делает хозяином того, кто не может.
import { canOwnLead } from './tasks-follow.js';
import { today } from '../domain/day.js';
import { phoneLikePattern, digitsOf } from '../../../public/js/admin/views/crm-phone-match.js';

// CRM_UNIFY_V1 (задача 6) — срок колл-центра CALLCENTER_ATTACH_DAYS (30 дней по
// created_at) заменён окном повторного обращения (contact-window.js, шаг E).
/** CRM_UNIFY_V1 (Р1) — кому сервер верит «пациент у стойки». */
export const DESK_ROLES = Object.freeze(['admin', 'registrar']);
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const holes = (a) => a.map(() => '?').join(',');

// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (ревью 3; финальное ревью) — НОМЕР ТЕЛЕФОНА: ОДНО СТРОГОЕ ПРАВИЛО
// ═══════════════════════════════════════════════════════════════════════════
//
// Ревью 2 резало поле на номера (phoneKeysOf), и каждое исправление разрезания
// открывало новую ошибку. Резать нечего:
//   1. в поле нет ни одной буквы (добавочный «доб», «тел: … (мама)» — нет);
//   2. цифры поля (любые разделители выброшены) — ЦЕЛЫЙ узбекский номер:
//      9 цифр, 0 + 9, 8 + 9 или 998 + 9. Иначе — не номер для автоматической
//      связи (пусто, коротко, два номера, неполный, иностранный +7 …): его
//      «последние 9 цифр» — часто чужой номер. Связывает оператор руками;
//   3. ключ — последние 9 цифр;
//   4. заявка — пациенту, только если её поле и ОСНОВНОЙ номер пациента — оба
//      целый номер с равным ключом; и это ЕДИНСТВЕННАЯ открытая заявка без
//      пациента на этот ключ (две и больше — почти всегда семья: ни одной); и
//      её имя, если оно есть, — имя или фамилия пациента (leadNameFits);
//   5. владельцы ключа — карты, у которых цифры phone, phone_secondary,
//      emergency_contact_phone или номера опекуна (patient_guardians.phone)
//      СОДЕРЖАТ ключ, и все, кто связан с ними опекунством или «Родственниками»
//      (patient_relationships) в любую сторону, даже без номера в строке связи.
//      С запасом — безопасная сторона;
//   6. связь — только если владельцы ровно {этот пациент}.

export const PHONE_KEY_DIGITS = 9;

/** Ключ целого узбекского номера: последние 9 цифр; '' — поле не такой номер. */
export function phoneMatchKey(raw) {
  const s = String(raw ?? '');
  if (/\p{L}/u.test(s)) return '';
  const d = digitsOf(s);
  if (d.length === PHONE_KEY_DIGITS) return d;
  if (d.length === PHONE_KEY_DIGITS + 1 && (d[0] === '0' || d[0] === '8')) return d.slice(1);
  if (d.length === PHONE_KEY_DIGITS + 3 && d.startsWith('998')) return d.slice(3);
  return '';
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
  // Связи семьи в обе стороны, и без номера в строке связи: опекунство (ревью 3,
  // D5) и «Родственники» карты (patient_relationships, финальное ревью, B) —
  // ребёнок, чья мама записана опекуном или родственником, владеет её номером.
  if (ids.size) {
    const list = [...ids];
    const add = (rows) => { for (const r of rows) for (const id of [r.a, r.b]) if (id != null) ids.add(Number(id)); };
    add(db.prepare(`SELECT patient_id AS a, guardian_patient_id AS b FROM patient_guardians
                     WHERE patient_id IN (${holes(list)}) OR guardian_patient_id IN (${holes(list)})`).all(...list, ...list));
    add(db.prepare(`SELECT patient_id_a AS a, patient_id_b AS b FROM patient_relationships
                     WHERE patient_id_a IN (${holes(list)}) OR patient_id_b IN (${holes(list)})`).all(...list, ...list));
  }
  return [...ids];
}

/** Слова имени: строчными, ё как е, только буквы, от 3 букв. */
const nameWords = (s) => (String(s ?? '').toLowerCase().replace(/ё/g, 'е').match(/\p{L}+/gu) || []).filter((w) => w.length >= 3);

/**
 * CRM_UNIFY_V1 (финальное ревью, A-C1) — ИМЯ ЗАЯВКИ ПОДХОДИТ КАРТЕ. Имени нет
 * (пусто или только цифры — так звонок называет незнакомца) — не мешает. Иначе
 * хоть одно слово заявки из 3+ букв равно имени или фамилии карты (first_name,
 * last_name; их нет — первые два слова full_name), без регистра, ё как е.
 * Другое письмо (латиница против кириллицы) не совпадает — безопасная сторона:
 * заявку «Сын Каримов» маме «Каримова Мама» не отдают.
 */
export function leadNameFits(leadName, patient) {
  const words = nameWords(leadName);
  if (!words.length) return true;
  const p = patient || {};
  let own = [...nameWords(p.first_name), ...nameWords(p.last_name)];
  if (!own.length) own = nameWords(p.full_name).slice(0, 2);
  return words.some((w) => own.includes(w));
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
 *
 * CRM_UNIFY_V1 (проверка ревью задачи 3, P3) — заявка БЕЗ ждущих строк и БЕЗ
 * даты ждёт прихода только в окне повторного обращения (updated_at, иначе
 * created_at; windowHours, 72 ч) — на любой двери записи и регистрации, как у
 * стойки (deskCloses) и правила прихода (settleLineless). Трёхмесячный «Новый
 * лид» — о другом обращении: запись его не берёт, и оплата потом не закрывает.
 * Заявка с датой или со строками — по-прежнему, любой давности.
 * CRM_UNIFY_V1 (задача 6) — окно — одно правило (contact-window.js inWindowSql).
 */
export function waitsForDay(db, requestId, day, { undated = false, hours = windowHours(db) } = {}) {
  const undatedSql = undated ? "l.scheduled_date IS NULL OR l.scheduled_date = '' OR " : '';
  return !!db.prepare(`
    SELECT 1 FROM crm_requests r
     WHERE r.id = ?
       AND ((NOT EXISTS (SELECT 1 FROM crm_request_services l WHERE l.request_id = r.id AND l.status = 'pending')
             AND ((r.scheduled_date IS NOT NULL AND r.scheduled_date <> '')
                  OR ${inWindowSql('r')}))
            OR date(r.scheduled_date) = date(?)
            OR EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending'
                          AND (${undatedSql}date(l.scheduled_date) = date(?))))`)
    .get(requestId, windowArg(hours), day, day);   // CRM_UNIFY_V1 (задача 6) — одно правило окна
}

/**
 * CRM_UNIFY_V1 (финальное ревью, A-C1) — ЗАЯВКА ПО НОМЕРУ: ОДНО ПРАВИЛО для шага
 * записи (phoneLeadFor) и новой карты (new-patient-link.js). Открытая заявка
 * без пациента с ключом ОСНОВНОГО номера карты — только если она ЕДИНСТВЕННАЯ
 * на этот ключ (две и больше — семья на одном номере: ни одной, их разбирает
 * оператор), её принимает accept, её имя подходит карте (leadNameFits) и
 * владельцы ключа — ровно {эта карта}. null — нет. Владельцы считаются
 * последними (ревью 2, скорость).
 */
export function soleMatchingLead(db, patientId, open, accept = () => true) {
  if (!open || !open.length) return null;
  const p = db.prepare('SELECT phone, full_name, first_name, last_name FROM patients WHERE id = ?').get(patientId);
  const key = phoneMatchKey(p && p.phone);
  if (!key) return null;
  const cands = phoneLeadCandidates(db, key, open);
  if (cands.length !== 1) return null;
  const lead = db.prepare('SELECT id, full_name FROM crm_requests WHERE id = ?').get(cands[0]);
  if (!lead || !accept(lead.id) || !leadNameFits(lead.full_name, p)) return null;
  return keyOwnedOnlyBy(db, patientId, key) ? Number(lead.id) : null;
}

/**
 * Заявка по номеру для шага записи (D): soleMatchingLead, принятая, если ждёт
 * этот приход (accept — своё правило отбора: на стойке это deskCloses,
 * CRM_UNIFY_V1). null — нет.
 */
export function phoneLeadFor(db, patientId, open, day, { undated = false, accept = null } = {}) {
  const ok = accept || ((id) => waitsForDay(db, id, day, { undated }));
  return soleMatchingLead(db, patientId, open, ok);
}

/**
 * CRM_UNIFY_V1 (ревью задачи 3, R5) — ЗАКРЫВАЕТ ЛИ СТОЙКА ЭТУ ОТКРЫТУЮ КАРТОЧКУ.
 * Да, если она (а) ждёт сегодня: ждущая строка на день визита или без даты,
 * дата карточки — день визита, привязка записи к этому визиту — любой
 * давности; или (б) двигалась в окне повторного обращения: updated_at (нет —
 * created_at) не старше windowHours. Иначе это старая карточка о другом —
 * «Новый лид» трёхмесячной давности регистрация сегодня не закрывает.
 * Спрашивать ДО того, как шаг связи тронул карточку (D ставит updated_at).
 * CRM_UNIFY_V1 (задача 6) — окно — одно правило (contact-window.js inWindowSql);
 * тем же правилом стойка закрывает и сидовую «Не пришёл» (шаг C).
 *
 * CRM_UNIFY_V1 (ревью задач 5–6, I-5) — у сидовой «Не пришёл» есть ещё одно
 * основание: ПРОПУЩЕННЫЙ ДЕНЬ (дата карточки) не раньше, чем окно назад.
 * «Не пришёл» проход ставит без движения карточки (updated_at прежний —
 * обычно день записи, недели назад), и пациент, опоздавший на день, — это
 * приход на назначенную запись, а не новое обращение (решение владельца 4).
 * Карточка, пропущенная двести дней назад, — история: посторонний приход её не
 * закрывает. CRM_UNIFY_V1 (финальное ревью) — правило опоздания одно на всех:
 * contact-window.js missedRecentlySql / missedRecentlyArgs (его же зовёт
 * правило прихода, visit-status.js), а не своя копия SQL.
 */
export function deskCloses(db, requestId, v, hours = windowHours(db)) {
  return !!db.prepare(`
    SELECT 1 FROM crm_requests r
     WHERE r.id = ?
       AND (EXISTS (SELECT 1 FROM crm_request_services l
                     WHERE l.request_id = r.id AND l.status = 'pending'
                       AND (l.scheduled_date IS NULL OR l.scheduled_date = '' OR date(l.scheduled_date) = date(?)))
            OR date(r.scheduled_date) = date(?)
            OR EXISTS (SELECT 1 FROM crm_booking_links b WHERE b.request_id = r.id AND b.visit_id = ?)
            OR ${inWindowSql('r')}
            OR ${missedRecentlySql('r')})`)   // CRM_UNIFY_V1 (ревью, I-5; финальное ревью) — опоздал на день: одно правило
    .get(requestId, v.day, v.day, v.id, windowArg(hours),   // CRM_UNIFY_V1 (задача 6) — одно правило окна
      missedRecentlyArgs(v.day, hours));
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
    // CRM_UNIFY_V1 — стойка: пациент здесь (deskArrive — сначала деньги, потом воронка).
    if (atDesk) deskArrive(db, v, user);
    // Визит уже «Пришёл»: только что взятые строки закрывает правило прихода.
    else if (arrived && linked) crmVisitStatus(db, { visitId: v.id, from: null, to: v.status });
  } catch (e) {
    console.error('[crm-link] визит', visitId, 'не связан с заявкой:', e && e.message);
  }
}

/**
 * CRM_UNIFY_V1 (ревью задачи 3, R1/R2/R6) — ПРИХОД НА СТОЙКЕ: СНАЧАЛА ДЕНЬГИ,
 * ПОТОМ ВОРОНКА.
 *   1. Зеркало: строки, которые визит только что взял (шаг A), становятся
 *      строками визита ('added'), как у ensure_visit до задачи 3, — касса их
 *      видит. Закрой правило прихода строки раньше, зеркало сочло бы визит
 *      пришедшим и молча оставило бы записанные услуги вне визита.
 *   2. Правило прихода (crmVisitStatus → 'arrived'): строки, которые зеркало
 *      поставить не смогло (визит уже пришёл или при счёте), встают в визит
 *      там же (placeHeldLines); 'done' — только строки, чья услуга в визите
 *      (инвариант, проверка ревью задачи 3); карточки — в конверсию (Р8, Р9,
 *      settleLineless).
 *   3. След: ступени, которые сменило правило прихода (например, «Не пришёл» →
 *      «Пришёл»), пишутся в crm_booking_undo, как и ступени шага G, —
 *      discard_empty_visit возвращает их вместе со строками.
 */
function deskArrive(db, v, user) {
  mirrorVisit(db, v.id, { actorId: user && user.id });
  db.transaction(() => {
    const around = db.prepare(`
      SELECT id, status, scheduled_date FROM crm_requests
       WHERE patient_id = ?
          OR id IN (SELECT request_id FROM crm_request_services WHERE visit_id = ?)
          OR id IN (SELECT request_id FROM crm_booking_links WHERE visit_id = ?)`);
    const before = new Map(around.all(v.patient_id, v.id, v.id).map((r) => [r.id, r]));
    crmVisitStatus(db, { visitId: v.id, from: null, to: ARRIVED_STATUSES[0] });
    for (const r of around.all(v.patient_id, v.id, v.id)) {
      const was = before.get(r.id);
      if (!was || (was.status === r.status && was.scheduled_date === r.scheduled_date)) continue;
      try {
        db.prepare(`INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(v.id, r.id, was.status, was.scheduled_date ?? null, r.status, r.scheduled_date ?? null);
      } catch { /* сборка без 186 — возвращать будет нечего */ }
    }
  })();
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
  //    CRM_UNIFY_V1 (ревью задачи 3, R3) — и карточка в конверсии («Пришёл»):
  //    её строка другого дня — запись, которая обязана дойти до визита и кассы.
  //    Ступень её не меняется (G только у живых). Проигрышные — никогда.
  const lookIn = [...new Set([...open, wonStageKey(db), SEED_NO_SHOW_STAGE])];
  const mine = db.prepare(`SELECT id, status FROM crm_requests WHERE patient_id = ? AND status IN (${holes(lookIn)})
                            ORDER BY updated_at DESC, id DESC`).all(v.patient_id, ...lookIn);
  // CRM_UNIFY_V1 (финальное ревью, A-C2) — строки «без даты» — только у ЖИВЫХ
  // карточек (открытые колонки и сидовая «Не пришёл»), никогда у закрытых:
  // консультация «когда придёт» карточки, перетащенной в «Пришёл» (или уже
  // оплаченная в прошлом визите), вставала с ценой в каждый следующий визит —
  // двойной счёт. Строка закрытой карточки НА ЭТОТ ДЕНЬ — по-прежнему (R3).
  // Подстановка сметы в браузере (crm-lines.js) читает так же.
  const linkSql = (withUndated) => db.prepare(`
    UPDATE crm_request_services SET visit_id = ?
     WHERE request_id = ? AND status = 'pending'
       AND (visit_id IS NULL OR NOT EXISTS (SELECT 1 FROM visits x WHERE x.id = crm_request_services.visit_id
                                                AND x.status NOT IN ('cancelled', 'no_show')))
       AND (${withUndated ? "scheduled_date IS NULL OR scheduled_date = '' OR " : ''}date(scheduled_date) = date(?))`);
  const linkDated = linkSql(false);
  const linkAny = undated ? linkSql(true) : linkDated;
  const live = new Set([...open, SEED_NO_SHOW_STAGE]);
  for (const r of mine) {
    if ((live.has(r.status) ? linkAny : linkDated).run(v.id, r.id, v.day).changes) touched.set(r.id, 'lines');
  }

  // Визит уже «Пришёл» — дальше правило прихода (crmVisitStatus в crmLinkVisit),
  // а не «Записан». CRM_UNIFY_V1 — регистрация на стойке (desk) по такому
  // визиту идёт дальше по всем шагам: карточку другого дня закрывает и она.
  if (arrived && !desk) return touched.size > 0;

  // B. Заявка, которая уже держит визит.
  const held = requestOfVisit(db, v.id);
  if (held && !touched.has(held)) touched.set(held, 'held');

  // C. Открытые заявки пациента, ждущие этот приход. CRM_UNIFY_V1 (Р8; ревью
  //    задачи 3, R5) — на стойке те, что стойка закрывает (deskCloses): ждут
  //    сегодня или двигались в окне повторного обращения.
  //    CRM_UNIFY_V1 (задача 6; Р8, Р11) — на стойке тем же правилом и сидовая
  //    «Не пришёл» (пришёл на день позже): двигалась в окне или ждёт сегодня.
  //    CRM_UNIFY_V1 (ревью задач 5–6, I-3) — «Не пришёл» не закрытая: запись на
  //    сегодня или позже берёт сидовую «Не пришёл», которая двигалась в окне, и
  //    шаг G переводит её в «Колонку записи». Давнюю — нет (колл-центру её
  //    возвращает в начало шаг E).
  const hours = windowHours(db);
  const closes = (id) => deskCloses(db, id, v, hours);
  const rebook = !desk && v.day >= today(db);
  const missed = (r) => r.status === SEED_NO_SHOW_STAGE && (desk || rebook);
  for (const r of mine) {
    if (touched.has(r.id) || (!open.includes(r.status) && !missed(r))) continue;
    const take = desk ? closes(r.id)
      : open.includes(r.status) ? waitsForDay(db, r.id, v.day, { undated })
        : leadInWindow(db, r.id, hours);
    if (take) touched.set(r.id, 'patient');
  }

  // D. По телефону — одна заявка, только patient_id (на стойке — тем же
  //    правилом deskCloses). Строки карточки по телефону визит не берут — ни
  //    здесь, ни на стойке: правило денег (общий номер — не общий счёт).
  if (!touched.size) {
    const id = phoneLeadFor(db, v.patient_id, open, v.day, { undated, accept: desk ? closes : null });   // CRM_UNIFY_V1
    if (id) {
      db.prepare(`UPDATE crm_requests SET patient_id = ?, updated_at = ${NOW_SQL} WHERE id = ? AND patient_id IS NULL`)
        .run(v.patient_id, id);
      touched.set(id, 'phone');
    }
  }

  // E. Колл-центр — новое обращение, по окну повторного обращения
  //    (CRM_UNIFY_V1, задача 6; contact-window.js). Не на стойке (решение 2).
  //    reopen — карточка возвращается в начало воронки, а G записывает её; след
  //    отмены помнит ступень ДО возврата (prevOf). closed — закрытая карточка в
  //    окне: новой нет, закрытую не трогаем, привязки нет (Р5).
  const prevOf = new Map();
  if (!touched.size && callcenter && !desk) {   // CRM_UNIFY_V1 — !desk
    const all = db.prepare('SELECT id FROM crm_requests WHERE patient_id = ?').all(v.patient_id);
    const d = contactDecision(db, all);
    if (d.action === 'same') touched.set(d.lead.id, 'callcenter');
    else if (d.action === 'reopen') {
      prevOf.set(d.lead.id, db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id = ?').get(d.lead.id));
      reopenLead(db, d.lead.id);
      touched.set(d.lead.id, 'callcenter');
    } else if (d.action === 'new') {
      const p = db.prepare('SELECT full_name, phone FROM patients WHERE id = ?').get(v.patient_id) || {};
      // CRM_UNIFY_V1 (финальное ревью, B) — хозяин — записавший, только если он
      // может вести карточку (canOwnLead, то же правило, что у /api/db); иначе
      // карточка ничья: наблюдатель CRM её не получает.
      const owner = uid && canOwnLead(db, uid) ? uid : null;
      const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, assigned_to, created_by, scheduled_date)
                                    VALUES (?, ?, 'call', ?, ?, ?, ?, ?)`)
        .run(p.full_name || '—', p.phone || '', scheduledStageKey(db) || open[0], v.patient_id, owner, uid, v.day).lastInsertRowid);
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
  // CRM_UNIFY_V1 (ревью, I-5) — updated_at двигается: запись и приход на стойке — контакт.
  const write = db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
  for (const [id, via] of touched) {
    if (via === 'created') continue;
    const r = read.get(id);
    // CRM_UNIFY_V1 (задача 6; ревью задач 5–6, I-3) — и сидовая «Не пришёл»:
    // на стойке — в «Пришёл»; записью на сегодня или позже — в «Колонку
    // записи» (запись по такой карточке её и берёт). Запись прошлого дня
    // (правка давнего визита) «Не пришёл» не трогает.
    const missed = r && r.status === SEED_NO_SHOW_STAGE && (desk || rebook);
    if (!r || (!open.includes(r.status) && !missed)) continue;
    let status = r.status;
    let when = r.scheduled_date;
    if (desk) {
      status = won;   // CRM_UNIFY_V1 — стойка: пациент здесь
    } else {
      const at = open.indexOf(r.status);
      if (schedAt >= 0 && at >= 0 && at < schedAt) status = scheduled;
      if (missed) status = scheduled || firstStageKey(db) || r.status;   // CRM_UNIFY_V1 (ревью, I-3)
      when = cardDateOf(db, id, v.day);   // CRM_UNIFY_V1 (ревью 3, D4) — одно правило со сверкой зеркала
    }
    const was = prevOf.get(id) || r;   // CRM_UNIFY_V1 (задача 6) — ступень до возврата в начало
    if (status === r.status && when === r.scheduled_date && was === r) continue;
    write.run(status, when, id);
    try {
      db.prepare(`INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(v.id, id, was.status, was.scheduled_date ?? null, status, when);
    } catch { /* сборка без 186 — возвращать будет нечего */ }
  }
  try { db.prepare("DELETE FROM crm_booking_undo WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')").run(); }
  catch { /* сборка без 186 */ }
  return [...touched.values()].includes('lines');
}
