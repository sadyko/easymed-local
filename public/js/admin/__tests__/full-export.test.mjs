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
const { exportColumnKeys, buildImportRow } = await import('../views/section-import-export.js');

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
    // DOCTOR_TIER_V2 — ступени 2 и 3.
    'doctor_tier_from_2', 'doctor_tier_percent_2', 'doctor_tier_from_3', 'doctor_tier_percent_3',
    'external_lab',   // EXTERNAL_LAB_V1
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
    // FULL_EXPORT_EOL_V1 — страж режет исходник по '\n'; на Windows с
    // core.autocrlf=true checkout отдаёт CRLF, и без нормализации срез пуст —
    // «category» не находится, и тест падает, хотя код верен.
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'section-import-export.js'), 'utf8').replace(/\r\n/g, '\n');
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

// DOCTOR_TIER_V1 — ИМПОРТ НЕ ИМЕЕТ ПРАВА СТИРАТЬ ТО, ЧЕГО В ФАЙЛЕ НЕТ.
//
// Обратная сторона того же договора, что и тесты выше: файл несёт ВСЁ, значит
// файл, который чего-то не несёт, ничего об этом и не говорит. Числовые
// колонки писались в payload всегда — даже когда заголовка в листе не было
// вовсе, — и обновление услуг файлом, выгруженным ДО ступеней, обнуляло
// ступень по всему прайс-листу. Молча: ни ошибки, ни предупреждения.
test('импорт услуг: колонок ступени в файле нет — ступень не трогается', () => {
    const { payload } = buildImportRow('services', {
        name: 'Приём терапевта', group: 'Консультация', price: 100000,
    });
    assert.ok(!('doctor_tier_from' in payload),
        'порог ступени попал в запись из файла, где такой колонки нет: ' + JSON.stringify(payload));
    assert.ok(!('doctor_tier_percent' in payload),
        'доля ступени попала в запись из файла, где такой колонки нет: ' + JSON.stringify(payload));
    // Остальные колонки листа при этом пишутся как раньше.
    assert.strictEqual(payload.name, 'Приём терапевта');
    assert.strictEqual(payload.price, 100000);
});

test('импорт услуг: пустая ячейка под своим заголовком по-прежнему значит «ступени нет»', () => {
    const { payload, status } = buildImportRow('services', {
        name: 'Приём терапевта', group: 'Консультация', price: 100000, doctor_tier_from: '', doctor_tier_percent: '',
    });
    assert.strictEqual(payload.doctor_tier_from, 0, 'колонка в файле есть — её значение и пишется');
    assert.strictEqual(payload.doctor_tier_percent, 0);
    assert.strictEqual(status, 'ok', 'осознанно пустая пара — не повод пугать предупреждением');
});

test('импорт услуг: полупара обнуляется И называется вслух', () => {
    const row = buildImportRow('services', {
        name: 'Приём терапевта', group: 'Консультация', price: 100000, doctor_tier_percent: 50,
    });
    assert.strictEqual(row.payload.doctor_tier_from, 0, 'полупара сохранилась — редактор её не примет');
    assert.strictEqual(row.payload.doctor_tier_percent, 0);
    assert.strictEqual(row.status, 'warn', 'строка уехала без предупреждения: ' + JSON.stringify(row.notes));
    assert.ok(row.notes.some((n) => /полупара/.test(String(n))),
        'предупреждение не сказало, что именно отброшено: ' + JSON.stringify(row.notes));

    // Полная пара в границах сервера проходит как есть.
    const ok = buildImportRow('services', {
        name: 'Приём терапевта', group: 'Консультация', price: 100000, doctor_tier_from: '26', doctor_tier_percent: '45.5',
    });
    assert.strictEqual(ok.payload.doctor_tier_from, 26);
    assert.strictEqual(ok.payload.doctor_tier_percent, 45.5);
    assert.strictEqual(ok.status, 'ok');
});

