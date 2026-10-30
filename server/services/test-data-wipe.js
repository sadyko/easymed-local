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
import { currentDiskSpace, dbBytes, copyNeedBytes, RESERVE_BYTES, gbText, gbValue } from './disk-guard.js';
import { createBackup, listBackups, MARKER_NAME } from './backup.js';
import { readPairing } from './branch-sync/pairing.js';
import { readJsonFile, writeAtomic } from './control/checkin.js';

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

// Ключ словаря public/js/admin/i18n-strings.js (как COPY_REFUSED_TEMPLATE в
// disk-guard.js): экран переводит фразу целиком по шаблону.
export const WIPE_NO_SPACE_TEMPLATE = 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Тестовые данные не удалены.';

/**
 * Отказ «нет места» — с шаблоном и значениями, как disk-guard.js noSpaceError
 * (DISK_GUARD_V1): message — готовая русская фраза (журнал, русский экран),
 * в params числа — ЧИСЛАМИ, десятичный знак ставит экран по своему языку.
 * «Нужно» округляется вверх, «свободно» — вниз.
 */
export function wipeNoSpaceError(need, free) {
  const e = new Error(WIPE_NO_SPACE_TEMPLATE.replace('{need}', gbText(need, { up: true })).replace('{free}', gbText(free)));
  e.code = 'no_space';
  e.need_bytes = need;
  e.free_bytes = free;
  e.template = WIPE_NO_SPACE_TEMPLATE;
  e.params = { need: gbValue(need, { up: true }), free: gbValue(free) };
  return e;
}

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
// (backup.js discardPartial). На EPERM один раз снимается «только для чтения»
// (Windows) — и только у самого файла: chmod по ссылке прошёл бы к цели,
// поэтому перед ним путь проверяется ещё раз. 'ok' — удалён, 'gone' — исчез
// сам, иначе — код ошибки: файл остался.
function unlinkFile(p) {
  let madeWritable = false;
  for (let attempt = 0; ; attempt++) {
    try { fs.unlinkSync(p); return 'ok'; } catch (err) {
      const code = (err && err.code) || 'error';
      if (code === 'ENOENT') return 'gone';
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) return code;
      if (code === 'EPERM' && !madeWritable && entryKind(p) === 'file') {
        madeWritable = true;
        try { fs.chmodSync(p, 0o666); continue; } catch { /* не вышло — обычная попытка через паузу */ }
      }
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
      warnDocs(dataDir, docs, kind === 'link'
        ? 'в папке документов ссылка — не открывается и не удаляется'
        : 'в папке документов не файл и не папка — не удаляется', kind);
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
    // Оборванный VACUUM мог оставить кадры в журнале — он сжимается и здесь.
    checkpointWal(db);
    return { done: false, reason: 'failed', before_bytes: before, after_bytes: dbBytes(dbFile) };
  }
  checkpointWal(db);
  return { done: true, reason: null, before_bytes: before, after_bytes: dbBytes(dbFile) };
}

/**
 * Всё удаление: проверка места, транзакция (wipeTestData), потом файлы
 * документов, потом VACUUM. Бросает только до транзакции и из неё — тогда
 * база цела и файлы не тронуты. Итог — тот же, что у wipeTestData (с числом
 * карточек CRM без учебной записи), плюс files и vacuum.
 *
 * Поправка 9(б): одна большая транзакция раздувает журнал базы (-wal)
 * примерно на объём удаляемого. Свободного места меньше этого и запаса 1 ГБ
 * (RESERVE_BYTES) — отказ 'no_space' ДО транзакции (wipeNoSpaceError).
 * Платформа не сказала, сколько места, — удаление идёт, как копии.
 */
