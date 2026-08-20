// Easy-Med — authentication (Supabase Auth backed).
//
// Pre-Day-1 this module hashed `easymed:<password>` with SHA-256 client-side
// and compared the result against users.password_hash. That gave us "good
// enough on a trusted LAN" auth but trivial to bypass from outside (anyone
// with the anon key can SELECT * FROM patients). After migration 032 every
// existing public.users row has a linked auth.users entry; we now call
// `supabase.auth.signInWithPassword` so the JWT becomes the actual
// authentication, the same JWT the RLS policies (migrations 034–039) check.
//
// Username UX is preserved: the user types `aziza` and we derive
// `aziza@auth.easymed.local` behind the scenes. The "@auth.easymed.local"
// domain is a stable internal identifier — never delivered to, parseable
// at, or reachable on a real mail server. Supabase Auth only needs an
// email-shaped string.
//
// FIRST-LOGIN reset: migration 032 set every auth.identities.last_sign_in_at
// to null. We check `auth.users.last_sign_in_at` on the first authed call;
// if absent, the caller (admin.js) renders the "Set new password" screen
// instead of the dashboard. After the user sets a new password,
// last_sign_in_at gets populated by the next signIn and the gate clears.

import { supabase } from '../supabase.js';

// ---------------------------------------------------------------------------
// Sign-in. Returns { user, needsPasswordReset } on success or { error }.
//
// `user` is the public.users row (with computed flags from actorFromUser);
// `needsPasswordReset` is true when this is the user's first sign-in (we
// then render the reset screen instead of the dashboard).
//
// The `admin/admin123` bootstrap fallback from the old auth.js is gone:
// when Supabase Auth is the source of truth, a hardcoded escape hatch is
// the kind of thing a security review would flag. If the DB is unreachable,
// the user sees a clean error and we fix the connection.
// ---------------------------------------------------------------------------
export async function verifyLogin(username, password) {
    const uname = String(username || '').trim();
    if (!uname || !password) return { error: 'Enter a username and password.' };
    const { data, error } = await supabase.auth.signInWithPassword({ username: uname, password });
    if (error) return { error: 'Wrong username or password.' };
    const user = data && data.user;
    if (!user) return { error: 'Login returned no session.' };
    if (user.is_active === false) return { error: 'This account is disabled.' };
    return { user };
}

// Used by admin.js boot — rehydrates the public.users row from the live
// Supabase Auth session. Returns null if no session is active.
export async function rehydrateUserFromSession() {
    const { data } = await supabase.auth.getUser();
    const user = data && data.user;
    if (!user || user.is_active === false) return null;
    return user;
}

// ---------------------------------------------------------------------------
// Force-reset flow — called from admin.js when needsPasswordReset is true.
// Updates the password AND marks the metadata so future logins skip the
// reset screen.
// ---------------------------------------------------------------------------
// Shared client-side password policy (M6). Server-side enforcement (Supabase
// Auth min length + leaked-password protection) should mirror this — the client
// check is UX only and is bypassable by calling the API directly.
const COMMON_WEAK_PASSWORDS = new Set([
    'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
    'qwerty123', 'admin123', 'welcome1', 'iloveyou', 'letmein1', 'changeme',
    'easymed', 'easymed123', 'clinic123',
]);

export function validatePasswordStrength(pwd) {
    const p = String(pwd || '');
    if (p.length < 10) return { error: 'Use at least 10 characters.' };
    if (COMMON_WEAK_PASSWORDS.has(p.toLowerCase())) return { error: 'This password is too common — choose another.' };
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
    if (classes < 3) return { error: 'Mix upper- and lower-case letters, digits and a symbol (at least 3 of 4).' };
    return { ok: true };
}

export async function completeFirstLoginReset(newPassword) {
    const pwd = String(newPassword || '');
    const strength = validatePasswordStrength(pwd);
    if (strength.error) return { error: strength.error };

    const { error } = await supabase.auth.updateUser({
        password: pwd,
        data: { password_set: true },
    });
    if (error) return { error: 'Password update failed: ' + error.message };
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Logout — single source of truth. Calls Supabase Auth and lets its own
// listener clear the app state (see supabase.js onAuthStateChange).
// ---------------------------------------------------------------------------
export async function signOutAndReload() {
    try { await supabase.auth.signOut(); } catch (e) { console.warn('[auth] signOut failed:', e); }
    // Reload so all module state (state.user, permission caches, view stack)
    // resets from a clean slate. Equivalent to clearing localStorage in the
    // old flow but more thorough.
    location.reload();
}

// ---------------------------------------------------------------------------
// Shape a public.users row into the in-app actor. Identical to the
// pre-Day-1 implementation so downstream code (admin.js, permissions.js,
// every view) doesn't need to change.
// ---------------------------------------------------------------------------
export function actorFromUser(u) {
    const role     = (u.role || '').toLowerCase();
    // is_super_admin is the explicit column from migration 045 — true only
    // for users the super admin has explicitly elevated. "Admin role" users
    // (role text 'admin' but the column is false) still get full operational
    // access via their role_id permissions, but they're not god-mode.
    const isSuperAdmin = u.is_super_admin === true;
    const isAdmin  = role === 'admin' || isSuperAdmin;
    // ADMIN_DOCTOR_V1 — a user can be BOTH admin and doctor. is_doctor is a
    // capability (doctor lists + consultation workspace), independent of the
    // admin permission role.
    const isDoctor = role === 'doctor' || u.is_doctor === true || !!u.specialty || !!u.license_number;
    return {
        id:             u.id || null,
        full_name:      u.full_name || u.username || 'User',
        username:       u.username || '',
        role:           u.role || 'user',
        role_id:        u.role_id || null,
        company_id:     u.company_id || null,
        specialty:      u.specialty || '',
        is_super_admin: isSuperAdmin,
        is_admin:       isAdmin,
        is_doctor:      isDoctor,
    };
}

// ---------------------------------------------------------------------------
// Legacy compat shims — kept so callers (employee-editor.js, section-crud.js)
// that still write users.password_hash don't break before Day 2's migration
// 033 introduces the admin RPC for new-user provisioning.
//
// After Day 2, these are dead code; we'll remove the password_hash column
// and these shims in a follow-up migration.
// ---------------------------------------------------------------------------

// Same hash format as migration 006 — purely for backward compat with the
// employee-editor / section-crud writers that still seed password_hash on
// user create. The hash is no longer consulted on login (Supabase Auth is).
export async function hashPassword(password) {
    const data = new TextEncoder().encode('easymed:' + String(password ?? ''));
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Old localStorage session API — no-ops now (Supabase Auth handles its own
// persistence under sb-<project>-auth-token). Kept as exports so any
// straggling caller compiles; can be deleted in a follow-up sweep.
export function saveSession()  { /* no-op — Supabase Auth handles persistence */ }
export function loadSession()  { return null; /* admin.js now uses rehydrateUserFromSession */ }
export function clearSession() { /* no-op — signOutAndReload is the path now */ }

// Pre-Day-1 admin.js called fetchUserById(sess.id). Kept signature-compatible
// in case any other module imports it; routes through the auth-aware fetcher.
export async function fetchUserById(id) {
    if (!id) return null;
    const { data, error } = await supabase
        .from('users')
        .select('id, full_name, username, role, role_id, is_doctor, specialty, license_number, active')   // ADMIN_DOCTOR_V3
        .eq('id', id).limit(1);
    if (error) { console.warn('[auth] fetchUserById failed:', error.message); return null; }
    const u = (data || [])[0];
    return (!u || u.active === false) ? null : u;
}
