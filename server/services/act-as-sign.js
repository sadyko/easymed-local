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

/** Ревью безопасности (HIGH 2) — то же для документа визита вида, который составляет врач (shared/act-as.js). */
export function refuseDoctorDocWhileActing(user, docType) {
  if (isDoctorDocType(docType)) refuseSignWhileActing(user);
}
