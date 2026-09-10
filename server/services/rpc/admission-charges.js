// ACT_OF_WORKS_V1 (2026-09-10) — АКТ ВЫПОЛНЕННЫХ РАБОТ ГОСПИТАЛИЗАЦИИ.
//
// Владелец: «we need to build the prescription window, and act of done things».
//
// Всё, что начислено пациенту за госпитализацию, УЖЕ КОПИТСЯ в одной таблице —
// admission_services: услуга, расходник со склада, койко-день. Каждая строка
// знает своё количество, цену, сумму, признак «в счёт» и — если счёт выставлен
// — ссылку на строку счёта. Экрана, который бы это показывал, не было: врач и
// касса видели только итог «накоплено к оплате» в обзоре.
//
// ЗДЕСЬ НЕТ НИ ОДНОГО НОВОГО ПРАВИЛА. Этот модуль только ЧИТАЕТ и складывает.
// Кто и что может начислить, как считается проживание, что попадает в счёт —
// решают inventory.js, accommodation.js и billing.js, и переспрашивать их
// здесь значило бы завести вторую версию правила.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. В прототипе владельца у строки есть «источник»
// (стационар / оперблок / анестезия), «тип расхода» и своя скидка. В базе за
// ними сегодня не стоит ничего: оперблок как источник не заведён, скидка живёт
// на счёте, а не на строке. Колонка, которая всегда пуста, — это обещание, а
// не сведения, поэтому её здесь нет.
import { RpcError } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { ACCOMMODATION_NOTE_PREFIX } from '../../../public/js/shared/accommodation-line.js';

/** Кто видит деньги госпитализации — тот же круг, что и у проживания. */
export const CHARGES_READ_ROLES = ['admin', 'head_doctor', 'registrar', 'nurse', 'doctor', 'cashier'];
/** Кто решает, идёт ли строка в счёт: те, кто отвечает за деньги. */
export const CHARGES_WRITE_ROLES = ['admin', 'head_doctor', 'cashier', 'registrar'];

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) throw new RpcError(`${what} закрыт для вашей роли.`, 403);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Род строки. Свой колонки у него нет и не надо: строка либо про услугу
 * (service_id), либо про товар со склада (clinic_item_id), либо про проживание
 * — а проживание узнаётся по метке в notes, как и в accommodation.js.
 */
function lineKind(row) {
  if (row.notes && String(row.notes).startsWith(ACCOMMODATION_NOTE_PREFIX)) return 'stay';
  if (row.clinic_item_id) return 'item';
  return 'service';
}

/**
 * АКТ ВЫПОЛНЕННЫХ РАБОТ: строки и итоги.
 *
 * Итоги считаются ЗДЕСЬ, а не на экране: два места, складывающие деньги,
 * рано или поздно складывают по-разному, и спорить с пациентом придётся о
 * той сумме, которую он увидел.
 */
