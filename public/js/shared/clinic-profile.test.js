// CLINIC_PROFILE_V1 — правила профиля клиники: одни для экрана, /api/db и синхронизации зданий.
//
// Ответ владельца 2026-10-10 (вариант B): бланки печатают прежний address,
// вписанный руками. Колонки address_manual и сборки адреса для бланка нет —
// composeAddress собирает адрес только для API, партнёров и предпросмотра.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from './clinic-profile.js';
import {
  COMPANY_CLINIC_WIDE, COMPANY_BUILDING, COMPANY_COLUMNS, PROFILE_MESSAGES,
  normalizeWebsite, websiteProblem, normalizeHandle, handleProblem, mapsProblem, routeUrl, telHref,
  composeAddress, addressProblems, companyProblems, normalizeProfile,
} from './clinic-profile.js';
import { STRINGS } from '../admin/i18n-strings.js';
import { writableColumns } from '../../../server/db/schema-registry.js';
import { catalogByKey } from './permission-catalog.js';

test('наборы колонок: общее и своё не пересекаются; всё пишется и по праву «Компания»', () => {
  assert.equal(COMPANY_CLINIC_WIDE.filter((c) => COMPANY_BUILDING.includes(c)).length, 0);
  const upd = writableColumns('doc_settings', 'update');
  const grant = catalogByKey().get('settings.company').grantColumns.doc_settings;
  for (const c of COMPANY_COLUMNS) {
    assert.ok(upd.includes(c), 'реестр не даёт править ' + c);
    assert.ok(grant.includes(c), 'право «Компания» не открывает ' + c);
  }
  assert.ok(!COMPANY_COLUMNS.includes('lab_scope') && !COMPANY_COLUMNS.includes('paper_size'));
});

test('адрес для документов — прежний address, вписанный руками: ни отметки «вручную», ни сборки для бланка', () => {
  assert.ok(COMPANY_BUILDING.includes('address'), 'address — своё у здания и по-прежнему сохраняется экраном');
  assert.ok(!COMPANY_COLUMNS.includes('address_manual'));
  assert.equal(profile.printedAddress, undefined, 'сборки адреса для бланка нет');
});

test('сайт: домен дополняется https://, http:// и мусор — объяснение', () => {
  assert.equal(normalizeWebsite(' klinika.uz '), 'https://klinika.uz');
  assert.equal(normalizeWebsite('HTTPS://Klinika.uz/ru'), 'https://Klinika.uz/ru');
  assert.equal(websiteProblem('klinika.uz'), '');
  assert.equal(websiteProblem(''), '');
  assert.equal(websiteProblem('http://klinika.uz'), PROFILE_MESSAGES.website);
  assert.equal(websiteProblem('klinika'), PROFILE_MESSAGES.website);
});

test('Telegram и Instagram: ссылка урезается до @имени; бот — на «bot»', () => {
  assert.equal(normalizeHandle('https://t.me/klinika_bot/'), '@klinika_bot');
  assert.equal(normalizeHandle('t.me/klinika?start=1'), '@klinika');
  assert.equal(normalizeHandle('https://www.instagram.com/klinika.uz/'), '@klinika.uz');
  assert.equal(normalizeHandle('@@klinika'), '@klinika');
  assert.equal(handleProblem('telegram_bot', '@klinika_bot'), '');
  assert.equal(handleProblem('telegram_bot', '@klinika_demo'), PROFILE_MESSAGES.bot);
  assert.equal(handleProblem('telegram_channel', '@abc'), PROFILE_MESSAGES.telegram, 'Telegram — от 5 знаков');
  assert.equal(handleProblem('instagram', '@klinika.uz'), '');
  assert.equal(handleProblem('instagram', '@кли ника'), PROFILE_MESSAGES.instagram);
});

