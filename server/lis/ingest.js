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
import { recordMessage, touchDevice, SERIES_PENDING_PREFIX } from './inbox.js';   // SERIES_PENDING_PREFIX: LIS_REAL_ANALYZERS_V1_SERIES
import { planObservations, outcome } from './match.js';   // LIS_MINDRAY_CODES_V1 — правило сопоставления и лотка
import { planSeries, seriesOutcome, SERIES_WINDOW_MS } from './match.js';   // LIS_REAL_ANALYZERS_V1_SERIES — бланк по серии сообщений
// CRM_REAL_BOOKING_V1 — работа над пациентом это доказательство его прихода.
import { crmServiceEvidence } from '../services/crm/visit-status.js';
// LIS_REAL_ANALYZERS_V1_SAMPLE — провод прибора: номер пробы и строки теста из
// нужных полей (wire.js); профиль называет провод.
import { readResult, pickMessageSample, wireFor } from './wire.js';   // pickMessageSample: LIS_REAL_ANALYZERS_V1, ревью R1, п. 1
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
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 4) — возраст заказа — от ПОЗДНЕЙШЕГО из:
 * создан (created_at), записан на время (scheduled_at), день визита
 * (visits.visit_date), всё по местному календарному дню. Запись колл-центра и
 * календаря создаёт строку заранее (booking-mirror.js): строка, созданная 10
 * дней назад на СЕГОДНЯШНИЙ визит, иначе отказывалась как «старше 7 дней».
 * Пустое не в счёт (COALESCE: у max() с NULL результат NULL).
 */
function bareIdRefusal(db, order, number) {
  const row = db.prepare(`SELECT max(COALESCE(${localDate('vs.created_at')}, ''), COALESCE(${localDate('vs.scheduled_at')}, ''),
                                     COALESCE(${localDate('v.visit_date')}, '')) AS day,
                                 date(?, ?) AS cutoff
                            FROM visit_services vs LEFT JOIN visits v ON v.id = vs.visit_id
                           WHERE vs.id = ?`)
    .get(today(db), '-' + BARE_ID_MAX_AGE_DAYS + ' days', order.id);
  const open = OPEN_LAB_STATUSES.has(order.status);
  const recent = !!(row && row.day && row.day >= row.cutoff);
  if (open && recent) return null;
  const why = [];
  if (!open) why.push('закрыт (статус «' + (STATUS_WORDS[order.status] || order.status) + '»)');
  if (!recent) why.push('датирован ' + dmy(row && row.day) + ' (позднейшее из: создан, записан, визит) — старше ' + BARE_ID_MAX_AGE_DAYS + ' дней');
  return 'номер пробы «' + number + '» без префикса LAB- указывает на заказ № ' + order.id + ', который '
    + why.join(' и ') + ' — возможно, это номер места в штативе прибора, а не номер пробирки; '
    + 'если проба этого заказа — нажмите «Привязать»';
}

/** Строка журнала у сообщения, прогнанного «Привязать» с номером человека. */
const MANUAL = 'привязано вручную';

/**
 * Спор о номере пробы — чья проба, не знает никто: номера нет, бланки не
 * трогаются. LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 1 и 2) — и разные номера у
 * разных OBR одного сообщения, и разные этикетки в компонентах одного поля.
 */
const CONFLICT_DETAIL = {
  fields: 'в OBR-2 и OBR-3 разные номера LAB-… — проверьте настройку штрихкода на приборе',
  components: 'в одном поле OBR разные номера LAB-… — проверьте настройку штрихкода на приборе',
  obrs: 'в сообщении пробы с разными номерами — ничего не записано: значения одной пробы легли бы в бланк другой; проверьте настройку прибора',
};

// LIS_REAL_ANALYZERS_V1_SERIES — строки лотка, остановленные ДО бланка: у
// услуги нет панели или панель не привязана к анализатору (ниже в приёме). У
// них есть заказ и статус unmapped, но в бланк из них не легло ничего, и
// пересчёт по нынешней панели не должен делать вид, что легло.
const BEFORE_BLANK = /^(услуга|панель) «/;

/**
 * LIS_REAL_ANALYZERS_V1_SERIES — ранние сообщения серии заказа (раздел 3
 * спецификации): с приборов той же модели (правило «та же модель» ниже), по
 * этому заказу, за SERIES_WINDOW_MS, вида «результат», applied или unmapped, и
 * в каждом легло хотя бы одно значение. Серия пересчитывается из сырых
 * сообщений тем же проводом (инвариант 2: сырое лежит целиком) — новых колонок
 * и состояния в памяти не нужно. Строки, которых коснулся человек, в серию
 * входят (их значения в бланке), но серия их не переводит.
 * @returns {Array<{id:number, status:string, detail:string, resolved_at:string|null, observations:object[]}>}
 */
