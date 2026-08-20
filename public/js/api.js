// Easy-Med Local — API client. All URLs are RELATIVE: the app works from any
// IP or hostname it happens to be served on. Never hardcode a host here.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.status === 401 && location.pathname !== '/') {
    // Session gone — return to the login page.
    location.href = '/';
    throw new Error('Login required.');
  }
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}
