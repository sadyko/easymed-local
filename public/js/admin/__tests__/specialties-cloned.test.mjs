// SPECIALTIES_CLONED_V1 — the doctor specialty list is medcore's 51, cloned into the app,
// plus two the owner asked for on 2026-10-02 (JOURNALS_V1_SPECIALTIES): 53;
// plus 67 more on the owner's word of 2026-10-06 (REFERENCE_LISTS_V1): 120.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
globalThis.document = { documentElement: { lang: 'ru', setAttribute() {} }, addEventListener() {} };
const { SPECIALTIES, SPECIALTY_ROWS, specialtyOptions, canonicalSpecialty } = await import('../specialties.js');

// REFERENCE_LISTS_V1 — таблица плана «API клиники, шаги 1–2», Task 12 (в ней 67 строк,
// хотя план называет 68 и 121 — счёт здесь по самой таблице: 53 + 67 = 120).
const NEW_ROWS = [
    { slug: 'angiolog', ru: 'Ангиолог', uz: 'Angiolog', en: 'Angiologist' },
    { slug: 'audiolog-surdolog', ru: 'Аудиолог-сурдолог', uz: 'Audiolog-surdolog', en: 'Audiologist' },
    { slug: 'bariatricheskiy-hirurg', ru: 'Бариатрический хирург', uz: 'Bariatrik jarroh', en: 'Bariatric Surgeon' },
    { slug: 'vertebrolog', ru: 'Вертебролог', uz: 'Vertebrolog', en: 'Vertebrologist' },
    { slug: 'virusolog', ru: 'Вирусолог', uz: 'Virusolog', en: 'Virologist' },
    { slug: 'kt-mrt', ru: 'Врач КТ и МРТ', uz: 'KT va MRT shifokori', en: 'CT and MRI Radiologist' },
    { slug: 'vrach-lfk', ru: 'Врач ЛФК', uz: 'DJT shifokori', en: 'Exercise Therapy Physician' },
    { slug: 'vrach-laborant', ru: 'Врач-лаборант', uz: 'Laboratoriya shifokori', en: 'Clinical Laboratory Physician' },
    { slug: 'gepatolog', ru: 'Гепатолог', uz: 'Gepatolog', en: 'Hepatologist' },
    { slug: 'geriatr', ru: 'Гериатр', uz: 'Geriatr', en: 'Geriatrician' },
    { slug: 'ginekolog-endokrinolog', ru: 'Гинеколог-эндокринолог', uz: 'Ginekolog-endokrinolog', en: 'Gynecologic Endocrinologist' },
    { slug: 'defektolog', ru: 'Дефектолог', uz: 'Defektolog', en: 'Defectologist' },
    { slug: 'detskiy-allergolog', ru: 'Детский аллерголог', uz: 'Bolalar allergologi', en: 'Pediatric Allergist' },
    { slug: 'detskiy-gastroenterolog', ru: 'Детский гастроэнтеролог', uz: 'Bolalar gastroenterologi', en: 'Pediatric Gastroenterologist' },
    { slug: 'detskiy-gematolog', ru: 'Детский гематолог', uz: 'Bolalar gematologi', en: 'Pediatric Hematologist' },
    { slug: 'detskiy-ginekolog', ru: 'Детский гинеколог', uz: 'Bolalar ginekologi', en: 'Pediatric Gynecologist' },
    { slug: 'detskiy-dermatolog', ru: 'Детский дерматолог', uz: 'Bolalar dermatologi', en: 'Pediatric Dermatologist' },
    { slug: 'detskiy-infeksionist', ru: 'Детский инфекционист', uz: 'Bolalar infeksionisti', en: 'Pediatric Infectious Disease Specialist' },
    { slug: 'detskiy-kardiolog', ru: 'Детский кардиолог', uz: 'Bolalar kardiologi', en: 'Pediatric Cardiologist' },
    { slug: 'detskiy-lor', ru: 'Детский ЛОР', uz: 'Bolalar LOR shifokori', en: 'Pediatric ENT' },
    { slug: 'detskiy-nefrolog', ru: 'Детский нефролог', uz: 'Bolalar nefrologi', en: 'Pediatric Nephrologist' },
    { slug: 'detskiy-onkolog', ru: 'Детский онколог', uz: 'Bolalar onkologi', en: 'Pediatric Oncologist' },
    { slug: 'detskiy-oftalmolog', ru: 'Детский офтальмолог', uz: 'Bolalar oftalmologi', en: 'Pediatric Ophthalmologist' },
    { slug: 'detskiy-psihiatr', ru: 'Детский психиатр', uz: 'Bolalar psixiatri', en: 'Child Psychiatrist' },
    { slug: 'detskiy-psiholog', ru: 'Детский психолог', uz: 'Bolalar psixologi', en: 'Child Psychologist' },
    { slug: 'detskiy-pulmonolog', ru: 'Детский пульмонолог', uz: 'Bolalar pulmonologi', en: 'Pediatric Pulmonologist' },
    { slug: 'detskiy-revmatolog', ru: 'Детский ревматолог', uz: 'Bolalar revmatologi', en: 'Pediatric Rheumatologist' },
    { slug: 'detskiy-travmatolog-ortoped', ru: 'Детский травматолог-ортопед', uz: 'Bolalar travmatolog-ortopedi', en: 'Pediatric Orthopedist' },
    { slug: 'detskiy-urolog-androlog', ru: 'Детский уролог-андролог', uz: 'Bolalar urolog-andrologi', en: 'Pediatric Urologist-Andrologist' },
    { slug: 'detskiy-endokrinolog', ru: 'Детский эндокринолог', uz: 'Bolalar endokrinologi', en: 'Pediatric Endocrinologist' },
    { slug: 'implantolog', ru: 'Имплантолог', uz: 'Implantolog', en: 'Dental Implantologist' },
    { slug: 'kardiolog-aritmolog', ru: 'Кардиолог-аритмолог', uz: 'Kardiolog-aritmolog', en: 'Cardiac Electrophysiologist' },
    { slug: 'kinezioterapevt', ru: 'Кинезиотерапевт', uz: 'Kinezioterapevt', en: 'Kinesiotherapist' },
    { slug: 'kosmetolog', ru: 'Косметолог', uz: 'Kosmetolog', en: 'Cosmetologist' },
    { slug: 'manualnyy-terapevt', ru: 'Мануальный терапевт', uz: 'Manual terapevt', en: 'Manual Therapist' },
    { slug: 'massazhist', ru: 'Массажист', uz: 'Massajchi', en: 'Massage Therapist' },
    { slug: 'medicinskiy-psiholog', ru: 'Медицинский психолог', uz: 'Tibbiy psixolog', en: 'Clinical Psychologist' },
    { slug: 'mikrobiolog', ru: 'Микробиолог', uz: 'Mikrobiolog', en: 'Microbiologist' },
    { slug: 'neonatolog', ru: 'Неонатолог', uz: 'Neonatolog', en: 'Neonatologist' },
    { slug: 'nutriciolog', ru: 'Нутрициолог', uz: 'Nutritsiolog', en: 'Nutritionist' },
    { slug: 'onkoginekolog', ru: 'Онкогинеколог', uz: 'Onkoginekolog', en: 'Gynecologic Oncologist' },
    { slug: 'onkolog-mammolog', ru: 'Онколог-маммолог', uz: 'Onkolog-mammolog', en: 'Breast Oncologist' },
    { slug: 'osteopat', ru: 'Остеопат', uz: 'Osteopat', en: 'Osteopath' },
    { slug: 'oftalmohirurg', ru: 'Офтальмохирург', uz: 'Oftalmojarroh', en: 'Ophthalmic Surgeon' },
    { slug: 'parazitolog', ru: 'Паразитолог', uz: 'Parazitolog', en: 'Parasitologist' },
    { slug: 'parodontolog', ru: 'Пародонтолог', uz: 'Parodontolog', en: 'Periodontist' },
    { slug: 'profpatolog', ru: 'Профпатолог', uz: 'Kasb kasalliklari shifokori', en: 'Occupational Medicine Physician' },
    { slug: 'radioterapevt', ru: 'Радиотерапевт', uz: 'Radioterapevt', en: 'Radiation Oncologist' },
    { slug: 'seksolog', ru: 'Сексолог', uz: 'Seksolog', en: 'Sexologist' },
    { slug: 'somnolog', ru: 'Сомнолог', uz: 'Somnolog', en: 'Sleep Medicine Specialist' },
    { slug: 'sportivnyy-vrach', ru: 'Спортивный врач', uz: 'Sport shifokori', en: 'Sports Medicine Physician' },
    { slug: 'stomatolog-gigienist', ru: 'Стоматолог-гигиенист', uz: 'Stomatolog-gigiyenist', en: 'Dental Hygienist' },
    { slug: 'stomatolog-ortoped', ru: 'Стоматолог-ортопед', uz: 'Stomatolog-ortoped', en: 'Prosthodontist' },
    { slug: 'stomatolog-terapevt', ru: 'Стоматолог-терапевт', uz: 'Stomatolog-terapevt', en: 'Restorative Dentist' },
    { slug: 'toksikolog', ru: 'Токсиколог', uz: 'Toksikolog', en: 'Toxicologist' },
    { slug: 'torakalnyy-hirurg', ru: 'Торакальный хирург', uz: 'Torakal jarroh', en: 'Thoracic Surgeon' },
    { slug: 'transfuziolog', ru: 'Трансфузиолог', uz: 'Transfuziolog', en: 'Transfusiologist' },
    { slug: 'triholog', ru: 'Трихолог', uz: 'Trixolog', en: 'Trichologist' },
    { slug: 'foniatr', ru: 'Фониатр', uz: 'Foniatr', en: 'Phoniatrist' },
    { slug: 'ftiziatr', ru: 'Фтизиатр', uz: 'Ftiziatr', en: 'Phthisiatrician (TB Specialist)' },
    { slug: 'himioterapevt', ru: 'Химиотерапевт', uz: 'Ximioterapevt', en: 'Medical Oncologist (Chemotherapy)' },
    { slug: 'hirurg-onkolog', ru: 'Хирург-онколог', uz: 'Jarroh-onkolog', en: 'Surgical Oncologist' },
    { slug: 'chelyustno-licevoy-hirurg', ru: 'Челюстно-лицевой хирург', uz: 'Yuz-jag‘ jarrohi', en: 'Maxillofacial Surgeon' },
    { slug: 'embriolog', ru: 'Эмбриолог', uz: 'Embriolog', en: 'Embryologist' },
    { slug: 'endodontist', ru: 'Эндодонтист', uz: 'Endodontist', en: 'Endodontist' },
    { slug: 'endoskopist', ru: 'Эндоскопист', uz: 'Endoskopist', en: 'Endoscopist' },
    { slug: 'epileptolog', ru: 'Эпилептолог', uz: 'Epileptolog', en: 'Epileptologist' },
];
// Прежние 53 — в их прежнем порядке (Подолог последним, вне алфавита — так было).
const OLD_ORDER = ('akusher-ginekolog allergolog-immunolog androlog anesteziolog-reanimatolog uzi funkcionalnaya-diagnostika '
    + 'gastroenterolog gematolog genetik ginekolog dermatovenerolog dermatolog detskiy-nevrolog detskiy-stomatolog detskiy-hirurg '
    + 'dietolog igloterapevt infeksionist kardiolog kardiohirurg logoped mammolog narkolog nevrolog neyrofiziolog neyrohirurg '
    + 'nefrolog onkolog ortodont lor oftalmolog pediatr plasticheskiy-hirurg proktolog psihiatr psihoterapevt pulmonolog '
    + 'reabilitolog revmatolog rentgenolog reproduktolog semeynyy-vrach sosudistyy-hirurg stomatolog stomatolog-hirurg terapevt '
    + 'travmatolog-ortoped urolog fizioterapevt flebolog hirurg endokrinolog podolog').split(' ');

