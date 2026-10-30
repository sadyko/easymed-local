// TEST_DATA_WIPE_V1 (docs/specs/2026-10-29-3190-refund-swap-test-wipe-design.md,
// раздел 3) — «Удалить тестовые данные»: само удаление.
//
// Что удаляется и что остаётся, решено по каждой таблице в
// test-data-wipe-plan.js; здесь — как. Одна транзакция: либо удалено всё по
// плану, либо ничего (сбой посередине откатывает и снятый на время триггер).
// После неё — файлы документов визитов и VACUUM (runTestDataWipe).
//
// Зовётся ТОЛЬКО при запуске (server/index.js — после migrate, до опросов и до
// listen): ни один запрос регистратуры или кассы не может вклиниться между
// удалением визита и удалением его счёта.
import fs from 'node:fs';
import path from 'node:path';
import { TABLE_PLAN, WIPE_ORDER, GUARD_TRIGGERS, tablesBy } from './test-data-wipe-plan.js';
import { SHIPPED } from './branch-sync/journal.js';
import { checkpointWal } from '../db/connection.js';
import { currentDiskSpace, dbBytes, RESERVE_BYTES } from './disk-guard.js';

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

// ── место под журнал удаления ──────────────────────────────────────────────

// Строка следа связи зданий — запись журнала и надгробие с ключами, — которую
// триггеры *_journal_del пишут на каждую удаляемую строку, пока wipeSyncTraces
// её не убрал. С запасом: uid — 36 символов.
const TRACE_ROW_BYTES = 512;
// Запись кадра журнала: заголовок 24 байта на страницу и 32 байта на файл.
const WAL_FRAME_HEADER = 24;
const WAL_FILE_HEADER = 32;

/**
 * Поправка 9(б) к плану: на сколько примерно вырастет журнал базы (-wal) за
 * транзакцию удаления — «объём удаляемого». Оценка сверху: SQLite пишет в
 * журнал каждую страницу, которую транзакция меняет, один раз (повторная
 * запись той же страницы в той же транзакции ложится на прежний кадр), а
 * меняются только страницы таблиц, которых удаление касается: удаляемых,
 * очищаемых, служебных таблиц связи зданий (туда пишут и там стирают
 * триггеры), таблиц со ссылками на удаляемые и схемы (снятый на время
 * триггер-запрет), — вместе с их индексами (dbstat). Сверху — строки следов,
 * которые триггеры пишут на каждую удаляемую строку, и две страницы списка
 * свободных. Нет dbstat — вся занятая часть базы. На учебной базе оценка
 * примерно вдвое больше настоящего роста: следы ложатся и на страницы,
 * освобождённые тем же удалением.
 *
 * Здесь только число: проверку места ДО копии и ДО удаления (нужно не меньше
 * этого и запаса RESERVE_BYTES, а просьбе — ещё и места на копию) делают
 * просьба администратора и запуск. Читает каждую страницу этих таблиц — на
 * базе учебной клиники это доли секунды.
 */
export function estimateWipeBytes(db) {
  const pageSize = db.pragma('page_size', { simple: true });
  const present = new Set(db.prepare(TABLES_SQL).all().map((r) => r.name));
  const gone = new Set([...tablesBy('delete'), ...tablesBy('partial')]);
  const touched = new Set(Object.keys(TABLE_PLAN).filter((t) =>
    present.has(t) && (TABLE_PLAN[t].how !== 'keep' || TABLE_PLAN[t].why === 'sync')));
  for (const t of childTables(db, gone)) touched.add(t);
  const trees = ['sqlite_schema'];
  const indexOf = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?");
  for (const t of touched) {
    trees.push(t);
    for (const i of indexOf.all(t)) trees.push(i.name);
  }
  let bytes;
  try {
    const size = db.prepare('SELECT COALESCE(SUM(pgsize), 0) AS b FROM dbstat WHERE name = ? AND aggregate = TRUE');
    bytes = trees.reduce((s, name) => s + size.get(name).b, 0);
  } catch {
    bytes = (db.pragma('page_count', { simple: true }) - db.pragma('freelist_count', { simple: true })) * pageSize;
  }
  const traced = Object.keys(SHIPPED).filter((t) => present.has(t) && TABLE_PLAN[t] && TABLE_PLAN[t].how === 'delete');
  for (const t of traced) bytes += db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n * TRACE_ROW_BYTES;
  const pages = Math.ceil(bytes / pageSize) + 2;
  return pages * (pageSize + WAL_FRAME_HEADER) + WAL_FILE_HEADER;
}

// ── файлы документов, VACUUM, итог ─────────────────────────────────────────

