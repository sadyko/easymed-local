// Settings → «Зарплата врачей» (DOCTOR_PAY_BULK_V1). Bulk-set the doctor share (%)
// across several services at once. The doctor's pay is read from ONE place —
// users.service_rates (the doctor_prices/doctor_referral_bonuses tables were
// removed — DOCTOR_PAY_CONSOLIDATE_V1).
//   • Все врачи     → the % goes into the record of every doctor who ALREADY
//                     performs the service (has a record for it); a doctor with
//                     no record is not touched.
//   • Выбранные врачи → writes/adds the % into the selected doctors' service_rates only.
//
// RATES_HONEST_V1 (2026-09-30) — аудит денег: «Все врачи» писал
// services.default_doctor_percent, которую расчёт НЕ читает (это лишь
// подстановка врачу, которого отмечают исполнителем в окне услуги), ставил %
// рядом с фиксированной суммой (сумма продолжала действовать) и обещал «доля
// задана». Теперь экран колонку услуги не пишет вовсе (её правят в окне
// услуги, и там сказано, что она делает), у записи с суммой сумма снимается,
// чтобы процент действовал (в обоих режимах), тост называет, скольким врачам
// ставка поставлена, а подсказка — что врачей без записи действие не трогает.
import { h, Icon, PageHead, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';

const cid = () => { try { return window.easymed?.state?.user?.company_id || null; } catch (e) { return null; } };

// INPATIENT_SHARE_V1, ревью (PLUS) — ставки врача пишутся через маршрут
// сотрудников (PATCH /api/users/:id), а не через /api/db: реестр запись в
// users не принимает вовсе (write у users пуст), и прежние сохранения этого
// экрана молча не делали ничего — экран говорил «обновлено», а ставки не
// менялись. Маршрут проверяет ставки тем же parseRates, что карточка
// сотрудника, и хранит все их ключи (pct, fix, price, branches); стационарные
// ставки с INPATIENT_BONUS_V1 — отдельно (inpatient_rates), этот экран их не пишет.
async function saveServiceRates(doctorId, rates) {
    const res = await fetch('/api/users/' + encodeURIComponent(doctorId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ service_rates: rates }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + res.status));
    return body;
}

// Доля в ставке: канонический ключ — pct (его читают отчёты); прежний
// «percentage» маршрут понимает только как синоним, поэтому пишется pct, а
// остальные ключи строки (своя цена, branches) остаются.
// RATES_HONEST_V1 — фиксированная сумма (fix) снимается: присутствие fix и есть
// режим «сумма за единицу», и рядом с ним поставленный процент не действовал бы.
function setPct(rate, pct) {
    rate.pct = pct;
    delete rate.percentage;
    delete rate.fix;
    return rate;
}
// RATES_HONEST_V1 — сколько врачей услугу уже оказывают (есть запись в их ставках).
const performersOf = (doctors, sid) => doctors.filter((d) => Array.isArray(d.service_rates)
    && d.service_rates.some((r) => r && String(r.service_id) === String(sid))).length;

