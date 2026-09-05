// CALENDAR_BOOKING_V1 — запись на приём: что свободно и кто куда записан.
//
// Два обработчика:
//   calendar_slots  — ЧИТАЕТ: свободные начала приёма у врача (или в кабинете)
//                     на день, с учётом графика, обеда, часов клиники и уже
//                     занятого. Стоит в READ_ONLY_RPCS (control/gate.js).
//   calendar_book   — ПИШЕТ: создаёт запись, а с visit_id — переносит или
//                     растягивает существующую. ОДИН вход на все три действия,
//                     потому что проверка у всех трёх одна и та же.
//
// ─── ЗАПРЕТ ДВОЙНОЙ ЗАПИСИ ──────────────────────────────────────────────────
//
// Правило владельца (2026-09-05): «Один пациент на врача на слот — жёсткий
// запрет». Жёсткий — значит на сервере: проверка, которую можно обойти,
// выключив JavaScript или послав тот же запрос curl'ом из соседнего кабинета,
// запретом не является.
//
// Отказ НАЗЫВАЕТ ЗАНЯТОЕ ВРЕМЯ, а не говорит «нельзя». Регистратура работает с
// человеком у стойки: «занято» без времени заставляет её тыкать в сетку
// наугад, «занято 14:30–15:00» — сразу предложить 15:00.
//
// ЭКСТРЕННАЯ ЗАПИСЬ — ОТДЕЛЬНОЕ ДЕЙСТВИЕ С ПРИЧИНОЙ, а не тихий обход.
// Поверх занятого времени записать можно, но только назвав, зачем; причина
// уходит в visits.notes, то есть остаётся в самой записи и уезжает филиалам
// вместе с ней (notes — в SHIPPED). Флаг без причины отвергается: «галочка,
// снимающая проверку» — это отсутствие проверки.
//
// ─── ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ ────────────────────────────────────────────────
//
// 1. Запрета на двойную занятость КАБИНЕТА. Правило владельца сформулировано
//    про врача, и только про врача. У кабинета есть capacity (миграция 082), в
//    процедурной одновременно бывает несколько человек, и запрет там означал бы
//    запрет того, что клиника делает каждый день. Ось кабинетов остаётся
//    показывающей, а не запрещающей.
// 2. Ограничения в самой базе. Разбор — в шапке миграции 099: ensure_visit
//    ставит визит-контейнер дня на 09:00, и ограничение уровня таблицы
//    отказало бы второму пациенту врача в регистрации вовсе. Именно так и
//    случилось в старшей системе (visits_no_overlap).
// 3. Отдельного правила для чужих зданий. Их записи проверяются ТЕМ ЖЕ loadBusy
//    и тем же условием: доехала — занимает время врача. Разбор — ниже.
//
// ═══ CROSS_BRANCH_CALENDAR_V1 — ЗАПИСЬ В ЛЮБОЙ ФИЛИАЛ ══════════════════════
//
// Решение владельца (2026-09-05): «видеть и записывать в любой». Цена названа
// ему вслух: здания обмениваются раз в час, поэтому внутри часа два оператора в
// двух зданиях физически могут занять один слот. Он выбрал это, приняв
// смягчение, которое здесь и сделано.
//
// ── ВРАЧ ЕДЕТ С ЗАПИСЬЮ ─────────────────────────────────────────────────────
// В этой шапке раньше стояло: «doctor_id между зданиями НЕ ЕЗДИТ, поэтому у
// приехавшей записи он NULL и в занятость врача она попасть не может
// физически». Теперь едет — ССЫЛКОЙ ПО ЛОГИНУ (branch-sync/journal.js,
// CODE_REFS.visits), как услуга едет кодом. Следствие для ЭТОГО файла ровно
// одно, и оно бесплатное: loadBusy никогда не фильтровал по sync_origin,
// поэтому доехавшая чужая запись занимает время врача сама собой. «Проверка
// двойной записи учитывает то, что прислало соседнее здание» — не новая ветка
// кода, а прямое следствие того, что врач наконец доезжает.
//
// ── ЧТО ЗНАЧИТ «ЗАПИСАТЬ В ЧУЖОЕ ЗДАНИЕ» ────────────────────────────────────
// Тот же вход и то же действие: calendar_book с branch_id того здания (или
// просто с врачом, который к нему приписан). Отличий три:
//
//   1. запись помечается cross_branch = буква того здания и cross_branch_seq =
//      номер её записи в журнале (миграция 100);
//   2. журнал выкладывается НЕМЕДЛЕННО (relay.js publishBookingNow), а не в
//      часовой такт: час задержки здесь означает второго человека на том же
//      приёме;
//   3. ответ несёт cross_branch.published — уехало или нет. Оператор обязан это
//      увидеть, потому что перед ним стоит человек.
//
// ── ЕСЛИ СВЯЗИ НЕТ: ДЕРЖИМ КАК НЕПОДТВЕРЖДЁННУЮ, А НЕ ОТКАЗЫВАЕМ ────────────
// Решение и его цена, названные прямо. Отказ был бы честнее только на словах:
// слот в том здании В САМОМ ДЕЛЕ свободен, и отказ означал бы потерянного
// пациента при живом свободном времени — а канал у клиники падает буднично
// (интернет в филиале, ночь, перезагрузка роутера). Поэтому запись СОЗДАЁТСЯ и
// слот держится здесь; но слова «записано» оператор не слышит: ответ говорит
// «не подтверждено, там об этом ещё не знают», и карточка носит ту же метку,
// пока не придёт квитанция. Пациенту, которому сказали «записано», а его никто
// не ждёт, хуже, чем тому, кому сказали «подтвердить сейчас не могу»; но и
// «мест нет» ему говорить нельзя — места есть. Невыложенная порция не
// теряется: срез журнала накопительный и уедет следующим тактом (шапка
// publishJournal).
//
// ── НАСТОЯЩЕЕ СТОЛКНОВЕНИЕ ВНУТРИ ОКНА ──────────────────────────────────────
// Двое заняли один слот в разных зданиях в один и тот же час. Ни одна из
// записей не пропадает и не перетирает другую: это две РАЗНЫЕ строки с разными
// uid, обе доезжают, и после обмена ОБА здания видят обе. Кто «первый»,
// решается одним правилом на обеих сторонах (resolveCollisions ниже):
// booked_at, затем буква здания-автора, затем uid. Все три одинаковы у обеих
// сторон, поэтому и ответ одинаков — проигравшего называют оба здания, а не
// каждое своего. Дальше это работа человека, а не программы: календарь
// показывает обе карточки, метит проигравшую, регистратура звонит.

