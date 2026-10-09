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
import { REATTACHED_NOTE } from './inbox.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 2
import { planObservations, outcome } from './match.js';   // LIS_MINDRAY_CODES_V1 — правило сопоставления и лотка
import { planSeries, seriesOutcome, SERIES_WINDOW_MS } from './match.js';   // LIS_REAL_ANALYZERS_V1_SERIES — бланк по серии сообщений
import { SERIES_MAX_MESSAGES } from './match.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 9
import { sameValue, SERIES_FORM_MAX_AGE_MS } from './match.js';   // LIS_REAL_ANALYZERS_V1 — ревью R3, пп. 6 и 10
import { disputeOf, sameDispute } from './match.js';   // LIS_REAL_ANALYZERS_V1 — ревью R4, п. D
import { guessProfile } from './discover.js';   // LIS_REAL_ANALYZERS_V1 — ревью R4, п. A: модель по имени сообщения и прибора панели
// CRM_REAL_BOOKING_V1 — работа над пациентом это доказательство его прихода.
import { crmServiceEvidence } from '../services/crm/visit-status.js';
// LIS_REAL_ANALYZERS_V1_SAMPLE — провод прибора: номер пробы и строки теста из
// нужных полей (wire.js); профиль называет провод.
import { readResult, pickMessageSample, wireFor, wireDecision } from './wire.js';   // pickMessageSample: LIS_REAL_ANALYZERS_V1, ревью R1, п. 1; wireDecision: ревью R2, п. 12
import { decimalPoint } from './wire.js';   // LIS_VENDOR_EXACT_V1 (D0) — десятичная запятая на любом проводе
import { readEnvelope } from './wire.js';   // LIS_VENDOR_EXACT_V1 (п. 6) — служебное сообщение к пациенту не идёт и при прямом вызове
import { planTube, tubeOutcome, heldChangeText, resentText } from './match.js';   // LIS_VENDOR_EXACT_V1 — D3 (пробирка — услуги визита) и N1 (повтор)
import { getProfile } from './profiles/index.js';
import { PROXY_NOT_TUBE, PROXY_QUIET_PREFIX } from './lisproxy-form.js';   // LIS_PROXY_V1
import { unusedText } from './match.js';   // LIS_PROXY_V1 — справка гематологии
import { LAB_RESULT_STATUSES } from '../services/visit-status-guard.js';   // LIS_REAL_ANALYZERS_V1 — ревью R7, п. 1: ворота лаборатории, общие с ручным вводом
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
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R7, п. 1) — «ожидает оплату» (added) правило
 * голых цифр пропускает как открытый, но дальше стоят ворота лаборатории
 * (gateRefusal): голый номер неоплаченного заказа отказывается той же
 * причиной, что и этикетка, — «заказ ещё не оплачен…», без привязки.
 */
export const BARE_ID_MAX_AGE_DAYS = 7;
const OPEN_LAB_STATUSES = new Set(['added', 'queued', 'collected', 'in_progress', 'resulted']);

// ═══ LIS_VENDOR_EXACT_V1 — ПРАВИЛО ГОЛОГО НОМЕРА: ТОЛЬКО НОМЕР С ЭТИКЕТКИ ═══════
// Решение владельца 2026-10-06, п. 4 (analyzer-research\fix\DECISIONS.md): «Label
// number only». Номер пробы без «LAB-» принимается, только если это номер с
// этикетки Easy-Med так, как он напечатан под штрихкодом: одни цифры, не меньше
// PLAIN_NUMBER_MIN_DIGITS («000123» — заказ 123, lab-doc.js labAccession).
// Короче — номер самого прибора, а не заказа: номера лаборатории на A1000
// (1, 2, 3…), номер контроля («3»), номер прогона BS-240/CL-900i в OBR-3 на
// строке «Другой анализатор (общий HL7)», автоприращение гематологии с «1» —
// раньше такие ложились в открытый свежий заказ ЧУЖОГО пациента. Такая проба
// идёт в «Необработанные», человек привязывает её кнопкой «Привязать».
// Лишние нули впереди («0000000021» — свой цифровой штрихкод пробирки, приёмка
// BS-200 T6b) — тоже не так, как напечатано: Easy-Med дополняет номер нулями
// ровно до 6 цифр. Исключение — переадресатор COM (провод forwarder): старая
// гематология Mindray дополняет номер нулями до ширины своего поля (8 знаков,
// analyzers\forwarder\protocols\mindray-legacy.js).
// Остальное правило прежнее (BARE_ID_MAX_AGE_DAYS выше): заказ открыт, оплачен
// и не старше 7 дней. Этикетка LAB- этим правилом не проверяется.
// Сменить порог — здесь, одной константой. Она равна числу цифр этикетки
// (wire.js LABEL_DIGITS: им узнаются этикетка LAB- и контроль A1000) — менять
// вместе.
export const PLAIN_NUMBER_MIN_DIGITS = 6;

/**
 * LIS_VENDOR_EXACT_V1 (решение владельца 2026-10-06, п. 4) — null: голые цифры
 * пробы — номер с этикетки (дальше — правило «открытый, оплаченный, 7 дней»);
 * иначе — причина словами для «Необработанных». Не цифры — не сюда (wire.js
 * pickSampleId их уже отказал: «не этикетка Easy-Med»).
 */
function plainNumberRefusal(value, wire) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = PLAIN_NUMBER_MIN_DIGITS;
  if (s.length < n) {
    return 'номер пробы «' + s + '» короче ' + n + ' цифр — на приборе вводите номер с этикетки Easy-Med (' + n
      + ' цифр, например 000123) или сканируйте её; эту пробу привяжите кнопкой «Привязать»';
  }
  if (wire !== 'forwarder' && s !== String(parseInt(s, 10)).padStart(n, '0')) {
    return 'номер пробы «' + s + '» — не номер с этикетки Easy-Med: на этикетке номер заказа из ' + n
      + ' цифр без лишних нулей впереди (например 000123), а это, возможно, свой штрихкод пробирки — на приборе'
      + ' вводите номер с этикетки Easy-Med или сканируйте её; эту пробу привяжите кнопкой «Привязать»';
  }
  return null;
}
/** LIS_REAL_ANALYZERS_V1 (ревью R5, п. 3) — куда «Привязать» может вернуть опустевший заказ: статусы лаборатории. */
const LAB_SIDE_STATUSES = new Set(['queued', 'collected', 'in_progress']);
/** LIS_REAL_ANALYZERS_V1 (ревью R6, п. 2) — и эти — как были: отменённый и возвращённый заказ таким и остаётся. */
const KEEP_STATUSES = new Set(['cancelled', 'canceled', 'refunded']);

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R6, п. 2) — касса отпустила строку заказа в
 * очередь: ровно то, после чего она переводит строку из «ожидает оплату» в
 * «ждёт забора» (billing.js). Ревью R7, п. 2 — все три пути кассы: счёт
 * оплачен, частично или в долг (record_payment, долг); счёт ПЛАТЕЛЬЩИКУ —
 * сам он остаётся 'unpaid' (createInvoiceForVisit, V3120_FIX FATAL-2); счёт на
 * ноль (FREE_SERVICE_V1, settleZeroTotal). Аннулированный и возвращённый счёт
 * не отпускает ничего.
 */
function linePaid(db, vsId) {
  const r = db.prepare(`SELECT i.status, i.payer_id, i.total_amount FROM visit_services vs
                          JOIN invoice_items ii ON ii.id = vs.invoice_item_id
                          JOIN invoices i ON i.id = ii.invoice_id
                         WHERE vs.id = ?`).get(vsId);
  if (!r || r.status === 'void' || r.status === 'refunded') return false;
  return ['paid', 'partial', 'debt'].includes(r.status) || r.payer_id != null || Math.round((Number(r.total_amount) || 0) * 100) <= 0;
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R7, п. 1) — ворота лаборатории (INPATIENT_MONEY_FIX_V1,
 * правило владельца): прибор, как и ручной ввод (rpc/lab.js saveLabResults),
 * пишет только в заказ из LAB_RESULT_STATUSES. Остальное — в лоток, с
 * причиной словами; не пишется ничего.
 */
const GATE_DETAIL = {
  added: 'заказ ещё не оплачен — результат прибора можно «Привязать» после оплаты',
  cancelled: 'заказ отменён',
  canceled: 'заказ отменён',
  refunded: 'по заказу возврат',
};
function gateRefusal(order) {
  if (LAB_RESULT_STATUSES.includes(order.status)) return null;
  return GATE_DETAIL[order.status] || 'заказ не в работе лаборатории (статус «' + (STATUS_WORDS[order.status] || order.status) + '»)';
}
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
 * Пустое не в счёт.
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 4) — день в БУДУЩЕМ (запись на завтра,
 * визит на следующей неделе) старый заказ свежим не делает: в «позднейшее из»
 * идут только дни не позже сегодняшнего. Все три — localDate (date(…,
 * 'localtime')), ровно как читает их остальной код (queue.js: день талона —
 * localDate(COALESCE(scheduled_at, visit_date))): запись колл-центра пишет
 * scheduled_at в ISO с «Z» (booking-lines.js toISOString), время без пояса
 * читается как UTC — как везде.
 */