export function runTestDataWipe(db, dataDir, { diskSpaceImpl = currentDiskSpace } = {}) {
  const space = diskSpaceImpl(dataDir);
  if (space) {
    const need = estimateWipeBytes(db) + RESERVE_BYTES;
    if (space.free < need) {
      console.warn(`[test-data-wipe] удаление не начато: нужно ${need} Б, свободно ${space.free} Б`);
      throw wipeNoSpaceError(need, space.free);
    }
  }
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
  // Итог мог быть прочитан с диска (test-data-wipe-result.json): каждое
  // значение — числом, пустое или испорченное — ноль.
  const num = (x) => Number(x) || 0;
  const d = (result && result.deleted) || {};
  const c = (result && result.cleared) || {};
  const parts = SUMMARY_KEYS.map((k) => `${k} ${num(d[k])}`);
  parts.push(`products_reset ${num(c.products)}`, `crm_lines_unlinked ${num(c.crm_request_services)}`);
  parts.push(`карточек CRM без учебной записи: ${num(result && result.crm_cards_unbooked)} (стадии не менялись)`);
  const f = result && result.files;
  if (f) parts.push(`files ${num(f.removed)}` + (num(f.failed) ? ` (не удалено ${num(f.failed)})` : ''));
  const v = result && result.vacuum;
  if (v) parts.push(v.done ? `vacuum ${num(v.before_bytes)}→${num(v.after_bytes)} Б` : `vacuum нет (${v.reason})`);
  return 'Тестовые данные удалены: ' + parts.join(', ');
}

// ── просьба администратора и запуск ────────────────────────────────────────

export const WIPE_ACTION = 'test_data_wipe';
// Итог последнего удаления — для «Данных клиники» после перезапуска. Только
// числа, имена таблиц, время и имя копии: данных пациентов в нём нет.
export const RESULT_NAME = 'test-data-wipe-result.json';

/**
 * Связана ли клиника с другими зданиями — та же запись о паре, по которой
 * экран «Филиалы» показывает связь (branch-sync/pairing.js readPairing; в
 * обмене строками без неё не участвует ничто). Связанной клинике удаление не
 * положено: «удалено» ушло бы в другое здание и стёрло бы там настоящие данные.
 */
export function isPaired(dataDir) {
  return readPairing(dataDir) !== null;
}

export function readWipeResult(dataDir) {
  return readJsonFile(path.join(dataDir, RESULT_NAME));
}

function writeWipeResult(dataDir, result) {
  try { writeAtomic(path.join(dataDir, RESULT_NAME), JSON.stringify(result, null, 2) + '\n'); }
  catch (e) { console.warn('[test-data-wipe] итог не записан (он есть в журнале программы):', e && e.message); }
}

// Намерение, которое нельзя выполнить, откладывается в .bad (как у
// processPendingAction, services/backup.js): не удаляется молча и не
// повторяется при каждом запуске.
function setAside(markerPath) {
  try { fs.renameSync(markerPath, markerPath + '.bad'); }
  catch { try { fs.unlinkSync(markerPath); } catch { /* не убрать — следующий запуск найдёт отметку DONE_KEY и не повторит */ } }
}

// Ревью C3 — «исполнено» в самой базе (control_state, остаётся при удалении):
// по какой копии намерение уже разобрано и чем кончилось. Если итог на диск не
// записался И намерение не убралось (диск, антивирус, права), запуск всё равно
// дошёл бы до listen — и следующий запуск, через день работы клиники, удалил бы
// уже НАСТОЯЩИЕ визиты и документы. Отметка пишется, когда удаление (или отказ)
// закончено, — повтор после сбоя посередине (до listen) она не останавливает.
const DONE_KEY = 'test_data_wipe_done';