import { hasAnyRole } from '../roles.js';
import {
  BUSY_STATUSES, DEFAULT_DURATION_MIN,
  clampWindow, clinicWindow, dayWindow, formatHhmm,
  overlapsMs, serviceDurationMinutes, slotStarts, windowSegments,
} from './slot-engine.js';
// CROSS_BRANCH_CALENDAR_V1. Список зданий и возраст их картинки — один на всю
// систему (rpc/branch-sync.js networkBuildings); срочная выгрузка — та же
// машина, что и часовая (branch-sync/relay.js), а не второй канал.
import { networkBuildings } from './branch-sync.js';
import { publishBookingNow } from '../branch-sync/relay.js';
import { readIdentity } from '../branch-sync/identity.js';
import { getDataDir } from '../control/config.js';

export class RpcError extends Error {
  constructor(msg, status = 400, code = null, params = null) {
    super(msg);
    this.status = status;
    if (code) this.code = code;
    if (params) this.params = params;
  }
}

// Кто записывает. Ровно те же роли, что уже могут вставлять и править visits
// через /api/db (schema-registry): RPC не должен быть ни щедрее, ни строже
// таблицы, иначе «через календарь нельзя, а через список можно».
const BOOK_ROLES = ['admin', 'registrar', 'doctor'];

function requireRole(user, allowed) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

function optId(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isPosInt(n)) throw new RpcError(name + ' must be a positive integer.', 400);
  return n;
}

// ─── ВРЕМЯ ──────────────────────────────────────────────────────────────────
//
// Единственное место во всём календаре, где существует часовой пояс. Сервер
// стоит в той же клинике, что и регистратура (easymed.local — коробка в
// здании), поэтому местное время процесса и есть местное время клиники, а
// график врача («09:00») — местное настенное время.
//
// Внутрь движка слотов уходят МИНУТЫ ДНЯ, наружу в базу — ISO в UTC.

/** 'YYYY-MM-DD' → Date локальной полуночи этого дня. Бросает на мусоре. */
function localMidnight(dayIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso || '').trim());
  if (!m) throw new RpcError('date must be YYYY-MM-DD.', 400);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) throw new RpcError('date must be YYYY-MM-DD.', 400);
  return d;
}

/** Момент времени → минуты от местной полуночи. */
const minutesOfLocal = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

/** Момент времени → 'YYYY-MM-DD' местного дня. */
function localDayIso(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Начало приёма из аргументов. Принимаются обе формы, потому что обе уже
 * ходят по этому коду:
 *   '2026-09-05T09:30:00.000Z' — абсолютное (Date#toISOString у клиента);
 *   '2026-09-05T09:30'         — местное настенное (input type=time + date).
 * Пустая строка и мусор — отказ, а не «сегодня в 00:00».
 */
function parseStart(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new RpcError('start is required (ISO datetime).', 400);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new RpcError('start must be an ISO datetime.', 400);
  return ms;
}

// ─── ЗАНЯТОСТЬ ──────────────────────────────────────────────────────────────

/**
 * Приёмы врача (или кабинета), пересекающие сутки вокруг дня. Границы берутся
 * с запасом в сутки, а точное попадание считается в АБСОЛЮТНЫХ миллисекундах:
 * сравнивать ISO-строки на границе суток — значит зависеть от того, написал
 * автор строки '…:00Z' или '…:00.000Z' (в базе есть обе формы: ensure_visit
 * пишет первую, мастер визита — вторую).
 *
 * Занято = статусы scheduled/confirmed/arrived. Отменённый и не пришедший
 * время НЕ занимают — иначе отменённая запись держала бы слот навсегда.
 */
function loadBusy(db, { doctorId, roomId, fromMs, toMs, excludeVisitId }) {
  const col = doctorId ? 'doctor_id' : 'room_id';
  const id = doctorId || roomId;
  if (!id) return [];
  const pad = 24 * 3600 * 1000;
  const rows = db.prepare(`
    SELECT v.id, v.visit_date, v.duration_minutes, v.status, v.patient_id, v.service_id,
           p.full_name AS patient_name
      FROM visits v
      LEFT JOIN patients p ON p.id = v.patient_id
     WHERE v.${col} = ?
       AND v.status IN (${BUSY_STATUSES.map(() => '?').join(',')})
       AND v.visit_date >= ? AND v.visit_date < ?
     ORDER BY v.visit_date
  `).all(id, ...BUSY_STATUSES, new Date(fromMs - pad).toISOString(), new Date(toMs + pad).toISOString());

  const out = [];
  for (const r of rows) {
    if (excludeVisitId && r.id === excludeVisitId) continue;   // переносим саму себя — она себе не мешает
    const startMs = Date.parse(r.visit_date);
    if (Number.isNaN(startMs)) continue;
    const dur = Math.max(1, Number(r.duration_minutes) || DEFAULT_DURATION_MIN);
    const endMs = startMs + dur * 60000;
    if (endMs <= fromMs || startMs >= toMs) continue;
    out.push({
      visit_id: r.id, startMs, endMs, durationMin: dur,
      status: r.status, patient_id: r.patient_id, patient_name: r.patient_name || '',
    });
  }
  return out;
}

/** Длительность записи: из услуги, иначе явная, иначе 15 (решение владельца). */
function resolveDuration(db, { serviceId, explicit }) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Math.round(Number(explicit));
    if (!Number.isFinite(n) || n < 5) throw new RpcError('duration_minutes must be at least 5.', 400);
    if (n > 24 * 60) throw new RpcError('duration_minutes must be under 24 hours.', 400);
    return n;
  }
  if (serviceId) {
    const svc = db.prepare('SELECT duration_minutes FROM services WHERE id = ?').get(serviceId);
    return serviceDurationMinutes(svc, DEFAULT_DURATION_MIN);
  }
  return DEFAULT_DURATION_MIN;
}

