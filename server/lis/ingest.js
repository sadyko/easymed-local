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
 * «результаты внесены» ровно в статус до прибора (lis_status_before);
 * неизвестен — «в работе», не «ждёт оплату» и не «ждёт забора».
 * @returns {{fromOrderId:number|null, taken:string[], kept:Array<{name:string, why:string}>,
 *            legacy:boolean, unlinked:boolean, status:string|null}}
 *   status — куда вернулся первый заказ, если его бланк опустел.
 */
export function takeBackValues(db, msg, toOrderId) {
  const out = { fromOrderId: null, taken: [], kept: [], legacy: false, unlinked: false, status: null };
  const fromId = msg && msg.visit_service_id;
  if (!fromId || Number(fromId) === Number(toOrderId)) return out;
  out.fromOrderId = fromId;

  const mine = db.prepare('SELECT * FROM lab_results WHERE visit_service_id = ? AND source_message_id = ? ORDER BY id').all(fromId, msg.id);
  if (mine.length) {
    // Ревью R3, п. 8 — «выдан» — по ЗАКАЗУ, как у правила выдачи (D7 в приёме):
    // выдан хоть один показатель — бланк заказа не трогается.
    const released = db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(fromId).c > 0;
    const order = db.prepare('SELECT service_id FROM visit_services WHERE id = ?').get(fromId);
    const panel = order && db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
    const analytes = panel ? db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id) : [];
    let others = null;
    for (const row of mine) {
      if (released) { out.kept.push({ name: row.parameter, why: 'выдан' }); continue; }
      const a = analytes.find((x) => x.name === row.parameter);
      const sent = a ? deliveredValue(db, msg, a) : null;
      // Ревью R3, п. 10 — «390.10» и «390.1» — одно значение.
      if (row.source !== 'analyzer' || sent == null || !sameValue(row.value, sent)) {
        out.kept.push({ name: row.parameter, why: sent == null && row.source === 'analyzer' ? 'не удалось сверить с сообщением' : 'изменено после прибора' });
        continue;
      }
      if (!others) {
        others = db.prepare(`SELECT id, raw, device_id, detail FROM lab_device_messages
                              WHERE visit_service_id = ? AND id <> ? AND kind = 'result' AND status IN ('applied', 'unmapped')
                                AND instr(COALESCE(detail, ''), ?) = 0
                              ORDER BY id DESC LIMIT ?`).all(fromId, msg.id, REATTACHED_NOTE, SERIES_MAX_MESSAGES)
          .filter((r) => !BEFORE_BLANK.test(String(r.detail || '')));
      }
      if (others.some((o) => { const v = deliveredValue(db, o, a); return v != null && sameValue(v, sent); })) {
        out.kept.push({ name: row.parameter, why: 'то же значение пришло другим сообщением' });
        continue;
      }
      db.prepare('DELETE FROM lab_results WHERE id = ?').run(row.id);
      out.taken.push(row.parameter);
    }
  }
  out.legacy = ['applied', 'unmapped'].includes(msg.status) && !BEFORE_BLANK.test(String(msg.detail || ''))
    && db.prepare("SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND source = 'analyzer' AND source_message_id IS NULL").get(fromId).c > 0;
  // Ревью R3, п. 9; R4, п. B — строка уходит с первого заказа, только когда её
  // значений там не осталось: иначе её след держал бы кассу зря («по услуге
  // уже пришли данные анализатора»), а лента показывала бы имя его пациента.
  // История — в журнале строки: куда перепривязана и откуда.
  out.unlinked = !out.kept.length && !out.legacy;
  const note = REATTACHED_NOTE + toOrderId + (out.unlinked ? ' (был заказ № ' + fromId + ')' : ' (значения остались в заказе № ' + fromId + ')');
  db.prepare(`UPDATE lab_device_messages SET visit_service_id = CASE WHEN ? THEN NULL ELSE visit_service_id END,
                detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || '; ' || ? END WHERE id = ?`)
    .run(out.unlinked ? 1 : 0, note, note, msg.id);

  if (out.taken.length) {
    // Примечание без значения («гемолиз») — тоже содержимое бланка (п. C).
    const left = db.prepare(`SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ?
                               AND (TRIM(COALESCE(value, '')) <> '' OR TRIM(COALESCE(notes, '')) <> '')`).get(fromId).c;
    const ord = db.prepare('SELECT status, lis_status_before FROM visit_services WHERE id = ?').get(fromId);
    if (!left && ord && ord.status === 'resulted') {
      out.status = ord.lis_status_before && ord.lis_status_before !== 'resulted' ? ord.lis_status_before : 'in_progress';
      db.prepare("UPDATE visit_services SET status = ?, lis_status_before = NULL WHERE id = ? AND status = 'resulted'").run(out.status, fromId);
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
  // LIS_REAL_ANALYZERS_V1 (ревью R3, п. 7) — opts.report: чем кончился приём
  // (статус строки, её номер, сколько строк бланка записано) — привязка из
  // лотка снимает значения из прежнего заказа, только если новый их принял.
  const record = (o) => {
    const id = recordMessage(db, manual ? { ...o, detail: o.detail ? o.detail + '; ' + MANUAL : MANUAL } : o);
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
  const device = deviceId ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const profile = device ? getProfile(device.profile) : null;
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — и по тому, как сообщение называет
  // себя (MSH-3/4): BS-200 на строке без профиля или с чужим профилем не
  // читает OBR-3; при споре профиля и сообщения — безопасный провод.
  const head = mshOf(raw);
  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 12) — спор профиля и сообщения ниже
  // кладёт сообщение в лоток; безопасный провод — для номера человеку.
  const decision = opts.wire ? { wire: opts.wire, conflict: false } : wireDecision({ profile, facility: head.facility, app: head.app });
  const wire = decision.wire;
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
  const sender = deviceId ? db.prepare('SELECT profile, name FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const panelDev = db.prepare('SELECT profile, name, sending_app, sending_facility FROM lab_devices WHERE id = ?').get(panel.device_id);
  const panelProfile = panelDev ? getProfile(panelDev.profile) : null;
  const messageModel = guessProfile({ app: head.app, facility: head.facility });
  const panelModel = panelDev ? guessProfile({ app: panelDev.sending_app, facility: panelDev.sending_facility }) : null;
  const perInstrumentOf = (p) => !!(p && p.codesPerInstrument);
  const pi = [profile, panelProfile, messageModel, panelModel].find(perInstrumentOf) || null;
  // Модель узнана по имени, а строка заведена другой моделью: человек правит
  // модель в «Анализаторах» — тогда и экран «Панели» покажет, что подтверждать.
  const misnamed = (row, p) => '; в «Анализаторах» прибор «' + row.name + '» заведён как '
    + (p ? p.model : 'прибор без модели') + ', а называет себя ' + pi.model + ' — исправьте модель прибора';
  let mislabel = '';
  if (pi && sender && perInstrumentOf(messageModel) && !perInstrumentOf(profile)) mislabel = misnamed(sender, profile);
  else if (pi && panelDev && perInstrumentOf(panelModel) && !perInstrumentOf(panelProfile)) mislabel = misnamed(panelDev, panelProfile);
  if (!deviceId && pi) {
    record({ ...base, visitServiceId: linkId, status: 'unmatched',
      detail: 'прибор этого сообщения неизвестен (его строку удалили или он не заведён), а панель «' + panel.name + '» кормит '
        + pi.model + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '') + ': у ' + pi.model + ' номер теста свой у каждого прибора'
        + ' — значения не записаны; внесите их вручную или пришлите пробу с прибора ещё раз' + mislabel });
    return 'AA';
  }
  if (deviceId && panel.device_id !== deviceId) {
    const sameModel = sender && panelDev && sender.profile && sender.profile === panelDev.profile;
    if (!sameModel) {
      record({ ...base, visitServiceId: linkId, status: 'unmatched',
        detail: 'панель «' + panel.name + '» кормится анализатором другой модели'
          + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '') });
      return 'AA';
    }
    // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 1) — у BS-200 номер теста свой у
    // каждого прибора (ItemID.ini): «2» второго BS-200 бывает креатинином, и
    // подмена «та же модель» положила бы его в строку «Глюкоза» панели первого.
    // У такого профиля (codesPerInstrument) панель кормит только свой прибор.
    if (pi) {
      record({ ...base, visitServiceId: linkId, status: 'unmatched',
        detail: 'панель «' + panel.name + '» привязана к другому анализатору той же модели'
          + (panelDev && panelDev.name ? ' («' + panelDev.name + '»)' : '')
          + ': у ' + pi.model + ' номер теста свой у каждого прибора — значения этого прибора в её бланк не идут;'
          // Ревью R3, пп. 2 и 3 — что делать: у услуги панель одна
          // (lab_panels.service_id UNIQUE), «заведите свою» было невозможно.
          + ' если это тот же анализатор с новым адресом — в «Лаборатория → Панели» выберите для панели этот прибор'
          + ' и заново подтвердите номера тестов, потом «Привязать»; если это второй ' + pi.model
          + ' — номера тестов у него свои: его результаты вносятся вручную или нужна отдельная услуга со своей панелью' + mislabel });
      return 'AA';
    }
  }

  // D7 — выданный бланк молча не переписывается. Проверка ДО записи: замещать
  // черновик помощь, замещать выданный отчёт пациента — другое дело.
  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 14) — здесь заказ привязывается и у
  // голого номера: он уже прошёл правило «открытый заказ последних 7 дней» и
  // проверки панели и модели — это обычное совпадение, как у этикетки. Пункт
  // 3 R1 снимает привязку только у ОТКАЗАННЫХ голых номеров (выше).
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
  //
  // LIS_REAL_ANALYZERS_V1 (ревью R4, п. A) — у прибора с номерами тестов,
  // своими у каждого прибора (pi выше), подтверждение действует, только если
  // дано для прибора панели (device_code_confirmed_device_id, мигр. 233).
  // Данное для другого прибора — и до мигр. 233 (NULL) — здесь «не
  // подтверждено»: значение в бланк не идёт (D4), проба — в лоток с причиной.
  // У кодов производителя отметка не читается.
  const rawAnalytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id);
  const stale = pi ? rawAnalytes.filter((a) => a.device_code_confirmed && String(a.device_code == null ? '' : a.device_code).trim()
    && a.device_code_confirmed_device_id !== panel.device_id) : [];
  const analytes = stale.length ? rawAnalytes.map((a) => (stale.includes(a) ? { ...a, device_code_confirmed: 0 } : a)) : rawAnalytes;
  const plan = planObservations(observations, analytes);
  const codeKey = (s) => String(s == null ? '' : s).trim().toUpperCase();
  const staleHit = stale.filter((a) => plan.unconfirmed.some((o) => codeKey(o.code) === codeKey(a.device_code) || codeKey(o.name) === codeKey(a.device_code)));
  const staleText = staleHit.length ? STALE_DETAIL + staleHit.map((a) => a.name + ' (' + String(a.device_code).trim() + ')').join(', ') + mislabel : '';

  let applied = 0;
  const writtenIds = [];   // ревью R4, п. B — строки бланка, записанные этим сообщением
  // LIS_REAL_ANALYZERS_V1_SERIES — прибор шлёт по тесту в сообщении.
  const seriesOn = !!(profile && profile.oneTestPerMessage && plan.fills.length > 0);
  const perInstrument = !!pi;   // ревью R2, п. 1; R4, п. A — по любому из четырёх
  // Ревью R3, п. 6 — fresh: только записанные не раньше суток назад — ими
  // судится «бланк полон»; «повтор» — против любого значения прибора в бланке.
  const analyzerValues = ({ fresh = false } = {}) => new Map(db.prepare(`SELECT parameter, value FROM lab_results
                                                    WHERE visit_service_id = ? AND source = 'analyzer' AND TRIM(COALESCE(value, '')) <> ''
                                                      AND (? = 0 OR entered_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?))`)
    .all(order.id, fresh ? 1 : 0, sinceArg(SERIES_FORM_MAX_AGE_MS)).map((r) => [r.parameter, r.value]));

  const run = db.transaction(() => {
    // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 5) — значения прибора в бланке ДО
    // записи: против них судится «повтор» — в любом окне.
    const before = seriesOn ? analyzerValues() : null;
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
        writtenIds.push(existing.id);
      } else {
        writtenIds.push(db.prepare(`INSERT INTO lab_results
                      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
          .run(order.id, a.name, obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag).lastInsertRowid);
      }
      applied++;
    }

    if (applied > 0 && order.status !== 'completed') {
      // Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
      // sample_collected_at не подставляем: времени забора мы не наблюдали, и
      // выдумать его значило бы записать в карту факт, которого не было.
      // LIS_REAL_ANALYZERS_V1 (ревью R4, п. C) — статус, из которого прибор
      // перевёл заказ в «результаты внесены», запоминается: «Привязать» к
      // другому заказу, опустошившее бланк, вернёт ровно его. Уже стоящий
      // «результаты внесены» прибор не переводил — запомненное не трогается.
      db.prepare(`UPDATE visit_services SET lis_status_before = CASE WHEN status = 'resulted' THEN lis_status_before ELSE status END,
                    status = 'resulted' WHERE id = ?`).run(order.id);
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
    let disputes = null;   // ревью R4, п. D
    if (seriesOn) {
      const who = { orderId: order.id, deviceId, perInstrument, profileKey: device.profile };
      const { members, overflow } = seriesMembers(db, { ...who, profile, analytes });
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
        // поднимается снова (п. 6).
        const written = new Set(analyzerValues({ fresh: true }).keys());   // ревью R3, п. 6
        const series = planSeries([...members.map((m) => m.observations), observations], analytes, { written, before });
        const seen = dismissedChange(db, order.id);
        series.changed = series.changed.filter((c) => !seen(c));
        // Ревью R4, п. D — спор этой строки структурой: по ней его узнают,
        // когда человек его разберёт.
        if (series.changed.length) disputes = JSON.stringify(series.changed.map(disputeOf));
        const r = seriesOutcome(series);
        status = r.status;
        detail = r.pending ? SERIES_PENDING_PREFIX + r.detail : r.detail;
        // Бланк полон — ожидание строк «ждём» этого заказа кончилось: они
        // становятся applied в этой же транзакции, в любом окне и даже если у
        // этого сообщения свой спор (он — в его строке). Строки, которых
        // коснулся человек («Привязать», «Отклонить» ставят resolved_at), не
        // трогаются. Сырое не трогается никогда.
        if (!series.missing.length && series.filled.length) accepted = waitingRows(db, who);
      }
    }

    // Ревью R4, п. A — подтверждено для другого прибора: что делать.
    if (staleText) detail = (detail ? detail + '; ' : '') + staleText;
    const id = record({ ...base, visitServiceId: order.id, status, detail, disputes });
    // Ревью R4, п. B — у записанного — номер этой строки лотка.
    for (const rid of writtenIds) db.prepare('UPDATE lab_results SET source_message_id = ? WHERE id = ?').run(id, rid);
    for (const m of accepted) {
      db.prepare("UPDATE lab_device_messages SET status = 'applied', detail = ? WHERE id = ? AND status = 'unmapped' AND resolved_at IS NULL")
        .run('принято серией (сообщение № ' + id + ')' + (m.detail.endsWith(MANUAL) ? '; ' + MANUAL : ''), m.id);
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
