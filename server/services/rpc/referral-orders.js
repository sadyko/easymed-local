// DOCTOR_REFERRAL_DESK_V1 (2026-11-02, выпуск 3.21.0) — НАПРАВЛЕНИЯ ВРАЧА В ОКНЕ РЕГИСТРАЦИИ.
//
// Регистратура видела записи колл-центра («из записи», booked-rows.js) и заявки CRM («из
// заявки»), а направление врача — уже выставленное и в очереди — мастер визита молча
// пропускал, быстрая регистрация писала лишь «По записи уже в счёте»; будущие дни и визиты
// «Пришёл» — ничего; «от врача» нигде не было. Рекомендации врача (recommended_services)
// были видны только во вкладке «Услуги» окна визита.
//
// Три вызова:
//   patient_referral_orders({ patient_id }) — ЧТЕНИЕ: открытые строки визитов пациента
//     (своё здание, визит не отменён и не «не пришёл», день визита — сегодня и вперёд,
//     строка не выполнена, не отменена, не возвращена (К5), её счёт не отменён),
//     НАПРАВЛЕННЫЕ ВРАЧОМ: у строки внутренний источник врача (REFERRAL_LINE_V1) или её
//     завёл врач (не стойка — то же правило, что у lineReferralStamp) к ДРУГОМУ исполнителю;
//     плюс открытые рекомендации. В строке — услуга (после замены — новая: строка та же),
//     кто направил, день, состояние счёта (нет / в счёте № / оплачено), рекомендация врача и
//     КОМУ бонус — ИМЕНА, сумм и ставок нет вовсе (решение владельца 2026-11-02: регистратор
//     видит, кому, но не сколько).
//   referral_recommendation_attach({ recommendation_id, visit_service_id }) — ЗАПИСЬ: строка,
//     заведённая по рекомендации, привязывается к ней — рекомендация закрывается («done»,
//     visit_service_id), строке ставится направивший (включённый внутренний источник
//     рекомендовавшего врача; не на его же строку) и рекомендация врача. Доказательство —
//     открытая рекомендация того же пациента и той же услуги. Направившего ВИЗИТА привязка не
//     ставит (visit_set_doctor_referrer, который ставил, снят — ревью полировки M1, N1).
//     Строку, по которой платили, не трогают: её деньги уже поделены. Строк визита этот вызов
//     НЕ заводит (строку вставляет дверь /api/db со своей проверкой повтора DUP_STOP_V1) — одна
//     строка закрывает одну рекомендацию.
//     Ревью U10 (HIGH-1, MEDIUM-2, LOW-8) — доказательство, которое нельзя подделать задним
//     числом: строку завёл сам вызывающий (все три двери — мастер, быстрая регистрация, окно
//     визита — вставляют её прямо перед привязкой), рекомендация написана НЕ ПОЗЖЕ строки, строка
//     и визит живые, месяц оплаты врачей открыт; «кто рекомендовал» ставит сервер (реестр,
//     recommendationAuthorStamp). Направивший строки — источник РЕКОМЕНДОВАВШЕГО, а не того, кто
//     вставил (дверь /api/db ставит вставившему врачу его источник): сам рекомендатель
//     исполняет — никто.
//   referral_visit_links({ visit_ids }) — ЧТЕНИЕ: метка «от врача» календаря — номер визита
//     и имя направившего, без услуг и денег.
//
// «Кому бонус» — lineBeneficiaries (domain/line-referral.js), то же правило, что у отчётов.
// Ревью U10 MEDIUM-3 — оба чтения проходят те же ворота данных пациента, что /api/db
// (patientDataRefusal: разделы роли и вкладки карты), как visit_dup_check (DUP_STOP_V1, M2).
import { hasAnyRole, effectiveRoles } from '../roles.js';
import { today, localDate, localMonth } from '../domain/day.js';
import { lineBeneficiaries, DESK_ROLES, DOCTOR_ROLES } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';   // ревью U10 MEDIUM-3
import { dayVisitOf } from './visits.js';   // ревью U10 LOW-7 — визит дня пациента (то же правило, что у ensure_visit)

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Окна регистрации открывают стойка и врач; касса и медсёстры видят то же (только чтение).
const ORDER_ROLES = ['admin', 'registrar', 'doctor', 'head_doctor', 'cashier', 'nurse', 'senior_nurse'];
// Привязку делают те, кто добавляет услуги из рекомендации в визит: регистратура, врач,
// администратор. Ревью U10 HIGH-1 — медсестра строк визита через /api/db не вставляет (реестр:
// 403), значит и законно привязывать ей нечего; прежде она ставила любой строке стойки источник
// любого врача.
const ATTACH_ROLES = ['admin', 'registrar', 'doctor', 'head_doctor'];
const LINKS_MAX = 500;
const NOTE_MAX = 500;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

