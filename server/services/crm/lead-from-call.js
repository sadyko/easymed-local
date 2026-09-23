// CRM_CONFIG_V1 — the telephony → CRM bridge: a recorded call becomes a lead
// card, or deliberately does not (migration 077's crm_call_routing).
//
// Called from ONE place — recordCall() in telephony/poller.js, which is itself
// the single writer both the poller and the webhook go through. That is the
// whole reason it lives there and not in two callers: poll and webhook deliver
// the same call, and a lead created twice is worse than one created never.
//
// Nothing here is a hard rule. Every disposition's fate is a row the owner can
// change in Настройки → CRM-канбан; this file only obeys the table.

import { readSettingsRow } from '../telephony/settings.js';
// The SAME phone matcher the CRM board, the call log and the Telegram bot use.
// Never a second one: two implementations of "the same number" is how the
// de-duplication below would start passing a number the operator considers a
// duplicate — the failure telegram/documents.js documents for the bot.
import { phoneKey, phoneLikePattern, MIN_PHONE_DIGITS }
  from '../../../public/js/admin/views/crm-phone-match.js';

// The source key every call-born lead carries. config.js refuses to delete it
// for exactly this reason.
export const TELEPHONY_SOURCE = 'telephony';

/**
 * Every lead of this number, newest first — `open` narrows it to the ones still
 * on the board (a stage of kind 'open').
 *
 * CRM_DEDUP_SEARCH_TASKS_V1 — ONE normalisation on both sides: phoneKey(), the
 * last nine digits (crm-phone-match.js). The old rule, «stored digits CONTAIN the
 * caller's digits», let a formatted «+998 91 566 22 78» and a bare «915662278»
 * be the same person in one place and two people in another. A LIKE prefilter
 * (digits in order, any separators between) keeps SQLite from reading every
 * row; the key comparison in JS is the actual decision.
 */
export function leadsForPhone(db, rawPhone, { open = false } = {}) {
  const key = phoneKey(rawPhone);
  // Too short to identify anybody: matching on three digits would call half
  // the board a duplicate and silently stop creating leads at all.
  if (key.length < MIN_PHONE_DIGITS) return [];
  const rows = db.prepare(`
    SELECT r.id, r.full_name, r.phone, r.status, r.created_at, r.assigned_to,
           s.kind AS stage_kind, s.label AS stage_label
      FROM crm_requests r
      LEFT JOIN crm_stages s ON s.key = r.status
     WHERE r.phone <> '' AND r.phone LIKE ? ${open ? "AND s.kind = 'open'" : ''}
     ORDER BY r.id DESC`).all(phoneLikePattern(key));
  return rows.filter((r) => phoneKey(r.phone) === key);
}

/**
 * An OPEN lead already on the board for this number, or null.
 *
 * Open only, on purpose — for an INCOMING call: a patient who came last month
 * («Пришёл») and calls again is a NEW lead, while a patient the operator is
 * already working on is not.
 */
export function openLeadForPhone(db, rawPhone) {
  return leadsForPhone(db, rawPhone, { open: true })[0] || null;
}

/**
 * ANY lead for this number — open, won or lost — or null.
 *
 * CRM_DEDUP_SEARCH_TASKS_V1 — the rule for an OUTGOING call. Владелец (23.09):
 * «Исходящий звонок создаёт карточку CRM только если у номера нет карточки
 * вообще». An operator calling a patient back is working an existing card (or
 * a closed one), not receiving a new request: 1 126 of 1 855 call-born cards in
 * the clinic's base came from the operators' own outgoing calls.
 */
export function anyLeadForPhone(db, rawPhone) {
  return leadsForPhone(db, rawPhone)[0] || null;
}

// Направление звонка в словаре журнала: calls.call_type, 0 — входящий,
// 1 — исходящий. Binotel присылает его сам (callType, в опросе и в вебхуке),
// onlinePBX — через normalizePbxCall (accountcode 'outbound' → 1, остальное →
// 0). «Мои Звонки» в журнал звонков не пишут вовсе (их история зовётся только
// для проверки подключения), поэтому и карточек из них не бывает.
export const OUTGOING_CALL_TYPE = 1;

/**
 * Files a lead for a call that has just been recorded.
 *
 * @param {Database} db
 * @param {{id:number, disposition?:string, external_number?:string, patient_id?:number|null, call_type?:number}} call
 *        the `calls` row as it was just written.
 * @returns {number|null} the new crm_requests id, or null when nothing was created.
 */
export function leadFromCall(db, call) {
  if (!call || !call.id) return null;

  const disposition = String(call.disposition ?? '').trim().toUpperCase();
  if (!disposition) return null;

  // Which PBX the clinic runs — data, not a constant, the same decision
  // telephony_settings.provider records. A row is keyed by (provider,
  // disposition), so 'ANSWER' can mean different things to different vendors.
  const settings = readSettingsRow(db);
  const provider = (settings && settings.provider) || 'binotel';

  const rule = db.prepare('SELECT action, stage_key FROM crm_call_routing WHERE provider = ? AND disposition = ?')
    .get(provider, disposition);
  // No rule at all = a disposition the vendor invented after this install was
  // set up. Silence, not a guess: inventing leads from an unknown vocabulary
  // is how a board fills with cards nobody asked for.
  if (!rule || rule.action !== 'create' || !rule.stage_key) return null;

  const stage = db.prepare('SELECT key, is_active FROM crm_stages WHERE key = ?').get(rule.stage_key);
  // Belt for a hand-edited database. saveStages already switches rules off
  // when their column is hidden or deleted, so in normal operation this cannot
  // be reached — but a lead dropped into a column nobody can see would look
  // exactly like a lost lead, and that is not a failure worth risking.
  if (!stage || !stage.is_active) return null;

  const phone = String(call.external_number ?? '').trim();
  // No number = nothing to call back and nothing to de-duplicate on. An
  // internal-only call (extension to extension) lands here.
  if (!phone) return null;

  // The chatty-patient guard. Somebody who calls four times before lunch is
  // ONE conversation the operator is having, not four cards to work through.
  // CRM_DEDUP_SEARCH_TASKS_V1 — an OUTGOING call is stricter: it creates a card
  // only for a number that has never had one (see anyLeadForPhone).
  const outgoing = Number(call.call_type) === OUTGOING_CALL_TYPE;
  if (outgoing ? anyLeadForPhone(db, phone) : openLeadForPhone(db, phone)) return null;

  // A known patient gets their real name on the card; an unknown caller gets
  // the number, which is what the operator has to work with anyway (and is
  // never empty, unlike a name).
  let fullName = phone;
  if (call.patient_id) {
    const p = db.prepare('SELECT full_name FROM patients WHERE id = ?').get(call.patient_id);
    if (p && p.full_name) fullName = p.full_name;
  }

  const info = db.prepare(`INSERT INTO crm_requests
      (full_name, phone, source, status, patient_id, call_id)
    VALUES (@full_name, @phone, @source, @status, @patient_id, @call_id)`).run({
    full_name: fullName,
    phone,
    source: TELEPHONY_SOURCE,
    status: stage.key,
    patient_id: call.patient_id || null,
    // The link the card reads to say «звонок в 14:32»; created_by stays NULL
    // because no person created this one, and pretending otherwise would put
    // a staff name on work nobody did.
    call_id: call.id,
  });
  return info.lastInsertRowid;
}
