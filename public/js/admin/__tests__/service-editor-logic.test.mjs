// SERVICE_EDITOR_V1 — решения редактора услуги, отдельно от рисования.
// Дизайн: docs/plans/2026-08-31-service-editor-design.md
//
// Здесь проверяется то, ради чего редактор существует и чем он ОПАСЕН:
//
//   1. users.service_rates — общий магазин: его редактируют карточка сотрудника
//      И этот диалог, а reports.js доктор-пэй читает ($.pct). Слияние обязано
//      трогать ТОЛЬКО запись этой услуги и переживать любой мусор в колонке —
//      затёртая ставка другого врача не всплывёт неделями, до первого расчёта
//      зарплаты.
//   2. Комбобокс «выбери или впиши» не должен плодить двойников: «Терапия»,
//      набранная ещё раз (с пробелами, в другом регистре), — это ВЫБОР
//      существующей строки, а не создание новой.
//   3. Врач определяется ТОЛЬКО по is_doctor — инвариант, который однажды уже
//      сломал шесть фильтров (см. память проекта: role-текст и specialty врут
//      для админов-врачей и для врачей без специальности).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_SECTIONS, labBlockVisible, normName, resolveCombobox,
  splitPerformers, currentPerformerIds, performerGate,
  ratesArray, mergeServiceRates,
} from '../service-editor-logic.js';

// ---------------------------------------------------------------------------
// Раздел → services.type — ровно шесть пар из утверждённого дизайна.
// ---------------------------------------------------------------------------

test('Раздел маппится на СУЩЕСТВУЮЩИЙ enum services.type, без новых значений', () => {
  assert.deepEqual(
    SERVICE_SECTIONS.map((s) => [s.label, s.type]),
    [
      ['Консультация', 'consultation'],
      ['Лаборатория', 'lab'],
      ['Процедура', 'procedure'],
      ['Диагностика', 'imaging'],
      ['Рентген', 'radiology'],
      ['Другое', 'other'],
    ],
  );
});

test('лабораторный блок виден ТОЛЬКО при разделе «лаборатория»', () => {
  assert.equal(labBlockVisible('lab'), true);
  for (const t of ['consultation', 'procedure', 'imaging', 'radiology', 'other', '', undefined]) {
    assert.equal(labBlockVisible(t), false, String(t));
  }
});

// ---------------------------------------------------------------------------
// Комбобокс: выбрать существующее ИЛИ создать. Правило «то же имя» одно на
// клиент и сервер (сервер импортирует normName), и оно же, что у усыновления
// в branch-sync/catalogue.js: trim + без учёта регистра.
// ---------------------------------------------------------------------------

test('normName: та же нормализация, что у усыновления в catalogue.js', () => {
  assert.equal(normName('  Терапия  '), 'терапия');
  assert.equal(normName('ТЕРАПИЯ'), 'терапия');
  assert.equal(normName(null), '');
  assert.equal(normName(undefined), '');
});

test('набранное имя существующей строки — это ВЫБОР, а не двойник', () => {
  const rows = [{ id: 3, name: 'Терапия' }, { id: 7, name: 'Хирургия' }];
  assert.deepEqual(resolveCombobox('Терапия', rows), { id: 3 });
  // Регистр и пробелы — самые частые способы набрать «то же самое» иначе.
  assert.deepEqual(resolveCombobox('  терапия ', rows), { id: 3 });
  assert.deepEqual(resolveCombobox('ХИРУРГИЯ', rows), { id: 7 });
});

test('новое имя уходит на создание — обрезанным, как его и сохранят', () => {
  assert.deepEqual(resolveCombobox(' Новая категория ', [{ id: 1, name: 'Терапия' }]),
    { name: 'Новая категория' });
  assert.deepEqual(resolveCombobox('УЗИ', []), { name: 'УЗИ' });
  assert.deepEqual(resolveCombobox('УЗИ', undefined), { name: 'УЗИ' });
});

test('пустой комбобокс — это «без значения», не создание пустой строки', () => {
  assert.equal(resolveCombobox('', [{ id: 1, name: 'Терапия' }]), null);
  assert.equal(resolveCombobox('   ', []), null);
  assert.equal(resolveCombobox(null, []), null);
});

// ---------------------------------------------------------------------------
// Исполнители. is_doctor — ЕДИНСТВЕННЫЙ признак врача.
// ---------------------------------------------------------------------------

test('врач — только is_doctor: role-текст и specialty не голосуют', () => {
  const users = [
    { id: 1, full_name: 'Админ-врач', role: 'admin', specialty: '', is_doctor: 1 },
    { id: 2, full_name: 'Врач без специальности', role: 'doctor', specialty: '', is_doctor: true },
    // role='doctor' у НЕ-врача — ровно тот случай, на котором ломались фильтры.
    { id: 3, full_name: 'Ошибочная роль', role: 'doctor', specialty: 'Кардиолог', is_doctor: 0 },
    { id: 4, full_name: 'Медсестра', role: 'nurse', specialty: '', is_doctor: false },
  ];
  const { doctors, others } = splitPerformers(users);
  assert.deepEqual(doctors.map((u) => u.id), [1, 2]);
  assert.deepEqual(others.map((u) => u.id), [3, 4]);
});

