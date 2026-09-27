// LIVE_AUDIT_FIX_V1 — «Поставщики»: контактное лицо и примечание сохраняются.
//
// Экран писал `contact` / `note`, а колонки реестра — `contact_name` / `notes`:
// компилятор молча выбрасывал оба поля, и список читал те же несуществующие
// ключи. Проверка — через настоящий компилятор и SQLite после миграций, на
// роли склада.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => 'ru', setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
const el = () => ({ style: {}, dataset: {}, children: [], appendChild(c) { return c; }, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
globalThis.document = { createElement: el, createElementNS: el, createTextNode: () => ({}), documentElement: el(), head: el(), body: el(), getElementById: () => null, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { supplierPayload } = await import('../views/inventory-suppliers.js');

const INV = { id: 1, role: 'inventory', extra_roles: [] };

test('поставщик: контакт и примечание доходят до базы и читаются обратно', () => {
  const db = openDb(':memory:'); migrate(db);
  const values = supplierPayload({ name: ' ООО Медтех ', contact: ' Алишер ', phone: '+998901234567', note: 'только по предоплате', active: true });
  assert.deepEqual(Object.keys(values).sort(), ['active', 'contact_name', 'name', 'notes', 'phone']);
  const ins = compile({ table: 'suppliers', op: 'insert', values }, INV, { db });
  db.prepare(ins.sql).run(...ins.params);
  const sel = compile({ table: 'suppliers', op: 'select', columns: '*' }, INV, { db });
  const row = db.prepare(sel.sql).all(...sel.params)[0];
  assert.equal(row.name, 'ООО Медтех');
  assert.equal(row.contact_name, 'Алишер', 'контактное лицо выброшено');
  assert.equal(row.notes, 'только по предоплате', 'примечание выброшено');

  const upd = compile({ table: 'suppliers', op: 'update', values: supplierPayload({ name: 'ООО Медтех', contact: 'Бобур', note: '', active: false }),
    filters: [{ col: 'id', op: 'eq', val: row.id }] }, INV, { db });
  db.prepare(upd.sql).run(...upd.params);
  const after = db.prepare('SELECT contact_name, notes, active FROM suppliers WHERE id = ?').get(row.id);
  assert.deepEqual({ ...after }, { contact_name: 'Бобур', notes: '', active: 0 });
});

test('список и окно поставщика читают те же колонки, что пишут', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/inventory-suppliers.js', import.meta.url), 'utf8');
  assert.ok(!/s\.contact\b(?!_)|s\.note\b(?!s)/.test(src), 'экран снова читает несуществующие s.contact / s.note');
  assert.match(src, /s\.contact_name/);
  assert.match(src, /s\.notes/);
});
