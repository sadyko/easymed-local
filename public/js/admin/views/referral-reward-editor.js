// INTERNAL_REFERRAL_V1 (мигр. 122) — вознаграждение врача за НАПРАВЛЕНИЕ.
//
// Редактируется в карточке сотрудника, а хранится НЕ в карточке, а на его
// источнике направления — той же строке, которую читают отчёт «Рефералы» и
// кабинет врача (rpc/reports.js referralLines). Поэтому три экрана не могут
// показать три разные суммы за одно направление.
//
// Стандартная ставка сразу для всех — в Настройках, на категории «Внутренние
// врачи»; здесь её можно перекрыть одному врачу.
//
// REPORTS_V2 — ОДИН модуль на обе карточки сотрудника. Живая карточка
// (employees.js) показывала во вкладке «Вознаграждение за направления» таблицу,
// которая писала users.referral_rates — колонку, которую не читает никто:
// процент вводился, сохранялся и не платился. Рабочая правка жила только в
// старой карточке (employee-editor.js). Теперь обе рисуют эту и сохраняют этой
// же функцией — второй копии правила нет.
import { supabase } from '../../supabase.js';
import { h, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
// GROUPS_FIVE_REFERRAL_V1 (мигр. 153) — строки таблицы — ПЯТЬ групп услуг
// (services.type), ключ записи — группа; подписи — те же, что у группировки услуг.
import { REFERRAL_GROUPS, referralGroupOf } from '../../shared/referral-reward.js';
import { TYPE_TO_GROUP_NAME } from './service-group.js?v=aug17e';

/**
 * Редактор ставки. Состояние правки кладётся в holder.referralReward
 * ({ mode: 'category'|'own', percent, rates }) — и сразу при открытии (без
 * onChange: открытая вкладка — не правка), и при каждом изменении (с onChange).
 * readOnly — карточка сотрудника, которую ведёт главная клиника (STAFF_SYNC_V1):
 * поля рисуются, но не правятся.
 * @param {{ doctorId: number|string|null, holder: object, onChange: () => void, readOnly?: boolean }} p
 */
export function referralRewardEditor({ doctorId, holder, onChange, readOnly = false }) {
    const body = h('div', { style: { maxWidth: '640px' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));

    (async () => {
        if (!doctorId) {
            clear(body);
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Ставка задаётся после того, как сотрудник сохранён.')));
            return;
        }
        let src = null, cat = null;
        try {
            const srcRes = await supabase.from('referral_sources')
                .select('id, reward_mode, own_percent, own_rates, category_id').eq('doctor_id', doctorId).limit(1);
            src = (srcRes.data && srcRes.data[0]) || null;
            if (src && src.category_id != null) {
                const catRes = await supabase.from('referral_source_categories')
                    .select('id, name, standard_percent').eq('id', src.category_id).limit(1);
                cat = (catRes.data && catRes.data[0]) || null;
            }
        } catch (e) { /* показываем ниже */ }

        clear(body);
        if (!src) {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('У этого сотрудника нет карточки источника направления — она заводится только врачам.')));
            return;
        }

        let rates = [];
        try {
            rates = Array.isArray(src.own_rates) ? src.own_rates
                : (typeof src.own_rates === 'string' && src.own_rates.trim() ? JSON.parse(src.own_rates) : []);
        } catch { rates = []; }
        if (!Array.isArray(rates)) rates = [];
        const byGroup = new Map();
        for (const e of rates) {
            const g = e && referralGroupOf(e.group);
            if (g && !byGroup.has(g)) byGroup.set(g, e);
        }

        const stdNote = cat
            ? trf('Стандарт категории «{cat}»: {pct}% со всех услуг, кроме заданных в ней по группам.',
                  { cat: cat.name, pct: cat.standard_percent })
            : tr('Категория у источника не выбрана — без своей ставки вознаграждение будет нулевым.');

        const modeChk = h('input', { type: 'checkbox', checked: src.reward_mode !== 'own' });
        const pctInp = h('input', { type: 'number', min: '0', step: '0.01',
            value: src.own_percent != null && Number(src.own_percent) !== 0 ? String(src.own_percent) : '',
            placeholder: '0', style: { width: '140px' } });

        const tbody = h('tbody');
        for (const g of REFERRAL_GROUPS) {
            const cur = byGroup.get(g);
            tbody.appendChild(h('tr', null,
                h('td', null, tr(TYPE_TO_GROUP_NAME[g])),
                h('td', null, h('div', { class: 'rate-cell' },
                    h('input', { type: 'number', min: '0', step: '0.01', 'data-rate-group': g,
                        value: cur && Number.isFinite(Number(cur.value)) ? String(cur.value) : '',
                        placeholder: tr('по стандарту') }),
                    h('select', { 'data-rate-unit': g },
                        h('option', { value: 'pct', selected: !cur || cur.unit !== 'fix' }, '%'),
                        h('option', { value: 'fix', selected: !!(cur && cur.unit === 'fix') }, 'сум'))))));
        }

        const ownBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { class: 'field' },
                h('label', null, tr('Свой процент — со всех услуг, кроме перечисленных ниже')), pctInp),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Пусто — действует стандартный процент сверху. Заполненная строка его перекрывает: % — доля от стоимости услуги, сум — фиксированная сумма за услугу.')),
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Группа услуг')),
                    h('th', { style: { textAlign: 'right', width: '240px' } }, tr('Ставка')))),
                tbody));

        // Ревью M6 — записи, которых таблица не показывает (без группы из пяти),
        // переносятся как были: редактор правит только то, что показывает, и не
        // стирает чужое молча.
        const hiddenRates = rates.filter(e => e && !referralGroupOf(e.group));
        function collect() {
            const out = hiddenRates.slice();
            for (const inp of tbody.querySelectorAll('input[data-rate-group]')) {
                const raw = inp.value.trim();
                if (raw === '') continue;
                const value = Number(raw);
                if (!Number.isFinite(value) || value < 0) continue;
                const sel = tbody.querySelector('select[data-rate-unit="' + inp.dataset.rateGroup + '"]');
                out.push({ group: inp.dataset.rateGroup, unit: sel && sel.value === 'fix' ? 'fix' : 'pct', value });
            }
            return out;
        }
        function snapshot() {
            return { mode: modeChk.checked ? 'category' : 'own',
                     percent: Number(pctInp.value) || 0, rates: collect() };
        }
        function push() {
            holder.referralReward = snapshot();
            ownBox.hidden = modeChk.checked;
            if (onChange) onChange();
        }
        // Стартовое состояние без onChange: открытая вкладка — не правка.
        holder.referralReward = snapshot();
        ownBox.hidden = modeChk.checked;
        modeChk.addEventListener('change', push);
        pctInp.addEventListener('input', push);
        tbody.addEventListener('change', push);
        tbody.addEventListener('input', push);

        body.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
            h('div', { class: 'field checkbox' }, modeChk,
                h('label', null, tr('Вознаграждение по категории (общая ставка)'))),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, stdNote),
            ownBox));
        if (readOnly) {
            modeChk.disabled = true;
            pctInp.disabled = true;
            for (const el of tbody.querySelectorAll('input, select')) el.disabled = true;
        }
    })();

    return body;
}

/**
 * Записать правку ставки на источник врача. Ничего не делает, если вкладку не
 * открывали (holder.referralReward не заведён) — сохранение карточки не
 * должно затирать ставку, которую никто не трогал.
 * @returns {Promise<string|null>} текст ошибки или null
 */
export async function saveReferralReward(doctorId, rr) {
    if (!rr || !doctorId) return null;
    try {
        const { error } = await supabase.from('referral_sources').update({
            reward_mode: rr.mode === 'own' ? 'own' : 'category',
            own_percent: rr.mode === 'own' ? (Number(rr.percent) || 0) : 0,
            own_rates:   rr.mode === 'own' ? (rr.rates || []) : [],
        }).eq('doctor_id', doctorId);
        return error ? (error.message || String(error)) : null;
    } catch (e) { return (e && e.message) || String(e); }
}
