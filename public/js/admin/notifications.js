// notifications.js — NOTIF_CENTER_V1
// Unifies the trial / company / license / branch banners into ONE notification model with two
// surfaces: a topbar BELL (red unread count + dropdown) and a dismissible top-banner stack.
// Auto-resolving: when a condition is met the item drops out of both surfaces and its dismiss
// flag clears. Dismissing a banner hides it (per clinic+user, localStorage) but it stays in the
// bell until resolved. Replaces renderTrialBanner / renderVerificationBanner / renderSetupChecklist.
import { supabase } from '../supabase.js';
import { h, Icon } from './ui.js';
import { openUploadModal } from './verify-banner.js?v=vb2';

let _styled = false;
function injectStyles() {
    if (_styled) return; _styled = true;
    const s = document.createElement('style');
    s.textContent = `
.em-bell{position:relative;width:38px;height:38px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;color:#475569;display:grid;place-items:center;cursor:pointer;font-family:inherit;}
.em-bell:hover{background:#f8fafc;color:#0d8a72;}
.em-bell-badge{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:#e11d48;color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center;line-height:1;box-shadow:0 0 0 2px #fff;}
#em-notif-dropdown{position:absolute;top:46px;right:0;width:340px;max-width:92vw;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 16px 40px rgba(13,30,44,.18);z-index:1000;overflow:hidden;}
#em-notif-dropdown .nd-head{padding:12px 14px;border-bottom:1px solid #eef2f4;font-weight:700;font-size:13.5px;color:#0b3a33;}
#em-notif-dropdown .nd-item{display:flex;gap:11px;padding:12px 14px;border-bottom:1px solid #f1f5f9;}
#em-notif-dropdown .nd-item:last-child{border-bottom:none;}
#em-notif-dropdown .nd-icon{width:30px;height:30px;border-radius:8px;flex:0 0 30px;display:grid;place-items:center;background:#e3f1ec;color:#0d8a72;}
#em-notif-dropdown .nd-item.warn .nd-icon{background:#fff4e0;color:#b45309;}
#em-notif-dropdown .nd-item.danger .nd-icon{background:#ffe4e6;color:#be123c;}
#em-notif-dropdown .nd-body{flex:1;min-width:0;}
#em-notif-dropdown .nd-title{font-weight:600;font-size:13px;color:#0c2a26;}
#em-notif-dropdown .nd-msg{font-size:12px;color:#5d7d75;margin-top:1px;line-height:1.4;}
#em-notif-dropdown .nd-cta{margin-top:7px;border:1px solid #0d8a72;background:#fff;color:#0a6e61;border-radius:7px;padding:5px 11px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;}
#em-notif-dropdown .nd-cta:hover{background:#0d8a72;color:#fff;}
#em-notif-dropdown .nd-empty{padding:26px 14px;text-align:center;color:#94a3b8;font-size:13px;}
#em-notif-banners{display:flex;flex-direction:column;}
.em-nbn{display:flex;align-items:center;gap:12px;padding:10px 18px;font-size:13px;border-bottom:1px solid #eef2f4;background:#f4faf8;color:#0c2a26;}
.em-nbn.warn{background:#fff7ed;border-bottom-color:#fed7aa;color:#7c2d12;}
.em-nbn.danger{background:#fff1f2;border-bottom-color:#fecdd3;color:#9f1239;}
.em-nbn .nbn-msg{flex:1;min-width:0;display:flex;align-items:center;gap:8px;line-height:1.4;}
.em-nbn .nbn-cta{flex:0 0 auto;border:none;border-radius:8px;padding:7px 14px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;background:#0d8a72;color:#fff;}
.em-nbn.warn .nbn-cta{background:#ea7a18;}
.em-nbn.danger .nbn-cta{background:#e11d48;}
.em-nbn .nbn-x{flex:0 0 auto;border:none;background:transparent;color:inherit;opacity:.6;font-size:18px;line-height:1;cursor:pointer;padding:2px 7px;border-radius:6px;}
.em-nbn .nbn-x:hover{opacity:1;background:rgba(0,0,0,.06);}`;
    document.head.appendChild(s);
}

function companyComplete(co) { return !!(co && co.name && co.phone && co.address); }

function nav(view) { try { window.easymed?.navigate?.(view); } catch (e) {} closeDropdown(); }

// NOTIF_LOCAL_ONLY_V1 — запрашиваем ТОЛЬКО то, что существует локально.
//
// Прежний loadState был наследием SaaS-версии: просил у companies колонки
// plan / trial_ends_at / is_locked / verification_status / name_ru, у branches —
// name_ru / district / company_id, и ходил в шлюз /public-site/dashboard.
// НИ ОДНОЙ из этих колонок в локальной базе нет, шлюза нет тоже — оба запроса
// падали 400 при КАЖДОЙ загрузке страницы с первого дня локальной версии.
// try/catch глотал ошибку, поэтому никто не видел; лог db-client её показал.
// Уведомления о пробном периоде и профиле филиала локально невозможны в
// принципе — убраны вместе с запросами, а не спрятаны обратно под catch.
async function loadState(clinic) {
    let co = null;
    try {
        const { data } = await supabase.from('companies')
            .select('id,name,phone,address').eq('id', clinic.id).limit(1);
        co = data && data[0];
    } catch (e) { /* нет строки — нет и напоминания */ }
    return { co };
}

