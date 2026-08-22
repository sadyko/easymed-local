import { Router } from 'express';
import { checkIn } from '../services/checkin.js';
import { signLicence } from '../services/signing.js';

// LICENCE_CORE_V1 — HTTP surface for the daily call. See services/checkin.js
// for the actual rules; this file only translates HTTP <-> that function,
// the same split as routes/enroll.js <-> services/enrollment.js.

// SAME status, SAME body, whether the token is unknown, belongs to a
// deactivated clinic, or is simply missing — see checkin.js's own comment on
// why all three collapse to the one `null` this route turns into a response.
// Distinguishing them would let someone probe which install_tokens are live.
const GENERIC_FAILURE_STATUS = 401;
const GENERIC_FAILURE_BODY = {
  error: {
    code: 'invalid_token',
    message: 'This install is not recognised.',
  },
};

export function checkinRoutes(db) {
  const r = Router();

  r.post('/', (req, res) => {
    const { install_token, version, fingerprint, module_requests, stats, update_result } = req.body || {};

    // signLicence runs INSIDE checkIn(), but only AFTER the check-in itself
    // has already committed (see checkIn's own doc comment) — so if it throws
    // here (an unset or unreadable signing key), the checkins row this call
    // wrote is untouched by the throw. Express's synchronous-handler catching
    // hands the error to app.js's error middleware, which answers 500 without
    // echoing anything request-shaped — the same path as enroll.js's own
    // signing failure.
    //
    // `stats` (STATS_V1) and `update_result` (UPDATE_DELIVERY_V1) pass
    // straight through, untouched, exactly like `module_requests` above —
    // checkIn()/normaliseStats()/normaliseUpdateResult() do all the actual
    // validation. An older clinic that never sends either field at all
    // leaves them `undefined` here, same as any other optional field.
    const result = checkIn(db, {
      installToken: install_token,
      version,
      fingerprint,
      moduleRequests: module_requests,
      stats,
      updateResult: update_result,
    }, { signLicence });

    if (!result) {
      return res.status(GENERIC_FAILURE_STATUS).json(GENERIC_FAILURE_BODY);
    }

    res.json(result);
  });

  return r;
}