export async function renderDoctorPay(container) {
    clear(container);
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Зарплата врачей — доля от услуг',
        // RATES_HONEST_V1 — подзаголовок говорит, что делает кнопка, а не «долю по умолчанию».
        subtitle: 'Массово задайте долю врача (%) сразу по нескольким услугам. «Все врачи» ставит долю врачам, которые уже оказывают услугу; «Выбранные врачи» — только отмеченным, и добавляет им услугу, если её не было.',
    }));

    const c = cid();
    const loading = h('div', { class: 'muted', style: { padding: '16px' } }, 'Загрузка…');
    root.appendChild(loading);

    let services = [], doctors = [];
    try {
        let qs = supabase.from('services').select('id, name, active').eq('active', true).order('name');   // RATES_HONEST_V1 — default_doctor_percent здесь не нужна
        if (c) qs = qs.eq('company_id', c);
        const { data } = await qs; services = data || [];
    } catch (e) { /* fail-soft */ }
    try {
        let qd = supabase.from('users').select('id, full_name, specialty, service_rates').eq('is_doctor', true).eq('active', true).order('full_name');
        if (c) qd = qd.eq('company_id', c);
        const { data } = await qd; doctors = data || [];
    } catch (e) { /* fail-soft */ }
    loading.remove();

    const selSvc = new Set();
    const selDoc = new Set();
    let mode = 'all';

    // ---- 1. services ----
    const svcSearch = h('input', { placeholder: 'Поиск услуги…', style: { width: '100%', marginBottom: '8px' } });
    const svcList = h('div', { style: { maxHeight: '300px', overflowY: 'auto', border: '1px solid var(--ink-200)', borderRadius: '10px', padding: '6px' } });
    function paintSvc() {
        clear(svcList);
        const t = (svcSearch.value || '').trim().toLowerCase();
        const shown = services.filter(s => !t || (s.name || '').toLowerCase().includes(t));
        if (!shown.length) { svcList.appendChild(h('div', { class: 'muted', style: { padding: '10px' } }, 'Нет услуг.')); return; }
        for (const s of shown) {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = selSvc.has(s.id);
            cb.addEventListener('change', () => { if (cb.checked) selSvc.add(s.id); else selSvc.delete(s.id); updateCount(); });
            svcList.appendChild(h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px', borderRadius: '8px', cursor: 'pointer', fontSize: '13.5px' } },
                cb, h('span', { style: { flex: 1, minWidth: '0' } }, s.name || '—'),
                // RATES_HONEST_V1 — не «тек. N %» из колонки, которую расчёт не
                // читает, а сколько врачей услугу оказывают: их и тронет «Все врачи».
                h('span', { class: 'muted', style: { fontSize: '12.5px', flex: '0 0 auto' } }, trf('оказывают: {k}', { k: performersOf(doctors, s.id) }))));
        }
    }
    const selectAllShown = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => {
        const t = (svcSearch.value || '').trim().toLowerCase();
        for (const s of services) if (!t || (s.name || '').toLowerCase().includes(t)) selSvc.add(s.id);
        paintSvc(); updateCount();
    } }, 'Выбрать все показанные');
    const clearSvc = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { selSvc.clear(); paintSvc(); updateCount(); } }, 'Очистить');
    svcSearch.addEventListener('input', paintSvc);
    paintSvc();

    // ---- 2. percent ----
    const pctInput = h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'напр. 30', style: { width: '160px' } });

    // ---- 3. who ----
    const docList = h('div', { style: { maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--ink-200)', borderRadius: '10px', padding: '6px' } });
    for (const d of doctors) {
        const cb = h('input', { type: 'checkbox' });
        cb.addEventListener('change', () => { if (cb.checked) selDoc.add(d.id); else selDoc.delete(d.id); updateCount(); });
        docList.appendChild(h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px', cursor: 'pointer', fontSize: '13.5px' } },
            cb, (d.full_name || '—') + (d.specialty ? ' · ' + d.specialty : '')));
    }
    if (!doctors.length) docList.appendChild(h('div', { class: 'muted', style: { padding: '10px' } }, 'В клинике нет врачей.'));
    const docWrap = h('div', { style: { display: 'none', marginTop: '10px' } },
        h('div', { style: { fontSize: '12.5px', fontWeight: '600', margin: '0 0 6px' } }, 'Выберите врачей:'), docList);

    function modeRadio(val, label) {
        const r = h('input', { type: 'radio', name: 'dp-mode', value: val });
        if (val === mode) r.checked = true;
        r.addEventListener('change', () => { if (r.checked) { mode = val; docWrap.style.display = val === 'selected' ? '' : 'none'; updateCount(); } });
        return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13.5px', marginRight: '18px' } }, r, label);
    }

    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });
    function updateCount() {
        countEl.textContent = trf('Услуг: {n}', { n: selSvc.size }) + (mode === 'selected' ? ' · ' + trf('Врачей: {n}', { n: selDoc.size }) : ' · ' + tr('Все врачи'));
    }
    updateCount();

    async function apply(ev) {
        const pct = Number(pctInput.value);
        if (!selSvc.size) { toast('Выберите хотя бы одну услугу.', 'warn'); return; }
        if (!Number.isFinite(pct) || pct < 0) { toast('Укажите долю врача (%).', 'warn'); pctInput.focus(); return; }
        if (mode === 'selected' && !selDoc.size) { toast('Выберите хотя бы одного врача.', 'warn'); return; }
        const svcIds = [...selSvc].map(String);
        const btn = ev.currentTarget; btn.disabled = true;
        try {
            if (mode === 'all') {
                // RATES_HONEST_V1 — только записи врачей, которые услугу уже
                // оказывают; у них процент ставится, а фикс снимается (setPct).
                // services.default_doctor_percent не пишется: расчёт её не читает.
                let touched = 0, failed = 0;
                for (const doc of doctors) {
                    const rates = Array.isArray(doc.service_rates) ? doc.service_rates.map(r => ({ ...r })) : [];
                    let changed = false;
                    for (const r of rates) if (svcIds.includes(String(r.service_id))) { setPct(r, pct); changed = true; }
                    if (changed) {
                        try { await saveServiceRates(doc.id, rates); touched++; doc.service_rates = rates; }
                        catch (e2) { failed++; console.warn('[doctor-pay] save', doc.id, e2 && e2.message); }
                    }
                }
                paintSvc();
                toast(trf('Ставка {n}% поставлена {k} врачам, которые оказывают услугу', { n: pct, k: touched }));
                if (failed) toast(trf('Не сохранено у врачей: {n}', { n: failed }), 'fail');
            } else {
                let touched = 0, failed = 0;
                for (const doc of doctors.filter(d => selDoc.has(d.id))) {
                    const rates = Array.isArray(doc.service_rates) ? doc.service_rates.map(r => ({ ...r })) : [];
                    for (const sid of svcIds) {
                        const ex = rates.find(r => String(r.service_id) === String(sid));
                        if (ex) setPct(ex, pct);
                        // DOCTOR_OWN_PRICE_V1 — no `price` key: this screen sets the
                        // doctor's SHARE, not their price. Seeding price:0 here would
                        // now read as a real own price of zero and bill the service free.
                        else rates.push({ service_id: Number(sid), pct, branches: [] });
                    }
                    try { await saveServiceRates(doc.id, rates); touched++; doc.service_rates = rates; }
                    catch (e2) { failed++; console.warn('[doctor-pay] save', doc.id, e2 && e2.message); }
                }
                paintSvc();   // RATES_HONEST_V1 — «оказывают: N» меняется у добавленных услуг
                toast(trf('Доля {pct}% задана для {n} услуг(и) у {touched} врач(ей).', { pct, n: svcIds.length, touched }));
                if (failed) toast(trf('Не сохранено у врачей: {n}', { n: failed }), 'fail');
            }
        } catch (e) {
            toast(trf('Не удалось применить: {msg}', { msg: e.message || e }), 'fail');
        } finally { if (btn && btn.isConnected) btn.disabled = false; }
    }
    const applyBtn = h('button', { class: 'btn btn-primary', onclick: apply }, Icon('Check', { size: 14 }), ' Применить долю');

    root.appendChild(h('div', { class: 'card', style: { padding: '18px', maxWidth: '720px' } },
        h('div', { class: 'field' }, h('label', null, '1. Услуги'), svcSearch),
        h('div', { style: { display: 'flex', gap: '8px', margin: '0 0 8px' } }, selectAllShown, clearSvc),
        svcList,
        h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', null, '2. Доля врача, %'), pctInput),
        h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', null, '3. Применить к'),
            h('div', null, modeRadio('all', 'Все врачи'), modeRadio('selected', 'Выбранные врачи'))),
        // RATES_HONEST_V1 — что именно сделает кнопка, словами.
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', lineHeight: 1.5 } },
            'Процент ставится в запись врача по услуге; фиксированная сумма в этой записи снимается, чтобы процент действовал. «Все врачи» — это врачи, которые уже оказывают услугу; тех, кто её не оказывает, действие не трогает — добавьте их через «Выбранные врачи».'),
        docWrap,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginTop: '16px', borderTop: '1px solid var(--ink-100)', paddingTop: '14px' } }, applyBtn, countEl),
    ));
}
