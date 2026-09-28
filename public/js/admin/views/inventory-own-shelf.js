// OWN_SHELF_ONLY_V1 (ревью F5, 2026-09-28) — «ТОЛЬКО СО СВОИХ ПОЛОК»:
// ПЕРЕКЛЮЧАТЕЛЬ КЛИНИКИ И ЕГО ГОТОВНОСТЬ. Живёт в «Закупках» чипом рядом с
// «Сроками годности» и «Журналом» — это экран склада, и настройки склада
// здесь же.
//
// Владелец: «Clinics keep working as today. The admin turns it on in settings
// once the warehouse has issued stock to rooms and nurses. The settings screen
// shows what is still missing.»
//
//   • Выключено (у каждой клиники, пока администратор не включит): врач и
//     медсестра выдают пациенту со своих полок, а недостачу добирает склад —
//     как было.
//   • Включено: только со своих полок; не хватило — отказ и «Запросить у
//     склада». Со склада напрямую — администратор и склад.
//   • Остаток склада врачу и медсестре не показывается при ЛЮБОМ положении.
//
// Всё, что здесь сказано о готовности, СЧИТАЕТ СЕРВЕР (own_shelf_settings):
// экран не складывает полки сам. Переключает только администратор — и это
// проверяет сервер (own_shelf_set отвечает 403 остальным), кнопка лишь не
// показывается тем, кому её не нажать. Включить можно и при недостающем: окно
// подтверждения перечисляет его, а журнал запоминает, кто, когда и что
// готовность в эту минуту называла недостающим.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { loadingCard } from './inventory-shared.js';

/** Чего не хватает цепочке «свои полки» — ключи ответа сервера и их слова. */
export const READINESS_LABELS = Object.freeze({
    staff_without_place:      'Врачи и медсёстры без кабинета и отдела',
    wards_without_department: 'Палаты без отдела',
    rooms_without_department: 'Кабинеты без отдела',
    departments_empty:        'Отделы, в которые ничего не выдано',
    staff_with_nothing:       'Врачи и медсёстры, у которых на своих полках пусто',
});
const NAMES_SHOWN = 12;

/** Имена через запятую; длинный список — первые двенадцать и «и ещё N». */
export function namesLine(names) {
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (list.length <= NAMES_SHOWN) return list.join(', ');
    return trf('{names} и ещё {n}', { names: list.slice(0, NAMES_SHOWN).join(', '), n: list.length - NAMES_SHOWN });
}

/** Недостающие пункты готовности (count > 0), в порядке сервера. */
export function missingItems(readiness) {
    return ((readiness && readiness.items) || []).filter((i) => Number(i.count) > 0 && READINESS_LABELS[i.key]);
}

export async function renderOwnShelfTab(container) {
    container.appendChild(loadingCard());
    let res;
    try { res = await supabase.rpc('own_shelf_settings', {}); } catch (e) { res = { error: e }; }
    clear(container);
    if (res.error || !res.data) {
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', 'data-own-shelf-error': '' },
            tr((res.error && res.error.message) || 'Не удалось загрузить настройку.'))));
        return;
    }
    paint(container, res.data);
}

function paint(container, s) {
    clear(container);
    const on = !!s.own_shelf_only;
    const reload = () => renderOwnShelfTab(container);

    const toggleBtn = s.can_change
        ? h('button', { class: 'btn btn-sm ' + (on ? 'btn-outline' : 'btn-primary'), type: 'button', 'data-own-shelf-toggle': on ? 'off' : 'on',
            onclick: () => confirmToggle(s, !on, reload) },
            Icon(on ? 'X' : 'Check', { size: 13 }), ' ', tr(on ? 'Выключить' : 'Включить'))
        : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Переключает только администратор.'));

    container.appendChild(h('div', { class: 'card', 'data-own-shelf-switch': on ? 'on' : 'off' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Shield', { size: 15 }), ' ', tr('Только со своих полок')),
            Tag(tr(on ? 'Включено' : 'Выключено'), { kind: on ? 'ok' : '', dot: true }),
            h('span', { class: 'grow' }),
            toggleBtn),
        h('div', { style: { padding: '12px 16px', display: 'grid', gap: '8px', fontSize: '13.5px' } },
            h('p', { style: { margin: 0 } }, tr(on
                ? 'Врач и медсестра выдают пациенту только со своих полок: личный подотчёт, кабинет, отдел. Не хватило — заявка на склад. Со склада напрямую выдают администратор и склад.'
                : 'Врач и медсестра выдают пациенту со своих полок, а чего не хватило — добирает склад, как раньше. Включите, когда склад выдаст товар в кабинеты, отделы и медсёстрам.')),
            h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } },
                tr('Остаток склада врачу и медсестре не показывается при любом положении переключателя.')),
            s.changed_at
                ? h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' }, 'data-own-shelf-changed': '' },
                    trf('Изменил: {name}, {when}', { name: s.changed_by_name || '—', when: fmtDateTime(s.changed_at) }))
                : null)));

    container.appendChild(readinessCard(s.readiness));
    container.appendChild(logCard(s.log || []));
}

