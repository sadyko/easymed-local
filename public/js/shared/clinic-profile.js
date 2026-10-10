// CLINIC_PROFILE_V1 — ПРОФИЛЬ КЛИНИКИ: какие колонки «Компании» общие для
// клиники, какие свои у здания; как проверяются ссылки и собирается адрес.
//
// Чистый модуль — без window, document, базы и перевода. Его читают экран
// «Компания» (views/documents-settings.js и соседи), /api/db (страж филиала,
// routes/db.js) и тесты. Сообщения — ключи словаря (i18n-strings.js): экран
// переводит их tr(), сервер отдаёт как есть.
//
// АДРЕС НА БЛАНКАХ (ответ владельца 2026-10-10, вариант B): документы печатают
// прежнее поле «Адрес» (doc_settings.address), вписанное руками, как сегодня.
// Списки «Страна → Город / область → Район» и улица на трёх языках — только
// для API, партнёров и предпросмотра «Как это увидят пациенты»: composeAddress
// собирает адрес для них и в address не пишет. Отметки «вписан вручную» нет.

// ОБЩЕЕ ДЛЯ КЛИНИКИ — меняет главное здание. Филиал получает текстовые поля
// со справочником (branch-sync/catalogue.js DOC_SETTINGS_COLUMNS) и печатает
// копию логотипа; файлов логотипов в филиале нет, пути к ним не едут.
export const COMPANY_CLINIC_WIDE = Object.freeze([
  'clinic_name', 'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en',
  'license', 'accent_color', 'logo_data_url', 'logo_square_path', 'logo_portrait_path',
  'website', 'telegram_bot', 'telegram_channel', 'instagram',
]);
// СВОЁ У ЗДАНИЯ — как address/phone/email с самого начала (catalogue.js).
// address — то, что печатается на бланках этого здания (вписан руками).
export const COMPANY_BUILDING = Object.freeze([
  'address', 'phone', 'email',
  'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en', 'maps_url',
]);
export const COMPANY_COLUMNS = Object.freeze([...COMPANY_CLINIC_WIDE, ...COMPANY_BUILDING]);

export const NAME_MAX = 120;
export const ABOUT_MAX = 600;
export const STREET_MAX = 160;

export const PROFILE_MESSAGES = Object.freeze({
  website:   'Адрес сайта должен начинаться с https://, например https://klinika.uz',
  telegram:  'Укажите имя в Telegram через @ (от 5 латинских букв, цифр или _), например @klinika_demo, или ссылку t.me/….',
  bot:       'Имя Telegram-бота заканчивается на «bot», например @klinika_demo_bot.',
  instagram: 'Укажите имя в Instagram через @, например @klinika_demo, или ссылку на профиль.',
  maps:      'Нужна ссылка из Яндекс Карт: откройте клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку (yandex.uz/maps/…).',
  region:    'Выберите город или область.',
  district:  'Выберите район из списка.',
  street:    'Впишите улицу и дом на русском.',
  // CLINIC_PROFILE_V1 (ревью I2) — путь к файлу логотипа пишет экран; этот отказ
  // видит только тот, кто пишет в /api/db в обход экрана.
  logoPath:  'Неверный путь к файлу логотипа: квадратный — square/<имя>.png, вертикальный — portrait/<имя>.png (латинские буквы, цифры, «-» и «_»).',
});

// CLINIC_PROFILE_V1 (ревью I2) — ХВОСТ ССЫЛКИ (путь, запрос, якорь): без
// пробелов, кавычек, <, >, обратной косой черты и обратного апострофа. Ссылки
// уходят партнёрам и в атрибуты href; CHECK миграции 240 — лишь запасной замок
// (он пропускал «https://a.uz/"><script>…»), правила — здесь, одни для экрана
// и для /api/db (storedProfileProblems).
const URL_TAIL = String.raw`(?:[/?#][^\s"'<>\\` + '`' + String.raw`]*)?`;

