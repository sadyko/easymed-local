// CUSTDEV_V1 — рабочее место обзвона (docs/specs/2026-08-25-custdev-survey-design.md).
//
// Открывается кнопкой «Cust Dev» рядом с «Канбан» в CRM. Оператор звонит тем,
// кто пришёл и оплатил, и оценивает три точки: регистратуру, кассу и врача.
//
// ТРИ ИЗ ПЯТИ КОЛОНОК ВЫЧИСЛЯЕМЫЕ. Перетаскивать карточку в «Доволен» нельзя:
// перетаскивание противоречило бы оценкам, из которых эта колонка получилась.
// Руками двигаются только «Не обзвонён» и «Не дозвонились».

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { canEdit } from '../permissions.js';

const STATUSES = [
    ['new',         'Не обзвонён',      'info'],
    ['unreachable', 'Не дозвонились',   'warn'],
    ['satisfied',   'Доволен',          'ok'],
    ['partial',     'Частично доволен', 'purple'],
    ['unsatisfied', 'Недоволен',        'crit'],
];
// Куда можно бросить карточку мышью. Остальные три следуют из оценок.
const MANUAL = ['new', 'unreachable'];

const SCORES = [
    ['good', 'Доволен'],
    ['bad',  'Не доволен'],
    ['na',   'Не применимо'],
];
const SCORE_TAG = { good: 'ok', bad: 'crit', na: '', unrated: '' };
const SCORE_RU = { good: 'Доволен', bad: 'Не доволен', na: 'Не применимо', unrated: 'Не оценено' };

const CRITERIA = [
    ['registrar', 'Регистратура', 'registrar_name', 'score_registrar'],
    ['cashier',   'Касса',        'cashier_name',   'score_cashier'],
    ['doctor',    'Врач',         'doctor_name',    'score_doctor'],
];

const PERIODS = [['today', 'Сегодня'], ['week', 'Эта неделя'], ['30', '30 дней'], ['custom', 'Свой период']];

// Период по умолчанию — 30 дней. «Сегодня» на этой доске ВСЕГДА пусто: карточка
// появляется на следующий день после визита. Открывать рабочее место на заведомо
// пустом экране значит показать поломку там, где её нет.
const state = { period: '30', from: '', to: '', search: '', rows: [], editable: false };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtD = (iso) => (iso || '').slice(0, 10).split('-').reverse().join('.');
const money = (n) => (Number(n) || 0).toLocaleString('ru-RU');

// Границы периода — местные сутки, как в CRM: клиника считает календарными
// днями, а не окнами по 24 часа.
function bounds() {
    if (state.period === 'custom') return { from: state.from, to: state.to };
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const to = ymd(new Date());
    if (state.period === 'today') return { from: ymd(d), to };
    if (state.period === 'week') {
        // Неделя с ПОНЕДЕЛЬНИКА: getDay() считает воскресенье нулём, иначе в
        // воскресенье «эта неделя» показала бы один день.
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return { from: ymd(d), to };
    }
    d.setDate(d.getDate() - 29);
    return { from: ymd(d), to };
}

