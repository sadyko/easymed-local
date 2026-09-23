// SERVICE_EDITOR_V1 — service_save: услуга + комбобоксы + исполнители ОДНОЙ
// транзакцией. Дизайн: docs/plans/2026-08-31-service-editor-design.md.
//
// Опубликованная система сохраняла услугу и просила «откройте её снова», чтобы
// отметить исполнителей, — обход её бэкенда, а не фича. Здесь один диалог и
// одно сохранение, и потому один инвариант важнее всех остальных: ЧАСТИЧНОЕ
// СОХРАНЕНИЕ НЕВОЗМОЖНО. Услуга без своих исполнителей после падения — это
// возрождение того самого бага; всё, что пишет этот RPC (новые строки
// справочников, сама услуга, записи в users.service_rates), живёт и умирает
// в одной db.transaction.
//
// Правила, которые здесь НЕ придумываются, а импортируются/повторяются:
//   • «то же имя» комбобокса — normName из service-editor-logic.js (клиент
//     подсказывает тем же правилом; двойник не рождается ни на одной стороне);
//   • слияние users.service_rates — mergeServiceRates оттуда же: трогает
//     ТОЛЬКО запись этой услуги, хранит форму DOC_RATE_JSON_V1
//     (service_id, pct, branches — то, что читает reports.js и принимает
//     parseRates в routes/users.js);
//   • право на запись — hasAnyRole(user, ['admin']), НЕ user.role === 'admin':
//     админ-врач держит primary-роль doctor (ADMIN_DOCTOR_V1, дважды уже
//     стреляло).
import { hasAnyRole } from '../roles.js';
import {
  SERVICE_SECTIONS, labBlockVisible, normName, mergeServiceRates,
  performerGate, ratesArray, tierStepsProblem,
} from '../../../public/js/admin/service-editor-logic.js';

export class RpcError extends Error {
  // extra.code / extra.params — машинная личность ошибки для ошибок с
  // ДИНАМИКОЙ (имя, id, таблица): склеенную фразу словарь не переведёт
  // никогда (tr() ищет строку целиком), поэтому экран переводит ШАБЛОН по
  // коду и подставляет params после перевода (rpcErrorTemplate в
  // service-editor-logic.js). Русская фраза остаётся в message — для логов
  // и старых клиентов. routes/rpc.js пропускает оба поля в JSON.
  constructor(msg, status = 400, extra = null) {
    super(msg);
    this.status = status;
    if (extra && extra.code) this.code = extra.code;
    if (extra && extra.params) this.params = extra.params;
  }
}

const KNOWN_TYPES = new Set(SERVICE_SECTIONS.map((s) => s.type));

// Колонки лабораторного блока — единственные, чья запись зависит от раздела.
// Скрытое поле не затирается (тот же прецедент, что visibleWhen у tube_color
// в sections.js): услуга, временно уведённая из лаборатории, при возврате
// находит свои референсы на месте.
const LAB_COLS = ['specimen', 'result_unit', 'ref_low', 'ref_high', 'ref_text', 'tube_color'];

// Комбобоксы: таблица + человеческое имя для сообщений об ошибке.
const REF_TABLES = {
  type_ref:       { table: 'service_types',      col: 'type_id' },
  category_ref:   { table: 'service_categories', col: 'category_id' },
  department_ref: { table: 'departments',        col: 'department_id' },
};

const asBool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;

const clampPct = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
};

/**
 * Разрешить значение комбобокса ВНУТРИ транзакции: {id} проверяется на
 * существование, {name} сначала ищется по normName (включая неактивные строки —
 * совпадение с отключённой строкой это ВЫБОР её, а не повод для двойника),
 * и только не найдясь — создаётся.
 *
 * Сравнение идёт в JS, не через SQL LOWER(): SQLite не складывает регистр
 * кириллицы, и «Терапия»/«терапия» для него — разные строки. Таблицы
 * справочников — десятки строк, полное чтение дешевле правильной collation.
 */
function resolveRefTx(db, table, ref) {
  if (ref == null) return { id: null, created: false };
  if (ref.id != null) {
    const row = db.prepare(`SELECT id FROM "${table}" WHERE id = ?`).get(Number(ref.id));
    if (!row) {
      throw new RpcError(`Справочник ${table}: строка ${ref.id} не найдена.`, 400,
        { code: 'ref_row_missing', params: { table, id: Number(ref.id) } });
    }
    return { id: row.id, created: false };
  }
  const name = String(ref.name ?? '').trim();
  if (!name) return { id: null, created: false };
  const rows = db.prepare(`SELECT id, name FROM "${table}"`).all();
  const hit = rows.find((r) => normName(r.name) === normName(name));
  if (hit) return { id: hit.id, created: false };
  const id = Number(db.prepare(`INSERT INTO "${table}" (name) VALUES (?)`).run(name).lastInsertRowid);
  return { id, created: true };
}