function bareIdRefusal(db, order, number) {
  const t = today(db);
  const row = db.prepare(`SELECT ${localDate('vs.created_at')} AS c, ${localDate('vs.scheduled_at')} AS s, ${localDate('v.visit_date')} AS v,
                                 date(?, ?) AS cutoff
                            FROM visit_services vs LEFT JOIN visits v ON v.id = vs.visit_id
                           WHERE vs.id = ?`)
    .get(t, '-' + BARE_ID_MAX_AGE_DAYS + ' days', order.id);
  if (row) row.day = [row.c, row.s, row.v].filter((d) => d && d <= t).sort().pop() || '';
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
 * LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — в сообщении значения для строк
 * панели, подтверждённых для другого прибора (или до мигр. 233): в бланк они
 * не идут; что делать. Следом — какие строки. Экран «Панели» у таких строк
 * говорит «подтверждено для другого прибора — подтвердите заново».
 */
const STALE_DETAIL = 'подтверждено для другого прибора — подтвердите заново в «Лаборатория → Панели»: ';

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

/**
 * LIS_VENDOR_EXACT_V1 (N2) — прибор найден в сети, но ещё не добавлен (added =
 * 0): его модель — догадка по имени, а по модели читаются номер пробы и значения
 * (wire.js). Пробы находки в бланки не идут — и через правило «та же модель»
 * (приёмка BC-5300 N2; проба H проверяющего гематологии: находка «BC-5300»
 * заполнила ОАК). Что делать — словами экрана.
 */
const NOT_ADDED_DETAIL = 'прибор ещё не добавлен — «Анализаторы» → «Добавить прибор» → «Найдены в сети» → «Добавить»';

/** D7 — выданный бланк молча не переписывается (текст прежний). */
const SUPERSEDED_DETAIL = 'результат уже выдан; новый результат требует подтверждения человеком';

/**
 * LIS_VENDOR_EXACT_V1 (п. 6) — служебное сообщение прибора, поданное в приём
 * мимо receive.js (там оно не доходит до приёма): та же строка, что пишет
 * receive.js, — в бланки и лоток не идёт.
 */
const SERVICE_DETAIL = {
  qc: 'контроль качества — в бланки и «Необработанные» не идёт',
  calibration: 'калибровка — в бланки и «Необработанные» не идёт',
  query: 'запрос рабочего списка — к пробам пациентов не относится',
};

/**
 * LIS_VENDOR_EXACT_V1 (D3) — другие заказы визита: открытые и оплаченные —
 * пишутся; ещё не оплаченный и уже выданный — нет (человеку сказано почему);
 * отменённые и возвращённые — не заказы этой пробирки. Сколько заказов визита
 * читать (у стационарного визита их бывает много) — SIBLINGS_MAX.
 */
const OPEN_PAID_STATUSES = new Set(['queued', 'collected', 'in_progress', 'resulted']);
const SIBLINGS_MAX = 100;

/**
 * LIS_VENDOR_EXACT_V1 (п. 5) — сколько ранних строк лотка заказа с этого прибора
 * сверять, когда сообщение заполнило бланк.
 */
const STALE_SCAN_MAX = 20;
/** LIS_VENDOR_EXACT_V1 (п. 5) — строку лотка, закрытую заполненным бланком, разбирает не человек: в журнале — чем. */
const closedNote = (orderId, msgId) => 'закрыто: бланк заказа № ' + orderId + ' заполнен сообщением № ' + msgId;

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
/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 1) — чьи сообщения — «тот же прибор» для
 * серии: у профиля с codesPerInstrument (BS-200: номер теста свой у каждого
 * прибора) — только этот прибор, у прочих — та же модель.
 */
const senderClause = (perInstrument) => (perInstrument ? 'm.device_id = ?' : 'd.profile = ?');

/**
 * LIS_REAL_ANALYZERS_V1_SERIES — ранние сообщения серии заказа (раздел 3
 * спецификации) за SERIES_WINDOW_MS: вида «результат», applied или unmapped, и
 * в каждом легло хотя бы одно значение. Серия пересчитывается из сырых
 * сообщений тем же проводом (инвариант 2: сырое лежит целиком) — новых колонок
 * и состояния в памяти не нужно. Строки, которых коснулся человек, в серию
 * входят (их значения в бланке), но серия их не переводит.
 * LIS_REAL_ANALYZERS_V1 (ревью R2) — не входят строки, перепривязанные
 * человеком к другому заказу (п. 2: их значения сняты из этого бланка); их
 * не больше SERIES_MAX_MESSAGES (п. 9): сверх — overflow, без пересчёта.
 * @returns {{members: Array<{id:number, observations:object[]}>, overflow:boolean}}
 */
function seriesMembers(db, { orderId, deviceId, perInstrument, profileKey, profile, analytes }) {
  const where = `FROM lab_device_messages m
                  JOIN lab_devices d ON d.id = m.device_id
                 WHERE m.visit_service_id = ? AND m.kind = 'result'
                   AND m.status IN ('applied', 'unmapped')
                   AND ${senderClause(perInstrument)}
                   AND instr(COALESCE(m.detail, ''), ?) = 0
                   AND m.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`;
  const args = [orderId, perInstrument ? deviceId : profileKey, REATTACHED_NOTE, '-' + Math.round(SERIES_WINDOW_MS / 1000) + ' seconds'];
  if (db.prepare('SELECT COUNT(*) AS n ' + where).get(...args).n >= SERIES_MAX_MESSAGES) return { members: [], overflow: true };
  const rows = db.prepare('SELECT m.id, m.raw, m.detail ' + where + ' ORDER BY m.id').all(...args);
  const members = [];
  for (const r of rows) {
    if (BEFORE_BLANK.test(String(r.detail || ''))) continue;
    const head = mshOf(r.raw);
    const { observations } = readResult(r.raw, wireFor({ profile, facility: head.facility, app: head.app }));
    if (!planObservations(observations, analytes).fills.length) continue;
    members.push({ id: r.id, observations });
  }
  return { members, overflow: false };
}

/** «Не раньше, чем ms назад» — для SQL, в том же виде, что received_at и entered_at. */
const sinceArg = (ms) => '-' + Math.round(ms / 1000) + ' seconds';

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 5) — строки «ждём» этого заказа (тот же
 * прибор или та же модель), которых не касался человек, — и раньше окна: бланк
 * полон — ожидание каждой кончилось.
 * Ревью R3, п. 6 — но не старше суток (SERIES_FORM_MAX_AGE_MS): строка, ждущая
 * с прошлой недели, — другой прогон; она остаётся «серия не дошла до конца».
 */
function waitingRows(db, { orderId, deviceId, perInstrument, profileKey }) {
  return db.prepare(`SELECT m.id, m.detail FROM lab_device_messages m JOIN lab_devices d ON d.id = m.device_id
                      WHERE m.visit_service_id = ? AND m.kind = 'result' AND m.status = 'unmapped' AND m.resolved_at IS NULL
                        AND substr(m.detail, 1, ?) = ? AND ${senderClause(perInstrument)}
                        AND m.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`)
    .all(orderId, SERIES_PENDING_PREFIX.length, SERIES_PENDING_PREFIX, perInstrument ? deviceId : profileKey, sinceArg(SERIES_FORM_MAX_AGE_MS));
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 6) — спор «повтор», который человек уже
 * разобрал («Отклонить», «Привязать»): тот же тест и те же два числа (в любом
 * порядке) второй раз не поднимаются.
 * Ревью R4, п. D — узнаётся по СТРУКТУРЕ спора у разобранных строк этого
 * заказа (lab_device_messages.disputes: код поля и два значения без хвостовых
 * нулей), а не по тексту журнала: текст — для человека, и подстроки в нём
 * путались («5.45» и «5.4», «12 (GLU)» и «2 (GLU)» — ревью R3, п. 5).
 */
function dismissedChange(db, orderId) {
  const seen = [];
  for (const r of db.prepare(`SELECT disputes FROM lab_device_messages
                               WHERE visit_service_id = ? AND kind = 'result' AND resolved_at IS NOT NULL
                                 AND disputes IS NOT NULL`).all(orderId)) {
    try {
      const list = JSON.parse(r.disputes);
      if (Array.isArray(list)) seen.push(...list);
    } catch { /* не JSON — не спор */ }
  }
  return (c) => seen.some((d) => sameDispute(d, disputeOf(c)));
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 2) — человек «Привязал» строку лотка к
 * ДРУГОМУ заказу (rpc/lis.js lis_message_attach). Если строка уже положила
 * значения прибора в бланк первого заказа, они оттуда снимаются — иначе одна
 * проба лежала бы в двух бланках, а серия первого заказа считала бы её своей.
 * Снимается строка бланка, только если это всё ещё значение прибора из этой
 * строки и бланк — черновик. Остаётся (и сказано, почему):
 *   — выдан (verified_at, D7 — выданное не трогает и машина);
 *   — изменено после прибора (значение другое: правил человек или переписало
 *     следующее сообщение);
 *   — то же значение пришло в этот заказ другим сообщением (оно и останется).
 * Сама строка помечается REATTACHED_NOTE и в серию первого заказа больше не
 * входит: его бланк снова неполон, и следующее сообщение это скажет. Сырое
 * сообщение не трогается (инвариант 2).
 *
 * Ревью R3: rpc/lis.js снимает, лишь когда новый заказ пробу принял (п. 7);
 * «выдан» — по заказу (п. 8); числа сравниваются без хвостовых нулей (п. 10).
 *
 * Ревью R4, п. B — снимается ровно то, что записала ЭТА строка лотка
 * (lab_results.source_message_id, ставит приём), а не пересчёт сырого
 * сообщения нынешним сопоставлением: после перепривязки панели или снятых
 * подтверждений пересчёт не находил ничего, и значение оставалось в чужом
 * бланке молча. «Изменено после прибора» — значение в бланке не то, что эта
 * строка прислала для поля показателя (сырое читается по коду показателя, без
 * оглядки на подтверждения); не найти, что прислано (показатель переименован,
 * код сменён), — «не удалось сверить с сообщением», остаётся. Строка уходит
 * с прежнего заказа (visit_service_id = NULL), только когда её значений там не осталось;
 * выданное и изменённое остаются — и строка остаётся при заказе: её след
 * держит кассу (billing.js assertNotPerformed). Значения прибора без отметки
 * строки (записаны до мигр. 233) не снимаются — чьи они, не известно; строка
 * остаётся при заказе, а человеку сказано проверить бланк (legacy).
 * П. C — опустевший бланк (ни значения, ни примечания) возвращает заказ из
 * «результаты внесены» в статус до прибора (lis_status_before), если это
 * статус лаборатории, «отменён» или «возвращён»; «ожидает оплату» — в «ждёт
 * забора пробы», если счёт строки оплачен (иначе так и остаётся «ожидает
 * оплату»: ревью R5, п. 3; R6, п. 2); неизвестен или другой — «в работе».
 * Ревью R5, п. 1 — значение, оставленное потому, что то же прислала другая
 * строка этого заказа, переходит к ней (source_message_id); R6, п. 3 — только
 * к неразобранной: сперва к принятой (applied), иначе к той, что можно
 * «Привязать»; нет такой — снимается.
 * @returns {{fromOrderId:number|null, taken:string[], kept:Array<{name:string, why:string}>,
 *            legacy:boolean, unlinked:boolean, status:string|null, statusWord:string|null}}
 *   status — куда вернулся первый заказ, если его бланк опустел; statusWord — он же словами.
 */
