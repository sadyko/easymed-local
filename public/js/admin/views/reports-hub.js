// Reports — «Отчёты»: card grid of downloadable reports (local port of the
// production easymed Reports hub, REPORTS_HUB_RU_V1).
//
// The page itself is just the cards; clicking one opens a FULL-SCREEN builder:
// period presets + branch checklist on top, «Сформировать отчёт» produces a
// live preview (first 300 rows), «Скачать Excel» exports everything via the
// vendored SheetJS (lazy-loaded on demand, never in the boot graph).
//
// Data comes from two server RPCs (server/services/rpc/reports.js):
//   run_report({kind, from, to, branch_ids})  -> { columns, rows } (aoa)
//   owner_report({from, to, branch_ids})      -> { kpis, monthly, byGroup, byPayer }
// branch_ids semantics: only a PROPER subset filters; all-selected (or none)
// sends [] so invoices with branch_id NULL stay in (matches production).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, PageHead } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ (в ccTrendLine параметр tr затеняет импорт — там только trf)
import { reportTotals } from './report-totals.js?v=rt1';   // REPORT_TOTALS_V1

// Экспортируется, чтобы определения (в т.ч. рисовалку графиков) можно было
// проверить тестом — страница целиком без DOM не поднимается.
export const REPORT_DEFS = [
    {
        kind:  'total_revenue',
        icon:  'Chart',
        title: 'Общая выручка',
        desc:  'Каждая строка счёта: пациент, услуга, цена, скидка и налог, доля врача, филиал, регистратор, реферал и выплата.',
    },
    {
        kind:  'referrals',
        icon:  'Coins',
        title: 'Рефералы',
        desc:  'Вознаграждение по источникам направлений: услуги, суммы и расчёт % по группам (режим «Общий» или «Вручную»).',
    },
    {
        kind:  'invoices_full',
        icon:  'Receipt',
        title: 'Счета',
        desc:  'Все счета за период: суммы, скидки, оплачено, остаток/долг, статус, плательщик и регистратор.',
    },
    {
        kind:  'procurement',
        icon:  'Layers',
        title: 'Закупки',
        desc:  'Позиции поступлений от поставщиков: товар, поставщик, количество и сумма.',
    },
    {
        kind:  'surgery_profit',
        icon:  'Activity',
        title: 'Рентабельность операций',
        desc:  'По каждой операции: сумма счёта, налог, гонорар хирурга, израсходованные товары (в счёте и вне его), прибыль клиники и маржа %.',
    },
    {
        kind:  'doctor_salaries',
        icon:  'Stethoscope',
        title: 'Зарплаты врачей',
        desc:  'По каждому врачу: оплаченные услуги, связанные с ним, сумма после скидки, средний % и доля врача (гонорар). Только полностью оплаченные счета.',
    },
    {
        kind:  'owner',
        icon:  'Trend',
        title: 'Отчёт владельца',
        desc:  'Графики: общая выручка, выручка по группам услуг, динамика по месяцам и поступления по плательщикам (пациент / ДМС / B2B / госпрограмма).',
        mode:  'charts',
    },
    // CALLCENTER_REPORT_V1 — работа стойки: когда звонят, чем кончается заявка,
    // кто из операторов доводит до визита. Филиалом не фильтруется — у заявки
    // нет филиала (см. rpc/callcenter.js).
    {
        kind:  'callcenter',
        icon:  'Headset',
        title: 'Колл-центр',
        desc:  'Загрузка по часам и дням недели, пиковое время, воронка заявок, конверсия в визит и в карту пациента, операторы и самые спрашиваемые услуги.',
        mode:  'charts',
        rpc:   'callcenter_report',
        exports: true,
        noBranch: true,
        render: (el, data) => renderCallcenterCharts(el, data),
    },
    // CASHIER_REPORT_V1 — касса за ПЕРИОД: приход, расход и итог. Отличается от
    // X-отчёта смены («Касса → Смены») тем, что смотрит не на смену, а на
    // выбранный диапазон дат.
    {
        kind:  'cashier',
        icon:  'Wallet',
        title: 'Отчёт кассира',
        desc:  'Полная картина работы кассы: итог по доходам и расходам, все поступления (услуга, врач, способ оплаты, сумма, дата) и все расходы (на что, тип, сумма).',
        mode:  'charts',
        rpc:   'cashier_report',
        exports: true,
        render: (el, data, st) => renderCashierReport(el, data, st ? st.from + '_' + st.to : ''),
    },
    // TELEGRAM_BROADCAST_V1 — не отчёт в смысле Excel-выгрузки, поэтому у
    // карточки собственный обработчик (`open`), а не общий конструктор
    // периода/филиалов: у бота нет ни строк, ни колонок — есть охват.
    // TELEGRAM_BROADCAST_V2 — рассылка отсюда убрана и живёт в «Чате с
    // пациентами»; здесь остались только цифры подключений.
    {
        kind:  'telegram',
        icon:  'Bot',
        title: 'Telegram-бот',
        desc:  'Сколько пациентов подключилось к боту, какой это охват и как он рос по неделям.',
        open:  () => import('./telegram-report.js?v=tgr5').then(m => m.openTelegramReport()),
    },
];

// ---------------------------------------------------------------------------
// Entry point — the hub page is only the cards.
// ---------------------------------------------------------------------------
export async function renderReportsHub(container) {
    clear(container);
    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({
            title: 'Отчёты',
            subtitle: 'Выберите отчёт — настройка периода, филиалов и предпросмотр откроются на весь экран.',
        }),
        h('div', {
            style: {
                display: 'grid', gap: '14px',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                // REPORTS_CARD_EVEN_V1 — все карточки одной высоты.
                //
                // По умолчанию строка сетки тянется по своему самому высокому
                // элементу, поэтому карточки равнялись только ВНУТРИ строки:
                // «Общая выручка» с описанием в три строки задавала первый ряд,
                // «Колл-центр» — второй, и ряды получались разной высоты.
                // `1fr` для неявных строк раздаёт им одинаковую высоту, то есть
                // высоту самого длинного описания на всей сетке.
                gridAutoRows: '1fr',
            },
        }, ...REPORT_DEFS.map(rep => reportCard(rep))),
    ));
}

function reportCard(rep) {
    return h('button', {
        type: 'button',
        onclick: () => (rep.open ? rep.open() : openReportBuilder(rep)),
        style: {
            display: 'flex', alignItems: 'flex-start', gap: '14px', textAlign: 'left',
            padding: '18px 20px', background: 'var(--white, #fff)',
            border: '1px solid var(--ink-100)', borderRadius: '14px',
            boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(11,20,24,0.05))', cursor: 'pointer', fontFamily: 'inherit',
            transition: 'border-color .12s, box-shadow .12s, transform .12s',
        },
        onmouseenter: (e) => { e.currentTarget.style.borderColor = 'var(--primary-300)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm, 0 1px 3px rgba(11,20,24,0.1))'; },
        onmouseleave: (e) => { e.currentTarget.style.borderColor = 'var(--ink-100)'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-xs, 0 1px 2px rgba(11,20,24,0.05))'; },
    },
        h('div', {
            style: {
                width: '40px', height: '40px', borderRadius: '11px', flex: '0 0 auto',
                background: 'var(--primary-50)', color: 'var(--primary-700)',
                display: 'grid', placeItems: 'center',
            },
        }, Icon(rep.icon || 'Download', { size: 18 })),
        h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--ink-900)' } }, rep.title),
            h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px', lineHeight: 1.45 } }, rep.desc),
            h('div', { style: { marginTop: '10px', fontSize: '12px', fontWeight: 600, color: 'var(--primary-700)', display: 'inline-flex', alignItems: 'center', gap: '5px' } },
                'Открыть отчёт ', Icon('ArrowRight', { size: 12 })),
        ),
    );
}

