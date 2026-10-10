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
import { composeAddress, routeUrl, mapsProblem, STREET_MAX } from '../../shared/clinic-profile.js';

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
 */
export function addressCard(state, { onChange = null, secondary = false } = {}) {
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
        const mine = geoCascade({ by: 'code', onChange: (sel) => {
            if (mine !== geo) return;   // ответ прежнего каскада — не наш
            parts = sel;
            state.country_code = sel.country ? sel.country.code : '';
            state.region_code = sel.region ? sel.region.code : '';
            state.district_code = sel.district ? sel.district.code : '';
            if (sel.region) boxes.region.err.set('');
            if (sel.district) boxes.district.err.set('');
            paintFull(); changed();
        } });
        geo = mine;
        mine.preset({ country: state.country_code || 'UZ', region: state.region_code, district: state.district_code });
        boxes.country.put(mine.countrySel);
        boxes.region.put(mine.regionSel);
        boxes.district.put(mine.districtSel);
        return mine.ready;
    }
    // До load() — заглушки: списки грузятся один раз, уже с сохранёнными кодами.
    for (const b of Object.values(boxes)) b.put(h('select', { disabled: true }, h('option', { value: '' }, 'Загрузка…')));

    const street = triGroup('Улица, дом', streetOf(), {
        key: 'street', max: STREET_MAX,
        onInput: (l, v) => { state['street_' + l] = v; paintFull(); changed(); },
    });

    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('MapPin', { size: 16 }), ' ',
            secondary ? 'Адрес этого здания для партнёров и сайта' : 'Адрес для партнёров и сайта')),
        h('div', { class: 'cpf-body' },
            h('p', { class: 'cpf-hint' }, 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. На бланках печатается «Адрес в документах» из «Реквизитов» — эти списки его не меняют.'),
            h('div', { class: 'cpf-geo' }, boxes.country.node, boxes.region.node, boxes.district.node),
            street.node,
            h('div', { class: 'cpf-full' },
                h('p', { class: 'cpf-subhead' }, 'Полный адрес — так его получат партнёры'),
                fullDl)));
    paintFull();

    return {
        node,
        street,
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

/** Карточка «Карта и маршрут»: ссылка из Яндекс Карт и что откроет кнопка «Маршрут». */
export function mapCard(state, { onChange = null } = {}) {
    const inp = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://yandex.uz/maps/…' });
    const box = labeled('Ссылка на клинику в Яндекс Картах', inp, {
        key: 'maps',
        hint: 'Найдите клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. Это адрес этого здания; у других зданий ссылки свои.',
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