/** Окно ресурса на день, уже суженное часами клиники. */
function resourceWindow(db, { doctor, room, dayIso }) {
  const weekday = localMidnight(dayIso).getDay();
  const res = doctor || room;
  if (!res) return null;
  const win = dayWindow(res.working_hours, weekday);
  // WORKING_HOURS_CLINIC_BOUND_V1 — здание бьёт по графику ресурса: врач,
  // работающий до 20:00 в клинике, закрывающейся в 18:00, принимает до 18:00.
  const branchId = doctor ? doctor.branch_id : null;
  const branch = branchId
    ? db.prepare('SELECT id, working_hours, is_24_7 FROM branches WHERE id = ?').get(branchId)
    : null;
  return clampWindow(win, clinicWindow(branch, weekday));
}

// ═══════════════════════════════════════════════════════════════════════════
// CROSS_BRANCH_CALENDAR_V1 — здания, подтверждения, столкновения
// ═══════════════════════════════════════════════════════════════════════════

/** Буква ЭТОГО здания; null — установка ещё не знает, кто она (не связана). */
function selfLetter(db) {
  try {
    const l = readIdentity(db).letter;
    return l ? String(l).trim().toUpperCase() : null;
  } catch { return null; }
}

/** Буква здания по его id. null — здания нет или буквы ему ещё не выдали. */
function letterOfBranch(db, branchId) {
  if (!branchId) return null;
  try {
    const row = db.prepare('SELECT letter FROM branches WHERE id = ?').get(branchId);
    const l = row && row.letter ? String(row.letter).trim().toUpperCase() : '';
    return l || null;
  } catch { return null; }
}

/**
 * В КАКОЕ ЗДАНИЕ ЗАПИСЫВАЕМ. null = в своё (обычный случай, ничего не меняется).
 *
 * ДВА ИСТОЧНИКА, И ПОРЯДОК МЕЖДУ НИМИ — РЕШЕНИЕ. Явный branch_id сильнее
 * приписки врача: оператор, выбравший здание в календаре, знает, что делает,
 * а users.branch_id — справочный факт, который у ПРИЕХАВШЕГО справочником
 * сотрудника вовсе пуст (catalogue.js не везёт branch_id: «филиал 2» главной
 * клиники во втором корпусе означал бы случайное здание). Поэтому:
 *   1) сказали branch_id — верим ему;
 *   2) не сказали — берём приписку врача;
 *   3) не знаем ничего — считаем, что записываем к себе. Это безопасный
 *      исход: слот держится здесь, ничего никуда не уезжает и никто ничего не
 *      обещает от имени соседа.
 */
function bookingTarget(db, { branchId, doctorId, mine }) {
  let letter = letterOfBranch(db, branchId);
  let id = branchId || null;
  if (!letter && doctorId) {
    try {
      const doc = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(doctorId);
      if (doc && doc.branch_id) { letter = letterOfBranch(db, doc.branch_id); id = doc.branch_id; }
    } catch { /* нет колонки/строки — записываем к себе */ }
  }
  if (!letter || !mine || letter === mine) return null;
  return { letter, branch_id: id };
}

/**
 * НОМЕР В ЖУРНАЛЕ, КОТОРЫЙ ДОЛЖЕН ПОДТВЕРДИТЬ СОСЕД.
 *
 * Читается ПОСЛЕ записи в visits и в той же транзакции: журнальные триггеры
 * (084) уже отработали, и последний seq этой строки — это ровно та запись,
 * которую сосед и подтвердит своей квитанцией.
 *
 * 0 = «ждать нечего»: строка без uid (база до 083) или журнал по ней уже
 * вычищен, а чистится он только по МИНИМАЛЬНОМУ подтверждённому горизонту
 * (pruneJournal), то есть вычищен = подтверждён всеми. Ноль поэтому честно
 * значит «неподтверждённого нет», а не «неизвестно».
 */
function journalSeqOf(db, visitId) {
  try {
    const row = db.prepare('SELECT uid FROM visits WHERE id = ?').get(visitId);
    if (!row || !row.uid) return 0;
    const j = db.prepare("SELECT MAX(seq) AS s FROM sync_journal WHERE tbl = 'visits' AND uid = ?").get(row.uid);
    return j && j.s ? Number(j.s) : 0;
  } catch { return 0; }
}