// ---------------------------------------------------------------------------
// Period presets — from/to as LOCAL 'YYYY-MM-DD' (the server compares by date()).
// ---------------------------------------------------------------------------
const PRESETS = [
    { id: 'today',  label: 'Сегодня' },
    { id: 'week',   label: 'Эта неделя' },
    { id: 'month',  label: 'Этот месяц' },
    { id: 'custom', label: 'Произвольный' },
];

function ymd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function presetRange(preset) {
    const now = new Date();
    const to = ymd(now);
    if (preset === 'today') return [to, to];
    if (preset === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); return [ymd(d), to]; }
    // month (also the seed for «Произвольный»)
    return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to];
}

// ---------------------------------------------------------------------------
// Full-screen builder
// ---------------------------------------------------------------------------
async function openReportBuilder(rep) {
    const st = {
        preset: 'month',
        from: '', to: '',
        branches: [], branchIds: new Set(),
        result: null,        // {columns, rows} — or the owner charts object
        generating: false,
    };
    [st.from, st.to] = presetRange('month');

    const overlay = h('div', {
        style: {
            position: 'fixed', inset: '0', zIndex: '150',
            background: 'var(--ink-25, #f6f8f9)',
            display: 'flex', flexDirection: 'column',
        },
    });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    // ---- header ----
    overlay.appendChild(h('header', {
        style: {
            display: 'flex', alignItems: 'center', gap: '14px',
            padding: '14px 22px', background: 'var(--white, #fff)',
            borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
        },
    },
        h('div', {
            style: { width: '36px', height: '36px', borderRadius: '10px', background: 'var(--primary-50)', color: 'var(--primary-700)', display: 'grid', placeItems: 'center' },
        }, Icon(rep.icon || 'Download', { size: 17 })),
        h('div', null,
            h('div', { style: { fontSize: '16px', fontWeight: 700, color: 'var(--ink-900)' } }, rep.title),
            h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Выберите период и филиалы, затем сформируйте отчёт'),
        ),
        h('span', { style: { flex: 1 } }),
        // REPORT_CLOSE_RED_V1 — the close control must be unmissable
        h('button', {
            class: 'btn',
            style: {
                fontSize: '13.5px', fontWeight: '700',
                background: '#dc2626', borderColor: '#dc2626', color: 'white',
                padding: '9px 18px', borderRadius: '10px',
                boxShadow: '0 2px 8px rgba(220,38,38,0.35)',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = '#b91c1c'; },
            onmouseleave: (e) => { e.currentTarget.style.background = '#dc2626'; },
            onclick: close,
        }, '✕ Закрыть'),
    ));

    // ---- controls: presets + dates (custom only) + branches + actions ----
    const dateInputStyle = {
        height: '34px', padding: '0 10px', flex: '1 1 130px', maxWidth: '160px',
        border: '1px solid var(--ink-200)', borderRadius: '8px',
        fontSize: '12.5px', fontFamily: 'inherit', background: 'white',
    };
    const fromInp = h('input', { type: 'date', value: st.from, style: dateInputStyle });
    const toInp   = h('input', { type: 'date', value: st.to,   style: dateInputStyle });
    fromInp.addEventListener('change', () => { st.from = fromInp.value; });
    toInp.addEventListener('change',   () => { st.to   = toInp.value;   });
    const dateWrap = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
        fromInp, h('span', { class: 'muted', style: { fontSize: '12px' } }, '→'), toInp);
    function syncDates() { dateWrap.style.display = st.preset === 'custom' ? 'flex' : 'none'; }

    const presetsEl = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
    function paintPresets() {
        clear(presetsEl);
        for (const p of PRESETS) {
            presetsEl.appendChild(h('button', {
                type: 'button',
                style: {
                    height: '32px', padding: '0 14px', borderRadius: '999px', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
                    border: '1px solid ' + (st.preset === p.id ? 'var(--primary-600)' : 'var(--ink-200)'),
                    background: st.preset === p.id ? 'var(--primary-600)' : 'var(--white, #fff)',
                    color: st.preset === p.id ? '#fff' : 'var(--ink-700)',
                    transition: 'background .1s, border-color .1s, color .1s',
                },
                onclick: () => {
                    st.preset = p.id;
                    if (p.id !== 'custom') {
                        [st.from, st.to] = presetRange(p.id);
                        fromInp.value = st.from;
                        toInp.value   = st.to;
                    }
                    paintPresets();
                    syncDates();
                },
            }, p.label));
        }
    }
    paintPresets();
    syncDates();

    // Branch checklist (async-loaded)
    const branchListEl = h('div', {
        style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: '4px 14px', padding: '5px 10px', minHeight: '32px',
            background: 'var(--white, #fff)', border: '1px solid var(--ink-100)',
            borderRadius: '10px', maxHeight: '64px', overflow: 'auto', maxWidth: '440px',
        },
    }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Загрузка филиалов…'));
    const masterCb  = h('input', { type: 'checkbox' });
    const summaryEl = h('span', { class: 'muted', style: { fontSize: '11.5px' } });

    function refreshBranchUI() {
        const total = st.branches.length;
        const picked = st.branchIds.size;
        if (picked === 0) { masterCb.checked = false; masterCb.indeterminate = false; }
        else if (picked === total) { masterCb.checked = true; masterCb.indeterminate = false; }
        else { masterCb.checked = false; masterCb.indeterminate = true; }
        summaryEl.textContent = total === 0 ? ''
            : picked === 0 ? tr('Филиалы не выбраны')
            : picked === total ? trf('Все филиалы ({total})', { total })
            : trf('{n} из {max}', { n: picked, max: total });
    }
    masterCb.addEventListener('change', () => {
        if (masterCb.checked) st.branches.forEach(b => st.branchIds.add(b.id));
        else                  st.branchIds.clear();
        branchListEl.querySelectorAll('input[data-branch-id]').forEach(cb => {
            cb.checked = st.branchIds.has(Number(cb.dataset.branchId));
        });
        refreshBranchUI();
    });

    (async () => {
        const { data } = await supabase.from('branches')
            .select('id, name').eq('active', 1).order('name');
        const list = data || [];
        st.branches = list;
        st.branchIds = new Set(list.map(b => b.id));
        clear(branchListEl);
        if (!list.length) {
            branchListEl.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } },
                'Филиалы не найдены — отчёт будет сформирован по всей клинике.'));
        } else {
            for (const b of list) {
                const cb = h('input', {
                    type: 'checkbox', checked: true, dataset: { branchId: b.id },
                    onchange: (e) => {
                        if (e.target.checked) st.branchIds.add(b.id);
                        else                  st.branchIds.delete(b.id);
                        refreshBranchUI();
                    },
                });
                branchListEl.appendChild(h('label', {
                    style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: 'var(--ink-800)', cursor: 'pointer' },
                }, cb, h('span', null, b.name)));
            }
        }
        refreshBranchUI();
    })();

    // ---- generate + download ----
    const downloadBtn = h('button', {
        class: 'btn', disabled: true,
        onclick: async (ev) => {
            const r = st.result;
            if (!r || !Array.isArray(r.rows) || !r.rows.length) return;
            ev.currentTarget.disabled = true;
            try {
                const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
                const ws = XLSX.utils.aoa_to_sheet([r.columns, ...r.rows]);
                ws['!cols'] = r.columns.map(c => ({ wch: c.length > 10 ? 20 : 13 }));
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Report');
                XLSX.writeFile(wb, `${rep.kind}_${st.from}_${st.to}.xlsx`);
                toast('Файл скачан', 'ok');
            } catch (e) {
                console.error('[reports-hub] download:', e);
                toast(trf('Не удалось скачать: {msg}', { msg: e.message || e }), 'fail');
            } finally { ev.currentTarget.disabled = false; }
        },
    }, Icon('Download', { size: 14 }), ' Скачать Excel');
    // Кнопку прячем только у отчётов, которым нечего выгружать (отчёт владельца).
    if (rep.mode === 'charts' && !rep.exports) downloadBtn.style.display = 'none';

    const generateBtn = h('button', {
        class: 'btn btn-primary',
        onclick: () => generate(),
    }, Icon('Refresh', { size: 14 }), h('span', { class: 'gen-lbl' }, ' Сформировать отчёт'));

    async function generate() {
        if (st.generating) return;
        st.generating = true;
        generateBtn.disabled = true;
        generateBtn.querySelector('.gen-lbl').textContent = ' Формируем…';
        paintPreviewLoading();
        try {
            // Only a PROPER subset filters; all/none selected = [] = no filter,
            // so rows with branch_id NULL stay in (matches production).
            const branch_ids = (st.branchIds.size && st.branchIds.size < st.branches.length)
                ? [...st.branchIds] : [];
            const args = { from: st.from, to: st.to, branch_ids };
            // CALLCENTER_REPORT_V1 — режим «графики» больше не привязан к отчёту
            // владельца: определение отчёта само называет свой RPC и рисовалку.
            const { data, error } = rep.mode === 'charts'
                ? await supabase.rpc(rep.rpc || 'owner_report', args)
                : await supabase.rpc('run_report', { kind: rep.kind, ...args });
            if (error) throw new Error(error.message || String(error));
            st.result = data;
            // Отчёт с графиками МОЖЕТ отдавать и плоские строки (колл-центр отдаёт
            // по строке на заявку) — тогда выгрузка работает как у табличных.
            downloadBtn.disabled = !data || !Array.isArray(data.rows) || data.rows.length === 0;
            paintPreview();
        } catch (e) {
            console.error('[reports-hub] generate:', e);
            toast(trf('Не удалось сформировать отчёт: {msg}', { msg: e.message || e }), 'fail');
            paintPreviewEmpty(trf('Ошибка: {msg}', { msg: e.message || e }));
        } finally {
            st.generating = false;
            generateBtn.disabled = false;
            generateBtn.querySelector('.gen-lbl').textContent = ' Сформировать отчёт';
        }
    }

    const label = (text) => h('div', {
        style: {
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--ink-500)',
        },
    }, text);

    overlay.appendChild(h('div', {
        style: {
            padding: '10px 22px', background: 'var(--white, #fff)',
            borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
            display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center',
        },
    },
        label('Период'),
        presetsEl,
        dateWrap,
        // CALLCENTER_REPORT_V1 — у отчётов с noBranch выбор филиала СКРЫТ:
        // у crm_requests нет branch_id, и селектор молча ничего бы не делал.
        rep.noBranch ? null : label('Филиалы'),
        rep.noBranch ? null : h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ink-700)', cursor: 'pointer', whiteSpace: 'nowrap' } },
            masterCb, h('span', null, 'Выбрать все')),
        rep.noBranch ? null : branchListEl,
        rep.noBranch ? null : summaryEl,
        h('span', { style: { flex: '1 1 auto' } }),
        h('div', { class: 'row', style: { gap: '8px', flex: '0 0 auto' } },
            generateBtn,
            downloadBtn,
        ),
    ));

    // ---- preview ("mirror") ----
    const previewEl = h('div', { style: { flex: '1 1 auto', overflow: 'auto', padding: '16px 22px' } });
    overlay.appendChild(previewEl);

    function paintPreviewEmpty(msg) {
        clear(previewEl);
        previewEl.appendChild(h('div', {
            class: 'muted',
            style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' },
        }, msg || 'Настройте период и филиалы, затем нажмите «Сформировать отчёт» — данные появятся здесь.'));
    }
    function paintPreviewLoading() {
        clear(previewEl);
        previewEl.appendChild(h('div', {
            class: 'muted',
            style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' },
        }, 'Формируем отчёт…'));
    }
    function paintPreview() {
        clear(previewEl);
        if (rep.mode === 'charts') { (rep.render || renderOwnerCharts)(previewEl, st.result, st); return; }
        const columns = (st.result && st.result.columns) || [];
        const rows = (st.result && st.result.rows) || [];
        if (rows.length === 0) {
            paintPreviewEmpty('Нет данных за выбранный период. Попробуйте расширить диапазон дат или изменить филиалы.');
            return;
        }
        const CAP = 300;
        const shown = rows.slice(0, CAP);
        previewEl.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '10px' } },
            h('span', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } }, trf('Строк: {n}', { n: rows.length })),
            rows.length > CAP ? h('span', { class: 'muted', style: { fontSize: '12px' } },
                trf('— показаны первые {n}, в Excel попадут все', { n: CAP })) : null,
        ));
        // Numeric columns right-align header AND cells (probe first non-empty value).
        const isNumCol = columns.map((_, ci) => {
            const probe = shown.find(r => r[ci] != null && r[ci] !== '');
            return typeof (probe && probe[ci]) === 'number';
        });
        const thStyle = {
            position: 'sticky', top: 0, background: 'var(--ink-50)', zIndex: 1,
            padding: '8px 10px', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.03em', color: 'var(--ink-600)', whiteSpace: 'nowrap', textAlign: 'left',
            borderBottom: '1px solid var(--ink-200)',
        };
        // REPORT_TOTALS_V1 — итог по ВСЕМ строкам отчёта, а не по видимым 300:
        // иначе «Итого» под усечённым списком тихо соврало бы.
        const totals = reportTotals(
            columns.map(c => ({ label: c })), rows,
            (r, _c, ci) => r[ci],
            (_c, ci) => isNumCol[ci]);
        const hasTotals = totals.some(v => v != null);

                // REPORT_TOTALS_V1 — «Итого» прилипает к низу таблицы: при 300
                // строках в скроллере итог, лежащий под ними, не виден без
                // прокрутки в самый конец, а нужен он как раз при взгляде на
                // список целиком.
                const footTd = (content, isNum) => h('td', { style: {
                    padding: '9px 10px', whiteSpace: 'nowrap', textAlign: isNum ? 'right' : 'left',
                    fontWeight: 800, fontSize: '12.5px', color: 'var(--ink-900)',
                    fontVariantNumeric: isNum ? 'tabular-nums' : 'normal',
                    background: 'var(--ink-50, #f1f4f5)', borderTop: '2px solid var(--ink-200)',
                    position: 'sticky', bottom: 0,
                } }, content);
        previewEl.appendChild(h('div', {
            style: { overflow: 'auto', maxHeight: 'calc(100vh - 320px)', background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '12px' },
        },
            h('table', { style: { borderCollapse: 'collapse', fontSize: '12px', minWidth: '100%' } },
                h('thead', null, h('tr', null,
                    ...columns.map((c, ci) => h('th', { style: { ...thStyle, textAlign: isNumCol[ci] ? 'right' : 'left' } }, c)),
                )),
                h('tbody', null, ...shown.map((r, i) => h('tr', {
                    style: { background: i % 2 ? 'var(--ink-25, #fafafa)' : 'var(--white, #fff)' },
                },
                    ...columns.map((_, ci) => {
                        const v = r[ci];
                        const isNum = typeof v === 'number';
                        return h('td', {
                            style: {
                                padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--ink-800)',
                                textAlign: isNum ? 'right' : 'left',
                                fontVariantNumeric: isNum ? 'tabular-nums' : 'normal',
                                borderBottom: '1px solid var(--ink-50)',
                            },
                        }, v == null || v === '' ? '—' : (isNum ? Number(v).toLocaleString('ru-RU') : String(v)));
                    }),
                ))),
                hasTotals ? h('tfoot', null, h('tr', null,
                    ...columns.map((_, ci) => footTd(
                        ci === 0 ? 'Итого' : (totals[ci] == null ? '' : Number(totals[ci]).toLocaleString('ru-RU')),
                        isNumCol[ci]))
                )) : null,
            ),
        ));
    }
    paintPreviewEmpty();

    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// «Отчёт владельца» charts — self-drawn SVG/DOM, no libraries (ported from
