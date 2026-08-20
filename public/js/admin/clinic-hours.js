// WORKING_HOURS_CLINIC_BOUND_V1 — shared clinic (branch) open-hours, used to bound a doctor's
// (or room's) bookable window so slots never fall outside the clinic's hours. Mirrors the
// gateway slot engine's combined_day_window (slots.py). Ranges are in MINUTES.
import { supabase } from '../supabase.js';

let _cache = null;   // { [branchId]: { wh, is24 } }
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const _p = (x) => { const [h, m] = String(x || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export async function loadClinicHours() {
    if (_cache) return _cache;
    _cache = {};
    try {
        const { data } = await supabase.from('branches').select('id, working_hours, is_24_7').eq('active', true);
        for (const b of (data || [])) _cache[b.id] = { wh: b.working_hours, is24: !!b.is_24_7 };
    } catch (e) { /* non-fatal: no clinic bound */ }
    return _cache;
}

// {fromMin,toMin} = clinic open window that day · null = clinic closed · undefined = no bound (24/7, unknown, no hours)
export function clinicRangeForDay(branchId, dayIso) {
    const c = _cache && branchId && _cache[branchId];
    if (!c) return undefined;
    if (c.is24 || !c.wh || typeof c.wh !== 'object') return undefined;
    const slot = c.wh[WD[new Date(dayIso + 'T00:00:00').getDay()]];
    if (!slot || slot.enabled === false) return null;
    const from = slot.from ? _p(slot.from) : 0, to = slot.to ? _p(slot.to) : 1440;
    return to > from ? { fromMin: from, toMin: to } : null;
}

// Narrow a {from,to} (minutes) by the clinic's hours for the day. null = off (closed / no overlap / input null).
export function clampToClinic(range, branchId, dayIso) {
    if (!range) return null;
    const cr = clinicRangeForDay(branchId, dayIso);
    if (cr === undefined) return range;
    if (cr === null) return null;
    const from = Math.max(range.from, cr.fromMin), to = Math.min(range.to, cr.toMin);
    return to > from ? { from, to } : null;
}
