import { controlState } from './state.js';

// LICENCE_CORE_V1 — the enforcement point.
//
// Enforced on the SERVER, in the two places every write already funnels through.
// Hiding buttons in the browser would be decoration: the API is reachable with
// curl from any PC on the clinic's network.
//
// 402 Payment Required is used deliberately. It is the one status whose meaning
// is exactly this, and it keeps a licence lapse distinguishable from 401 (log in
// again) and 403 (your role may not) — three different problems with three
// different fixes, which the UI must not confuse.

// RPCs that only read. Everything absent from this set is treated as a write.
//
// FAILS CLOSED ON PURPOSE. When someone adds an RPC next year and never reads
// this file, the failure mode is "it stops working during a lapse" — noticed
// immediately, fixed in one line. The alternative default would silently leave a
// hole open for as long as nobody looked.
const READ_ONLY_RPCS = new Set([
  'dashboard_summary', 'reports_overview', 'run_report', 'owner_report',
  'cashier_invoices', 'cash_shift_summary', 'shift_report', 'cashier_report',
  'callcenter_report', 'queue_board', 'documents_feed', 'accommodation_state',
  'deposit_balance', 'list_deposits', 'service_delete_check', 'get_clinic_by_slug',
  'telegram_settings_get', 'telegram_links_list', 'telegram_deliveries_list',
  'telegram_stats', 'telegram_broadcast_status', 'telegram_broadcast_history',
  'telegram_chats_list', 'telegram_chat_messages', 'telegram_chat_unread',
]);

// The way back in. These must work while locked or a clinic that wants to pay
// has no route to doing so — the reason login itself stays open. They do not
// exist yet; a later task adds them.
const ALWAYS_ALLOWED_RPCS = new Set([
  'licence_status', 'licence_unlock', 'module_request',
]);

export function isReadOnlyRpc(name) { return READ_ONLY_RPCS.has(name); }
export function isAlwaysAllowedRpc(name) { return ALWAYS_ALLOWED_RPCS.has(name); }

/** Resolved once per request, after the user is known and before any route can write. */
export function attachControl(db, dataDir) {
  return (req, res, next) => {
    try { req.control = controlState(db, dataDir); }
    catch (e) {
      // controlState is documented never to throw and is tested against twelve
      // corruption scenarios. If it ever does, a licensing bug must not take the
      // clinic down with it.
      console.warn('[licence] state unavailable:', e.message);
      req.control = { locked: false, modules: [], has: () => true, state: 'ok', reason: 'error', daysLeft: 0 };
    }
    next();
  };
}

// The message depends on WHY, and getting this wrong is the failure this whole
// feature was designed to avoid: a clinic that has PAID, whose router died, must
// never be told it owes money. The two lock states are mechanically identical and
// must read completely differently.
//
// This shipped hardcoded to the money wording and was caught in review — a paid
// but offline clinic saving a patient card got "Подписка не активна". The default
// below is deliberately the NEUTRAL message, not the money one: a call site that
// forgets to pass `control` should under-accuse, never over-accuse.
const LOCKED_MESSAGES = {
  unpaid:       'Подписка не активна. Обратитесь к менеджеру Easy-Med.',
  offline:      'Нет связи с Easy-Med. Проверьте интернет — изменения временно недоступны.',
  unlicensed:   'Система не активирована. Обратитесь к менеджеру Easy-Med.',
  not_enrolled: 'Система не активирована. Обратитесь к менеджеру Easy-Med.',
};
const LOCKED_DEFAULT = 'Изменения временно недоступны. Обратитесь к менеджеру Easy-Med.';

export function lockedResponse(res, control) {
  const reason = control && control.reason;
  return res.status(402).json({
    error: {
      code: 'licence_locked',
      reason: reason || 'unknown',
      message: LOCKED_MESSAGES[reason] || LOCKED_DEFAULT,
    },
  });
}
