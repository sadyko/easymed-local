// Easy-Med Local — local data client. Exposes a Supabase-shaped `supabase`
// object backed entirely by our local Express API (no Supabase, no network to
// any external host). The ~52 files importing { supabase } keep working.
import { makeDbClient } from './db-client.js';
import { makeAuthBridge } from './db-auth.js';

const httpFetch = (...a) => fetch(...a);   // browser global; bound at call time

const dbClient = makeDbClient({ fetch: httpFetch, base: '/api/db' });
const auth     = makeAuthBridge({ fetch: httpFetch, base: '/api/auth' });

async function rpc(name, args = {}) {
    try {
        const res = await fetch('/api/rpc/' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(args || {}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return { data: null, error: json.error || { message: 'RPC failed (' + res.status + ')' } };
        return { data: json.data ?? null, error: null };
    } catch (e) {
        return { data: null, error: { message: String(e) } };
    }
}

function channel() {
    // Realtime is not used locally (single nav-badge subscription degrades to
    // manual refresh). Return a no-op with the chainable surface callers expect.
    const ch = { on() { return ch; }, subscribe() { return ch; }, unsubscribe() { return Promise.resolve(); } };
    return ch;
}

// Local file storage backed by /api/storage (server/routes/storage.js). Objects
// are served by that same-origin authenticated endpoint, so a "signed URL" is
// just the object's path — the session cookie authorises the request (works
// directly as an <img src>). Matches the subset of the Supabase Storage API the
// app uses: upload / createSignedUrl / remove / getPublicUrl.
function storageObjectUrl(bucket, objectPath) {
    const segs = String(objectPath || '').split('/').map(encodeURIComponent).join('/');
    return `/api/storage/${encodeURIComponent(bucket)}/${segs}`;
}
const storage = {
    from(bucket) {
        return {
            async upload(objectPath, file, _opts) {
                try {
                    const res = await fetch(storageObjectUrl(bucket, objectPath), {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': (file && file.type) || 'application/octet-stream' },
                        body: file,
                    });
                    if (!res.ok) {
                        const j = await res.json().catch(() => ({}));
                        return { data: null, error: j.error || { message: 'Upload failed (' + res.status + ')' } };
                    }
                    return { data: { path: objectPath }, error: null };
                } catch (e) {
                    return { data: null, error: { message: String(e) } };
                }
            },
            // Local objects need no time-limited token; the authenticated path IS
            // the URL. (expiresSeconds is accepted for API-shape compatibility.)
            async createSignedUrl(objectPath, _expiresSeconds) {
                if (!objectPath) return { data: null, error: { message: 'No path.' } };
                return { data: { signedUrl: storageObjectUrl(bucket, objectPath) }, error: null };
            },
            async remove(paths) {
                const list = Array.isArray(paths) ? paths : [paths];
                try {
                    for (const p of list) {
                        await fetch(storageObjectUrl(bucket, p), { method: 'DELETE', credentials: 'same-origin' });
                    }
                    return { data: {}, error: null };
                } catch (e) {
                    return { data: null, error: { message: String(e) } };
                }
            },
            getPublicUrl(objectPath) {
                return { data: { publicUrl: storageObjectUrl(bucket, objectPath) } };
            },
        };
    },
};

export const supabase = {
    from: (t) => dbClient.from(t),
    rpc,
    channel,
    removeChannel() {},
    auth,
    storage,
};

// Back-compat shims for the two extra exports the old module had:
export async function pingSupabase() {
    try { const r = await supabase.auth.getSession(); return !!(r && r.data); } catch { return false; }
}

let authListeners = [];
export function subscribeAuth(fn) {
    authListeners.push(fn);
    return () => { authListeners = authListeners.filter(f => f !== fn); };
}