test('текущие исполнители услуги — те, у кого в service_rates есть её запись', () => {
  const users = [
    { id: 1, service_rates: [{ service_id: 5, pct: 30 }] },
    { id: 2, service_rates: [{ service_id: 9, pct: 40 }] },
    { id: 3, service_rates: '' },                                   // колонка DEFAULT ''
    { id: 4, service_rates: '[{"service_id":"5","pct":25}]' },      // строка и строковый id — переживаем
    { id: 5, service_rates: '{broken' },                            // мусор не роняет открытие диалога
  ];
  assert.deepEqual(currentPerformerIds(users, 5), [1, 4]);
});

test('гейт: «оказывает специалист» без единого исполнителя — отказ с внятной фразой', () => {
  const refused = performerGate(true, 0);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Отметьте хотя бы одного исполнителя (врача или медсестру).');
  assert.deepEqual(performerGate(true, 2), { ok: true });
  // Без галки исполнители не требуются — услуга без специалиста легальна.
  assert.deepEqual(performerGate(false, 0), { ok: true });
});

// ---------------------------------------------------------------------------
// Слияние users.service_rates — сердце опасности этого редактора.
// ---------------------------------------------------------------------------

test('тик нового исполнителя добавляет запись формы reports.js: service_id, pct, branches', () => {
  const { changed, rates } = mergeServiceRates('', 5, true, 30, [1, 2]);
  assert.equal(changed, true);
  assert.deepEqual(rates, [{ service_id: 5, pct: 30, branches: [1, 2] }]);
});

test('уже существующая запись исполнителя НЕ перезаписывается — персональная ставка живёт в карточке', () => {
  const stored = [{ service_id: 5, pct: 50, fix: 20000, price: 90000, branches: [2] }];
  const { changed, rates } = mergeServiceRates(JSON.stringify(stored), 5, true, 30, [1, 2]);
  assert.equal(changed, false, 'нечего писать — членство уже есть');
  assert.deepEqual(rates, stored, 'fix/price/branches персональной записи неприкосновенны');
});

test('снятие тика убирает ТОЛЬКО запись этой услуги; чужие услуги — байт в байт', () => {
  const stored = [
    { service_id: 3, pct: 45, note_key: 'нестандартное поле — тоже уезжает целым' },
    { service_id: 5, pct: 30, branches: [] },
    { service_id: 9, pct: 20, fix: 5000 },
  ];
  const { changed, rates } = mergeServiceRates(JSON.stringify(stored), 5, false, 0, []);
  assert.equal(changed, true);
  assert.deepEqual(rates, [stored[0], stored[2]], 'порядок и содержимое остальных записей сохранены');
});

test('снятие тика у того, кого и не было, — не изменение (и не UPDATE каждой строки users)', () => {
  const stored = [{ service_id: 9, pct: 20 }];
  const { changed, rates } = mergeServiceRates(JSON.stringify(stored), 5, false, 0, []);
  assert.equal(changed, false);
  assert.deepEqual(rates, stored);
});

test('строковые id в старых данных находятся числовым сравнением', () => {
  const { changed, rates } = mergeServiceRates('[{"service_id":"5","pct":25}]', 5, false, 0, []);
  assert.equal(changed, true);
  assert.deepEqual(rates, []);
});

test('доля по умолчанию зажимается в 0..100 — как в parseRates на приёме users', () => {
  assert.equal(mergeServiceRates('', 5, true, 150, []).rates[0].pct, 100);
  assert.equal(mergeServiceRates('', 5, true, -3, []).rates[0].pct, 0);
  assert.equal(mergeServiceRates('', 5, true, NaN, []).rates[0].pct, 0);
  assert.equal(mergeServiceRates('', 5, true, '35', []).rates[0].pct, 35);
});

test('испорченный JSON никогда не «чинится» перезаписью — corrupt, и вызывающий решает', () => {
  const out = mergeServiceRates('{broken json', 5, true, 30, []);
  assert.equal(out.corrupt, true);
  assert.equal(out.changed, false);
  assert.equal(out.rates, null, 'писать нечего — данные человека не наши, чтобы их терять');
  // Непустой, валидный, но НЕ-массив — тот же случай.
  assert.equal(mergeServiceRates('{"a":1}', 5, true, 30, []).corrupt, true);
});

test('ratesArray терпит все реальные формы колонки: массив, строку, пусто, мусор', () => {
  assert.deepEqual(ratesArray([{ service_id: 1 }]).rates, [{ service_id: 1 }]);
  assert.deepEqual(ratesArray('[{"service_id":1}]').rates, [{ service_id: 1 }]);
  assert.deepEqual(ratesArray('').rates, []);
  assert.deepEqual(ratesArray(null).rates, []);
  assert.equal(ratesArray('xx').corrupt, true);
});
