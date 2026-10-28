// ADMIN_ACT_AS_V1 (R3) — ПОДПИСАТЬ ДОКУМЕНТ ВРАЧА ОТ ЧУЖОГО ИМЕНИ НЕЛЬЗЯ.
//
// Одна проверка на все двери подписи, которые идут через RPC: подтверждение
// процедуры (procedure_complete), записи стационара (admission_review_save:
// создать, изменить, опубликовать), копия подписанного документа приёма
// (visit_document_archive). Подпись заключения приёма и «Проверить и выдать»
// лаборатории идут через /api/db — там та же проверка в routes/db.js.
//
// Модуль без зависимостей от базы и других служб: его импортируют модули RPC.
import { ACT_AS_SIGN_REFUSAL } from '../../public/js/shared/act-as.js';

/** Бросает 403 sign_while_acting, если пользователь работает от имени (рядом — администратор). */
export function refuseSignWhileActing(user) {
  if (!user || !user.acting_admin) return;
  const e = new Error(ACT_AS_SIGN_REFUSAL);
  e.status = 403;
  e.code = 'sign_while_acting';
  throw e;
}
