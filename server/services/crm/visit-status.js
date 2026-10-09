// ═══════════════════════════════════════════════════════════════════════════
// CRM_REAL_BOOKING_V1 (2026-09-21) — «ПРИШЁЛ» СТАВИТ ПРИХОД, А НЕ ЗАПИСЬ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец (2026-09-21): «Пришёл» значит, что пациент ФИЗИЧЕСКИ пришёл. До сих
// пор конверсию объявляло создание визита (settleCrmForVisit в rpc/visits.js):
// заявка уезжала в «Пришёл» в тот миг, когда её ЗАПИСАЛИ — по телефону, за
// неделю до приёма. Воронка колл-центра считала конверсией собственную запись,
// а «Не пришёл» в ней появиться не мог, если оператор успел записать.
//
// Половина правила, которая осталась записи, живёт в crm/visit-link.js
// (crmLinkVisit — CRM_UNIFY_V1; прежде settleCrmOnBooking в rpc/visits.js):
// строка берёт себе визит, заявка уезжает в «Записан». Регистрация на стойке
// (desk, CRM_UNIFY_V1) — уже приход: шаг связи зовёт правило ниже сразу.
// ВТОРАЯ ПОЛОВИНА — здесь: что происходит с заявкой, когда у ЕЁ визита
// меняется статус.
//
// СЛОВАРЬ СТАТУСОВ ВИЗИТА — ПЯТЬ СЛОВ, И НИ ОДНОГО БОЛЬШЕ (миграция 003,
// CHECK на visits.status): 'scheduled', 'confirmed', 'arrived', 'cancelled',
// 'no_show'. Ни 'in_progress', ни 'completed' у визита нет — работа идёт по
// строкам visit_services, у которых свой словарь. Поэтому приход здесь ровно
// один: 'arrived'. 'confirmed' — это «дозвонились и подтвердили», человек всё
// ещё дома, и конверсией он не является.
//
// ГДЕ ЭТО ЗОВЁТСЯ. Единственная дверь, которая пишет visits.status на всём
// сервере, — calendar_book (rpc/calendar.js): через неё идут и плитки
// календаря, и окно визита, и кабинет врача, и мастер записи
// (VISITS_ONE_DOOR_V1). Оттуда и зовут.
//
// НЕ БРОСАЕТСЯ НИКОГДА. Заявка не вправе отказать в записи, переносе или
// отметке прихода: воронка — это учёт работы колл-центра, а не условие приёма
// пациента. Любая ошибка попадает в лог и там остаётся.

import { openStageKeys, wonStageKey, noShowStageKey, scheduledStageKey, windowHours, SEED_NO_SHOW_STAGE } from './config.js';   // CRM_UNIFY_V1 — windowHours
// CLINIC_DAY_V1 — «сегодня» и «день визита» — местные дни клиники, теми же
// словами, какими их считают касса, дневник и документы.
import { localDate } from '../domain/day.js';
// CRM_UNIFY_V1 (задача 6) — «двигалась ли карточка в окне» — одно правило (contact-window.js).
import { inWindowSql, windowArg } from './contact-window.js';
// CRM_UNIFY_V1 — приход ставит в визит строки, которые визит держит, а в нём их
// нет (вызов во время прихода, не при загрузке модуля: booking-mirror.js сам
// берёт отсюда EVIDENCE_SERVICE_STATUSES).
import { placeHeldLines, cardDateOf } from './booking-mirror.js';   // CRM_UNIFY_V1 (ревью, M-1) — cardDateOf

/** Статусы визита, означающие «пациент здесь». Словарь — из миграции 003. */
export const ARRIVED_STATUSES = Object.freeze(['arrived']);

// ОТМЕНЁННАЯ И НЕ ПРИШЕДШАЯ ЗАПИСЬ ДОКАЗАТЕЛЬСТВОМ НЕ БЫВАЕТ НИКОГДА, чем бы
// за неё ни заплатили: предоплату вносят заранее, а возвращают потом. Ровно
// этот же вырез стоит у доски Cust Dev (custdev/sync.js), и по той же причине.
const DEAD_VISIT_STATUSES = Object.freeze(['cancelled', 'no_show']);