// production reports-export.js; local schema has no service groups, so the
// group chart shows revenue by service, top 8 + «Прочее»).
// ---------------------------------------------------------------------------
function renderOwnerCharts(el, d) {
    clear(el);
    if (!d || !d.kpis || (d.kpis.count === 0 && d.monthly.every(m => m.value === 0))) {
        el.appendChild(h('div', { class: 'muted', style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' } },
            'Нет данных за выбранный период. Попробуйте расширить диапазон дат или изменить филиалы.'));
        return;
    }
    const tip = ownerTip();
    // The tooltip node lives on document.body — remove it when the overlay goes away.
    const obs = new MutationObserver(() => { if (!el.isConnected) { tip.destroy(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } },
        ownerKpiTile('Общая выручка', d.kpis.revenue.toLocaleString('ru-RU') + ' ' + tr('сум'), 'за выбранный период'),
        ownerKpiTile('Услуг оказано', d.kpis.count.toLocaleString('ru-RU'), 'без отменённых'),
        ownerKpiTile('Средний чек', d.kpis.avg.toLocaleString('ru-RU') + ' ' + tr('сум'), 'выручка / услуги')));
    el.appendChild(h('div', { style: { marginTop: '14px' } },
        ownerCard('Выручка по месяцам', 'последние 12 месяцев — независимо от выбранного периода', ownerLine(d.monthly, { tip }))));
    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '14px' } },
        ownerCard('Выручка по услугам', 'топ-8 за выбранный период', d.byGroup.length ? ownerBars(d.byGroup, { tip }) : h('div', { class: 'muted' }, 'Нет данных.')),
        ownerCard('Поступления по плательщикам', 'кто покрывает услуги — за выбранный период', d.byPayer.length ? ownerBars(d.byPayer, { tip }) : h('div', { class: 'muted' }, 'Нет данных.'))));
}

