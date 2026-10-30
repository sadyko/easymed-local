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

/**
 * Нарушения внешних ключей по таблицам (только таблицы с нарушениями): какая
 * строка и по какой ссылке — `rowid|родитель|номер ключа` → сколько раз.
 * Сравниваются строки, а не число: прежняя висячая ссылка, которая ушла при
 * удалении (каскадом), не прикрывает новую. У таблиц WITHOUT ROWID rowid пуст —
 * у них сравнивается число нарушений по каждой ссылке.
 * @returns {Map<string, Map<string, number>>}
 */
function fkViolations(db, tables) {
  const out = new Map();
  for (const t of tables) {
    const rows = db.prepare('SELECT * FROM pragma_foreign_key_check(?)').all(t);
    if (!rows.length) continue;
    const keys = new Map();
    for (const r of rows) {
      const k = `${r.rowid}|${r.parent}|${r.fkid}`;
      keys.set(k, (keys.get(k) || 0) + 1);
    }
    out.set(t, keys);
  }
  return out;
}

/** Таблицы, в которых после удаления есть нарушение, которого до него не было. */
function newViolations(before, after) {
  const out = [];
  for (const [t, keys] of after) {
    const was = before.get(t) || new Map();
    for (const [k, n] of keys) {
      if (n > (was.get(k) || 0)) { out.push(t); break; }
    }
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
 * Считаются карточки, которые держали ЖИВОЙ учебный визит (не отменённый и не
 * «не пришёл»): строка карточки на визите или на его строке
 * (crm_request_services, кроме снятых строк 'cancelled'), привязка записи к
 * карточке (crm_booking_links) или след записи, сменившей стадию карточки
 * (crm_booking_undo). Удаление уносит ВСЕ визиты, поэтому каждая такая связь —
 * потерянная запись. Карточка, чья запись была отменена ещё до удаления
 * (отметка released_from_visit_id, привязка на отменённом визите), не в счёт:
 * записи у неё к этому времени уже не было. Карточки, которых уже нет (у
 * crm_booking_links и crm_booking_undo нет внешнего ключа), не в счёт.
 * Зовётся до шагов удаления — пока ссылки и визиты ещё на месте.
 */
const LIVE_VISIT = "COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')";
function crmCardsUnbooked(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM crm_requests WHERE id IN (
      SELECT l.request_id FROM crm_request_services l JOIN visits v ON v.id = l.visit_id
       WHERE l.status <> 'cancelled' AND ${LIVE_VISIT}
      UNION SELECT l.request_id FROM crm_request_services l
              JOIN visit_services x ON x.id = l.visit_service_id JOIN visits v ON v.id = x.visit_id
       WHERE l.status <> 'cancelled' AND ${LIVE_VISIT}
      UNION SELECT b.request_id FROM crm_booking_links b JOIN visits v ON v.id = b.visit_id WHERE ${LIVE_VISIT}
      UNION SELECT u.request_id FROM crm_booking_undo u JOIN visits v ON v.id = u.visit_id WHERE ${LIVE_VISIT})`).get().n;
}

/**
 * Следы удаления в служебных таблицах связи зданий. Клиника, связанная с
 * другими зданиями, сюда не доходит (отказ — rpc/backup.js), но запись о
 * соседе (sync_peers) живёт после «Отвязать» до 30 дней (journal.js
 * pruneJournal), и связь могут завести заново. Тогда тёплый хвост (journal.js
 * buildBatch) читает журнал от sent_seq соседа, а запись о строке, которой
 * больше нет, превращается в 'del' — и стирает у соседа настоящую строку: в
 * наших таблицах лежат и строки, приехавшие из других зданий.
 *
 * sync_journal: удаляемые таблицы теряют ВСЕ строки, поэтому любая запись
 * журнала о них — и 'del' самого удаления (триггеры *_journal_del, мигр. 084,
 * 087), и прежние 'put', которые сосед ещё не подтвердил, — может дать только
 * 'del'. Убираются все записи этих таблиц и всё, что написано после отметки
 * before (seq растёт всегда — AUTOINCREMENT). Журнал оставляемых таблиц (карты
 * пациентов, объединения карт) не трогается; pruneJournal не зовётся — он
 * вычистил бы и чужое. Цена: прежнее настоящее удаление в этих таблицах, которое
 * сосед ещё не подтвердил, тёплым хвостом больше не уедет (надгробие остаётся).
 *
 * sync_tombstones: убираются надгробия самого удаления (seq > before). Прежние
 * остаются: их читает только холодный засев (seedPage), написали их настоящие
 * удаления до удаления тестовых данных, и уехали бы они так же и без него.
 * Авторство и отчеканенные номера удалённых строк (sync_authored, sync_minted)
 * убирают сами триггеры *_journal_del и invoices_minted_del (мигр. 090), и
 * соседу они не уезжают. Отметки «видел»/«ждёт»/«отказано» по удалённым
 * таблицам больше ни к чему не относятся.
 */
function wipeSyncTraces(db, before) {
  const wiped = Object.keys(SHIPPED).filter((t) => TABLE_PLAN[t] && TABLE_PLAN[t].how === 'delete');
  const inList = wiped.map(() => '?').join(', ');
  return {
    sync_journal: db.prepare(`DELETE FROM sync_journal WHERE seq > ? OR tbl IN (${inList})`).run(before.journal, ...wiped).changes,
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
  // Внутри чужой транзакции удаление стало бы её точкой сохранения: COMMIT и
  // проверку ссылок делал бы чужой код. А PRAGMA foreign_keys внутри
  // транзакции не переключается — без неё не сработали бы ни ON DELETE, ни
  // отложенная проверка цикла госпитализация ↔ счёт.
  if (db.inTransaction) {
    throw new Error('Удаление тестовых данных нельзя начинать внутри другой транзакции — только отдельно, при запуске.');
  }
  if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
    throw new Error('Удаление тестовых данных требует PRAGMA foreign_keys = ON (openDb) — без проверки ссылок не начинается.');
  }
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

    const broken = newViolations(fkBefore, fkViolations(db, watch));
    if (broken.length) {
      throw new Error('Удаление тестовых данных оставило бы висячие ссылки в таблицах: ' + broken.join(', '));
    }
  });
  run.immediate();
  return { deleted, cleared, sync, crm_cards_unbooked: crmUnbooked };
}