/**
 * ПОДТВЕРДИЛО ЛИ ЗДАНИЕ ПРИЁМ ЗАПИСИ.
 *
 * ВТОРОГО МЕХАНИЗМА ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. sync_peers.sent_seq двигает
 * ТОЛЬКО квитанция соседа (markConfirmed, branch-sync/journal.js) — не наш
 * ответ 2xx от релея, не таймер, не флаг, который кто-то однажды забудет
 * снять. Поэтому «подтверждено» — это не колонка, а вопрос к горизонту, и
 * ответ на него не может разойтись с настоящим состоянием канала.
 *
 * Строки sync_peers нет — мы этому зданию ещё ни разу ничего не выкладывали:
 * НЕ подтверждено.
 */
function confirmedBy(db, letter, seq) {
  if (!letter || !seq) return true;
  try {
    const row = db.prepare('SELECT sent_seq FROM sync_peers WHERE node = ?').get(letter);
    return !!row && Number(row.sent_seq) >= Number(seq);
  } catch { return false; }
}

/**
 * КТО ИЗ ДВУХ ЗАПИСЕЙ ПЕРВЫЙ — правило, которое ОБА ЗДАНИЯ считают одинаково.
 *
 * Ключ из трёх частей, и каждая выбрана за то, что у обеих сторон она
 * буквально одна и та же:
 *
 *   1. booked_at — момент записи, поставленный тем, кто записал, и уехавший
 *      вместе с записью (SHIPPED.visits). Пусто у строк старше миграции 100 —
 *      они сортируются первыми и выигрывают, что верно: они и были раньше.
 *   2. буква здания-автора — sync_origin у приехавшей строки, наша буква у
 *      своей. В здании A запись из B несёт 'B'; в самом B у той же строки
 *      sync_origin пуст, но буква здания и есть 'B'. Совпадает.
 *   3. uid — одинаков везде по построению (миграция 083).
 *
 * Часы в двух зданиях могут разойтись на секунды, и тогда «первым» окажется не
 * тот, кто на самом деле нажал раньше. Это названо вслух и НЕ чинится
 * усложнением ключа: важно не «кто действительно был первым» (этого не знает
 * никто), а что оба здания назовут ОДНОГО И ТОГО ЖЕ — иначе каждое считает
 * победителем себя и оба ждут пациента.
 */
const collisionKey = (r) => [r.booked_at || '', r.home || '', r.uid || ''].join(' ');

/**
 * Столкновения ВНУТРИ ОДНОГО ВРАЧА и МЕЖДУ РАЗНЫМИ ЗДАНИЯМИ.
 *
 * Пересечение записей одного здания сюда не попадает намеренно: его не бывает
 * случайно — calendar_book отказывает, а экстренная запись поверх занятого
 * времени сделана НАРОЧНО и с причиной, и метить её «столкновением» значило бы
 * пугать регистратуру собственным решением.
 *
 * @returns {Map<number, {with:number, building:string, loses:boolean}>}
 */
function resolveCollisions(rows) {
  const out = new Map();
  const byDoctor = new Map();
  for (const r of rows) {
    if (!r.doctor_id) continue;
    if (!byDoctor.has(r.doctor_id)) byDoctor.set(r.doctor_id, []);
    byDoctor.get(r.doctor_id).push(r);
  }
  for (const list of byDoctor.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.home === b.home) continue;                       // своё двойное — не сюда
        if (a.endMs <= b.startMs || b.endMs <= a.startMs) continue;
        const aFirst = collisionKey(a) <= collisionKey(b);
        const loser = aFirst ? b : a;
        const winner = aFirst ? a : b;
        // Проигравший уже отмечен другим столкновением — не переписываем:
        // первое названное и есть то, с кем он спорит.
        if (!out.has(loser.id)) out.set(loser.id, { with: winner.id, building: winner.building, loses: true });
        if (!out.has(winner.id)) out.set(winner.id, { with: loser.id, building: loser.building, loses: false });
      }
    }
  }
  return out;
}

/**
 * ВЕСЬ МЕЖФИЛИАЛЬНЫЙ КОНТЕКСТ ВИДИМОЙ СЕТКИ — одним ответом.
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ ОБЫЧНОЕ ЧТЕНИЕ ТАБЛИЦЫ. Ни одного из этих трёх фактов в
 * `visits` нет и быть не может: «подтверждено» живёт в горизонте sync_peers,
 * «данные на HH:MM» — в возрасте последнего блоба, «кто первый» — это правило,
 * а не колонка. Считать их в браузере значило бы завести вторую реализацию
 * каждого — ровно то, из-за чего появился slot-engine.js.
 *
 * ПОЧЕМУ ВМЕСТЕ С ОКНАМИ, А НЕ ОТДЕЛЬНЫМ ВЫЗОВОМ. По той же причине, по
 * которой окна отдаются пачкой: сетка перерисовывается на каждую смену дня,
 * шага, периода и после каждой записи, и второй запрос на ту же перерисовку —
 * это второй повод ей отстать от первого.
 */