test('карта и маршрут: только Яндекс; маршрут из pt=/ll=, иначе — сама ссылка', () => {
  assert.equal(mapsProblem('https://yandex.uz/maps/-/CDabc123'), '');
  assert.equal(mapsProblem('https://yandex.ru/maps/org/shifo/123/'), '');
  assert.equal(mapsProblem('https://maps.google.com/x'), PROFILE_MESSAGES.maps);
  assert.equal(routeUrl('https://yandex.uz/maps/?ll=69.2401%2C41.2995&z=16&pt=69.2401,41.2995'),
    'https://yandex.uz/maps/?rtext=~41.2995,69.2401&rtt=auto');
  assert.equal(routeUrl('https://yandex.uz/maps/-/CDabc123'), 'https://yandex.uz/maps/-/CDabc123');
  assert.equal(routeUrl(''), '');
  assert.equal(telHref('+998 71 200-12-00'), 'tel:+998712001200');
  assert.equal(telHref('12'), '');
});

const UZ = { code: 'UZ', name: 'Узбекистан', name_uz: 'O‘zbekiston', name_en: 'Uzbekistan' };
const KZ = { code: 'KZ', name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan' };
const TASH = { code: 'tashkent-city', name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city' };
const YUN = { code: 'yunusobod', name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: '' };
const STREET = { ru: 'ул. Амира Темура, 12', uz: 'Amir Temur ko‘chasi, 12', en: '' };

test('полный адрес (API и предпросмотр): по-языковой, с русским запасом; страна — только не Узбекистан', () => {
  const parts = { country: UZ, region: TASH, district: YUN, street: STREET };
  assert.equal(composeAddress(parts, 'ru'), 'город Ташкент, Юнусабадский район, ул. Амира Темура, 12');
  assert.equal(composeAddress(parts, 'uz'), 'Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 12');
  assert.equal(composeAddress(parts, 'en'), 'Tashkent city, Юнусабадский район, ул. Амира Темура, 12');
  assert.equal(composeAddress({ country: KZ, region: null, district: null, street: { ru: 'пр. Абая, 1' } }, 'ru'), 'Казахстан, пр. Абая, 1');
  assert.equal(composeAddress({}, 'ru'), '');
});

test('адрес — всё или ничего: начатый требует город/область, район и улицу RU', () => {
  assert.deepEqual(addressProblems({ country_code: 'UZ' }), {}, 'страна по умолчанию — не «начат»');
  assert.deepEqual(addressProblems({ address: 'Ташкент, ул. Мира 1' }), {}, 'вписанный для бланка адрес — не «начат»');
  assert.deepEqual(Object.keys(addressProblems({ street_ru: 'ул. Мира 1' })), ['region_code']);
  assert.deepEqual(Object.keys(addressProblems({ region_code: 'tashkent-city' })).sort(), ['district_code', 'street_ru']);
  assert.deepEqual(Object.keys(addressProblems({ region_code: 'x' }, { districtsAvailable: false })), ['street_ru']);
  assert.deepEqual(addressProblems({ region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира 1' }), {});
});

test('проверка профиля целиком и нормализация перед записью', () => {
  const v = normalizeProfile({ website: 'klinika.uz', telegram_bot: 't.me/klinika_bot', instagram: '', maps_url: ' ', clinic_name: ' Шифо ', address: 'Ташкент, ул. Мира 1' });
  assert.equal(v.website, 'https://klinika.uz');
  assert.equal(v.telegram_bot, '@klinika_bot');
  assert.equal(v.maps_url, '');
  assert.equal(v.clinic_name, 'Шифо');
  assert.equal(v.address, 'Ташкент, ул. Мира 1', 'адрес для бланка — как вписан');
  assert.ok(!('address_manual' in v));
  assert.deepEqual(companyProblems(v), {});
  assert.deepEqual(Object.keys(companyProblems({ ...v, telegram_bot: '@klinika' })), ['telegram_bot']);
});

test('каждое сообщение модуля переведено на ru / uz / en', () => {
  for (const m of Object.values(PROFILE_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});

// ---------------------------------------------------------------------------
// CLINIC_PROFILE_V1 (ревью I2) — строгие правила: CHECK миграции 240 — лишь
// запасной замок, и он пропускал «..» в пути логотипа, разметку в адресе сайта
// и чужой хост «yandex.evil.com». Те же правила — экрану и серверу (/api/db).
// ---------------------------------------------------------------------------
test('сайт: только https с настоящим хостом; кавычки, <, > и пробелы — отказ', () => {
  for (const bad of ['https://a.uz/"><script>alert(1)</script>', "https://a.uz/'x", 'https://a.uz/a b', 'https://a.uz/<b>',
    'https://localhost', 'https://a', 'https://-a.uz', 'https://a..uz', 'https://a.uz:99999', 'javascript:alert(1)', 'https://a.uz/`x`']) {
    assert.equal(websiteProblem(bad), PROFILE_MESSAGES.website, bad);
  }
  for (const good of ['https://klinika.uz', 'https://www.klinika.uz/ru/about?x=1&y=2#top', 'https://xn--80aswg.xn--p1ai', 'https://a-b.c-d.uz:8443/x']) {
    assert.equal(websiteProblem(good), '', good);
  }
});

test('карта: только yandex.uz / .ru / .com (и www., maps.yandex.*) с путём /maps; разметка и чужие хосты — отказ', () => {
  for (const bad of ['https://yandex.evil.com/maps', 'https://yandex.uz.evil.com/maps', 'https://yandex.uz/mapsx', 'https://yandex.kz/maps/',
    'https://yandex.uz/maps/"><script>', 'https://yandex.uz/maps/a b', 'http://yandex.uz/maps/', 'https://evil.com/?https://yandex.uz/maps']) {
    assert.equal(mapsProblem(bad), PROFILE_MESSAGES.maps, bad);
  }
  for (const good of ['https://yandex.uz/maps/-/CDabc123', 'https://www.yandex.ru/maps/org/shifo/123/', 'https://yandex.com/maps?ll=69.2%2C41.3',
    'https://maps.yandex.uz/?pt=69.2,41.3', 'https://yandex.uz/maps']) {
    assert.equal(mapsProblem(good), '', good);
  }
});

test('сервер: storedProfileProblems проверяет значения ровно в том виде, в каком их пишут в базу', async () => {
  const { storedProfileProblems } = await import('./clinic-profile.js');
  assert.deepEqual(storedProfileProblems({ clinic_name: 'Шифо', address: 'что угодно', logo_data_url: 'data:image/png;base64,AAAA' }), {}, 'прочие колонки не проверяются');
  assert.deepEqual(storedProfileProblems({ website: '', telegram_bot: '', instagram: '', maps_url: '', logo_square_path: '', logo_portrait_path: '' }), {}, 'пусто — можно');
  assert.deepEqual(storedProfileProblems({ website: 'https://klinika.uz', telegram_bot: '@klinika_bot', telegram_channel: '@klinika',
    instagram: '@klinika.uz', maps_url: 'https://yandex.uz/maps/-/CDabc', logo_square_path: 'square/1760000000000-ab12cd.png',
    logo_portrait_path: 'portrait/1760000000000-ab12cd.png' }), {});
  const bad = storedProfileProblems({
    logo_square_path: 'square/../../clinic-docs/patients/1/docs/scan.png',
    logo_portrait_path: 'square/1-a.png',
    website: 'klinika.uz',                     // не приведён — сервер не дописывает https:// за клиента
    telegram_bot: 't.me/klinika_bot',          // не урезан до @имени
    telegram_channel: '@klinika channel',
    instagram: '@кли ника',
    maps_url: 'https://yandex.evil.com/maps',
  });
  assert.deepEqual(Object.keys(bad).sort(), ['instagram', 'logo_portrait_path', 'logo_square_path', 'maps_url', 'telegram_bot', 'telegram_channel', 'website']);
  assert.equal(bad.logo_square_path, PROFILE_MESSAGES.logoPath);
  assert.equal(bad.website, PROFILE_MESSAGES.website);
  assert.equal(bad.maps_url, PROFILE_MESSAGES.maps);
  for (const p of ['square/a b.png', 'square/a.PNG.exe', 'square/.png', 'square/a/b.png', 'square\a.png', 'square/a.png ', 'portrait/a.png'])
    assert.equal(storedProfileProblems({ logo_square_path: p }).logo_square_path, PROFILE_MESSAGES.logoPath, p);
  assert.equal(storedProfileProblems({ website: 5 }).website, PROFILE_MESSAGES.website, 'не строка — отказ');
});
