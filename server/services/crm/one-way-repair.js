// ═══════════════════════════════════════════════════════════════════════════
// CRM_ONE_WAY_V1 (2026-10-17) — РАЗОВОЕ ИСПРАВЛЕНИЕ ПРИ УСТАНОВКЕ (O8)
// ═══════════════════════════════════════════════════════════════════════════
//
// Спецификация docs/specs/2026-10-17-crm-one-way-booking-design.md, правило O8: «Upgrade
// repair (one-off, logged, conservative)». До CRM_ONE_WAY_V1 зеркало записи копировало услуги
// визита в карточку строками и отпускало строки отменённой записи с днём и ссылкой на её строку
// визита. В базах клиник это осталось — и без исправления строка отменённой записи садилась бы
// в следующую запись того же дня (повторы ревью M1, M2, C1). Исправляем ОДИН раз — при первом
// запуске после миграции 246, после исправления CRM_UNIFY_V1 и до первого прохода «Не пришёл»
// (server/index.js).
//
// ЧТО ДЕЛАЕТСЯ (только строки карточек — crm_request_services):
//   1. КОПИИ ЗЕРКАЛА УХОДЯТ (deleted_copy). Строка карточки — копия строки визита, если её
//      завело зеркало: она указывает на строку визита (visit_service_id), её визит — визит той
//      строки или пуст, строку визита завела не CRM (visit_service_auto = 0), и сама строка
//      заведена в ту же секунду-две, что и строка визита (зеркало заводило копию тем же
//      запросом: шаг 3 сверки, касса — mirrorCashierLine). Строку оператора окно карточки
//      заводит всегда БЕЗ визита и раньше или позже — по ней такого совпадения не бывает;
//      строка, которая не подходит под правило точно, остаётся (kept_ambiguous — только запись в
//      журнал): строку, заведённую оператором, исправление не удаляет никогда. Услуги визита
//      карточка показывает списком «Записи пациента».
//   2. СТРОКИ ОТМЕНЁННОЙ ЗАПИСИ — ОТПУЩЕННЫЕ ЖЕЛАНИЯ (released): ждущая строка, которая держит
//      отменённый визит, — без дня, без визита, с отметкой (O4), как после отмены сейчас.
//   3. ССЫЛКИ, ОСТАВЛЕННЫЕ ПРЕЖНЕЙ ОТМЕНОЙ (released_stale / cleared_stale): ждущая строка без
//      визита, чья строка визита — в отменённом визите. День строки — день той записи (или
//      пуст): отмена её и отпустила — отпущенное желание (O4). Оператор дал ей другой день —
//      обычное желание того дня, ссылка снимается.
//   4. ССЫЛКА В ДРУГОЙ ЖИВОЙ ВИЗИТ (cleared_moved / released_cross): прежнее окно карточки
//      переносило строку на другой день, а её строку визита везло зеркало при следующей записи.
//      Строки визита CRM больше не возит (O6): у строки без визита ссылка снимается (желание
//      своего дня; прежний визит — решение регистратуры), строка, державшая один визит со
//      строкой визита в другом, — отпущенное желание (ни в какой визит сама не сядет).
// НИКОГДА: строки визитов, счета, платежи, ступени и даты карточек; снятые строки ('cancelled').
// Каждое изменение — строка crm_one_way_repair_log; итог — отметка crm_one_way_repair и одна
// строка журнала сервера. Правки, журнал и отметка — одна транзакция: упало — ничего, повтор
// при следующем запуске; отметка стоит — второй раз ничего не делается.
import { localDate } from '../domain/day.js';

const COPY_GAP_SECONDS = 2;
const RACED = Symbol('crm-one-way-repair-raced');

