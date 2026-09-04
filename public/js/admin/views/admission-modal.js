// ADMISSION_ORDER_V1 — ОДНО окно госпитализации: заявка, размещение, отмена и
// карточка маршрута.
//
// ─── ЧТО ЗДЕСЬ БЫЛО ДО ЭТОЙ ПРАВКИ ──────────────────────────────────────────
// 981 строка НЕПЕРЕНЕСЁННОГО облачного кода. Файл читался как работающий экран
// (вкладки «Детали / Услуги / Счёт», кнопка «Выписать»), но выполниться не мог
// ни разу:
//   • первый же запрос просил колонки `home_bed_id` и `discharge_summary` и
//     embed `beds!admissions_bed_id_fkey(…)` — таких колонок в этой базе нет
//     (миграция 091), а `!fkey` не проходит EMBED_TOKEN в query-compiler.js, и
//     запрос отвечает `unknown column` ещё до первой отрисовки;
//   • «Выписать» делал `admissions.update()` напрямую — в schema-registry.js у
//     admissions `insert/update/delete roles: []`, то есть гарантированные 403;
//   • дальше шли `visits!inner(…)` и `company_id` — снова колонки чужой базы.
// То есть это был не «устаревший экран», а экран, которого не существовало:
// клик по пациенту в стационаре из кабинета врача давал пустое окно и ошибку в
// консоли. Он удалён целиком и заменён тем, что ниже.
//
// ─── ЧТО ЗДЕСЬ ТЕПЕРЬ ───────────────────────────────────────────────────────
//   openAdmissionOrderModal  — ЗАЯВКА на госпитализацию (регистратура). Её
//                              зовут карта пациента и экран регистрации.
//   openAdmissionBedPicker   — «Положить на койку»: выбор свободной койки
//                              (медсестра, окно «Стационар»).
//   openAdmissionCancelModal — отмена заявки с обязательной причиной.
//   openAdmissionCard        — карточка маршрута: где пациент и что дальше.
//   openAdmissionReviewModal — ПЕРВИЧНЫЙ ОСМОТР главного врача (Задача 3) и
//                              запись обхода: черновик отдельно, публикация
//                              отдельно.
//   openAdmissionAttendingModal — ЛЕЧАЩИЙ ВРАЧ (Задача 3): шаг, после которого
//                              открываются назначения.
//   openAdmissionDischargeRequestModal / openAdmissionDischargeCancelModal —
//                              ЗАЯВКА НА ВЫПИСКУ и её отзыв (Задача 8, ШАГ 1).
//
// Все шесть — вокруг ОДНОГО источника правды: RPC `admission_order_create`,
// `admission_admit`, `admission_order_cancel`, `admission_review_save`,
// `admission_set_attending` и чтение `admission_flow_state`.
// Экран не решает, кому что можно: матрица прав живёт на сервере
// (rpc/inpatient-flow.js), и вторая её копия в браузере разошлась бы с первой.
//
// Денег и услуг здесь нет НАМЕРЕННО: счёт госпитализации, проживание и выдача
// препаратов живут в консоли койки («Стационар и палаты» → койка), и это
// работающий экран. Два места, где начисляют по одной госпитализации, — самый
// дорогой вид дубля.

import { supabase } from '../../supabase.js';
import { IN_BED_STATUSES, admissionStatusLabel } from '../../shared/admission-status.js';
import { h, Icon, Tag, toast, clear, field, fmtDateTime, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
// TWO_STEP_DISCHARGE_V1 — исход госпитализации спрашивают ЗДЕСЬ (врач подаёт
// заявку) и показывают ТАМ (очередь оформления). Список и подписи берутся из
// экрана очереди, а не заводятся вторые: разойдись они, один экран называл бы
// исход словом, которого другой не знает.
import { DISCHARGE_OUTCOMES, outcomeTitle } from './discharge.js';

const ADMISSION_TYPES = [['planned', 'Плановая'], ['emergency', 'Экстренная']];
const STAY_MODES = [['round', 'Круглосуточно'], ['day', 'Дневной стационар']];

// Одна и та же оболочка окна для всех четырёх диалогов: два окна госпитализации
// с разной рамкой читаются как два разных продукта.
//
// `secondaryLabel` — ВТОРОЕ действие того же окна, и заведено оно ровно под
// одно: «Сохранить черновик» рядом с «Опубликовать осмотр». Осмотр набирают по
// частям, между двумя другими делами, и одна кнопка заставляла бы врача либо
// писать документ целиком с первого раза, либо терять начатое (см. шапку
// rpc/inpatient-reviews.js). Второе действие НЕ закрывает окно: черновик
// сохраняют, чтобы продолжить.
// MAR_SHEET_V1 — оболочка ЭКСПОРТИРУЕТСЯ (Задача 5). Лист назначений и рабочее
// место медсестры открывают свои диалоги — «+ Назначение», «Отменить
// назначение», подтверждение «5 прав», «Не введено» — и это те же окна того же
// раздела. Второй shell рядом означал бы два вида окна госпитализации: одна
// рамка у заявки, другая у дозы, которую по этой заявке вводят.
export function inpatientModal(title, icon, bodyEls, submitLabel, onSubmit, { width = 520, secondaryLabel = null, onSecondary = null } = {}) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const foot = [h('button', { class: 'btn', type: 'button', onclick: close }, tr('Закрыть')), h('span', { class: 'grow' })];
    if (secondaryLabel && onSecondary) {
        const secBtn = h('button', { class: 'btn', type: 'button' }, secondaryLabel);
        secBtn.addEventListener('click', async () => {
            secBtn.disabled = true;
            const prev = secBtn.textContent;
            secBtn.textContent = tr('Выполняем…');
            try { await onSecondary(); } catch (e) { toast((e && e.message) || tr('Не удалось.'), 'fail'); }
            secBtn.disabled = false;
            secBtn.textContent = prev;
        });
        foot.push(secBtn);
    }
    if (submitLabel) {
        const submitBtn = h('button', { class: 'btn btn-primary', type: 'button' }, submitLabel);
        submitBtn.addEventListener('click', async () => {
            submitBtn.disabled = true;
            const prev = submitBtn.textContent;
            submitBtn.textContent = tr('Выполняем…');
            let ok = false;
            try { ok = await onSubmit(); } catch (e) { toast((e && e.message) || tr('Не удалось.'), 'fail'); }
            if (ok) { close(); return; }
            submitBtn.disabled = false;
            submitBtn.textContent = prev;
        });
        foot.push(submitBtn);
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon(icon, { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { alignContent: 'start' } }, ...bodyEls.filter(Boolean)),
        h('footer', { class: 'modal-foot' }, ...foot),
    ));
    document.body.appendChild(overlay);
    return { close, overlay };
}

