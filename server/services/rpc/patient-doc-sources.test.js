// PASTE_SOURCES_V1 (2026-11-02) — «Вставить результаты» кабинета врача: все
// документы пациента одной выборкой (rpc patient_doc_sources).
//
// Проверяется то, что владелец увидел на тестовой клинике и на dev:
//   • раскладка — по services.type, а не по имени вида услуги (справочник
//     «Типы услуг» у клиник пуст, отделов у услуг нет);
//   • в документ идёт ПОЛНЫЙ текст разделов — Жалобы, Анамнез, Терапия,
//     Заключение, «Описание» диагностики, — а не сводка из трёх;
//   • архив документов (visit_documents) и заключение визита читаются;
//   • текущая строка не возвращается, права — как у карты пациента; размер
//     ответа ограничен;
//   • здание — как у карты пациента: результат анализа, приехавший из другого
//     здания, виден с пометкой филиала; протоколы, листы диагностики и
//     заключения визита между зданиями не ездят — чужих в списке нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientDocSources, SECTION_MAX, lineKind } from './patient-doc-sources.js';
import { patientCardDeleteDocument } from './patient-card.js';   // PASTE_SOURCES_V1 (ревью H1) — «Отозвать документ» карты
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir } from '../control/config.js';

const DOCTOR = { id: 3, role: 'doctor' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES
      (3, 'doc', 'x', 'Врач Тестов', 'doctor', 1),
      (4, 'doc2', 'x', 'Врач Второй', 'doctor', 1),
      (11, 'store', 'x', 'Склад', 'inventory', 0);
    INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Пациент Тестовый', 'T-1');
    INSERT INTO services (id, name, price, type, is_lab) VALUES
      (901, 'Приём терапевта', 70000, 'consultation', 0),
      (902, 'УЗИ брюшной полости', 90000, 'imaging', 0),
      (903, 'Общий анализ крови', 50000, 'lab', 1),
      (904, 'ЭхоКГ', 120000, 'imaging', 0),
      (905, 'Массаж', 40000, 'procedure', 0);
    INSERT INTO visits (id, patient_id, doctor_id, visit_date) VALUES
      (50, 1, 3, '2026-10-01T05:00:00Z'),
      (51, 1, 4, '2026-10-20T05:00:00Z');
  `);
  return db;
}

function line(db, id, visit, service, { status = 'completed', notes = null, doctor = 3, verified = null } = {}) {
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes, verified_at)
              VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`).run(id, visit, service, doctor, status, notes, verified);
}

function signedNotes(fields, extra = {}) {
  return JSON.stringify({ __service_workspace_v1: 1, current: fields, history: [
    { kind: 'draft', savedAt: '2026-10-01T06:00:00.000Z', fields: { chief_complaint: 'ЧЕРНОВИК' } },
    { kind: 'signed', savedAt: '2026-10-01T07:00:00.000Z', byName: 'Врач Тестов', fields },
  ], ...extra });
}

const setTabs = (db, role, tabs) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const p = JSON.parse(row.permissions);
  p.patient_tabs = tabs;
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
};

test('протокол приёма — все разделы целиком; диагноз — код ПОДПИСАННОЙ записи (F8); УЗИ — «Диагностика»; массаж — «Консультации»; черновик не документ', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({
    chief_complaint: 'Кашель 3 дня', hpi: 'Болеет неделю',
    physical_exam: '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>',
    primary_diagnosis: 'Текст врача', icd10: 'N28.9', therapy_text: '<b>Амоксициллин</b>',
    recommendations_text: 'Диета', conclusion_text: 'Здоров',
  }, { diagnoses: [{ code: 'E71.0', name: 'Болезнь', type: 'main' }], prescriptions: [{ name: 'Парацетамол', dose: '500 мг', freq: '2 раза' }] }) });
  line(db, 62, 50, 902, { notes: signedNotes({ instrumental_text: 'Печень не увеличена', primary_diagnosis: 'Без патологии' }, { docType: 'diag' }) });
  line(db, 63, 50, 905, { notes: signedNotes({ chief_complaint: 'Боль в спине' }) });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(out.groups.consult.map((d) => d.title).sort(), ['Массаж', 'Приём терапевта']);
  const p = out.groups.consult.find((d) => d.title === 'Приём терапевта');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Анамнез', 'Осмотр', 'Диагноз', 'Терапия', 'Рекомендации', 'Заключение', 'Рецепт']);
  const sec = Object.fromEntries(p.sections.map((s) => [s.key, s.html]));
  assert.equal(sec.complaint, 'Кашель 3 дня');
  assert.equal(sec.exam, '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>', 'оформление врача — разметкой, «<» экранирован один раз');
  assert.equal(sec.dx, 'N28.9<br>Текст врача', 'диагноз — код подписанной записи, а не нынешний основной');
  assert.equal(sec.therapy, '<b>Амоксициллин</b>');
  assert.match(sec.rx, /<ol><li><b>Парацетамол<\/b> — 500 мг, 2 раза<\/li><\/ol>/);
  assert.equal(p.doctor, 'Врач Тестов');
  assert.equal(p.at, '2026-10-01T07:00:00.000Z', 'дата документа — подпись');
  assert.deepEqual(out.groups.diag.map((d) => d.title), ['УЗИ брюшной полости']);
  assert.deepEqual(out.groups.diag[0].sections.map((s) => [s.label, s.html]), [['Описание', 'Печень не увеличена'], ['Заключение', 'Без патологии']]);
  assert.ok(!JSON.stringify(out).includes('ЧЕРНОВИК'), 'черновик ушёл в документы');
});

