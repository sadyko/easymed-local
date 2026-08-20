// Supabase Storage helpers for file/image uploads.
//
// Buckets here are PRIVATE — uploads store the object PATH in the DB, and the
// UI fetches a short-lived signed URL to display/download. Nothing is exposed
// through a permanent public URL.

import { supabase } from '../supabase.js';

// SLICED2: reuse the proven private 'clinic-docs' bucket (already has working
// authenticated INSERT/SELECT policies, same use case as clinic license/cert
// uploads). Avoids a half-policied new bucket.
export const BRANCH_BUCKET = 'clinic-docs';

// Upload one File to `bucket`. Returns { name, path, size } — store this in the
// row (path for single fields, the whole object inside a jsonb array for
// multi-file fields). Throws on failure so the caller can toast.
export async function uploadFile(bucket, file, prefix = '') {
    const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) throw error;
    return { name: file.name, path, size: file.size };
}

// Short-lived signed URL for a stored object path. Returns null on any error
// (e.g. bucket/policy not set up yet) so callers can degrade gracefully.
export async function signedUrl(bucket, path, expiresSeconds = 3600) {
    if (!path) return null;
    try {
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresSeconds);
        if (error) { console.warn('[storage] sign:', error.message); return null; }
        return data?.signedUrl || null;
    } catch (e) {
        console.warn('[storage] sign:', e?.message || e);
        return null;
    }
}

// Best-effort delete of a stored object (used when the user removes a file).
export async function removeFile(bucket, path) {
    if (!path) return;
    try { await supabase.storage.from(bucket).remove([path]); }
    catch (e) { console.warn('[storage] remove:', e?.message || e); }
}
