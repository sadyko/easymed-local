// DOCTOR_PROFILE_V1 — «ПУБЛИЧНЫЙ ПРОФИЛЬ» КАРТОЧКИ СОТРУДНИКА (шаг 5 API
// клиники; макет screen-doctor.js publicPane): как врача видят пациенты на
// сайте клиники, в Symptex и у партнёров.
//
// Раздел рисует и сообщает правки; состояние держит карточка (views/employees.js):
//   • ctx.profile — emp.public_profile; ctx.setProfile(k, v) — правка поля
//     профиля (в PATCH уходят только изменённые — CLINIC_API_FIX_V1);
//   • ctx.emp — is_public, scheduling_mode, booking_days, show_queue_count,
//     branch_id; ctx.setField(patch) — их правка;
//   • ctx.specialtiesNode() — тот же список специальностей, что во «Должности»;
//   • ctx.errors — отказы сохранения по полям (publicPaneProblems), живут
//     между перерисовками раздела.
//   • ctx.loadPreview() — ответ doctor_public_preview (null — сотрудник не сохранён, false — сервер не ответил).
// Показ меняет только администратор (ctx.isAdmin; сервер — 403, routes/users.js).
// Данные врача и клиники — текстом (createTextNode), не через tr().
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
import { triGroup, fieldErr } from './company-fields.js';
import { photoRefusal, ALLOWED_PHOTO_EXT } from '../../shared/patient-file-limits.js?v=pph1';
import { downscalePhoto } from '../../shared/photo-downscale.js?v=pph1';
import { DOCTOR_LANGS, PRACTICE_SINCE_MIN, DOCTOR_PUBLIC_MESSAGES, profileCompleteness,
    experienceYears, readLanguages, shownPracticeSince, cleanPracticeSince, BOOKING_DAYS, DEFAULT_BOOKING_DAYS } from '../../shared/doctor-public.js';
import { renderPartnerPreview, renderConsultPrices, renderConsultServices } from './doctor-public-preview.js';   // DOCTOR_PROFILE_V1 — приём, превью, цены
import { branchAllowsDoctor } from '../../shared/branch-profile.js';

const LANG_TAG = Object.freeze({ ru: 'RU', uz: 'UZ', en: 'EN' });
const PHOTO_BUCKET = 'doctor-photos';
const DAY_LABEL = Object.freeze({ 7: '7 дней вперёд', 14: '14 дней вперёд', 30: '30 дней вперёд' });
let seq = 0;

/** Тексты экрана — ключи словаря. */
export const PANE_MESSAGES = Object.freeze({
    needName:    'Сначала заполните ФИО',
    incomplete:  'Врач будет виден. Пустые переводы партнёры покажут на русском.',
    nameRu:      'Введите ФИО на русском.',
    oneLanguage: 'Нужен хотя бы один язык',
});

/**
 * Что держит сохранение карточки (макет: «Введите ФИО на русском.»,
 * «Чтобы показывать врача, выберите специальность.»):
 *   • ФИО на русском — у показываемого врача; у остальных — только если его
 *     правили и оставили пустым (EMPLOYEE_CARD_SAVE_V1: нетронутое не держит
 *     сохранение оклада);
 *   • специальность — у показываемого врача;
 *   • «работает врачом с» — если правили.
 * Возвращает { поле: сообщение }.
 */
export function publicPaneProblems({ isPublic, profile, profileAtOpen, touched = [], specialtiesCount = 0 }) {
    const p = {};
    const t = new Set(touched);
    const ru = String((profile && profile.full_name_ru) || '').trim();
    const wasRu = String((profileAtOpen && profileAtOpen.full_name_ru) || '').trim();
    if (!ru && (isPublic || (t.has('full_name_ru') && wasRu))) p.full_name_ru = PANE_MESSAGES.nameRu;
    if (isPublic && !(specialtiesCount > 0)) p.specialties = DOCTOR_PUBLIC_MESSAGES.specialty;
    if (t.has('practice_since')) {
        const c = cleanPracticeSince(profile && profile.practice_since);
        if (c.problem) p.practice_since = c.problem;
    }
    return p;
}

