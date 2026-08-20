// Patient activity log — generic "who did what to this patient" feed.
// Backed by the `patient_activity_log` table (migration 011). Every code
// path that mutates patient-relevant state (invoice cancel, service
// add/remove, referral sent, status change) should call
// `logPatientActivity` so the patient card can render one unified
// timeline under the Visits tab.

import { supabase } from '../../supabase.js';
import { h, Icon } from '../ui.js';
import { currentActor } from './invoice-actions.js';

// Insert one row. Non-fatal — logging hiccups must never roll back the
// underlying action that already succeeded.
export async function logPatientActivity({
    patientId,
    visitId      = null,
    entityType,
    entityId     = null,
    entityLabel  = null,
    action,
    summary      = null,
    detail       = null,
} = {}) {
    if (!patientId) return;            // nothing to attach the row to
    const actor = currentActor();
    const row = {
        patient_id:    patientId,
        visit_id:      visitId,
        entity_type:   entityType,
        entity_id:     entityId,
        entity_label:  entityLabel,
        action,
        summary,
        detail,
        actor_user_id: actor.id,
        actor_name:    actor.name,
        actor_role:    actor.role,
    };
    const { error } = await supabase.from('patient_activity_log').insert(row);
    if (error) {
        if (/relation .* does not exist|patient_activity_log/i.test(error.message)) {
            console.warn('[patient_activity_log] table missing — apply migration 011_patient_activity_log.sql');
        } else {
            console.warn('[patient_activity_log] insert failed:', error.message);
        }
    }
}

// Load the most recent N rows for a patient. Joins users so the actor's
// current name is preferred over the snapshot when available.
export async function loadPatientActivity(patientId, limit = 100) {
    if (!patientId) return [];
    const { data, error } = await supabase
        .from('patient_activity_log')
        .select('*, users:actor_user_id(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) {
        if (/relation .* does not exist|patient_activity_log/i.test(error.message)) {
            console.warn('[patient_activity_log] table missing — apply migration 011_patient_activity_log.sql');
        } else {
            console.warn('[patient_activity_log] load failed:', error.message);
        }
        return [];
    }
    return (data || []).map(r => ({
        ...r,
        __actor_name: r.users?.full_name || r.actor_name || 'Unknown',
        __actor_role: r.users?.role      || r.actor_role || '',
    }));
}

// ---------------------------------------------------------------------------
// Rendering — used by the patient card's Visits tab. Builds a card with a
// table of events (newest first). When the patient has no activity yet the
// card explains what will appear here.
// ---------------------------------------------------------------------------
export function activityCard(rows) {
    return h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Doc', { size: 14 }), ' Activity log ',
                h('span', { class: 'h-count' }, String((rows || []).length))),
            h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                'Cancellations, refunds, referrals, service edits — newest first.'),
        ),
        (!rows || rows.length === 0)
            ? h('div', { class: 'empty', style: { padding: '24px 20px' } },
                h('p', null, 'No activity recorded yet.'),
                h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } },
                    'Every invoice cancel, refund, referral, and service edit for this patient will appear here.'))
            : h('table', { class: 'tbl', style: { fontSize: '12.5px' } },
                h('thead', null, h('tr', null,
                    h('th', { style: { width: '155px' } }, 'When'),
                    h('th', { style: { width: '110px' } }, 'What'),
                    h('th', null, 'Summary'),
                    h('th', { style: { width: '180px' } }, 'Who'),
                )),
                h('tbody', null, ...rows.map(activityRow)),
            ),
    );
}

function activityRow(r) {
    return h('tr', null,
        h('td', { class: 'muted', style: { fontSize: '11.5px' } }, formatStamp(r.created_at)),
        h('td', null, activityTag(r.entity_type, r.action)),
        h('td', null,
            h('div', { style: { fontWeight: 500, color: 'var(--ink-800)' } }, r.summary || '—'),
            r.entity_label && h('div', { class: 'muted', style: { fontSize: '11px' } }, r.entity_label),
        ),
        h('td', null,
            h('div', { style: { fontWeight: 600, color: 'var(--ink-800)' } }, r.__actor_name || 'Unknown'),
            r.__actor_role && h('div', { class: 'muted', style: { fontSize: '11px' } }, r.__actor_role),
        ),
    );
}

function activityTag(entityType, action) {
    // Map (entity, action) → { kind, text }. Falls back to a neutral tag
    // so newly added action types still render even before this table is
    // updated.
    const key = `${entityType}.${action}`;
    const map = {
        'invoice.created':        { kind: 'info', text: 'Invoice created'   },
        'invoice.paid':           { kind: 'ok',   text: 'Invoice paid'      },
        'invoice.partial':        { kind: 'warn', text: 'Partial payment'   },
        'invoice.debt':           { kind: 'warn', text: 'Debt left'         },
        'invoice.cancelled':      { kind: 'crit', text: 'Invoice cancelled' },
        'invoice.refunded':       { kind: 'crit', text: 'Refunded'          },
        'service.created':        { kind: 'info', text: 'Service added'     },
        'service.deleted':        { kind: 'crit', text: 'Service removed'   },
        'service.updated':        { kind: 'info', text: 'Service edited'    },
        'recommendation.sent':    { kind: 'info', text: 'Referral sent'     },
        'recommendation.cancelled':{ kind: 'crit', text: 'Referral cancelled' },
        'recommendation.done':    { kind: 'ok',   text: 'Referral fulfilled'  },
        'visit.created':          { kind: 'info', text: 'Visit created'     },
        'visit.status_change':    { kind: '',     text: 'Visit status'      },
        'visit.deleted':          { kind: 'crit', text: 'Visit deleted'     },
    };
    const m = map[key] || { kind: '', text: `${entityType} ${action}` };
    return h('span', { class: 'tag tag-' + m.kind }, m.text);
}

function formatStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
