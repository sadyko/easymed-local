// LAB_SETTINGS_V1 — clinic management of lab/diagnostic PANELS + their INDICATORS
// (reference ranges, M/F overrides, grouping). The clinic builds its own panels in
// lab_panels + lab_panel_analytes — Local has no medcore gateway, so there is no
// shared catalogue to import from and the catalogue modals were removed. A panel
// links to one orderable clinic service; the lab result-entry screen resolves
// visit_service → service → panel.
//
// LAB_TEMPLATES_V1 — panels can also be imported from a seeded local catalogue of
// 1002 laboratory studies (migrations 050/051). Importing COPIES the template in;
// reference ranges are never shipped and are always the clinic's own.
import { h, Icon, PageHead, toast, clear } from '../ui.js';
import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';
import { isLabService, deptKindMap, typeNameMap } from './lab-service.js';   // LAB_SERVICE_ROUTING_V1 — one shared definition of 'lab service'

const MODALITY_RU = { lab: 'Лаборатория', diagnostic: 'Диагностика' };

// Bump this whenever this screen changes. If the marker on the page does not
// match what you expect, the browser is running older JavaScript — reload the
// page fully (F5), because switching hash routes does not re-fetch modules.
const LAB_BUILD = 'lab-v5';

export async function renderLabSettings(container, { onNavigate } = {}) {
    clear(container);
    const state = { panels: [], services: [], selected: null, rows: [], panelQuery: '', loadError: null, deptKindById: {}, typeNameById: {} };
    const cid = currentClinicId();

    const listEl   = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const panelSearch = h('input', { placeholder: 'Поиск панели…', style: { width: '100%', marginBottom: '8px', fontSize: '12.5px' }, oninput: (e) => { state.panelQuery = e.target.value; paintList(); } });
    const editorEl = h('div', { class: 'card', style: { minHeight: '320px' } });

    container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'center' } },
                h('button', { class: 'btn btn-outline btn-sm', onclick: () => onNavigate && onNavigate('settings') }, '← Настройки'),
                h('div', null,
                    h('h1', { class: 'page-title' },
                        'Лаборатория и диагностика',
                        // Visible build marker, following the CRM's v11 pattern. Changing
                        // the hash (#settings -> #lab-settings) does NOT reload the app,
                        // so new JavaScript only arrives on a full page reload — without a
                        // marker there is no way to tell which build you are looking at,
                        // and "I can't see any changes" is impossible to diagnose.
                        h('span', { class: 'muted', style: { fontSize: '10px', opacity: '0.6', marginLeft: '8px', fontWeight: '400' } }, LAB_BUILD)),
                    h('p', { class: 'page-subtitle' }, 'Панели исследований, показатели и референсные значения. Создайте панели своей клиники и заполните референсные значения.')),
            ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '16px', alignItems: 'start' } },
            h('div', { class: 'card', style: { padding: '10px', position: 'sticky', top: '88px' } },
                h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px' } },
                    // LAB_TEMPLATES_V1 — «Из каталога» is back, now reading the
                    // catalogue seeded by migrations 050/051 instead of the cloud
                    // medcore gateway this offline build cannot reach.
                    h('button', { class: 'btn btn-primary btn-sm', style: { flex: 1 }, onclick: () => openCatalog() },
                        Icon('Layers', { size: 13 }), ' Из каталога'),
                    h('button', { class: 'btn btn-outline btn-sm', title: 'Создать пустую панель вручную', onclick: () => newBlankPanel() },
                        Icon('Plus', { size: 13 }), ' Пустая'),
                    h('button', {
                        class: 'btn btn-outline btn-sm',
                        title: 'Создать копию выбранной панели',
                        onclick: () => duplicatePanel(),
                    }, Icon('Repeat', { size: 13 }))),
                panelSearch,
                listEl),
            editorEl,
        ),
    ));

    async function reload() {
        // Do NOT bail on a missing clinic id. This build is single-clinic and the
        // API ignores company_id filters entirely (TENANCY_NOOP_V1), so the id is
        // decoration here — returning early only guaranteed an empty screen. It
        // used to, and the notice it left behind was erased by the next paintList(),
        // which is why this looked like "the clinic has no services" for a week.
        state.loadError = null;
        if (!cid) {
            state.loadError = 'нет привязки к клинике (window.CLINIC пуст)';
            console.warn('[lab-settings] currentClinicId() is null; loading without a tenant filter');
        }
        // Errors are CAPTURED, not discarded. Destructuring only `data` turned any
        // failure into an empty service picker with nothing on screen to say why —
        // the screen looked like a clinic with no services rather than a broken read.
        const [panelsRes, servicesRes, deptsRes, typesRes] = await Promise.all([
            supabase.from('lab_panels').select('*').eq('company_id', cid).order('modality').order('name'),
            // LAB_SERVICE_LINK_V1 — `type` and `is_lab` come along so the picker can
            // offer lab services first. Migration 048 keeps the two in step, so in
            // practice either would do; reading both keeps this honest for any row
            // written before it ran.
            // LAB_SERVICE_ROUTING_V1 — department_id and type_id come along because a
            // service can be lab work by its department or by its catalogue type, not
            // only by the routing enum. The two lookup tables are tiny and load once.
            supabase.from('services').select('id, name, type, is_lab, department_id, type_id').eq('company_id', cid).eq('active', true).order('name'),
            supabase.from('departments').select('id, name, kind').limit(200),
            supabase.from('service_types').select('id, name').limit(200),
        ]);
        if (panelsRes.error)   state.loadError = 'панели: ' + (panelsRes.error.message || panelsRes.error);
        if (servicesRes.error) state.loadError = (state.loadError ? state.loadError + ' · ' : '') + 'услуги: ' + (servicesRes.error.message || servicesRes.error);
        if (state.loadError) toast('Не удалось загрузить: ' + state.loadError, 'fail');
        state.panels = panelsRes.data || [];
        state.services = servicesRes.data || [];
        // Lookups for the lab-service rule. A failure here is not fatal — it only
        // means the department/type branches cannot fire, so a service still counts
        // via its routing enum. Not worth blocking the screen for.
        state.deptKindById = deptKindMap(deptsRes && deptsRes.data);
        state.typeNameById = typeNameMap(typesRes && typesRes.data);
        paintList();
        if (state.selected) { const again = state.panels.find(p => p.id === state.selected.id); selectPanel(again || null); }
        else if (state.panels.length) selectPanel(state.panels[0]);
        else paintEditor();
    }

    function paintList() {
        clear(listEl);
        const _q = (state.panelQuery || '').trim().toLowerCase();
        const _shown = _q ? state.panels.filter(p => (p.name || '').toLowerCase().includes(_q)) : state.panels;
        if (!_shown.length) { listEl.appendChild(h('div', { class: 'empty', style: { padding: '24px 12px', fontSize: '12.5px' } }, _q ? 'Ничего не найдено.' : 'Панелей пока нет — выберите «Из каталога» или «Пустая».')); return; }
        const byMod = { lab: [], diagnostic: [] };
        for (const p of _shown) (byMod[p.modality] || byMod.lab).push(p);
        for (const mod of ['lab', 'diagnostic']) {
            if (!byMod[mod].length) continue;
            listEl.appendChild(h('div', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink-400)', fontWeight: 700, padding: '8px 6px 2px' } }, MODALITY_RU[mod]));
            for (const p of byMod[mod]) {
                const on = state.selected && state.selected.id === p.id;
                listEl.appendChild(h('button', {
                    class: 'nav-item' + (on ? ' active' : ''),
                    style: { width: '100%', textAlign: 'left' },
                    onclick: () => selectPanel(p),
                },
                    h('span', { class: 'nav-icon' }, Icon(mod === 'lab' ? 'Flask' : 'Activity', { size: 14 })),
                    h('span', { style: { flex: 1 } }, p.name),
                    !p.active ? h('span', { class: 'tag', style: { fontSize: '10px' } }, 'выкл') : null));
            }
        }
    }

    // LAB_PANEL_RACE_V1 — показатели применяются, только если панель за время
    // запроса не сменилась.
    //
    // Здесь была потеря данных, а не косметика. selectPanel асинхронная:
    // state.selected ставился сразу, а state.rows — ПОСЛЕ ответа базы. Клик по
    // панели А, затем быстрый клик по Б — и если ответ А приходил вторым, в
    // редакторе оказывались показатели А при выбранной панели Б. Сохранение
    // (delete-then-insert по panel_id) стирало показатели Б и записывало на их
    // место показатели А: панель теряла свои нормы, а другая — дублировалась.
    // Именно так «Антимюллеров гормон» исчез из справочника, а в его панели
    // оказался лютеинизирующий гормон.
    let panelToken = 0;
    async function selectPanel(p) {
        const token = ++panelToken;
        state.selected = p;
        paintList();
        if (!p) { state.rows = []; paintEditor(); return; }
        if (p.id) {
            const { data } = await supabase.from('lab_panel_analytes').select('*').eq('panel_id', p.id).order('sort_order');
            if (token !== panelToken) return;   // выбрали другую панель — ответ уже не наш
            state.rows = (data || []).map(r => ({ ...r }));
        } else { state.rows = []; }
        if (token !== panelToken) return;
        state.rowsPanelId = p.id || null;       // чьи показатели сейчас в редакторе
        paintEditor();
    }

    function newBlankPanel() {
        state.rowsPanelId = null;
        selectPanel({ id: null, company_id: cid, name: 'Новая панель', modality: 'lab', has_narrative: false, service_id: null, active: true });
    }

    // Copy the selected panel and its indicators into an unsaved new one — the
    // fastest route to a second, similar panel now that there is no shared
    // catalogue to import from. service_id is deliberately cleared: two panels
    // must not claim the same service, or result entry cannot tell which to render.
    // ── LAB_TEMPLATES_V1 — browse the seeded catalogue and import ──────────────
    // Reads lab_panel_templates / lab_panel_template_analytes (migrations 050/051),
    // which are read-only reference content. Importing COPIES the template into
    // lab_panels + lab_panel_analytes, which the clinic then owns and edits — the
    // template is never linked to, so later catalogue changes cannot rewrite a
    // clinic's panel, and the clinic's edits cannot corrupt the catalogue.
    async function openCatalog() {
        const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        document.addEventListener('keydown', onKey);

        const listBox = h('div', { style: { marginTop: '10px', maxHeight: '52vh', overflowY: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } });
        const countEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');
        const searchInp = h('input', { placeholder: 'Поиск: название анализа…', style: { width: '100%' } });
        const catSel = h('select', { style: { width: '100%' } }, h('option', { value: '' }, 'Все разделы'));

        let cats = [];
        try {
            const { data } = await supabase.from('lab_panel_templates').select('category').eq('active', true).limit(2000);
            cats = [...new Set((data || []).map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
        } catch (e) { /* falls back to "Все разделы" only */ }
        for (const c of cats) catSel.appendChild(h('option', { value: c }, c));

        let timer = null;
        async function run() {
            clear(listBox);
            listBox.appendChild(h('div', { class: 'muted', style: { padding: '14px' } }, 'Загрузка…'));
            const q = searchInp.value.trim();
            let req = supabase.from('lab_panel_templates')
                .select('id, code, name, category, specimen, description, preparation')
                .eq('active', true);
            if (catSel.value) req = req.eq('category', catSel.value);
            if (q) req = req.ilike('name', '%' + q + '%');
            const { data, error } = await req.order('name').limit(300);
            clear(listBox);
            if (error) {
                listBox.appendChild(h('div', { style: { padding: '14px', color: 'var(--crit-700)' } }, 'Каталог недоступен: ' + (error.message || error)));
                countEl.textContent = '';
                return;
            }
            const rows = data || [];
            countEl.textContent = rows.length ? `найдено: ${rows.length}${rows.length === 300 ? '+' : ''}` : '';
            if (!rows.length) {
                listBox.appendChild(h('div', { class: 'muted', style: { padding: '18px', textAlign: 'center', fontSize: '12.5px' } }, 'Ничего не найдено — измените запрос или раздел.'));
                return;
            }
            for (const t of rows) {
                listBox.appendChild(h('button', {
                    class: 'nav-item',
                    style: { width: '100%', textAlign: 'left', alignItems: 'flex-start', padding: '9px 10px' },
                    title: t.description || '',
                    onclick: () => importTemplate(t, close),
                },
                    h('span', { class: 'nav-icon', style: { marginTop: '2px' } }, Icon('Flask', { size: 14 })),
                    h('span', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontWeight: 600, fontSize: '12.5px', lineHeight: '1.35' } }, t.name),
                        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } },
                            [t.category, t.specimen].filter(Boolean).join(' · '))),
                    Icon('Plus', { size: 14 })));
            }
        }
        searchInp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
        catSel.addEventListener('change', run);

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('div', null,
                    h('h2', null, Icon('Layers', { size: 16 }), ' Каталог исследований'),
                    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                        'Выберите анализ — панель со всеми показателями скопируется в вашу клинику. Референсные значения заполняете вы.')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 220px', gap: '10px' } },
                    h('div', { class: 'field' }, h('label', null, 'Поиск'), searchInp),
                    h('div', { class: 'field' }, h('label', null, 'Раздел'), catSel)),
                h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, countEl),
                listBox)));
        document.body.appendChild(overlay);
        setTimeout(() => searchInp.focus(), 30);
        run();
    }

    // Copy a catalogue template into this clinic as an editable panel.
    async function importTemplate(t, close) {
        try {
            const { data: analytes, error: aErr } = await supabase.from('lab_panel_template_analytes')
                .select('*').eq('template_id', t.id).order('sort_order');
            if (aErr) throw aErr;

            // A single-analyte test (most of the catalogue) still gets one parameter,
            // named after the test itself, so the result form is never empty.
            const rows = (analytes && analytes.length ? analytes : [{ name: t.name, unit: '', value_type: 'numeric', decimals: 2, group_label: null }])
                .map((a, i) => ({
                    id: null, code: a.code || null, name: a.name, unit: a.unit || '',
                    value_type: a.value_type || 'numeric', value_options: a.value_options || '',
                    decimals: a.decimals == null ? 2 : a.decimals,
                    ref_low: null, ref_high: null, ref_text: '',
                    ref_low_m: null, ref_high_m: null, ref_low_f: null, ref_high_f: null,
                    group_label: a.group_label || '', sort_order: i, ref_ranges: [],
                }));

            state.selected = {
                id: null, company_id: cid, name: t.name, code: t.code || null,
                modality: 'lab', has_narrative: false, service_id: null, active: true,
            };
            state.rows = rows;
            if (typeof close === 'function') close();
            paintList();
            paintEditor();
            toast(`«${t.name.slice(0, 40)}${t.name.length > 40 ? '…' : ''}» — ${rows.length} показ. Привяжите услугу и сохраните.`);
        } catch (e) {
            toast('Не удалось загрузить шаблон: ' + (e.message || e), 'fail');
        }
    }

    function duplicatePanel() {
        const p = state.selected;
        if (!p || !p.id) { toast('Сначала выберите панель для копирования', 'warn'); return; }
        state.selected = { ...p, id: null, core_panel_id: null, service_id: null, name: p.name + ' (копия)' };
        state.rows = state.rows.map(r => ({ ...r, id: null, panel_id: null }));
        paintList();
        paintEditor();
        toast('Копия создана — проверьте и сохраните');
    }

    function paintEditor() {
        clear(editorEl);
        const p = state.selected;
        // The «Привязанная услуга» picker lives inside a SELECTED panel — until one
        // is picked there is no dropdown on screen at all, which reads as "the lab
        // services aren't showing" rather than "nothing is selected yet". So the
        // empty pane carries the way forward instead of only describing it.
        if (!p) {
            editorEl.appendChild(h('div', { class: 'empty', style: { padding: '54px 20px', textAlign: 'center' } },
                h('div', { style: { marginBottom: '6px' } }, Icon('Flask', { size: 26 })),
                h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
                    state.panels.length ? 'Выберите панель слева' : 'Панелей пока нет'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '440px', margin: '0 auto 14px' } },
                    'Панель — это список показателей одного исследования. Создайте её и привяжите к лабораторной услуге: тогда заказ этой услуги попадёт в «Лабораторию» с готовыми полями для результатов.'),
                h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newBlankPanel() },
                    Icon('Plus', { size: 14 }), ' Новая панель')));
            return;
        }

        const nameInp = h('input', { value: p.name || '', style: { width: '100%' } });
        const modSel = h('select', { style: { width: '100%' } },
            ...['lab', 'diagnostic'].map(m => h('option', { value: m, selected: p.modality === m }, MODALITY_RU[m])));
        const narrChk = h('input', { type: 'checkbox', checked: !!p.has_narrative });
        const activeChk = h('input', { type: 'checkbox', checked: p.active !== false });
        const svcSel = h('select', { style: { width: '100%' } });
        const svcSearch = h('input', { placeholder: 'Поиск услуги…', style: { width: '100%', marginBottom: '6px', fontSize: '12.5px' } });
        // LAB_SERVICE_LINK_V1 — a service may carry at most ONE panel (unique index,
        // migration 048), so a service already spoken for by a DIFFERENT panel is
        // shown as taken rather than silently offered and then rejected on save.
        const takenBy = {};
        for (const other of state.panels) {
            if (other.service_id != null && other.id !== p.id) takenBy[other.service_id] = other.name;
        }
        // One definition, shared with the lab queue (lab-service.js): routing enum,
        // laboratory department, laboratory-named catalogue type, or a linked panel.
        const isLabSvc = (s) => isLabService(s, {
            deptKindById: state.deptKindById,
            typeNameById: state.typeNameById,
            hasPanel: (id) => state.panels.some(pp => pp.service_id === id),
        });

        const buildSvcOptions = (query) => {
            const qq = (query || '').trim().toLowerCase();
            const cur = svcSel.value || p.service_id || '';
            clear(svcSel);
            svcSel.appendChild(h('option', { value: '' }, '— не привязана —'));
            const match = qq ? state.services.filter(s => (s.name || '').toLowerCase().includes(qq)) : state.services;

            // Lab services first, under a heading, because they are what a panel is
            // normally for. The rest stay reachable below — a clinic may well want a
            // panel on a service it has typed as «Диагностика».
            const lab = match.filter(isLabSvc);
            const rest = match.filter(s => !isLabSvc(s));
            const pinned = (p.service_id && !match.some(s => s.id === p.service_id))
                ? state.services.filter(s => s.id === p.service_id) : [];

            const opt = (s) => h('option', {
                value: s.id,
                selected: cur === s.id,
                disabled: !!takenBy[s.id],
            }, s.name + (takenBy[s.id] ? '  — уже занята: ' + takenBy[s.id] : ''));

            for (const s of pinned) svcSel.appendChild(opt(s));
            if (lab.length) {
                const g = h('optgroup', { label: 'Лабораторные услуги' });
                for (const s of lab) g.appendChild(opt(s));
                svcSel.appendChild(g);
            }
            if (rest.length) {
                const g = h('optgroup', { label: 'Остальные услуги' });
                for (const s of rest) g.appendChild(opt(s));
                svcSel.appendChild(g);
            }
            // An empty picker used to be indistinguishable from a broken read. Say
            // which of the three it actually is: the read failed, the clinic has no
            // services at all, or the search simply matched nothing.
            if (!lab.length && !rest.length && !pinned.length) {
                const why = state.loadError ? 'Ошибка загрузки услуг'
                    : !state.services.length ? 'Услуг в клинике пока нет'
                    : 'Ничего не найдено';
                svcSel.appendChild(h('option', { value: '', disabled: true }, why));
            }
            svcSel.value = cur;
        };
        svcSearch.addEventListener('input', () => buildSvcOptions(svcSearch.value));
        buildSvcOptions('');

        const fld = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('div', { class: 'hint' }, hint) : null);

        editorEl.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Flask', { size: 16 }), ' ', p.id ? 'Редактирование панели' : 'Новая панель'),
            p.id ? h('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: 'auto', color: 'var(--crit-700)' }, onclick: () => removePanel(p) }, Icon('Trash', { size: 13 }), ' Удалить') : null));

        const body = h('div', { class: 'card-pad' });
        body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' } },
            fld('Название панели', nameInp),
            fld('Тип', modSel),
            fld('Привязанная услуга', h('div', null, svcSearch, svcSel),
                'Когда регистратура добавит эту услугу в визит и касса примет оплату, заказ появится в «Лаборатории» с показателями этой панели.')));

        // Says plainly whether the link is actually wired up. Without this the two
        // failure modes are silent: an unlinked panel is never ordered by anyone, and
        // a panel on a non-lab service never reaches the lab queue.
        const linkedSvc = state.services.find(s => s.id === (p.service_id || svcSel.value));
        body.appendChild(
            !p.service_id
                ? h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 12px' } },
                    Icon('Warning', { size: 12 }), ' Панель ни к чему не привязана — заказать её пока нельзя.')
                : (linkedSvc && !isLabSvc(linkedSvc))
                    ? h('div', { style: { fontSize: '12px', margin: '-6px 0 12px', color: 'var(--warn-700, #92400e)' } },
                        Icon('Warning', { size: 12 }),
                        ' Услуга «' + linkedSvc.name + '» не помечена как лабораторная. Поставьте ей тип «Лаборатория» в Настройки → Услуги, иначе заказ не попадёт в очередь лаборатории.')
                    : h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 12px' } },
                        Icon('Check', { size: 12 }), ' Привязана' + (linkedSvc ? ' к услуге «' + linkedSvc.name + '»' : '') + ' — заказы попадут в «Лабораторию».'));
        body.appendChild(h('div', { class: 'row', style: { gap: '10px', margin: '14px 0 18px' } },
            h('label', { class: 'lp-check' }, narrChk, ' Текстовое заключение'),
            h('label', { class: 'lp-check' + (p.active !== false ? ' on' : '') }, activeChk, ' Активна')));

        // ── analyte table ──
        body.appendChild(h('div', { class: 'row', style: { alignItems: 'center', margin: '4px 0 8px' } },
            h('h4', { style: { margin: 0, fontSize: '13px' } }, 'Показатели'),
            h('span', { class: 'tag tag-teal', style: { marginLeft: '8px', fontSize: '10.5px' } }, String(state.rows.length)),
            h('span', { style: { flex: 1 } }),
            // LAB_ANALYTE_LIBRARY_V1 — two ways to add an indicator, mirroring the
            // panel level above: pick from the dictionary, or start an empty row.
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => openAnalyteLibrary() },
                Icon('Layers', { size: 12 }), ' Из справочника'),
            h('button', { class: 'btn btn-outline btn-sm', style: { marginLeft: '6px' }, title: 'Добавить пустую строку и заполнить вручную',
                onclick: () => { state.rows.push(blankRow()); paintEditor(); } },
                Icon('Plus', { size: 12 }), ' Пустой')));

        const tblWrap = h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } });
        if (!state.rows.length) {
            tblWrap.appendChild(h('div', { class: 'muted', style: { padding: '22px', textAlign: 'center', fontSize: '12.5px' } }, 'Нет показателей — выберите «Из справочника» или «Пустой».'));
        } else {
            const tb = h('tbody');
            state.rows.forEach((r, i) => tb.appendChild(analyteRow(r, i)));
            tblWrap.appendChild(h('table', { class: 'lp-tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', { rowspan: '2' }, 'Показатель'), h('th', { rowspan: '2' }, 'Ед.'), h('th', { rowspan: '2' }, 'Тип'),
                        h('th', { class: 'grp', colspan: '3' }, 'Референсные интервалы'),
                        h('th', { rowspan: '2' }, 'Группа'), h('th', { rowspan: '2' }, '')),
                    h('tr', null,
                        h('th', { class: 'grp' }, 'Общий'), h('th', { class: 'grp' }, 'Муж.'), h('th', { class: 'grp' }, 'Жен.'))),
                tb));
        }
        body.appendChild(tblWrap);

        body.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '16px', justifyContent: 'flex-end' } },
            h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                ev.currentTarget.disabled = true;
                try {
                    await savePanel({ name: nameInp.value.trim(), modality: modSel.value, has_narrative: narrChk.checked, service_id: svcSel.value || null, active: activeChk.checked });
                } finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Сохранить панель')));
        editorEl.appendChild(body);
    }

    function blankRow() { return { id: null, name: '', unit: '', value_type: 'numeric', value_options: '', decimals: 1, ref_low: null, ref_high: null, ref_text: '', ref_low_m: null, ref_high_m: null, ref_low_f: null, ref_high_f: null, group_label: '', ref_ranges: [] }; }

    // ── LAB_ANALYTE_LIBRARY_V1 — pick indicators from the parameter dictionary ──
    // Reads lab_analyte_templates (migration 052), which is read-only reference
    // content. Picking COPIES name/unit/type into a normal editable row, so the
    // panel owns its parameters and later library changes cannot rewrite them.
    // Multi-select on purpose: a blood count is ~17 indicators, and adding them one
    // modal at a time would be slower than typing.
    async function openAnalyteLibrary() {
        const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        document.addEventListener('keydown', onKey);

        const picked = new Map();                       // id -> template row
        const already = new Set(state.rows.map(r => String(r.name || '').trim().toLowerCase()).filter(Boolean));

        const listBox = h('div', { style: { marginTop: '10px', maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } });
        const countEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');
        const searchInp = h('input', { placeholder: 'Поиск: название показателя…', style: { width: '100%' } });
        const catSel = h('select', { style: { width: '100%' } }, h('option', { value: '' }, 'Все разделы'));
        const addBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => commit() }, Icon('Check', { size: 14 }), ' Добавить');

        const syncAddBtn = () => {
            addBtn.disabled = picked.size === 0;
            addBtn.textContent = picked.size ? ` Добавить (${picked.size})` : ' Добавить';
            addBtn.prepend(Icon('Check', { size: 14 }));
        };

        try {
            const { data } = await supabase.from('lab_analyte_templates').select('category').eq('active', true).limit(2000);
            for (const c of [...new Set((data || []).map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))) {
                catSel.appendChild(h('option', { value: c }, c));
            }
        } catch (e) { /* falls back to "Все разделы" only */ }

        let timer = null;
        async function run() {
            clear(listBox);
            listBox.appendChild(h('div', { class: 'muted', style: { padding: '14px' } }, 'Загрузка…'));
            const q = searchInp.value.trim();
            let req = supabase.from('lab_analyte_templates')
                .select('id, name, category, unit, value_type, value_options, decimals, group_label')
                .eq('active', true);
            if (catSel.value) req = req.eq('category', catSel.value);
            if (q) req = req.ilike('name', '%' + q + '%');
            const { data, error } = await req.order('name').limit(400);
            clear(listBox);
            if (error) {
                listBox.appendChild(h('div', { style: { padding: '14px', color: 'var(--crit-700)' } }, 'Справочник недоступен: ' + (error.message || error)));
                countEl.textContent = '';
                return;
            }
            const rows = data || [];
            countEl.textContent = rows.length ? `найдено: ${rows.length}${rows.length === 400 ? '+' : ''}` : '';
            if (!rows.length) {
                listBox.appendChild(h('div', { class: 'muted', style: { padding: '18px', textAlign: 'center', fontSize: '12.5px' } }, 'Ничего не найдено — измените запрос или раздел.'));
                return;
            }
            for (const t of rows) {
                const dup = already.has(String(t.name).trim().toLowerCase());
                const box = h('input', { type: 'checkbox', disabled: dup, checked: picked.has(t.id) });
                box.addEventListener('change', () => {
                    if (box.checked) picked.set(t.id, t); else picked.delete(t.id);
                    syncAddBtn();
                });
                listBox.appendChild(h('label', {
                    class: 'nav-item',
                    style: { width: '100%', textAlign: 'left', alignItems: 'center', padding: '8px 10px', cursor: dup ? 'default' : 'pointer', opacity: dup ? '.55' : '1' },
                    title: dup ? 'Этот показатель уже есть в панели' : '',
                },
                    box,
                    h('span', { style: { flex: 1, minWidth: 0, marginLeft: '9px' } },
                        h('div', { style: { fontWeight: 600, fontSize: '12.5px', lineHeight: '1.35' } }, t.name),
                        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } },
                            [t.category, t.unit, t.value_type === 'select' ? 'список' : (t.value_type === 'text' ? 'текст' : 'число')].filter(Boolean).join(' · '))),
                    dup ? h('span', { class: 'tag', style: { fontSize: '10px' } }, 'уже добавлен') : null));
            }
        }

        // Reference ranges are deliberately NOT copied: the library has none, and
        // they are the clinic's own. Every picked row lands with empty bounds.
        function commit() {
            for (const t of picked.values()) {
                state.rows.push({
                    ...blankRow(),
                    name: t.name,
                    unit: t.unit || '',
                    value_type: t.value_type || 'numeric',
                    value_options: t.value_options || '',
                    decimals: Number.isInteger(t.decimals) ? t.decimals : 1,
                    group_label: t.group_label || '',
                });
            }
            const n = picked.size;
            close();
            paintEditor();
            toast(n === 1 ? 'Показатель добавлен — заполните референсные значения' : `Добавлено показателей: ${n} — заполните референсные значения`);
        }

        searchInp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
        catSel.addEventListener('change', run);

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('div', null,
                    h('h2', null, Icon('Layers', { size: 16 }), ' Справочник показателей'),
                    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                        'Отметьте нужные показатели. Название, единицы и тип подставятся; референсные значения заполняете вы.')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 220px', gap: '10px' } },
                    h('div', { class: 'field' }, h('label', null, 'Поиск'), searchInp),
                    h('div', { class: 'field' }, h('label', null, 'Раздел'), catSel)),
                h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, countEl),
                listBox),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn', onclick: close }, 'Отмена'),
                addBtn)));
        document.body.appendChild(overlay);
        setTimeout(() => searchInp.focus(), 30);
        run();
    }

    // LAB_MULTI_REF_V1 — named reference ranges beyond М/Ж. Kept as JSON on the
    // analyte row (lab_panel_analytes.ref_ranges) rather than a child table:
    // savePanel replaces analytes with DELETE-then-INSERT, so analyte ids are
    // regenerated on every save and anything FK'd to them would be cascaded away.
    function normRanges(r) {
        let v = r.ref_ranges;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
        return Array.isArray(v) ? v : [];
    }

    function openRangesModal(r) {
        const rows = normRanges(r).map(x => ({ ...x }));
        const overlay = h('div', { class: 'modal' });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        const listEl = h('tbody');

        const paintRows = () => {
            clear(listEl);
            if (!rows.length) {
                listEl.appendChild(h('tr', null, h('td', { colspan: '7', class: 'muted', style: { padding: '18px', textAlign: 'center', fontSize: '12.5px' } },
                    'Пока нет дополнительных диапазонов. Используются обычные нормы (общая / М / Ж).')));
                return;
            }
            rows.forEach((rr, i) => {
                const num = (key, w) => h('input', { type: 'number', step: 'any', value: rr[key] ?? '', class: 'lw-inp', style: { width: w || '74px' },
                    oninput: (e) => { rr[key] = e.target.value === '' ? null : Number(e.target.value); } });
                listEl.appendChild(h('tr', null,
                    h('td', null, h('input', { value: rr.label || '', placeholder: 'Менопауза', class: 'lw-inp', style: { minWidth: '160px' },
                        oninput: (e) => { rr.label = e.target.value; } })),
                    h('td', null, h('select', { class: 'lw-inp', style: { width: '92px' }, onchange: (e) => { rr.sex = e.target.value || null; } },
                        h('option', { value: '', selected: !rr.sex }, 'любой'),
                        h('option', { value: 'male', selected: rr.sex === 'male' }, 'М'),
                        h('option', { value: 'female', selected: rr.sex === 'female' }, 'Ж'))),
                    h('td', null, num('age_min', '64px')),
                    h('td', null, num('age_max', '64px')),
                    h('td', null, num('low')),
                    h('td', null, num('high')),
                    h('td', null, h('input', { value: rr.text || '', placeholder: 'или текст', class: 'lw-inp', style: { width: '120px' },
                        oninput: (e) => { rr.text = e.target.value; } })),
                    h('td', null, h('span', { class: 'lp-actions' },
                        h('button', { class: 'lp-ic', title: 'Вверх', onclick: () => { if (i > 0) { const t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t; paintRows(); } } }, '↑'),
                        h('button', { class: 'lp-ic', title: 'Вниз', onclick: () => { if (i < rows.length - 1) { const t = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t; paintRows(); } } }, '↓'),
                        h('button', { class: 'lp-ic del', title: 'Удалить', onclick: () => { rows.splice(i, 1); paintRows(); } }, Icon('Trash', { size: 12 }))))));
            });
        };
        paintRows();

        const card = h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, 'Диапазоны нормы · ' + (r.name || 'показатель')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { style: { padding: '16px 20px' } },
                h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px', lineHeight: '1.5' } },
                    'Для показателей, у которых норма зависит не только от пола — фаза цикла, менопауза, триместр беременности, возрастные группы. ',
                    h('b', null, 'Если задать два и более диапазона, в бланк печатаются все, а автоматический флаг (H/L) для этого показателя не ставится'),
                    ' — фазу цикла программа знать не может, решает врач. Пол и возраст нужны только чтобы отметить подходящую строку жирным.'),
                h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
                    h('table', { class: 'lp-tbl' },
                        h('thead', null, h('tr', null,
                            h('th', null, 'Название'), h('th', null, 'Пол'),
                            h('th', null, 'Возраст от'), h('th', null, 'до'),
                            h('th', null, 'Мин'), h('th', null, 'Макс'),
                            h('th', null, 'Текст'), h('th', null, ''))),
                        listEl)),
                h('button', { class: 'btn btn-outline btn-sm', style: { marginTop: '10px' },
                    onclick: () => { rows.push({ label: '', sex: null, age_min: null, age_max: null, low: null, high: null, text: '' }); paintRows(); } },
                    Icon('Plus', { size: 12 }), ' Добавить диапазон')),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn', onclick: close }, 'Отмена'),
                h('button', { class: 'btn btn-primary', onclick: () => {
                    r.ref_ranges = rows
                        .filter(x => (x.label || '').trim() || x.low != null || x.high != null || (x.text || '').trim())
                        .map(x => ({
                            label: (x.label || '').trim(),
                            sex: (x.sex === 'male' || x.sex === 'female') ? x.sex : null,
                            age_min: x.age_min == null || x.age_min === '' ? null : Number(x.age_min),
                            age_max: x.age_max == null || x.age_max === '' ? null : Number(x.age_max),
                            low: x.low == null || x.low === '' ? null : Number(x.low),
                            high: x.high == null || x.high === '' ? null : Number(x.high),
                            text: (x.text || '').trim(),
                        }));
                    close(); paintEditor();
                } }, Icon('Check', { size: 14 }), ' Применить')));
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
    }

    function analyteRow(r, idx) {
        const numCell = (key) => h('input', { type: 'number', step: 'any', value: r[key] ?? '', class: 'lw-inp', oninput: (e) => { r[key] = e.target.value === '' ? null : Number(e.target.value); } });
        const range = (a, b) => h('span', { class: 'lp-range' }, numCell(a), h('span', { class: 'd' }, '–'), numCell(b));
        const isText = r.value_type === 'text';
        const isSel = r.value_type === 'select';   // LAB_SELECT_OPTIONS_V1 — answer picked from a list
        const nRanges = normRanges(r).length;      // LAB_MULTI_REF_V1
        const typeSel = h('select', { class: 'lw-inp', style: { width: '96px' }, onchange: (e) => { r.value_type = e.target.value; paintEditor(); } },
            h('option', { value: 'numeric', selected: !isText && !isSel }, 'число'),
            h('option', { value: 'text', selected: isText }, 'текст'),
            h('option', { value: 'select', selected: isSel }, 'список'));
        const normCell = isSel
            ? h('input', { value: r.value_options || '', placeholder: 'Прозрачная, Мутная', title: 'Варианты ответа через запятую — лаборант выберет один из списка', class: 'lw-inp', style: { width: '190px' }, oninput: (e) => { r.value_options = e.target.value; } })
            : isText
                ? h('input', { value: r.ref_text || '', placeholder: 'норма', class: 'lw-inp', style: { width: '130px' }, oninput: (e) => { r.ref_text = e.target.value; } })
                : range('ref_low', 'ref_high');
        return h('tr', null,
            h('td', null, h('input', { value: r.name || '', class: 'lw-inp param', style: { minWidth: '150px' }, oninput: (e) => { r.name = e.target.value; } })),
            h('td', null, h('input', { value: r.unit || '', class: 'lw-inp unit', style: { width: '70px' }, oninput: (e) => { r.unit = e.target.value; } })),
            h('td', null, typeSel),
            h('td', null, normCell),
            h('td', null, (isText || isSel) ? h('span', { class: 'muted' }, '—') : range('ref_low_m', 'ref_high_m')),
            h('td', null, (isText || isSel) ? h('span', { class: 'muted' }, '—') : range('ref_low_f', 'ref_high_f')),
            h('td', null, h('input', { value: r.group_label || '', placeholder: '—', class: 'lw-inp', style: { width: '120px' }, oninput: (e) => { r.group_label = e.target.value; } })),
            h('td', null, h('span', { class: 'lp-actions' },
                // LAB_MULTI_REF_V1 — extra named ranges (menopause, cycle phase,
                // trimester, age bands). Count badge so a configured analyte is
                // obvious at a glance in a long panel.
                (isText || isSel) ? h('span', { class: 'muted' }, '—') : h('button', {
                    class: 'lp-ic' + (nRanges > 1 ? ' on' : ''),
                    style: nRanges > 1 ? { fontWeight: '700', color: 'var(--primary-700)' } : null,
                    title: 'Диапазоны нормы (фаза цикла, менопауза, возраст…)',
                    onclick: () => openRangesModal(r),
                }, nRanges ? '±' + nRanges : '±'),
                h('button', { class: 'lp-ic', title: 'Вверх', onclick: () => { if (idx > 0) { const t = state.rows[idx - 1]; state.rows[idx - 1] = state.rows[idx]; state.rows[idx] = t; paintEditor(); } } }, '↑'),
                h('button', { class: 'lp-ic', title: 'Вниз', onclick: () => { if (idx < state.rows.length - 1) { const t = state.rows[idx + 1]; state.rows[idx + 1] = state.rows[idx]; state.rows[idx] = t; paintEditor(); } } }, '↓'),
                h('button', { class: 'lp-ic del', title: 'Удалить', onclick: () => { state.rows.splice(idx, 1); paintEditor(); } }, Icon('Trash', { size: 12 })))));
    }

    async function savePanel(fields) {
        if (!fields.name) { toast('Укажите название панели', 'warn'); return; }
        const p = state.selected;
        try {
            let panelId = p.id;
            const row = { name: fields.name, modality: fields.modality, has_narrative: fields.has_narrative, service_id: fields.service_id, active: fields.active };
            if (panelId) {
                const { error } = await supabase.from('lab_panels').update(row).eq('id', panelId);
                if (error) throw error;
            } else {
                row.company_id = cid; row.core_panel_id = p.core_panel_id || null; row.code = p.code || null;
                const { data, error } = await supabase.from('lab_panels').insert(row).select('id').single();
                if (error) throw error; panelId = data.id;
            }
            // LAB_PANEL_SAFE_SAVE_V1 — страховка от записи чужих показателей.
            //
            // Если в редакторе лежат показатели ДРУГОЙ панели (гонка выше или
            // любой будущий её вариант), сохранение уничтожило бы нормы этой
            // панели молча. Лучше отказать и попросить открыть панель заново.
            if (p.id && state.rowsPanelId != null && state.rowsPanelId !== p.id) {
                toast('Показатели в редакторе принадлежат другой панели — откройте панель заново.', 'fail');
                return;
            }
            // Старые показатели удаляем ПОСЛЕ успешной вставки новых: раньше
            // сначала шло удаление, и любая ошибка вставки оставляла панель
            // вообще без показателей — вместе со всеми нормами.
            const oldIds = (await supabase.from('lab_panel_analytes').select('id').eq('panel_id', panelId))
                .data?.map(x => x.id) || [];
            const ins = state.rows.filter(r => (r.name || '').trim()).map((r, i) => ({
                panel_id: panelId, company_id: cid, code: r.code || null, name: r.name.trim(), unit: r.unit || null,
                value_type: r.value_type || 'numeric', value_options: (r.value_options || '').trim() || null, decimals: Number(r.decimals) || 0,
                ref_low: r.ref_low, ref_high: r.ref_high, ref_text: r.ref_text || null,
                ref_low_m: r.ref_low_m, ref_high_m: r.ref_high_m, ref_low_f: r.ref_low_f, ref_high_f: r.ref_high_f,
                group_label: (r.group_label || '').trim() || null, sort_order: i,
                ref_ranges: normRanges(r).length ? normRanges(r) : null,   // LAB_MULTI_REF_V1
            }));
            if (ins.length) {
                let { error } = await supabase.from('lab_panel_analytes').insert(ins);
                // LAB_MULTI_REF_V1 — if migration 121 hasn't been applied yet the
                // ref_ranges column doesn't exist and the whole insert would fail,
                // taking the panel's analytes with it (they were just deleted).
                // Retry without the column so saving a panel NEVER breaks, and say
                // plainly what to do to enable the feature.
                if (error && /ref_ranges/i.test(error.message || '')) {
                    console.warn('[lab-settings] ref_ranges column missing — apply supabase/migrations/121_lab_multi_ref_ranges.sql');
                    const legacy = ins.map(({ ref_ranges, ...rest }) => rest);
                    ({ error } = await supabase.from('lab_panel_analytes').insert(legacy));
                    if (!error) toast('Панель сохранена, но доп. диапазоны не записаны — примените миграцию 121_lab_multi_ref_ranges.sql', 'warn');
                }
                if (error) throw error;
            }
            // Вставка прошла — теперь можно убрать прежние строки.
            if (oldIds.length) {
                const { error: delErr } = await supabase.from('lab_panel_analytes').delete().in('id', oldIds);
                if (delErr) throw delErr;
            }
            toast('Панель сохранена');
            state.selected = { ...p, id: panelId, ...row };
            await reload();
        } catch (e) { toast('Не удалось сохранить: ' + savePanelReason(e, fields), 'fail'); }
    }

    // LAB_LINK_REASON_V1 — одна услуга = одна панель (UNIQUE-индекс, миграция
    // 048). Раньше нарушение приходило как «Query failed.», и лаборант видел
    // только то, что сохранить нельзя — без причины и без способа исправить.
    // Теперь сервер отвечает 409 с именем ограничения; переводим его в фразу,
    // которая НАЗЫВАЕТ панель-владельца, потому что действие пользователя —
    // отвязать услугу там или выбрать другую.
    function savePanelReason(e, fields) {
        const msg = (e && e.message) || String(e);
        if (/lab_panels\.service_id/i.test(msg)) {
            const svcId = fields && fields.service_id;
            const owner = state.panels.find(p => String(p.service_id) === String(svcId) && p.id !== (state.selected && state.selected.id));
            const svc = state.services.find(s => String(s.id) === String(svcId));
            return 'услуга' + (svc ? ' «' + svc.name + '»' : '')
                + ' уже привязана к панели' + (owner ? ' «' + owner.name + '»' : '')
                + '. Одна услуга может принадлежать только одной панели — отвяжите её там или выберите другую услугу.';
        }
        return msg;
    }

    async function removePanel(p) {
        if (!p.id || !window.confirm('Удалить панель «' + p.name + '» и её показатели?')) return;
        try {
            const { error } = await supabase.from('lab_panels').delete().eq('id', p.id);
            if (error) throw error;
            toast('Панель удалена'); state.selected = null; await reload();
        } catch (e) { toast('Не удалось удалить: ' + (e.message || e), 'fail'); }
    }

    reload();
}
