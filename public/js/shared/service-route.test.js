// DIAG_ROUTE_V1 (2026-11-03) — «маршрут решает ГРУППА услуги, а не название».
// Случаи — из расследования «диагностика не видна у врача» (A01–A17): группа
// «Диагностика» с «лабораторным» типом каталога или с отделением видом
// «Процедурный»/«Лаборатория» уходила из кабинета врача.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceRoute, serviceGroup, goesToCabinet, procedureSql, noGroupSql, hintedSql, groupDecides, needsPerformer, SERVICE_GROUPS, HINTED_GROUPS, LAB_NAME_RE } from './service-route.js';
import { performerRequired } from './service-route.js';   // LAB_NO_DOCTOR_V1
import { openDb } from '../../../server/db/connection.js';
import { migrate } from '../../../server/db/migrate.js';

const deptKindById = { 2: 'clinical', 3: 'procedure', 5: 'laboratory', 6: 'diagnostics' };
const typeNameById = { 2: 'Лаборатория', 3: 'Процедуры', 4: 'Диагностика', 9: 'Лабораторная диагностика', 10: 'Laboratoriya va diagnostika' };
const L = { deptKindById, typeNameById };

test('группа решает: Лаборатория → лаборатория, Процедуры → процедуры, остальные четыре → кабинет', () => {
  assert.equal(serviceRoute({ type: 'lab' }), 'lab');
  assert.equal(serviceRoute({ type: 'procedure' }), 'procedure');
  for (const g of ['consultation', 'imaging', 'radiology', 'other']) assert.equal(serviceRoute({ type: g }), 'cabinet', g);
  assert.equal(serviceRoute({ type: 'imaging', is_lab: 1 }), 'lab', 'is_lab — зеркало группы «Лаборатория» (мигр. 048)');
  assert.equal(serviceRoute({ type: ' IMAGING ' }), 'cabinet', 'регистр и пробелы');
});

test('A09–A13: тип каталога и вид отделения НЕ уводят услугу группы «Диагностика» из кабинета', () => {
  assert.equal(serviceRoute({ type: 'imaging', type_id: 9 }, L), 'cabinet', 'A09 «Лабораторная диагностика»');
  assert.equal(serviceRoute({ type: 'imaging', type_id: 10 }, L), 'cabinet', 'A10 «Laboratoriya va diagnostika»');
  assert.equal(serviceRoute({ type: 'imaging', type_id: 2 }, L), 'cabinet', 'A11 тип «Лаборатория» по ошибке');
  assert.equal(serviceRoute({ type: 'imaging', department_id: 3 }, L), 'cabinet', 'A12 отделение видом «Процедурный»');
  assert.equal(serviceRoute({ type: 'imaging', department_id: 5 }, L), 'cabinet', 'A13 отделение видом «Лаборатория»');
  // встроенные ответы /api/db (services(service_types(name), departments(kind))) — то же правило
  assert.equal(serviceRoute({ type: 'imaging', service_types: { name: 'Лабораторная диагностика' }, departments: { kind: 'procedure' } }), 'cabinet');
  assert.equal(serviceRoute({ type: 'procedure', service_types: { name: 'Диагностика' } }), 'procedure', 'A14 ЭКГ группы «Процедуры» — процедура');
});

// Поправка ревью (2026-11-03): 'consultation' — УМОЛЧАНИЕ колонки services.type (мигр. 023);
// клиники держат под ним и анализы, которые приходят в лабораторию только отделением
// «Лаборатория» или «лабораторным» типом. У группы «Консультации» — прежнее правило.
test('группа «Консультации» — как строка без группы: отделение и тип каталога ведут в лабораторию / процедуры', () => {
  assert.deepEqual([...HINTED_GROUPS], ['consultation']);
  assert.equal(serviceRoute({ type: 'consultation', department_id: 5 }, L), 'lab', 'отделение «Лаборатория»');
  assert.equal(serviceRoute({ type: 'consultation', type_id: 2 }, L), 'lab', 'тип «Лаборатория»');
  assert.equal(serviceRoute({ type: 'consultation', type_id: 9 }, L), 'lab', 'тип «Лабораторная диагностика»');
  assert.equal(serviceRoute({ type: 'consultation', department_id: 3 }, L), 'procedure', 'отделение «Процедурный»');
  assert.equal(serviceRoute({ type: 'consultation', departments: { kind: 'laboratory' } }), 'lab', 'встроенный ответ /api/db');
  assert.equal(serviceRoute({ type: 'consultation', service_types: { name: 'Laboratoriya va diagnostika' } }), 'lab');
  assert.equal(serviceRoute({ type: 'consultation', department_id: 2, type_id: 4 }, L), 'cabinet', 'обычный приём');
  assert.equal(serviceRoute({ type: 'consultation' }), 'cabinet');
  assert.equal(serviceRoute({ type: ' Consultation ', department_id: 5 }, L), 'lab', 'регистр и пробелы');
  assert.equal(groupDecides({ type: 'consultation' }), false);
  for (const g of ['lab', 'procedure', 'imaging', 'radiology', 'other']) assert.equal(groupDecides({ type: g }), true, g);
  assert.equal(groupDecides({}), false);
  // УЗИ / ЭКГ группы «Диагностика» — по-прежнему всегда кабинет, при любых подсказках
  for (const g of ['imaging', 'radiology', 'other']) {
    for (const hint of [{ department_id: 5 }, { department_id: 3 }, { type_id: 2 }, { type_id: 9 }, { type_id: 10 }, { department_id: 5, type_id: 2 }]) {
      assert.equal(serviceRoute({ type: g, ...hint }, L), 'cabinet', g + ' ' + JSON.stringify(hint));
    }
  }
});