function ownerCard(title, sub, bodyEl) {
    return h('div', { style: { background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '16px 18px', minWidth: 0 } },
        h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } }, title),
        sub ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, sub) : null,
        h('div', { style: { marginTop: '12px' } }, bodyEl));
}

function ownerKpiTile(label, value, sub) {
    return h('div', { style: { background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '14px 18px', minWidth: 0 } },
        h('div', { class: 'muted', style: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
        h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 800, color: 'var(--ink-900)', marginTop: '4px', fontVariantNumeric: 'tabular-nums' } }, value),
        sub ? h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, sub) : null);
}

function ownerTip() {
    const t = h('div', { style: { position: 'fixed', zIndex: '200', pointerEvents: 'none', display: 'none',
        background: 'var(--ink-900, #0b1418)', color: '#fff', borderRadius: '8px', padding: '6px 10px',
        font: '600 12px -apple-system, "Segoe UI", Roboto, sans-serif', boxShadow: '0 6px 18px rgba(11,20,24,.3)', whiteSpace: 'nowrap' } });
    document.body.appendChild(t);
    return {
        show(x, y, text) { t.textContent = text; t.style.display = 'block'; t.style.left = (x + 12) + 'px'; t.style.top = (y - 30) + 'px'; },
        hide() { t.style.display = 'none'; },
        destroy() { t.remove(); },
    };
}

// Horizontal bar list — magnitude in ONE hue unless a row carries its own
// identity color (payer composition). Direct labels, share % at the end.
function ownerBars(items, { hue = '#0d8a72', tip, total = null } = {}) {
    const max = Math.max(...items.map(i => i.value), 1);
    const sum = total != null ? total : items.reduce((s, i) => s + i.value, 0);
    const wrapEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
    for (const it of items) {
        const pctW = Math.max(1, Math.round(it.value / max * 100));
        const share = sum > 0 ? Math.round(it.value / sum * 100) : 0;
        const row = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) 2fr auto', alignItems: 'center', gap: '10px', padding: '4px 4px', borderRadius: '6px' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-800)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '7px' } },
                it.color ? h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: it.color, flex: 'none' } }) : null,
                it.name || it.label),
            h('span', { style: { display: 'block', height: '14px', background: 'var(--ink-50, #f3f5f7)', borderRadius: '4px', overflow: 'hidden' } },
                h('span', { style: { display: 'block', height: '100%', width: pctW + '%', background: it.color || hue, borderRadius: '0 4px 4px 0' } })),
            h('span', { class: 'num', style: { fontSize: '12px', color: 'var(--ink-800)', fontVariantNumeric: 'tabular-nums' } },
                it.value.toLocaleString('ru-RU') + (sum > 0 ? '  · ' + share + '%' : '')));
        row.addEventListener('mousemove', (e) => tip && tip.show(e.clientX, e.clientY, trf('{name}: {value} сум · {share}%', { name: it.name || it.label, value: it.value.toLocaleString('ru-RU'), share })));
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--ink-25, #fafbfb)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; tip && tip.hide(); });
        wrapEl.appendChild(row);
    }
    return wrapEl;
}

