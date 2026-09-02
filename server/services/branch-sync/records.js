// BRANCH_RECORDS_V1 — приём чужих изменений.
//
// ТРИ ПРАВИЛА, каждое из которых нельзя переиграть после того, как данные
// разъехались:
//
//   1. Строки приезжают по СВОИМ локальным id (uid → id через таблицу).
//      Перенести чужой id значило бы перевесить местные счета и смены кассы на
//      чужие строки — разбор этого есть в миграции 079.
//   2. Слияние ПОКОЛОНОЧНОЕ — и в обе стороны. Приехавшая запись меняет только
//      те колонки, которые отправитель ПРАВИЛ (rec.changed), и только если её
//      метка новее той, под которой эта колонка менялась в последний раз;
//      местная неотправленная правка держит СВОИ колонки, а не строку целиком.
//      Телефон, исправленный здесь, и адрес, исправленный там, обязаны выжить
//      оба — включая случай, когда обе правки ещё не отданы (шапка 084).
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
// БАЙТЫ, а не символы: в кириллице буква — два байта, и .length занизил бы
// размер русской записи вдвое ровно там, где предел и нужен.
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
// Та же граница, что NODE_RE в hlc.js и LETTER_MAX_CHARS в letters.js. Здесь
// своя копия, а не импорт: hlc проверяет букву в чеканке метки, а нам нужно
// отказать ДО транзакции — на входе, где отказ ничего не стоит.
const SELF_RE = /^[A-Z]{1,8}$/;

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
 * @param {{self: string, peer?: string}} opts self — буква ЭТОГО узла (идёт в
 *   часы); peer — буква узла, ЧЕЙ блоб мы забрали, если она известна вызывающему.
 * @returns {{applied:number, released:number, skipped:number, protected:number, deferred:number, deleted:number}}
 *   released — сколько строк применено ИЗ ОЖИДАНИЯ; protected — сколько записей
 *   отдали хотя бы одну колонку местной неотправленной правке; deferred — сколько
 *   строк ЖДЁТ родителя на конец транзакции (не «сколько раз отложили»).
 */
export function applyBatch(db, records, { self, peer = null } = {}) {
  // Без self часы после приёма не чеканятся, и узел с отставшими часами
  // проигрывал бы слияние вечно — это тихая потеря данных, а не мелочь.
  // Проверяется ФОРМА буквы, а не просто «не пусто»: self уходит в nextStamp,
  // и мусор вроде true или 'узел-1' уронил бы там ВСЮ транзакцию в самом
  // конце — после того, как порция уже применена, но до записи часов.
  if (!SELF_RE.test(String(self == null ? '' : self).toUpperCase())) {
    throw new Error('applyBatch: self letter required, got ' + JSON.stringify(self));
  }
  const stats = { applied: 0, released: 0, skipped: 0, protected: 0, deferred: 0, deleted: 0 };
  const ctx = newCtx(db);

  const run = db.transaction((batch) => {
    const mark = db.prepare('SELECT MAX(seq) AS s FROM sync_journal').get();
    const journalFrom = mark && mark.s ? mark.s : 0;

    for (const rec of batch) {
      // ЧУЖОЙ ОТПРАВИТЕЛЬ. origin приходит из порции, то есть от того, кто её
      // прислал; проверить его подпись нечем. Но ВЫЗЫВАЮЩИЙ знает, чей блоб он
      // сейчас забрал, и запись, подписанная другой буквой, в этом блобе —
      // либо ошибка сборки, либо попытка выдать себя за третий филиал. Такая
      // запись не применяется: origin решает, чью защиту снимать (см.
      // localUnshippedCols) и чьей меткой подписывать строку.
      if (peer && (!rec || typeof rec !== 'object' || rec.origin !== peer)) { stats.skipped++; continue; }
      applyGuarded(db, rec, stats, ctx);
    }

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

    // deferred — сколько строк ЖДЁТ, а не сколько раз откладывали. Цепочка
    // «результат → услуга → визит», приехавшая задом наперёд одной порцией и
    // разобранная тут же, — это deferred 0 и released 3, а не «отложено три
    // раза»: читающему лог важно, сколько работы ОСТАЛОСЬ висеть.
    stats.deferred = db.prepare('SELECT COUNT(*) AS n FROM sync_pending').get().n;
  });

  run(Array.isArray(records) ? records : []);
  return stats;
}