export function takeBackValues(db, msg, toOrderId) {
  const out = { fromOrderId: null, taken: [], kept: [], legacy: false, unlinked: false, status: null, statusWord: null, others: [] };
  const fromId = msg && msg.visit_service_id;
  if (!fromId || Number(fromId) === Number(toOrderId)) return out;
  out.fromOrderId = fromId;
  let stays = 0;   // значения ЭТОЙ строки, оставшиеся в бланке (выдано, изменено, не сверить)

  // LIS_VENDOR_EXACT_V1 (D3) — строка пробирки пишет и в другие заказы визита
  // (source_message_id): снимается отовсюду, куда она писала, по тем же
  // правилам. В журнале у их показателей — номер заказа; куда вернулся
  // опустевший другой заказ — out.others (у первого — status, как прежде).
  const orders = [fromId, ...db.prepare(`SELECT DISTINCT visit_service_id AS v FROM lab_results
                                          WHERE source_message_id = ? AND visit_service_id <> ? ORDER BY visit_service_id`)
    .all(msg.id, fromId).map((r) => r.v).filter((v) => Number(v) !== Number(toOrderId))];
  for (const oid of orders) {
    const own = Number(oid) === Number(fromId);
    const suffix = own ? '' : ' (заказ № ' + oid + ')';
    const r = takeBackFrom(db, msg, oid, fromId);
    out.taken.push(...r.taken.map((n) => n + suffix));
    out.kept.push(...r.kept.map((k) => ({ name: k.name + suffix, why: k.why })));
    stays += r.stays;
    if (own) Object.assign(out, { status: r.status, statusWord: r.statusWord });
    else if (r.status) out.others.push({ orderId: oid, status: r.status, statusWord: r.statusWord });
  }
  out.legacy = ['applied', 'unmapped'].includes(msg.status) && !BEFORE_BLANK.test(String(msg.detail || ''))
    && db.prepare("SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND source = 'analyzer' AND source_message_id IS NULL").get(fromId).c > 0;
  // Ревью R3, п. 9; R4, п. B — строка уходит с первого заказа, только когда её
  // значений там не осталось: иначе её след держал бы кассу зря («по услуге
  // уже пришли данные анализатора»), а лента показывала бы имя его пациента.
  // История — в журнале строки: куда перепривязана и откуда. Значение,
  // перешедшее к другой строке (п. 1 R5), — уже не её.
  out.unlinked = !stays && !out.legacy;
  const note = REATTACHED_NOTE + toOrderId + (out.unlinked ? ' (был заказ № ' + fromId + ')' : ' (значения остались в заказе № ' + fromId + ')');
  db.prepare(`UPDATE lab_device_messages SET visit_service_id = CASE WHEN ? THEN NULL ELSE visit_service_id END,
                detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || '; ' || ? END WHERE id = ?`)
    .run(out.unlinked ? 1 : 0, note, note, msg.id);
  return out;
}

/**
 * Одна строка лотка снимает свои значения из бланка одного заказа (oid) —
 * правила takeBackValues выше. LIS_VENDOR_EXACT_V1 (D3) — вынесено из
 * takeBackValues, чтобы тем же правилом снимать и из других заказов визита;
 * наследник «то же значение» — строка этого заказа или заказа пробирки (fromId):
 * строка пробирки лежит при заказе пробирки, а пишет и в другие.
 * @returns {{taken:string[], kept:Array<{name:string, why:string}>, stays:number, status:string|null, statusWord:string|null}}
 */
function takeBackFrom(db, msg, oid, fromId) {
  const out = { taken: [], kept: [], stays: 0, status: null, statusWord: null };
  const mine = db.prepare('SELECT * FROM lab_results WHERE visit_service_id = ? AND source_message_id = ? ORDER BY id').all(oid, msg.id);
  if (mine.length) {
    // Ревью R3, п. 8 — «выдан» — по ЗАКАЗУ, как у правила выдачи (D7 в приёме):
    // выдан хоть один показатель — бланк заказа не трогается.
    const released = db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(oid).c > 0;
    const order = db.prepare('SELECT service_id FROM visit_services WHERE id = ?').get(oid);
    const panel = order && db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
    const analytes = panel ? db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id) : [];
    let others = null;
    for (const row of mine) {
      if (released) { out.kept.push({ name: row.parameter, why: 'выдан' }); out.stays++; continue; }
      const a = analytes.find((x) => x.name === row.parameter);
      const sent = a ? deliveredValue(db, msg, a) : null;
      // Ревью R3, п. 10 — «390.10» и «390.1» — одно значение.
      if (row.source !== 'analyzer' || sent == null || !sameValue(row.value, sent)) {
        out.kept.push({ name: row.parameter, why: sent == null && row.source === 'analyzer' ? 'не удалось сверить с сообщением' : 'изменено после прибора' });
        out.stays++;
        continue;
      }
      if (!others) {
        // Ревью R6, п. 3 — только строки, которые не разобраны человеком
        // («Отклонить», «Привязать» ставят resolved_at): отклонённую строку
        // «Привязать» уже нельзя, и значение, перешедшее к ней, застряло бы.
        // LIS_VENDOR_EXACT_V1 (D3) — строки этого заказа и заказа пробирки.
        others = db.prepare(`SELECT id, raw, device_id, detail, status FROM lab_device_messages
                              WHERE visit_service_id IN (?, ?) AND id <> ? AND kind = 'result' AND status IN ('applied', 'unmapped')
                                AND resolved_at IS NULL AND instr(COALESCE(detail, ''), ?) = 0
                              ORDER BY id DESC LIMIT ?`).all(oid, fromId, msg.id, REATTACHED_NOTE, SERIES_MAX_MESSAGES)
          .filter((r) => !BEFORE_BLANK.test(String(r.detail || '')));
      }
      // Ревью R5, п. 1 — то же значение прислала другая строка, всё ещё при
      // этом заказе: значение остаётся и ПЕРЕХОДИТ к ней (source_message_id).
      // Иначе, привязав потом и её, снимать было бы нечего: у неё «своих»
      // строк нет, и значение пациента другого заказа оставалось бы здесь
      // молча. Эта строка своих значений здесь больше не держит.
      // Ревью R6, п. 3 — сперва принятая (applied) строка этого заказа: это
      // его собственная проба с тем же значением, и значение остаётся по
      // праву; иначе строка, которую ещё можно «Привязать»; нет такой —
      // значение снимается, как обычно. В журнале — номер строки.
      const same = others.filter((o) => { const v = deliveredValue(db, o, a); return v != null && sameValue(v, sent); });
      const heir = same.find((o) => o.status === 'applied') || same[0];
      if (heir) {
        db.prepare('UPDATE lab_results SET source_message_id = ? WHERE id = ?').run(heir.id, row.id);
        out.kept.push({ name: row.parameter, why: 'то же значение пришло другим сообщением — теперь за строкой № ' + heir.id });
        continue;
      }
      db.prepare('DELETE FROM lab_results WHERE id = ?').run(row.id);
      out.taken.push(row.parameter);
    }
  }

  if (out.taken.length) {
    // Примечание без значения («гемолиз») — тоже содержимое бланка (п. C).
    const left = db.prepare(`SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ?
                               AND (TRIM(COALESCE(value, '')) <> '' OR TRIM(COALESCE(notes, '')) <> '')`).get(oid).c;
    const ord = db.prepare('SELECT status, lis_status_before FROM visit_services WHERE id = ?').get(oid);
    if (!left && ord && ord.status === 'resulted') {
      // Ревью R5, п. 3; R6, п. 2 — статусы лаборатории, «отменён» и
      // «возвращён» — как были. «Ожидает оплату» до прибора после оплаты
      // устарел (касса строку «результаты внесены» не трогает: billing.js) —
      // счёт строки оплачен, частично или в долг: «ждёт забора пробы»; иначе
      // снова «ожидает оплату»: «ждёт забора» открыл бы кассу — результат
      // неоплаченного анализа (rpc/lab.js saveLabResults). Неизвестен или
      // другой — «в работе».
      const was = ord.lis_status_before;
      if (LAB_SIDE_STATUSES.has(was) || KEEP_STATUSES.has(was)) out.status = was;
      else if (was === 'added') out.status = linePaid(db, oid) ? 'queued' : 'added';
      else out.status = 'in_progress';
      out.statusWord = STATUS_WORDS[out.status];
      db.prepare("UPDATE visit_services SET status = ?, lis_status_before = NULL WHERE id = ? AND status = 'resulted'").run(out.status, oid);
    }
  }
  return out;
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R4, п. B) — что строка лотка прислала для
 * показателя: сырое тем же проводом, по коду показателя, без оглядки на
 * подтверждение (здесь вопрос «что прислано», а не «что применять»). null —
 * не прислала или код у показателя пуст.
 */