// Single-series line chart (SVG): 2px line, soft area, 3 recessive gridlines,
// hover crosshair + marker + tooltip, direct label on the last point.
// Wide viewBox + preserveAspectRatio:none + clamped CSS height so the chart
// fills the width without ballooning on the full-screen page.
function ownerLine(points, { hue = '#0d8a72', tip } = {}) {
    const W = 1600, H = 220, padL = 10, padR = 60, padT = 18, padB = 30;
    const max = Math.max(...points.map(p => p.value), 1);
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = (i) => padL + (points.length > 1 ? i / (points.length - 1) : 0.5) * iw;
    const y = (v) => padT + ih - (v / max) * ih;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = '100%'; svg.style.display = 'block';
    svg.style.height = 'clamp(170px, 22vh, 240px)';
    const add = (tag, attrs, textContent) => {
        const node = document.createElementNS(NS, tag);
        for (const [k, val] of Object.entries(attrs)) node.setAttribute(k, val);
        if (textContent != null) node.textContent = textContent;
        svg.appendChild(node); return node;
    };
    for (const fr of [0, 0.5, 1]) {   // recessive gridlines + scale labels
        const gy = padT + ih - fr * ih;
        add('line', { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: 'var(--ink-100, #e8ecef)', 'stroke-width': '1' });
        add('text', { x: padL + iw + 4, y: gy + 3, 'font-size': '9', fill: 'var(--ink-400, #8a97a0)' },
            fr === 0 ? '0' : Math.round(max * fr).toLocaleString('ru-RU'));
    }
    const coords = points.map((p, i) => [x(i), y(p.value)]);
    add('path', { d: 'M' + coords.map(c => c[0] + ',' + c[1]).join(' L') + ` L${padL + iw},${padT + ih} L${padL},${padT + ih} Z`, fill: hue, opacity: '0.08' });
    add('path', { d: 'M' + coords.map(c => c[0] + ',' + c[1]).join(' L'), fill: 'none', stroke: hue, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    points.forEach((p, i) => add('text', { x: x(i), y: H - 8, 'font-size': '9.5', 'text-anchor': 'middle', fill: 'var(--ink-500, #55636d)' }, p.label));
    const last = points[points.length - 1];
    if (last && last.value > 0) add('text', { x: coords[coords.length - 1][0], y: coords[coords.length - 1][1] - 8, 'font-size': '10', 'font-weight': '700', 'text-anchor': 'end', fill: 'var(--ink-800, #1f2d34)' }, last.value.toLocaleString('ru-RU'));
    const vline = add('line', { x1: 0, y1: padT, x2: 0, y2: padT + ih, stroke: 'var(--ink-300, #aab4bc)', 'stroke-width': '1', 'stroke-dasharray': '3 3', visibility: 'hidden' });
    const marker = add('circle', { cx: 0, cy: 0, r: '4.5', fill: hue, stroke: '#fff', 'stroke-width': '2', visibility: 'hidden' });
    svg.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        const relX = (e.clientX - r.left) / r.width * W;
        let best = 0, bd = Infinity;
        coords.forEach((c, i) => { const d = Math.abs(c[0] - relX); if (d < bd) { bd = d; best = i; } });
        vline.setAttribute('x1', coords[best][0]); vline.setAttribute('x2', coords[best][0]); vline.setAttribute('visibility', 'visible');
        marker.setAttribute('cx', coords[best][0]); marker.setAttribute('cy', coords[best][1]); marker.setAttribute('visibility', 'visible');
        tip && tip.show(e.clientX, e.clientY, trf('{name}: {value} сум', { name: points[best].label, value: points[best].value.toLocaleString('ru-RU') }));
    });
    svg.addEventListener('mouseleave', () => { vline.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); tip && tip.hide(); });
    return svg;
}

// ---------------------------------------------------------------------------
// CALLCENTER_REPORT_V1 — графики колл-центра.
//
// Переиспользует атомы отчёта владельца (ownerCard / ownerKpiTile / ownerBars /
// ownerLine / ownerTip): страница «Отчёты» должна выглядеть как одна страница,
// а не как два разных продукта.
//
// Главный график — почасовой: именно его просили («самые загруженные часы»), и
// он единственный рисуется отдельной функцией, потому что у часов своя логика —
// показываются ВСЕ 24, а не только непустые, и рабочий диапазон подсвечен.
// ---------------------------------------------------------------------------
function renderCallcenterCharts(el, d) {
    clear(el);
    if (!d || !d.kpi || !d.kpi.total) {
        el.appendChild(h('div', { class: 'muted', style: { padding: '60px 20px', textAlign: 'center', fontSize: '13px' } },
            'За выбранный период заявок нет. Расширьте диапазон дат.'));
        return;
    }
    const k = d.kpi, tip = ownerTip();
    const obs = new MutationObserver(() => { if (!el.isConnected) { tip.destroy(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });

    const num = (n) => Number(n || 0).toLocaleString('ru-RU');
    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
        ownerKpiTile('Заявок', num(k.total), 'за выбранный период'),
        ownerKpiTile('Дошли', num(k.came) + ' · ' + k.came_pct + '%', 'статус «Пришёл»'),
        ownerKpiTile('Записаны', num(k.scheduled), 'ждут визита'),
        ownerKpiTile('Не пришли', num(k.no_show) + ' · ' + k.no_show_pct + '%', 'записались, но не явились'),
        ownerKpiTile('Стали пациентами', num(k.became_patient) + ' · ' + k.became_patient_pct + '%', 'заведена карта'),
        ownerKpiTile('Пиковый час', d.peak.hour != null ? d.peak.hour + ':00' : '—',
            d.peak.hour != null ? trf('{n} заявок · время клиники', { n: num(d.peak.hour_count) }) : 'нет данных'),
        ownerKpiTile('Пиковый день', d.peak.weekday || '—',
            d.peak.weekday ? trf('{n} заявок', { n: num(d.peak.weekday_count) }) : 'нет данных'),
        ownerKpiTile('Запись вперёд', k.avg_lead_days != null ? trf('{n} дн.', { n: k.avg_lead_days }) : '—',
            'в среднем от заявки до даты приёма')));

    el.appendChild(h('div', { style: { marginTop: '14px' } },
        ownerCard('Загрузка по часам', 'когда принимают заявки — по времени клиники', ccHourBars(d.byHour, tip))));

    // CC_LAST30_V1 — «растём или падаем»: фиксированные 30 дней, не зависящие
    // от выбранного фильтра. Стоит сразу под часами: оба графика про «когда»,
    // только в разном масштабе.
    if (d.last30 && d.last30.length) {
        el.appendChild(h('div', { style: { marginTop: '14px' } },
            ownerCard('Заявки за 30 дней', 'сколько обращений принимали каждый день — растёт или падает',
                h('div', null, ccTrendLine(d.trend), ccDayBars(d.last30, tip)))));
    }

    el.appendChild(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '14px' } },
        ownerCard('По дням недели', 'в какие дни стойка загружена сильнее',
            ownerBars(d.byWeekday.map((w) => ({ name: w.label, value: w.count })), { tip })),
        ownerCard('Динамика по дням', 'сколько заявок принимали каждый день периода',
            d.byDay.length ? ownerLine(d.byDay.map((x) => ({ name: x.day, value: x.count })), { tip })
                           : h('div', { class: 'muted' }, 'Нет данных.')),
        ownerCard('Воронка заявок', 'чем заканчиваются обращения',
            ownerBars(d.byStatus.map((x) => ({ name: x.label, value: x.count })), { tip, total: k.total })),
        ownerCard('Операторы', 'сколько завёл и сколько из них дошло до визита', ccOperators(d.byOperator)),
        // CC_OPS_V1 — три карточки про «что делать сейчас».
        //
        // Конверсия по источникам стоит РЯДОМ с «Источниками» намеренно: одна
        // отвечает «откуда идут», вторая «откуда доходят», и врозь они читаются
        // как один и тот же график.
        ownerCard('Конверсия по источникам', 'какой канал доводит до визита, а не только звонит',
            (d.sourceConv && d.sourceConv.length)
                ? ccOperators(d.sourceConv)
                : h('div', { class: 'muted' }, 'Нет данных.')),
        ownerCard('Заявки без движения', 'в работе, но никто не касался 3+ дней', ccStale(d.stale)),
        ownerCard('Загрузка ближайших дней', 'на какие дни уже записаны — и где пусто',
            ccForward(d.forwardBook, tip)),
        ownerCard('Источники', 'откуда пришло обращение',
            ownerBars(d.bySource.map((x) => ({ name: x.label, value: x.count })), { tip, total: k.total })),
        // CC_BY_SERVICE_TYPE_V1 — группы идут ПЕРЕД списком услуг: сначала
        // «куда идёт поток» (приём / лаборатория / диагностика), потом
        // расшифровка по конкретным услугам. Обратный порядок заставляет
        // складывать двенадцать строк в голове.
        ownerCard('Спрос по группам услуг', 'куда идёт поток обращений',
            (d.byServiceType && d.byServiceType.length)
                ? ownerBars(d.byServiceType.map((x) => ({ name: x.name, value: x.count })), { tip })
                : h('div', { class: 'muted' }, 'Услуги в заявках не указаны.')),
        ownerCard('Что спрашивают', 'самые запрашиваемые услуги',
            d.topServices.length ? ownerBars(d.topServices.map((x) => ({ name: x.name, value: x.count })), { tip })
                                 : h('div', { class: 'muted' }, 'Услуги в заявках не указаны.'))));
}