const modal = inpatientModal;

// ПАЦИЕНТ — ЯКОРЬ. Одна плашка на все четыре окна: имя крупнее всего
// остального. Это та самая защита от «не того пациента», ради которой построен
// экран медсестры, и в диалоге она нужна ровно так же — подтверждают действие
// именно здесь, а не в списке.
// MAR_SHEET_V1 — переход на лист назначений. Идёт через маршрутизатор
// (window.easymed.navigate), а не через location.hash: голый хеш этот экран не
// маршрутизирует (слушателя hashchange нет, историю ведёт navigate()), и
// ссылка молча открывала бы прежнюю вкладку.
export function goToMarSheet(admissionId, onNavigate) {
    const nav = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
    if (!nav) return false;
    nav('mar-sheet', { sub: String(admissionId) });
    return true;
}

export function patientAnchor(name, sub) {
    return h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '11px', padding: '11px 13px',
            background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)',
            borderRadius: '11px',
        },
    },
        h('span', {
            style: {
                width: '38px', height: '38px', borderRadius: '999px', flex: '0 0 38px',
                background: 'var(--primary-600, #1f7a72)', color: '#fff',
                display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '15px',
            },
        }, initials(name || '?')),
        h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--ink-900)', lineHeight: 1.2 } }, name || '—'),
            sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, sub) : null),
    );
}

