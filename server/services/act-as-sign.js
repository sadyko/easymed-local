// ADMIN_ACT_AS_V1 (R3) — ПОДПИСАТЬ ДОКУМЕНТ ВРАЧА ОТ ЧУЖОГО ИМЕНИ НЕЛЬЗЯ.
//
// Одна проверка на все двери подписи, которые идут через RPC: подтверждение
// процедуры (procedure_complete), записи стационара (admission_review_save:
// создать, изменить, опубликовать), копия подписанного документа приёма
// (visit_document_archive), история болезни (admission_case_file_save) и
// документ врача, приложенный к карте (patient_card_doc_add с видом документа
// врача — ревью безопасности, HIGH 2). Подпись заключения приёма, «Проверить и
// выдать» лаборатории и документы врача в visit_documents идут через /api/db —
// там та же проверка в routes/db.js.
//
// Модуль без зависимостей от базы и других служб: его импортируют модули RPC.
import { ACT_AS_SIGN_REFUSAL, isDoctorDocType } from '../../public/js/shared/act-as.js';

/** Бросает 403 sign_while_acting, если пользователь работает от имени (рядом — администратор). */
export function refuseSignWhileActing(user) {
  if (!user || !user.acting_admin) return;
  const e = new Error(ACT_AS_SIGN_REFUSAL);
  e.status = 403;
  e.code = 'sign_while_acting';
  throw e;
}

/**
 * Ревью-2 (LOW 1) — есть ли у документа визита ТЕКСТ (visit_documents.body):
 * не null, не пустая строка, не пустой объект или список (строкой JSON — тоже).
 * Архив документов и карта пациента открывают текст неизвестного вида бланком
 * заключения, под «Консультацией», — от имени такой документ не пишут.
 */
export function docBodyGiven(body) {
  let v = body;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return false;
    try { v = JSON.parse(s); } catch { return true; }
    if (typeof v === 'string') return v.trim() !== '';
  }
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * Ревью безопасности (HIGH 2) — то же для документа визита вида, который
 * составляет врач (shared/act-as.js), и (ревью-2) для любого документа с
 * текстом. Файл без текста (вид «upload») и название — можно.
 */
export function refuseDoctorDocWhileActing(user, docType, body) {
  if (isDoctorDocType(docType) || docBodyGiven(body)) refuseSignWhileActing(user);
}
