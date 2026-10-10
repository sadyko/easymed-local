// CLINIC_PROFILE_V1 — «Компания»: адрес здания для партнёров и сайта, карта и маршрут.
//
// АДРЕС ДЛЯ ПАРТНЁРОВ И САЙТА — списки «Страна → Город / область → Район» из
// справочника (тот же каскад, что при регистрации пациента, geo-cascade.js, в
// режиме кодов: партнёры получают коды миграции 132) и улица на трёх языках.
// Полный адрес на каждом языке собирает composeAddress — для API, партнёров и
// предпросмотра «Как это увидят пациенты».
//
// На бланках печатается ДРУГОЕ поле — «Адрес в документах» (doc_settings.address)
// в «Реквизитах», вписанное руками, как сегодня. Списки его не меняют и сами
// в него ничего не собирают (ответ владельца 2026-10-10, вариант B).
import { h, Icon, clear } from '../ui.js';
import { geoCascade } from './geo-cascade.js';
import { triGroup, labeled, fieldErr } from './company-fields.js';
import { composeAddress, routeUrl, mapsProblem, STREET_MAX, PROFILE_MESSAGES } from '../../shared/clinic-profile.js';
import { tr } from '../i18n.js';   // CLINIC_API_STEP7_V1 — строка «адрес обязателен» ставится через textContent

const LANG_ROWS = [['ru', 'RU'], ['uz', 'UZ'], ['en', 'EN']];
// Сколько вариантов в списке (первый — «Выберите…»); без options — ни одного.
const optionCount = (sel) => (sel && sel.options ? sel.options.length : 0);

// Поле списка: подпись (for=), место под <select>, строка ошибки. put(sel)
// кладёт новый список на место прежнего — подпись остаётся привязанной.
let geoSeq = 0;
function geoField(key, label) {
    const id = 'cpf-geo-' + key + '-' + (++geoSeq);
    const slot = h('div', { class: 'cpf-slot' });
    const err = fieldErr(null);
    const node = h('div', { class: 'field' }, h('label', { for: id }, label), slot, err.node);
    return {
        node, err,
        put(sel) { sel.setAttribute('id', id); clear(slot); slot.appendChild(sel); err.ctrl = sel; },
    };
}

/**
 * Карточка адреса. state — объект экрана (общий для карточек); onChange —
 * после любого изменения (перерисовать предпросмотры). secondary — филиал:
 * заголовок «этого здания». Вызывающий зовёт load() после того, как строка
 * doc_settings прочитана: каскад выбирает сохранённые коды только из пресета,
 * заданного до прихода списков.
 *
 * BRANCH_PROFILE_V1 — заголовок, подсказку и замок задаёт экран: «Филиалы»
 * (страница здания) и «Компания» филиала. disabled — списки и улица видны, но
 * не правятся; after — узлы сразу под улицей (ориентир, прежний адрес).
 */
