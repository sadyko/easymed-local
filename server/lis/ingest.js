// LIS_INGEST_V1 — приём: найти заказ, применить ПОДТВЕРЖДЁННОЕ сопоставление,
// записать, продвинуть статус до «Проверить и выдать».
//
// Здесь держатся решения владельца и инварианты безопасности пациента. Менять
// поведение этого файла, не поправив
// docs/specs/2026-09-10-lis-analyzer-ingest-design.md, нельзя:
//
//   Инвариант 1  машина печатает, подписывает человек — verified_* не трогаем
//   Инвариант 2  ничего не теряется — сырое сообщение сохраняется всегда
//   Инвариант 3  референсы клиники бьют референсы прибора
//   Инвариант 4  имя и единица берутся из панели, а не из провода
//   D4           применяются ТОЛЬКО подтверждённые человеком сопоставления
//   D6           значение прибора замещает набранное руками в ЧЕРНОВИКЕ
//   D7           выданный результат молча не переписывается
//   LIS_MINDRAY_CODES_V1  код бланка сравнивается с компонентом 1 или 2 поля
//                         OBX-3; в лоток — только когда бланк не заполнен
//                         (решение владельца 2026-09-28; server/lis/match.js)
import { parseMessage, mshOf } from './hl7.js';
import { recordMessage, touchDevice } from './inbox.js';
import { planObservations, outcome } from './match.js';   // LIS_MINDRAY_CODES_V1 — правило сопоставления и лотка
// CRM_REAL_BOOKING_V1 — работа над пациентом это доказательство его прихода.
import { crmServiceEvidence } from '../services/crm/visit-status.js';
// LIS_REAL_ANALYZERS_V1_SAMPLE — провод прибора: номер пробы и строки теста из
// нужных полей (wire.js); профиль называет провод.
import { readResult, pickSampleId, wireFor } from './wire.js';
import { getProfile } from './profiles/index.js';
import { today, localDate } from '../services/domain/day.js';

/**
 * LIS_REAL_ANALYZERS_V1_SAMPLE — номер пробы БЕЗ «LAB-» (голые цифры)
 * принимается, только если заказ ОТКРЫТ и создан не раньше, чем
 * BARE_ID_MAX_AGE_DAYS дней назад по местному календарному дню клиники
 * (решение владельца 2026-10-01, вопрос 3 спецификации — изменён против её
 * рекомендации «только в работе лаборатории»).
 *
 * Открытый — не выдан, не отменён и не закрыт иначе: ровно статусы очереди
 * лаборатории («Открытые» + «Не оплачено», laboratory.js; мигр. 041). queued
 * здесь обязателен: лаборатория часто не нажимает «Забор пробы», и заказ стоит
 * в queued, когда пробирка уже в анализаторе.
 *
 * От чего защищает: номер места в штативе, порядковый номер прогона,
 * автоматический номер гематологии — маленькие числа, и они совпадают со
 * старыми заказами первых дней клиники, почти всегда выданными. Окно 7 дней и
 * открытый статус отсекают и их, и выданный чужой бланк (D7 его бы не
 * переписал, но сообщение легло бы рядом с чужим пациентом в ленте).
 * Этикетка LAB- этому правилу не подчиняется: её печатает только Easy-Med.
 */
export const BARE_ID_MAX_AGE_DAYS = 7;
const OPEN_LAB_STATUSES = new Set(['added', 'queued', 'collected', 'in_progress', 'resulted']);
const STATUS_WORDS = {
  added: 'ожидает оплату', queued: 'ждёт забора пробы', collected: 'проба взята',
  in_progress: 'в работе', resulted: 'результаты внесены', completed: 'выдан',
  cancelled: 'отменён', canceled: 'отменён', refunded: 'возвращён',
};
const dmy = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? ymd.slice(8, 10) + '.' + ymd.slice(5, 7) + '.' + ymd.slice(0, 4) : 'неизвестного дня');

/**
 * null — заказ принимает голые цифры; иначе — причина отказа словами для
 * журнала лотка: закрыт и/или старше 7 дней, номер без LAB-, возможно, это
 * номер места в штативе.
 */