test('120 специальностей, Подолог среди них, у каждой — slug, uz и en; slug уникален', () => {
    assert.equal(SPECIALTY_ROWS.length, 120);   // REFERENCE_LISTS_V1 — 53 + 67 (было 53: 51 + Иглотерапевт + Нейрофизиолог)
    assert.ok(SPECIALTIES.includes('Подолог'), 'Подолог добавлен (владелец)');
    assert.ok(SPECIALTIES.includes('Отоларинголог (ЛОР)') && SPECIALTIES.includes('Семейный врач (ВОП)'));
    for (const r of SPECIALTY_ROWS) assert.ok(r.slug && r.ru && r.uz && r.en, 'неполная строка: ' + JSON.stringify(r));
    assert.equal(new Set(SPECIALTY_ROWS.map((r) => r.slug)).size, 120);   // REFERENCE_LISTS_V1
    assert.equal(new Set(SPECIALTY_ROWS.map((r) => r.ru.toLowerCase())).size, 120, 'русское название не повторяется (и в другом регистре)');   // REFERENCE_LISTS_V1
    for (const r of SPECIALTY_ROWS) assert.match(r.slug, /^[a-z0-9-]+$/, 'slug не ASCII: ' + r.slug);   // JOURNALS_V1_SPECIALTIES
    const dict = fs.readFileSync(path.join(HERE, '..', 'i18n-strings.js'), 'utf8');
    for (const r of SPECIALTY_ROWS) assert.ok(dict.includes('\n  "' + r.ru + '": {'), 'нет перевода для ' + r.ru);
});