export function addressCard(state, { onChange = null, secondary = false, title = '', hint = '', disabled = false, after = null, required = false } = {}) {   // CLINIC_API_STEP7_V1 — required: решение владельца 11
    let parts = { country: null, region: null, district: null };
    const streetOf = () => ({ ru: state.street_ru, uz: state.street_uz, en: state.street_en });
    const changed = () => { if (typeof onChange === 'function') onChange(); };
    const fullDl = h('dl', { class: 'cpf-kv' });

    function paintFull() {
        clear(fullDl);
        for (const [lng, tag] of LANG_ROWS) {
            fullDl.appendChild(h('dt', null, h('span', { class: 'cpf-lang' }, tag)));
            fullDl.appendChild(h('dd', { dataset: { lang: lng } },
                document.createTextNode(composeAddress({ ...parts, street: streetOf() }, lng) || '—')));
        }
        fullDl.appendChild(h('dt', null, 'Коды'));
        fullDl.appendChild(h('dd', { class: 'cpf-mono', dataset: { lang: 'codes' } }, document.createTextNode(
            [state.country_code || '—', state.region_code || '—', state.district_code || '—'].join(' · '))));
    }

    // Три поля списков живут дольше самих списков: load() строит новый каскад
    // по сохранённым кодам и кладёт его <select> на место прежних (подпись,
    // строка ошибки и id для for= — те же).
    const boxes = {
        country: geoField('country', 'Страна'),
        region: geoField('region', 'Город / область'),
        district: geoField('district', 'Район'),
    };
    let geo = null;
    function mountGeo() {
        // CLINIC_PROFILE_V1 (ревью C1, M4) — первый вызов onChange — показ
        // сохранённого (каскад выбрал коды из пресета, страну по умолчанию или
        // прежний пункт «(не используется)»): строку он не меняет. Коды пишутся
        // только после выбора человеком — нетронутое сохранение ничего не шлёт,
        // и ни один сохранённый код не теряется молча.
        let shown = false;
        const mine = geoCascade({ by: 'code', onChange: (sel) => {
            if (mine !== geo) return;   // ответ прежнего каскада — не наш
            parts = sel;
            if (shown) {
                state.country_code = sel.country ? sel.country.code : '';
                state.region_code = sel.region ? sel.region.code : '';
                state.district_code = sel.district ? sel.district.code : '';
            }
            shown = true;
            if (sel.region) boxes.region.err.set('');
            if (sel.district) boxes.district.err.set('');
            paintFull(); changed();
        } });
        geo = mine;
        // Пустая страна — каскад сам предложит Узбекистан (не «сохранённый» код).
        mine.preset({ country: state.country_code, region: state.region_code, district: state.district_code });
        boxes.country.put(mine.countrySel);
        boxes.region.put(mine.regionSel);
        boxes.district.put(mine.districtSel);
        // BRANCH_PROFILE_V1 — замок от вызывающего («Филиалы»: своё здание
        // главного и филиал; «Компания» филиала): списки видны, выбрать нельзя.
        if (disabled) for (const s of [mine.countrySel, mine.regionSel, mine.districtSel]) { s.disabled = true; s.setAttribute('disabled', ''); }
        return mine.ready;
    }
    // До load() — заглушки: списки грузятся один раз, уже с сохранёнными кодами.
    for (const b of Object.values(boxes)) b.put(h('select', { disabled: true }, h('option', { value: '' }, 'Загрузка…')));

    const street = triGroup('Улица, дом', streetOf(), {
        key: 'street', max: STREET_MAX,
        markMissing: true,   // CLINIC_PROFILE_V1 (полировка по макету) — «нет перевода» у пустых UZ / EN
        disabled,   // BRANCH_PROFILE_V1
        onInput: (l, v) => { state['street_' + l] = v; paintFull(); changed(); },
    });

    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // город / область, район и улица RU обязательны — звёздочка у подписи и
    // строка над полями. Звёздочка — текст, а не атрибут: поддельный DOM тестов
    // и настоящий показывают её одинаково.
    const marks = [boxes.region, boxes.district].map((b) => {
        const mk = h('span', { class: 'req' });
        b.node.children[0].appendChild(mk);   // <label> поля — первый ребёнок
        return mk;
    });
    const streetMark = h('span', { class: 'req' });
    street.node.firstChild.appendChild(streetMark);   // <legend> группы «Улица, дом»
    const reqNote = h('p', { class: 'cpf-hint cpf-req-note' });
    // Слияние с шагом 4 (BRANCH_PROFILE_V1): поля, которые здесь только видны
    // (disabled — «Компания» филиала, своё здание главного в «Филиалах»), не бывают
    // обязательными: звёздочек и строки нет, что бы ни пришло в on.
    function setRequired(on) {
        const show = !!on && !disabled;
        for (const mk of [...marks, streetMark]) mk.textContent = show ? ' *' : '';
        reqNote.textContent = show ? tr(PROFILE_MESSAGES.partnerAddress) : '';
    }
    setRequired(required);

    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('MapPin', { size: 16 }), ' ',
            title || (secondary ? 'Адрес этого здания для партнёров и сайта' : 'Адрес для партнёров и сайта'))),   // BRANCH_PROFILE_V1 — заголовок от экрана
        h('div', { class: 'cpf-body' },
            h('p', { class: 'cpf-hint' }, hint || 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. На бланках печатается «Адрес в документах» из «Реквизитов» — эти списки его не меняют. Адреса других зданий — в «Филиалах».'),   // BRANCH_PROFILE_V1 — подсказка шага 3 «Адреса других зданий — в «Филиалах»» возвращена (аудит макета)
            reqNote,   // CLINIC_API_STEP7_V1
            h('div', { class: 'cpf-geo' }, boxes.country.node, boxes.region.node, boxes.district.node),
            street.node,
            ...[].concat(after || []),   // BRANCH_PROFILE_V1 — «Филиалы»: ориентир, прежний адрес
            h('div', { class: 'cpf-full' },
                h('p', { class: 'cpf-subhead' }, 'Полный адрес — так его получат партнёры'),
                fullDl)));
    paintFull();

    return {
        node,
        street,
        setRequired,   // CLINIC_API_STEP7_V1
        get geo() { return geo; },
        // Выбранные строки справочника — для предпросмотра «Как это увидят пациенты».
        parts: () => parts,
        // Ошибки по колонкам — для showProblems экрана.
        errs: { region_code: boxes.region.err, district_code: boxes.district.err, street_ru: street.inputs.ru.err },
        // Есть ли из чего выбирать: «Регионы не заведены» не требует региона.
        availability: () => (geo
            ? { regionsAvailable: optionCount(geo.regionSel) > 1, districtsAvailable: optionCount(geo.districtSel) > 1 }
            : { regionsAvailable: false, districtsAvailable: false }),
        // После сохранения: улица — в поля (приведённая), полный адрес — заново.
        paint() { street.set(streetOf()); paintFull(); },
        // После чтения строки: то же, и коды — в новый каскад.
        load() { street.set(streetOf()); parts = { country: null, region: null, district: null }; paintFull(); return mountGeo(); },
    };
}

