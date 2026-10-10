// CLINIC_API_STEP7_V1 (ревью слияния №1) — решение владельца 11 и «Добавить филиал»
// карточки синхронизации (RPC branch_sync_add_branch → letters.js allocateLetter).
//
// Карточка спрашивает только название, поэтому отказывать в заведении нельзя:
// ключ филиала выдаётся этим же нажатием. Пока включено подключение API, новое
// здание заводится СКРЫТЫМ (show_public = 0): адреса для партнёров у него ещё нет,
// а показанное на сайте здание без адреса правило запрещает. Строка ответа
// говорит владельцу заполнить адрес в «Филиалах» и потом показать здание.
// Подключений нет — как раньше: здание сразу на сайте (умолчание мигр. 241).
process.env.LIS_ENABLED = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { setDataDir } from '../services/control/config.js';
import { branchSyncMakeKey, branchSyncAddBranch } from '../services/rpc/branch-sync.js';
import { insertConnectionRow } from '../test-helpers/api-connection-row.js';
import { ADDRESS_MESSAGES, partnerAddressBlockers, partnerAddressRequired } from '../services/api/partner-address.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';

const admin = { id: 1, role: 'admin' };
const impls = {
  mintImpl: async () => ({ ok: true, token: 't', relay_id: 'a'.repeat(32) }),
  branchImpl: async () => ({ ok: true, enrollment_code: 'EM-TEST-0001', clinic_id: 'c-1-b1' }),
  publishImpl: async () => ({ ok: true, bytes: 1 }),
};
function mainInstall() {
  setDataDir(tmpDir('em-s7m-addbranch-'));
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(branchSyncMakeKey(db, { url: 'http://10.0.0.5:8000' }, admin).ok, true);
  db.prepare(`UPDATE doc_settings SET region_code = 'tashkent-city', district_code = 'yunusobod',
    street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  return db;
}
const rowOf = (db, id) => ({ ...db.prepare('SELECT active, show_public, street_ru FROM branches WHERE id = ?').get(id) });

test('подключение включено: «Добавить филиал» заводит здание скрытым и говорит, что заполнить; правило держится', async () => {
  const db = mainInstall();
  try {
    insertConnectionRow(db);
    assert.equal(partnerAddressRequired(db), true);
    const added = await branchSyncAddBranch(db, { name: 'Юнусабад' }, admin, impls);
    assert.equal(added.ok, true, 'заведение не отказано');
    assert.ok(added.branch.letter, 'буква выдана');
    assert.deepEqual(rowOf(db, added.branch.id), { active: 1, show_public: 0, street_ru: '' });
    assert.deepEqual(partnerAddressBlockers(db), [], 'на сайте нет здания без адреса');
    assert.equal(added.address_note, ADDRESS_MESSAGES.addBranchHidden);
    const e = STRINGS[added.address_note];
    assert.ok(e && e.uz && e.en, 'строка переведена');
  } finally { db.close(); }
});

test('подключений нет (или выключено) — как раньше: здание сразу на сайте, строки про адрес нет', async () => {
  const db = mainInstall();
  try {
    insertConnectionRow(db, { active: 0 });
    assert.equal(partnerAddressRequired(db), false);
    const added = await branchSyncAddBranch(db, { name: 'Сергели' }, admin, impls);
    assert.equal(added.ok, true);
    assert.deepEqual(rowOf(db, added.branch.id), { active: 1, show_public: 1, street_ru: '' });
    assert.equal(added.address_note, undefined);
  } finally { db.close(); }
});
