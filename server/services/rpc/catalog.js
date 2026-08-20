// SERVICE_DELETE_V1 — removing a service from the price list.
//
// Until now `services` had no delete at all (schema-registry granted the delete
// verb to no role) and the UI only offered «active = 0». That is right for a
// service the clinic has actually used — its name is what an old invoice line
// and an old visit record point at, and deleting the row would either be
// refused by SQLite's foreign keys or leave a patient's billing history naming
// nothing. It is wrong for the mistyped «test lab» rows every clinic
// accumulates while setting the catalogue up, which can never be cleaned away.
//
// So deletion is conditional, and the condition is history:
//
//   BLOCKED  — the service appears in a visit, an invoice, an inpatient stay, a
//              printed queue ticket, a lab panel, or a CRM lead. These are
//              records of things that happened; the caller is told what is
//              holding the service and pointed at deactivation instead.
//   ALLOWED  — nothing references it but pure configuration (a doctor's rate
//              for it, a "recommended service" link). Those rows exist only to
//              describe the service, so they go with it, in one transaction.
//
// Deactivation is not a lesser outcome — it is the correct one for a used
// service, and stays available from the same modal.

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// Tables whose rows are RECORDS OF EVENTS. A reference from any of these means
// the service is part of the clinic's history and must survive as a name.
// `label` is user-facing (Russian, like the rest of the admin UI).
const HISTORY_REFS = [
  { table: 'visit_services',        label: 'визиты' },
  { table: 'invoice_items',         label: 'счета' },
  { table: 'admission_services',    label: 'госпитализации' },
  { table: 'service_queue_tickets', label: 'талоны очереди' },
  { table: 'lab_panels',            label: 'лабораторные панели' },
  { table: 'crm_requests',          label: 'заявки CRM' },
];

// Pure configuration ABOUT the service — meaningless once it is gone.
const CONFIG_REFS = ['doctor_rates', 'recommended_services'];

/**
 * delete_service — hard-delete a service that has no history.
 * args: { p_service_id }  ->  { deleted: true, name }
 * Refuses with 409 and a per-table breakdown when history exists.
 */
export function deleteService(db, args, user) {
  if (!user || user.role !== 'admin') {
    throw new RpcError('Удалять услуги может только администратор.', 403);
  }

  const id = Number(args && (args.p_service_id ?? args.service_id));
  if (!Number.isInteger(id) || id <= 0) {
    throw new RpcError('p_service_id must be a positive integer.', 400);
  }

  const svc = db.prepare('SELECT id, name FROM services WHERE id = ?').get(id);
  if (!svc) throw new RpcError('Услуга не найдена.', 404);

  const blocking = [];
  for (const ref of HISTORY_REFS) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE service_id = ?`).get(id);
    if (n > 0) blocking.push({ ...ref, count: n });
  }

  if (blocking.length) {
    const detail = blocking.map((b) => `${b.label}: ${b.count}`).join(', ');
    // 409, not 400: the request is well-formed, the state forbids it.
    throw new RpcError(
      `Услуга «${svc.name}» уже используется (${detail}) — её нельзя удалить без потери истории. ` +
      'Отключите её: она исчезнет из списков, а прошлые записи останутся целыми.',
      409,
    );
  }

  const run = db.transaction(() => {
    for (const table of CONFIG_REFS) {
      db.prepare(`DELETE FROM "${table}" WHERE service_id = ?`).run(id);
    }
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
  });
  run();

  return { deleted: true, id, name: svc.name };
}

/**
 * service_delete_check — what would happen, without doing it. Lets the UI show
 * «удалить навсегда» vs «отключить» before the registrar commits to a click,
 * rather than offering delete and then explaining it was never possible.
 * args: { p_service_id }  ->  { deletable, blocking: [{table,label,count}], name }
 */
export function serviceDeleteCheck(db, args, user) {
  if (!user || user.role !== 'admin') {
    throw new RpcError('Удалять услуги может только администратор.', 403);
  }
  const id = Number(args && (args.p_service_id ?? args.service_id));
  if (!Number.isInteger(id) || id <= 0) {
    throw new RpcError('p_service_id must be a positive integer.', 400);
  }
  const svc = db.prepare('SELECT id, name FROM services WHERE id = ?').get(id);
  if (!svc) throw new RpcError('Услуга не найдена.', 404);

  const blocking = [];
  for (const ref of HISTORY_REFS) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE service_id = ?`).get(id);
    if (n > 0) blocking.push({ table: ref.table, label: ref.label, count: n });
  }
  return { name: svc.name, deletable: blocking.length === 0, blocking };
}