const sqlList = (list) => list.map((r) => `'${r}'`).join(', ');
const extraRolesOf = (u) => `json_each(CASE WHEN json_valid(${u}.extra_roles) THEN ${u}.extra_roles ELSE '[]' END)`;
// Сотрудник u — «врач, а не стойка»: то же правило, что у lineReferralStamp (isDoctorActor и не
// isDeskActor). Администратор-врач у стойки (ADMIN_DOCTOR_V1) записывает пациента — это работа
// стойки, а не направление врача.
const DOCTOR_NOT_DESK_SQL = (u) => `((${u}.is_doctor = 1 OR ${u}.role IN (${sqlList(DOCTOR_ROLES)})
        OR EXISTS (SELECT 1 FROM ${extraRolesOf(u)} jd WHERE jd.value IN (${sqlList(DOCTOR_ROLES)})))
    AND ${u}.role NOT IN (${sqlList(DESK_ROLES)})
    AND NOT EXISTS (SELECT 1 FROM ${extraRolesOf(u)} jk WHERE jk.value IN (${sqlList(DESK_ROLES)})))`;
// Строка — «направление врача»: у неё внутренний источник врача, или её завёл врач к ДРУГОМУ
// исполнителю (у врача без источника направившего нет, но направление — есть). Алиасы: vs —
// строка, lrs — её источник, cu — кто завёл.
const DOCTOR_ORDER_SQL = `((lrs.id IS NOT NULL AND lrs.doctor_id IS NOT NULL)
   OR (${DOCTOR_NOT_DESK_SQL('cu')} AND COALESCE(vs.doctor_id, 0) <> cu.id))`;
// К5 — возвращённая строка («Вернуть услугу», и прежняя строка «вернуть и выставить новую»):
// отпущена со счёта с возвратом и не выставлена заново (pay_refund_releases 'out', то же
// правило, что у кассы, журнала и выплаты врачу). Регистратуре её не показывают — иначе она
// выставилась бы снова.
// REFERRAL_LINE_V1 (полировка, п. 10; ревью U10 LOW-D) — КТО «ОТ ВРАЧА» в метке стойки и календаря:
// врач источника строки; иначе — рекомендовавший рекомендацию, которую строка закрыла (врач сам
// исполняет — источника у строки нет, а направил всё равно он, а не вставивший коллега); иначе —
// кто завёл строку. Алиасы: vs — строка, lrs — её источник.
const REFERRER_ID_SQL = `COALESCE(lrs.doctor_id,
         (SELECT rr.recommended_by FROM recommended_services rr
           WHERE rr.visit_service_id = vs.id AND rr.recommended_by IS NOT NULL ORDER BY rr.id LIMIT 1),
         vs.created_by)`;
const NOT_REFUNDED_SQL = `NOT (vs.invoice_item_id IS NULL
         AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))`;

// DOCTOR_REFERRAL_DESK_V1 (полировка 3.21.0; страж domain/no-drift.test.js) — подпись счёта для
// стойки: СОХРАНЁННЫЙ статус счёта (его ставит касса через invoiceStatusFor), а не новая
// «лестница» по суммам: оплачен — «оплачено», любой другой живой — «в счёте».
const BILL_STATE = Object.freeze({ paid: 'paid' });
function billOf(r) {
  if (r.invoice_id == null) return { state: 'none', invoice_id: null, invoice_number: null };
  const own = Object.prototype.hasOwnProperty.call(BILL_STATE, String(r.invoice_status));
  return { state: own ? BILL_STATE[r.invoice_status] : 'invoiced', invoice_id: r.invoice_id,
           invoice_number: r.invoice_number || String(r.invoice_id) };
}
const namesOf = (bens, baseName, lineName) => bens.map((b) => (b.via === 'visit' ? baseName : lineName)).filter(Boolean);

