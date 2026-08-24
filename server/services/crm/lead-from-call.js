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
import { digitsOf, uzLocalDigits, phoneLikePattern, MIN_PHONE_DIGITS }
  from '../../../public/js/admin/views/crm-phone-match.js';

// The source key every call-born lead carries. config.js refuses to delete it
// for exactly this reason.
export const TELEPHONY_SOURCE = 'telephony';

/**
 * An OPEN lead already on the board for this number, or null.
 *
 * Open only, on purpose: a patient who came last month («Пришёл») and calls
 * again is a NEW lead, while a patient the operator is already working on is
 * not. Two-stage lookup — a LIKE prefilter in SQLite, exact digit containment
 * in JS — because phones are stored formatted («+998 90 961 00 04») and
 * Binotel sends them bare.
 */
export function openLeadForPhone(db, rawPhone) {
  const d = digitsOf(rawPhone);
  // Too short to identify anybody: matching on three digits would call half
  // the board a duplicate and silently stop creating leads at all.
  if (d.length < MIN_PHONE_DIGITS) return null;
  const local = uzLocalDigits(d);

  const rows = db.prepare(`
    SELECT r.id, r.phone
      FROM crm_requests r
      JOIN crm_stages s ON s.key = r.status
     WHERE s.kind = 'open' AND r.phone <> '' AND (r.phone LIKE ? OR r.phone LIKE ?)
     ORDER BY r.id DESC
     LIMIT 200`).all(phoneLikePattern(local), phoneLikePattern(d));

  return rows.find((r) => {
    const sf = digitsOf(r.phone);
    return sf && (sf.includes(local) || sf.includes(d));
  }) || null;
}

/**
 * Files a lead for a call that has just been recorded.
 *
 * @param {Database} db
 * @param {{id:number, disposition?:string, external_number?:string, patient_id?:number|null}} call
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
  if (openLeadForPhone(db, phone)) return null;

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
