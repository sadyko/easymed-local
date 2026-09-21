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

const norm = (v) => String(v ?? '').trim();

/**
 * Заявки, которым принадлежат строки этого визита, и сами строки.
 * Пусто — визит заведён не из заявки, и делать здесь нечего.
 */
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
 *                там и остаётся.
 *   no_show    — заявка уходит в «Не пришёл», и только из живых ступеней.
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

    const lines = linesOf(db, id);
    if (!lines.length) return;
    const requestIds = [...new Set(lines.map((l) => l.request_id).filter(Boolean))];
    if (!requestIds.length) return;
    const parents = parentsOf(db, requestIds);
    if (!parents.length) return;

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
      db.prepare("UPDATE crm_request_services SET status = 'done' WHERE visit_id = ? AND status = 'pending'").run(id);
      const won = wonStageKey(db);
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
