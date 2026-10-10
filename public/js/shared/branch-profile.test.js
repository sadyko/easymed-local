// BRANCH_PROFILE_V1 — профиль здания: колонки, проверки, одно место на адрес
// здания, «скрытое здание прячет врачей», что синхронизация может записать.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_PROFILE_COLUMNS, BRANCH_SYNC_COLUMNS, BRANCH_MAIN_COLUMNS, BRANCH_LOCAL_COLUMNS, BRANCH_EDIT_COLUMNS,
  OWN_FROM_COMPANY, BRANCH_MESSAGES, LANDMARK_MAX,
  normalizeBranch, branchProblems, storedBranchProblems, syncableBranchValue, overlayOwnBuilding, branchAllowsDoctor,
} from './branch-profile.js';
import { PROFILE_MESSAGES, COMPANY_BUILDING } from './clinic-profile.js';
import { HOURS_MESSAGES } from './branch-hours.js';
import { readableColumns, writableColumns } from '../../../server/db/schema-registry.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('колонки: главное и своё у установки не пересекаются; всё читается и пишется по реестру', () => {
  assert.equal(BRANCH_MAIN_COLUMNS.filter((c) => BRANCH_LOCAL_COLUMNS.includes(c)).length, 0);
  for (const c of BRANCH_EDIT_COLUMNS) {
    assert.ok(readableColumns('branches').includes(c), 'не читается ' + c);
    assert.ok(writableColumns('branches', 'update').includes(c), 'не пишется ' + c);
  }
  for (const c of BRANCH_PROFILE_COLUMNS) assert.ok(writableColumns('branches', 'insert').includes(c), 'не вставляется ' + c);
  assert.deepEqual(BRANCH_SYNC_COLUMNS, ['phone', ...BRANCH_PROFILE_COLUMNS]);
  assert.ok(!BRANCH_EDIT_COLUMNS.includes('letter') && !BRANCH_EDIT_COLUMNS.includes('address'), 'буква — дело связи зданий; прежний адрес не правится (Р3)');
  for (const c of OWN_FROM_COMPANY) assert.ok(COMPANY_BUILDING.includes(c), c + ' — своё у здания в «Компании» (шаг 3)');
});

test('главное здание: адрес для партнёров, карта и телефон — из его «Компании»; остальное — из строки', () => {
  const row = { id: 1, name: 'Главный корпус', street_ru: 'не отсюда', phone: 'старый', landmark_ru: 'у парка', show_public: 1 };
  const company = { country_code: 'UZ', region_code: 'tashkent-city', district_code: 'mirobod', street_ru: 'ул. Мира, 1',
    street_uz: '', street_en: '', maps_url: 'https://yandex.uz/maps/-/CDm', phone: '+998 71 200 12 00', clinic_name: 'Шифо' };
  const v = overlayOwnBuilding(row, company);
  assert.deepEqual(OWN_FROM_COMPANY.map((c) => v[c]), OWN_FROM_COMPANY.map((c) => company[c]));
  assert.equal(v.landmark_ru, 'у парка', 'ориентир — из «Филиалов»');
  assert.equal(v.name, 'Главный корпус', 'название здания — не название клиники');
  assert.ok(!('clinic_name' in v));
  assert.equal(overlayOwnBuilding(row, null), row);
  assert.equal(overlayOwnBuilding(row, []), row);
  assert.equal(overlayOwnBuilding(row, { phone: '+1' }).street_ru, 'не отсюда', 'база до 240: колонок «Компании» нет — строка как есть');
});

test('скрытое здание прячет своих врачей; врач без здания и врач открытого здания — нет', () => {
  const branches = new Map([[5, { id: 5, show_public: 0 }], [6, { id: 6, show_public: 1 }]]);
  assert.equal(branchAllowsDoctor({ branch_id: 5 }, branches), false);
  assert.equal(branchAllowsDoctor({ branch_id: '5' }, branches), false);
  assert.equal(branchAllowsDoctor({ branch_id: 6 }, branches), true);
  assert.equal(branchAllowsDoctor({ branch_id: null }, branches), true, 'врач без здания этим правилом не прячется');
  assert.equal(branchAllowsDoctor({ branch_id: 99 }, branches), true, 'здания нет в списке — прятать нечем');
});

