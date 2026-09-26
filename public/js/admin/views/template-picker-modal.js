// Template picker modal — TEMPLATE_PICKER_V1 (FAST_REG_ONE_SCREEN_V1, задача T2).
//
// A small, reusable «Пакеты» (service template) picker: any window that wants
// to let the user pick one of the clinic's service_templates gets it from
// here, instead of growing its own copy of the list-of-rows markup. The visit
// wizard (views/visit-wizard.js, openTemplatePicker()) has its own local
// picker with the same look — this module does not replace it (that one also
// offers «Убрать шаблон из списка», which is out of scope here), but new
// callers (e.g. the fast one-screen registration flow) should reach for this
// one rather than re-implementing the rows.
//
// Data layer only comes from service-templates.js: listTemplates() for the
// rows, templateSize() for the «N усл.» count. Turning a picked template into
// actual services (resolveTemplate against a catalogue) is the caller's job —
// this dialog only ever hands back the raw template row.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { listTemplates, templateSize, packageDiscount } from './service-templates.js?v=tpl1';   // WIZ_TEMPLATES_LOCAL_V1

// PACKAGES_V1 — «−20 % · до 30.09» под названием пакета: скидку и срок видно
// ДО выбора. Список уже отобран по сегодняшнему дню (listTemplates).
export function packageTermsText(t) {
    const pct = packageDiscount(t);
    const until = String((t && t.valid_until) || '').slice(0, 10);
    const bits = [];
    if (pct > 0) bits.push(trf('скидка {pct} %', { pct: String(pct).replace('.', ',') }));
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) bits.push(trf('до {date}', { date: until.slice(8, 10) + '.' + until.slice(5, 7) + '.' + until.slice(0, 4) }));
    return bits.join(' · ');
}

/**
 * TEMPLATE_PICKER_V1 — выбор пакета услуг (service_templates) в любом окне.
 * onPick(template) получает строку шаблона {id, name, service_ids}; разворачивать
 * её в услуги — забота вызывающего (resolveTemplate из service-templates.js).
 * Только выбор: сохранить/убрать шаблон остаются в мастере визита.
 */
export function openTemplatePickerModal({ onPick, title = 'Пакеты услуг' } = {}) {
    const pick = typeof onPick === 'function' ? onPick : () => {};

    const overlay = h('div', { class: 'modal', 'data-dialog': 'template-picker', style: { zIndex: '180' } });
    // Список пакетов спрашивается у сервера, и между вопросом и ответом окно
    // можно закрыть — Esc, крестиком, кликом по подложке. Ответ от этого не
    // исчезает: без этого флага он приходил в УЖЕ ЗАКРЫТОЕ окно и работал так,
    // будто оно на экране, — отказ сервера выдавал тост поверх того, что
    // регистратор открыл вместо него, и закрывал окно ВТОРОЙ раз, а второе
    // закрытие в живом окне достаётся уже не ему, а тому, что встало на его
    // место. Ответ закрытому окну не принадлежит.
    let closed = false;
    const close = () => { closed = true; document.removeEventListener('keydown', onKey); overlay.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '52vh', overflowY: 'auto' } },
        h('div', { class: 'muted', style: { padding: '14px', textAlign: 'center' } }, 'Загрузка…'));

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Copy', { size: 15 }), ' ', title),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { display: 'block', padding: '14px' } }, listEl)));

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    (async () => {
        const { data, error } = await listTemplates(supabase);
        if (closed) return;
        clear(listEl);
        if (error) {
            toast(trf('Не удалось загрузить пакеты: {msg}', { msg: error.message || error }), 'fail');
            close();
            return;
        }
        if (!data || !data.length) {
            listEl.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center', fontSize: '12.5px' } },
                'Действующих пакетов нет — заведите пакет в «Настройки → Пакеты услуг» или сохраните смету шаблоном в каталоге услуг.'));
            return;
        }
        for (const t of data) {
            const terms = packageTermsText(t);
            listEl.appendChild(h('button', {
                type: 'button',
                class: 'row',
                style: {
                    width: '100%', gap: '8px', border: '1px solid var(--ink-100)', borderRadius: '10px',
                    padding: '9px 12px', background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left',
                },
                onclick: () => { close(); pick(t); },
            },
                h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
                    h('span', { style: { fontWeight: 700, fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.name),
                    terms ? h('span', { 'data-package-terms': '', style: { fontSize: '12.5px', color: 'var(--ok-700, #15803d)' } }, terms) : null),
                h('span', { class: 'muted', style: { flex: 'none', fontSize: '12.5px' } }, trf('{n} усл.', { n: templateSize(t) }))));
        }
    })();

    return { overlay, close };
}
