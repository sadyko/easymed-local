// Patient card — PATIENT_CARD_DESIGN_V2 — rebuilt to the production easymed
// patient-profile design: teal cover banner («+ Новый визит»), name + «Активен»
// pill over MRN · gender · age · DOB · phone, the «Особые отметки / Последняя
// заметка» strip, a five-cell stat row (Страховка / Последний визит / Аллергии /
// Кэшбэк / Баланс счёта), underline tabs and the two-card «Деталь» layout
// (Контакты и документы + Сводка).
//
// Data flows are unchanged from PATIENT_CARD_RICH_V1: everything is re-fetched
// on reload() from the local /api (patients, visits, invoices, visit_services,
// lab_results); booking reuses openBookVisitModal (visits.js) and a visit row
// opens openVisitBillModal (visit-bill.js).
//
// Local-schema notes: КЭШБЭК shows 0 (no per-patient cashback ledger yet);
// «Особые отметки» surfaces allergies + chronic conditions; «Последняя заметка»
// is patients.notes (edited via the «Отметки» modal). Production-only tabs
// (Рекомендации, Назначения, Документы, Лояльность, Чат) are not ported.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, StatusTag, fmtDate, fmtDateTime, field, Avatar, avColor, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { labFlagCell, labPosFor, fmtDMY, labSexRu, labRefLines, labRefText, matchResultsToAnalytes, labAccession, labIssueDates, labMaxDate,
         namedRangeCell, ageYears } from './lab-doc.js?v=labshared1';
import { analyteIndex, resolveAnalyte, analytesForService } from './lab-analyte-index.js?v=labshared1';   // LAB_BLANK_DESIGNED_V1
import { openVisitWizard } from './visit-wizard.js?v=aug17e';
import { printInvoiceCheck } from './receipt-print.js?v=rp1';   // REPRINT_SERVICE_CHECK_V1
import { printableSheet as _printSheet } from './doc-settings.js?v=noqr1';   // VISIT_WIZARD_LOCAL_V1 — full-screen «Добавить услугу к визиту»
import { openVisitBillModal } from './visit-bill.js';
import { BRANCH_BUCKET, uploadFile, signedUrl, removeFile } from '../storage.js?v=aurora20b';   // PATIENT_DOCS_TAB_V1 — same URL as service-workspace (one instance)
import { printableSheet } from './doc-settings.js?v=noqr1';   // PATIENT_DOCS_CLINICAL_V1 — заключения/результаты открываются брендированным бланком
// PATIENT_EDIT_REG_V1 — редактирование карты в стиле формы регистрации: те же
// контролы (флаг-телефон, чипы пола, email с иконкой). Тот же ?v=, что в
// admin.js → один экземпляр модуля; цикл registration↔patient-card безопасен,
// т.к. обе стороны используют только hoisted-функции во время выполнения.
import { radioChips, phoneInput, mailInput } from './registration.js?v=aug17f';

// Compatibility stubs. Older modules still import these names FROM patient-card
// (registration.js -> openCreateVisitModal, service-workspace.js -> openVitalsDialog).
// An ESM import of a missing name is a FATAL module-load error that blanks the
// whole app, so these inert no-ops keep those imports resolving.
export function openCreateVisitModal() { /* replaced by the per-patient Book visit flow */ }
export function openVitalsDialog() { /* vitals UI is not part of the local patient view yet */ }

// Tab bar — module-level so the selected tab survives a repaint.
// TAB_ORDER_V2 (user-requested): Услуги → Лаборатория → Документы → Счёт →
// Визиты (визит = день, для статистики — DAY_VISIT_V1) → Деталь.
// Landing = «Услуги».
const state = { tab: 'services' };
const TABS = [
    { id: 'services', label: 'Услуги',      icon: 'Stethoscope' },
    { id: 'labs',     label: 'Лаборатория', icon: 'Flask' },
    { id: 'docs',     label: 'Документы',   icon: 'Doc' },      // PATIENT_DOCS_TAB_V1 — файлы/документы пациента
    { id: 'billing',  label: 'Счёт',        icon: 'Receipt' },
    { id: 'visits',   label: 'Визиты',      icon: 'Calendar' },
    { id: 'details',  label: 'Деталь',      icon: 'User' },
];

const RU_M_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
// «13 мая 1993 г.»
function fmtRuDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // I18N_COVERAGE_V1 — единый локале-зависимый формат из ui.js (Intl сам
    // добавляет « г.» в ru-RU) вместо русской сборки, которую tr() не найдёт.
    return fmtDate(d);
}

function ageFromDob(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
}

function genderLabel(g) {
    if (!g) return null;
    const s = String(g).toLowerCase();
    if (s === 'male' || s === 'm')   return 'Male';
    if (s === 'female' || s === 'f') return 'Female';
    if (s === 'other') return 'Other';
    return g.charAt(0).toUpperCase() + g.slice(1);
}

