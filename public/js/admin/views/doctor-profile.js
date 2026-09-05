// Doctor "My public profile" — full editable public-profile editor the doctor
// edits themselves (photo, trilingual identity + long-text, contacts/socials,
// specialties, diseases/symptoms treated). Saved to the doctor's own users row
// via update_my_doctor_profile RPC, plus user_specialties + doctor_conditions.
// Surfaces on Symptex via the partner API. DOCTOR_PROFILE_V1
import { h, clear, toast, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';
import { gw } from '../gateway.js';
import { uploadFile } from '../storage.js';
// PATIENT_PHOTO_V1 — те же правила и то же уменьшение, что в окне заведения
// пациента: один набор на оба виджета фото и на сервер.
import { photoRefusal, ALLOWED_PHOTO_EXT } from '../../shared/patient-file-limits.js?v=pph1';
import { downscalePhoto } from '../../shared/photo-downscale.js?v=pph1';

// PATIENT_PHOTO_V1 (2026-09-05) — корзина `doctor-photos` НЕ БЫЛА ОБЪЯВЛЕНА на
// сервере (routes/storage.js BUCKETS), и «Моё фото» в профиле врача отвечало
// 400 «Invalid storage path» — всегда, с самого переезда с Supabase.
//
// Путь стал `doctors/<id врача>/<ключ>`: id попал в него не для порядка, а
// потому, что по пути сервер отвечает на вопрос «чьё это фото» и выполняет
// правило «свою фотографию врач меняет сам». По прежнему `doctors/<ключ>` этот
// вопрос ответа не имел.
const PHOTO_BUCKET = 'doctor-photos';   // getPublicUrl → photo_url (NOT base64)
const photoPrefix = (doctorId) => 'doctors/' + doctorId + '/';

// Each base has _ru/_uz/_en. full_name & academic_title live in the IDENTITY card;
// the 5 below are the long-text cards.
const TRI_TEXT = [
    ['bio',            'О враче / Биография'],
];
// CV-style repeatable lists: each entry = { ru, uz, en, year } (year not translated).
const LIST_CATS = [
    ['education',      'Образование'],
    ['experience',     'Опыт работы'],
    ['certifications', 'Сертификаты'],
    ['prof_dev',       'Повышения квалификаций'],
];
// ENTRY_FIELDS_V1 — education/experience entries also carry a title + a year range
// (year_from/year_to); certificates/prof_dev keep a single year. Entries are free-form jsonb.
const LIST_OPTS = {
    education:  { title: 'Специальность / квалификация', range: true },
    experience: { title: 'Должность', range: true },
};
const LANGS = ['ru', 'uz', 'en'];
const LANG_LBL = { ru: 'RU', uz: 'UZ', en: 'EN' };
// DEGREE_SELECT_V1 — Учёная степень options; selecting one fills academic_title_{ru,uz,en}.
const ACADEMIC_TITLES = [
    { ru: '', uz: '', en: '' },
    { ru: 'Кандидат медицинских наук', uz: 'Tibbiyot fanlari nomzodi', en: 'Candidate of Medical Sciences' },
    { ru: 'Доктор медицинских наук', uz: 'Tibbiyot fanlari doktori', en: 'Doctor of Medical Sciences' },
    { ru: 'PhD', uz: 'PhD (falsafa doktori)', en: 'PhD' },
    { ru: 'DSc (доктор наук)', uz: 'DSc (fan doktori)', en: 'Doctor of Science (DSc)' },
];

export async function renderDoctorProfile(container, doctorId) {
    clear(container);
    const stUser = (window.easymed && window.easymed.state && window.easymed.state.user) || {};
    const companyId = stUser.company_id || (window.CLINIC && window.CLINIC.id) || null;

    // Per-open state (closure).
    const st = {
        user: null,               // the loaded users row
        photoFile: null,          // File/Blob pending upload (file pick OR webcam snapshot)
        photoUrl: '',             // already-a-URL ("по ссылке") OR loaded users.photo_url
        specSlugs: [],            // array of specialty_slug strings (max 4, [0] = primary)
        selectedConds: new Map(), // "kind:slug" -> { kind, slug, name_ru, name_uz }
        catalog: [],              // conditions catalog from gw
        specCatalog: [],          // specialties catalog from gw
    };

    const root = h('div', { class: 'fade-in docprof', style: { maxWidth: '820px' } });
    container.appendChild(root);
    root.appendChild(h('h2', { class: 'docprof-title' }, 'Мой профиль'));
    root.appendChild(h('div', { class: 'docprof-sub' },
        'Это ваша публичная карточка — её увидят пациенты на Symptex. Заполните на трёх языках.'));

    if (!doctorId || !companyId) {
        root.appendChild(h('div', { class: 'empty', style: { padding: '20px' } },
            'Нет контекста врача/клиники — откройте раздел из аккаунта врача на поддомене клиники.'));
        return;
    }

    const status = h('div', { class: 'docprof-status' }, 'Загрузка…');
    root.appendChild(status);

    // ----- Load (tolerant; swallow per CLAUDE.md so a missing row never breaks) -----
    try { st.catalog = (await gw('/catalog/conditions?limit=500')).data || []; }
    catch (e) { st.catalog = []; /* conditions card shows its own load error */ }
    try { st.specCatalog = (await gw('/catalog/specialties')).data || []; }
    catch (e) { st.specCatalog = []; }
    try { window.__specLookup = Object.fromEntries(st.specCatalog.map((s) => [s.slug, s])); } catch (e) {}

    try {
        const { data } = await supabase.from('users')
            .select('id, full_name, phone, specialty, license_number, doctor_category, room_id, ' +
                'photo_url, instagram_url, telegram_url, experience_years, ' +
                'full_name_ru, full_name_uz, full_name_en, academic_title_ru, academic_title_uz, academic_title_en, ' +
                'bio_ru, bio_uz, bio_en, education_ru, education_uz, education_en, ' +
                'experience_ru, experience_uz, experience_en, ' +
                'certifications_ru, certifications_uz, certifications_en, ' +
                'prof_dev_ru, prof_dev_uz, prof_dev_en, ' +
                'education_entries, experience_entries, certifications_entries, prof_dev_entries')
            .eq('id', doctorId).single();
        st.user = data || {};
    } catch (e) { st.user = {}; }
    st.photoUrl = st.user.photo_url || '';

    try {
        const { data } = await supabase.from('user_specialties')
            .select('specialty_slug, is_primary').eq('user_id', doctorId)
            .order('is_primary', { ascending: false });
        st.specSlugs = (data || []).map((r) => r.specialty_slug);
    } catch (e) { st.specSlugs = []; }

    try {
        const { data } = await supabase.from('doctor_conditions')
            .select('kind,slug,name_ru,name_uz').eq('doctor_id', doctorId);
        for (const r of (data || [])) st.selectedConds.set(r.kind + ':' + r.slug, r);
    } catch (e) {}

    status.remove();

    // ----- Collectors read by the save flow -----
    const triInputs = {};       // base -> { ru, uz, en } controls
    const nameInputs = {};      // lng -> { last, first, middle } structured ФИО (STRUCTURED_NAME_V1)
    const scalarInputs = {};    // experience_years
    const contactInputs = {};   // instagram_url, telegram_url
    const listCollectors = {};  // base -> () => [{ ru, uz, en, year }]
    let academicSel = null, academicOpts = [];  // Учёная степень dropdown (DEGREE_SELECT_V1)

    // ----- Card 1: photo + identity -----
    const idFields = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    idFields.appendChild(nameRow());
    idFields.appendChild(academicSelect());
    const yearsInp = h('input', { type: 'number', min: '0', step: '1', class: 'docprof-in',
        value: st.user.experience_years != null ? String(st.user.experience_years) : '' });
    scalarInputs.experience_years = yearsInp;
    idFields.appendChild(field('Стаж (лет)', yearsInp));

    root.appendChild(card('Фото и личные данные', 'User',
        h('div', { class: 'docprof-idrow' }, photoBlock(), idFields)));

    // ----- Card 2: contacts / socials -----
    const phoneInp = h('input', { type: 'tel', class: 'docprof-in', value: st.user.phone || '', disabled: true });
    const igInp = h('input', { type: 'url', class: 'docprof-in', value: st.user.instagram_url || '',
        placeholder: 'https://instagram.com/…' });
    const tgInp = h('input', { type: 'url', class: 'docprof-in', value: st.user.telegram_url || '',
        placeholder: 'https://t.me/…' });
    contactInputs.instagram_url = igInp;
    contactInputs.telegram_url = tgInp;
    root.appendChild(card('Контакты и соцсети', 'Link',
        h('div', { class: 'docprof-contacts' },
            field('Телефон', phoneInp, 'изменяется в карточке сотрудника'),
            field('Instagram', igInp),
            field('Telegram', tgInp))));

    // ----- Bio (trilingual long-text) -----
    for (const [base, label] of TRI_TEXT) {
        root.appendChild(card(label, 'NotePencil', triCardRow(base, label, { textarea: true })));
    }
    // ----- CV-style repeatable lists (education / experience / certs / qualifications) -----
    for (const [base, label] of LIST_CATS) {
        root.appendChild(card(label, 'NotePencil', entryListEditor(base, label)));
    }

    // ----- Card 8: specialties -----
    root.appendChild(card('Специальности', 'Stethoscope', specialtyCard()));

    // ----- Card 9: conditions (ported) -----
    root.appendChild(card('Болезни и симптомы, которые я лечу', 'Pulse', conditionsCard()));

    // ----- Save bar -----
    const saveBtn = h('button', { class: 'btn btn-primary docprof-save', type: 'button' },
        Icon('Check', { size: 14 }), ' Сохранить профиль');
    root.appendChild(h('div', { class: 'docprof-savebar' }, saveBtn));

    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = tr('Сохранение…');
        try {
            // (1) Upload pending photo → URL (or external "по ссылке", or '').
            const photoUrl = await uploadPendingPhoto();

            // (2) Assemble whitelisted RPC payload. '' clears a field.
            const p = {};
            for (const lng of LANGS) {
                const n = nameInputs[lng] || {};
                p[`full_name_${lng}`] = ['last', 'first', 'middle']
                    .map((k) => ((n[k] && n[k].value) || '').trim()).filter(Boolean).join(' ');
            }
            const _deg = academicOpts[parseInt((academicSel && academicSel.value) || '0', 10) || 0] || { ru: '', uz: '', en: '' };
            for (const lng of LANGS) p[`academic_title_${lng}`] = (_deg[lng] || '').trim();
            for (const [base] of TRI_TEXT) {
                for (const lng of LANGS) p[`${base}_${lng}`] = (triInputs[base][lng].value || '').trim();
            }
            for (const base of ['education', 'experience', 'certifications', 'prof_dev']) {
                p[`${base}_entries`] = listCollectors[base] ? listCollectors[base]() : [];
            }
            const yrs = scalarInputs.experience_years.value.trim();
            p.experience_years = yrs === '' ? null : Math.max(0, parseInt(yrs, 10) || 0);
            p.instagram_url = (contactInputs.instagram_url.value || '').trim();
            p.telegram_url = (contactInputs.telegram_url.value || '').trim();
            if (photoUrl) p.photo_url = photoUrl;   // never blank an existing photo by accident

            // (3) RPC — server-side whitelist; only the current doctor's row.
            const { error: rpcErr } = await supabase.rpc('update_my_doctor_profile', { p });
            if (rpcErr) throw rpcErr;

            // (4) Specialties: delete-then-insert, max 4, [0] = primary.
            await supabase.from('user_specialties').delete().eq('user_id', doctorId);
            const slugs = st.specSlugs.slice(0, 4);
            if (slugs.length) {
                const rows = slugs.map((slug, i) => {
                    const s = (window.__specLookup && window.__specLookup[slug]) || {};
                    return { company_id: companyId, user_id: doctorId, specialty_slug: slug,
                        name_ru: s.name_ru || null, name_uz: s.name_uz || null, is_primary: i === 0 };
                });
                const { error } = await supabase.from('user_specialties').insert(rows);
                if (error) throw error;
            }

            // (5) Conditions: delete-then-insert (ported legacy save logic).
            await supabase.from('doctor_conditions').delete().eq('doctor_id', doctorId);
            const condRows = [...st.selectedConds.values()].map((x) => ({
                company_id: companyId, doctor_id: doctorId, kind: x.kind, slug: x.slug,
                name_ru: x.name_ru || null, name_uz: x.name_uz || null,
            }));
            if (condRows.length) {
                const { error } = await supabase.from('doctor_conditions').insert(condRows);
                if (error) throw error;
            }

            // (6) Reflect the new photo in state so a re-save doesn't re-upload.
            if (photoUrl) { st.photoUrl = photoUrl; st.photoFile = null; }
            // (6b) DOCTOR_SYNC_V1 — publish to medcore so the profile (name in all languages,
            // photo, bio, department) reaches the Symptex marketplace now, not only on the next
            // bulk company publish. Best-effort: a sync failure must not fail the local save.
            try {
                await gw('/identity/doctor', { method: 'POST', body: { user_id: doctorId, specialty_slugs: st.specSlugs.slice(0, 4) } });
            } catch (e) { console.warn('[doctor-profile] medcore sync:', e.message); }
            toast('Профиль сохранён', 'info');
        } catch (e) {
            toast(trf('Не удалось сохранить: {msg}', { msg: e.message || e }), 'fail');
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '';
        saveBtn.append(Icon('Check', { size: 14 }), ' Сохранить профиль');
    };

    // =======================================================================
    // Helpers (closures over st / doctorId / companyId / triInputs).
    // =======================================================================

    function card(title, iconName, ...body) {
        return h('div', { class: 'card docprof-card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon(iconName, { size: 16 }), ' ' + title)),
            h('div', { class: 'card-pad' }, ...body));
    }

    function field(label, input, hint) {
        return h('div', { class: 'field' },
            h('label', null, label), input,
            hint ? h('div', { class: 'docprof-hint' }, hint) : null);
    }

    // Trilingual RU/UZ/EN group. opts.textarea → <textarea>; else single-line input.
    function triRow(base, label, { textarea = false, prefill = {}, placeholder = {} } = {}) {
        const inputs = {};
        const cells = LANGS.map((lng) => {
            const v = prefill[lng] != null ? prefill[lng] : '';
            const ctrl = textarea
                ? h('textarea', { rows: '4', class: 'docprof-ta', placeholder: placeholder[lng] || '' }, v)
                : h('input', { type: 'text', class: 'docprof-in', value: v, placeholder: placeholder[lng] || '' });
            inputs[lng] = ctrl;
            return h('div', { class: 'docprof-tricell' },
                h('label', { class: 'docprof-trilabel' }, label + ' · ' + LANG_LBL[lng]),
                ctrl);
        });
        const node = h('div', { class: 'docprof-trigroup' }, ...cells);
        return { node, inputs };
    }

    function triCardRow(base, label, opts = {}) {
        const pf = {};
        for (const lng of LANGS) pf[lng] = (st.user[`${base}_${lng}`]) || '';
        if (opts.seedRuFromLegacy && !pf.ru && st.user.full_name) pf.ru = st.user.full_name;
        const r = triRow(base, label, {
            textarea: !!opts.textarea && !opts.input,
            prefill: pf,
            placeholder: opts.placeholder || {},
        });
        triInputs[base] = r.inputs;
        return r.node;
    }

    // STRUCTURED_NAME_V1 — ФИО as Surname / Name / Middle per language. Split from / composed
    // back to the single full_name_<lng> string (mirrors the employee card; no sharing-schema change).
    function splitName(str) {
        const parts = String(str || '').trim().split(/\s+/).filter(Boolean);
        return { last: parts[0] || '', first: parts[1] || '', middle: parts.slice(2).join(' ') };
    }
    function nameRow() {
        const groups = LANGS.map((lng) => {
            const seed = st.user[`full_name_${lng}`] || (lng === 'ru' ? st.user.full_name : '') || '';
            const part = splitName(seed);
            const mk = (val, ph) => h('input', { type: 'text', class: 'docprof-in', value: val, placeholder: ph });
            const last = mk(part.last, 'Фамилия'), first = mk(part.first, 'Имя'), middle = mk(part.middle, 'Отчество');
            nameInputs[lng] = { last, first, middle };
            return h('div', { class: 'docprof-tricell' },
                h('label', { class: 'docprof-trilabel' }, trf('ФИО · {lang}', { lang: LANG_LBL[lng] })),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' } }, last, first, middle));
        });
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, ...groups);
    }

    // DEGREE_SELECT_V1 — Учёная степень dropdown; a pre-existing free-text value not in the list is
    // preserved as an extra option so nothing is lost.
    function academicSelect() {
        const cur = { ru: (st.user.academic_title_ru || '').trim(),
                      uz: (st.user.academic_title_uz || '').trim(),
                      en: (st.user.academic_title_en || '').trim() };
        academicOpts = ACADEMIC_TITLES.slice();
        if (cur.ru && !academicOpts.some((o) => o.ru === cur.ru)) academicOpts.splice(1, 0, cur);
        const sel = h('select', { class: 'docprof-in' });
        academicOpts.forEach((opt, i) => {
            const o = h('option', { value: String(i) }, opt.ru || '— Не указана —');
            if ((opt.ru || '') === cur.ru) o.selected = true;
            sel.appendChild(o);
        });
        academicSel = sel;
        return field('Учёная степень', sel);
    }

    // ----- CV-style repeatable list editor: rows of { ru, uz, en, year } -----
    function entryListEditor(base, label) {
        const opt = LIST_OPTS[base] || {};
        const wrap = h('div', { class: 'docprof-list' });
        const rowsBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
        const seed = Array.isArray(st.user[`${base}_entries`]) ? st.user[`${base}_entries`] : [];
        const yint = (el) => (el && el.value.trim() ? Math.max(0, parseInt(el.value, 10) || 0) : null);

        function addRow(it = {}) {
            const ru = h('input', { type: 'text', class: 'docprof-in', placeholder: 'RU', value: it.ru || '' });
            const uz = h('input', { type: 'text', class: 'docprof-in', placeholder: 'UZ', value: it.uz || '' });
            const en = h('input', { type: 'text', class: 'docprof-in', placeholder: 'EN', value: it.en || '' });
            const cells = [ru, uz, en];
            let cols = '1fr 1fr 1fr';

            let titleInp = null;
            if (opt.title) {
                titleInp = h('input', { type: 'text', class: 'docprof-in', placeholder: opt.title, value: it.title || '' });
                cells.push(titleInp); cols += ' 1.2fr';
            }

            let fromInp = null, toInp = null, yrInp = null;
            if (opt.range) {
                const yearIn = (ph, val) => h('input', { type: 'number', min: '0', step: '1', class: 'docprof-in',
                    placeholder: ph, value: (val != null && val !== '' ? String(val) : ''), style: { maxWidth: '92px' } });
                fromInp = yearIn('Год с', it.year_from != null ? it.year_from : it.year);
                toInp   = yearIn('Год по', it.year_to);
                cells.push(fromInp, toInp); cols += ' 92px 92px';
            } else {
                yrInp = h('input', { type: 'number', min: '0', step: '1', class: 'docprof-in', placeholder: 'Год',
                    value: (it.year != null ? String(it.year) : ''), style: { maxWidth: '94px' } });
                cells.push(yrInp); cols += ' 94px';
            }
            cols += ' auto';

            const row = h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: '6px', alignItems: 'center' } }, ...cells);
            const del = h('button', { type: 'button', class: 'btn btn-outline btn-sm', title: 'Удалить', onclick: () => row.remove() }, '×');
            row.appendChild(del);
            row._get = () => {
                const e = { ru: ru.value.trim(), uz: uz.value.trim(), en: en.value.trim() };
                if (opt.title) e.title = titleInp.value.trim();
                if (opt.range) { e.year_from = yint(fromInp); e.year_to = yint(toInp); }
                else e.year = yint(yrInp);
                return e;
            };
            rowsBox.appendChild(row);
        }
        seed.forEach(addRow);

        const addBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', style: { marginTop: '8px' },
            onclick: () => addRow() }, Icon('Plus', { size: 13 }), ' Добавить запись');
        wrap.appendChild(rowsBox);
        wrap.appendChild(addBtn);
        listCollectors[base] = () => [...rowsBox.children].filter(r => r._get)
            .map(r => r._get())
            .filter(e => e.ru || e.uz || e.en || e.title || e.year != null || e.year_from != null || e.year_to != null);
        return wrap;
    }

    // ----- Photo block (ported from registration.js; bucket → doctor-photos) -----
    function photoBlock() {
        const img = h('img', { alt: 'Фото врача', style: { display: 'none', width: '156px', height: '156px', objectFit: 'cover', borderRadius: '12px' } });
        const ph = h('div', { class: 'cam-ph' },
            Icon('Image', { size: 28 }),
            h('span', { style: { fontSize: '12.5px', fontWeight: 500 } }, 'Фото врача'),
        );
        const box = h('div', { class: 'cam-box' }, ph, img);
        const setPhoto = (url) => {
            if (!url) { img.style.display = 'none'; ph.style.display = ''; return; }
            img.src = url; img.style.display = ''; ph.style.display = 'none';
        };
        // PATIENT_PHOTO_V1 — одна дверь для файла и для кадра с камеры:
        // уменьшить → проверить → показать. Правило, добавленное в один из
        // двух обработчиков, обошло бы второй.
        async function acceptPhoto(fileOrBlob) {
            if (!fileOrBlob) return null;
            const named = fileOrBlob instanceof File
                ? fileOrBlob
                : new File([fileOrBlob], 'photo.jpg', { type: (fileOrBlob && fileOrBlob.type) || 'image/jpeg' });
            const small = await downscalePhoto(named);
            const bad = photoRefusal({ name: small.name || named.name, size: small.size });
            if (bad) { toast(trf(bad.template, bad.params), 'fail'); return null; }
            st.photoFile = small; st.photoUrl = '';
            setPhoto(URL.createObjectURL(small));
            return small;
        }
        const fileInp = h('input', { type: 'file', accept: ALLOWED_PHOTO_EXT.join(','), style: { display: 'none' },
            onchange: async (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                if (await acceptPhoto(f)) toast(trf('Фото загружено: {name}', { name: f.name || tr('файл') }));
            },
        });
        const acts = h('div', { class: 'cam-acts' },
            h('button', { class: 'cam-act', type: 'button', title: 'Сфотографировать с веб-камеры', 'aria-label': 'Сфотографировать',
                onclick: () => openWebcamModal(async (blob) => { if (await acceptPhoto(blob)) toast('Фото снято с камеры'); }) },
                Icon('Camera', { size: 15 })),
            h('button', { class: 'cam-act', type: 'button', title: 'Загрузить файл с компьютера', 'aria-label': 'Загрузить с компьютера',
                onclick: () => fileInp.click() },
                Icon('Download', { size: 15 })),
            h('button', { class: 'cam-act', type: 'button', title: 'Добавить фото по ссылке (URL)', 'aria-label': 'По ссылке',
                onclick: () => { const u = window.prompt('Ссылка на фото (URL)'); if (u && u.trim()) { st.photoFile = null; st.photoUrl = u.trim(); setPhoto(u.trim()); toast('Фото по ссылке добавлено'); } } },
                Icon('Globe', { size: 15 })),
        );
        if (st.photoUrl) setPhoto(st.photoUrl);   // show current photo on open
        return h('div', { class: 'cam-wrap' }, box, fileInp, acts);
    }

    // Upload pending photo to Storage (NEVER base64). Returns external URL,
    // a Storage public URL, or '' (leave photo unchanged on failure).
    async function uploadPendingPhoto() {
        if (st.photoUrl && st.photoUrl !== st.user.photo_url) return st.photoUrl;  // "по ссылке"
        if (!st.photoFile) return '';                                              // nothing new chosen
        const file = st.photoFile instanceof File
            ? st.photoFile
            : new File([st.photoFile], 'photo.jpg', { type: st.photoFile.type || 'image/jpeg' });
        try {
            const { path } = await uploadFile(PHOTO_BUCKET, file, photoPrefix(doctorId));
            const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
            return (data && data.publicUrl) || '';
        } catch (e) {
            toast(trf('Не удалось загрузить фото: {msg}', { msg: (e && e.message) || e }), 'fail');
            return '';   // save profile anyway, photo unchanged
        }
    }

    // ----- WebcamCapture modal (ported; title → doctor) -----
    function openWebcamModal(onCapture) {
        const overlay = h('div', { class: 'modal', style: { zIndex: '120' } });
        let stream = null;
        const stop = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } };
        const close = () => { stop(); overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'cam-video' });
        const errEl = h('div', { class: 'cam-err', style: { display: 'none' } });
        const snapBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true,
            onclick: () => {
                const w = video.videoWidth || 1280, ht = video.videoHeight || 960;
                const cv = document.createElement('canvas'); cv.width = w; cv.height = ht;
                cv.getContext('2d').drawImage(video, 0, 0, w, ht);
                cv.toBlob((blob) => { if (blob) onCapture(blob); close(); }, 'image/jpeg', 0.9);
            } }, Icon('Camera', { size: 14 }), ' Сделать снимок');

        const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = ''; };
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showErr('Камера не поддерживается этим браузером.');
        } else {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
                .then((s) => { stream = s; video.srcObject = s; snapBtn.removeAttribute('disabled'); })
                .catch((e) => showErr(trf('Нет доступа к камере: {msg}. Разрешите доступ в браузере.', { msg: (e && e.message) || e })));
        }

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Camera', { size: 16 }), ' Съёмка фото врача'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' }, errEl, video),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
                h('button', { class: 'btn', onclick: close }, 'Отмена'),
                snapBtn),
        ));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
    }

    // ----- Specialties card (adapted from employee-editor specialtyPicker) -----
    function specialtyCard() {
        const nameOf = (s) => (s && (s.name_ru || s.slug)) || '';
        const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
        const chips = h('div', { class: 'docprof-spec-chips' });
        const ctrlWrap = h('div');

        function repaint() {
            clear(chips);
            st.specSlugs.forEach((slug, idx) => {
                const s = st.specCatalog.find((x) => x.slug === slug) || { slug, name_ru: slug };
                chips.appendChild(h('span', { class: 'docprof-spec-chip' },
                    nameOf(s),
                    idx === 0 ? h('span', { class: 'primary-badge' }, 'основная') : null,
                    h('button', { class: 'x', type: 'button', title: 'Убрать',
                        onclick: () => { st.specSlugs = st.specSlugs.filter((x) => x !== slug); repaint(); } }, '×')));
            });
            clear(ctrlWrap);
            if (st.specSlugs.length < 4) {
                const avail = st.specCatalog.filter((s) => !st.specSlugs.includes(s.slug));
                const sel = h('select', { class: 'docprof-in', style: { maxWidth: '320px' },
                    onchange: (e) => {
                        const v = e.target.value;
                        if (v) { st.specSlugs = [...st.specSlugs, v]; repaint(); }
                    } },
                    h('option', { value: '' }, '+ Добавить специальность'),
                    ...avail.map((s) => h('option', { value: s.slug }, nameOf(s))));
                ctrlWrap.appendChild(sel);
            } else {
                ctrlWrap.appendChild(h('div', { class: 'docprof-hint' }, 'Максимум 4 специальности.'));
            }
        }
        wrap.appendChild(chips);
        wrap.appendChild(ctrlWrap);
        repaint();
        return wrap;
    }

    // ----- Conditions card (ported legacy logic — search + checkbox list) -----
    function conditionsCard() {
        const wrap = h('div');
        const condStatus = h('div', { class: 'docprof-status', style: { marginBottom: '8px' } }, '');
        const searchI = h('input', { class: 'docprof-cond-search', placeholder: 'Поиск болезней / симптомов…' });
        const listWrap = h('div', { class: 'docprof-cond-list' });
        wrap.appendChild(condStatus);
        wrap.appendChild(searchI);
        wrap.appendChild(listWrap);

        if (!st.catalog.length) {
            condStatus.textContent = tr('Не удалось загрузить каталог болезней.');
            return wrap;
        }

        const key = (k, s) => k + ':' + s;
        function updateStatus() {
            condStatus.textContent = trf('{sel} выбрано · {total} в каталоге', { sel: st.selectedConds.size, total: st.catalog.length });
        }
        function render() {
            clear(listWrap);
            const q = searchI.value.trim().toLowerCase();
            const items = st.catalog.filter((x) => !q || x.slug.toLowerCase().includes(q) || (x.name_ru || '').toLowerCase().includes(q) || (x.name_uz || '').toLowerCase().includes(q));
            if (!items.length) listWrap.appendChild(h('div', { class: 'docprof-status', style: { padding: '8px' } }, 'Ничего не найдено.'));
            for (const x of items) {
                const k = key(x.kind, x.slug);
                const cb = h('input', { type: 'checkbox', onchange: () => { if (cb.checked) st.selectedConds.set(k, x); else st.selectedConds.delete(k); updateStatus(); } });
                if (st.selectedConds.has(k)) cb.checked = true;
                listWrap.appendChild(h('label', { class: 'docprof-cond-row' },
                    cb,
                    h('span', { style: { flex: '1' } }, x.name_ru || x.slug, x.name_uz ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '  ·  ' + x.name_uz) : null),
                    h('span', { class: 'tag ' + (x.kind === 'diagnosis' ? 'tag-info' : 'tag-purple'), style: { fontSize: '12.5px' } }, x.kind === 'diagnosis' ? 'Болезнь' : 'Симптом')));
            }
            updateStatus();
        }
        searchI.oninput = render;
        render();
        return wrap;
    }
}
