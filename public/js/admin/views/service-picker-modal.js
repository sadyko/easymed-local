// Service picker modal — three cascading columns (Type → Service → Doctor)
// layered above another modal. Used by:
//   * the visit modal's Services tab "Add service" button,
//   * the service-workspace "Refer to …" buttons (Types locked — only
//     Services + Doctors visible),
//   * the patient card "Create visit" flow.
// Calls onPick({ service, doctor }) on confirm.
//
// Behaviour:
//   • Services and Doctors are searchable independently — the user does NOT
//     have to pick a Type first. Typing in the Service search reveals every
//     matching service across all types; typing in the Doctor search reveals
//     every matching doctor.
//   • When a service is picked we auto-select its service_type so the Types
//     column reflects the implied filter.
//
// Options:
//   visitDoctorId    – pre-select this doctor.
//   onPick           – callback.
//   title            – modal heading.
//   titleIcon        – icon name shown next to the heading.
//   confirmLabel     – text of the confirm button.
//   confirmIcon      – icon shown on the confirm button.
//   lockedTypeNames  – array of substrings (case-insensitive). On load, the
//                      first service_type whose name contains any of them is
//                      auto-selected and the Types column is hidden. If
//                      nothing matches the column stays visible as fallback.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Avatar, initials, avColor } from '../ui.js';
import { loadPatientsPaged, savePatient, loadPatientById, insertRow, currentUser } from '../data.js';
import { logPatientActivity } from './activity-log.js';   // BOOK_WIZARD_V1
import { gw } from '../gateway.js';
import { clinicFlags } from '../clinic-flags.js';   // CUSTOM_CLINIC_V1
import { loadClinicHours, clinicRangeForDay } from '../clinic-hours.js?v=ch1';   // WORKING_HOURS_CLINIC_BOUND_V1
import { printableSheet } from './doc-settings.js?v=q3company1';   // insurance/B2B: print statistics act
import { tr, trf } from '../i18n.js';   // WIZ_TEMPLATES_V1 + I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { phoneInput } from '../phone-input.js?v=ph1';
import { resolveTypeId } from './service-group.js?v=aug17e';   // SERVICE_GROUPS_V1 — group filtering must survive a NULL type_id

