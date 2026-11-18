// DOC_HISTORY_V1 (3.25.0, решение владельца) — ИСТОРИЯ ИЗМЕНЕНИЙ ДОКУМЕНТА ПРИЁМА:
// ЗАПИСЬ ВЕРСИЙ (сервер).
//
// Версию пишет только сервер и только вместе с самой записью документа — в ОДНОЙ
// транзакции (вызывающий открывает её сам):
//   • /api/db — правка visit_services.notes (routes/db.js);
//   • «Выполнено» процедуры — заметка медсестры (rpc/procedures.js);
//   • копия подписанного документа (rpc/patient-card.js visit_document_archive) —
//     догоняет историю, если документ строки изменили мимо этих дверей.
// Время ставит база (created_at), сотрудника — сессия; присланное браузером
// (savedAt, by, byName записи кабинета) в версию не попадает. Правила — какое
// содержание, какой вид, какие разделы — общие с экраном: shared/doc-history.js.
// Таблица (миграция 289) неизменяема: UPDATE и DELETE отказывают триггеры.
import {
  docContentOf, docContentHash, docSnapshotOf, docSectionsChanged, docRevisionKind, signedEntriesOf,
} from '../../../public/js/shared/doc-history.js';
import { storedIsCabinet } from '../../../public/js/shared/cabinet-notes.js';

const NOBODY = Object.freeze({ id: null, name: null, role: null, adminId: null, adminName: null });

/** Кто записал: сотрудник сессии (имя и роль — копией) и администратор при входе «от имени». */
function actorOf(db, user) {
  if (!user || user.id == null) return NOBODY;
  const row = db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(user.id);
  const acting = user.acting_admin && user.acting_admin.id != null
    ? db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(user.acting_admin.id) : null;
  return {
    id: row ? row.id : null,   // ссылка — только на существующего сотрудника (внешний ключ не уронит запись документа)
    name: (row && row.full_name) || user.full_name || null,
    role: (row && row.role) || user.role || null,
    adminId: acting ? acting.id : null,
    adminName: acting ? (acting.full_name || null) : (user.acting_admin ? (user.acting_admin.full_name || null) : null),
  };
}

const lastRevision = (db, vsId) => db.prepare(`SELECT rev_no, content_hash, signed_n, snapshot FROM visit_document_revisions
  WHERE visit_service_id = ? ORDER BY rev_no DESC LIMIT 1`).get(vsId);

function insertRevision(db, vsId, revNo, { kind, via, snap, hash, diff, actor }) {
  db.prepare(`INSERT INTO visit_document_revisions
      (visit_service_id, rev_no, kind, via, doc_type, sections, images_added, images_removed, snapshot, content_hash, signed_n,
       user_id, user_name, user_role, acting_admin_id, acting_admin_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(vsId, revNo, kind, via, snap.docType || null, JSON.stringify(diff.sections), diff.imagesAdded, diff.imagesRemoved,
      JSON.stringify(snap), hash, snap.signed.length, actor.id, actor.name, actor.role, actor.adminId, actor.adminName);
}

// Документ, написанный до журнала (до 3.25.0), версий не имеет: первая запись после
// обновления сначала сохраняет его прежнее состояние — «Версия до журнала изменений»
// (сотрудник неизвестен; подписи — как их записал кабинет), иначе первую правку не с
// чем было бы сравнить.
function baselineIfNeeded(db, vsId, last, prevRaw, prev = docContentOf(prevRaw)) {
  if (last) return last.rev_no;
  if (!prev) return 0;
  const signedN = signedEntriesOf(prevRaw).length;
  if (docContentHash(prev) === docContentHash(null) && !signedN) return 0;
  insertRevision(db, vsId, 1, { kind: 'baseline', via: 'baseline', snap: docSnapshotOf(prevRaw, prev), hash: docContentHash(prev),
    diff: { sections: [], imagesAdded: 0, imagesRemoved: 0 }, actor: NOBODY });
  return 1;
}

/**
 * Записать версию после записи документа строки: prevRaw — notes ДО записи,
 * nextRaw — то, что теперь лежит у строки. Вызывать внутри транзакции записи.
 * → { rev_no, kind } или null (содержание то же — версии нет).
 */
export function recordDocRevision(db, { visitServiceId, prevRaw, nextRaw, user, via = 'cabinet' }) {
  // Содержание считается один раз на запись: отпечатки снимков идут по всем их байтам.
  const prev = docContentOf(prevRaw);
  const next = docContentOf(nextRaw);
  const kind = docRevisionKind({ prevRaw, nextRaw, via, prevContent: prev, nextContent: next });
  if (!kind) return null;
  const vsId = Number(visitServiceId);
  let revNo = baselineIfNeeded(db, vsId, lastRevision(db, vsId), prevRaw, prev);
  insertRevision(db, vsId, ++revNo, { kind, via, snap: docSnapshotOf(nextRaw, next), hash: docContentHash(next),
    diff: docSectionsChanged(prev, next), actor: actorOf(db, user) });
  return { rev_no: revNo, kind };
}

/**
 * Копия подписанного документа (visit_document_archive): документ строки уже записан
 * (его версия — от /api/db). Если он изменился мимо журнала (последняя версия — не
 * то, что лежит у строки), история догоняется версией 'archive' от подписавшего.
 * → { rev_no, kind } или null.
 */
export function ensureDocRevisionCurrent(db, visitServiceId, user) {
  const vsId = Number(visitServiceId);
  const row = db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(vsId);
  if (!row || !storedIsCabinet(row.notes)) return null;
  const now = docContentOf(row.notes);
  const hash = docContentHash(now);
  const signedN = signedEntriesOf(row.notes).length;
  const last = lastRevision(db, vsId);
  if (last && last.content_hash === hash && Number(last.signed_n) === signedN) return null;
  if (!last) return baselineIfNeeded(db, vsId, null, row.notes, now) ? { rev_no: 1, kind: 'baseline' } : null;
  let prev = null;
  try { prev = JSON.parse(last.snapshot); } catch { prev = null; }
  const changed = last.content_hash !== hash;
  const kind = changed && Number(last.signed_n) > 0 ? 'amended'
    : signedN > Number(last.signed_n) ? 'signed'
      : changed ? 'draft' : 'signed';
  const revNo = Number(last.rev_no) + 1;
  insertRevision(db, vsId, revNo, { kind, via: 'archive', snap: docSnapshotOf(row.notes, now), hash,
    diff: docSectionsChanged(prev, now), actor: actorOf(db, user) });
  return { rev_no: revNo, kind };
}