// ОДНА КРИВАЯ ЗАПИСЬ НЕ ОТМЕНЯЕТ ПОРЦИЮ. Проверить форму записи на входе можно,
// но не всё ловится проверкой: CHECK-ограничение (visits.status), внешний ключ,
// длина поля — это отказ САМОЙ БАЗЫ уже посреди вставки. Без savepoint такой
// отказ выбрасывает наружу всю транзакцию: сотня здоровых записей теряется
// из-за одной, и следующая порция принесёт ту же кривую снова.
//
// ROLLBACK TO не снимает savepoint — RELEASE после него обязателен, иначе
// метка копится на каждую запись до конца транзакции.
//
// Счётчики откатываются вместе с данными: applyOne успевает их тронуть до
// падения, и без восстановления в статистике осталось бы «применено» то,
// чего в базе нет.
function applyGuarded(db, rec, stats, ctx) {
  const before = { ...stats };
  ctx.q('SAVEPOINT rec').run();
  try {
    applyOne(db, rec, stats, ctx);
    ctx.q('RELEASE rec').run();
  } catch (e) {
    ctx.q('ROLLBACK TO rec').run();
    ctx.q('RELEASE rec').run();
    Object.assign(stats, before);
    stats.skipped++;
    // Именно предупреждением, а не молчанием: запись, которую база не берёт,
    // будет приезжать снова и снова, и знать об этом должен человек.
    console.warn('[sync] record refused', rec && rec.tbl, rec && rec.uid, rec && rec.stamp, e.message);
  }
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
// Чего эта граница НЕ закрывает, и об этом надо знать вслух: порция от соседа
// с нормальными часами, пришедшая МЕЖДУ двумя порциями отставшего, поднимает
// границу до «сейчас» и вычищает метки эпохи 1970 — вместе с надгробиями.
// Случай узкий (нужен именно такой порядок порций) и ограниченный по ущербу,
// но он есть: полное лечение — своя граница на КАЖДОГО соседа, то есть ещё
// одна таблица, а не строчка здесь.
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
      || typeof rec.uid !== 'string' || !isStamp(rec.stamp)
      || !scalarPayload(rec.data)) { stats.skipped++; return; }
  // Часы двигаются за ЛЮБОЙ годной приехавшей меткой — и за удалением, и за
  // отложенной в ожидание, и за пропущенной: иначе узел с отставшими часами,
  // получивший детей раньше родителей, ничему не учится и продолжает проигрывать.
  if (rec.stamp > ctx.maxReceived) ctx.maxReceived = rec.stamp;

  const id = localId(db, ctx, rec.tbl, rec.uid);
  // Колонки, правленные ЗДЕСЬ и ещё не отданные этому соседу. Пустое множество
  // — защищать нечего. Новой строки (id == null) здесь не правили по
  // определению: терять нечего, защита не нужна.
  const guarded = id == null ? EMPTY : localUnshippedCols(db, ctx, rec.tbl, rec.uid, rec.origin);

  if (rec.op === 'del') {
    // Правило 3. Удаление проигрывает любой более поздней правке — местной
    // неотправленной или приехавшей с более новой меткой по любой колонке.
    // ЛЮБАЯ незаконченная местная правка держит строку целиком: удалять
    // наполовину нечем, и «уцелела одна колонка» здесь не ответ.
    const newerCol = ctx.q(`SELECT 1 FROM ${SEEN} WHERE tbl = ? AND uid = ? AND stamp > ? LIMIT 1`)
      .get(rec.tbl, rec.uid, rec.stamp);
    if (guarded.size) { stats.skipped++; stats.protected++; return; }
    if (newerCol) { stats.skipped++; return; }
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

  // ЧТО В ЭТОЙ ЗАПИСИ АВТОРСКОЕ. data — снимок ВСЕЙ строки отправителя (иначе
  // новую строку у нас нечем было бы завести), но правил он только колонки из
  // changed; остальное в снимке — его КОПИЯ чужих значений, часто устаревшая.
  // Применять их «заодно» значит объявлять его автором того, чего он не
  // касался: так телефон, исправленный здесь, возвращался пустым под меткой
  // новее и пропадал из сети целиком (шапка 084).
  //
  // Запись СТАРОЙ сборки без changed — '*': «неизвестно, что менялось».
  // Прежнее поведение слово в слово, и никакой сосед не ломается от обновления
  // одной стороны раньше другой.
  //
  // У НОВОЙ строки (id == null) changed не спрашиваем вовсе: терять нечего,
  // а собрать её из трёх изменённых полей нельзя — NOT NULL без умолчания.
  const changed = id == null ? null : changedSet(rec);
  let held = false;   // хоть одну авторскую колонку забрала местная правка
  const wanted = (col) => {
    if (changed && !changed.has('*') && !changed.has(col)) return false;
    if (guarded.has('*') || guarded.has(col)) { held = true; return false; }
    return true;
  };

  const cols = [];
  const vals = [];
  const seenCol = ctx.q(`SELECT stamp FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = ?`);
  for (const col of SHIPPED[rec.tbl]) {
    if (!rec.data || !Object.prototype.hasOwnProperty.call(rec.data, col)) continue;
    if (!wanted(col)) continue;
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
    // Ссылка — такая же КОЛОНКА, как телефон, и подчиняется тем же правилам:
    // и авторству (changed), и защите местной правки. У СУЩЕСТВУЮЩЕЙ строки
    // ссылка уже проставлена — не наше дело её трогать. У новой она нужна
    // всегда: без родителя строки не собрать.
    if (id != null && !wanted(col)) continue;
    // Без проверки ниже запись, отлежавшая в ожидании, при освобождении
    // перевешивала бы визит на пациента из своей УСТАРЕВШЕЙ ссылки, оставляя
    // статус от более новой записи: половина строки от вчера, половина от
    // сегодня, и никакой ошибки в логах.
    const prevRef = seenCol.get(rec.tbl, rec.uid, col);
    if (prevRef && compareStamps(rec.stamp, prevRef.stamp) <= 0) {
      // Ссылку уже приняли новее. Существующей строке это ничем не грозит, а
      // НОВУЮ без обязательного родителя не собрать — и выдумывать его нельзя.
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
      if (id != null && !wanted(col)) continue;
      // То же правило. Колонка необязательная (visit_services.service_id
      // допускает NULL), поэтому устаревшую ссылку достаточно не трогать.
      const prevRef = seenCol.get(rec.tbl, rec.uid, col);
      if (prevRef && compareStamps(rec.stamp, prevRef.stamp) <= 0) continue;
      const pid = catalogueId(db, ctx, spec, code);
      if (pid == null) { waiting = { tbl: spec.table, uid: code }; break; }
      cols.push(col); vals.push(pid);
    }
  }
  if (waiting) {
    const json = JSON.stringify(rec);
    // Ожидание — рабочая таблица, а не свалка: одна раздутая запись, которую
    // всё равно нечем применить, не должна занимать место годами.
    if (Buffer.byteLength(json, 'utf8') > MAX_PENDING_BYTES) { stats.skipped++; return; }
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
    // Не «пропущено» — ждёт родителя; читающему лог это две разные новости.
    // Считается не здесь, а в конце транзакции: часть отложенных освободится
    // в этой же порции, и «отложено 3, применено 3» сбивало бы с толку.
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
    // BRANCH_ORIGIN_V1 — откуда строка, ставится ОДИН РАЗ, при вставке. UPDATE
    // её не трогает: то, что сосед потом поправил запись, не делает её своей и
    // наоборот. В SHIPPED колонки нет — у каждого узла своя точка зрения, и
    // отправить её значило бы объявить соседу его собственные строки чужими.
    // Не строка (undefined у записи без origin) → NULL: better-sqlite3 не
    // связывает undefined и уронил бы всю порцию.
    const origin = typeof rec.origin === 'string' && rec.origin !== '' ? rec.origin : null;
    ctx.q(
      `INSERT INTO ${rec.tbl} (uid, sync_origin${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES (?, ?${cols.map(() => ', ?').join('')})`
    ).run(rec.uid, origin, ...vals);
  } else if (cols.length) {
    ctx.q(`UPDATE ${rec.tbl} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...vals, id);
  }
  // Строка применена напрямую. Всё, что лежит по ней в ожидании со МЕНЬШЕЙ
  // меткой, устарело: дождавшись своего родителя, оно воспроизвело бы старое
  // состояние поверх нового. Поколоночное правило выше и так не дало бы ему
  // победить, но снять перекрытое ожидание дешевле, чем годами хранить и
  // раз за разом проигрывать его заново. Ожидание с БОЛЬШЕЙ меткой остаётся:
  // оно новее и выиграет по колонкам, когда придёт его час.
  ctx.q('DELETE FROM sync_pending WHERE tbl = ? AND uid = ? AND stamp <= ?')
    .run(rec.tbl, rec.uid, rec.stamp);
  const remember = ctx.q(`INSERT INTO ${SEEN} (tbl, uid, col, stamp) VALUES (?,?,?,?)
              ON CONFLICT(tbl, uid, col) DO UPDATE SET stamp = excluded.stamp`);
  // Метка пишется ТОЛЬКО применённым колонкам. Написать её всему снимку
  // значило бы объявить отправителя автором каждой колонки строки — с этого
  // и начинался дефект, который чинит вся эта задача.
  for (const col of cols) remember.run(rec.tbl, rec.uid, col, rec.stamp);
  if (held) stats.protected++;
  if (cols.length || id == null) stats.applied++; else stats.skipped++;
}

// Значения, которые better-sqlite3 умеет связать. Всё прочее (true, объект,
// массив, undefined) роняет вставку — а обещание файла в том, что мусорная
// запись пропускается ПОИМЁННО. Проверка на входе честнее savepoint'а: тот
// откатит уже начатую работу, эта не даст её начать.
function scalarPayload(data) {
  if (data == null) return true;                                   // del и записи без данных
  if (typeof data !== 'object' || Array.isArray(data)) return false;
  for (const v of Object.values(data)) {
    const t = typeof v;
    if (v === null || t === 'number' || t === 'string' || t === 'bigint') continue;
    if (Buffer.isBuffer(v)) continue;
    return false;
  }
  return true;
}

const EMPTY = new Set();

// Какие колонки отправитель ПРАВИЛ (а не просто прислал в снимке). Запись без
// changed — старая сборка соседа: считаем авторской всю строку, ровно как до
// этой задачи.
function changedSet(rec) {
  if (!Array.isArray(rec.changed) || !rec.changed.length) return null;
  const set = new Set();
  for (const col of rec.changed) if (typeof col === 'string' && col) set.add(col);
  return set.size ? set : null;
}

// Строка справочника — по КОДУ. Дублей кода схема не запрещает, поэтому берём
// самую раннюю: любой другой выбор («последняя», «любая») менялся бы от порции
// к порции, и одна и та же приехавшая работа садилась бы то на одну услугу, то
// на другую.
function catalogueId(db, ctx, spec, code) {
  const r = ctx.q(`SELECT id FROM ${spec.table} WHERE ${spec.key} = ? ORDER BY id LIMIT 1`).get(code);
  return r ? r.id : null;
}

// КАКИЕ КОЛОНКИ этой строки правили здесь и ещё не отдали соседу, от которого
// пришла порция. Пустое множество — защищать нечего; '*' в множестве — вся
// строка (вставка или правка соседа неизвестной сборки).
//
// Раньше здесь был ответ «да/нет» на всю строку, и «да» означало ОТБРОСИТЬ
// приехавшую запись целиком. Цена оказалась не в грубости, а в потере: сосед,
// чью запись мы отбросили, уже сдвинул свой markSent и второй раз её не
// пришлёт — правка исчезала из сети навсегда (шапка 084, ревью Задачи 5).
// Теперь местная правка держит СВОИ колонки, а остальное сливается как обычно.
//
// ПО СОСЕДУ (origin записи), а не MIN по всем: с тремя филиалами заброшенный D
// держал бы MIN(sent_seq) внизу вечно, и каждая строка, которую здесь хоть раз
// правили, отвергала бы ВСЕ слияния, пока D не выйдет на связь (ревью Задачи 2).
function localUnshippedCols(db, ctx, tbl, uid, peer) {
  const last = ctx.q('SELECT MAX(seq) AS s FROM sync_journal WHERE tbl = ? AND uid = ?').get(tbl, uid);
  if (!last || !last.s) return EMPTY;
  // Запись без origin (better-sqlite3 не связывает undefined и уронил бы всю
  // порцию) — соседа не назвали, значит доказать, что наша правка до него
  // доехала, нечем: считаем защищённой всю строку. Осторожность здесь ничего
  // не теряет — правка приедет снова.
  const sent = ctx.q('SELECT sent_seq FROM sync_peers WHERE node = ?').get(typeof peer === 'string' ? peer : '');
  if (!sent) return ALL;
  const rows = ctx.q('SELECT DISTINCT cols FROM sync_journal WHERE tbl = ? AND uid = ? AND seq > ?')
    .all(tbl, uid, sent.sent_seq);
  const set = new Set();
  for (const row of rows) {
    for (const part of String(row.cols || '*').split(',')) {
      const col = part.trim();
      if (!col) continue;
      if (col === '*') return ALL;
      set.add(col);
    }
  }
  return set;
}

// Отдельная константа, а не new Set(['*']) на каждый вызов: множество только
// читают, и одно на процесс дешевле пяти тысяч одинаковых на порцию.
const ALL = new Set(['*']);

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
        // Дождавшаяся запись проходит те же savepoint и те же проверки, что и
        // только что приехавшая: за месяцы ожидания схема могла уйти вперёд, и
        // отказ базы на СТАРОЙ записи не должен отменять свежую порцию.
        const appliedBefore = stats.applied;
        applyGuarded(db, rec, stats, ctx);
        // Освобождением считается только настоящее применение: запись, ушедшая
        // ждать ВТОРОГО родителя, из ожидания не вышла.
        if (stats.applied > appliedBefore) stats.released++;
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
