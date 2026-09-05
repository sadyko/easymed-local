// CONTROL_PLANE_PANEL_V1 — the one fetch helper every view goes through.
//
// Every failure path here ends in a thrown ApiError with a real message —
// no view is allowed to catch a raw fetch/JSON exception and end up with a
// blank screen. A 401 is special-cased: it means the vendor session ended
// (logged out elsewhere, expired, never existed), so it calls a single
// shared hook (see setUnauthorizedHandler) instead of leaving each view to
// notice it independently — that hook is what returns the panel to the
// login screen WITHOUT touching location.hash, so the in-progress route
// survives a re-login.

const BASE = '/cp/v1';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network failure: offline, DNS, the process not running. Never let this
    // surface as an uncaught rejection — every caller gets a real message.
    throw new ApiError('Could not reach the control plane. Check the connection and try again.', 0, 'network');
  }

  let data = null;
  try { data = await res.json(); } catch { /* no/invalid JSON body — data stays null */ }

  if (res.status === 401) onUnauthorized();

  if (!res.ok) {
    throw new ApiError(data?.error?.message || `Request failed (${res.status}).`, res.status, data?.error?.code || null);
  }
  return data;
}

// Thin, literal wrappers over admin.js's own route table (see that file for
// exact response shapes — nothing here reshapes or renames a field).
export const cp = {
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),

  clinics: () => request('GET', '/admin/clinics'),
  clinic: (id) => request('GET', `/admin/clinics/${encodeURIComponent(id)}`),
  createClinic: (payload) => request('POST', '/admin/clinics', payload),
  setModule: (id, moduleKey, granted) =>
    request('POST', `/admin/clinics/${encodeURIComponent(id)}/modules`, { module_key: moduleKey, granted }),
  setSubscription: (id, payload) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/subscription`, payload),
  retire: (id) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/retire`, {}),
  deleteClinic: (id) => request('DELETE', `/admin/clinics/${encodeURIComponent(id)}`),
  unlockCode: (id, challenge) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/unlock-code`, { challenge }),

  // STATS_V1 (docs/plans/2026-08-22-statistics.md)
  counters: () => request('GET', '/admin/counters'),
  setCollect: (id, names) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/collect`, { names }),

  requests: () => request('GET', '/admin/requests'),
  grantRequest: (id) => request('POST', `/admin/requests/${encodeURIComponent(id)}/grant`, {}),
};