// ---------------------------------------------------------------------------
// 1. Заявка на госпитализацию (регистратура)
// ---------------------------------------------------------------------------
// patientId может не быть: с экрана регистрации заявку оформляют, ещё не открыв
// карту, поэтому окно умеет искать пациента само. Из карты пациента поиск не
// показывается вовсе — предлагать выбор там, где пациент уже известен, значит
// предлагать ошибиться.
export function openAdmissionOrderModal({ patientId = null, patientName = '', patientMrn = '', onDone } = {}) {
    let chosenId = patientId ? Number(patientId) : null;
    let chosenName = patientName || '';

    const anchorBox = h('div');
    const paintAnchor = () => {
        clear(anchorBox);
        if (chosenId) anchorBox.appendChild(patientAnchor(chosenName, patientMrn || ''));
    };
    paintAnchor();

    const searchInp = h('input', { type: 'text', placeholder: tr('Фамилия, MRN или телефон') });
    const results = h('div', {
        style: { display: 'none', maxHeight: '190px', overflowY: 'auto', border: '1px solid var(--ink-100)', borderRadius: '9px', marginTop: '6px' },
    });
    let timer = null;
    searchInp.addEventListener('input', () => {
        clearTimeout(timer);
        const q = searchInp.value.trim();
        if (q.length < 2) { results.style.display = 'none'; return; }
        timer = setTimeout(async () => {
            const { data } = await supabase.from('patients').select('id, full_name, mrn, phone').ilike('full_name', '%' + q + '%').limit(8);
            clear(results);
            if (!data || !data.length) {
                results.appendChild(h('div', { class: 'muted', style: { padding: '9px 10px', fontSize: '12.5px' } },
                    trf('Не найдено «{q}» — проверьте написание.', { q })));
                results.style.display = '';
                return;
            }
            for (const p of data) {
                results.appendChild(h('div', {
                    style: { padding: '7px 10px', cursor: 'pointer', fontSize: '13.5px' },
                    onmouseover: (e) => { e.currentTarget.style.background = 'var(--ink-25)'; },
                    onmouseout: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onclick: () => {
                        chosenId = p.id; chosenName = p.full_name || '';
                        searchInp.value = chosenName;
                        results.style.display = 'none';
                        paintAnchor();
                    },
                }, (p.full_name || '') + (p.mrn ? '  ·  ' + p.mrn : '')));
            }
            results.style.display = '';
        }, 220);
    });

    const wardSel = h('select', null, h('option', { value: '' }, tr('Палату выберет медсестра')));
    supabase.from('wards').select('id, name').eq('active', 1).order('name').then(({ data }) => {
        for (const w of (data || [])) wardSel.appendChild(h('option', { value: String(w.id) }, w.name));
    });
    const deptInp = h('input', { type: 'text', placeholder: tr('Например: хирургия') });
    const typeSel = h('select', null, ...ADMISSION_TYPES.map(([v, l]) => h('option', { value: v }, tr(l))));
    const modeSel = h('select', null, ...STAY_MODES.map(([v, l]) => h('option', { value: v }, tr(l))));
    const whenInp = h('input', { type: 'datetime-local' });
    const noteInp = h('input', { type: 'text', placeholder: tr('Повод для госпитализации') });

    modal(tr('Заявка на госпитализацию'), 'Bed', [
        anchorBox,
        chosenId ? null : field(tr('Пациент'), h('div', null, searchInp, results), { required: true }),
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
            h('div', { style: { flex: 1 } }, field(tr('Отделение'), deptInp)),
            h('div', { style: { flex: 1 } }, field(tr('Палата'), wardSel))),
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
            h('div', { style: { flex: 1 } }, field(tr('Тип госпитализации'), typeSel)),
            h('div', { style: { flex: 1 } }, field(tr('Режим пребывания'), modeSel))),
        field(tr('Планируемая дата и время'), whenInp),
        field(tr('Повод / жалобы'), noteInp),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Заявка попадёт в «Стационар» — медсестра положит пациента на койку.')),
    ], tr('Оформить заявку'), async () => {
        if (!chosenId) { toast(tr('Выберите пациента.'), 'fail'); return false; }
        const { error } = await supabase.rpc('admission_order_create', {
            patient_id: chosenId,
            ward_id: wardSel.value ? Number(wardSel.value) : null,
            department: deptInp.value.trim(),
            admission_type: typeSel.value,
            stay_mode: modeSel.value,
            // <input type="datetime-local"> отдаёт «2026-09-05T08:00» без зоны;
            // сервер хранит строкой, поэтому секунды и Z дописываются здесь, а
            // не оставляются на догадку каждому, кто эту строку прочитает.
            planned_at: whenInp.value ? whenInp.value + ':00Z' : null,
            note: noteInp.value.trim(),
        });
        if (error) { toast((error.message) || tr('Не удалось оформить заявку.'), 'fail'); return false; }
        toast(tr('Заявка на госпитализацию оформлена.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ---------------------------------------------------------------------------
// 2. «Положить на койку» (медсестра)
// ---------------------------------------------------------------------------
// Занятые койки и койки на уборке НЕ ПРЯЧУТСЯ. Медсестра ищет глазами
// конкретную койку; не найдя её в списке вовсе, она решает, что экран сломан, и
// идёт смотреть на доску. Койка видна, не нажимается и называет причину.
export function openAdmissionBedPicker({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Заявка не найдена.'), 'fail'); return; }
    const p = admission.patients || {};
    const listBox = h('div', { style: { display: 'grid', gap: '8px', maxHeight: '340px', overflowY: 'auto' } });
    let chosenBed = null;
    let chosenRow = null;

    const wantWardId = admission.ward_id != null ? Number(admission.ward_id) : null;

    async function load() {
        clear(listBox);
        listBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));
        const [bedsR, admR] = await Promise.all([
            supabase.from('beds').select('id, code, status, ward_id, type, wards(name)').eq('active', 1).order('code'),
            supabase.from('admissions').select('id, bed_id, status').in('status', IN_BED_STATUSES),
        ]);
        // Занятость считаем по ГОСПИТАЛИЗАЦИЯМ, как доска коек и как сервер:
        // beds.status — housekeeping, и разойтись с правдой он может.
        const taken = new Set((admR.data || []).map((a) => a.bed_id).filter((v) => v != null));
        let beds = bedsR.data || [];
        if (wantWardId != null) beds = beds.filter((b) => Number(b.ward_id) === wantWardId);

        clear(listBox);
        if (!beds.length) {
            listBox.appendChild(h('div', { class: 'empty', style: { padding: '18px' } },
                tr('Коек в этой палате нет. Заведите койки или измените палату в заявке.')));
            return;
        }
        for (const b of beds) {
            const busy = taken.has(b.id) || b.status === 'occupied';
            const why = busy ? tr('Занята')
                : b.status === 'cleaning' ? tr('Уборка')
                : b.status === 'maintenance' ? tr('Ремонт') : null;
            const free = !why;
            const row = h('button', {
                type: 'button',
                disabled: !free,
                style: {
                    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left',
                    padding: '10px 12px', borderRadius: '10px', font: 'inherit',
                    border: '1px solid var(--ink-100)',
                    background: free ? 'var(--white, #fff)' : 'var(--ink-25, #f7f8fa)',
                    cursor: free ? 'pointer' : 'not-allowed', opacity: free ? '1' : '0.65',
                },
                onclick: () => {
                    if (chosenRow) {
                        chosenRow.style.borderColor = 'var(--ink-100)';
                        chosenRow.style.background = 'var(--white, #fff)';
                    }
                    chosenBed = b;
                    chosenRow = row;
                    row.style.borderColor = 'var(--primary-500, #2b968c)';
                    row.style.background = 'var(--primary-25, #f2faf8)';
                },
            },
                h('span', { style: { fontWeight: 700, fontSize: '13.5px' } }, b.code),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, (b.wards && b.wards.name) || '—'),
                h('span', { style: { flex: 1 } }),
                free ? Tag(tr('Свободна'), { kind: 'ok', dot: true }) : Tag(why, { dot: true }),
            );
            listBox.appendChild(row);
        }
    }
    load();

    modal(tr('Положить на койку'), 'Bed', [
        patientAnchor(p.full_name || '', [p.mrn, admission.department, admission.admission_no].filter(Boolean).join(' · ')),
        wantWardId != null
            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('Заявка оформлена в палату «{ward}» — показаны её койки.', { ward: (admission.wards && admission.wards.name) || '—' }))
            : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Палата в заявке не указана — выберите любую свободную койку.')),
        listBox,
    ], tr('Положить'), async () => {
        if (!chosenBed) { toast(tr('Выберите койку.'), 'fail'); return false; }
        const { error } = await supabase.rpc('admission_admit', { admission_id: admission.id, bed_id: chosenBed.id });
        if (error) { toast((error.message) || tr('Не удалось положить на койку.'), 'fail'); return false; }
        toast(tr('Пациент размещён на койке.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ---------------------------------------------------------------------------
// 3. Отмена заявки — причина обязательна
// ---------------------------------------------------------------------------
// Отменённая заявка — единственный след того, что пациента ждали и не
// дождались. Без слова «почему» этот след не отвечает ни на один вопрос, ради
// которого к нему приходят. Сервер требует причину второй раз, независимо.
export function openAdmissionCancelModal({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Заявка не найдена.'), 'fail'); return; }
    const p = admission.patients || {};
    const reasonInp = h('input', { type: 'text', placeholder: tr('Например: госпитализирован в другую клинику') });

    modal(tr('Отменить заявку на госпитализацию'), 'Warning', [
        patientAnchor(p.full_name || '', [p.mrn, admission.admission_no].filter(Boolean).join(' · ')),
        field(tr('Причина отмены'), reasonInp, { required: true }),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Заявка не удаляется: она останется в истории пациента с этой причиной.')),
    ], tr('Отменить заявку'), async () => {
        const reason = reasonInp.value.trim();
        if (!reason) { toast(tr('Укажите причину отмены заявки.'), 'fail'); return false; }
        const { error } = await supabase.rpc('admission_order_cancel', { admission_id: admission.id, reason });
        if (error) { toast((error.message) || tr('Не удалось отменить заявку.'), 'fail'); return false; }
        toast(tr('Заявка отменена.'), 'ok');
        if (onDone) await onDone();
        return true;
    });
}

// ---------------------------------------------------------------------------
// 4. Карточка маршрута: где пациент и что дальше
// ---------------------------------------------------------------------------
// Что МОЖНО сделать, спрашиваем у сервера (admission_flow_state), а не считаем
// в браузере: матрица прав живёт в rpc/inpatient-flow.js, и её вторая копия
// здесь разошлась бы с первой ровно в тот день, когда матрицу поправят.
export function openAdmissionCard({ admissionId, onChange, onNavigate = null } = {}) {
    if (!admissionId) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const body = h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));
    const { close } = modal(tr('Госпитализация'), 'Bed', [body], null, null, { width: 560 });

    const kv = (k, v) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', fontSize: '13.5px' } },
        h('span', { class: 'muted' }, k), h('span', { style: { fontWeight: 600, textAlign: 'right' } }, v || '—'));

    (async () => {
        const [admR, flowR, capsR] = await Promise.all([
            supabase.from('admissions')
                // КТО ОСМОТРЕЛ и КТО ЛЕЧИТ — два разных человека и два разных
                // JOIN'а на users в одной строке (алиасные embed'ы, реестр
                // admissions). Без них карточка называет состояние «Лечение», не
                // называя лечащего врача, — то есть отвечает на вопрос «где
                // пациент» и молчит о том, «к кому идти».
                .select('*, patients(mrn, full_name), wards(name), beds(code), '
                      + 'attending:attending_doctor_id(full_name, specialty), examined:examined_by(full_name)')
                .eq('id', admissionId).single(),
            supabase.rpc('admission_flow_state', { admission_id: admissionId }),
            // TWO_STEP_DISCHARGE_V1 — второй ответ сервера, и он про ЧЕЛОВЕКА,
            // а не про эту госпитализацию: подать заявку на выписку и отозвать
            // её вправе лечащий врач, главный врач и администратор
            // (CAPABILITY_TRANSITION в rpc/inpatient-flow.js). Считать это в
            // браузере по названию роли — та самая вторая копия матрицы, из-за
            // которой кнопка появляется у того, кому сервер откажет.
            supabase.rpc('inpatient_capabilities', {}),
        ]);
        clear(body);
        if (admR.error || !admR.data) {
            body.appendChild(h('div', { class: 'empty', style: { padding: '18px' } },
                trf('Не удалось загрузить: {msg}', { msg: (admR.error && admR.error.message) || tr('нет данных') })));
            return;
        }
        const a = admR.data;
        const p = a.patients || {};
        const can = (flowR.data && flowR.data.can) || {};
        const may = (capsR && capsR.data && capsR.data.can) || {};

        body.appendChild(patientAnchor(p.full_name || '', [p.mrn, a.admission_no].filter(Boolean).join(' · ')));
        body.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            Tag(tr(admissionStatusLabel(a.status)), { kind: IN_BED_STATUSES.includes(a.status) ? 'ok' : '', dot: true }),
            Tag(tr(a.admission_type === 'emergency' ? 'Экстренная' : 'Плановая')),
            Tag(tr(a.stay_mode === 'day' ? 'Дневной стационар' : 'Круглосуточно')),
        ));
        body.appendChild(h('div', { class: 'card', style: { padding: '12px 14px' } },
            kv(tr('Отделение'), a.department || '—'),
            kv(tr('Палата · койка'), [(a.wards && a.wards.name) || null, (a.beds && a.beds.code) || null].filter(Boolean).join(' · ') || tr('койки нет')),
            kv(tr('Заявка оформлена'), a.ordered_at ? fmtDateTime(a.ordered_at) : '—'),
            kv(tr('Размещён на койке'), a.admitted_by ? fmtDateTime(a.admitted_at) : '—'),
            kv(tr('Первичный осмотр'), a.examined_at
                ? [fmtDateTime(a.examined_at), (a.examined && a.examined.full_name) || null].filter(Boolean).join(' · ')
                : tr('ещё не проведён')),
            kv(tr('Лечащий врач'), (a.attending && a.attending.full_name) || tr('ещё не назначен')),
            kv(tr('Планируемая дата'), a.planned_at ? fmtDateTime(a.planned_at) : '—'),
            kv(tr('Повод / жалобы'), a.chief_complaint || '—'),
            kv(tr('Диагноз направления'), a.admission_diagnosis || '—'),
            a.status === 'cancelled' ? kv(tr('Причина отмены'), a.cancel_reason || '—') : null,
            // TWO_STEP_DISCHARGE_V1 — судьба заявки видна ТОМУ, КТО ЕЁ ПОДАЛ.
            // Врач подаёт заявку и уходит; между «готов» и «оформлено» стоят
            // часы, и всё это время единственный его вопрос — «выписали уже
            // или нет». Без этих строк ответ на него живёт на чужом экране.
            a.discharge_requested_at ? kv(tr('Заявка на выписку подана'), fmtDateTime(a.discharge_requested_at)) : null,
            a.discharge_outcome ? kv(tr('Исход'), outcomeTitle(a.discharge_outcome)) : null,
            a.discharge_destination ? kv(tr('Куда переведён'), a.discharge_destination) : null,
            a.status === 'discharged' && a.discharged_at ? kv(tr('Выписан'), fmtDateTime(a.discharged_at)) : null,
        ));

        const actions = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
        if (can.admitted) {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionBedPicker({ admission: a, onDone: onChange }); },
            }, Icon('Bed', { size: 13 }), ' ', tr('Положить на койку')));
        }
        // INPATIENT_REVIEW_V1 — два шага главного врача. Показываем их по тому
        // же ответу сервера, что и остальные: can.examined — «первичный осмотр»,
        // can.active — «назначить лечащего врача».
        if (can.examined) {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionReviewModal({ admission: a, onDone: onChange }); },
            }, Icon('Stethoscope', { size: 13 }), ' ', tr('Провести первичный осмотр')));
        }
        if (can.active) {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionAttendingModal({ admission: a, onDone: onChange }); },
            }, Icon('User', { size: 13 }), ' ', tr('Назначить лечащего врача')));
        }
        // MAR_SHEET_V1 — лечение открыто: у пациента есть лист назначений, и
        // это первое, куда идут из карточки. Кнопка появляется ровно с того
        // состояния, с которого сервер вообще принимает назначения ('active';
        // 'discharging' — тот же пациент, лечение ещё идёт).
        if (a.status === 'active' || a.status === 'discharging') {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); goToMarSheet(a.id, onNavigate); },
            }, Icon('Pill', { size: 13 }), ' ', tr('Лист назначений')));
        }
        // TWO_STEP_DISCHARGE_V1 — ШАГ 1 ВЫПИСКИ СТОИТ ЗДЕСЬ, и это решение о
        // месте, а не о вёрстке. Исход госпитализации — «домой» / «переведён»
        // / «отказ» / «летальный» — объявляет тот, кто лечил, и объявляет он
        // его в карте СВОЕГО пациента, где уже стоит: осмотр, лечащий врач,
        // лист назначений. Отдельный экран заявок означал бы, что врач ищет
        // того же пациента заново в чужом списке — ровно тот шаг, который
        // отделение и перестаёт делать, выписывая мимо программы.
        //
        // Койку врач НЕ ОСВОБОЖДАЕТ: заявка переводит госпитализацию в
        // 'discharging', и на этом его часть кончается. Оформляет выписку
        // старшая медсестра на своём экране («Выписки к оформлению»).
        if (a.status === 'active' && may.request_discharge) {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionDischargeRequestModal({ admission: a, onDone: onChange }); },
            }, Icon('Check', { size: 13 }), ' ', tr('Заявка на выписку')));
        }
        // ЕДИНСТВЕННАЯ СТРЕЛКА НАЗАД во всём маршруте (lifecycle.js говорит это
        // вслух). За часы между «готов» и «оформлено» состояние меняется, и без
        // отзыва отделению оставалось бы выписать и завести госпитализацию
        // заново — то есть соврать в истории болезни и в деньгах.
        if (a.status === 'discharging' && may.cancel_discharge_request) {
            actions.appendChild(h('button', {
                class: 'btn btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionDischargeCancelModal({ admission: a, onDone: onChange }); },
            }, tr('Отозвать заявку')));
        }
        if (can.cancelled) {
            actions.appendChild(h('button', {
                class: 'btn btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionCancelModal({ admission: a, onDone: onChange }); },
            }, tr('Отменить заявку')));
        }
        if (actions.children.length) body.appendChild(actions);
        else body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Следующий шаг маршрута делает другая роль.')));
    })();
}

