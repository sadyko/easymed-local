// BRANCH_RECORDS_V1 — что именно уезжает соседу.
//
// ПЕРЕЧЕНЬ КОЛОНОК В КОДЕ, как у справочника (catalogue.js) и по той же
// причине: фильтр «уберём лишнее перед отправкой» забывают обновить, когда в
// таблицу добавляют колонку, а перечень — нет, потому что новая колонка просто
// не попадает в выгрузку, пока её сюда не впишут.
//
// Денежные поля visit_services (unit_price, total, invoice_item_id) НЕ
// перечислены намеренно: статус нужен лабораторной очереди, деньги — Фаза 3.
//
// lab_results.parameter/ref_low/ref_high (ревью Задачи 4, C3) — имя аналита и
// границы нормы. Без parameter документ-фид (documents.js) группирует
// результаты по visit_service_id+parameter, и панель на 20 показателей
// приехавшая без него схлопывается в одну безымянную строку — не «неполно»,
// а неотличимо от одного анализа.
import { nextStamp } from './hlc.js';

export const SHIPPED = {
  patients: [
    'mrn', 'full_name', 'first_name', 'last_name', 'middle_name',
    'date_of_birth', 'gender', 'blood_type', 'phone', 'email', 'national_id',
    'address', 'nationality', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone',
    'allergies', 'chronic_conditions', 'notes', 'active', 'registration_date',
  ],
  visits: ['visit_date', 'duration_minutes', 'visit_kind', 'visit_type', 'status', 'notes'],
  visit_services: ['quantity', 'status'],
  lab_results: [
    'parameter', 'value', 'numeric_value', 'unit', 'reference_range',
    'ref_low', 'ref_high', 'flag', 'notes', 'entered_at', 'verified_at',
  ],
};

// Ссылки: колонка → таблица, на которую она смотрит. Уезжает uid родителя, а не
// его локальный id — id у соседа другой (см. миграцию 083).
export const REFS = {
  visits: { patient_id: 'patients' },
  visit_services: { visit_id: 'visits' },
  lab_results: { visit_service_id: 'visit_services' },
};

// Ссылки на СПРАВОЧНИК — не по uid, а по коду. services синхронизирует
// catalogue.js (Этап 1), у него своя карта соответствий и никакого uid; id
// одной и той же услуги в двух филиалах разный, поэтому visit_services.service_id
// не может уехать как есть. Код услуги — то единственное, что у обеих сторон
// одинаково (catalogue.js усыновляет местную строку по natural: ['code','name']).
// Без этой ссылки принятая строка лабораторной очереди приезжала бы БЕЗ услуги:
// в очереди появляется работа, о которой неизвестно, что это за анализ.
//
//   колонка → { table, key, ref } — ref это имя поля в refs записи.
export const CODE_REFS = {
  visit_services: { service_id: { table: 'services', key: 'code', ref: 'service_code' } },
};

const TABLES = Object.keys(SHIPPED);

