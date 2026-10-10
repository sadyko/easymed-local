// REFERENCE_LISTS_V1 (2026-10-06) — НАСТРОЙКИ → «СПРАВОЧНИКИ»: ГОРОДА, РАЙОНЫ И
// СПЕЦИАЛЬНОСТИ С КОДАМИ. ТОЛЬКО ПРОСМОТР.
//
// Владелец согласовал макет «Справочники» (план «API клиники, шаги 1–2»,
// задача 13). Партнёры по API клиники получают КОДЫ, а не текст; этот экран —
// место, где клиника видит, какой код у какого названия.
//
// ЧТО ЗДЕСЬ ПОКАЗАНО. Общие списки, из которых клиника выбирает в анкетах:
//   • «Города и районы» — таблицы countries / regions / districts, миграция 132
//     (GEO_HARDCODE_V1): код, ru, uz, en. Регионы Узбекистана (страна с кодом
//     'UZ'): слева регион — русское название, под ним uz · en, код и число
//     районов; справа районы выбранного региона. Сразу открыт город Ташкент;
//   • «Страны» — та же таблица countries: код, ru, uz, en (дизайн API клиники,
//     «Шаг 2»: «страны / регионы / районы с кодами»). Узбекистан первым,
//     остальные по алфавиту; выключенные в «Географии» не показаны;
//   • «Специальности» — SPECIALTY_ROWS (shared/specialty-list.js): код, ru,
//     uz, en. Встроены в программу целиком, серверу они не нужны.
//
// ПОЧЕМУ ТОЛЬКО ПРОСМОТР. Списки одинаковы у всех клиник и партнёров: код,
// поменянный в одной клинике, перестал бы совпадать у партнёра. Меняются они
// новой версией программы. Прежний редактор «География» (sections.js, консоль
// супер-админа) остаётся как был — этот экран его не заменяет.
//
// НАЗВАНИЯ — ДАННЫЕ, А НЕ ТЕКСТ ЭКРАНА. h() пропускает каждую строку через
// tr(), а русские названия специальностей есть в словаре: колонка «RU» на
// узбекском интерфейсе показала бы узбекское название. Поэтому коды и названия
// кладутся готовыми текстовыми узлами (raw()), мимо перевода.
//
// ДОСТУП. Маршрут открывает тот же ключ, что и сам хаб «Настроек»
// (permissions.js, isRouteAllowed): в списках нет данных клиники, и те же
// названия любой сотрудник видит в выпадающих списках анкеты пациента. Сервер
// отдаёт эти таблицы на чтение всем сотрудникам (schema-registry.js ALL_STAFF).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear } from '../ui.js';
import { SPECIALTY_ROWS } from '../../shared/specialty-list.js';
import { bySheetOrder } from '../../shared/geo-codes.js';   // REFERENCE_LISTS_V1 (полировка) — порядок бланка

/** Страна, чьи регионы показывает экран, и регион, открытый сразу. */
export const COUNTRY_CODE = 'UZ';
export const DEFAULT_REGION = 'tashkent-city';

// REFERENCE_LISTS_V1 (полировка по макету, 2026-10-10) — регионы и районы — в
// ПОРЯДКЕ БЛАНКА «Справочники EasyMed», как в согласованном макете: город
// Ташкент, Ташкентская область, Андижанская … Хорезмская, Каракалпакстан
// последним; районы — как в бланке. Не по алфавиту и не по id: id в базе
// раздала миграция 030 в другом порядке. Порядок — shared/geo-codes.js (он
// сверен с миграцией 132); строки, заведённые в «Географии», — после строк
// бланка, по названию.

const raw = (v) => document.createTextNode(v == null || v === '' ? '—' : String(v));
const byRu = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru');

/**
 * Страны и регионы страны COUNTRY_CODE с их районами: { countries, regions }.
 * Три запроса — все страны, регионы страны с кодом COUNTRY_CODE, районы всех
 * её регионов разом. REFERENCE_LISTS_V1 (ревью итога) — у каждой вкладки своя
 * причина отказа: countriesError — не пришли страны (тогда и регионы не
 * найти — regionsError тоже); regionsError — не пришли регионы или районы,
 * а страны — пришли, и вкладка «Страны» их показывает.
 */