// DOCTOR_TIER_V2 (правка ревью) — вне границ сервера импорт НЕ округляет молча
// (раньше 25.6 → 26 и 140 % → 100 %, а service_save такое отвергает): ступень
// из файла не сохраняется, и строка называет услугу и причину.
test('импорт услуг: дробный порог и доля > 100 — ступень не сохраняется, с предупреждением', () => {
    for (const [cells, msg] of [
        [{ doctor_tier_from: '25.6', doctor_tier_percent: '40' }, 'Порог ступени — целое число'],
        [{ doctor_tier_from: '25', doctor_tier_percent: '140' }, 'Доля выше порога — от 0 до 100 %'],
        [{ doctor_tier_from: '25', doctor_tier_percent: '40', doctor_tier_from_2: '7.5', doctor_tier_percent_2: '45' }, 'Порог ступени 2 — целое число'],
    ]) {
        const row = buildImportRow('services', { name: 'Приём терапевта', group: 'Консультация', price: 100000, ...cells });
        assert.strictEqual(row.status, 'warn', JSON.stringify(cells));
        assert.ok(row.notes.some((n) => String(n).includes(msg) && String(n).includes('Приём терапевта')), JSON.stringify(row.notes));
        assert.ok(!Object.values(row.payload).includes(26) && !Object.values(row.payload).includes(100) && !Object.values(row.payload).includes(8),
            'число молча округлено: ' + JSON.stringify(row.payload));
    }
    const bad2 = buildImportRow('services', { name: 'Приём терапевта', group: 'Консультация', price: 100000,
        doctor_tier_from: '25', doctor_tier_percent: '40', doctor_tier_from_2: '7.5', doctor_tier_percent_2: '45' });
    assert.ok(!('doctor_tier_from_2' in bad2.payload), 'сломанная ступень 2 уехала в запись');
});

// ---------------------------------------------------------------------------
// DOCTOR_TIER_V2 — шесть колонок трёх ступеней: то же поведение половин и
// отсутствующих заголовков, что у ступени 1, плюс порядок ступеней.
// ---------------------------------------------------------------------------
const SVC_BASE = { name: 'Приём терапевта', group: 'Консультация', price: 100000 };
const SIX = ['doctor_tier_from', 'doctor_tier_percent', 'doctor_tier_from_2', 'doctor_tier_percent_2', 'doctor_tier_from_3', 'doctor_tier_percent_3'];

test('DOCTOR_TIER_V2: экспорт → импорт — три ступени возвращаются как были', () => {
    const keys = exportColumnKeys('services');
    for (const k of SIX) assert.ok(keys.includes(k), 'нет колонки ' + k);
    const row = { ...SVC_BASE, doctor_tier_from: 25, doctor_tier_percent: 40, doctor_tier_from_2: 50, doctor_tier_percent_2: 45, doctor_tier_from_3: 100, doctor_tier_percent_3: 50 };
    const { payload, status } = buildImportRow('services', row);
    assert.deepEqual(SIX.map((k) => payload[k]), [25, 40, 50, 45, 100, 50]);
    assert.strictEqual(status, 'ok');
});

test('DOCTOR_TIER_V2: в файле нет колонок ступеней 2–3 — они не трогаются', () => {
    const { payload } = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 25, doctor_tier_percent: 40 });
    assert.strictEqual(payload.doctor_tier_from, 25);
    for (const k of SIX.slice(2)) assert.ok(!(k in payload), k + ' попал в запись из файла без такой колонки');
});

test('DOCTOR_TIER_V2: полупара ступени 2 обнуляется и называется вслух', () => {
    const row = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 25, doctor_tier_percent: 40,
        doctor_tier_from_2: 50, doctor_tier_percent_2: '', doctor_tier_from_3: '', doctor_tier_percent_3: '' });
    assert.strictEqual(row.payload.doctor_tier_from_2, 0);
    assert.strictEqual(row.payload.doctor_tier_percent_2, 0);
    assert.strictEqual(row.payload.doctor_tier_from, 25, 'ступень 1 цела');
    assert.strictEqual(row.status, 'warn');
    assert.ok(row.notes.some((n) => /Ступень 2/.test(String(n)) && /полупара/.test(String(n))), JSON.stringify(row.notes));
});

