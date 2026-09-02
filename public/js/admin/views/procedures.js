// Procedures — nurse work queue for procedure-type services (injections, IV, manipulations).
// SERVICE_ROUTING_V2: a service whose department.kind = 'procedure' lands HERE, not the
// doctor cabinet (consultation.js). Per-department-team — a nurse sees procedures for THEIR
// department (users.department_id); admin/owner and unassigned nurses see all. Branch
// isolation is enforced by RLS on visit_services (via the parent visit's branch).
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, toast, clear, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { hasRestriction, scopedProviderId } from '../permissions.js';
import { currentUser } from '../data.js';
import { openItemPickerModal } from './item-picker-modal.js?v=billoptin1';   // PROC_PRODUCTS_V1 — reuse the dispense picker

const STATUS_RU = { added: 'Назначено', queued: 'В очереди', in_progress: 'Выполняется', completed: 'Выполнено' };
const OPEN = ['added', 'queued', 'in_progress'];
const state = { rows: [], filter: 'open', myDeptId: null, showAll: true, search: '' };   // PROC_SEARCH_V1

export async function renderProcedures(container) {
    clear(container);
    container.appendChild(PageHead({ title: 'Процедуры', subtitle: 'Очередь процедур — инъекции, капельницы, манипуляции' }));
    const body = h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
    container.appendChild(body);
    body.appendChild(h('div', { class: 'muted', style: { padding: '28px', textAlign: 'center' } }, 'Загрузка…'));
    await resolveScope();
    await load();
    paint(body);
}

async function resolveScope() {
    // SERVICE_SCOPE_V1 — procedures are per-PROVIDER now (was per-department): each doctor/nurse
    // sees only procedures assigned to them (visit_services.doctor_id); full admins see all.
    state.providerId = (typeof scopedProviderId === 'function') ? scopedProviderId() : null;
    state.showAll = state.providerId == null;
}

