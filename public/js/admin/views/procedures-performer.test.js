// PROC_PERFORMER_V1 — то, что экраны обязаны продолжать делать.
//
// ЧИТАЕТ ТЕКСТ, А НЕ ИМПОРТИРУЕТ ЭКРАНЫ: views/procedures.js и
// views/service-picker-modal.js тянут ui.js и supabase.js и требуют DOM
// (`import` падает на `document is not defined`). Тот же приём и та же
// причина, что у visit-bill-origin.test.js, branch-sync-i18n.test.js и
// updates-i18n.test.js рядом.
//
// Проверяются ровно четыре вещи, каждая из которых уже была ошибкой:
//
//   1. ИНВАРИАНТ is_doctor. Список врачей обязан проверять флаг is_doctor, а не
//      слово в role: администратор клиники, который ведёт приём, иначе
//      исчезает из списка. Это чинили в шести фильтрах SPA — и повторять не
//      будем.
//   2. ВЫБРАННЫЙ ИСПОЛНИТЕЛЬ ИЩЕТСЯ СРЕДИ ВСЕХ. `state.doctors.find(d => d.id
//      === state.doctorId)` был багом, а не стилем: медсестры в state.doctors
//      нет, и её выбор молча превращался в null.
//   3. ОЧЕРЕДЬ ПРОЦЕДУР НЕ СОБИРАЕТСЯ В БРАУЗЕРЕ. Экран обязан звать
//      procedures_list; свой запрос к visit_services вернул бы половину
//      (палатных процедур в этой таблице нет) и своё правило видимости.
//   4. ПАЛАТНАЯ ПРОЦЕДУРА НЕ ПИШЕТ admission_services.doctor_id — это лечащий
//      врач и деньги (шапка миграции 102).
//
// Плюс: все строки экрана есть в словаре на трёх языках, и все размеры шрифта
// взяты из шкалы.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const procSrc   = fs.readFileSync(path.join(HERE, 'procedures.js'), 'utf8');
const pickerSrc = fs.readFileSync(path.join(HERE, 'service-picker-modal.js'), 'utf8');

test('инвариант ADMIN_DOCTOR_LIST_V1: список врачей проверяет is_doctor, а не только role', () => {
  assert.match(pickerSrc, /u\.is_doctor === true \|\| \(u\.role \|\| ''\)\.toLowerCase\(\) === 'doctor'/,
    'фильтр врачей обязан начинаться с флага is_doctor');
  // Предикат исполнителя — тот же инвариант: сначала флаг, потом роль.
  assert.match(pickerSrc, /function isProcedurePerformer\(u\) \{[\s\S]{0,200}?u\.is_doctor === true/,
    'isProcedurePerformer обязан спрашивать is_doctor');
  assert.match(pickerSrc, /PROC_ROLES = \['doctor', 'head_doctor', 'nurse', 'senior_nurse'\]/,
    'медсестра и старшая медсестра — исполнители');
});

test('выбранный исполнитель ищется среди ВСЕХ сотрудников, а не только среди врачей', () => {
  assert.equal(
    (pickerSrc.match(/state\.doctors\.find\(d => d\.id === state\.doctorId\)/g) || []).length, 0,
    'ни одного поиска выбранного исполнителя только среди врачей не осталось');
  assert.match(pickerSrc, /function providerById\(id\) \{/);
  assert.match(pickerSrc, /function currentDoctor\(\) \{ return providerById\(state\.doctorId\); \}/);
});

test('у процедуры без назначенных ставок колонка исполнителей не пустая', () => {
  // Раньше: isCabinetRouted('procedure') === false → candidatesFor вернул бы
  // пустой список, регистратура сохранила бы строку без исполнителя, и
  // процедура не пришла бы никому.
  assert.match(pickerSrc, /function isProcedureRouted\(svc\)/);
  assert.match(pickerSrc, /if \(isProcedureRouted\(svc\)\) return state\.procStaff \|\| state\.doctors;/);
  assert.match(pickerSrc, /state\.procStaff = \(doctors \|\| \[\]\)\.filter\(isProcedurePerformer\);/);
});

test('очередь процедур собирается сервером, а не браузером', () => {
  assert.match(procSrc, /supabase\.rpc\('procedures_list'/);
  assert.match(procSrc, /supabase\.rpc\('procedure_assign'/);
  assert.match(procSrc, /supabase\.rpc\('procedure_complete'/);
  // Свой запрос очереди к visit_services вернул бы половину списка и своё
  // правило видимости. Остаётся ровно один прямой запрос — список списанных
  // товаров визита (loadProcItems), и он не про очередь.
  const selects = procSrc.match(/supabase\.from\('visit_services'\)/g) || [];
  assert.equal(selects.length, 1, 'единственный прямой запрос — расходники визита');
  assert.doesNotMatch(procSrc, /from\('visit_services'\)[\s\S]{0,400}?\.update\(/,
    'экран больше не пишет в visit_services напрямую');
  assert.doesNotMatch(procSrc, /supabase\.from\('admission_services'\)/,
    'палатную строку экран трогает только через RPC');
});

test('палатная процедура не пишет doctor_id — это лечащий врач и деньги', () => {
  const rpcSrc = fs.readFileSync(
    path.join(HERE, '..', '..', '..', '..', 'server', 'services', 'rpc', 'procedures.js'), 'utf8');
  assert.doesNotMatch(rpcSrc, /UPDATE admission_services[\s\S]{0,300}?doctor_id\s*=/,
    'ни один путь не переписывает лечащего врача палатной строки');
  assert.match(rpcSrc, /performer_id = COALESCE\(performer_id, \?\)/);
});

test('все строки экрана процедур переведены на три языка', () => {
  const re = /\btrf?\(\s*'((?:[^'\\]|\\.)*)'/g;
  const missing = [];
  let m;
  while ((m = re.exec(procSrc))) {
    const key = m[1].replace(/\\'/g, "'");
    const row = STRINGS[key];
    if (!row || !row.ru || !row.uz || !row.en) missing.push(key);
  }
  assert.deepEqual(missing, [], 'строки без перевода');
});

test('размеры шрифта — только из шкалы', () => {
  const ALLOWED = new Set(['12.5', '13.5', '15', '17', '20', '24', '30', '40']);
  const bad = [];
  for (const src of [procSrc]) {
    const re = /font-size:\s*'?([0-9.]+)px/g;
    let m;
    while ((m = re.exec(src))) if (!ALLOWED.has(m[1])) bad.push(m[1]);
    const re2 = /fontSize:\s*'([0-9.]+)px'/g;
    while ((m = re2.exec(src))) if (!ALLOWED.has(m[1])) bad.push(m[1]);
  }
  assert.deepEqual([...new Set(bad)], [], 'размеры вне шкалы 12.5/13.5/15/17/20/24/30/40');
});