test('раскладка по services.type; отдел — запасной путь после типа', () => {
  const db = seed();
  assert.equal(lineKind({ type: 'imaging' }), 'diag');
  assert.equal(lineKind({ type: 'radiology' }), 'diag');
  assert.equal(lineKind({ type: 'lab' }), 'labs');
  assert.equal(lineKind({ type: 'consultation', is_lab: 1 }), 'labs');
  assert.equal(lineKind({ type: 'procedure' }), 'consult');
  assert.equal(lineKind({ type: 'other' }), 'consult');
  assert.equal(lineKind({ type: 'consultation', dept_kind: 'diagnostics' }), 'diag');
  assert.equal(lineKind({ type: 'imaging', dept_kind: 'laboratory' }), 'diag', 'тип сильнее отдела');
  const dep = db.prepare("INSERT INTO departments (name, kind) VALUES ('Функциональная диагностика', 'diagnostics')").run().lastInsertRowid;
  db.prepare("INSERT INTO services (id, name, price, type, department_id) VALUES (906, 'ЭКГ', 40000, 'consultation', ?)").run(dep);
  line(db, 71, 50, 906, { notes: signedNotes({ chief_complaint: 'Перебои' }) });
  line(db, 72, 50, 905, { notes: signedNotes({ chief_complaint: 'Боль в спине' }) });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(out.groups.diag.map((d) => d.title), ['ЭКГ']);
  assert.deepEqual(out.groups.diag[0].sections.map((s) => s.label), ['Жалобы'], 'запись приёма у исследования — разделами приёма');
  assert.deepEqual(out.groups.consult.map((d) => d.title), ['Массаж']);
});