/** patient_referral_orders({ patient_id }) → { patient_id, today, lines, recommendations } */
export function patientReferralOrders(db, args, user) {
  if (!hasAnyRole(user, ORDER_ROLES)) throw new RpcError('Направления врача вашей роли недоступны.', 403);
  // Ревью U10 MEDIUM-3 — строки визита и рекомендации врача — данные пациента: роль, которой
  // клиника закрыла клинические разделы (склад, своя роль), их через /api/db не читает — и здесь
  // тоже (услуги, исполнители, направившие, рекомендация врача, номера счетов и цены).
  if (patientDataRefusal('visit_services', user, db) || patientDataRefusal('recommended_services', user, db)) {
    throw new RpcError(PATIENT_DATA_DENIED, 403);
  }
  const patientId = Number(args && args.patient_id);
  if (!isPosInt(patientId)) throw new RpcError('Пациент указан неверно.', 400);
  const day = today(db);
  const lines = db.prepare(`
    SELECT vs.id AS visit_service_id, vs.visit_id, ${localDate('v.visit_date')} AS day,
           vs.scheduled_at, v.status AS visit_status, vs.service_id, vs.consultation_type_id,
           COALESCE(s.name, ct.name_ru, ct.name, '') AS name, vs.quantity, vs.unit_price, vs.doctor_id,
           COALESCE(NULLIF(pu.full_name, ''), pu.username) AS doctor_name,
           vs.status, vs.referral_note, vs.referred_by_source_id,
           lrs.name AS line_source_name, lrs.doctor_id AS line_source_doctor_id,
           ${REFERRER_ID_SQL} AS referrer_id,
           COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '') AS referrer_name,
           bs.id AS base_source_id, bs.name AS base_source_name, bs.doctor_id AS base_source_doctor_id,
           i.id AS invoice_id, i.invoice_number, i.status AS invoice_status
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      JOIN patients pt ON pt.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users pu ON pu.id = vs.doctor_id
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN users ru ON ru.id = ${REFERRER_ID_SQL}
      LEFT JOIN referral_sources bs ON bs.id = COALESCE(v.referral_source_id, pt.referral_source_id)
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i ON i.id = ii.invoice_id
     WHERE v.patient_id = ?
       AND v.sync_origin IS NULL AND vs.sync_origin IS NULL
       AND v.status NOT IN ('cancelled', 'no_show')
       AND ${localDate('v.visit_date')} >= ?
       AND vs.clinic_item_id IS NULL
       AND vs.status NOT IN ('completed', 'cancelled', 'removed')
       -- Без счёта — только 'added', как строки «из записи» (booked-rows.js): строку без счёта,
       -- по которой уже идёт работа, выставляет касса («Ждут счёта»), а не регистратура.
       AND (vs.invoice_item_id IS NOT NULL OR vs.status = 'added')
       AND (i.id IS NULL OR i.status NOT IN ('void', 'refunded'))
       AND ${NOT_REFUNDED_SQL}
       AND ${DOCTOR_ORDER_SQL}
     ORDER BY day, COALESCE(vs.scheduled_at, v.visit_date), vs.id`).all(patientId, day)
    .map((r) => ({
      visit_service_id: r.visit_service_id, visit_id: r.visit_id, day: r.day, scheduled_at: r.scheduled_at || null,
      visit_status: r.visit_status, service_id: r.service_id ?? null, consultation_type_id: r.consultation_type_id ?? null,
      name: r.name || '', quantity: Number(r.quantity) || 1, unit_price: Number(r.unit_price) || 0,
      doctor_id: r.doctor_id ?? null, doctor_name: r.doctor_name || '', status: r.status,
      referrer_id: r.referrer_id ?? null, referrer_name: r.referrer_name || '',
      referral_note: r.referral_note || '',
      bill: billOf(r),
      bonus_to: namesOf(lineBeneficiaries(
        r.base_source_id != null ? { id: r.base_source_id, doctor_id: r.base_source_doctor_id } : null,
        r.referred_by_source_id != null ? { id: r.referred_by_source_id, doctor_id: r.line_source_doctor_id } : null,
        r.doctor_id), r.base_source_name, r.line_source_name),
    }));
  // Ревью U10 LOW-7 — «Бонус: …» у рекомендации — то, что заплатит расчёт: база — источник
  // СЕГОДНЯШНЕГО визита пациента (строку по рекомендации стойка ставит в него, dayVisitOf — то же
  // правило, что у ensure_visit), иначе карточки пациента. Исполнитель ещё не выбран: источник
  // рекомендателя назван отдельно (bonus_if_other) — он получит бонус, только если услугу выполнит
  // другой врач (своя строка — без бонуса); получатель «через визит» — без условия.
  // Ревью полировки L2 (проба PB3) — направивший визита, которого вариант «б» на строке заменяет
  // рекомендателем, получает бонус, если рекомендатель выполнит услугу сам (своя строка — платится
  // визит): он назван своим условием (bonus_if_self). Так подпись называет всех, кому могут
  // заплатить; имена, без сумм.
  const dv = dayVisitOf(db, patientId, day);
  const base = db.prepare(`SELECT id, name, doctor_id FROM referral_sources
                            WHERE id = COALESCE(?, (SELECT referral_source_id FROM patients WHERE id = ?))`)
    .get(dv ? dv.referral_source_id ?? null : null, patientId) || null;
  const recommendations = db.prepare(`
    SELECT r.id AS recommendation_id, r.service_id, COALESCE(s.name, r.service_name, '') AS name,
           r.recommended_by AS referrer_id,
           COALESCE(NULLIF(u.full_name, ''), NULLIF(r.recommended_by_name, ''), u.username, '') AS referrer_name,
           r.created_at, r.notes, r.source_visit_id,
           rs.id AS rec_source_id, rs.name AS rec_source_name, rs.doctor_id AS rec_source_doctor_id
      FROM recommended_services r
      LEFT JOIN services s ON s.id = r.service_id
      LEFT JOIN users u ON u.id = r.recommended_by
      LEFT JOIN referral_sources rs ON rs.id = (SELECT x.id FROM referral_sources x WHERE x.doctor_id = r.recommended_by AND x.active = 1 ORDER BY x.id LIMIT 1)
     WHERE r.patient_id = ? AND r.closed_at IS NULL AND COALESCE(r.status, '') NOT IN ('done', 'cancelled')
     ORDER BY r.created_at DESC, r.id DESC`).all(patientId)
    .map((r) => {
      const baseSrc = base ? { id: base.id, doctor_id: base.doctor_id } : null;
      const recSrc = r.rec_source_id != null ? { id: r.rec_source_id, doctor_id: r.rec_source_doctor_id } : null;
      const bens = lineBeneficiaries(baseSrc, recSrc, null);   // выполнит другой врач
      const selfBens = recSrc && recSrc.doctor_id != null ? lineBeneficiaries(baseSrc, recSrc, recSrc.doctor_id) : bens;   // ревью полировки L2 — сам рекомендатель
      const viaVisit = (list) => list.some((b) => b.via === 'visit');
      const ifOther = bens.some((b) => b.via === 'line') ? (r.rec_source_name || r.referrer_name || null) : null;
      const ifSelf = !viaVisit(bens) && viaVisit(selfBens) ? (base ? base.name : null) : null;
      return {
        recommendation_id: r.recommendation_id, service_id: r.service_id ?? null, name: r.name || '',
        referrer_id: r.referrer_id ?? null, referrer_name: r.referrer_name || '', created_at: r.created_at,
        notes: r.notes || '', source_visit_id: r.source_visit_id ?? null,
        bonus_to: namesOf(bens.filter((b) => b.via === 'visit'), base ? base.name : null, null),
        bonus_if_other: ifOther,
        bonus_if_self: ifSelf || null,
      };
    });
  return { patient_id: patientId, today: day, lines, recommendations };
}