test('старые написания приводятся к medcore-названию; незнакомое — остаётся с пометкой «не из списка»', () => {
    assert.equal(canonicalSpecialty('Оториноларинголог (ЛОР)'), 'Отоларинголог (ЛОР)');
    assert.equal(canonicalSpecialty('Врач УЗД'), 'Врач УЗИ');
    assert.equal(canonicalSpecialty('Кардиолог'), 'Кардиолог');
    const opts = specialtyOptions('ЛОР');
    assert.ok(!opts.some(([v]) => v === 'ЛОР'), 'старое «ЛОР» не становится отдельным пунктом');
    // REFERENCE_LISTS_V1 — «Косметолог» теперь в списке; пример «вне списка» — Гирудотерапевт
    const kept = specialtyOptions('Гирудотерапевт');
    assert.ok(kept.some(([v, l]) => v === 'Гирудотерапевт' && /не из списка/.test(l)), 'значение вне списка сохраняется и подписано');
    assert.ok(!specialtyOptions('Косметолог').some(([, l]) => /не из списка/.test(l)), 'Косметолог — уже из списка');
});

// JOURNALS_V1_SPECIALTIES (владелец, 2026-10-02): «in the employees, we need to
// add 2 specialties, "иглотерапевт" and "нейрофизиолог"». По алфавиту листа:
// Иглотерапевт — перед Инфекционистом, Нейрофизиолог — перед Нейрохирургом.
test('Иглотерапевт и Нейрофизиолог — в списке по алфавиту, со слагом, uz и en; канон узнаёт их в любом регистре', () => {
    const at = (ru) => SPECIALTY_ROWS.findIndex((r) => r.ru === ru);
    assert.deepEqual(SPECIALTY_ROWS[at('Иглотерапевт')], { slug: 'igloterapevt', ru: 'Иглотерапевт', uz: 'Ignaterapevt', en: 'Acupuncturist' });
    assert.deepEqual(SPECIALTY_ROWS[at('Нейрофизиолог')], { slug: 'neyrofiziolog', ru: 'Нейрофизиолог', uz: 'Neyrofiziolog', en: 'Neurophysiologist' });
    // REFERENCE_LISTS_V1 — между Иглотерапевтом и Инфекционистом встал Имплантолог
    assert.equal(at('Иглотерапевт') + 1, at('Имплантолог'));
    assert.equal(at('Имплантолог') + 1, at('Инфекционист'));
    assert.equal(at('Диетолог') + 1, at('Иглотерапевт'));
    assert.equal(at('Нейрофизиолог') + 1, at('Нейрохирург'));
    assert.equal(at('Невролог') + 1, at('Нейрофизиолог'));
    assert.ok(specialtyOptions('').some(([v]) => v === 'Иглотерапевт') && specialtyOptions('').some(([v]) => v === 'Нейрофизиолог'), 'пункты выпадающего списка карточки');
    assert.ok(!specialtyOptions('Нейрофизиолог').some(([, l]) => /не из списка/.test(l)), 'сохранённый — уже из списка');
    assert.equal(canonicalSpecialty(' Иглотерапевт '), 'Иглотерапевт');
});