/**
 * Карточка «Карта и маршрут»: ссылка из Яндекс Карт и что откроет кнопка «Маршрут».
 * BRANCH_PROFILE_V1 — подпись, подсказку и замок задаёт экран («Филиалы»,
 * «Компания» филиала); без них — как в «Компании».
 */
export function mapCard(state, { onChange = null, label = '', hint = '', disabled = false } = {}) {
    const inp = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://yandex.uz/maps/…', disabled });
    inp.disabled = !!disabled;   // BRANCH_PROFILE_V1
    const box = labeled(label || 'Ссылка на клинику в Яндекс Картах', inp, {
        key: 'maps',
        hint: hint || 'Найдите клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. Это адрес этого здания; у других зданий ссылки свои.',
    });
    const routeDd = h('dd');
    function paintRoute() {
        clear(routeDd);
        const raw = String(state.maps_url || '').trim();
        const url = raw && !mapsProblem(raw) ? routeUrl(raw) : '';
        if (!url) { routeDd.appendChild(h('span', { class: 'muted' }, 'Появится, когда будет ссылка на карту.')); return; }
        routeDd.appendChild(h('span', { class: 'cpf-mono cpf-route' }, document.createTextNode(url)));
        routeDd.appendChild(h('a', { class: 'btn btn-ghost btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer' },
            Icon('Link', { size: 14 }), ' ', 'Открыть маршрут'));
    }
    inp.addEventListener('input', () => {
        state.maps_url = inp.value;
        box.err.set('');
        paintRoute();
        if (typeof onChange === 'function') onChange();
    });
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Flag', { size: 16 }), ' ', 'Карта и маршрут')),
        h('div', { class: 'cpf-body' },
            box.node,
            h('dl', { class: 'cpf-kv' }, h('dt', null, 'Кнопка «Маршрут»'), routeDd)));
    paintRoute();
    return {
        node, err: box.err,
        load() { inp.value = state.maps_url || ''; box.err.set(''); paintRoute(); },
    };
}