/**
 * СТАТУСЫ УСЛУГИ, КОТОРЫЕ МОГ ПОСТАВИТЬ ТОЛЬКО ЧЕЛОВЕК ПЕРЕД ВРАЧОМ.
 *
 * Машина состояний услуги — из шапки миграции 041: added → queued → collected
 * → in_progress → resulted → completed. Первые два заочны: 'added' это «внесли
 * в смету», 'queued' ставит оплата. Остальные четыре означают работу НАД
 * ПАЦИЕНТОМ: пробу взяли, приём начали, результат внесли, выдали. Ни одного из
 * них не бывает у человека, который до клиники не доехал.
 */
export const EVIDENCE_SERVICE_STATUSES = Object.freeze(['collected', 'in_progress', 'resulted', 'completed']);

const norm = (v) => String(v ?? '').trim();

/** Строки заявок, держащие этот визит. Пусто — визит заведён не из заявки. */
function linesOf(db, visitId) {
  return db.prepare(`
    SELECT id, request_id, status, scheduled_date
      FROM crm_request_services WHERE visit_id = ?
  `).all(visitId);
}

function parentsOf(db, requestIds) {
  const holes = requestIds.map(() => '?').join(',');
  return db.prepare(`SELECT id, status, scheduled_date FROM crm_requests WHERE id IN (${holes})`).all(...requestIds);
}

// CRM_UNIFY_V1 (ревью задач 5–6, I-5) — ЧТО ИЗ ЭТОГО ДВИЖЕНИЕ КАРТОЧКИ.
// updated_at — «последний контакт» для окна повторного обращения
// (contact-window.js). Переход, который сервер делает сам, контактом с
// пациентом не является и updated_at не трогает (bump = false):
//   • неявка по календарю — факт отсутствия, не обращение;
//   • отмена записи — карточка возвращается ждать, нового обращения нет.
// Приход (arrived, в том числе по деньгам, работе, стойке) — человек в клинике:
// updated_at двигается, как и раньше (закрытая только что карточка в окне —
// это тот же человек, решение 3 и Р5).
const setParent = (db, bump = true) => db.prepare(`
  UPDATE crm_requests
     SET status = ?, scheduled_date = ?${bump ? ", updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')" : ''}
   WHERE id = ?
`);

/** Пишем, только если что-то действительно меняется: идемпотентность даром. */
function writeParent(stmt, parent, status, when) {
  if (status === parent.status && when === parent.scheduled_date) return;
  stmt.run(status, when, parent.id);
}

/**
 * ЗАЯВКА БЕЗ СТРОК — ТОЖЕ ЗАЯВКА, И ЕЁ ТОЖЕ НАДО ЗАКРЫТЬ.
 *
 * Лид, заведённый из звонка (crm/lead-from-call.js), не имеет ни одной строки
 * услуг: оператор поговорил с человеком, и всё. Такой заявке нечем взять
 * visit_id, то есть ссылочное правило выше до неё не дотягивается НИКОГДА —
 * а до сегодня её закрывал приход (CRM_AUTO_CAME_V1). Без этого прохода она
 * висела бы в своей колонке вечно и уезжала бы в отчёт недошедшей.
 *
 * Условие то же, что у строки: заявка ЖИВА, ждать ей нечего (ни одной строки
 * 'pending') и она либо без даты («когда придёт»), либо ровно на этот день.
 * Заявка, назначенная на другой день, сегодняшним приходом не закрывается —
 * то самое правило CRM_FUTURE_LEAD_V2, ради которого оно однажды и появилось.
 *
 * CRM_UNIFY_V1 (ревью задачи 3, R5) — заявка БЕЗ ДАТЫ закрывается приходом,
 * только если она двигалась в окне повторного обращения (updated_at, иначе
 * created_at; windowHours, 72 ч) — то же правило, что у стойки (deskCloses в
 * crm/visit-link.js). Трёхмесячный «Новый лид» без записи — о другом
 * обращении: приход сегодня его не закрывает, ни на стойке, ни оплатой.
 * Заявка на этот день закрывается, как и прежде, любой давности.
 *
 * Сидовую «Не пришёл» этого дня поднимает liftMissed (ниже) — и со строками.
 */