export function openServicePickerModal({
    visitDoctorId   = null,
    onPick,
    title           = 'Добавить услугу к визиту',
    titleIcon       = 'Plus',
    confirmLabel    = 'Готово',
    confirmIcon     = 'Check',
    lockedTypeNames = null,
    // When true, a per-doctor schedule calendar appears under the columns once
    // a doctor is picked. It auto-selects the nearest free slot and returns the
    // chosen day/time on onPick. Off for flows that don't book a time (e.g. the
    // service-workspace "Refer to …" buttons).
    showSchedule    = false,
    // Optional — lets the schedule skip the patient's own existing same-day
    // visit when deciding which slots are busy.
    patientId       = null,
    // Optional — start hunting for the nearest free slot from this day instead
    // of today (e.g. the visit's own day). Never goes earlier than today.
    initialDateIso  = null,
    // Optional — services already attached to the visit before the picker
    // opened. They render disabled (with an "Already on visit" tag) so a
    // registrar can't add the same service twice.
    excludeServiceIds = [],
    // Optional — called when the user clicks the × on a row in the "Selected
    // for booking" panel to undo a just-added service. Receives the same
    // payload onPick got. The caller is responsible for removing it from the
    // underlying record (e.g. the visit_services row) and refreshing.
    onUndo          = null,
    // NEW (calculator mode only — internal). When true the picker is a
    // no-patient price quote: it never fires onPick; the cart can be
    // attached to a patient and handed to the Create Visit modal.
    calculator      = false,
    // NEW (calculator mode only). Called by the AttachPatient modal's
    // «Создать пациента» action — typically navigates to registration.
    onCreatePatient = null,
    // NEW — book into a specific room (room-calendar handoff). Threaded to the
    // create-visit modal so the booked visit gets visits.room_id.
    roomId          = null,
    // NEW (ROOMCAL_BLOCKS_V1) — pre-fill the new visit time from an empty-lane click.
    scheduledISO    = null,
    // BOOK_WIZARD_V1 — called after the wizard successfully creates the visit
    // (and invoice, for patient-pays). Lets the room-calendar refresh its grid.
    onBooked        = null,
    // CATALOG_WIZARD_V1 — pre-attached patient (entry: patient card / registration).
    patient         = null,
    // CATALOG_WIZARD_V1 — locked performer (entry: calendar doctor column click);
    // {id, name, spec}. Catalog filters to this doctor's services; time = scheduledISO.
    lockedDoctor    = null,
    // ATTACH_CATALOG_V1 — «Добавить услугу» from an EXISTING visit. Renders the
    // same catalog + смета UI as the booking wizard instead of the 3-column
    // cascade, but creates NO visit: the смета CTA fires onPick once per cart row
    // so the caller appends them to the visit it already has. Requires `patient`
    // (the visit's patient); no attach-patient step and no payment block — money
    // stays with the visit's own invoice flow.
    attachMode      = false,
} = {}) {
    // Catalog UI is shared by the booking wizard and attach mode.
    const catalogUI = calculator || attachMode;
    const overlay = h('div', { class: 'modal', style: { zIndex: '130' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => {
        if (catalogUI && state.added.length && !confirm(attachMode ? 'Закрыть? Выбранные услуги не будут добавлены.' : 'Закрыть мастер записи? Подбор услуг будет потерян.')) return;
        overlay.remove();
    } }));

    const state = {
        typeId:     null,
        serviceId:  null,
        doctorId:   visitDoctorId || null,
        typeSearch: '',
        svcSearch:  '',
        docSearch:  '',
        types:      [],
        services:   [],
        doctors:    [],
        svcGroupMap: {},    // core_service_id -> group_id (when useGroups)
        useGroups:  false,  // column 1 = medcore groups
        deriveType: false,  // column 1 = distinct service.type fallback
        consultationTypes: [],  // clinic consultation_types (bookable as pseudo-services)
        docConsult:        {},  // "doctorId|typeId" -> {price, available, is_free}
        // Set to true after we've found a matching type and hidden the column.
        typeLocked: false,
        // ---- Schedule (only used when showSchedule) ----
        schedDateIso:    null,   // YYYY-MM-DD of the chosen slot
        schedStartMin:   null,   // minutes-from-midnight of the chosen slot
        schedManual:     false,  // user clicked a slot → stop auto-overriding
        schedVisits:     {},     // dateIso -> [{startMin,endMin,label}]
        schedLoadingFor: null,   // doctor id currently loading, guards races
        // Running list of services already added in THIS picker session (via
        // "Add & pick another"). Displayed at the top of the modal so the
        // registrar can see what's already been stacked onto the visit.
        added:           [],
    };

    // CONSULT_BOOKING_V1 (picker) — consultations are bookable as pseudo-service rows.
    const CONSULT_GROUP_ID = '__consult__';
    const consultName = (ct) => (ct && (ct.name_ru || ct.name_uz || ct.name_en)) || '—';
    function consultPriceFor(doctorId, ct) {
        // CONSULT_PER_DOCTOR_V1 — the doctor's own price (0 if free / unset). No clinic default.
        const dc = state.docConsult[doctorId + '|' + ct.id];
        if (!dc || dc.is_free) return 0;
        return dc.price != null ? Number(dc.price) : 0;
    }
    function consultAvailableFor(doctorId, typeId) {
        // CONSULT_PER_DOCTOR_V1 — a type the doctor hasn't configured is not offered.
        const dc = state.docConsult[doctorId + '|' + typeId];
        return !!dc && dc.available !== false;
    }
    // CONSULT_PRICE_RANGE_V1 — a consultation's price varies per doctor. Range across doctors who
    // offer it (non-zero), so the catalog can show «от {min}» instead of the misleading default 0.
    function consultPriceRange(ct) {
        const vals = [];
        for (const d of state.doctors) {
            if (!consultAvailableFor(d.id, ct.id)) continue;
            const p = consultPriceFor(d.id, ct);
            if (p > 0) vals.push(p);
        }
        if (!vals.length) return null;
        return { min: Math.min(...vals), max: Math.max(...vals) };
    }
    // CONSULT_NAME_OVERRIDE_V1 — a doctor's per-type name override (doctor_consultation_prices.name_*),
    // falling back to the clinic-wide consultation type name.
    function consultNameFor(doctorId, ct) {
        const dc = state.docConsult[doctorId + '|' + ct.id];
        if (dc && (dc.name_ru || dc.name_uz || dc.name_en)) return dc.name_ru || dc.name_uz || dc.name_en;
        return consultName(ct);
    }

    const refs = { columns: [null, null, null], schedule: null, addedEl: null, calcBarEl: null, attachedPatient: null };

    // BOOK_WIZARD_V1 — wizard state (calculator mode only). Step 1 = the existing
    // columns+cart screen; steps 2/3 swap the body content. payment.mode 'patient'
    // generates an invoice at confirm; insurance/corporate/state just save the visit.
    const wiz = {
        step: 1,
        payment: { mode: 'patient', discountPct: null, coverage: 'insurance', payerId: null, policyId: null, policyNumber: '', useBal: true },   // WIZ_POLICY_MANUAL_V1
        payers: null, policies: null, depositBalance: null, _prefilled: false,
        applied: [],   // CATALOG_WIZARD_V3 — applied promo/gift/cert rows
        coverage: {},  // COVER_SPLIT_V1 — per service-index: 'payer' | 'patient'
        _covMode: null,
        referral: { cats: null, sources: null, globalCat: '', globalSrc: '', per: {} },   // SVC_REFERRAL_V1
    };
    if (catalogUI && patient) refs.attachedPatient = patient;   // CATALOG_WIZARD_V1 + ATTACH_CATALOG_V1
    // ATTACH_CATALOG_V1 — the payer question was settled on the visit already.
    if (attachMode) wiz.payment.mode = 'patient';

    // WIZ_FULLSCREEN_V1 — full-screen wizard so registrars get the whole screen.
    const card = h('div', { class: 'modal-card', style: { width: 'calc(100vw - 24px)', maxWidth: 'calc(100vw - 24px)', height: 'calc(100vh - 24px)', maxHeight: 'calc(100vh - 24px)', display: 'flex', flexDirection: 'column' } });
    overlay.appendChild(card);

    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon(titleIcon, { size: 16 }), ' ', title),
        h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×'),
    ));
    // BOOK_WIZARD_V1 — step chips (calculator mode only)
    const wizChipsEl = h('div', { class: 'pkw-steps', style: calculator ? {} : { display: 'none' } });
    card.appendChild(wizChipsEl);

    // WIZ_FULLSCREEN_V1 — minHeight 0 (not 560px): the card is fixed-height now,
    // so a hard min forced the flex children past the card on short screens —
    // the footer rendered over the rail buttons ("buttons on top of each other").
    const body = h('div', { style: { padding: '16px 22px', flex: 1, overflow: 'auto', minHeight: 0 } });
    card.appendChild(body);

    const summary = h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)' } }, 'Search a service or doctor to begin');

    // Build the payload for the current selection (service + doctor + optional
    // schedule). Returns null when no service is picked.
    function buildPayload() {
        const svc = state.services.find(s => s.id === state.serviceId);
        const doc = state.doctors.find(d => d.id === state.doctorId);
        if (!svc) return null;
        const payload = { service: (svc.__consult && doc) ? { ...svc, price: consultPriceFor(doc.id, svc.__ct) } : svc, doctor: doc || null };
        if (showSchedule && state.schedDateIso && state.schedStartMin != null) {
            const time = fmtMin(state.schedStartMin);
            payload.dateIso         = state.schedDateIso;
            payload.time            = time;
            payload.startISO        = new Date(`${state.schedDateIso}T${time}:00`).toISOString();
            payload.durationMinutes = serviceDurationMin();
        }
        return payload;
    }

    // "Add" — stages the current selection in the running list at the top of
    // the picker. Fires onPick so the caller can mirror the add into its own
    // state (e.g. the Create Visit dialog accumulates them into an array;
    // the Edit Visit modal inserts a visit_services row immediately).
    // Clears the per-service form so the registrar can stack the next one.
    // Keeps the doctor + type filter so consecutive picks stay in context.
    const addAnotherBtn = h('button', { class: 'btn btn-outline', disabled: '',
        title: 'Добавить услугу в список и выбрать ещё одну',
        onclick: () => {
            const payload = buildPayload();
            if (!payload) { toast('Pick a service.', 'fail'); return; }
            if (!calculator) onPick(payload);
            state.added.push(payload);
            state.serviceId     = null;
            state.svcSearch     = '';
            state.schedDateIso  = null;
            state.schedStartMin = null;
            state.schedManual   = false;
            updateColumn(1);
            if (showSchedule) renderSchedule();
            renderAdded();
            updateSummary();
            toast(trf('В списке: {name}', { name: payload.service.name }));
        },
    }, Icon('Plus', { size: 14 }), ' В список');

    // "Done" — commits the picker. If a service is selected but not yet added,
    // it's added implicitly so the registrar can do "pick one and close" in
    // a single click. Then closes the picker.
    //
    // If neither a current selection nor any staged items exist, this is
    // effectively the same as Cancel — but we toast a hint instead of just
    // closing silently so the registrar knows nothing was attached.
    const confirmBtn = h('button', { class: 'btn btn-primary', disabled: '',
        onclick: () => {
            const payload = buildPayload();
            if (payload) {
                if (!calculator) onPick(payload);
                state.added.push(payload);
            } else if (state.added.length === 0) {
                toast('Pick a service first.', 'fail');
                return;
            }
            overlay.remove();
        },
    }, Icon(confirmIcon, { size: 14 }), ' ' + confirmLabel);

    // BOOK_WIZARD_V1 — wizard footer controls (calculator only; display toggled by paintWizFooter)
    const wizBackBtn = h('button', { class: 'btn', style: { display: 'none' }, type: 'button',
        onclick: () => wizGoto(wiz.step - 1) }, '← Назад');
    const wizNextBtn = h('button', { class: 'btn btn-primary', style: { display: 'none' }, type: 'button',
        onclick: () => wizGoto(wiz.step + 1) }, 'Далее →');   // WIZ_4STEPS_V1 — payer validated on step-1 CTA now
    const wizCreateLabel = h('span', null, ' Создать визит');
    const wizCreateBtn = h('button', { class: 'btn btn-primary', style: { display: 'none' }, type: 'button',
        onclick: (ev) => wizSave(ev.currentTarget) }, Icon('Check', { size: 14 }), wizCreateLabel);

    card.appendChild(h('footer', { class: 'modal-foot' },
        summary,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Отмена'),
        wizBackBtn,
        addAnotherBtn,
        confirmBtn,
        wizNextBtn,
        wizCreateBtn,
    ));
    // Calculator mode: the «Оформить визит» action in the right-panel calc
    // bar replaces Done — hide the footer confirm so there are no two CTAs.
    if (catalogUI) confirmBtn.style.display = 'none';
    if (attachMode) { addAnotherBtn.style.display = 'none'; summary.style.display = 'none'; }

    // Load + render
    (async () => {
        const [types, services, doctors] = await Promise.all([
            safeSelect('service_types', b => b.eq('active', true).order('name')),
            safeSelect('services',      b => (window.CLINIC?.id ? b.eq('company_id', window.CLINIC.id) : b).eq('active', true).order('name')),       // TENANT_BOOKING_SCOPE_V1 — this clinic's services only (super-admin must not see other clinics')
            safeSelect('users',         b => (window.CLINIC?.id ? b.eq('company_id', window.CLINIC.id) : b).eq('active', true).order('full_name')),   // TENANT_BOOKING_SCOPE_V1 — this clinic's doctors only
        ]);
        await loadClinicHours();   // WORKING_HOURS_CLINIC_BOUND_V1
        state.types    = types || [];
        state.services = services || [];
        state.doctors  = (doctors || []).filter(u =>
            u.is_doctor === true || (u.role || '').toLowerCase() === 'doctor' || (u.specialty || '').length > 0   // ADMIN_DOCTOR_LIST_V1
        );
        if (state.doctors.length === 0) state.doctors = doctors || [];
        // SERVICE_NURSE_PROVIDER_V1 — performer pool incl. nurses (assigned via service_rates);
        // the cabinet fallback still uses state.doctors (doctors only).
        state.providers = doctors || [];   // SERVICE_PROVIDER_TOGGLE_V1 - any assigned staff via service_rates

        // PICKER_GROUPS: the local service_types table is often empty; services carry
        // core_service_id, so column 1 lists the medcore GROUPS those services fall under
        // (same source as the booking wizard). Fail-soft to the service_types list, then to
        // distinct service.type, so the column is never empty when services exist.
        try {
            // CUSTOM_CLINIC_V1 — custom clinics keep column 1 = local service_types
            const _cflags = await clinicFlags();
            const _ids = state.services.map(s => s.core_service_id).filter(Boolean);
            if (_ids.length && !_cflags.custom_services_enabled) {
                const _r = await gw('/catalog/groups-for-services?ids=' + encodeURIComponent(_ids.join(',')));
                const _groups = (_r && _r.groups) || [];
                if (_groups.length) {
                    state.types = _groups.map(g => ({ id: g.id, name: g.name_ru || g.name_uz || g.slug }));
                    state.svcGroupMap = (_r && _r.map) || {};
                    state.useGroups = true;
                }
            }
        } catch (e) { console.warn('[picker] groups', e.message); }
        // CUSTOM_CLINIC_V3 — RLS hides service_types from the browser; when we're
        // not on medcore groups and the local read came back empty, load the
        // shared type list via the gateway so column 1 is never blank.
        if (!state.useGroups && state.types.length === 0) {
            try {
                const _lk = await gw('/lookups/catalog');
                state.types = (_lk && _lk.service_types) || [];
            } catch (e) { console.warn('[picker] catalog lookup', e.message); }
        }
        if (!state.useGroups && state.types.length === 0) {
            const seen = new Map();
            for (const s of state.services) { const t = (s.type || '').trim(); if (t && !seen.has(t)) seen.set(t, { id: t, name: t }); }
            state.types = [...seen.values()];
            state.deriveType = state.types.length > 0;
        }

        // PICKER_CONSULTS: the clinic's consultation types become bookable pseudo-services
        // under a «Консультации» group (per-doctor pricing via doctor_consultation_prices).
        // RLS scopes both to the clinic; fail-soft so a missing migration never blocks services.
        try {
            const [_ct, _dc] = await Promise.all([
                supabase.from('consultation_types').select('id, name_ru, name_uz, name_en, default_price, duration_minutes, sort_order, active').eq('active', true).order('sort_order', { ascending: true }),
                supabase.from('doctor_consultation_prices').select('doctor_id, consultation_type_id, price, available, is_free, name_ru, name_uz, name_en'),
            ]);
            state.consultationTypes = (_ct && !_ct.error) ? (_ct.data || []) : [];
            for (const rr of ((_dc && !_dc.error) ? (_dc.data || []) : [])) {
                state.docConsult[rr.doctor_id + '|' + rr.consultation_type_id] = { price: rr.price, available: rr.available, is_free: rr.is_free, name_ru: rr.name_ru, name_uz: rr.name_uz, name_en: rr.name_en };
            }
            // CONSULT_PER_DOCTOR_ROWS_V1 — one bookable row PER DOCTOR×consultation (the name + price
            // the doctor set in #consultation-types), not one aggregate clinic-type row. The doctor is
            // bound to the row (__consultDoctorId) so picking it books that doctor at that price.
            const _ctById = {}; for (const _c of state.consultationTypes) _ctById[String(_c.id)] = _c;
            const _docById = {}; for (const _d of state.doctors) _docById[String(_d.id)] = _d;
            const consultRows = [];
            for (const _k in state.docConsult) {
                const _dc2 = state.docConsult[_k]; if (!_dc2 || _dc2.available === false) continue;
                const _bar = _k.indexOf('|'); const _did = _k.slice(0, _bar), _tid = _k.slice(_bar + 1);
                const _ct2 = _ctById[_tid], _doc = _docById[_did];
                if (!_ct2 || !_doc) continue;
                consultRows.push({
                    id: 'c|' + _did + '|' + _tid,
                    name: consultNameFor(_did, _ct2),
                    price: _dc2.is_free ? 0 : (_dc2.price != null ? Number(_dc2.price) : 0),
                    duration_minutes: _ct2.duration_minutes || 30,
                    __consult: true, consultation_type_id: _ct2.id, __ct: _ct2, core_service_id: null,
                    __consultDoctorId: _did, __consultDocName: _doc.full_name || _doc.name || '',
                });
            }
            consultRows.sort((_a, _b) => (_a.name || '').localeCompare(_b.name || '', 'ru'));
            if (consultRows.length) {
                state.types = [...state.types, { id: CONSULT_GROUP_ID, name: 'Консультации' }];
                state.services = [...state.services, ...consultRows];
            }
        } catch (e) { console.warn('[picker] consultations', e.message); }

        // Auto-pick the locked type, if any. We hide the Types column only
        // when we actually found a match — otherwise the user has to pick
        // manually and we leave the column visible as a fallback.
        if (Array.isArray(lockedTypeNames) && lockedTypeNames.length) {
            const needles = lockedTypeNames.map(s => String(s).toLowerCase());
            const match = state.types.find(t => {
                const n = (t.name || '').toLowerCase();
                return needles.some(needle => n.includes(needle));
            });
            if (match) { state.typeId = match.id; state.typeLocked = true; }
            else toast('Группа услуг не найдена — выберите вручную.', 'fail');
        }

        if (catalogUI) mountCatalog(); else mountColumns();   // CATALOG_WIZARD_V1 + ATTACH_CATALOG_V1
        // Pre-selected doctor (e.g. the visit's doctor) — load their schedule
        // and auto-pick the nearest free slot straight away.
        // Columns view only: onDoctorChanged() drives the columns-mode schedule
        // strip, which does not exist in the catalog view (each cart row owns
        // its own doctor/time picker).
        if (!catalogUI && showSchedule && state.doctorId) onDoctorChanged();
        if (catalogUI) await prefillFromCrm();   // CRM_SCHEDULE_V1
    })();

    // CRM_SCHEDULE_V1 — the call centre's half of the booking, handed to the
    // registrar on the day.
    //
    // The call centre records «интересующая услуга» + «дата записи» on a
    // crm_requests row and stops there (it does not register, price or invoice).
    // When the registrar opens «Добавить услуги к визиту» for that patient ON
    // THAT DATE, the service is already in the смета — they confirm and raise the
    // invoice. On any other date nothing is prefilled and the picker behaves
    // exactly as before, which is the whole point of matching on the date: a
    // request booked for Friday must not attach itself to a Tuesday walk-in.
    async function prefillFromCrm() {
        const pid = patientId || (refs.attachedPatient && refs.attachedPatient.id) || null;
        const dayIso = String(initialDateIso || '').slice(0, 10);
        if (!pid || !dayIso) return;
        try {
            // CRM_MULTI_SERVICE_V1 — the services live on crm_request_services,
            // one row per service with its OWN date, so a request covering three
            // things on three days surfaces each on its own day. Two steps because
            // the filter is on the PARENT (patient) and the CHILD (date), and the
            // query compiler filters the base table only.
            const { data: reqs, error: reqErr } = await supabase.from('crm_requests')
                .select('id')
                .eq('patient_id', pid)
                .in('status', ['scheduled', 'approved', 'in_process', 'recall']);
            if (reqErr || !reqs || !reqs.length) return;

            const { data: lines, error } = await supabase.from('crm_request_services')
                .select('id, request_id, service_id, scheduled_date, status')
                .in('request_id', reqs.map(r => r.id))
                .eq('scheduled_date', dayIso)
                .eq('status', 'pending');
            if (error || !lines || !lines.length) return;

            const added = [];
            for (const line of lines) {
                if (!line.service_id) continue;
                const svc = state.services.find(s => String(s.id) === String(line.service_id));
                if (!svc) continue;                                   // service retired since the call
                if (state.added.some(x => x.service.id === svc.id)) continue;
                if ((excludeServiceIds || []).some(id => String(id) === String(svc.id))) continue;   // already on the visit
                await catAdd(svc);
                added.push({ line, svc });
            }
            if (!added.length) return;
            // Remember which LINES these came from so attaching them can close the
            // loop (see attachCartToVisit) — per line, not per request: the other
            // services of the same request may be booked for another day.
            state.crmLineIds = added.map(a => a.line.id);
            state.crmRequestIds = [...new Set(added.map(a => a.line.request_id))];
            // i18n-exempt: заметка сохраняется В БАЗУ — хранимая запись, а не текст экрана
            state.crmNote = 'Из заявки колл-центра на ' + dayIso.split('-').reverse().join('.')
                + ': ' + added.map(a => a.svc.name).join(', ');
            paintCatalog();
            toast(state.crmNote, 'ok');
        } catch (e) {
            // A prefill is a convenience — never block the registrar from adding
            // services by hand because the CRM lookup failed.
            console.warn('[picker] CRM prefill skipped:', e && e.message);
        }
    }

    function mountColumns() {
        clear(body);
        // Running "added in this session" cart — in the AURORA_PICKER_V1 2-col
        // layout it lives in the RIGHT panel. renderAdded() paints its own
        // border/background/visibility inline (unchanged); .pk2-cart is layout
        // only and must NOT override those.
        refs.addedEl = h('div', {
            class: 'pk2-cart',
            style: {
                border: '1px solid #c6efd9', background: 'white',
                borderRadius: '10px',
                display: 'none', overflow: 'hidden',
            },
        });

        // LEFT panel — the existing cascade columns, unchanged in class/behaviour.
        const cols = [];
        if (!state.typeLocked) cols.push(buildCol(0, 'Группы услуг', 'Поиск групп…', 'typeSearch', 1));
        cols.push(buildCol(1, 'Услуги', 'Поиск услуг…', 'svcSearch', state.typeLocked ? 1 : 2));
        cols.push(buildCol(2, 'Врачи',  'Поиск врачей…',  'docSearch', state.typeLocked ? 2 : 3));
        // Give Services twice the room so long Cyrillic names + prices fit.
        // typeLocked (Types column hidden): 2 columns rendered.
        const gridTemplate = state.typeLocked
            ? '2fr 1fr'                  // Services · Doctors
            : '1fr 2fr 1fr';             // Types · Services · Doctors
        const colsWrap = h('div', { class: 'sched-picker svc-picker', style: { gridTemplateColumns: gridTemplate } }, ...cols);
        const left = h('div', { class: 'pk2-left' }, colsWrap);
        if (showSchedule) {
            refs.schedule = h('div', { style: { marginTop: '18px' } });
            left.appendChild(refs.schedule);
        }

        // RIGHT panel — the cart. Calculator mode appends its action bar below.
        const right = h('div', { class: 'pk2-right' }, refs.addedEl);
        if (calculator) {
            refs.calcBarEl = h('div', { class: 'pk2-calcbar' });
            right.appendChild(refs.calcBarEl);
        }

        body.appendChild(h('div', { class: 'pk2-grid' + (calculator ? ' pk2-grid--calc' : '') }, left, right));

        if (showSchedule) renderSchedule();
        for (let i = 0; i < 3; i++) if (refs.columns[i]) updateColumn(i);
        renderAdded();
        if (calculator) renderCalcBar();
        updateSummary();
        if (calculator) { paintWizChips(); paintWizFooter(); }   // BOOK_WIZARD_V1
    }

    function renderAdded() {
        const el = refs.addedEl;
        if (!el) return;
        clear(el);
        el.style.display = '';
        if (state.added.length === 0) {
            // PICKER_UX_V1 — explain the flow instead of collapsing into blank space.
            el.appendChild(h('div', { style: { padding: '22px 18px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '12.5px', lineHeight: '1.55' } },
                h('div', { style: { marginBottom: '8px', color: 'var(--ink-300)' } }, Icon('Receipt', { size: 26 })),
                h('div', { style: { fontWeight: 700, color: 'var(--ink-700)', marginBottom: '4px' } }, 'Список услуг пуст'),
                'Выберите слева группу → услугу → врача.', h('br', null),
                'Кнопка «В список» добавляет несколько услуг сразу;', h('br', null),
                'или подтвердите одну услугу основной кнопкой.'));
            return;
        }

        const total = state.added.reduce((s, a) => s + Number(a.service?.price || 0), 0);
        const n = state.added.length;

        // Header bar
        el.appendChild(h('div', {
            style: {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', background: 'var(--ok-50)',
                borderBottom: '1px solid #c6efd9',
            },
        },
            h('span', { style: { color: 'var(--ok-700)', fontWeight: 700, fontSize: '13px' } },
                trf('Выбрано услуг: {n}', { n })),
            h('span', { class: 'num', style: { fontWeight: 700, color: 'var(--ok-700)', fontSize: '13px' } },
                total.toLocaleString('ru-RU'), ' сум'),
        ));

        const GRID = '1.4fr 1.2fr 110px 28px';

        // Column header
        el.appendChild(h('div', {
            style: {
                display: 'grid', gridTemplateColumns: GRID, gap: '12px',
                padding: '8px 14px', borderBottom: '1px solid var(--ink-100)',
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: 'var(--ink-500)',
            },
        },
            h('span', null, 'Услуга'),
            h('span', null, 'Врач'),
            h('span', { style: { textAlign: 'right' } }, 'Цена'),
            h('span'),
        ));

        // Rows
        state.added.forEach((a, idx) => {
            const removeBtn = h('button', {
                title: 'Убрать из списка',
                style: {
                    background: 'transparent', border: '1px solid transparent',
                    color: 'var(--crit-700)', cursor: 'pointer',
                    width: '24px', height: '24px', borderRadius: '6px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', fontWeight: 700, padding: 0,
                },
                onmouseover: (e) => { e.currentTarget.style.background = 'var(--crit-50)'; e.currentTarget.style.borderColor = '#fecaca'; },
                onmouseout:  (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; },
                onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try {
                        if (onUndo) await onUndo(a);
                        state.added.splice(idx, 1);
                        renderAdded();
                        // Re-enable that service in the column.
                        updateColumn(1);
                    } catch (e) {
                        toast(e?.message || 'Не удалось убрать.', 'fail');
                        if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
                    }
                },
            }, '✕');

            const doctorLine = h('div', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink-700)', fontSize: '12.5px' } });
            if (a.doctor?.full_name) {
                doctorLine.appendChild(document.createTextNode(a.doctor.full_name));
                if (a.doctor.specialty) doctorLine.appendChild(h('span', { class: 'muted', style: { fontSize: '11.5px' } }, ' · ' + a.doctor.specialty));
            } else {
                doctorLine.appendChild(document.createTextNode('—'));
            }
            if (a.time && a.dateIso) doctorLine.appendChild(h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, schedDateLabel(a.dateIso) + ' ' + a.time));

            el.appendChild(h('div', {
                style: {
                    display: 'grid', gridTemplateColumns: GRID, gap: '12px',
                    padding: '10px 14px', borderTop: idx === 0 ? 'none' : '1px solid var(--ink-100)',
                    alignItems: 'center', fontSize: '12.5px',
                },
            },
                h('div', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--ink-900)' }, title: a.service?.name }, a.service?.name || '—'),
                doctorLine,
                h('div', { class: 'num', style: { textAlign: 'right', fontWeight: 700, color: 'var(--ink-900)' } }, Number(a.service?.price || 0).toLocaleString('ru-RU')),
                removeBtn,
            ));
        });
        // Calculator: keep the right-panel quote total + button state in sync.
        if (calculator && refs.calcBarEl) renderCalcBar();
    }

    function buildCol(i, title, placeholder, searchKey, step) {
        const listEl = h('div', { class: 'sched-col-list' });
        const footEl = h('div', { class: 'sched-col-foot' }, h('div', { class: 'summary' }, ''));
        refs.columns[i] = { listEl, footEl };
        return h('div', { class: 'sched-col' },
            h('div', { class: 'sched-col-head', style: { display: 'flex', alignItems: 'center', gap: '7px' } },
                step ? h('span', { style: { flex: '0 0 auto', width: '18px', height: '18px', borderRadius: '50%', background: 'var(--primary-600, #167873)', color: 'white', font: '700 10.5px/18px inherit', textAlign: 'center' } }, String(step)) : null,
                title),
            h('div', { class: 'sched-col-search' },
                h('input', {
                    placeholder, value: state[searchKey],
                    oninput: (e) => { state[searchKey] = e.target.value; updateColumn(i); },
                }),
            ),
            listEl,
            footEl,
        );
    }

    function updateColumn(i) {
        if (!refs.columns[i]) return;
        const { listEl } = refs.columns[i];
        clear(listEl);
        if (i === 0) {
            const t = state.typeSearch.trim().toLowerCase();
            const filtered = state.types.filter(r => !t || (r.name || '').toLowerCase().includes(t));
            if (!filtered.length) { listEl.appendChild(emptyHint('Нет групп услуг.', '')); return; }
            // "All" pseudo-row lets the user clear the type filter.
            listEl.appendChild(rowEl('Все группы', '', state.typeId === null, () => selectAt(0, null)));
            for (const r of filtered) listEl.appendChild(rowEl(r.name, r.code || '', state.typeId === r.id, () => selectAt(0, r.id)));
        } else if (i === 1) {
            const filtered = filterServices();
            if (!filtered.length) {
                listEl.appendChild(emptyHint('Услуги не найдены', state.typeId ? 'Сбросьте группу или измените поиск.' : 'Измените поисковый запрос.'));
                return;
            }
            // Services already on the visit or just added in this session render
            // disabled — no double-booking the same service.
            const lockedIds = new Set([
                ...excludeServiceIds,
                ...state.added.map(a => a.service?.id).filter(Boolean),
            ]);
            for (const r of filtered) {
                const locked = lockedIds.has(r.id);
                listEl.appendChild(rowEl(r.name, formatMoney(r.price), state.serviceId === r.id, () => selectAt(1, r.id),
                    { disabled: locked, badge: locked ? 'Добавлено' : null }));
            }
        } else if (i === 2) {
            const filtered = filterDoctors();
            if (!filtered.length) {
                listEl.appendChild(state.serviceId
                    ? emptyHint('Для услуги не назначен врач.', 'Назначьте в «Сотрудники → Услуги и тарифы».')
                    : emptyHint('Врачи не найдены.', ''));
                return;
            }
            for (const d of filtered) listEl.appendChild(rowEl(d.full_name, d.specialty || '', state.doctorId === d.id, () => selectAt(2, d.id)));
        }
    }

    function selectAt(colIdx, id) {
        if (colIdx === 0) {
            // Clicking the already-active type clears the filter; clicking "All" passes id=null.
            state.typeId = state.typeId === id ? null : id;
            // Drop the service pick if it no longer matches the new type filter.
            if (state.typeId) {
                const svc = state.services.find(s => s.id === state.serviceId);
                if (svc && _implType(svc) !== state.typeId) state.serviceId = null;
            }
            updateColumn(0); updateColumn(1);
        } else if (colIdx === 1) {
            // Service pick — auto-select its service_type so the Types column
            // reflects the implied filter. Toggling the same service clears it.
            if (state.serviceId === id) {
                state.serviceId = null;
            } else {
                state.serviceId = id;
                // PICKER_UX_V1 — if exactly one doctor performs this service, pick them.
                // CONSULT_PER_DOCTOR_ROWS_V1 — use svcPerformers (resolves a consult's bound doctor;
                // performersOf can't, since the consult id is a composite c|doc|type).
                const _svc599 = state.services.find(s => s.id === id);
                const _perf = _svc599 ? svcPerformers(_svc599) : [];
                if (_perf.length === 1) { state.doctorId = _perf[0].id; if (showSchedule) onDoctorChanged(); }
                const svc = state.services.find(s => s.id === id);
                const _impl = _implType(svc);
                if (svc && _impl && !state.typeLocked) {
                    state.typeId = _impl;
                    updateColumn(0);
                }
            }
            updateColumn(1);
            // The Doctors column now shows only performers of the chosen service.
            // Drop the picked doctor if they don't perform it.
            const _curSvc = state.services.find(s => s.id === state.serviceId);
            const _docOk = (_curSvc && _curSvc.__consult)
                ? consultAvailableFor(state.doctorId, _curSvc.consultation_type_id)
                : doctorPerforms(currentDoctor() || {}, state.serviceId);
            if (state.serviceId && state.doctorId && !_docOk) {
                state.doctorId = null;
                if (showSchedule) { state.schedDateIso = null; state.schedStartMin = null; state.schedManual = false; }
            }
            updateColumn(2);
            // Service duration drives slot length — re-pick the nearest slot
            // unless the user already chose one by hand.
            if (showSchedule && state.doctorId && !state.schedManual) autoPickSlot();
            if (showSchedule) renderSchedule();
        } else if (colIdx === 2) {
            state.doctorId = state.doctorId === id ? null : id;
            updateColumn(2);
            if (showSchedule) onDoctorChanged();
        }
        updateSummary();
    }

    function updateSummary() {
        const svc = state.services.find(s => s.id === state.serviceId);
        const doc = state.doctors.find(d => d.id === state.doctorId);
        const hasStaged = state.added.length > 0;
        if (svc) {
            const parts = [`${svc.name} · ${formatMoney(svc.price)}`, doc ? doc.full_name : 'врач не выбран'];
            if (showSchedule && state.schedDateIso && state.schedStartMin != null) {
                parts.push(`${schedDateLabel(state.schedDateIso)} ${fmtMin(state.schedStartMin)}`);
            }
            summary.textContent = parts.join(' · ');
            confirmBtn.removeAttribute('disabled');
            addAnotherBtn.removeAttribute('disabled');
        } else if (hasStaged) {
            // No current selection, but the registrar already staged services
            // via "Add". Done is enabled so they can commit and close; Add
            // stays disabled (nothing to add).
            const _tot = state.added.reduce((s, a) => s + Number(a.service?.price || 0), 0);
            summary.textContent = trf('В списке: {n} усл. на {sum} — нажмите «{label}»', { n: state.added.length, sum: formatMoney(_tot), label: tr(confirmLabel) });
            confirmBtn.removeAttribute('disabled');
            addAnotherBtn.setAttribute('disabled', '');
        } else {
            summary.textContent = 'Выберите услугу, чтобы продолжить';
            confirmBtn.setAttribute('disabled', '');
            addAnotherBtn.setAttribute('disabled', '');
        }
    }

    // The type a service implies for column 1 — group id, distinct type, or legacy type_id.
    //
    // SERVICE_GROUPS_V1 — the last branch used to be a bare `svc.type_id`, which
    // is NULL for every service imported without one. `NULL === selectedId` is
    // never true, so clicking any group in column 1 returned an empty list and
    // only «Все группы» ever showed anything. resolveTypeId() derives the group
    // from the routing `type` when type_id is missing (and still prefers an
    // explicit type_id, so a hand-filed service keeps its group).
    function _implType(svc) {
        if (!svc) return null;
        if (svc.__consult) return CONSULT_GROUP_ID;
        if (state.useGroups)  return state.svcGroupMap[svc.core_service_id] || null;
        if (state.deriveType) return (svc.type || null);
        return resolveTypeId(svc, state.types) || null;
    }
    function filterServices() {
        const t = state.svcSearch.trim().toLowerCase();
        return state.services.filter(s => {
            if (state.typeId && _implType(s) !== state.typeId) return false;
            if (t && !(s.name || '').toLowerCase().includes(t)) return false;
            return true;
        });
    }
    // A doctor "performs" a service when it's in their users.service_rates
    // (the "Services performed" list set on the employee). Stored as
    // [{ service_id, percentage }].
    function doctorPerforms(d, serviceId) {
        const rates = Array.isArray(d.service_rates) ? d.service_rates : [];
        return rates.some(r => r && String(r.service_id) === String(serviceId));
    }
    function performersOf(serviceId) {
        return (state.providers || state.doctors).filter(d => doctorPerforms(d, serviceId));
    }
    // DOCTOR_FALLBACK_V1 — a service is "cabinet-routed" (handled by the doctor's
    // «Мои услуги» worklist in consultation.js, not the lab/procedure modules)
    // when its routing type isn't lab/procedure — i.e. consultation, imaging
    // (diagnostics) or other/surgery. For such a service with no dedicated
    // performer in users.service_rates, the booking must still let the registrar
    // pick a doctor; otherwise visit_services.doctor_id is written null and the
    // patient never reaches any worklist. SERVICE_GROUP_ROUTING_V1.
    function isCabinetRouted(svc) {
        const t = (svc && svc.type || '').trim();
        return t !== 'lab' && t !== 'procedure';
    }
    // Candidate doctors for a non-consult service: its performers, or — when it
    // has none but is cabinet-routed — every active doctor, so the patient can
    // be assigned and land on that doctor's worklist.
    function candidatesFor(svc) {
        const perf = performersOf(svc.id);
        if (perf.length === 0 && isCabinetRouted(svc)) return state.doctors;
        return perf;
    }

    function filterDoctors() {
        const t = state.docSearch.trim().toLowerCase();
        // Once a service is picked, show ONLY doctors assigned to it (their
        // "Services performed" in Settings → Employees). No service picked yet →
        // the full list. If a service has no assigned doctor the column is empty
        // and the empty-state hint tells the user where to assign one.
        const _selSvc = state.services.find(s => s.id === state.serviceId);
        const pool = !state.serviceId ? state.doctors
            : (_selSvc && _selSvc.__consult)
                ? (_selSvc.__consultDoctorId
                    ? state.doctors.filter(d => d.id === _selSvc.__consultDoctorId)   // CONSULT_PER_DOCTOR_ROWS_V1 — only the row's bound doctor
                    : state.doctors.filter(d => consultAvailableFor(d.id, _selSvc.consultation_type_id)))
                : (_selSvc ? candidatesFor(_selSvc) : performersOf(state.serviceId));   // DOCTOR_FALLBACK_V1
        return pool.filter(d => {
            if (t && !((d.full_name || '').toLowerCase().includes(t) || (d.specialty || '').toLowerCase().includes(t))) return false;
            return true;
        });
    }

    // -----------------------------------------------------------------------
    // Schedule (only mounted when showSchedule). Shows the picked doctor's
    // working hours for a day, blocks out their existing bookings, and lets the
    // registrar click a free slot. The nearest free slot is auto-selected so a
    // walk-in patient who isn't already booked lands on the soonest opening.
    // -----------------------------------------------------------------------
    function currentDoctor() { return state.doctors.find(d => d.id === state.doctorId) || null; }
    function serviceDurationMin() {
        const svc = state.services.find(s => s.id === state.serviceId);
        return Math.max(5, Number(svc?.duration_minutes || 30));
    }
    // Earliest day we'll consider — the caller's context day if it's in the
    // future, otherwise today. Booking in the past is never offered.
    function schedBaseIso() {
        const today = schedTodayIso();
        return (initialDateIso && initialDateIso > today) ? initialDateIso : today;
    }

    // Doctor (re)selected — wipe any prior pick, load the booking window, then
    // auto-select the nearest opening.
    async function onDoctorChanged() {
        state.schedManual   = false;
        state.schedDateIso  = null;
        state.schedStartMin = null;
        state.schedViewIso  = schedBaseIso();
        renderSchedule();
        const doctor = currentDoctor();
        if (!doctor) { updateSummary(); return; }
        await loadDoctorVisitsWindow(doctor.id);
        // The doctor may have changed again while we awaited — bail if stale.
        if (state.doctorId !== doctor.id) return;
        autoPickSlot();
        renderSchedule();
        updateSummary();
    }

    // Pull the doctor's visits for the next 2 weeks in one query and bucket
    // them by local day so slot math is purely in-memory afterwards.
    async function loadDoctorVisitsWindow(doctorId) {
        state.schedLoadingFor = doctorId;
        const startIso = schedTodayIso();
        const endDate  = schedIsoToDate(schedAddDays(startIso, SCHED_WINDOW_DAYS));
        endDate.setHours(23, 59, 59, 999);
        const start = schedIsoToDate(startIso);
        start.setHours(0, 0, 0, 0);
        const { data, error } = await supabase.from('visits')
            .select('id, visit_date, duration_minutes, status, patient_id, services(name)')
            .eq('doctor_id', doctorId)
            .gte('visit_date', start.toISOString())
            .lte('visit_date', endDate.toISOString());
        const map = {};
        if (error) {
            console.warn('[service-picker] schedule visits load failed:', error.message);
        } else {
            for (const v of (data || [])) {
                if (['cancelled', 'no_show'].includes(v.status)) continue;
                if (patientId && v.patient_id === patientId) continue;   // ignore the patient's own slot
                const d = new Date(v.visit_date);
                if (Number.isNaN(d.getTime())) continue;
                const iso = schedDateToIso(d);
                const startMin = d.getHours() * 60 + d.getMinutes();
                const dur = Math.max(5, Number(v.duration_minutes || 30));
                if (!map[iso]) map[iso] = [];
                map[iso].push({ startMin, endMin: startMin + dur, label: v.services?.name || 'Booked' });
            }
        }
        state.schedVisits = map;
        if (state.schedLoadingFor === doctorId) state.schedLoadingFor = null;
    }

    // Walk forward day-by-day from today to the first day that has a free slot.
    function autoPickSlot() {
        const doctor = currentDoctor();
        if (!doctor) return;
        const dur = serviceDurationMin();
        for (let i = 0; i < SCHED_WINDOW_DAYS; i++) {
            const iso   = schedAddDays(schedBaseIso(), i);
            const range = workingRangeFor(doctor, iso);
            if (!range) continue;
            const slot = nearestSlotInDay(iso, range, dur);
            if (slot != null) {
                state.schedViewIso  = iso;
                state.schedDateIso  = iso;
                state.schedStartMin = slot;
                return;
            }
        }
        state.schedDateIso  = null;
        state.schedStartMin = null;
    }

    // Earliest snapped, non-overlapping slot of `dur` minutes inside `range`.
    function nearestSlotInDay(iso, range, dur) {
        const busy = state.schedVisits[iso] || [];
        let earliest = range.fromMin;
        if (iso === schedTodayIso()) {
            const now = new Date();
            const nowMin = now.getHours() * 60 + now.getMinutes();
            earliest = Math.max(earliest, Math.ceil(nowMin / SCHED_SNAP) * SCHED_SNAP);
        }
        for (let s = range.fromMin; s + dur <= range.toMin; s += SCHED_SNAP) {
            if (s < earliest) continue;
            if (!overlapsBusy(s, s + dur, busy)) return s;
        }
        return null;
    }

    function selectSchedDay(iso) {
        state.schedViewIso = iso;
        const doctor = currentDoctor();
        const range  = doctor ? workingRangeFor(doctor, iso) : null;
        const slot   = range ? nearestSlotInDay(iso, range, serviceDurationMin()) : null;
        // Stepping to a day re-arms auto-pick: land on that day's first opening.
        state.schedManual   = false;
        state.schedDateIso  = slot != null ? iso : null;
        state.schedStartMin = slot;
        renderSchedule();
        updateSummary();
    }

    function selectSchedTime(min) {
        state.schedDateIso  = state.schedViewIso;
        state.schedStartMin = min;
        state.schedManual   = true;
        renderSchedule();
        updateSummary();
    }

    function renderSchedule() {
        if (!refs.schedule) return;
        clear(refs.schedule);
        const doctor = currentDoctor();

        const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
            h('span', { style: { color: 'var(--primary-700)' } }, Icon('Calendar', { size: 15 })),
            h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Время приёма'),
        );

        if (!doctor) {
            refs.schedule.append(head, h('div', {
                style: { padding: '14px 16px', border: '1px dashed var(--ink-200)', borderRadius: '10px', color: 'var(--ink-500)', fontSize: '12.5px', background: 'var(--ink-25)' },
            }, 'Выберите врача выше — появится его расписание и свободное время.'));
            return;
        }

        const viewIso = state.schedViewIso || schedTodayIso();
        const range   = workingRangeFor(doctor, viewIso);
        const dur     = serviceDurationMin();

        const chosen = (state.schedDateIso === viewIso && state.schedStartMin != null) ? state.schedStartMin : null;
        const chosenChip = h('div', {
            style: {
                marginLeft: 'auto', fontSize: '12px', fontWeight: 600,
                padding: '3px 10px', borderRadius: '999px',
                background: chosen != null ? 'var(--primary-50)' : 'var(--ink-25)',
                color: chosen != null ? 'var(--primary-700)' : 'var(--ink-500)',
                border: '1px solid ' + (chosen != null ? 'var(--primary-200)' : 'var(--ink-100)'),
            },
        }, chosen != null ? `Selected · ${fmtMin(chosen)}–${fmtMin(chosen + dur)}` : 'No time selected');
        head.appendChild(chosenChip);
        refs.schedule.appendChild(head);

        // Day stepper
        const isToday = viewIso === schedTodayIso();
        const prevBtn = h('button', {
            class: 'btn btn-sm', type: 'button',
            disabled: isToday ? '' : null,
            title: isToday ? 'Cannot book in the past' : 'Previous day',
            onclick: () => { if (!isToday) selectSchedDay(schedAddDays(viewIso, -1)); },
        }, '‹');
        const nextBtn = h('button', {
            class: 'btn btn-sm', type: 'button', title: 'Next day',
            onclick: () => selectSchedDay(schedAddDays(viewIso, 1)),
        }, '›');
        refs.schedule.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
            prevBtn,
            h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-800)', minWidth: '150px', textAlign: 'center' } }, schedDateLabel(viewIso)),
            nextBtn,
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginLeft: '6px' } },
                range ? `Working ${fmtMin(range.fromMin)}–${fmtMin(range.toMin)} · ${dur} min slot` : 'Not working this day'),
        ));

        // Timeline track
        const trackInner = buildTimeline(doctor, viewIso, range, dur, chosen);
        const scroller = h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'white', padding: '0 0 8px' } }, trackInner);
        refs.schedule.appendChild(scroller);

        // Caption / fallback
        if (!range) {
            refs.schedule.appendChild(captionLine('The doctor does not work on this day — step to another day.', 'warn'));
        } else if (chosen == null) {
            refs.schedule.appendChild(captionLine('No free slot on this day. Try another day, or click a free area on the timeline.', 'warn'));
        } else if (state.schedManual) {
            refs.schedule.appendChild(captionLine('Time set manually. Click another free area to change it.', 'muted'));
        } else {
            refs.schedule.appendChild(captionLine('Nearest free slot selected automatically. Click any free area to change it.', 'muted'));
        }
    }

    function captionLine(text, kind) {
        const color = kind === 'warn' ? 'var(--warn-700, #b45309)' : 'var(--ink-500)';
        return h('div', { style: { fontSize: '11.5px', color, marginTop: '8px' } }, text);
    }

    // Builds the hour ruler + clickable track for one day.
    function buildTimeline(doctor, iso, range, dur, chosen) {
        const totalHours = SCHED_GRID_END - SCHED_GRID_START;
        const width = totalHours * SCHED_HOUR_W;
        const wrap = h('div', { style: { width: width + 'px', minWidth: width + 'px' } });

        // Hour labels
        const ruler = h('div', { style: { position: 'relative', height: '20px', borderBottom: '1px solid var(--ink-100)' } });
        for (let hh = SCHED_GRID_START; hh <= SCHED_GRID_END; hh++) {
            ruler.appendChild(h('div', {
                style: { position: 'absolute', left: ((hh - SCHED_GRID_START) * SCHED_HOUR_W) + 'px', top: '2px', fontSize: '10.5px', color: 'var(--ink-400)', transform: 'translateX(-50%)' },
            }, String(hh).padStart(2, '0') + ':00'));
        }
        wrap.appendChild(ruler);

        const track = h('div', { style: { position: 'relative', height: '48px', cursor: range ? 'pointer' : 'default' } });

        // Off-hours shading
        const shade = (fromMin, toMin) => h('div', {
            style: { position: 'absolute', top: 0, bottom: 0, left: xOf(fromMin) + 'px', width: Math.max(0, xOf(toMin) - xOf(fromMin)) + 'px', background: 'repeating-linear-gradient(45deg, var(--ink-25), var(--ink-25) 6px, #fff 6px, #fff 12px)' },
        });
        const gridStartMin = SCHED_GRID_START * 60, gridEndMin = SCHED_GRID_END * 60;
        if (!range) {
            track.appendChild(shade(gridStartMin, gridEndMin));
        } else {
            if (range.fromMin > gridStartMin) track.appendChild(shade(gridStartMin, range.fromMin));
            if (range.toMin   < gridEndMin)   track.appendChild(shade(range.toMin, gridEndMin));
        }

        // Hour gridlines
        for (let hh = SCHED_GRID_START; hh <= SCHED_GRID_END; hh++) {
            track.appendChild(h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: ((hh - SCHED_GRID_START) * SCHED_HOUR_W) + 'px', width: '1px', background: 'var(--ink-100)' } }));
        }

        // Busy blocks
        for (const b of (state.schedVisits[iso] || [])) {
            const left = xOf(Math.max(b.startMin, gridStartMin));
            const right = xOf(Math.min(b.endMin, gridEndMin));
            if (right <= left) continue;
            track.appendChild(h('div', {
                title: `Booked ${fmtMin(b.startMin)}–${fmtMin(b.endMin)} · ${b.label}`,
                style: { position: 'absolute', top: '4px', bottom: '4px', left: left + 'px', width: (right - left) + 'px', background: 'var(--ink-100)', border: '1px solid var(--ink-200)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', fontSize: '10.5px', color: 'var(--ink-600)', padding: '0 4px' },
            }, b.label));
        }

        // NOW marker
        if (iso === schedTodayIso()) {
            const now = new Date();
            const nowMin = now.getHours() * 60 + now.getMinutes();
            if (nowMin >= gridStartMin && nowMin <= gridEndMin) {
                track.appendChild(h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: xOf(nowMin) + 'px', width: '2px', background: 'var(--crit-500, #ef4444)' } }));
            }
        }

        // Chosen slot block
        if (chosen != null) {
            const left = xOf(chosen);
            const w = (dur / 60) * SCHED_HOUR_W;
            track.appendChild(h('div', {
                style: { position: 'absolute', top: '4px', bottom: '4px', left: left + 'px', width: w + 'px', background: 'var(--primary-500, #2563eb)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '11px', fontWeight: 600, boxShadow: '0 1px 4px rgba(0,0,0,0.18)' },
            }, fmtMin(chosen)));
        }

        // Click to choose
        if (range) {
            track.addEventListener('click', (e) => {
                const rect = track.getBoundingClientRect();
                const x = e.clientX - rect.left;
                let min = SCHED_GRID_START * 60 + (x / SCHED_HOUR_W) * 60;
                min = Math.round(min / SCHED_SNAP) * SCHED_SNAP;
                // Keep the whole slot inside working hours.
                if (min < range.fromMin) min = range.fromMin;
                if (min + dur > range.toMin) min = range.toMin - dur;
                min = Math.round(min / SCHED_SNAP) * SCHED_SNAP;
                if (min < range.fromMin) { toast('That time is before the doctor starts.', 'fail'); return; }
                if (iso === schedTodayIso()) {
                    const now = new Date();
                    if (min < now.getHours() * 60 + now.getMinutes()) { toast('That time is already past.', 'fail'); return; }
                }
                if (overlapsBusy(min, min + dur, state.schedVisits[iso] || [])) { toast('That slot overlaps an existing booking.', 'fail'); return; }
                selectSchedTime(min);
            });
        }

        wrap.appendChild(track);
        return wrap;
    }

    function xOf(min) { return ((min - SCHED_GRID_START * 60) / 60) * SCHED_HOUR_W; }
    function workingRangeFor(doctor, iso) {
        let fromMin, toMin;
        const wh = doctor?.working_hours || doctor?.workingHours;
        if (!wh || typeof wh !== 'object') { fromMin = 8 * 60; toMin = 18 * 60; }
        else {
            const slot = wh[SCHED_WEEKDAY[schedIsoToDate(iso).getDay()]];
            if (!slot || slot.enabled === false) return null;
            fromMin = Math.round(schedParseHHMM(slot.from || '08:00') * 60);
            toMin   = Math.round(schedParseHHMM(slot.to   || '18:00') * 60);
            if (toMin <= fromMin) return null;
        }
        const cr = clinicRangeForDay(doctor && doctor.branch_id, iso);   // WORKING_HOURS_CLINIC_BOUND_V1
        if (cr === null) return null;
        if (cr) { fromMin = Math.max(fromMin, cr.fromMin); toMin = Math.min(toMin, cr.toMin); }
        return toMin > fromMin ? { fromMin, toMin } : null;
    }


    // =======================================================================
    // AURORA_PICKER_V1 — Calculator mode (no-patient quote → attach → visit).
    // These closures capture state/refs/overlay/onKey/calculator/onCreatePatient.
    // They never run unless `calculator === true`. onPick is never fired here.
    // =======================================================================

    // Sum of staged services in the cart.
    function calcCartTotal() {
        return state.added.reduce((s, a) => s + Number(a.service?.price || 0), 0);
    }

    // The right-panel action bar under the cart. Two states:
    //   A — no patient attached: total echo + «Привязать пациента»
    //   B — patient attached: patient chip + «Оформить визит»
    function renderCalcBar() {
        const el = refs.calcBarEl;
        if (!el) return;
        clear(el);

        const total = calcCartTotal();
        const n = state.added.length;

        el.appendChild(h('div', { class: 'pk2-calc-cap' }, 'Калькулятор — расчёт без пациента'));
        el.appendChild(h('div', { class: 'pk2-calc-total' },
            total.toLocaleString('ru-RU'), ' сум',
            h('small', null, ' · ', trf('{n} услуг(и)', { n })),
        ));

        const p = refs.attachedPatient;
        if (!p) {
            // State A — attach a patient.
            const btn = h('button', {
                class: 'pk2-calc-btn', type: 'button',
                disabled: state.added.length === 0 ? '' : null,
                onclick: () => openAttachPatientModal(),
            }, Icon('User', { size: 15 }), ' Привязать пациента');
            el.appendChild(btn);
            el.appendChild(h('div', { class: 'pk2-calc-sub' },
                'Добавьте услуги в список, затем привяжите пациента.'));
        } else {
            // State B — patient attached → hand off to the visit modal.
            const name = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
            const sub = [p.mrn, p.phone].filter(Boolean).join(' · ') || '—';
            el.appendChild(h('div', { class: 'pk2-calc-pat' },
                Avatar({ initials: p.initials || initials(name), color: p.avColor || avColor(p.id || name) }),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'nm', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                    h('div', { class: 'sub' }, sub),
                ),
                h('button', {
                    class: 'x', type: 'button', title: 'Отвязать пациента',
                    onclick: () => { refs.attachedPatient = null; renderCalcBar(); },
                }, '×'),
            ));
            el.appendChild(h('button', {
                class: 'pk2-calc-btn', type: 'button',
                onclick: () => wizGoto(2),   // SVC_REFERRAL_V1 — step 2: Направление
            }, Icon('ArrowRight', { size: 15 }), ' Далее: Направление'));
        }
    }

    // Second-level modal (z 150, above the picker's 130). Search existing
    // patients by ФИО / ID / телефон, or «Создать пациента» → onCreatePatient.
    let _attachOverlay = null;
    function closeAttach() {
        if (_attachOverlay) { _attachOverlay.remove(); _attachOverlay = null; }
    }
    function openAttachPatientModal() {
        if (state.added.length === 0) { toast('Сначала добавьте услуги.', 'fail'); return; }
        closeAttach();
        const ov = h('div', { class: 'modal', style: { zIndex: '150' } });
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: () => closeAttach() }));
        _attachOverlay = ov;

        const resultsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px', maxHeight: '46vh', overflow: 'auto' } });
        const inp = h('input', {
            type: 'search', autocomplete: 'off',
            style: { width: '100%', height: '36px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontSize: '13px' },
            placeholder: 'Поиск по ФИО, ID или телефону…',
        });

        let timer = null, reqSeq = 0;
        function paint(rows) {
            clear(resultsEl);
            if (!rows || rows.length === 0) {
                resultsEl.appendChild(h('div', { style: { padding: '14px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '13px' } }, 'Ничего не найдено'));
                return;
            }
            rows.forEach((p) => {
                const name = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
                const sub = [p.mrn, p.phone].filter(Boolean).join(' · ') || '—';
                resultsEl.appendChild(h('button', {
                    class: 'pk2-attach-row', type: 'button',
                    onclick: () => attachPatient(p),
                },
                    Avatar({ initials: p.initials || initials(name), color: p.avColor || avColor(p.id || name) }),
                    h('div', { style: { minWidth: 0, flex: 1 } },
                        h('div', { class: 'nm', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                        h('div', { class: 'sub' }, sub),
                    ),
                    Icon('ArrowRight', { size: 14 }),
                ));
            });
        }
        async function search(term) {
            const seq = ++reqSeq;
            try {
                const { rows } = await loadPatientsPaged({ search: term, limit: 8 });
                if (seq !== reqSeq) return;   // a newer keystroke superseded this
                paint(rows);
            } catch (e) {
                if (seq !== reqSeq) return;
                paint([]);
            }
        }
        inp.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => search(inp.value.trim()), 250);
        });

        const card = h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)', display: 'flex', flexDirection: 'column' } });
        card.appendChild(h('header', { class: 'modal-head' },
            h('h2', null, Icon('User', { size: 16 }), ' Привязать пациента'),
            h('button', { class: 'modal-close', onclick: () => closeAttach() }, '×'),
        ));
        card.appendChild(h('div', { class: 'modal-body', style: { padding: '16px 22px' } }, inp, resultsEl));
        card.appendChild(h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: () => closeAttach() }, 'Отмена'),
            h('button', {
                class: 'btn btn-outline',
                onclick: () => {
                    // BOOK_WIZARD_V1 — inline create keeps the staged cart alive.
                    if (calculator) { openCreatePatientInline(); return; }
                    if (typeof onCreatePatient === 'function') {
                        closeAttach();
                        overlay.remove();
                        document.removeEventListener('keydown', onKey);
                        onCreatePatient();
                    } else {
                        toast('Откройте «Создать пациента» на странице пациентов.', 'info');
                    }
                },
            }, Icon('Plus', { size: 14 }), ' Создать пациента'),
        ));
        ov.appendChild(card);
        document.body.appendChild(ov);
        // Initial list (recent patients) so the registrar can pick without typing.
        search('');
        setTimeout(() => inp.focus(), 30);
    }

    function attachPatient(p) {
        refs.attachedPatient = p;
        closeAttach();
        renderCalcBar();
        if (catListEl) { wiz.depositBalance = null; wiz._prefilled = false; wiz.applied = []; wiz.payment.discountPct = null; wiz.payment.payerId = null; wiz.payment.policyId = null; wiz.payment.policyNumber = ''; paintCatalog(); }   // CATALOG_WIZARD_V4
        const nm = (p.lastName || p.fullName || '').toString().trim();
        toast(nm ? trf('Пациент привязан: {name}', { name: nm }) : tr('Пациент привязан'));
    }


    // =======================================================================
    // CATALOG_WIZARD_V1 — step 1 redesign (calculator mode only): searchable
    // service CATALOG + sticky СМЕТА rail replacing the 3-column cascade.
    // Windowed rendering: CAT_PAGE rows + «Показать ещё» so 1000+-service
    // catalogs never bloat the DOM. lockedDoctor filters the catalog to that
    // doctor's services and pins the slot time; patient pins the patient.
    // =======================================================================
    const CAT_PAGE = 60;
    const cat2 = { q: '', group: '', win: CAT_PAGE };
    const slotCache = {};   // docId -> { byDay: { dayIso: [{s,e}] } }
    let catListEl = null, catRailEl = null, catCtxEl = null, catGroupsEl = null, catSearchEl = null;

    const CAT_MO = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const CAT_WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    function catDays() {
        const out = [], t = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
            out.push({ iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                wd: CAT_WD[d.getDay()], dd: d.getDate(), mo: CAT_MO[d.getMonth()], today: i === 0 });
        }
        return out;
    }
    function svcPerformers(svc) {
        if (svc.__consult) {
            if (svc.__consultDoctorId) return state.doctors.filter(d => d.id === svc.__consultDoctorId);   // CONSULT_PER_DOCTOR_ROWS_V1
            return state.doctors.filter(d => consultAvailableFor(d.id, svc.consultation_type_id || svc.id));
        }
        return candidatesFor(svc);   // DOCTOR_FALLBACK_V1 — performers, or all doctors for a cabinet-routed service with none
    }
    function svcPrice(svc, docId) {
        if (svc.__consult && docId) return consultPriceFor(docId, svc.__ct || svc);
        return Number(svc.price || 0);
    }
    function svcGroupId(svc) {
        if (svc.__consult) return CONSULT_GROUP_ID;
        if (state.useGroups) return state.svcGroupMap[svc.core_service_id] || '';
        if (state.deriveType) return (svc.type || '').trim();
        // SERVICE_GROUPS_V1 — was `svc.type_id || ''`. With type_id NULL every
        // service counted under the '' key, so paintCatGroups() found n === 0 for
        // every real group and rendered ONLY the «Все» chip — literally "it only
        // ever shows all groups". (Same fix as _implType; keep the two in step.)
        return resolveTypeId(svc, state.types) || '';
    }
    function groupNameOf(svc) {
        const gid = String(svcGroupId(svc) || '');
        const t = state.types.find(x => String(x.id) === gid);
        return t ? t.name : (svc.type || '');
    }
    function catEligible() {
        if (!lockedDoctor) return state.services;
        return state.services.filter(s => {
            if (s.__consult) return s.__consultDoctorId ? (s.__consultDoctorId === lockedDoctor.id) : consultAvailableFor(lockedDoctor.id, s.consultation_type_id || s.id);   // CONSULT_PER_DOCTOR_ROWS_V1
            return performersOf(s.id).some(d => d.id === lockedDoctor.id);
        });
    }
    function catFiltered() {
        const ql = cat2.q.trim().toLowerCase();
        return catEligible().filter(s => {
            if (cat2.group && String(svcGroupId(s)) !== String(cat2.group)) return false;
            if (!ql) return true;
            if ((s.name || '').toLowerCase().includes(ql)) return true;
            return svcPerformers(s).some(d => (d.full_name || '').toLowerCase().includes(ql));
        });
    }

    // ---- slot engine: one 7-day visits query per doctor, cached ----
    async function ensureDocSlots(docId) {
        if (slotCache[docId]) return slotCache[docId];
        const byDay = {};
        try {
            const start = new Date(); start.setHours(0, 0, 0, 0);
            const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
            const { data } = await supabase.from('visits')
                .select('visit_date, duration_minutes, status')
                .eq('doctor_id', docId)
                .gte('visit_date', start.toISOString()).lt('visit_date', end.toISOString());
            for (const v of (data || [])) {
                if (['cancelled', 'no_show'].includes((v.status || '').toLowerCase())) continue;
                const dt = new Date(v.visit_date);
                const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                const sMin = dt.getHours() * 60 + dt.getMinutes();
                (byDay[iso] = byDay[iso] || []).push({ s: sMin, e: sMin + (Number(v.duration_minutes) || 30) });
            }
        } catch (e) { console.warn('[catalog] slots', e.message); }
        slotCache[docId] = { byDay };
        return slotCache[docId];
    }
    function catWorkRange(doc, dayIso) {
        const hours = doc && (doc.working_hours || doc.workingHours);
        const p = (x) => { const [hh, mm] = String(x || '').split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
        let from, to;
        if (!hours || typeof hours !== 'object') { from = 8 * 60; to = 18 * 60; }
        else {
            const d = new Date(dayIso + 'T00:00:00');
            const slot = hours[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()]];
            if (!slot || slot.enabled === false) return null;
            from = slot.from ? p(slot.from) : 8 * 60; to = slot.to ? p(slot.to) : 18 * 60;
            if (to <= from) return null;
        }
        const cr = clinicRangeForDay(doc && doc.branch_id, dayIso);   // WORKING_HOURS_CLINIC_BOUND_V1
        if (cr === null) return null;
        if (cr) { from = Math.max(from, cr.fromMin); to = Math.min(to, cr.toMin); }
        return to > from ? { from, to } : null;
    }
    function freeStarts(docId, dayIso, dur, exceptItem) {
        const doc = state.doctors.find(d => d.id === docId);
        const wr = catWorkRange(doc, dayIso);
        if (!wr) return [];
        const busy = [...((((slotCache[docId] || {}).byDay) || {})[dayIso] || [])];
        // CATALOG_WIZARD_V2 — other cart items for this doctor+day block their slot too
        for (const o of state.added) {
            if (o === exceptItem || !o.doctor || o.doctor.id !== docId || o.dateIso !== dayIso || !o.time) continue;
            const sm = Number(o.time.slice(0, 2)) * 60 + Number(o.time.slice(3, 5));
            busy.push({ s: sm, e: sm + (o.durationMinutes || 30) });
        }
        const out = [];
        const now = new Date();
        const isToday = dayIso === catDays()[0].iso;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        for (let m = wr.from; m + dur <= wr.to; m += 30) {
            if (isToday && m < nowMin) continue;
            if (busy.some(b => m < b.e && m + dur > b.s)) continue;
            out.push(m);
        }
        return out;
    }

    function itemComplete(a) {
        if (lockedDoctor) return true;
        if (!a.__needsDoc) return true;
        if (a.doctor && (a.doctor.scheduling_mode || 'schedulable') === 'live_queue') return true;   // SVC_LIVE_QUEUE_V1
        return !!(a.doctor && a.startISO);
    }
    function cartComplete() { return state.added.length > 0 && state.added.every(itemComplete); }

    // WIZ_TEMPLATES_V1 — шаблоны сметы (service_templates, mig 104): имя + список
    // service_ids. Врач/время НЕ сохраняются — выбираются при каждой записи.
    function saveCartTemplate() {
        if (!state.added.length) return;
        const ov = h('div', { class: 'modal', style: { zIndex: '170' } });
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: () => ov.remove() }));
        const nameIn = h('input', { class: 'tp-input', placeholder: 'Название шаблона', style: { width: '100%', marginTop: '10px' } });
        const doSave = async (btn) => {
            const name = nameIn.value.trim();
            if (!name) { toast(tr('Введите название шаблона'), 'fail'); return; }
            btn.disabled = true;
            const ids = state.added.map(a => a.service && a.service.id).filter(Boolean);
            const ins = { name, service_ids: ids, active: true };
            if (window.CLINIC && window.CLINIC.id) ins.company_id = window.CLINIC.id;
            const { error } = await supabase.from('service_templates').insert(ins);
            if (error) {
                // Only schema errors mean "apply the migration" — anything else
                // (RLS etc.) must surface its REAL message, not a misleading hint.
                const schemaErr = /schema cache|does not exist|column/i.test(error.message || '');
                const msg = schemaErr ? tr('Примените миграцию 104 в Supabase SQL editor.') : error.message;
                toast(tr('Шаблон не сохранён') + ': ' + msg, 'fail'); btn.disabled = false; return;
            }
            toast(tr('Шаблон сохранён'), 'ok');
            ov.remove();
        };
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(ov.querySelector('.btn-primary')); });
        ov.appendChild(h('div', { class: 'modal-card', style: { width: '380px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, 'Сохранить как шаблон'),
                h('button', { class: 'modal-close', onclick: () => ov.remove() }, '×')),
            h('div', { class: 'modal-body', style: { display: 'block' } },
                h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Шаблон сохранит список услуг — врач и время выбираются при записи.'),
                nameIn),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', onclick: () => ov.remove() }, 'Отмена'),
                h('button', { class: 'btn btn-primary', onclick: (e) => doSave(e.currentTarget) }, 'Сохранить'))));
        document.body.appendChild(ov);
        setTimeout(() => nameIn.focus(), 50);
    }

    async function openTemplatePicker() {
        const ov = h('div', { class: 'modal', style: { zIndex: '170' } });
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: () => ov.remove() }));
        const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '50vh', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '14px', textAlign: 'center' } }, 'Загрузка…'));
        ov.appendChild(h('div', { class: 'modal-card', style: { width: '420px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, 'Шаблоны'),
                h('button', { class: 'modal-close', onclick: () => ov.remove() }, '×')),
            h('div', { class: 'modal-body', style: { display: 'block' } }, listEl),
            h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => ov.remove() }, 'Закрыть'))));
        document.body.appendChild(ov);
        let q = supabase.from('service_templates').select('id, name, service_ids').eq('active', true).order('name');
        if (window.CLINIC && window.CLINIC.id) q = q.eq('company_id', window.CLINIC.id);
        const { data, error } = await q;
        clear(listEl);
        if (error) {
            listEl.appendChild(h('div', { class: 'muted', style: { padding: '10px', textAlign: 'center' } },
                /schema cache|does not exist|column/i.test(error.message || '') ? 'Примените миграцию 104 в Supabase SQL editor.' : error.message));
            return;
        }
        if (!data || !data.length) {
            listEl.appendChild(h('div', { class: 'muted', style: { padding: '14px', textAlign: 'center' } }, 'Нет сохранённых шаблонов.'));
            return;
        }
        for (const t of data) {
            const ids = Array.isArray(t.service_ids) ? t.service_ids : [];
            const row = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', border: '1px solid var(--ink-100, #e8ecef)', borderRadius: '10px', padding: '9px 12px' } },
                h('button', { type: 'button', style: { flex: '1 1 auto', minWidth: 0, border: '0', background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', padding: '0' },
                    onclick: async () => { ov.remove(); await applyServiceTemplate(t); } },
                    h('div', { style: { fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.name),
                    h('div', { class: 'muted', style: { fontSize: '11px' } }, tr('услуг') + ': ' + ids.length)),
                h('button', { type: 'button', title: 'Удалить шаблон',
                    style: { border: '0', background: 'none', cursor: 'pointer', color: 'var(--crit-600, #dc2626)', fontSize: '15px', flex: 'none', padding: '2px 4px' },
                    onclick: async (e) => {
                        e.stopPropagation();
                        const { error: dErr } = await supabase.from('service_templates').update({ active: false }).eq('id', t.id);
                        if (dErr) { toast(dErr.message, 'fail'); return; }
                        row.remove(); toast(tr('Шаблон удалён'), 'ok');
                    } }, '×'));
            listEl.appendChild(row);
        }
    }

    async function applyServiceTemplate(t) {
        const ids = Array.isArray(t.service_ids) ? t.service_ids : [];
        let added = 0, missing = 0;
        for (const id of ids) {
            const svc = state.services.find(s => s.id === id);
            if (!svc) { missing++; continue; }
            const before = state.added.length;
            await catAdd(svc);
            if (state.added.length > before) added++;
        }
        paintCatalog();
        toast(tr('Шаблон применён') + ': +' + added + (missing ? ' · ' + tr('не найдено услуг') + ': ' + missing : ''), missing ? 'warn' : 'ok');
    }

    async function catAdd(svc) {
        if (state.added.some(x => x.service.id === svc.id)) return;
        const dur = Math.max(5, Number(svc.duration_minutes || 30));
        if (lockedDoctor) {
            const doc = { id: lockedDoctor.id, full_name: lockedDoctor.name || lockedDoctor.full_name || '', specialty: lockedDoctor.spec || '' };
            const d = scheduledISO ? new Date(scheduledISO) : new Date();
            state.added.push({
                service: svc.__consult ? { ...svc, price: svcPrice(svc, doc.id) } : svc, doctor: doc,
                dateIso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
                startISO: scheduledISO || null, durationMinutes: dur, __needsDoc: false,
            });
            paintCatalog();
            return;
        }
        const perf = svcPerformers(svc);
        // SVC_NO_DOCTOR_V1 — «Без врача» (services.requires_doctor = false) means the
        // service is performed without a named doctor (КТ/лаборатория/процедурный
        // кабинет). Never block the wizard on a doctor+time pick for it, even when
        // performers happen to be linked to the service. Consultations always need one.
        const needsDoc = (svc.requires_doctor === false && !svc.__consult)
            ? false
            : (perf.length > 0 || !!svc.__consult);
        const item = { service: svc, doctor: null, dateIso: null, time: null, startISO: null,
            durationMinutes: dur, __needsDoc: needsDoc, __dayIso: catDays()[0].iso, __auto: false };
        state.added.push(item);
        paintCatalog();
        if (needsDoc && perf.length === 1) await catPickDoc(item, perf[0], true);
    }
    function catRemove(item) {
        const i = state.added.indexOf(item);
        if (i >= 0) state.added.splice(i, 1);
        paintCatalog();
    }
    async function catPickDoc(item, doc, auto) {
        item.doctor = doc;
        if (item.service.__consult) item.service = { ...item.service, price: consultPriceFor(doc.id, item.service.__ct || item.service) };
        item.startISO = null; item.time = null; item.dateIso = null;
        // SVC_LIVE_QUEUE_V1 — live-queue doctors are served without a time; no slot pick.
        if ((doc.scheduling_mode || 'schedulable') === 'live_queue') { paintCatalog(); return; }
        await ensureDocSlots(doc.id);
        if (item.doctor !== doc || !state.added.includes(item)) return;   // CATALOG_WIZARD_V2 — stale: switched/removed mid-fetch
        for (const d of catDays()) {
            const f = freeStarts(doc.id, d.iso, item.durationMinutes, item);
            if (f.length) { item.__dayIso = d.iso; catPickTime(item, d.iso, f[0], !!auto); return; }
        }
        item.__dayIso = catDays()[0].iso;
        paintCatalog();
    }
    function catPickTime(item, dayIso, m, auto) {
        item.__dayIso = dayIso;
        item.dateIso = dayIso;
        item.time = fmtMin(m);
        item.startISO = new Date(`${dayIso}T${fmtMin(m)}:00`).toISOString();
        item.__auto = !!auto;
        item.__editSlot = false;   // COLLAPSE_SLOT_V1 — picking a time re-collapses the picker
        paintCatalog();
    }

    function mountCatalog() {
        clear(body);
        cat2.win = CAT_PAGE;
        catCtxEl = h('div', { class: 'wzc-ctx' });
        const searchIn = h('input', { class: 'wzc-search', type: 'search', value: cat2.q,
            placeholder: lockedDoctor ? 'Поиск по услугам врача…' : 'Поиск услуги или врача…' });
        catSearchEl = searchIn;
        searchIn.addEventListener('input', () => {
            clearTimeout(searchIn._t);
            searchIn._t = setTimeout(() => { cat2.q = searchIn.value; cat2.win = CAT_PAGE; paintCatGroups(); paintCatList(); }, 200);
        });
        catGroupsEl = h('div', { class: 'wzc-groups' });
        catListEl = h('div', null);
        // WIZ_RAIL_SCROLL_V1 — the rail is a viewport-capped flex column: the
        // service rows scroll in the middle while the payment block, totals and
        // CTA stay pinned at the bottom of the смета.
        catRailEl = h('div', { class: 'wzc-rail', style: { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 235px)' } });
        // WIZ_TEMPLATES_V1 — поиск делит строку с кнопкой «Выбрать шаблон».
        // .wzc-search несёт margin-bottom:10px — внутри строки он смещал кнопку
        // ниже; переносим отступ на саму строку и выравниваем высоты (38px).
        searchIn.style.marginBottom = '0';
        const tplBtn = h('button', { class: 'btn btn-outline', type: 'button',
            style: { flex: 'none', whiteSpace: 'nowrap', height: '38px' },
            onclick: () => openTemplatePicker() }, 'Выбрать шаблон');
        const searchRow = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '10px' } },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, searchIn), tplBtn);
        body.appendChild(catCtxEl);
        body.appendChild(h('div', { class: 'wzc-grid' },
            h('div', { style: { minWidth: 0 } }, searchRow, catGroupsEl, catListEl),
            catRailEl));
        paintCatalog();
        paintWizChips(); paintWizFooter();
    }
    function paintCatalog() {
        if (!catListEl || !catListEl.isConnected) { if (!catListEl) return; }
        paintCatCtx(); paintCatGroups(); paintCatList(); paintCatRail();
    }
    function paintCatCtx() {
        clear(catCtxEl);
        const chips = [];
        if (scheduledISO) {
            const d = new Date(scheduledISO);
            chips.push(h('span', { class: 'wzc-chip' },
                `${CAT_WD[d.getDay()]}, ${d.getDate()} ${CAT_MO[d.getMonth()]} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`));
        }
        if (lockedDoctor) chips.push(h('span', { class: 'wzc-chip' },
            h('span', { class: 'wzc-av' }, initials(lockedDoctor.name || '')),
            ` ${lockedDoctor.name || ''}${lockedDoctor.spec ? ' · ' + lockedDoctor.spec : ''}`));
        const p = refs.attachedPatient;
        if (p && patient) {
            const nm = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
            chips.push(h('span', { class: 'wzc-chip' },
                h('span', { class: 'wzc-av', style: { background: '#c47d12' } }, p.initials || initials(nm)),
                ` ${nm}${p.mrn ? ' · ' + p.mrn : ''}${p.phone ? ' · ' + p.phone : ''}`));
        }
        for (const c of chips) catCtxEl.appendChild(c);
        catCtxEl.style.display = chips.length ? '' : 'none';
    }
    function paintCatGroups() {
        clear(catGroupsEl);
        const counts = {};
        const elig = catEligible();
        for (const s of elig) { const g = String(svcGroupId(s) || ''); counts[g] = (counts[g] || 0) + 1; }
        const mk = (id, name, n) => h('button', { class: 'wzc-cat' + (cat2.group === id ? ' on' : ''), type: 'button',
            onclick: () => { cat2.group = id; cat2.win = CAT_PAGE; paintCatGroups(); paintCatList(); } }, `${name} · ${n}`);
        catGroupsEl.appendChild(mk('', 'Все', elig.length));
        for (const t of state.types) { const n = counts[String(t.id)] || 0; if (n) catGroupsEl.appendChild(mk(String(t.id), t.name, n)); }
        if (lockedDoctor) catGroupsEl.appendChild(h('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11px', alignSelf: 'center' } },
            trf('только услуги: {name}', { name: lockedDoctor.name || '' })));
    }
    function paintCatList() {
        clear(catListEl);
        // HIDE_SCHEDULED_V1 — once a service has its doctor + time it drops out of the
        // list (it lives in the Смета); «изменить» there sets __editSlot to re-show it.
        const unfiltered = catFiltered();
        const list = unfiltered.filter(s => {
            const it = state.added.find(x => x.service.id === s.id);
            // Hide only after the registrar EXPLICITLY picks the doctor + time. The
            // auto-suggested slot (__auto) keeps the service visible so they can see
            // and confirm/adjust it first; clicking a time clears __auto -> hides.
            return !(it && itemComplete(it) && !it.__auto && !it.__editSlot);
        });
        if (!list.length) {
            const allAdded = unfiltered.length > 0;
            catListEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                allAdded ? 'Все подходящие услуги добавлены — см. смету' : 'Ничего не найдено'));
            return;
        }
        for (const s of list.slice(0, cat2.win)) catListEl.appendChild(catRow(s));
        if (list.length > cat2.win) {
            catListEl.appendChild(h('button', { class: 'btn btn-outline', style: { width: '100%', marginTop: '4px' }, type: 'button',
                onclick: () => { cat2.win += CAT_PAGE; paintCatList(); } },
                trf('Показать ещё {n} · всего {total}', { n: Math.min(CAT_PAGE, list.length - cat2.win), total: list.length })));
        }
    }
    function catRow(s) {
        const item = state.added.find(x => x.service.id === s.id);
        const perf = lockedDoctor ? [] : svcPerformers(s);
        const price = item ? Number(item.service.price || 0) : svcPrice(s, lockedDoctor ? lockedDoctor.id : null);
        let priceLabel = formatMoney(price);
        if (s.__consult && !s.__consultDoctorId && !lockedDoctor && !item) {   // CONSULT_PRICE_RANGE_V1 — aggregate only; per-doctor rows show the doctor's own price
            const rng = consultPriceRange(s.__ct || s);
            if (rng) priceLabel = (rng.min === rng.max) ? formatMoney(rng.min) : ('\u043e\u0442 ' + formatMoney(rng.min));
        }
        const dur = Math.max(5, Number(s.duration_minutes || 30));
        // CONSULT_NAME_OVERRIDE_V1 — show the per-doctor name when a doctor is locked or picked.
        const _docCtx = s.__consult ? (lockedDoctor ? lockedDoctor.id : (item && item.doctor ? item.doctor.id : null)) : null;
        const dispName = _docCtx ? consultNameFor(_docCtx, s.__ct || s) : s.name;
        const subBits = [s.__consultDocName ? s.__consultDocName : groupNameOf(s), trf('{n} мин', { n: dur })];   // CONSULT_PER_DOCTOR_ROWS_V1
        if (!lockedDoctor && !s.__consult && perf.length === 0) subBits.push('врач не требуется');
        // ATTACH_CATALOG_V1 — a service already on the visit can't be added again.
        // The columns view has always greyed these out (excludeServiceIds); the
        // catalog didn't, so the row looked addable and only failed on insert.
        const onVisit = !item && excludeServiceIds.indexOf(s.id) !== -1;
        const row = h('div', { class: 'wzc-svc' + (item ? ' added' : '') + (onVisit ? ' added' : '') });
        if (onVisit) row.style.opacity = '0.55';
        row.appendChild(h('div', { class: 'wzc-svc-top' },
            h('div', { style: { minWidth: 0 } },
                h('div', { class: 'wzc-svc-nm' }, dispName,
                    item ? h('span', { class: 'wzc-ok' }, ' — добавлено') : null,
                    onVisit ? h('span', { class: 'wzc-ok' }, ' — уже в визите') : null),
                h('div', { class: 'wzc-svc-sub' }, subBits.filter(Boolean).join(' · '))),
            h('div', { class: 'row', style: { gap: '10px', flex: 'none', alignItems: 'center' } },
                h('span', { class: 'num', style: { fontWeight: 700 } }, priceLabel),
                item ? h('button', { class: 'wzc-rm', type: 'button', onclick: () => catRemove(item) }, 'убрать')
                     : h('button', { class: 'wzc-add', type: 'button', disabled: onVisit ? '' : undefined,
                         title: onVisit ? 'Эта услуга уже добавлена в визит' : null,
                         onclick: () => { if (!onVisit) catAdd(s); } }, 'Добавить'))));
        if (item && !lockedDoctor && item.__needsDoc) row.appendChild(catPickerPanel(item, perf));
        if (item && !lockedDoctor && !item.__needsDoc) row.appendChild(h('div', { class: 'wzc-picker' },
            h('div', { class: 'wzc-lbl' }, 'Врач не требуется — выполняется в день визита')));
        return row;
    }
    function catPickerPanel(item, perf) {
        const box = h('div', { class: 'wzc-picker' });
        box.appendChild(h('div', { class: 'wzc-lbl' }, 'Врач'));
        // SVC_DOC_DROPDOWN_V1 — searchable dropdown replaces the chip grid.
        if (item.doctor) {
            box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('span', { class: 'wzc-doc on', style: { cursor: 'default' } },
                    h('span', { class: 'wzc-av' }, initials(item.doctor.full_name || '')),
                    ` ${item.doctor.full_name || '—'}`,
                    item.doctor.specialty ? h('span', { class: 'muted', style: { fontWeight: 500 } }, ' · ' + item.doctor.specialty) : null,
                    item.service.__consult ? h('span', { class: 'num', style: { marginLeft: '6px', fontWeight: 700 } }, formatMoney(consultPriceFor(item.doctor.id, item.service.__ct || item.service))) : null),
                (item.doctor.scheduling_mode || 'schedulable') === 'live_queue' ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '· живая очередь') : null,
                h('button', { class: 'btn btn-sm btn-outline', type: 'button', style: { flex: 'none' },
                    onclick: () => { item.doctor = null; item.startISO = null; item.time = null; item.dateIso = null; paintCatalog(); } }, 'Изменить')));
        } else {
            const search = h('input', { type: 'search', placeholder: 'Поиск врача…',
                style: { width: '100%', maxWidth: '340px', height: '34px', padding: '0 10px', border: '1px solid var(--ink-200, #d1d5db)', borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit' } });
            const listBox = h('div', { style: { marginTop: '6px', maxHeight: '190px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '3px' } });
            const paintOpts = () => {
                listBox.replaceChildren();
                const q = search.value.trim().toLowerCase();
                const rows = perf.filter(d => !q || (d.full_name || '').toLowerCase().includes(q) || (d.specialty || '').toLowerCase().includes(q));
                if (!rows.length) { listBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', padding: '6px' } }, 'Врач не найден')); return; }
                for (const d of rows) {
                    listBox.appendChild(h('button', { class: 'wzc-doc', type: 'button', style: { justifyContent: 'flex-start', textAlign: 'left' },
                        onclick: () => catPickDoc(item, d, false) },
                        h('span', { class: 'wzc-av' }, initials(d.full_name || '')),
                        ` ${d.full_name || '—'}`,
                        d.specialty ? h('span', { class: 'muted', style: { fontWeight: 500 } }, ' · ' + d.specialty) : null,
                        (d.scheduling_mode || 'schedulable') === 'live_queue' ? h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, '· живая очередь') : null,
                        item.service.__consult ? h('span', { class: 'num', style: { marginLeft: 'auto', fontWeight: 700 } }, formatMoney(consultPriceFor(d.id, item.service.__ct || item.service))) : null));
                }
            };
            search.addEventListener('input', paintOpts);
            box.appendChild(search);
            box.appendChild(listBox);
            paintOpts();
        }
        if (item.doctor && (item.doctor.scheduling_mode || 'schedulable') === 'live_queue') {
            box.appendChild(h('div', { class: 'wzc-tsum', style: { marginTop: '8px' } }, 'Живая очередь — визит без времени (в день визита).'));
            return box;
        }
        if (item.doctor) {
            const strip = h('div', { class: 'wzc-days' });
            for (const d of catDays()) {
                const free = freeStarts(item.doctor.id, d.iso, item.durationMinutes, item).length;
                strip.appendChild(h('button', {
                    class: 'wzc-day' + (item.__dayIso === d.iso ? ' on' : '') + (free === 0 ? ' none' : ''), type: 'button',
                    onclick: free === 0 ? null : () => { item.__dayIso = d.iso; paintCatalog(); } },
                    h('span', { class: 'wd' }, d.today ? 'сегодня' : d.wd),
                    h('span', { class: 'dd' }, String(d.dd)),
                    h('span', { class: 'free' }, free === 0 ? tr('нет') : trf('{n} окн.', { n: free }))));
            }
            box.appendChild(strip);
            const slots = freeStarts(item.doctor.id, item.__dayIso, item.durationMinutes, item);
            const selM = (item.time && item.dateIso === item.__dayIso)
                ? Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3, 5)) : null;
            const tg = h('div', { class: 'wzc-tgroups' });
            for (const [g, f, to] of [['Утро', 0, 720], ['День', 720, 1020], ['Вечер', 1020, 1440]]) {
                const part = slots.filter(m => m >= f && m < to);
                if (!part.length) continue;
                tg.appendChild(h('div', { class: 'wzc-tg' },
                    h('div', { class: 'glbl' }, g),
                    h('div', { class: 'slots' }, ...part.map(m =>
                        h('button', { class: 'wzc-tm' + (selM === m ? ' on' : ''), type: 'button',
                            onclick: () => catPickTime(item, item.__dayIso, m, false) }, fmtMin(m))))));
            }
            box.appendChild(tg);
            if (item.time && item.dateIso) {
                const d = catDays().find(x => x.iso === item.dateIso);
                const startM = Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3, 5));
                box.appendChild(h('div', { class: 'wzc-tsum' },
                    h('span', null, (d ? (d.today ? tr('Сегодня') : tr(d.wd) + ', ' + d.dd + ' ' + tr(d.mo)) : item.dateIso) + ' · ',
                        h('b', { class: 'num' }, `${item.time}–${fmtMin(startM + item.durationMinutes)}`),
                        ' · ' + trf('{n} мин', { n: item.durationMinutes })),
                    item.__auto ? h('span', { class: 'auto' }, 'ближайшее свободное — можно изменить') : null));
            } else {
                box.appendChild(h('div', { class: 'wzc-tsum off' }, 'выберите время'));
            }
        }
        return box;
    }
    function paintCatRail() {
        clear(catRailEl);
        // WIZ_TEMPLATES_V1 — заголовок сметы + «Сохранить как шаблон» (когда есть услуги).
        catRailEl.appendChild(h('div', { class: 'wzc-rail-h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('span', null, 'Смета'),
            state.added.length ? h('button', { class: 'btn btn-sm btn-amber', type: 'button',
                style: { flex: 'none', whiteSpace: 'nowrap', textTransform: 'none', letterSpacing: 'normal' },
                onclick: () => saveCartTemplate() }, 'Сохранить как шаблон') : null));
        const p = refs.attachedPatient;
        if (p) {
            const nm = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
            catRailEl.appendChild(h('div', { class: 'wzc-pat' },
                h('span', { class: 'wzc-av', style: { background: '#c47d12' } }, p.initials || initials(nm)),
                h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { style: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nm),
                    h('div', { class: 'muted', style: { fontSize: '11px' } }, [p.mrn, p.phone].filter(Boolean).join(' · ') || '—')),
                patient ? null : h('button', { class: 'x', type: 'button', title: 'Отвязать пациента',
                    onclick: () => { refs.attachedPatient = null; wiz.depositBalance = null; wiz._prefilled = false; wiz.applied = []; wiz.payment.discountPct = null; wiz.payment.payerId = null; wiz.payment.policyId = null; wiz.payment.policyNumber = ''; paintCatalog(); } }, '×')));
        } else {
            catRailEl.appendChild(h('button', { class: 'wzc-attach', type: 'button', onclick: () => openAttachPatientModal() },
                h('div', { style: { fontWeight: 700, color: 'var(--primary-700)' } }, 'Привязать пациента'),
                h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, 'поиск по ФИО / телефону · или создать нового')));
        }
        if (state.added.length) {
            // WIZ_RAIL_SCROLL_V1 — rows scroll; money block below stays visible.
            const rowsWrap = h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: '90px' } });
            for (const a of state.added) {
                let who;
                if (!itemComplete(a)) who = h('button', { class: 'wzc-warn', type: 'button',
                    style: { background: 'none', border: '0', padding: '0', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' },
                    onclick: () => { cat2.q = a.service.name; cat2.group = ''; cat2.win = CAT_PAGE;
                        if (catSearchEl) catSearchEl.value = cat2.q; paintCatalog(); } },
                    'выберите врача и время');
                else if (a.doctor) who = h('div', { class: 'muted', style: { fontSize: '11px' } },
                    `${a.doctor.full_name || ''}${a.time ? ' · ' + (a.dateIso === catDays()[0].iso ? 'сегодня' : (a.dateIso || '').slice(8) + '.' + (a.dateIso || '').slice(5, 7)) + ' ' + a.time : ''}`);
                else who = h('div', { class: 'muted', style: { fontSize: '11px' } }, 'процедурный кабинет');
                rowsWrap.appendChild(h('div', { class: 'wzc-ln' },
                    h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: '12.5px' } }, a.service.name), who),
                    h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: 'none' } },
                        h('span', { class: 'num', style: { fontWeight: 700 } }, formatMoney(Number(a.service.price || 0))),
                        itemComplete(a) ? h('button', { type: 'button', title: 'Изменить врача и время',
                            style: { border: '0', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: '11px', color: 'var(--primary-700, #115d5a)', textDecoration: 'underline', padding: '0', flex: 'none' },
                            onclick: () => { a.__editSlot = true; cat2.q = a.service.name; cat2.group = ''; cat2.win = CAT_PAGE; if (catSearchEl) catSearchEl.value = a.service.name; paintCatalog(); } }, 'изменить') : null,
                        h('button', { type: 'button', title: 'Убрать услугу', 'aria-label': 'Убрать услугу',
                            style: { border: '0', background: 'none', cursor: 'pointer', color: 'var(--crit-600, #dc2626)', fontSize: '16px', lineHeight: '1', padding: '2px 4px', flex: 'none' },
                            onclick: () => catRemove(a) }, '×'))));
            }
            catRailEl.appendChild(rowsWrap);   // WIZ_RAIL_SCROLL_V1
        } else {
            catRailEl.appendChild(h('div', { class: 'wzc-empty' }, 'Услуги появятся здесь'));
        }
        // WIZ_PAY_RAIL_V1 — оплата живёт в смете: кто платит / скидка / промо / баланс.
        // ATTACH_CATALOG_V1 — discounts/payer/balance belong to the visit's own invoice.
        if (!attachMode && refs.attachedPatient && state.added.length) catRailEl.appendChild(buildRailPayment());
        const totBox = h('div', null);
        const ctaBtn = h('button', { class: 'wzc-cta', type: 'button',
            onclick: () => {
                if (attachMode) { if (cartComplete()) attachCartToVisit(ctaBtn); return; }
                if (cartComplete() && refs.attachedPatient && wizStep2Valid()) wizGoto(2);
            } }, attachMode ? 'Добавить к визиту' : 'Далее: Направление');
        const hintEl = h('div', { class: 'wzc-hint' });
        const refreshRail = () => {
            const wt = wizTotals();
            clear(totBox);
            totBox.appendChild(h('div', { class: 'wzc-tot' },
                h('span', null, 'Итого'), h('span', { class: 'num' }, formatMoney(wt.full))));
            if (wiz.payment.mode === 'patient') {
                const line = (lbl, v) => h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: '12px', color: 'var(--ink-500, #55636d)' } },
                    h('span', null, lbl), h('span', { class: 'num' }, '−' + formatMoney(v)));
                if (wt.full - wt.afterDisc > 0) totBox.appendChild(line(trf('Скидка {n}%', { n: wizDiscountPct() }), wt.full - wt.afterDisc));
                if (wt.promoOff > 0) totBox.appendChild(line('Промокод', wt.promoOff));
                if (wt.cards > 0) totBox.appendChild(line('Карты/сертификаты', wt.cards));
                if (wt.bal > 0) totBox.appendChild(line('Баланс', wt.bal));
                if (wt.due !== wt.full) totBox.appendChild(h('div', { class: 'wzc-tot', style: { borderTop: '1px dashed var(--ink-100, #e8ecef)', marginTop: '4px' } },
                    h('span', null, 'К оплате'), h('span', { class: 'num', style: { color: 'var(--primary-600, #0d8a72)' } }, formatMoney(wt.due))));
            } else {
                totBox.appendChild(h('div', { class: 'muted', style: { fontSize: '11.5px', margin: '2px 0 4px' } },
                    'Покрывает плательщик — распределение на шаге «Кто платит».'));
            }
            // ATTACH_CATALOG_V1 — attaching needs only a complete cart; the
            // patient is fixed (the visit's) and there is no payer to choose.
            const ok = attachMode ? cartComplete()
                : (cartComplete() && !!refs.attachedPatient && wizStep2Valid());
            ctaBtn.disabled = !ok;
            hintEl.textContent =
                state.added.length === 0 ? 'добавьте хотя бы одну услугу'
                : !cartComplete() ? 'у некоторых услуг не выбран врач или время'
                : attachMode ? trf('всё готово — услуг: {n}', { n: state.added.length })
                : !refs.attachedPatient ? 'привяжите пациента'
                : !wizStep2Valid() ? 'выберите плательщика'
                : trf('всё готово — услуг: {n}', { n: state.added.length });
        };
        wiz._railRefresh = refreshRail;
        refreshRail();
        catRailEl.appendChild(totBox);
        catRailEl.appendChild(ctaBtn);
        catRailEl.appendChild(hintEl);
    }

    // ATTACH_CATALOG_V1 — hand the смета to the caller one row at a time, in the
    // shape the 3-column picker produced ({service, doctor, startISO}), so
    // visit-modal's addServiceFromPicker keeps working untouched. Closes only if
    // at least one row landed; a total failure leaves the cart on screen so the
    // registrar can see what happened and retry.
    async function attachCartToVisit(btn) {
        if (!state.added.length || typeof onPick !== 'function') return;
        const rows = state.added.slice();
        if (btn) { btn.disabled = true; btn.textContent = 'Добавляем…'; }
        let added = 0, failed = 0;
        for (const a of rows) {
            try {
                await onPick({ service: a.service, doctor: a.doctor || null, startISO: a.startISO || null });
                added++;
            } catch (e) {
                failed++;
                console.warn('[picker attach]', (a.service && a.service.name) || '?', e && e.message);
            }
        }
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Добавить к визиту'; }
        if (added && !failed)      toast(added === 1 ? 'Услуга добавлена к визиту.' : trf('Добавлено услуг: {n}.', { n: added }));
        else if (added && failed)  toast(trf('Добавлено {ok}, не удалось {bad} — проверьте список.', { ok: added, bad: failed }), 'warn');
        else                       { toast('Не удалось добавить услуги.', 'fail'); return; }
        // CRM_SCHEDULE_V1 — the patient came and the service was attached, so the
        // request is fulfilled. Without this it stays «Записан», and crm.js's
        // overnight sweep (status scheduled/approved + scheduled_date < today ->
        // 'no_show') would mark a patient who actually attended as a no-show.
        if (added) await closeCrmRequests();
        overlay.remove();
    }

    // CRM_SCHEDULE_V1 — mark the prefilled requests as converted. Best-effort:
    // the services are already on the visit, so a failure here must not surface
    // as "adding failed".
    async function closeCrmRequests() {
        const lineIds = state.crmLineIds || [];
        const reqIds  = state.crmRequestIds || [];
        if (!lineIds.length) return;
        try {
            // The LINES that were actually attached are done.
            await supabase.from('crm_request_services')
                .update({ status: 'done' })
                .in('id', lineIds);

            // CRM_MULTI_SERVICE_V1 — the parent only becomes «Пришёл» once it has
            // nothing pending left. A request booked across three days must stay
            // open after the first visit, or the other two days would vanish from
            // the registrar's prefill.
            for (const rid of reqIds) {
                const { data: left } = await supabase.from('crm_request_services')
                    .select('id').eq('request_id', rid).eq('status', 'pending').limit(1);
                if (!left || !left.length) {
                    await supabase.from('crm_requests').update({ status: 'came' }).eq('id', rid);
                }
            }
        } catch (e) {
            console.warn('[picker] CRM request not closed:', e && e.message);
        }
        state.crmLineIds = [];
        state.crmRequestIds = [];
    }

    // WIZ_PAY_RAIL_V1 — «Оплата» в смете: кто платит (+плательщик/полис) для
    // покрытия, скидка/промокод/баланс для самооплаты. Использует существующие
    // wiz.payment / wizTotals / wizApplyCode / ensureWizData; отдельный шаг
    // «Оплата» удалён (WIZ_4STEPS_V1).
    function buildRailPayment() {
        const pm = wiz.payment;
        const box = h('div', { style: { borderTop: '1px solid var(--ink-100, #e8ecef)', margin: '8px 0 4px', paddingTop: '8px' } });
        const refresh = () => { if (wiz._railRefresh) wiz._railRefresh(); };
        if (wiz.payers === null || wiz.depositBalance === null || !wiz._prefilled) {
            ensureWizData().then(() => { if (wiz.step === 1 && box.isConnected) { clear(box); fill(); refresh(); } }).catch(() => {});
        }
        function fill() {
            box.appendChild(h('div', { style: { fontWeight: 700, fontSize: '12px', marginBottom: '6px' } }, 'Кто платит'));
            // WIZ_PAY_RAIL_V3 — сначала ТИП покрытия, затем отдельным полем КОМПАНИЯ
            // из Настроек (Payer management); номер полиса вводится ВРУЧНУЮ и
            // сохраняется в payer_policies при создании визита (WIZ_POLICY_MANUAL_V1).
            const modeSel = h('select', { class: 'tp-input', style: { width: '100%' } },
                h('option', { value: 'patient' }, 'Пациент (самооплата)'),
                h('option', { value: 'insurance' }, 'ДМС / Страховка'),
                h('option', { value: 'corporate' }, 'Корпоративный (B2B)'),
                h('option', { value: 'state' }, 'ОМС / госпрограмма'));
            modeSel.value = pm.mode === 'patient' ? 'patient' : pm.coverage;
            modeSel.addEventListener('change', () => {
                const v = modeSel.value;
                if (v === 'patient') { pm.mode = 'patient'; pm.payerId = null; pm.policyId = null; pm.policyNumber = ''; }
                else { pm.mode = 'insurance'; pm.coverage = v; pm.payerId = null; pm.policyId = null; }
                clear(box); fill(); refresh(); paintWizChips(); paintWizFooter();
            });
            box.appendChild(modeSel);
            if (pm.mode !== 'patient') {
                const COV_TYPE = { insurance: 'insurance', corporate: 'corporate', state: 'government' };
                const payerSel = h('select', { class: 'tp-input', style: { width: '100%', marginTop: '6px' } });
                payerSel.appendChild(h('option', { value: '' }, wiz.payers === null ? 'Загрузка…' : '— выберите компанию —'));
                const want = COV_TYPE[pm.coverage];
                for (const x of (wiz.payers || []).filter(x => !want || (x.type || '') === want))
                    payerSel.appendChild(h('option', { value: x.id, selected: pm.payerId === x.id ? '' : null }, x.name || '—'));
                payerSel.addEventListener('change', () => { pm.payerId = payerSel.value || null; pm.policyId = null; refresh(); });
                const polIn = h('input', { class: 'tp-input', placeholder: 'Номер полиса / договора', value: pm.policyNumber || '',
                    style: { width: '100%', marginTop: '6px' },
                    oninput: (e) => { pm.policyNumber = e.target.value; } });
                box.appendChild(payerSel);
                box.appendChild(polIn);
                box.appendChild(h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
                    'Визит сохраняется без счёта — расчёт с плательщиком отдельно (акт).'));
            } else {
                const discIn = h('input', { class: 'tp-input', type: 'number', min: '0', max: '100', step: '1',
                    value: String(wizDiscountPct()), style: { width: '72px' },
                    oninput: (e) => { pm.discountPct = e.target.value; refresh(); } });
                box.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '8px', justifyContent: 'space-between' } },
                    h('span', { style: { fontSize: '12.5px' } }, 'Скидка (лояльность), %'), discIn));
                const codeIn = h('input', { class: 'tp-input', placeholder: 'Промокод / карта / сертификат', style: { flex: '1', minWidth: 0 } });
                const appliedBox = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px' } });
                const paintRailApplied = () => {
                    clear(appliedBox);
                    for (const d of (wiz.applied || [])) {
                        const lbl = d.kind === 'promo_code'
                            ? (d.discount_type === 'amount' ? '−' + formatMoney(d.amount) + ' ' + tr('сум') : `−${Number(d.percent || 0)}%`)
                            : formatMoney(d.remaining ?? d.amount ?? 0) + ' ' + tr('сум');
                        appliedBox.appendChild(h('span', { class: 'tag tag-ok', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px' } },
                            tr(KIND_RU3[d.kind] || d.kind) + ' ' + d.code + ' · ' + lbl,
                            h('button', { type: 'button', style: { background: 'none', border: '0', cursor: 'pointer', color: 'inherit', fontWeight: 700 },
                                onclick: (e) => { e.stopPropagation(); wiz.applied = wiz.applied.filter(x => x !== d); paintRailApplied(); refresh(); } }, '×')));
                    }
                };
                const applyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async (ev) => {
                    const code = codeIn.value.trim(); if (!code) return;
                    ev.currentTarget.disabled = true;
                    try { await wizApplyCode(code); codeIn.value = ''; paintRailApplied(); refresh(); }
                    finally { if (ev.currentTarget && ev.currentTarget.isConnected) ev.currentTarget.disabled = false; }
                } }, 'Применить');
                box.appendChild(h('div', { class: 'row', style: { gap: '6px', marginTop: '8px' } }, codeIn, applyBtn));
                box.appendChild(appliedBox);
                paintRailApplied();
                const balAvail = Number(wiz.depositBalance || 0);
                if (balAvail > 0) {
                    const balBtn = h('button', { class: 'btn btn-sm ' + (pm.useBal ? 'btn-primary' : 'btn-outline'), type: 'button',
                        onclick: () => { pm.useBal = !pm.useBal;
                            balBtn.className = 'btn btn-sm ' + (pm.useBal ? 'btn-primary' : 'btn-outline');
                            balBtn.textContent = pm.useBal ? 'Используется' : 'Использовать';
                            refresh(); } },
                        pm.useBal ? 'Используется' : 'Использовать');
                    box.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginTop: '8px' } },
                        h('span', { style: { fontSize: '12px' } }, 'Баланс: ', h('b', { class: 'num' }, formatMoney(balAvail))), balBtn));
                }
            }
        }
        fill();
        return box;
    }

    // =======================================================================
    // BOOK_WIZARD_V1 — steps 2 (Оплата) + 3 (Подтверждение) + save sequence.
    // Replaces the old handoff to openCreateVisitModal: the wizard now creates
    // the visit (+ invoice for patient-pays) itself.
    // =======================================================================
    function wizGoto(n) {
        if (!calculator) return;
        if (n < 1) n = 1;
        if (n >= 2 && (!refs.attachedPatient || state.added.length === 0 || !cartComplete())) {
            toast('Добавьте услуги, врача/время и привяжите пациента.', 'fail'); return;
        }
        // WIZ_4STEPS_V1 — Оплата удалён (оплата живёт в смете, WIZ_PAY_RAIL_V1);
        // шаг 3 «Кто платит» пропускается при самооплате (нечего распределять).
        if (n > 4) n = 4;
        if (n === 3 && wiz.payment.mode === 'patient') n = (wiz.step >= 3) ? 2 : 4;
        wiz.step = n;
        if (n === 1) { mountCatalog(); return; }   // re-renders chips/footer itself
        clear(body);
        body.appendChild(n === 2 ? buildStepReferral() : n === 3 ? buildStepCoverage() : buildConfirm());
        paintWizChips(); paintWizFooter();
    }

    function paintWizChips() {
        if (!calculator) return;
        clear(wizChipsEl);
        // WIZ_4STEPS_V1 — 4 шага; «Кто платит» затемняется при самооплате (пропускается).
        const _selfPay = wiz.payment.mode === 'patient';
        const items = [[1, 'Услуги и пациент'], [2, 'Направление'], [3, 'Кто платит'], [4, 'Подтверждение']];
        for (const [n, label] of items) {
            const skipped = n === 3 && _selfPay;
            const cls = 'pkw-step' + (wiz.step === n ? ' on' : (wiz.step > n && !skipped ? ' done' : ''));
            const props = { class: cls, type: 'button',
                onclick: () => { if (!skipped && n < wiz.step) wizGoto(n); } };
            if (skipped) { props.disabled = ''; props.style = { opacity: '0.45' }; props.title = 'Пациент платит сам — распределение не требуется'; }
            wizChipsEl.appendChild(h('button', props,
                h('span', { class: 'n' }, (wiz.step > n && !skipped) ? '✓' : String(n)), label));
        }
    }

    function paintWizFooter() {
        if (!calculator) return;
        addAnotherBtn.style.display = 'none';   // CATALOG_WIZARD_V1 — смета rail owns the step-1 CTA
        summary.style.display       = 'none';
        wizBackBtn.style.display    = wiz.step > 1 ? '' : 'none';
        wizNextBtn.style.display    = (wiz.step >= 2 && wiz.step <= 3) ? '' : 'none';   // WIZ_4STEPS_V1
        wizNextBtn.disabled         = false;
        wizCreateBtn.style.display  = wiz.step === 4 ? '' : 'none';
        wizCreateLabel.textContent  = (wiz.payment.mode === 'patient' && covHasPatient()) ? ' Создать визит и счёт' : ' Создать визит';
    }

    function wizStep2Valid() {
        if (wiz.payment.mode === 'patient') return true;
        return !!wiz.payment.payerId;
    }

    function wizDiscountPct() {
        return Math.min(100, Math.max(0, Number(wiz.payment.discountPct) || 0));
    }
    function wizDiscounted(n) {
        return Math.round(Number(n || 0) * (1 - wizDiscountPct() / 100));
    }
    function wizTotals() {
        const full = calcCartTotal();
        const isPatient = wiz.payment.mode === 'patient';
        const afterDisc = isPatient ? state.added.reduce((s, a) => s + wizDiscounted(a.service?.price), 0) : full;
        // CATALOG_WIZARD_V3 — application order: loyalty % -> promo -> gift/cert cards -> balance.
        const promoOff = isPatient ? wizPromoOff(afterDisc) : 0;
        const payable = Math.max(0, afterDisc - promoOff);
        const cards = isPatient ? Math.min(wizCardsAvail(), payable) : 0;
        const bal = (isPatient && wiz.payment.useBal) ? Math.min(Number(wiz.depositBalance || 0), payable - cards) : 0;
        return { full, afterDisc, promoOff, payable, cards, bal, due: payable - cards - bal };
    }

    // CATALOG_WIZARD_V3 — promo / gift-card / certificate redemption.
    const KIND_RU3 = { promo_code: 'Промокод', gift_card: 'Карта', certificate: 'Сертификат' };
    function wizPromo() { return (wiz.applied || []).find(x => x.kind === 'promo_code') || null; }
    function wizCards() { return (wiz.applied || []).filter(x => x.kind !== 'promo_code'); }
    function wizCardsAvail() { return wizCards().reduce((s, c) => s + Math.max(0, Number(c.remaining ?? c.amount ?? 0)), 0); }
    function wizPromoOff(base) {
        const pr = wizPromo(); if (!pr) return 0;
        if (pr.discount_type === 'amount') return Math.min(base, Math.round(Number(pr.amount || 0)));
        return Math.round(base * Math.min(100, Math.max(0, Number(pr.percent || 0))) / 100);
    }
    async function wizApplyCode(code) {
        const { data, error } = await supabase.from('patient_discounts')
            .select('*').eq('code', code.toUpperCase()).limit(1);
        if (error) { toast(trf('Скидки недоступны: {msg}', { msg: error.message }), 'fail'); return; }
        const row = (data || [])[0];
        if (!row) { toast('Код не найден.', 'fail'); return; }
        if (!row.active) { toast('Код деактивирован.', 'fail'); return; }
        const today = new Date().toISOString().slice(0, 10);
        if (row.valid_from && row.valid_from > today) { toast('Код ещё не действует.', 'fail'); return; }
        if (row.valid_to && row.valid_to < today) { toast('Срок действия кода истёк.', 'fail'); return; }
        if (row.patient_id && (!refs.attachedPatient || refs.attachedPatient.id !== row.patient_id)) { toast('Код привязан к другому пациенту.', 'fail'); return; }
        if (row.max_uses != null && Number(row.used_count || 0) >= Number(row.max_uses)) { toast('Лимит использований исчерпан.', 'fail'); return; }
        if (Number(row.min_purchase || 0) > wizTotals().afterDisc) { toast(trf('Код действует при счёте от {sum}.', { sum: formatMoney(row.min_purchase) }), 'fail'); return; }
        if (row.kind !== 'promo_code' && !(Number(row.remaining ?? row.amount ?? 0) > 0)) { toast('На карте нет средств.', 'fail'); return; }
        if ((wiz.applied || []).some(x => x.id === row.id)) { toast('Код уже применён.', 'info'); return; }
        if (row.kind === 'promo_code' && wizPromo()) { toast('Можно применить только один промокод.', 'fail'); return; }
        wiz.applied.push(row);
        toast(trf('{kind} применён: {code}', { kind: tr(KIND_RU3[row.kind] || 'Код'), code: row.code }));
    }

    async function loadWizDeposit(pid) {
        try {
            const { data } = await supabase.from('patient_deposits')
                .select('amount, refund_amount, status').eq('patient_id', pid);
            return Math.max(0, (data || []).reduce((s, d) => {
                if (d.status === 'received') return s + Number(d.amount || 0);
                if (d.status === 'refunded') return s + Number(d.amount || 0) - Number(d.refund_amount || 0);
                if (d.status === 'spent')    return s - Number(d.amount || 0);   // CATALOG_WIZARD_V1
                return s;
            }, 0));
        } catch (_) { return 0; }
    }

    async function ensureWizData() {
        if (wiz.payers === null) {
            const [payers, policies] = await Promise.all([
                safeSelect('payers', b => b.eq('active', true).order('name')),
                safeSelect('payer_policies', b => b.eq('active', true).order('name')),
            ]);
            wiz.payers = payers || [];
            wiz.policies = policies || [];
        }
        if (wiz.depositBalance === null && refs.attachedPatient) {
            wiz.depositBalance = await loadWizDeposit(refs.attachedPatient.id);
        }
        if (!wiz._prefilled && refs.attachedPatient) {
            wiz._prefilled = true;
            const raw = refs.attachedPatient._raw || {};
            if (wiz.payment.discountPct === null) wiz.payment.discountPct = Number(raw.personal_discount || 0);
            if (raw.payer_id && wiz.payers.some(x => x.id === raw.payer_id)) {
                wiz.payment.payerId = raw.payer_id;
                const pt = (wiz.payers.find(x => x.id === raw.payer_id) || {}).type;
                wiz.payment.coverage = pt === 'government' ? 'state' : (pt === 'corporate' ? 'corporate' : 'insurance');
                if (raw.payer_policy_id && wiz.policies.some(x => x.id === raw.payer_policy_id && x.payer_id === raw.payer_id)) {
                    wiz.payment.policyId = raw.payer_policy_id;
                    const _pp = wiz.policies.find(x => x.id === raw.payer_policy_id);   // WIZ_POLICY_MANUAL_V1 — префилл номера
                    if (_pp && !wiz.payment.policyNumber) wiz.payment.policyNumber = _pp.policy_code || _pp.name || '';
                }
            }
        }
    }

    function wizPatientChip() {
        const p = refs.attachedPatient || {};
        const name = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
        const sub = [p.mrn, p.phone].filter(Boolean).join(' · ') || '—';
        return h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
            Avatar({ initials: p.initials || initials(name), color: p.avColor || avColor(p.id || name) }),
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontWeight: 700, fontSize: '13.5px' } }, name),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub)));
    }

    // ---- SVC_REFERRAL_V1 — step 2 «Направление»: источник направления по услугам ----
    async function ensureReferralData() {
        if (wiz.referral.cats) return;
        try {
            const [c, s] = await Promise.all([
                supabase.from('referral_source_categories').select('id, name').eq('active', true).order('name'),
                supabase.from('referral_sources').select('id, name, category_id').eq('active', true).order('name'),
            ]);
            wiz.referral.cats = c.data || [];
            wiz.referral.sources = s.data || [];
        } catch (_) { wiz.referral.cats = []; wiz.referral.sources = []; }
    }
    function buildStepReferral() {
        const root = h('div', { style: { padding: '14px 6px' } });
        root.appendChild(h('div', { class: 'empty', style: { padding: '24px' } }, 'Загрузка…'));
        (async () => { await ensureReferralData(); if (wiz.step !== 2) return; clear(root); paintStepReferral(root); })();
        return root;
    }
    function paintStepReferral(root) {
        const R = wiz.referral;
        const catOpts = (sel) => [
            h('option', { value: '', selected: !sel }, 'Сам пациент'),
            ...R.cats.map(c => h('option', { value: c.id, selected: sel === c.id }, c.name)),
        ];
        const srcOpts = (catId, sel) => {
            const list = R.sources.filter(s => s.category_id === catId);
            return [h('option', { value: '', selected: !sel }, list.length ? 'Выберите партнёра…' : 'Нет партнёров в категории'),
                    ...list.map(s => h('option', { value: s.id, selected: sel === s.id }, s.name))];
        };
        // Одно место: категория направления сразу для всех услуг
        const globalSel = h('select', { class: 'tp-input', style: { maxWidth: '340px' },
            onchange: (e) => {
                R.globalCat = e.target.value || '';
                R.globalSrc = '';
                state.added.forEach((_, i) => { R.per[i] = { catId: R.globalCat, sourceId: '' }; });
                clear(root); paintStepReferral(root);
            } }, ...catOpts(R.globalCat));
        // Партнёр сразу для всех услуг (доступен после выбора категории)
        const globalSrcSel = h('select', { class: 'tp-input', style: { maxWidth: '340px' }, disabled: R.globalCat ? null : true,
            onchange: (e) => {
                R.globalSrc = e.target.value || '';
                state.added.forEach((_, i) => { R.per[i] = { catId: R.globalCat, sourceId: R.globalSrc }; });
                clear(root); paintStepReferral(root);
            } }, ...srcOpts(R.globalCat, R.globalSrc));
        root.appendChild(h('div', { style: { marginBottom: '14px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '6px' } }, 'Источник направления для всех услуг'),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, globalSel, globalSrcSel),
            h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } },
                '«Сам пациент» — обращение без направившего партнёра. Ниже категорию и партнёра можно уточнить для каждой услуги отдельно.'),
        ));
        state.added.forEach((a, i) => {
            const row = R.per[i] || (R.per[i] = { catId: R.globalCat, sourceId: '' });
            const srcSel = h('select', { class: 'tp-input', style: { flex: '1 1 auto', minWidth: 0 }, disabled: row.catId ? null : true,
                onchange: (e) => { row.sourceId = e.target.value || ''; } }, ...srcOpts(row.catId, row.sourceId));
            const catSel = h('select', { class: 'tp-input', style: { flex: '0 0 220px' },
                onchange: (e) => { row.catId = e.target.value || ''; row.sourceId = ''; clear(root); paintStepReferral(root); } },
                ...catOpts(row.catId));
            root.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '9px 0', borderTop: '1px solid var(--line, #e8ecef)' } },
                h('div', { style: { flex: '1 1 38%', minWidth: 0 } },
                    h('div', { style: { fontWeight: '600', fontSize: '13px' } }, a.service && a.service.name || '—'),
                    a.doctor && a.doctor.full_name ? h('div', { class: 'muted', style: { fontSize: '11.5px' } }, a.doctor.full_name) : null),
                catSel, srcSel));
        });
    }

    // (WIZ_4STEPS_V1 — прежний шаг «Оплата» удалён: оплата настраивается в смете, см. buildRailPayment.)


    // ---- Coverage split helpers (COVER_SPLIT_V1) ----
    // wiz.coverage maps a state.added index -> 'payer' | 'patient'. Defaults are
    // derived from the step-2 payment mode and reset whenever that mode changes.
    function ensureCoverage() {
        const def = wiz.payment.mode === 'patient' ? 'patient' : 'payer';
        if (wiz._covMode !== wiz.payment.mode) { wiz.coverage = {}; wiz._covMode = wiz.payment.mode; }
        state.added.forEach((a, i) => {
            if (wiz.coverage[i] !== 'payer' && wiz.coverage[i] !== 'patient') wiz.coverage[i] = def;
        });
    }
    function covOf(i) {
        if (wiz.coverage[i] === 'patient' || wiz.coverage[i] === 'payer') return wiz.coverage[i];
        return wiz.payment.mode === 'patient' ? 'patient' : 'payer';
    }
    function covHasPatient() { ensureCoverage(); return state.added.some((a, i) => covOf(i) === 'patient'); }
    function covSums() {
        let payer = 0, patient = 0;
        state.added.forEach((a, i) => { const pr = Number(a.service?.price || 0); if (covOf(i) === 'patient') patient += pr; else payer += pr; });
        return { payer, patient };
    }

    // ---- Step 3 — Кто платит ----
    // Per-service split: Плательщик (-> акт) vs Пациент (-> счёт/касса).
    function buildStepCoverage() {
        ensureCoverage();
        const root = h('div', null);
        const selfPay = wiz.payment.mode === 'patient';
        const payerName = ((wiz.payers || []).find(x => x.id === wiz.payment.payerId) || {}).name || 'Плательщик';
        const s = covSums();
        root.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' } },
            wizPatientChip(),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                payerName + ': ', h('b', null, formatMoney(s.payer)), ' · Пациент (в кассу): ',
                h('b', { style: { color: 'var(--primary-700, #115d5a)' } }, formatMoney(s.patient)))));
        if (selfPay) root.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
            'Самооплата: все услуги оплачивает пациент. Чтобы распределить на плательщика, выберите ДМС / контракт на шаге «Оплата».'));
        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        state.added.forEach((a, i) => {
            const price = Number(a.service?.price || 0);
            const mk = (val, label) => {
                const on = covOf(i) === val;
                const disabled = selfPay && val === 'payer';
                return h('button', { type: 'button', disabled: disabled ? '' : null, title: label,
                    style: { padding: '6px 12px', border: '0', cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit', fontSize: '12.5px', fontWeight: 600,
                             whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px',
                             background: on ? 'var(--primary-600, #167873)' : 'transparent',
                             color: on ? '#fff' : (disabled ? 'var(--ink-300, #aab4bc)' : 'var(--ink-700, #1f2d34)') },
                    onclick: () => { if (disabled) return; wiz.coverage[i] = val; wizGoto(3); } }, label);   // WIZ_4STEPS_V1 — repaint (Кто платит = step 3)
            };
            const seg = h('div', { style: { display: 'inline-flex', flex: '0 0 auto', maxWidth: '60%', border: '1px solid var(--ink-200, #d3d9de)', borderRadius: '8px', overflow: 'hidden' } },
                mk('payer', payerName), mk('patient', 'Пациент'));
            list.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 12px', border: '1px solid var(--ink-100, #e7ebee)', borderRadius: '10px' } },
                h('div', null,
                    h('div', { style: { fontWeight: 500 } }, a.service?.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12px' } }, formatMoney(price))),
                seg));
        });
        root.appendChild(list);
        return root;
    }

    // ---- Step 4 — Подтверждение ----
    function buildConfirm() {
        ensureCoverage();
        const root = h('div', null);
        const pm = wiz.payment;
        const selfPay = pm.mode === 'patient';
        const t = wizTotals();
        const payer = (wiz.payers || []).find(x => x.id === pm.payerId);
        const pol = (wiz.policies || []).find(x => x.id === pm.policyId);
        const covRu = { insurance: 'ДМС / Страховка', corporate: 'Корпоративный (B2B)', state: 'ОМС / госпрограмма' };

        const payerIdx = [], patIdx = [];
        state.added.forEach((a, i) => { (covOf(i) === 'patient' ? patIdx : payerIdx).push(i); });

        // SVC_REFERRAL_CONFIRM_V1 — surface the step-2 referral choice on the
        // confirmation summary. Resolves each service's row (falling back to
        // the global pick) to a human label; when every service shares one
        // source it's a single summary line, otherwise per-service sub-lines.
        const refLabelOf = (i) => {
            const R = wiz.referral || {};
            const row = (R.per || {})[i] || { catId: R.globalCat || '', sourceId: R.globalSrc || '' };
            if (!row.catId && !row.sourceId) return 'Сам пациент';
            const src = (R.sources || []).find(s => s.id === row.sourceId);
            const cat = (R.cats || []).find(c => c.id === row.catId);
            if (src) return (cat ? cat.name + ' · ' : '') + src.name;
            return cat ? trf('{name} (партнёр не выбран)', { name: cat.name }) : 'Сам пациент';
        };
        const refLabels = state.added.map((_, i) => refLabelOf(i));
        const refUniform = refLabels.length > 0 && refLabels.every(l => l === refLabels[0]);

        root.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' } },
            wizPatientChip(),
            h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
                // SVC_REFERRAL_CONFIRM_V1 — prominent header chips: who referred + who pays.
                refUniform && refLabels[0] !== 'Сам пациент' ? h('div', { class: 'tag tag-info', style: { fontSize: '13.5px', fontWeight: '700', padding: '6px 12px' } },
                    'Направление: ', h('b', null, refLabels[0])) : null,
                h('div', { class: 'tag ' + (selfPay ? 'tag-ok' : 'tag-warn'), style: { fontSize: '13.5px', fontWeight: '700', padding: '6px 12px' } },
                    selfPay ? 'Пациент платит' : trf('Платит: {who}', { who: (payer && payer.name) || tr(covRu[pm.coverage] || pm.coverage) })))));

        const tableFor = (idxs, withDisc) => {
            const tb = h('tbody');
            for (const i of idxs) {
                const a = state.added[i]; const unit = Number(a.service?.price || 0);
                tb.appendChild(h('tr', null,
                    h('td', { style: { fontWeight: 500 } }, a.service?.name || '—',
                        refUniform ? null : h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 400, marginTop: '2px' } }, trf('Направление: {ref}', { ref: refLabels[i] }))),   // SVC_REFERRAL_CONFIRM_V1
                    h('td', { class: 'muted' }, a.doctor ? (a.doctor.full_name || a.doctor.name || '—') : '—'),
                    h('td', { class: 'num', style: { textAlign: 'right' } },
                        withDisc && wizDiscountPct()
                            ? h('span', null, h('s', { class: 'muted', style: { marginRight: '6px' } }, formatMoney(unit)), formatMoney(wizDiscounted(unit)))
                            : formatMoney(unit)),
                ));
            }
            return h('table', { class: 'tbl', style: { width: '100%', marginBottom: '10px' } },
                h('thead', null, h('tr', null, h('th', null, 'Услуга'), h('th', null, 'Врач'), h('th', { style: { textAlign: 'right' } }, 'Цена'))), tb);
        };
        const sectionTitle = (txt) => h('div', { style: { fontWeight: 700, fontSize: '12.5px', margin: '6px 0', color: 'var(--ink-700, #1f2d34)' } }, txt);

        if (payerIdx.length) {
            const sum = payerIdx.reduce((acc, i) => acc + Number(state.added[i].service?.price || 0), 0);
            root.appendChild(sectionTitle(trf('Плательщик (акт): {who} — {sum}', { who: (payer ? payer.name : '—') + ((pol && (pol.name || pol.policy_code)) || (pm.policyNumber || '').trim() ? ' · ' + ((pol && (pol.name || pol.policy_code)) || pm.policyNumber.trim()) : ''), sum: formatMoney(sum) })));   // WIZ_POLICY_MANUAL_V1
            root.appendChild(tableFor(payerIdx, false));
        }
        if (patIdx.length) {
            root.appendChild(sectionTitle('Пациент (счёт → касса)'));
            root.appendChild(tableFor(patIdx, selfPay));
        }

        const lines = [];
        if (scheduledISO) lines.push(trf('Время записи: {when}', { when: new Date(scheduledISO).toLocaleString('ru-RU') }));
        lines.push(trf('Направление: {ref}', { ref: refUniform ? refLabels[0] : tr('указано по каждой услуге (см. список выше).') }));   // SVC_REFERRAL_CONFIRM_V1
        if (payerIdx.length) lines.push('Покрытые услуги: счёт не выставляется, печатается акт оказанных услуг.');
        if (patIdx.length) {
            if (selfPay) {
                if (t.promoOff > 0) lines.push(trf('Промокод: −{sum}.', { sum: formatMoney(t.promoOff) }));
                if (t.cards > 0) lines.push(trf('Карты/сертификаты: −{sum}.', { sum: formatMoney(t.cards) }));
                if (t.bal > 0) lines.push(trf('Списание баланса: −{sum} (кешбэк и возвраты).', { sum: formatMoney(t.bal) }));
                lines.push(trf('Счёт на {sum} — к оплате в кассе {due}.', { sum: formatMoney(t.payable), due: formatMoney(t.due) }));
            } else {
                const patBase = patIdx.reduce((acc, i) => acc + Number(state.added[i].service?.price || 0), 0);
                lines.push(trf('Счёт пациенту на {sum} — к оплате в кассе.', { sum: formatMoney(patBase) }));
            }
        }
        root.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            ...lines.map(x => h('div', null, x))));
        return root;
    }

    // ---- save ----
    async function wizSave(btn) {
        const p = refs.attachedPatient;
        if (!p || state.added.length === 0) { toast('Добавьте услуги и привяжите пациента.', 'fail'); return; }
        if (!wizStep2Valid()) { toast('Выберите плательщика.', 'fail'); wizGoto(1); return; }   // WIZ_4STEPS_V1 — payer выбирается в смете (шаг 1)
        if (btn) btn.disabled = true;
        const pm = wiz.payment;
        const isPatient = pm.mode === 'patient';
        try {
            // WIZ_POLICY_MANUAL_V1 — полис вводится вручную при регистрации: найти
            // или создать строку payer_policies с этим номером (policy_code) у
            // выбранного плательщика и использовать её id как payer_policy_id.
            if (!isPatient && pm.payerId && (pm.policyNumber || '').trim()) {
                const num = pm.policyNumber.trim();
                try {
                    const { data: ex } = await supabase.from('payer_policies')
                        .select('id').eq('payer_id', pm.payerId).eq('policy_code', num).limit(1);
                    if (ex && ex.length) pm.policyId = ex[0].id;
                    else {
                        const ins = { payer_id: pm.payerId, policy_code: num, name: num, active: true };
                        if (window.CLINIC && window.CLINIC.id) ins.company_id = window.CLINIC.id;
                        const { data: crt, error: cErr } = await supabase.from('payer_policies').insert(ins).select('id').single();
                        if (cErr) console.warn('[wizard] policy create:', cErr.message);
                        else pm.policyId = crt.id;
                    }
                } catch (e) { console.warn('[wizard] policy resolve:', e.message); }
            }
            // CATALOG_WIZARD_V2 — the visits row anchors on the EARLIEST item that has
            // a doctor+slot (a no-doctor lab item first in the cart must not produce a
            // doctorless 09:00 visit). lockedDoctor bookings occupy the slot for the sum
            // of all item durations.
            const timed = state.added.filter(a => a.doctor && a.startISO)
                .sort((a, b) => String(a.startISO).localeCompare(String(b.startISO)));
            const head = timed[0] || state.added[0];
            const fallback = new Date(); fallback.setHours(9, 0, 0, 0);
            const visitDate = head.startISO || scheduledISO || fallback.toISOString();
            const totalDur = lockedDoctor
                ? state.added.reduce((s, a) => s + (a.durationMinutes || 30), 0)
                : (head.durationMinutes || head.service.duration_minutes || 30);
            // VISIT_OVERLAP_FIX_V1 — `visits_no_overlap` blocks a 2nd visit overlapping the SAME
            // doctor's time; walk-ins default to a 09:00 slot so several to one doctor collided.
            // Auto-assigned time -> nudge to the doctor's next free slot and retry; an explicitly
            // chosen slot (or a fully-booked doctor) -> ask the registrar to pick another time.
            const _vBase = {
                patient_id:          p.id,
                branch_id:           (p._raw && p._raw.branch_id) || p.branch_id || null,
                doctor_id:           head.doctor?.id || null,
                service_id:          head.service.__consult ? null : head.service.id,
                duration_minutes:    totalDur,
                visit_kind:          'first',
                visit_type:          'outpatient',
                status:              'scheduled',
                room_id:             roomId || null,
                coverage_type:       isPatient ? 'patient' : pm.coverage,
                payer_id:            isPatient ? null : (pm.payerId || null),
                payer_policy_id:     isPatient ? null : (pm.policyId || null),
                discount_percentage: isPatient ? wizDiscountPct() : 0,
                notes:               null,
            };
            const _explicit = !!(head.startISO || scheduledISO);
            const _overlap = (er) => !!er && (er.code === '23P01' || /overlap|exclu|conflict|no_overlap/i.test(er.message || ''));
            let visit, error, _try = new Date(visitDate);
            for (let _a = 0; _a < 24; _a++) {
                ({ data: visit, error } = await supabase.from('visits')
                    .insert({ ..._vBase, visit_date: _try.toISOString() }).select().single());
                if (!error) break;
                if (_overlap(error) && !_explicit && _vBase.doctor_id) { _try = new Date(_try.getTime() + Math.max(15, totalDur || 30) * 60000); continue; }
                break;
            }
            if (error) {
                if (_overlap(error)) throw new Error('Это время уже занято у выбранного врача — выберите другое время.');
                throw error;
            }

            const vsRows = [];
            for (const a of state.added) {
                const unitPrice = Number(a.service.price || 0);
                const isConsult = !!a.service.__consult;
                const { data: vs, error: vsErr } = await insertRow('visit_services', {
                    visit_id:     visit.id,
                    service_id:   isConsult ? null : a.service.id,
                    consultation_type_id: isConsult ? (a.service.consultation_type_id || a.service.id) : null,
                    doctor_id:    a.doctor?.id || null,
                    quantity:     1,
                    unit_price:   unitPrice,
                    total:        unitPrice,
                    scheduled_at: a.startISO || scheduledISO || null,
                    referral_source_id: ((wiz.referral || {}).per || {})[state.added.indexOf(a)] && wiz.referral.per[state.added.indexOf(a)].sourceId || null,   // SVC_REFERRAL_V1
                });
                if (vsErr) { console.warn('[wizard] visit_services:', vsErr.message || vsErr); continue; }
                vsRows.push({ vs, a, unitPrice });
                try {
                    await logPatientActivity({ patientId: p.id, visitId: visit.id, entityType: 'service',
                        entityId: a.service.id, entityLabel: a.service.name, action: 'created' });
                } catch (_) {}
            }

            // CATALOG_WIZARD_V2 — a partially-recorded visit must not proceed to
            // billing: the invoice/balance math would diverge from what landed.
            if (vsRows.length !== state.added.length) {
                toast(trf('Записались не все услуги ({got} из {want}) — счёт НЕ выставлен. Откройте визит и добавьте услуги вручную.', { got: vsRows.length, want: state.added.length }), 'fail');
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                if (typeof onBooked === 'function') { try { onBooked(); } catch (_) {} }
                return;
            }
            // COVER_SPLIT_V1 — split by who pays (chosen on step 3 «Кто платит»):
            // patientRows -> invoice (cashier, existing loyalty path); payerRows -> акт + release now.
            const covAlloc = (r) => covOf(state.added.indexOf(r.a));
            const patientRows = vsRows.filter(r => covAlloc(r) === 'patient');
            const payerRows   = vsRows.filter(r => covAlloc(r) === 'payer');
            let note = '';
            let openServicesFor = null;
            if (patientRows.length && isPatient) {
                const subtotal = patientRows.reduce((s, r) => s + wizDiscounted(r.unitPrice), 0);
                // CATALOG_WIZARD_V4 — revalidate applied codes against FRESH rows + the
                // final subtotal (cart/loyalty may have changed since apply); atomically
                // CLAIM the promo before pricing so concurrent sessions can't over-redeem.
                let promoRow = null; const validCards = [];
                if (wiz.applied.length) {
                    const today = new Date().toISOString().slice(0, 10);
                    let fresh = [];
                    try { const fr = await supabase.from('patient_discounts').select('*').in('id', wiz.applied.map(x => x.id)); fresh = fr.data || []; } catch (_) {}
                    const byId = {}; for (const r of fresh) byId[r.id] = r;
                    for (const ap of wiz.applied) {
                        const r = byId[ap.id];
                        if (!r || !r.active) { toast(trf('Код {code} больше недоступен — не применён.', { code: ap.code }), 'fail'); continue; }
                        if (r.valid_from && r.valid_from > today) { toast(trf('Код {code} ещё не действует — не применён.', { code: ap.code }), 'fail'); continue; }
                        if (r.valid_to && r.valid_to < today) { toast(trf('Код {code} истёк — не применён.', { code: ap.code }), 'fail'); continue; }
                        if (r.patient_id && r.patient_id !== p.id) { toast(trf('Код {code} привязан к другому пациенту — не применён.', { code: ap.code }), 'fail'); continue; }
                        if (Number(r.min_purchase || 0) > subtotal) { toast(trf('Код {code} требует счёт от {sum} — не применён.', { code: ap.code, sum: formatMoney(r.min_purchase) }), 'fail'); continue; }
                        if (r.kind === 'promo_code') { if (!promoRow) promoRow = r; }
                        else if (Number(r.remaining ?? r.amount ?? 0) > 0) validCards.push(r);
                    }
                }
                let promoOff = 0;
                if (promoRow) {
                    promoOff = Math.min(subtotal, promoRow.discount_type === 'amount'
                        ? Math.round(Number(promoRow.amount || 0))
                        : Math.round(subtotal * Math.min(100, Math.max(0, Number(promoRow.percent || 0))) / 100));
                    let claimed = false;
                    try { const cr = await supabase.rpc('claim_promo_use', { p_id: promoRow.id }); claimed = !cr.error && !!cr.data; } catch (_) {}
                    if (!claimed) { toast(trf('Промокод {code} исчерпан — не применён.', { code: promoRow.code }), 'fail'); promoOff = 0; promoRow = null; }
                }
                const payable = Math.max(0, subtotal - promoOff);
                const { data: inv, error: invErr } = await supabase.from('invoices').insert({
                    visit_id: visit.id, patient_id: p.id, branch_id: visit.branch_id || null, coverage_type: 'patient',   // REVENUE_BRANCH_NULL_FIX
                    subtotal, total_amount: payable, paid_amount: 0, status: 'unpaid',
                    created_by: currentUser()?.id || null,
                }).select().single();
                if (invErr) {
                    console.warn('[wizard] invoice:', invErr.message); note = ' ' + trf('(счёт не создан: {msg})', { msg: invErr.message });
                    if (promoRow) { try { await supabase.rpc('release_promo_use', { p_id: promoRow.id }); } catch (_) {} }
                }
                else {
                    let _billLinkFail = 0;   // ROUTING_BILL_LINK_FIX_V1 — surface a failed invoice-item link
                    for (const r of patientRows) {
                        const price = wizDiscounted(r.unitPrice);
                        const { data: item, error: itErr } = await supabase.from('invoice_items').insert({
                            invoice_id:  inv.id,
                            service_id:  r.a.service.__consult ? null : r.a.service.id,
                            // i18n-exempt: описание строки счёта пишется В БАЗУ — хранимая запись, а не текст экрана
                            description: (r.a.service.name || 'Услуга') + (wizDiscountPct() ? ` (скидка ${wizDiscountPct()}%)` : ''),
                            quantity:    1,
                            unit_price:  price,
                            total:       price,
                        }).select().single();
                        if (itErr) { console.warn('[wizard] invoice_items:', itErr.message); _billLinkFail++; continue; }
                        if (r.vs && r.vs.id) {
                            const { error: _linkErr } = await supabase.from('visit_services').update({ invoice_item_id: item.id }).eq('id', r.vs.id);
                            if (_linkErr) { console.warn('[wizard] invoice_item link:', _linkErr.message); _billLinkFail++; }
                        }
                    }
                    if (_billLinkFail) toast(trf('Внимание: {n} услуг(и) не привязались к счёту — проверьте счёт в кассе перед оплатой.', { n: _billLinkFail }), 'fail');
                    note = inv.invoice_number ? ', ' + trf('счёт №{no}', { no: inv.invoice_number }) : ', ' + tr('счёт выставлен');
                    // CATALOG_WIZARD_V4 — promo marker (cancel-restore), then non-cash
                    // payments via ATOMIC claims (gift cards -> balance), relative undo,
                    // ONE final invoice update; payable===0 (full promo) is paid+released.
                    if (promoRow) {
                        note += ' · ' + trf('промокод −{sum}', { sum: formatMoney(promoOff) });
                        await supabase.from('payments').insert({ invoice_id: inv.id, amount: 0, method: 'other', notes: 'promo:' + promoRow.id });
                    }
                    let paidSoFar = 0;
                    const undo = [];
                    if (payable > 0) for (const card of validCards) {
                        const avail = Math.max(0, Number(card.remaining ?? card.amount ?? 0));
                        const alloc = Math.min(avail, payable - paidSoFar);
                        if (alloc <= 0) continue;
                        let newRem = null;
                        try { const cr = await supabase.rpc('claim_patient_discount', { p_id: card.id, p_alloc: alloc }); newRem = cr.error ? null : cr.data; } catch (_) { newRem = null; }
                        if (newRem == null) { toast(trf('Карта {code} не списана — баланс карты изменился.', { code: card.code }), 'fail'); continue; }
                        const { data: gp, error: gErr } = await supabase.from('payments').insert({
                            invoice_id: inv.id, amount: alloc, method: 'gift_card',
                            cashier_id: currentUser()?.id || null, notes: 'gift:' + card.id,
                        }).select().single();
                        if (gErr) {
                            try { await supabase.rpc('restore_patient_discount', { p_id: card.id, p_amount: alloc }); } catch (_) {}
                            toast(trf('Карта {code} не списана: {msg}', { code: card.code, msg: gErr.message }), 'fail');
                            continue;
                        }
                        undo.push(async () => {
                            await supabase.from('payments').delete().eq('id', gp.id);
                            try { await supabase.rpc('restore_patient_discount', { p_id: card.id, p_amount: alloc }); } catch (_) {}
                        });
                        paidSoFar += alloc;
                        note += ` · ${KIND_RU3[card.kind] || 'карта'} −${formatMoney(alloc)}`;
                    }
                    let balToSpend = 0;
                    if (payable > 0 && wiz.payment.useBal && paidSoFar < payable) {
                        const freshBal = await loadWizDeposit(p.id);
                        balToSpend = Math.max(0, Math.min(freshBal, payable - paidSoFar));
                    }
                    if (balToSpend > 0) {
                        const { data: spentRow, error: dErr } = await supabase.from('patient_deposits').insert({
                            patient_id: p.id, amount: balToSpend, method: 'other', status: 'spent',
                            notes: 'spend:' + inv.id,
                            created_by: currentUser()?.id || null,
                            created_by_name: currentUser()?.full_name || null,
                        }).select().single();
                        if (dErr) { toast(trf('Баланс НЕ списан: {msg}', { msg: dErr.message }), 'fail'); balToSpend = 0; }
                        else {
                            const { data: payRow, error: pyErr } = await supabase.from('payments').insert({
                                invoice_id: inv.id, amount: balToSpend, method: 'deposit',
                                cashier_id: currentUser()?.id || null,
                            }).select().single();
                            if (pyErr) {
                                await supabase.from('patient_deposits').delete().eq('id', spentRow.id);
                                toast(trf('Баланс НЕ списан: {msg}', { msg: pyErr.message }), 'fail');
                                balToSpend = 0;
                            } else {
                                undo.push(async () => {
                                    await supabase.from('payments').delete().eq('id', payRow.id);
                                    await supabase.from('patient_deposits').delete().eq('id', spentRow.id);
                                });
                                note += ' · ' + trf('баланс −{sum}', { sum: formatMoney(balToSpend) });
                            }
                        }
                    }
                    const paidTotal = paidSoFar + balToSpend;
                    if (paidTotal > 0 || payable === 0) {
                        const fullyPaid = paidTotal >= payable;
                        const { error: updErr } = await supabase.from('invoices').update({
                            paid_amount: paidTotal,
                            status: fullyPaid ? 'paid' : 'partial',
                            ...(fullyPaid ? { paid_at: new Date().toISOString() } : {}),
                        }).eq('id', inv.id);
                        if (updErr) {
                            for (const u of undo.reverse()) { try { await u(); } catch (_) {} }
                            toast(trf('Оплаты НЕ применены ({msg}) — оплата полностью в кассе.', { msg: updErr.message }), 'fail');
                            note = inv.invoice_number ? ', ' + trf('счёт №{no}', { no: inv.invoice_number }) : ', ' + tr('счёт выставлен');
                        } else if (fullyPaid) {
                            const ids = patientRows.map(r => r.vs && r.vs.id).filter(Boolean);
                            if (ids.length) await supabase.from('visit_services').update({ status: 'queued' }).in('id', ids);
                            if (payable === 0) note += ' · полностью покрыт промокодом';
                        }
                    }
                    // WIZ_INVOICE_PRINT_V1 — сразу открываем печатную форму счёта для
                    // пациента (тот же printableSheet/бланк, которым печатается акт).
                    try {
                        const invItems = patientRows.map((r, i) => ({
                            name: r.a.service?.name || 'Услуга', qty: 1, price: wizDiscounted(r.unitPrice), _alt: i % 2 === 1,
                        }));
                        // QUEUE_TICKET_V1 — allocate the queue number for every service
                        // just registered, ordered by registration time. Numbering happens
                        // in Postgres (issue_queue_numbers) so two registrars printing at
                        // the same instant cannot be handed the same number. One ticket per
                        // visit_service, so reprinting this invoice reuses the same numbers.
                        // QUEUE_ONE_PER_VISIT_V1 — services heading to the same destination
                        // come back sharing one number (all lab tests = one place in line);
                        // queue_key is carried through so the slip groups them correctly.
                        // Best-effort: a failure here must never block the invoice.
                        let queueBlock = [];
                        try {
                            const qIds = patientRows.map(r => r.vs && r.vs.id).filter(Boolean);
                            if (qIds.length) {
                                const { data: tickets, error: qErr } = await supabase.rpc('issue_queue_numbers', { p_ids: qIds });
                                if (qErr) {
                                    console.warn('[wizard] queue numbers:', qErr.message || qErr,
                                        '— apply supabase/migrations/122_service_queue_tickets.sql');
                                } else {
                                    const byVs = new Map((tickets || []).map(t => [t.visit_service_id, t]));
                                    // QUEUE_TICKET_V3 — ONE entry per DESTINATION, not per service.
                                    // Four analyses share the lab's number because the patient walks
                                    // to the draw window once; two doctors are two queues, so two
                                    // numbers. No letter prefix — the destination line above the
                                    // number already names the queue.
                                    const byQueue = new Map();
                                    for (const r of patientRows) {
                                        const t = byVs.get(r.vs && r.vs.id);
                                        if (!t) continue;
                                        const key = t.queue_key || ('n' + t.number);
                                        if (!byQueue.has(key)) {
                                            byQueue.set(key, { label: t.label || '', number: String(t.number), names: [] });
                                        }
                                        byQueue.get(key).names.push(r.a.service?.name || 'Услуга');
                                    }
                                    queueBlock = [...byQueue.values()].map(q => ({
                                        label:   q.label,
                                        service: q.names.length === 1 ? q.names[0] : (q.names.length + ' услуг'),   // i18n-exempt: талон очереди — печатный документ
                                        number:  q.number,
                                    }));
                                }
                            }
                        } catch (e) { console.warn('[wizard] queue numbers:', e && e.message); }
                        const patName = (p.fullName || [p.lastName, p.firstName].filter(Boolean).join(' ') || '—').trim();
                        const paidNow = Math.min(paidSoFar + balToSpend, payable);
                        const invStatus = payable === 0 || paidNow >= payable ? 'PAID' : (paidNow > 0 ? 'PARTIAL' : 'UNPAID');
                        /* i18n-exempt-start: печатный счёт (бланк) — печатные документы намеренно русские */
                        printableSheet({ type: 'invoice', idLine: inv.invoice_number || inv.id.slice(0, 8), data: {
                            title: 'Амбулаторные услуги',
                            docNo: inv.invoice_number || inv.id.slice(0, 8),
                            issueDate: 'Дата ' + new Date().toLocaleDateString('ru-RU'),
                            status: invStatus,
                            patient: [
                                ['ФИО', patName],
                                ['Карта №', p.mrn || (p._raw && p._raw.mrn) || '—'],
                                ['Телефон', p.phone || '—'],
                            ],
                            billing: [
                                ['Дата', new Date().toLocaleDateString('ru-RU')],
                                ['Оплата', 'Самооплата — касса'],
                                ...(wizDiscountPct() ? [['Скидка', wizDiscountPct() + '%']] : []),
                                ...(promoOff > 0 ? [['Промокод', '−' + formatMoney(promoOff)]] : []),
                            ],
                            items: invItems,
                            queue: queueBlock,   // QUEUE_TICKET_V1
                            subtotal, total: payable, paid: paidNow,
                        } });
                    } catch (e) { console.warn('[wizard] invoice print:', e); }
                }
            }
            if (payerRows.length) {
                // ACT_PRINT_V1 — covered services: НЕ выставляем счёт. Освобождаем услуги
                // в очередь (пациент идёт к врачу сразу) и печатаем акт оказанных услуг —
                // его подписывают после приёма и используют для сверки с плательщиком.
                const ids = payerRows.map(r => r.vs && r.vs.id).filter(Boolean);
                if (ids.length) {
                    const { error: relErr } = await supabase.from('visit_services')
                        .update({ status: 'queued' }).in('id', ids)
                        .not('status', 'in', '(in_progress,completed)');
                    if (relErr) console.warn('[wizard] release services:', relErr.message);
                    // PAYER_COVERED_FLAG_V1 — mark these so they're locked from patient
                    // invoicing everywhere. Best-effort: column added by migration 058;
                    // a pre-migration error is non-fatal (the visit-modal heuristic still covers it).
                    const { error: pcErr } = await supabase.from('visit_services')
                        .update({ payer_covered: true }).in('id', ids);
                    if (pcErr) console.warn('[wizard] payer_covered (apply migration 058):', pcErr.message);
                }
                try {
                    const payer = (wiz.payers || []).find(x => x.id === pm.payerId);
                    const pol   = (wiz.policies || []).find(x => x.id === pm.policyId);
                    const covRu = { insurance: 'ДМС / Страховка', corporate: 'Корпоративный (B2B)', state: 'ОМС / госпрограмма' };
                    const fullName = [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim()
                        || p.full_name || p.name || '—';
                    const dobRaw = p.date_of_birth || p.birth_date || (p._raw && p._raw.date_of_birth) || '';
                    const actItems = payerRows.map((r, i) => ({
                        name: r.a.service?.name || 'Услуга', qty: 1, price: Number(r.unitPrice || 0), _alt: i % 2 === 1,
                    }));
                    const actTotal = actItems.reduce((sx, it) => sx + it.price, 0);
                    const actNo = visit.visit_number || visit.id.slice(0, 8);
                    /* i18n-exempt-end */
                    /* i18n-exempt-start: печатный акт оказанных услуг — печатный документ */
                    printableSheet({ type: 'act', idLine: actNo, data: {
                        title: 'Акт оказанных медицинских услуг',
                        docNo: actNo,
                        issueDate: 'Дата ' + new Date(visit.visit_date || Date.now()).toLocaleDateString('ru-RU'),
                        coverage: covRu[pm.coverage] || 'По договору',
                        patient: [
                            ['ФИО', fullName],
                            ['Карта №', p.mrn || (p._raw && p._raw.mrn) || '—'],
                            ['Дата рождения', dobRaw ? new Date(dobRaw).toLocaleDateString('ru-RU') : '—'],
                        ],
                        payer: [
                            ['Организация', payer ? payer.name : '—'],
                            ['Полис', (pol && (pol.name || pol.policy_code)) || (pm.policyNumber || '').trim() || '—'],   // WIZ_POLICY_MANUAL_V1
                            ['Покрытие', '100%'],
                        ],
                        items: actItems, total: actTotal,
                    } });
                } catch (e) { console.warn('[wizard] act print:', e); }
                note += ' · акт оказанных услуг';
            }
            if (patientRows.length && !isPatient) {
                // Payer/mixed visit: patient-paid services are NOT auto-invoiced here —
                // the registrar finishes them on the visit's Services tab («Сформировать счёт»).
                note += ' · услуги пациента — счёт во вкладке «Услуги»';
                openServicesFor = visit;
            }
            /* i18n-exempt-end */
            toast(tr('Визит создан') + note);
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            if (typeof onBooked === 'function') { try { onBooked(); } catch (_) {} }
            if (openServicesFor) {
                // Open the visit on its Services tab so the registrar can generate the
                // invoice for the patient-paid services. Dynamic import avoids the
                // visit-modal <-> service-picker static import cycle.
                try {
                    const mod = await import('./visit-modal.js?v=aug17e');
                    mod.openVisitModal({ visit: openServicesFor, patient: (p._raw || p), onChange: (typeof onBooked === 'function' ? onBooked : undefined) });
                } catch (e) { console.warn('[wizard] open Services tab:', e); }
            }
        } catch (e) {
            toast(trf('Не удалось создать визит: {msg}', { msg: e.message || e }), 'fail');
            if (btn && btn.isConnected) btn.disabled = false;
        }
    }

    // ---- inline create-patient (cart preserved; canonical savePatient path) ----
    function openCreatePatientInline() {
        const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
        const close = () => ov.remove();
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        const fLast  = h('input', { style: { width: '100%' }, placeholder: 'Фамилия *' });
        const fFirst = h('input', { style: { width: '100%' }, placeholder: 'Имя *' });
        const fPhone = phoneInput('phone', '+998 90 961 00 04');
        const fDob   = h('input', { type: 'date', style: { width: '100%' } });
        const fSex   = h('select', { style: { width: '100%' } },
            h('option', { value: '' }, '—'), h('option', { value: 'male' }, 'Мужской'), h('option', { value: 'female' }, 'Женский'));
        const fld = (label, el) => h('div', { class: 'field' }, h('label', null, label), el);
        async function doCreate(force) {
            const payload = {
                last_name: fLast.value.trim(), first_name: fFirst.value.trim(),
                phone: fPhone.value.trim() || null, date_of_birth: fDob.value || null,
                gender: fSex.value || null,
            };
            if (!payload.last_name || !payload.first_name) { toast('Фамилия и имя обязательны.', 'fail'); return; }
            try {
                const created = await savePatient(payload, { force });
                close(); closeAttach();
                attachPatient(created);
            } catch (e) {
                if (e?.code === 'DUPLICATE_PATIENT' && e.existing) {
                    close();
                    try {
                        const mod = await import('./registration.js?v=aug17f');
                        mod.openDuplicatePatientDialog(e, {
                            onOpenExisting: async (c) => {
                                const full = await loadPatientById(c.id);
                                if (full) { closeAttach(); attachPatient(full); }
                            },
                            onForceCreate: () => doCreate(true),
                        });
                    } catch (_) { toast('Похожий пациент уже существует — найдите его через поиск.', 'fail'); }
                } else {
                    toast(trf('Не удалось создать: {msg}', { msg: e.message || e }), 'fail');
                }
            }
        }
        ov.appendChild(h('div', { class: 'modal-card', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Plus', { size: 16 }), ' Новый пациент'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 14px' } },
                fld('Фамилия *', fLast), fld('Имя *', fFirst),
                fld('Телефон', fPhone), fld('Дата рождения', fDob),
                fld('Пол', fSex)),
            h('footer', { class: 'modal-foot' },
                h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Полная анкета — на странице «Регистратура».'),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn', onclick: close }, 'Отмена'),
                h('button', { class: 'btn btn-primary', onclick: (ev) => { const b = ev.currentTarget; if (b.disabled) return; b.disabled = true; Promise.resolve(doCreate(false)).finally(() => { b.disabled = false; }); } }, Icon('Check', { size: 14 }), ' Создать и привязать'))));
        document.body.appendChild(ov);
        setTimeout(() => fLast.focus(), 30);
    }

    document.body.appendChild(overlay);

    function onKey(e) {
        if (e.key !== 'Escape') return;
        if (catalogUI && state.added.length && !confirm(attachMode ? 'Закрыть? Выбранные услуги не будут добавлены.' : 'Закрыть мастер записи? Подбор услуг будет потерян.')) return;
        overlay.remove(); document.removeEventListener('keydown', onKey);
    }
    document.addEventListener('keydown', onKey);
}