export function crmOneWayRepair(db) {
  const zero = { skipped: false, failed: false, counts: {}, summary: null };
  let mark;
  try { mark = db.prepare('SELECT done_at FROM crm_one_way_repair WHERE id = 1').get(); } catch { mark = null; }
  if (!mark || mark.done_at) return { ...zero, skipped: true };
  const counts = { deleted_copy: 0, kept_ambiguous: 0, released: 0, released_stale: 0, cleared_stale: 0, cleared_moved: 0, released_cross: 0 };
  try {
    db.transaction(() => {
      const log = db.prepare(`INSERT INTO crm_one_way_repair_log (line_id, request_id, visit_id, visit_service_id, action, detail)
                              VALUES (?, ?, ?, ?, ?, ?)`);
      const note = (l, action, detail = null) => { log.run(l.id, l.request_id, l.visit_id ?? null, l.visit_service_id ?? null, action, detail); counts[action]++; };
      const release = db.prepare(`UPDATE crm_request_services
                                     SET released_from_visit_id = ?, released_vs_id = ?, scheduled_date = NULL,
                                         visit_id = NULL, visit_service_id = NULL
                                   WHERE id = ?`);

      // 1. Копии зеркала.
      const copies = db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id,
               (julianday(l.created_at) - julianday(vs.created_at)) * 86400.0 AS gap
          FROM crm_request_services l
          JOIN visit_services vs ON vs.id = l.visit_service_id
         WHERE l.status IN ('pending', 'done') AND COALESCE(l.visit_service_auto, 0) = 0
           AND (l.visit_id IS NULL OR l.visit_id = vs.visit_id)`).all();
      const del = db.prepare('DELETE FROM crm_request_services WHERE id = ?');
      for (const c of copies) {
        if (c.gap != null && c.gap >= 0 && c.gap <= COPY_GAP_SECONDS) { note(c, 'deleted_copy', `gap ${Math.round(c.gap * 10) / 10} s`); del.run(c.id); }
        else note(c, 'kept_ambiguous', c.gap == null ? null : `gap ${Math.round(c.gap)} s`);
      }

      // 2. Строки, державшие отменённый визит.
      for (const l of db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id,
               CASE WHEN vs.id IS NOT NULL AND vs.visit_id = l.visit_id AND vs.status <> 'cancelled' THEN vs.id END AS keep
          FROM crm_request_services l
          JOIN visits w ON w.id = l.visit_id AND w.status = 'cancelled'
          LEFT JOIN visit_services vs ON vs.id = l.visit_service_id
         WHERE l.status = 'pending'`).all()) {
        note(l, 'released');
        release.run(l.visit_id, l.keep ?? null, l.id);
      }

      // 3–4. Ссылки на строки визитов, которые строка уже не держит.
      const clear = db.prepare('UPDATE crm_request_services SET visit_service_id = NULL, visit_service_auto = 0 WHERE id = ?');
      for (const l of db.prepare(`
        SELECT l.id, l.request_id, l.visit_id, l.visit_service_id, l.scheduled_date,
               w.id AS w_id, w.status AS w_status, ${localDate('w.visit_date')} AS w_day
          FROM crm_request_services l
          JOIN visit_services vs ON vs.id = l.visit_service_id
          JOIN visits w ON w.id = vs.visit_id
         WHERE l.status = 'pending' AND (l.visit_id IS NULL OR l.visit_id <> vs.visit_id)`).all()) {
        if (l.visit_id == null && l.w_status === 'cancelled') {
          const sameDay = !l.scheduled_date || String(l.scheduled_date).slice(0, 10) === l.w_day;
          if (sameDay) { note(l, 'released_stale', `visit ${l.w_id}`); release.run(l.w_id, l.visit_service_id, l.id); }
          else { note(l, 'cleared_stale', `day ${l.scheduled_date}`); clear.run(l.id); }
        } else if (l.visit_id == null) {
          note(l, 'cleared_moved', `visit ${l.w_id}`); clear.run(l.id);
        } else {
          note(l, 'released_cross', `line visit ${l.visit_id}, visit line in ${l.w_id}`); release.run(l.visit_id, null, l.id);
        }
      }

      const summary = 'CRM: строки записи переведены на одно направление (CRM_ONE_WAY_V1) — '
        + `копий удалено: ${counts.deleted_copy}, отпущено: ${counts.released + counts.released_stale + counts.released_cross}, `
        + `ссылок снято: ${counts.cleared_stale + counts.cleared_moved}, оставлено строк оператора: ${counts.kept_ambiguous}.`;
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
