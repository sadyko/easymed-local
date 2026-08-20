import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';

const REG = { id: 1, role: 'registrar' };
const runSel = (db, desc) => { const c = compile(desc, REG); return db.prepare(c.sql).all(...c.params); };

test('030 seeds Uzbekistan address data and the registration cascade queries return it', () => {
  const db = openDb(':memory:'); migrate(db);

  // registration.js: countries.select('id,name').eq('active', true).order('name')
  const countries = runSel(db, { table: 'countries', op: 'select', columns: 'id,name',
    filters: [{ col: 'active', op: 'eq', val: true }], order: [{ col: 'name', asc: true }] });
  assert.equal(countries.length, 7);
  const uz = countries.find((c) => c.name === 'Узбекистан');
  assert.ok(uz, 'Uzbekistan present');

  // regions.select('id,name').eq('country_id', uz.id).eq('active', true)
  const regions = runSel(db, { table: 'regions', op: 'select', columns: 'id,name',
    filters: [{ col: 'country_id', op: 'eq', val: uz.id }, { col: 'active', op: 'eq', val: true }], order: [{ col: 'name', asc: true }] });
  assert.equal(regions.length, 14);   // 12 provinces + Karakalpakstan + Tashkent city

  // districts.select('id,name').eq('region_id', <Tashkent city>).eq('active', true)
  const tashkent = regions.find((r) => r.name === 'город Ташкент');
  assert.ok(tashkent);
  const districts = runSel(db, { table: 'districts', op: 'select', columns: 'id,name',
    filters: [{ col: 'region_id', op: 'eq', val: tashkent.id }, { col: 'active', op: 'eq', val: true }], order: [{ col: 'name', asc: true }] });
  assert.equal(districts.length, 12);

  // every region links to a real country, every district to a real region
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
