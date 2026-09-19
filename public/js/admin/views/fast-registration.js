// FAST_REG_ONE_SCREEN_V1 (2026-09-19) — «БЫСТРАЯ РЕГИСТРАЦИЯ» ОДНИМ ОКНОМ.
// docs/plans/2026-09-19-fast-registration-one-screen.md
//
// Что было. Кнопка «Быстрая регистрация» открывала окно заведения пациента, а
// после сохранения — ВТОРОЕ окно, мастер услуг. Между ними карта успевала
// создаться, и регистратор, закрывший второе окно, оставлял пациента без
// визита: с виду он «зарегистрирован», а услуг, врача и счёта у него нет.
//
// Что стало. Одно окно и одна кнопка «Сохранить»: реквизиты пациента сверху,
// таблица услуг с врачом снизу, счёт и номера очереди — одним нажатием. Пока
// нажатие не сделано, не создано НИЧЕГО; после него есть и карта, и визит, и
// счёт. Промежуточного состояния «полпациента» больше нет.
//
// ПОЛЯ ПАЦИЕНТА ЗДЕСЬ НЕ СВОИ. Их рисует buildPatientFields (PATIENT_FIELDS_V1,
// views/patient-create-modal.js) — тот же набор, те же обязательные поля, та же
// проверка. Второй набор полей разошёлся бы с первым МОЛЧА.
//
// ЦЕПОЧКА СОХРАНЕНИЯ ТОЖЕ НЕ СВОЯ. Визит → строки → счёт → очередь ведёт
// registerWalkIn (WALK_IN_BOOKING_V1, views/walk-in-booking.js) — та же
// последовательность, что у мастера визита, без единого обращения к DOM.
//
// А ВОТ СОХРАНЕНИЕ ПАЦИЕНТА — СВОЁ, И ЭТО РЕШЕНИЕ. api.save() сборщика на
// «Открыть существующего» в диалоге дубликата ЗАКРЫВАЕТ окно и уходит в карту
// пациента: для формы заведения это правильно, а здесь это потеря уже набранной
// таблицы услуг. В этом окне «Открыть существующего» значит «записать услуги на
// НЕГО», поэтому savePatient() зовётся здесь напрямую, а диалог дубликата
// (openDuplicatePatientDialog — тот же самый) получает свои обработчики.
// Сборщик при этом НЕ ТРОНУТ: у формы заведения поведение прежнее.

import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';
import { savePatient, loadPatientById, currentUser } from '../data.js';
// PATIENT_CREATE_GATE_V1 — тот же ключ и тот же видимый отказ, что у формы
// заведения: окно, открывающееся в обход права, — это дыра, а молчащая кнопка
// читается как поломка.
import { canCreatePatient } from '../permissions.js';
import { openAccessDeniedDialog } from '../access-denied.js';
import { fadeOutAndRemove } from '../motion.js?v=mo1';   // MOTION_DIALOG_V1
import { buildPatientFields, openDuplicatePatientDialog, runPatientSearch, uploadPendingPhoto } from './patient-create-modal.js?v=fastreg1';
import { openTemplatePickerModal } from './template-picker-modal.js?v=tpl1';   // TEMPLATE_PICKER_V1
import { resolveTemplate } from './service-templates.js?v=tpl1';               // WIZ_TEMPLATES_LOCAL_V1
import { registerWalkIn } from './walk-in-booking.js?v=wib1';                  // WALK_IN_BOOKING_V1
import { doctorPoolFor } from './doctor-pool.js?v=dp1';                        // DOCTOR_POOL_V1
import { searchableSelect } from './searchable-select.js?v=ss2';               // SEARCHABLE_SELECT_V1
import { referralSourceLabel } from '../../shared/referral-label.js?v=rl1';    // REFERRAL_SOURCE_CODE_V1
import { printableSheet } from './doc-settings.js?v=noqr1';                    // WIZ_INVOICE_PRINT_V1 — тот же бланк «Счёт»

const CARD_WIDTH = 1240;   // как у формы заведения пациента (METRICS.cardWidth)

/** Разряды тысяч пробелом — так цену читают во всех экранах продукта. */
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * VAT_INCLUSIVE_V1 — цена каталога уже С НДС, поэтому «Сумма» это цена БЕЗ
 * него, а не наоборот. Та же арифметика, что в выгрузке услуг в Excel; счёт
 * от этого не меняется — столбец показывает, из чего цена сложена.
 */
