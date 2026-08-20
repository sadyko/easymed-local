// Platform → Support. Per-CLINIC conversations.
// Two-pane layout: left = clinics with conversations (sorted by most
// recent message + unread badge), right = full chat thread for the
// selected clinic + reply box. All messages for one clinic merge into
// a single chronological thread regardless of how many tickets exist
// underneath.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let state = {
    conversations: [],   // [{ company, tickets:[], messages:[], unread, lastAt, lastFrom, status }]
    selectedId:    null, // company_id
    pollTimer:     null,
    filter:        'all',
    search:        '',
};

const POLL_MS = 12_000;

// ---------------------------------------------------------------------
// Styles — local to this view, dark theme matching the console
// ---------------------------------------------------------------------
function injectStyles() {
    if (document.getElementById('sp-styles')) return;
    const s = document.createElement('style');
    s.id = 'sp-styles';
    s.textContent = `
/* Pin the support pane to the viewport — no page-level scroll.
   Overhead breakdown (must fit inside 100vh):
     tab-strip      ~48px
     topbar         ~68px  (h1 25 + sub 17 + 12+12 pad + 2 gap)
     content pad    24 top + 80 bottom = 104
   Total ≈ 220px. Use 224 to leave a 4px safety margin so a single-pixel
   measurement drift doesn't reintroduce the scroll. */
.sp-wrap {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 14px;
    height: calc(100vh - 224px);
    min-height: 0;
    overflow: hidden;
}
.sp-left { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.sp-left .sp-search-wrap { padding: 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.sp-left .sp-search-wrap input { width: 100%; padding: 8px 12px; background: var(--bg-3); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; font-size: 13px; outline: none; }
.sp-left .sp-search-wrap input:focus { border-color: var(--teal); }
.sp-left .sp-filter-row { display: flex; gap: 4px; }
.sp-left .sp-filter-row .chip { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-2); color: var(--ink-2); cursor: pointer; font-size: 11.5px; }
.sp-left .sp-filter-row .chip.on { background: var(--teal); color: white; border-color: transparent; }
.sp-conv-list { flex: 1; overflow-y: auto; }
.sp-conv { padding: 12px 14px; border-bottom: 1px solid var(--line); cursor: pointer; transition: background .08s; }
.sp-conv:hover { background: rgba(255,255,255,0.02); }
.sp-conv.on    { background: var(--bg-3); border-left: 3px solid var(--teal); padding-left: 11px; }
.sp-conv .sp-conv-top { display: flex; align-items: center; gap: 6px; }
.sp-conv .sp-conv-name { font-weight: 700; font-size: 13.5px; color: var(--ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-conv .sp-conv-time { font-size: 11px; color: var(--ink-3); flex-shrink: 0; }
.sp-conv .sp-conv-preview { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; line-height: 1.4; max-height: 36px; overflow: hidden; }
.sp-conv .sp-conv-preview .sp-preview-from { font-weight: 600; color: var(--ink-2); }
.sp-conv .sp-conv-meta { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.sp-conv .sp-unread { background: var(--red); color: white; font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; line-height: 1.4; }
.sp-conv-empty { padding: 30px 18px; color: var(--ink-3); text-align: center; font-size: 13px; }

.sp-right { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.sp-right-empty { flex: 1; display: grid; place-items: center; color: var(--ink-3); font-size: 14px; text-align: center; padding: 20px; }
.sp-thread-head { padding: 14px 18px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.sp-thread-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.sp-thread-head .sp-h-sub { margin-top: 4px; font-size: 12px; color: var(--ink-3); }
.sp-thread-head .sp-h-actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
.sp-thread-head .sp-h-actions .btn.small { padding: 4px 10px; font-size: 11.5px; }

.sp-thread { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; background: var(--bg); }
.sp-day-sep { align-self: center; font-size: 11px; color: var(--ink-3); padding: 4px 10px; background: var(--bg-3); border-radius: 999px; margin: 8px 0; }
.sp-msg { max-width: 78%; }
.sp-msg.user     { align-self: flex-start; }
.sp-msg.platform { align-self: flex-end; }
.sp-msg.system   { align-self: center; max-width: 100%; }
.sp-msg .sp-msg-bub { padding: 9px 13px; font-size: 13.5px; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; border-radius: 14px; }
.sp-msg.user .sp-msg-bub     { background: var(--bg-2); color: var(--ink); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
.sp-msg.platform .sp-msg-bub { background: linear-gradient(180deg, #0d8a8a, #0a6e6e); color: white; border-bottom-right-radius: 4px; }
.sp-msg.system .sp-msg-bub   { background: transparent; color: var(--ink-3); font-size: 11.5px; font-style: italic; border: none; padding: 4px 8px; }
.sp-msg .sp-msg-meta { font-size: 10.5px; color: var(--ink-3); margin-top: 3px; padding: 0 6px; }
.sp-msg.user .sp-msg-meta     { text-align: left; }
.sp-msg.platform .sp-msg-meta { text-align: right; }

.sp-foot { flex-shrink: 0; padding: 12px 18px; border-top: 1px solid var(--line); background: var(--bg-2); }
.sp-foot textarea { width: 100%; min-height: 56px; max-height: 160px; padding: 9px 12px; background: var(--bg-3); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; font-family: inherit; font-size: 13.5px; resize: vertical; outline: none; line-height: 1.5; box-sizing: border-box; }
.sp-foot textarea:focus { border-color: var(--teal); }
.sp-foot .sp-foot-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.sp-foot .sp-foot-row .sp-hint { color: var(--ink-3); font-size: 11px; flex: 1; }
.sp-foot .sp-foot-err { color: var(--red); font-size: 12px; margin-top: 6px; min-height: 16px; }
`;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------
async function loadConversations() {
    const { supabase } = mountedCtx;
    const [tRes, mRes, cRes] = await Promise.all([
        supabase.from('support_tickets')
            .select('id, company_id, subject, status, last_message_at, last_message_from, unread_for_platform, unread_for_user, created_at'),
        supabase.from('support_messages')
            .select('id, ticket_id, sender, body, created_at, author_user_id')
            .order('created_at', { ascending: true }),
        supabase.from('companies').select('id, name, slug, plan'),
    ]);
    if (tRes.error || mRes.error || cRes.error) {
        return { error: tRes.error || mRes.error || cRes.error };
    }

    const companies = {};
    for (const c of (cRes.data || [])) companies[c.id] = c;

    const ticketsByCompany = {};
    for (const t of (tRes.data || [])) {
        (ticketsByCompany[t.company_id] ||= []).push(t);
    }

    const messagesByTicket = {};
    for (const m of (mRes.data || [])) {
        (messagesByTicket[m.ticket_id] ||= []).push(m);
    }

    const conversations = [];
    for (const [companyId, tickets] of Object.entries(ticketsByCompany)) {
        const company = companies[companyId];
        if (!company) continue;
        const allMessages = [];
        for (const t of tickets) {
            for (const m of (messagesByTicket[t.id] || [])) {
                allMessages.push({ ...m, ticket_status: t.status });
            }
        }
        allMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const last = allMessages[allMessages.length - 1];
        const unread = tickets.reduce((s, t) => s + (t.unread_for_platform || 0), 0);
        // Pick the "primary" active ticket for replies (latest open/waiting_user; else latest)
        const active = tickets.find(t => t.status === 'open' || t.status === 'waiting_user')
                       || tickets.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))[0];
        conversations.push({
            company,
            tickets,
            messages:  allMessages,
            lastAt:    last?.created_at || active?.last_message_at,
            lastFrom:  last?.sender,
            lastBody:  last?.body,
            unread,
            status:    active?.status || 'open',
            activeTicketId: active?.id,
        });
    }
    conversations.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    return { conversations };
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
export async function renderSupport(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    injectStyles();
    root.innerHTML = `
      <div class="sp-wrap">
        <aside class="sp-left">
          <div class="sp-search-wrap">
            <input id="sp-search" placeholder="Search clinic, message…">
            <div class="sp-filter-row">
              <button class="chip on" data-filter="all">All</button>
              <button class="chip" data-filter="unread">Unread</button>
              <button class="chip" data-filter="open">Open</button>
              <button class="chip" data-filter="resolved">Resolved</button>
            </div>
          </div>
          <div class="sp-conv-list" id="sp-list">
            <div class="row-loading"><div class="spinner"></div>Loading…</div>
          </div>
        </aside>
        <section class="sp-right" id="sp-right">
          <div class="sp-right-empty">Pick a clinic on the left to read the conversation.</div>
        </section>
      </div>
    `;

    root.querySelector('#sp-search').addEventListener('input', e => {
        state.search = e.target.value.toLowerCase().trim();
        renderConversationList();
    });
    root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
        root.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        state.filter = b.dataset.filter;
        renderConversationList();
    }));

    await refresh();
    // Poll for new messages while this view is mounted
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, POLL_MS);
    // Cleanup poll when navigated away — best-effort via MutationObserver
    new MutationObserver((muts, obs) => {
        if (!document.body.contains(root)) {
            if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
            obs.disconnect();
        }
    }).observe(document.body, { childList: true, subtree: true });
}

