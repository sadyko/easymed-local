// PATIENT_LIST_REGISTRAR_V1 (2026-11-24) — «КТО ОФОРМИЛ ВИЗИТ»: ОДНО ПРАВИЛО НА ВСЕ ЭКРАНЫ.
//
// Правило родилось в списке «Записи CRM» (CRM_BOOKING_LOG_V1, rpc/registrar-waiting.js,
// поле registered_by) и теперь нужно картотеке: владелец решил, что колонка
// «Регистратор» показывает того, кто оформил ПОСЛЕДНИЙ ВИЗИТ пациента, а не того,
// кто завёл карту (у импортированных карт автора нет — «Не указан» на каждой строке).
// Чтобы у двух экранов не было двух определений, правило живёт здесь, и оба его зовут.
//
// Визит оформили, по порядку:
//   1) создатели ЖИВЫХ (не отменённых — status <> 'void') счетов визита, по номеру счёта;
//   2) авторы отметок «оформлен» журнала (invoice_audit_log, action 'visit_registered'),
//      по номеру записи; у отметки без сотрудника — имя, записанное в самой отметке.
// Имя — ФИО сотрудника, а без него логин; один человек — один раз; пустые имена не
// попадают. Первый в списке — тот, кого показывает экран, остальные — в подсказке.
//
// Два чтения на всю пачку визитов, оба по индексам visit_id (idx_invoices_visit,
// idx_invoice_audit_log_visit): ни одного запроса на строку.
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const idList = (list) => JSON.stringify([...new Set((list || []).map(Number).filter(isPosInt))]);
const IN_IDS = (col) => `${col} IN (SELECT value FROM json_each(?))`;

/** Имя сотрудника, как его пишут списки стойки: ФИО, а без него логин. */
export const nameOfUser = (u) => (u ? (String(u.full_name || '').trim() || u.username || '') : '');

const INVOICES_SQL = `SELECT i.visit_id, i.created_by FROM invoices i
                       WHERE ${IN_IDS('i.visit_id')} AND COALESCE(i.status, '') <> 'void' ORDER BY i.id`;
const JOURNAL_SQL = `SELECT a.visit_id, a.actor_user_id, a.actor_name FROM invoice_audit_log a
                      WHERE ${IN_IDS('a.visit_id')} AND a.action = 'visit_registered' ORDER BY a.id`;

/**
 * Кто оформил каждый из визитов.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} visitIds
 * @param {{ users?: Map<number, {full_name?: string, username?: string}> }} [opts]
 *        users — уже прочитанные сотрудники (id → строка); без них имена нужных
 *        сотрудников читаются здесь одним запросом.
 * @returns {Map<number, string[]>} ключ — id визита; у визита без записей — пустой список.
 */
export function visitRegisteredBy(db, visitIds, { users = null } = {}) {
  const ids = JSON.parse(idList(visitIds));
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const arg = JSON.stringify(ids);
  const invoices = db.prepare(INVOICES_SQL).all(arg);
  const journal = db.prepare(JOURNAL_SQL).all(arg);
  let who = users;
  if (!who) {
    const need = idList([...invoices.map((i) => i.created_by), ...journal.map((a) => a.actor_user_id)]);
    who = new Map(need === '[]' ? [] : db.prepare(`SELECT id, username, full_name FROM users WHERE ${IN_IDS('id')}`)
      .all(need).map((u) => [Number(u.id), u]));
  }
  const add = (visitId, name) => {
    const list = out.get(Number(visitId));
    if (list && name && !list.includes(name)) list.push(name);
  };
  for (const i of invoices) add(i.visit_id, nameOfUser(who.get(Number(i.created_by))));
  for (const a of journal) add(a.visit_id, nameOfUser(who.get(Number(a.actor_user_id))) || a.actor_name || '');
  return out;
}

/** Планы двух чтений (EXPLAIN QUERY PLAN тех же текстов, что выполняются) — их проверяет тест картотеки. */
export function visitRegisteredByPlans(db, visitIds = [1]) {
  const detail = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(idList(visitIds)).map((r) => String(r.detail));
  return { invoices: detail(INVOICES_SQL), journal: detail(JOURNAL_SQL) };
}
