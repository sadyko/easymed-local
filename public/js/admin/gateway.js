// EasyMed admin -> gateway (FastAPI at easymed.uz/api). Attaches the Supabase JWT. GATEWAY_CLIENT_V1
import { supabase } from '../supabase.js';

export async function gw(path, { method = 'GET', body = null } = {}) {
    let token = null;
    try { const { data } = await supabase.auth.getSession(); token = (data && data.session && data.session.access_token) || null; } catch (e) {}
    const res = await fetch('/api/v1' + path, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: body != null ? JSON.stringify(body) : null,
    });
    const txt = await res.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) throw new Error((data && (data.detail || data.message)) || (res.status + ' ' + txt));
    return data;
}