// I7 (ревью Задачи 4): без кэша каждая ссылка (REFS + CODE_REFS) и каждый
// снимок строки компилируют СВОЙ SQL заново на КАЖДУЮ запись — на партии
// visit_services в 5000 строк это 15 000 компиляций (замерено ревью), хотя
// различных текстов запроса за всю порцию не больше десятка: они зависят от
// имени таблицы, а таблиц четыре. Кэш живёт один buildBatch — не дольше:
// текст запроса привязан к конкретному db.prepare, а не глобален.
function cachedPrep(db) {
  const cache = new Map();
  return (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
}

/**
 * Собрать порцию для соседа: по одной записи на изменённую строку.
 *
 * self — буква ЭТОЙ установки (идёт в метку и в origin); peer — буква узла,
 * КОМУ собираем (по нему читается sent_seq). Два имени — две вещи.
 *
 * Пока сосед ХОЛОДНЫЙ (строки в sync_peers ещё нет) или ЗАСЕИВАЕТСЯ (строка
 * есть, но seed_floor не NULL — ревью Задачи 4, C1), heads читаются
 * ПОСТРАНИЧНО из самих таблиц (+ надгробий) через seedPage, а не из журнала —
 * иначе строки, существовавшие ДО миграции 084, никогда бы не уехали. Иначе —
 * обычный хвост журнала.
 *
 * @returns {{records: Array, upto: number, clock: object, seed: object|null}}
 *   upto — при тёплом хвосте: seq, до которого собрано; при засеве — тот же
 *   пол журнала, что и seed.floor (см. markSent).
 *   seed — null у тёплого соседа; иначе {floor, done, tbl, at, id} — состояние
 *   курсора страницы, которое markSent ОБЯЗАН передать дальше без изменений.
 */
export function buildBatch(db, { self, peer, limit = 5000, clock: clockFn = Date.now } = {}) {
  const from = db.prepare('SELECT * FROM sync_peers WHERE node = ?').get(peer);
  const seeding = from == null || from.seed_floor != null;

  let heads;
  let seed = null;
  let upto;

  if (seeding) {
    // ПОЛ ЗАМОРАЖИВАЕТСЯ ДО чтения таблиц (Minor 9, ревью Задачи 4): читать
    // его ПОСЛЕ значило бы, что правка, случившаяся между двумя чтениями,
    // получает seq НЕ БОЛЬШЕ пола — а раз sent_seq в конце засева станет этим
    // же полом, такая правка навсегда осталась бы НИЖЕ него и не уехала бы
    // никогда. Читая пол первым, любая правка «в процессе засева» получает
    // seq строго ВЫШЕ него и гарантированно приезжает первой же тёплой
    // порцией после засева (тест «правка не теряется под полом»).
    const floor = from == null
      ? db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_journal').get().m
      : from.seed_floor;
    const cursor = from == null
      ? { tbl: null, at: '', id: 0 }
      : { tbl: from.seed_tbl, at: from.seed_at || '', id: from.seed_id || 0 };

    const page = seedPage(db, limit, cursor);
    heads = page.heads;
    seed = { floor, done: page.done, tbl: page.cursor.tbl, at: page.cursor.at, id: page.cursor.id };
    upto = floor;
  } else {
    // Хвост журнала. Последняя запись про каждую строку: у пациента,
    // правленного сто раз, есть одно текущее состояние, а не сто. Голая
    // колонка `at` при GROUP BY + MAX(seq) — из строки с MAX(seq): SQLite
    // это гарантирует (bare-column rule), и именно это нам нужно.
    heads = db.prepare(`
      SELECT tbl, uid, MAX(seq) AS seq, at
        FROM sync_journal
       WHERE seq > ?
       GROUP BY tbl, uid
       ORDER BY seq
       LIMIT ?
    `).all(from.sent_seq, limit);
    upto = from.sent_seq;
  }

  // ЧАСЫ ХРАНЯТСЯ, а не заводятся заново на каждую порцию: часы, переведённые
  // назад между двумя синхронизациями, дали бы метку НИЖЕ уже отправленной —
  // приёмник её пропустит, а sent_seq уже ушёл вперёд: правка исчезает молча.
  // Читаем один раз на порцию, не на запись.
  let clock = readClock(db);
  const records = [];
  const q = cachedPrep(db);

  for (const h of heads) {
    if (!seeding) upto = Math.max(upto, h.seq);
    if (!TABLES.includes(h.tbl)) continue;

    const row = q(`SELECT * FROM ${h.tbl} WHERE uid = ?`).get(h.uid);
    // Метка — от ВРЕМЕНИ ПРАВКИ (journal.at / created_at), не от времени
    // отправки: иначе правка в 10:00, отправленная в 10:15, побеждала бы
    // настоящую правку соседа в 10:05. `at` — секундной точности; внутри
    // секунды порядок отдачи.
    //
    // I4 (ревью Задачи 4): испорченная/нечитаемая дата не должна чеканить
    // метку «1970» — такая метка проигрывала бы вообще любой настоящей и
    // молча portила бы соседу порядок слияния. Падаем обратно на часы
    // вызова — как для новой правки без собственной сохранённой метки.
    const atMs = h.at ? Date.parse(h.at) : NaN;
    clock = nextStamp(clock, self, Number.isFinite(atMs) ? () => atMs : clockFn);

    if (!row) {
      records.push({ tbl: h.tbl, uid: h.uid, op: 'del', stamp: clock.stamp, origin: self });
      continue;
    }

    const data = {};
    for (const col of SHIPPED[h.tbl]) if (row[col] !== undefined) data[col] = row[col];

    const refs = {};
    for (const [col, parent] of Object.entries(REFS[h.tbl] || {})) {
      const pid = row[col];
      if (pid == null) continue;
      const p = q(`SELECT uid FROM ${parent} WHERE id = ?`).get(pid);
      if (p) refs[col] = p.uid;
    }
    for (const [col, spec] of Object.entries(CODE_REFS[h.tbl] || {})) {
      const pid = row[col];
      if (pid == null) continue;
      const p = q(`SELECT ${spec.key} AS k FROM ${spec.table} WHERE id = ?`).get(pid);
      // Услуга без кода не едет вовсе: приёмник опознаёт её ТОЛЬКО по коду, а
      // подобрать «похожую по названию» значило бы привязать чужую работу.
      if (p && p.k) refs[spec.ref] = p.k;
    }

    records.push({ tbl: h.tbl, uid: h.uid, op: 'put', stamp: clock.stamp, data, refs, origin: self });
  }
  return { records, upto, clock, seed };
}

// Ранг таблицы — тай-брейк порядка засева, СТРОГО порядок зависимостей REFS:
// patients < visits < visit_services < lab_results. created_at сам ставит
// родителя раньше ребёнка почти всегда (ребёнок создаётся позже), ранг нужен
// только чтобы разрешить редкую ничью created_at (секундная точность) в ТУ ЖЕ
// сторону, а не в произвольную.
const TABLE_RANK = { patients: 0, visits: 1, visit_services: 2, lab_results: 3 };

// Курсор засева одалживает поле seed_tbl как имя фазы, пока идут надгробия —
// ни одна настоящая таблица так не называется, столкновения быть не может.
const TOMB_PHASE = 'sync_tombstones';

const SEED_PRESENCE_SQL = `
  SELECT tbl, uid, at, id FROM (
    SELECT 'patients' AS tbl, 0 AS rank, uid, created_at AS at, id FROM patients WHERE uid IS NOT NULL
    UNION ALL
    SELECT 'visits' AS tbl, 1 AS rank, uid, created_at AS at, id FROM visits WHERE uid IS NOT NULL
    UNION ALL
    SELECT 'visit_services' AS tbl, 2 AS rank, uid, created_at AS at, id FROM visit_services WHERE uid IS NOT NULL
    UNION ALL
    SELECT 'lab_results' AS tbl, 3 AS rank, uid, created_at AS at, id FROM lab_results WHERE uid IS NOT NULL
  )
  WHERE at > @at OR (at = @at AND (rank > @rank OR (rank = @rank AND id > @id)))
  ORDER BY at, rank, id
  LIMIT @limit
`;

/**
 * Одна страница холодного засева. Форма голов — ТА ЖЕ, что у хвоста журнала
 * ({tbl, uid, seq: 0, at}): buildBatch дальше не различает засев и журнал —
 * put/del решается одним и тем же способом («есть ли сейчас такая строка»).
 *
 * ДВЕ ФАЗЫ СТРОГО ПОСЛЕДОВАТЕЛЬНО: сперва присутствующие строки (по
 * created_at — реальному времени правки), ПОТОМ все надгробия. Не наоборот
 * (ревью Задачи 4, N2 — измерено на живом воспроизведении): buildBatch
 * чеканит метку каждой головы часами HLC, а у HLC пол монотонный и НИКОГДА не
 * опускается. Надгробие несёт время УДАЛЕНИЯ — почти всегда «только что», то
 * есть позже любого created_at из присутствий. Пусти его ПЕРВЫМ — и пол,
 * поднятый этой одной меткой, придавит ВСЕ следующие метки вверх до «сейчас»:
 * правка 2020 года приехала бы с меткой 2026, и подлинно более новая местная
 * правка соседа проиграла бы ей слияние (было: без надгробия первым —
 * P0 2020-01-01 cnt0; с ним первым — всё 2026-09-02). Присутствия по
 * created_at ASC, потом надгробия (тоже по времени, обычно позже любого
 * created_at) — это и есть настоящий хронологический порядок правок, и HLC
 * растёт по нему монотонно САМ, без скачков.
 *
 * Порядку ПРИМЕНЕНИЯ на приёме это не мешает: records.js разбирает put/del
 * по меткам и надгробиям независимо от порядка записей внутри порции — важен
 * только порядок ЧЕКАНКИ метки, а его задаёт именно эта функция.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 * @param {{tbl: string|null, at: string, id: number}} cursor
 *   null tbl — самое начало (ни одна фаза ещё не пройдена).
 * @returns {{heads: Array, cursor: object, done: boolean}}
 */
function seedPage(db, limit, cursor) {
  const out = [];
  let next = cursor;

  if (next.tbl !== TOMB_PHASE) {
    const rank = next.tbl ? TABLE_RANK[next.tbl] : -1;
    const rows = db.prepare(SEED_PRESENCE_SQL).all({ at: next.at || '', rank, id: next.id || 0, limit });
    for (const r of rows) out.push({ tbl: r.tbl, uid: r.uid, seq: 0, at: r.at });
    // rows.length === limit — страница заполнена целиком присутствиями,
    // дальше ещё могут быть; курсор остаётся в этой фазе. rows.length < limit
    // (в том числе 0) — присутствия ТОЧНО исчерпаны, переходим к надгробиям
    // с нуля — в этой же странице, если бюджет остался.
    next = rows.length === limit
      ? { tbl: rows[rows.length - 1].tbl, at: rows[rows.length - 1].at, id: rows[rows.length - 1].id }
      : { tbl: TOMB_PHASE, at: '', id: 0 };
  }

  if (out.length < limit && next.tbl === TOMB_PHASE) {
    // seq, а не rowid (ревью Задачи 4, N1 — воспроизведено ревью): rowid без
    // AUTOINCREMENT переиспользуется, как только pruneJournal вычищает
    // sync_tombstones целиком, и курсор соседа, остановившийся посреди этой
    // фазы, молча пропускает новое надгробие с переиспользованным номером.
    const rows = db.prepare(`
      SELECT tbl, uid, at, seq FROM sync_tombstones WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(next.id, limit - out.length);
    for (const r of rows) out.push({ tbl: r.tbl, uid: r.uid, seq: 0, at: r.at });
    if (rows.length) next = { tbl: TOMB_PHASE, at: '', id: rows[rows.length - 1].seq };
  }

  // out.length < limit (а не «обе фазы явно исчерпаны») — значит, ровно
  // limit оставшихся строк стоят одним лишним пустым обходом, зато не нужно
  // отдельно спрашивать «а сколько ещё» до самой отдачи. Пейджинг это уже
  // терпит везде в этом файле (тот же приём у тёплого хвоста).
  return { heads: out, cursor: next, done: out.length < limit };
}

// Хвост, отданный ВСЕМ соседям, больше не нужен: без чистки журнал растёт
// ~4.7 млн строк в год на клинике с 300 визитами в день, а сборка порции
// сканирует его целиком. Сосед, молчавший дольше STALE_DAYS, забывается: его
// строка удаляется, и по возвращении он получает холодный засев из таблиц —
// иначе он навсегда пропустил бы всё, что вычищено за время его отсутствия.
// Удалять строку ОБЯЗАТЕЛЬНО раньше, чем считать пол: если просто исключить
// такого соседа из MIN(sent_seq), его собственная sync_peers-строка
// (старый sent_seq) остаётся на месте — buildBatch увидит её, посчитает
// соседа тёплым и станет читать хвост журнала НИЖЕ уже вычищенного места:
// дыра, а не переотправка.
const STALE_DAYS = 30;
// Надгробия переживают забытого соседа ДОЛЬШЕ, чем сама запись о нём (ревью
// Задачи 4, C2): удалить строку из sync_tombstones раньше, чем сосед успеет
// вернуться и забрать холодный засев, значит воскресить у него ту строку,
// которую мы у себя давно удалили — обычный put её просто не защитит, надеть
// защиту нечем. 2×STALE_DAYS — не строгая гарантия (сосед может молчать и
// дольше), а осознанно ОГРАНИЧЕННЫЙ риск: молчание дольше 60 дней — это уже
// не «не успели снять надгробие», а «филиал закрылся или сменил адрес», и
// хранить надгробия для него вечно дороже, чем один раз пересверить руками.
const TOMBSTONE_DAYS = STALE_DAYS * 2;
export function pruneJournal(db, { now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - STALE_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sync_peers WHERE last_ok IS NULL OR last_ok < ?').run(cutoff);

  const tombCutoff = new Date(now().getTime() - TOMBSTONE_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sync_tombstones WHERE at < ?').run(tombCutoff);

  // I6 (ревью Задачи 4): соседей вообще не осталось — не было ни одного, или
  // все только что забыты выше. MIN(sent_seq) ниже был бы NULL, чистка
  // молчала бы НАВСЕГДА, и журнал рос бы у клиники без единого настроенного
  // соседа так же, как рос бы вовсе без этой функции.
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM sync_peers').get().n;
  if (remaining === 0) return db.prepare('DELETE FROM sync_journal').run().changes;

  const floor = db.prepare('SELECT MIN(sent_seq) AS m FROM sync_peers WHERE last_ok IS NOT NULL AND last_ok >= ?').get(cutoff);
  if (!floor || floor.m == null || floor.m <= 0) return 0;
  return db.prepare('DELETE FROM sync_journal WHERE seq <= ?').run(floor.m).changes;
}

const CLOCK_KEY = 'sync_clock';

// control_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT) —
// та же таблица и та же форма upsert, что в rpc/branch-sync.js (getState /
// putState); здесь не переиспользованы напрямую, потому что там не
// экспортированы, а тянуть ради двух строк весь модуль RPC — лишняя связь.

/** Последнее состояние часов из control_state. Строки → числа (TEXT-колонка). */
export function readClock(db) {
  const row = db.prepare('SELECT value FROM control_state WHERE key = ?').get(CLOCK_KEY);
  if (!row) return null;
  let v;
  try {
    v = JSON.parse(row.value);
  } catch {
    // Испорченная запись не должна ронять сборку порции — часы просто
    // начнутся заново от текущего времени, как при самом первом запуске.
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ms = Number(v.ms);
  const cnt = Number(v.cnt);
  if (!Number.isFinite(ms) || !Number.isFinite(cnt)) return null;
  return { ms, cnt };
}

/** Записать часы — только если ушли вперёд. После удачной отправки и после каждого приёма. */
export function writeClock(db, clock) {
  if (!clock) return;
  const prev = readClock(db);
  // Часы не откатываются НАЗАД записью: порция, собранная позже за то же
  // время (тот же ms, меньший или равный cnt), не должна вернуть часы назад —
  // иначе следующая метка могла бы повториться или уйти ниже уже отправленной.
  if (prev && (prev.ms > clock.ms || (prev.ms === clock.ms && prev.cnt >= clock.cnt))) return;
  db.prepare(`
    INSERT INTO control_state (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CLOCK_KEY, JSON.stringify({ ms: clock.ms, cnt: clock.cnt }));
}

/**
 * Отметить, докуда соседу отдано, сохранить часы, вычистить хвост. ТОЛЬКО
 * после подтверждённой отправки — buildBatch сам ничего не пишет в базу
 * именно поэтому: не долетевшая до соседа порция обязана прийти снова, а
 * записанное здесь состояние это ей запретит.
 *
 * seed — ОБЯЗАТЕЛЕН, когда buildBatch вернул его (сосед холодный или
 * засевается): это курсор страницы, а не необязательная деталь. Без него
 * этот вызов упадёт явной ошибкой, а не молча закроет незавершённый засев —
 * закрыть его молча значило бы навсегда потерять всё, что страница ещё не
 * долистала (ревью Задачи 4, C1: «5000 из 18000 пациентов, ноль визитов»).
 * Для тёплого соседа seed — null, как и раньше.
 *
 * @param {object|null} seed batch.seed из buildBatch, без изменений
 */
export function markSent(db, peer, upto, clock = null, seed = null, { now = () => new Date() } = {}) {
  // I5 (ревью Задачи 4): всё внутри одной транзакции — состояние соседа,
  // часы и чистка журнала обязаны либо примениться целиком, либо не
  // примениться вовсе. Половина (например, sent_seq сдвинут, а чистка
  // журнала прервалась) — это ровно тот же класс дыры, что и остальной файл
  // старается не допустить.
  const run = db.transaction(() => {
    const existing = db.prepare('SELECT seed_floor FROM sync_peers WHERE node = ?').get(peer);
    const wasSeeding = existing == null || existing.seed_floor != null;
    if (wasSeeding && !seed) {
      throw new Error(
        `journal: markSent(${JSON.stringify(peer)}) called without seed info while the peer is cold or mid-seed`
      );
    }

    if (seed) {
      const done = seed.done;
      db.prepare(`
        INSERT INTO sync_peers (node, sent_seq, last_ok, seed_floor, seed_tbl, seed_at, seed_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node) DO UPDATE SET
          sent_seq = excluded.sent_seq, last_ok = excluded.last_ok,
          seed_floor = excluded.seed_floor, seed_tbl = excluded.seed_tbl,
          seed_at = excluded.seed_at, seed_id = excluded.seed_id
      `).run(
        peer, seed.floor, now().toISOString(),
        done ? null : seed.floor,
        done ? null : seed.tbl,
        done ? null : seed.at,
        done ? 0 : seed.id,
      );
    } else {
      db.prepare(`
        INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES (?, ?, ?)
        ON CONFLICT(node) DO UPDATE SET sent_seq = MAX(sent_seq, excluded.sent_seq), last_ok = excluded.last_ok
      `).run(peer, upto, now().toISOString());
    }
    writeClock(db, clock);
    pruneJournal(db, { now });
  });
  run();
}
