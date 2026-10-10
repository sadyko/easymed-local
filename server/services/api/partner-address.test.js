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
  partnerAddressRequired } from './partner-address.js';   // CLINIC_API_STEP7_V1 (ревью №8) — partnerAddressRequired

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