function seriesMembers(db, { orderId, profileKey, profile, analytes }) {
  const rows = db.prepare(`SELECT m.id, m.raw, m.status, m.detail, m.resolved_at
                             FROM lab_device_messages m
                             JOIN lab_devices d ON d.id = m.device_id
                            WHERE m.visit_service_id = ? AND m.kind = 'result'
                              AND m.status IN ('applied', 'unmapped')
                              AND d.profile = ?
                              AND m.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
                            ORDER BY m.id`)
    .all(orderId, profileKey, '-' + Math.round(SERIES_WINDOW_MS / 1000) + ' seconds');
  const out = [];
  for (const r of rows) {
    if (BEFORE_BLANK.test(String(r.detail || ''))) continue;
    const head = mshOf(r.raw);
    const { observations } = readResult(r.raw, wireFor({ profile, facility: head.facility, app: head.app }));
    if (!planObservations(observations, analytes).fills.length) continue;
    out.push({ id: r.id, status: r.status, detail: r.detail || '', resolved_at: r.resolved_at, observations });
  }
  return out;
}

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
  const profile = device ? getProfile(device.profile) : null;
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — и по тому, как сообщение называет
  // себя (MSH-3/4): BS-200 на строке без профиля или с чужим профилем не
  // читает OBR-3; при споре профиля и сообщения — безопасный провод.
  const head = mshOf(raw);
  const wire = opts.wire || wireFor({ profile, facility: head.facility, app: head.app });
  const { obrs, observations } = readResult(raw, wire);

  // Номер пробы — из поля провода: LAB- в OBR-2 или OBR-3 бьёт всё, иначе
  // основное поле, иначе запасное (wire.js pickSampleId). Номер, названный
  // человеком, — как есть.
  // LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 1, 2, 5) — у КАЖДОГО OBR и во всех
  // компонентах поля; разные номера у разных OBR — номера нет; первый непустой.
  const pick = manual
    ? { sampleId: String(opts.sampleIdOverride), value: String(opts.sampleIdOverride), lab: false, conflict: false }
    : pickMessageSample(obrs, wire);

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
    record({ ...base, status: 'unmatched', detail: CONFLICT_DETAIL[pick.why] || CONFLICT_DETAIL.fields });
    return 'AA';
  }
  // LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 2 и 8) — в поле номера не этикетка
  // Easy-Med и не голые цифры («2^15», «QC1», «lab_2», «LAB-123»): номера нет.
  // Раньше «LAB2», «lab 2», «LAB-123» сходили за этикетку и обходили правило
  // голых цифр, а у «2^15» читался компонент 1.
  if (pick.foreign) {
    record({ ...base, status: 'unmatched', detail: 'номер пробы «' + pick.sampleId + '» — не этикетка Easy-Med и не номер из одних цифр'
      + ' (этикетка — «LAB-» и не меньше 6 цифр) — проверьте настройку штрихкода на приборе; если проба вашего заказа — нажмите «Привязать»' });
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
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 3) — голый номер прибора (не этикетка
  // и не номер человека), отказанный дальше по приёму, заказ НЕ привязывает
  // (visit_service_id = NULL): иначе лента показала бы имя чужого пациента
  // рядом с пробой, а касса не смогла бы снять его неоплаченную строку
  // (billing.js assertNotPerformed, visit-lines.js). Этикетка LAB- и номер
  // человека привязывают, как прежде. D7 ниже — как прежде.
  const linkId = pick.lab || manual ? order.id : null;
  if (!order.is_lab) {
    record({ ...base, visitServiceId: linkId, status: 'unmatched',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не помечена как лабораторная' });
    return 'AA';
  }

  const panel = db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
  if (!panel) {
    // Название услуги здесь обязательно. У клиники бывает несколько похоже
    // названных услуг («Общий анализ крови (CBC)», «(ОАК)», «(стационар)»), и
    // безымянное «у услуги нет панели» не отвечает на единственный вопрос,
    // который человек задаёт в этот момент: у КАКОЙ именно.
    record({ ...base, visitServiceId: linkId, status: 'unmapped',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не привязана ни к одной панели' });
    return 'AA';
  }
  if (!panel.device_id) {
    record({ ...base, visitServiceId: linkId, status: 'unmapped',
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
      record({ ...base, visitServiceId: linkId, status: 'unmatched',
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
    let { status, detail } = outcome(plan);

    // LIS_REAL_ANALYZERS_V1_SERIES — прибор шлёт по тесту в сообщении (профиль
    // oneTestPerMessage: BS-200, A1000): «бланк заполнен» судится по серии
    // сообщений этого заказа (match.js planSeries), а не по одному. То же
    // правило владельца: в лоток — если подтверждённой строки нет (пока
    // серия идёт — с отметкой «ждём»), если пришло значение для
    // неподтверждённой строки или второе, другое значение той же строки.
    // Сообщение, из которого в бланк не легло ничего, — правило одного
    // сообщения, как прежде, и в серию оно не входит.
    let accepted = [];
    if (profile && profile.oneTestPerMessage && plan.fills.length > 0) {
      const earlier = seriesMembers(db, { orderId: order.id, profileKey: device.profile, profile, analytes });
      // Серия верит бланку: строка, которую пересчёт «заполнил», но которой
      // в бланке нет (по D4 не легла), — не заполнена.
      const written = new Set(db.prepare(`SELECT parameter FROM lab_results
                                           WHERE visit_service_id = ? AND source = 'analyzer' AND TRIM(COALESCE(value, '')) <> ''`)
        .all(order.id).map((r) => r.parameter));
      const series = seriesOutcome(planSeries([...earlier.map((m) => m.observations), observations], analytes, { written }));
      status = series.status;
      detail = series.pending ? SERIES_PENDING_PREFIX + series.detail : series.detail;
      // Дошла серия — её ранние строки «ждём» становятся applied в этой же
      // транзакции. Строки, которых коснулся человек («Привязать», «Отклонить»
      // ставят resolved_at), не трогаются. Сырое не трогается никогда.
      if (status === 'applied') {
        accepted = earlier.filter((m) => m.status === 'unmapped' && !m.resolved_at && m.detail.startsWith(SERIES_PENDING_PREFIX));
      }
    }

    const id = record({ ...base, visitServiceId: order.id, status, detail });
    for (const m of accepted) {
      db.prepare("UPDATE lab_device_messages SET status = 'applied', detail = ? WHERE id = ? AND status = 'unmapped' AND resolved_at IS NULL")
        .run('принято серией (сообщение № ' + id + ')' + (m.detail.endsWith(MANUAL) ? '; ' + MANUAL : ''), m.id);
    }
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