/** referral_recommendation_attach({ recommendation_id, visit_service_id }) → { attached, …, referred_by_source_id } */
export function referralRecommendationAttach(db, args, user) {
  if (!hasAnyRole(user, ATTACH_ROLES)) {
    throw new RpcError('Добавлять рекомендации врача в визит может регистратура, врач или администратор.', 403);
  }
  const recId = Number(args && args.recommendation_id);
  const vsId = Number(args && args.visit_service_id);
  if (!isPosInt(recId)) throw new RpcError('Рекомендация указана неверно.', 400);
  if (!isPosInt(vsId)) throw new RpcError('Строка услуги указана неверно.', 400);
  const run = db.transaction(() => {
    const rec = db.prepare('SELECT * FROM recommended_services WHERE id = ?').get(recId);
    if (!rec) throw new RpcError('Рекомендация не найдена.', 404);
    if (rec.closed_at != null || rec.status === 'done' || rec.status === 'cancelled') {
      throw new RpcError('Рекомендация уже закрыта — её добавили в визит или убрали.', 409);
    }
    // REFERRAL_LINE_V1 (полировка, п. 9; ревью U10 LOW-C) — рекомендация, уже привязанная к строке,
    // ко второй не привязывается, даже если её «открыли» заново правкой статуса через /api/db:
    // одна рекомендация — одно направление («Внутренние врачи» считали её дважды).
    if (rec.visit_service_id != null && Number(rec.visit_service_id) !== vsId) {
      throw new RpcError('Рекомендация уже привязана к другой строке услуги.', 409);
    }
    const line = db.prepare(`SELECT vs.*, v.patient_id AS visit_patient_id, v.sync_origin AS visit_origin,
                                    v.status AS visit_status, ${localMonth('v.visit_date')} AS visit_month
                               FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.id = ?`).get(vsId);
    if (!line) throw new RpcError('Строка услуги не найдена.', 404);
    if (Number(line.visit_patient_id) !== Number(rec.patient_id)) throw new RpcError('Строка услуги — у другого пациента.', 400);
    if (rec.service_id == null || Number(line.service_id) !== Number(rec.service_id)) {
      throw new RpcError('Услуга строки не та, что в рекомендации.', 400);
    }
    if (line.visit_origin != null || line.sync_origin != null) {
      throw new RpcError('Строка услуги заведена в другом здании — привязать рекомендацию можно только там.', 400);
    }
    // Ревью U10 HIGH-1 — привязывают к строке, которую вызывающий сам только что завёл (created_by
    // ставит сервер из сессии — реестр, stamps): все три двери вставляют её прямо перед привязкой.
    // Иначе любой врач писал рекомендацию задним числом и ставил свой источник на строку стойки,
    // ждущую оплаты, — клиника платила за одну строку дважды. Прежнее «врач — только свою
    // рекомендацию» снято: рекомендацию коллеги, написанную раньше строки, привязать можно —
    // направившим станет коллега (ниже), а не вставивший.
    if (line.created_by == null || Number(line.created_by) !== Number(user && user.id)) {
      throw new RpcError('Рекомендацию привязывают к строке, которую вы только что добавили в визит, — эту строку завёл другой сотрудник.', 403);
    }
    // Ревью U10 LOW-8 — строка и визит, которые бонуса не дают, рекомендацию не закрывают.
    if (line.status === 'cancelled' || line.status === 'removed') {
      throw new RpcError('Строка услуги отменена или снята — рекомендацию к ней не привязывают.', 409);
    }
    if (line.invoice_item_id == null
        && db.prepare("SELECT 1 FROM pay_refund_releases WHERE kind = 'out' AND line_id = ? LIMIT 1").get(vsId)) {
      throw new RpcError('Услуга этой строки возвращена — рекомендацию к ней не привязывают.', 409);
    }
    if (line.visit_status === 'cancelled' || line.visit_status === 'no_show') {
      throw new RpcError('Визит отменён или пациент не пришёл — рекомендацию к нему не привязывают.', 409);
    }
    // Одна строка — одна рекомендация: «Внутренние врачи» считают строку той рекомендацией,
    // которую она закрыла (rpc/referrals.js lineReferrals), — две закрытые одной строкой были
    // бы двумя направлениями за одну услугу.
    if (db.prepare('SELECT 1 FROM recommended_services WHERE visit_service_id = ? AND id <> ? LIMIT 1').get(vsId, recId)) {
      throw new RpcError('Эта строка услуги уже закрывает другую рекомендацию.', 409);
    }
    // Ревью U10 HIGH-1 — рекомендация — причина строки, значит она не моложе строки (секунда в
    // секунду — можно: обе пишутся в один миг).
    if (db.prepare('SELECT julianday(?) > julianday(?) AS newer').get(rec.created_at, line.created_at).newer === 1) {
      throw new RpcError('Рекомендация написана позже, чем заведена строка услуги, — к этой строке её не привязывают.', 409);
    }
    const paid = line.invoice_item_id != null && db.prepare(`SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.id = ? AND (COALESCE(i.paid_amount, 0) > 0 OR i.status IN ('paid', 'partial'))`).get(line.invoice_item_id);
    if (paid) throw new RpcError('По этой строке уже есть оплата — направившего у неё не меняют.', 409);
    // Ревью U10 LOW-8 — закрытый месяц оплаты врачей заморожен (то же правило и те же слова, что
    // у замены и возврата строки — billing.js assertLineMonthOpen: местный месяц дня визита).
    if (line.visit_month && db.prepare('SELECT 1 FROM pay_periods WHERE month = ?').get(line.visit_month)) {
      throw new RpcError('Начисления врачам за этот месяц закрыты — услуги визита этого месяца уже не меняют.', 409);
    }
    // Ревью U10 MEDIUM-2 — направивший строки — включённый источник РЕКОМЕНДОВАВШЕГО (recommended_by
    // ставит сервер — реестр, recommendationAuthorStamp), а не того, кто вставил строку: дверь
    // /api/db ставит вставившему врачу его собственный источник, и врач, добавивший рекомендацию
    // коллеги, получал за неё бонус. Рекомендатель сам исполняет (своя строка), у него нет
    // включённого источника или рекомендацию писал не врач — направившего у строки нет.
    let stamped = null;
    if (rec.recommended_by != null) {
      const src = db.prepare('SELECT id, doctor_id FROM referral_sources WHERE doctor_id = ? AND active = 1 ORDER BY id LIMIT 1').get(rec.recommended_by);
      if (src && !(line.doctor_id != null && Number(line.doctor_id) === Number(src.doctor_id))) stamped = Number(src.id);
    }
    if ((line.referred_by_source_id ?? null) !== stamped) {
      db.prepare('UPDATE visit_services SET referred_by_source_id = ? WHERE id = ?').run(stamped, vsId);
    }
    const note = typeof rec.notes === 'string' ? rec.notes.trim().slice(0, NOTE_MAX) : '';
    if (note && (line.referral_note == null || line.referral_note === '')) {
      db.prepare('UPDATE visit_services SET referral_note = ? WHERE id = ?').run(note, vsId);
    }
    db.prepare(`UPDATE recommended_services SET status = 'done', closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), visit_service_id = ?
                 WHERE id = ?`).run(vsId, recId);
    return { attached: true, recommendation_id: recId, visit_service_id: vsId, referred_by_source_id: stamped };
  });
  return run();
}

