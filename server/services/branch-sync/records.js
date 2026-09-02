// BRANCH_RECORDS_V1 — приём чужих изменений.
//
// ТРИ ПРАВИЛА, каждое из которых нельзя переиграть после того, как данные
// разъехались:
//
//   1. Строки приезжают по СВОИМ локальным id (uid → id через таблицу).
//      Перенести чужой id значило бы перевесить местные счета и смены кассы на
//      чужие строки — разбор этого есть в миграции 079.
//   2. Слияние ПОКОЛОНОЧНОЕ: приехавшая запись меняет только те колонки, что в
//      ней есть, и только если её метка новее той, под которой эта колонка
//      менялась в последний раз. Телефон, исправленный здесь, и адрес,
//      исправленный там, обязаны выжить оба.
//   3. Удаление проигрывает более поздней правке. Молча уничтожить запись, с
//      которой кто-то ещё работал, — единственная невосстановимая ошибка в
//      этом файле.
//
// Всё это — в ОДНОЙ транзакции: половина приехавшей истории хуже, чем ничего,
// потому что в ней визиты без пациентов.
import { compareStamps, isStamp, nextStamp } from './hlc.js';
import { SHIPPED, REFS, CODE_REFS, readClock, writeClock } from './journal.js';

// sync_seen (миграция 084): метка последнего ПРИНЯТОГО изменения каждой
// колонки. Местная правка метки не имеет — до отправки её защищает журнал.
const SEEN = 'sync_seen';
// Приехавшая запись больше этого — не хранится в ожидании, а пропускается:
// предел релея (12 МБ сжатых) ничего не говорит о размере ОДНОЙ строки.
const MAX_PENDING_BYTES = 256 * 1024;
const PENDING_MAX_DAYS = 30;
// sync_seen растёт быстрее журнала: ~190 строк на принятый визит с панелью
// (повторное ревью Задачи 3: ~17 млн строк, 1.4 ГБ в год у принимающего
// филиала). Метка старше SEEN_DAYS не нужна: порции — минутной давности, а
// холодный засев несёт СВЕЖИЕ метки (пол HLC), не created_at. Надгробия '*'
// живут столько же: запоздавший put старше 90 дней — не сценарий.
const SEEN_DAYS = 90;
// Предохранитель цикла освобождения. Настоящая глубина цепочки — четыре
// (пациент → визит → услуга → результат), и каждый круг освобождает ВСЕХ, кому
// родитель уже приехал, поэтому кругов нужно не больше пяти. Ограничение стоит
// не ради нормы, а чтобы порция с неожиданной формой данных не завесила приём
// навсегда: лучше оставить ожидание на следующую порцию, чем не вернуться.
const MAX_RELEASE_ROUNDS = 64;

/**
 * Применить порцию.
 *
 * ЖУРНАЛ ПРИ ЭТОМ НЕ ПИШЕТСЯ. Триггеры 084 висят на самих таблицах, снять их
 * на время приёма нельзя (это одна база на всю клинику, рядом работают люди),
 * поэтому записи, порождённые приёмом, удаляются в конце транзакции по
 * отметке MAX(seq), снятой до её тела. Иначе принятое изменение уехало бы
 * обратно, вернулось снова и ходило бы по кругу вечно.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array} records порция, как её собрал buildBatch на той стороне
 * @param {{self: string}} opts буква ЭТОГО узла — идёт в часы
 * @returns {{applied:number, skipped:number, deferred:number, deleted:number}}
 */
