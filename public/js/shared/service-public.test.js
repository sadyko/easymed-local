// SERVICES_PACKAGES_V1 — услуги на сайте и у партнёров: пять групп и их коды
// для API, правило показа (RU + UZ), цифры экрана «Услуги для сайта и партнёров».
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_GROUPS, GROUP_KEYS, API_GROUPS, SERVICE_PUBLIC_MESSAGES,
  serviceGroupOf, apiGroupOf, programTypesOfApi, serviceNamesReady, serviceNames, servicePublicState,
  onlineRuleProblem, consultServiceWarning, bulkShowPlan, servicePublicFacts,
} from './service-public.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('пять групп — в порядке макета; коды для партнёров — из документации API (В4)', () => {
  assert.deepEqual(GROUP_KEYS, ['consultation', 'lab', 'imaging', 'procedure', 'other']);
  assert.deepEqual(API_GROUPS, ['consultations', 'lab', 'diagnostics', 'procedures', 'surgery']);
  assert.deepEqual(PUBLIC_GROUPS.map((g) => g.label), ['Консультации', 'Лаборатория', 'Диагностика', 'Процедуры', 'Хирургия']);
});

test('группа услуги: по services.type; radiology — диагностика; без типа — лаборатория по is_lab, иначе консультации', () => {
  assert.equal(serviceGroupOf({ type: 'imaging' }), 'imaging');
  assert.equal(serviceGroupOf({ type: 'radiology' }), 'imaging');
  assert.equal(serviceGroupOf({ type: 'other' }), 'other');
  assert.equal(serviceGroupOf({ type: '', is_lab: 1 }), 'lab');
  assert.equal(serviceGroupOf({ type: null }), 'consultation');
  assert.equal(apiGroupOf({ type: 'radiology' }), 'diagnostics');
  assert.equal(apiGroupOf({ type: 'other' }), 'surgery');
  assert.equal(apiGroupOf({ type: 'consultation' }), 'consultations');
  assert.deepEqual(programTypesOfApi('diagnostics'), ['imaging', 'radiology']);
  assert.deepEqual(programTypesOfApi('surgery'), ['other']);
  assert.equal(programTypesOfApi('dental'), null);
});

test('показ: отключённая в прайсе — никогда; без узбекского названия — нет, даже с флагом; иначе — флаг', () => {
  const s = { name: 'ОАК', name_uz: 'UQT', name_en: '', online_booking: 1, active: 1 };
  assert.equal(servicePublicState(s), 'shown');
  assert.equal(servicePublicState({ ...s, online_booking: 0 }), 'off');
  assert.equal(servicePublicState({ ...s, online_booking: true }), 'shown', 'булев с экрана — тоже');
  assert.equal(servicePublicState({ ...s, name_uz: ' ' }), 'no_uz');
  assert.equal(servicePublicState({ ...s, active: 0 }), 'inactive');
  assert.equal(serviceNamesReady({ name: 'X', name_uz: 'Y' }), true);
  assert.equal(serviceNamesReady({ name: ' ', name_uz: 'Y' }), false);
  assert.deepEqual(serviceNames({ name: ' ОАК ', name_uz: null, name_en: 'CBC' }), { ru: 'ОАК', uz: '', en: 'CBC' });
});

test('правило записи: включённый показ без названий RU и UZ — отказ теми же словами; выключенный — можно', () => {
  assert.equal(onlineRuleProblem({ name: 'ОАК', name_uz: '', online_booking: 1 }), SERVICE_PUBLIC_MESSAGES.online);
  assert.equal(onlineRuleProblem({ name: 'ОАК', name_uz: 'UQT', online_booking: '1' }), null);
  assert.equal(onlineRuleProblem({ name: 'ОАК', name_uz: '', online_booking: 0 }), null);
  assert.equal(onlineRuleProblem(null), null);
});

test('решение 12: услуга-консультация без врача или только со скрытыми врачами — предупреждение', () => {
  assert.equal(consultServiceWarning([]), 'noPerformer');
  assert.equal(consultServiceWarning([{ id: 1, shown: false }]), 'performersHidden');
  assert.equal(consultServiceWarning([{ id: 1, shown: false }, { id: 2, shown: true }]), null);
});

test('«Показать всю группу»: включает выключенные с названиями RU + UZ, остальные пропускает; чужие группы и отключённые не трогает', () => {
  const list = [
    { id: 1, type: 'lab', name: 'ОАК', name_uz: 'UQT', online_booking: 0, active: 1 },
    { id: 2, type: 'lab', name: 'Глюкоза', name_uz: '', online_booking: 0, active: 1 },
    { id: 3, type: 'lab', name: 'ТТГ', name_uz: 'TTG', online_booking: 1, active: 1 },
    { id: 4, type: 'lab', name: 'Старый', name_uz: 'Eski', online_booking: 0, active: 0 },
    { id: 5, type: 'imaging', name: 'УЗИ', name_uz: 'UTT', online_booking: 0, active: 1 },
  ];
  assert.deepEqual(bulkShowPlan(list, 'lab'), { on: [1], skipped: [2] });
  assert.deepEqual(bulkShowPlan(list, 'imaging'), { on: [5], skipped: [] });
});

test('цифры экрана: показанные из действующих; врачи на сайте с консультациями из всех; без английского — среди показанных', () => {
  const services = [
    { id: 1, name: 'ОАК', name_uz: 'UQT', name_en: 'CBC', online_booking: 1, active: 1 },
    { id: 2, name: 'Глюкоза', name_uz: 'Glyukoza', name_en: '', online_booking: 1, active: 1 },
    { id: 3, name: 'Перевязка', name_uz: '', name_en: '', online_booking: 0, active: 1 },
    { id: 4, name: 'Старая', name_uz: 'Eski', online_booking: 1, active: 0 },
  ];
  const doctors = [
    { id: 1, state: 'shown', consultations: [{ price: 150000 }] },
    { id: 2, state: 'shown', consultations: [] },
    { id: 3, state: 'off', consultations: [{ price: 1 }] },
  ];
  assert.deepEqual(servicePublicFacts(services, doctors), { services_shown: 2, services_total: 3, doctors_shown: 1, doctors_total: 3, no_en: 1 });
});

test('сообщения переведены на ru / uz / en', () => {
  for (const m of Object.values(SERVICE_PUBLIC_MESSAGES)) { const e = STRINGS[m]; assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m); }
  for (const g of PUBLIC_GROUPS) { const e = STRINGS[g.label]; assert.ok(e && e.uz && e.en, g.label); }
});
