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
//
// Все четыре — вокруг ОДНОГО источника правды: RPC `admission_order_create`,
// `admission_admit`, `admission_order_cancel` и чтение `admission_flow_state`.
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

const ADMISSION_TYPES = [['planned', 'Плановая'], ['emergency', 'Экстренная']];
const STAY_MODES = [['round', 'Круглосуточно'], ['day', 'Дневной стационар']];

// Одна и та же оболочка окна для всех четырёх диалогов: два окна госпитализации
// с разной рамкой читаются как два разных продукта.
function modal(title, icon, bodyEls, submitLabel, onSubmit, { width = 520 } = {}) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const foot = [h('button', { class: 'btn', type: 'button', onclick: close }, tr('Закрыть')), h('span', { class: 'grow' })];
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

// ПАЦИЕНТ — ЯКОРЬ. Одна плашка на все четыре окна: имя крупнее всего
// остального. Это та самая защита от «не того пациента», ради которой построен
// экран медсестры, и в диалоге она нужна ровно так же — подтверждают действие
// именно здесь, а не в списке.
function patientAnchor(name, sub) {
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
export function openAdmissionCard({ admissionId, onChange } = {}) {
    if (!admissionId) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }
    const body = h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));
    const { close } = modal(tr('Госпитализация'), 'Bed', [body], null, null, { width: 560 });

    const kv = (k, v) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', fontSize: '13.5px' } },
        h('span', { class: 'muted' }, k), h('span', { style: { fontWeight: 600, textAlign: 'right' } }, v || '—'));

    (async () => {
        const [admR, flowR] = await Promise.all([
            supabase.from('admissions')
                .select('*, patients(mrn, full_name), wards(name), beds(code)')
                .eq('id', admissionId).single(),
            supabase.rpc('admission_flow_state', { admission_id: admissionId }),
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
            kv(tr('Первичный осмотр'), a.examined_at ? fmtDateTime(a.examined_at) : tr('ещё не проведён')),
            kv(tr('Планируемая дата'), a.planned_at ? fmtDateTime(a.planned_at) : '—'),
            kv(tr('Повод / жалобы'), a.chief_complaint || '—'),
            kv(tr('Диагноз направления'), a.admission_diagnosis || '—'),
            a.status === 'cancelled' ? kv(tr('Причина отмены'), a.cancel_reason || '—') : null,
        ));

        const actions = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
        if (can.admitted) {
            actions.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => { close(); openAdmissionBedPicker({ admission: a, onDone: onChange }); },
            }, Icon('Bed', { size: 13 }), ' ', tr('Положить на койку')));
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
