// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — ЭКРАН НАСТРОЕК «ТОЛЬКО ДЛЯ ПРОСМОТРА».
//
// Владелец: «there are some roles and functions which are only available to the
// administrator. can you make read, change, delete options for them too?».
// Телефония, Telegram-бот и CRM-канбан стали выдаваться «Просмотром». Сами
// экраны рисуют много карточек и дорисовывают их после ответов сервера, и
// перечислять в каждом его кнопки значило бы пропустить первую же новую. Поэтому
// экран монтируется внутрь рамки, которая:
//   • говорит строкой сверху, что это только просмотр;
//   • гасит поля ввода (класс is-view-only, admin-views.css);
//   • перехватывает нажатие кнопок-действий (класс .btn) ДО их обработчиков.
// Это удобство, а не защита: сохранение отклоняет сервер тем же ключом
// (rpc/telephony.js, rpc/telegram.js, rpc/crm-config.js).
import { h, Icon, toast } from './ui.js';
import { tr } from './i18n.js';
import { settingsTileAllows } from './permissions.js';

function actionButton(target, host) {
    let n = target;
    while (n && n !== host) {
        if (String(n.tagName || '').toUpperCase() === 'BUTTON') {
            return String(n.className || '').split(/\s+/).includes('btn') && !(n.dataset && n.dataset.viewOk) ? n : null;
        }
        n = n.parentNode || null;
    }
    return null;
}

/**
 * Смонтировать экран плитки `tileKey`: на «Просмотре» — внутри рамки «только
 * просмотр», иначе — как обычно. `render(root)` рисует экран в `root`.
 */
export async function renderWithViewOnly(container, tileKey, render) {
    if (settingsTileAllows(tileKey, 'edit') || !settingsTileAllows(tileKey, 'view')) return render(container);
    const inner = h('div');
    const host = h('div', { class: 'is-view-only' },
        h('div', { class: 'view-only-note', role: 'note' }, Icon('Lock', { size: 14 }), ' ',
            tr('Только просмотр: менять эти настройки может роль с правом «Изменение».')),
        inner);
    container.appendChild(host);
    host.addEventListener('click', (e) => {
        if (!actionButton(e.target, host)) return;
        e.preventDefault();
        e.stopPropagation();
        toast(tr('Только просмотр: менять эти настройки может роль с правом «Изменение».'), 'fail');
    }, true);
    host.addEventListener('keydown', (e) => {
        const tag = String((e.target && e.target.tagName) || '').toUpperCase();
        if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && e.key !== 'Tab') e.preventDefault();
    }, true);
    return render(inner);
}