export async function openCustDev() {
    if (state.period === 'custom' && !state.from && !state.to) {
        const now = new Date();
        state.from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        state.to = ymd(now);
    }
    state.editable = canEdit('custdev');

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

    const body = h('div', { class: 'modal-body', style: { minHeight: '300px' } });
    const filters = h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' } });

    overlay.appendChild(h('div', {
        class: 'modal-card',
        style: { width: 'calc(100vw - 48px)', maxWidth: '1600px', height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' },
    },
        h('header', { class: 'modal-head' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                h('span', { style: { width: '34px', height: '34px', borderRadius: '10px', background: 'var(--teal-50, #e0f2f1)', color: 'var(--teal-700, #00796b)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                    Icon('PhoneOut', { size: 17 })),
                h('div', null,
                    h('h2', { style: { margin: 0, fontSize: '15px' } }, 'Cust Dev · Обзвон пациентов'),
                    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '1px' } },
                        state.editable
                            ? 'Пришли и оплатили: спросите про регистратуру, кассу и врача'
                            : 'Доступ «Только просмотр»: оценивать карточки нельзя'))),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { style: { padding: '12px 20px 0' } }, filters),
        body));

    document.body.appendChild(overlay);
    paintFilters();
    await reload();

    function paintFilters() {
        clear(filters);
        const chip = (on, label, onclick) => h('button', { class: 'wzc-cat' + (on ? ' on' : ''), type: 'button', onclick }, label);

        const search = h('input', {
            class: 'crm-search', type: 'search', placeholder: 'Поиск по имени или телефону…', value: state.search,
            style: { width: '260px', height: '36px', padding: '0 12px', border: '1px solid var(--ink-200, #d1d5db)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13px' },
        });
        search.addEventListener('input', () => { state.search = search.value; paintBoard(); });
        filters.appendChild(search);

        const per = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        for (const [key, label] of PERIODS) {
            per.appendChild(chip(state.period === key, label, () => {
                if (key === 'custom' && !state.from && !state.to) {
                    const now = new Date();
                    state.from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
                    state.to = ymd(now);
                }
                state.period = key;
                paintFilters();
                reload();
            }));
        }
        if (state.period === 'custom') {
            const box = h('div', { class: 'crm-range' });
            const inp = (value, onchange) => {
                const el = h('input', { type: 'date', value: value || '' });
                el.addEventListener('change', () => { onchange(el.value); reload(); });
                return el;
            };
            box.appendChild(h('span', { class: 'lbl' }, 'с'));
            box.appendChild(inp(state.from, (v) => { state.from = v; }));
            box.appendChild(h('span', { class: 'lbl' }, 'по'));
            box.appendChild(inp(state.to, (v) => { state.to = v; }));
            per.appendChild(box);
        }
        filters.appendChild(per);

        filters.appendChild(h('span', { style: { flex: 1 } }));
        filters.appendChild(h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => openReport(bounds()) },
            Icon('Chart', { size: 13 }), ' Отчёт'));
        filters.appendChild(h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => toExcel(filtered()) },
            Icon('Download', { size: 13 }), ' Excel'));
    }

    async function reload() {
        const b = bounds();
        if (!b.from || !b.to) { state.rows = []; paintBoard(); return; }

        // supabase.rpc() НИКОГДА не бросает — ошибку возвращает в { error }.
        // Здесь стояло `state.rows = await supabase.rpc(...)`, и в state.rows
        // ложился объект { data, error }: rows.length давал undefined (экран
        // говорил «обзванивать некого»), а следующий rows.filter() падал
        // TypeError-ом ещё до отрисовки колонок. Доска была пуста при 344
        // карточках в базе.
        //
        // Ошибку синхронизации глотаем НАМЕРЕННО: у клиники с просроченной
        // лицензией custdev_sync — запись и вернёт 402, но уже созданные
        // карточки читаться должны, иначе «только чтение» превратилось бы в
        // пустой экран.
        await supabase.rpc('custdev_sync', b);

        const { data, error } = await supabase.rpc('custdev_list', b);
        if (error) {
            toast('Не удалось загрузить карточки: ' + (error.message || ''), 'fail');
            state.rows = [];
        } else {
            state.rows = Array.isArray(data) ? data : [];
        }
        paintBoard();
    }

    function filtered() {
        const q = state.search.trim().toLowerCase();
        if (!q) return state.rows;
        return state.rows.filter(r => (r.patient_name || '').toLowerCase().includes(q) || (r.phone || '').includes(q));
    }

    function paintBoard() {
        clear(body);
        const rows = filtered();

        if (!rows.length) {
            body.appendChild(h('p', { class: 'muted', style: { padding: '20px 0' } },
                'За выбранный период обзванивать некого. Карточка появляется на следующий день после оплаченного визита.'));
        }

        const board = h('div', { 'data-cd-board': '', style: { display: 'grid', gridTemplateColumns: `repeat(${STATUSES.length}, minmax(230px, 1fr))`, gap: '12px', overflowX: 'auto', paddingBottom: '6px' } });
        for (const [key, label, kind] of STATUSES) {
            const colRows = rows.filter(r => r.status === key);
            const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '60px', padding: '4px' } });
            for (const r of colRows) list.appendChild(cardEl(r));

            board.appendChild(h('div', {
                class: 'card', 'data-col': key,
                style: { padding: '10px 12px', background: 'var(--ink-25, #f8fafa)' },
            },
                h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
                    Tag(label, { kind, dot: true }),
                    h('span', { class: 'muted', style: { fontSize: '12px', fontWeight: 700 } }, String(colRows.length))),
                list));
        }
        body.appendChild(board);
    }

    function cardEl(r) {
        const line = (...kids) => h('div', { style: { fontSize: '12.5px', marginTop: '4px', overflowWrap: 'anywhere' } }, ...kids);

        const scores = h('div', { class: 'row', style: { gap: '4px', marginTop: '8px', flexWrap: 'wrap' } });
        for (const [, label, , col] of CRITERIA) {
            scores.appendChild(Tag(label.slice(0, 4) + ': ' + SCORE_RU[r[col]], { kind: SCORE_TAG[r[col]] || '' }));
        }

        const card = h('div', {
            style: { background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', touchAction: 'none', userSelect: 'none' },
            onclick: () => openRate(r, reload, state.editable),
        },
            h('div', { class: 'row', style: { gap: '6px', alignItems: 'baseline' } },
                h('span', { style: { flex: 1, minWidth: 0, fontWeight: 700, fontSize: '13px', overflowWrap: 'anywhere' } }, r.patient_name || '—'),
                h('span', { class: 'muted', style: { fontSize: '11px', whiteSpace: 'nowrap' } }, fmtD(r.visit_date))),
            line(h('span', { class: 'num' }, r.phone || '—')),
            r.mrn ? line(Tag(r.mrn, { kind: 'ok' })) : null,
            line(h('span', { class: 'muted' }, 'Оплачено: '), money(r.paid_amount), ' сум'),
            line(h('span', { class: 'muted' }, 'Врач: '), r.doctor_name || '—'),
            line(h('span', { class: 'muted' }, 'Касса: '), r.cashier_name || '—'),
            line(h('span', { class: 'muted' }, 'Регистратура: '), r.registrar_name || '—'),
            scores,
            r.comment ? line(h('span', { class: 'muted' }, r.comment)) : null);

        if (state.editable && MANUAL.includes(r.status)) attachDrag(card, r);
        return card;
    }

    // Перетаскивание на pointer-событиях — как в CRM (HTML5 DnD там часто вовсе
    // не стартовал). Разрешено ТОЛЬКО между двумя ручными колонками.
    function attachDrag(card, r) {
        card.style.cursor = 'grab';
        card.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 && ev.pointerType === 'mouse') return;
            if (ev.target.closest('button, select, input, a')) return;
            try { card.setPointerCapture(ev.pointerId); } catch (e) { /* не критично */ }

            const startX = ev.clientX, startY = ev.clientY;
            let ghost = null, overCol = null, dx = 0, dy = 0;

            const mark = (col) => {
                if (overCol === col) return;
                if (overCol) overCol.style.outline = 'none';
                // Подсвечиваем ТОЛЬКО те колонки, куда бросить можно: подсветка
                // над «Доволен» обещала бы действие, которого не будет.
                if (col && MANUAL.includes(col.dataset.col)) {
                    overCol = col;
                    overCol.style.outline = '2px dashed var(--primary-300, #7fcbb8)';
                } else {
                    overCol = null;
                }
            };
            const onMove = (mv) => {
                if (!ghost) {
                    if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 7) return;
                    const rect = card.getBoundingClientRect();
                    dx = startX - rect.left; dy = startY - rect.top;
                    ghost = card.cloneNode(true);
                    Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', margin: '0', zIndex: '9999', pointerEvents: 'none', boxShadow: '0 12px 28px rgba(0,0,0,0.2)', transform: 'rotate(2deg)', opacity: '0.95' });
                    document.body.appendChild(ghost);
                    card.style.opacity = '0.35';
                }
                ghost.style.left = (mv.clientX - dx) + 'px';
                ghost.style.top = (mv.clientY - dy) + 'px';
                const under = document.elementFromPoint(mv.clientX, mv.clientY);
                mark(under ? under.closest('[data-col]') : null);
                mv.preventDefault();
            };
            const cleanup = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', cleanup);
                card.style.cursor = 'grab';
                if (overCol) overCol.style.outline = 'none';
                if (ghost) { ghost.remove(); card.style.opacity = '1'; }
            };
            const onUp = async () => {
                const target = overCol;
                cleanup();
                if (!target || target.dataset.col === r.status) return;
                const { error } = await supabase.rpc('custdev_mark', { card_id: r.id, status: target.dataset.col });
                if (error) { toast(error.message || 'Не удалось изменить статус.', 'fail'); return; }
                await reload();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', cleanup);
        });
    }
}