// ---------------------------------------------------------------------------
// 5. Первичный осмотр главного врача
// ---------------------------------------------------------------------------
// ФОРМА РАЗДЕЛЕНА НА ЧАСТИ, а не одно поле «текст осмотра», и это не
// оформление: жалобы и объективный статус читает медсестра, диагноз уходит в
// счёт и в выписку, план лечения превращается в лист назначений (Задача 4).
// Склеенные в один абзац, они перестают быть данными (см. шапку миграции 095).
//
// Две кнопки: «Сохранить черновик» не двигает ничего и не закрывает окно —
// осмотр набирают по частям; «Опубликовать» — это шаг маршрута, после которого
// у пациента появляется состояние 'examined' и сразу спрашивается лечащий врач.
// TWO_STEP_DISCHARGE_V1 — ТРЕТИЙ РОД ЗАПИСИ НАЗЫВАЕТСЯ СВОИМ ИМЕНЕМ. Сервер
// принимает три (KINDS в rpc/inpatient-reviews.js: primary / round /
// discharge), а окно знало два и подписывало выписной эпикриз «Записью
// обхода» — то есть врач, посланный отказом писать эпикриз, открывал бы
// документ с чужим названием и не понимал, туда ли он попал.
const REVIEW_TITLE = { primary: 'Первичный осмотр', round: 'Запись обхода', discharge: 'Выписной эпикриз' };
const REVIEW_SUBMIT = { primary: 'Опубликовать осмотр', round: 'Опубликовать запись', discharge: 'Опубликовать эпикриз' };

