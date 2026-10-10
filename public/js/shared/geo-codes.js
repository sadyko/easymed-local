// GEO_HARDCODE_V1 / REFERENCE_LISTS_V1 — ВСТРОЕННЫЙ СПРАВОЧНИК ГЕОГРАФИИ: КОДЫ
// И ИХ ПОРЯДОК В БЛАНКЕ.
//
// Ровно то, что завела миграция 132 из «Справочники EasyMed (бланк).xlsx»:
// 7 стран, 14 регионов Узбекистана и 206 районов и городов — В ПОРЯДКЕ
// БЛАНКА: город Ташкент, Ташкентская область, Андижанская … Хорезмская,
// Каракалпакстан последним; районы каждого региона — как в бланке.
//
// Порядок строк в базе его не хранит: миграция 030 завела регионы раньше и в
// другом порядке (id 1 — Каракалпакстан, id 14 — город Ташкент), а районы
// Ташкента — по алфавиту; миграция 132 их только дополнила. Поэтому список и
// порядок — здесь, а geo-codes.test.js сверяет их с самой миграцией 132:
// разойтись они не могут.
//
// Кто читает:
//   • «Справочники» (admin/views/reference-lists.js) — регионы и районы в
//     порядке бланка, как в согласованном макете;
//   • /api/db (server/services/geo-codes-guard.js) — коды строк бланка:
//     клиника их не меняет и такие строки не удаляет (их коды получают
//     партнёры).
//
// Код района уникален среди районов, но может совпасть с кодом региона
// ('namangan' — и область, и район), поэтому место ищется по таблице.
//
// Чистый модуль: без window, document и базы.

export const GEO_COUNTRY_CODES = Object.freeze(['UZ', 'KZ', 'KG', 'TJ', 'TM', 'RU', 'AF']);