// Попап оценки. Открывается поверх рабочего места (z-index выше, как у
// вложенного попапа в CRM), потому что оператор возвращается на доску сразу
// после звонка и терять её позицию незачем.
function openRate(r, onSaved, editable) {
    const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => ov.remove();
    ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });

    // Оценка, уже стоящая на карточке, — стартовое значение. 'unrated'
    // означает «ещё не спрашивали», выбранной кнопки нет.
    const picked = {
        registrar: r.score_registrar === 'unrated' ? '' : r.score_registrar,
        cashier:   r.score_cashier   === 'unrated' ? '' : r.score_cashier,
        doctor:    r.score_doctor    === 'unrated' ? '' : r.score_doctor,
    };

    const comment = h('textarea', {
        rows: 3, placeholder: 'Что сказал пациент',
        style: { width: '100%', fontFamily: 'inherit', fontSize: '13px', padding: '8px 10px', borderRadius: '10px', border: '1px solid var(--ink-200, #d1d5db)' },
    });
    comment.value = r.comment || '';
    comment.disabled = !editable;
    comment.addEventListener('input', syncSave);

    const hint = h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить');

    const groups = {};
    function groupEl(key, label, who) {
        const row = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        const buttons = {};
        for (const [val, text] of SCORES) {
            const b = h('button', {
                class: 'wzc-cat' + (picked[key] === val ? ' on' : ''), type: 'button',
                disabled: !editable,
                onclick: () => { picked[key] = val; repaint(); },
            }, text);
            buttons[val] = b;
            row.appendChild(b);
        }
        groups[key] = buttons;
        return field(label + (who ? ' · ' + who : ''), row);
    }

    function repaint() {
        for (const [key, buttons] of Object.entries(groups)) {
            for (const [val, b] of Object.entries(buttons)) {
                b.classList.toggle('on', picked[key] === val);
            }
        }
        syncSave();
    }

    // Кнопка «Сохранить» гаснет, пока сохранять нельзя, И говорит почему.
    // Заблокированная кнопка без объяснения читается как поломка.
    function syncSave() {
        if (!editable) { saveBtn.disabled = true; hint.textContent = 'Доступ «Только просмотр».'; return; }
        const vals = [picked.registrar, picked.cashier, picked.doctor];
        if (vals.some(v => !v)) { saveBtn.disabled = true; hint.textContent = 'Оцените все три пункта — или отметьте «Не применимо».'; return; }
        if (vals.every(v => v === 'na')) { saveBtn.disabled = true; hint.textContent = 'Три «Не применимо» оценкой не являются.'; return; }
        if (vals.includes('bad') && !comment.value.trim()) {
            saveBtn.disabled = true;
            hint.textContent = 'Есть «Не доволен» — напишите, что именно не устроило.';
            return;
        }
        saveBtn.disabled = false;
        hint.textContent = '';
    }

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const { error } = await supabase.rpc('custdev_rate', {
            card_id: r.id, registrar: picked.registrar, cashier: picked.cashier,
            doctor: picked.doctor, comment: comment.value,
        });
        // Отказ сервера ОБЯЗАН быть виден. Пока ошибка проверялась через
        // try/catch, которого rpc() не использует, отказ проходил незамеченным:
        // попап закрывался с «Оценка сохранена», а в базе не менялось ничего.
        if (error) {
            toast(error.message || 'Не удалось сохранить оценку.', 'fail');
            syncSave();
            return;
        }
        toast('Оценка сохранена.', 'ok');
        close();
        await onSaved();
    });

    const noAnswer = h('button', { class: 'btn btn-outline', type: 'button', disabled: !editable },
        Icon('PhoneMissed', { size: 14 }), ' Не дозвонились');
    noAnswer.addEventListener('click', async () => {
        noAnswer.disabled = true;
        const { error } = await supabase.rpc('custdev_mark', { card_id: r.id, status: 'unreachable' });
        if (error) {
            toast(error.message || 'Не удалось изменить статус.', 'fail');
            noAnswer.disabled = false;
            return;
        }
        close();
        await onSaved();
    });

    ov.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0, fontSize: '15px' } }, r.patient_name || 'Карточка'),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '1px' } },
                    'Визит ' + fmtD(r.visit_date) + ' · ' + (r.phone || 'телефон не указан'))),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            groupEl('registrar', 'Регистратура', r.registrar_name),
            groupEl('cashier', 'Касса', r.cashier_name),
            groupEl('doctor', 'Врач', r.doctor_name),
            field('Комментарий', comment),
            hint),
        h('footer', { class: 'modal-foot' },
            noAnswer,
            h('span', { style: { flex: 1 } }),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Отмена'),
            saveBtn)));

    document.body.appendChild(ov);
    syncSave();
}