export function admissionCharges(db, args, user) {
  requireRole(user, CHARGES_READ_ROLES, 'Акт выполненных работ');
  const admissionId = Number(args && args.admission_id) || null;
  if (!admissionId) throw new RpcError('Госпитализация не выбрана.', 400);
  const adm = db.prepare('SELECT id, admission_no, patient_id FROM admissions WHERE id = ?').get(admissionId);
  if (!adm) throw new RpcError('Госпитализация не найдена.', 404);

  const rows = db.prepare(`
    SELECT s.*,
           sv.name        AS service_name,
           st.name        AS service_type_name,
           sv.type        AS service_type_word,
           p.name         AS product_name,
           p.consumption_unit AS product_unit,
           p.category     AS product_category,
           r.name         AS room_name,
           p.base_unit    AS product_base_unit,
           u.full_name    AS doctor_name,
           ii.invoice_id  AS invoice_id,
           inv.invoice_number AS invoice_number,
           inv.status     AS invoice_status
      FROM admission_services s
      LEFT JOIN services  sv  ON sv.id = s.service_id
      LEFT JOIN service_types st ON st.id = sv.type_id
      LEFT JOIN rooms     r   ON r.id  = sv.room_id
      LEFT JOIN products  p   ON p.id  = s.clinic_item_id
      LEFT JOIN users     u   ON u.id  = s.doctor_id
      LEFT JOIN invoice_items ii ON ii.id = s.invoice_item_id
      LEFT JOIN invoices  inv ON inv.id = ii.invoice_id
     WHERE s.admission_id = ?
     ORDER BY COALESCE(s.performed_at, s.created_at), s.id
  `).all(admissionId);

  const lines = rows.map((r) => {
    const kind = lineKind(r);
    return {
      id: r.id,
      kind,
      // Имя берётся у того, чем строка является. Проживание своего имени в
      // справочниках не имеет — оно в метке, и её же видит касса в счёте.
      name: kind === 'stay' ? String(r.notes || '') : (r.service_name || r.product_name || ''),
      unit: kind === 'item' ? (r.product_unit || r.product_base_unit || '') : '',
      // ACT_ADD_SERVICE_V1 — раздел справочника, из которого услуга. По нему
      // вкладки истории болезни отличают анализ от операции; своего признака
      // «это анализ» у строки нет и заводить его значило бы держать вторую
      // правду рядом со справочником.
      service_id: r.service_id || null,
      service_type: r.service_type_name || r.service_type_word || '',
      // ТИП РАСХОДА в акте эталона: медикамент это или изделие. Своего поля у
      // строки нет — категория стоит у ТОВАРА, и берётся она оттуда.
      product_category: r.product_category || '',
      // Кабинет услуги — из справочника: он же стоит в направлении.
      room: r.room_name || '',
      // SERVICE_ORDER_FORM_V1 — «на когда назначено». Это НЕ время выполнения:
      // по нему готовят кабинет, а не считают деньги.
      planned_at: r.planned_at || null,
      // «Оплачен» — свойство СЧЁТА, а не строки: строка знает только, в каком
      // она счёте. Пересчитывать оплату здесь значило бы завести вторую кассу.
      paid: String(r.invoice_status || '') === 'paid',
      status: r.status || '',
      quantity: Number(r.quantity) || 0,
      unit_price: round2(r.unit_price),
      total: round2(r.total),
      billable: !!r.billable,
      doctor_name: r.doctor_name || '',
      at: r.performed_at || r.created_at || null,
      note: kind === 'stay' ? '' : (r.notes || ''),
      invoice_id: r.invoice_id || null,
      invoice_number: r.invoice_number || '',
      invoice_status: r.invoice_status || '',
      // Строка, которая уже в счёте, не правится: за ней деньги (billing.js).
      locked: !!r.invoice_item_id,
    };
  });

  const sum = (f) => round2(lines.filter(f).reduce((a, l) => a + l.total, 0));
  return {
    admission_id: adm.id,
    admission_no: adm.admission_no || '',
    lines,
    totals: {
      // Всё начисленное — включая то, что решили не выставлять: акт показывает
      // работу, а не только деньги.
      accrued: sum(() => true),
      billable: sum((l) => l.billable),
      invoiced: sum((l) => !!l.invoice_id),
      // К выставлению: в счёт идёт, а счёта ещё нет.
      pending: sum((l) => l.billable && !l.invoice_id),
      not_billable: sum((l) => !l.billable),
      lines: lines.length,
    },
  };
}

/** Кто назначает услуги: это клиническое решение, а не кассовое. */
export const SERVICE_ADD_ROLES = ['admin', 'head_doctor', 'doctor'];

/**
 * НАЧИСЛИТЬ ГОСПИТАЛИЗАЦИИ УСЛУГУ — анализ, диагностику, операцию.
 *
 * ACT_ADD_SERVICE_V1 (2026-09-10) — владелец: «add prescription, add analyses
 * and diagnostics, add surgery (get service type surgery from the services
 * list)». До этого начислить госпитализации услугу было НЕЧЕМ: строки заводили
 * только списание со склада и проживание, а всё остальное шло мимо — через
 * обычный визит, как у амбулаторного пациента.
 *
 * ЦЕНА БЕРЁТСЯ ИЗ СПРАВОЧНИКА, а не из аргументов. Цена, присланная экраном, —
 * это цена, которую можно подделать запросом; здесь же деньги.
 *
 * SERVICE_ORDER_FORM_V1 — назначают НА ВРЕМЯ: `planned_at` (миграция 118).
 * Строка при этом остаётся невыполненной — performed_at пуст, — потому что
 * «назначено на завтра» и «сделано» это разные вещи, и акт не должен говорить
 * второе, когда правда первое.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ. Строка начисляет и печатается в акте, но НЕ СТАНОВИТСЯ
 * заданием лаборатории: очередь лаборатории сегодня собирается из визитов
 * (lab_results.visit_service_id), и связать её с госпитализацией — отдельная
 * работа. Пока анализ, назначенный отсюда, лаборатория в своей очереди не
 * увидит; сказать это владельцу честнее, чем нарисовать кнопку, после которой
 * пробирку никто не возьмёт.
 */
