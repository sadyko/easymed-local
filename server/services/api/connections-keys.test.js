// CLINIC_API_STEP7_V1 — правка подключения, включение (решение владельца 11),
// показать / новый ключ и секрет, удаление-архив; копия базы ключей не
// раскрывает; на другом компьютере ключ работает, но не показывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { createBackup } from '../backup.js';
import { keyExpiresAt } from '../../../public/js/shared/api-connections.js';
import { KEK_FILE, SECRET_MESSAGES, keyHash } from './secret-box.js';
import { makeDraft } from './drafts.js';
import { SERVICE_MESSAGES, saveSlug, createConnection, updateConnection, revealSecret, regenerateSecret,
  deleteConnection, listConnections, listJournal } from './connections.js';
import { seed, PARTNER } from '../../test-helpers/api-connections-seed.js';

const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };
function withPartner(s = seed()) {
  saveSlug(s.db, 'shifo', s.actor, { kekPath: s.kekPath });
  const d = makeDraft(1);
  const out = createConnection(s.db, PARTNER, s.actor, { draftId: d.draft_id, kekPath: s.kekPath });
  return { ...s, id: out.connection.id, key: out.key, secret: out.secret };
}

test('правка: только изменённое; название подключения переименовывает его источник; журнал — поля без значений ключей', () => {
  const t = withPartner();
  const c = updateConnection(t.db, t.id, { name: 'med24', contact: 'Отдел партнёров', scopes: [...PARTNER.scopes, 'packages'] }, t.actor);
  assert.equal(c.name, 'med24');
  assert.equal(c.crm_source_label, 'med24', 'источник переименован вместе с подключением');
  const [last] = listJournal(t.db, { connectionId: t.id });
  assert.equal(last.action, 'updated');
  assert.deepEqual(last.detail.fields, ['name', 'scopes'], 'неизменённый контакт в журнал не попал');
  assert.deepEqual(last.detail.scopes, { added: ['packages'], removed: [] });
  assert.deepEqual(last.detail.name, { from: 'med24.uz', to: 'med24' });
  const n = listJournal(t.db).length;
  updateConnection(t.db, t.id, { name: 'med24' }, t.actor);
  assert.equal(listJournal(t.db).length, n, 'без изменений — без записи');
});

test('адрес уведомлений в журнале — без запроса и якоря', () => {
  const t = withPartner();
  updateConnection(t.db, t.id, { webhook_url: 'https://med24.uz/hooks/new?token=abc#x' }, t.actor);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id })[0].detail.webhook_url,
    { from: 'https://med24.uz/hooks', to: 'https://med24.uz/hooks/new' });
});

test('включение: без адреса для партнёров — отказ; выключение — всегда; журнал «включено / выключено»', () => {
  const t = withPartner();
  updateConnection(t.db, t.id, { active: false }, t.actor);
  t.db.prepare("UPDATE doc_settings SET district_code = '' WHERE id = 1").run();
  assert.equal(refusal(() => updateConnection(t.db, t.id, { active: true }, t.actor)).code, 'partner_address_required');
  t.db.prepare("UPDATE doc_settings SET district_code = 'yunusobod' WHERE id = 1").run();
  assert.equal(updateConnection(t.db, t.id, { active: true }, t.actor).active, true);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id }).slice(0, 2).map((x) => x.action), ['enabled', 'disabled']);
});

test('срок ключа: смена срока — дата от выдачи; новый ключ — от новой выдачи', () => {
  const t = withPartner();
  const c = updateConnection(t.db, t.id, { key_ttl: '3m' }, t.actor);
  assert.equal(c.key_ttl, '3m');
  assert.equal(c.key_expires_at, keyExpiresAt(c.key_issued_at, '3m'));
  assert.equal(updateConnection(t.db, t.id, { key_ttl: 'never' }, t.actor).key_expires_at, null);
  updateConnection(t.db, t.id, { key_ttl: '6m' }, t.actor);
  const r = regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.equal(r.connection.key_expires_at, keyExpiresAt(r.connection.key_issued_at, '6m'));
});

test('сайт клиники: адрес — в «Компании»; удалить нельзя', () => {
  const t = withPartner();
  const site = listConnections(t.db).find((c) => c.kind === 'site');
  assert.equal(refusal(() => updateConnection(t.db, site.id, { site_url: 'https://shifo.uz' }, t.actor)).message, SERVICE_MESSAGES.siteUrlInCompany);
  assert.equal(refusal(() => deleteConnection(t.db, site.id, t.actor, { confirm: true })).message, SERVICE_MESSAGES.siteNoDelete);
});