// Отчёт за период. Считает СЕРВЕР: доска читает максимум 1000 карточек, а
// отчёт должен отвечать за весь период, а не за то, что поместилось на экран.
async function openReport(b) {
    const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => ov.remove();
    ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });

    const body = h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, 'Считаем…'));
    ov.appendChild(h('div', { class: 'modal-card', style: { width: '860px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0, fontSize: '15px' } }, Icon('Chart', { size: 16 }), ' Отчёт по обзвону'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        body));
    document.body.appendChild(ov);

    const { data: rep, error } = await supabase.rpc('custdev_report', b);
    if (error || !rep) {
        clear(body);
        body.appendChild(h('p', { class: 'muted' },
            'Не удалось построить отчёт: ' + ((error && error.message) || 'пустой ответ')));
        return;
    }

    const kpi = (label, value, sub) => h('div', { class: 'card', style: { padding: '12px 14px', flex: '1 1 150px' } },
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
        h('div', { style: { fontSize: '22px', fontWeight: 700, marginTop: '4px' } }, String(value)),
        sub ? h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub) : null);

    function staffTable(title, rows) {
        if (!rows.length) {
            return h('div', { style: { marginTop: '16px' } },
                h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, title),
                h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Нет оценённых карточек за период.'));
        }
        const tb = h('tbody');
        for (const r of rows) {
            tb.appendChild(h('tr', null,
                h('td', null, r.name || '—'),
                h('td', { style: { textAlign: 'right' } }, String(r.good)),
                h('td', { style: { textAlign: 'right' } }, String(r.bad)),
                h('td', { style: { textAlign: 'right', fontWeight: 700 } }, r.pct + ' %')));
        }
        return h('div', { style: { marginTop: '16px' } },
            h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, title),
            h('table', { class: 'table' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Сотрудник'),
                    h('th', { style: { textAlign: 'right' } }, 'Доволен'),
                    h('th', { style: { textAlign: 'right' } }, 'Не доволен'),
                    h('th', { style: { textAlign: 'right' } }, '% довольных'))),
                tb));
    }

    clear(body);
    body.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
        'Период: ' + fmtD(b.from) + ' — ' + fmtD(b.to)));
    body.appendChild(h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
        kpi('Карточек', rep.total),
        kpi('Обзвонено', rep.called, rep.calledPct + ' %'),
        kpi('Доволен', rep.satisfied),
        kpi('Частично', rep.partial),
        kpi('Недоволен', rep.unsatisfied),
        kpi('Не дозвонились', rep.unreachable)));
    body.appendChild(staffTable('По врачам', rep.byDoctor));
    body.appendChild(staffTable('По кассирам', rep.byCashier));
    body.appendChild(staffTable('По регистраторам', rep.byRegistrar));
}