function deliveredValue(db, row, analyte) {
  const dev = row.device_id ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(row.device_id) : null;
  const head = mshOf(row.raw);
  const wire = wireFor({ profile: dev ? getProfile(dev.profile) : null, facility: head.facility, app: head.app });
  const fill = planObservations(readResult(row.raw, wire).observations, [{ ...analyte, device_code_confirmed: 1 }]).fills[0];
  return fill ? fill.obs.value : null;
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
 *
 * LIS_VENDOR_EXACT_V1 (D0, D6) — null: у флага нет основания. Пустой флаг
 * прибора — не «норма» (A1000 OBX-8 не пишет вовсе; раньше любой его
 * результат без диапазона клиники выходил «Норма»). «N» — норма только по
 * диапазону самого прибора (OBX-7): CL-900i пишет «N» у каждого результата
 * («Fixed as N»), OBX-7 у него «-» — это не суждение о норме.
 */
function flagFromDevice(abnormal, deviceRange = '') {
  switch (String(abnormal || '').toUpperCase()) {
    case '': return null;
    case 'N': return hasDeviceRange(deviceRange) ? 'normal' : null;
    case 'L': return 'low';
    case 'H': return 'high';
    case 'LL': case 'HH': case 'AA': return 'critical';
    default: return 'abnormal';
  }
}

/** LIS_VENDOR_EXACT_V1 — OBX-7 с диапазоном: не пусто и не «-» (Mindray пишет «-», когда диапазона нет). */
const hasDeviceRange = (r) => !/^-*$/.test(String(r == null ? '' : r).trim());

/** Инвариант 3: диапазон клиники бьёт диапазон прибора. null — клиника молчит. */
function flagFromClinic(num, low, high) {
  if (num == null) return null;
  if (low == null && high == null) return null;
  if (low != null && num < low) return 'low';
  if (high != null && num > high) return 'high';
  return 'normal';
}

/**
 * LIS_VENDOR_EXACT_V1 (D0) — флаг строки бланка и его ОСНОВАНИЕ: диапазон
 * клиники (инвариант 3), иначе флаг прибора; null — основания нет.
 * null в базу не пишется: lab_results.flag NOT NULL DEFAULT 'normal' CHECK
 * (мигр. 006), и запись с NULL сорвалась бы целиком. Приём пишет умолчание
 * колонки — как ручной ввод (rpc/lab.js saveLabResults); печатный бланк
 * (lab-doc.js labFlagFor) и так рисует пустой флаг как «N».
 *
 * LIS_VENDOR_EXACT_V1 (D6) — качественный ответ прибора (OBX-9 CL-900i и химии
 * Mindray, wire.js qualitative) — основание сильнее OBX-8: «положительно» (и
 * слабо, и «реактивно») — «Отклонение», и диапазон клиники «нормой» его не
 * перекрывает (выше/ниже — перекрывает: направление точнее); «отрицательно» —
 * «Норма», если диапазон клиники не сказал иного (инвариант 3).
 * @param {{num?:number|null, refLow?:number|null, refHigh?:number|null, abnormal?:string, deviceRange?:string, qualitative?:string}} o
 * @returns {'normal'|'low'|'high'|'abnormal'|'critical'|null}
 */
export function resultFlag({ num = null, refLow = null, refHigh = null, abnormal = '', deviceRange = '', qualitative = '' } = {}) {
  const clinic = flagFromClinic(num, refLow, refHigh);
  if (qualitative === 'positive') return clinic && clinic !== 'normal' ? clinic : 'abnormal';
  if (qualitative === 'negative') return clinic || 'normal';
  return clinic || flagFromDevice(abnormal, deviceRange);
}

// ═══ LIS_VENDOR_EXACT_V1 (D3) — заказ, его панель и прибор; заказы визита ═════

/** LIS_REAL_ANALYZERS_V1 (ревью R2, п. 1) — у профиля номер теста свой у каждого прибора (BS-200). */
const perInstrumentOf = (p) => !!(p && p.codesPerInstrument);
/**
 * LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — модель узнана по имени, а строка
 * заведена другой моделью: человек правит модель в «Анализаторах» — тогда и
 * экран «Панели» покажет, что подтверждать.
 */
const misnamed = (row, p, pi) => '; в «Анализаторах» прибор «' + row.name + '» заведён как '
  + (p ? p.model : 'прибор без модели') + ', а называет себя ' + pi.model + ' — исправьте модель прибора';

/** D7 — у заказа выдан хоть один показатель (как у правила выдачи и takeBackValues). */
const isReleased = (db, orderId) => db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(orderId).c > 0;

/** Значение строки прибора так, как оно ложится в бланк: у числа одна десятичная запятая — точка (D0). */
const valueOf = (obs) => (obs.valueType === 'NM' ? decimalPoint(obs.value) : obs.value);

/**
 * Значения прибора в бланке заказа: имя строки бланка → значение. fresh —
 * только записанные не раньше суток назад (ревью R3, п. 6): ими судится «бланк
 * полон»; «повтор» — против любого значения прибора в бланке.
 */
function analyzerValuesOf(db, orderId, { fresh = false } = {}) {
  return new Map(db.prepare(`SELECT parameter, value FROM lab_results
                              WHERE visit_service_id = ? AND source = 'analyzer' AND TRIM(COALESCE(value, '')) <> ''
                                AND (? = 0 OR entered_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?))`)
    .all(orderId, fresh ? 1 : 0, sinceArg(SERIES_FORM_MAX_AGE_MS)).map((r) => [r.parameter, r.value]));
}

const codeKey = (s) => String(s == null ? '' : s).trim().toUpperCase();
/** У строки бланка есть подтверждённый код поля анализатора. */
const confirmedCode = (a) => !!a.device_code_confirmed && codeKey(a.device_code) !== '';

/**
 * LIS_VENDOR_EXACT_V1 (D3) — может ли прибор этого сообщения писать в заказ:
 * панель услуги, её прибор, правило «свой прибор / та же модель»,
 * подтверждения сопоставлений. Раньше — середина ingestMessage для одного
 * заказа; теперь тем же правилом проверяется и каждый другой заказ визита
 * пробирки. Тексты отказов прежние: у заказа пробирки они идут в лоток, другой
 * заказ визита с отказом просто не участвует.
 * @param {object} order  строка visit_services (+ is_lab, service_name)
 * @param {{deviceId:number|null, sender:object|null, profile:object|null, messageModel:object|null}} ctx
 * @returns {{ok:true, panel:object, panelDev:object|null, pi:object|null, mislabel:string, analytes:object[], stale:object[]}
 *          | {ok:false, status:string, detail:string}}
 */
function orderSide(db, order, { deviceId, sender, profile, messageModel }) {
  const panel = db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
  if (!panel) {
    // Название услуги здесь обязательно. У клиники бывает несколько похоже
    // названных услуг («Общий анализ крови (CBC)», «(ОАК)», «(стационар)»), и
    // безымянное «у услуги нет панели» не отвечает на единственный вопрос,
    // который человек задаёт в этот момент: у КАКОЙ именно.
    return { ok: false, status: 'unmapped', detail: 'услуга «' + (order.service_name || order.service_id) + '» не привязана ни к одной панели' };
  }
  if (!panel.device_id) return { ok: false, status: 'unmapped', detail: 'панель «' + panel.name + '» не привязана к анализатору' };
  // Панель привязана к ОДНОМУ прибору, но в лаборатории обычное дело — два
  // одинаковых анализатора, и пробирку прогоняют на том, что свободен. Поэтому
  // сверяется МОДЕЛЬ, а не строка прибора: у одинаковых моделей одни и те же
  // коды каналов, и сопоставление панели верно для обеих. Отказ по номеру
  // строки означал бы, что результат теряется в зависимости от того, какая
  // машина оказалась свободна.
  //
  // Пустой профиль совпадением НЕ считается: иначе любой неопознанный прибор
  // писал бы в любую панель.
  // LIS_REAL_ANALYZERS_V1 (ревью R3, п. 1) — прибор сообщения неизвестен: его
  // строку удалили («Удалить» ставит device_id = NULL у его сообщений), потолок
  // находок, строку звонка удалили посреди кадра. Проверка «своя панель» ниже
  // такое пропускала, и после «Привязать» креатинин удалённого второго BS-200
  // ложился в «Глюкозу». Панель кормит прибор с номерами тестов, своими у
  // каждого прибора (codesPerInstrument), — ничего не пишется. У кодов
  // производителя (гематология и прочие) — как прежде.
  //
  // LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — номер теста свой у каждого
  // прибора, если codesPerInstrument у ЛЮБОГО из: профиль строки отправителя,
  // профиль строки прибора панели, модель, которой называет себя сообщение
  // (MSH-3/4), модель, которой называл себя прибор панели (sending_app и
  // sending_facility строки). По одному профилю строки правило обходилось:
  // строку BS-200 переименовали в BS-240, два BS-200 завели как BS-240,
  // неизвестный прибор при панели на строке BS-240. Тогда значения пишет только
  // прибор панели — и только в строки, подтверждённые для него (ниже).
  const panelDev = db.prepare('SELECT profile, name, sending_app, sending_facility, code_epoch FROM lab_devices WHERE id = ?').get(panel.device_id);   // code_epoch: ревью R6, п. 1
  const panelProfile = panelDev ? getProfile(panelDev.profile) : null;
  const panelModel = panelDev ? guessProfile({ app: panelDev.sending_app, facility: panelDev.sending_facility }) : null;
  const pi = [profile, panelProfile, messageModel, panelModel].find(perInstrumentOf) || null;
  let mislabel = '';
  if (pi && sender && perInstrumentOf(messageModel) && !perInstrumentOf(profile)) mislabel = misnamed(sender, profile, pi);
  else if (pi && panelDev && perInstrumentOf(panelModel) && !perInstrumentOf(panelProfile)) mislabel = misnamed(panelDev, panelProfile, pi);
  if (!deviceId && pi) {
    return { ok: false, status: 'unmatched',
      detail: 'прибор этого сообщения неизвестен (его строку удалили или он не заведён), а панель «' + panel.name + '» кормит '
        + pi.model + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '') + ': у ' + pi.model + ' номер теста свой у каждого прибора'
        + ' — значения не записаны; внесите их вручную или пришлите пробу с прибора ещё раз' + mislabel };
  }
  if (deviceId && panel.device_id !== deviceId) {
    const sameModel = sender && panelDev && sender.profile && sender.profile === panelDev.profile;
    if (!sameModel) {
      return { ok: false, status: 'unmatched',
        detail: 'панель «' + panel.name + '» кормится анализатором другой модели' + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '') };
    }
    // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 1) — у BS-200 номер теста свой у
    // каждого прибора (ItemID.ini): «2» второго BS-200 бывает креатинином, и
    // подмена «та же модель» положила бы его в строку «Глюкоза» панели первого.
    // У такого профиля (codesPerInstrument) панель кормит только свой прибор.
    if (pi) {
      return { ok: false, status: 'unmatched',
        detail: 'панель «' + panel.name + '» привязана к другому анализатору той же модели'
          + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '')
          + ': у ' + pi.model + ' номер теста свой у каждого прибора — значения этого прибора в её бланк не идут;'
          // Ревью R3, пп. 2 и 3 — что делать: у услуги панель одна
          // (lab_panels.service_id UNIQUE), «заведите свою» было невозможно.
          + ' если это тот же анализатор с новым адресом — в «Лаборатория → Панели» выберите для панели этот прибор'
          + ' и заново подтвердите номера тестов, потом «Привязать»; если это второй ' + pi.model
          + ' — номера тестов у него свои: его результаты вносятся вручную или нужна отдельная услуга со своей панелью' + mislabel };
    }
  }
  // LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — у прибора с номерами тестов,
  // своими у каждого прибора (pi выше), подтверждение действует, только если
  // дано для прибора панели (device_code_confirmed_device_id, мигр. 233).
  // Данное для другого прибора — и до мигр. 233 (NULL) — здесь «не
  // подтверждено»: значение в бланк не идёт (D4), проба — в лоток с причиной.
  // У кодов производителя отметка не читается.
  // Ревью R6, п. 1 — и эпоха кодов прибора: подтверждение действует, только
  // если дано при нынешней эпохе прибора (lab_devices.code_epoch растёт со
  // сменой адреса строки BS-200). Вкладка, открытая до смены адреса,
  // сохраняет прежнюю эпоху — и не совпадает; NULL не совпадает никогда.
  const rawAnalytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id);
  const epochNow = panelDev ? panelDev.code_epoch : null;
  const stale = pi ? rawAnalytes.filter((a) => a.device_code_confirmed && String(a.device_code == null ? '' : a.device_code).trim()
    && (a.device_code_confirmed_device_id !== panel.device_id || a.device_code_confirmed_epoch == null
        || a.device_code_confirmed_epoch !== epochNow)) : [];
  const analytes = stale.length ? rawAnalytes.map((a) => (stale.includes(a) ? { ...a, device_code_confirmed: 0 } : a)) : rawAnalytes;
  return { ok: true, panel, panelDev, pi, mislabel, analytes, stale };
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — в сообщении значения для строк
 * панели, подтверждённых для другого прибора (или до мигр. 233): что делать и
 * какие строки. LIS_VENDOR_EXACT_V1 (D3) — у каждого заказа пробирки свой.
 */
