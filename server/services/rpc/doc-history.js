// DOC_HISTORY_V1 (3.25.0, решение владельца) — «ИСТОРИЯ ИЗМЕНЕНИЙ» ДОКУМЕНТА ПРИЁМА: ЧТЕНИЕ.
//
// Версии документа строки (visit_document_revisions, миграция 289) пишет только
// сервер (services/domain/doc-history.js). Здесь — две двери чтения, обе только
// читают (control/gate.js READ_ONLY_RPCS):
//   document_history_list { visit_service_id } — список версий без снимков: номер,
//     вид, тип документа, изменённые разделы, снимки (добавлено / убрано), время,
//     кто (имя и роль — как на момент записи), «вместо кого» при входе «от имени»;
//   document_history_get  { visit_service_id, id } — одна версия со снимком (для
//     просмотра и сравнения — экран сравнивает две версии сам).
//
// КТО ВИДИТ (решение владельца): врач строки (её исполнитель, doctor_id — так строку
// видит кабинет), главный врач (надстроечная роль head_doctor — «Главный врач»;
// отдельного права в справочнике прав нет) и администратор. Медсестра, регистратура,
// другой врач — 403 (DOC_HISTORY_DENIED). Сверх того — правило данных пациентов
// (db/patient-data-gate.js, как у документов визитов): роли, которой они закрыты,
// история не отдаётся даже врачу строки. Вход «от имени» — права сотрудника.
// Правящих дверей нет: версии не меняются и не удаляются никем.
import { RpcError } from './crm-config.js';
import { patientDataRefusal } from '../../db/patient-data-gate.js';
import { canSeeDocHistory, DOC_HISTORY_DENIED } from '../../../public/js/shared/doc-history.js';

function lineFor(db, args, user) {
  const vsId = Number(args && args.visit_service_id);
  if (!Number.isInteger(vsId) || vsId <= 0) throw new RpcError('Не указана строка услуги.', 400);
  const refusal = patientDataRefusal('visit_documents', user, db);
  if (refusal) throw new RpcError(refusal, 403);
  const line = db.prepare('SELECT id, doctor_id FROM visit_services WHERE id = ?').get(vsId);
  if (!line) throw new RpcError('Строка услуги не найдена.', 404);
  if (!canSeeDocHistory(user, line.doctor_id)) throw new RpcError(DOC_HISTORY_DENIED, 403);
  return line;
}

function parseList(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rowOut(r) {
  return {
    id: r.id, rev_no: r.rev_no, kind: r.kind, via: r.via, doc_type: r.doc_type,
    sections: parseList(r.sections), images_added: r.images_added, images_removed: r.images_removed, signed_n: r.signed_n,
    created_at: r.created_at,
    user: r.user_id != null || r.user_name ? { id: r.user_id, name: r.user_name || '', role: r.user_role || '' } : null,
    acting_admin: r.acting_admin_id != null || r.acting_admin_name ? { id: r.acting_admin_id, name: r.acting_admin_name || '' } : null,
  };
}
const COLUMNS = `id, rev_no, kind, via, doc_type, sections, images_added, images_removed, signed_n, created_at,
  user_id, user_name, user_role, acting_admin_id, acting_admin_name`;

export function documentHistoryList(db, args, user) {
  const line = lineFor(db, args, user);
  const rows = db.prepare(`SELECT ${COLUMNS} FROM visit_document_revisions WHERE visit_service_id = ? ORDER BY rev_no`).all(line.id);
  return { visit_service_id: line.id, doctor_id: line.doctor_id, revisions: rows.map(rowOut) };
}

export function documentHistoryGet(db, args, user) {
  const line = lineFor(db, args, user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана версия документа.', 400);
  const r = db.prepare(`SELECT ${COLUMNS}, snapshot FROM visit_document_revisions WHERE id = ? AND visit_service_id = ?`).get(id, line.id);
  if (!r) throw new RpcError('Версия документа не найдена.', 404);
  let snapshot = null;
  try { snapshot = JSON.parse(r.snapshot); } catch { snapshot = null; }
  return { ...rowOut(r), snapshot };
}