// Выгрузка тем же вендоренным SheetJS, что в CRM. Никаких CDN.
async function toExcel(rows) {
    if (!rows.length) { toast('Нет карточек для выгрузки.', 'fail'); return; }
    try {
        const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
        const statusRu = Object.fromEntries(STATUSES.map(([k, l]) => [k, l]));
        const aoa = [
            ['Пациент', 'MRN', 'Дата визита', 'Телефон', 'Оплачено', 'Регистратор', 'Кассир', 'Врач',
             'Регистратура', 'Касса', 'Врач (оценка)', 'Статус', 'Комментарий', 'Кто звонил', 'Когда'],
            ...rows.map(r => [
                r.patient_name || '', r.mrn || '', fmtD(r.visit_date), r.phone || '', Number(r.paid_amount) || 0,
                r.registrar_name || '', r.cashier_name || '', r.doctor_name || '',
                SCORE_RU[r.score_registrar], SCORE_RU[r.score_cashier], SCORE_RU[r.score_doctor],
                statusRu[r.status] || r.status, r.comment || '',
                r.called_by_name || '', (r.called_at || '').replace('T', ' ').slice(0, 16),
            ]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 },
                       { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 14 },
                       { wch: 14 }, { wch: 18 }, { wch: 34 }, { wch: 18 }, { wch: 16 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Cust Dev');
        XLSX.writeFile(wb, 'custdev.xlsx');
    } catch (e) {
        toast('Не удалось сформировать Excel: ' + ((e && e.message) || e), 'fail');
    }
}