export function applyBatch(db, records, { self } = {}) {
  // Без self часы после приёма не чеканятся, и узел с отставшими часами
  // проигрывал бы слияние вечно — это тихая потеря данных, а не мелочь.
  if (!self) throw new Error('applyBatch: self letter required');
  const stats = { applied: 0, skipped: 0, deferred: 0, deleted: 0 };
  const ctx = newCtx(db);

  const run = db.transaction((batch) => {
    const mark = db.prepare('SELECT MAX(seq) AS s FROM sync_journal').get();
    const journalFrom = mark && mark.s ? mark.s : 0;

    for (const rec of batch) applyOne(db, rec, stats, ctx);

    releasePending(db, stats, ctx);

    // Ребёнок, чей родитель удалён у источника (или чья услуга так и не
    // появилась в справочнике), ждал бы вечно.
    db.prepare('DELETE FROM sync_pending WHERE received_at < ?')
      .run(new Date(Date.now() - PENDING_MAX_DAYS * 86400000).toISOString());
    // Метки, старше которых ничего не приедет. Сравнение строковое: метка —
    // hex миллисекунд фиксированной ширины (hlc.js), и «старше даты» это
    // «меньше метки этой даты».
    const seenCutoff = seenHorizon(ctx.maxReceived);
    if (seenCutoff) db.prepare(`DELETE FROM ${SEEN} WHERE stamp < ?`).run(seenCutoff);

    // Приём не порождает исходящих изменений — см. заголовок.
    db.prepare('DELETE FROM sync_journal WHERE seq > ?').run(journalFrom);

    // Часы этой машины двигаются за самую новую чужую метку: узел с отставшими
    // часами иначе проигрывал бы каждое слияние вечно.
    if (ctx.maxReceived) writeClock(db, nextStamp(readClock(db), self, Date.now, ctx.maxReceived));
  });

  run(Array.isArray(records) ? records : []);
  return stats;
}

// Готовые запросы живут на порцию, а не на запись: порция — до 5000 записей, и
// prepare на каждую из них съедал бы больше, чем сама вставка.
function newCtx(db) {
  const cache = new Map();
  return {
    maxReceived: '',
    q(sql) {
      let s = cache.get(sql);
      if (!s) { s = db.prepare(sql); cache.set(sql, s); }
      return s;
    },
  };
}

// Граница удержания sync_seen — не «сейчас минус 90 дней», а «минимум из
// СЕЙЧАС и самой новой ПРИЕХАВШЕЙ метки, минус 90 дней». Разница видна ровно
// там, где всё и ломается: у филиала с ушедшими часами (севшая батарейка CMOS —
// в клинике это не гипотеза). Его метки приезжают «из 1970»; по границе от
// местного Date.now() они были бы вычищены В ТОЙ ЖЕ транзакции, в которой
// приняты, и вместе с ними — надгробия и поколоночные метки, которые защищают
// именно от его следующей порции: запоздавший put воскресил бы удалённую
// строку. Поэтому граница считается по ТОЙ ЖЕ шкале, что и сами метки.
//
// Симметрично сверху: часы соседа, ушедшие ВПЕРЁД на год, не должны вычистить
// весь sync_seen — поэтому минимум, а не максимум. Самоисправление встроено в
// HLC: приняв нашу метку, отставший сосед подтягивает свои часы (пол в
// nextStamp), и со следующего обмена удержание работает как обычно.
//
// Порция без единой годной метки границы не двигает: чистить нечем и незачем.
function seenHorizon(maxReceived) {
  if (!maxReceived) return null;
  const receivedMs = parseInt(String(maxReceived).slice(0, 12), 16);
  const base = Math.min(Date.now(), Number.isFinite(receivedMs) ? receivedMs : 0);
  const cutoff = base - SEEN_DAYS * 86400000;
  if (cutoff <= 0) return null;
  return cutoff.toString(16).padStart(12, '0');
}

function localId(db, ctx, tbl, uid) {
  const r = ctx.q(`SELECT id FROM ${tbl} WHERE uid = ?`).get(uid);
  return r ? r.id : null;
}

/**
 * Одна запись. Тот же код и для порции, и для освобождения из ожидания:
 * ожидавшая запись обязана пройти ровно те же проверки (надгробие, защита
 * местной правки, поколоночные метки), что и только что приехавшая.
 */