test('показать: значение из шифротекста, в журнал — «открыт» без значения; новый ключ — прежний не подходит; без подтверждения — отказ', () => {
  const t = withPartner();
  assert.equal(revealSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath }), t.key);
  assert.equal(revealSecret(t.db, t.id, 'secret', t.actor, { kekPath: t.kekPath }), t.secret);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id }).slice(0, 2).map((x) => x.action), ['secret_revealed', 'key_revealed']);
  assert.equal(refusal(() => revealSecret(t.db, t.id, 'всё', t.actor, { kekPath: t.kekPath })).message, SERVICE_MESSAGES.badWhat);
  assert.equal(refusal(() => regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath })).message, SERVICE_MESSAGES.confirmKey);
  const r = regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.notEqual(r.value, t.key);
  const row = t.db.prepare('SELECT key_hash FROM api_connections WHERE id = ?').get(t.id);
  assert.equal(row.key_hash, keyHash(r.value));
  assert.notEqual(row.key_hash, keyHash(t.key), 'прежний ключ узнаётся');
  assert.equal(revealSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath }), r.value);
  const s = regenerateSecret(t.db, t.id, 'secret', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.notEqual(s.value, t.secret);
  const text = JSON.stringify(listJournal(t.db));
  for (const v of [t.key, t.secret, r.value, s.value]) assert.ok(!text.includes(v), 'значение в журнале');
});

test('удаление — архив: ключ и секрет стёрты, источник скрыт и цел; второй раз — «не найдено»', () => {
  const t = withPartner();
  assert.equal(refusal(() => deleteConnection(t.db, t.id, t.actor)).message, SERVICE_MESSAGES.confirmDelete);
  deleteConnection(t.db, t.id, t.actor, { confirm: true });
  const row = t.db.prepare('SELECT * FROM api_connections WHERE id = ?').get(t.id);
  assert.deepEqual([row.key_hash, row.key_sealed, row.secret_sealed, row.active], ['', '', '', 0]);
  assert.ok(row.deleted_at);
  assert.equal(t.db.prepare("SELECT is_active FROM crm_sources WHERE key = 'api_med24_uz'").get().is_active, 0);
  assert.ok(!listConnections(t.db).some((c) => c.id === t.id));
  assert.equal(refusal(() => deleteConnection(t.db, t.id, t.actor, { confirm: true })).status, 404);
  assert.equal(listJournal(t.db, { connectionId: t.id })[0].action, 'deleted');
});

test('копия базы ключей не раскрывает: ни значения в файле копии, ни файла шифрования среди копий', async () => {
  const dir = tmpDir('em-apic-backup-');
  const db = openDb(path.join(dir, 'easymed.db'));
  migrate(db);
  // Файл шифрования — в каталоге данных, как в работе (рядом с базой и backups/).
  const t = withPartner(seed({ db, kekPath: path.join(dir, KEK_FILE) }));
  const b = await createBackup(db, dir, 'manual');
  const copy = fs.readFileSync(path.join(dir, 'backups', b.name)).toString('latin1');
  for (const v of [t.key, t.secret]) assert.ok(!copy.includes(v), 'значение в копии базы');
  const listed = fs.readdirSync(path.join(dir, 'backups'), { recursive: true }).map(String);
  assert.ok(!listed.some((f) => f.includes(KEK_FILE)), 'файл шифрования попал в копии');

  // Та же копия на ДРУГОМ компьютере, без файла шифрования.
  const dir2 = tmpDir('em-apic-otherpc-');
  fs.copyFileSync(path.join(dir, 'backups', b.name), path.join(dir2, 'easymed.db'));
  const db2 = openDb(path.join(dir2, 'easymed.db'));
  const kek2 = path.join(dir2, KEK_FILE);
  assert.equal(db2.prepare('SELECT key_hash FROM api_connections WHERE id = ?').get(t.id).key_hash, keyHash(t.key), 'ключ узнаётся по отпечатку');
  const e = refusal(() => revealSecret(db2, t.id, 'key', t.actor, { kekPath: kek2 }));
  assert.deepEqual([e.status, e.message], [409, SECRET_MESSAGES.kekMissing]);
  const fresh = regenerateSecret(db2, t.id, 'key', t.actor, { kekPath: kek2, confirm: true }).value;
  assert.equal(revealSecret(db2, t.id, 'key', t.actor, { kekPath: kek2 }), fresh);
  db.close(); db2.close();
});