// ---- сайт -----------------------------------------------------------------
// CLINIC_PROFILE_V1 (ревью I2) — настоящий хост: метки из латиницы, цифр и
// «-» (не по краям), домен верхнего уровня — буквы или xn--…; порт 1–65535.
const WEBSITE_RE = new RegExp(String.raw`^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})`
  + String.raw`(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d\d|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?` + URL_TAIL + '$', 'i');
const WEBSITE_MAX = 300;
const websiteOk = (s) => s.length <= WEBSITE_MAX && WEBSITE_RE.test(s);
export function normalizeWebsite(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;          // «klinika.uz» → https://klinika.uz
  return s.replace(/^https:\/\//i, 'https://');
}
export function websiteProblem(v) {
  const s = normalizeWebsite(v);
  return !s || websiteOk(s) ? '' : PROFILE_MESSAGES.website;
}

// ---- Telegram / Instagram: храним «@имя» ------------------------------------
const HANDLE_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|instagram\.com)\//i;
export function normalizeHandle(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  s = s.replace(HANDLE_PREFIX, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^@+/, '');
  return s ? '@' + s : '';
}
const TG_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;   // Telegram: 5–32 знака, с буквы
const IG_RE = /^@[A-Za-z0-9_.]{1,30}$/;
export function handleProblem(kind, v) {
  const s = normalizeHandle(v);
  if (!s) return '';
  if (kind === 'instagram') return IG_RE.test(s) ? '' : PROFILE_MESSAGES.instagram;
  if (!TG_RE.test(s)) return PROFILE_MESSAGES.telegram;
  if (kind === 'telegram_bot' && !/bot$/i.test(s)) return PROFILE_MESSAGES.bot;
  return '';
}

// ---- карта и маршрут ----------------------------------------------------------
// CLINIC_PROFILE_V1 (ревью I2) — только Яндекс Карты: yandex.uz / .ru / .com
// (и www.) с путём /maps или maps.yandex.*; хвост — без разметки и пробелов.
const MAPS_RE = new RegExp(String.raw`^https:\/\/(?:(?:www\.)?yandex\.(?:uz|ru|com)\/maps|maps\.yandex\.(?:uz|ru|com))` + URL_TAIL + '$', 'i');
const MAPS_MAX = 500;
const mapsOk = (s) => s.length <= MAPS_MAX && MAPS_RE.test(s);
export function mapsProblem(v) {
  const s = String(v || '').trim();
  return !s || mapsOk(s) ? '' : PROFILE_MESSAGES.maps;
}
// «Маршрут»: координаты из ссылки (pt= / ll= — долгота,широта) → «проложить
// от меня»; ссылка «Поделиться» (yandex.uz/maps/-/…) координат не несёт —
// тогда открывается сама карточка, в ней своя кнопка «Маршрут».
export function routeUrl(maps) {
  const s = String(maps || '').trim();
  if (!s) return '';
  const m = /[?&](?:pt|ll)=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i.exec(s);
  return m ? 'https://yandex.uz/maps/?rtext=~' + m[2] + ',' + m[1] + '&rtt=auto' : s;
}
export function telHref(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  return d.replace(/\D/g, '').length >= 7 ? 'tel:' + d : '';
}

