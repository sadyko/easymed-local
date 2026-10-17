// ═══════════════════════════════════════════════════════════════════════════
// CRM_ONE_WAY_V1 (2026-10-17) — РАЗОВОЕ ИСПРАВЛЕНИЕ ПРИ УСТАНОВКЕ (O8)
// ═══════════════════════════════════════════════════════════════════════════
//
// Спецификация docs/specs/2026-10-17-crm-one-way-booking-design.md, правило O8: «Upgrade
// repair (one-off, logged, conservative)». До CRM_ONE_WAY_V1 зеркало записи копировало услуги
// визита в карточку строками и отпускало строки отменённой записи с днём и ссылкой на её строку
// визита. В базах клиник это осталось — и без исправления строка отменённой записи садилась бы
// в следующую запись того же дня (повторы ревью M1, M2, C1). Исправляем ОДИН раз — при первом
// запуске после миграций 246 и 248, после исправления CRM_UNIFY_V1 и до первого прохода «Не
// пришёл» (server/index.js).
//
// РЕШЕНИЕ КОНТРОЛЁРА ПО РЕВЬЮ r4 (п. 1, 5, 6) — ИСПРАВЛЕНИЕ НЕ УДАЛЯЕТ НИЧЕГО. Прежняя редакция
// удаляла «копии зеркала» по совпадению времени, и на настоящих старых базах уносила строку записи
// колл-центра (R2: она — строка записи карточки) и желание оператора, сохранённое через секунду
// после строки регистратуры. Теперь строка только отмечается, отпускается или снимается — и
// всегда остаётся в базе.
//
// ЧТО ДЕЛАЕТСЯ (только строки карточек — crm_request_services):
//   1. СТРОКИ, УКАЗЫВАЮЩИЕ НА СТРОКУ ВИЗИТА, ОСТАЮТСЯ СТРОКАМИ ЗАПИСИ и отмечаются по
//      происхождению. КОПИЯ — только по правилу 0–2 с: строку завела не CRM
//      (visit_service_auto = 0), она заведена в ту же секунду-две, что и строка визита (зеркало
//      заводило копию тем же запросом), и запись держит НЕ привязка колл-центра этой карточки
//      (регистратура: шаг C 'match' или без привязки). Строка записи колл-центра (R2) и желание
//      оператора (раньше строки визита или позже 2 с) — не копии.
//        • запись жива: копия — legacy_copy = 1 (marked_copy; отмена записи потом снимет её,
//          а не вернёт в карточку вторым желанием той же услуги); остальное — kept_booked
//          (только журнал; отмена вернёт её в карточку без дня, как сейчас);
//        • запись отменена: копия снимается ('cancelled', cancelled_copy — то, что сделала бы
//          отмена сейчас); остальное — отпущенное желание без дня (released, O4);
//        • строка уже без визита, её строка визита — в отменённом визите (её отпустила прежняя
//          отмена): копия — cancelled_copy; день строки — день той записи или пуст — отпущенное
//          желание (released_stale); оператор дал ей другой день — обычное желание того дня,
//          ссылка снимается (cleared_stale);
//        • строка без визита, её строка визита — в живом визите (прежнее окно карточки перенесло
//          строку на другой день): ссылка снимается (cleared_moved — желание своего дня);
//        • строка держит один визит, а её строка визита — в другом: отпущенное желание
//          (released_cross — ни в какой визит сама не сядет).
//      Закрытые строки ('done') — история: копии из них только пишутся в журнал (kept_done).
//   2. СТРОКА, ДЕРЖАВШАЯ ОТМЕНЁННЫЙ ВИЗИТ БЕЗ СТРОКИ ВИЗИТА, — отпущенное желание с отметкой
//      released_held (O5: отмену отменят — она снова будет держать визит) — released.
//   3. ДАТИРОВАННОЕ ЖЕЛАНИЕ БЕЗ ССЫЛКИ, ЧЬЯ КАРТОЧКА ОТМЕНИЛА ЗАПИСЬ ЭТОГО ДНЯ (released_dated):
//      прежняя «голая» отмена оставляла строке день и снимала визит — и строка садилась в любую
//      следующую запись того дня (повтор O8-B). Доказательство отмены — след записи карточки
//      (crm_booking_undo) или её привязка (crm_booking_links) на отменённый визит этого дня;
//      строка становится отпущенным желанием без дня с отметкой этого визита. Привязка «только для
//      воронки» (C′, телефон) строк карточки не брала никогда (O9) — её отменённый визит не доказательство.
// НИКОГДА: удаление строк; строки визитов, счета, платежи, ступени и даты карточек; снятые строки
// ('cancelled'). Каждая строка, о которой принято решение, — строка crm_one_way_repair_log; итог —
// отметка crm_one_way_repair и одна строка журнала сервера. Правки, журнал и отметка — одна
// транзакция: упало — ничего, повтор при следующем запуске; отметка стоит — второй раз ничего.
import { localDate } from '../domain/day.js';
import { displayLinkSql } from './display-links.js';