function applyOne(db, rec, stats, ctx) {
  // Порция приехала снаружи — форму её записей никто не гарантировал. Мусорная
  // запись пропускается поимённо, а не роняет всю транзакцию: одна кривая
  // строка не должна отменять сотню здоровых.
  if (!rec || typeof rec !== 'object' || !SHIPPED[rec.tbl]
      || typeof rec.uid !== 'string' || !isStamp(rec.stamp)) { stats.skipped++; return; }
  // Часы двигаются за ЛЮБОЙ годной приехавшей меткой — и за удалением, и за
  // отложенной в ожидание, и за пропущенной: иначе узел с отставшими часами,
  // получивший детей раньше родителей, ничему не учится и продолжает проигрывать.
  if (rec.stamp > ctx.maxReceived) ctx.maxReceived = rec.stamp;

  const id = localId(db, ctx, rec.tbl, rec.uid);
  const protectedHere = id != null && hasLocalUnshipped(db, ctx, rec.tbl, rec.uid, rec.origin);

  if (rec.op === 'del') {
    // Правило 3. Удаление проигрывает любой более поздней правке — местной
    // неотправленной или приехавшей с более новой меткой по любой колонке.
    const newerCol = ctx.q(`SELECT 1 FROM ${SEEN} WHERE tbl = ? AND uid = ? AND stamp > ? LIMIT 1`)
      .get(rec.tbl, rec.uid, rec.stamp);
    if (protectedHere || newerCol) { stats.skipped++; return; }
    if (id != null) { ctx.q(`DELETE FROM ${rec.tbl} WHERE id = ?`).run(id); stats.deleted++; }
    // Надгробие вместо поколоночных меток: строки больше нет, помнить по
    // колонкам нечего, а помнить САМ ФАКТ удаления обязательно (правило ниже).
    ctx.q(`DELETE FROM ${SEEN} WHERE tbl = ? AND uid = ?`).run(rec.tbl, rec.uid);
    ctx.q(`INSERT INTO ${SEEN} (tbl, uid, col, stamp) VALUES (?,?,?,?)`).run(rec.tbl, rec.uid, '*', rec.stamp);
    return;
  }

  // Надгробие: строка удалена с этой меткой. put, который СТАРШЕ надгробия, не
  // воскрешает её — отправитель удаление не повторит, и воскресшая строка
  // осталась бы здесь навсегда. put НОВЕЕ надгробия — законное повторное
  // заведение той же строки, и надгробие снимается.
  const tomb = ctx.q(`SELECT stamp FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = ?`).get(rec.tbl, rec.uid, '*');
  if (tomb && compareStamps(rec.stamp, tomb.stamp) <= 0) { stats.skipped++; return; }

  // Здесь строку правили, и сосед, приславший запись, этой правки ещё не видел
  // — значит, он писал, не зная о ней. Не трогаем строку ЦЕЛИКОМ, включая
  // ссылки: перевесить защищённый визит на другого пациента ничем не лучше,
  // чем стереть у него телефон. И не откладываем: ждать нечего, сосед просто
  // не в курсе. Точность придёт с отправкой — тогда его следующая запись
  // сольётся поколоночно, как положено.
  if (protectedHere) { stats.skipped++; return; }

  const cols = [];
  const vals = [];
  const seenCol = ctx.q(`SELECT stamp FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = ?`);
  for (const col of SHIPPED[rec.tbl]) {
    if (!rec.data || !Object.prototype.hasOwnProperty.call(rec.data, col)) continue;
    const prev = seenCol.get(rec.tbl, rec.uid, col);
    if (prev && compareStamps(rec.stamp, prev.stamp) <= 0) continue;   // эта колонка новее у нас
    cols.push(col); vals.push(rec.data[col]);
  }
  // Новая строка: у неё ничего не защищено и ничего не видено — все колонки едут.
  //
  // Ссылки: uid родителя → его местный id. Родителя ещё нет — запись ЦЕЛИКОМ
  // уходит в ожидание: NOT NULL и внешние ключи не дадут вставить ребёнка с
  // пустой ссылкой, и это правильно. Ссылка на справочник (CODE_REFS) ищется
  // по коду, а не по uid: у services нет uid, его синхронизирует catalogue.js.
  //
  // sync_pending хранит ОДНОГО ожидаемого родителя, и break ниже — на первом
  // отсутствующем. Сегодня у каждой таблицы одна ссылка на строку плюс не более
  // одной на справочник, и запись, дождавшаяся первого родителя, тут же уходит
  // ждать второго; вторая ссылка НА СТРОКУ потребует ждать обоих сразу.
  let waiting = null;
  for (const [col, parent] of Object.entries(REFS[rec.tbl] || {})) {
    const parentUid = rec.refs ? rec.refs[col] : null;
    if (!parentUid) {
      // Ссылки нет в самой записи. У существующей строки она давно проставлена
      // — не трогаем. У НОВОЙ вставить нечего: колонка NOT NULL, и попытка
      // уронила бы ВСЮ порцию на строке, которую всё равно нечем применить.
      if (id == null) { stats.skipped++; return; }
      continue;
    }
    const pid = localId(db, ctx, parent, parentUid);
    if (pid == null) { waiting = { tbl: parent, uid: parentUid }; break; }
    cols.push(col); vals.push(pid);
  }
  if (!waiting) {
    for (const [col, spec] of Object.entries(CODE_REFS[rec.tbl] || {})) {
      const code = rec.refs ? rec.refs[spec.ref] : null;
      if (!code) continue;
      const pid = catalogueId(db, ctx, spec, code);
      if (pid == null) { waiting = { tbl: spec.table, uid: code }; break; }
      cols.push(col); vals.push(pid);
    }
  }
  if (waiting) {
    const json = JSON.stringify(rec);
    // Ожидание — рабочая таблица, а не свалка: одна раздутая запись, которую
    // всё равно нечем применить, не должна занимать место годами.
    if (json.length > MAX_PENDING_BYTES) { stats.skipped++; return; }
    // Более поздняя запись про ту же строку замещает более раннюю; более ранняя
    // НЕ затирает более позднюю — порядок прихода не гарантирован ничем.
    ctx.q(`INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(tbl, uid) DO UPDATE SET
             stamp = excluded.stamp, record = excluded.record,
             waits_tbl = excluded.waits_tbl, waits_uid = excluded.waits_uid,
             received_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE excluded.stamp > sync_pending.stamp`)
      .run(rec.tbl, rec.uid, rec.stamp, json, waiting.tbl, waiting.uid);
    stats.deferred++;   // не «пропущено» — ждёт родителя; читающему лог это две разные новости
    return;
  }

  // Надгробие снимается только теперь, когда запись точно применяется: сними
  // его раньше — и запись, ушедшая ждать родителя, потеряла бы защиту от
  // воскрешения, а вместе с ней и весь смысл правила.
  if (tomb) ctx.q(`DELETE FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = ?`).run(rec.tbl, rec.uid, '*');

  // Новая строка, в которой нечего записать, — не строка: у большинства этих
  // таблиц есть NOT NULL без умолчания (patients.full_name, visits.visit_date),
  // и `INSERT (uid) VALUES (?)` уронил бы транзакцию целиком.
  if (id == null && !cols.length) { stats.skipped++; return; }

  if (id == null) {
    ctx.q(
      `INSERT INTO ${rec.tbl} (uid${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES (?${cols.map(() => ', ?').join('')})`
    ).run(rec.uid, ...vals);
  } else if (cols.length) {
    ctx.q(`UPDATE ${rec.tbl} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...vals, id);
  }
  const remember = ctx.q(`INSERT INTO ${SEEN} (tbl, uid, col, stamp) VALUES (?,?,?,?)
              ON CONFLICT(tbl, uid, col) DO UPDATE SET stamp = excluded.stamp`);
  for (const col of cols) remember.run(rec.tbl, rec.uid, col, rec.stamp);
  if (cols.length || id == null) stats.applied++; else stats.skipped++;
}

// Строка справочника — по КОДУ. Дублей кода схема не запрещает, поэтому берём
// самую раннюю: любой другой выбор («последняя», «любая») менялся бы от порции
// к порции, и одна и та же приехавшая работа садилась бы то на одну услугу, то
// на другую.
function catalogueId(db, ctx, spec, code) {
  const r = ctx.q(`SELECT id FROM ${spec.table} WHERE ${spec.key} = ? ORDER BY id LIMIT 1`).get(code);
  return r ? r.id : null;
}

// Строка менялась здесь и ещё не уехала соседу, от которого пришла порция?
// Тогда её колонки новее любой приехавшей записи. Какие именно колонки —
// журнал не знает, поэтому защищаются все: грубее, но теряет ноль правок.
// ПО СОСЕДУ (origin записи), а не MIN по всем: с тремя филиалами заброшенный D
// держал бы MIN(sent_seq) внизу вечно, и каждая строка, которую здесь хоть раз
// правили, отвергала бы ВСЕ слияния, пока D не выйдет на связь (ревью Задачи 2).
function hasLocalUnshipped(db, ctx, tbl, uid, peer) {
  const last = ctx.q('SELECT MAX(seq) AS s FROM sync_journal WHERE tbl = ? AND uid = ?').get(tbl, uid);
  if (!last || !last.s) return false;
  // Запись без origin (better-sqlite3 не связывает undefined и уронил бы всю
  // порцию) — соседа не назвали, значит доказать, что наша правка до него
  // доехала, нечем: считаем строку защищённой. Осторожность здесь ничего не
  // теряет — правка приедет снова.
  const sent = ctx.q('SELECT sent_seq FROM sync_peers WHERE node = ?').get(typeof peer === 'string' ? peer : '');
  return !sent || last.s > sent.sent_seq;
}

// Применить тех, кто ждал родителей, которые УЖЕ на месте.
//
// Ищем не «кто приехал в этой порции», а «чей родитель существует локально
// прямо сейчас»: родитель мог приехать и не порцией — услуга справочника
// приезжает через catalogue.js, отдельным механизмом, и ожидавшая её строка
// иначе не разобралась бы никогда.
//
// Точечно, по (waits_tbl, waits_uid): связать всех висящих детей с первым
// попавшимся родителем было бы не «не связать», а перепутать — хуже.
// Освобождённый ребёнок сам может быть родителем (визит → услуга → результат),
// поэтому цикл до неподвижной точки.
function releasePending(db, stats, ctx) {
  for (let round = 0; round < MAX_RELEASE_ROUNDS; round++) {
    const ready = ctx.q('SELECT DISTINCT waits_tbl, waits_uid FROM sync_pending').all()
      .filter((p) => parentPresent(db, ctx, p.waits_tbl, p.waits_uid));
    if (!ready.length) return;

    for (const parent of ready) {
      const rows = ctx.q('SELECT tbl, uid, record FROM sync_pending WHERE waits_tbl = ? AND waits_uid = ?')
        .all(parent.waits_tbl, parent.waits_uid);
      for (const row of rows) {
        // Строка снимается с ожидания ДО применения: если родителя уже видно, а
        // записи не хватает чего-то ещё, applyOne положит её обратно — уже с
        // новым «кого ждём». Оставить её на месте значило бы вечно ждать того,
        // кто приехал.
        ctx.q('DELETE FROM sync_pending WHERE tbl = ? AND uid = ?').run(row.tbl, row.uid);
        let rec;
        try {
          rec = JSON.parse(row.record);
        } catch {
          // Испорченный JSON применить нечем, и хранить его дальше незачем:
          // он уже снят с ожидания выше.
          stats.skipped++;
          continue;
        }
        applyOne(db, rec, stats, ctx);
      }
    }
  }
}

// Родитель на месте? Строки — по uid, справочник — по коду, ровно так же, как
// их резолвит applyOne: иначе освобождение и применение разошлись бы, и запись
// ходила бы по кругу «освободили → снова в ожидание».
function parentPresent(db, ctx, tbl, key) {
  for (const specs of Object.values(CODE_REFS)) {
    for (const spec of Object.values(specs)) {
      if (spec.table === tbl) return catalogueId(db, ctx, spec, key) != null;
    }
  }
  if (!SHIPPED[tbl]) return false;   // неизвестная таблица: ждать её нечем
  return localId(db, ctx, tbl, key) != null;
}
