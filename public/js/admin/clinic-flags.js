// Per-clinic feature flags, fetched once via the gateway. Fail-soft to {} so
// every consumer treats "can't load" as "all features off" (today's behavior).
// CUSTOM_CLINIC_V1.
import { gw } from './gateway.js';

let _cache = null;
let _inflight = null;

export async function clinicFlags() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try { _cache = (await gw('/company/flags')) || {}; }
        catch (e) { console.warn('[clinic-flags]', e && e.message); _cache = {}; }
        _inflight = null;
        return _cache;
    })();
    return _inflight;
}

export function clinicFlagsSync() { return _cache || {}; }