export function openAdmissionReviewModal({ admission, kind = 'primary', onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const p = admission.patients || {};
    const isPrimary = kind === 'primary';
    const isDischarge = kind === 'discharge';

    const complaints = h('textarea', { rows: '2', placeholder: tr('Что беспокоит пациента') });
    const objective  = h('textarea', { rows: '3', placeholder: tr('Состояние, осмотр по системам, витальные показатели') });
    const diagnosis  = h('input', { type: 'text', placeholder: tr('Диагноз при поступлении') });
    const plan       = h('textarea', { rows: '3', placeholder: tr('Обследование, лечение, режим, стол') });
    const body       = h('textarea', { rows: '2', placeholder: tr('Анамнез, сопутствующее, обоснование') });

    // Незаконченный черновик этого же осмотра подхватывается, а не заводится
    // заново: иначе у одной госпитализации накапливались бы обрывки, и никто не
    // знал бы, какой из них дописывать.
    let reviewId = null;
    (async () => {
        const { data } = await supabase.rpc('admission_reviews_list', { admission_id: admission.id });
        const drafts = ((data && data.reviews) || []).filter((r) => r.kind === kind && !r.published_at);
        const draft = drafts.length ? drafts[drafts.length - 1] : null;
        if (!draft) return;
        reviewId = draft.id;
        complaints.value = draft.complaints || '';
        objective.value = draft.objective || '';
        diagnosis.value = draft.diagnosis || '';
        plan.value = draft.plan || '';
        body.value = draft.body || '';
    })();

    const payload = (publish) => ({
        admission_id: admission.id,
        review_id: reviewId,
        kind,
        complaints: complaints.value.trim(),
        objective: objective.value.trim(),
        diagnosis: diagnosis.value.trim(),
        plan: plan.value.trim(),
        body: body.value.trim(),
        publish,
    });

    modal(tr(REVIEW_TITLE[kind] || REVIEW_TITLE.round), isDischarge ? 'Doc' : 'Stethoscope', [
        patientAnchor(p.full_name || '', [p.mrn, admission.department, admission.admission_no].filter(Boolean).join(' · ')),
        field(tr('Жалобы'), complaints),
        field(tr('Объективно'), objective),
        field(tr('Диагноз'), diagnosis, { required: isPrimary }),
        field(tr('План обследования и лечения'), plan),
        field(tr('Дополнительно'), body),
        isPrimary
            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('После публикации осмотра нужно назначить лечащего врача — без него назначений не будет.'))
            : null,
        // Черновик эпикриза заявку на выписку НЕ ПРОПУСКАЕТ, и сказать это
        // нужно здесь, до того как врач закроет окно кнопкой «Сохранить
        // черновик» и вернётся к отказу, которого не ждал.
        isDischarge
            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Заявку на выписку принимают только по ОПУБЛИКОВАННОМУ эпикризу: черновик — не документ.'))
            : null,
    ], tr(REVIEW_SUBMIT[kind] || REVIEW_SUBMIT.round), async () => {
        if (isPrimary && !diagnosis.value.trim()) { toast(tr('Укажите диагноз.'), 'fail'); return false; }
        const { data, error } = await supabase.rpc('admission_review_save', payload(true));
        if (error) { toast((error.message) || tr('Не удалось сохранить осмотр.'), 'fail'); return false; }
        toast(isPrimary ? tr('Первичный осмотр проведён.') : tr('Запись сохранена.'), 'ok');
        if (onDone) await onDone();
        // Осмотр опубликован — маршрут ждёт лечащего врача, и спрашиваем его
        // здесь же: заставлять главного врача искать того же пациента заново в
        // другом списке значит терять шаг на ровном месте.
        const adm = (data && data.admission) || null;
        if (isPrimary && adm && adm.status === 'examined') {
            openAdmissionAttendingModal({ admission: Object.assign({}, admission, adm, { patients: p }), onDone });
        }
        return true;
    }, {
        width: 600,
        secondaryLabel: tr('Сохранить черновик'),
        onSecondary: async () => {
            const { data, error } = await supabase.rpc('admission_review_save', payload(false));
            if (error) { toast((error.message) || tr('Не удалось сохранить черновик.'), 'fail'); return; }
            if (data && data.review) reviewId = data.review.id;
            toast(tr('Черновик осмотра сохранён.'), 'ok');
        },
    });
}