function readinessCard(r) {
    const items = missingItems(r);
    const body = h('div', { style: { padding: '12px 16px', display: 'grid', gap: '10px', fontSize: '13.5px' } },
        h('p', { style: { margin: 0 }, 'data-readiness-summary': '' },
            trf('Врачей и медсестёр: {n}; что-то есть на своих полках у {m}.', { n: Number(r && r.clinical_staff) || 0, m: Number(r && r.staff_with_stock) || 0 })));
    if (!items.length) {
        body.appendChild(h('p', { class: 'muted', style: { margin: 0 }, 'data-readiness-ready': '' },
            tr('Всё готово: у каждого врача и медсестры есть место в цепочке и что-то на своих полках.')));
    }
    for (const i of items) {
        body.appendChild(h('div', { 'data-readiness-item': i.key, style: { display: 'grid', gap: '2px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } },
                h('span', null, tr(READINESS_LABELS[i.key])),
                Tag(String(i.count), { kind: 'warn' })),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, namesLine(i.names))));
    }
    return h('div', { class: 'card', style: { marginTop: '12px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Check', { size: 15 }), ' ', tr('Готовность полок'))),
        body);
}

function logCard(log) {
    const rows = log.map((l) => h('tr', { 'data-own-shelf-log': '' },
        h('td', null, fmtDateTime(l.changed_at)),
        h('td', null, l.changed_by_name || '—'),
        h('td', null, tr(l.own_shelf_only ? 'включил' : 'выключил')),
        h('td', { class: 'muted' }, Number(l.missing) > 0 ? trf('недоставало: {n}', { n: Number(l.missing) }) : '')));
    return h('div', { class: 'card', style: { marginTop: '12px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Clock', { size: 15 }), ' ', tr('Кто и когда переключал'))),
        rows.length
            ? h('table', { class: 'tbl' }, h('tbody', null, ...rows))
            : h('div', { class: 'empty', style: { padding: '14px 16px' } }, tr('Ещё не переключали.')));
}

/**
 * Окно подтверждения. Включение перечисляет недостающее (со счётом и
 * именами) — включить при нём можно, но человек видит, на что соглашается.
 */
export function confirmToggle(s, next, onDone) {
    const items = next ? missingItems(s.readiness) : [];
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' }, 'data-own-shelf-confirm': next ? 'on' : 'off' });
    const close = () => overlay.remove();
    const go = h('button', { class: 'btn ' + (next ? 'btn-primary' : 'btn-danger'), type: 'button', 'data-own-shelf-confirm-go': '',
        onclick: async () => {
            go.setAttribute('disabled', '');
            const { data, error } = await supabase.rpc('own_shelf_set', { own_shelf_only: next });
            if (error) { go.removeAttribute('disabled'); toast(tr(error.message || 'Не удалось сохранить.'), 'fail'); return; }
            close();
            toast(tr(data && data.own_shelf_only ? '«Только со своих полок» включено.' : '«Только со своих полок» выключено.'), 'ok');
            if (typeof onDone === 'function') onDone();
        } }, tr(next ? (items.length ? 'Всё равно включить' : 'Включить') : 'Выключить'));
    const body = h('div', { class: 'modal-body', style: { display: 'grid', gap: '8px' } });
    if (next) {
        body.appendChild(h('p', { style: { margin: 0 } }, tr('Врач и медсестра будут выдавать пациенту только со своих полок; не хватило — отказ и заявка на склад.')));
        if (items.length) {
            body.appendChild(h('p', { style: { margin: 0, fontWeight: 600 } }, tr('Ещё не готово:')));
            for (const i of items) {
                body.appendChild(h('div', { 'data-confirm-missing': i.key, style: { fontSize: '13.5px' } },
                    h('div', null, trf('{label}: {n}', { label: tr(READINESS_LABELS[i.key]), n: i.count })),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, namesLine(i.names))));
            }
        }
    } else {
        body.appendChild(h('p', { style: { margin: 0 } }, tr('Врачу и медсестре склад снова будет добирать то, чего нет на их полках, как раньше.')));
    }
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'alertdialog', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Shield', { size: 16 }), ' ', tr(next ? 'Включить «Только со своих полок»?' : 'Выключить «Только со своих полок»?')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
            h('span', { class: 'grow' }),
            go)));
    document.body.appendChild(overlay);
    return { close };
}
