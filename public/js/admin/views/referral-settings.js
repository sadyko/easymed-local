// Настройки → Направления → «Реферальное вознаграждение».
// REFERRAL_REWARDS_V1 — clinic-wide GENERAL reward rates, % per product group
// (service_types), stored in companies.referral_reward_rates jsonb
// { service_type_id: percent }. Referral sources with commission_mode='general'
// use these rates; 'manual' sources carry their own map (edited in the source
// list). Rewards are calculated in the «Рефералы» report (reports-export.js).
import { supabase } from '../../supabase.js';
import { h, PageHead, toast, clear } from '../ui.js';

export async function renderReferralSettings(container) {
    clear(container);
    container.appendChild(h('div', { class: 'empty' }, 'Загрузка…'));
    const cid = (window.CLINIC && window.CLINIC.id) || null;
    if (!cid) {
        clear(container);
        container.appendChild(h('div', { class: 'empty' }, 'Нет контекста клиники.'));
        return;
    }
    const [typesRes, coRes] = await Promise.all([
        supabase.from('service_types').select('id, name').eq('company_id', cid).eq('active', true).order('name'),
        supabase.from('companies').select('referral_reward_rates').eq('id', cid).single(),
    ]);
    const types = typesRes.data || [];
    const migrationMissing = !!(coRes.error && /referral_reward_rates/.test(coRes.error.message || ''));
    const rates = (!coRes.error && coRes.data && coRes.data.referral_reward_rates) || {};

    clear(container);
    const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '460px' } });
    if (migrationMissing) {
        rows.appendChild(h('div', { class: 'empty', style: { color: 'var(--warn-700, #b45309)' } },
            'Колонка referral_reward_rates отсутствует — примените миграцию 103 в Supabase SQL editor.'));
    }
    if (!types.length) {
        rows.appendChild(h('div', { class: 'empty' }, 'Группы услуг не найдены.'));
    }
    for (const t of types) {
        rows.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '9px 12px', border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'var(--white)' } },
            h('span', { style: { fontSize: '13.5px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, t.name),
            h('span', { style: { flex: 'none' } },
                h('input', { type: 'number', min: '0', max: '100', step: '0.1', 'data-rr-type': t.id,
                    value: rates[t.id] != null ? String(rates[t.id]) : '', placeholder: '0',
                    style: { width: '90px', textAlign: 'right', padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '8px', font: 'inherit' } }),
                h('span', { class: 'muted', style: { marginLeft: '6px' } }, '%'))));
    }

    const saveBtn = h('button', { class: 'btn btn-primary', disabled: migrationMissing ? '' : null, onclick: async (ev) => {
        const btn = ev.currentTarget;
        const obj = {};
        for (const inp of rows.querySelectorAll('input[data-rr-type]')) {
            const raw = inp.value.trim();
            if (raw === '' || Number.isNaN(Number(raw))) continue;
            obj[inp.dataset.rrType] = Number(raw);
        }
        btn.disabled = true;
        try {
            const { error } = await supabase.from('companies').update({ referral_reward_rates: obj }).eq('id', cid);
            if (error) toast('Не сохранилось: ' + error.message, 'fail');
            else toast('Общие ставки сохранены', 'ok');
        } finally { if (btn.isConnected) btn.disabled = false; }
    } }, 'Сохранить');

    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Реферальное вознаграждение',
            subtitle: 'Общие ставки, % по группам услуг. Применяются к источникам с режимом «Общий»; источники «Вручную» задают свои ставки в списке источников. Пусто = 0%.',
        }),
        rows,
        h('div', null, saveBtn),
    ));
}
