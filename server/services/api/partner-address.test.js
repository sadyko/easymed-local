// CLINIC_API_STEP7_V1 — решение владельца 11 на сервере: подключение не
// включается без адреса; «Компания» без адреса не сохраняется, пока подключение включено.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { PROFILE_MESSAGES } from '../../../public/js/shared/clinic-profile.js';
import { ADDRESS_MESSAGES, apiActive, addressAvailability, companyAddressProblems, companyAddressRefusal, requirePartnerAddress,
  partnerAddressRequired, partnerAddressBlockers, branchAddressRefusal } from './partner-address.js';   // CLINIC_API_STEP7_V1 — здания на сайте   // CLINIC_API_STEP7_V1 (ревью №8) — partnerAddressRequired

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const FULL = { region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1' };
const setAddr = (db, v) => db.prepare('UPDATE doc_settings SET region_code = ?, district_code = ?, street_ru = ? WHERE id = 1')
  .run(v.region_code || '', v.district_code || '', v.street_ru || '');
const meta = { table: 'doc_settings', op: 'update' };

test('включено ли хоть одно подключение: выключенные и удалённые не в счёт', () => {
  const db = fresh();
  assert.equal(apiActive(db), false);
  const id = insertConnectionRow(db, { active: 0 });
  assert.equal(apiActive(db), false);
  db.prepare('UPDATE api_connections SET active = 1 WHERE id = ?').run(id);
  assert.equal(apiActive(db), true);
});

test('есть ли из чего выбирать — по справочнику мигр. 132: у Узбекистана области с районами, у Казахстана областей нет', () => {
  const db = fresh();
  assert.deepEqual(addressAvailability(db, { country_code: '', region_code: 'tashkent-city' }), { regionsAvailable: true, districtsAvailable: true });
  assert.deepEqual(addressAvailability(db, { country_code: 'KZ' }), { regionsAvailable: false, districtsAvailable: false });
});

test('проверка адреса «Компании» и отказ включения', () => {
  const db = fresh();
  assert.deepEqual(Object.keys(companyAddressProblems(db)).sort(), ['region_code', 'street_ru']);
  const e = (() => { try { requirePartnerAddress(db); } catch (x) { return x; } return null; })();
  assert.equal(e.status, 409);
  assert.equal(e.code, 'partner_address_required');
  assert.equal(e.message, ADDRESS_MESSAGES.enable);
  setAddr(db, FULL);
  assert.deepEqual(companyAddressProblems(db), {});
  requirePartnerAddress(db);
});

test('/api/db: пока подключение включено, правка «Компании» без адреса — отказ с полем; без подключения — как раньше', () => {
  const db = fresh();
  setAddr(db, FULL);
  assert.equal(companyAddressRefusal(db, meta, { values: { street_ru: '' } }), null, 'подключений нет — адрес необязателен');
  insertConnectionRow(db);
  assert.deepEqual(companyAddressRefusal(db, meta, { values: { street_ru: '' } }), { field: 'street_ru', message: PROFILE_MESSAGES.partnerAddress });
  assert.deepEqual(companyAddressRefusal(db, meta, { values: { region_code: '', district_code: '' } }), { field: 'region_code', message: PROFILE_MESSAGES.partnerAddress });
  assert.equal(companyAddressRefusal(db, meta, { values: { phone: '+998 71 200 00 00' } }), null, 'адрес полон — правка телефона проходит');
  assert.equal(companyAddressRefusal(db, { table: 'doc_settings', op: 'select' }, {}), null);
  assert.equal(companyAddressRefusal(db, { table: 'patients', op: 'update' }, { values: {} }), null);
});

test('сообщения переведены', () => {
  for (const m of [ADDRESS_MESSAGES.enable, PROFILE_MESSAGES.partnerAddress]) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});

// CLINIC_API_STEP7_V1 (ревью №8) — в филиале подключений нет (таблицы не едут, записи —
// 409): подключение, оставленное включённым до присоединения к главному зданию, не
// требует адреса — иначе филиал не мог бы очистить адрес своего здания, а выключить
// подключение отсюда нельзя.
test('филиал: адрес для партнёров не требуется, даже если подключение осталось включённым', async () => {
  const { becomeSecondary } = await import('../branch-sync/identity.js');
  const db = fresh();
  setAddr(db, FULL);
  insertConnectionRow(db);
  assert.equal(partnerAddressRequired(db), true);
  assert.ok(companyAddressRefusal(db, meta, { values: { region_code: '', district_code: '', street_ru: '' } }));
  becomeSecondary(db, { letter: 'C', name: 'Филиал' });
  assert.equal(apiActive(db), true, 'строка подключения на месте');
  assert.equal(partnerAddressRequired(db), false);
  assert.equal(companyAddressRefusal(db, meta, { values: { region_code: '', district_code: '', street_ru: '' } }), null);
});

// CLINIC_API_STEP7_V1 — решение владельца 11 ПО ЗДАНИЯМ (план шага 7, «Шагам 4, 8 и 9»
// и «Завершение» п. 5; строит шаг, влившийся вторым): пока включено подключение, у
// каждого здания, показанного партнёрам (active = 1 и show_public = 1, как их прочтёт
// шаг 8), адрес для партнёров полный. Главное здание — только через «Компанию»: его
// строка branches адреса не держит (шаг 4, одно место на здание).
const addBranch = (db, v = {}) => Number(db.prepare(
  'INSERT INTO branches (name, region_code, district_code, street_ru, show_public, active) VALUES (?, ?, ?, ?, ?, ?)')
  .run(v.name || 'Чиланзар', v.region_code ?? '', v.district_code ?? '', v.street_ru ?? '', v.show_public ?? 1, v.active ?? 1).lastInsertRowid);
const FULL_BRANCH = { region_code: 'tashkent-city', district_code: 'chilonzor', street_ru: 'ул. Бунёдкор, 5' };
const thrown = (fn) => { try { fn(); } catch (x) { return x; } return null; };

test('здания: главное — только через «Компанию»; показанный филиал без района — помеха с именем; скрытый и закрытый — нет', () => {
  const db = fresh();
  setAddr(db, FULL);
  assert.deepEqual(partnerAddressBlockers(db), [], 'строка главного здания в branches пуста, но адрес главного — в «Компании»');
  const id = addBranch(db, { ...FULL_BRANCH, district_code: '' });
  const b = partnerAddressBlockers(db);
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].building, b[0].branch_id, b[0].name], ['branch', id, 'Чиланзар']);
  assert.deepEqual(Object.keys(b[0].problems), ['district_code']);
  addBranch(db, { name: 'Скрытый', show_public: 0 });
  addBranch(db, { name: 'Закрытый', active: 0 });
  assert.equal(partnerAddressBlockers(db).length, 1, 'скрытое (show_public 0) и закрытое (active 0) здание партнёрам не видно — не проверяется');
  setAddr(db, {});
  assert.deepEqual(partnerAddressBlockers(db).map((x) => x.building), ['main', 'branch'], 'сначала «Компания», потом здания');
});