const COPY_GAP_SECONDS = 2;
const RACED = Symbol('crm-one-way-repair-raced');

export function crmOneWayRepair(db) {
  const zero = { skipped: false, failed: false, counts: {}, summary: null };
  let mark;
  try { mark = db.prepare('SELECT done_at FROM crm_one_way_repair WHERE id = 1').get(); } catch { mark = null; }
  if (!mark || mark.done_at) return { ...zero, skipped: true };
  const counts = {
    kept_booked: 0, marked_copy: 0, kept_done: 0, cancelled_copy: 0, released: 0,
    released_stale: 0, cleared_stale: 0, cleared_moved: 0, released_cross: 0, released_dated: 0,
  };
  try {
    db.transaction(() => {
      const log = db.prepare(`INSERT INTO crm_one_way_repair_log (line_id, request_id, visit_id, visit_service_id, action, detail)
                              VALUES (?, ?, ?, ?, ?, ?)`);
      const note = (l, action, detail = null) => { log.run(l.id, l.request_id, l.visit_id ?? null, l.visit_service_id ?? null, action, detail); counts[action]++; };
      const release = db.prepare(`UPDATE crm_request_services
                                     SET released_from_visit_id = ?, released_vs_id = ?, released_held = ?, scheduled_date = NULL,
                                         visit_id = NULL, visit_service_id = NULL
                                   WHERE id = ?`);
      const markCopy = db.prepare('UPDATE crm_request_services SET legacy_copy = 1 WHERE id = ?');
      const cancelCopy = db.prepare("UPDATE crm_request_services SET status = 'cancelled', legacy_copy = 1 WHERE id = ?");
      const clear = db.prepare('UPDATE crm_request_services SET visit_service_id = NULL, visit_service_auto = 0 WHERE id = ?');

      // 1. Строки, указывающие на строку визита.
      const pointing = db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id, l.status, l.scheduled_date,
               COALESCE(l.visit_service_auto, 0) AS auto,
               (julianday(l.created_at) - julianday(vs.created_at)) * 86400.0 AS gap,
               vs.status AS vs_status, w.id AS w_id, w.status AS w_status, ${localDate('w.visit_date')} AS w_day,
               EXISTS (SELECT 1 FROM crm_booking_links b
                        WHERE b.visit_id = w.id AND b.request_id = l.request_id AND b.source = 'callcenter') AS cc
          FROM crm_request_services l
          JOIN visit_services vs ON vs.id = l.visit_service_id
          JOIN visits w ON w.id = vs.visit_id
         WHERE l.status IN ('pending', 'done')
         ORDER BY l.id`).all();
      const gapNote = (l) => (l.gap == null ? null : `gap ${Math.round(l.gap * 10) / 10} s`);
      for (const l of pointing) {
        const copy = !Number(l.auto) && !Number(l.cc) && l.gap != null && l.gap >= 0 && l.gap <= COPY_GAP_SECONDS;
        const why = Number(l.auto) ? 'crm line' : Number(l.cc) ? 'callcenter booking (R2)' : gapNote(l);
        if (l.status === 'done') { if (copy) note(l, 'kept_done', gapNote(l)); continue; }
        if (l.visit_id === l.w_id) {
          if (l.w_status === 'cancelled') {
            if (copy) { note(l, 'cancelled_copy', gapNote(l)); cancelCopy.run(l.id); }
            else { note(l, 'released', why); release.run(l.w_id, l.vs_status !== 'cancelled' ? l.visit_service_id : null, 0, l.id); }
          } else if (copy) { note(l, 'marked_copy', gapNote(l)); markCopy.run(l.id); }
          else note(l, 'kept_booked', why);
        } else if (l.visit_id == null && l.w_status === 'cancelled') {
          if (copy) { note(l, 'cancelled_copy', `${gapNote(l)}, visit ${l.w_id}`); cancelCopy.run(l.id); continue; }
          const sameDay = !l.scheduled_date || String(l.scheduled_date).slice(0, 10) === l.w_day;
          if (sameDay) { note(l, 'released_stale', `visit ${l.w_id}`); release.run(l.w_id, l.visit_service_id, 0, l.id); }
          else { note(l, 'cleared_stale', `day ${l.scheduled_date}`); clear.run(l.id); }
        } else if (l.visit_id == null) {
          note(l, 'cleared_moved', `visit ${l.w_id}`); clear.run(l.id);
        } else {
          note(l, 'released_cross', `line visit ${l.visit_id}, visit line in ${l.w_id}`); release.run(l.visit_id, null, 0, l.id);
        }
      }

      // 2. Строки, державшие отменённый визит без строки визита.
      for (const l of db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id FROM crm_request_services l
          JOIN visits w ON w.id = l.visit_id AND w.status = 'cancelled'
         WHERE l.status = 'pending' AND l.visit_service_id IS NULL ORDER BY l.id`).all()) {
        note(l, 'released', 'held without a visit line');
        release.run(l.visit_id, null, 1, l.id);
      }

      // 3. Датированные желания без ссылки, чья карточка отменила запись этого дня.
      for (const l of db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id, l.scheduled_date,
               (SELECT MAX(w.id) FROM visits w
                 WHERE w.status = 'cancelled' AND ${localDate('w.visit_date')} = date(l.scheduled_date)
                   AND (w.id IN (SELECT u.visit_id FROM crm_booking_undo u WHERE u.request_id = l.request_id)
                        OR w.id IN (SELECT b.visit_id FROM crm_booking_links b WHERE b.request_id = l.request_id))
                   AND NOT EXISTS (SELECT 1 FROM crm_booking_links b WHERE b.visit_id = w.id AND b.request_id = l.request_id
                                      AND ${displayLinkSql('b')})) AS w_id
          FROM crm_request_services l
         WHERE l.status = 'pending' AND l.visit_id IS NULL AND l.visit_service_id IS NULL
           AND l.released_from_visit_id IS NULL AND l.scheduled_date IS NOT NULL AND l.scheduled_date <> ''
         ORDER BY l.id`).all()) {
        if (!l.w_id) continue;
        note(l, 'released_dated', `day ${String(l.scheduled_date).slice(0, 10)}, cancelled visit ${l.w_id}`);
        release.run(l.w_id, null, 0, l.id);
      }

      const released = counts.released + counts.released_stale + counts.released_cross + counts.released_dated;
      const summary = 'CRM: строки записи переведены на одно направление (CRM_ONE_WAY_V1), ничего не удалено — '
        + `строк записи оставлено: ${counts.kept_booked}, копий отмечено: ${counts.marked_copy}, `
        + `копий отменённых записей снято: ${counts.cancelled_copy}, отпущено без дня: ${released}, `
        + `ссылок снято: ${counts.cleared_stale + counts.cleared_moved}.`;
      const done = db.prepare(`UPDATE crm_one_way_repair SET done_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary = ?
                                WHERE id = 1 AND done_at IS NULL`).run(summary);
      if (!done.changes) throw RACED;   // отметку поставил другой запуск — откатить своё
      zero.summary = summary;
    })();
  } catch (e) {
    if (e === RACED) return { ...zero, skipped: true };
    console.error('[crm-one-way-repair] исправление не выполнено:', e && e.message);   // CRM_ONE_WAY_V1
    return { ...zero, failed: true };
  }
  const anything = Object.values(counts).some((n) => n > 0);
  return { ...zero, counts, summary: anything ? zero.summary : null };
}