async function load() {
    const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1 — scope to this clinic (super-admin JWT passes RLS on every clinic)
    // SERVICE_GROUP_ROUTING_V1 / PROC_SELECT_FIX_V1 — the routing marker used to sit
    // INSIDE the select template string, which sent '// ...' to PostgREST and 400'd
    // the whole load (the queue rendered empty for everyone).
    const { data, error } = await supabase.from('visit_services')
        .select(`id, status, notes, created_at, service_id, doctor_id,
                 services(name, type, department_id, departments(kind)),
                 users:doctor_id(full_name), verified_at, performer:verified_by(full_name),
                 visits(id, visit_date, patient_id, patients(full_name, last_name, first_name, phone, mrn, date_of_birth, gender))`)
        .eq('company_id', cid)
        // BRANCH_ORIGIN_V1 — решение владельца 2026-09-02: «очередь и кабинет врача —
        // своего здания». Это тот же visit_services, что и «Мои услуги»: чужая процедура
        // приезжает с настоящим статусом и разрешённой услугой и встала бы в очередь
        // медсестры пустой строкой — без врача и без цены.
        .is('sync_origin', null)
        .in('status', ['added', 'queued', 'in_progress', 'completed'])   // SERVICE_BADGE_SENT_V1 — показываем 'added' (Назначено) как «пациент направлен»; провести всё равно нельзя до оплаты (см. #15)
        .order('created_at', { ascending: false }).limit(300);
    if (error) {
        console.warn('[procedures]', error.message);
        toast(trf('Не удалось загрузить процедуры: {msg}', { msg: error.message }), 'fail');
        state.rows = []; return;
    }
    state.rows = (data || [])
        .filter(r => r.services?.departments?.kind === 'procedure' || r.services?.type === 'procedure')   // SERVICE_GROUP_ROUTING_V1
        // PROC_UNASSIGNED_V1 — раньше строка без doctor_id пряталась ОТ ВСЕХ,
        // включая администратора. А процедуре врач обычно не нужен: мастер визита
        // показывает выбор врача только для услуг «нужен врач», поэтому у процедуры
        // doctor_id оставался пустым — и она исчезала по дороге в эту очередь.
        // Теперь неназначенные видны всем и их берёт себе тот, кто выполняет.
        .filter(r => r.doctor_id == null || state.showAll || r.doctor_id === state.providerId)
        .map(r => {
            const p = r.visits?.patients || {};
            return {
                id: r.id, status: r.status, notes: r.notes || '',
                service: r.services?.name || '—',
                patient: [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '—',
                phone: p.phone || '', doctor: r.users?.full_name || '',
                when: r.visits?.visit_date || r.created_at,
                doneAt: r.verified_at || null, doneBy: r.performer?.full_name || '',   // PROC_DONE_STAMP_V1
                // PROC_PRODUCTS_V1 — patient card + product dispensing onto the procedure's visit
                visit_id: r.visits?.id || null, patient_id: r.visits?.patient_id || null,
                mrn: p.mrn || '', dob: p.date_of_birth || null, sex: p.gender || null,
                doctor_id: r.doctor_id || null,
                unassigned: r.doctor_id == null,   // PROC_UNASSIGNED_V1
            };
        });
}

function paint(body) {
    clear(body);
    const counts = {
        open: state.rows.filter(r => OPEN.includes(r.status)).length,
        done: state.rows.filter(r => r.status === 'completed').length,
        all:  state.rows.length,
    };
    const tabs = h('div', { class: 'row', style: { gap: '6px', padding: '12px 14px', borderBottom: '1px solid var(--ink-100, #eee)', flexWrap: 'wrap' } });
    for (const [key, label] of [['open', 'В работе'], ['done', 'Выполнено'], ['all', 'Все']]) {
        tabs.appendChild(h('button', { class: 'btn btn-sm ' + (state.filter === key ? 'btn-primary' : 'btn-outline'), type: 'button',
            onclick: () => { state.filter = key; paint(body); } }, `${label} · ${counts[key]}`));
    }
    // PROC_SEARCH_V1 — live search over service / patient / phone / doctor.
    // Only the row list repaints on input so the field keeps focus.
    const searchInp = h('input', {
        type: 'search', value: state.search || '', placeholder: 'Поиск: услуга, пациент, телефон…',
        style: { marginLeft: 'auto', height: '30px', padding: '0 10px', border: '1px solid var(--ink-200, #ddd)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', width: '250px', outline: 'none' },
        oninput: (e) => { state.search = e.target.value; repaintRows(); },
    });
    tabs.appendChild(searchInp);
    body.appendChild(tabs);
    const rowsWrap = h('div');
    body.appendChild(rowsWrap);
    const repaintRows = () => {
        clear(rowsWrap);
        const q = (state.search || '').trim().toLowerCase();
        const shown = state.rows
            .filter(r => state.filter === 'all' ? true : state.filter === 'done' ? r.status === 'completed' : OPEN.includes(r.status))
            .filter(r => !q || [r.service, r.patient, r.phone, r.doctor].some(v => (v || '').toLowerCase().includes(q)));
        if (!shown.length) {
            rowsWrap.appendChild(h('div', { class: 'empty', style: { padding: '40px', textAlign: 'center' } },
                q ? 'Ничего не найдено' : state.showAll ? 'Нет процедур в этой категории' : 'Нет процедур для вашего отдела'));
            return;
        }
        for (const r of shown) rowsWrap.appendChild(rowEl(r, body));
    };
    repaintRows();
}

function rowEl(r, body) {
    const done = r.status === 'completed';
    // PROC_UNASSIGNED_V1 — «Назначен» (кто должен сделать) и «Выполнил» (кто
    // сделал) — РАЗНЫЕ вопросы: первый живёт в doctor_id, второй в verified_by.
    // Пока никто не назначен, строка это и говорит, а не молчит.
    const whoLine = r.unassigned
        ? (done ? '' : 'Исполнитель не назначен')
        : trf('Исполнитель · {name}', { name: r.doctor });
    return h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '12px 14px', borderBottom: '1px solid var(--ink-50, #f3f3f3)' } },
        h('div', { style: { minWidth: '0' } },
            h('div', { style: { fontWeight: '600', fontSize: '13.5px' } }, r.service),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                [r.patient, r.phone, whoLine, fmtDateTime(r.when)].filter(Boolean).join(' · '))),
        h('div', { class: 'row', style: { gap: '8px', flex: 'none', alignItems: 'center' } },
            // Свободную процедуру берёт себе тот, кто её выполняет — отдельного
            // назначающего в смене нет, а ждать администратора у процедурного
            // кабинета некому.
            r.unassigned && !done
                ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: 'Назначить процедуру на себя',
                    onclick: () => takeProcedure(r, body) }, Icon('User', { size: 13 }), ' Взять')
                : null,
            h('span', { class: 'tag' + (done ? ' tag-ok' : r.unassigned ? ' tag-warn' : ''), style: { fontSize: '12.5px' } },
                STATUS_RU[r.status] || r.status),
            r.status === 'added'
                // #15 — un-released (pay-first): the nurse can't perform it until the cashier confirms (payment/debt).
                ? h('span', { class: 'tag', style: { fontSize: '12.5px', opacity: '.75' } }, Icon('Wallet', { size: 11 }), ' Ожидает кассу')
                : done
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: [r.doneBy, r.doneAt ? fmtDateTime(r.doneAt) : '', r.notes].filter(Boolean).join(' · ') },
                        // PROC_DONE_STAMP_V1 — who pressed «Выполнить» and when
                        [r.doneBy ? '✓ ' + r.doneBy : '✓', r.doneAt ? fmtDateTime(r.doneAt) : '', r.notes].filter(Boolean).join(' · '))
                    : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openDone(r, body) }, 'Выполнить')));
}

