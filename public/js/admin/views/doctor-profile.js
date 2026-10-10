// Doctor "My public profile" — full editable public-profile editor the doctor
// edits themselves (photo, trilingual identity + long-text, contacts/socials,
// specialties, diseases/symptoms treated). Saved to the doctor's own users row
// via update_my_doctor_profile RPC, plus user_specialties + doctor_conditions.
// Surfaces on Symptex via the partner API. DOCTOR_PROFILE_V1
import { h, clear, toast, Icon } from '../ui.js';
import { tr, trf, getLang } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ; REFERENCE_LISTS_V1 — getLang для порядка
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
// RPC_PORT_V1 — офлайн каталог специальностей из медкора (gw) недоступен:
// выбор идёт из того же канонического списка, по которому сервер проверяет слаг.
import { SPECIALTY_ROWS, canonicalSpecialty, sortByShownLabel } from '../../shared/specialty-list.js';   // REFERENCE_LISTS_V1 — sortByShownLabel
import { specialtyLabel } from '../specialties.js?v=spec2';   // DOCTOR_PROFILE_V1 — название из справочника, как в карточке сотрудника (ревью №10)
import { DOCTOR_LANGS, PRACTICE_SINCE_MIN, experienceYears, readLanguages, shownPracticeSince, cleanPracticeSince } from '../../shared/doctor-public.js';   // DOCTOR_PROFILE_V1
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
        specLoadFailed: false,    // CLINIC_API_FIX_V1 — list did not load: no editing, never sent
        selectedConds: new Map(), // "kind:slug" -> { kind, slug, name_ru, name_uz }
        condLoadFailed: false,    // CLINIC_API_FIX_V1 — as specLoadFailed, for doctor_conditions
        catalog: [],              // conditions catalog from gw
        specCatalog: [],          // specialties catalog from gw
        languages: [],            // DOCTOR_PROFILE_V1 — языки приёма
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
    // V3120_FIX — КАТАЛОГИ ВСТРОЕННЫЕ, ШЛЮЗА ОФЛАЙН НЕТ. Здесь стояли два
    // запроса к облачному шлюзу (/api/v1/catalog/conditions и /specialties):
    // офлайн оба отвечали 404 на каждое открытие профиля, и специальности всё
    // равно брались из встроенного списка. Список специальностей — встроенный
    // (shared/specialty-list.js); каталога болезней в офлайн-версии нет, и
    // карточка честно это говорит (conditionsCard ниже).
    st.catalog = [];
    st.specCatalog = SPECIALTY_ROWS.map((r) => ({ slug: r.slug, name_ru: r.ru, name_uz: r.uz }));   // RPC_PORT_V1
    try { window.__specLookup = Object.fromEntries(st.specCatalog.map((s) => [s.slug, s])); } catch (e) {}

    try {
        // CLOUD_LEFTOVER_COLUMNS_V1 (2026-09-06) — СПРАШИВАЕМ ТОЛЬКО ТО, ЧТО
        // В ЭТОЙ БАЗЕ ЕСТЬ.
        //
        // Здесь перечислялись 36 колонок, из которых 29 в offline-схеме не
        // существует вовсе: многоязычные биографии, звания, образование,
        // Instagram и Telegram — это поля ПУБЛИЧНОГО профиля врача из облачной
        // версии. Компилятор отвергает запрос ЦЕЛИКОМ из-за любой неизвестной
        // колонки, поэтому не «не хватало биографии», а не приходило НИЧЕГО:
        // `st.user` оставался пустым, и экран профиля врача был пуст всегда,
        // с самого начала.
        //
        // Это тот самый класс, из-за которого владелец видит «запрос к базе
        // отклонён»: одна лишняя колонка гасит целый экран.
        // DOCTOR_PUBLIC_PROFILE_V1 (миграция 159) — поля публичного профиля
        // теперь хранятся офлайн и читаются обратно: без этого экран каждый
        // раз открывался пустым, и повторное «Сохранить» стирало введённое.
        const { data } = await supabase.from('users')
            .select('id, full_name, phone, specialty, license_number, doctor_category, room_id, '
                + 'full_name_ru, full_name_uz, full_name_en, academic_title_ru, academic_title_uz, academic_title_en, '
                + 'bio_ru, bio_uz, bio_en, education_entries, experience_entries, certifications_entries, prof_dev_entries, '
                + 'experience_years, instagram_url, telegram_url, photo_url, '
                + 'is_local, '   // CLINIC_API_FIX_V1 — 0: строка из главного здания, здесь только просмотр
                + 'languages, practice_since, is_public')   // DOCTOR_PROFILE_V1 — языки, «работает с», показ (только видно)
            .eq('id', doctorId).single();
        st.user = data || {};
    } catch (e) { st.user = {}; }
    // DOCTOR_PUBLIC_PROFILE_V1 — photo_url хранится (путь в doctor-photos или ссылка).
    st.photoUrl = st.user.photo_url || '';

    try {
        // CLINIC_API_FIX_V1 — отказ базы — не «специальностей нет»: пустой
        // список на экране после правки заменил бы на сервере весь набор врача.
        const { data, error } = await supabase.from('user_specialties')
            .select('specialty_slug, name_ru, is_primary').eq('user_id', doctorId)
            .order('is_primary', { ascending: false });
        if (error) throw error;
        // Ревью M7b — карточка сотрудника пишет специальность без слага, одним
        // названием. Каноническое название узнаём по списку и показываем как
        // обычную специальность; неканоническое экран не показывает и не шлёт —
        // сервер сохраняет такую строку сам (rpc/doctor-profile.js).
        const slugOfName = (name) => {
            const ru = canonicalSpecialty(name);
            const hit = SPECIALTY_ROWS.find((r) => r.ru === ru);
            return hit ? hit.slug : null;
        };
        st.specSlugs = [...new Set((data || []).map((r) => r.specialty_slug || slugOfName(r.name_ru)).filter(Boolean))];
    } catch (e) { st.specSlugs = []; st.specLoadFailed = true; }   // CLINIC_API_FIX_V1

    try {
        // CLINIC_API_FIX_V1 (ревью итога) — как со специальностями выше: отказ
        // базы приходит {error}, без исключения, и молча давал пустой список.
        // Отмеченная после этого болезнь заменила бы на сервере (DELETE +
        // INSERT) все сохранённые — поэтому не загрузились — не меняются.
        const { data, error } = await supabase.from('doctor_conditions')
            .select('kind,slug,name_ru,name_uz').eq('doctor_id', doctorId);
        if (error) throw error;
        for (const r of (data || [])) st.selectedConds.set(r.kind + ':' + r.slug, r);
    } catch (e) { st.selectedConds.clear(); st.condLoadFailed = true; }

    status.remove();

    // CLINIC_API_FIX_V1 — ВРАЧ ИЗ ГЛАВНОГО ЗДАНИЯ (users.is_local = 0,
    // STAFF_SYNC_V1): профиль здесь только смотрят — правку переписала бы
    // ежечасная синхронизация, и сервер отказывает ей 409 (rpc/doctor-profile.js).
    // Как карточка сотрудника для синхронизированных (views/employees.js
    // managedNote + disableAll): строка-объяснение первой, поля и «Сохранить
    // профиль» выключены. Строка не загрузилась (st.user пуст) — это не «из
    // главного здания»: тогда отказ, если он нужен, даст сервер.
    const managed = st.user.is_local === 0;
    const MANAGED_NOTE = 'Профиль врача меняется в главном здании — здесь его можно только посмотреть.';
    if (managed) {
        root.appendChild(h('div', {
            class: 'docprof-managed', role: 'note',
            style: {
                display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px',
                padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
                background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', color: 'var(--ink-600)',
            },
        }, Icon('Building', { size: 15 }), h('span', null, MANAGED_NOTE)));
    }
    // DOCTOR_PROFILE_V1 — показ на сайте и у партнёров включает администратор
    // (карточка сотрудника); врач его здесь только видит.
    root.appendChild(h('p', { class: 'docprof-hint docprof-pub', role: 'note' }, Number(st.user.is_public) === 1
        ? 'Профиль показывается на сайте клиники и у партнёров. Показ включает и выключает администратор.'
        : 'Профиль пока не показывается на сайте клиники и у партнёров — показ включает администратор.'));

    // ----- Collectors read by the save flow -----
    const triInputs = {};       // base -> { ru, uz, en } controls
    const nameInputs = {};      // lng -> { last, first, middle } structured ФИО (STRUCTURED_NAME_V1)
    const scalarInputs = {};    // practice_since (DOCTOR_PROFILE_V1)
    const contactInputs = {};   // instagram_url, telegram_url
    const listCollectors = {};  // base -> () => [{ ru, uz, en, year }]
    let academicSel = null, academicOpts = [];  // Учёная степень dropdown (DEGREE_SELECT_V1)

    // ----- Card 1: photo + identity -----
    const idFields = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    idFields.appendChild(nameRow());
    idFields.appendChild(academicSelect());
    // DOCTOR_PROFILE_V1 — «Работает врачом с» вместо «Стаж (лет)»: стаж на сайте
    // растёт сам; у строки главной старой версии год — из прежнего стажа.
    const thisYear = new Date().getFullYear();
    const sinceInp = h('input', { type: 'number', min: String(PRACTICE_SINCE_MIN), max: String(thisYear), step: '1', class: 'docprof-in', placeholder: '2015' });
    const shownSince = shownPracticeSince(st.user);
    sinceInp.value = shownSince == null ? '' : String(shownSince);
    scalarInputs.practice_since = sinceInp;
    const sinceHint = h('div', { class: 'docprof-hint' });
    // DOCTOR_PROFILE_V1 (ревью шага 5, №9) — год проверяется здесь, до сервера, тем же
    // правилом, что карточка сотрудника (cleanPracticeSince): отказ — под полем, а не
    // тостом сервера; подсказка стажа — только у годного года («12» по старой
    // привычке «Стаж (лет)» давал «Стаж на сайте, лет: 2014.»).
    const sinceErr = h('div', { class: 'cpf-err', role: 'alert' });
    sinceErr.hidden = true;
    const sayYear = (msg) => {
        sinceErr.textContent = msg ? tr(msg) : '';
        sinceErr.hidden = !msg;
        if (msg) sinceInp.setAttribute('aria-invalid', 'true'); else sinceInp.removeAttribute('aria-invalid');
    };
    const paintSince = () => {
        const c = cleanPracticeSince(sinceInp.value.trim());
        sinceHint.textContent = c.problem || c.value == null ? '' : trf('Стаж на сайте, лет: {n}.', { n: experienceYears(c.value) });
    };
    sinceInp.addEventListener('input', () => { sayYear(''); paintSince(); });
    paintSince();
    idFields.appendChild(h('div', { class: 'field' }, h('label', null, 'Работает врачом с'), sinceInp, sinceHint, sinceErr));
    // DOCTOR_PROFILE_V1 — языки приёма (макет «Публичный профиль»): хотя бы один.
    st.languages = readLanguages(st.user.languages);
    const langBox = h('div', { class: 'dpp-langs', role: 'group', 'aria-label': 'Языки приёма' });
    for (const l of DOCTOR_LANGS) {
        const b = h('button', { type: 'button', class: 'dpp-lang', 'aria-pressed': st.languages.includes(l) ? 'true' : 'false' }, LANG_LBL[l]);
        b.addEventListener('click', () => {
            const on = st.languages.includes(l);
            if (on && st.languages.length === 1) { toast('Нужен хотя бы один язык', 'fail'); return; }
            st.languages = DOCTOR_LANGS.filter((x) => (x === l ? !on : st.languages.includes(x)));
            b.setAttribute('aria-pressed', on ? 'false' : 'true');
        });
        langBox.appendChild(b);
    }
    idFields.appendChild(h('div', { class: 'field' }, h('label', null, 'Языки приёма'), langBox,
        h('div', { class: 'docprof-hint' }, 'На каких языках врач говорит с пациентом.')));

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

    // ----- What the screen shows right after opening -----
    // CLINIC_API_FIX_V1 (2026-10-06) — СОХРАНЯЕТСЯ ТОЛЬКО ИЗМЕНЁННОЕ. Прежде
    // каждое «Сохранить профиль» слало ВСЕ поля профиля и целые наборы
    // специальностей и болезней: правка администратора в карточке сотрудника,
    // сделанная, пока у врача открыт этот экран, молча откатывалась, а экран,
    // который не загрузился (запрос к базе отклонён), открывался пустым и
    // стирал весь профиль. Точка отсчёта — то, что экран собрал бы сразу после
    // открытия (теми же сборщиками: подставленное ФИО, нормализованные списки),
    // а после удачного сохранения — сохранённое.
    let atOpen = collectAll();

    // ----- Save bar -----
    const saveBtn = h('button', { class: 'btn btn-primary docprof-save', type: 'button' },
        Icon('Check', { size: 14 }), ' Сохранить профиль');
    root.appendChild(h('div', { class: 'docprof-savebar' }, saveBtn));
    if (managed) disableAll(root);   // CLINIC_API_FIX_V1 — только просмотр, вместе с «Сохранить профиль»

    saveBtn.onclick = async () => {
        // CLINIC_API_FIX_V1 — кнопка выключена; нажатие, которое всё же дошло,
        // не загружает фото и не зовёт сервер.
        if (managed) { toast(MANAGED_NOTE, 'fail'); return; }
        // DOCTOR_PROFILE_V1 (ревью шага 5, №9) — изменённый год — проверка до сервера:
        // сервер отказал бы всему сохранению (и биографии тоже).
        const yrsNow = sinceInp.value.trim();
        if ((yrsNow === '' ? null : Number(yrsNow)) !== atOpen.p.practice_since) {
            const c = cleanPracticeSince(yrsNow);
            if (c.problem) { sayYear(c.problem); sinceInp.focus(); toast(c.problem, 'fail'); return; }
        }
        saveBtn.disabled = true;
        saveBtn.textContent = tr('Сохранение…');
        try {
            // (0) CLINIC_API_FIX_V1 — врачу из главного здания сервер откажет во
            // всём сохранении (409, rpc/doctor-profile.js), и выбранное фото
            // легло бы в хранилище зря. Пустой вызов ничего не пишет и отвечает
            // тем же отказом — спрашиваем его ДО загрузки и только при новом
            // фото: без фото отказ придёт ответом на само сохранение.
            if (st.photoFile) {
                const { error: preErr } = await supabase.rpc('update_my_doctor_profile', { p: {} });
                if (preErr) throw preErr;
            }
            // (1) Upload pending photo → URL (or external "по ссылке", or '').
            // Сбой загрузки фото не должен отнимать у врача сохранение
            // остального профиля, специальностей и болезней.
            let photoUrl = '';
            try { photoUrl = await uploadPendingPhoto(); } catch (e) { console.warn('[doctor-profile] photo upload:', e.message || e); }
            // CLINIC_API_FIX_V1 — выбранное фото не загрузилось (свой тост об
            // этом уже показан): не «Нет изменений» и не голое «Профиль сохранён».
            const photoFailed = !photoUrl && !!st.photoFile;

            // (2) Whitelisted RPC payload — CLINIC_API_FIX_V1: only the keys that
            // differ from atOpen. '' clears a field.
            const now = collectAll();
            const p = {};
            for (const [k, v] of Object.entries(now.p)) {
                if (JSON.stringify(v) !== JSON.stringify(atOpen.p[k])) p[k] = v;
            }
            if (photoUrl) p.photo_url = photoUrl;   // only a newly chosen photo; never blank an existing one

            // (3) RPC — server-side whitelist; only the current doctor's row.
            // RPC_PORT_V1 — специальности (до 4, [0] = основная) и болезни/симптомы
            // едут в том же вызове и заменяются на сервере одной транзакцией.
            // Напрямую в user_specialties / doctor_conditions экран больше не
            // пишет: реестр пускает туда только admin, и insert с company_id
            // отвергался у всех.
            // CLINIC_API_FIX_V1 — набор уходит, только если он стал другим:
            // без ключа сервер оставляет строки как были. Не загрузившиеся
            // специальности и болезни не уходят никогда.
            const args = { p };
            if (!st.specLoadFailed && JSON.stringify(now.specialties) !== JSON.stringify(atOpen.specialties)) args.specialties = now.specialties;
            if (!st.condLoadFailed && JSON.stringify(now.conditions) !== JSON.stringify(atOpen.conditions)) args.conditions = now.conditions;
            if (!Object.keys(p).length && !('specialties' in args) && !('conditions' in args)) {
                // Фото не загрузилось — об этом уже сказал свой тост.
                if (!photoFailed) toast('Нет изменений', 'info');
                return;
            }
            const { data: saveRes, error: rpcErr } = await supabase.rpc('update_my_doctor_profile', args);
            if (rpcErr) throw rpcErr;
            const notStored = (saveRes && Array.isArray(saveRes.not_stored)) ? saveRes.not_stored : [];
            atOpen = now;   // CLINIC_API_FIX_V1 — следующее сохранение считает от сохранённого

            // (6) Reflect the new photo in state so a re-save doesn't re-upload
            // (CLINIC_API_FIX_V1 — and doesn't re-send it as "по ссылке").
            if (photoUrl) { st.photoUrl = photoUrl; st.photoFile = null; st.user.photo_url = photoUrl; }
            // (6b) DOCTOR_SYNC_V1 — публикация в облачный medcore убрана (V3120_FIX):
            // офлайн шлюза нет, и каждое «Сохранить профиль» заканчивалось 404.
            // RPC_PORT_V1 — не говорим «сохранён» о том, что офлайн не хранится.
            // DOCTOR_PUBLIC_PROFILE_V1 — после миграции 159 not_stored пуст,
            // и это предупреждение остаётся только для базы до обновления.
            // CLINIC_API_FIX_V1 — один тост на экран: «Профиль сохранён» закрыл бы
            // ошибку фото, и врач решил бы, что фото тоже сохранено. Фото ждёт
            // в st.photoFile — повторное «Сохранить профиль» дошлёт его.
            if (photoFailed) toast('Профиль сохранён, но фото не загрузилось — нажмите «Сохранить профиль» ещё раз.', 'fail');
            else if (notStored.length) toast('Профиль сохранён. Биография, образование, соцсети и фото в офлайн-версии не хранятся.', 'info');
            else toast('Профиль сохранён', 'info');
        } catch (e) {
            // CLINIC_API_FIX_V1 — причина отказа (например, «Профиль врача
            // меняется в главном здании.») — тоже на языке экрана.
            toast(trf('Не удалось сохранить: {msg}', { msg: tr(String((e && e.message) || e)) }), 'fail');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '';
            saveBtn.append(Icon('Check', { size: 14 }), ' Сохранить профиль');
        }
    };

    // CLINIC_API_FIX_V1 — профиль (без фото: фото уходит, только когда выбрано
    // новое), специальности и болезни в том виде, в каком их шлёт RPC.
    function collectAll() {
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
        // DOCTOR_PROFILE_V1 — год «работает с» (стаж сервер пишет сам) и языки приёма.
        const yrs = scalarInputs.practice_since.value.trim();
        p.practice_since = yrs === '' ? null : Number(yrs);
        p.languages = [...(st.languages || [])];
        p.instagram_url = (contactInputs.instagram_url.value || '').trim();
        p.telegram_url = (contactInputs.telegram_url.value || '').trim();
        const specialties = st.specSlugs.filter(Boolean).slice(0, 4);
        const conditions = [...st.selectedConds.values()].map((x) => ({
            kind: x.kind, slug: x.slug, name_ru: x.name_ru || null, name_uz: x.name_uz || null,
        }));
        return { p, specialties, conditions };
    }

    // CLINIC_API_FIX_V1 — то же, что disableAll карточки сотрудника
    // (views/employees.js): каждое поле и каждая кнопка под узлом выключены.
    function disableAll(node) {
        for (const child of node.children || []) {
            const tag = String(child.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') child.disabled = true;
            disableAll(child);
        }
    }

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
            // DOCTOR_PUBLIC_PROFILE_V1, ревью M4 — «Фото по ссылке» убрано: фото
            // врача хранится только в своём хранилище (сервер внешнюю ссылку
            // не примет) — оно уходит партнёрам, и клиника за него отвечает.
        );
        if (st.photoUrl) setPhoto(st.photoUrl);   // show current photo on open
        return h('div', { class: 'cam-wrap' }, box, fileInp, acts);
    }

    // Upload pending photo to Storage (NEVER base64). Returns external URL,
    // a Storage public URL, or '' (leave photo unchanged on failure).
    // CLINIC_API_FIX_V1 — КАЖДАЯ неудача говорит о себе тостом: сборка файла
    // теперь внутри try, а пустой адрес из хранилища — тоже неудача. Прежде
    // оба случая возвращали '' молча, и «Сохранить профиль» без других правок
    // не делало ничего и ничего не говорило.
    async function uploadPendingPhoto() {
        if (st.photoUrl && st.photoUrl !== st.user.photo_url) return st.photoUrl;  // "по ссылке"
        if (!st.photoFile) return '';                                              // nothing new chosen
        try {
            const file = st.photoFile instanceof File
                ? st.photoFile
                : new File([st.photoFile], 'photo.jpg', { type: st.photoFile.type || 'image/jpeg' });
            const { path } = await uploadFile(PHOTO_BUCKET, file, photoPrefix(doctorId));
            const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
            const url = (data && data.publicUrl) || '';
            if (!url) toast('Не удалось загрузить фото', 'fail');
            return url;
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
        // CLINIC_API_FIX_V1 — список не загрузился: ни чипов, ни выбора, только
        // объяснение. Пустой список здесь значил бы «специальностей нет», и
        // добавленная заменила бы на сервере весь набор врача.
        if (st.specLoadFailed) {
            return h('div', { class: 'docprof-hint' }, 'Специальности не загрузились — обновите страницу, чтобы их изменить.');
        }
        // DOCTOR_PROFILE_V1 (ревью шага 5, №10) — название на языке экрана из справочника
        // (specialtyLabel), как в карточке сотрудника; текстом — без второго перевода.
        const nameOf = (s) => document.createTextNode(specialtyLabel((s && s.slug) || ''));
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
                // REFERENCE_LISTS_V1 — по показанной (переведённой) подписи на языке
                // интерфейса: в uz/en русский порядок выглядел вразнобой.
                const avail = sortByShownLabel(st.specCatalog.filter((s) => !st.specSlugs.includes(s.slug)),
                    (s) => specialtyLabel(s.slug), getLang());
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
        // CLINIC_API_FIX_V1 (ревью итога) — список не загрузился: ни поиска, ни
        // отметок, только объяснение (как у специальностей, specialtyCard).
        if (st.condLoadFailed) {
            return h('div', { class: 'docprof-hint' }, 'Болезни и симптомы не загрузились — обновите страницу, чтобы их изменить.');
        }
        const wrap = h('div');
        const condStatus = h('div', { class: 'docprof-status', style: { marginBottom: '8px' } }, '');
        const searchI = h('input', { class: 'docprof-cond-search', placeholder: 'Поиск болезней / симптомов…' });
        const listWrap = h('div', { class: 'docprof-cond-list' });
        wrap.appendChild(condStatus);
        wrap.appendChild(searchI);
        wrap.appendChild(listWrap);

        if (!st.catalog.length) {
            // V3120_FIX — не «не удалось загрузить»: грузить неоткуда, каталог
            // болезней живёт в облачной версии. Уже отмеченные сохраняются как были.
            condStatus.textContent = tr('Каталог болезней в офлайн-версии не подключён — уже отмеченные сохраняются как были.');
            searchI.hidden = true;
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