function staleTextOf(side, plan) {
  const hit = side.stale.filter((a) => plan.unconfirmed.some((o) => codeKey(o.code) === codeKey(a.device_code) || codeKey(o.name) === codeKey(a.device_code)));
  return hit.length ? STALE_DETAIL + hit.map((a) => a.name + ' (' + String(a.device_code).trim() + ')').join(', ') + side.mislabel : '';
}

/**
 * LIS_PROXY_V1 (ревью C1) — материал услуги (services.specimen, свободный текст
 * «Материал (кровь, моча…)») для «одна пробирка — все услуги» (D3): моча,
 * плазма, сыворотка, кровь — по слову (плазма и сыворотка раньше крови:
 * «плазма крови», «сыворотка крови»); прочее — сам текст без регистра и лишних
 * пробелов; пусто — '' (не указан). Делят пробирку только заказы с одним
 * ключом: не указан у обоих — делят (клиника, которая поле не заполняет,
 * ничего не теряет); у одного — не делят (значение — «не использованы», его
 * видно). Кровь и сыворотка — разные пробирки (ЭДТА и сыворотка), хотя BS-200
 * обе называет serum (lisproxy-form.js biomaterialOf): HbA1c из цельной крови
 * не идёт в рабочий список пробирки сыворотки.
 */
export function specimenKey(specimen) {
  const s = String(specimen == null ? '' : specimen).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/моч|urine/.test(s)) return 'urine';
  if (/плазм|plasma/.test(s)) return 'plasma';
  if (/сыворот|serum/.test(s)) return 'serum';
  if (/кров|blood/.test(s)) return 'blood';
  return s;
}

/**
 * LIS_VENDOR_EXACT_V1 (D3; решение владельца 2026-10-06, п. 2 — «Заполнить
 * все») — другие лабораторные заказы визита пробирки, которые кормит этот
 * прибор (orderSide — то же правило «свой прибор / та же модель») и у панели
 * которых есть подтверждённые коды. closed: '' — открыт и оплачен, пишется;
 * 'unpaid' — ещё не оплачен, 'released' — уже выдан: значения не получает, а
 * человеку сказано почему (если код пробирки — только его). Отменённые и
 * возвращённые — не заказы этой пробирки. Прибор сообщения неизвестен — других
 * заказов нет (вызывающий не спрашивает).
 */
function siblingSides(db, order, ctx) {
  if (order.visit_id == null) return [];
  const out = [];
  const rows = db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name, s.specimen AS service_specimen FROM visit_services vs
                             JOIN services s ON s.id = vs.service_id
                            WHERE vs.visit_id = ? AND vs.id <> ? AND s.is_lab = 1
                            ORDER BY vs.id LIMIT ?`).all(order.visit_id, order.id, SIBLINGS_MAX);   // service_specimen: LIS_PROXY_V1 (ревью C1)
  const tubeSpecimen = specimenKey(order.service_specimen);   // LIS_PROXY_V1 (ревью C1)
  for (const o of rows) {
    // LIS_PROXY_V1 (ревью C1) — одна пробирка — заказы ОДНОГО материала: проба
    // мочи не заполняет «Биохимию» сыворотки (и не переписывает её 5.1 своими
    // 0.3), а рабочий список пробирки мочи не велит гнать на ней глюкозу
    // сыворотки. И у своего порта, и у LIS Proxy. Материал не указан у обоих —
    // один (D3 как прежде); у одного — разные (specimenKey).
    if (specimenKey(o.service_specimen) !== tubeSpecimen) continue;
    let closed = '';
    if (o.status === 'added') closed = 'unpaid';
    else if (o.status === 'completed') closed = 'released';
    else if (!OPEN_PAID_STATUSES.has(o.status)) continue;
    else if (isReleased(db, o.id)) closed = 'released';
    const side = orderSide(db, o, ctx);
    if (!side.ok || !side.analytes.some(confirmedCode)) continue;
    out.push({ order: o, ...side, closed });
  }
  return out;
}

/**
 * Запись значений прибора в бланк заказа: D6 — в черновике машина побеждает
 * набранное руками (выданное отсеяно раньше). Возвращает номера записанных
 * строк бланка — им ставится номер строки лотка (ревью R4, п. B).
 */
function writeFills(db, orderId, fills) {
  const ids = [];
  for (const { obs, analyte: a } of fills) {
    // LIS_VENDOR_EXACT_V1 (D0) — одна десятичная запятая между цифрами у
    // числовой строки — точка, на любом проводе: в бланке «9.81», окно
    // результатов (<input type=number>) его показывает, numeric_value есть,
    // и диапазон клиники ставит флаг. Раньше «9,81» ложилось текстом.
    const value = valueOf(obs);
    const num = obs.valueType === 'NM' && /^-?\d+(\.\d+)?$/.test(value) ? parseFloat(value) : null;
    // LIS_VENDOR_EXACT_V1 (D0) — основание флага (resultFlag); без основания
    // — умолчание колонки 'normal': flag NOT NULL (мигр. 006), NULL сорвал бы запись.
    const flag = resultFlag({ num, refLow: a.ref_low, refHigh: a.ref_high, abnormal: obs.abnormal, deviceRange: obs.range,
      qualitative: obs.qualitative }) || 'normal';   // LIS_VENDOR_EXACT_V1 (D6) — ответ OBX-9
    // Инвариант 3 и 4: диапазон, имя и единица — из панели. Диапазон прибора
    // берётся только там, где клиника свой не задала.
    // LIS_VENDOR_EXACT_V1 (D6) — OBX-7 «-» (Mindray: диапазона нет) — пусто,
    // а не «-» в графе «Референс» бланка.
    const range = a.ref_text
      || (a.ref_low != null || a.ref_high != null ? `${a.ref_low == null ? '' : a.ref_low}-${a.ref_high == null ? '' : a.ref_high}`
        : (hasDeviceRange(obs.range) ? obs.range : ''));

    const existing = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = ? AND parameter = ?').get(orderId, a.name);
    if (existing) {
      // D6 — машина побеждает в ЧЕРНОВИКЕ (выданное отсеяно выше).
      db.prepare(`UPDATE lab_results SET value = ?, numeric_value = ?, unit = ?, reference_range = ?,
                    ref_low = ?, ref_high = ?, flag = ?, source = 'analyzer',
                    entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                  WHERE id = ?`)
        .run(value, num, a.unit || '', range, a.ref_low, a.ref_high, flag, existing.id);   // LIS_VENDOR_EXACT_V1 (D0) — value с точкой
      ids.push(existing.id);
    } else {
      ids.push(db.prepare(`INSERT INTO lab_results
                    (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
        .run(orderId, a.name, value, num, a.unit || '', range, a.ref_low, a.ref_high, flag).lastInsertRowid);   // LIS_VENDOR_EXACT_V1 (D0)
    }
  }
  return ids;
}

/**
 * Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
 * sample_collected_at не подставляем: времени забора мы не наблюдали, и
 * выдумать его значило бы записать в карту факт, которого не было.
 * LIS_REAL_ANALYZERS_V1 (ревью R4, п. C) — статус, из которого прибор перевёл
 * заказ в «результаты внесены», запоминается: «Привязать» к другому заказу,
 * опустошившее бланк, вернёт ровно его. Уже стоящий «результаты внесены» прибор
 * не переводил — запомненное не трогается.
 */