/**
 * service_save — создать или обновить услугу целиком, как её видит диалог.
 * args: { id?, name, type, price, tax_rate?, duration_minutes?, requires_doctor?,
 *         default_doctor_percent?, room_id?, code?, active?,
 *         doctor_tier_from?, doctor_tier_percent?  (DOCTOR_TIER_V1 — pair: both or neither)
 *         doctor_tier_from_2?, doctor_tier_percent_2?, doctor_tier_from_3?, doctor_tier_percent_3?
 *           (DOCTOR_TIER_V2 — each a pair, filled in order, thresholds strictly ascending)
 *         price_secondary?, secondary_days_from?, secondary_days_to?, price_repeat?  (VISIT_TIER_PRICING_V1, all nullable)
 *         repeat_days_from?, repeat_days_to?  (REPEAT_WINDOW_V1, nullable — empty = the second-visit window)
 *         name_uz?, name_en?, online_booking?  (SERVICE_NAMES_ONLINE_V1 — online needs name AND name_uz)
 *         type_ref?/category_ref?/department_ref?: {id}|{name}|null,
 *         lab?: {specimen, result_unit, ref_low, ref_high, ref_text, tube_color},
 *         performers?: [userId] }
 * -> { id, created, refs: {type_id, category_id, department_id}, created_refs }
 */
