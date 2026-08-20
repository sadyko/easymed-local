// Settings → General → «Скидки пациентов» (PATIENT_DISCOUNTS_V1).
// Manages patient_discounts: gift cards (with balances), promo codes (percent or
// fixed discount, usage limits) and certificates — optionally bound to a specific
// patient, with min-purchase / validity / usage limits. Redeemed in the booking
// wizard's payment step (CATALOG_WIZARD_V3); gift/cert redemptions decrement
// `remaining` and land as payments method 'gift_card' (notes 'gift:<id>').
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, toast, clear, fmtDate, initials, avColor } from '../ui.js';
import { loadPatientsPaged, insertRow, currentUser } from '../data.js';

const KINDS = [
    ['promo_code',  'Промокод'],
    ['gift_card',   'Подарочная карта'],
    ['certificate', 'Сертификат'],
];
const KIND_RU = Object.fromEntries(KINDS);
const fmtUZS = (n) => (Number(n) || 0).toLocaleString('ru-RU');

const state = { kind: '', q: '', rows: [], patients: {}, loaded: false };

export async function renderDiscountsSettings(container, { onNavigate } = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    const listBox = h('div');

    async function loadRows() {
        try {
            const { data, error } = await supabase.from('patient_discounts')
                .select('*').order('created_at', { ascending: false });
            if (error) throw error;
            state.rows = data || [];
            const pids = [...new Set(state.rows.map(r => r.patient_id).filter(Boolean))];
            state.patients = {};
            if (pids.length) {
                const { data: ps } = await supabase.from('patients')
                    .select('id, full_name, first_name, last_name, mrn').in('id', pids);
                for (const p of (ps || [])) state.patients[p.id] = (p.full_name || [p.last_name, p.first_name].filter(Boolean).join(' ') || '—') + (p.mrn ? ' · ' + p.mrn : '');
            }
        } catch (e) {
            toast('Не удалось загрузить: ' + (e.message || e), 'fail');
            state.rows = [];
        }
        state.loaded = true;
    }

    function valueCell(r) {
        if (r.kind === 'promo_code') {
            return r.discount_type === 'amount'
                ? h('span', { class: 'num', style: { fontWeight: 700 } }, '−' + fmtUZS(r.amount) + ' сум')
                : h('span', { class: 'num', style: { fontWeight: 700 } }, '−' + Number(r.percent || 0) + '%');
        }
        const rem = Number(r.remaining ?? r.amount ?? 0);
        return h('span', null,
            h('span', { class: 'num', style: { fontWeight: 700, color: rem > 0 ? 'var(--ok-700)' : 'var(--ink-400)' } }, fmtUZS(rem)),
            h('span', { class: 'muted', style: { fontSize: '11px' } }, ' / ' + fmtUZS(r.amount) + ' сум'));
    }
    function limitsCell(r) {
        const bits = [];
        if (r.max_uses != null) bits.push(`${r.used_count || 0} из ${r.max_uses} исп.`);
        else if (r.used_count) bits.push(`${r.used_count} исп.`);
        if (Number(r.min_purchase) > 0) bits.push('от ' + fmtUZS(r.min_purchase));
        return bits.join(' · ') || '—';
    }
    function validityCell(r) {
        if (!r.valid_from && !r.valid_to) return 'бессрочно';
        return [r.valid_from ? fmtDate(r.valid_from) : '…', r.valid_to ? fmtDate(r.valid_to) : '…'].join(' — ');
    }
    function statusTag(r) {
        const today = new Date().toISOString().slice(0, 10);
        if (!r.active) return h('span', { class: 'tag' }, 'Выключен');
        if (r.valid_to && r.valid_to < today) return h('span', { class: 'tag tag-crit' }, 'Истёк');
        if (r.kind !== 'promo_code' && !(Number(r.remaining ?? 0) > 0)) return h('span', { class: 'tag tag-warn' }, 'Исчерпан');
        if (r.max_uses != null && Number(r.used_count || 0) >= Number(r.max_uses)) return h('span', { class: 'tag tag-warn' }, 'Лимит');
        return h('span', { class: 'tag tag-ok' }, 'Активен');
    }

    function paintList() {
        clear(listBox);
        const ql = state.q.trim().toLowerCase();
        const rows = state.rows.filter(r =>
            (!state.kind || r.kind === state.kind) &&
            (!ql || (r.code || '').toLowerCase().includes(ql) || (r.name || '').toLowerCase().includes(ql)
                 || (state.patients[r.patient_id] || '').toLowerCase().includes(ql)));
        const chips = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
            ...[['', 'Все'], ...KINDS].map(([k, l]) => {
                const n = k ? state.rows.filter(r => r.kind === k).length : state.rows.length;
                return h('button', { class: 'btn btn-sm ' + (state.kind === k ? 'btn-primary' : 'btn-outline'), type: 'button',
                    onclick: () => { state.kind = k; paintList(); } }, `${l} · ${n}`);
            }));
        const search = h('input', { type: 'search', placeholder: 'Код, название или пациент…', value: state.q,
            style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', minWidth: '240px', fontFamily: 'inherit' },
            oninput: (e) => { state.q = e.target.value; paintBody(); } });
        const tb = h('tbody');
        for (const r of rows) tb.appendChild(rowEl(r));
        const bodyEl = rows.length
            ? h('table', { class: 'tbl', style: { width: '100%' } },
                h('thead', null, h('tr', null,
                    h('th', null, 'Код'), h('th', null, 'Тип'), h('th', null, 'Название'),
                    h('th', null, 'Скидка / остаток'), h('th', null, 'Пациент'),
                    h('th', null, 'Лимиты'), h('th', null, 'Действует'), h('th', null, 'Статус'), h('th', null, ''))),
                tb)
            : h('div', { class: 'empty', style: { padding: '40px 20px' } },
                state.rows.length ? 'Ничего не найдено.' : 'Пока пусто — создайте промокод, карту или сертификат.');

        listBox.appendChild(h('div', { class: 'card' },
            h('div', { class: 'card-header', style: { flexWrap: 'wrap', gap: '10px' } }, chips, h('span', { class: 'grow' }), search),
            bodyEl));

        function paintBody() {
            // search keystrokes repaint only the table body, keeping input focus
            const fresh = state.rows.filter(r =>
                (!state.kind || r.kind === state.kind) &&
                (!state.q.trim() || (r.code || '').toLowerCase().includes(state.q.trim().toLowerCase())
                    || (r.name || '').toLowerCase().includes(state.q.trim().toLowerCase())
                    || (state.patients[r.patient_id] || '').toLowerCase().includes(state.q.trim().toLowerCase())));
            clear(tb);
            for (const r of fresh) tb.appendChild(rowEl(r));
        }
        function rowEl(r) {
            return h('tr', null,
                h('td', { class: 'num', style: { fontWeight: 700, whiteSpace: 'nowrap' } }, r.code),
                h('td', null, h('span', { class: 'tag ' + (r.kind === 'promo_code' ? 'tag-info' : 'tag-purple') }, KIND_RU[r.kind] || r.kind)),
                h('td', null, r.name || '—'),
                h('td', null, valueCell(r)),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, r.patient_id ? (state.patients[r.patient_id] || '…') : 'любой пациент'),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, limitsCell(r)),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, validityCell(r)),
                h('td', null, statusTag(r)),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditor(r) }, 'Изменить'),
                    h('button', { class: 'btn btn-ghost btn-sm', style: { color: r.active ? 'var(--crit-700)' : 'var(--ok-700)' },
                        onclick: async () => {
                            const { error } = await supabase.from('patient_discounts').update({ active: !r.active }).eq('id', r.id);
                            if (error) { toast('Не удалось: ' + error.message, 'fail'); return; }
                            r.active = !r.active; paintList();
                        } }, r.active ? 'Выключить' : 'Включить')),
            );
        }
    }

    // ---- create / edit dialog ----
    function openEditor(row) {
        const isNew = !row;
        const r = row || { kind: 'promo_code', discount_type: 'percent', active: true, min_purchase: 0 };
        const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const fld = (label, el, span) => { const w = h('div', { class: 'field' }, h('label', null, label), el); if (span) w.style.gridColumn = 'span 2'; return w; };
        const inp = (props) => h('input', { style: { width: '100%', boxSizing: 'border-box' }, ...props });

        const fKind = h('select', { style: { width: '100%' }, onchange: () => syncKind() },
            ...KINDS.map(([v, l]) => h('option', { value: v, selected: r.kind === v ? '' : null }, l)));
        const fCode = inp({ value: r.code || '', placeholder: 'НАПР. WELCOME10' });
        const genBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '4px' },
            onclick: () => { fCode.value = (KIND_RU[fKind.value] === 'Промокод' ? 'P' : 'G') + '-' + Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join(''); } },
            'Сгенерировать');
        const fName = inp({ value: r.name || '', placeholder: 'Например: Акция к открытию' });
        const fDtype = h('select', { style: { width: '100%' }, onchange: () => syncKind() },
            h('option', { value: 'percent', selected: (r.discount_type || 'percent') === 'percent' ? '' : null }, 'Процент (%)'),
            h('option', { value: 'amount', selected: r.discount_type === 'amount' ? '' : null }, 'Фиксированная сумма'));
        const fPercent = inp({ type: 'number', min: '0', max: '100', value: r.percent != null ? String(r.percent) : '' });
        const fAmount = inp({ type: 'number', min: '0', value: r.amount != null ? String(r.amount) : '' });
        const fRemaining = inp({ type: 'number', min: '0', value: r.remaining != null ? String(r.remaining) : '' });
        const fMin = inp({ type: 'number', min: '0', value: r.min_purchase != null ? String(r.min_purchase) : '0' });
        const fMaxUses = inp({ type: 'number', min: '0', value: r.max_uses != null ? String(r.max_uses) : '', placeholder: 'без лимита' });
        const fFrom = inp({ type: 'date', value: r.valid_from || '' });
        const fTo = inp({ type: 'date', value: r.valid_to || '' });
        const fActive = h('select', { style: { width: '100%' } },
            h('option', { value: '1', selected: r.active !== false ? '' : null }, 'Активен'),
            h('option', { value: '0', selected: r.active === false ? '' : null }, 'Выключен'));
        const fNotes = h('textarea', { rows: '2', style: { width: '100%', boxSizing: 'border-box' } }, r.notes || '');

        // patient binding — debounced search picker (any patient OR a specific one)
        let pickedPatient = r.patient_id ? { id: r.patient_id, label: state.patients[r.patient_id] || 'пациент' } : null;
        const patBox = h('div');
        function paintPat() {
            clear(patBox);
            if (pickedPatient) {
                patBox.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                    h('span', { class: 'tag tag-ok' }, pickedPatient.label),
                    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { pickedPatient = null; paintPat(); } }, '× любой пациент')));
                return;
            }
            const res = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', maxHeight: '160px', overflow: 'auto' } });
            const si = h('input', { type: 'search', placeholder: 'Поиск пациента (или оставьте пустым — для всех)…',
                style: { width: '100%', boxSizing: 'border-box' } });
            let t = null, seq = 0;
            si.addEventListener('input', () => {
                clearTimeout(t);
                t = setTimeout(async () => {
                    const my = ++seq;
                    const term = si.value.trim();
                    if (!term) { clear(res); return; }
                    try {
                        const { rows } = await loadPatientsPaged({ search: term, limit: 6 });
                        if (my !== seq) return;
                        clear(res);
                        for (const p of (rows || [])) {
                            const nm = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
                            const label = nm + (p.mrn ? ' · ' + p.mrn : '');
                            res.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { justifyContent: 'flex-start' },
                                onclick: () => { pickedPatient = { id: p.id, label }; paintPat(); } }, label));
                        }
                    } catch (_) { if (my === seq) clear(res); }
                }, 250);
            });
            patBox.appendChild(si);
            patBox.appendChild(res);
        }
        paintPat();

        const rowPercent = fld('Скидка, %', fPercent);
        const rowAmountPromo = fld('Скидка, сум', fAmount);
        const rowFace = fld('Номинал, сум', fAmount);
        const rowRemaining = fld('Остаток, сум', fRemaining);
        const rowDtype = fld('Тип скидки', fDtype);
        const rowMaxUses = fld('Лимит использований', fMaxUses);
        function syncKind() {
            const isPromo = fKind.value === 'promo_code';
            rowDtype.style.display = isPromo ? '' : 'none';
            rowPercent.style.display = isPromo && fDtype.value === 'percent' ? '' : 'none';
            rowAmountPromo.style.display = isPromo && fDtype.value === 'amount' ? '' : 'none';
            rowFace.style.display = isPromo ? 'none' : '';
            rowRemaining.style.display = (!isPromo && !isNew) ? '' : 'none';
            rowMaxUses.style.display = isPromo ? '' : 'none';
        }

        async function save(btn) {
            const kind = fKind.value;
            const code = fCode.value.trim().toUpperCase();
            if (!code) { toast('Укажите код.', 'fail'); return; }
            const payload = {
                kind, code,
                name: fName.value.trim() || null,
                discount_type: kind === 'promo_code' ? fDtype.value : null,
                percent: kind === 'promo_code' && fDtype.value === 'percent' ? (Number(fPercent.value) || 0) : null,
                amount: kind === 'promo_code'
                    ? (fDtype.value === 'amount' ? (Number(fAmount.value) || 0) : null)
                    : (Number(fAmount.value) || 0),
                remaining: kind === 'promo_code' ? null
                    : ((isNew || fRemaining.value === '') ? (Number(fAmount.value) || 0) : (Number(fRemaining.value) || 0)),
                patient_id: pickedPatient ? pickedPatient.id : null,
                min_purchase: Number(fMin.value) || 0,
                max_uses: kind === 'promo_code' && fMaxUses.value !== '' ? (Number(fMaxUses.value) || 0) : null,
                valid_from: fFrom.value || null,
                valid_to: fTo.value || null,
                active: fActive.value === '1',
                notes: fNotes.value.trim() || null,
            };
            if (kind === 'promo_code' && payload.discount_type === 'percent' && !(payload.percent > 0)) { toast('Укажите процент скидки.', 'fail'); return; }
            if (kind === 'promo_code' && payload.discount_type === 'amount' && !(payload.amount > 0)) { toast('Укажите сумму скидки.', 'fail'); return; }
            if (kind !== 'promo_code' && !(payload.amount > 0)) { toast('Укажите номинал.', 'fail'); return; }
            btn.disabled = true;
            try {
                if (isNew) {
                    payload.created_by_name = currentUser()?.full_name || null;
                    const { error } = await insertRow('patient_discounts', payload, { stampCreatedBy: false });
                    if (error) throw error;
                    toast('Создано: ' + code);
                } else {
                    const { error } = await supabase.from('patient_discounts').update(payload).eq('id', r.id);
                    if (error) throw error;
                    toast('Сохранено');
                }
                close();
                await loadRows(); paintList();
            } catch (e) {
                toast(/duplicate|uniq/i.test(e.message || '') ? 'Такой код уже существует.' : 'Не удалось сохранить: ' + (e.message || e), 'fail');
                btn.disabled = false;
            }
        }

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Coins', { size: 16 }), ' ', isNew ? 'Новая скидка' : 'Изменить — ' + (r.code || '')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 14px' } },
                fld('Тип', fKind),
                fld('Код', h('div', null, fCode, genBtn)),
                fld('Название', fName, true),
                rowDtype, rowPercent, rowAmountPromo, rowFace, rowRemaining,
                fld('Мин. сумма счёта, сум', fMin),
                rowMaxUses,
                fld('Действует с', fFrom), fld('Действует по', fTo),
                fld('Статус', fActive),
                fld('Пациент (опционально)', patBox, true),
                fld('Заметка', fNotes, true)),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
                h('button', { class: 'btn', onclick: close }, 'Отмена'),
                h('button', { class: 'btn btn-primary', onclick: (ev) => save(ev.currentTarget) }, Icon('Check', { size: 14 }), ' Сохранить'))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
        syncKind();
        setTimeout(() => fCode.focus(), 30);
    }

    root.appendChild(PageHead({
        title: 'Скидки пациентов',
        subtitle: 'Промокоды, подарочные карты и сертификаты — применяются на шаге «Оплата» при записи. Можно привязать к пациенту и ограничить лимитами.',
        right: [h('button', { class: 'btn btn-primary', onclick: () => openEditor(null) }, Icon('Plus', { size: 14 }), ' Создать')],
    }));
    root.appendChild(listBox);

    listBox.appendChild(h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'Загрузка…'));
    await loadRows();
    paintList();
}