/**
 * Что лежит по пути — БЕЗ перехода по ссылке: 'dir', 'file', 'link' (symlink и
 * junction: lstat на Windows видит junction ссылкой), 'other' или null (нет).
 */
function entryKind(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Один файл: unlink не идёт по ссылке никогда — даже если на месте файла
// успела появиться ссылка, уходит сама ссылка. Файл, занятый антивирусом
// (Windows: EBUSY/EPERM), — ещё три попытки через 100 мс, как у копий
// (backup.js discardPartial). 'ok' — удалён, 'gone' — исчез сам, иначе — код
// ошибки: файл остался.
function unlinkFile(p) {
  for (let attempt = 0; ; attempt++) {
    try { fs.unlinkSync(p); return 'ok'; } catch (err) {
      const code = (err && err.code) || 'error';
      if (code === 'ENOENT') return 'gone';
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) return code;
      pause(100);
    }
  }
}

// Журнал программы — без имён файлов: в имени документа на диске может быть
// имя, которое дал файлу человек. Только папка (номер карты) и код ошибки.
function warnDocs(dataDir, dir, what, code) {
  console.warn(`[test-data-wipe] ${what}:`, path.relative(dataDir, dir), code || '');
}

// Очистить настоящую папку документов со всеми вложенными настоящими папками.
// Ссылка и всё, что не файл и не папка, не открывается и не удаляется — и
// считается «не удалено»: за ней могли лежать документы.
function clearDocsDir(dataDir, docs, dir, tally) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    warnDocs(dataDir, docs, 'папка документов не прочитана', err && err.code);
    tally.failed++;
    return;
  }
  let left = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    const kind = entryKind(p);
    if (kind === null) continue;                  // исчез сам
    if (kind === 'dir') {
      clearDocsDir(dataDir, docs, p, tally);
      if (fs.existsSync(p)) left++;
    } else if (kind === 'file') {
      const r = unlinkFile(p);
      if (r === 'ok') tally.removed++;
      else if (r !== 'gone') { tally.failed++; left++; warnDocs(dataDir, docs, 'файл документа не удалён', r); }
    } else {
      tally.failed++;
      left++;
      warnDocs(dataDir, docs, 'в папке документов ссылка — не открывается и не удаляется', kind);
    }
  }
  if (left) return;
  // Пустая папка. Не ушла (её держит Проводник) — файлов в ней уже нет.
  try { fs.rmdirSync(dir); } catch (err) { warnDocs(dataDir, docs, 'пустая папка документов не убрана', err && err.code); }
}

/**
 * Файлы документов: <dataDir>/storage/clinic-docs/patients/<id>/docs — все,
 * и документов визитов, и сканов в карте пациента без визита (поправка 6:
 * строки visit_documents удаляются все, пациенты остаются). Так их кладёт
 * карта пациента (PATIENT_FILE_ATTACH_V1, rpc/patient-card.js DOC_PREFIX).
 * Удаляются ПОСЛЕ базы: строка документа без файла — «файл не открывается»,
 * файл без строки — лишние байты; из двух неполных состояний правильно второе
 * (тот же довод, что у копий, services/backup.js). Прежние фотографии
 * пациентов (patients/<ключ> — файл прямо в patients/, PATIENT_PHOTO_V1), всё,
 * что лежит у пациента вне docs/, patient-photos и telegram-media не
 * трогаются. Копия «Перед удалением тестовых данных» держит файлы жёсткими
 * ссылками (snapshotStorage) — путь назад цел.
 *
 * Только внутри папки данных: имена берутся из чтения папок, а не из базы или
 * запроса, и ни одна ссылка (symlink, junction) — ни на пути к папкам
 * документов, ни внутри них — не открывается и не удаляется: снимок копии по
 * ссылкам тоже не идёт, и удалённое по ссылке назад бы не вернулось. Такая
 * ссылка считается в failed. Никогда не бросает.
 * @returns {{removed:number, failed:number}}
 */
export function removeVisitDocFiles(dataDir) {
  const tally = { removed: 0, failed: 0 };
  let root = dataDir;
  for (const seg of ['storage', 'clinic-docs', 'patients']) {
    root = path.join(root, seg);
    const kind = entryKind(root);
    if (kind === null) return tally;              // нет папки — нет и документов
    if (kind !== 'dir') {
      warnDocs(dataDir, root, 'папка хранилища — не папка (ссылка?), файлы документов не удалялись', kind);
      tally.failed++;
      return tally;
    }
  }
  let names;
  try { names = fs.readdirSync(root); } catch (err) {
    warnDocs(dataDir, root, 'папка карт пациентов не прочитана', err && err.code);
    tally.failed++;
    return tally;
  }
  for (const name of names) {
    const card = path.join(root, name);
    const cardKind = entryKind(card);
    if (cardKind === 'link') {
      warnDocs(dataDir, card, 'папка пациента — ссылка, не открывается', cardKind);
      tally.failed++;
      continue;
    }
    if (cardKind !== 'dir') continue;             // прежнее фото пациента — не документ
    const docs = path.join(card, 'docs');
    const docsKind = entryKind(docs);
    if (docsKind === 'dir') clearDocsDir(dataDir, docs, docs, tally);
    else if (docsKind === 'link') {
      warnDocs(dataDir, docs, 'папка документов — ссылка, не открывается и не удаляется', docsKind);
      tally.failed++;
    }
  }
  return tally;
}

