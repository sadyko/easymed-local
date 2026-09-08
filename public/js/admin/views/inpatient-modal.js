// INPATIENT_MODAL_V1 — окно и «якорь пациента» стационара.
//
// Вынесены из admission-modal.js (TITLE_SHEET_V1): титульному листу
// (views/title-sheet.js) нужно то же окно и тот же якорь, а окну койки в
// admission-modal.js нужен титульный лист — импорт друг в друга был бы
// кольцом, которого этот раздел сознательно избегает (см. шапку case-docs.js).
// Тексты и поведение — дословно прежние.
import { h, Icon, toast, initials } from '../ui.js';
import { tr } from '../i18n.js';

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