// CC_LAST30_V1 — заявки по дням за последние 30 дней.
//
// Отдельно от «Динамики по дням»: та рисует ВЫБРАННЫЙ период, а этот график
// всегда один и тот же горизонт, поэтому две недели можно сравнить с двумя
// предыдущими и увидеть направление. Пустые дни занимают своё место: провал в
// среду — это факт, а график без такого дня показывает ровную линию и врёт.
//
// Подписи дат — не под каждым столбцом: тридцать подписей в ряд сливаются в
// серую кашу. Каждая пятая плюс сегодня, остальное отдано подсказке.
function ccDayBars(days, tip) {
    const max = Math.max(...days.map((d) => d.count), 1);
    const wrap = h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '150px', padding: '6px 0 0' } });
    const labels = h('div', { style: { display: 'flex', gap: '3px', marginTop: '6px' } });

    days.forEach((d, i) => {
        const dow = new Date(d.day + 'T00:00:00').getDay();
        const weekend = dow === 0 || dow === 6;
        const last = i === days.length - 1;
        const col = h('div', { style: { flex: '1 1 0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' } });

        // Значение подписываем только там, где оно есть: нули над пустыми
        // столбцами — тридцать лишних цифр, которые нечего сказать.
        if (d.count) {
            col.appendChild(h('div', { style: {
                fontSize: '10px', fontWeight: '700', textAlign: 'center', marginBottom: '2px',
                color: last ? 'var(--primary-700, #00695c)' : 'var(--ink-500)',
            } }, String(d.count)));
        }
        const bar = h('div', {
            style: {
                borderRadius: '4px 4px 0 0', cursor: 'default',
                height: Math.max(d.count ? 3 : 1, Math.round((d.count / max) * 108)) + 'px',
                // Выходные приглушены — спад в воскресенье это график работы
                // клиники, а не падение спроса.
                background: d.count ? (weekend ? '#9fc4bb' : '#0d8a72') : 'var(--ink-100, #e8ecef)',
            },
        });
        if (tip) {
            const human = new Date(d.day + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', weekday: 'short' });
            bar.addEventListener('mousemove', (e) => tip.show(e, human + ' — ' + trf('{n} заявок', { n: d.count })));
            bar.addEventListener('mouseleave', () => tip.hide());
        }
        col.appendChild(bar);
        wrap.appendChild(col);

        const show = last || i % 5 === 0;
        labels.appendChild(h('div', { style: {
            flex: '1 1 0', textAlign: 'center', fontSize: '9.5px',
            color: last ? 'var(--primary-700, #00695c)' : 'var(--ink-400)',
            fontWeight: last ? '700' : '400', whiteSpace: 'nowrap',
        } }, show ? d.day.slice(8) + '.' + d.day.slice(5, 7) : ''));
    });

    return h('div', null, wrap, labels);
}

// Строка тренда: неделя против предыдущей недели, словами и цифрой.
// «+2800%» без базы не значит ничего, поэтому рядом всегда стоят оба числа.
function ccTrendLine(tr) {
    if (!tr) return null;
    const up = tr.direction === 'up', flat = tr.direction === 'flat';
    const color = flat ? 'var(--ink-500)' : up ? 'var(--ok-600, #16a34a)' : 'var(--crit-600, #b03a3a)';
    const arrow = flat ? '→' : up ? '↑' : '↓';
    const pctText = tr.delta_pct == null
        ? 'рост с нуля'                     // неделей раньше не было ни одной заявки
        : (tr.delta_pct > 0 ? '+' : '') + tr.delta_pct + '%';

    return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' } },
        h('span', { style: { fontSize: '19px', fontWeight: '800', color } }, arrow + ' ' + pctText),
        h('span', { class: 'muted', style: { fontSize: '12.5px' } },
            trf('за 7 дней {cur} · неделей раньше {prev}', { cur: tr.current, prev: tr.previous })));
}

// CASHIER_REPORT_V1 — экран «Отчёта кассира».
//
// Три плитки итога и две таблицы: приход и расход. У каждой таблицы свой поиск
// по колонкам и своя выгрузка — кассир обычно ищет одну строку («кто провёл
// платёж на 280 000»), а не читает отчёт целиком.
const ccrMoney = (n) => Number(n || 0).toLocaleString('ru-RU') + ' UZS';