export function serviceSave(db, args, user) {
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Сохранять услуги может только администратор клиники.', 403);
  }
  const a = args || {};

  // --- валидация ДО транзакции: отказ не должен ничего успеть создать ------
  const name = String(a.name ?? '').trim();
  if (!name) throw new RpcError('Укажите название услуги.', 400);
  // SERVICE_NAMES_ONLINE_V1 — названия на узбекском и английском; флаг
  // онлайн-записи — только параметр, но включить его можно лишь с названиями
  // на русском и узбекском (владелец: «do not save active unless users writes
  // the language versions»). Английское — по желанию.
  const nameUz = String(a.name_uz ?? '').trim() || null;
  const nameEn = String(a.name_en ?? '').trim() || null;
  const onlineBooking = asBool(a.online_booking) ? 1 : 0;
  if (onlineBooking && !nameUz) {
    throw new RpcError('Для онлайн-записи заполните название на русском и узбекском.', 400);
  }

  const type = String(a.type ?? '');
  if (!KNOWN_TYPES.has(type)) throw new RpcError('Неизвестный раздел услуги.', 400);

  const price = Number(a.price);
  if (a.price === undefined || a.price === null || a.price === '' || !Number.isFinite(price) || price < 0) {
    throw new RpcError('Укажите цену услуги.', 400);
  }

  const taxRate = a.tax_rate === undefined || a.tax_rate === null || a.tax_rate === '' ? 12 : Number(a.tax_rate);
  if (!Number.isFinite(taxRate) || taxRate < 0) throw new RpcError('НДС должен быть неотрицательным числом.', 400);

  const duration = a.duration_minutes === undefined || a.duration_minutes === null || a.duration_minutes === ''
    ? 30 : Number(a.duration_minutes);
  if (!Number.isInteger(duration) || duration <= 0) throw new RpcError('Длительность — целое число минут.', 400);

  const requiresDoctor = asBool(a.requires_doctor);
  const defaultPct = clampPct(a.default_doctor_percent);

  // DOCTOR_TIER_V1 — ступень доли по объёму: порог (целое ≥ 0, 0 = нет) и
  // доля выше порога (0–100). Одно без другого — ошибка ввода, а не «половина
  // настройки»: экран не должен притворяться, что ступень есть.
  const optNum = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const tierFrom = optNum(a.doctor_tier_from);
  if (!Number.isInteger(tierFrom) || tierFrom < 0) throw new RpcError('Порог ступени — целое число услуг в месяц (0 — без ступени).', 400);
  const tierPct = optNum(a.doctor_tier_percent);
  if (!Number.isFinite(tierPct) || tierPct < 0 || tierPct > 100) throw new RpcError('Доля выше порога — от 0 до 100 %.', 400);

  // DOCTOR_TIER_V2 — ступени 2 и 3 (миграция 147): те же границы чисел, что у
  // ступени 1. Пары, порядок и растущие пороги проверяет ОДНО правило —
  // tierStepsProblem (service-editor-logic.js), его же зовут редактор и импорт.
  // Проценты расти не обязаны — клиника решает сама, здесь о них ни слова.
  const stepN = (n) => {
    const from = optNum(a['doctor_tier_from_' + n]);
    if (!Number.isInteger(from) || from < 0) throw new RpcError(`Порог ступени ${n} — целое число услуг в месяц (0 — без ступени).`, 400);
    const pct = optNum(a['doctor_tier_percent_' + n]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new RpcError(`Доля ступени ${n} — от 0 до 100 %.`, 400);
    return { from, pct };
  };
  const step2 = stepN(2);
  const step3 = stepN(3);
  const tierProblem = tierStepsProblem([{ from: tierFrom, pct: tierPct }, step2, step3]);
  if (tierProblem) throw new RpcError(tierProblem.message, 400);
  const tierCols = {
    doctor_tier_from: tierFrom, doctor_tier_percent: tierPct,   // DOCTOR_TIER_V1
    doctor_tier_from_2: step2.from, doctor_tier_percent_2: step2.pct,   // DOCTOR_TIER_V2
    doctor_tier_from_3: step3.from, doctor_tier_percent_3: step3.pct,
  };

  // VISIT_TIER_PRICING_V1 — цены по счёту визита. Все четыре поля могут быть
  // пустыми (услуга с одной ценой); заданная цена — неотрицательное число,
  // окно — целые дни, «до» не раньше «от». Окно без второй цены бессмысленно:
  // считать нечего — пусть экран не притворяется, что настроил.
  const tierNum = (v, what) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new RpcError(`${what} — неотрицательное число.`, 400);
    return n;
  };
  const tierDays = (v, what) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new RpcError(`${what} — целое число дней.`, 400);
    return n;
  };
  const priceSecondary = tierNum(a.price_secondary, 'Цена второго визита');
  const priceRepeat = tierNum(a.price_repeat, 'Цена повторного визита');
  const daysFrom = tierDays(a.secondary_days_from, '«Со дня»');
  const daysTo = tierDays(a.secondary_days_to, '«По день»');
  if (daysFrom !== null && daysTo !== null && daysTo < daysFrom) {
    throw new RpcError('Окно второго визита: «по день» не может быть раньше «со дня».', 400);
  }
  if ((daysFrom !== null || daysTo !== null) && priceSecondary === null && priceRepeat === null) {
    throw new RpcError('Укажите цену второго визита — иначе окно дней не на что применить.', 400);
  }
  // REPEAT_WINDOW_V1 — the repeat visit's own window; both empty = as the second visit.
  const repDaysFrom = tierDays(a.repeat_days_from, 'Повторный визит, «не раньше чем через»');
  const repDaysTo = tierDays(a.repeat_days_to, 'Повторный визит, «не позже чем через»');
  if (repDaysFrom !== null && repDaysTo !== null && repDaysTo < repDaysFrom) {
    throw new RpcError('Окно повторного визита: «не позже чем через» не может быть раньше «не раньше чем через».', 400);
  }
  if ((repDaysFrom !== null || repDaysTo !== null) && priceSecondary === null && priceRepeat === null) {
    throw new RpcError('Укажите цену повторного визита — иначе окно дней не на что применить.', 400);
  }
  const active = a.active === undefined ? 1 : asBool(a.active);
  const code = a.code == null || String(a.code).trim() === '' ? null : String(a.code).trim();

  const performers = Array.isArray(a.performers) ? [...new Set(a.performers.map(Number))] : [];
  if (!performers.every((p) => Number.isInteger(p) && p > 0)) {
    throw new RpcError('Список исполнителей повреждён.', 400);
  }
  const gate = performerGate(!!requiresDoctor, performers.length);
  if (!gate.ok) throw new RpcError(gate.error, 400);

  let roomId = null;
  if (a.room_id !== undefined && a.room_id !== null && a.room_id !== '') {
    roomId = Number(a.room_id);
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) throw new RpcError('Кабинет не найден.', 400);
  }

  const editId = a.id === undefined || a.id === null ? null : Number(a.id);
  if (editId !== null && (!Number.isInteger(editId) || editId === 0)) {
    throw new RpcError('Некорректный id услуги.', 400);
  }
  if (editId !== null && !db.prepare('SELECT id FROM services WHERE id = ?').get(editId)) {
    throw new RpcError('Услуга не найдена.', 404);
  }

  // Исполнители существуют? Проверяется заранее, чтобы отказ был внятным
  // («такого сотрудника нет»), а не откатом на полдороге.
  const performerRows = performers.map((pid) => {
    const row = db.prepare('SELECT id, full_name, service_rates FROM users WHERE id = ?').get(pid);
    if (!row) throw new RpcError(`Сотрудник ${pid} не найден.`, 400, { code: 'employee_missing', params: { id: pid } });
    return row;
  });
  for (const row of performerRows) {
    if (ratesArray(row.service_rates).corrupt) {
      // Чинить чужие данные перезаписью нельзя — затёртые ставки всплывут
      // только при расчёте зарплаты. Пусть карточку сотрудника поправят руками.
      throw new RpcError(
        `У сотрудника «${row.full_name}» повреждён список ставок — откройте его карточку и сохраните её заново, затем повторите.`,
        400,
        { code: 'rates_corrupt', params: { name: row.full_name } },
      );
    }
  }

  // --- одна транзакция -----------------------------------------------------
  const run = db.transaction(() => {
    const refs = {};
    const createdRefs = {};
    for (const [key, spec] of Object.entries(REF_TABLES)) {
      const res = resolveRefTx(db, spec.table, a[key]);
      refs[spec.col] = res.id;
      createdRefs[spec.table] = res.created;
    }

    // Раздел и есть маршрутизация: is_lab следует за ним (той же связкой, что
    // миграция 022 backfill'ила type='lab' WHERE is_lab=1 — в обратную сторону).
    const isLab = labBlockVisible(type) ? 1 : 0;
    const lab = (isLab && a.lab && typeof a.lab === 'object') ? a.lab : null;

    let serviceId = editId;
    if (serviceId === null) {
      const cols = {
        name, code, price, tax_rate: taxRate, duration_minutes: duration,
        requires_doctor: requiresDoctor, active, type, is_lab: isLab,
        type_id: refs.type_id, category_id: refs.category_id, department_id: refs.department_id,
        default_doctor_percent: defaultPct, room_id: roomId,
        ...tierCols,   // DOCTOR_TIER_V1/V2 — три ступени
        price_secondary: priceSecondary, secondary_days_from: daysFrom, secondary_days_to: daysTo, price_repeat: priceRepeat,
        repeat_days_from: repDaysFrom, repeat_days_to: repDaysTo,
        name_uz: nameUz, name_en: nameEn, online_booking: onlineBooking,
        // Не-лабораторная услуга рождается с пустым лаб-блоком; лабораторная —
        // с тем, что ввели.
        specimen: lab ? (lab.specimen ?? null) : null,
        result_unit: lab ? (lab.result_unit ?? null) : null,
        ref_low: lab ? (lab.ref_low ?? null) : null,
        ref_high: lab ? (lab.ref_high ?? null) : null,
        ref_text: lab ? (lab.ref_text ?? null) : null,
        tube_color: lab ? (lab.tube_color ?? null) : null,
      };
      const names = Object.keys(cols);
      serviceId = Number(db.prepare(
        `INSERT INTO services (${names.map((c) => `"${c}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      ).run(...names.map((c) => cols[c])).lastInsertRowid);
    } else {
      const sets = {
        name, code, price, tax_rate: taxRate, duration_minutes: duration,
        requires_doctor: requiresDoctor, active, type, is_lab: isLab,
        type_id: refs.type_id, category_id: refs.category_id, department_id: refs.department_id,
        default_doctor_percent: defaultPct, room_id: roomId,
        ...tierCols,   // DOCTOR_TIER_V1/V2 — три ступени
        price_secondary: priceSecondary, secondary_days_from: daysFrom, secondary_days_to: daysTo, price_repeat: priceRepeat,
        repeat_days_from: repDaysFrom, repeat_days_to: repDaysTo,
        name_uz: nameUz, name_en: nameEn, online_booking: onlineBooking,
      };
      // Лаб-колонки пишутся ТОЛЬКО когда раздел = лаборатория. Скрытый блок
      // не затирает сохранённое (прецедент sections.js visibleWhen).
      if (lab) for (const c of LAB_COLS) sets[c] = lab[c] ?? null;
      const names = Object.keys(sets);
      db.prepare(
        `UPDATE services SET ${names.map((c) => `"${c}" = ?`).join(', ')}, `
        + "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
      ).run(...names.map((c) => sets[c]), serviceId);
    }

    // --- членство исполнителей ---------------------------------------------
    // Новые записи получают branches = все филиалы клиники — то же, чем
    // карточка сотрудника наполняет СВОЮ новую строку (buildRates seeds all).
    const branchIds = db.prepare('SELECT id FROM branches WHERE active = 1 ORDER BY id').all().map((b) => b.id);
    const ticked = new Set(performers);

    // Затронуты и те, кого отметили, и те, у кого запись уже есть (их тик
    // сняли). Полный проход по users дешевле точного поиска: это персонал,
    // не пациенты. Непустая, но нечитаемая колонка у НЕотмеченного —
    // пропускается: убрать запись оттуда, не потеряв остального, нельзя,
    // а сохранение услуги важнее чужой давно битой строки.
    for (const u of db.prepare("SELECT id, service_rates FROM users WHERE service_rates != '' OR id IN "
      + `(${performers.map(() => '?').join(', ') || 'NULL'})`).all(...performers)) {
      const merged = mergeServiceRates(u.service_rates, serviceId, ticked.has(u.id), defaultPct, branchIds);
      if (merged.corrupt || !merged.changed) continue;
      db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify(merged.rates), u.id);
    }

    return { id: serviceId, created: editId === null, refs, created_refs: createdRefs };
  });

  return run();
}