test('нормализация: пробелы по краям, отметки — 0/1', () => {
  const v = normalizeBranch({ name: ' Юнусабад ', street_ru: ' ул. Мира, 1 ', maps_url: ' ', phone: ' +998 ', show_public: true, active: '0', is_24_7: false });
  assert.deepEqual([v.name, v.street_ru, v.maps_url, v.phone], ['Юнусабад', 'ул. Мира, 1', '', '+998']);
  assert.deepEqual([v.show_public, v.active, v.is_24_7], [1, 0, 0]);
});

test('экран: название RU обязательно; адрес — всё или ничего; карта — только Яндекс', () => {
  assert.deepEqual(branchProblems({ name: 'Юнусабад' }), {});
  assert.equal(branchProblems({ name: ' ' }).name, BRANCH_MESSAGES.name);
  assert.equal(branchProblems({ name: 'X', street_ru: 'ул. Мира, 1' }).region_code, PROFILE_MESSAGES.region);
  assert.equal(branchProblems({ name: 'X', maps_url: 'https://maps.google.com/x' }).maps_url, PROFILE_MESSAGES.maps);
  assert.deepEqual(branchProblems({ name: 'X', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1',
    maps_url: 'https://yandex.uz/maps/-/CDabc' }), {});
});

test('сервер: формат карты, часов, отметок и кодов; неприсланное не проверяется', () => {
  assert.deepEqual(storedBranchProblems({ name: 'Любое', phone: 'что угодно' }), {});
  assert.equal(storedBranchProblems({ maps_url: 'https://maps.google.com/x' }).maps_url, PROFILE_MESSAGES.maps);
  assert.equal(storedBranchProblems({ maps_url: ' https://yandex.uz/maps/-/CDabc' }).maps_url, PROFILE_MESSAGES.maps, 'сервер не приводит за экран');
  assert.equal(storedBranchProblems({ working_hours: '{"mon":{"enabled":true}}' }).working_hours, HOURS_MESSAGES.stored);
  assert.equal(storedBranchProblems({ show_public: 2 }).show_public, BRANCH_MESSAGES.flag);
  assert.equal(storedBranchProblems({ is_24_7: 'да' }).is_24_7, BRANCH_MESSAGES.flag);
  assert.equal(storedBranchProblems({ district_code: '"><b>' }).district_code, BRANCH_MESSAGES.code);
  assert.deepEqual(storedBranchProblems({ maps_url: '', working_hours: '{}', show_public: true, is_24_7: 0, active: 1,
    region_code: 'tashkent-city', district_code: '' }), {});
  assert.deepEqual(storedBranchProblems([{ maps_url: 'x' }]), {}, 'пачку перебирает вызывающий (routes/db.js)');
});

test('синхронизация: приехавшее значение пишется, только если база его примет', () => {
  assert.equal(syncableBranchValue('name_uz', 'Yunusobod'), true);
  assert.equal(syncableBranchValue('name_uz', null), false, 'null в NOT NULL уронил бы приём');
  assert.equal(syncableBranchValue('name_uz', 5), false);
  assert.equal(syncableBranchValue('name_uz', 'x'.repeat(121)), false);
  assert.equal(syncableBranchValue('landmark_ru', 'x'.repeat(LANDMARK_MAX)), true);
  assert.equal(syncableBranchValue('phone', '+998 71 200 12 00'), true);
  assert.equal(syncableBranchValue('maps_url', 'https://maps.google.com/x'), false, 'CHECK миграции 241 уронил бы приём');
  assert.equal(syncableBranchValue('maps_url', ''), true);
  assert.equal(syncableBranchValue('show_public', 0), true);
  assert.equal(syncableBranchValue('show_public', 2), false);
  assert.equal(syncableBranchValue('show_public', '1'), false);
  assert.equal(syncableBranchValue('region_code', 'tashkent-city'), true);
  assert.equal(syncableBranchValue('region_code', 'a b'), false);
});

test('каждое сообщение модуля переведено на ru / uz / en', () => {
  for (const m of Object.values(BRANCH_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});