test('включение подключения: филиал на сайте без адреса — 409, сообщение называет здание (шаблон с {name}); главное без адреса — прежний отказ «Компании»', () => {
  const db = fresh();
  setAddr(db, FULL);
  addBranch(db, { ...FULL_BRANCH, district_code: '' });
  const e = thrown(() => requirePartnerAddress(db));
  assert.ok(e, 'включение прошло при неполном адресе показанного филиала');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'branch_address_required');
  assert.ok(e.message.includes('«Чиланзар»'), e.message);
  assert.equal(e.template, ADDRESS_MESSAGES.enableBranch);
  assert.deepEqual(e.params, { name: 'Чиланзар' });
  addBranch(db, { name: 'Юнусабад' });
  const e2 = thrown(() => requirePartnerAddress(db));
  assert.equal(e2.template, ADDRESS_MESSAGES.enableBranches);
  assert.deepEqual(e2.params, { names: 'Чиланзар, Юнусабад' });
  setAddr(db, {});
  const e3 = thrown(() => requirePartnerAddress(db));
  assert.deepEqual([e3.code, e3.message], ['partner_address_required', ADDRESS_MESSAGES.enable], 'адрес «Компании» — первым, с дорогой в «Компанию»');
  setAddr(db, FULL);
  db.prepare("UPDATE branches SET district_code = 'chilonzor', show_public = 1 WHERE name = 'Чиланзар'").run();
  db.prepare("UPDATE branches SET show_public = 0 WHERE name = 'Юнусабад'").run();
  assert.equal(thrown(() => requirePartnerAddress(db)), null, 'адреса полны или здание скрыто — включается');
});

