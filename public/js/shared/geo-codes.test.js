// GEO_HARDCODE_V1 / REFERENCE_LISTS_V1 — встроенный справочник географии в
// shared/geo-codes.js — ТОТ ЖЕ, что завела миграция 132, и в ТОМ ЖЕ порядке.
//
// Миграция — источник: её строки выписаны из «Справочники EasyMed (бланк).xlsx»
// по порядку бланка. Модуль — копия для экрана «Справочники» (порядок) и для
// /api/db (какие коды встроены). Эта проверка не даёт им разойтись: новый
// район в миграции без строки в модуле (или наоборот) — красная сборка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEO_COUNTRY_CODES, GEO_REGION_DISTRICTS, GEO_REGION_CODES, GEO_DISTRICT_CODES,
  geoSheetRank, isBuiltinGeoCode, bySheetOrder,
} from './geo-codes.js';
import { openDb } from '../../../server/db/connection.js';
import { migrate } from '../../../server/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.resolve(HERE, '../../../server/db/migrations/132_geography_names.sql'), 'utf8');

// Порядок миграции 132 — прочитан из её текста.
const sheet = (() => {
  const countries = [...SQL.matchAll(/^UPDATE countries SET .* WHERE code = '([^']+)'/gm)].map((m) => m[1]);
  const regionByName = new Map();
  const regions = [];
  for (const m of SQL.matchAll(/^UPDATE regions SET code = '([^']+)'.*WHERE name = '([^']+)';$/gm)) { regions.push(m[1]); regionByName.set(m[2], m[1]); }
  const districts = new Map(regions.map((r) => [r, []]));
  for (const m of SQL.matchAll(/^UPDATE districts SET code = '([^']+)'.*region_id = \(SELECT id FROM regions WHERE name = '([^']+)'\);$/gm)) {
    districts.get(regionByName.get(m[2])).push(m[1]);
  }
  return { countries, regions, districts };
})();

test('страны, регионы и районы модуля — ровно миграция 132 и в её порядке (порядок бланка)', () => {
  assert.equal(sheet.countries.length, 7, 'стенд: 7 стран в миграции');
  assert.equal(sheet.regions.length, 14, 'стенд: 14 регионов в миграции');
  assert.deepEqual([...GEO_COUNTRY_CODES], sheet.countries);
  assert.deepEqual([...GEO_REGION_CODES], sheet.regions);
  for (const [region, districts] of GEO_REGION_DISTRICTS) {
    assert.deepEqual([...districts], sheet.districts.get(region), region + ': районы не те или не в том порядке');
  }
  assert.equal(GEO_DISTRICT_CODES.length, 206);
  assert.equal(new Set(GEO_DISTRICT_CODES).size, 206, 'код района повторяется');
});

test('после всех миграций в базе каждый код модуля стоит у своей строки (район — в своём регионе)', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const countries = new Set(db.prepare('SELECT code FROM countries').all().map((r) => r.code));
    for (const c of GEO_COUNTRY_CODES) assert.ok(countries.has(c), 'нет страны ' + c);
    const regionOf = new Map(db.prepare(`SELECT d.code AS d, r.code AS r FROM districts d JOIN regions r ON r.id = d.region_id
      WHERE d.code IS NOT NULL`).all().map((x) => [x.d, x.r]));
    for (const [region, districts] of GEO_REGION_DISTRICTS) {
      for (const d of districts) assert.equal(regionOf.get(d), region, d + ' — не в регионе ' + region);
    }
  } finally { db.close(); }
});

test('место в бланке — по таблице: «namangan» — и область, и район', () => {
  assert.equal(geoSheetRank('regions', 'tashkent-city'), 0);
  assert.equal(geoSheetRank('regions', 'karakalpakstan'), 13);
  assert.equal(geoSheetRank('countries', 'UZ'), 0);
  assert.ok(geoSheetRank('regions', 'namangan') >= 0 && geoSheetRank('districts', 'namangan') >= 0);
  assert.notEqual(geoSheetRank('regions', 'namangan'), geoSheetRank('districts', 'namangan'));
  assert.equal(geoSheetRank('regions', 'bektemir'), -1, 'код района — не код региона');
  assert.equal(geoSheetRank('districts', null), -1);
  assert.equal(geoSheetRank('patients', 'UZ'), -1);
  assert.equal(isBuiltinGeoCode('countries', 'UZ'), true);
  assert.equal(isBuiltinGeoCode('countries', 'TR'), false);
  assert.equal(isBuiltinGeoCode('districts', ' yunusobod '), true, 'пробелы по краям не делают код чужим');
});

test('сортировка: строки бланка в его порядке, затем свои — по названию', () => {
  const rows = [
    { code: null, name: 'Яя-своя' }, { code: 'karakalpakstan', name: 'Республика Каракалпакстан' },
    { code: 'own', name: 'Аа-своя' }, { code: 'tashkent', name: 'Ташкентская область' }, { code: 'tashkent-city', name: 'город Ташкент' },
  ];
  assert.deepEqual(rows.sort(bySheetOrder('regions')).map((r) => r.code), ['tashkent-city', 'tashkent', 'karakalpakstan', 'own', null]);
});
