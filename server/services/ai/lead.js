// AI_CHAT_V1 — заявка, которую ИИ заводит из чата Telegram. Правило CRM то же,
// что у звонков, Meta и ссылок для рекламы: повторное обращение того же номера
// в окне контакта — в открытую карточку, а не вторая (crm/contact-window.js).
// Для Facebook и Instagram ИИ зовёт toCrm (meta/inbox-actions.js) — тот же
// путь, что у оператора.
import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { contactDecision, firstStageKey, reopenLead } from '../crm/contact-window.js';
import { leadsForPhone } from '../crm/lead-from-call.js';
import { patientIdForPhone } from '../crm/patient-by-phone.js';
import { ensureSource, appendToCard } from '../telegram/deeplinks.js';

const SOURCE_KEY = 'telegram';

export function createTelegramAiLead(db, { chatId, phone, name, wish }) {
  const note = ['Создано ИИ · Telegram', String(wish || '').trim()].filter(Boolean).join('\n').slice(0, 2000);
  return db.transaction(() => {
    ensureSource(db);
    const phoneNorm = phone ? (uzE164(phone) || String(phone)) : '';
    let decision = { action: 'new', lead: null };
    if (phoneNorm) decision = contactDecision(db, leadsForPhone(db, phoneNorm));
    if ((decision.action === 'same' || decision.action === 'reopen') && decision.lead) {
      if (decision.action === 'reopen') reopenLead(db, decision.lead.id);
      // Та же дописка, что у заявки по ссылке: и комментарий, и источник «telegram».
      appendToCard(db, decision.lead.id, note);
      return { crm_request_id: decision.lead.id, merged: true };
    }
    const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, patient_id)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(name || '').slice(0, 200) || 'Заявка из Telegram', phoneNorm.slice(0, 40), SOURCE_KEY, JSON.stringify([SOURCE_KEY]),
        firstStageKey(db) || 'in_process', note, phoneNorm ? patientIdForPhone(db, phoneNorm) : null).lastInsertRowid);
    return { crm_request_id: id, merged: false, chatId: String(chatId) };
  })();
}