export async function loadGeography() {
    const c = await supabase.from('countries').select('id, code, name, name_uz, name_en, active');
    if (c.error) return { countriesError: c.error, regionsError: c.error };
    // Регионы — у страны с кодом COUNTRY_CODE, как и прежде, даже если её
    // выключили в «Географии»; в списке стран показаны только включённые.
    const country = (c.data || []).find((x) => x.code === COUNTRY_CODE);
    const top = (x) => (x.code === COUNTRY_CODE ? 0 : 1);
    const countries = (c.data || []).filter((x) => x.active !== false && x.active !== 0)
        .sort((a, b) => (top(a) - top(b)) || byRu(a, b));
    if (!country) return { countries, regions: [] };

    const r = await supabase.from('regions').select('id, name, code, name_uz, name_en')
        .eq('country_id', country.id).eq('active', true);
    if (r.error) return { countries, regionsError: r.error };
    const regions = (r.data || []).map((x) => ({ ...x, districts: [] }));
    if (!regions.length) return { countries, regions };

    const d = await supabase.from('districts').select('id, region_id, name, code, name_uz, name_en, kind')
        .in('region_id', regions.map((x) => x.id)).eq('active', true);
    if (d.error) return { countries, regionsError: d.error };
    const byId = new Map(regions.map((x) => [x.id, x]));
    for (const row of d.data || []) { const reg = byId.get(row.region_id); if (reg) reg.districts.push(row); }
    for (const reg of regions) reg.districts.sort(bySheetOrder('districts'));

    // Порядок бланка; открытый сразу город Ташкент в нём и так первый.
    regions.sort(bySheetOrder('regions'));
    return { countries, regions };
}

// REFERENCE_LISTS_V1 (ревью M2) — id вкладок и панели уникальны на каждую отрисовку.
let seq = 0;

export async function renderReferenceLists(container, ctx = {}) {
    clear(container);
    // REFERENCE_LISTS_V1 (ревью M5) — состояние у каждой отрисовки СВОЁ: общее на
    // модуль переписала бы медленная прежняя отрисовка, дождавшись ответа сервера.
    // region — id региона, а не код (ревью M3): регион, заведённый в «Географии»
    // без кода, выбирается так же; null — «открытый сразу» (DEFAULT_REGION).
    const state = { tab: 'geo', region: null, geo: null, uid: 'ref-' + (++seq) };

    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Справочники',
        subtitle: 'Страны, города, районы и специальности: коды и названия на трёх языках',
    }));
    root.appendChild(h('div', {
        style: {
            display: 'flex', alignItems: 'flex-start', gap: '10px', margin: '0 0 16px', padding: '11px 14px',
            borderRadius: '10px', background: 'var(--info-50)', color: 'var(--info-700)', fontSize: '13.5px', lineHeight: '1.5',
        },
    },
        h('span', { style: { flex: '0 0 auto', display: 'inline-flex', marginTop: '1px' } }, Icon('Info', { size: 16 })),
        // REFERENCE_LISTS_V1 (полировка по макету) — три предложения макета: списки
        // работают без интернета; код не меняется никогда, переименованная строка
        // сохраняет код для партнёров; недостающий район или специальность — через
        // поддержку EasyMed. Каждое предложение — своя статья словаря.
        h('span', null,
            'Общие списки: одинаковые у всех клиник и партнёров; партнёры получают коды. Списки встроены в программу и обновляются вместе с ней; интернет для них не нужен.',
            ' ', 'Код не меняется никогда; если меняется название, партнёры получают новое название с тем же кодом.',
            ' ', 'Добавить район или специальность можно в новой версии программы — напишите в поддержку EasyMed.'),
    ));

    const card = h('section', { class: 'card', style: { overflow: 'hidden' } });
    root.appendChild(card);
    const body = h('div', { role: 'tabpanel', id: state.uid + '-panel' });
    // REFERENCE_LISTS_V1 (ревью M1) — выбор перерисовывает карточку, и узел, на
    // котором стоял фокус, исчезает. `focus` говорит, куда его вернуть: на
    // открытую вкладку ('tab') или на выбранную строку региона ('region').
    // После загрузки фокус не трогаем — человек мог уже уйти в другое место.
    const paint = (focus = null) => paintCard(state, card, body, paint, focus);

    paint();
    state.geo = await loadGeography();
    paint();
}

function paintCard(state, card, body, paint, focus) {
    clear(card);
    card.appendChild(h('div', { class: 'card-header' },
        h('h3', null, Icon('Layers', { size: 17 }), 'Общие списки'),
        h('span', { class: 'tag tag-info' }, 'Только просмотр'),
    ));
    const tabId = (id) => state.uid + '-tab-' + id;
    let activeTab = null;
    const tab = (id, label, count) => {
        const on = state.tab === id;
        const el = h('button', {
            class: 'tab' + (on ? ' on' : ''), type: 'button', role: 'tab', id: tabId(id),
            'aria-selected': on ? 'true' : 'false', 'aria-controls': body.getAttribute('id'),
            onclick: () => { if (!on) { state.tab = id; paint('tab'); } },
        }, label, count == null ? null : h('span', { class: 'tab-count' }, raw(count)));
        if (on) activeTab = el;
        return el;
    };
    const geoCount = state.geo && state.geo.regions ? state.geo.regions.length : null;
    const countryCount = state.geo && state.geo.countries ? state.geo.countries.length : null;
    card.appendChild(h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Справочники', style: { padding: '0 12px' } },
        tab('geo', 'Города и районы', geoCount),
        tab('countries', 'Страны', countryCount),
        tab('spec', 'Специальности', SPECIALTY_ROWS.length),
    ));
    body.setAttribute('aria-labelledby', tabId(state.tab));
    card.appendChild(body);
    clear(body);
    let selRow = null;
    if (state.tab === 'spec') paintSpecialties(body);
    else if (!state.geo) body.appendChild(h('div', { class: 'muted', style: { padding: '24px', textAlign: 'center' } }, 'Загрузка…'));
    else if (state.tab === 'countries') paintCountries(state, body);
    else selRow = paintGeography(state, body, paint);
    const target = focus === 'tab' ? activeTab : focus === 'region' ? selRow : null;
    if (target) target.focus();
}