// PROC_PRODUCTS_V1 — compact «Выполнить процедуру» modal, styled like the inpatient
// bed card: a patient block on top + a «Товары (расходные материалы)» section where
// consumables are dispensed onto the procedure's visit (same dispense_visit_item RPC
// as the consult/inpatient flows). No «Услуги» section — procedures don't add services.
function openDone(r, body) {
    injectProcStyles();
    const overlay = h('div', { class: 'modal', style: { zIndex: '130' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const note = h('textarea', { rows: '3', placeholder: 'Примечание — доза, место, реакция (необязательно)',
        style: { width: '100%', padding: '8px 10px', border: '1px solid var(--ink-200, #ddd)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', boxSizing: 'border-box', resize: 'vertical' } });
    note.value = r.notes || '';

    // Dispensed-products list for this visit (clinic_item_id rows), with per-line void.
    const itemsWrap = h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' } });
    async function refreshItems() {
        const items = await loadProcItems(r.visit_id);
        clear(itemsWrap);
        if (!items.length) {
            itemsWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 4px', textAlign: 'center' } },
                r.visit_id ? 'Товаров пока нет. Нажмите «Добавить товары», чтобы списать расходники.' : 'Визит не привязан — добавить товары нельзя.'));
            return;
        }
        for (const it of items) {
            itemsWrap.appendChild(h('div', { class: 'proc-item' },
                Icon('Pill', { size: 15 }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600 } }, it.name, h('span', { class: 'muted', style: { fontWeight: 500 } }, ' × ' + it.qty)),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, it.total.toLocaleString('ru-RU') + ' UZS' + (it.invoiced ? ' · в счёте' : ''))),
                it.invoiced
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px' }, title: 'Уже в счёте — убрать нельзя' }, Icon('Check', { size: 12 }))
                    : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { color: 'var(--crit-700)' }, title: 'Убрать (вернуть на склад)',
                        onclick: async () => {
                            if (!confirm(trf('Убрать «{name}»? Товар вернётся на склад.', { name: it.name }))) return;
                            try { const { error } = await supabase.rpc('void_dispensed_visit_item', { p_line: it.id }); if (error) throw error; toast('Товар возвращён на склад.'); await refreshItems(); }
                            catch (e) { toast(e?.message || String(e), 'fail'); }
                        } }, Icon('Trash', { size: 12 }))));
        }
    }

    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: r.visit_id ? null : true,
        onclick: () => openItemPickerModal({
            title: 'Добавить товары', confirmLabel: 'Добавить',
            onConfirm: async (lines) => {
                let ok = 0; const fails = [];
                for (const { item, qty } of lines) {
                    try {
                        const { error } = await supabase.rpc('dispense_visit_item', { p_visit_id: r.visit_id, p_item_id: item.id, p_qty: Number(qty), p_doctor_id: r.doctor_id || null });
                        if (error) throw error; ok++;
                    } catch (e) { fails.push(`${item.name}: ${e?.message || e}`); }
                }
                await refreshItems();
                if (ok === 0) throw new Error(fails[0] || 'Не удалось добавить товары');
                toast(trf('Добавлено позиций: {n}', { n: ok }) + (fails.length ? ' · ' + trf('ошибок: {n}', { n: fails.length }) : ''));
                if (fails.length) toast(fails.join('; '), 'fail');
            },
        }) }, Icon('Plus', { size: 13 }), ' Добавить товары');

    const age = r.dob ? Math.floor((Date.now() - new Date(r.dob).getTime()) / 31557600000) : null;
    const sex = r.sex === 'male' ? 'M' : r.sex === 'female' ? 'F' : null;

    overlay.appendChild(h('div', { class: 'modal-card modal-compact proc-done-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },   // modal-compact = opt out of MODAL_FULLSCREEN_V1
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Drop', { size: 16 }), ' Выполнить процедуру'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' } },
            // PROC_TITLE_BLOCK_V1 — the procedure name as a prominent banner so a
            // nurse/doctor sees at a glance WHICH procedure they are performing.
            h('div', { class: 'proc-title-block' },
                h('div', { class: 'proc-title-ic' }, Icon('Drop', { size: 20 })),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'proc-title-label' }, 'Процедура'),
                    h('div', { class: 'proc-title-name' }, r.service)),
            ),
            // Patient block — inpatient-style card
            h('div', { class: 'proc-pcard' },
                h('div', { class: 'proc-av' }, procInitials(r.patient)),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '15px' } }, r.patient),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        [r.mrn, age != null ? age + ' y' : null, sex, r.phone].filter(Boolean).join(' · ') || '—'))),
            // Products section (расходные материалы)
            h('div', { class: 'proc-sec' },
                h('div', { class: 'proc-sec-head' },
                    h('h4', null, 'Товары (расходные материалы)'),
                    h('span', { style: { flex: 1 } }),
                    addBtn),
                itemsWrap),
            // Note
            h('div', null,
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } }, 'Примечание'),
                note),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 14px', borderTop: '1px solid var(--ink-100, #eee)' } },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, 'Отмена'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
                await complete(r, note.value.trim()); close(); await load(); paint(body);
            } }, 'Отметить выполненной'))));
    document.body.appendChild(overlay);
    refreshItems();
}

