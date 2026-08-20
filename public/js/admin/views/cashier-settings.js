// Настройки → «Смены кассы».
// CASHIER_SHIFT_MODE_V1 — per-clinic choice of how cashier shifts are run.
// Stored in companies.cashier_shift_mode (migration 116): 'manual' | 'auto'.
//   manual — the cashier opens the shift and closes it with the X/Z recount.
//   auto   — the shift is closed automatically at 00:00 (counted = expected,
//            no variance) and a new one opens automatically for the new day,
//            carrying the closing cash forward as the opening float.
// The rollover itself lives in cashier-shifts.js (maybeAutoRollover) and runs
// when the Касса page is opened — there is no server cron, so a shift left
// open overnight is closed/reopened the next time the cashier opens the page,
// but it is STAMPED at the 00:00 boundary so the day's reports stay correct.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, toast, clear } from '../ui.js';

const MODES = [
    {
        key: 'manual',
        icon: 'User',
        title: 'Вручную',
        sub: 'Кассир сам открывает смену и закрывает её с пересчётом (X/Z-отчёт).',
        bullets: [
            'Кассир нажимает «Открыть смену» в начале дня.',
            '«Закрыть и пересчитать» в конце дня — с расхождением излишек/недостача.',
            'Наличные передаются старшему кассиру вручную.',
        ],
    },
    {
        key: 'auto',
        icon: 'Clock',
        title: 'Автоматически в 00:00',
        sub: 'Смена закрывается в полночь и открывается заново каждый день — без действий кассира.',
        bullets: [
            'В 00:00 смена закрывается: пересчитано = ожидается, расхождение 0.',
            'Новая смена открывается автоматически; остаток переносится как начальный.',
            'Кнопки «Открыть смену» / «Закрыть смену» скрыты у кассира.',
        ],
    },
];

export async function renderCashierSettings(container) {
    clear(container);
    container.appendChild(h('div', { class: 'empty' }, 'Загрузка…'));

    const cid = (window.CLINIC && window.CLINIC.id) || null;
    if (!cid) {
        clear(container);
        container.appendChild(h('div', { class: 'empty' }, 'Нет контекста клиники.'));
        return;
    }

    const coRes = await supabase.from('companies').select('cashier_shift_mode').eq('id', cid).single();
    const migrationMissing = !!(coRes.error && /cashier_shift_mode/.test(coRes.error.message || ''));
    let mode = (!coRes.error && coRes.data && coRes.data.cashier_shift_mode) || 'manual';

    clear(container);
    container.appendChild(PageHead({
        title: 'Смены кассы',
        subtitle: 'Как ведутся смены кассиров в этой клинике',
    }));

    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' } });

    if (migrationMissing) {
        wrap.appendChild(h('div', { class: 'empty', style: { color: 'var(--warn-700, #b45309)' } },
            'Колонка cashier_shift_mode отсутствует — примените миграцию 116 в Supabase SQL editor.'));
    }

    const cards = {};
    const paint = () => {
        for (const m of MODES) {
            const on = mode === m.key;
            const c = cards[m.key];
            c.style.borderColor = on ? 'var(--primary-500, #14a78d)' : 'var(--ink-200)';
            c.style.background  = on ? 'var(--primary-50, #ecfdf5)' : 'var(--white)';
            c.style.boxShadow   = on ? '0 0 0 2px rgba(20,167,141,.15)' : 'none';
            const dot = c.querySelector('[data-dot]');
            if (dot) {
                dot.style.background   = on ? 'var(--primary-600, #0d8a72)' : 'transparent';
                dot.style.borderColor  = on ? 'var(--primary-600, #0d8a72)' : 'var(--ink-300)';
            }
        }
    };

    for (const m of MODES) {
        const card = h('div', {
            style: {
                border: '1px solid var(--ink-200)', borderRadius: '14px', padding: '14px 16px',
                cursor: migrationMissing ? 'not-allowed' : 'pointer', background: 'var(--white)',
                transition: 'border-color .12s, background .12s, box-shadow .12s',
                opacity: migrationMissing ? '.6' : '1',
            },
            onclick: () => { if (migrationMissing) return; mode = m.key; paint(); },
        },
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                h('span', { 'data-dot': '', style: {
                    width: '16px', height: '16px', borderRadius: '50%', flex: '0 0 auto', marginTop: '2px',
                    border: '2px solid var(--ink-300)', boxShadow: 'inset 0 0 0 3px var(--white)' } }),
                h('div', { style: { width: '30px', height: '30px', borderRadius: '9px', flex: '0 0 auto',
                        background: 'var(--ink-50)', color: 'var(--ink-700)', display: 'grid', placeItems: 'center' } },
                    Icon(m.icon, { size: 16 })),
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--ink-900)' } }, m.title),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px', lineHeight: 1.45 } }, m.sub),
                    h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px', color: 'var(--ink-600)', fontSize: '12px', lineHeight: 1.6 } },
                        ...m.bullets.map(b => h('li', null, b))),
                ),
            ),
        );
        cards[m.key] = card;
        wrap.appendChild(card);
    }

    const saveBtn = h('button', { class: 'btn btn-primary', disabled: migrationMissing ? '' : null },
        Icon('Check', { size: 14 }), ' Сохранить');
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            const { error } = await supabase.from('companies').update({ cashier_shift_mode: mode }).eq('id', cid);
            if (error) { toast('Не сохранилось: ' + error.message, 'fail'); return; }
            toast(mode === 'auto'
                ? 'Режим смен: автоматически в 00:00.'
                : 'Режим смен: вручную.', 'ok');
        } finally { if (saveBtn.isConnected) saveBtn.disabled = false; }
    });

    wrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: 1.5, marginTop: '2px' } },
        'Автоматический режим применяется при открытии страницы «Касса»: если смена осталась открытой со вчера, она закрывается задним числом на 00:00 и сразу открывается новая. Отчёты за день от этого не смещаются.'));
    wrap.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } }, saveBtn));

    container.appendChild(h('div', { class: 'card', style: { padding: '18px 20px' } }, wrap));
    paint();
}
