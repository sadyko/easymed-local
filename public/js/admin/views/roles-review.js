// V3121_ROLES — «ПРОВЕРЬТЕ ПРАВА ЭТОЙ РОЛИ» НА ЭКРАНЕ «РОЛИ».
//
// Миграция 215 записала в role_permission_reviews роли, чей «Просмотр» на
// стационаре или складе совпал с отпечатком старого экрана «Роли»
// (shared/old-screen-view.js). Такой «Просмотр» мог выставить сам экран
// версии 0.9–3.0 (и тогда медсестра с 3.2 не пишет измерения, склад не выдаёт),
// а мог — человек нарочно: строки одинаковые. Поэтому решает администратор:
//   «Вернуть права по умолчанию» — ключи раздела снимаются, работает то, что
//      основа роли получает по умолчанию (не выше), уровень раздела — как у
//      штатных ролей;
//   «Оставить как есть» — права не трогаются, вопрос больше не задаётся.
// Строка, которую с тех пор изменили руками (отпечаток больше не совпадает),
// не показывается: решение уже принято на самом экране.
import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr } from '../i18n.js';
import { OLD_SCREEN_AREAS, matchesOldScreen, restoreOldScreenArea } from '../../shared/old-screen-view.js';

const AREA_TEXT = {
    inpatient: 'Стационар: у роли на всех окнах и действиях стоит «Просмотр» — так роль мог сохранить старый экран «Роли». С ним сотрудник не записывает измерения, не отмечает введение препаратов и не добавляет услуги лежащим пациентам.',
    procurement: 'Закупки: у роли стоит «Просмотр» и нет выдачи со склада — так роль мог сохранить старый экран «Роли». С ним сотрудник не выдаёт товар со склада и не ведёт заявки на закупку.',
};

/** Нерешённые записи проверки по роли — только те, что всё ещё совпадают с отпечатком. */
export async function openReviews(role, perms) {
    try {
        const { data, error } = await supabase.from('role_permission_reviews')
            .select('id, role, area, resolution').eq('role', role).is('resolution', null);
        if (error || !Array.isArray(data)) return [];
        return data.filter((r) => OLD_SCREEN_AREAS[r.area] && matchesOldScreen(perms, r.area));
    } catch (e) { return []; }
}

async function resolve(item, resolution) {
    const { error } = await supabase.from('role_permission_reviews')
        .update({ resolution, resolved_at: new Date().toISOString() }).eq('id', item.id).select();
    if (error) throw new Error(error.message || String(error));
}

/** «Вернуть права по умолчанию»: права раздела — по основе роли. Перечитывает строку перед записью. */
export async function restoreDefaults(item) {
    const { data, error } = await supabase.from('role_permissions').select('permissions').eq('role', item.role).maybeSingle();
    if (error) throw new Error(error.message || String(error));
    let p = data && data.permissions;
    if (typeof p === 'string') p = JSON.parse(p);
    if (matchesOldScreen(p, item.area)) {
        const next = restoreOldScreenArea(p, item.area);
        const up = await supabase.from('role_permissions').update({ permissions: JSON.stringify(next) }).eq('role', item.role).select().single();
        if (up.error) throw new Error(up.error.message || String(up.error));
    }
    await resolve(item, 'restored');
}

/**
 * Врезка в карточку роли. `onDone` зовётся после решения (экран перечитывает роль).
 * Возвращает узел сразу; записи подгружаются следом — нет записей, нет и врезки.
 */
export function roleReviewNotice(role, perms, { onDone } = {}) {
    const box = h('div', { class: 'roles-review' });
    openReviews(role, perms).then((items) => {
        for (const item of items) {
            const restoreBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Вернуть права по умолчанию');
            const keepBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Оставить как есть');
            const act = async (fn, okText) => {
                restoreBtn.disabled = true; keepBtn.disabled = true;
                try { await fn(); toast(tr(okText), 'ok'); if (onDone) onDone(); }
                catch (e) { toast(tr('Не удалось сохранить решение.') + ' ' + ((e && e.message) || ''), 'fail'); restoreBtn.disabled = false; keepBtn.disabled = false; }
            };
            restoreBtn.addEventListener('click', () => act(() => restoreDefaults(item), 'Права раздела возвращены по умолчанию.'));
            keepBtn.addEventListener('click', () => act(() => resolve(item, 'kept'), 'Права оставлены как есть.'));
            box.appendChild(h('div', { class: 'card roles-note', role: 'status' },
                h('span', { class: 'roles-note-ico' }, Icon('Warning', { size: 15 })),
                h('div', { class: 'roles-note-txt' },
                    h('strong', null, 'Проверьте права этой роли'),
                    h('div', { class: 'muted' }, AREA_TEXT[item.area]),
                    h('div', { class: 'muted' }, 'Если «только просмотр» выбран нарочно — оставьте как есть. «Вернуть права по умолчанию» даёт то, что основа роли получает по умолчанию, и не больше.'),
                    h('div', { class: 'roles-review-acts' }, restoreBtn, ' ', keepBtn)),
            ));
        }
    });
    return box;
}