/** referral_visit_links({ visit_ids }) → [{ visit_id, doctor_name }] */
export function referralVisitLinks(db, args, user) {
  if (!user || !effectiveRoles(user).length) throw new RpcError('Метки направлений врача вашей роли недоступны.', 403);
  // Ревью U10 MEDIUM-3 — кто направил на визит — данные строк визита: роль, которой /api/db их не
  // отдаёт (колл-центр, лаборатория, склад), меток не получает — иначе перебирала бы по 500 номеров
  // визитов за вызов. Пустой ответ, а не отказ: календарь рисуется и без меток.
  if (patientDataRefusal('visit_services', user, db)) return [];
  const raw = Array.isArray(args && args.visit_ids) ? args.visit_ids : [];
  const ids = [...new Set(raw.map(Number).filter(isPosInt))].slice(0, LINKS_MAX);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT vs.visit_id AS visit_id, MIN(COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '')) AS doctor_name
      FROM visit_services vs
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN users ru ON ru.id = ${REFERRER_ID_SQL}
     WHERE vs.visit_id IN (${ids.map(() => '?').join(',')})
       AND vs.clinic_item_id IS NULL
       AND vs.status NOT IN ('cancelled', 'removed')
       AND ${NOT_REFUNDED_SQL}
       AND ${DOCTOR_ORDER_SQL}
     GROUP BY vs.visit_id
     ORDER BY vs.visit_id`).all(...ids);
}
