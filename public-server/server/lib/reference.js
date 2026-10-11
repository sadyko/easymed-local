// PUBLIC_SERVER_V1 — СПРАВОЧНИКИ ДЛЯ ПАРТНЁРОВ: /reference/geo и
// /reference/specialties (макет «Документация API», раздел «Справочники»).
//
// Решение владельца 6: справочники зашиты в программу и одни на все клиники.
// Публичный сервер берёт их ОТТУДА ЖЕ, а не из снимка клиники:
//   • коды и порядок географии — public/js/shared/geo-codes.js;
//   • названия на ru / uz / en — из текста миграции 132 программы (там они
//     записаны построчно; geo-codes.test.js держит модуль и миграцию вместе);
//   • специальности — public/js/shared/specialty-list.js.
// Разбор миграции проверяет reference.test.js: каждый код модуля получил три
// названия, лишних нет — разойтись с программой справочники не могут.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO_COUNTRY_CODES, GEO_REGION_DISTRICTS } from '../../../public/js/shared/geo-codes.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEO_MIGRATION = path.resolve(HERE, '../../../server/db/migrations/132_geography_names.sql');

const Q = "'((?:[^']|'')*)'";
const unq = (s) => s.replace(/''/g, "'");

/** Названия из миграции 132: Map(code → {code, name, name_uz, name_en}) по странам, регионам, районам. */
export function parseGeoSql(sql) {
  const countries = new Map();
  for (const m of sql.matchAll(new RegExp(`^UPDATE countries SET name_uz = ${Q}, name_en = ${Q} WHERE code = ${Q} OR name = ${Q};$`, 'gm'))) {
    countries.set(unq(m[3]), { code: unq(m[3]), name: unq(m[4]), name_uz: unq(m[1]), name_en: unq(m[2]) });
  }
  const regions = new Map();
  for (const m of sql.matchAll(new RegExp(`^UPDATE regions SET code = ${Q}, name_uz = ${Q}, name_en = ${Q} WHERE name = ${Q};$`, 'gm'))) {
    regions.set(unq(m[1]), { code: unq(m[1]), name: unq(m[4]), name_uz: unq(m[2]), name_en: unq(m[3]) });
  }
  const districts = new Map();
  const re = new RegExp(`^UPDATE districts SET code = ${Q}, name_uz = ${Q}, name_en = ${Q}, kind = ${Q} WHERE name = ${Q} AND region_id = \\(SELECT id FROM regions WHERE name = ${Q}\\);$`, 'gm');
  for (const m of sql.matchAll(re)) districts.set(unq(m[1]), { code: unq(m[1]), name: unq(m[5]), name_uz: unq(m[2]), name_en: unq(m[3]) });
  return { countries, regions, districts };
}

let geo = null;
/** Справочник географии (читается один раз). */
export function geoRows() {
  if (!geo) geo = parseGeoSql(fs.readFileSync(GEO_MIGRATION, 'utf8'));
  return geo;
}

const tri = (row) => ({ ru: row.name, uz: row.name_uz || row.name, en: row.name_en || row.name });

/** GET /reference/geo — страны и города/области Узбекистана с районами, в порядке бланка. */
export function geoReference() {
  const g = geoRows();
  return {
    countries: GEO_COUNTRY_CODES.filter((c) => g.countries.has(c)).map((c) => ({ code: c, name: tri(g.countries.get(c)) })),
    cities: GEO_REGION_DISTRICTS.filter(([r]) => g.regions.has(r)).map(([r, districts]) => ({
      slug: r, name: tri(g.regions.get(r)),
      districts: districts.filter((d) => g.districts.has(d)).map((d) => ({ slug: d, name: tri(g.districts.get(d)) })),
    })),
  };
}

/** GET /reference/specialties. */
export function specialtiesReference() {
  return { specialties: SPECIALTY_ROWS.map((r) => ({ slug: r.slug, name: { ru: r.ru, uz: r.uz || r.ru, en: r.en || r.ru } })) };
}

/** Строки для адреса (shared/clinic-profile.js composeAddress): {code, name, name_uz, name_en} или null. */
export const countryRow = (code) => geoRows().countries.get(String(code || '')) || null;
export const regionRow = (code) => geoRows().regions.get(String(code || '')) || null;
export const districtRow = (code) => geoRows().districts.get(String(code || '')) || null;