async function refresh() {
    const res = await loadConversations();
    if (res.error) {
        mountedRoot.querySelector('#sp-list').innerHTML = `<div class="sp-conv-empty">Failed: ${esc(res.error.message)}</div>`;
        return;
    }
    state.conversations = res.conversations;
    renderConversationList();
    if (state.selectedId) renderThread(state.selectedId);
    if (mountedCtx.refreshBadges) mountedCtx.refreshBadges();
}

function renderConversationList() {
    const list = mountedRoot.querySelector('#sp-list');
    let convs = state.conversations;
    if (state.search) {
        const s = state.search;
        convs = convs.filter(c =>
            (c.company.name || '').toLowerCase().includes(s)
            || (c.company.slug || '').toLowerCase().includes(s)
            || (c.lastBody || '').toLowerCase().includes(s)
        );
    }
    switch (state.filter) {
        case 'unread':   convs = convs.filter(c => c.unread > 0); break;
        case 'open':     convs = convs.filter(c => c.status === 'open' || c.status === 'waiting_user'); break;
        case 'resolved': convs = convs.filter(c => c.status === 'resolved'); break;
    }
    if (convs.length === 0) {
        list.innerHTML = `<div class="sp-conv-empty">No conversations match.</div>`;
        return;
    }
    list.innerHTML = convs.map(c => {
        const initial = (c.company.name || '?')[0].toUpperCase();
        const preview = c.lastBody
            ? `${c.lastFrom === 'platform' ? '<span class="sp-preview-from">You: </span>' : ''}${esc(truncate(c.lastBody, 80))}`
            : '<em>No messages yet</em>';
        return `
            <div class="sp-conv ${c.company.id === state.selectedId ? 'on' : ''}" data-id="${esc(c.company.id)}">
                <div class="sp-conv-top">
                    <div class="sp-conv-name">${esc(c.company.name)}</div>
                    <div class="sp-conv-time">${c.lastAt ? fmtRelative(c.lastAt) : ''}</div>
                </div>
                <div class="sp-conv-preview">${preview}</div>
                <div class="sp-conv-meta">
                    <span class="badge ${esc(c.company.plan || 'trial')}">${esc(c.company.plan || 'trial')}</span>
                    <span class="badge ${statusBadgeClass(c.status)}">${esc(c.status.replace('_',' '))}</span>
                    ${c.unread > 0 ? `<span class="sp-unread">${c.unread}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');
    list.querySelectorAll('.sp-conv').forEach(el => el.addEventListener('click', () => {
        state.selectedId = el.dataset.id;
        renderConversationList();
        renderThread(el.dataset.id);
    }));
}

function statusBadgeClass(s) {
    return ({ open: 'pending', waiting_user: 'starter', resolved: 'approved', closed: 'inactive' })[s] || 'inactive';
}

function truncate(s, n) {
    s = String(s).replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function renderThread(companyId) {
    const c = state.conversations.find(x => x.company.id === companyId);
    const right = mountedRoot.querySelector('#sp-right');
    if (!c) {
        right.innerHTML = `<div class="sp-right-empty">Conversation not found.</div>`;
        return;
    }
    const subdomain = c.company.slug ? `${c.company.slug}.easymed.uz` : '(no slug)';
    right.innerHTML = `
      <div class="sp-thread-head">
        <h3>${esc(c.company.name)}</h3>
        <div class="sp-h-sub">
            <a href="https://${esc(subdomain)}/admin" target="_blank">${esc(subdomain)}</a>
            · <span class="badge ${esc(c.company.plan || 'trial')}">${esc(c.company.plan || 'trial')}</span>
            · ${c.tickets.length} ticket${c.tickets.length === 1 ? '' : 's'}
            · last reply ${c.lastAt ? fmtRelative(c.lastAt) : '—'}
            · <span class="badge ${statusBadgeClass(c.status)}">${esc(c.status.replace('_',' '))}</span>
        </div>
        <div class="sp-h-actions">
            <button class="btn small" data-thread-act="resolved">Mark resolved</button>
            <button class="btn small" data-thread-act="closed">Close ticket</button>
            <button class="btn small" id="sp-reopen" ${c.status !== 'closed' && c.status !== 'resolved' ? 'style="display:none"' : ''} data-thread-act="open">Reopen</button>
        </div>
      </div>
      <div class="sp-thread" id="sp-thread"></div>
      <div class="sp-foot">
        <textarea id="sp-reply" rows="3" placeholder="Type your reply to ${esc(c.company.name)}…"></textarea>
        <div class="sp-foot-err" id="sp-reply-err"></div>
        <div class="sp-foot-row">
            <div class="sp-hint">Enter to send · Shift+Enter for newline · sent as platform reply</div>
            <button class="btn primary" id="sp-send">Send reply</button>
        </div>
      </div>
    `;

    const thread = right.querySelector('#sp-thread');
    thread.innerHTML = renderMessages(c.messages);
    thread.scrollTop = thread.scrollHeight;

    // Mark all unread tickets as read for the platform side
    const { supabase } = mountedCtx;
    for (const t of c.tickets) {
        if (t.unread_for_platform > 0) {
            await supabase.rpc('mark_support_read_platform', { p_ticket_id: t.id });
        }
    }

    const replyEl = right.querySelector('#sp-reply');
    const errEl   = right.querySelector('#sp-reply-err');
    const sendEl  = right.querySelector('#sp-send');
    async function doSend() {
        const body = replyEl.value.trim();
        errEl.textContent = '';
        if (!body) { errEl.textContent = 'Reply is empty.'; return; }
        sendEl.disabled = true;
        try {
            const { error } = await supabase.rpc('send_support_reply', { p_ticket_id: c.activeTicketId, p_body: body });
            if (error) { errEl.textContent = error.message; return; }
            replyEl.value = '';
            await refresh();
            toast('Reply sent.', 'ok');
        } finally {
            sendEl.disabled = false;
            replyEl.focus();
        }
    }
    sendEl.addEventListener('click', doSend);
    replyEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    right.querySelectorAll('[data-thread-act]').forEach(b => b.addEventListener('click', async () => {
        const newStatus = b.dataset.threadAct;
        if (!c.activeTicketId) return;
        const { error } = await supabase.from('support_tickets').update({ status: newStatus }).eq('id', c.activeTicketId);
        if (error) { toast('Failed: ' + error.message, 'err'); return; }
        toast('Marked ' + newStatus.replace('_',' ') + '.', 'ok');
        await refresh();
    }));
}

function renderMessages(msgs) {
    if (!msgs || msgs.length === 0) {
        return `<div style="margin:auto; color:var(--ink-3); text-align:center; font-size:13px; padding:30px;">No messages yet.</div>`;
    }
    let lastDay = null;
    return msgs.map(m => {
        const d = new Date(m.created_at);
        const day = d.toDateString();
        let sep = '';
        if (day !== lastDay) {
            sep = `<div class="sp-day-sep">${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>`;
            lastDay = day;
        }
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            ${sep}
            <div class="sp-msg ${esc(m.sender)}">
                <div class="sp-msg-bub">${esc(m.body)}</div>
                <div class="sp-msg-meta">${esc(time)}${m.ticket_status === 'closed' ? ' · ticket closed' : ''}</div>
            </div>
        `;
    }).join('');
}
