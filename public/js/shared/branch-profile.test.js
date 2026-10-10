// BRANCH_PROFILE_V1 — профиль здания: колонки, проверки, одно место на адрес
// здания, «скрытое здание прячет врачей», что синхронизация может записать.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_PROFILE_COLUMNS, BRANCH_SYNC_COLUMNS, BRANCH_MAIN_COLUMNS, BRANCH_LOCAL_COLUMNS, BRANCH_EDIT_COLUMNS,
  OWN_FROM_COMPANY, BRANCH_MESSAGES, LANDMARK_MAX,
  normalizeBranch, branchProblems, storedBranchProblems, syncableBranchValue, overlayOwnBuilding, branchAllowsDoctor,
  PHONE_MAX, ownBuildingProblems,   // BRANCH_PROFILE_V1 (ревью шага 4, #3)
} from './branch-profile.js';
import { PROFILE_MESSAGES, COMPANY_BUILDING, NAME_MAX, STREET_MAX } from './clinic-profile.js';
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

// BRANCH_PROFILE_V1 (ревью шага 4, #3) — ЧТО ПРИНЯЛ /api/db ГЛАВНОГО, ТО
// ПРИМЕТ И ФИЛИАЛ. Приём филиала пропускает значение длиннее предела
// (syncableBranchValue), и раньше /api/db такое значение принимал: улица в 184
// знака сохранялась в главном и никогда не доезжала до филиала, а повторная
// синхронизация молча считала «изменений нет». Пределы — одни на обе стороны.
const LIMITS = [['name', NAME_MAX], ['name_uz', NAME_MAX], ['name_en', NAME_MAX], ['phone', PHONE_MAX],
  ['street_ru', STREET_MAX], ['street_uz', STREET_MAX], ['street_en', STREET_MAX],
  ['landmark_ru', LANDMARK_MAX], ['landmark_uz', LANDMARK_MAX], ['landmark_en', LANDMARK_MAX]];

test('пределы длины: /api/db отказывает тому, что приём филиала пропустил бы, — с полем и пределом', () => {
  assert.deepEqual([NAME_MAX, PHONE_MAX, STREET_MAX, LANDMARK_MAX], [120, 64, 160, 160]);
  for (const [col, max] of LIMITS) {
    assert.deepEqual(storedBranchProblems({ [col]: 'ж'.repeat(max) }), {}, col + ' ровно ' + max);
    assert.equal(storedBranchProblems({ [col]: 'ж'.repeat(max + 1) })[col], BRANCH_MESSAGES['long' + max], col + ' длиннее ' + max);
  }
  const long = 'ул. ' + 'Очень длинная улица '.repeat(9);   // 184 знака — находка ревью
  assert.equal(storedBranchProblems({ street_ru: long, name_uz: 'x'.repeat(200), phone: '9'.repeat(80) }).street_ru, BRANCH_MESSAGES.long160);
  assert.deepEqual(Object.keys(storedBranchProblems({ street_ru: long, name_uz: 'x'.repeat(200), phone: '9'.repeat(80) })).sort(),
    ['name_uz', 'phone', 'street_ru']);
});

test('свойство: значение, которое принимает /api/db, принимает и приём филиала (каждая колонка, что едет)', () => {
  const POOL = ['', ' ', 'Юнусабад', 'tashkent-city', 'a b', '"><b>', '+998 71 200 12 00', 'https://yandex.uz/maps/-/CDabc',
    'HTTPS://YANDEX.UZ/maps/x', 'https://maps.google.com/x', ' https://yandex.uz/maps/-/CD', '9:00'];
  for (const n of [63, 64, 65, 119, 120, 121, 159, 160, 161, 499, 500, 501]) POOL.push('x'.repeat(n), 'https://yandex.uz/maps/' + 'a'.repeat(n));
  let checked = 0;
  for (const col of BRANCH_SYNC_COLUMNS) {
    // В базе show_public — 0/1 (CHECK мигр. 241); /api/db принимает и true/false — выгрузка отдаёт уже 0/1.
    const values = col === 'show_public' ? [0, 1] : POOL;
    for (const v of values) {
      if (storedBranchProblems({ [col]: v })[col]) continue;
      checked += 1;
      assert.equal(syncableBranchValue(col, v), true, col + ' = ' + JSON.stringify(v).slice(0, 60));
    }
  }
  assert.ok(checked > 200, 'перебор не пуст: ' + checked);
});

test('«Компания» главного здания: адрес для партнёров, карта и телефон уезжают в филиалы — те же пределы и формат', () => {
  assert.deepEqual(ownBuildingProblems({ phone: '9'.repeat(PHONE_MAX), street_ru: 'ж'.repeat(STREET_MAX), region_code: 'tashkent-city',
    maps_url: 'https://yandex.uz/maps/-/CDm', clinic_name: 'ж'.repeat(500), about_ru: 'ж'.repeat(5000), address: 'ж'.repeat(500) }), {},
    'общее для клиники и адрес для документов — не дело этой проверки');
  const p = ownBuildingProblems({ phone: '9'.repeat(PHONE_MAX + 1), street_en: 'x'.repeat(STREET_MAX + 1), district_code: 'a b',
    maps_url: 'https://maps.google.com/x' });
  assert.deepEqual(p, { phone: BRANCH_MESSAGES.long64, street_en: BRANCH_MESSAGES.long160, district_code: BRANCH_MESSAGES.code,
    maps_url: PROFILE_MESSAGES.maps });
  assert.deepEqual(ownBuildingProblems(null), {});
  assert.deepEqual(ownBuildingProblems([{ phone: '9'.repeat(99) }]), {}, 'пачку перебирает вызывающий');
  // Что прошло проверку «Компании», доезжает до филиала целиком (overlayOwnBuilding → syncableBranchValue).
  const company = { phone: '+998 71 200 12 00', country_code: 'UZ', region_code: 'tashkent-city', district_code: 'mirobod',
    street_ru: 'ж'.repeat(STREET_MAX), street_uz: '', street_en: 'x', maps_url: 'https://yandex.uz/maps/-/CDm' };
  assert.deepEqual(ownBuildingProblems(company), {});
  const row = overlayOwnBuilding({ id: 1, name: 'Главный корпус' }, company);
  for (const c of OWN_FROM_COMPANY) assert.equal(syncableBranchValue(c, row[c]), true, c);
});
