// FULL_EXPORT_V1 — владелец: «exporting and importing are not giving all the
// information to the excel sheet. for the patients and for the services».
// Файл Excel обязан нести ВСЁ, что держит окно: каждое поле окна пациента и
// каждое поле редактора услуги — колонка файла. Проверяется по реестру
// колонок базы: колонка, которой нет в файле, — это данные, которые
// экспорт теряет молча.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Minimal DOM so the view module (and i18n it pulls) can load; nothing renders here.
class F { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; } removeChild() {} setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {} removeEventListener() {} querySelector() { return null; } querySelectorAll() { return []; } remove() {}
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
    get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; } }
const mk = (t) => new F(t);
globalThis.Node = F;
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; }, head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
const { exportColumnKeys } = await import('../views/section-import-export.js');

// Что хранит анкета пациента (patient-create-modal.js reg(...)) — по именам полей.
const PATIENT_FORM_FIELDS = [
    'last_name', 'first_name', 'middle_name', 'date_of_birth', 'gender', 'phone', 'phone_secondary', 'email',
    'language', 'national_id', 'passport_number', 'nationality', 'behavior_note',
    'country', 'region', 'district', 'mahalla', 'address',
    'blood_type', 'allergies', 'chronic_conditions', 'occupation', 'emergency_contact_name', 'emergency_contact_phone',
    'citizenship',
];
// Что держит редактор услуги (service-editor.js args) — кроме исполнителей и лаб-норм (живут в панелях).
const SERVICE_EDITOR_FIELDS = [
    'name', 'code', 'price', 'tax_rate', 'duration_minutes', 'requires_doctor', 'default_doctor_percent', 'active',
    'price_secondary', 'secondary_days_from', 'secondary_days_to', 'price_repeat', 'repeat_days_from', 'repeat_days_to', 'specimen', 'tube_color',
    'name_uz', 'name_en', 'online_booking', 'doctor_tier_from', 'doctor_tier_percent',
];

test('экспорт пациентов несёт каждое поле окна пациента (категория — по названию)', () => {
    const keys = exportColumnKeys('patients');
    for (const f of PATIENT_FORM_FIELDS) assert.ok(keys.includes(f), 'в файле пациентов нет колонки ' + f + ': ' + keys.join(', '));
    assert.ok(keys.includes('category'), 'категория пациента (по названию) не экспортируется');
    for (const f of ['marital_status', 'emergency_contact_relation', 'insurance_policy_number', 'insurance_expiry_date', 'registration_date', 'notes', 'mrn', 'active']) {
        assert.ok(keys.includes(f), 'в файле пациентов нет колонки ' + f);
    }
});

test('экспорт услуг несёт каждое поле редактора услуги (раздел/тип/категория/отделение/кабинет — по названиям)', () => {
    const keys = exportColumnKeys('services');
    for (const f of SERVICE_EDITOR_FIELDS) assert.ok(keys.includes(f), 'в файле услуг нет колонки ' + f + ': ' + keys.join(', '));
    for (const f of ['group', 'type', 'category', 'department', 'room']) assert.ok(keys.includes(f), 'нет колонки ' + f);
});

test('колонки файла — только те, что реестр базы принимает на запись (иначе импорт молча теряет данные)', async () => {
    const { writableColumns } = await import('../../../../server/db/schema-registry.js');
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'section-import-export.js'), 'utf8');
    const block = (name) => { const i = src.indexOf('    ' + name + ': {\n        table:'); return src.slice(i, src.indexOf('sampleRows', i)); };
    for (const [section, table] of [['patients', 'patients'], ['services', 'services']]) {
        const cfgSrc = block(section);
        const writable = new Set(writableColumns(table, 'insert'));
        for (const key of exportColumnKeys(section)) {
            // A column with `target:` or `fk:` writes elsewhere; a plain key writes itself.
            const line = cfgSrc.split('\n').find((l) => l.includes("key: '" + key + "'")) || '';
            if (/target:|fk:/.test(line)) continue;
            assert.ok(writable.has(key), section + ': колонка «' + key + '» есть в файле, но реестр не принимает её на запись');
        }
    }
});

test('реестр разделов: экспорт всего раздела постранично (все пациенты, не одна страница) и по формату импорта', () => {
    const crud = fs.readFileSync(path.join(HERE, '..', 'views', 'section-crud.js'), 'utf8');
    assert.match(crud, /tr\('Экспорт в Excel'\)/, 'в шапке реестра есть кнопка экспорта всего раздела');
    assert.match(crud, /async function fetchAllRowsForExport/, 'экспорт собирает строки сам, а не берёт state.rows текущей страницы');
    assert.match(crud, /q\.range\(from, from \+ EXPORT_SLICE - 1\)/, 'страничный раздел читается кусками до конца');
    assert.match(crud, /applyListFilters\(scopedQuery\(def\), def\)/, 'фильтры экрана и область видимости клиники применяются к экспорту');
    assert.match(crud, /if \(!state\.paged\) return filterRows\(state\.rows, def, state\.search\)/, 'малый раздел — по тем же фильтрам, что на экране');
    assert.match(crud, /exportSectionRows\(\{ sectionKey: state\.sectionKey, rows, filenameStem: state\.sectionKey \}\)/, 'файл — по формату импорта: все поля, можно вернуть импортом');
    assert.match(crud, /if \(hasImporter\(state\.sectionKey\)\) \{\s*await exportSectionRows/, 'экспорт выбранных — тем же полным форматом');
    const svc = fs.readFileSync(path.join(HERE, '..', 'views', 'services.js'), 'utf8');
    assert.match(svc, /exportSectionRows\(\{ sectionKey: 'services', rows: picked\(\)/, 'услуги: экспорт выбранных — полным форматом');
});
