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
// Половина правила, которая осталась записи, живёт в rpc/visits.js
// (settleCrmOnBooking): строка берёт себе визит, заявка уезжает в «Записан».
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

import { openStageKeys, wonStageKey, noShowStageKey, scheduledStageKey, SEED_NO_SHOW_STAGE } from './config.js';

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

const setParent = (db) => db.prepare(`
  UPDATE crm_requests
     SET status = ?, scheduled_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
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
 */
function settleLineless(db, { patientId, day, open, won, write }) {
  if (!patientId || !open.length) return;
  const holes = open.map(() => '?').join(',');
  const reqs = db.prepare(`
    SELECT r.id, r.status, r.scheduled_date
      FROM crm_requests r
     WHERE r.patient_id = ? AND r.status IN (${holes})
       AND (r.scheduled_date IS NULL OR r.scheduled_date = '' OR date(r.scheduled_date) = date(?))
       AND NOT EXISTS (SELECT 1 FROM crm_request_services l
                        WHERE l.request_id = r.id AND l.status = 'pending')
  `).all(patientId, ...open, day);
  for (const p of reqs) writeParent(write, p, won, p.scheduled_date);
}

/**
 * ЧТО ДЕЛАЕТ СМЕНА СТАТУСА ВИЗИТА С ЗАЯВКАМИ, ЧЬИ СТРОКИ ЕГО ДЕРЖАТ.
 *
 *   arrived    — строки этого визита закрываются ('done'), и только теперь
 *                заявка вправе стать конверсией: «Пришёл» ставится, когда
 *                ждать больше нечего. Заявка на три дня после первого прихода
 *                возвращается в «Записан» с датой БЛИЖАЙШЕЙ оставшейся строки
 *                (миграция 057: родительская дата — зеркало строк, по ней
 *                живут карточка, отчёт колл-центра и ночная автоматика «Не
 *                пришёл»). Пришедший воскрешает и недошедшую заявку: он
 *                пришёл сейчас, и это та самая конверсия. Назад по ЖИВЫМ
 *                ступеням заявка не откатывается — стоящая в «Согласован»
 *                там и остаётся. Плюс проход по заявкам БЕЗ СТРОК того же
 *                пациента (settleLineless).
 *   no_show    — заявка уходит в «Не пришёл», и только из живых ступеней.
 *                Строки остаются со своим visit_id: неявка — это факт об
 *                этой записи, и он не стирается. Записать такую строку заново
 *                можно (см. settleCrmOnBooking: мёртвый визит не держит).
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

    const visit = db.prepare('SELECT id, patient_id, substr(visit_date, 1, 10) AS day FROM visits WHERE id = ?').get(id);
    if (!visit) return;

    const lines = linesOf(db, id);
    const requestIds = [...new Set(lines.map((l) => l.request_id).filter(Boolean))];
    const parents = requestIds.length ? parentsOf(db, requestIds) : [];
    // Приход обязан дойти до заявки БЕЗ СТРОК, поэтому выходим раньше времени
    // только там, где работать действительно не с чем.
    if (!parents.length && !ARRIVED_STATUSES.includes(now)) return;

    const open = openStageKeys(db);
    const scheduled = scheduledStageKey(db);
    const schedAt = scheduled ? open.indexOf(scheduled) : -1;
    const write = setParent(db);
    const pendingLeft = db.prepare(`
      SELECT COUNT(*) AS n, MIN(NULLIF(scheduled_date, '')) AS next,
             SUM(visit_id IS NOT NULL) AS booked
        FROM crm_request_services WHERE request_id = ? AND status = 'pending'
    `);

    if (ARRIVED_STATUSES.includes(now)) {
      const won = wonStageKey(db);
      if (parents.length) {
        db.prepare("UPDATE crm_request_services SET status = 'done' WHERE visit_id = ? AND status = 'pending'").run(id);
        for (const p of parents) {
          const left = pendingLeft.get(p.id);
          if (!left || !left.n) {
            // Ждать больше нечего — вот теперь конверсия.
            writeParent(write, p, won, p.scheduled_date);
            continue;
          }
          // Ещё есть чего ждать. Заявка стоит в «Записан» — кроме случая, когда
          // она уже ДАЛЬШЕ него по живым ступеням: назад её не отбрасываем.
          const at = open.indexOf(p.status);
          const ahead = at >= 0 && schedAt >= 0 && at > schedAt;
          const status = (scheduled && !ahead) ? scheduled : p.status;
          writeParent(write, p, status, left.next ?? null);
        }
      }
      // Строго ПОСЛЕ: заявка, у которой строки только что закрылись, уже
      // стоит в «Пришёл» и живой не считается — второй раз её не тронут.
      settleLineless(db, { patientId: visit.patient_id, day: visit.day, open, won, write });
      return;
    }

    if (now === 'no_show') {
      // «Не пришёл» берётся ТОЛЬКО сидовым именем. Запасной вариант
      // noShowStageKey() отдаёт первую проигрышную колонку, и у клиники,
      // убравшей сидовую, неявка уносила бы заявку в «Обработка остановлена» —
      // совсем другой факт о ней.
      const noShow = noShowStageKey(db);
      if (noShow !== SEED_NO_SHOW_STAGE) return;
      for (const p of parents) {
        // Только из ЖИВЫХ: уже закрытую заявку неявка не переписывает, а
        // дошедшую — тем более (пациент был, визит ему потом отменили —
        // конверсия от этого не исчезает).
        if (!open.includes(p.status)) continue;
        writeParent(write, p, noShow, p.scheduled_date);
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
    for (const p of parents) {
      // Выигранную и проигранную заявку отмена визита не трогает вовсе:
      // «Пришёл» — это факт прошлого, и отменённая запись его не отменяет.
      if (!open.includes(p.status)) continue;
      const left = pendingLeft.get(p.id);
      const when = (left && left.next) || null;
      // Назад в первую открытую колонку — только если заявка стоит в
      // «Записан» и ПОСЛЕ отмены у неё не осталось ни одного занятого дня.
      // Заявка на три дня, у которой отменили один, остаётся записанной: два
      // других слота никуда не делись.
      const stillBooked = !!(left && left.booked);
      const undo = scheduled && p.status === scheduled && !stillBooked && first;
      writeParent(write, p, undo ? first : p.status, when);
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
    const visit = db.prepare('SELECT status FROM visits WHERE id = ?').get(id);
    if (!visit || DEAD_VISIT_STATUSES.includes(visit.status)) return;
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