// Закупки — «Поставщики» tab (PROCUREMENT_REDESIGN_V1): простой CRUD-справочник.
// Удаления нет — поставщика деактивируют, чтобы прошлые записи не ломались
// (registry: delete roles []).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard } from './inventory-shared.js';
import { phoneInput } from '../phone-input.js?v=ph1';

const refs = { tbody: null, emptyEl: null, totalEl: null };

export function renderSuppliersTab(container) {
    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет поставщиков — добавьте первого.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openSupplierModal(null, fetchAndPaint),
    }, Icon('Plus', { size: 14 }), ' Добавить поставщика');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            refs.totalEl,
            h('div', { class: 'page-head-actions' }, addBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Название'),
                    h('th', null, 'Контактное лицо'),
                    h('th', null, 'Телефон'),
                    h('th', null, 'Примечание'),
                    h('th', null, 'Статус'),
                )),
                refs.tbody,
            ),
            refs.emptyEl,
        ),
    ));

    fetchAndPaint();
}

async function fetchAndPaint() {
    const token = ++fetchGuard.token;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '5', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…')));
    try {
        const { data, error } = await supabase.from('suppliers')
            .select('*')
            .order('name', { ascending: true })
            .limit(500);
        if (token !== fetchGuard.token) return;
        if (error) throw error;
        paintRows(data || []);
        refs.totalEl.textContent = trf('Поставщиков: {n}', { n: (data || []).length });
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast(trf('Не удалось загрузить поставщиков: {msg}', { msg: (e && e.message) || e }), 'fail');
        paintRows([]);
    }
}

function paintRows(rows) {
    clear(refs.tbody);
    if (!rows.length) { refs.emptyEl.style.display = ''; return; }
    refs.emptyEl.style.display = 'none';
    for (const s of rows) {
        refs.tbody.appendChild(h('tr', {
            class: 'row-click',
            style: { cursor: 'pointer', opacity: s.active ? '' : '0.55' },
            onclick: () => openSupplierModal(s, fetchAndPaint),
        },
            h('td', { class: 'cell-strong' }, s.name || '—'),
            h('td', null, s.contact || '—'),
            h('td', null, s.phone || '—'),
            h('td', { class: 'muted' }, s.note || ''),
            h('td', null, Tag(s.active ? 'Активен' : 'Неактивен', { kind: s.active ? 'ok' : '', dot: true })),
        ));
    }
}

export function openSupplierModal(s, onSaved) {
    const isEdit = !!s;
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInp = h('input', { type: 'text', required: true, value: s ? (s.name || '') : '' });
    const contactInp = h('input', { type: 'text', value: s ? (s.contact || '') : '' });
    const phoneInp = phoneInput('phone', '+998 90 961 00 04', { value: s ? s.phone : '' });
    const noteInp = h('input', { type: 'text', value: s ? (s.note || '') : '' });
    const activeChk = h('input', { type: 'checkbox', checked: s ? !!s.active : true });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    saveBtn.addEventListener('click', save);

    async function save() {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название поставщика.', 'fail'); return; }
        saveBtn.disabled = true;
        const prev = saveBtn.textContent;
        saveBtn.textContent = tr('Сохраняем…');
        try {
            const payload = {
                name,
                contact: contactInp.value.trim(),
                phone:   phoneInp.value.trim(),
                note:    noteInp.value.trim(),
                active:  activeChk.checked ? 1 : 0,
            };
            const { error } = isEdit
                ? await supabase.from('suppliers').update(payload).eq('id', s.id).select().single()
                : await supabase.from('suppliers').insert(payload).select().single();
            if (error) throw error;
            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '420px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Building', { size: 16 }), ' ', isEdit ? 'Поставщик' : 'Добавить поставщика'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Название', nameInp, { required: true }),
            field('Контактное лицо', contactInp),
            field('Телефон', phoneInp),
            field('Примечание', noteInp),
            checkField('Активен', activeChk),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}