test('/api/db: правка филиала на сайте без района при включённом подключении — отказ с полем; скрыть — можно; без подключений — как раньше', () => {
  const db = fresh();
  setAddr(db, FULL);
  const id = addBranch(db, FULL_BRANCH);
  const upd = (values) => branchAddressRefusal(db, { table: 'branches', op: 'update' }, { values, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(upd({ district_code: '' }), null, 'подключений нет — адрес необязателен');
  insertConnectionRow(db);
  assert.deepEqual(upd({ district_code: '' }), { field: 'district_code', message: ADDRESS_MESSAGES.saveBranch });
  assert.equal(upd({ name: 'Чиланзар-2' }), null, 'адрес полон — правка названия проходит');
  db.prepare("UPDATE branches SET district_code = '' WHERE id = ?").run(id);   // неполный адрес с прежних времён
  assert.deepEqual(upd({ name: 'Чиланзар-2' }), { field: 'district_code', message: ADDRESS_MESSAGES.saveBranch }, 'сохраняемая строка целиком (как «Компания»)');
  assert.equal(upd({ show_public: 0 }), null, 'скрыть филиал с неполным адресом — можно');
  db.prepare('UPDATE branches SET show_public = 0 WHERE id = ?').run(id);
  assert.deepEqual(upd({ show_public: 1 }), { field: 'district_code', message: ADDRESS_MESSAGES.saveBranch }, 'показать на сайте с неполным адресом — нельзя');
  assert.equal(upd({ name: 'Скрытый' }), null, 'скрытый филиал не проверяется');
  const ins = (values) => branchAddressRefusal(db, { table: 'branches', op: 'insert' }, { values });
  assert.deepEqual(ins({ name: 'Новый' }), { field: 'region_code', message: ADDRESS_MESSAGES.saveBranch }, 'новое здание видно на сайте по умолчанию');
  assert.equal(ins({ name: 'Новый', show_public: 0 }), null);
  assert.equal(ins({ name: 'Новый', ...FULL_BRANCH }), null);
  db.prepare('UPDATE api_connections SET active = 0').run();
  assert.equal(upd({ show_public: 1 }), null, 'последнее подключение выключено — правило снято');
});

test('/api/db: своя строка главного здания — только через «Компанию»; в филиале (вторая установка) правило не действует (ревью №8)', async () => {
  const { becomeSecondary } = await import('../branch-sync/identity.js');
  const db = fresh();
  setAddr(db, FULL);
  insertConnectionRow(db);
  const own = db.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id;
  assert.equal(branchAddressRefusal(db, { table: 'branches', op: 'update' }, { values: { name: 'Главный корпус' }, filters: [{ col: 'id', op: 'eq', val: own }] }), null);
  const id = addBranch(db);
  becomeSecondary(db, { letter: 'C', name: 'Филиал' });
  assert.equal(branchAddressRefusal(db, { table: 'branches', op: 'update' }, { values: { show_public: 1 }, filters: [{ col: 'id', op: 'eq', val: id }] }), null);
});

test('сообщения про здания переведены', () => {
  for (const m of [ADDRESS_MESSAGES.enableBranch, ADDRESS_MESSAGES.enableBranches, ADDRESS_MESSAGES.saveBranch]) {
    assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
    assert.ok(!/[А-Яа-яЁё]/.test(STRINGS[m].uz + STRINGS[m].en), 'кириллица в uz / en: ' + m);
  }
});