function ccrTile(label, value, tone) {
    const t = {
        in:  { bg: '#eaf7ef', bd: '#c6e9d4', fg: '#1a7a44' },
        out: { bg: '#fdeeee', bd: '#f3cfcf', fg: '#b03a3a' },
        net: { bg: 'var(--white,#fff)', bd: 'var(--ink-100)', fg: 'var(--ink-900)' },
    }[tone];
    return h('div', { style: {
        flex: '1 1 220px', padding: '14px 18px', borderRadius: '12px',
        background: t.bg, border: '1px solid ' + t.bd,
    } },
        h('div', { style: { fontSize: '11px', fontWeight: '700', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-500)' } }, label),
        h('div', { style: { fontSize: '24px', fontWeight: '800', marginTop: '4px', color: t.fg } }, ccrMoney(value)));
}

// Таблица с поиском под каждой колонкой. Отбор идёт в памяти: строки уже
// пришли целиком, и запрос на каждую букву был бы работой на пустом месте.
// CASHIER_REPORT_PAGE_V1 — на экране первые 15 строк, остальные по кнопке.
//
// За месяц касса набирает две с половиной сотни поступлений, и отчёт открывался
// экраном на десять прокруток: чтобы увидеть расходы под таблицей, приходилось
// пролистать весь приход. Выгрузка в Excel постраничности НЕ знает — там
// уходят все строки: лист режут ради чтения с экрана, а не ради файла.
const CCR_PAGE = 15;

function ccrTable({ title, tone, columns, rows, numericCol, kind, period }) {
    const flt = columns.map(() => '');
    let shown = CCR_PAGE;
    const tbody = h('tbody');
    const countEl = h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '8px' } });
    const totalEl = h('span', { style: { fontWeight: '700', marginLeft: '6px' } });

    const visible = () => rows.filter((r) => r.every((cell, i) =>
        !flt[i] || String(cell == null ? '' : cell).toLowerCase().includes(flt[i])));

    function paint() {
        const vis = visible();
        const page = vis.slice(0, shown);
        clear(tbody);
        // Показываем и сколько на экране, и сколько всего — иначе «Строк: 15»
        // рядом с итогом на 39 миллионов читается как потерянные данные.
        countEl.textContent = page.length < vis.length
            ? trf('Показано {n} из {total}', { n: page.length, total: vis.length })
            : trf('Строк: {n}', { n: vis.length }) + (vis.length !== rows.length ? ' ' + trf('из {n}', { n: rows.length }) : '');
        // Итог считается по ВИДИМЫМ строкам: отфильтровали одного кассира —
        // сумма обязана стать его суммой, иначе фильтр обманывает.
        totalEl.textContent = ccrMoney(vis.reduce((n, r) => n + (Number(r[numericCol]) || 0), 0));
        if (!vis.length) {
            tbody.appendChild(h('tr', null, h('td', { colspan: String(columns.length),
                style: { textAlign: 'center', padding: '18px', color: 'var(--ink-500)' } },
                rows.length ? 'Ничего не найдено.' : 'Нет данных за период.')));
            return;
        }
        for (const r of page) {
            tbody.appendChild(h('tr', null, ...r.map((cell, i) => h('td', {
                style: {
                    padding: '8px 10px', fontSize: '12.5px', borderBottom: '1px solid var(--ink-50,#f1f4f5)',
                    ...(i === numericCol
                        ? { textAlign: 'right', fontWeight: '700', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
                        : {}),
                },
            }, i === numericCol ? Number(cell || 0).toLocaleString('ru-RU') : String(cell == null ? '' : cell)))));
        }

        const left = vis.length - page.length;
        moreWrap.style.display = left ? 'flex' : 'none';
        moreBtn.textContent = trf('Показать ещё {n} (осталось {left})', { n: Math.min(CCR_PAGE, left), left });
    }

    const moreBtn = h('button', { class: 'btn btn-sm', type: 'button',
        onclick: () => { shown += CCR_PAGE; paint(); } });
    const allBtn = h('button', { class: 'btn btn-sm btn-outline', type: 'button',
        onclick: () => { shown = Infinity; paint(); } }, 'Показать все');
    const moreWrap = h('div', { style: {
        display: 'none', gap: '8px', justifyContent: 'center',
        padding: '10px', borderTop: '1px solid var(--ink-50,#f1f4f5)',
    } }, moreBtn, allBtn);

    const filterRow = h('tr', { style: { background: 'var(--ink-25,#f6f8f9)' } },
        ...columns.map((_, i) => h('th', { style: { padding: '6px 8px' } },
            h('input', {
                placeholder: 'Поиск…',
                style: { width: '100%', height: '26px', padding: '0 8px', fontSize: '12px', fontFamily: 'inherit',
                         border: '1px solid var(--ink-200)', borderRadius: '6px', boxSizing: 'border-box' },
                // Новый отбор — снова с первой страницы: иначе после поиска
                // остался бы «показать ещё» от прошлой выдачи.
                oninput: (e) => { flt[i] = e.target.value.trim().toLowerCase(); shown = CCR_PAGE; paint(); },
            }))));

    const xlsBtn = h('button', { class: 'btn btn-sm', type: 'button',
        style: { background: 'var(--ok-600,#16a34a)', borderColor: 'var(--ok-600,#16a34a)', color: '#fff' },
        onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
                // В файл уходят ВСЕ строки, а не показанная страница: «показать
                // ещё» — способ читать с экрана, и урезанная по нему выгрузка
                // была бы тихо неполной. Фильтр при этом уважается: его задал
                // человек, а страницу — мы.
                const ws = XLSX.utils.aoa_to_sheet([columns, ...visible()]);
                ws['!cols'] = columns.map((c) => ({ wch: c.length > 10 ? 24 : 14 }));
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, title);
                XLSX.writeFile(wb, 'cashier_' + kind + '_' + period + '.xlsx');
                toast('Файл скачан', 'ok');
            } catch (e) { toast(trf('Не удалось скачать: {msg}', { msg: e.message || e }), 'fail'); }
            finally { ev.currentTarget.disabled = false; }
        },
    }, Icon('Download', { size: 13 }), ' Excel');

    paint();
    return h('div', { class: 'card', style: { marginTop: '14px', overflow: 'hidden' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 14px', borderBottom: '1px solid var(--ink-100)' } },
            h('span', { style: { fontWeight: '700', color: tone === 'in' ? 'var(--ok-700,#1a7a44)' : 'var(--crit-600,#b03a3a)' } }, title),
            countEl,
            h('span', { style: { flex: '1' } }),
            h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Итого:'), totalEl,
            xlsBtn),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                h('thead', null,
                    h('tr', null, ...columns.map((c, i) => h('th', {
                        style: { textAlign: i === numericCol ? 'right' : 'left', padding: '8px 10px', fontSize: '11px',
                                 fontWeight: '700', letterSpacing: '.03em', textTransform: 'uppercase',
                                 color: 'var(--ink-500)', borderBottom: '1px solid var(--ink-100)', whiteSpace: 'nowrap' } }, c))),
                    filterRow),
                tbody)),
        moreWrap);
}

function renderCashierReport(el, d, period) {
    clear(el);
    if (!d || !d.kpi) {
        el.appendChild(h('div', { class: 'muted', style: { padding: '50px 20px', textAlign: 'center' } }, 'Нет данных за период.'));
        return;
    }
    el.appendChild(h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
        ccrTile('Общий доход', d.kpi.income, 'in'),
        ccrTile('Общий расход', d.kpi.expense, 'out'),
        ccrTile('Итого (доход − расход)', d.kpi.net, 'net')));

    el.appendChild(ccrTable({ title: 'Поступления', tone: 'in', kind: 'income', period: period || '',
        columns: d.income.columns, rows: d.income.rows, numericCol: 5 }));
    el.appendChild(ccrTable({ title: 'Расходы', tone: 'out', kind: 'expense', period: period || '',
        columns: d.expense.columns, rows: d.expense.rows, numericCol: 3 }));
}

