// TEST_DATA_WIPE_V1 (docs/specs/2026-10-29-3190-refund-swap-test-wipe-design.md,
// раздел 3) — «Удалить тестовые данные»: само удаление.
//
// Что удаляется и что остаётся, решено по каждой таблице в
// test-data-wipe-plan.js; здесь — как. Одна транзакция: либо удалено всё по
// плану, либо ничего (сбой посередине откатывает и снятый на время триггер).
//
// Зовётся ТОЛЬКО при запуске (server/index.js — после migrate, до опросов и до
// listen): ни один запрос регистратуры или кассы не может вклиниться между
// удалением визита и удалением его счёта.
import { TABLE_PLAN, WIPE_ORDER, GUARD_TRIGGERS, tablesBy } from './test-data-wipe-plan.js';
import { SHIPPED } from './branch-sync/journal.js';

const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

/** Таблицы, у которых есть внешний ключ на одну из parents. */
function childTables(db, parents) {
  return db.prepare(TABLES_SQL).all().map((r) => r.name).filter((t) =>
    db.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').all(t).some((f) => parents.has(f.parent)));
}

/** Нарушения внешних ключей по таблицам (только ненулевые). */
function fkViolations(db, tables) {
  const out = {};
  for (const t of tables) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM pragma_foreign_key_check(?)').get(t).n;
    if (n) out[t] = n;
  }
  return out;
}

const maxSeq = (db, table) => db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM "${table}"`).get().m;

/**
 * Поправка 8 к плану (владелец, 2026-10-30): стадии карточек CRM удаление НЕ
 * меняет (test-data-wipe-plan.js, crm_request_services). Карточка, которую
 * учебная запись перевела в «Записан», остаётся в своей колонке уже без
 * записи — итог говорит администратору, сколько таких карточек.
 *
 * Считаются карточки, которые держали учебный визит: строка карточки на визите
 * или на его строке (crm_request_services), привязка записи к карточке
 * (crm_booking_links) или след записи, сменившей стадию карточки
 * (crm_booking_undo). Удаление уносит ВСЕ визиты, поэтому каждая такая связь —
 * потерянная запись. Строки с отметкой «запись отменена» (released_from_visit_id)
 * не в счёт: их запись была отменена ещё до удаления. Карточки, которых уже
 * нет (у crm_booking_links и crm_booking_undo нет внешнего ключа), не в счёт.
 * Зовётся до шагов удаления — пока ссылки ещё на месте.
 */
function crmCardsUnbooked(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM crm_requests WHERE id IN (
      SELECT request_id FROM crm_request_services WHERE visit_id IS NOT NULL OR visit_service_id IS NOT NULL
      UNION SELECT request_id FROM crm_booking_links
      UNION SELECT request_id FROM crm_booking_undo)`).get().n;
}

/**
 * Следы самого удаления в служебных таблицах связи зданий. Триггеры
 * *_journal_del (мигр. 084, 087) пишут на каждую удалённую строку
 * визита, услуги, анализа, счёта, позиции и платежа 'del' в sync_journal и
 * надгробие в sync_tombstones. Клиника, связанная с другими зданиями, сюда не
 * доходит (отказ — rpc/backup.js), но связь могут завести позже: тогда эти
 * надгробия ушли бы в другое здание и стёрли бы там настоящие строки. Поэтому
 * убирается ровно то, что написано после отметки before (seq растёт всегда —
 * AUTOINCREMENT), а прежний журнал и прежние надгробия остаются. Отметки
 * «видел»/«ждёт»/«отказано» по удалённым таблицам больше ни к чему не относятся.
 */
function wipeSyncTraces(db, before) {
  const wiped = Object.keys(SHIPPED).filter((t) => TABLE_PLAN[t] && TABLE_PLAN[t].how === 'delete');
  const inList = wiped.map(() => '?').join(', ');
  return {
    sync_journal: db.prepare('DELETE FROM sync_journal WHERE seq > ?').run(before.journal).changes,
    sync_tombstones: db.prepare('DELETE FROM sync_tombstones WHERE seq > ?').run(before.tombstones).changes,
    sync_seen: db.prepare(`DELETE FROM sync_seen WHERE tbl IN (${inList})`).run(...wiped).changes,
    sync_pending: db.prepare(`DELETE FROM sync_pending WHERE tbl IN (${inList}) OR waits_tbl IN (${inList})`).run(...wiped, ...wiped).changes,
    sync_refused: db.prepare(`DELETE FROM sync_refused WHERE tbl IN (${inList})`).run(...wiped).changes,
  };
}

/**
 * Удалить тестовые данные одной транзакцией. Чистая функция над открытой
 * базой, собранной миграциями: файлов и VACUUM здесь нет (runTestDataWipe).
 *
 * @returns {{deleted: Record<string, number>, cleared: Record<string, number>, sync: Record<string, number>, crm_cards_unbooked: number}}
 *   сколько строк удалено, сколько очищено (по таблицам), сколько следов
 *   связи зданий убрано и сколько карточек CRM потеряли учебную запись (их
 *   стадии не менялись — поправка 8). Только числа и имена таблиц — данных
 *   пациентов нет.
 */
export function wipeTestData(db) {
  const deleted = {};
  const cleared = {};
  let sync = {};
  let crmUnbooked = 0;
  const gone = new Set([...tablesBy('delete'), ...tablesBy('partial')]);

  const run = db.transaction(() => {
    // Цикл admissions ↔ invoices и самоссылки (admission_reviews.superseded_by)
    // проверяются в конце транзакции; COMMIT не пройдёт, если хоть одна
    // ссылка осталась висеть. Прагма сама выключается на COMMIT/ROLLBACK.
    db.pragma('defer_foreign_keys = ON');
    const watch = childTables(db, gone);
    const fkBefore = fkViolations(db, watch);
    const before = { journal: maxSeq(db, 'sync_journal'), tombstones: maxSeq(db, 'sync_tombstones') };
    crmUnbooked = crmCardsUnbooked(db);

    // Триггеры-запреты снимаются на время транзакции и ставятся обратно тем
    // же текстом (sqlite_master): откат вернул бы и их.
    const guards = [];
    for (const names of Object.values(GUARD_TRIGGERS)) {
      for (const name of names) {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
        if (!row) continue;
        guards.push(row.sql);
        db.exec(`DROP TRIGGER "${name}"`);
      }
    }

    for (const t of WIPE_ORDER) {
      const p = TABLE_PLAN[t];
      if (p.how === 'clear') {
        cleared[t] = db.prepare(`UPDATE "${t}" SET ${p.set} WHERE ${p.where}`).run().changes;
      } else if (p.how === 'partial') {
        deleted[t] = db.prepare(`DELETE FROM "${t}" WHERE ${p.where}`).run().changes;
        if (p.reset) cleared[t] = db.prepare(`UPDATE "${t}" SET ${p.reset.set} WHERE ${p.reset.where}`).run().changes;
      } else {
        deleted[t] = db.prepare(`DELETE FROM "${t}"`).run().changes;
      }
    }

    sync = wipeSyncTraces(db, before);
    for (const sql of guards) db.exec(sql);

    const fkAfter = fkViolations(db, watch);
    const broken = Object.keys(fkAfter).filter((t) => fkAfter[t] > (fkBefore[t] || 0));
    if (broken.length) {
      throw new Error('Удаление тестовых данных оставило бы висячие ссылки в таблицах: ' + broken.join(', '));
    }
  });
  run.immediate();
  return { deleted, cleared, sync, crm_cards_unbooked: crmUnbooked };
}
