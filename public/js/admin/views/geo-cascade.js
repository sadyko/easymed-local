// GEO_HARDCODE_V1 / CLINIC_PROFILE_V1 — каскад «Страна → Регион → Район» из
// справочника (миграции 030, 132). ОДИН на программу: окно заведения пациента
// хранит ИМЕНА (patients.country / region / district — текст, как всегда),
// «Компания» — КОДЫ (doc_settings.country_code / region_code / district_code:
// партнёры получают коды). Вынесен из patient-create-modal.js; поведение
// регистрации не изменилось.
import { supabase } from '../../supabase.js';
import { h, clear } from '../ui.js';
import { tr, trf, getLang } from '../i18n.js';

export function geoCascade({ by = 'name', onChange = null } = {}) {
    const byCode = by === 'code';
    const valueOf = (r) => (byCode ? r.code : r.name);
    const countrySel  = h('select', { name: 'country'  });
    const regionSel   = h('select', { name: 'region'   });
    const districtSel = h('select', { name: 'district' });
    // CLINIC_PROFILE_V1 (ревью I1) — строки у КАЖДОГО списка свои. id в
    // справочнике пересекаются между таблицами (мигр. 132: страна 1 —
    // Узбекистан, регион 1 — Каракалпакстан, район 1 — Бектемирский), и общая
    // таблица по id отдавала за страну строку района, нарисованного последним:
    // «Компания» записывала country_code 'bektemir'. Регистрации это не
    // касалось — ей нужны только id для загрузки следующего списка, а id у
    // подменённой строки тот же.
    const rowsOf = new Map([[countrySel, new Map()], [regionSel, new Map()], [districtSel, new Map()]]);

    // Подпись — на языке интерфейса (uz / en из мигр. 132); значение — имя или код.
    const label = (r) => { const l = getLang(); return (l === 'uz' && r.name_uz) || (l === 'en' && r.name_en) || r.name; };
    function paintSelect(sel, rows, placeholder, selected, { saved = false, parentStale = false } = {}) {
        clear(sel);
        const byId = rowsOf.get(sel);
        byId.clear();
        sel.appendChild(h('option', { value: '' }, placeholder));
        // CLINIC_PROFILE_V1 — в режиме кодов строка без кода не предлагается:
        // партнёр её не прочтёт (её завела клиника в «Географии»).
        const usable = rows.filter((r) => r && (!byCode || r.code));
        // CLINIC_PROFILE_V1 (ревью M4) — режим кодов: сохранённый код, которого
        // в активном списке больше нет (строку выключили в «Географии»), не
        // теряется молча — он остаётся выбранным пунктом «(не используется)».
        // Только СОХРАНЁННЫЙ код (saved; не страна по умолчанию) и только когда
        // список пришёл (пустой мог и не загрузиться) или выше выбран такой же
        // прежний пункт (parentStale). Регистрация (имена) — как была.
        if (byCode && saved && selected && !usable.some((r) => r.code === selected) && (usable.length || parentStale)) {
            const opt = h('option', { value: selected }, document.createTextNode(trf('{code} (не используется)', { code: selected })));
            opt.dataset.stale = '1';
            opt.dataset.code = selected;
            opt.selected = true;
            sel.appendChild(opt);
        }
        for (const r of [...usable].sort((a, b) => label(a).localeCompare(label(b), 'ru'))) {
            const opt = h('option', { value: valueOf(r) }, label(r));
            opt.dataset.id = r.id;
            byId.set(String(r.id), r);
            if (selected && selected === valueOf(r)) opt.selected = true;
            sel.appendChild(opt);
        }
    }
    function rowOf(sel) {
        const o = sel.options ? sel.options[sel.selectedIndex] : null;
        if (!o || !o.dataset) return null;
        // Прежний пункт: строки справочника нет — код и вместо имени тот же код.
        if (o.dataset.stale) return { id: null, code: o.dataset.code, name: o.dataset.code, stale: true };
        const id = o.dataset.id || '';
        return id ? (rowsOf.get(sel).get(String(id)) || null) : null;
    }
    const selectedId = (sel) => { const r = rowOf(sel); return r ? r.id : ''; };
    const selected = () => ({ country: rowOf(countrySel), region: rowOf(regionSel), district: rowOf(districtSel) });
    const fire = () => {
        if (typeof onChange !== 'function') return;
        try { onChange(selected()); } catch (e) { console.warn('[geo-cascade]', e); }
    };
    const load = async (table, filter) => {
        try {
            let q = supabase.from(table).select(byCode ? 'id, name, name_uz, name_en, code' : 'id, name, name_uz, name_en')
                .eq('active', true).order('name');
            if (filter) q = q.eq(filter[0], filter[1]);
            const { data, error } = await q;
            if (error) return [];
            return Array.isArray(data) ? data : [];   // CLINIC_PROFILE_V1 — не массив — пустой список, не исключение
        } catch (e) { return []; }
    };
    const regionsPh   = (n) => (n ? tr('Выберите регион') : tr('Регионы не заведены — Настройки → География'));
    const districtsPh = (n) => (n ? tr('Выберите район') : tr('Районы не заведены — Настройки → География'));

    paintSelect(countrySel,  [], tr('Загрузка…'));
    paintSelect(regionSel,   [], tr('Сначала выберите страну'));
    paintSelect(districtSel, [], tr('Сначала выберите регион'));

    countrySel.addEventListener('change', async () => {
        paintSelect(regionSel,   [], tr('Загрузка…'));
        paintSelect(districtSel, [], tr('Сначала выберите регион'));
        const cid = selectedId(countrySel);
        const regs = cid ? await load('regions', ['country_id', cid]) : [];
        paintSelect(regionSel, regs, regionsPh(regs.length));
        fire();
    });
    regionSel.addEventListener('change', async () => {
        paintSelect(districtSel, [], tr('Загрузка…'));
        const rid = selectedId(regionSel);
        const dists = rid ? await load('districts', ['region_id', rid]) : [];
        paintSelect(districtSel, dists, districtsPh(dists.length));
        fire();
    });
    districtSel.addEventListener('change', fire);

    // PATIENT_FORM_ONE_V1 — режим правки: выбор по сохранённым значениям, как
    // только соответствующий список приехал. ready — для экранов и тестов.
    const want = { country: '', region: '', district: '' };
    const ready = (async () => {
        const countries = await load('countries', null);
        paintSelect(countrySel, countries,
            countries.length ? tr('Выберите страну') : tr('Список стран не загрузился — обновите страницу'),   // GEO_HARDCODE_V1 — the list ships with the app; empty means the request failed
            want.country || (byCode ? 'UZ' : 'Uzbekistan'), { saved: !!want.country });
        const cid = selectedId(countrySel);
        const isStale = (sel) => { const r = rowOf(sel); return !!(r && r.stale); };
        if (cid) {
            const regs = await load('regions', ['country_id', cid]);
            paintSelect(regionSel, regs, regionsPh(regs.length), want.region, { saved: true });
            const rid = selectedId(regionSel);
            // CLINIC_PROFILE_V1 — в «Компании» районы нужны и тогда, когда район ещё не выбран.
            if (rid && (want.district || byCode)) {
                const dists = await load('districts', ['region_id', rid]);
                paintSelect(districtSel, dists, districtsPh(dists.length), want.district, { saved: true });
            } else if (isStale(regionSel) && want.district) {
                // CLINIC_PROFILE_V1 (ревью M4) — прежний регион: его районов не загрузить, прежний район виден как есть.
                paintSelect(districtSel, [], tr('Сначала выберите регион'), want.district, { saved: true, parentStale: true });
            }
        } else if (isStale(countrySel)) {
            // CLINIC_PROFILE_V1 (ревью M4) — прежняя страна: прежние регион и район видны как есть.
            if (want.region) paintSelect(regionSel, [], tr('Сначала выберите страну'), want.region, { saved: true, parentStale: true });
            if (want.district) paintSelect(districtSel, [], tr('Сначала выберите регион'), want.district, { saved: true, parentStale: true });
        }
        fire();
    })();

    return { countrySel, regionSel, districtSel, ready, selected,
        preset: ({ country, region, district } = {}) => { want.country = country || ''; want.region = region || ''; want.district = district || ''; } };
}
