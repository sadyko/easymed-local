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
  // UPDATE_DELIVERY_V1 — the approval screen's own status read; it changes
  // nothing, only reports the offer/approval/schedule/last result.
  'update_status',
]);

// The way back in. These must work while locked or a clinic that wants to pay
// has no route to doing so — the reason login itself stays open.
const ALWAYS_ALLOWED_RPCS = new Set([
  'licence_status', 'licence_unlock', 'module_request',
  // ENROLLMENT_SCREEN_V1 — the first-run "type the EM- code" screen. A
  // never-enrolled install is locked (reason not_enrolled), so without this
  // line the one RPC that ends that state would 402 against it.
  'licence_enroll',
  // UPDATE_DELIVERY_V1 — a licence-lapsed clinic must still be able to
  // receive an update: the update may be exactly what the vendor ships to
  // fix the clinic's own situation (a licensing bug, a billing-flow fix),
  // and approving/cancelling it is vendor-relations, not clinical data —
  // the same category as the three RPCs above, not a write this gate exists
  // to hold back. tickUpdater's own pipeline (download/verify/stage/apply)
  // is not reached through this gate at all — it runs off a timer, not an
  // HTTP request — so this only ever governs whether the ADMIN can still
  // see the offer and say yes/no to it while locked.
  'update_approve', 'update_cancel',
  // «Проверить обновления» — triggers an immediate check-in. The check-in is
  // the very mechanism that renews a licence and delivers module grants, so
  // for a locked clinic this button is the recovery path itself: an admin who
  // just fixed the router (or just paid) presses it and gets unlocked NOW
  // instead of waiting for the daily timer. Blocking it at 402 would be
  // locking the clinic out of the one action that ends the lock.
  'update_check_now',
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