test('DOCTOR_TIER_V2: ступень 3 без ступени 2 и нерастущие пороги — ни одна ступень строки не сохраняется, с предупреждением', () => {
    const skip = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 25, doctor_tier_percent: 40,
        doctor_tier_from_2: '', doctor_tier_percent_2: '', doctor_tier_from_3: 100, doctor_tier_percent_3: 50 });
    for (const k of SIX) assert.ok(!(k in skip.payload), 'при нарушении порядка ступени строки не пишутся вовсе: ' + k);
    assert.strictEqual(skip.status, 'warn');
    assert.ok(skip.notes.some((n) => /ступень 3 без ступени 2/.test(String(n))), JSON.stringify(skip.notes));

    const desc = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 25, doctor_tier_percent: 40,
        doctor_tier_from_2: 20, doctor_tier_percent_2: 45, doctor_tier_from_3: 100, doctor_tier_percent_3: 50 });
    for (const k of SIX) assert.ok(!(k in desc.payload), 'при нарушении порядка ступени строки не пишутся вовсе: ' + k);
    assert.ok(desc.notes.some((n) => /Порог ступени 2 должен быть больше/.test(String(n))), JSON.stringify(desc.notes));
});

// ---------------------------------------------------------------------------
// EXTERNAL_LAB_V1 — одна колонка «external_lab»: едет туда и обратно, без
// заголовка отметка не трогается, у не-лабораторной услуги её не бывает.
// ---------------------------------------------------------------------------
test('EXTERNAL_LAB_V1: колонка в файле есть и возвращается импортом', () => {
    assert.ok(exportColumnKeys('services').includes('external_lab'), 'нет колонки external_lab');
    const on = buildImportRow('services', { name: 'ПЦР', group: 'Лаборатория', price: 100000, external_lab: 1 });
    assert.strictEqual(on.payload.external_lab, true);
    const off = buildImportRow('services', { name: 'ПЦР', group: 'Лаборатория', price: 100000, external_lab: '' });
    assert.strictEqual(off.payload.external_lab, false, 'пустая ячейка под заголовком — «своя лаборатория»');
});

test('EXTERNAL_LAB_V1: заголовка нет — отметка не трогается; не лаборатория — отметки нет', () => {
    const none = buildImportRow('services', { name: 'ПЦР', group: 'Лаборатория', price: 100000 });
    assert.ok(!('external_lab' in none.payload), 'отметка попала в запись из файла без такой колонки');
    const consult = buildImportRow('services', { ...SVC_BASE, external_lab: 'true' });
    assert.strictEqual(consult.payload.external_lab, false);
});

// DOCTOR_TIER_V2 (правка ревью) — СТАРЫЙ ФАЙЛ. Выгрузка до ступеней 2–3 несёт
// только колонки ступени 1; поднятый в нём порог 1 (60) выше сохранённого
// порога 2 (50). Раньше строка проходила молча, а отчёт переставал платить
// ступени 2–3. Теперь порядок проверяется по файлу ПОВЕРХ сохранённого.
const STORED = () => ({ __stored: new Map([['приём терапевта', {
    name: 'Приём терапевта', doctor_tier_from: 25, doctor_tier_percent: 40,
    doctor_tier_from_2: 50, doctor_tier_percent_2: 45, doctor_tier_from_3: 100, doctor_tier_percent_3: 50 }]]) });