test('needsPerformer идёт тем же маршрутом: анализ группы «Консультации» из отделения «Лаборатория» исполнителя не требует', () => {
  assert.equal(needsPerformer({ type: 'consultation', departments: { kind: 'laboratory' } }), false);
  assert.equal(needsPerformer({ type: 'consultation', service_types: { name: 'Лаборатория' } }), false);
  assert.equal(needsPerformer({ type: 'consultation', departments: { kind: 'procedure' } }), false);
  assert.equal(needsPerformer({ type: 'consultation', department_id: 5 }, L), false, 'по справочнику');
  assert.equal(needsPerformer({ type: 'consultation', departments: { kind: 'laboratory' }, requires_doctor: 1 }), true, '«нужен врач» — всегда');
  assert.equal(needsPerformer({ type: 'consultation', departments: { kind: 'clinical' } }), true);
  assert.equal(needsPerformer({ type: 'consultation' }), true);
  assert.equal(needsPerformer({ type: 'imaging', departments: { kind: 'laboratory' }, service_types: { name: 'Лаборатория' } }), true, 'УЗИ группы «Диагностика» — врачу');
  for (const svc of [{ type: 'consultation', departments: { kind: 'laboratory' } }, { type: 'imaging', departments: { kind: 'procedure' } }, { type: 'consultation' }]) {
    assert.equal(needsPerformer(svc), serviceRoute(svc) === 'cabinet', JSON.stringify(svc));
  }
});

test('строка без группы — прежнее правило: отделение и тип каталога', () => {
  assert.equal(serviceRoute({ department_id: 5 }, L), 'lab');
  assert.equal(serviceRoute({ type_id: 9 }, L), 'lab');
  assert.equal(serviceRoute({ department_id: 3 }, L), 'procedure');
  assert.equal(serviceRoute({ departments: { kind: 'laboratory' } }), 'lab');
  assert.equal(serviceRoute({ dept_kind: 'procedure' }), 'procedure');
  assert.equal(serviceRoute({ type: 'xray', department_id: 6 }, L), 'cabinet', 'неизвестная группа = без группы');
  assert.equal(serviceRoute({}, L), 'cabinet');
  assert.equal(serviceRoute(null), 'cabinet');
  assert.equal(serviceGroup({ type: 'xray' }), '');
  assert.equal(goesToCabinet({ type: 'imaging', type_id: 9 }, L), true);
  assert.ok(LAB_NAME_RE.test('Лабораторная диагностика') && LAB_NAME_RE.test('Lab tests') && !LAB_NAME_RE.test('Диагностика'));
});

test('SQL сервера — то же правило: группа «Диагностика» из отделения видом «Процедурный» — не процедура', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const dep = Number(db.prepare("INSERT INTO departments (name, kind) VALUES ('Кабинет функциональной диагностики', 'procedure')").run().lastInsertRowid);
    const S = db.prepare('INSERT INTO services (id, name, price, type, department_id) VALUES (?, ?, 0, ?, ?)');
    S.run(1, 'ЭКГ', 'imaging', dep);       // A12
    S.run(2, 'Капельница', 'procedure', null);
    S.run(3, 'Перевязка', 'procedure', dep);
    S.run(4, 'Массаж (группа по умолчанию)', 'consultation', dep);   // «Консультации» — отделение решает
    S.run(5, 'Приём', 'consultation', null);
    S.run(6, 'Рентген', 'radiology', dep);
    const ids = db.prepare(`SELECT s.id FROM services s LEFT JOIN departments d ON d.id = s.department_id
                             WHERE s.id IN (1,2,3,4,5,6) AND ${procedureSql('s', 'd')} ORDER BY s.id`).all().map((r) => r.id);
    assert.deepEqual(ids, [2, 3, 4]);
    // клиент и сервер — одно правило: SQL совпадает с serviceRoute на каждой строке
    const rows = db.prepare(`SELECT s.id, s.type, d.kind AS dept_kind, ${procedureSql('s', 'd')} AS isProc
                               FROM services s LEFT JOIN departments d ON d.id = s.department_id WHERE s.id IN (1,2,3,4,5,6)`).all();
    for (const r of rows) assert.equal(r.isProc === 1, serviceRoute({ type: r.type, dept_kind: r.dept_kind || '' }) === 'procedure', 'строка ' + r.id);
    const hinted = (type) => db.prepare(`SELECT ${hintedSql('s')} AS h FROM (SELECT ? AS type) s`).get(type).h === 1;
    for (const g of [null, '', 'xray', 'consultation', 'lab', 'procedure', 'imaging', 'radiology', 'other']) {
      assert.equal(hinted(g), !groupDecides({ type: g }), 'hintedSql = !groupDecides для ' + g);
    }
    // Колонка services.type NOT NULL (мигр. 023): у сохранённой услуги группа есть ВСЕГДА — ветка «без группы»
    // в SQL срабатывает только у строки без услуги.
    assert.equal(db.prepare(`SELECT ${noGroupSql('s')} AS ng FROM (SELECT NULL AS type) s`).get().ng, 1);
    assert.equal(db.prepare(`SELECT ${noGroupSql('s')} AS ng FROM (SELECT 'imaging' AS type) s`).get().ng, 0);
    assert.deepEqual([...SERVICE_GROUPS].sort(), ['consultation', 'imaging', 'lab', 'other', 'procedure', 'radiology']);
  } finally { db.close(); }
});

