// DIET_TABLES_V1 — лечебные столы: сервер.
//
// Пять RPC: справочник, назначение стола с историей, сама история, отметка
// приёма пищи и ПОРЦИОННИК — заказ на кухню на дату.
//
// ─── ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ ───────────────────────────────────────────────
//
// Своих правил маршрута. «Пациент дошёл до лечения» и «пациент лежит в койке»
// спрашиваются у rpc/inpatient-flow.js (assertAdmissionAtLeast, IN_BED_STATUSES)
// — там же, где их спрашивают соседние задачи. Второй экземпляр этих правил
// разошёлся бы с первым, и разошёлся бы молча: экран продолжал бы показывать
// стол выписанному пациенту, а кухня — варить на него порцию.
//
// Денег. Питание в этой системе не начисляется отдельно: оно входит в
// койко-день (wards.price_per_day, rpc/accommodation.js). Ни одной строки в
// invoices этот файл не пишет.
//
// ─── ОДНО ОТЛИЧИЕ ОТ РЕФЕРЕНСА, РАДИ КОТОРОГО ВСЁ ОСТАЛЬНОЕ ─────────────────
//
// В референсе смена стола ПРАВИТ СТРОКУ пациента и подписывает правку ЛЕЧАЩИМ
// ВРАЧОМ — кто бы её ни сделал. Неверны обе половины:
//   • правка на месте стирает предыдущий период, а «с какого дня пациент на
//     девятом столе» — ровно тот вопрос, ради которого стол вообще записывают;
//   • подпись лечащего врача под решением дежурной старшей медсестры — это
//     подделка записи в истории болезни, пусть и не намеренная.
// Здесь: старый период закрывается (ended_at), новый открывается, и автором
// пишется id ТОГО, КТО НАЖАЛ.

import { RpcError, loadAdmission, assertAdmissionAtLeast, IN_BED_STATUSES } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { today, localDate } from '../domain/day.js';

export { RpcError };

// ─── Роли (матрица плана, раздел «Роли») ────────────────────────────────────
//
//   Сменить стол        — врач, главный врач, СТАРШАЯ медсестра, admin;
//   отметить приём пищи — медсестра, старшая медсестра, admin.
//
// Обычная медсестра стол НЕ МЕНЯЕТ, а старшая — меняет: стол это назначение,
// но ночью и в выходной его переводят на «ноль перед операцией» без врача, и
// отделение, которому это запрещено, просто перестанет писать правду.
//
// Врач здесь БЕЗ оговорки «свой пациент» — в отличие от листа назначений
// (assertCanPrescribe). Так в матрице плана, и так правильно: стол отменяют
// перед экстренной операцией, и хирург, впервые увидевший пациента, обязан
// сделать это не разыскивая лечащего врача.
const SET_ROLES = ['doctor', 'head_doctor', 'senior_nurse', 'admin'];
const MARK_ROLES = ['nurse', 'senior_nurse', 'admin'];
// Читают те же, кто ведёт пациента в отделении (тот же список, что READ_ROLES
// в rpc/treatment-orders.js). Касса и склад — нет: стол это история болезни.
const READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

// Приёмы пищи — латинскими кодами (миграция 094), подписи даёт словарь i18n.
// Порядок = порядок дня, он же порядок колонок в листе питания.
export const MEAL_KEYS = ['breakfast', 'breakfast2', 'lunch', 'tea', 'dinner', 'night'];
export const MEAL_STATUSES = ['waiting', 'served', 'eaten', 'partial', 'refused', 'npo', 'missed'];

// Какие приёмы пищи входят в N-разовое питание. Не «первые N из списка»:
// 2-й завтрак добавляют пятым, а не вторым — сначала появляется полдник.
// Таблица явная, потому что порядок добавления — факт диетологии, а не
// свойство массива.
const MEALS_BY_FREQUENCY = Object.freeze({
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'tea', 'dinner'],
  5: ['breakfast', 'breakfast2', 'lunch', 'tea', 'dinner'],
  6: ['breakfast', 'breakfast2', 'lunch', 'tea', 'dinner', 'night'],
});
export const MEAL_FREQUENCIES = [3, 4, 5, 6];

/** Приёмы пищи N-разового питания; неизвестное N — как 4-разовое. */
export function mealsForFrequency(n) {
  return MEALS_BY_FREQUENCY[Number(n)] || MEALS_BY_FREQUENCY[4];
}