export function renderPatientCard(container, { onNavigate, payload } = {}) {
    clear(container);

    // TAB_ORDER_V2 — каждая ВНОВЬ открытая карточка стартует с «Услуги».
    // Repaint той же карточки (сохранение, обновление) вкладку не сбрасывает.
    if (payload && payload.id && String(state._cardPatientId || '') !== String(payload.id)) {
        state.tab = 'services';
        state._cardPatientId = payload.id;
    }

    if (!payload || !payload.id) {
        container.appendChild(h('div', { class: 'fade-in' },
            h('div', { class: 'empty' }, 'Откройте пациента из списка «Пациенты».'),
            h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '12px' },
                onclick: () => onNavigate && onNavigate('patients'),
            }, Icon('ChevronLeft', { size: 14 }), ' Пациенты'),
        ));
        return;
    }

    // ---- per-instance data (never module-level — a different patient must not
    // inherit a stale header/rows from whoever was open before). ----
    let patient = null;
    let payerName = null;
    let visits = [];
    let invoices = [];
    let services = [];   // visit_services rows across this patient's visits
    let labs = [];
    let fetchToken = 0;

    const patientId = payload.id;
    const patientStub = () => ({ id: patient?.id, full_name: patient?.full_name, mrn: patient?.mrn, phone: patient?.phone });

    // ---- skeleton ----
    const headerEl = h('div');
    const tabbarEl = h('div');
    const bodyEl   = h('div');

    container.appendChild(h('div', { class: 'fade-in' }, headerEl, tabbarEl, bodyEl));
    reload();

    // ---------------------------------------------------------------------
    // reload — re-fetch patient + visits + invoices + services/labs, repaint.
    // ---------------------------------------------------------------------
    async function reload() {
        const token = ++fetchToken;
        clear(headerEl);
        headerEl.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Загрузка…')));
        clear(tabbarEl);
        clear(bodyEl);

        try {
            const { data: pRow, error: pErr } = await supabase.from('patients')
                .select('*').eq('id', patientId).single();
            if (token !== fetchToken) return;
            if (pErr || !pRow) {
                clear(headerEl);
                headerEl.appendChild(h('div', { class: 'empty' }, 'Пациент не найден.'));
                toast(trf('Не удалось загрузить пациента: {msg}', { msg: (pErr && pErr.message) || 'not found' }), 'fail');
                return;
            }
            patient = pRow;

            const [visitsRes, invoicesRes, payerRes] = await Promise.all([
                supabase.from('visits')
                    .select('*, doctor(full_name), patients(full_name,mrn,phone)')
                    .eq('patient_id', patient.id)
                    .order('visit_date', { ascending: false })
                    .limit(200),
                supabase.from('invoices')
                    .select('*')
                    .eq('patient_id', patient.id)
                    .order('created_at', { ascending: false })
                    .limit(200),
                patient.payer_id
                    ? supabase.from('payers').select('name').eq('id', patient.payer_id).single()
                    : Promise.resolve({ data: null }),
            ]);
            if (token !== fetchToken) return;
            if (visitsRes.error)   toast(trf('Не удалось загрузить визиты: {msg}', { msg: visitsRes.error.message }), 'fail');
            if (invoicesRes.error) toast(trf('Не удалось загрузить счета: {msg}', { msg: invoicesRes.error.message }), 'fail');
            visits    = visitsRes.data || [];
            invoices  = invoicesRes.data || [];
            payerName = (payerRes && payerRes.data && payerRes.data.name) || null;

            await loadServicesAndLabs();
            if (token !== fetchToken) return;

            paintHeader();
            paintTabs();
            paintBody();
        } catch (e) {
            if (token !== fetchToken) return;
            clear(headerEl);
            headerEl.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить пациента.'));
            toast(trf('Не удалось загрузить пациента: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    }

    // One visit_services fetch feeds BOTH the «Услуги» tab and the labs join.
    async function loadServicesAndLabs() {
        services = [];
        labs = [];
        const visitIds = visits.map(v => v.id).filter(v => v != null);
        if (visitIds.length === 0) return;

        // SVC_ROW_ACTIONS_V1 — тянем id/врача/привязку к счёту/слот, чтобы
        // строки услуг были управляемыми (удалить неоплаченную, сменить врача).
        const { data: vsRows, error: vsErr } = await supabase.from('visit_services')
            // LAB_DOC_PENDING_V1 — is_lab/type тянем, чтобы отличить лабораторный
            // ЗАКАЗ от остальных услуг: документ «Результаты анализов» должен
            // появляться с момента назначения, а не с первой введённой цифры.
            .select('id,visit_id,quantity,unit_price,total,status,invoice_item_id,doctor_id,service_id,scheduled_at,services(name,result_unit,ref_low,ref_high,is_lab,type),users:doctor_id(full_name)')
            .in('visit_id', visitIds);
        if (vsErr || !vsRows || vsRows.length === 0) return;

        const visitById = new Map(visits.map(v => [v.id, v]));
        services = vsRows.map(r => ({
            id:            r.id,
            serviceId:     r.service_id,
            doctorId:      r.doctor_id,
            doctorName:    (r.users && r.users.full_name) || '',
            invoiceItemId: r.invoice_item_id,
            name:   (r.services && r.services.name) || '—',
            qty:    r.quantity,
            total:  r.total,
            status: r.status,
            // LAB_DOC_PENDING_V1 — «это лабораторный заказ?». Определение то же,
            // что у lab-service.js: флаг is_lab ИЛИ тип услуги 'lab'.
            visitId: r.visit_id,
            isLab:  !!((r.services && r.services.is_lab) || (r.services && r.services.type === 'lab')),
            date:   r.scheduled_at || (visitById.get(r.visit_id) || {}).visit_date || null,
        })).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        const vsIds = vsRows.map(r => r.id);
        const { data: lrRows, error: lrErr } = await supabase.from('lab_results')
            .select('*')
            .in('visit_service_id', vsIds);
        if (lrErr || !lrRows || lrRows.length === 0) return;

        const vsById = new Map(vsRows.map(r => [r.id, r]));
        // LAB_DOC_ALL_ANALYTES_V1 — панель пишет ПО СТРОКЕ lab_results НА КАЖДЫЙ
        // ПОКАЗАТЕЛЬ (laboratory.js: «Each analyte writes ONE lab_results row»).
        // Здесь оставалась одна, самая свежая строка НА УСЛУГУ — и от ОАК с 28
        // показателями в карту попадал ровно один. «Свежая побеждает» относится к
        // ПОВТОРНОМУ вводу того же показателя, поэтому ключ — (услуга, параметр).
        const latest = new Map();
        for (const lr of lrRows) {
            const t = new Date(lr.entered_at || lr.created_at || 0).getTime();
            const key = lr.visit_service_id + '\0' + (lr.parameter || '');
            const prev = latest.get(key);
            if (!prev || t >= prev.t || (t === prev.t && lr.id > prev.row.id)) latest.set(key, { row: lr, t });
        }
        const rows = [];
        for (const entry of latest.values()) {
            const lr  = entry.row;
            const vs  = vsById.get(lr.visit_service_id);
            const svc = vs && vs.services;
            const vst = vs ? visitById.get(vs.visit_id) : null;
            let reference = lr.reference_range || '';
            if (!reference && svc && (svc.ref_low != null || svc.ref_high != null)) {
                reference = `${svc.ref_low ?? ''}–${svc.ref_high ?? ''}`;
            }
            rows.push({
                // Строка = ПОКАЗАТЕЛЬ; название услуги держим рядом, иначе 28 строк
                // ОАК выглядели бы как 28 одинаковых «Общий анализ крови».
                name:      lr.parameter || (svc && svc.name) || '—',
                panel:     (svc && svc.name) || '',
                // Секции документа режем по ЗАКАЗУ (visit_service), а не по имени
                // панели: одну и ту же панель могут назначить дважды за визит
                // (повтор анализа), и по имени два заказа слиплись бы в одну
                // таблицу, где каждый показатель встречается дважды без пометки,
                // из какого он забора.
                vsId:      lr.visit_service_id,
                enteredAt: lr.entered_at || null,
                verifiedAt: lr.verified_at || null,
                visitId:   vs ? vs.visit_id : null,
                value:     lr.value,
                unit:      lr.unit || (svc && svc.result_unit) || '',
                reference: reference || '—',
                flag:      lr.flag || null,
                date:      (vst && vst.visit_date) || lr.entered_at || lr.created_at || null,
                _id:       lr.id,
            });
        }
        // Внутри дня — в порядке ввода, чтобы показатели панели шли как в панели.
        rows.sort((a, b) => (a._id || 0) - (b._id || 0));
        rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        labs = rows;
    }

    // ---------------------------------------------------------------------
    // Header block: teal cover, name row, отметки strip, stat row.
    // ---------------------------------------------------------------------
    function paintHeader() {
        clear(headerEl);
        const p = patient;

        // -- teal cover banner --
        const cover = h('div', {
            style: {
                background: 'linear-gradient(120deg, var(--primary-800, #0b5d52), var(--primary-500, #17967f))',
                borderRadius: '16px 16px 0 0', padding: '14px 18px', minHeight: '68px',
                display: 'flex', alignItems: 'flex-start', gap: '10px',
            },
        },
            h('button', {
                type: 'button',
                onclick: () => onNavigate && onNavigate('patients'),
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '7px 12px', borderRadius: '9px', cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.12)',
                    color: '#fff', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
                },
            }, Icon('ChevronLeft', { size: 13 }), 'Пациенты'),
            h('span', { style: { flex: 1 } }),
            h('button', {
                type: 'button',
                onclick: () => openVisitWizard(reload, patientStub()),
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    padding: '9px 16px', borderRadius: '10px', cursor: 'pointer',
                    border: 'none', background: '#fff', color: 'var(--ink-900)',
                    fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 700,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                },
            }, Icon('Plus', { size: 14 }), 'Добавить услуги'),   // DAY_VISIT_V1 — работаем услугами, визит (день) считается сам
        );

        // -- name / demographics row --
        const age = ageFromDob(p.date_of_birth);
        const sep = () => h('span', { style: { color: 'var(--ink-300)' } }, '·');
        const demo = h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px', fontSize: '13.5px', color: 'var(--ink-600)' } },
            h('span', { class: 'num', style: { fontWeight: 700, color: 'var(--ink-800)' } }, p.mrn || '—'),
        );
        const demoBits = [];
        const gl = genderLabel(p.gender);
        const dobRu = fmtRuDate(p.date_of_birth);
        if (gl || age != null || dobRu) {
            demoBits.push(h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
                Icon('User', { size: 13 }),
                [gl, age != null ? age + ' y' : null, dobRu].filter(Boolean).join(' · ')));
        }
        if (p.phone) {
            demoBits.push(h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
                Icon('Phone', { size: 13 }), p.phone));
        }
        for (const b of demoBits) { demo.appendChild(sep()); demo.appendChild(b); }

        const activePill = h('span', {
            style: {
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '3px 12px', borderRadius: '999px', fontSize: '12.5px', fontWeight: 600,
                background: p.active === 0 ? 'var(--ink-50)' : 'var(--ok-50, #ecfdf5)',
                color: p.active === 0 ? 'var(--ink-600)' : 'var(--ok-700, #047857)',
            },
        },
            h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: p.active === 0 ? 'var(--ink-400)' : 'var(--ok-500, #10b981)' } }),
            p.active === 0 ? 'Неактивен' : 'Активен');

        const nameRow = h('div', { style: { padding: '16px 20px 14px', display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' } },
            h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { class: 'row', style: { gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
                    h('h1', { style: { margin: 0, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--ink-900)' } }, p.full_name || '—'),
                    activePill,
                ),
                demo,
            ),
            h('button', {
                class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => openEditModal(),
            }, Icon('Edit', { size: 14 }), ' Редактировать'),
        );

        // -- Особые отметки strip --
        const marks = [(p.allergies || '').trim(), (p.chronic_conditions || '').trim()].filter(Boolean);
        const note = (p.notes || '').trim();
        const flagsStrip = h('div', { style: { padding: '0 20px 16px' } },
            h('div', {
                style: {
                    border: '1px solid var(--primary-200, #b6e2d6)', borderRadius: '12px',
                    background: 'var(--primary-25, #f4fbf9)', padding: '12px 16px',
                    display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
                },
            },
                h('div', {
                    style: {
                        width: '36px', height: '36px', borderRadius: '10px', flex: '0 0 auto',
                        background: 'var(--primary-700, #0e6e5e)', color: '#fff',
                        display: 'grid', placeItems: 'center',
                    },
                }, Icon('Flag', { size: 16 })),
                h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' } }, 'Особые отметки'),
                    marks.length
                        ? h('div', { style: { marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                            ...marks.map(m => h('span', {
                                style: { background: 'var(--crit-50, #fef2f2)', color: 'var(--crit-700, #b91c1c)', borderRadius: '999px', padding: '2px 10px', fontSize: '12.5px', fontWeight: 600 },
                            }, m)))
                        : h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, 'Нет отметок'),
                ),
                h('div', { style: { textAlign: 'right', minWidth: '160px', maxWidth: '340px' } },
                    h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' } }, 'Последняя заметка'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        note || 'Заметок нет'),
                ),
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openNotesModal() },
                    Icon('Flag', { size: 13 }), ' Отметки'),
            ),
        );

        // -- stat row (5 cells, divided) --
        const lastVisit = visits[0];
        let daysAgo = null;
        if (lastVisit) {
            daysAgo = Math.max(0, Math.floor((Date.now() - new Date(lastVisit.visit_date).getTime()) / 86400000));
        }
        let outstanding = 0;
        for (const inv of invoices) {
            if (inv.status === 'unpaid' || inv.status === 'partial' || inv.status === 'debt') {
                outstanding += Number(inv.total_amount || 0) - Number(inv.paid_amount || 0);
            }
        }
        outstanding = Math.max(0, Math.round(outstanding));
        const allergiesText = (p.allergies || '').trim();

        // STAT_CELLS_CLICK_V1 — each cell is a button: страховка → payer
        // info/change, последний визит → the Визиты tab, аллергии → the
        // «Отметки» editor, кэшбэк → accrual history, баланс → the ledger.
        const statCell = (icon, iconColor, label, value, sub, valueColor, onclick) => h('button', {
            type: 'button', onclick,
            style: {
                flex: '1 1 180px', padding: '14px 18px', minWidth: 0,
                border: 'none', borderLeft: '1px solid var(--ink-100)',
                background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                transition: 'background .1s',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
            onmouseleave: (e) => { e.currentTarget.style.background = 'none'; },
        },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } },
                h('div', {
                    style: {
                        width: '30px', height: '30px', borderRadius: '9px', flex: '0 0 auto',
                        background: 'var(--ink-25, #f6f8f9)', color: iconColor,
                        display: 'grid', placeItems: 'center', border: '1px solid var(--ink-100)',
                    },
                }, Icon(icon, { size: 14 })),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' } }, label),
                    h('div', { style: { fontSize: '15px', fontWeight: 700, marginTop: '3px', color: valueColor || 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value),
                    sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, sub) : null,
                ),
            ),
        );

        const gotoVisitsTab = () => {
            state.tab = 'visits';
            paintTabs();
            paintBody();
            tabbarEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        const statRow = h('div', {
            style: {
                display: 'flex', flexWrap: 'wrap', borderTop: '1px solid var(--ink-100)',
                margin: '0 -1px',
            },
        },
            statCell('ID',       '#2563eb', 'Страховка', payerName || '—', null, null, () => openInsuranceModal()),
            statCell('Clock',    '#2563eb', 'Последний визит',
                lastVisit ? (lastVisit.visit_date || '').slice(0, 10) : '—',
                daysAgo != null ? (daysAgo === 0 ? 'today' : daysAgo + ' days ago') : 'визитов не было',
                null, gotoVisitsTab),
            statCell('Warning',  'var(--ok-600, #16a34a)', 'Аллергии',
                allergiesText || 'Нет данных', null,
                allergiesText ? 'var(--crit-600, #dc2626)' : 'var(--ok-700, #047857)',
                () => openNotesModal()),
            statCell('Coins',    '#2563eb', 'Кэшбэк', '0 сум', 'нет начислений', null, () => openCashbackModal()),
            statCell('Wallet',   outstanding > 0 ? 'var(--crit-600, #dc2626)' : 'var(--ok-600, #16a34a)', 'Баланс счёта',
                fmtPrice(outstanding) + ' ' + tr('сум'),
                outstanding > 0 ? 'долг' : 'оплачено',
                outstanding > 0 ? 'var(--crit-600, #dc2626)' : 'var(--ok-700, #047857)',
                () => openBalanceModal()),
        );

        headerEl.appendChild(h('div', { class: 'card', style: { overflow: 'hidden', marginBottom: '14px', padding: 0 } },
            cover, nameRow, flagsStrip, statRow,
        ));
    }

    // ---------------------------------------------------------------------
    // Underline tab bar
    // ---------------------------------------------------------------------
    function paintTabs() {
        clear(tabbarEl);
        const bar = h('div', {
            class: 'card',
            style: {
                display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'stretch',
                padding: '0 12px', marginBottom: '14px',
            },
        });
        for (const t of TABS) {
            const active = state.tab === t.id;
            const badge = t.id === 'visits' && visits.length
                ? h('span', {
                    style: {
                        background: active ? 'var(--primary-600)' : 'var(--ink-100)',
                        color: active ? '#fff' : 'var(--ink-600)',
                        borderRadius: '999px', padding: '1px 8px', fontSize: '12.5px', fontWeight: 700,
                    },
                }, String(visits.length))
                : null;
            bar.appendChild(h('button', {
                type: 'button',
                onclick: () => {
                    if (state.tab === t.id) return;
                    state.tab = t.id;
                    paintTabs();
                    paintBody();
                },
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    padding: '14px 12px', border: 'none', background: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: '13.5px',
                    fontWeight: active ? 700 : 500,
                    color: active ? 'var(--primary-700)' : 'var(--ink-600)',
                    borderBottom: '2px solid ' + (active ? 'var(--primary-600)' : 'transparent'),
                    marginBottom: '-1px',
                },
            }, Icon(t.icon, { size: 14 }), t.label, badge));
        }
        // ADD_SERVICES_IN_TABBAR_V1 — «Добавить услуги» живёт в строке вкладок
        // (справа), видна с ЛЮБОЙ активной вкладки.
        bar.appendChild(h('span', { style: { flex: 1 } }));
        bar.appendChild(h('button', {
            class: 'btn btn-primary btn-sm', type: 'button',
            style: { alignSelf: 'center', margin: '8px 0' },
            onclick: () => openVisitWizard(reload, patientStub()),
        }, Icon('Plus', { size: 14 }), ' Добавить услуги'));
        tabbarEl.appendChild(bar);
    }

    function paintBody() {
        clear(bodyEl);
        if (!patient) return;
        if (state.tab === 'visits')        bodyEl.appendChild(renderVisits());
        else if (state.tab === 'services') bodyEl.appendChild(renderServices());
        else if (state.tab === 'billing')  bodyEl.appendChild(renderBilling());
        else if (state.tab === 'labs')     bodyEl.appendChild(renderLabs());
        else if (state.tab === 'docs')     bodyEl.appendChild(renderDocs());   // PATIENT_DOCS_TAB_V1
        else                               bodyEl.appendChild(renderDetails());
    }

    // ---- «Деталь» tab: Контакты и документы + Сводка ----
    function renderDetails() {
        const p = patient;

        const kvRow = (label, valueEl) => h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--ink-50)' } },
            h('div', { class: 'muted', style: { flex: '0 0 130px', fontSize: '12.5px' } }, label),
            h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 500, wordBreak: 'break-word' } },
                valueEl == null || valueEl === '' ? '—' : valueEl),
        );

        const contacts = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('User', { size: 15 }), ' Контакты и документы'),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'звонки и сообщения из системы — скоро'),
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0 36px', padding: '10px 20px 16px' } },
                h('div', null,
                    kvRow('Телефон', p.phone ? h('span', { style: { color: 'var(--primary-700)', fontWeight: 600 } }, p.phone) : null),
                    kvRow('Email', p.email),
                    kvRow('Адрес', p.address),
                    kvRow('Паспорт / ID', p.national_id),
                    kvRow('Гражданство', p.nationality),
                    kvRow('Группа крови', p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : null),
                ),
                h('div', null,
                    kvRow('Экстренный контакт', p.emergency_contact_name),
                    kvRow('Тел. экстренного', p.emergency_contact_phone),
                    kvRow('Профессия', p.occupation),
                    kvRow('Дата рождения', fmtRuDate(p.date_of_birth)),
                    kvRow('Дата регистрации', fmtRuDate(p.registration_date || p.created_at)),
                ),
            ),
        );

        let outstanding = 0;
        for (const inv of invoices) {
            if (inv.status === 'unpaid' || inv.status === 'partial' || inv.status === 'debt') {
                outstanding += Number(inv.total_amount || 0) - Number(inv.paid_amount || 0);
            }
        }
        outstanding = Math.max(0, Math.round(outstanding));
        const countList = (txt) => (txt || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).length;

        const miniTile = (icon, label, value, color) => h('div', {
            style: { background: 'var(--ink-25, #f8fafa)', borderRadius: '10px', padding: '12px 14px', minWidth: 0 },
        },
            h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', color: 'var(--ink-500)', fontSize: '12.5px', fontWeight: 600 } },
                Icon(icon, { size: 12 }), label),
            h('div', { class: 'num', style: { fontSize: '17px', fontWeight: 800, marginTop: '4px', color: color || 'var(--ink-900)' } }, value),
        );

        const summary = h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Chart', { size: 15 }), ' Сводка')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '14px 18px 18px' } },
                miniTile('Stethoscope', 'Визитов', String(visits.length)),
                miniTile('Wallet', 'Баланс счёта', fmtPrice(outstanding) + ' ' + tr('сум'), outstanding > 0 ? 'var(--crit-600)' : 'var(--ok-700)'),
                miniTile('Coins', 'Кэшбэк', '0 сум'),
                miniTile('ID', 'Полис', payerName || '—'),
                miniTile('Warning', 'Аллергий', String(countList(p.allergies))),
                miniTile('Activity', 'Состояний', String(countList(p.chronic_conditions))),
            ),
        );

        return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', gap: '14px', alignItems: 'start' } },
            contacts, summary);
    }

    // ---- Визиты ----
    function renderVisits() {
        const wrap = h('div', { class: 'card' });
        // ADD_SERVICES_IN_TABBAR_V1 — кнопка «Добавить услуги» живёт в строке
        // вкладок (всегда видна), дубль в шапке «Визиты» убран.
        wrap.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Calendar', { size: 15 }), ' Визиты'),
        ));
        if (visits.length === 0) {
            wrap.appendChild(h('div', { class: 'empty' }, 'Визитов пока нет — добавьте пациенту услуги, визит дня создастся сам.'));
            return wrap;
        }
        const tbody = h('tbody');
        for (const v of visits) {
            const doc = v.doctor;
            tbody.appendChild(h('tr', {
                class: 'row-click', style: { cursor: 'pointer' },
                onclick: () => openVisitBillModal(v, reload),
            },
                h('td', { class: 'num', style: { fontSize: '12.5px' } }, fmtDateTime(v.visit_date)),
                h('td', null, doc ? (doc.full_name || '—') : '—'),
                h('td', null, v.visit_type || '—'),
                h('td', null, StatusTag(v.status)),
            ));
        }
        wrap.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата / время'), h('th', null, 'Врач'), h('th', null, 'Тип'), h('th', null, 'Статус'))),
            tbody,
        ));
        return wrap;
    }

    // ---- Услуги (all visit services across visits) ----
    // SVC_ROW_ACTIONS_V1 — правила управляемости строки услуги:
    //   удалить  — пока услуга НЕ в счёте (invoice_item_id пуст); выставленная
    //              в счёт строка заблокирована (сначала отмените счёт);
    //   сменить врача — пока услугу не начали/не оказали (added/queued);
    //              кандидаты — только врачи, назначенные на услугу
    //              (users.service_rates, как в мастере).
    let _svcDocPool = null;   // ленивый кэш врачей с назначениями
    async function svcDoctorPool() {
        if (_svcDocPool) return _svcDocPool;
        const { data } = await supabase.from('users')
            .select('id, full_name, service_rates').eq('role', 'doctor').eq('is_active', true).order('full_name');
        _svcDocPool = data || [];
        return _svcDocPool;
    }

    // SVC_PAGE_SEARCH_V1 — у постоянного пациента список услуг вырастает в
    // бесконечную простыню: последние строки уезжают за экран, а найти в ней
    // что-то можно только глазами. Показываем первые PAGE строк, остальное —
    // по кнопке, плюс поиск по услуге / врачу / дате / статусу.
    const SERVICES_PAGE = 10;

    function renderServices() {
        const wrap = h('div', { class: 'card' });
        const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 500, marginLeft: '8px' } });
        // Строится ОДИН раз: перерисовываем только строки таблицы, иначе поле
        // пересоздавалось бы на каждый символ и теряло фокус (тот же приём, что
        // в фильтрах списка услуг и сотрудников).
        const searchInp = h('input', {
            type: 'search', placeholder: 'Поиск: услуга, врач, статус…',
            style: {
                width: '230px', maxWidth: '45vw', height: '30px', padding: '0 10px',
                border: '1px solid var(--ink-200)', borderRadius: '8px',
                fontFamily: 'inherit', fontSize: '12.5px', boxSizing: 'border-box',
            },
        });
        wrap.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Stethoscope', { size: 15 }), ' Услуги', countEl),
            h('span', { class: 'grow' }),
            services.length > 0 ? searchInp : null));
        if (services.length === 0) {
            wrap.appendChild(h('div', { class: 'empty' }, 'Услуг пока нет.'));
            return wrap;
        }

        const tbody = h('tbody');
        const moreBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' });
        const moreWrap = h('div', { style: { padding: '10px 20px 14px', textAlign: 'center' } }, moreBtn);

        let q = '';
        let shown = SERVICES_PAGE;

        // Ищем по тому, что видно в строке: названию, врачу, дате и статусу.
        // Статус в таблице переведён (h() прогоняет текст через tr()), поэтому
        // сравниваем и с сырым ключом, и с русской подписью — иначе «выполнено»
        // не находило бы строку со status='completed'.
        const RU_STATUS = {
            added: 'добавлено', queued: 'в очереди', in_progress: 'выполняется',
            completed: 'выполнено', cancelled: 'отменено',
        };
        const haystack = (s) => [
            s.name, s.doctorName, s.date ? fmtDateTime(s.date) : '',
            s.status, RU_STATUS[s.status] || '', String(s.total ?? ''),
        ].filter(Boolean).join(' ').toLowerCase();
        const matches = (s) => !q || haystack(s).includes(q);

        searchInp.addEventListener('input', () => {
            q = searchInp.value.trim().toLowerCase();
            shown = SERVICES_PAGE;   // новый запрос — снова с первой страницы
            paintRows();
        });
        moreBtn.addEventListener('click', () => { shown += SERVICES_PAGE; paintRows(); });

        function paintRows() {
            clear(tbody);
            const rows = services.filter(matches);
            countEl.textContent = q ? trf('{n} из {max}', { n: rows.length, max: services.length }) : String(services.length);

            if (!rows.length) {
                tbody.appendChild(h('tr', null, h('td', { colspan: '7', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } },
                    'Ничего не найдено — измените запрос.')));
                moreWrap.style.display = 'none';
                return;
            }
            for (const s of rows.slice(0, shown)) tbody.appendChild(buildServiceRow(s));

            const left = rows.length - Math.min(shown, rows.length);
            moreWrap.style.display = left > 0 ? '' : 'none';
            moreBtn.textContent = trf('Показать ещё {n} из {left}', { n: Math.min(SERVICES_PAGE, left), left });
        }

        // Одна строка таблицы. Вынесена из цикла, чтобы её можно было
        // перерисовывать при поиске и по кнопке «Показать ещё».
        function buildServiceRow(s) {
            const editable  = s.status === 'added' || s.status === 'queued';   // ещё не оказана
            // SVC_UNPAID_REMOVE_V1 — убрать можно любую НЕ начатую услугу; если
            // строка уже в счёте, сервер удалит её вместе с НЕоплаченным счётом
            // (уменьшит или удалит его целиком) и откажет по оплаченному.
            const removable = editable;

            const docCell = h('td', null, s.doctorName || '—');
            const editBtn = editable ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', title: 'Сменить врача',
                onclick: async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    const pool = (await svcDoctorPool()).filter(d => Array.isArray(d.service_rates)
                        && d.service_rates.some(r => r && String(r.service_id) === String(s.serviceId)));
                    btn.disabled = false;
                    if (!pool.length) { toast('На эту услугу не назначен ни один врач (Сотрудники → «Услуги и ставки»).', 'info'); return; }
                    const sel = h('select', { style: { padding: '5px 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', maxWidth: '180px' } },
                        ...(s.doctorId && !pool.some(d => String(d.id) === String(s.doctorId))
                            ? [h('option', { value: s.doctorId, selected: true }, s.doctorName || trf('Врач #{id}', { id: s.doctorId }))] : []),
                        ...pool.map(d => h('option', { value: d.id, selected: String(d.id) === String(s.doctorId) }, d.full_name)));
                    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'ОК');
                    save.addEventListener('click', async () => {
                        const { error } = await supabase.from('visit_services').update({ doctor_id: Number(sel.value) }).eq('id', s.id);
                        if (error) { toast(trf('Не сохранилось: {msg}', { msg: error.message }), 'fail'); return; }
                        toast('Врач изменён.');
                        await reload();
                    });
                    clear(docCell);
                    docCell.appendChild(h('span', { class: 'row', style: { gap: '6px' } }, sel, save));
                },
            }, Icon('Edit', { size: 13 })) : null;

            // SVC_CHANGE_V1 — заменить услугу (пока не оказана и счёт не оплачен):
            // строка получает новую услугу/цену, неоплаченный счёт пересчитывается.
            const swapBtn = editable ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', title: 'Заменить услугу (цена и счёт пересчитаются)',
                onclick: async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    const { data: svcList, error: svcErr } = await supabase.from('services')
                        .select('id, name, price').eq('active', 1).order('name').limit(1000);
                    btn.disabled = false;
                    if (svcErr || !svcList || !svcList.length) { toast('Каталог услуг не загрузился.', 'fail'); return; }
                    const sel = h('select', { style: { padding: '5px 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', maxWidth: '220px' } },
                        ...svcList.map(x => h('option', { value: x.id, selected: String(x.id) === String(s.serviceId) },
                            x.name + ' — ' + fmtPrice(x.price))));
                    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'ОК');
                    save.addEventListener('click', async () => {
                        if (String(sel.value) === String(s.serviceId)) { toast('Услуга не изменилась.', 'info'); return; }
                        const { data, error } = await supabase.rpc('change_unpaid_service',
                            { visit_service_id: s.id, new_service_id: Number(sel.value) });
                        if (error) { toast(trf('Не удалось заменить: {msg}', { msg: error.message }), 'fail'); return; }
                        toast(data && data.invoice ? 'Услуга заменена, счёт пересчитан.' : 'Услуга заменена.');
                        await reload();
                    });
                    clear(nameCell);
                    nameCell.appendChild(h('span', { class: 'row', style: { gap: '6px' } }, sel, save));
                },
            }, Icon('Repeat', { size: 13 })) : null;

            const delBtn = removable ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button',
                title: s.invoiceItemId ? 'Убрать услугу вместе с неоплаченным счётом' : 'Убрать услугу',
                style: { color: 'var(--crit-600, #dc2626)' },
                onclick: async () => {
                    const warn = s.invoiceItemId
                        ? trf('Убрать услугу «{name}»? Неоплаченный счёт будет уменьшен (или удалён, если это единственная позиция).', { name: s.name })
                        : trf('Убрать услугу «{name}»?', { name: s.name });
                    if (!confirm(warn)) return;
                    // SVC_UNPAID_REMOVE_V1 — атомарно: строка + ремонт счёта; сервер
                    // откажет, если счёт уже оплачен/частично оплачен.
                    const { data, error } = await supabase.rpc('remove_unpaid_service', { visit_service_id: s.id });
                    if (error) { toast(trf('Не удалось убрать: {msg}', { msg: error.message }), 'fail'); return; }
                    toast(data && data.invoice_deleted ? 'Услуга и пустой счёт удалены.'
                        : s.invoiceItemId ? 'Услуга убрана, счёт пересчитан.' : 'Услуга убрана.');
                    await reload();
                },
            }, Icon('Trash', { size: 13 })) : null;

            // REPRINT_SERVICE_CHECK_V1 — перепечатать чек по этой услуге.
            // Доступно, только когда услуга попала в счёт: чек — документ об
            // оплате, и без счёта печатать нечего. Номер очереди на чеке тот же
            // самый — issue_queue_numbers возвращает уже выданный, а не новый.
            const printBtn = s.invoiceItemId ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', title: 'Перепечатать чек',
                onclick: async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    try {
                        const { data: item, error } = await supabase.from('invoice_items')
                            .select('invoice_id').eq('id', s.invoiceItemId).single();
                        if (error || !item) { toast('Счёт для этой услуги не найден.', 'fail'); return; }
                        const me = (typeof window !== 'undefined' && window.CURRENT_USER) || {};   // admin.js onAuthed()
                        const res = await printInvoiceCheck({
                            supabase, printableSheet: _printSheet, invoiceId: item.invoice_id,
                            cashierName: (me && (me.full_name || me.username)) || '',
                        });
                        if (!res.ok) toast(res.reason || 'Не удалось напечатать чек.', 'fail');
                    } catch (e) {
                        toast(trf('Не удалось напечатать чек: {msg}', { msg: (e && e.message) || e }), 'fail');
                    } finally { btn.disabled = false; }
                },
            }, Icon('Print', { size: 13 })) : null;

            const nameCell = h('td', null, s.name);
            return h('tr', null,
                h('td', { class: 'num', style: { fontSize: '12.5px' } }, s.date ? fmtDateTime(s.date) : '—'),
                nameCell,
                docCell,
                h('td', { class: 'num', style: { textAlign: 'right' } }, String(s.qty || 1)),
                h('td', { class: 'num', style: { textAlign: 'right' } }, fmtPrice(s.total)),
                h('td', null, StatusTag(s.status)),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    h('span', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, printBtn, swapBtn, editBtn, delBtn)),
            );
        }

        wrap.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Услуга'), h('th', null, 'Врач'),
                h('th', { style: { textAlign: 'right' } }, 'Кол-во'),
                h('th', { style: { textAlign: 'right' } }, 'Сумма'),
                h('th', null, 'Статус'), h('th', null, ''))),
            tbody,
        ));
        wrap.appendChild(moreWrap);
        paintRows();
        return wrap;
    }

    // ---- Счёт ----
    // PATIENT_BILLING_DETAILED_V1 — per invoice: WHAT was billed (each service
    // line with qty and sum) and WHO the doctor was (visit_services rows linked
    // by invoice_item_id). Rows paint immediately; details fill in from three
    // bounded reads (invoice_items → visit_services → users).
    function renderBilling() {
        const wrap = h('div', { class: 'card' });
        wrap.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Receipt', { size: 15 }), ' Счёт')));
        if (invoices.length === 0) {
            wrap.appendChild(h('div', { class: 'empty' }, 'Счетов пока нет.'));
            return wrap;
        }
        let totalBilled = 0, totalPaid = 0;
        for (const inv of invoices) {
            totalBilled += Number(inv.total_amount || 0);
            totalPaid   += Number(inv.paid_amount || 0);
        }
        const outstanding = Math.max(0, totalBilled - totalPaid);
        wrap.appendChild(h('div', { class: 'row', style: { gap: '18px', padding: '14px 20px 0', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--ink-600)' } },
            h('span', null, 'Выставлено: ', h('b', null, fmtPrice(totalBilled), ' сум')),
            h('span', null, 'Оплачено: ', h('b', null, fmtPrice(totalPaid), ' сум')),
            h('span', { style: { color: outstanding > 0 ? 'var(--warn-700)' : 'var(--ok-700)', fontWeight: 600 } },
                'Долг: ', fmtPrice(outstanding), ' сум'),
        ));
        const svcCells = new Map();   // invoice_id -> услуги cell
        const docCells = new Map();   // invoice_id -> врач cell
        const tbody = h('tbody');
        for (const inv of invoices) {
            const balance = Number(inv.total_amount || 0) - Number(inv.paid_amount || 0);
            const svcTd = h('td', { style: { maxWidth: '340px' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загрузка…'));
            const docTd = h('td', null, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '…'));
            svcCells.set(inv.id, svcTd);
            docCells.set(inv.id, docTd);
            tbody.appendChild(h('tr', null,
                h('td', null,
                    h('div', { class: 'cell-strong' }, inv.invoice_number || ('#' + inv.id)),
                    h('div', { class: 'muted num', style: { fontSize: '12.5px', marginTop: '2px' } }, fmtDateTime(inv.created_at)),
                ),
                svcTd,
                docTd,
                h('td', { class: 'num', style: { textAlign: 'right' } }, fmtPrice(inv.total_amount)),
                h('td', { class: 'num', style: { textAlign: 'right', color: 'var(--ok-700)' } }, fmtPrice(inv.paid_amount)),
                h('td', { class: 'num', style: { textAlign: 'right', fontWeight: 600, color: balance > 0 ? 'var(--crit-600)' : 'var(--ink-500)' } }, fmtPrice(balance)),
                h('td', null, StatusTag(inv.status)),
            ));
        }
        wrap.appendChild(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, '№ счёта / дата'),
                h('th', null, 'Услуги'),
                h('th', null, 'Врач'),
                h('th', { style: { textAlign: 'right' } }, 'Сумма'),
                h('th', { style: { textAlign: 'right' } }, 'Оплачено'),
                h('th', { style: { textAlign: 'right' } }, 'Остаток'),
                h('th', null, 'Статус'))),
            tbody,
        )));
        fillBillingDetails(svcCells, docCells);
        return wrap;
    }

    async function fillBillingDetails(svcCells, docCells) {
        const invIds = invoices.map(i => i.id);
        if (!invIds.length) return;

        let items = [];
        try {
            const { data } = await supabase.from('invoice_items')
                .select('id, invoice_id, description, quantity, total, services(name)')
                .in('invoice_id', invIds).limit(1000);
            items = data || [];
        } catch (e) { /* cells fall back to «—» below */ }

        // The doctor lives on visit_services, linked by invoice_item_id.
        const docByItem = new Map();
        const itemIds = items.map(i => i.id);
        if (itemIds.length) {
            try {
                const { data: vsRows } = await supabase.from('visit_services')
                    .select('invoice_item_id, doctor_id').in('invoice_item_id', itemIds).limit(1000);
                const docIds = [...new Set((vsRows || []).map(r => r.doctor_id).filter(Boolean))];
                const nameById = new Map();
                if (docIds.length) {
                    const { data: users } = await supabase.from('users')
                        .select('id, full_name').in('id', docIds).limit(200);
                    for (const u of (users || [])) nameById.set(u.id, u.full_name);
                }
                for (const r of (vsRows || [])) {
                    if (r.doctor_id && nameById.has(r.doctor_id)) docByItem.set(r.invoice_item_id, nameById.get(r.doctor_id));
                }
            } catch (e) { /* doctors stay unknown */ }
        }

        const byInvoice = new Map();
        for (const it of items) {
            const list = byInvoice.get(it.invoice_id) || [];
            list.push(it);
            byInvoice.set(it.invoice_id, list);
        }

        for (const [invId, td] of svcCells) {
            if (!td.isConnected) continue;   // the tab was switched away
            clear(td);
            const list = byInvoice.get(invId) || [];
            if (!list.length) { td.appendChild(h('span', { class: 'muted' }, '—')); continue; }
            for (const it of list) {
                const nm = (it.services && it.services.name) || it.description || '—';
                td.appendChild(h('div', { style: { fontSize: '12.5px', padding: '1px 0', whiteSpace: 'normal', lineHeight: 1.45 } },
                    nm + (it.quantity > 1 ? ` ×${it.quantity}` : ''),
                    h('span', { class: 'muted num' }, ' — ' + fmtPrice(it.total)),
                ));
            }
        }
        for (const [invId, td] of docCells) {
            if (!td.isConnected) continue;
            clear(td);
            const docs = [...new Set((byInvoice.get(invId) || []).map(it => docByItem.get(it.id)).filter(Boolean))];
            td.appendChild(docs.length
                ? h('div', { style: { fontSize: '12.5px', whiteSpace: 'normal', lineHeight: 1.45 } }, docs.join(', '))
                : h('span', { class: 'muted' }, '—'));
        }
    }

    // ---- Лаборатория ----
    function renderLabs() {
        const wrap = h('div', { class: 'card' });
        wrap.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Flask', { size: 15 }), ' Лаборатория')));
        if (labs.length === 0) {
            wrap.appendChild(h('div', { class: 'empty' }, 'Результатов пока нет.'));
            return wrap;
        }
        const tbody = h('tbody');
        for (const r of labs) {
            tbody.appendChild(h('tr', null,
                h('td', null, r.name),
                h('td', { class: 'num' }, [r.value, r.unit].filter(Boolean).join(' ') || '—'),
                h('td', null, r.reference),
                h('td', null, r.flag ? StatusTag(r.flag) : '—'),
                h('td', { class: 'num', style: { fontSize: '12.5px' } }, r.date ? fmtDateTime(r.date) : '—'),
            ));
        }
        wrap.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Тест'), h('th', null, 'Результат'), h('th', null, 'Референс'),
                h('th', null, 'Флаг'), h('th', null, 'Дата'))),
            tbody,
        ));
        return wrap;
    }

    // ---------------------------------------------------------------------
    // PATIENT_DOCS_TAB_V1 — «Документы»: файлы пациента (visit_documents).
    // Загрузка в локальное хранилище (BRANCH_BUCKET) + строка в
    // visit_documents (patient_id); открытие по signedUrl. Сюда же попадают
    // подписанные протоколы из кабинета врача (они тоже в visit_documents).
    // ---------------------------------------------------------------------
    function renderDocs() {
        const wrap = h('div', { class: 'card' });
        const uid = (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null;

        const fileInp = h('input', { type: 'file', style: { display: 'none' } });
        fileInp.addEventListener('change', async () => {
            const f = fileInp.files && fileInp.files[0];
            if (!f) return;
            try {
                const up = await uploadFile(BRANCH_BUCKET, f, 'patients/' + patient.id + '/docs/');
                const row = {
                    patient_id: patient.id, title: f.name, file_name: f.name,
                    file_path: up.path, file_size: f.size,
                    content_type: f.type || 'application/octet-stream', doc_type: 'upload',
                };
                if (uid != null) row.created_by = uid;
                const { error } = await supabase.from('visit_documents').insert(row);
                if (error) throw new Error(error.message);
                toast('Документ загружен.');
                paintList();
            } catch (e) { toast(trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }), 'fail'); }
            fileInp.value = '';
        });

        wrap.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Doc', { size: 15 }), ' Документы'),
            h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => fileInp.click(),
            }, Icon('Plus', { size: 14 }), ' Загрузить документ'),
        ));
        wrap.appendChild(fileInp);

        const listEl = h('div');
        wrap.appendChild(listEl);

        // PATIENT_DOCS_CLINICAL_V1 — вкладка = клинический архив пациента:
        // заключения приёма/диагностики (подписанные в кабинете врача,
        // visit_documents.body), результаты анализов (из lab_results, по дням)
        // и загруженные файлы. Заключения открываются тем же брендированным
        // бланком, что и все кнопки «Печать» (Настройки → Документы).
        const DOC_TYPE_RU = { protocol: 'Заключение приёма', diag: 'Заключение диагностики', lab: 'Результаты анализов', upload: 'Файл', file: 'Файл' };
        // LAB_BLANK_DESIGNED_V1 — имена ТИПОВ ШАБЛОНА, а не наши внутренние.
        // Здесь стояли 'diagnostics' и 'results' — типов с такими именами нет
        // (есть conclusion / diag / lab), поэтому сохранённое заключение
        // диагностики и результаты анализов открывались не своим бланком, а
        // старой обёрткой .sheet, которая не умеет делиться на страницы.
        const SHEET_TYPE = { protocol: 'conclusion', diag: 'diag', lab: 'lab' };
        async function openDoc(d) {
            if (d.file_path) {
                const url = await signedUrl(BRANCH_BUCKET, d.file_path);
                if (url) window.open(url, '_blank'); else toast('Файл недоступен.', 'fail');
                return;
            }
            if (d.body && typeof d.body === 'object') {
                printableSheet({ type: SHEET_TYPE[d.doc_type] || 'conclusion', title: d.title || null, data: d.body });
                return;
            }
            toast('У записи нет содержимого.', 'info');
        }
        function labDayRows() {
            // LAB_DOC_ONE_PER_VISIT_V1 — ОДИН документ на ВИЗИТ со ВСЕМИ панелями
            // этого визита. Раньше группировали по дню (и по одной строке на
            // услугу), поэтому пациент с пятью анализами получал документ с одним
            // результатом. Ключ — визит; день остаётся запасным ключом для старых
            // строк, у которых визит не определился.
            // LAB_DOC_PENDING_V1 — документ строится по НАЗНАЧЕННЫМ анализам, а
            // не по введённым результатам. Раньше здесь перебирались строки
            // lab_results, поэтому назначенный, но ещё не готовый анализ не
            // появлялся в карте ВООБЩЕ: у регистратора не было способа увидеть,
            // что документ ещё ждут, — он видел пустоту и считал, что ничего не
            // назначали.
            const resultsByVs = new Map();
            for (const r of (labs || [])) {
                if (r.vsId == null) continue;
                if (!resultsByVs.has(r.vsId)) resultsByVs.set(r.vsId, []);
                resultsByVs.get(r.vsId).push(r);
            }

            const byVisit = new Map();
            const take = (key, day) => {
                if (!byVisit.has(key)) byVisit.set(key, { day, orders: [], rows: [] });
                return byVisit.get(key);
            };
            for (const o of (services || [])) {
                if (!o.isLab) continue;
                const day = o.date ? String(o.date).slice(0, 10) : '';
                const key = o.visitId != null ? 'v' + o.visitId : (day ? 'd' + day : '');
                if (!key) continue;
                const g = take(key, day);
                g.orders.push(o);
                g.rows.push(...(resultsByVs.get(o.id) || []));
            }
            // Результаты, чей заказ не попал в services (старые строки без
            // визита), не теряем — для них остаётся прежняя группировка по дню.
            const known = new Set([...byVisit.values()].flatMap(g => g.orders.map(o => o.id)));
            for (const r of (labs || [])) {
                if (r.vsId != null && known.has(r.vsId)) continue;
                const day = r.date ? String(r.date).slice(0, 10) : '';
                const key = r.visitId != null ? 'v' + r.visitId : (day ? 'd' + day : '');
                if (!key) continue;
                take(key, day).rows.push(r);
            }

            return [...byVisit.entries()].map(([key, g]) => {
                // В заголовке — число НАЗНАЧЕННЫХ АНАЛИЗОВ, а не показателей: «28
                // тестов» для одного ОАК читалось бы как 28 назначений.
                const total = g.orders.length || new Set(g.rows.map(r => r.vsId)).size || 1;
                const ready = g.orders.length
                    ? g.orders.filter(o => (resultsByVs.get(o.id) || []).length).length
                    : total;
                return {
                    _lab: true, id: 'lab:' + key, doc_type: 'lab',
                    title: trf('Результаты анализов · {n} анализ(ов)', { n: total }),
                    created_at: (g.day || '') + 'T12:00:00Z',
                    rows: g.rows,
                    ready, total, st: labDocStatus(g.orders, ready, total),
                };
            });
        }

        // Состояние документа целиком. Пока хоть один назначенный анализ без
        // результата — документ НЕ готов: отдать пациенту половину бланка хуже,
        // чем сказать, что он ещё делается.
        function labDocStatus(orders, ready, total) {
            if (!ready) return { label: 'Не готов', kind: 'warn' };
            if (ready < total) return { label: trf('Готово {ready} из {total}', { ready, total }), kind: 'warn' };
            const issued = orders.length && orders.every(o => o.status === 'completed');
            return issued ? { label: 'Выдан', kind: 'ok' } : { label: 'Готов', kind: 'info' };
        }
        // Локальная копия — patient-card не тянет lab-grouping.js ради одного слова.
        function pluralRuLocal(n, one, few, many) {
            const a = Math.abs(n) % 100, b = a % 10;
            if (a > 10 && a < 20) return many;
            if (b > 1 && b < 5) return few;
            if (b === 1) return one;
            return many;
        }
        // LAB_BLANK_DESIGNED_V1 — тот же бланк, что печатает лаборатория.
        //
        // Раньше здесь строилась собственная таблица и уходила как type:'results'
        // — типа с таким именем нет, поэтому документ рисовался старой обёрткой
        // .sheet (display:flex + overflow:hidden). Chrome не делит flex-контейнер
        // на страницы и обрезает лишнее, так что результаты за один день длиннее
        // страницы печатались обрубленными. Теперь — шаблон из «Настройки →
        // Документы» (type:'lab'), тот же, что в лаборатории: один бланк, один
        // вид, куда бы пациент за ним ни пришёл.
        async function printLabDay(doc) {
            // LAB_DOC_ONE_PER_VISIT_V1 — каждая панель визита своей группой:
            // сплошной таблицей не видно, где кончается ОАК и начинается ТОРЧ.
            const byPanel = new Map();
            for (const r of doc.rows) {
                const k = r.vsId != null ? 'vs' + r.vsId : (r.panel || '');
                if (!byPanel.has(k)) byPanel.set(k, { panel: r.panel || '', list: [] });
                byPanel.get(k).list.push(r);
            }
            // LAB_ANALYTE_INDEX_V1 — карта пациента ищет показатель ТЕМ ЖЕ
            // способом, что и лаборатория. Раньше здесь печаталось только то,
            // что сохранилось в самой строке результата, поэтому нормы,
            // заведённые позже, в карту не попадали, и один и тот же анализ
            // выглядел по-разному в лаборатории и в карте.
            const idx = await analyteIndex();
            const gender = String((patient && patient.gender) || '').toLowerCase();
            const age = ageYears(patient && patient.date_of_birth);
            // LAB_PANEL_IS_TRUTH_V1 — каждая группа это ОДИН заказ (vsId),
            // значит у неё есть услуга и панель услуги. Результаты группы
            // сопоставляются с показателями этой панели: сначала по имени,
            // остальные по порядку. Правка имён в справочнике больше не
            // оставляет старые документы без норм — ровно как в лаборатории.
            const svcByVs = new Map((services || []).map((x) => [x.id, x.serviceId]));
            const groups = [...byPanel.values()].map(({ panel, list }) => {
                const vsId = list.length ? list[0].vsId : null;
                const panelList = analytesForService(idx, svcByVs.get(vsId));
                const byOrder = matchResultsToAnalytes(panelList, list.map((r) => r.name));
                return {
                // LAB_SHEET_HEAD_V1 — «· № LAB-…» как на бланке лаборатории:
                // номер образца стоит у своей таблицы, где бы бланк ни печатали.
                title: (panel || 'Анализ') + (vsId != null ? ' · № ' + labAccession(vsId) : ''),
                tests: list.map((r, ri) => {
                    const analyte = byOrder[ri] || resolveAnalyte(idx, r.name, null);
                    const named = namedRangeCell(analyte, gender, age);
                    const manyRanges = named.count >= 2;
                    return {
                        name: r.name,
                        code: '',
                        value: r.value == null || r.value === '' ? '—' : String(r.value),
                        unit: r.unit || (analyte && analyte.unit) || '',
                        ref: labRefText(analyte, named.marked ? '' : gender, r.reference, named.texts),
                        flag: manyRanges ? '' : labFlagCell(r),
                        // Строки этого документа собираются без числовых границ
                        // (ref_low/ref_high), поэтому полоску диапазона не рисуем:
                        // метка по умолчанию села бы в середину и читалась как норма.
                        pos: manyRanges ? null : labPosFor(r),
                    };
                }),
                };
            });
            // LAB_DOC_PENDING_V1 — назначенный, но не готовый анализ теперь виден
            // в списке, поэтому по нему МОЖНО нажать «Печать». Печатать нечего —
            // говорим об этом прямо, а не открываем пустой бланк.
            if (!groups.length) return toast('Результаты ещё не внесены — печатать нечего.', 'info');
            // LAB_SHEET_HEAD_V1 — та же шапка, что у лаборатории и бота.
            // Раньше здесь «Выдан» получал ДЕНЬ ВИЗИТА (синтетический
            // created_at группировки), а номер заявки не печатался вовсе — и
            // пациент держал два разных документа об одном анализе.
            const vsIds = [...new Set(doc.rows.map((r) => r.vsId).filter((v) => v != null))];
            const { dateIn, dateOut } = labIssueDates({
                visitDate: labMaxDate(doc.rows, 'date'),
                verifiedAt: labMaxDate(doc.rows, 'verifiedAt'),
                lastEnteredAt: labMaxDate(doc.rows, 'enteredAt'),
            });
            printableSheet({
                type: 'lab',
                title: 'Результаты анализов',
                data: {
                    requestNo: vsIds.length === 1 ? labAccession(vsIds[0]) : '',
                    dateIn,
                    dateOut,
                    patientName: patient.full_name || '—',
                    dob: fmtDMY(patient.date_of_birth),
                    sex: labSexRu(patient.gender),
                    mrn: patient.mrn || '',
                    groups,
                },
            });
        }
        // WS_DERIVED_DOCS_V1 — заключения также ДЕРИВИРУЮТСЯ из подписанной
        // истории visit_services.notes: покрывает документы, подписанные до
        // включения архива, и любой будущий сбой архивации. Дубликаты
        // отсекаются по visit_service_id (архивная строка выигрывает).
        const FIELD_RU = {
            complaint: 'Жалобы', anamnesis: 'Анамнез', objective: 'Объективный статус',
            diagnosis: 'Диагноз', dx: 'Диагноз', icd10: 'Код МКБ-10', therapy: 'Терапия',
            recommendations: 'Рекомендации', follow_up: 'Повторный приём',
            referral: 'Направление', instrumental: 'Инструментальные данные', doctor_phone: 'Телефон врача',
        };
        /* i18n-exempt-start: печать «Заключения врача» — печатный документ, намеренно русский */
        /* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
        function printWsDoc(d) {
            const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
            const blocks = Object.entries(d.fields || {})
                .filter(([, v]) => String(v || '').replace(/<[^>]*>/g, '').trim())
                .map(([k, v]) => `<div style="margin:10px 0"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;color:#178;text-transform:uppercase">${esc(FIELD_RU[k] || k)}</div><div style="font-size:13.5px;margin-top:3px">${v}</div></div>`)
                .join('');
            const bodyHtml = `<h3 style="margin:0 0 4px">Заключение врача</h3>
<div style="color:#667;font-size:12px;margin-bottom:8px">${esc(patient.full_name || '')} · ${esc(patient.mrn || '')}${d.doctorName ? ' · Врач: ' + esc(d.doctorName) : ''} · ${esc(String(d.created_at || '').slice(0, 10).split('-').reverse().join('.'))}</div>
${blocks || '<div style="color:#889;font-size:13px">Документ подписан без заполненных разделов.</div>'}`;
            /* type-scale-exempt-end */
            /* i18n-exempt-end */
            printableSheet({ type: 'conclusion', title: d.title, bodyHtml });
        }
        async function paintList() {
            clear(listEl);
            listEl.appendChild(h('div', { class: 'muted', style: { padding: '12px 0' } }, 'Загрузка…'));
            const { data, error } = await supabase.from('visit_documents')
                .select('id, title, doc_type, file_name, file_path, body, created_at, visit_service_id')
                .eq('patient_id', patient.id)
                .order('created_at', { ascending: false })
                .limit(300);
            clear(listEl);
            if (error) { listEl.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить документы: {msg}', { msg: error.message }))); return; }

            // подписанные документы из истории строк услуг (WS_DERIVED_DOCS_V1)
            const wsRows = [];
            try {
                const visitIds = (visits || []).map(v => v.id).filter(Boolean);
                if (visitIds.length) {
                    const { data: vsNotes } = await supabase.from('visit_services')
                        .select('id, notes, services(name), users:doctor_id(full_name)')
                        .in('visit_id', visitIds)
                        .not('notes', 'is', null);
                    const archived = new Set((data || []).map(x => x.visit_service_id).filter(Boolean));
                    for (const r of (vsNotes || [])) {
                        if (archived.has(r.id)) continue;
                        let p = null; try { p = JSON.parse(r.notes); } catch (e2) { continue; }
                        const signed = ((p && p.history) || []).filter(e2 => e2.kind === 'signed');
                        const last = signed[signed.length - 1];
                        if (!last) continue;
                        wsRows.push({
                            _ws: true, id: 'ws:' + r.id, doc_type: 'protocol',
                            title: 'Заключение приёма',
                            service: (r.services && r.services.name) || '',
                            created_at: last.savedAt || '',
                            fields: last.fields || {},
                            doctorName: (r.users && r.users.full_name) || last.byName || '',
                        });
                    }
                }
            } catch (e2) { console.warn('[patient-docs] ws-derive:', e2 && e2.message); }

            const docs = [...(data || []), ...wsRows, ...labDayRows()]
                .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            if (docs.length === 0) {
                listEl.appendChild(h('div', { class: 'empty' }, 'Документов пока нет — подпишите заключение в кабинете врача, внесите результаты анализов или загрузите файл.'));
                return;
            }
            // DOCS_DETAIL_ROW_V1 — детализированные строки: Документ · Услуга ·
            // Врач · Дата + явная кнопка «Печать» в конце (регистратор печатает
            // и отдаёт пациенту).
            const rowSvc = (d) => d.service
                || (d.body && typeof d.body === 'object' && d.body.service)
                || (d._lab ? 'Лаборатория' : '');
            const rowDoc = (d) => d.doctorName
                || (d.body && typeof d.body === 'object' && (d.body.doctorName || (d.body.meta && d.body.meta.signedBy)))
                || '';
            const openRow = (d) => d._lab ? printLabDay(d) : (d._ws ? printWsDoc(d) : openDoc(d));
            const tbody = h('tbody');
            for (const d of docs) {
                tbody.appendChild(h('tr', null,
                    h('td', null, h('a', {
                        href: '#', style: { fontWeight: 600 },
                        onclick: (ev) => { ev.preventDefault(); openRow(d); },
                    }, d.title || d.file_name || trf('Документ #{id}', { id: d.id })),
                        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '3px' } },
                            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, DOC_TYPE_RU[d.doc_type] || d.doc_type || ''),
                            // LAB_DOC_PENDING_V1 — статус виден в списке: «Не
                            // готов» это ответ на вопрос пациента у стойки.
                            d.st ? Tag(d.st.label, { kind: d.st.kind, dot: true }) : null)),
                    h('td', null, rowSvc(d) || '—'),
                    h('td', null, rowDoc(d) || '—'),
                    h('td', { class: 'num', style: { fontSize: '12.5px' } }, d.created_at ? fmtDateTime(d.created_at) : '—'),
                    h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        h('button', {
                            class: 'btn btn-outline btn-sm', type: 'button', title: 'Печать',
                            onclick: () => openRow(d),
                        }, Icon('Print', { size: 13 }), ' Печать'),
                        (d._lab || d._ws) ? null : h('button', {
                            class: 'btn btn-outline btn-sm', type: 'button', title: 'Удалить',
                            style: { marginLeft: '6px', color: 'var(--crit-600, #dc2626)' },
                            onclick: async () => {
                                if (!confirm(trf('Удалить документ «{name}»?', { name: d.title || d.file_name || d.id }))) return;
                                const { error: delErr } = await supabase.from('visit_documents').delete().eq('id', d.id);
                                if (delErr) { toast(trf('Не удалось удалить: {msg}', { msg: delErr.message }), 'fail'); return; }
                                if (d.file_path) removeFile(BRANCH_BUCKET, d.file_path);   // best-effort
                                toast('Документ удалён.');
                                paintList();
                            },
                        }, Icon('Trash', { size: 13 }))),
                ));
            }
            listEl.appendChild(h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Документ'), h('th', null, 'Услуга'), h('th', null, 'Врач'),
                    h('th', null, 'Дата'), h('th', null, ''))),
                tbody,
            ));
        }
        paintList();
        return wrap;
    }

    // ---------------------------------------------------------------------
    // STAT_CELLS_CLICK_V1 — shared info-modal chrome for the cell histories.
    // ---------------------------------------------------------------------
    function infoModal(title, icon, bodyEls, footEls) {
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon(icon, { size: 16 }), ' ', title),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' }, ...bodyEls),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'),
                h('span', { class: 'grow' }),
                ...(footEls || [])),
        ));
        document.body.appendChild(overlay);
        return { close };
    }

    // ---- Страховка: current payer + policies, with a change control ----
    async function openInsuranceModal() {
        const p = patient;
        let payers = [];
        try {
            const { data } = await supabase.from('payers').select('id, name, kind').eq('active', true).order('name');
            payers = data || [];
        } catch (e) { /* list stays empty */ }

        const sel = h('select', null,
            h('option', { value: '' }, '— Самооплата (без страховки) —'),
            ...payers.map(py => h('option', { value: py.id, selected: p.payer_id === py.id }, py.name)));

        const policiesEl = h('div', { class: 'muted', style: { fontSize: '12.5px', minHeight: '20px' } });
        async function showPolicies() {
            clear(policiesEl);
            const pid = Number(sel.value);
            if (!pid) { policiesEl.textContent = payers.length ? tr('') : tr('Плательщики не настроены (Настройки → Плательщики).'); return; }
            try {
                const { data } = await supabase.from('payer_policies')
                    .select('name, coverage_percent').eq('payer_id', pid).eq('active', true).order('name');
                const rows = data || [];
                if (!rows.length) { policiesEl.textContent = tr('У плательщика нет активных полисов.'); return; }
                policiesEl.appendChild(h('div', null,
                    h('div', { style: { fontWeight: 700, fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' } }, 'Полисы'),
                    ...rows.map(r => h('div', { class: 'row', style: { padding: '5px 0', borderBottom: '1px solid var(--ink-50)', gap: '10px' } },
                        h('span', { style: { flex: 1, color: 'var(--ink-800)' } }, r.name),
                        h('span', { class: 'num', style: { fontWeight: 600 } }, trf('покрытие {n}%', { n: r.coverage_percent || 0 })))),
                ));
            } catch (e) { policiesEl.textContent = ''; }
        }
        sel.addEventListener('change', showPolicies);
        showPolicies();

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
        const m = infoModal('Страховка', 'ID', [
            field('Плательщик', sel),
            policiesEl,
        ], [saveBtn]);
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = tr('Сохраняем…');
            try {
                const { error } = await supabase.from('patients')
                    .update({ payer_id: sel.value ? Number(sel.value) : null }).eq('id', p.id).select().single();
                if (error) { toast(error.message, 'fail'); saveBtn.disabled = false; saveBtn.textContent = tr('Сохранить'); return; }
                toast('Сохранено');
                m.close();
                await reload();
            } catch (e) {
                toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
                saveBtn.disabled = false;
                saveBtn.textContent = tr('Сохранить');
            }
        });
    }

    // ---- Кэшбэк: accrual history (empty until a ledger exists) + rules ----
    async function openCashbackModal() {
        let rules = [];
        try {
            const { data } = await supabase.from('cashback_rules').select('name, percent').eq('active', true).order('name');
            rules = data || [];
        } catch (e) { /* rules stay empty */ }

        infoModal('Кэшбэк · история', 'Coins', [
            h('div', {
                style: { background: 'var(--ink-25, #f8fafa)', borderRadius: '10px', padding: '22px 14px', textAlign: 'center' },
            },
                h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 800 } }, '0 сум'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    'Начислений пока нет — история кэшбэка появится здесь после первых начислений.'),
            ),
            rules.length
                ? h('div', { style: { marginTop: '14px' } },
                    h('div', { style: { fontWeight: 700, fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-500)', marginBottom: '6px' } }, 'Действующие правила'),
                    ...rules.map(r => h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--ink-50)', gap: '10px', fontSize: '12.5px' } },
                        h('span', { style: { flex: 1, color: 'var(--ink-800)' } }, r.name),
                        h('span', { class: 'num', style: { fontWeight: 700, color: 'var(--primary-700)' } }, r.percent + '%'))),
                )
                : h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '12px' } },
                    'Правила кэшбэка не настроены (Настройки → Кэшбэк).'),
        ]);
    }

    // ---- Баланс счёта: the full invoice/payment ledger with running debt ----
    async function openBalanceModal() {
        let payRows = [];
        const invIds = invoices.map(i => i.id);
        if (invIds.length) {
            try {
                const { data } = await supabase.from('payments')
                    .select('invoice_id, amount, method, paid_at').in('invoice_id', invIds).limit(1000);
                payRows = data || [];
            } catch (e) { /* ledger shows invoices only */ }
        }
        const numById = new Map(invoices.map(i => [i.id, i.invoice_number || ('#' + i.id)]));
        const METHOD_RU = { cash: 'наличные', card: 'карта', transfer: 'перевод', acquiring: 'эквайринг' };

        const events = [];
        for (const inv of invoices) {
            const voided = inv.status === 'void' || inv.status === 'refunded';
            events.push({
                t: inv.created_at, kind: 'invoice', voided,
                label: trf('Счёт {no}', { no: inv.invoice_number || ('#' + inv.id) }) + (voided ? ' · ' + tr('отменён') : ''),
                amount: Number(inv.total_amount || 0),
            });
        }
        for (const pay of payRows) {
            events.push({
                t: pay.paid_at, kind: 'payment',
                label: trf('Оплата · {method}', { method: tr(METHOD_RU[pay.method] || pay.method) }) + ' · ' + (numById.get(pay.invoice_id) || ''),
                amount: Number(pay.amount || 0),
            });
        }
        events.sort((a, b) => new Date(a.t || 0) - new Date(b.t || 0));

        let totalBilled = 0, totalPaid = 0;
        const rows = [];
        let running = 0;
        for (const ev of events) {
            if (ev.kind === 'invoice') {
                if (!ev.voided) { running += ev.amount; totalBilled += ev.amount; }
            } else {
                running -= ev.amount;
                totalPaid += ev.amount;
            }
            rows.push(h('div', { class: 'row', style: { padding: '7px 0', borderBottom: '1px solid var(--ink-50)', gap: '10px', fontSize: '12.5px' } },
                h('span', { class: 'muted num', style: { flex: '0 0 118px', fontSize: '12.5px' } }, ev.t ? fmtDateTime(ev.t) : '—'),
                h('span', { style: { flex: 1, minWidth: 0, color: ev.voided ? 'var(--ink-400)' : 'var(--ink-800)', textDecoration: ev.voided ? 'line-through' : 'none' } }, ev.label),
                h('span', { class: 'num', style: { fontWeight: 700, color: ev.kind === 'payment' ? 'var(--ok-700)' : (ev.voided ? 'var(--ink-400)' : 'var(--ink-900)') } },
                    (ev.kind === 'payment' ? '−' : '+') + fmtPrice(ev.amount)),
                h('span', { class: 'num muted', style: { flex: '0 0 96px', textAlign: 'right', fontSize: '12.5px' } },
                    trf('долг {sum}', { sum: fmtPrice(Math.max(running, 0)) })),
            ));
        }
        const debt = Math.max(totalBilled - totalPaid, 0);

        const sums = h('div', { class: 'row', style: { gap: '16px', flexWrap: 'wrap', fontSize: '12.5px', marginBottom: '10px' } },
            h('span', null, 'Выставлено: ', h('b', { class: 'num' }, fmtPrice(totalBilled), ' сум')),
            h('span', null, 'Оплачено: ', h('b', { class: 'num', style: { color: 'var(--ok-700)' } }, fmtPrice(totalPaid), ' сум')),
            h('span', null, 'Долг: ', h('b', { class: 'num', style: { color: debt > 0 ? 'var(--crit-600)' : 'var(--ok-700)' } }, fmtPrice(debt), ' сум')),
        );

        // DEPOSIT_V1 — депозит живёт здесь же. «Баланс счёта» — то место, куда
        // идут за вопросом «сколько денег у этого пациента», и предоплата — часть
        // ответа: счета показывают, сколько он ДОЛЖЕН, депозит — сколько уже внёс.
        let bal = { balance: 0, rows: [] };
        try { bal = await rpcDeposits('deposit_balance', { patient_id: patient.id }); }
        catch (e) { /* модалка работает и без депозитов */ }
        const pending = (bal.rows || []).filter(d => d.status === 'pending');

        const depLine = h('div', {
            style: {
                display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                marginTop: '12px', padding: '11px 13px', borderRadius: '10px',
                background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-200, #b6e2d6)',
            },
        },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, 'Депозит (предоплата):'),
            h('b', { class: 'num', style: { fontSize: '15px', color: 'var(--primary-700)' } }, fmtPrice(bal.balance), ' сум'),
            // Заведённый, но не принятый кассой депозит — не деньги. Показываем
            // отдельно, иначе регистратура ждала бы, что баланс уже вырос.
            pending.length
                ? h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                    '· ', trf('ждёт приёма кассой: {sum} сум', { sum: fmtPrice(pending.reduce((n, d) => n + Number(d.amount || 0), 0)) }))
                : null);

        const depBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' },
            Icon('Wallet', { size: 13 }), ' Внести депозит');

        const modal = infoModal('Баланс счёта · история расчётов', 'Wallet', [
            sums,
            depLine,
            rows.length
                ? h('div', { style: { maxHeight: '52vh', overflow: 'auto' } }, ...rows)
                : h('div', { class: 'empty' }, 'Счетов и оплат пока нет.'),
        ], [depBtn]);
        depBtn.addEventListener('click', () => { modal.close(); openDepositModal(); });
    }

    // DEPOSIT_V1 — форма взноса. Регистратура вводит только СУММУ: денег она не
    // принимает, строка уходит кассе в статусе «ждёт приёма» и становится
    // балансом лишь после того, как кассир возьмёт деньги.
    //
    // DEPOSIT_METHOD_BY_CASHIER_V1 — выбора способа здесь больше НЕТ. Чем
    // пациент заплатит, знает только тот, кто принял деньги: по дороге к окошку
    // передумывают. Регистратура, называя способ заранее, лишь угадывала — а
    // касса потом сверяла ящик с этой догадкой.
    function openDepositModal() {
        const amountInp = h('input', { type: 'number', min: '0', step: '1000', placeholder: '0' });
        const noteInp = h('input', { type: 'text', placeholder: 'Комментарий (необязательно)' });
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Отправить в кассу');

        const m = infoModal('Внести депозит', 'Wallet', [
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } },
                'Деньги принимает касса — она же выбирает способ оплаты. Депозит появится в «Приём оплат» и станет балансом пациента после приёма.'),
            field('Сумма, сум', amountInp),
            field('Комментарий', noteInp),
        ], [saveBtn]);

        saveBtn.addEventListener('click', async () => {
            const amount = Math.round(Number(amountInp.value) || 0);
            if (!(amount > 0)) { toast('Введите сумму депозита.', 'fail'); amountInp.focus(); return; }
            saveBtn.disabled = true;
            saveBtn.textContent = tr('Отправляем…');
            try {
                const res = await rpcDeposits('create_deposit', {
                    patient_id: patient.id, amount, notes: noteInp.value.trim(),
                });
                const num = (res && res.deposit && res.deposit.deposit_number) || '';
                m.close();
                toast(trf('Депозит {no} на {sum} сум отправлен в кассу.', { no: num, sum: fmtPrice(amount) }), 'ok');
                reload();
            } catch (e) {
                toast(trf('Не удалось создать депозит: {msg}', { msg: (e && e.message) || e }), 'fail');
                saveBtn.disabled = false;
                saveBtn.textContent = tr('Отправить в кассу');
            }
        });
        amountInp.focus();
    }

    async function rpcDeposits(name, args) {
        const { data, error } = await supabase.rpc(name, args || {});
        if (error) throw new Error(error.message || 'RPC failed');
        return data;
    }

    // ---------------------------------------------------------------------
    // «Отметки» modal — edits notes + allergies + chronic conditions.
    // ---------------------------------------------------------------------
    function openNotesModal() {
        const p = patient;
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const notesInp = h('textarea', { rows: '3' });
        notesInp.value = p.notes || '';
        const allergiesInp = h('textarea', { rows: '2', placeholder: 'через запятую' });
        allergiesInp.value = p.allergies || '';
        const chronicInp = h('textarea', { rows: '2', placeholder: 'через запятую' });
        chronicInp.value = p.chronic_conditions || '';

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = tr('Сохраняем…');
            try {
                const { error } = await supabase.from('patients').update({
                    notes: notesInp.value.trim(),
                    allergies: allergiesInp.value.trim(),
                    chronic_conditions: chronicInp.value.trim(),
                }).eq('id', p.id).select().single();
                if (error) { toast(error.message, 'fail'); saveBtn.disabled = false; saveBtn.textContent = tr('Сохранить'); return; }
                toast('Сохранено');
                close();
                await reload();
            } catch (e) {
                toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
                saveBtn.disabled = false;
                saveBtn.textContent = tr('Сохранить');
            }
        });

        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Flag', { size: 16 }), ' Отметки и заметки'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                field('Заметка', notesInp),
                field('Аллергии', allergiesInp),
                field('Хронические состояния', chronicInp),
            ),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('span', { class: 'grow' }),
                saveBtn),
        ));
        document.body.appendChild(overlay);
        notesInp.focus();
    }

    // ---------------------------------------------------------------------
    // Edit patient modal — PATIENT_EDIT_REG_V1: компактно и в стиле формы
    // регистрации (те же нумерованные секции, русские подписи, флаг-телефон,
    // чипы пола), вместо прежней разъехавшейся англоязычной сетки.
    // ---------------------------------------------------------------------
    function openEditModal() {
        const p = patient;
        if (!p) return;

        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const lastInp   = h('input', { type: 'text', value: p.last_name || '' });
        const firstInp  = h('input', { type: 'text', value: p.first_name || '' });
        const midInp    = h('input', { type: 'text', value: p.middle_name || '' });
        const dobInp    = h('input', { type: 'date', value: (p.date_of_birth || '').slice(0, 10) });
        let genderVal   = ['male', 'female', 'other'].includes(p.gender) ? p.gender : 'other';
        const genderChips = radioChips('__edit_gender',
            [['male', 'Мужской'], ['female', 'Женский'], ['other', 'Другое']],
            () => genderVal, (v) => { genderVal = v; }, { nowrap: true });
        const bloodInp  = h('input', { type: 'text', value: p.blood_type || '', placeholder: 'напр. O(I) Rh+' });
        // Телефоны — тот же контрол с флагом/группировкой, что в регистрации.
        // PHONE_INPUT_V1 — контрол сам держит своё состояние: значение заводим
        // через .value, и обратно .value отдаёт '' пока в поле только «+998».
        const phoneWrap   = phoneInput('phone', '+998 90 961 00 04', { value: p.phone });
        const ecPhoneWrap = phoneInput('emergency_contact_phone', '+998 90 000 00 00', { value: p.emergency_contact_phone });
        const emailWrap = mailInput('email', 'name@example.com');
        const emailInp  = emailWrap.querySelector('input');
        emailInp.value = p.email || '';
        const nidInp    = h('input', { type: 'text', value: p.national_id || '', placeholder: '14 цифр', maxLength: '14' });
        const addrInp   = h('input', { type: 'text', value: p.address || '', placeholder: 'ул. Амира Темура 12, кв. 47' });
        const natInp    = h('input', { type: 'text', value: p.nationality || '' });
        const occInp    = h('input', { type: 'text', value: p.occupation || '' });
        const ecNameInp = h('input', { type: 'text', value: p.emergency_contact_name || '' });
        const allergiesInp = h('textarea', { rows: '2' });
        allergiesInp.value = p.allergies || '';   // <textarea> needs value set post-creation
        const chronicInp = h('textarea', { rows: '2' });
        chronicInp.value = p.chronic_conditions || '';

        const grid = (cols, ...kids) => h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '14px', marginBottom: '14px' } }, ...kids);
        const span = (n, node) => { node.style.gridColumn = `span ${n}`; return node; };
        const section = (num, title, desc, ...body) => h('div', { class: 'form-section' },
            h('div', { class: 'form-section-head' },
                h('span', { class: 'num-step' }, num),
                h('h4', null, title),
                h('p', null, desc)),
            ...body);

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить');
        saveBtn.addEventListener('click', save);

        async function save() {
            const last  = lastInp.value.trim();
            const first = firstInp.value.trim();
            const mid   = midInp.value.trim();
            const fullName = [last, first, mid].filter(Boolean).join(' ').trim() || p.full_name;

            const values = {
                last_name: last, first_name: first, middle_name: mid,
                full_name: fullName,
                date_of_birth: dobInp.value || null,
                gender: genderVal,
                blood_type: bloodInp.value.trim(),
                phone: phoneWrap.value.trim(),
                email: emailInp.value.trim(),
                national_id: nidInp.value.trim(),
                address: addrInp.value.trim(),
                nationality: natInp.value.trim(),
                occupation: occInp.value.trim(),
                emergency_contact_name: ecNameInp.value.trim(),
                emergency_contact_phone: ecPhoneWrap.value.trim(),
                allergies: allergiesInp.value.trim(),
                chronic_conditions: chronicInp.value.trim(),
            };

            saveBtn.disabled = true;
            const prevLabel = saveBtn.textContent;
            saveBtn.textContent = tr('Сохранение…');
            try {
                const { error } = await supabase.from('patients').update(values).eq('id', p.id).select().single();
                if (error) {
                    toast(error.message, 'fail');
                    saveBtn.disabled = false;
                    saveBtn.textContent = prevLabel;
                    return;
                }
                toast('Сохранено.', 'ok');
                close();
                await reload();
            } catch (e) {
                toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
                saveBtn.disabled = false;
                saveBtn.textContent = prevLabel;
            }
        }

        // modal-compact — MODAL_COMPACT_OPTOUT_V1: без него MODAL_FULLSCREEN_V1
        // растягивает карточку на весь экран (именно так прежняя форма и
        // разъезжалась во всю ширину).
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '760px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('User', { size: 16 }), ' Редактирование карты пациента'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body', style: { display: 'block' } },
                section('1', 'Личные данные', 'ФИО, дата рождения, пол, телефон',
                    grid(3,
                        field('Фамилия', lastInp), field('Имя', firstInp), field('Отчество', midInp),
                        field('Дата рождения', dobInp), field('Пол', genderChips), field('Группа крови', bloodInp)),
                    grid(2,
                        field('Номер телефона', phoneWrap), field('Email', emailWrap))),
                section('2', 'Контакты и документы', 'Адрес, ПИНФЛ, экстренная связь',
                    grid(3,
                        span(2, field('Адрес', addrInp)), field('ПИНФЛ', nidInp),
                        field('Национальность', natInp), field('Профессия', occInp), h('span'),
                        field('Экстренный контакт — имя', ecNameInp), span(2, field('Экстренный контакт — телефон', ecPhoneWrap)))),
                section('3', 'Медицинские отметки', 'Показываются в карте пациента',
                    grid(1,
                        field('Аллергии', allergiesInp),
                        field('Хронические заболевания', chronicInp))),
            ),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('span', { class: 'grow' }),
                saveBtn),
        ));
        document.body.appendChild(overlay);
        lastInp.focus();
    }
}