function settleLineless(db, { patientId, day, open, won, write }) {
  if (!patientId || !open.length) return;
  const holes = open.map(() => '?').join(',');
  const reqs = db.prepare(`
    SELECT r.id, r.status, r.scheduled_date
      FROM crm_requests r
     WHERE r.patient_id = ? AND r.status IN (${holes})
       AND (date(r.scheduled_date) = date(?)
            OR ((r.scheduled_date IS NULL OR r.scheduled_date = '') AND ${inWindowSql('r')}))
       AND NOT EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending')
  `).all(patientId, ...open, day, windowArg(windowHours(db)));   // CRM_UNIFY_V1 (задача 6) — одно правило окна
  for (const p of reqs) writeParent(write, p, won, p.scheduled_date);
}

/**
 * CRM_UNIFY_V1 (задача 5; ревью задач 5–6, I-1) — САМОИСПРАВЛЕНИЕ «НЕ ПРИШЁЛ».
 *
 * Сервер ставит «Не пришёл», когда прихода в день записи не видно
 * (crm/no-show.js). Доказательство, пришедшее ПОЗЖЕ, — вчерашний визит оплатили
 * сегодня, порция соседнего здания доехала через crmFromSync, пациент пришёл
 * другим визитом того дня — это приход на назначенный день: сидовая «Не
 * пришёл» этого пациента поднимается в конверсию правилом прихода (Р8), если её
 * день — этот день: дата карточки, ждущая строка этого дня или живая запись
 * этого дня (строкой или привязкой crm_booking_links). Ждущие строки ей не
 * мешают: первый приход закрывает карточку, строки других дней остаются
 * записями. Строки не трогаются (инвариант: 'done' — только строка, чья услуга
 * в визите). Другой день, другой пациент (общий номер) и будущий визит — нет:
 * будущий визит приходом не бывает (сторож в crmVisitStatus).
 */
function liftMissed(db, { patientId, day, won, write }) {
  if (!patientId) return;
  const live = "v.status NOT IN ('cancelled', 'no_show')";
  let links = '';
  try { db.prepare('SELECT 1 FROM crm_booking_links LIMIT 1').get(); links = `
            OR EXISTS (SELECT 1 FROM crm_booking_links b JOIN visits v ON v.id = b.visit_id
                        WHERE b.request_id = r.id AND ${live} AND ${localDate('v.visit_date')} = date(@day))`; }
  catch { links = ''; }   // сборка без 187
  const reqs = db.prepare(`
    SELECT r.id, r.status, r.scheduled_date FROM crm_requests r
     WHERE r.patient_id = @pid AND r.status = @missed
       AND (date(r.scheduled_date) = date(@day)
            OR EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending' AND date(l.scheduled_date) = date(@day))
            OR EXISTS (SELECT 1 FROM crm_request_services l JOIN visits v ON v.id = l.visit_id
                        WHERE l.request_id = r.id AND l.status <> 'cancelled' AND ${live}
                          AND ${localDate('v.visit_date')} = date(@day))${links})`)
    .all({ pid: patientId, missed: SEED_NO_SHOW_STAGE, day });
  for (const p of reqs) writeParent(write, p, won, p.scheduled_date);
}