function markDone(db, backup, outcome) {
  if (!backup) return;
  try {
    db.prepare(`INSERT INTO control_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(DONE_KEY, JSON.stringify({ backup, ok: outcome.ok === true, reason: outcome.reason || null, at: outcome.at || null }));
  } catch (e) {
    console.warn('[test-data-wipe] отметка «исполнено» не записана:', e && e.message);
  }
}

function doneFor(db, backup) {
  if (!backup) return null;
  try {
    const row = db.prepare('SELECT value FROM control_state WHERE key = ?').get(DONE_KEY);
    const v = row ? JSON.parse(row.value) : null;
    return v && typeof v === 'object' && v.backup === backup ? v : null;
  } catch { return null; }
}

/** Что показать на «Данных клиники»: связана ли клиника, ждёт ли удаление запуска, итог прошлого. */
export function wipeStatus(dataDir) {
  const m = readJsonFile(path.join(dataDir, MARKER_NAME));
  return { paired: isPaired(dataDir), pending: !!(m && m.action === WIPE_ACTION), last: readWipeResult(dataDir) };
}

/**
 * Ревью C3 — место при просьбе: на копию «Перед удалением тестовых данных»
 * (база × 1,2 + 1 ГБ, copyNeedBytes) и сверху — на журнал самого удаления
 * (estimateWipeBytes). Запас 1 ГБ, который удаление при запуске требует сверх
 * журнала (runTestDataWipe), уже внутри места на копию: после копии свободно
 * останется не меньше журнала и запаса — запуск не откажет по месту. Не
 * хватает — отказ 'no_space' словами удаления ДО копии и ДО намерения.
 * Платформа не сказала, сколько места, — дальше решает охрана копии.
 * Оценка читает страницы затронутых таблиц — на учебной базе доли секунды.
 */
function ensureRequestSpace(db, dataDir, diskSpaceImpl) {
  const space = diskSpaceImpl(dataDir);
  if (!space) return;
  const need = copyNeedBytes(dbBytes(path.join(dataDir, 'easymed.db'))) + estimateWipeBytes(db);
  if (space.free < need) {
    console.warn(`[test-data-wipe] удаление не запрошено: нужно ${need} Б (копия и журнал удаления), свободно ${space.free} Б`);
    throw wipeNoSpaceError(need, space.free);
  }
}

/**
 * Просьба администратора (rpc/backup.js testDataWipe): сначала копия «Перед
 * удалением тестовых данных» — это и есть путь назад, — потом намерение в
 * pending-action.json. Копия ДО намерения: как только намерение лежит,
 * перезапуск удалит, и состояние, которое уходит, к этому моменту уже должно
 * быть в копии. Перед копией — место на копию И на удаление
 * (ensureRequestSpace); сама копия идёт через охрану места (createBackup →
 * ensureCopySpace). Места нет — бросает 'no_space', намерение не пишется,
 * ничего не удаляется.
 * @returns {Promise<{ok:true, backup:string}|{ok:false, reason:'paired'}>}
 */
export async function requestTestDataWipe(db, dataDir, { now = new Date(), userId = null, diskSpaceImpl = currentDiskSpace } = {}) {
  if (isPaired(dataDir)) return { ok: false, reason: 'paired' };
  ensureRequestSpace(db, dataDir, diskSpaceImpl);
  const copy = await createBackup(db, dataDir, 'wipe', now, { diskSpaceImpl });
  // Пока делалась копия, клинику могли связать с другим зданием.
  if (isPaired(dataDir)) return { ok: false, reason: 'paired' };
  writeAtomic(path.join(dataDir, MARKER_NAME), JSON.stringify({
    action: WIPE_ACTION, backup: copy.name, requested_at: now.toISOString(), requested_by: userId,
  }));
  return { ok: true, backup: copy.name };
}

/**
 * Выполнить отложенное удаление при запуске (server/index.js: после migrate,
 * до первого прохода CRM, опросов и listen). Никогда не бросает: клиника,
 * которая не может запуститься, хуже клиники, где учебные данные остались.
 *
 * Намерение удаляется ПОСЛЕДНИМ. Сбой посередине (процесс упал до listen) —
 * следующий запуск повторит: удалять уже нечего. Намерение, уже разобранное
 * по той же копии (итог в файле или отметка DONE_KEY в базе), не
 * выполняется второй раз никогда: между запусками клиника могла работать, и
 * повтор снёс бы настоящие визиты и документы (removeVisitDocFiles). Итог
 * того разбора не перезаписывается нулями.
 *
 * Отказы — база цела, намерение в .bad, итог с причиной: 'paired' (связали
 * после просьбы), 'no_space' (журналу удаления не хватает места — в итоге
 * шаблон и числа, экран переведёт фразу целиком), 'failed' (сбой
 * транзакции; нет копии «Перед удалением» — нет пути назад).
 *
 * @returns {{action:null}|{action:'test_data_wipe', ok:boolean, reason?:string, line:string}}
 */
export function applyPendingTestDataWipe(db, dataDir, { diskSpaceImpl = currentDiskSpace, now = () => new Date() } = {}) {
  const markerPath = path.join(dataDir, MARKER_NAME);
  const m = readJsonFile(markerPath);
  if (!m || m.action !== WIPE_ACTION) return { action: null };
  const backup = typeof m.backup === 'string' && m.backup ? m.backup : null;
  try {
    const prev = readWipeResult(dataDir);
    const last = backup && prev && prev.backup === backup ? prev : null;
    const done = last || doneFor(db, backup);
    if (done) {
      if (done.ok === true) {
        try { fs.unlinkSync(markerPath); } catch { /* повторим; отметка DONE_KEY не даст удалить второй раз */ }
        return {
          action: WIPE_ACTION, ok: true,
          line: last ? summaryLine(last) : 'Тестовые данные уже удалены прошлым запуском (итог того удаления не сохранился).',
        };
      }
      setAside(markerPath);
      return { action: WIPE_ACTION, ok: false, reason: done.reason || 'failed', line: 'Тестовые данные НЕ удалены (намерение уже разобрано прошлым запуском).' };
    }
    const at = now().toISOString();
    const refuse = (reason, line, extra = {}) => {
      const outcome = { ok: false, reason, at, backup, ...extra };
      markDone(db, backup, outcome);
      writeWipeResult(dataDir, outcome);
      setAside(markerPath);
      return { action: WIPE_ACTION, ok: false, reason, line };
    };
    if (isPaired(dataDir)) {
      const line = 'Тестовые данные НЕ удалены: клиника связана с другими зданиями.';
      console.warn('[test-data-wipe] ' + line);
      return refuse('paired', line);
    }
    // Ревью C3 — копию, названную в намерении, могли удалить мимо программы
    // между просьбой и запуском (или намерение написано не программой): без
    // пути назад удаления нет.
    if (!backup || !listBackups(dataDir).some((b) => b.name === backup && b.restorable)) {
      const line = 'Тестовые данные НЕ удалены: нет копии «Перед удалением тестовых данных» — без пути назад удаления нет.';
      console.warn('[test-data-wipe] ' + line);
      return refuse('failed', line);
    }
    let result;
    try {
      result = runTestDataWipe(db, dataDir, { diskSpaceImpl });
    } catch (e) {
      if (e && e.code === 'no_space') {
        // Ревью C3 — причина словами: экран (C5) переводит фразу по шаблону.
        return refuse('no_space', e.message, {
          template: e.template, params: e.params, need_bytes: e.need_bytes, free_bytes: e.free_bytes,
        });
      }
      console.error('[test-data-wipe] удаление не прошло, база не тронута:', e && e.message);
      return refuse('failed', 'Тестовые данные НЕ удалены — база не тронута (причина — строкой выше).');
    }
    const out = { ok: true, at, backup, ...result };
    markDone(db, backup, out);
    writeWipeResult(dataDir, out);
    try { fs.unlinkSync(markerPath); } catch { /* следующий запуск увидит итог этой копии (или отметку) и только уберёт намерение */ }
    return { action: WIPE_ACTION, ok: true, line: summaryLine(out) };
  } catch (e) {
    console.error('[test-data-wipe] сбой:', e && e.message);
    setAside(markerPath);
    return { action: WIPE_ACTION, ok: false, reason: 'failed', line: 'Тестовые данные НЕ удалены.' };
  }
}