function crossContext(db, { fromMs, toMs }) {
  const buildings = networkBuildings(db);
  const mine = selfLetter(db);
  const asOf = new Map(buildings.map((b) => [b.letter, b.as_of]));

  // Границы с запасом в сутки, точное попадание — в миллисекундах: в базе
  // лежат обе формы ISO ('…:00Z' и '…:00.000Z'), и сравнение строк на границе
  // суток зависело бы от того, кто написал строку (та же оговорка, что в
  // loadBusy).
  const pad = 24 * 3600 * 1000;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT v.id, v.uid, v.doctor_id, v.visit_date, v.duration_minutes, v.status,
             v.sync_origin, v.cross_branch, v.cross_branch_seq, v.booked_at,
             u.branch_id AS doctor_branch_id
        FROM visits v
        LEFT JOIN users u ON u.id = v.doctor_id
       WHERE v.visit_date >= ? AND v.visit_date < ?
    `).all(new Date(fromMs - pad).toISOString(), new Date(toMs + pad).toISOString());
  } catch (e) {
    // База без миграции 100 — сетка обязана рисоваться и без межфилиальных
    // подписей, а не падать целиком.
    console.warn('[calendar] could not read the cross-branch context:', e && e.message);
    return { self: mine, buildings, visits: {} };
  }

  // Буква здания по id — с памяткой: строк за неделю бывают сотни, а зданий у
  // клиники два-три, и спрашивать базу на каждую строку означало бы сотни
  // запросов на одну перерисовку сетки.
  const letterMemo = new Map();
  const letterCached = (id) => {
    if (!id) return '';
    if (!letterMemo.has(id)) letterMemo.set(id, letterOfBranch(db, id) || '');
    return letterMemo.get(id);
  };

  const live = [];
  for (const r of rows) {
    const startMs = Date.parse(r.visit_date);
    if (Number.isNaN(startMs)) continue;
    const dur = Math.max(1, Number(r.duration_minutes) || DEFAULT_DURATION_MIN);
    const endMs = startMs + dur * 60000;
    if (endMs <= fromMs || startMs >= toMs) continue;
    const home = (r.sync_origin ? String(r.sync_origin).trim().toUpperCase() : mine) || '';
    // ЗДАНИЕ ПРИЁМА — не то же самое, что здание автора: запись, сделанную
    // здесь в чужой филиал, ведёт ТОТ филиал. Приписка врача сильнее всего
    // (она и решала, куда записывать), затем наша пометка cross_branch, затем
    // автор строки.
    const building = letterCached(r.doctor_branch_id)
      || (r.cross_branch ? String(r.cross_branch).trim().toUpperCase() : '')
      || home;
    live.push({
      id: r.id, uid: r.uid || '', doctor_id: r.doctor_id, startMs, endMs,
      status: r.status, home, building,
      booked_at: r.booked_at || '',
      foreign: r.sync_origin != null,
      cross: r.cross_branch ? String(r.cross_branch).trim().toUpperCase() : null,
      cross_seq: Number(r.cross_branch_seq) || 0,
    });
  }

  // Столкновения считаются ТОЛЬКО по времязанимающим статусам — по тем же
  // трём, что и запрет двойной записи: отменённая запись ни с кем не спорит.
  const collisions = resolveCollisions(live.filter((r) => BUSY_STATUSES.includes(r.status)));

  const visits = {};
  for (const r of live) {
    const confirming = !!(r.cross && !confirmedBy(db, r.cross, r.cross_seq));
    const collision = collisions.get(r.id) || null;
    // Карточка своего здания, никем не оспоренная и никого не ждущая, в этом
    // ответе не нужна: экран рисует её как рисовал.
    if (!r.foreign && !confirming && !collision && (!r.building || r.building === mine)) continue;
    visits[r.id] = {
      building: r.building || null,
      home: r.home || null,
      foreign: r.foreign,
      // Возраст картинки — только у ПРИЕХАВШЕЙ записи. У своей, даже сделанной
      // в чужое здание, данные наши и всегда свежие; про неё говорится другое —
      // подтверждена или нет.
      as_of: r.foreign ? (asOf.get(r.home) || null) : null,
      confirming,
      cross: r.cross,
      collision,
    };
  }
  return { self: mine, buildings, visits };
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_slots — что свободно
// ═══════════════════════════════════════════════════════════════════════════

/**
 * args: { doctor_id? , room_id?, date:'YYYY-MM-DD', service_id?,
 *         duration_minutes?, step_minutes?, exclude_visit_id? }
 *
 * Возвращает окно дня, свободные начала и занятое — всё в местном настенном
 * времени ('09:30') плюс ISO для тех, кто будет записывать.
 */
export function calendarSlots(db, args, user) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};
  const doctorId = optId(a.doctor_id, 'doctor_id');
  const roomId = optId(a.room_id, 'room_id');
  if (!doctorId && !roomId) throw new RpcError('doctor_id or room_id is required.', 400);
  if (doctorId && roomId) throw new RpcError('pass doctor_id or room_id, not both.', 400);

  const dayIso = String(a.date || '').slice(0, 10);
  const midnight = localMidnight(dayIso);
  const dayStartMs = midnight.getTime();
  const dayEndMs = dayStartMs + 24 * 3600 * 1000;

  const doctor = doctorId
    ? db.prepare('SELECT id, full_name, working_hours, branch_id, scheduling_mode FROM users WHERE id = ?').get(doctorId)
    : null;
  if (doctorId && !doctor) throw new RpcError('doctor not found.', 400);
  const room = roomId
    ? db.prepare('SELECT id, name, code, working_hours FROM rooms WHERE id = ?').get(roomId)
    : null;
  if (roomId && !room) throw new RpcError('room not found.', 400);

  const serviceId = optId(a.service_id, 'service_id');
  const durationMin = resolveDuration(db, { serviceId, explicit: a.duration_minutes });
  const stepMin = a.step_minutes ? Math.max(5, Math.round(Number(a.step_minutes))) : durationMin;
  const excludeVisitId = optId(a.exclude_visit_id, 'exclude_visit_id');

  const win = resourceWindow(db, { doctor, room, dayIso });
  const busy = loadBusy(db, { doctorId, roomId, fromMs: dayStartMs, toMs: dayEndMs, excludeVisitId });

  // Занятое переводится в минуты дня СМЕЩЕНИЕМ ОТ ПОЛУНОЧИ, а не часами начала:
  // приём, начавшийся вчера в 23:40 и кончающийся сегодня в 00:10, обязан
  // занять первые десять минут суток, а не 1420-ю минуту.
  const clampMin = (ms) => Math.max(0, Math.min(24 * 60, Math.round((ms - dayStartMs) / 60000)));
  const busyMinutes = busy.map((b) => ({ from: clampMin(b.startMs), to: clampMin(b.endMs) }))
    .filter((b) => b.to > b.from);

  // «Сейчас» отсекает прошедшие слоты только СЕГОДНЯ: вчерашний день читают,
  // чтобы посмотреть, что было, а не чтобы записать.
  const now = Date.now();
  const minStartMin = (now >= dayStartMs && now < dayEndMs) ? minutesOfLocal(now) : null;

  const segments = windowSegments(win);
  const starts = slotStarts({ segments, busy: busyMinutes, durationMin, stepMin, minStartMin });

  return {
    date: dayIso,
    resource: doctor
      ? { kind: 'doctor', id: doctor.id, name: doctor.full_name || '', scheduling_mode: doctor.scheduling_mode || '' }
      : { kind: 'room', id: room.id, name: room.name || '', code: room.code || '' },
    duration_minutes: durationMin,
    step_minutes: stepMin,
    window: win ? { from: formatHhmm(win.from), to: formatHhmm(win.to), breaks: (win.breaks || []).map((b) => ({ from: formatHhmm(b.from), to: formatHhmm(b.to) })) } : null,
    slots: starts.map((t) => ({
      start: formatHhmm(t),
      end: formatHhmm(t + durationMin),
      start_iso: new Date(dayStartMs + t * 60000).toISOString(),
    })),
    busy: busy.map((b) => ({
      visit_id: b.visit_id,
      from: formatHhmm(minutesOfLocal(b.startMs)),
      to: formatHhmm(minutesOfLocal(b.startMs) + b.durationMin),
      duration_minutes: b.durationMin,
      status: b.status,
      patient_id: b.patient_id,
      patient_name: b.patient_name,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_windows — рабочие окна пачкой
// ═══════════════════════════════════════════════════════════════════════════

/**
 * args: { doctor_ids?: number[], room_ids?: number[], date:'YYYY-MM-DD', days?: 1..14 }
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ОБРАБОТЧИК, А НЕ N ВЫЗОВОВ calendar_slots. Сетка календаря
 * затеняет нерабочие часы у КАЖДОЙ показанной дорожки: шесть врачей на неделю —
 * это 42 клетки «ресурс × день». Спрашивать их по одной значило бы 42 запроса
 * на каждую перерисовку; считать их в браузере значило бы завести ЧЕТВЁРТУЮ
 * реализацию правила о рабочем дне — ровно то, из-за чего этот движок и
 * появился (см. шапку slot-engine.js). Поэтому окна отдаются пачкой, одним
 * ответом, и экран не знает о графиках, обедах и часах клиники ничего.
 *
 * Возвращает { days: ['YYYY-MM-DD', …], windows: { 'doctor:7': { '2026-09-07':
 * {from:'09:00',to:'18:00',breaks:[…]} | null } } }. null = ресурс в этот день
 * не принимает.
 */
export function calendarWindows(db, args, user) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};
  const ids = (x, name) => (Array.isArray(x) ? x : []).map((v) => optId(v, name)).filter(Boolean);
  const doctorIds = ids(a.doctor_ids, 'doctor_ids');
  const roomIds = ids(a.room_ids, 'room_ids');
  // CROSS_BRANCH_CALENDAR_V1 — СПИСОК ЗДАНИЙ ОТДАЁТСЯ ДАЖЕ НА ПУСТОЙ ЗАПРОС.
  // Экран строит переключатель филиалов ДО того, как что-нибудь выбрано, и
  // отказ «выберите ресурсы» оставил бы его без переключателя навсегда.
  if (doctorIds.length + roomIds.length === 0) {
    return { days: [], windows: {}, cross: { self: selfLetter(db), buildings: networkBuildings(db), visits: {} } };
  }
  if (doctorIds.length + roomIds.length > 200) throw new RpcError('too many resources.', 400);

  const days = Math.min(14, Math.max(1, Math.round(Number(a.days) || 1)));
  const first = localMidnight(String(a.date || '').slice(0, 10));
  const dayIsos = Array.from({ length: days }, (_, i) =>
    localDayIso(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime()));

  const doctors = doctorIds.length
    ? db.prepare(`SELECT id, working_hours, branch_id FROM users WHERE id IN (${doctorIds.map(() => '?').join(',')})`).all(...doctorIds)
    : [];
  const rooms = roomIds.length
    ? db.prepare(`SELECT id, working_hours FROM rooms WHERE id IN (${roomIds.map(() => '?').join(',')})`).all(...roomIds)
    : [];

  const out = {};
  const put = (key, res, isDoctor) => {
    const byDay = {};
    for (const dayIso of dayIsos) {
      const win = resourceWindow(db, { doctor: isDoctor ? res : null, room: isDoctor ? null : res, dayIso });
      byDay[dayIso] = win
        ? { from: formatHhmm(win.from), to: formatHhmm(win.to), breaks: (win.breaks || []).map((b) => ({ from: formatHhmm(b.from), to: formatHhmm(b.to) })) }
        : null;
    }
    out[key] = byDay;
  };
  for (const d of doctors) put('doctor:' + d.id, d, true);
  for (const r of rooms) put('room:' + r.id, r, false);

  // Тот же диапазон, что и у сетки: с местной полуночи первого дня по местную
  // полуночь дня, следующего за последним.
  const fromMs = first.getTime();
  const last = localMidnight(dayIsos[dayIsos.length - 1]);
  const toMs = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  return { days: dayIsos, windows: out, cross: crossContext(db, { fromMs, toMs }) };
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_book — записать, перенести, растянуть
// ═══════════════════════════════════════════════════════════════════════════

/** Текст отказа. Русский — как у остальных отказов RPC этого проекта. */
function conflictError(doctorName, conflict) {
  const from = formatHhmm(minutesOfLocal(conflict.startMs));
  const to = formatHhmm(minutesOfLocal(conflict.startMs) + conflict.durationMin);
  const params = { doctor: doctorName || '—', from, to };
  // i18n-exempt: сообщение сервера; экран переводит его по коду slot_taken
  // (шаблон в словаре, подстановка после перевода — см. rpcErrorTemplate).
  const message = `Это время занято: у врача ${params.doctor} уже есть приём ${from}–${to}. Выберите другое время.`;
  return new RpcError(message, 409, 'slot_taken', params);
}

/**
 * args:
 *   { visit_id?, patient_id?, doctor_id?, room_id?, service_id?, branch_id?,
 *     start, duration_minutes?, status?, notes?,
 *     emergency?, emergency_reason? }
 *
 * Без visit_id — создаёт запись (нужен patient_id). С visit_id — переносит
 * и/или растягивает существующую: то же действие, та же проверка, тот же отказ.
 *
 * Возвращает { visit, created, emergency, cross_branch? }.
 *
 * cross_branch есть ТОЛЬКО у записи в чужое здание:
 *   { letter, name, published, reason, confirmed:false } — и `published: false`
 * означает «запись создана, слот держим здесь, но там о ней ещё не знают».
 * Экран обязан сказать это оператору словами (см. шапку файла).
 *
 * АСИНХРОННАЯ, и только из-за этого: запись в чужое здание выкладывается на
 * канал немедленно, и результат выгрузки — часть ответа, а не запись в логе,
 * которую никто не прочтёт. Запись в своё здание не ждёт ничего.
 *
 * deps — шов для тестов: publishImpl подменяет выгрузку, dataDir — папку
 * установки. В бою оба берутся сами (index.js зовёт вызов тремя аргументами).
 */
export async function calendarBook(db, args, user, deps = {}) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};

  const visitId = optId(a.visit_id, 'visit_id');
  const existing = visitId ? db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId) : null;
  if (visitId && !existing) throw new RpcError('visit not found.', 400);

  const startMs = parseStart(a.start);
  const dayIso = localDayIso(startMs);

  // Врач/кабинет: не переданы — остаются прежними (перетаскивание по времени
  // внутри одной дорожки не должно требовать пересылки всей карточки).
  const doctorId = a.doctor_id === undefined && existing ? existing.doctor_id : optId(a.doctor_id, 'doctor_id');
  const roomId = a.room_id === undefined && existing ? existing.room_id : optId(a.room_id, 'room_id');
  const serviceId = a.service_id === undefined && existing ? existing.service_id : optId(a.service_id, 'service_id');

  if (doctorId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
    throw new RpcError('doctor not found.', 400);
  }
  if (roomId && !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) {
    throw new RpcError('room not found.', 400);
  }
  if (serviceId && !db.prepare('SELECT 1 FROM services WHERE id = ?').get(serviceId)) {
    throw new RpcError('service not found.', 400);
  }

  const durationMin = a.duration_minutes === undefined && existing
    ? Math.max(5, Number(existing.duration_minutes) || DEFAULT_DURATION_MIN)
    : resolveDuration(db, { serviceId, explicit: a.duration_minutes });

  const patientId = existing ? existing.patient_id : optId(a.patient_id, 'patient_id');
  if (!existing) {
    if (!patientId) throw new RpcError('patient_id is required.', 400);
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('patient not found.', 400);
    }
  }

  const status = typeof a.status === 'string' && a.status
    ? a.status
    : (existing ? existing.status : 'scheduled');

  // ─── ПРОВЕРКА ───────────────────────────────────────────────────────────
  // Только для врача (см. шапку) и только для времязанимающих статусов:
  // перевод записи в «отменён» не обязан бороться за слот, который он же и
  // освобождает.
  const emergency = a.emergency === true || a.emergency === 'true';
  const reason = typeof a.emergency_reason === 'string' ? a.emergency_reason.trim() : '';
  let conflict = null;

  if (doctorId && BUSY_STATUSES.includes(status)) {
    const busy = loadBusy(db, {
      doctorId, roomId: null,
      fromMs: startMs, toMs: startMs + durationMin * 60000,
      excludeVisitId: visitId,
    });
    conflict = busy.find((b) => overlapsMs(startMs, durationMin, b.startMs, b.durationMin)) || null;
  }

  if (conflict) {
    const doctorName = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(doctorId) || {}).full_name || '';
    if (!emergency) throw conflictError(doctorName, conflict);
    if (reason.length < 3) {
      throw new RpcError(
        // i18n-exempt: сообщение сервера; ключ словаря — тот же текст.
        'Экстренная запись поверх занятого времени требует причины — укажите её.',
        400, 'emergency_reason_required',
      );
    }
  }

  // Пометка экстренной записи живёт в самой записи, а не в отдельном журнале:
  // notes уезжает филиалам (SHIPPED.visits), то есть причина доедет туда же,
  // куда доедет запись, и переживёт любую выгрузку.
  let notes = existing ? (existing.notes || '') : (typeof a.notes === 'string' ? a.notes : '');
  if (conflict && emergency) {
    const from = formatHhmm(minutesOfLocal(conflict.startMs));
    const to = formatHhmm(minutesOfLocal(conflict.startMs) + conflict.durationMin);
    // i18n-exempt: строка ПИШЕТСЯ В БАЗУ (запись о причине), а не рисуется —
    // тот же случай, что примечания к платежам и записи журнала действий.
    const mark = `Экстренная запись поверх занятого времени ${from}–${to}: ${reason}`;
    notes = notes ? notes + '\n' + mark : mark;
  }

  const visitDate = new Date(startMs).toISOString();
  const branchId = a.branch_id === undefined && existing ? existing.branch_id : optId(a.branch_id, 'branch_id');

  // CROSS_BRANCH_CALENDAR_V1 — куда записываем и, если не к себе, чего ждём.
  const mine = selfLetter(db);
  const target = bookingTarget(db, { branchId, doctorId, mine });
  // booked_at ставится ОДИН РАЗ, при создании: это «когда записали», а не
  // «когда последний раз двигали». Перенос записи на другое время не делает её
  // моложе в споре за слот — иначе тот, кто чаще правит, всегда бы выигрывал.
  const bookedAt = existing ? (existing.booked_at || '') : new Date().toISOString();

  const run = db.transaction(() => {
    let id;
    if (existing) {
      // branch_id ОБНОВЛЯЕТСЯ, но только когда его назвали явно. Иначе перенос
      // карточки мышью внутри дня молча переселял бы приём в другое здание.
      const moveBranch = a.branch_id !== undefined;
      db.prepare(`
        UPDATE visits
           SET visit_date = ?, duration_minutes = ?, doctor_id = ?, room_id = ?,
               service_id = ?, status = ?, notes = ?,
               branch_id = CASE WHEN ? THEN ? ELSE branch_id END,
               -- ДОСТАВЛЯЕМ booked_at СТРОКЕ, КОТОРАЯ ЕГО НЕ ПОЛУЧИЛА, и берём
               -- его из created_at, а не из «сейчас». Так делают два разных
               -- случая, и оба важны: строка старше миграции 100 (created_at =
               -- день, когда её и записали) и строка, только что заведённая
               -- МАСТЕРОМ ВИЗИТА — а мастер это единственный способ записать
               -- пациента, и своего booked_at он не ставит. Поставь мы здесь
               -- «сейчас», прошлогодняя запись при первой же правке
               -- омолодилась бы до сегодняшнего дня и проиграла бы спор за
               -- слот записи, сделанной пять минут назад.
               --
               -- Только у СВОЕЙ строки: у приехавшей created_at означает «когда
               -- МЫ её приняли» и временем записи не является ни в каком смысле.
               booked_at = CASE WHEN booked_at = '' AND sync_origin IS NULL
                                THEN COALESCE(NULLIF(created_at, ''), ?) ELSE booked_at END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?
      `).run(visitDate, durationMin, doctorId, roomId, serviceId, status, notes,
        moveBranch ? 1 : 0, branchId, new Date().toISOString(), existing.id);
      id = existing.id;
    } else {
      const info = db.prepare(`
        INSERT INTO visits (patient_id, doctor_id, room_id, service_id, branch_id, visit_date,
                            duration_minutes, visit_kind, visit_type, status, notes, created_by, booked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'first', 'outpatient', ?, ?, ?, ?)
      `).run(patientId, doctorId, roomId, serviceId, branchId, visitDate, durationMin, status, notes,
        user && user.id, bookedAt);
      id = Number(info.lastInsertRowid);
    }

    // ПОМЕТКА ОЖИДАНИЯ — ВТОРЫМ UPDATE, И ЭТО НАМЕРЕННО. cross_branch и
    // cross_branch_seq не перечислены ни в SHIPPED, ни в триггере
    // visits_journal_upd (миграция 100), поэтому правка ТОЛЬКО их не даёт в
    // журнале ни одной записи — а номер, который мы сюда кладём, берётся из
    // журнальной записи, которую только что сделала вставка выше. Сделай мы
    // это одним запросом — пришлось бы знать seq до того, как он появился.
    const seq = target ? journalSeqOf(db, id) : 0;
    db.prepare('UPDATE visits SET cross_branch = ?, cross_branch_seq = ? WHERE id = ?')
      .run(target ? target.letter : '', seq, id);

    return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(id), created: !existing, seq };
  });

  const out = run();
  const seq = out.seq;
  delete out.seq;
  out.emergency = !!(conflict && emergency);
  out.day = dayIso;
  if (!target) return out;

  // ─── СРОЧНАЯ ВЫГРУЗКА ───────────────────────────────────────────────────
  // Уже ПОСЛЕ транзакции: запись в базе, и что бы ни случилось с каналом, она
  // там останется. Выгрузка не бросает (publishBookingNow ловит всё сама), и
  // неудача не откатывает ничего — она НАЗЫВАЕТСЯ.
  const publishImpl = deps.publishImpl || publishBookingNow;
  let published = false;
  let publishReason = null;
  try {
    const res = await publishImpl(db, deps.dataDir || getDataDir(), {});
    published = !!(res && res.ok);
    if (!published) publishReason = (res && res.reason) || 'relay_offline';
  } catch (e) {
    publishReason = 'relay_offline';
    console.warn('[calendar] the booking could not be published to', target.letter, ':', e && e.message);
  }
  const building = networkBuildings(db).find((b) => b.letter === target.letter) || null;
  out.cross_branch = {
    letter: target.letter,
    name: building ? building.name : '',
    published,
    reason: publishReason,
    // ПОДТВЕРЖДЕНИЕ ЗДЕСЬ НЕВОЗМОЖНО В ПРИНЦИПЕ, и врать об этом нельзя:
    // sent_seq двигает квитанция соседа, а сосед ещё даже не забирал блоб.
    // Ответ всегда false; «подтверждено» появится на карточке позже, само.
    confirmed: false,
    seq,
  };
  return out;
}