/** Таблица «Код · RU · UZ · EN» — одна на страны, районы и специальности. */
function codeTable(rows, rowClass) {
    return h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Код'), h('th', null, raw('RU')), h('th', null, raw('UZ')), h('th', null, raw('EN')))),
            h('tbody', null, ...rows.map((x) => h('tr', { class: rowClass },
                h('td', { class: 'cell-mono' }, raw(x.code)),
                h('td', null, raw(x.ru)),
                h('td', null, raw(x.uz)),
                h('td', null, raw(x.en)),
            )))));
}

function paintSpecialties(body) {
    body.appendChild(codeTable(SPECIALTY_ROWS.map((s) => ({ code: s.slug, ru: s.ru, uz: s.uz, en: s.en })), 'ref-spec'));
}

function paintCountries(state, body) {
    const empty = (text) => h('div', { class: 'empty', style: { padding: '32px 20px' } }, text);
    if (state.geo.countriesError) { body.appendChild(empty('Не удалось загрузить страны — обновите страницу.')); return; }
    const countries = state.geo.countries || [];
    if (!countries.length) { body.appendChild(empty('Стран нет.')); return; }
    body.appendChild(codeTable(countries.map((c) => ({ code: c.code, ru: c.name, uz: c.name_uz, en: c.name_en })), 'ref-country'));
}

/** Рисует вкладку «Города и районы»; возвращает строку выбранного региона (для фокуса). */
function paintGeography(state, body, paint) {
    const empty = (text) => h('div', { class: 'empty', style: { padding: '32px 20px' } }, text);
    if (state.geo.regionsError) { body.appendChild(empty('Не удалось загрузить города и районы — обновите страницу.')); return null; }
    const regions = state.geo.regions;
    const sel = regions.find((r) => r.id === state.region)
        || regions.find((r) => r.code === DEFAULT_REGION) || regions[0];
    if (!sel) { body.appendChild(empty('Районов нет.')); return null; }

    // Повторный выбор того же региона ничего не перерисовывает — фокус и так на нём.
    const pick = (r) => { if (r !== sel) { state.region = r.id; paint('region'); } };
    let selRow = null;
    const left = h('div', { style: { flex: '1 1 320px', minWidth: 0, borderRight: '1px solid var(--ink-100)' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Город / область'), h('th', null, 'Код'), h('th', { style: { textAlign: 'right' } }, 'Районов'))),
            h('tbody', null, ...regions.map((r) => {
                const on = r === sel;
                // Строка таблицы — не вариант списка: выбранную отмечает aria-current
                // (ревью M2), а не aria-selected.
                const tr = h('tr', {
                    class: 'ref-region', 'data-id': r.id, 'data-code': r.code, tabindex: '0', 'aria-current': on ? 'true' : null,
                    style: { cursor: 'pointer', background: on ? 'var(--primary-50)' : null },
                    onclick: () => pick(r),
                    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r); } },
                },
                    h('td', null,
                        h('div', { style: { fontWeight: 600 } }, raw(r.name)),
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                            raw([r.name_uz, r.name_en].filter(Boolean).join(' · ')))),
                    h('td', { class: 'cell-mono' }, raw(r.code)),
                    h('td', { style: { textAlign: 'right' } }, raw(r.districts.length)),
                );
                if (on) selRow = tr;
                return tr;
            }))));

    const right = h('div', { style: { flex: '1.6 1 420px', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '12px 16px', borderBottom: '1px solid var(--ink-100)' } },
            h('b', null, raw(sel.name)),
            h('span', { class: 'cell-mono' }, raw(sel.code))),
        sel.districts.length
            ? codeTable(sel.districts.map((d) => ({ code: d.code, ru: d.name, uz: d.name_uz, en: d.name_en })), 'ref-district')
            : empty('Районов нет.'));

    body.appendChild(h('div', { style: { display: 'flex', flexWrap: 'wrap' } }, left, right));
    return selRow;
}
