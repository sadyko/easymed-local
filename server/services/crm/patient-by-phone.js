// FIX_318_V1 (L3, 2026-10-28) — ПАЦИЕНТ НОВОЙ КАРТОЧКИ CRM ПО НОМЕРУ: ПРАВИЛО ЗВОНКА.
//
// Звонок (telephony/poller.js recordCall) кладёт в calls.patient_id верхнюю
// карту findPatientsByPhone — активные первыми, затем самые новые, — и
// leadFromCall (crm/lead-from-call.js) переносит её в новую карточку. Заявки
// из рекламы Meta (meta/leads.js) и из рекламной ссылки Telegram
// (telegram/deeplinks.js) пациента не искали вовсе: карточка постоянного
// пациента открывалась без его карты. Теперь их НОВАЯ карточка получает
// пациента этим же правилом — одним модулем на всех, иначе «тот же номер»
// снова начали бы считать по-разному (telegram/documents.js объясняет, почему
// это хуже всего).
//
// Влитая в открытую карточку заявка пациента не меняет — как и звонок, который
// попал в окно повторного обращения.
import { findPatientsByPhone } from '../telegram/documents.js';

/** id карты пациента для номера или null (номера нет, карты с ним нет). */
export function patientIdForPhone(db, rawPhone) {
  if (!rawPhone) return null;
  const top = findPatientsByPhone(db, rawPhone, 1)[0];
  return top ? Number(top.id) : null;
}