function bareIdRefusal(db, order, number) {
  const row = db.prepare(`SELECT ${localDate('created_at')} AS day, date(?, ?) AS cutoff FROM visit_services WHERE id = ?`)
    .get(today(db), '-' + BARE_ID_MAX_AGE_DAYS + ' days', order.id);
  const open = OPEN_LAB_STATUSES.has(order.status);
  const recent = !!(row && row.day && row.day >= row.cutoff);
  if (open && recent) return null;
  const why = [];
  if (!open) why.push('закрыт (статус «' + (STATUS_WORDS[order.status] || order.status) + '»)');
  if (!recent) why.push('создан ' + dmy(row && row.day) + ' — старше ' + BARE_ID_MAX_AGE_DAYS + ' дней');
  return 'номер пробы «' + number + '» без префикса LAB- указывает на заказ № ' + order.id + ', который '
    + why.join(' и ') + ' — возможно, это номер места в штативе прибора, а не номер пробирки; '
    + 'если проба этого заказа — нажмите «Привязать»';
}

/** Строка журнала у сообщения, прогнанного «Привязать» с номером человека. */
const MANUAL = 'привязано вручную';

/**
 * 'LAB-000123' → 123. Голые цифры принимаются: сканер может передавать
 * префикс, а может нет, и номер часто набирают руками (решение D2).
 */
export function parseSampleId(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^lab[-_ ]?/i, '');
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Флаг прибора → наш словарь. LL/HH/AA намеренно ведут в 'critical': они
 * кормят существующий счётчик критических результатов на панели отчётов.
 */
function flagFromDevice(abnormal) {
  switch (String(abnormal || '').toUpperCase()) {
    case '': case 'N': return 'normal';
    case 'L': return 'low';
    case 'H': return 'high';
    case 'LL': case 'HH': case 'AA': return 'critical';
    default: return 'abnormal';
  }
}

/** Инвариант 3: диапазон клиники бьёт диапазон прибора. null — клиника молчит. */
function flagFromClinic(num, low, high) {
  if (num == null) return null;
  if (low == null && high == null) return null;
  if (low != null && num < low) return 'low';
  if (high != null && num > high) return 'high';
  return 'normal';
}

/**
 * Принимает ОДНО сообщение и возвращает 'AA' либо 'AE' — то, что уйдёт прибору.
 *
 * 'AA' означает «принято и сохранено», а не «применено»: сообщение, не нашедшее
 * заказ, лежит в лотке и ждёт человека, и повторять его прибору незачем. 'AE'
 * отдаётся только там, где повтор ИМЕЕТ смысл: мусор на входе и сорванная
 * запись.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} raw     сырой текст сообщения
 * @param {string} peer    адрес отправителя (для лотка)
 * @param {number|null} deviceId  устройство, если удалось определить
 * @param {{touch?: boolean, sampleIdOverride?: number, wire?: string}} [opts]
 *        touch: false — не отмечать прибор «на связи» (LIS_ANALYZER_LIST_V1,
 *        ревью M4): ручная привязка из лотка прогоняет СТАРОЕ сообщение, и
 *        нажатие человека — не голос анализатора.
 *        sampleIdOverride (LIS_REAL_ANALYZERS_V1_SAMPLE) — номер заказа назвал
 *        человек («Привязать»): поля OBR не читаются, правило голых цифр не
 *        действует, сырое сообщение не подменяется, в журнале — «привязано
 *        вручную».
 *        wire — провод назван явно (иначе — по MSH-4 и профилю прибора).
 */