function rowEl(label, meta, on, onClick, opts = {}) {
    const { disabled = false, badge = null } = opts;
    const attrs = { class: 'sched-col-row' + (on ? ' on' : ''), type: 'button' };
    if (disabled) {
        attrs.disabled = true;
        attrs.style = { opacity: '0.55', cursor: 'not-allowed' };
        attrs.title = badge || 'Already added';
    } else {
        attrs.onclick = onClick;
    }
    return h('button', attrs,
        h('span', { class: 'radio-dot' }),
        h('span', { class: 'row-label' }, label || '—'),
        meta && h('span', { class: 'row-meta' }, meta),
        badge && h('span', { style: {
            marginLeft: '6px', fontSize: '10px', fontWeight: 700,
            color: 'var(--ok-700)', background: 'var(--ok-50)',
            padding: '2px 7px', borderRadius: '999px',
            textTransform: 'uppercase', letterSpacing: '0.04em',
        } }, badge),
    );
}
function emptyHint(title, sub) {
    return h('div', { class: 'sched-empty' },
        h('b', null, title),
        sub && h('div', null, sub),
    );
}
function formatMoney(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ' + tr('сум');
}

// ---------------------------------------------------------------------------
// Schedule helpers (pure)
// ---------------------------------------------------------------------------
const SCHED_GRID_START  = 8;     // visible window start hour
const SCHED_GRID_END    = 20;    // visible window end hour
const SCHED_HOUR_W      = 76;    // px per hour on the timeline
const SCHED_SNAP        = 15;    // slot granularity, minutes
const SCHED_WINDOW_DAYS = 14;    // how far ahead auto-pick / nav may reach
const SCHED_WEEKDAY     = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function schedParseHHMM(s) {
    const [hh, mm] = String(s || '00:00').split(':').map(Number);
    return (hh || 0) + (mm || 0) / 60;
}
function fmtMin(min) {
    const hh = Math.floor(min / 60), mm = min % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function schedDateToIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function schedTodayIso() { return schedDateToIso(new Date()); }
function schedIsoToDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}
function schedAddDays(iso, n) {
    const d = schedIsoToDate(iso);
    d.setDate(d.getDate() + n);
    return schedDateToIso(d);
}
function schedDateLabel(iso) {
    if (iso === schedTodayIso()) return 'Today · ' + schedIsoToDate(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
    if (iso === schedAddDays(schedTodayIso(), 1)) return 'Tomorrow · ' + schedIsoToDate(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
    return schedIsoToDate(iso).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
}
function overlapsBusy(start, end, busy) {
    return (busy || []).some(b => start < b.endMin && end > b.startMin);
}
async function safeSelect(table, q = b => b) {
    try {
        const { data, error } = await q(supabase.from(table).select('*'));
        if (error) { console.warn('[service-picker]', table, error.message); return null; }
        return data;
    } catch (e) { console.warn('[service-picker]', table, e.message); return null; }
}