// Почасовая гистограмма. Все 24 часа всегда на месте: «в 8 утра не звонят» —
// это ответ, а не пропуск, и график с дырками читается как сбой загрузки.
// Часы вне 08–20 приглушены, чтобы рабочий день читался с одного взгляда.
function ccHourBars(byHour, tip) {
    const max = Math.max(...byHour.map((s) => s.count), 1);
    const wrap = h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '150px', padding: '6px 0 0' } });
    for (const slot of byHour) {
        const work = Number(slot.hour) >= 8 && Number(slot.hour) <= 20;
        const bar = h('div', {
            style: {
                borderRadius: '4px 4px 0 0', cursor: 'default',
                height: Math.max(slot.count ? 3 : 1, Math.round((slot.count / max) * 118)) + 'px',
                background: slot.count ? (work ? '#0d8a72' : '#9fc4bb') : 'var(--ink-100, #e8ecef)',
            },
        });
        if (tip) {
            bar.addEventListener('mousemove', (e) => tip.show(e, slot.hour + ':00 — ' + trf('{n} заявок', { n: slot.count })));
            bar.addEventListener('mouseleave', () => tip.hide());
        }
        wrap.appendChild(h('div', { style: { flex: '1', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' } },
            h('div', { style: { fontSize: '9.5px', textAlign: 'center', color: 'var(--ink-500)', marginBottom: '2px', fontVariantNumeric: 'tabular-nums' } },
                slot.count || ''),
            bar,
            h('div', { style: { fontSize: '9px', textAlign: 'center', color: work ? 'var(--ink-600)' : 'var(--ink-400)', marginTop: '3px' } }, slot.hour)));
    }
    return wrap;
}

// Операторы: объём и доля дошедших рядом. Сто заявок, из которых никто не
// пришёл, — это не работа, поэтому процент стоит вплотную к количеству.
// Тёмная часть полосы — дошедшие, светлая — остальные.
// CC_OPS_V1 — «Заявки без движения».
//
// Не график, а рабочий список: цифра «висит 7 заявок» ничего не меняет, пока
// не видно КАКИХ. Поэтому корзины по возрасту плюс самые давние поимённо — по
// ним можно звонить прямо с экрана.
function ccStale(s) {
    if (!s || !s.total) {
        return h('div', { style: { padding: '18px 0', textAlign: 'center' } },
            h('div', { style: { fontSize: '26px' } }, '✅'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
                'Зависших заявок нет — все в работе тронуты за последние 3 дня.'));
    }
    const wrap = h('div');
    wrap.appendChild(h('div', { style: { display: 'flex', gap: '8px', marginBottom: '12px' } },
        ...s.buckets.map((b) => h('div', { style: {
            flex: '1', padding: '8px 10px', borderRadius: '10px', textAlign: 'center',
            background: b.count ? 'var(--warn-50, #fffbeb)' : 'var(--ink-25, #f6f8f9)',
            border: '1px solid ' + (b.count ? 'var(--warn-200, #fde68a)' : 'var(--ink-100)'),
        } },
            h('div', { style: { fontSize: '18px', fontWeight: '800', color: b.count ? 'var(--warn-700, #b45309)' : 'var(--ink-400)' } },
                String(b.count)),
            h('div', { style: { fontSize: '10.5px', color: 'var(--ink-500)', marginTop: '2px' } }, b.label)))));

    for (const x of s.oldest) {
        wrap.appendChild(h('div', { style: {
            display: 'flex', alignItems: 'baseline', gap: '8px',
            padding: '6px 0', borderTop: '1px solid var(--ink-50, #f1f4f5)', fontSize: '12.5px',
        } },
            h('span', { style: { flex: '0 0 42px', fontWeight: '700', color: 'var(--warn-700, #b45309)', fontVariantNumeric: 'tabular-nums' } },
                trf('{n} дн.', { n: x.days })),
            h('span', { style: { flex: '1', minWidth: '0', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                x.name),
            h('span', { class: 'muted', style: { flex: '0 0 auto', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' } },
                x.phone)));
    }
    return wrap;
}

// CC_OPS_V1 — «Запись вперёд»: чем занят ближайший день, а чем нет.
// Пустой день показан пустым столбцом — дыра в расписании и есть повод звонить.
function ccForward(days, tip) {
    if (!days || !days.length) return h('div', { class: 'muted' }, 'Нет записей вперёд.');
    const max = Math.max(...days.map((d) => d.count), 1);
    const wrap = h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '120px' } });
    const labels = h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } });

    days.forEach((d, i) => {
        const dt = new Date(d.day + 'T00:00:00');
        const dow = dt.getDay();
        const weekend = dow === 0 || dow === 6;
        const col = h('div', { style: { flex: '1 1 0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' } });
        if (d.count) {
            col.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '700', textAlign: 'center', marginBottom: '2px', color: 'var(--ink-600)' } },
                String(d.count)));
        }
        const bar = h('div', { style: {
            borderRadius: '4px 4px 0 0',
            height: Math.max(d.count ? 3 : 1, Math.round((d.count / max) * 88)) + 'px',
            background: d.count ? (weekend ? '#9fc4bb' : '#0d8a72') : 'var(--ink-100, #e8ecef)',
        } });
        if (tip) {
            const human = dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', weekday: 'short' });
            bar.addEventListener('mousemove', (e) => tip.show(e, human + ' — ' + (d.count || 'никого')));
            bar.addEventListener('mouseleave', () => tip.hide());
        }
        col.appendChild(bar);
        wrap.appendChild(col);
        labels.appendChild(h('div', { style: {
            flex: '1 1 0', textAlign: 'center', fontSize: '9.5px', whiteSpace: 'nowrap',
            color: i === 0 ? 'var(--primary-700, #00695c)' : 'var(--ink-400)',
            fontWeight: i === 0 ? '700' : '400',
        } }, i === 0 ? 'сег.' : d.day.slice(8)));
    });
    return h('div', null, wrap, labels);
}

function ccOperators(rows) {
    if (!rows || !rows.length) return h('div', { class: 'muted' }, 'Нет данных.');
    const max = Math.max(...rows.map((r) => r.count), 1);
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    for (const r of rows) {
        wrap.appendChild(h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12.5px', marginBottom: '4px' } },
                h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
                h('span', { class: 'num', style: { flex: '0 0 auto', color: 'var(--ink-600)', fontVariantNumeric: 'tabular-nums' } },
                    trf('{n} · дошли {came} ({pct}%)', { n: r.count, came: r.came, pct: r.came_pct }))),
            h('div', { style: { height: '8px', background: 'var(--ink-100)', borderRadius: '99px', overflow: 'hidden' } },
                h('div', { style: { width: (r.count / max * 100) + '%', height: '100%', background: '#9fc4bb', borderRadius: '99px', overflow: 'hidden' } },
                    h('div', { style: { width: r.came_pct + '%', height: '100%', background: '#0d8a72' } })))));
    }
    return wrap;
}