test('архив документов: копия подписи в списке и выигрывает у записи строки; отозванная — нет; снимок до DOC_RICH_FORMAT_V1 — текст; изображения не отдаются', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'из записи строки' }) });
  line(db, 62, 50, 902);
  const arch = (vs, type, body, voided = null) => db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by, created_at, voided_at)
      VALUES (?, 50, 1, ?, 'Копия', ?, 3, '2026-10-01T08:00:00Z', ?)`).run(vs, type, JSON.stringify(body), voided);
  arch(61, 'protocol', { rich: 1, service: 'Приём терапевта', doctorName: 'Врач Тестов', complaint: 'из архива', hpi: '<p>Анамнез <i>длинный</i></p>', therapy: 'Покой', conclusionText: 'Здоров', dx: 'J20.9 — Острый бронхит' });
  arch(61, 'protocol', { rich: 1, complaint: 'ОТОЗВАННЫЙ' }, '2026-10-01T09:00:00Z');
  arch(62, 'diag', { description: 'Hb <b>ниже</b> нормы', conclusion: 'Без патологии', images: ['data:image/png;base64,' + 'A'.repeat(5000)] });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.consult.length, 1, 'документ строки задвоился: архив и запись строки');
  const p = out.groups.consult[0];
  assert.equal(p.source, 'archive');
  assert.equal(p.title, 'Приём терапевта');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Анамнез', 'Диагноз', 'Терапия', 'Заключение']);
  assert.equal(p.sections[1].html, '<p>Анамнез <i>длинный</i></p>');
  const s = JSON.stringify(out);
  assert.ok(!s.includes('ОТОЗВАННЫЙ') && !s.includes('из записи строки'), 'отозванный документ или запись строки рядом с её копией');
  assert.equal(out.groups.diag[0].sections[0].html, 'Hb &lt;b&gt;ниже&lt;/b&gt; нормы', 'набранное «<b>» старого снимка стало тегом');
  assert.ok(!s.includes('base64'), 'изображения снимка ушли в ответ');
});

test('текущая строка не возвращается: ни её запись, ни её копия в архиве', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'ТЕКУЩАЯ' }) });
  line(db, 64, 51, 901, { doctor: 4, notes: signedNotes({ chief_complaint: 'Прежний приём' }) });
  db.prepare("INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by) VALUES (61, 50, 1, 'protocol', 'Копия', ?, 3)")
    .run(JSON.stringify({ rich: 1, complaint: 'ТЕКУЩАЯ' }));
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 61 }, DOCTOR);
  assert.ok(!JSON.stringify(out).includes('ТЕКУЩАЯ'), 'текущая строка в списке');
  assert.deepEqual(out.groups.consult.map((d) => d.visit_service_id), [64]);
});

test('заключение визита — только если у визита нет документа строки (или это текущая строка)', () => {
  const db = seed();
  db.prepare("UPDATE visits SET conclusion = 'Заключение из кабинета', conclusion_type = 'consultation' WHERE id = 50").run();
  db.prepare("UPDATE visits SET conclusion = 'Ранее: <здоров>', conclusion_type = 'diagnostic' WHERE id = 51").run();
  line(db, 61, 50, 901, { notes: signedNotes({ conclusion_text: 'Заключение из кабинета' }) });
  line(db, 64, 51, 902);
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 61 }, DOCTOR);
  assert.ok(!JSON.stringify(out.groups.consult).includes('Заключение из кабинета'), 'заключение текущей строки вернулось заключением визита');
  const v = out.groups.diag.find((d) => d.source === 'visit');
  assert.ok(v, 'заключение визита без документов строк не показано');
  assert.equal(v.title, 'Заключение визита');
  assert.equal(v.sections[0].html, 'Ранее: &lt;здоров&gt;');
});

test('права — как у карты пациента: без раздела «Пациенты» — 403; закрытая вкладка — группа null и названа в closed; закрыто всё — 403 с названием вкладки', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'Кашель' }) });
  assert.throws(() => patientDocSources(db, { patient_id: 1 }, { id: 11, role: 'inventory' }), (e) => e.status === 403);
  setTabs(db, 'doctor', { docs: 'none' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.consult, null);
  assert.equal(out.groups.diag, null);
  assert.equal(out.groups.files, null);
  assert.deepEqual([...out.closed].sort(), ['consult', 'diag', 'files']);
  assert.ok(Array.isArray(out.groups.labs), 'анализы — своя вкладка «Лаборатория», она открыта');
  setTabs(db, 'doctor', { docs: 'none', labs: 'none', history: 'none' });
  assert.throws(() => patientDocSources(db, { patient_id: 1 }, DOCTOR), (e) => e.status === 403 && e.params && e.params.tab === 'Документы');
  setTabs(db, 'doctor', {});
  assert.throws(() => patientDocSources(db, {}, DOCTOR), (e) => e.status === 400);
  assert.throws(() => patientDocSources(db, { patient_id: 999 }, DOCTOR), (e) => e.status === 404);
});

test('разметка очищена: script, обработчики, картинки и ссылки не проходят, текст остаётся', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: '<img src=x onerror="alert(1)">Боль<script>alert(2)</script>', hpi: '<a href="javascript:alert(3)">ссылка</a>' }) });
  const s = JSON.stringify(patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.consult);
  assert.ok(!/<script|onerror|javascript:|<img|<a /i.test(s), s);
  assert.ok(s.includes('Боль') && s.includes('ссылка'), s);
});

test('размер ограничен: limit документов на группу (не больше 100) с пометкой truncated; длинный раздел обрезан', () => {
  const db = seed();
  for (let i = 0; i < 5; i++) line(db, 70 + i, 50, 901, { notes: signedNotes({ chief_complaint: 'Приём ' + i }) });
  const out = patientDocSources(db, { patient_id: 1, limit: 2 }, DOCTOR);
  assert.equal(out.groups.consult.length, 2);
  assert.equal(out.truncated.consult, true);
  assert.equal(out.truncated.diag, false);
  assert.equal(patientDocSources(db, { patient_id: 1, limit: 5000 }, DOCTOR).groups.consult.length, 5, 'предел выше 100 — не ошибка, а 100');
  line(db, 80, 51, 901, { notes: signedNotes({ hpi: 'x'.repeat(SECTION_MAX + 50) }) });
  const big = patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.consult.find((d) => d.visit_service_id === 80);
  assert.ok(big.sections[0].html.length <= SECTION_MAX + 1, 'раздел не обрезан: ' + big.sections[0].html.length);
});

test('RPC зарегистрирован, при просроченной лицензии читается (READ_ONLY_RPCS)', () => {
  assert.equal(typeof getRpc('patient_doc_sources'), 'function');
  assert.equal(isReadOnlyRpc('patient_doc_sources'), true);
});

const result = (db, vs, parameter, value, { unit = '', ref = '', flag = 'normal', origin = null } = {}) =>
  db.prepare('INSERT INTO lab_results (visit_service_id, parameter, value, unit, reference_range, flag, entered_by, sync_origin) VALUES (?,?,?,?,?,?,3,?)')
    .run(vs, parameter, value, unit, ref, flag, origin);

test('анализы — по визитам: «resulted» в списке с пометкой, проверенный — без; без показателей и отменённый — нет; повторный ввод показателя заменяет прежний', () => {
  const db = seed();
  line(db, 63, 50, 903, { status: 'resulted' });
  line(db, 65, 51, 903, { status: 'completed', verified: '2026-10-20T09:00:00Z' });
  line(db, 66, 51, 903, { status: 'queued' });
  line(db, 67, 51, 903, { status: 'cancelled' });
  result(db, 63, 'HGB', '96', { unit: 'г/л', ref: '120–160', flag: 'low' });
  result(db, 63, 'WBC', '14.2', { flag: 'high' });
  result(db, 63, 'HGB', '101', { unit: 'г/л', ref: '120–160', flag: 'low' });
  result(db, 65, 'PLT', '250');
  result(db, 67, 'ОТМЕНЁН', '1');
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const byVisit = Object.fromEntries(out.groups.labs.map((d) => [d.visit_id, d]));
  assert.deepEqual(Object.keys(byVisit).sort(), ['50', '51']);
  assert.equal(byVisit[50].unverified, true, '«resulted» без пометки «не проверено»');
  assert.deepEqual(byVisit[50].panels.map((p) => [p.visit_service_id, p.title, p.unverified]), [[63, 'Общий анализ крови', true]]);
  assert.deepEqual(byVisit[50].panels[0].rows.map((r) => [r.parameter, r.value, r.flag]), [['WBC', '14.2', 'high'], ['HGB', '101', 'low']]);
  assert.equal(byVisit[51].unverified, false);
  assert.deepEqual(byVisit[51].panels.map((p) => p.visit_service_id), [65], 'анализ без показателей или отменённый — в списке');
  assert.ok(!JSON.stringify(out).includes('ОТМЕНЁН'));
  assert.equal(out.groups.consult.length + out.groups.diag.length, 0, 'анализ ушёл не в свою вкладку');
  const ex = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 63 }, DOCTOR);
  assert.deepEqual(ex.groups.labs.map((d) => d.visit_id), [51], 'текущая строка-анализ вернулась');
});

test('измерения исследования (показатели у УЗИ/ЭхоКГ) — раздел «Измерения» его заключения в «Диагностике», не в «Анализах»', () => {
  const db = seed();
  line(db, 68, 50, 904, { notes: signedNotes({ instrumental_text: 'Камеры не расширены', primary_diagnosis: 'Норма' }, { docType: 'diag' }) });
  result(db, 68, 'ФВ', '62', { unit: '%', ref: '55–70' });
  line(db, 69, 51, 904);
  result(db, 69, 'КДР', '6.1', { unit: 'см', ref: '3.7–5.6', flag: 'high' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.labs.length, 0);
  const d68 = out.groups.diag.find((d) => d.visit_service_id === 68);
  assert.deepEqual(d68.sections.map((s) => s.label), ['Описание', 'Заключение', 'Измерения']);
  assert.match(d68.sections[2].html, /^<table class="a4-restbl">.*<td>ФВ<\/td><td>62 %<\/td><td>55–70<\/td>/);
  const d69 = out.groups.diag.find((d) => d.visit_service_id === 69);
  assert.deepEqual(d69.sections.map((s) => s.key), ['measurements']);
  assert.match(d69.sections[0].html, /<b>6\.1 см<\/b>/, 'отклонение от нормы не выделено');
});

test('стационар: опубликованные и не исправленные записи — разделами (свои подписи, свои разделы); черновик и исправленная — нет; «История» закрыта — null', () => {
  const db = seed();
  db.prepare("INSERT INTO admissions (id, patient_id, status, admission_no, admitted_at) VALUES (10, 1, 'active', 'A-26-0001', '2026-10-05T06:00:00Z')").run();
  db.prepare("INSERT INTO case_doc_types (kind, title, due_rule, sort_order) VALUES ('own_cardio', 'Осмотр кардиолога', 'none', 200)").run();
  const rev = (kind, c = {}) => db.prepare(`INSERT INTO admission_reviews
      (admission_id, kind, type_kind, complaints, objective, diagnosis, plan, body, author_id, published_at, superseded_by, sections_json)
      VALUES (10, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)`).run(kind, c.typeKind || null, c.complaints || '', c.objective || '', c.diagnosis || '',
    c.plan || '', c.body || '', c.published === undefined ? '2026-10-06T08:00:00Z' : c.published, c.superseded || null, c.sections || null).lastInsertRowid;
  const primary = rev('primary', {
    complaints: '<p>Боль в животе</p>', objective: 'Живот напряжён', diagnosis: 'K35.8 Острый аппендицит', plan: '<ul><li>Операция</li></ul>',
    sections: JSON.stringify({ titles: { objective: 'Статус' }, extra: [{ title: 'Осмотр хирурга', html: '<p>Симптом Щёткина +</p>' }] }),
  });
  rev('primary', { complaints: 'ИСПРАВЛЕННАЯ', superseded: primary });
  rev('round', { complaints: 'ЧЕРНОВИК-СТАЦИОНАРА', published: null });
  rev('other', { typeKind: 'own_cardio', objective: 'Ритм синусовый' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const byKind = Object.fromEntries(out.groups.inpatient.map((d) => [d.doc_kind, d]));
  assert.deepEqual(Object.keys(byKind).sort(), ['own_cardio', 'primary']);
  const p = byKind.primary;
  assert.equal(p.title, '', 'у встроенного рода имя — на экране (CASE_DOC_TITLE), не с сервера');
  assert.equal(p.admission_no, 'A-26-0001');
  assert.equal(p.doctor, 'Врач Тестов');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Статус', 'Диагноз', 'План обследования и лечения', 'Осмотр хирурга']);
  assert.equal(p.sections[3].html, '<ul><li>Операция</li></ul>');
  assert.equal(byKind.own_cardio.title, 'Осмотр кардиолога', 'свой род клиники — своим именем');
  const s = JSON.stringify(out);
  assert.ok(!s.includes('ИСПРАВЛЕННАЯ') && !s.includes('ЧЕРНОВИК-СТАЦИОНАРА'), 'исправленная запись или черновик в списке');
  setTabs(db, 'doctor', { history: 'none' });
  assert.equal(patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.inpatient, null);
});

test('файлы: название и путь без содержимого; отозванный — нет; «лежит ли на этом компьютере» — как в карте пациента', () => {
  const db = seed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-paste-'));
  setDataDir(dir);
  try {
    const docs = path.join(dir, 'storage', 'clinic-docs', 'patients', '1', 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'k1-scan.pdf'), 'x');
    const file = (title, name, voided = null) => db.prepare(`INSERT INTO visit_documents (patient_id, title, file_name, file_path, doc_type, created_by, voided_at)
        VALUES (1, ?, ?, ?, 'upload', 3, ?)`).run(title, name, 'patients/1/docs/' + name, voided);
    file('Направление', 'k1-scan.pdf');
    file('Снимок', 'k2-missing.jpg');
    file('ОТОЗВАН', 'k3.pdf', '2026-10-02T00:00:00Z');
    const files = patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.files;
    assert.deepEqual(files.map((f) => [f.title, f.file_available]).sort(), [['Направление', true], ['Снимок', false]]);
    assert.ok(files.every((f) => !f.sections && f.file_path.startsWith('patients/1/docs/')), 'у файла есть содержимое или чужой путь');
  } finally {
    setDataDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// PASTE_SOURCES_V1 — здание как у карты пациента (BRANCH_ORIGIN_V1): владелец
// просил результаты «из других документов пациента», а результаты анализов
// ездят между зданиями — они видны с буквой филиала (правило карты: метка
// результата, иначе метка строки). Протоколы, листы диагностики и заключения
// визита между зданиями не ездят — соседних в списке нет.
test('результат анализа другого здания виден с пометкой филиала; протокол, диагностика и заключение визита соседнего здания — нет; текущая строка — нет', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'СВОЁ' }) });
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, conclusion, sync_origin) VALUES (52, 1, '2026-10-21T05:00:00Z', 'ФИЛИАЛ-ВИЗИТ', 'B')").run();
  line(db, 64, 52, 901, { notes: signedNotes({ chief_complaint: 'ФИЛИАЛ-СТРОКА' }) });
  line(db, 65, 52, 904, { notes: signedNotes({ instrumental_text: 'ФИЛИАЛ-ЭХО' }, { docType: 'diag' }) });
  line(db, 66, 52, 903, { status: 'completed', verified: '2026-10-21T09:00:00Z' });
  line(db, 68, 52, 903, { status: 'resulted' });
  db.prepare("UPDATE visit_services SET sync_origin = 'B' WHERE id IN (64, 65, 66, 68)").run();
  result(db, 65, 'ФВ', '58', { unit: '%', origin: 'B' });
  result(db, 66, 'HGB', '131', { unit: 'г/л', origin: 'B' });
  result(db, 68, 'ТЕКУЩИЙ', '1', { origin: 'B' });
  line(db, 63, 50, 903, { status: 'completed', verified: '2026-10-01T09:00:00Z' });
  result(db, 63, 'WBC', '6.0');
  line(db, 67, 50, 903, { status: 'completed', verified: '2026-10-01T09:00:00Z' });
  result(db, 67, 'CRP', '2', { origin: 'C' });   // строка своя, результат приехал из филиала C
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 68 }, DOCTOR);
  const s = JSON.stringify(out);
  assert.ok(s.includes('СВОЁ'));
  assert.ok(!s.includes('ФИЛИАЛ-СТРОКА') && !s.includes('ФИЛИАЛ-ЭХО') && !s.includes('ФИЛИАЛ-ВИЗИТ'), 'протокол или заключение соседнего здания в списке');
  assert.ok(!s.includes('ТЕКУЩИЙ'), 'текущая строка в списке');
  const byVisit = Object.fromEntries(out.groups.labs.map((d) => [d.visit_id, d]));
  assert.deepEqual(Object.keys(byVisit).sort(), ['50', '52'], 'анализ соседнего здания не виден');
  assert.equal(byVisit[52].origin, 'B', 'у анализа соседнего здания нет пометки филиала');
  assert.deepEqual(byVisit[52].panels.map((p) => [p.visit_service_id, p.origin, p.rows[0].parameter]), [[66, 'B', 'HGB']]);
  assert.equal(byVisit[50].origin, null, 'свой визит со смешанными анализами — пометка у анализа, не у документа');
  assert.deepEqual(byVisit[50].panels.map((p) => [p.visit_service_id, p.origin]), [[63, null], [67, 'C']]);
  const echo = out.groups.diag.find((d) => d.visit_service_id === 65);
  assert.ok(echo, 'измерения исследования соседнего здания не видны');
  assert.equal(echo.origin, 'B');
  assert.deepEqual(echo.sections.map((x) => x.key), ['measurements'], 'к измерениям приехал протокол соседнего здания');
  assert.equal(out.groups.consult.every((d) => !d.origin), true, 'у своего протокола пометка филиала');
});

// ---------------------------------------------------------------------------
// PASTE_SOURCES_V1 — РЕВЬЮ U3 (2026-11-03): то, что ревьюер доказал пробами.
// ---------------------------------------------------------------------------
const arch = (db, vs, visit, type, body, at = '2026-10-01T08:00:00Z') => db.prepare(`INSERT INTO visit_documents
    (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by, created_at) VALUES (?, ?, 1, ?, 'Копия', ?, 3, ?)`)
  .run(vs, visit, type, JSON.stringify(body), at).lastInsertRowid;
const visitRow = (db, id, date, pid = 1) => db.prepare('INSERT INTO visits (id, patient_id, doctor_id, visit_date) VALUES (?, ?, 3, ?)').run(id, pid, date);
const dayIso = (base, i) => new Date(Date.parse(base) + i * 3600000).toISOString();

// H1 — «Отозвать документ» в карте: «Он останется в карте, но перестанет
// открываться». Окно вставки брало подписанную запись строки (notes), раз живой
// копии больше нет, и отозванный текст возвращался обычным документом; а
// visits.conclusion, записанное той же подписью (WS_CONCLUSION_V1), — «Заключением визита».
test('ревью H1: отозванные в карте протокол и диагностика не возвращаются ни записью строки, ни заключением визита; новая подпись после отзыва — видна', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'ОТОЗВАН-ПРИЁМ', conclusion_text: 'ОТОЗВАН-ЗАКЛ' }) });
  db.prepare("UPDATE visits SET conclusion = 'ОТОЗВАН-ЗАКЛ', conclusion_type = 'consultation' WHERE id = 50").run();
  const p = arch(db, 61, 50, 'protocol', { rich: 1, complaint: 'ОТОЗВАН-ПРИЁМ', conclusionText: 'ОТОЗВАН-ЗАКЛ' });
  line(db, 62, 51, 902, { notes: signedNotes({ instrumental_text: 'ОТОЗВАН-УЗИ' }, { docType: 'diag' }) });
  db.prepare("UPDATE visits SET conclusion = 'ОТОЗВАН-УЗИ-ЗАКЛ', conclusion_type = 'diagnostic' WHERE id = 51").run();
  const d = arch(db, 62, 51, 'diag', { rich: 1, description: 'ОТОЗВАН-УЗИ' });
  const before = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(before.groups.consult.map((x) => x.source), ['archive']);
  assert.deepEqual(before.groups.diag.map((x) => x.source), ['archive']);
  patientCardDeleteDocument(db, { document_id: p, reason: 'не тот пациент' }, DOCTOR);
  patientCardDeleteDocument(db, { document_id: d, reason: 'не тот пациент' }, DOCTOR);
  const after = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.ok(!JSON.stringify(after).includes('ОТОЗВАН'), 'отозванный документ вернулся: ' + JSON.stringify(after.groups));
  assert.deepEqual(after.groups.consult, []);
  assert.deepEqual(after.groups.diag, []);
  // Карта при этом тоже ничего не выводит из notes: правило одно (patient-card.js paintList).
  arch(db, 61, 50, 'protocol', { rich: 1, complaint: 'НОВАЯ-ПОДПИСЬ' }, '2026-10-02T08:00:00Z');
  const again = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(again.groups.consult.map((x) => [x.source, x.sections[0].html]), [['archive', 'НОВАЯ-ПОДПИСЬ']]);
});

// M1 — один LIMIT на все строки пациента: каждый анализ — своя строка, и 10
// чек-апов по 30 анализов вытесняли давний приём и давний анализ; окно писало
// «Документов этого вида у пациента пока нет».
test('ревью M1: строки анализов не вытесняют приёмы и диагностику — у каждого источника свой предел; давние приём, УЗИ и анализ видны', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'ДАВНИЙ-ПРИЁМ' }) });
  line(db, 62, 50, 902, { notes: signedNotes({ instrumental_text: 'ДАВНЕЕ-УЗИ' }, { docType: 'diag' }) });
  line(db, 63, 50, 903, { status: 'completed', verified: '2026-10-01T09:00:00Z' });
  result(db, 63, 'HGB', '130');
  let id = 1000;
  for (let i = 0; i < 12; i++) {
    visitRow(db, 200 + i, dayIso('2026-10-21T05:00:00Z', i * 24));
    for (let k = 0; k < 30; k++) { line(db, ++id, 200 + i, 903, { status: 'completed', verified: '2026-10-21T09:00:00Z' }); result(db, id, 'P' + k, '1'); }
  }
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.ok(JSON.stringify(out.groups.consult).includes('ДАВНИЙ-ПРИЁМ'), 'давний приём вытеснен анализами');
  assert.ok(JSON.stringify(out.groups.diag).includes('ДАВНЕЕ-УЗИ'), 'давнее УЗИ вытеснено анализами');
  assert.equal(out.groups.labs.length, 13);
  assert.ok(out.groups.labs.some((d) => d.visit_id === 50), 'давний анализ вытеснен');
  assert.deepEqual(out.truncated, { consult: false, diag: false, labs: false, inpatient: false, files: false });
});

test('ревью M1: у копий архива протоколов и диагностики — свои пределы; новейшие выигрывают; обрезанное помечено truncated', () => {
  const db = seed();
  let id = 2000;
  // 45 заключений диагностики (2025) и 320 протоколов (2026) — все копии архива
  for (let i = 0; i < 45; i++) {
    const v = 300 + i;
    visitRow(db, v, dayIso('2025-01-01T05:00:00Z', i * 24));
    line(db, ++id, v, 902);
    arch(db, id, v, 'diag', { rich: 1, description: 'УЗИ ' + i }, dayIso('2025-01-01T08:00:00Z', i * 24));
  }
  for (let i = 0; i < 320; i++) {
    const v = 400 + i;
    visitRow(db, v, dayIso('2026-01-01T05:00:00Z', i * 12));
    line(db, ++id, v, 901);
    arch(db, id, v, 'protocol', { rich: 1, complaint: 'Приём ' + i }, dayIso('2026-01-01T08:00:00Z', i * 12));
  }
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const htmls = (g) => out.groups[g].map((d) => d.sections[0].html);
  assert.equal(out.groups.diag.length, 40, 'копии диагностики вытеснены протоколами');
  assert.ok(htmls('diag').includes('УЗИ 44') && !htmls('diag').includes('УЗИ 4'), 'показаны не новейшие заключения');
  assert.equal(out.truncated.diag, true, 'обрезанная диагностика не помечена');
  assert.equal(out.groups.consult.length, 40);
  assert.ok(htmls('consult').includes('Приём 319') && !htmls('consult').includes('Приём 279'), 'показаны не новейшие протоколы');
  assert.equal(out.truncated.consult, true);
});

test('ревью M1: подписанные записи без копии — приёмы не вытесняют исследования; предел записей помечает свою группу', () => {
  const db = seed();
  line(db, 61, 50, 902, { notes: signedNotes({ instrumental_text: 'СТАРОЕ-УЗИ' }, { docType: 'diag' }) });
  line(db, 62, 50, 904, { notes: signedNotes({ instrumental_text: 'СТАРАЯ-ЭХО' }, { docType: 'diag' }) });
  let id = 3000;
  for (let i = 0; i < 310; i++) {
    visitRow(db, 800 + i, dayIso('2026-10-21T05:00:00Z', i));
    line(db, ++id, 800 + i, 901, { notes: signedNotes({ chief_complaint: 'Приём ' + i }) });
  }
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(out.groups.diag.map((d) => d.sections[0].html).sort(), ['СТАРАЯ-ЭХО', 'СТАРОЕ-УЗИ'], 'исследования вытеснены приёмами');
  assert.equal(out.truncated.diag, false);
  assert.equal(out.groups.consult.length, 40);
  assert.equal(out.truncated.consult, true);
});

// M2 — один бюджет ответа тратился группами по порядку с break: 39 длинных
// годовалых консультаций съедали его, и сегодняшнее УЗИ не попадало в ответ.
test('ревью M2: у каждой группы своя доля ответа — длинные давние приёмы не вытесняют сегодняшнее УЗИ, анализ и файл', () => {
  const db = seed();
  const big = '<p>' + 'x'.repeat(19000) + '</p>';
  for (let i = 0; i < 40; i++) {
    visitRow(db, 500 + i, dayIso('2025-06-01T05:00:00Z', i * 24));
    line(db, 600 + i, 500 + i, 901, { notes: signedNotes({ chief_complaint: big, hpi: big }) });
  }
  visitRow(db, 590, '2026-11-02T05:00:00Z');
  line(db, 691, 590, 903, { status: 'resulted' });
  result(db, 691, 'HGB', '96');
  line(db, 692, 590, 902, { notes: signedNotes({ instrumental_text: 'СЕГОДНЯ-УЗИ ' + 'y'.repeat(15000) }, { docType: 'diag' }) });
  db.prepare("INSERT INTO visit_documents (patient_id, title, file_name, file_path, doc_type, created_by) VALUES (1, 'Скан', 'a.pdf', 'patients/1/docs/a.pdf', 'upload', 3)").run();
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.diag.length, 1, 'сегодняшнее УЗИ вытеснено давними приёмами');
  assert.ok(out.groups.diag[0].sections[0].html.startsWith('СЕГОДНЯ-УЗИ'));
  assert.equal(out.groups.labs.length, 1);
  assert.equal(out.groups.files.length, 1);
  assert.equal(out.truncated.diag, false);
  assert.equal(out.truncated.consult, true, 'обрезанные приёмы не помечены');
  assert.ok(out.groups.consult.length >= 30, 'приёмам досталось слишком мало: ' + out.groups.consult.length);
  assert.ok(JSON.stringify(out).length <= 1600000, 'ответ вышел за бюджет');
});

test('ревью M2: fitGroups — малые группы берут своё, большие делят остаток поровну; документ, который не влез, пропускается, а не обрывает группу', async () => {
  const { fitGroups } = await import('./patient-doc-sources.js');
  assert.equal(typeof fitGroups, 'function');
  assert.deepEqual(fitGroups({ a: [5, 5], b: [100, 100, 100] }, 120), { a: [true, true], b: [true, false, false] });
  assert.deepEqual(fitGroups({ a: [50, 5, 5] }, 20), { a: [false, true, true] }, 'после документа, который не влез, группа оборвалась');
  assert.deepEqual(fitGroups({ a: [30, 30, 30], b: [30, 30, 30], c: [] }, 120), { a: [true, true, false], b: [true, true, false], c: [] });
});

// M3 (решение по умолчанию, владельцу сообщается): своя роль клиники с
// кабинетом врача, но без раздела «Пациенты» (например, «Врач-УЗИ»). Прежнее
// окно читало строки через /api/db и работало; новое отвечало 403. Теперь —
// права карты ИЛИ строка, открытая в кабинете (она назначена этому врачу), и
// тогда только пациент ЭТОЙ строки.
test('ревью M3: роль только с кабинетом — по своей строке видит документы ЕЁ пациента; чужой пациент, чужая строка, без строки и колл-центр — 403', () => {
  const db = seed();
  db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('uzi_doc', ?)").run(JSON.stringify({ sections: ['consultation'] }));
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'cc', 'x', 'Оператор', 'callcenter', 0)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (2, 'Пациент Второй', 'T-2')").run();
  visitRow(db, 60, '2026-10-22T05:00:00Z', 2);
  line(db, 61, 50, 902, { doctor: 3 });                                                    // текущая строка врача УЗИ
  line(db, 64, 51, 901, { doctor: 4, notes: signedNotes({ chief_complaint: 'ПРИЁМ-ПАЦИЕНТА-1' }) });
  line(db, 65, 60, 902, { doctor: 3, notes: signedNotes({ instrumental_text: 'УЗИ-ПАЦИЕНТА-2' }, { docType: 'diag' }) });
  const uzi = { id: 3, role: 'doctor', custom_role_code: 'uzi_doc' };
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 61 }, uzi);
  assert.ok(JSON.stringify(out.groups.consult).includes('ПРИЁМ-ПАЦИЕНТА-1'), 'документы пациента своей строки не видны');
  assert.ok(!JSON.stringify(out).includes('УЗИ-ПАЦИЕНТА-2'), 'документы другого пациента в ответе');
  const denied = (args, user = uzi) => assert.throws(() => patientDocSources(db, args, user), (e) => e.status === 403, JSON.stringify(args));
  denied({ patient_id: 2, exclude_visit_service_id: 61 });          // строка — пациента 1, просят пациента 2
  denied({ patient_id: 1, exclude_visit_service_id: 64 });          // строка другого врача
  denied({ patient_id: 1 });                                        // без строки
  denied({ patient_id: 1, exclude_visit_service_id: 99999 });       // строки нет
  denied({ patient_id: 1, exclude_visit_service_id: 61 }, { id: 12, role: 'callcenter' });
  db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = 61").run();
  denied({ patient_id: 1, exclude_visit_service_id: 61 });          // отменённая строка кабинетом не открывается
  // права карты — как раньше: штатный врач видит пациента и без строки
  assert.ok(Array.isArray(patientDocSources(db, { patient_id: 2 }, DOCTOR).groups.diag));
});

// L1 — раздел длиннее предела терял всё оформление (таблица — текстом через
// табуляцию) или обрезался «…», и окно об этом молчало.
test('ревью L1: раздел, сокращённый пределом, помечен cut — и потерявший оформление, и обрезанный; обычный — без пометки', () => {
  const db = seed();
  const rows = Array.from({ length: 500 }, (_, i) => `<tr><td><b>Показатель ${i}</b></td><td>${i}.0</td></tr>`).join('');
  line(db, 61, 50, 904, { notes: signedNotes({ instrumental_text: '<table class="a4-tbl"><tbody>' + rows + '</tbody></table>', primary_diagnosis: 'Норма' }, { docType: 'diag' }) });
  line(db, 62, 50, 901, { notes: signedNotes({ chief_complaint: 'Кашель', hpi: 'z'.repeat(SECTION_MAX + 10) }) });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const desc = out.groups.diag[0].sections.find((s) => s.key === 'description');
  assert.equal(desc.cut, true, 'раздел без оформления не помечен');
  assert.equal(out.groups.diag[0].sections.find((s) => s.key === 'conclusion').cut, undefined);
  const c = out.groups.consult[0].sections;
  assert.equal(c.find((s) => s.key === 'hpi').cut, true, 'обрезанный раздел не помечен');
  assert.ok(c.find((s) => s.key === 'hpi').html.endsWith('…'));
  assert.equal(c.find((s) => s.key === 'complaint').cut, undefined);
});

// L2, L3 — «Измерения» у своего исследования: результат другого здания
// терял «Филиал X», а введённый, но не проверенный — пометку «не проверено».
test('ревью L2/L3: «Измерения» своего исследования — с буквой филиала результата и с пометкой «не проверено»; проверенные — без неё', () => {
  const db = seed();
  line(db, 68, 50, 904, { status: 'resulted', notes: signedNotes({ instrumental_text: 'Эхо-текст' }, { docType: 'diag' }) });
  result(db, 68, 'ФВ', '60', { unit: '%', origin: 'B' });
  line(db, 69, 51, 904, { status: 'completed', verified: '2026-10-20T09:00:00Z', notes: signedNotes({ instrumental_text: 'Эхо-2' }, { docType: 'diag' }) });
  result(db, 69, 'КДР', '5.0', { unit: 'см' });
  line(db, 70, 51, 902, { status: 'resulted' });
  result(db, 70, 'Печень', '14', { unit: 'см' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const by = Object.fromEntries(out.groups.diag.map((d) => [d.visit_service_id, d]));
  const m68 = by[68].sections.find((s) => s.key === 'measurements');
  assert.equal(by[68].origin, null, 'описание своего здания подписано чужим филиалом');
  assert.equal(m68.origin, 'B', 'у измерений другого здания нет буквы филиала');
  assert.equal(m68.unverified, true, 'непроверенные измерения без пометки');
  assert.equal(by[68].unverified, true);
  const m69 = by[69].sections.find((s) => s.key === 'measurements');
  assert.ok(!m69.unverified && !m69.origin && !by[69].unverified, 'у проверенных своих измерений лишние пометки');
  assert.equal(by[70].unverified, true, 'непроверенные измерения без документа — без пометки');
});

// L5 — день в заголовке вставки — день документа (docDayText, PRINT_VISIT_DATE_V1),
// а не время последней подписи: сервер отдаёт исходные значения, день считает окно.
test('ревью L5: у записи строки — день визита и первая подпись; у копии архива — день, напечатанный на ней (issueDate)', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: JSON.stringify({ __service_workspace_v1: 1, history: [
    { kind: 'signed', savedAt: '2026-10-01T07:00:00.000Z', fields: { chief_complaint: 'Первая' } },
    { kind: 'signed', savedAt: '2026-10-08T07:00:00.000Z', fields: { chief_complaint: 'Переподпись' } }] }) });
  line(db, 62, 51, 901);
  arch(db, 62, 51, 'protocol', { rich: 1, complaint: 'Копия', issueDate: '20.10.2026' }, '2026-10-27T08:00:00Z');
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const n = out.groups.consult.find((d) => d.visit_service_id === 61);
  assert.equal(n.at, '2026-10-08T07:00:00.000Z');
  assert.equal(n.visit_date, '2026-10-01T05:00:00Z');
  assert.equal(n.first_signed_at, '2026-10-01T07:00:00.000Z');
  const a = out.groups.consult.find((d) => d.visit_service_id === 62);
  assert.equal(a.issue_date, '20.10.2026');
  assert.equal(a.visit_date, '2026-10-20T05:00:00Z');
});