/**
 * ЧТО ДЕЛАЕТ СМЕНА СТАТУСА ВИЗИТА С ЗАЯВКАМИ, ЧЬИ СТРОКИ ЕГО ДЕРЖАТ.
 *
 *   arrived    — строки этого визита закрываются ('done'), и заявка становится
 *                конверсией. CRM_UNIFY_V1 (инвариант) — закрывается только
 *                строка, чья услуга В ВИЗИТЕ: сначала строки без строки визита
 *                встают в визит (placeHeldLines), не встали — ждут. CRM_UNIFY_V1 — ПЕРВЫЙ ПРИХОД ЗАКРЫВАЕТ КАРТОЧКУ
 *                (решение владельца 1, Р8): «Пришёл» ставится сразу, даже если
 *                у заявки остались строки на другие дни, — они остаются в
 *                карточке и в календаре как записи (прежде заявка на три дня
 *                возвращалась в «Записан» до последнего дня). Закрываются
 *                заявки, чьи строки держат визит, и (Р9) привязанные к нему
 *                только записью (crm_booking_links). Из живых колонок и из
 *                сидовой «Не пришёл»: пришедший воскрешает недошедшую заявку —
 *                он пришёл сейчас, и это та самая конверсия. «Пришёл», «Отказ»
 *                и прочие закрытые не меняются (решение 3). Плюс проход по
 *                заявкам БЕЗ СТРОК того же пациента (settleLineless).
 *   no_show    — заявка уходит в «Не пришёл», и только из живых ступеней.
 *                Строки остаются со своим visit_id: неявка — это факт об
 *                этой записи, и он не стирается. Записать такую строку заново
 *                можно (см. crmLinkVisit, шаг A: мёртвый визит не держит — CRM_UNIFY_V1).
 *   cancelled  — строки снимаются со слота и снова ждут записи; заявка
 *                откатывается из «Записан» в первую открытую колонку, если
 *                занятых дней у неё больше не осталось.
 *
 * Всё остальное ('scheduled', 'confirmed' и возврат назад) заявку не трогает.
 *
 * @param {object} db
 * @param {{visitId:number, from:?string, to:string}} p — from/to: статус визита
 *        ДО и ПОСЛЕ записи. Равные значения — не событие, и работы здесь нет.
 */
