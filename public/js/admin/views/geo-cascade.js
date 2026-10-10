// GEO_HARDCODE_V1 / CLINIC_PROFILE_V1 — каскад «Страна → Регион → Район» из
// справочника (миграции 030, 132). ОДИН на программу: окно заведения пациента
// хранит ИМЕНА (patients.country / region / district — текст, как всегда),
// «Компания» — КОДЫ (doc_settings.country_code / region_code / district_code:
// партнёры получают коды). Вынесен из patient-create-modal.js; поведение
// регистрации не изменилось.
import { supabase } from '../../supabase.js';
import { h, clear } from '../ui.js';
import { tr, getLang } from '../i18n.js';

export function geoCascade({ by = 'name', onChange = null } = {}) {
    const byCode = by === 'code';
    const valueOf = (r) => (byCode ? r.code : r.name);
    const countrySel  = h('select', { name: 'country'  });
    const regionSel   = h('select', { name: 'region'   });
    const districtSel = h('select', { name: 'district' });
    const rowsById = new Map();

    // Подпись — на языке интерфейса (uz / en из мигр. 132); значение — имя или код.
    const label = (r) => { const l = getLang(); return (l === 'uz' && r.name_uz) || (l === 'en' && r.name_en) || r.name; };
    function paintSelect(sel, rows, placeholder, selected) {
        clear(sel);
        sel.appendChild(h('option', { value: '' }, placeholder));
        // CLINIC_PROFILE_V1 — в режиме кодов строка без кода не предлагается:
        // партнёр её не прочтёт (её завела клиника в «Географии»).
        const usable = rows.filter((r) => r && (!byCode || r.code));
        for (const r of [...usable].sort((a, b) => label(a).localeCompare(label(b), 'ru'))) {
            const opt = h('option', { value: valueOf(r) }, label(r));
            opt.dataset.id = r.id;
            rowsById.set(String(r.id), r);
            if (selected && selected === valueOf(r)) opt.selected = true;
            sel.appendChild(opt);
        }
    }
    function rowOf(sel) {
        const o = sel.options ? sel.options[sel.selectedIndex] : null;
        const id = o && o.dataset ? (o.dataset.id || '') : '';
        return id ? (rowsById.get(String(id)) || null) : null;
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
            want.country || (byCode ? 'UZ' : 'Uzbekistan'));
        const cid = selectedId(countrySel);
        if (cid) {
            const regs = await load('regions', ['country_id', cid]);
            paintSelect(regionSel, regs, regionsPh(regs.length), want.region);
            const rid = selectedId(regionSel);
            // CLINIC_PROFILE_V1 — в «Компании» районы нужны и тогда, когда район ещё не выбран.
            if (rid && (want.district || byCode)) {
                const dists = await load('districts', ['region_id', rid]);
                paintSelect(districtSel, dists, districtsPh(dists.length), want.district);
            }
        }
        fire();
    })();

    return { countrySel, regionSel, districtSel, ready, selected,
        preset: ({ country, region, district } = {}) => { want.country = country || ''; want.region = region || ''; want.district = district || ''; } };
}