export function admissionServiceAdd(db, args, user) {
  requireRole(user, SERVICE_ADD_ROLES, 'Назначение услуги');
  const a = args || {};
  const admissionId = Number(a.admission_id) || null;
  const serviceId = Number(a.service_id) || null;
  if (!admissionId) throw new RpcError('Госпитализация не выбрана.', 400);
  if (!serviceId) throw new RpcError('Услуга не выбрана.', 400);

  const adm = db.prepare('SELECT id, status FROM admissions WHERE id = ?').get(admissionId);
  if (!adm) throw new RpcError('Госпитализация не найдена.', 404);
  if (['discharged', 'cancelled'].includes(adm.status)) {
    throw new RpcError('Госпитализация закрыта — услуги в неё больше не начисляют.', 400);
  }
  const svc = db.prepare('SELECT id, name, price FROM services WHERE id = ?').get(serviceId);
  if (!svc) throw new RpcError('Такой услуги в справочнике нет.', 404);

  const qty = Number(a.quantity);
  const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const price = Number(svc.price) || 0;
  const total = round2(price * quantity);
  const doctorId = Number(a.doctor_id) || (user && user.id) || null;
  const note = a.note === null || a.note === undefined ? null : String(a.note).trim().slice(0, 300) || null;
  // Время принимается только разбираемое: строка, которую не прочесть, в
  // расписании кабинета хуже пустого поля — её никто не заметит.
  const planned = a.planned_at ? new Date(String(a.planned_at)) : null;
  if (planned && Number.isNaN(planned.getTime())) throw new RpcError('Время назначения не разобрано.', 400);
  const plannedAt = planned ? planned.toISOString().slice(0, 19) + 'Z' : null;

  const info = db.prepare(`
    INSERT INTO admission_services (admission_id, service_id, doctor_id, quantity, unit_price, total,
                                    status, billable, notes, planned_at, performed_at)
    VALUES (?,?,?,?,?,?,'added',1,?,?,
            CASE WHEN ? IS NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END)
  `).run(admissionId, serviceId, doctorId, quantity, price, total, note, plannedAt, plannedAt);

  return { line: db.prepare('SELECT * FROM admission_services WHERE id = ?').get(info.lastInsertRowid) };
}

/**
 * ВКЛЮЧИТЬ ИЛИ ИСКЛЮЧИТЬ СТРОКУ ИЗ СЧЁТА.
 *
 * Признак `billable` у строки был с самого начала (миграция 025) и его
 * спрашивает выставление счёта, а поменять его было НЕЧЕМ: расходник,
 * списанный по ошибке или за счёт клиники, оставался в счёте пациента
 * навсегда.
 *
 * Строку, уже попавшую в счёт, не трогаем: за ней деньги. Её сначала убирают
 * из счёта (remove_admission_line_from_invoice) — там же и проверки.
 */
export function admissionChargeSetBillable(db, args, user) {
  requireRole(user, CHARGES_WRITE_ROLES, 'Акт выполненных работ');
  const id = Number(args && args.line_id) || null;
  if (!id) throw new RpcError('Строка не выбрана.', 400);
  const row = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(id);
  if (!row) throw new RpcError('Такой строки в акте нет.', 404);
  if (row.invoice_item_id) {
    throw new RpcError('Строка уже в счёте — сначала уберите её из счёта.', 400);
  }
  const billable = args.billable ? 1 : 0;
  db.prepare('UPDATE admission_services SET billable = ? WHERE id = ?').run(billable, id);
  return { line: db.prepare('SELECT id, billable FROM admission_services WHERE id = ?').get(id) };
}