function buildNotifs(clinic, st) {
    const { co } = st;
    const list = [];
    // NOTIF_POLICY_V2 (owner, 2026-07-21): напоминание срабатывает только по реально
    // ПРОЧИТАННОЙ и действительно неполной строке.
    if (co && !companyComplete(co)) list.push({ id: 'company', sev: 'info', icon: 'Building',
        title: 'Данные клиники', message: 'Заполните название, телефон и адрес клиники.',
        ctaLabel: 'Заполнить', onCta: () => nav('settings:companies') });
    return list;
}

function dismKey(clinic) { const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {}; return 'em.notif.dismissed.' + (clinic.id || 'x') + '.' + (u.id || u.auth_user_id || 'x'); }
function getDismissed(clinic) { try { return JSON.parse(localStorage.getItem(dismKey(clinic)) || '[]'); } catch (e) { return []; } }
function setDismissed(clinic, ids) { try { localStorage.setItem(dismKey(clinic), JSON.stringify(ids)); } catch (e) {} }

function closeDropdown() { document.getElementById('em-notif-dropdown')?.remove(); }

let _docBound = false;
function bindOutsideClose() {
    if (_docBound) return; _docBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('em-notif-dropdown');
        if (dd && !dd.contains(e.target) && !e.target.closest('.em-bell')) dd.remove();
    });
}

export async function renderNotifications(clinic) {
    injectStyles(); bindOutsideClose();
    document.getElementById('em-notif-banners')?.remove();
    if (!clinic || !clinic.id) { paintBell([], clinic); return; }
    const st = await loadState(clinic);
    const notifs = buildNotifs(clinic, st);
    const active = new Set(notifs.map((n) => n.id));
    const dism = getDismissed(clinic).filter((id) => active.has(id));
    setDismissed(clinic, dism);
    paintBell(notifs, clinic);
    paintBanners(notifs, clinic, dism);
}

function paintBell(notifs, clinic) {
    const mount = document.getElementById('topbar-bell');
    if (!mount) return;
    mount.innerHTML = '';
    const count = notifs.length;
    const btn = h('button', { class: 'em-bell', type: 'button', title: 'Уведомления',
        onclick: (e) => { e.stopPropagation(); if (document.getElementById('em-notif-dropdown')) { closeDropdown(); return; } openDropdown(notifs, clinic, mount); } },
        Icon('Bell', { size: 18 }),
        count > 0 ? h('span', { class: 'em-bell-badge' }, count > 9 ? '9+' : String(count)) : '');
    mount.appendChild(btn);
}

function openDropdown(notifs, clinic, mount) {
    closeDropdown();
    const dd = h('div', { id: 'em-notif-dropdown' },
        h('div', { class: 'nd-head' }, 'Уведомления'),
        notifs.length === 0
            ? h('div', { class: 'nd-empty' }, 'Всё в порядке — уведомлений нет.')
            : h('div', null, ...notifs.map((n) => h('div', { class: 'nd-item ' + (n.sev || 'info') },
                h('div', { class: 'nd-icon' }, Icon(n.icon || 'Info', { size: 15 })),
                h('div', { class: 'nd-body' },
                    h('div', { class: 'nd-title' }, n.title),
                    h('div', { class: 'nd-msg' }, n.message),
                    h('button', { class: 'nd-cta', type: 'button', onclick: n.onCta }, n.ctaLabel))))));
    mount.appendChild(dd);
}

function paintBanners(notifs, clinic, dism) {
    const visible = notifs.filter((n) => !dism.includes(n.id));
    if (!visible.length) return;
    const wrap = h('div', { id: 'em-notif-banners' }, ...visible.map((n) => {
        const row = h('div', { class: 'em-nbn ' + (n.sev || 'info') },
            h('span', { class: 'nbn-msg' }, Icon(n.icon || 'Info', { size: 15 }), n.message),
            h('button', { class: 'nbn-cta', type: 'button', onclick: n.onCta }, n.ctaLabel),
            h('button', { class: 'nbn-x', type: 'button', title: 'Скрыть', onclick: () => {
                const d = getDismissed(clinic); if (!d.includes(n.id)) d.push(n.id); setDismissed(clinic, d); row.remove();
                if (!document.querySelector('#em-notif-banners .em-nbn')) document.getElementById('em-notif-banners')?.remove();
            } }, '×'));
        return row;
    }));
    const root = document.querySelector('.app') || document.body.firstChild;
    document.body.insertBefore(wrap, root);
}