export const GEO_REGION_DISTRICTS = Object.freeze([
  ['tashkent-city', Object.freeze([
    'bektemir', 'mirobod', 'mirzo-ulugbek', 'sergeli', 'uchtepa', 'chilonzor', 'shayxontohur',
    'yunusobod', 'yakkasaroy', 'yashnobod', 'olmazor', 'yangihayot',
  ])],
  ['tashkent', Object.freeze([
    'oqqorgon', 'ohangaron', 'bekobod', 'bostonliq', 'boka', 'zangiota', 'qibray', 'quyichirchiq',
    'parkent', 'piskent', 'toshkent', 'ortachirchiq', 'chinoz', 'yuqorichirchiq', 'yangiyol',
    'angren-shahri', 'olmaliq-shahri', 'bekobod-shahri', 'chirchiq-shahri', 'yangiyol-shahri',
    'nurafshon-shahri', 'ohangaron-shahri',
  ])],
  ['andijan', Object.freeze([
    'andijon', 'asaka', 'baliqchi', 'boz', 'buloqboshi', 'jalaquduq', 'izboskan', 'qorgontepa',
    'marhamat', 'oltinkol', 'paxtaobod', 'ulugnor', 'xojaobod', 'shahrixon', 'andijon-shahri',
    'xonobod-shahri',
  ])],
  ['bukhara', Object.freeze([
    'olot', 'buxoro', 'vobkent', 'gijduvon', 'jondor', 'kogon', 'qorakol', 'qorovulbozor', 'peshku',
    'romitan', 'shofirkon', 'buxoro-shahri', 'kogon-shahri',
  ])],
  ['jizzakh', Object.freeze([
    'arnasoy', 'baxmal', 'gallaorol', 'sharof-rashidov', 'dostlik', 'zomin', 'zarbdor', 'zafarobod',
    'mirzachol', 'paxtakor', 'forish', 'yangiobod', 'jizzax-shahri',
  ])],
  ['kashkadarya', Object.freeze([
    'guzor', 'dehqonobod', 'qamashi', 'qarshi', 'koson', 'kasbi', 'kitob', 'kokdala', 'mirishkor',
    'muborak', 'nishon', 'chiroqchi', 'shahrisabz', 'yakkabog', 'qarshi-shahri', 'shahrisabz-shahri',
  ])],
  ['navoi', Object.freeze([
    'konimex', 'karmana', 'qiziltepa', 'navbahor', 'nurota', 'tomdi', 'uchquduq', 'xatirchi',
    'navoiy-shahri', 'zarafshon-shahri', 'gozgon-shahri',
  ])],
  ['namangan', Object.freeze([
    'kosonsoy', 'mingbuloq', 'namangan', 'norin', 'pop', 'toraqorgon', 'uychi', 'uchqorgon', 'chortoq',
    'chust', 'yangiqorgon', 'namangan-shahri',
  ])],
  ['samarkand', Object.freeze([
    'oqdaryo', 'bulungur', 'jomboy', 'ishtixon', 'kattaqorgon', 'qoshrabot', 'narpay', 'nurobod',
    'payariq', 'pastdargom', 'paxtachi', 'samarqand', 'toyloq', 'urgut', 'samarqand-shahri',
    'kattaqorgon-shahri',
  ])],
  ['surkhandarya', Object.freeze([
    'oltinsoy', 'angor', 'bandixon', 'boysun', 'denov', 'jarqorgon', 'qiziriq', 'qumqorgon', 'muzrabot',
    'sariosiyo', 'termiz', 'uzun', 'sherobod', 'shorchi', 'termiz-shahri',
  ])],
  ['syrdarya', Object.freeze([
    'oqoltin', 'boyovut', 'guliston', 'mirzaobod', 'sayxunobod', 'sardoba', 'sirdaryo', 'xovos',
    'guliston-shahri', 'shirin-shahri', 'yangiyer-shahri',
  ])],
  ['fergana', Object.freeze([
    'oltiariq', 'bagdod', 'beshariq', 'buvayda', 'dangara', 'yozyovon', 'quva', 'qoshtepa', 'rishton',
    'sox', 'toshloq', 'ozbekiston', 'uchkoprik', 'fargona', 'furqat', 'fargona-shahri', 'qoqon-shahri',
    'margilon-shahri', 'quvasoy-shahri',
  ])],
  ['khorezm', Object.freeze([
    'bogot', 'gurlan', 'qoshkopir', 'tuproqqala', 'urganch', 'hazorasp', 'xonqa', 'xiva', 'shovot',
    'yangiariq', 'yangibozor', 'urganch-shahri', 'xiva-shahri',
  ])],
  ['karakalpakstan', Object.freeze([
    'amudaryo', 'beruniy', 'bozatov', 'qanlikol', 'qoraozak', 'kegeyli', 'qongirot', 'moynoq', 'nukus',
    'taxiatosh', 'taxtakopir', 'tortkol', 'xojayli', 'chimboy', 'shumanay', 'ellikqala', 'nukus-shahri',
  ])],
]);

export const GEO_REGION_CODES = Object.freeze(GEO_REGION_DISTRICTS.map(([region]) => region));
export const GEO_DISTRICT_CODES = Object.freeze(GEO_REGION_DISTRICTS.flatMap(([, districts]) => districts));

const RANKS = Object.freeze({
  countries: new Map(GEO_COUNTRY_CODES.map((c, i) => [c, i])),
  regions: new Map(GEO_REGION_CODES.map((c, i) => [c, i])),
  districts: new Map(GEO_DISTRICT_CODES.map((c, i) => [c, i])),
});

/** Место кода в бланке (0, 1, …) для таблицы countries / regions / districts; -1 — строка не из бланка. */
export function geoSheetRank(table, code) {
  const ranks = RANKS[table];
  if (!ranks || code == null) return -1;
  const i = ranks.get(String(code).trim());
  return i == null ? -1 : i;
}

/** Код строки встроенного справочника (бланка) для этой таблицы? */
export function isBuiltinGeoCode(table, code) {
  return geoSheetRank(table, code) >= 0;
}

/**
 * Сравнение строк справочника для сортировки: сначала строки бланка в его
 * порядке, затем остальные (заведённые в «Географии», без кода или со своим
 * кодом) — по русскому названию.
 */
export function bySheetOrder(table) {
  return (a, b) => {
    const ra = geoSheetRank(table, a && a.code);
    const rb = geoSheetRank(table, b && b.code);
    if (ra >= 0 && rb >= 0) return ra - rb;
    if (ra >= 0) return -1;
    if (rb >= 0) return 1;
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'ru');
  };
}