// ---- адрес (для API, партнёров и предпросмотра — не для бланка) -------------
// Строки справочника — как их отдаёт база: { code, name, name_uz, name_en }
// (name — русское, миграции 030/132).
export function placeName(row, lang) {
  if (!row) return '';
  return String((lang === 'uz' && row.name_uz) || (lang === 'en' && row.name_en) || row.name || '').trim();
}
// «город Ташкент, Юнусабадский район, ул. Амира Темура, 12» на языке lang;
// часть без перевода — по-русски; страна — только за пределами Узбекистана.
export function composeAddress({ country = null, region = null, district = null, street = null } = {}, lang = 'ru') {
  const st = street || {};
  const streetText = String(st[lang] || st.ru || '').trim();
  return [
    country && country.code && country.code !== 'UZ' ? placeName(country, lang) : '',
    placeName(region, lang), placeName(district, lang), streetText,
  ].filter(Boolean).join(', ');
}
// Начат ли адрес из списков. Страна в счёт не идёт: её ставит экран (UZ по
// умолчанию); address (адрес для бланка, вписан руками) — тоже: он свой.
export function addressStarted(v) {
  return !!(v.region_code || v.district_code || ['street_ru', 'street_uz', 'street_en'].some((k) => String(v[k] || '').trim()));
}
// Всё или ничего: старую клинику пустой адрес не останавливает, начатый — доводится до конца.
export function addressProblems(v, { regionsAvailable = true, districtsAvailable = true } = {}) {
  const p = {};
  if (!addressStarted(v)) return p;
  if (regionsAvailable && !v.region_code) p.region_code = PROFILE_MESSAGES.region;
  if (v.region_code && districtsAvailable && !v.district_code) p.district_code = PROFILE_MESSAGES.district;
  if (!String(v.street_ru || '').trim()) p.street_ru = PROFILE_MESSAGES.street;
  return p;
}

export function normalizeProfile(v) {
  const out = { ...v };
  out.website = normalizeWebsite(v.website);
  for (const k of ['telegram_bot', 'telegram_channel', 'instagram']) out[k] = normalizeHandle(v[k]);
  for (const k of ['clinic_name', 'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en',
    'street_ru', 'street_uz', 'street_en', 'maps_url']) out[k] = String(v[k] == null ? '' : v[k]).trim();
  return out;
}
export function companyProblems(v, geo = {}) {
  const p = { ...addressProblems(v, geo) };
  const w = websiteProblem(v.website); if (w) p.website = w;
  for (const k of ['telegram_bot', 'telegram_channel', 'instagram']) { const m = handleProblem(k, v[k]); if (m) p[k] = m; }
  const mp = mapsProblem(v.maps_url); if (mp) p.maps_url = mp;
  return p;
}

// ---- сервер: значения ровно в том виде, в каком их пишут в базу -------------
// CLINIC_PROFILE_V1 (ревью I2) — /api/db (routes/db.js) спрашивает это до
// записи в doc_settings. Экран присылает уже приведённое (normalizeProfile):
// https://…, @имя, путь square/<ключ>.png. Сервер ничего не приводит за
// вызывающего — неприведённое значение — отказ с тем же объяснением, что на
// экране. Проверяются только присланные колонки; прочие колонки doc_settings —
// не дело этого модуля.
const LOGO_PATH_RE = Object.freeze({
  logo_square_path: /^square\/[A-Za-z0-9_-]+\.png$/,
  logo_portrait_path: /^portrait\/[A-Za-z0-9_-]+\.png$/,
});
export function storedProfileProblems(values) {
  const p = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return p;
  // null не проверяем: его отклонит NOT NULL базы своим сообщением.
  const given = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] != null;
  const text = (k) => (typeof values[k] === 'string' ? values[k] : null);
  if (given('website')) {
    const s = text('website');
    if (s === null || (s !== '' && !websiteOk(s))) p.website = PROFILE_MESSAGES.website;
  }
  for (const k of ['telegram_bot', 'telegram_channel', 'instagram']) {
    if (!given(k)) continue;
    const s = text(k);
    if (s === '') continue;
    if (s === null || normalizeHandle(s) !== s) { p[k] = k === 'instagram' ? PROFILE_MESSAGES.instagram : PROFILE_MESSAGES.telegram; continue; }
    const m = handleProblem(k, s); if (m) p[k] = m;
  }
  if (given('maps_url')) {
    const s = text('maps_url');
    if (s === null || (s !== '' && !mapsOk(s))) p.maps_url = PROFILE_MESSAGES.maps;
  }
  for (const [k, re] of Object.entries(LOGO_PATH_RE)) {
    if (!given(k)) continue;
    const s = text(k);
    if (s === null || (s !== '' && !re.test(s))) p[k] = PROFILE_MESSAGES.logoPath;
  }
  return p;
}
