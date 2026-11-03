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
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

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

// PASTE_SOURCES_V1 — протоколы, листы диагностики и заключения визита между
// зданиями не ездят: строки и визиты соседнего здания (sync_origin) — не их
// источник. Результаты анализов — проверяются вместе с анализами ниже.
test('протокол, диагностика и заключение визита соседнего здания (sync_origin) не возвращаются', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'СВОЁ' }) });
  line(db, 64, 51, 901, { notes: signedNotes({ chief_complaint: 'ФИЛИАЛ-СТРОКА' }) });
  line(db, 65, 51, 902, { notes: signedNotes({ instrumental_text: 'ФИЛИАЛ-УЗИ' }, { docType: 'diag' }) });
  db.prepare("UPDATE visit_services SET sync_origin = 'B' WHERE id IN (64, 65)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, conclusion, sync_origin) VALUES (52, 1, '2026-10-21T05:00:00Z', 'ФИЛИАЛ-ВИЗИТ', 'B')").run();
  const s = JSON.stringify(patientDocSources(db, { patient_id: 1 }, DOCTOR));
  assert.ok(s.includes('СВОЁ'));
  assert.ok(!s.includes('ФИЛИАЛ-СТРОКА') && !s.includes('ФИЛИАЛ-УЗИ') && !s.includes('ФИЛИАЛ-ВИЗИТ'), 'документ соседнего здания в списке');
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