// PROC_PRODUCTS_V1 — dispensed clinic-item lines for a visit (same shape as the
// consult «Назначения (в клинике)» list).
async function loadProcItems(visitId) {
    if (!visitId) return [];
    const { data, error } = await supabase.from('visit_services')
        .select('id, quantity, unit_price, invoice_item_id, clinic_item_id, clinic_items(name, unit)')
        .eq('visit_id', visitId).not('clinic_item_id', 'is', null);
    if (error) { console.warn('[procedures] items:', error.message); return []; }
    return (data || []).map(x => {
        const qty = Number(x.quantity ?? 1), price = Number(x.unit_price ?? 0);
        return { id: x.id, invoiced: !!x.invoice_item_id, qty, total: price * qty,
            name: (x.clinic_items?.name || 'Товар') + (x.clinic_items?.unit ? ' (' + x.clinic_items.unit + ')' : '') };
    });
}

function procInitials(name) {
    return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '—';
}

function injectProcStyles() {
    if (document.getElementById('proc-done-styles')) return;
    const s = document.createElement('style');
    s.id = 'proc-done-styles';
    // Injected after admin.css → these !important rules beat MODAL_FULLSCREEN_V1.
    s.textContent = `
.modal-card.proc-done-card { width: 560px !important; max-width: calc(100vw - 32px) !important; height: auto !important; max-height: calc(100vh - 48px) !important; }
.modal-card.proc-done-card > .modal-body { flex: 0 1 auto !important; }
.proc-title-block { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--primary-50, #eff6ff); border: 1px solid var(--primary-200, #bfdbfe); border-radius: 12px; }
.proc-title-ic { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 11px; background: var(--primary-100, #dbeafe); color: var(--primary-700, #1d4ed8); display: flex; align-items: center; justify-content: center; }
.proc-title-label { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700; color: var(--primary-600, #2563eb); }
.proc-title-name { font-size: 20px; font-weight: 700; color: var(--ink-900); line-height: 1.2; overflow-wrap: anywhere; }
.proc-pcard { display: flex; gap: 12px; align-items: center; padding: 12px 14px; background: var(--ink-25); border: 1px solid var(--ink-100); border-radius: 12px; }
.proc-av { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 50%; background: var(--primary-100, #dbeafe); color: var(--primary-700, #1d4ed8); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
.proc-sec { border: 1px solid var(--ink-100); border-radius: 12px; overflow: hidden; }
.proc-sec-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--ink-100); background: var(--ink-25); }
.proc-sec-head h4 { margin: 0; font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-700); }
.proc-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--primary-50); border: 1px solid var(--primary-200); border-radius: 9px; }
`;
    document.head.appendChild(s);
}

