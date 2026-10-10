// CLINIC_API_STEP7_V1 — RPC «API и подключения»: кто что может (строка «API»,
// settings.api), филиал, лицензия, словарь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { becomeSecondary } from '../branch-sync/identity.js';
import { TABLES } from '../branch-sync/catalogue.js';
import { SHIPPED } from '../branch-sync/journal.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { __clearDraftsForTests } from '../api/drafts.js';
import { RPC } from './index.js';
import {
  RPC_MESSAGES, apiSettingsGet, apiSlugSave, apiConnectionDraft, apiConnectionCreate, apiConnectionUpdate,
  apiConnectionReveal, apiConnectionRegenerate, apiConnectionDelete, apiJournalList,
} from './api-connections.js';

const NAMES = ['api_settings_get', 'api_slug_save', 'api_connection_draft', 'api_connection_create', 'api_connection_update',
  'api_connection_reveal', 'api_connection_regenerate', 'api_connection_delete', 'api_journal_list'];
function seed() {
  setDataDir(tmpDir('em-apic-rpc-'));
  __clearDraftsForTests();
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)');
  u.run(1, 'boss', 'x', 'Босс', 'admin');
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar');
  u.run(3, 'docadm', 'x', 'Врач-админ', 'doctor');
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', name_en = 'Shifo Clinic', region_code = 'tashkent-city',
    district_code = 'yunusobod', street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  for (const [code, level] of [['api_view', 'view'], ['api_edit', 'edit']]) {
    db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, 'registrar');
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code,
      JSON.stringify({ sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.api': level } }));
  }
  return db;
}
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOC_ADMIN = { id: 3, role: 'doctor', extra_roles: ['admin'] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
const VIEW = { id: 2, role: 'registrar', extra_roles: [], custom_role_code: 'api_view' };
const EDIT = { id: 2, role: 'registrar', extra_roles: [], custom_role_code: 'api_edit' };
const st = (fn) => { try { fn(); return 200; } catch (e) { return e.status || 500; } };
function partner(db, user = ADMIN) {
  apiSlugSave(db, { slug: 'shifo' }, user);
  const d = apiConnectionDraft(db, {}, user);
  return apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'partner', name: 'med24.uz',
    scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'] }, user);
}

test('чтение: без права — 403; «Просмотр» — без масок ключей и секретов; администратор — маски, `can`, адрес', () => {
  const db = seed();
  partner(db);
  assert.equal(st(() => apiSettingsGet(db, {}, REG)), 403);
  const v = apiSettingsGet(db, {}, VIEW);
  assert.deepEqual(v.can, { view: true, edit: false, admin: false });
  assert.ok(v.connections.length === 2 && v.connections.every((c) => c.key_mask === '' && c.secret_mask === ''));
  const a = apiSettingsGet(db, {}, ADMIN);
  assert.deepEqual(a.can, { view: true, edit: true, admin: true });
  assert.ok(a.connections.every((c) => /^em_live_••••/.test(c.key_mask)));
  assert.deepEqual([a.slug, a.base_url, a.public_server, a.building_role, a.clinic_name],
    ['shifo', 'https://api.easymed.uz/shifo/v1/', false, 'main', 'Шифо']);
  assert.deepEqual(a.partner_address_missing, []);
  assert.equal(st(() => apiJournalList(db, {}, VIEW)), 200);
});

test('«Изменение»: включить, выключить, переименовать — да; права, уведомления, безопасность, ключи — только администратор', () => {
  const db = seed();
  const { connection: c } = partner(db);
  assert.equal(apiConnectionUpdate(db, { id: c.id, name: 'med24', active: false }, EDIT).connection.name, 'med24');
  for (const patch of [{ scopes: ['clinic'] }, { webhook_url: 'https://x.uz/h' }, { webhook_events: [] }, { rate_limit: 30 },
    { key_ttl: 'never' }, { ip_allow: '203.0.113.7' }]) {
    assert.equal(st(() => apiConnectionUpdate(db, { id: c.id, ...patch }, EDIT)), 403, JSON.stringify(patch));
  }
  assert.equal(st(() => apiConnectionUpdate(db, { id: c.id, name: 'x' }, VIEW)), 403);
  assert.equal(st(() => apiConnectionUpdate(db, { id: c.id }, EDIT)), 400, 'нечего сохранять');
  for (const fn of [() => apiConnectionReveal(db, { id: c.id, what: 'key' }, EDIT),
    () => apiConnectionRegenerate(db, { id: c.id, what: 'key', confirm: true }, EDIT),
    () => apiConnectionDelete(db, { id: c.id, confirm: true }, EDIT),
    () => apiConnectionDraft(db, {}, EDIT),
    () => apiSlugSave(db, { slug: 'other' }, EDIT)]) assert.equal(st(fn), 403);
});

test('администратор-врач — как администратор (ADMIN_DOCTOR_V1)', () => {
  const db = seed();
  const { connection: c } = partner(db, DOC_ADMIN);
  assert.match(apiConnectionReveal(db, { id: c.id, what: 'key' }, DOC_ADMIN).value, /^em_live_/);
});

test('черновик: обновить ключ — та же запись; создать по чужому или устаревшему черновику нельзя', () => {
  const db = seed();
  apiSlugSave(db, { slug: 'shifo' }, ADMIN);
  const d = apiConnectionDraft(db, {}, ADMIN);
  const r = apiConnectionDraft(db, { draft_id: d.draft_id, renew: 'key' }, ADMIN);
  assert.equal(r.draft_id, d.draft_id);
  assert.notEqual(r.key, d.key);
  const out = apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'symptex', name: 'Symptex', scopes: ['clinic'] }, ADMIN);
  assert.equal(out.key, r.key, 'создан с ОБНОВЛЁННЫМ ключом');
  assert.equal(out.base_url, 'https://api.easymed.uz/shifo/v1/');
  assert.equal(st(() => apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'partner', name: 'x', scopes: ['clinic'] }, ADMIN)), 409);
});

test('филиал: чтение — роль здания и пусто; любая запись — 409', () => {
  const db = seed();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const s = apiSettingsGet(db, {}, ADMIN);
  assert.deepEqual([s.building_role, s.connections], ['secondary', []]);
  for (const fn of [() => apiSlugSave(db, { slug: 'shifo' }, ADMIN), () => apiConnectionDraft(db, {}, ADMIN),
    () => apiConnectionUpdate(db, { id: 1, name: 'x' }, ADMIN)]) {
    assert.equal(st(fn), 409);
  }
  assert.throws(() => apiSlugSave(db, { slug: 'shifo' }, ADMIN), (e) => e.message === RPC_MESSAGES.mainOnly);
});

test('карта RPC, лицензия, здания, словарь', () => {
  for (const n of NAMES) assert.equal(typeof RPC[n], 'function', n);
  assert.deepEqual(NAMES.filter(isReadOnlyRpc), ['api_settings_get', 'api_journal_list']);
  assert.ok(!TABLES.some((t) => t.name.startsWith('api_')), 'подключения едут справочником в филиал');
  assert.ok(!Object.keys(SHIPPED).some((t) => t.startsWith('api_')), 'подключения едут журналом записей');
  for (const m of Object.values(RPC_MESSAGES)) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