test('DOCTOR_TIER_V2: старый файл поднимает порог 1 выше сохранённого порога 2 — ступени не пишутся, строка предупреждает', () => {
    const row = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 60, doctor_tier_percent: 40 }, { lookups: STORED() });
    for (const k of SIX) assert.ok(!(k in row.payload), 'колонка ступеней уехала в запись: ' + k);
    assert.strictEqual(row.status, 'warn');
    assert.ok(row.notes.some((n) => String(n).includes('Приём терапевта') && String(n).includes('Порог ступени 2 должен быть больше порога ступени 1')),
        JSON.stringify(row.notes));
    // Совместимая правка того же файла проходит: порог 1 ниже сохранённого порога 2.
    const fine = buildImportRow('services', { ...SVC_BASE, doctor_tier_from: 20, doctor_tier_percent: 35 }, { lookups: STORED() });
    assert.strictEqual(fine.status, 'ok', JSON.stringify(fine.notes));
    assert.strictEqual(fine.payload.doctor_tier_from, 20);
    assert.ok(!('doctor_tier_from_2' in fine.payload), 'сохранённая ступень 2 не трогается');
});

test('DOCTOR_TIER_V2: после импорта старого файла зарплата врача не меняется (120 услуг: 5 000 000)', async () => {
    const { openDb } = await import('../../../../server/db/connection.js');
    const { migrate } = await import('../../../../server/db/migrate.js');
    const { runReport } = await import('../../../../server/services/rpc/reports.js');
    const { writableColumns } = await import('../../../../server/db/schema-registry.js');
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, service_rates)
                    VALUES (1,'doc','x','doctor','Доктор Д.', ?)`).run(JSON.stringify([{ service_id: 1, pct: 30 }]));
        db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
        db.prepare(`INSERT INTO services (id, name, price, tax_rate, doctor_tier_from, doctor_tier_percent,
                      doctor_tier_from_2, doctor_tier_percent_2, doctor_tier_from_3, doctor_tier_percent_3)
                    VALUES (1,'Приём терапевта',100000,0,25,40,50,45,100,50)`).run();
        for (let id = 1; id <= 120; id++) {
            db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (?,1,'2026-09-05T09:00:00Z')").run(id);
            db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                        VALUES (?,?,?,1,100000,0,100000,100000,'paid','2026-09-05T10:00:00Z')`).run(id, 'INV-' + id, id);
            db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,1,'Приём',1,100000,100000)").run(id, id);
            // PAY_BASIS_PERFORMED_V1 — доля платится за ВЫПОЛНЕННУЮ строку (прежде 'added').
            db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
                        VALUES (?,?,1,1,1,100000,100000,'completed',?)`).run(id, id, id);
        }
        const fee = () => {
            const r = runReport(db, { kind: 'doctor_salaries', from: '2026-09-01', to: '2026-09-30' }, { id: 1, role: 'admin' });
            return r.rows[0][r.columns.indexOf('Доля врача (гонорар)')];
        };
        assert.strictEqual(fee(), 5000000);

        // Сохранённые ступени — как их прочитал бы loadLookups (по названию).
        const stored = db.prepare('SELECT * FROM services WHERE id = 1').get();
        const lookups = { __stored: new Map([['приём терапевта', stored]]) };
        const { payload } = buildImportRow('services', { ...SVC_BASE, tax_rate: 0, doctor_tier_from: 60, doctor_tier_percent: 40 }, { lookups });   // НДС в файле тот же, что в базе: меняются только ступени
        // Пишем ровно так, как пишет импорт при обновлении: все простые колонки строки.
        const writable = new Set(writableColumns('services', 'update'));
        const cols = Object.keys(payload).filter((k) => writable.has(k) && (payload[k] === null || typeof payload[k] !== 'object'));
        db.prepare(`UPDATE services SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = 1`)
            .run(...cols.map((c) => (typeof payload[c] === 'boolean' ? (payload[c] ? 1 : 0) : payload[c])));
        assert.strictEqual(fee(), 5000000, 'импорт старого файла понизил зарплату врача');
    } finally { db.close(); }
});