/**
 * VACUUM после удаления: удалённые строки действительно уходят из файла базы,
 * файл уменьшается. Сначала сжимается журнал (-wal) самого удаления — его
 * место тоже свободно для VACUUM. Нужно места до двух объёмов оставшихся
 * данных (временная копия и журнал, документация SQLite) и тот же запас 1 ГБ,
 * что у копий (disk-guard.js RESERVE_BYTES). Не хватает — VACUUM не делается:
 * удаление уже состоялось, а полный диск посреди VACUUM хуже несжатого файла.
 * Потом журнал сжимается до нуля (checkpointWal). Никогда не бросает.
 */
export function vacuumAfterWipe(db, dataDir, { diskSpaceImpl = currentDiskSpace } = {}) {
  const dbFile = path.join(dataDir, 'easymed.db');
  checkpointWal(db);
  const before = dbBytes(dbFile);
  const used = (db.pragma('page_count', { simple: true }) - db.pragma('freelist_count', { simple: true }))
    * db.pragma('page_size', { simple: true });
  const need = 2 * used + RESERVE_BYTES;
  const space = diskSpaceImpl(dataDir);
  if (space && space.free < need) {
    console.warn(`[test-data-wipe] VACUUM не сделан: нужно ${need} Б, свободно ${space.free} Б — файл базы уменьшится после освобождения места и следующего удаления`);
    return { done: false, reason: 'no_space', need_bytes: need, free_bytes: space.free, before_bytes: before, after_bytes: before };
  }
  try {
    db.exec('VACUUM');
  } catch (e) {
    console.warn('[test-data-wipe] VACUUM не удался (удаление цело):', e && e.message);
    return { done: false, reason: 'failed', before_bytes: before, after_bytes: dbBytes(dbFile) };
  }
  checkpointWal(db);
  return { done: true, reason: null, before_bytes: before, after_bytes: dbBytes(dbFile) };
}

/**
 * Всё удаление: транзакция (wipeTestData), потом файлы документов, потом
 * VACUUM. Бросает только из транзакции — тогда база цела и файлы не тронуты.
 * Итог — тот же, что у wipeTestData (с числом карточек CRM без учебной
 * записи), плюс files и vacuum.
 */
export function runTestDataWipe(db, dataDir, { diskSpaceImpl = currentDiskSpace } = {}) {
  const result = wipeTestData(db);
  const files = removeVisitDocFiles(dataDir);
  const vacuum = vacuumAfterWipe(db, dataDir, { diskSpaceImpl });
  return { ...result, files, vacuum };
}

// Строки итога — что показать на экране и в журнале программы. Подписи у
// экрана (public/js/admin/test-wipe-logic.js) по тем же ключам.
export const SUMMARY_KEYS = Object.freeze([
  'visits', 'visit_services', 'lab_results', 'visit_documents', 'admissions',
  'invoices', 'payments', 'patient_deposits', 'cash_shifts', 'stock_movements', 'api_requests',
]);

/**
 * Одна строка для журнала программы (logs/easymed.log): только числа и имена
 * таблиц. Карточки CRM, потерявшие учебную запись, — словами: их стадии
 * удаление не меняло (поправка 8), и это надо прочесть, а не вычислить.
 */
export function summaryLine(result) {
  const d = (result && result.deleted) || {};
  const c = (result && result.cleared) || {};
  const parts = SUMMARY_KEYS.map((k) => `${k} ${d[k] || 0}`);
  parts.push(`products_reset ${c.products || 0}`, `crm_lines_unlinked ${c.crm_request_services || 0}`);
  parts.push(`карточек CRM без учебной записи: ${Number(result && result.crm_cards_unbooked) || 0} (стадии не менялись)`);
  const f = result && result.files;
  if (f) parts.push(`files ${f.removed}` + (f.failed ? ` (не удалено ${f.failed})` : ''));
  const v = result && result.vacuum;
  if (v) parts.push(v.done ? `vacuum ${v.before_bytes}→${v.after_bytes} Б` : `vacuum нет (${v.reason})`);
  return 'Тестовые данные удалены: ' + parts.join(', ');
}