function section(title, sub, ...body) {
    return h('section', { class: 'dpp-sec' }, h('h4', null, title), sub ? h('p', { class: 'cpf-hint' }, sub) : null, ...body);
}
function errLine(msg) {
    const e = fieldErr(null);
    if (msg) e.set(msg);
    return e.node;
}

export function doctorPublicPane(ctx) {
    const { emp, profile: pp, isEdit, readOnly, isAdmin, doctorId, errors = {} } = ctx;
    const root = h('div', { class: 'dpp' });

    // ---- показ на сайте и у партнёров (только администратор) ----
    const sw = h('button', { type: 'button', class: 'dpp-switch', role: 'switch', 'aria-label': 'Показывать врача' });
    sw.disabled = !!readOnly || !isAdmin;
    const swSub = h('span', { class: 'cpf-hint' });
    const paintSwitch = () => {
        sw.setAttribute('aria-checked', emp.is_public ? 'true' : 'false');
        const c = profileCompleteness(pp, ctx.specialtiesCount());
        const lead = emp.is_public ? tr('Врач виден пациентам.') : tr('Врач скрыт: партнёры не видят ни профиль, ни свободное время.');
        const fill = c.missing.length
            ? trf('Профиль заполнен на {pct}%: не хватает — {list}.', { pct: c.pct, list: c.missing.map((m) => tr(m)).join(', ') })
            : trf('Профиль заполнен на {pct}%.', { pct: c.pct });
        swSub.textContent = lead + ' ' + fill;
    };
    sw.addEventListener('click', () => {
        if (sw.disabled) return;
        if (!emp.is_public && !String(pp.full_name_ru || '').trim()) { toast(PANE_MESSAGES.needName, 'fail'); return; }
        const on = !emp.is_public;
        ctx.setField({ is_public: on });
        paintSwitch();
        if (on && profileCompleteness(pp, ctx.specialtiesCount()).missing.length) toast(PANE_MESSAGES.incomplete, 'info');
    });
    root.appendChild(h('div', { class: 'dpp-switch-row' }, sw,
        h('div', { class: 'dpp-switch-text' }, h('b', null, 'Показывать врача на сайте и у партнёров'), swSub)));
    if (!readOnly && !isAdmin) root.appendChild(h('p', { class: 'cpf-hint' }, DOCTOR_PUBLIC_MESSAGES.adminOnly));
    if (!branchAllowsDoctor({ branch_id: emp.branch_id }, ctx.branchesById)) {
        root.appendChild(h('p', { class: 'cpf-note dpp-note-warn', role: 'note' }, Icon('Building', { size: 16 }),
            h('span', null, 'Филиал врача скрыт с сайта — врача партнёры не увидят, пока филиал скрыт.')));
    }
    paintSwitch();

    // ---- фото для партнёров ----
    const photo = h('div', { class: 'dpp-photo' });
    const paintPhoto = () => {
        clear(photo);
        if (pp.photo_url) photo.appendChild(h('img', { src: pp.photo_url, alt: '' }));
        else photo.appendChild(document.createTextNode(ctx.initials || ''));
    };
    paintPhoto();
    const fileInp = h('input', { type: 'file', accept: ALLOWED_PHOTO_EXT.join(','), 'aria-label': 'Загрузить фото' });
    fileInp.hidden = true;
    const photoBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, Icon('Image', { size: 14 }), ' ', 'Загрузить фото');
    photoBtn.disabled = !!readOnly || !isEdit;
    const photoStatus = h('span', { class: 'cpf-hint', role: 'status' });
    photoBtn.addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', async (e) => {
        const f = e && e.target && e.target.files && e.target.files[0];
        if (!f || !doctorId) return;
        const small = await downscalePhoto(f);
        const bad = photoRefusal({ name: small.name || f.name, size: small.size });
        if (bad) { toast(trf(bad.template, bad.params), 'fail'); return; }
        photoBtn.disabled = true;
        photoStatus.textContent = tr('Загрузка…');
        try {
            const file = small instanceof File ? small : new File([small], 'photo.jpg', { type: small.type || 'image/jpeg' });
            // Путь — папка ЭТОГО врача (CLINIC_API_FIX_V1: сервер примет фото только оттуда).
            const { path } = await uploadFile(PHOTO_BUCKET, file, 'doctors/' + doctorId + '/');
            const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
            const url = (data && data.publicUrl) || '';
            if (!url) throw new Error(tr('Не удалось загрузить фото'));
            ctx.setProfile('photo_url', url);
            paintPhoto();
            photoStatus.textContent = tr('Фото загружено — сохраните сотрудника.');
        } catch (err) {
            photoStatus.textContent = '';
            toast(trf('Не удалось загрузить фото: {msg}', { msg: tr(String((err && err.message) || err)) }), 'fail');
        } finally {
            photoBtn.disabled = !!readOnly;
        }
    });
    root.appendChild(h('div', { class: 'dpp-photo-row' }, photo,
        h('div', { class: 'dpp-photo-acts' }, h('div', { class: 'dpp-row' }, photoBtn, fileInp),
            h('p', { class: 'cpf-hint' }, isEdit ? 'Портрет на светлом фоне, лицо по центру. JPG или PNG от 600×600 px.' : 'Фото можно загрузить после сохранения сотрудника.'),
            photoStatus)));

    // ---- ФИО, специальности, учёная степень ----
    const fio = triGroup('ФИО', { ru: pp.full_name_ru, uz: pp.full_name_uz, en: pp.full_name_en }, {
        key: 'dpp-fio', markMissing: true, disabled: !!readOnly, max: 200,
        hint: 'Имя на сайте и у партнёров. В документах печатается ФИО из «Личных данных».',
        onInput: (lng, v) => { ctx.setProfile('full_name_' + lng, v); paintSwitch(); },
    });
    if (errors.full_name_ru) fio.inputs.ru.err.set(errors.full_name_ru);
    root.appendChild(fio.node);
    root.appendChild(h('div', { class: 'dpp-block' }, h('p', { class: 'dpp-h5' }, 'Специальности'), ctx.specialtiesNode(),
        errLine(errors.specialties),
        h('p', { class: 'cpf-hint' }, 'Выбор из общего справочника (120 специальностей, встроен в программу). Партнёры получают код специальности и ищут врача по нему: «pediatr» — это «Педиатр», «Pediatr» и «Pediatrician» сразу.')));
    root.appendChild(triGroup('Учёная степень', { ru: pp.academic_title_ru, uz: pp.academic_title_uz, en: pp.academic_title_en }, {
        key: 'dpp-deg', disabled: !!readOnly, max: 200, onInput: (lng, v) => ctx.setProfile('academic_title_' + lng, v),
    }).node);

    // ---- «работает врачом с» и языки приёма ----
    const thisYear = new Date().getFullYear();
    const since = h('input', { type: 'number', min: String(PRACTICE_SINCE_MIN), max: String(thisYear), step: '1', placeholder: '2015', class: 'docprof-in', id: 'dpp-since-' + (++seq) });
    const shown = shownPracticeSince(pp);
    since.value = shown == null ? '' : String(shown);
    since.disabled = !!readOnly;
    const sinceHint = h('p', { class: 'cpf-hint' });
    const paintSince = () => {
        const y = since.value === '' ? null : experienceYears(Number(since.value));
        sinceHint.textContent = y == null ? '' : trf('Стаж на сайте, лет: {n}.', { n: y });
    };
    since.addEventListener('input', () => { ctx.setProfile('practice_since', since.value === '' ? null : Number(since.value)); paintSince(); });
    paintSince();
    const sinceErr = fieldErr(since);
    if (errors.practice_since) sinceErr.set(errors.practice_since);
    const langBox = h('div', { class: 'dpp-langs', role: 'group', 'aria-label': 'Языки приёма' });
    for (const l of DOCTOR_LANGS) {
        const b = h('button', { type: 'button', class: 'dpp-lang', 'aria-pressed': readLanguages(pp.languages).includes(l) ? 'true' : 'false' }, LANG_TAG[l]);
        b.disabled = !!readOnly;
        b.addEventListener('click', () => {
            const cur = readLanguages(pp.languages);
            const on = cur.includes(l);
            if (on && cur.length === 1) { toast(PANE_MESSAGES.oneLanguage, 'fail'); return; }
            ctx.setProfile('languages', DOCTOR_LANGS.filter((x) => (x === l ? !on : cur.includes(x))));
            b.setAttribute('aria-pressed', on ? 'false' : 'true');
        });
        langBox.appendChild(b);
    }
    root.appendChild(h('div', { class: 'dpp-grid2' },
        h('div', { class: 'field' }, h('label', { for: since.getAttribute('id') }, 'Работает врачом с'), since, sinceHint, sinceErr.node),
        h('div', { class: 'field' }, h('span', { class: 'dpp-label' }, 'Языки приёма'), langBox, h('p', { class: 'cpf-hint' }, 'На каких языках врач говорит с пациентом.'))));

    // ---- биография ----
    root.appendChild(triGroup('Биография', { ru: pp.bio_ru, uz: pp.bio_uz, en: pp.bio_en }, {
        key: 'dpp-bio', textarea: true, markMissing: true, disabled: !!readOnly, max: 5000,
        onInput: (lng, v) => { ctx.setProfile('bio_' + lng, v); paintSwitch(); },
    }).node);

    // ---- приём пациентов и что увидят партнёры ----
    const MODES = [['schedulable', 'Calendar', 'По записи', 'Пациент выбирает свободное время. Окна по 15 минут.'],
        ['live_queue', 'Patients', 'Живая очередь', 'Пациент приходит в часы приёма, порядок — по приходу.']];
    const modeBtns = {};
    const modeBox = h('div', { class: 'dpp-modes', role: 'radiogroup', 'aria-label': 'Как принимает' });
    const receptionBody = h('div', { class: 'dpp-reception' });
    const previewBox = h('div', { class: 'dpp-preview', 'aria-live': 'polite' });
    let preview;   // ответ doctor_public_preview: undefined — грузится; null — не сохранён; false — сервер не ответил
    const queueMode = () => emp.scheduling_mode === 'live_queue';
    const paintPreview = () => renderPartnerPreview(previewBox, preview, { mode: queueMode() ? 'live_queue' : 'schedulable', showQueue: !!emp.show_queue_count });
    function paintReception() {
        for (const [k, b] of Object.entries(modeBtns)) b.setAttribute('aria-checked', (k === 'live_queue') === queueMode() ? 'true' : 'false');
        clear(receptionBody);
        if (!queueMode()) {
            const cur = BOOKING_DAYS.includes(Number(emp.booking_days)) ? Number(emp.booking_days) : DEFAULT_BOOKING_DAYS;
            const days = h('select', { class: 'docprof-in', id: 'dpp-days-' + (++seq) },
                ...BOOKING_DAYS.map((n) => h('option', { value: String(n), selected: cur === n }, DAY_LABEL[n])));
            days.value = String(cur);
            days.disabled = !!readOnly;
            days.addEventListener('change', () => ctx.setField({ booking_days: Number(days.value) }));
            receptionBody.appendChild(h('div', { class: 'dpp-grid2' },
                h('div', { class: 'field' }, h('span', { class: 'dpp-label' }, 'Длина окна'),
                    h('span', { class: 'dpp-fixed' }, Icon('Clock', { size: 14 }), ' ', '15 минут'), h('p', { class: 'cpf-hint' }, 'Одинаково для всех врачей.')),
                h('div', { class: 'field' }, h('label', { for: days.getAttribute('id') }, 'Запись открыта на'), days,
                    h('p', { class: 'cpf-hint' }, 'Дальше этого срока партнёры время не видят.'))));
        } else {
            const chk = h('input', { type: 'checkbox', id: 'dpp-qc-' + (++seq) });
            chk.checked = !!emp.show_queue_count;
            chk.disabled = !!readOnly;
            chk.addEventListener('change', () => { ctx.setField({ show_queue_count: chk.checked }); paintPreview(); });
            receptionBody.appendChild(h('label', { class: 'dpp-check', for: chk.getAttribute('id') }, chk,
                h('b', null, 'Показывать, сколько человек сейчас в очереди'), h('span', null, 'Число пациентов, которые пришли к врачу и ждут приёма.')));
        }
        paintPreview();
    }
    for (const [k, icon, title, sub] of MODES) {
        const b = h('button', { type: 'button', class: 'dpp-mode', role: 'radio' }, Icon(icon, { size: 18 }), h('span', null, h('b', null, title), h('span', null, sub)));
        b.disabled = !!readOnly;
        b.addEventListener('click', () => { ctx.setField({ scheduling_mode: k }); paintReception(); });
        modeBtns[k] = b;
        modeBox.appendChild(b);
    }
    root.appendChild(section('Приём пациентов', 'Та же настройка, что «Приём услуг» в «Должности»: «по записи» или «живая очередь».',
        modeBox, receptionBody,
        h('div', null, h('p', { class: 'dpp-h5' }, 'Что увидят партнёры'), previewBox),
        h('p', { class: 'cpf-hint' }, 'Часы приёма берутся из «Рабочего времени» врача и часов работы филиала. Показано по сохранённому графику.')));

    // ---- цены консультаций (решение 8) и консультации из прайса (решение 12) ----
    const pricesBox = h('div');
    const servicesBox = h('div');
    root.appendChild(section('Цены консультаций', 'Из раздела «Консультации врачей».', pricesBox,
        h('div', { class: 'dpp-row' },
            ctx.openConsultations ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', dataset: { viewOk: '1' }, onclick: () => ctx.openConsultations() },   // DOCTOR_PROFILE_V1 — переход, не правка: работает и в карточке «только просмотр» (ревью №7)
                Icon('Edit', { size: 14 }), ' ', 'Изменить в «Консультации врачей»') : null,
            h('span', { class: 'cpf-hint' }, 'Партнёры получают эти цены вместе с профилем врача. Пустая цена и «Бесплатно» — 0: чтобы брать деньги, впишите цену в «Консультациях врачей».'))));
    root.appendChild(section('Консультации из прайса', 'Услуги группы «Консультации», которые оказывает врач: кто оказывает услугу — в окне услуги и во вкладке «Услуги и ставки». Партнёры увидят их в профиле врача, если у услуги включена онлайн-запись.', servicesBox));

    // ---- соцсети и опыт (как было: списки правит врач в «Моём профиле») ----
    const ptxt = (k, ph) => {
        const i = h('input', { type: 'text', class: 'docprof-in', placeholder: ph });
        i.value = pp[k] || '';
        i.disabled = !!readOnly;
        i.addEventListener('input', () => ctx.setProfile(k, i.value));
        return i;
    };
    const LISTS = [['education_entries', 'Образование'], ['experience_entries', 'Опыт работы'],
        ['certifications_entries', 'Сертификаты'], ['prof_dev_entries', 'Повышения квалификаций']];
    const entryLine = (e) => [e && (e.ru || e.title || ''), e && (e.year || [e.year_from, e.year_to].filter(Boolean).join('–'))].filter(Boolean).join(' · ');
    root.appendChild(section('Соцсети, образование и опыт', '',
        h('div', { class: 'dpp-grid2' }, field('Instagram', ptxt('instagram_url', 'https://instagram.com/…')), field('Telegram', ptxt('telegram_url', 'https://t.me/…'))),
        ...LISTS.map(([k, label]) => {
            const list = Array.isArray(pp[k]) ? pp[k] : [];
            return field(label, list.length
                ? h('div', { class: 'dpp-entries' }, ...list.map((e) => h('div', null, document.createTextNode(entryLine(e) || '—'))))
                : h('div', { class: 'cpf-hint' }, 'Пока пусто — врач заполняет в «Моём профиле».'));
        })));

    // DOCTOR_PROFILE_V1 — приём и превью: сначала «Загрузка…», потом ответ doctor_public_preview.
    paintReception();
    renderConsultPrices(pricesBox, undefined);
    renderConsultServices(servicesBox, undefined);
    if (typeof ctx.loadPreview === 'function') {
        Promise.resolve(ctx.loadPreview()).then((data) => {
            preview = data && typeof data === 'object' && !Array.isArray(data) ? data : (data === false ? false : null);
            paintPreview();
            renderConsultPrices(pricesBox, preview ? preview.consultations : preview);
            renderConsultServices(servicesBox, preview ? preview.services : preview);
        });
    }
    if (typeof ctx.onRepaint === 'function') ctx.onRepaint(paintSwitch);
    return root;
}