// ─── Мелочи ─────────────────────────────────────────────────────────────────

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError(`${what} — недоступно вашей роли.`, 403);
  }
}

// Время в том же виде, в каком его пишут DEFAULT'ы всех таблиц (UTC).
function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function str(v, max, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim().slice(0, max);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата 'ГГГГ-ММ-ДД' или сегодняшний день клиники (domain/day.js). */
function dayOrToday(db, v) {
  const s = str(v, 10);
  if (!s) return today(db);
  if (!DATE_RE.test(s)) throw new RpcError('Дата должна быть в виде ГГГГ-ММ-ДД.', 400);
  return s;
}

function posIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Действующий стол госпитализации — строка с ended_at IS NULL, или null. */
function currentDietRow(db, admissionId) {
  return db.prepare(
    'SELECT * FROM admission_diets WHERE admission_id = ? AND ended_at IS NULL',
  ).get(admissionId) || null;
}

// ─── 1. Справочник столов ───────────────────────────────────────────────────

/**
 * Столы Певзнера плюс всё, что клиника завела сама.
 *
 * По умолчанию — только действующие: погашенный стол остаётся в базе ради
 * истории уже пролеченных пациентов, но предлагать его к назначению нельзя.
 * include_inactive нужен экрану настройки справочника.
 */
export function dietTablesList(db, args, user) {
  requireRole(user, READ_ROLES, 'Справочник столов');
  const all = !!(args && args.include_inactive);
  const rows = db.prepare(`
    SELECT id, code, name, indication, active, sort_order
      FROM diet_tables
     ${all ? '' : 'WHERE active = 1'}
     ORDER BY sort_order, id
  `).all();
  return { diets: rows };
}

// ─── 2. Назначить стол ──────────────────────────────────────────────────────

/**
 * Сменить стол: закрыть действующий период и открыть новый.
 *
 * Первая строка — охранник маршрута: до 'active' стола не назначают. Это не
 * формальность — до первичного осмотра никто не знает, чем пациента можно
 * кормить, а порционник, посчитавший порцию неосмотренному, отправит на кухню
 * заказ, за которым никто не стоит.
 *
 * @returns {{diet: object, previous: object|null, changed: boolean}}
 */
export function admissionDietSet(db, args, user) {
  const a = args || {};
  requireRole(user, SET_ROLES, 'Назначение стола');
  const adm = assertAdmissionAtLeast(db, a.admission_id, 'active');

  const code = str(a.diet_code, 20);
  if (!code) throw new RpcError('Выберите стол.', 400);
  const table = db.prepare('SELECT code, active FROM diet_tables WHERE code = ?').get(code);
  if (!table) throw new RpcError(`Стол не найден: ${code}.`, 400);
  if (!table.active) throw new RpcError('Этот стол выведен из справочника — выберите действующий.', 400);

  const prev = currentDietRow(db, adm.id);

  // Разовость: сказали — берём сказанное, промолчали — сохраняем ту, что уже
  // назначена этому пациенту. Молчание при смене стола означает «стол другой,
  // кормим как кормили», и сбрасывать её к умолчанию значило бы тихо снять
  // шестиразовое питание у истощённого пациента при переводе на другой стол.
  let meals = prev ? prev.meals_per_day : 4;
  if (a.meals_per_day !== undefined && a.meals_per_day !== null && a.meals_per_day !== '') {
    meals = Number(a.meals_per_day);
    if (!MEAL_FREQUENCIES.includes(meals)) {
      throw new RpcError('Питание бывает 3-, 4-, 5- или 6-разовым.', 400);
    }
  }

  const note = str(a.note, 300);

  // Повтор без изменений — НЕ новый период. Двойное нажатие на общем планшете
  // отделения иначе оставляло бы в истории период нулевой длины, и «стол
  // меняли дважды за минуту» читалось бы как решение врача, которого не было.
  if (prev && prev.diet_code === code && prev.meals_per_day === meals && prev.note === note) {
    return { diet: prev, previous: null, changed: false };
  }

  const at = nowUtc(db);
  // КТО НАЖАЛ — не лечащий врач. См. шапку файла и комментарий в миграции 094.
  const by = (user && user.id) || null;

  const insert = db.transaction(() => {
    if (prev) {
      // Закрываем предыдущий период. НЕ удаляем и не правим его стол:
      // история — это и есть смысл таблицы.
      db.prepare('UPDATE admission_diets SET ended_at = ? WHERE id = ?').run(at, prev.id);
    }
    return db.prepare(`
      INSERT INTO admission_diets (admission_id, diet_code, since, assigned_by, note, meals_per_day)
      VALUES (?,?,?,?,?,?)
    `).run(adm.id, code, at, by, note, meals).lastInsertRowid;
  });
  const id = insert();

  return {
    diet: db.prepare('SELECT * FROM admission_diets WHERE id = ?').get(id),
    previous: prev ? db.prepare('SELECT * FROM admission_diets WHERE id = ?').get(prev.id) : null,
    changed: true,
  };
}

// ─── 3. История стола ───────────────────────────────────────────────────────

/**
 * Все периоды питания этой госпитализации, новый сверху.
 *
 * Имя стола и имя автора подшиваются здесь, а не подбираются экраном: строка
 * истории обязана читаться и через год, когда стол переименовали, а сотрудник
 * уволился.
 */
export function admissionDietHistory(db, args, user) {
  requireRole(user, READ_ROLES, 'История стола');
  const adm = loadAdmission(db, args && args.admission_id);
  const rows = db.prepare(`
    SELECT d.id, d.admission_id, d.diet_code, d.since, d.ended_at, d.assigned_by,
           d.note, d.meals_per_day, d.created_at,
           t.name AS diet_name, t.indication AS diet_indication,
           u.full_name AS assigned_by_name
      FROM admission_diets d
      LEFT JOIN diet_tables t ON t.code = d.diet_code
      LEFT JOIN users u ON u.id = d.assigned_by
     WHERE d.admission_id = ?
     ORDER BY d.since DESC, d.id DESC
  `).all(adm.id);
  return {
    admission_id: adm.id,
    current: rows.find((r) => r.ended_at === null) || null,
    history: rows,
  };
}

// ─── 4. Отметка приёма пищи ─────────────────────────────────────────────────

/**
 * Отметить приём пищи. ИДЕМПОТЕНТНО по (госпитализация, дата, приём): повтор
 * перезаписывает свою строку, а не заводит вторую (UNIQUE в миграции 094 +
 * UPSERT здесь). Кнопку жмут на общем планшете в коридоре, и второе нажатие —
 * норма жизни отделения, а не ошибка оператора.
 *
 * Требуется, чтобы пациент БЫЛ В КОЙКЕ, а не дошёл до 'active': кормят с
 * первого часа после размещения, задолго до первичного осмотра. Единственное,
 * чего быть не может, — накормить выписанного или ещё не поступившего.
 */
export function admissionMealMark(db, args, user) {
  const a = args || {};
  requireRole(user, MARK_ROLES, 'Отметка приёма пищи');
  const adm = loadAdmission(db, a.admission_id);
  if (!IN_BED_STATUSES.includes(adm.status)) {
    throw new RpcError('Отмечать питание можно только пациенту, который лежит в отделении.', 400);
  }

  const date = dayOrToday(db, a.meal_date);
  const key = str(a.meal_key, 20);
  if (!MEAL_KEYS.includes(key)) throw new RpcError(`Неизвестный приём пищи: ${key}.`, 400);
  const status = str(a.status, 20);
  if (!MEAL_STATUSES.includes(status)) throw new RpcError(`Неизвестная отметка питания: ${status}.`, 400);
  const note = str(a.note, 300);

  db.prepare(`
    INSERT INTO admission_meals (admission_id, meal_date, meal_key, status, marked_by, marked_at, note)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (admission_id, meal_date, meal_key) DO UPDATE SET
      status = excluded.status,
      marked_by = excluded.marked_by,
      marked_at = excluded.marked_at,
      note = excluded.note
  `).run(adm.id, date, key, status, (user && user.id) || null, nowUtc(db), note);

  return {
    meal: db.prepare(
      'SELECT * FROM admission_meals WHERE admission_id = ? AND meal_date = ? AND meal_key = ?',
    ).get(adm.id, date, key),
  };
}

/** Отметки питания одной госпитализации за день — лист питания медсестры. */
export function admissionMealsList(db, args, user) {
  requireRole(user, READ_ROLES, 'Лист питания');
  const adm = loadAdmission(db, args && args.admission_id);
  const date = dayOrToday(db, args && args.meal_date);
  const diet = currentDietRow(db, adm.id);
  const rows = db.prepare(
    'SELECT * FROM admission_meals WHERE admission_id = ? AND meal_date = ? ORDER BY id',
  ).all(adm.id, date);
  const byKey = new Map(rows.map((r) => [r.meal_key, r]));
  return {
    admission_id: adm.id,
    meal_date: date,
    diet_code: diet ? diet.diet_code : null,
    meals_per_day: diet ? diet.meals_per_day : null,
    // План дня — приёмы, положенные по разовости; отметка, если она есть.
    meals: mealsForFrequency(diet ? diet.meals_per_day : 4)
      .map((key) => ({ meal_key: key, mark: byKey.get(key) || null })),
  };
}

// ─── 5. Порционник ──────────────────────────────────────────────────────────

/**
 * ПОРЦИОННИК — заказ на кухню на дату: кто где лежит и на каком столе, плюс
 * итог по столам («Стол №5 — 12 порций»).
 *
 * Кого считаем: КАЖДУЮ госпитализацию В КОЙКЕ (IN_BED_STATUSES из
 * shared/admission-status.js — тот же список, каким доска коек решает, занята
 * ли койка). Выписанный и отменённый в него не входят, и это половина смысла
 * документа: порция, сваренная выписанному, — это и деньги, и строка «пациент
 * получал питание после выписки» в проверке.
 *
 * Какой стол показываем: действовавший НА ЭТУ ДАТУ, а не «последний вообще».
 * Берётся последний период, начавшийся не позже этой даты и не закрытый раньше
 * неё. Пациент без назначенного стола из документа НЕ выпадает — он попадает в
 * отдельную строку итога: кухня всё равно обязана его накормить, и «стол не
 * назначен» в порционнике — сигнал отделению, а не пустое место.
 */
export function kitchenSheet(db, args, user) {
  requireRole(user, READ_ROLES, 'Порционник');
  const a = args || {};
  const date = dayOrToday(db, a.date);
  const wardId = posIntOrNull(a.ward_id);

  // Два '?' в подзапросе про дату идут ПЕРВЫМИ — порядок параметров в
  // better-sqlite3 позиционный, а подзапрос стоит в JOIN, то есть до WHERE.
  const params = [date, date, ...IN_BED_STATUSES];
  let where = `a.status IN (${IN_BED_STATUSES.map(() => '?').join(',')})`;
  if (wardId !== null) { where += ' AND a.ward_id = ?'; params.push(wardId); }

  const rows = db.prepare(`
    SELECT a.id AS admission_id, a.status,
           p.id AS patient_id, p.full_name AS patient_name,
           w.id AS ward_id, w.name AS ward_name,
           b.id AS bed_id, b.code AS bed_code,
           d.diet_code, d.meals_per_day, d.since AS diet_since, d.note AS diet_note,
           t.name AS diet_name, t.sort_order AS diet_sort
      FROM admissions a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds  b ON b.id = a.bed_id
      LEFT JOIN admission_diets d ON d.id = (
            SELECT d2.id FROM admission_diets d2
             WHERE d2.admission_id = a.id
               AND ${localDate('d2.since')} <= ?
               AND (d2.ended_at IS NULL OR ${localDate('d2.ended_at')} >= ?)
             ORDER BY d2.since DESC, d2.id DESC
             LIMIT 1)
      LEFT JOIN diet_tables t ON t.code = d.diet_code
     WHERE ${where}
     ORDER BY w.name IS NULL, w.name, b.code, p.full_name
  `).all(...params);

  // Итог по столам. Порядок — справочника (sort_order), а не алфавита: кухня
  // читает его тем же порядком, каким столы пронумерованы, а «не назначен»
  // стоит последним, потому что это не стол, а недоделка отделения.
  const buckets = new Map();
  for (const r of rows) {
    const code = r.diet_code || null;
    const k = code === null ? ' ' : code;
    if (!buckets.has(k)) {
      buckets.set(k, {
        diet_code: code,
        diet_name: r.diet_name || null,
        sort_order: code === null ? Number.MAX_SAFE_INTEGER : (r.diet_sort == null ? 0 : r.diet_sort),
        portions: 0,
      });
    }
    buckets.get(k).portions++;
  }
  const totals = [...buckets.values()]
    .sort((x, y) => x.sort_order - y.sort_order || String(x.diet_code).localeCompare(String(y.diet_code)))
    .map(({ diet_code, diet_name, portions }) => ({ diet_code, diet_name, portions }));

  return {
    date,
    ward_id: wardId,
    // Порций столько же, сколько лежащих пациентов: кормят всех, включая тех,
    // кому стол ещё не назначили.
    total_portions: rows.length,
    totals,
    rows,
  };
}
