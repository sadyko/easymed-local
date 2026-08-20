// Easy-Med — Supabase client
// Loads supabase-js from the official CDN as an ES module.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(
        '[Easy-Med] Supabase keys are missing. ' +
        'Fill in js/config.js with values from `supabase keys.txt`.'
    );
}

// `persistSession: true` is the default but stated explicitly so future
// readers know we rely on Supabase Auth's own storage (sb-<project>-auth-token
// in localStorage) — the legacy `easymed:session` key is gone.
//
// `autoRefreshToken` keeps the JWT alive while the tab is open (Supabase
// rotates the access token every hour). `detectSessionInUrl` is false: we
// don't use the magic-link / OAuth callback flow.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession:     true,
        autoRefreshToken:   true,
        detectSessionInUrl: false,
        storageKey:         'easymed-auth',
    },
});

// Tiny health check so DevTools shows the client is wired up. Also reveals
// whether a session is active (now meaningful — pre-Day-1 it always said
// "anonymous" because we never used Supabase Auth).
export async function pingSupabase() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        console.log('[Easy-Med] Supabase OK. Session:', data.session ? 'authenticated' : 'anonymous');
        return true;
    } catch (err) {
        console.error('[Easy-Med] Supabase connection failed:', err);
        return false;
    }
}

// Auth state observer — fired by supabase-js on sign-in / sign-out / token
// refresh / user update. We let admin.js subscribe via subscribeAuth() so
// the boot order stays predictable (admin.js owns when to render UI).
//
// Events of interest (per supabase-js docs):
//   - SIGNED_IN          (user just signed in)
//   - SIGNED_OUT         (signOut() or session expiry)
//   - TOKEN_REFRESHED    (silent rotation; no UI action needed)
//   - USER_UPDATED       (e.g. password just changed)
//   - PASSWORD_RECOVERY  (recovery link clicked — not used today)
let authListeners = [];
supabase.auth.onAuthStateChange((event, session) => {
    for (const fn of authListeners) {
        try { fn(event, session); } catch (e) { console.error('[auth listener]', e); }
    }
});

export function subscribeAuth(fn) {
    authListeners.push(fn);
    return () => { authListeners = authListeners.filter(f => f !== fn); };
}