function markResulted(db, order) {
  if (order.status === 'completed') return;
  db.prepare(`UPDATE visit_services SET lis_status_before = CASE WHEN status = 'resulted' THEN lis_status_before ELSE status END,
                status = 'resulted' WHERE id = ?`).run(order.id);
  // CRM_REAL_BOOKING_V1 — прибор отдал результат по пробе, которую взяли у
  // человека здесь: для заявки колл-центра это доказательство прихода.
  crmServiceEvidence(db, [order.id]);
}

/** LIS_VENDOR_EXACT_V1 (п. 5) — каждая подтверждённая строка бланка заказа держит значение. */
function blankComplete(db, side) {
  const has = db.prepare("SELECT 1 FROM lab_results WHERE visit_service_id = ? AND parameter = ? AND TRIM(COALESCE(value, '')) <> ''");
  const expected = side.analytes.filter(confirmedCode);
  return expected.length > 0 && expected.every((a) => !!has.get(side.order.id, a.name));
}

/**
 * LIS_VENDOR_EXACT_V1 (п. 5) — сообщение заполнило бланк заказа (каждая
 * подтверждённая строка держит значение, и само сообщение для этого заказа
 * чистое): ранние строки лотка ЭТОГО заказа с ЭТОГО ЖЕ прибора, всё сказанное
 * которыми теперь в бланке, закрываются (resolved_at) с отметкой, каким
 * сообщением: проба до настройки («панель … не привязана к анализатору»),
 * частичная отправка («Отправить незавершенные пробы» CL-900i — «не пришли:
 * …»), проба до оплаты или до «Добавить» прибор.
 * Закрывается строка, только если её значения — те же, что в бланке
 * (пересчёт сырого нынешним сопоставлением: другой прогон с другими числами
 * сверяет человек), и в ней нет того, что разбирает человек: «повтор»,
 * «не подтверждено» (D4), «неоднозначно» (D3). Строки других заказов, другого
 * прибора, ждущие строки серии (их принимает серия) и разобранные человеком не
 * трогаются; статус и сырое — как были (инвариант 2).
 */