// LAB_NO_DOCTOR_V1 (3.23.0) — анализ, оставленный в группе «Консультации» (умолчание колонки)
// без подсказок отделения и типа, уходит в кабинет (needsPerformer), но исполнитель ему не
// обязателен: решает флаг «нужен врач» (0 из базы). «Диагностика» — как прежде (D1).
test('LAB_NO_DOCTOR_V1: performerRequired — у группы «Консультации» решает requires_doctor; «Диагностика» и флаг 1 — обязателен', () => {
  assert.equal(performerRequired({ type: 'consultation', requires_doctor: 0 }), false, 'анализ в «Консультациях» держит «Далее»');
  assert.equal(performerRequired({ type: '', requires_doctor: 0 }), false, 'строка без группы — так же');
  assert.equal(performerRequired({ type: 'consultation', requires_doctor: 1 }), true);
  assert.equal(performerRequired({ type: 'consultation' }), true, 'флага нет — как прежде');
  assert.equal(performerRequired({ type: 'imaging', requires_doctor: 0 }), true, 'УЗИ «Диагностики» — исполнитель обязателен (D1)');
  assert.equal(performerRequired({ type: 'other', requires_doctor: 0 }), true);
  assert.equal(performerRequired({ type: 'lab', requires_doctor: 0 }), false);
  assert.equal(performerRequired({ type: 'consultation', requires_doctor: 0, departments: { kind: 'laboratory' } }), false);
});

// LAB_NO_DOCTOR_V1 (ревью, решение координатора b) — ОДНО ПРАВИЛО ИСПОЛНИТЕЛЯ НА ВСЕ ЭКРАНЫ.
// Требовать / не пускать дальше / ставить исполнителя самим — только performerRequired;
// «нужен врач СО ВРЕМЕНЕМ» — только requires_doctor. Запасной список «все врачи» — только
// услуге, которой исполнитель обязателен: анализу, оставленному в «Консультациях», врача не
// подставляют; «Диагностике» с requires_doctor = 0 — как прежде (D1, без времени).
test('LAB_NO_DOCTOR_V1: doctorPoolFor — запасной «все врачи» только услуге, которой исполнитель обязателен', async () => {
  const { doctorPoolFor } = await import('../admin/views/doctor-pool.js');
  const docs = [{ id: 7, is_doctor: 1 }, { id: 8, is_doctor: 1 }];
  assert.deepEqual(doctorPoolFor(docs, { id: 31, type: 'consultation', requires_doctor: 0 }).map((d) => d.id), [], 'анализу в «Консультациях» подставлены все врачи');
  assert.deepEqual(doctorPoolFor(docs, { id: 31, type: 'imaging', requires_doctor: 0 }).map((d) => d.id), [7, 8], 'УЗИ без исполнителя — выбор из всех врачей (D1)');
  assert.deepEqual(doctorPoolFor(docs, { id: 31, type: 'consultation', requires_doctor: 1 }).map((d) => d.id), [7, 8]);
  assert.deepEqual(doctorPoolFor(docs, { id: 31, type: 'lab', requires_doctor: 0 }).map((d) => d.id), []);
});

test('LAB_NO_DOCTOR_V1: ни один экран не требует исполнителя по needsPerformer мимо performerRequired', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'views');
  const offences = [];
  for (const f of fs.readdirSync(VIEWS).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const code = fs.readFileSync(path.join(VIEWS, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    code.split(/\r?\n/).forEach((L, i) => { if (/\bneedsPerformer\s*\(/.test(L)) offences.push(`${f}:${i + 1}: ${L.trim()}`); });
  }
  assert.deepEqual(offences, [], 'экран решает об исполнителе по needsPerformer:\n' + offences.join('\n'));
});
