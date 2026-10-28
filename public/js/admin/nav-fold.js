// NAV_GROUPS_V1 (2026-10-17) — логика свёрнутых групп бокового меню.
//
// Владелец: «Money Section (it should be Folded) … Operations (it should be
// Folded) … Settings (it should be Folded) … Reports (it should be Folded)».
// Группа в NAV (admin.js) помечается `{ section: 'Money', fold: true }`;
// renderSidebar() спрашивает здесь, рисовать ли её раскрытой, и этим же
// модулем переключает её по щелчку. Вынесено из admin.js ради теста:
// оболочка при импорте монтирует себя в document, а эти три функции — чистые
// (две вовсе без DOM, третья трогает только classList и один атрибут).
// См. docs/specs/2026-10-17-sidebar-groups-design.md.

/**
 * Группа, в которой лежит открытый экран: имя секции (`item.section`) первой
 * записи-заголовка над пунктом, для которого `owns(item)` истинно, или null.
 * Пункты до первого заголовка считаются вне групп.
 *
 * @param {Array<{section?: string, id?: string}>} nav
 * @param {(item: object) => boolean} owns — «этот пункт несёт открытый экран?»
 */
export function activeSectionOf(nav, owns) {
    let section = null;
    for (const item of nav) {
        if (item.section) { section = item.section; continue; }
        if (owns(item)) return section;
    }
    return null;
}

/**
 * Рисовать ли группу раскрытой.
 *
 * Без `fold` — всегда: «Клиника» не сворачивается. С `fold` группа сворачиваемая,
 * и NAV_UNFOLDED_V1 (2026-10-27, владелец: «make this unfolded») — ПО УМОЛЧАНИЮ
 * РАСКРЫТА: свёрнутой она бывает только после щелчка в этой загрузке страницы
 * (`closed`). Группа с открытым экраном раскрыта всегда — свёрнутое меню без
 * выделенного пункта не говорит, где ты. `opened` остался от прежнего правила
 * «свёрнуто по умолчанию» (NAV_GROUPS_V1) и лишь перебивает `closed`.
 *
 * FIX_318_V1 (B2) — `compact`: раскрытое меню НЕ входит в окно (ноутбук
 * 1366×768, 1280×720, 1440×900 с панелями браузера — ступень max-height:760px в
 * admin.css считалась под свёрнутые группы). Тогда умолчание обратное: группа
 * без открытого экрана свёрнута. Щелчок человека — `opened` или `closed`, его
 * оболочка теперь пишет в обе стороны — сильнее умолчания в обоих режимах.
 *
 * @param {{section: string, fold?: boolean}} item — запись-заголовок из NAV
 * @param {{closed?: Set<string>, opened?: Set<string>, activeSection?: string|null, compact?: boolean}} ctx
 */
export function isNavSectionOpen(item, { closed, opened, activeSection, compact = false } = {}) {
    if (!item.fold) return true;
    if (activeSection != null && activeSection === item.section) return true;
    if (opened && opened.has(item.section)) return true;
    if (closed && closed.has(item.section)) return false;
    return !compact;
}

/**
 * FIX_318_V1 (B2) — входит ли меню в окно, если раскрыть ВСЕ сворачиваемые
 * группы. Раскрывает их на время замера и возвращает классы как были: чтение
 * scrollHeight раскладывает страницу сразу, а кадр рисуется позже, поэтому
 * человек промежуточного состояния не видит.
 *
 * null — раскладки нет (вкладка скрыта, колонка не показана, тест без DOM):
 * решать не по чему, оболочка оставляет прежний режим.
 *
 * @param {{clientHeight:number, scrollHeight:number}|null} bodyEl — #sidebar-body
 * @param {Array<{navEl: Element}>} groups — списки сворачиваемых групп
 * @returns {boolean|null}
 */
export function navFitsOpen(bodyEl, groups) {
    if (!bodyEl || !(bodyEl.clientHeight > 0)) return null;
    const was = groups.map((g) => g.navEl.classList.contains('nav--folded'));
    for (const g of groups) g.navEl.classList.toggle('nav--folded', false);
    const fits = bodyEl.scrollHeight <= bodyEl.clientHeight + 1;   // +1 — дробные пиксели масштаба
    groups.forEach((g, i) => g.navEl.classList.toggle('nav--folded', was[i]));
    return fits;
}

/**
 * FIX_318_V1 (B6) — бейдж заголовка свёрнутой группы: сумма счётчиков её
 * пунктов. Красный, если красен хоть один ненулевой (просроченные задачи CRM,
 * неоплаченные счета, непрочитанный чат, обновление в «Настройках»). Нечего
 * показать — null.
 *
 * @param {Array<{count: number|null, alert?: boolean}>} items
 * @returns {{total: number, alert: boolean}|null}
 */
export function groupBadge(items) {
    let total = 0, alert = false;
    for (const it of items || []) {
        const n = Number(it && it.count) || 0;
        if (n <= 0) continue;
        total += n;
        if (it.alert) alert = true;
    }
    return total > 0 ? { total, alert } : null;
}

/**
 * Применить состояние к разметке: список получает `nav--folded`, заголовок —
 * `nav-section--folded` (поворот шеврона) и `aria-expanded`. Скрывает CSS, а
 * не inline-style: на рейке 68px (.sidebar-collapsed) заголовков нет, щёлкнуть
 * не по чему, и там правило admin.css показывает пункты свёрнутых групп тоже.
 *
 * @param {Element} headerEl
 * @param {Element} navEl
 * @param {boolean} open
 */
export function setNavSectionOpen(headerEl, navEl, open) {
    navEl.classList.toggle('nav--folded', !open);
    headerEl.classList.toggle('nav-section--folded', !open);
    headerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}