// PROC_UNASSIGNED_V1 — «Взять»: свободная процедура закрепляется за тем, кто
// нажал. Пишем doctor_id (это и есть исполнитель — так строка его и подписывает),
// статус НЕ трогаем: очередь кассы и «Выполнить» живут своим порядком.
async function takeProcedure(r, body) {
    const me = currentUser();
    if (!me || me.id == null) { toast('Не удалось определить пользователя — войдите заново.', 'fail'); return; }
    const { error } = await supabase.from('visit_services').update({ doctor_id: me.id }).eq('id', r.id);
    if (error) { toast(trf('Не удалось взять процедуру: {msg}', { msg: error.message }), 'fail'); return; }
    toast('Процедура закреплена за вами');
    await load();
    paint(body);
}

async function complete(r, noteText) {
    if (r.status === 'added') { toast('Услуга не проведена кассой — сначала оплата или долг.', 'fail'); return; }   // #15 — defense-in-depth
    // PROC_DONE_STAMP_V1 — record WHO pressed «Выполнить» and WHEN (verified_by /
    // verified_at double as the performer stamp for procedure rows; lab rows use
    // them for result verification — the two flows never share a row).
    const _me = currentUser();
    const payload = {
        status: 'completed', notes: noteText || null,
        verified_at: new Date().toISOString(), verified_by: (_me && _me.id) || null,
    };
    // PROC_UNASSIGNED_V1 — выполнить свободную процедуру, не нажимая «Взять»,
    // тоже можно: тогда исполнителем становится тот, кто её провёл. Иначе строка
    // осталась бы «не назначена» уже после выполнения.
    if (r.unassigned && _me && _me.id != null) payload.doctor_id = _me.id;
    const { error } = await supabase.from('visit_services').update(payload).eq('id', r.id);
    if (error) { toast(trf('Ошибка: {msg}', { msg: error.message }), 'fail'); return; }
    toast('Процедура выполнена');
}