export function ingestMessage(db, raw, peer = '', deviceId = null, opts = {}) {
  const manual = opts.sampleIdOverride != null;
  // LIS_REAL_ANALYZERS_V1_SAMPLE — у привязанного вручную каждая строка
  // журнала говорит об этом: номер выбрал человек, а не прибор.
  const record = (o) => recordMessage(db, manual ? { ...o, detail: o.detail ? o.detail + '; ' + MANUAL : MANUAL } : o);

  try {
    parseMessage(raw);
  } catch (e) {
    record({ deviceId, peer, raw, status: 'rejected', detail: e.message });
    return 'AE';
  }

  // LIS_REAL_ANALYZERS_V1_SAMPLE — провод прибора: сообщения переадресателя
  // (MSH-4 = LabPC) — forwarder, иначе провод профиля, иначе default (прежние
  // профили и прибор без профиля читаются ровно как раньше).
  const device = deviceId ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const wire = opts.wire || wireFor({ profile: device ? getProfile(device.profile) : null, facility: mshOf(raw).facility });
  const { obr, observations } = readResult(raw, wire);

  // Номер пробы — из поля провода: LAB- в OBR-2 или OBR-3 бьёт всё, иначе
  // основное поле, иначе запасное (wire.js pickSampleId). Номер, названный
  // человеком, — как есть.
  const pick = manual
    ? { sampleId: String(opts.sampleIdOverride), value: String(opts.sampleIdOverride), lab: false, conflict: false }
    : pickSampleId(obr, wire);

  const base = { deviceId, peer, raw, sampleId: pick.sampleId };
  // LIS_ANALYZER_LIST_V1 — «на связи» на ЛЮБОМ разобранном сообщении известного
  // прибора. Раньше отметка ставилась, только когда проба ложилась в бланк:
  // прибор, чьи пробы не находили заказ, выглядел молчащим неделями («kjkj» —
  // «молчит с 10.09», а слал до 14.09). Мусор (rejected, выше) прибор не
  // отмечает: неразобранное не доказывает, что говорил анализатор.
  // Ревью M4: и повторный прогон из лотка — тоже нет (opts.touch = false).
  if (opts.touch !== false) touchDevice(db, deviceId);

  // Две РАЗНЫЕ этикетки LAB- в OBR-2 и OBR-3 — чья проба, не знает никто:
  // номера нет, бланки не трогаются, в sample_id — оба номера.
  if (pick.conflict) {
    record({ ...base, status: 'unmatched', detail: 'в OBR-2 и OBR-3 разные номера LAB-… — проверьте настройку штрихкода на приборе' });
    return 'AA';
  }

  const vsId = parseSampleId(pick.value);

  const order = vsId
    ? db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name FROM visit_services vs
                    JOIN services s ON s.id = vs.service_id
                   WHERE vs.id = ?`).get(vsId)
    : null;

  if (!order) {
    record({ ...base, status: 'unmatched', detail: 'заказ по номеру пробы не найден' });
    return 'AA';
  }
  // Голые цифры — только для открытого заказа последних 7 дней (решение
  // владельца 2026-10-01). Отказ НЕ привязывает сообщение к найденному заказу
  // (visit_service_id = NULL): скорее всего это чужой пациент, и лента не
  // должна показывать его имя рядом с пробой. Лаборант может «Привязать».
  if (!pick.lab && !manual) {
    const refusal = bareIdRefusal(db, order, pick.value);
    if (refusal) {
      record({ ...base, status: 'unmatched', detail: refusal });
      return 'AA';
    }
  }
  if (!order.is_lab) {
    record({ ...base, visitServiceId: order.id, status: 'unmatched',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не помечена как лабораторная' });
    return 'AA';
  }

  const panel = db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
  if (!panel) {
    // Название услуги здесь обязательно. У клиники бывает несколько похоже
    // названных услуг («Общий анализ крови (CBC)», «(ОАК)», «(стационар)»), и
    // безымянное «у услуги нет панели» не отвечает на единственный вопрос,
    // который человек задаёт в этот момент: у КАКОЙ именно.
    record({ ...base, visitServiceId: order.id, status: 'unmapped',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не привязана ни к одной панели' });
    return 'AA';
  }
  if (!panel.device_id) {
    record({ ...base, visitServiceId: order.id, status: 'unmapped',
      detail: 'панель «' + panel.name + '» не привязана к анализатору' });
    return 'AA';
  }
  // Панель привязана к ОДНОМУ прибору, но в лаборатории обычное дело — два
  // одинаковых анализатора, и пробирку прогоняют на том, что свободен. Поэтому
  // сверяется МОДЕЛЬ, а не строка прибора: у одинаковых моделей одни и те же
  // коды каналов, и сопоставление панели верно для обеих. Отказ по номеру
  // строки означал бы, что результат теряется в зависимости от того, какая
  // машина оказалась свободна.
  //
  // Пустой профиль совпадением НЕ считается: иначе любой неопознанный прибор
  // писал бы в любую панель.
  if (deviceId && panel.device_id !== deviceId) {
    const mine = db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(deviceId);
    const panelDev = db.prepare('SELECT profile, name FROM lab_devices WHERE id = ?').get(panel.device_id);
    const sameModel = mine && panelDev && mine.profile && mine.profile === panelDev.profile;
    if (!sameModel) {
      record({ ...base, visitServiceId: order.id, status: 'unmatched',
        detail: 'панель «' + panel.name + '» кормится анализатором другой модели'
          + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '') });
      return 'AA';
    }
  }

  // D7 — выданный бланк молча не переписывается. Проверка ДО записи: замещать
  // черновик помощь, замещать выданный отчёт пациента — другое дело.
  const released = db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(order.id).c;
  if (released > 0) {
    record({ ...base, visitServiceId: order.id, status: 'superseded',
      detail: 'результат уже выдан; новый результат требует подтверждения человеком' });
    return 'AA';
  }

  // LIS_MINDRAY_CODES_V1 — какая строка прибора ложится в какую строку бланка,
  // решает planObservations (match.js): компонент 1 ИЛИ 2 поля OBX-3 (Mindray
  // пишет «6690-2^WBC^LN»), только подтверждённые сопоставления (D4), пустое
  // значение — не значение. Порядок бланка — чтобы спор решался одинаково.
  const analytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id);
  const plan = planObservations(observations, analytes);

  let applied = 0;

  const run = db.transaction(() => {
    for (const { obs, analyte: a } of plan.fills) {
      const num = obs.valueType === 'NM' && /^-?\d+(\.\d+)?$/.test(obs.value) ? parseFloat(obs.value) : null;
      const flag = flagFromClinic(num, a.ref_low, a.ref_high) || flagFromDevice(obs.abnormal);
      // Инвариант 3 и 4: диапазон, имя и единица — из панели. Диапазон прибора
      // берётся только там, где клиника свой не задала.
      const range = a.ref_text
        || (a.ref_low != null || a.ref_high != null ? `${a.ref_low == null ? '' : a.ref_low}-${a.ref_high == null ? '' : a.ref_high}` : (obs.range || ''));

      const existing = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = ? AND parameter = ?').get(order.id, a.name);
      if (existing) {
        // D6 — машина побеждает в ЧЕРНОВИКЕ (выданное отсеяно выше).
        db.prepare(`UPDATE lab_results SET value = ?, numeric_value = ?, unit = ?, reference_range = ?,
                      ref_low = ?, ref_high = ?, flag = ?, source = 'analyzer',
                      entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE id = ?`)
          .run(obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag, existing.id);
      } else {
        db.prepare(`INSERT INTO lab_results
                      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
          .run(order.id, a.name, obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag);
      }
      applied++;
    }

    if (applied > 0 && order.status !== 'completed') {
      // Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
      // sample_collected_at не подставляем: времени забора мы не наблюдали, и
      // выдумать его значило бы записать в карту факт, которого не было.
      db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(order.id);
      // CRM_REAL_BOOKING_V1 — прибор отдал результат по пробе, которую взяли у
      // человека здесь: для заявки колл-центра это доказательство прихода.
      crmServiceEvidence(db, [order.id]);
    }

    // Лоток (решение владельца 2026-09-28): проба принята, когда заполнена
    // каждая подтверждённая строка бланка; лишние строки прибора — справка.
    const { status, detail } = outcome(plan);
    record({ ...base, visitServiceId: order.id, status, detail });
  });

  try {
    run();
  } catch (e) {
    // Транзакция откатилась целиком. NAK — прибор пришлёт снова, и это здесь
    // помощник, а не помеха.
    record({ ...base, visitServiceId: order.id, status: 'rejected', detail: 'ошибка записи: ' + e.message });
    return 'AE';
  }

  return 'AA';
}
