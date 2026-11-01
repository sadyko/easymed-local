// CLINIC_NEWS_STRIP_V1 (2026-10-31) — тонкая полоса «Новости клиники» над
// приложением — регистратуре, call-центру и администратору.
//
// Владелец, выбирая, как донести «Информационную доску» (CLINIC_NEWS_V1) до
// тех, кто на витрину «Коммерческие инструменты» не ходит: «a small strip»,
// «small strip only in call center and registrars». Это люди у стойки и на
// телефоне: им первым звонят и приходят с вопросом «а кардиолог из Турции
// когда?» и «УЗИ сегодня работает?».
//
// Что в полосе: ОДНО объявление — первое на доске (закреплённое, иначе самое
// свежее, — порядок сервера clinic_news_list), «ещё N» и ссылка «Все
// объявления» на #clinic-news (адрес открыт всем сотрудникам). Крестик прячет
// полосу до перезагрузки — как у полосы обновления (UPDATE_BANNER_DISMISS_V1),
// и отметка — по номеру объявления: появилось НОВОЕ первое — полоса снова видна.
//
// Кто видит — правило в clinic-news-strip-logic.js: регистратор, call-центр и
// администратор (владелец: «put to admin role to»), но не медпредставитель.
import { h, Icon } from './ui.js';
import { tr, trf } from './i18n.js';
import { supabase } from '../supabase.js';
import { actorRoleCodes } from './permissions.js';
import { newsStripAudience } from './clinic-news-strip-logic.js';
export { newsStripAudience };

const KIND_ICON = { news: 'Megaphone', doctor_visit: 'Stethoscope', equipment: 'Warning', other: 'Info' };
const REFRESH_MS = 5 * 60 * 1000;

let dismissedId = null;
let timer = null;

/**
 * Нарисовать (или перерисовать) полосу. navigate — оболочки. Без зрителя,
 * без объявлений, после крестика по тому же объявлению — полосы нет.
 */
export async function renderNewsStrip({ navigate, user } = {}) {
    const me = user || (window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!newsStripAudience(me, actorRoleCodes())) { document.getElementById('news-strip')?.remove(); return; }
    // Опрос раз в пять минут: объявление «аппарат не работает» должно дойти
    // до стойки в течение смены, а не к следующему входу. Таймер один.
    if (!timer) {
        timer = setInterval(() => { renderNewsStrip({ navigate }).catch(() => {}); }, REFRESH_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }
    let items = [];
    try {
        const { data, error } = await supabase.rpc('clinic_news_list', {});
        if (error) return;   // доска недоступна — полосы просто нет, тревоги не поднимаем
        items = (data && data.items) || [];
    } catch (_) { return; }
    document.getElementById('news-strip')?.remove();
    const first = items[0];
    if (!first || first.id === dismissedId) return;

    const open = () => { if (typeof navigate === 'function') navigate('clinic-news'); };
    // CLINIC_NEWS_IMPORTANT_V1 — важное объявление: полоса жёлтая, вместо
    // «Новости клиники» — «Важно». Сервер ставит важные сразу за закреплёнными,
    // так что первое в полосе — то, что важнее всего.
    const strip = h('div', { id: 'news-strip', class: 'news-strip ns-kind-' + first.kind + (first.important ? ' ns-important' : ''), role: 'status' },
        h('span', { class: 'ns-ico' }, Icon(first.important ? 'Warning' : (KIND_ICON[first.kind] || 'Info'), { size: 14 })),
        h('span', { class: 'ns-label' }, first.important ? tr('Важно') : tr('Новости клиники')),
        h('button', { class: 'ns-title', type: 'button', title: first.title, onclick: open }, first.title),
        items.length > 1 ? h('span', { class: 'ns-more' }, trf('ещё {n}', { n: items.length - 1 })) : null,
        h('button', { class: 'ns-all', type: 'button', onclick: open }, tr('Все объявления'), Icon('ChevronRight', { size: 13 })),
        h('button', {
            class: 'ns-close', type: 'button', title: tr('Скрыть до перезагрузки страницы'), 'aria-label': tr('Скрыть'),
            onclick: () => { dismissedId = first.id; strip.remove(); },
        }, Icon('X', { size: 14 })));
    document.body.insertBefore(strip, document.querySelector('.app') || document.body.firstChild);
}