// REFERENCE_LISTS_V1 (владелец, 2026-10-06): «add another 50+». Список по-прежнему
// встроен в программу (SPECIALTIES_CLONED_V1), сохраняется русское название.
test('67 новых специальностей — с указанными slug, ru, uz и en', () => {
    assert.equal(NEW_ROWS.length, 67);
    assert.equal(new Set(NEW_ROWS.map((r) => r.slug)).size, 67);
    const bySlug = new Map(SPECIALTY_ROWS.map((r) => [r.slug, r]));
    for (const want of NEW_ROWS) assert.deepEqual(bySlug.get(want.slug), want, 'строка ' + want.slug);
    for (const slug of OLD_ORDER) assert.ok(bySlug.has(slug), 'пропала прежняя ' + slug);
    assert.equal(OLD_ORDER.length + NEW_ROWS.length, SPECIALTY_ROWS.length, 'кроме прежних и новых — ничего');
});

test('новые — на алфавитных местах по-русски; прежние 53 — в прежнем порядке, Подолог последним', () => {
    const NEW = new Set(NEW_ROWS.map((r) => r.slug));
    assert.deepEqual(SPECIALTY_ROWS.filter((r) => !NEW.has(r.slug)).map((r) => r.slug), OLD_ORDER);
    assert.equal(SPECIALTY_ROWS[SPECIALTY_ROWS.length - 1].ru, 'Подолог');
    const cmp = (a, b) => a.ru.localeCompare(b.ru, 'ru');
    SPECIALTY_ROWS.forEach((r, i) => {
        if (!NEW.has(r.slug)) return;
        const prev = SPECIALTY_ROWS[i - 1], next = SPECIALTY_ROWS[i + 1];
        if (prev) assert.ok(cmp(prev, r) <= 0, prev.ru + ' стоит перед ' + r.ru);
        if (next && next.slug !== 'podolog') assert.ok(cmp(r, next) <= 0, r.ru + ' стоит перед ' + next.ru);
    });
});

test('названия «не из списка» в других тестах — по-прежнему не из списка', () => {
    // server/routes/users.specialties.test.js, server/services/rpc/reports.doctor-lines.test.js
    for (const name of ['Гирудотерапевт', 'Консультант клиники', 'Эксперт клиники', 'Мой особый']) {
        assert.ok(!SPECIALTIES.some((s) => s.toLowerCase() === name.toLowerCase()), name + ' попал в список');
    }
});