function netOfVat(price, taxRate) {
    const p = Number(price) || 0;
    const t = Number(taxRate) || 0;
    if (!t) return p;
    return Math.round((p / (1 + t / 100)) * 100) / 100;
}

/** Имя пациента, как его отдают ОБА источника: savePatient (fullName) и строка базы. */
function nameOf(p) {
    if (!p) return '';
    return p.fullName
        || p.full_name
        || [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim()
        || '';
}

/**
 * FAST_REG_ONE_SCREEN_V1 — окно «Быстрая регистрация».
 * @param {{onNavigate?:Function, onSaved?:Function}} [opts]
 * @returns {{overlay, card, body, close, state, fields, collect, saveBtn, printBtn}|null}
 */
export function openFastRegistrationDialog({ onNavigate, onSaved } = {}) {
    if (!canCreatePatient()) { openAccessDeniedDialog(); return null; }

    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    const notifySaved = typeof onSaved === 'function' ? onSaved : () => {};

    const overlay = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // MODAL_COMPACT_OPTOUT_V1 — без .modal-compact admin.css растягивает карточку
    // на весь экран с !important, и ширина 1240 ниже не значит ничего.
    const card = h('div', {
        class: 'modal-card modal-grouped mg-dense modal-compact pc-form',
        'data-dialog': 'fast-registration',
        style: {
            width: CARD_WIDTH + 'px',
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 60px)',
        },
    });
    overlay.appendChild(card);
    const body = h('div', { class: 'modal-body' });

    // ── состояние окна ────────────────────────────────────────────────────
    // rows: [{ service, doctorId, sel }] — sel нужен, чтобы отказ «выберите
    // врача» ставил курсор в ТУ САМУЮ строку, а не заставлял искать её глазами.
    const state = {
        patient: null,      // выбранный/созданный пациент — второй раз не создаём
        rows: [],
        catalog: [],
        doctors: [],
        sources: [],
        result: null,       // { visit, invoice, items, queue, lines } после записи
        saving: false,
        addLine, applyTemplate, removeLine,
    };

    // ── шапка ─────────────────────────────────────────────────────────────
    const headHint = h('span', { class: 'mg-hint', style: { marginLeft: '12px' } },
        'Пациент → услуги и врач → счёт → печать');
    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Rocket', { size: 16 }), ' ', tr('Быстрая регистрация')),
        headHint,
        h('span', { class: 'grow' }),
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));
    card.appendChild(body);

    // ── строка поиска существующего пациента ──────────────────────────────
    // Своя, а не сборщика: у сборщика выбор найденного УВОДИТ в карту пациента
    // (это его работа — форма заведения там и заканчивается). Здесь выбор
    // значит «этому человеку и записываем услуги», окно остаётся открытым.
    const searchInput = h('input', {
        type: 'search', autocomplete: 'off', class: 'mg-search-input',
        placeholder: 'Поиск по ФИО, MRN, телефону или ПИНФЛ…',
    });
    const searchResults = h('div', { class: 'mg-search-results', style: { display: 'none' } });
    searchInput.addEventListener('input', () => {
        runPatientSearch(searchInput.value, searchResults, (p) => usePatient(p, { load: true }));
    });
    const searchEl = h('div', { class: 'mg-section span-full mg-search' },
        h('div', { class: 'field' },
            h('label', null, tr('Найти существующего пациента'), ' ',
                h('span', { class: 'muted', style: { fontWeight: '400' } },
                    tr('— выберите его, и услуги запишутся на эту карту'))),
            h('div', { class: 'mg-search-box' },
                h('span', { class: 'mg-search-ic' }, Icon('Search', { size: 15 })),
                searchInput, searchResults)));
    body.appendChild(searchEl);

    // Плашка выбранного пациента: пока она видна, поля заперты — карта уже есть,
    // и править её из окна регистрации значило бы тихо менять чужие данные.
    const pickedName = h('span', { class: 'cell-strong', style: { fontSize: '13.5px' } }, '');
    const changeBtn = h('button', {
        class: 'link-btn', type: 'button',
        onclick: () => { if (!state.result) usePatient(null); },
    }, tr('Сменить'));
    const pickedBar = h('div', {
        class: 'mg-section span-full',
        style: { display: 'none', flexDirection: 'row', alignItems: 'center', gap: '10px' },
    }, Icon('Patients', { size: 15 }), pickedName, h('span', { class: 'grow' }), changeBtn);
    body.appendChild(pickedBar);

    // ── блок 1: реквизиты пациента (поля сборщика) ────────────────────────
    const patientBox = h('div');
    body.appendChild(patientBox);
    const api = buildPatientFields(patientBox, {
        sections: ['personal', 'documents', 'contacts'],
        withSearchStrip: false,          // строка поиска у окна своя, см. выше
        onNavigate: navigate,
        close: () => {},                 // окно закрывает себя само
    });

    // ── блок 1а: направление и скидка ─────────────────────────────────────
    const referralSel = h('select', { name: '__referral_source' },
        h('option', { value: '' }, '— Без направления —'));
    const referralWrap = searchableSelect(referralSel, { placeholder: 'Номер или имя…' });
    const referralSection = h('div', { class: 'mg-section' },
        h('h3', { class: 'has-step' }, h('span', { class: 'mg-step' }, '4'), tr('Направление и скидка')),
        h('div', { class: 'mg-grid cols-3' },
            field('Код отправителя (лечащий врач)', referralWrap)),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
            tr('Тип скидки — это «Категория пациента» в разделе «Документы и резидентство»: процент по ней применяет сервер при выставлении счёта.')));
    body.appendChild(referralSection);

    // ── блок 2: услуги ────────────────────────────────────────────────────
    const countEl = h('span', { class: 'h-count' }, '0');
    const addServicesBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', onclick: openServicePicker,
    }, Icon('Plus', { size: 13 }), ' ', tr('+Услуги'));
    const addPackagesBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', onclick: openPackagePicker,
    }, Icon('Copy', { size: 13 }), ' ', tr('+Пакеты'));
    const printBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', disabled: true, onclick: printInvoice,
    }, Icon('Print', { size: 13 }), ' ', tr('Печать'));
    const table = h('table', { class: 'tbl' });
    const servicesCard = h('div', { class: 'card', style: { margin: '14px 22px 18px' } },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Receipt', { size: 14 }), ' ', tr('Услуги'), ' ', countEl),
            h('span', { class: 'grow' }),
            addServicesBtn, addPackagesBtn, printBtn),
        table);
    body.appendChild(servicesCard);

    // ── подвал ────────────────────────────────────────────────────────────
    const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, tr('Отмена'));
    const saveBtn = h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => { void doSave(); },
    }, Icon('Check', { size: 14 }), ' ', tr('Сохранить'));
    const openCardBtn = h('button', {
        class: 'btn btn-outline', type: 'button', style: { display: 'none' },
        onclick: async () => {
            const p = state.patient;
            if (!p || !p.id) return;
            const full = await loadPatientById(p.id).catch(() => null);
            close();
            navigate('patient-card', full || p);
        },
    }, Icon('Patients', { size: 14 }), ' ', tr('Открыть карту'));
    const doneBtn = h('button', {
        class: 'btn btn-primary', type: 'button', style: { display: 'none' }, onclick: close,
    }, Icon('Check', { size: 14 }), ' ', tr('Закрыть'));
    const footHint = h('span', { class: 'mg-hint' }, h('kbd', null, 'Enter'), ' ', tr('— сохранить и записать услуги'));
    card.appendChild(h('footer', { class: 'modal-foot' },
        footHint, h('span', { class: 'grow' }), cancelBtn, openCardBtn, saveBtn, doneBtn));

    // PATIENT_FORM_FLOW_V1 — Enter нажимает ГЛАВНОЕ действие подвала. Пропускаем
    // там, где Enter уже занят и значит другое: перенос строки в <textarea>,
    // нажатие самой кнопки/ссылки, выбор строки в открытом списке и строка
    // поиска дубликатов (сохранять оттуда значило бы заводить второго такого же
    // ровно в тот миг, когда регистратор проверяет, нет ли первого).
    card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        const t = e.target;
        const tag = ((t && t.tagName) || '').toLowerCase();
        if (tag === 'textarea' || tag === 'button' || tag === 'a') return;
        if (t && t.closest && t.closest('.mg-search')) return;
        if (typeof document !== 'undefined' && document.querySelector
            && document.querySelector('.uisel-pop, .uidate-pop')) return;
        e.preventDefault();
        if (saveBtn.disabled || state.result) return;
        saveBtn.click();
    });

    // =======================================================================
    // Таблица услуг
    // =======================================================================
    function totalGross() {
        return state.rows.reduce((a, r) => a + (Number(r.service.price) || 0), 0);
    }

    function doctorCell(row) {
        const pool = doctorPoolFor(state.doctors, row.service);
        if (!pool.length && !row.service.requires_doctor) return h('td', { class: 'muted' }, '—');
        const sel = h('select', { style: { width: '100%' } },
            h('option', { value: '' }, '— выберите врача —'),
            ...pool.map((d) => h('option', { value: String(d.id) }, d.full_name || d.username || String(d.id))));
        sel.value = row.doctorId == null ? '' : String(row.doctorId);
        sel.addEventListener('change', () => { row.doctorId = sel.value ? Number(sel.value) : null; });
        if (state.result) sel.disabled = true;
        row.sel = sel;
        return h('td', null, sel);
    }

    function queueLabel(i) {
        const line = state.result && state.result.lines && state.result.lines[i];
        const ticket = line && state.result.queue && state.result.queue.get(line.visitServiceId);
        if (!ticket) return '—';
        return ticket.label || (ticket.number != null ? String(ticket.number) : '—');
    }

    function paintTable() {
        clear(table);
        const done = !!state.result;
        const cols = 6;   // № · Наименование · Сумма · С НДС · Врач · (№ очереди | Уд.)
        table.appendChild(h('thead', null, h('tr', null,
            h('th', { style: { width: '46px' } }, '№'),
            h('th', null, tr('Наименование')),
            h('th', { style: { width: '130px' } }, tr('Сумма')),
            h('th', { style: { width: '130px' } }, tr('С НДС')),
            h('th', { style: { width: '270px' } }, tr('Врач')),
            done ? h('th', { style: { width: '120px' } }, tr('№ очереди'))
                 : h('th', { style: { width: '56px' } }, tr('Уд.')))));

        const tbody = h('tbody');
        if (!state.rows.length) {
            tbody.appendChild(h('tr', null, h('td', { colspan: String(cols), class: 'muted', style: { padding: '18px 14px', textAlign: 'center', fontSize: '12.5px' } },
                tr('Добавьте услуги кнопкой «+Услуги» или пакетом'))));
        }
        state.rows.forEach((row, i) => {
            tbody.appendChild(h('tr', null,
                h('td', { class: 'muted' }, String(i + 1)),
                h('td', { class: 'cell-strong' }, row.service.name || '—'),
                h('td', null, fmtPrice(netOfVat(row.service.price, row.service.tax_rate))),
                h('td', { class: 'cell-strong' }, fmtPrice(row.service.price)),
                doctorCell(row),
                done
                    ? h('td', { class: 'cell-strong' }, queueLabel(i))
                    : h('td', null, h('button', {
                        class: 'icon-btn btn-sm', type: 'button',
                        title: 'Убрать услугу', 'aria-label': 'Убрать услугу',
                        onclick: () => removeLine(i),
                    }, Icon('Trash', { size: 13 })))));
        });
        table.appendChild(tbody);

        table.appendChild(h('tfoot', null, h('tr', null,
            h('td', { colspan: '3', class: 'cell-strong', style: { textAlign: 'right' } }, tr('Итого')),
            h('td', { class: 'cell-strong' }, fmtPrice(totalGross())),
            h('td', null, ''),
            h('td', null, ''))));

        countEl.textContent = String(state.rows.length);
    }

    function addLine(service, doctor) {
        if (!service || service.id == null) return null;
        const row = {
            service,
            doctorId: doctor && doctor.id != null ? Number(doctor.id) : null,
            sel: null,
        };
        state.rows.push(row);
        paintTable();
        return row;
    }

    function removeLine(i) {
        state.rows.splice(i, 1);
        paintTable();
    }

    function applyTemplate(template) {
        const { services, missing } = resolveTemplate(template, state.catalog);
        for (const s of services) addLine(s, null);
        if (missing) toast(trf('Пакет: {n} услуг(и) не найдено в каталоге', { n: missing }), 'warn');
        return services.length;
    }

    // «+Услуги» — тот же каталог, что у мастера визита, в режиме подбора: он
    // зовёт onPick по одному разу на выбранную услугу, а строку рисуем мы.
    // Импорт динамический: каталог тянет полмодуля продукта, и грузить его при
    // каждом открытии окна регистрации незачем (и кольца импортов не завести).
    async function openServicePicker() {
        if (state.result) return;
        try {
            const mod = await import('./service-picker-modal.js?v=fastreg1');
            mod.openServicePickerModal({
                title: 'Добавить услуги',
                confirmLabel: 'Готово',
                onPick: (p) => { if (p && p.service) addLine(p.service, p.doctor || null); },
            });
        } catch (e) {
            toast(trf('Не удалось открыть каталог услуг: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    }

    function openPackagePicker() {
        if (state.result) return;
        openTemplatePickerModal({ onPick: (t) => applyTemplate(t) });
    }

    // =======================================================================
    // Пациент
    // =======================================================================
    /** Взять готовую карту (найденную поиском, созданную или выбранную в дубликатах). */
    async function usePatient(p, { load = false } = {}) {
        if (!p) {
            state.patient = null;
            pickedBar.style.display = 'none';
            setPatientFormEnabled(true);
            return null;
        }
        const full = load ? await loadPatientById(p.id).catch(() => null) : null;
        const chosen = full || p;
        state.patient = chosen;
        pickedName.textContent = trf('Пациент № {mrn} · {name}', {
            mrn: chosen.mrn || '—', name: nameOf(chosen) || '—',
        });
        pickedBar.style.display = '';
        searchResults.style.display = 'none';
        setPatientFormEnabled(false);
        return chosen;
    }

    function setPatientFormEnabled(on) {
        const walk = (node) => {
            for (const c of (node.children || [])) {
                const tag = String(c.tagName || '').toUpperCase();
                if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
                    c.disabled = !on;
                    if (on) { if (c.removeAttribute) c.removeAttribute('disabled'); }
                    else if (c.setAttribute) c.setAttribute('disabled', '');
                }
                walk(c);
            }
        };
        walk(patientBox);
        patientBox.style.opacity = on ? '' : '0.55';
    }

    // =======================================================================
    // Сохранение
    // =======================================================================
    /** Врач у услуги, которая его требует, — проверка ДО первой записи в базу. */
    function checkDoctors() {
        for (const row of state.rows) {
            if (row.service.requires_doctor && !row.doctorId) {
                toast(trf('Укажите врача для услуги «{name}»', { name: row.service.name || '' }), 'fail');
                try { if (row.sel && row.sel.focus) row.sel.focus(); } catch (e) { /* нет фокуса — не беда */ }
                return false;
            }
        }
        return true;
    }

    async function doSave() {
        if (state.saving || state.result) return null;
        if (!checkDoctors()) return null;
        state.saving = true;
        saveBtn.disabled = true;
        try {
            if (!state.patient) {
                const payload = api.collect();
                if (!payload) return null;
                // PATIENT_PHOTO_V1 — снимок кладётся в хранилище ДО вставки
                // карты, ровно как в форме заведения: иначе фото, снятое с
                // веб-камеры прямо здесь, молча не доехало бы до карты.
                const photoUrl = await uploadPendingPhoto(api.state);
                if (photoUrl) payload.photo_url = photoUrl;
                const created = await createPatient(payload, false);
                // null значит либо отказ с тостом, либо открытый диалог
                // дубликата — он продолжит сохранение сам, своим doSave().
                if (!created) return null;
                await usePatient(created);
            }
            return await bookServices();
        } finally {
            state.saving = false;
            saveBtn.disabled = !!state.result;
        }
    }

    /**
     * Создание карты и диалог дубликата СВОИМИ обработчиками (см. шапку файла):
     * «Открыть существующего» здесь значит «записать услуги на него», а не уход
     * в карту. Продолжение цепочки — повторный doSave(): пациент уже в
     * состоянии окна, поэтому второй карты не появится.
     */
    async function createPatient(payload, force) {
        try {
            return await savePatient(payload, { force });
        } catch (e) {
            if (!force && e && e.code === 'DUPLICATE_PATIENT' && e.existing) {
                openDuplicatePatientDialog(e, {
                    onOpenExisting: async (c) => { await usePatient(c, { load: true }); await doSave(); },
                    onForceCreate: async () => {
                        const created = await createPatient(payload, true);
                        if (!created) return;
                        await usePatient(created);
                        await doSave();
                    },
                });
                return null;
            }
            toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
            return null;
        }
    }

    /** Пустая таблица — это обычное заведение карты: сохранили и закрылись. */
    async function bookServices() {
        const patient = state.patient;
        if (!patient) return null;
        if (!state.rows.length) {
            toast('Пациент сохранён.');
            notifySaved(patient);
            close();
            return patient;
        }
        let res;
        try {
            res = await registerWalkIn({
                patientId: patient.id,
                lines: state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId })),
                referralSourceId: referralSel.value || null,
                createdBy: (currentUser() || {}).id || null,
            });
        } catch (e) {
            // Карта уже существует (state.patient), поэтому повтор нажатия не
            // заведёт второго пациента — он продолжит с того же места.
            toast(trf('Услуги не записаны: {msg}', { msg: (e && e.message) || e }), 'fail');
            return null;
        }
        state.result = res;
        if (res.quoteError) toast(trf('Тариф визита не спрошен: {msg}', { msg: res.quoteError }), 'warn');
        if (res.queueError) toast(trf('Номера очереди не выданы: {msg}', { msg: res.queueError }), 'warn');
        notifySaved(patient);
        toSavedState();
        return res;
    }

    function toSavedState() {
        const inv = (state.result && state.result.invoice) || null;
        const p = state.patient || {};
        headHint.textContent = [
            trf('Пациент № {mrn} · {name}', { mrn: p.mrn || '—', name: nameOf(p) || '—' }),
            trf('Счёт № {no}', { no: (inv && (inv.invoice_number || inv.id)) || '—' }),
        ].join(' · ');
        setPatientFormEnabled(false);
        searchInput.disabled = true;
        referralSel.disabled = true;
        changeBtn.style.display = 'none';
        addServicesBtn.style.display = 'none';
        addPackagesBtn.style.display = 'none';
        printBtn.disabled = false;
        if (printBtn.removeAttribute) printBtn.removeAttribute('disabled');
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        openCardBtn.style.display = '';
        doneBtn.style.display = '';
        footHint.textContent = tr('Пациент, визит и счёт созданы. Печать счёта — кнопкой в шапке таблицы.');
        paintTable();
        toast('Пациент зарегистрирован, счёт выставлен.');
    }

    function printInvoice() {
        const inv = state.result && state.result.invoice;
        if (!inv) return;
        const p = state.patient || {};
        const queueRows = state.rows.map((row, i) => ({
            service: row.service.name || '', label: queueLabel(i), number: '', key: '',
        }));
        const total = state.rows.reduce((a, r) => a + (Number(r.service.price) || 0), 0);
        /* i18n-exempt-start: печатный счёт — бланк документа, намеренно русский (как в мастере визита) */
        printableSheet({ type: 'invoice', idLine: inv.invoice_number || String(inv.id), data: {
            title: 'Амбулаторные услуги',
            docNo: inv.invoice_number || String(inv.id),
            issueDate: 'Дата ' + new Date().toLocaleDateString('ru-RU'),
            status: 'UNPAID',
            patient: [
                ['ФИО', nameOf(p) || '—'],
                ['Карта №', p.mrn || '—'],
                ['Телефон', p.phone || '—'],
            ],
            billing: [
                ['Дата', new Date().toLocaleDateString('ru-RU')],
                ['Оплата', 'Пациент — оплата в кассе'],
            ],
            items: state.rows.map((row, i) => ({
                name: row.service.name || '', qty: 1, price: Number(row.service.price) || 0, _alt: i % 2 === 1,
            })),
            queue: queueRows,
            subtotal: total,
            total: Number(inv.total_amount) || total,
            paid: 0,
        } });
        /* i18n-exempt-end */
    }

    // =======================================================================
    // Справочники
    // =======================================================================
    (async () => {
        try {
            const [svcRes, docRes, srcRes] = await Promise.all([
                supabase.from('services').select('id, name, price, tax_rate, requires_doctor, type, active').eq('active', true).order('name').limit(1000),
                // EASYMED_DOCTOR_DETECTION — список врачей проверяет is_doctor, а
                // не role: у администратора-врача роли 'doctor' нет вовсе.
                supabase.from('users').select('id, full_name, service_rates').eq('is_doctor', true).eq('active', true).order('full_name'),
                supabase.from('referral_sources').select('id, name, code, category_id, doctor_id, active').eq('active', true).order('code'),
            ]);
            state.catalog = (svcRes && svcRes.data) || [];
            state.doctors = (docRes && docRes.data) || [];
            state.sources = (srcRes && srcRes.data) || [];
            for (const s of state.sources) {
                referralSel.appendChild(h('option', { value: String(s.id) }, referralSourceLabel(s)));
            }
            paintTable();
        } catch (e) {
            toast(trf('Не удалось загрузить справочники: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    })();

    paintTable();
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => { try { api.fields.last_name.focus(); } catch (e) { /* нет фокуса — не беда */ } }, 30);

    return {
        overlay, card, body, close, state,
        fields: api.fields, collect: api.collect, setGender: api.setGender,
        table, saveBtn, printBtn, addServicesBtn, addPackagesBtn, referralSel, searchInput,
    };
}