function closeStaleRows(db, { sides, k, deviceId, msgId, profile }) {
  const target = sides[k];
  const rows = db.prepare(`SELECT id, raw, detail FROM lab_device_messages
                            WHERE visit_service_id = ? AND device_id = ? AND id <> ? AND kind = 'result'
                              AND status IN ('unmapped', 'unmatched') AND resolved_at IS NULL AND disputes IS NULL
                            ORDER BY id DESC LIMIT ?`).all(target.order.id, deviceId, msgId, STALE_SCAN_MAX);
  if (!rows.length) return;
  // Заказы — как у самой пробы: этот первым, потом другие заказы визита.
  const order = [target, ...sides.filter((s, i) => i !== k)];
  const inBlank = db.prepare('SELECT value FROM lab_results WHERE visit_service_id = ? AND parameter = ?');
  for (const r of rows) {
    const d = String(r.detail || '');
    if (d.startsWith(SERIES_PENDING_PREFIX) || d.includes('повтор:') || d.includes('не подтверждено')
      || d.includes('неоднозначно') || d.includes(REATTACHED_NOTE)) continue;
    const head = mshOf(r.raw);
    const w = wireFor({ profile, facility: head.facility, app: head.app });
    if (readEnvelope(r.raw, w).service) continue;
    const t = planTube(readResult(r.raw, w).observations, order.map((s, i) => ({ analytes: s.analytes, tier: i === 0 ? 0 : (s.closed ? 2 : 1) })));
    const fills = t.plans.flatMap((p, i) => p.fills.map((f) => ({ orderId: order[i].order.id, f })));
    if (t.ambiguous.length || !fills.length) continue;
    const same = fills.every(({ orderId, f }) => {
      const b = inBlank.get(orderId, f.analyte.name);
      return !!b && String(b.value == null ? '' : b.value).trim() !== '' && sameValue(b.value, valueOf(f.obs));
    });
    if (!same) continue;
    const note = closedNote(target.order.id, msgId);
    db.prepare(`UPDATE lab_device_messages SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                  detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || '; ' || ? END
                WHERE id = ? AND resolved_at IS NULL`).run(note, note, r.id);
  }
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
 *        вручную». LIS_VENDOR_EXACT_V1 (N1) — и «повтор» не держит: человек
 *        принял новые значения.
 *        wire — провод назван явно (иначе — по MSH-4 и профилю прибора).
 */
export function ingestMessage(db, raw, peer = '', deviceId = null, opts = {}) {
  const manual = opts.sampleIdOverride != null;
  // LIS_REAL_ANALYZERS_V1_SAMPLE — у привязанного вручную каждая строка
  // журнала говорит об этом: номер выбрал человек, а не прибор.
  // LIS_REAL_ANALYZERS_V1 (ревью R3, п. 7) — opts.report: чем кончился приём
  // (статус строки, её номер, сколько строк бланка записано) — привязка из
  // лотка снимает значения из прежнего заказа, только если новый их принял.
  const record = (o) => {
    const row = manual ? { ...o, detail: o.detail ? o.detail + '; ' + MANUAL : MANUAL } : o;
    // LIS_PROXY_V1 — запрос LIS Proxy уже в журнале (записан до разбора): приём дописывает ту же строку.
    const id = recordMessage(db, opts.journalId != null ? { ...row, id: opts.journalId } : row);
    if (opts.report) Object.assign(opts.report, { status: o.status, rowId: id });
    return id;
  };

  try {
    parseMessage(raw);
  } catch (e) {
    record({ deviceId, peer, raw, status: 'rejected', detail: e.message });
    return 'AE';
  }

  // LIS_REAL_ANALYZERS_V1_SAMPLE — провод прибора: сообщения переадресателя
  // (MSH-4 = LabPC) — forwarder, иначе провод профиля, иначе default (прежние
  // профили и прибор без профиля читаются ровно как раньше).
  // LIS_VENDOR_EXACT_V1 (N2) — и added: находка, которую человек ещё не добавил.
  const device = deviceId ? db.prepare('SELECT profile, added, via FROM lab_devices WHERE id = ?').get(deviceId) : null;   // via: LIS_PROXY_V1
  // LIS_PROXY_V1 — прибор за LIS Proxy (мигр. 239): прокси шлёт по значению в запросе, номер — только этикетка.
  const proxy = !!(device && device.via === 'lisproxy');
  const profile = device ? getProfile(device.profile) : null;
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — и по тому, как сообщение называет
  // себя (MSH-3/4): BS-200 на строке без профиля или с чужим профилем не
  // читает OBR-3; при споре профиля и сообщения — безопасный провод.
  const head = mshOf(raw);
  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 12) — спор профиля и сообщения ниже
  // кладёт сообщение в лоток; безопасный провод — для номера человеку.
  const decision = opts.wire ? { wire: opts.wire, conflict: false } : wireDecision({ profile, facility: head.facility, app: head.app });
  const wire = decision.wire;

  // LIS_VENDOR_EXACT_V1 (п. 6) — служебное сообщение (контроль качества,
  // калибровка, запрос рабочего списка) к сопоставлению с пациентом не
  // доходит НИКОГДА: ни с номером прибора, ни с номером человека. receive.js
  // отводит его раньше приёма, «Привязать» (rpc/lis.js) отказывает; здесь —
  // последняя стена для любого другого пути. Вид — тем же проводом, что у
  // receive.js (wire.js readEnvelope: химия и ИХЛА Mindray — MSH-16;
  // гематология Mindray — MSH-11 и OBR-4 с 99MRC; A1000 — по правилу провода).
  const env = readEnvelope(raw, wire);
  if (env.service) {
    if (opts.touch !== false) touchDevice(db, deviceId);
    record({ deviceId, peer, raw, sampleId: env.kind === 'query' ? env.queryBarcode : '', status: 'unmatched',
      detail: SERVICE_DETAIL[env.kind] || SERVICE_DETAIL.query, kind: env.kind, resolved: true });
    return 'AA';
  }
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

  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 12) — строка прибора и само сообщение
  // называют РАЗНЫЕ модели с разными проводами (строка — BC-780, сообщение —
  // «Mindray|BS-200E»): где номер пробы, где код и значение, решает провод, и
  // выбрать наугад — значит, может быть, прочесть место в штативе как номер
  // или RLU как результат. Ничего не читается, в лоток; номер в sample_id — по
  // безопасному проводу (у BS-200 OBR-3 не читается и здесь), для человека.
  // И при ручной привязке: номер назвал человек, но провод он не выбирал.
  if (decision.conflict) {
    const said = [head.app, head.facility].filter(Boolean).join(' ');
    record({ ...base, status: 'unmatched', detail: 'прибор заведён как «' + decision.rowModel + '», а сообщение — от «' + said
      + '» (модель «' + decision.messageModel + '»): у этих моделей разные поля номера пробы и значений — значения не прочитаны;'
      + ' исправьте модель прибора в «Анализаторах»' });
    return 'AA';
  }

  // Две РАЗНЫЕ этикетки LAB- в OBR-2 и OBR-3 — чья проба, не знает никто:
  // номера нет, бланки не трогаются, в sample_id — оба номера.
  if (pick.conflict) {
    record({ ...base, status: 'unmatched', detail: CONFLICT_DETAIL[pick.why] || CONFLICT_DETAIL.fields });
    return 'AA';
  }
  // LIS_PROXY_V1 (решение владельца 2026-10-09, п. 3) — у прибора за LIS Proxy номер
  // пробы — только этикетка LAB-: тип BS-200 прокси кладёт в поле штрихкода номер
  // пациента (PID-2), и правило голых цифр ниже заполнило бы бланк ДРУГОГО
  // пациента. Вход прокси (lisproxy.js) такое сюда не пускает; это стена на
  // случай любого другого пути. Номер, названный человеком («Привязать»), — как прежде.
  if (proxy && !manual && !pick.lab) {
    record({ ...base, status: 'unmatched', detail: PROXY_NOT_TUBE + ': ' + (pick.sampleId || '(пусто)') + ' — заказ не ищется; пробу привяжите кнопкой «Привязать»' });
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
  // LIS_VENDOR_EXACT_V1 (решение владельца 2026-10-06, п. 4) — голые цифры —
  // только номер с этикетки (PLAIN_NUMBER_MIN_DIGITS выше): номер самого
  // прибора заказ даже не ищет — в лоток, без привязки к чьему-либо заказу.
  if (!pick.lab && !manual) {
    const plain = plainNumberRefusal(pick.value, wire);
    if (plain) {
      record({ ...base, status: 'unmatched', detail: plain });
      return 'AA';
    }
  }

  const vsId = parseSampleId(pick.value);

  const order = vsId
    ? db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name, s.specimen AS service_specimen FROM visit_services vs
                    JOIN services s ON s.id = vs.service_id
                   WHERE vs.id = ?`).get(vsId)   // service_specimen: LIS_PROXY_V1 (ревью C1) — материал пробирки для D3
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
  // LIS_REAL_ANALYZERS_V1 (ревью R7, п. 1) — ворота лаборатории, те же, что у
  // ручного ввода: неоплаченный, отменённый, возвращённый заказ прибор не
  // заполняет и в «результаты внесены» не переводит (иначе после этого
  // открывался и ручной ввод). Строка лотка — с заказом, только если номер —
  // этикетка LAB- (или номер назвал человек), как у прочих отказов; голый
  // номер не привязывает. Оплатили — «Привязать» её к тому же заказу. Серия
  // такого заказа тоже ничего не переводит: до неё приём не доходит.
  const gate = gateRefusal(order);
  if (gate) {
    record({ ...base, visitServiceId: linkId, status: 'unmatched', detail: gate });
    return 'AA';
  }
  // LIS_VENDOR_EXACT_V1 (N2) — находка (added = 0) в бланки не пишет: ни в
  // свою панель, ни через «та же модель», ни по «Привязать» — её модель ещё
  // догадка, а по модели читаются номер пробы и значения (приёмка BC-5300 N2;
  // проба H проверяющего гематологии: находка «BC-5300» заполнила ОАК).
  // Сообщение сохранено (инвариант 2), в лотке — что сделать. Заказ — как у
  // прочих отказов: этикетка LAB- (её печатает только Easy-Med) и номер
  // человека привязывают, голый номер — нет. После «Добавить» та же проба,
  // присланная снова, ложится в бланк, а эта строка закрывается сама (п. 5).
  // Добавленные приборы — как прежде.
  if (device && Number(device.added) === 0) {
    record({ ...base, visitServiceId: linkId, status: 'unmatched', detail: NOT_ADDED_DETAIL });
    return 'AA';
  }

  // Панель, прибор, модель, подтверждения заказа пробирки — orderSide (выше);
  // отказ — в лоток, с прежними словами.
  const sender = deviceId ? db.prepare('SELECT profile, name FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const ctx = { deviceId, sender, profile, messageModel: guessProfile({ app: head.app, facility: head.facility }) };
  const x = orderSide(db, order, ctx);
  if (!x.ok) {
    record({ ...base, visitServiceId: linkId, status: x.status, detail: x.detail });
    return 'AA';
  }

  // LIS_VENDOR_EXACT_V1 (D3; решение владельца 2026-10-06, п. 2 — «Заполнить
  // все») — пробирка заполняет и другие лабораторные заказы визита, которые
  // кормит этот прибор: ТТГ, Т4 св. и Т3 св. тремя услугами — одна пробирка.
  // Раньше их значения шли в «не использованы», а проба — «принята». Кому какая
  // строка прибора — match.js planTube: заказ пробирки первым; код у двух
  // других заказов — «неоднозначно» (не угадываем). Прибор неизвестен — других
  // заказов не ищем: чей это прибор, не знает никто.
  const sides = [{ order, ...x, closed: isReleased(db, order.id) ? 'released' : '' }];
  if (deviceId) sides.push(...siblingSides(db, order, ctx));
  const tube = planTube(observations, sides.map((s, i) => ({ analytes: s.analytes, tier: i === 0 ? 0 : (s.closed ? 2 : 1) })));
  const fanned = tube.ambiguous.length > 0 || tube.involved.some((v, i) => i > 0 && v);

  // D7 — выданный бланк молча не переписывается. Проверка ДО записи: замещать
  // черновик помощь, замещать выданный отчёт пациента — другое дело.
  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 14) — здесь заказ привязывается и у
  // голого номера: он уже прошёл правило «открытый заказ последних 7 дней» и
  // проверки панели и модели — это обычное совпадение, как у этикетки. Пункт
  // 3 R1 снимает привязку только у ОТКАЗАННЫХ голых номеров (выше).
  // LIS_VENDOR_EXACT_V1 (D3) — выдан заказ пробирки, а проба заполняет и другие
  // заказы визита: выданный не трогается (его часть — «уже выдан»), остальные
  // пишутся; сообщение — superseded (новое значение к выданному смотрит человек).
  if (sides[0].closed && !fanned) {
    record({ ...base, visitServiceId: order.id, status: 'superseded', detail: SUPERSEDED_DETAIL });
    return 'AA';
  }

  // LIS_REAL_ANALYZERS_V1_SERIES — прибор шлёт по тесту в сообщении.
  // LIS_PROXY_V1 — LIS Proxy шлёт одно значение в запросе при любой модели: серия всегда.
  const oneTest = proxy || !!(profile && profile.oneTestPerMessage);
  // LIS_PROXY_V1 (Р14) — гематология за LIS Proxy: лишний показатель — справка, а не лоток.
  const heme = !!(profile && profile.kind === 'hematology');
  // LIS_VENDOR_EXACT_V1 (D3) — о каком заказе говорит сообщение: о заказе
  // пробирки — всегда, если других нет; при других — если ему досталась
  // строка прибора, а у прибора без серии и тогда, когда его подтверждённые
  // строки не пришли (у CL-900i все тесты пробы — в одном сообщении). У
  // прибора «по тесту» тест другой услуги о заказе пробирки не говорит
  // ничего: его ожидание — в его собственных строках серии (приёмка BS-200 T8).
  const reported = sides.map((s, i) => (i > 0 ? tube.involved[i]
    : !fanned || tube.involved[0] || (!s.closed && !oneTest && s.analytes.some(confirmedCode))));

  let applied = 0;
  const run = db.transaction(() => {
    const writtenIds = [];   // ревью R4, п. B — строки бланка, записанные этим сообщением
    const accepted = [];     // ждущие строки серий, которые это сообщение закрыло
    const disputes = [];     // ревью R4, п. D; LIS_VENDOR_EXACT_V1 (N1)
    const reports = [];
    sides.forEach((s, k) => {
      if (!reported[k]) return;
      const O = s.order;
      const report = { k, orderId: O.id, name: O.service_name || String(O.service_id), status: 'unmapped', detail: '', pending: false, open: false };
      reports.push(report);
      if (s.closed) {
        // LIS_VENDOR_EXACT_V1 (D3) — заказ визита принять не может: значения не
        // пишутся, сказано почему (выдан — D7; не оплачен — ворота лаборатории).
        Object.assign(report, s.closed === 'released' ? { status: 'superseded', detail: SUPERSEDED_DETAIL } : { detail: GATE_DETAIL.added });
        return;
      }
      const plan = tube.plans[k];
      const seriesOn = oneTest && plan.fills.length > 0;
      // LIS_PROXY_V1 (Р14) — гематология через LIS Proxy: значение, которое ничего не
      // заполнило и ни на что не претендует (не подтверждено, не повтор) — только
      // «не использованы». На своём порту такие строки — справка в принятом
      // сообщении (правило владельца 2026-09-28); по одному значению в запросе
      // каждая была бы строкой лотка на каждую пробирку. Строка — разрешённая
      // справка; бланк судит серия. BS-200 и AutoLumo — как свой порт: в лоток.
      if (proxy && heme && !fanned && k === 0 && !plan.fills.length && !plan.unconfirmed.length && !plan.repeats.length && plan.unused.length) {
        Object.assign(report, { status: 'unmapped', detail: PROXY_QUIET_PREFIX + unusedText(plan.unused), pending: false, open: true, quiet: true });
        return;
      }
      // LIS_VENDOR_EXACT_V1 (N1) — у прибора без серии новое сообщение МЕНЯЕТ
      // значение прибора в черновике заказа (приёмка: WBC 5.40 → 14.20
      // пробирки с чужим автономером — молча, без строки в лотке): в этот
      // заказ не пишется ничего — смешать в одном бланке два прогона нельзя;
      // сообщение — в лоток «повтор…», спор — структурой (disputes, как у
      // серии). Принять новые значения — «Привязать» (номер называет человек:
      // manual). То же значение — повторная передача: не пишется, не спор;
      // пустая строка бланка заполняется. Набранное руками — D6, как прежде.
      // У серии (BS-200, A1000) — её правило «повтор» (match.js planSeries).
      const held = [];
      const dupes = [];
      if (!seriesOn && !manual) {
        const now = analyzerValuesOf(db, O.id);
        for (const f of plan.fills) {
          if (!now.has(f.analyte.name)) continue;
          const was = now.get(f.analyte.name);
          if (sameValue(was, valueOf(f.obs))) dupes.push(f);
          else held.push({ obs: f.obs, analyte: f.analyte, was: String(was).trim(), now: valueOf(f.obs) });
        }
      }
      // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 5) — значения прибора в бланке ДО
      // записи: против них судится «повтор» серии — в любом окне.
      const before = seriesOn ? analyzerValuesOf(db, O.id) : null;
      // LIS_MINDRAY_CODES_V1 — какая строка прибора ложится в какую строку
      // бланка, решает planObservations (match.js): компонент 1 ИЛИ 2 поля
      // OBX-3, только подтверждённые сопоставления (D4), пустое значение — не
      // значение.
      const ids = held.length ? [] : writeFills(db, O.id, plan.fills.filter((f) => !dupes.includes(f)));
      writtenIds.push(...ids);
      applied += ids.length;
      if (ids.length) markResulted(db, O);
      if (held.length) disputes.push(...held.map((c) => disputeOf({ analyte: c.analyte, was: [c.was], now: c.now })));

      // Лоток (решение владельца 2026-09-28): проба принята, когда заполнена
      // каждая подтверждённая строка бланка; лишние строки прибора — справка.
      // LIS_VENDOR_EXACT_V1 (D3; приёмка BS-200 T8) — у прибора «по тесту»
      // сообщение без своих значений говорит «не пришли» по бланку: строки,
      // уже записанные ранними сообщениями той же пробирки, не «не пришли».
      // «Не использованы» при других заказах — у всего сообщения (tubeOutcome).
      let p = plan;
      if (oneTest && !seriesOn) {
        const filled = new Set(analyzerValuesOf(db, O.id, { fresh: true }).keys());
        p = { ...p, missing: p.missing.filter((m) => !filled.has(m.analyte.name)) };
      }
      if (fanned) p = { ...p, unused: [] };
      const core = outcome(p, { lead: held.length ? [heldChangeText(held)] : [], info: dupes.length ? [resentText(dupes)] : [] });
      let status = held.length ? 'unmapped' : core.status;
      let detail = core.detail;
      let pending = false;

      // LIS_REAL_ANALYZERS_V1_SERIES — прибор шлёт по тесту в сообщении (профиль
      // oneTestPerMessage: BS-200, A1000): «бланк заполнен» судится по серии
      // сообщений этого заказа (match.js planSeries), а не по одному. То же
      // правило владельца: в лоток — если подтверждённой строки нет (пока
      // серия идёт — с отметкой «ждём»), если пришло значение для
      // неподтверждённой строки или второе, другое значение той же строки.
      // Сообщение, из которого в бланк не легло ничего, — правило одного
      // сообщения, как прежде, и в серию оно не входит.
      if (seriesOn) {
        const who = { orderId: O.id, deviceId, perInstrument: proxy || !!s.pi, profileKey: device.profile };   // ревью R2, п. 1; R4, п. A; LIS_PROXY_V1 — серия LIS Proxy — по строке прибора
        const { members, overflow } = seriesMembers(db, { ...who, profile, analytes: s.analytes });
        if (overflow) {
          // Ревью R2, п. 9 — серия не растёт без предела: сверх потолка она не
          // пересчитывается, а сообщение — в лоток, со своим журналом.
          status = 'unmapped';
          detail = 'больше ' + SERIES_MAX_MESSAGES + ' сообщений по этому заказу за ' + Math.round(SERIES_WINDOW_MS / 60000)
            + ' минут — серия не считается: проверьте прибор и бланк' + (detail ? '; ' + detail : '');
        } else {
          // Серия верит бланку (ревью R2, п. 5): «заполнено» — значение прибора
          // в бланке, в том числе пришедшее раньше окна; «повтор» — против
          // значения в бланке до записи; отклонённый человеком спор не
          // поднимается снова (п. 6). LIS_VENDOR_EXACT_V1 (D3) — строки
          // прибора этого заказа (у заказа пробирки — все, как прежде).
          const written = new Set(analyzerValuesOf(db, O.id, { fresh: true }).keys());   // ревью R3, п. 6
          const series = planSeries([...members.map((m) => m.observations), tube.routed[k]], s.analytes, { written, before });
          const seen = dismissedChange(db, O.id);
          series.changed = series.changed.filter((c) => !seen(c));
          // Ревью R4, п. D — спор этой строки структурой: по ней его узнают,
          // когда человек его разберёт.
          if (series.changed.length) disputes.push(...series.changed.map(disputeOf));
          if (fanned) series.unused = [];
          const r = seriesOutcome(series);
          status = r.status;
          detail = r.detail;
          pending = r.pending;
          // Бланк полон — ожидание строк «ждём» этого заказа кончилось: они
          // становятся applied в этой же транзакции, в любом окне и даже если у
          // этого сообщения свой спор (он — в его строке). Строки, которых
          // коснулся человек («Привязать», «Отклонить» ставят resolved_at), не
          // трогаются. Сырое не трогается никогда.
          if (!series.missing.length && series.filled.length) accepted.push(...waitingRows(db, who));
        }
      }

      // Ревью R4, п. A — подтверждено для другого прибора: что делать.
      const staleText = staleTextOf(s, plan);
      if (staleText) detail = (detail ? detail + '; ' : '') + staleText;
      Object.assign(report, { status, detail, pending, open: true });
    });

    // LIS_VENDOR_EXACT_V1 (D3) — строка лотка одна на сообщение: при других
    // заказах — журнал по заказам (match.js tubeOutcome); при заказе пробирки,
    // а у теста другой услуги прибора «по тесту» — при той услуге, которую он
    // заполнил (её серия ищет свои сообщения по заказу).
    let status;
    let detail;
    if (!fanned) {
      ({ status, detail } = reports[0]);
      if (reports[0].pending) detail = SERIES_PENDING_PREFIX + detail;
    } else {
      const t = tubeOutcome(reports, {
        ambiguous: tube.ambiguous.map((a) => ({ obs: a.obs, orders: a.orders.map((i) => sides[i].order.id) })),
        unused: tube.unused,
      });
      status = t.status;
      detail = t.pending ? SERIES_PENDING_PREFIX + t.detail : t.detail;
    }
    const linked = reports.length === 1 && reports[0].k > 0 ? reports[0].orderId : order.id;
    const quiet = !fanned && !!reports[0].quiet;   // LIS_PROXY_V1 (Р14) — справка разрешена сразу
    const id = record({ ...base, visitServiceId: linked, status, detail, disputes: disputes.length ? JSON.stringify(disputes) : null, resolved: quiet });
    // Ревью R4, п. B — у записанного — номер этой строки лотка.
    for (const rid of writtenIds) db.prepare('UPDATE lab_results SET source_message_id = ? WHERE id = ?').run(id, rid);
    for (const m of accepted) {
      db.prepare("UPDATE lab_device_messages SET status = 'applied', detail = ? WHERE id = ? AND status = 'unmapped' AND resolved_at IS NULL")
        .run('принято серией (сообщение № ' + id + ')' + (m.detail.endsWith(MANUAL) ? '; ' + MANUAL : ''), m.id);
    }
    // LIS_VENDOR_EXACT_V1 (п. 5) — заказ, который это сообщение заполнило
    // чисто, закрывает свои устаревшие строки лотка с этого прибора.
    if (deviceId) {
      for (const r of reports) {
        if (r.open && r.status === 'applied' && blankComplete(db, sides[r.k])) closeStaleRows(db, { sides, k: r.k, deviceId, msgId: id, profile });
      }
    }
  });

  try {
    run();
    if (opts.report) opts.report.written = applied;   // ревью R3, п. 7
  } catch (e) {
    // Транзакция откатилась целиком. NAK — прибор пришлёт снова, и это здесь
    // помощник, а не помеха.
    record({ ...base, visitServiceId: order.id, status: 'rejected', detail: 'ошибка записи: ' + e.message });
    return 'AE';
  }

  return 'AA';
}

// ═══ LIS_PROXY_V1 — РАБОЧИЙ СПИСОК ДЛЯ LIS PROXY (apiOrderGet) ═══════════════
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 5; решение
// владельца 2026-10-09, п. 1 — отменяет «только результаты» 2026-10-01, §7.)
//
// Здесь, а не во входе прокси: тесты на пробирку отдаются по ТЕМ ЖЕ воротам,
// по которым приём потом примет результат, — одно правило, а не копия. Только
// чтение: ничего не пишет.
//   — заказ есть и лабораторный; ворота лаборатории (gateRefusal: не оплачен,
//     отменён, возврат); не выдан (D7: выданный приём всё равно не перепишет);
//   — orderSide: панель услуги привязана к этому прибору или к прибору той же
//     модели (у BS-200 — только к своему), подтверждения BS-200 — для этого
//     прибора и его эпохи;
//   — коды — только подтверждённые человеком (D4), по порядку панели; потом —
//     открытых оплаченных невыданных заказов того же визита, которые кормит этот
//     прибор (D3, решение владельца 2026-10-06, п. 2): без них анализатор не
//     прогонит тесты других услуг пробирки. Повторы кода — один раз.
// @returns {{ok:true, codes:string[], patient:{date_of_birth:string|null, gender:string|null}, specimen:string}
//          | {ok:false, why:string}}
export function worklistLines(db, { deviceId, orderId } = {}) {
  const order = orderId ? db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name, s.specimen AS service_specimen FROM visit_services vs
                                        JOIN services s ON s.id = vs.service_id WHERE vs.id = ?`).get(orderId) : null;
  if (!order) return { ok: false, why: 'заказ по номеру пробы не найден' };
  if (!order.is_lab) return { ok: false, why: 'услуга «' + (order.service_name || order.service_id) + '» не помечена как лабораторная' };
  const gate = gateRefusal(order);
  if (gate) return { ok: false, why: gate };
  if (order.status === 'completed' || isReleased(db, order.id)) return { ok: false, why: 'результат заказа уже выдан' };
  const sender = deviceId ? db.prepare('SELECT profile, name FROM lab_devices WHERE id = ?').get(deviceId) : null;
  if (!sender) return { ok: false, why: 'прибор не найден' };
  const ctx = { deviceId, sender, profile: getProfile(sender.profile), messageModel: null };
  const own = orderSide(db, order, ctx);
  if (!own.ok) return { ok: false, why: own.detail };
  const sides = [own, ...siblingSides(db, order, ctx).filter((s) => !s.closed)];
  const seen = new Set();
  const codes = [];
  for (const s of sides) {
    for (const a of s.analytes.filter(confirmedCode)) {
      const code = String(a.device_code).trim();
      if (seen.has(codeKey(code))) continue;
      seen.add(codeKey(code));
      codes.push(code);
    }
  }
  if (!codes.length) return { ok: false, why: 'у панели нет подтверждённых кодов этого прибора' };
  const patient = db.prepare('SELECT p.date_of_birth, p.gender FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?').get(order.visit_id)
    || { date_of_birth: null, gender: null };
  return { ok: true, codes, patient, specimen: order.service_specimen || '' };
}
