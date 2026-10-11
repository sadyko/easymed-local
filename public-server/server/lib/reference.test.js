// PUBLIC_SERVER_V1 — справочники для партнёров — ровно справочники программы:
// все коды географии модуля с тремя названиями из миграции 132 и в порядке
// бланка; все специальности со слагами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoReference, specialtiesReference, regionRow, districtRow, countryRow, parseGeoSql } from './reference.js';
import { GEO_COUNTRY_CODES, GEO_REGION_CODES, GEO_DISTRICT_CODES } from '../../../public/js/shared/geo-codes.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const cyr = /[а-яё]/i;

test('география: 7 стран, 14 регионов, 206 районов — коды модуля, порядок бланка, три названия у каждого', () => {
  const g = geoReference();
  assert.deepEqual(g.countries.map((c) => c.code), [...GEO_COUNTRY_CODES]);
  assert.deepEqual(g.cities.map((c) => c.slug), [...GEO_REGION_CODES]);
  assert.deepEqual(g.cities.flatMap((c) => c.districts.map((d) => d.slug)), [...GEO_DISTRICT_CODES]);
  for (const item of [...g.countries, ...g.cities, ...g.cities.flatMap((c) => c.districts)]) {
    assert.ok(item.name.ru && item.name.uz && item.name.en, JSON.stringify(item));
    assert.ok(!cyr.test(item.name.uz) && !cyr.test(item.name.en), 'кириллица в uz/en: ' + JSON.stringify(item.name));
  }
  const tash = g.cities.find((c) => c.slug === 'tashkent-city');
  assert.equal(tash.name.ru, 'город Ташкент');
  assert.ok(tash.districts.some((d) => d.slug === 'yunusobod'));
});

test('строки для адреса — в виде базы программы', () => {
  assert.deepEqual(Object.keys(regionRow('tashkent-city')).sort(), ['code', 'name', 'name_en', 'name_uz']);
  assert.equal(districtRow('mirobod').name, 'Мирабадский район');
  assert.equal(countryRow('UZ').name_en, 'Uzbekistan');
  assert.equal(regionRow('нет'), null);
});

test('разбор понимает кавычку внутри названия', () => {
  const g = parseGeoSql("UPDATE regions SET code = 'x', name_uz = 'O''zbek', name_en = 'X' WHERE name = 'Икс';\n");
  assert.equal(g.regions.get('x').name_uz, "O'zbek");
});

test('специальности: все строки программы со слагом и тремя названиями', () => {
  const s = specialtiesReference().specialties;
  assert.equal(s.length, SPECIALTY_ROWS.length);
  assert.ok(s.length >= 120);
  for (const r of s) assert.ok(r.slug && r.name.ru && r.name.uz && r.name.en, r.slug);
  assert.equal(new Set(s.map((r) => r.slug)).size, s.length, 'слаг повторяется');
});
