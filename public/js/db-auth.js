// Pure ES module: local Supabase-Auth-shaped bridge over our own
// /api/auth/{login,logout,me} endpoints. Runs in both the browser (real
// fetch) and node (fake fetch, for tests) — no DOM/window references at
// module scope.
//
// export function makeAuthBridge({ fetch, base }) -> {
//   signInWithPassword, getUser, getSession, signOut, updateUser,
//   onAuthStateChange
// }
//
// Every method returns a supabase-shaped { data, error } (or { error } for
// signOut) and NEVER throws — network failures and non-2xx responses are
// folded into the error/null shape the callers already branch on.

export function makeAuthBridge({ fetch, base }) {
  async function request(method, path, payload) {
    try {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: method === 'POST' ? JSON.stringify(payload || {}) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      return { ok: false, status: 0, json: { error: { message: String(err) } } };
    }
  }

  async function signInWithPassword({ email, username, password } = {}) {
    const { ok, json } = await request('POST', '/login', {
      username: username ?? email,
      password,
    });
    if (!ok) {
      return {
        data: { user: null, session: null },
        error: json.error || { message: 'Login failed' },
      };
    }
    return {
      data: { user: json.user, session: { user: json.user } },
      error: null,
    };
  }

  async function getUser() {
    const { ok, json } = await request('GET', '/me');
    if (!ok) return { data: { user: null }, error: null };
    return { data: { user: json.user }, error: null };
  }

  async function getSession() {
    const { ok, json } = await request('GET', '/me');
    if (!ok) return { data: { session: null }, error: null };
    return { data: { session: { user: json.user } }, error: null };
  }

  async function signOut() {
    await request('POST', '/logout', {});
    return { error: null };
  }

  async function updateUser(_attrs) {
    return {
      data: { user: null },
      error: { message: 'updateUser not supported locally yet' },
    };
  }

  function onAuthStateChange(_cb) {
    // No-op: boot (2a-shell) drives auth explicitly rather than relying on
    // an event stream, so we don't invoke `_cb`.
    return { data: { subscription: { unsubscribe() {} } } };
  }

  return {
    signInWithPassword,
    getUser,
    getSession,
    signOut,
    updateUser,
    onAuthStateChange,
  };
}