// ---------------------------------------------------------------------------
// 6. Лечащий врач
// ---------------------------------------------------------------------------
// Список — ТОЛЬКО ВРАЧИ, и признак врача берётся не из текста роли:
// ADMIN_DOCTOR_LIST_V1 (data.js) — администратор клиники может быть врачом, и у
// такой учётной записи role='admin' и пустая специальность. Отфильтруй мы по
// слову 'doctor' — его нельзя было бы назначить лечащим врачом собственного
// пациента. Сервер проверяет тот же признак ещё раз (rpc/inpatient-reviews.js).
export function openAdmissionAttendingModal({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const p = admission.patients || {};
    const sel = h('select', null, h('option', { value: '' }, tr('Выберите врача')));
    supabase.from('users')
        .select('id, full_name, specialty, role, is_doctor, license_number')
        .eq('active', true).order('full_name')
        .then(({ data }) => {
            const doctors = (data || []).filter((u) =>
                u.is_doctor === true || u.is_doctor === 1 ||
                (u.role || '').toLowerCase() === 'doctor' ||
                (u.specialty || '').length > 0 ||
                (u.license_number || '').length > 0);
            for (const d of doctors) {
                sel.appendChild(h('option', { value: String(d.id) },
                    d.full_name + (d.specialty ? '  ·  ' + d.specialty : '')));
            }
        });

    modal(tr('Назначить лечащего врача'), 'User', [
        patientAnchor(p.full_name || '', [p.mrn, admission.admission_no].filter(Boolean).join(' · ')),
        field(tr('Лечащий врач'), sel, { required: true }),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('С этого момента идёт лечение: лечащий врач ведёт назначения, услуги и стол этого пациента.')),
    ], tr('Назначить'), async () => {
        if (!sel.value) { toast(tr('Выберите врача.'), 'fail'); return false; }
        const { error } = await supabase.rpc('admission_set_attending', {
            admission_id: admission.id, doctor_id: Number(sel.value),
        });
        if (error) { toast((error.message) || tr('Не удалось назначить лечащего врача.'), 'fail'); return false; }
        toast(tr('Лечащий врач назначен — лечение открыто.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ---------------------------------------------------------------------------
// 7. Заявка на выписку — ШАГ 1 (TWO_STEP_DISCHARGE_V1, Задача 8)
// ---------------------------------------------------------------------------
// Врач говорит «готов» и НАЗЫВАЕТ ИСХОД. Койку это не освобождает, счёт не
// закрывает и документов не печатает: между заявкой и оформлением стоят часы,
// и делает второй шаг другой человек на своём экране. Ровно это разделение и
// есть смысл двух шагов — одношаговая выписка v0.8.0 отдавала оба решения
// одному человеку, и «домой» нажимала та, кто не лечила.

// ОТКАЗЫ СЕРВЕРА, КОТОРЫЕ ЛЕЧАТСЯ ОДНИМ ДЕЙСТВИЕМ, — дословно (rpc/inpatient.js
// admissionDischargeRequest, проверка 4). Экран НЕ ПЕРЕПИСЫВАЕТ их своими
// словами: у сервера они точнее, и черновик от пустого места он различает
// намеренно — одному врачу осталось нажать «Опубликовать», другому написать
// документ. Здесь эти две строки нужны только затем, чтобы узнать отказ и
// открыть тот самый бланк, а не оставить человека с сообщением и без выхода.
// Тест читает серверный модуль и падает, если строки разъехались.
export const EPICRISIS_REFUSALS = Object.freeze([
    'Выписной эпикриз сохранён черновиком — опубликуйте его, затем подайте заявку.',
    'Выписной эпикриз не написан — заявку на выписку принять нельзя.',
]);

/** Это ли отказ «сначала эпикриз» — то есть ведёт ли он в бланк эпикриза. */
export function needsEpicrisis(message) {
    return EPICRISIS_REFUSALS.includes(String(message == null ? '' : message).trim());
}

export function openAdmissionDischargeRequestModal({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const p = admission.patients || {};

    const outcomeSel = h('select', null,
        ...DISCHARGE_OUTCOMES.map((code) => h('option', { value: code }, outcomeTitle(code))));
    const destInp = h('input', { type: 'text', placeholder: tr('Например: городская больница №1, реанимация') });
    const destBox = h('div', { style: { display: 'none' } },
        field(tr('Куда переведён'), destInp, { required: true }));
    const recInp = h('textarea', { rows: '3', placeholder: tr('Режим, препараты, явка на контроль') });
    // РЕКОМЕНДАЦИИ ПОДХВАТЫВАЮТСЯ, А НЕ СПРАШИВАЮТСЯ ЗАНОВО. Отзыв заявки
    // стирает исход и подпись, но рекомендации оставляет намеренно (шапка
    // admissionDischargeCancelRequest): это набранный врачом клинический текст.
    // Пустое поле в повторной заявке затёрло бы его — сервер пишет то, что
    // прислали, — и весь смысл того решения пропал бы здесь.
    recInp.value = (admission.discharge_recommendations || '');
    const whenInp = h('input', { type: 'datetime-local' });

    // Адрес спрашивается ТОЛЬКО у перевода. Поле «куда», висящее над выпиской
    // домой, заполняют по инерции — и в отчётности появляются переводы, которых
    // не было. Сервер требует его ровно в том же единственном случае.
    const syncOutcome = () => { destBox.style.display = outcomeSel.value === 'transfer' ? '' : 'none'; };
    outcomeSel.addEventListener('change', syncOutcome);
    syncOutcome();

    modal(tr('Заявка на выписку'), 'Check', [
        patientAnchor(p.full_name || '', [p.mrn, admission.department, admission.admission_no].filter(Boolean).join(' · ')),
        field(tr('Исход госпитализации'), outcomeSel, { required: true }),
        destBox,
        field(tr('Рекомендации пациенту'), recInp),
        field(tr('Планируемая дата и время выписки'), whenInp),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Койка остаётся за пациентом. Выписку оформит старшая медсестра: фактическое время, счёт, документы.')),
    ], tr('Подать заявку'), async () => {
        if (outcomeSel.value === 'transfer' && !destInp.value.trim()) {
            toast(tr('Укажите, в какое учреждение переведён пациент.'), 'fail');
            return false;
        }
        const { error } = await supabase.rpc('admission_discharge_request', {
            admission_id: admission.id,
            outcome: outcomeSel.value,
            destination: destInp.value.trim(),
            recommendations: recInp.value.trim(),
            // <input type="datetime-local"> отдаёт «2026-09-05T14:00» без зоны —
            // секунды и Z дописываются здесь, как в заявке на госпитализацию.
            planned_discharge_at: whenInp.value ? whenInp.value + ':00Z' : null,
        });
        if (error) {
            const msg = (error && error.message) || tr('Не удалось подать заявку на выписку.');
            toast(msg, 'fail');
            // ОТКАЗ ВЕДЁТ ТУДА, ГДЕ ЕГО СНИМАЮТ. «Напишите эпикриз» без бланка
            // эпикриза — это тупик: врач закрывает окно и идёт искать, где
            // такой документ вообще заводят. Бланк уже есть, и открывается он
            // тем же родом записи, которого требует сервер (kind='discharge').
            if (needsEpicrisis(msg)) openAdmissionReviewModal({ admission, kind: 'discharge', onDone });
            return false;
        }
        toast(tr('Заявка на выписку подана. Оформит старшая медсестра.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ---------------------------------------------------------------------------
// 8. Отзыв заявки на выписку — единственный шаг назад
// ---------------------------------------------------------------------------
export function openAdmissionDischargeCancelModal({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const p = admission.patients || {};
    const reasonInp = h('input', { type: 'text', placeholder: tr('Например: поднялась температура, выписка отложена') });

    modal(tr('Отозвать заявку на выписку'), 'Warning', [
        patientAnchor(p.full_name || '', [p.mrn, admission.admission_no].filter(Boolean).join(' · ')),
        admission.discharge_outcome
            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, outcomeTitle(admission.discharge_outcome))
            : null,
        field(tr('Причина отзыва'), reasonInp, { required: true }),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Пациент остаётся на своей койке, лечение продолжается. Исход и подпись заявки стираются — следующая заявка объявит их заново; рекомендации и эпикриз остаются.')),
    ], tr('Отозвать заявку'), async () => {
        const reason = reasonInp.value.trim();
        if (!reason) { toast(tr('Укажите причину отзыва заявки на выписку.'), 'fail'); return false; }
        const { error } = await supabase.rpc('admission_discharge_cancel_request', {
            admission_id: admission.id, reason,
        });
        if (error) { toast((error.message) || tr('Не удалось отозвать заявку на выписку.'), 'fail'); return false; }
        toast(tr('Заявка на выписку отозвана. Пациент остаётся в отделении.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}