export function crmVisitStatus(db, { visitId, from, to } = {}) {
  try {
    const id = Number(visitId);
    if (!Number.isInteger(id) || id <= 0) return;
    const now = norm(to);
    // Статус не менялся — не меняется и заявка. Это и есть защита от повтора:
    // «пришёл» поверх «пришёл» не должен пересчитывать ничего второй раз.
    if (!now || now === norm(from)) return;
    if (!ARRIVED_STATUSES.includes(now) && now !== 'no_show' && now !== 'cancelled') return;

    const visit = db.prepare(`
      -- FINAL_MONEY_FIX_V1 (M6) — день визита МЕСТНЫЙ (как ensure_visit и
      -- отчёты): substr(visit_date, 1, 10) давал день по UTC, и приход после
      -- полуночи по местному закрывал вчерашние заявки вместо сегодняшних.
      SELECT id, patient_id, ${localDate('visit_date')} AS day,
             (${localDate('visit_date')} > date('now','localtime')) AS future
        FROM visits WHERE id = ?
    `).get(id);
    if (!visit) return;
    // НА ПРИЁМ, КОТОРЫЙ ЕЩЁ НЕ НАСТУПИЛ, ПРИЙТИ НЕЛЬЗЯ. Сторож стоит здесь, а
    // не у одной из дверей, чтобы любая новая дверь получила его даром:
    // будущий визит не закрывает заявку ни оплатой, ни актом, ни работой,
    // ни отметкой «пришёл». Неявка и отмена будущего визита — законные
    // события, их сторож не трогает.
    if (visit.future && ARRIVED_STATUSES.includes(now)) return;

    const lines = linesOf(db, id);
    const requestIds = [...new Set(lines.map((l) => l.request_id).filter(Boolean))];
    const parents = requestIds.length ? parentsOf(db, requestIds) : [];
    // CRM_UNIFY_V1 (Р9) — и карточки, привязанные к визиту только записью
    // (crm_booking_links, без строк): их закрывает приход, и (задача 5) в «Не
    // пришёл» их уводит неявка — иначе запись из календаря без строк заявки не
    // узнавала ни о том, ни о другом.
    // CRM_UNIFY_V1 (ревью, M-1) — и отмена: симметрично приходу и неявке.
    let linked = [];
    if (ARRIVED_STATUSES.includes(now) || now === 'no_show' || now === 'cancelled') {
      try {
        linked = db.prepare(`SELECT r.id, r.status, r.scheduled_date FROM crm_booking_links b
                               JOIN crm_requests r ON r.id = b.request_id WHERE b.visit_id = ?`).all(id);
      } catch { linked = []; }   // сборка без 187
    }
    // Приход обязан дойти до заявки БЕЗ СТРОК, поэтому выходим раньше времени
    // только там, где работать действительно не с чем.
    if (!parents.length && !linked.length && !ARRIVED_STATUSES.includes(now)) return;

    const open = openStageKeys(db);
    const scheduled = scheduledStageKey(db);
    const write = setParent(db);              // приход — движение карточки
    const quiet = setParent(db, false);       // CRM_UNIFY_V1 (ревью, I-5) — неявка и отмена — нет
    const pendingLeft = db.prepare(`
      SELECT COUNT(*) AS n, MIN(NULLIF(scheduled_date, '')) AS next,
             SUM(visit_id IS NOT NULL) AS booked
        FROM crm_request_services WHERE request_id = ? AND status = 'pending'
    `);
    // Строки и привязка — одна карточка один раз.
    const withLinked = () => {
      const all = new Map();
      for (const p of [...parents, ...linked]) if (!all.has(p.id)) all.set(p.id, p);
      return [...all.values()];
    };

    if (ARRIVED_STATUSES.includes(now)) {
      const won = wonStageKey(db);
      if (parents.length) {
        // CRM_UNIFY_V1 (проверка ревью задачи 3, N1/P2) — СНАЧАЛА УСЛУГИ:
        // строки, которые визит держит, а в визите их нет (взяли после прихода
        // или при счёте), встают в визит 'added' — касса видит их в «Ждут
        // счёта» (booking-mirror.js placeHeldLines).
        placeHeldLines(db, id);
        // ИНВАРИАНТ (решение контролёра) — ЕДИНСТВЕННОЕ МЕСТО, ГДЕ СТРОКА
        // ЗАЯВКИ СТАНОВИТСЯ 'done': только строка, чья услуга ДЕЙСТВИТЕЛЬНО в
        // визите (строка визита visit_service_id этого визита). Поставить её в
        // визит не удалось (хирургия, снятая с продажи, визит соседнего здания)
        // — строка ждёт, а не пропадает молча с «выполнено» без услуги, счёта и
        // анализа. Ступень карточки от этого не зависит (ниже).
        db.prepare(`UPDATE crm_request_services SET status = 'done'
                     WHERE visit_id = ? AND status = 'pending'
                       AND EXISTS (SELECT 1 FROM visit_services vs
                                    WHERE vs.id = crm_request_services.visit_service_id
                                      AND vs.visit_id = crm_request_services.visit_id
                                      AND COALESCE(vs.status, '') <> 'cancelled')`).run(id);
      }
      for (const p of withLinked()) {
        // CRM_UNIFY_V1 — ПЕРВЫЙ ПРИХОД ЗАКРЫВАЕТ КАРТОЧКУ (решение владельца 1,
        // Р8): строки других дней остаются в карточке и в календаре как записи.
        // Закрываются живые колонки и сидовая «Не пришёл»; «Пришёл», «Отказ» и
        // прочие закрытые не меняются (решение 3).
        if (!open.includes(p.status) && p.status !== SEED_NO_SHOW_STAGE) continue;
        writeParent(write, p, won, p.scheduled_date);
      }
      // Строго ПОСЛЕ: заявка, у которой строки только что закрылись, уже
      // стоит в «Пришёл» и живой не считается — второй раз её не тронут.
      settleLineless(db, { patientId: visit.patient_id, day: visit.day, open, won, write });
      liftMissed(db, { patientId: visit.patient_id, day: visit.day, won, write });   // CRM_UNIFY_V1 (ревью, I-1)
      return;
    }

    if (now === 'no_show') {
      // «Не пришёл» берётся ТОЛЬКО сидовым именем. Запасной вариант
      // noShowStageKey() отдаёт первую проигрышную колонку, и у клиники,
      // убравшей сидовую, неявка уносила бы заявку в «Обработка остановлена» —
      // совсем другой факт о ней.
      const noShow = noShowStageKey(db);
      if (noShow !== SEED_NO_SHOW_STAGE) return;
      for (const p of withLinked()) {   // CRM_UNIFY_V1 (Р9) — и привязанные записью
        // Только из ЖИВЫХ: уже закрытую заявку неявка не переписывает, а
        // дошедшую — тем более (пациент был, визит ему потом отменили —
        // конверсия от этого не исчезает).
        if (!open.includes(p.status)) continue;
        writeParent(quiet, p, noShow, p.scheduled_date);   // CRM_UNIFY_V1 (ревью, I-5) — не движение
      }
      return;
    }

    // ЗАПИСЬ ОТМЕНЕНА — СЛОТ ВОЗВРАЩАЕТСЯ ЗАЯВКЕ, А НЕ ПРОПАДАЕТ ВМЕСТЕ С НЕЙ.
    //
    // Строки снимаются с отменённого визита и снова становятся «ждущими без
    // слота»: их можно записать заново, и подстановка сметы их по-прежнему
    // видит. Закрытые (done) не трогаются: там пациент уже был.
    db.prepare("UPDATE crm_request_services SET visit_id = NULL WHERE visit_id = ? AND status = 'pending'").run(id);
    const first = open[0] || null;
    // CRM_UNIFY_V1 (ревью, M-1) — и карточки, привязанные к визиту только
    // записью (crm_booking_links): иначе отменённая запись календаря оставляла
    // карточку «Записан», и наутро проход уносил её в «Не пришёл». Занятым днём
    // считается и другая живая запись по привязке.
    let otherLink = () => false;
    try {
      const q = db.prepare(`SELECT 1 FROM crm_booking_links b JOIN visits v ON v.id = b.visit_id
                             WHERE b.request_id = ? AND b.visit_id <> ? AND v.status NOT IN ('cancelled', 'no_show') LIMIT 1`);
      otherLink = (rid) => !!q.get(rid, id);
    } catch { /* сборка без 187 */ }
    const byLine = new Set(parents.map((p) => p.id));
    for (const p of withLinked()) {
      // Выигранную и проигранную заявку отмена визита не трогает вовсе:
      // «Пришёл» — это факт прошлого, и отменённая запись его не отменяет.
      if (!open.includes(p.status)) continue;
      const left = pendingLeft.get(p.id);
      // Дата: у карточки со строками — ближайшая ждущая строка (как раньше);
      // у привязанной только записью — ближайший записанный день (cardDateOf),
      // иначе пусто: дата отменённой записи не остаётся висеть.
      const when = byLine.has(p.id) ? ((left && left.next) || null) : cardDateOf(db, p.id, (left && left.next) || null);
      // Назад в первую открытую колонку — только если заявка стоит в
      // «Записан» и ПОСЛЕ отмены у неё не осталось ни одного занятого дня.
      // Заявка на три дня, у которой отменили один, остаётся записанной: два
      // других слота никуда не делись.
      const stillBooked = !!(left && left.booked) || otherLink(p.id);
      const undo = scheduled && p.status === scheduled && !stillBooked && first;
      writeParent(quiet, p, undo ? first : p.status, when);   // CRM_UNIFY_V1 (ревью, I-5) — отмена не движение
    }
  } catch (e) {
    console.error('[crm] заявки по визиту', visitId, 'не пересчитаны:', e && e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ДОКАЗАТЕЛЬСТВА ПРИХОДА, КОТОРЫЕ НЕ ЯВЛЯЮТСЯ СТАТУСОМ ВИЗИТА
// ═══════════════════════════════════════════════════════════════════════════
//
// КНОПКУ «ПРИШЁЛ» В КЛИНИКЕ НЕ НАЖИМАЕТ НИКТО. Это не предположение: на боевой
// базе ВСЕ 390 визитов имеют статус 'scheduled' и ни один — 'arrived', при этом
// 389 счетов оплачены (разбор — в шапке custdev/sync.js). Регистратура
// принимает человека, он платит на кассе, врач его принимает, и статус визита
// за всё это время не трогает никто.
//
// Значит правило «Пришёл = пришёл» нельзя вешать на одну эту кнопку: воронка
// колл-центра осталась бы пустой навсегда, а ночная автоматика уносила бы в
// «Не пришёл» пациентов, которые сидели в коридоре. Отметка прихода — ЛУЧШЕЕ
// доказательство, но не единственное. Ещё два не могут произойти заочно:
//
//   ДЕНЬГИ. Платёж на кассе — событие с человеком у окна. Его же считает
//   доказательством присутствия доска Cust Dev, и по той же причине.
//   РАБОТА НАД ПАЦИЕНТОМ. Проба взята, приём начат, результат внесён, услуга
//   выдана — ни одного из этих статусов не бывает у того, кто не доехал.
//
// Статус самого визита при этом НЕ МЕНЯЕТСЯ: доказательство — это факт о
// пациенте, а visits.status остаётся тем, что поставил человек (и тем, что
// уедет филиалам). Здесь он только ЧИТАЕТСЯ — чтобы не принять предоплату за
// приход по отменённой записи.

/**
 * «Есть доказательство, что пациент был здесь» — тот же переход, что у
 * отметки прихода. Идемпотентен по построению: строки уже закрыты, заявка уже
 * в «Пришёл», и повторный вызов не находит, что менять.
 */
export function crmVisitEvidence(db, visitId) {
  try {
    const id = Number(visitId);
    if (!Number.isInteger(id) || id <= 0) return;
    // ДОКАЗАТЕЛЬСТВО НЕ МОЖЕТ ОПЕРЕЖАТЬ ДЕНЬ ВИЗИТА (разбор ревью). Мастер
    // визита выставляет счёт по акту В ТОТ ЖЕ КЛИК, что и записывает, — на
    // каждый день корзины, включая будущие. Без этой строки заявка на
    // следующий вторник становилась «Пришёл» сегодня. Вчерашний визит,
    // оплаченный сегодня, наоборот, законен: деньги за прошлое приходят
    // позже сплошь и рядом.
    const visit = db.prepare(`
      SELECT status, (${localDate('visit_date')} > date('now','localtime')) AS future
        FROM visits WHERE id = ?
    `).get(id);
    if (!visit || DEAD_VISIT_STATUSES.includes(visit.status) || visit.future) return;
    crmVisitStatus(db, { visitId: id, from: null, to: ARRIVED_STATUSES[0] });
  } catch (e) {
    console.error('[crm] доказательство прихода по визиту', visitId, 'не учтено:', e && e.message);
  }
}

/** Оплата счёта: доказательством является ВИЗИТ этого счёта, если он есть. */
export function crmInvoiceEvidence(db, invoiceId) {
  try {
    const id = Number(invoiceId);
    if (!Number.isInteger(id) || id <= 0) return;
    // Счёт госпитализации и счёт-депозит визита не имеют вовсе — тогда и
    // доказывать нечего.
    //
    // paid_amount > 0 — потому что доказательством являются ДЕНЬГИ, а не
    // существование счёта: выставленный и неоплаченный счёт заводят заочно, а
    // возврат обнуляет оплату обратно.
    const inv = db.prepare('SELECT visit_id, paid_amount FROM invoices WHERE id = ?').get(id);
    if (inv && inv.visit_id && Number(inv.paid_amount) > 0) crmVisitEvidence(db, inv.visit_id);
  } catch (e) {
    console.error('[crm] оплата счёта', invoiceId, 'не учтена:', e && e.message);
  }
}

/**
 * Работа над услугами: доказательством является визит каждой из них.
 * @param {number[]} visitServiceIds строки visit_services, которые только что
 *        перешли в один из EVIDENCE_SERVICE_STATUSES.
 */
export function crmServiceEvidence(db, visitServiceIds) {
  try {
    const ids = (Array.isArray(visitServiceIds) ? visitServiceIds : [visitServiceIds])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return;
    const holes = ids.map(() => '?').join(',');
    // Доказательство читается С САМОЙ СТРОКИ, а не со слов вызывающего: строку
    // заводят в смету заочно ('added'), и оплата её тоже не трогает руками
    // пациента ('queued'). Работой считаются только четыре статуса из
    // EVIDENCE_SERVICE_STATUSES — и проверяются они здесь, в одном месте, чтобы
    // ни один из пяти вызывающих не мог ошибиться этим по-своему.
    const marks = EVIDENCE_SERVICE_STATUSES.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT DISTINCT visit_id FROM visit_services
        WHERE id IN (${holes}) AND status IN (${marks})`,
    ).all(...ids, ...EVIDENCE_SERVICE_STATUSES);
    for (const r of rows) if (r.visit_id) crmVisitEvidence(db, r.visit_id);
  } catch (e) {
    console.error('[crm] работа по услугам', visitServiceIds, 'не учтена:', e && e.message);
  }
}