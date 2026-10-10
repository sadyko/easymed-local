// CLINIC_API_STEP7_V1 — подключения API: имя в адресе, сайт клиники (сам,
// выключенным), черновик ключа, создание, список, журнал без значений.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { KEY_RE, SECRET_RE, API_MESSAGES } from '../../../public/js/shared/api-connections.js';
import { loadKek, unseal, keyHash } from './secret-box.js';
import { makeDraft, renewDraft, readDraft, __clearDraftsForTests, DRAFT_TTL_MS } from './drafts.js';
import {
  SERVICE_MESSAGES, SITE_NAME, readSlug, saveSlug, slugSuggestion, listConnections, createConnection, listJournal,
} from './connections.js';
import { seed, PARTNER } from '../../test-helpers/api-connections-seed.js';

const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };

test('черновик: одному администратору, 30 минут; ключ и секрет обновляются по отдельности', () => {
  __clearDraftsForTests();
  const d = makeDraft(1, { now: 1000 });
  assert.match(d.key, KEY_RE);
  assert.match(d.secret, SECRET_RE);
  assert.equal(readDraft(d.draft_id, 2, { now: 1000 }), null, 'чужой черновик');
  const r = renewDraft(d.draft_id, 1, 'key', { now: 2000 });
  assert.notEqual(r.key, d.key);
  assert.equal(r.secret, d.secret);
  assert.equal(renewDraft(d.draft_id, 1, 'всё', { now: 2000 }), null);
  assert.equal(readDraft(d.draft_id, 1, { now: 2000 + DRAFT_TTL_MS + 1 }), null, 'просрочен');
});

test('имя в адресе: проверка, предложение из «Компании», журнал «было → стало»; сайт клиники создаётся сам — выключенным, один', () => {
  const { db, actor, kekPath } = seed();
  assert.equal(slugSuggestion(db), 'shifo-clinic');
  assert.equal(refusal(() => saveSlug(db, 'api', actor, { kekPath })).message, API_MESSAGES.slugReserved);
  assert.deepEqual(saveSlug(db, ' Shifo ', actor, { kekPath }), { slug: 'shifo', base_url: 'https://api.easymed.uz/shifo/v1/', site_created: true });
  const [site] = listConnections(db);
  assert.deepEqual([site.kind, site.name, site.active, site.crm_source_key, site.owns_source, site.site_url],
    ['site', SITE_NAME, false, 'website', false, '']);
  assert.match(site.key_mask, /^em_live_••••[A-Za-z0-9]{4}$/);
  assert.equal(saveSlug(db, 'shifo-24', actor, { kekPath }).site_created, false);
  assert.equal(listConnections(db).filter((c) => c.kind === 'site').length, 1);
  assert.equal(readSlug(db), 'shifo-24');
  const j = listJournal(db);
  assert.deepEqual(j.map((x) => x.action), ['slug_saved', 'created', 'slug_saved']);
  assert.deepEqual(j[0].detail, { from: 'shifo', to: 'shifo-24' });
  assert.equal(j[0].user_name, 'Босс');
  assert.deepEqual(j[1].detail, { kind: 'site', auto: true, source: 'website' });
});

test('создание: ключ и секрет — из черновика; в базе — шифротекст и отпечаток; свой источник CRM; журнал без значений', () => {
  const { db, actor, kekPath } = seed();
  saveSlug(db, 'shifo', actor, { kekPath });
  const d = makeDraft(1);
  const out = createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath });
  assert.equal(out.key, d.key);
  assert.equal(out.secret, d.secret);
  const c = out.connection;
  assert.deepEqual([c.kind, c.name, c.active, c.crm_source_key, c.crm_source_label, c.owns_source, c.rate_limit, c.key_ttl, c.created_by_name],
    ['partner', 'med24.uz', true, 'api_med24_uz', 'med24.uz', true, 60, '1y', 'Босс']);
  assert.ok(c.key_expires_at > c.key_issued_at, 'срок «1 год» посчитан от выдачи');
  const row = db.prepare('SELECT * FROM api_connections WHERE id = ?').get(c.id);
  assert.equal(row.key_hash, keyHash(d.key));
  assert.equal(unseal(row.key_sealed, loadKek({ kekPath })), d.key);
  assert.equal(unseal(row.secret_sealed, loadKek({ kekPath })), d.secret);
  const rowText = JSON.stringify(row);
  assert.ok(!rowText.includes(d.key) && !rowText.includes(d.secret), 'значение лежит открыто');
  for (const k of ['key_hash', 'key_sealed', 'secret_sealed']) assert.ok(!(k in c), 'список отдаёт ' + k);
  assert.equal(readDraft(d.draft_id, 1), null, 'черновик израсходован');
  const j = JSON.stringify(listJournal(db));
  assert.ok(!j.includes(d.key) && !j.includes(d.secret));
});

test('создание: отказы — нет имени в адресе, устаревший черновик, сайт вручную, неверные поля, адрес не заполнен', () => {
  const { db, actor, kekPath } = seed();
  const d = makeDraft(1);
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath })).message, SERVICE_MESSAGES.slugFirst);
  saveSlug(db, 'shifo', actor, { kekPath });
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: 'нет', kekPath })).message, SERVICE_MESSAGES.draftGone);
  assert.equal(refusal(() => createConnection(db, { ...PARTNER, kind: 'site' }, actor, { draftId: d.draft_id, kekPath })).status, 409);
  assert.equal(refusal(() => createConnection(db, { ...PARTNER, scopes: ['clinic', 'appointments'] }, actor, { draftId: d.draft_id, kekPath })).message,
    API_MESSAGES.appointmentsNeedSlots);
  db.prepare("UPDATE doc_settings SET street_ru = '' WHERE id = 1").run();
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath })).code, 'partner_address_required');
  const off = createConnection(db, { ...PARTNER, active: false }, actor, { draftId: d.draft_id, kekPath });
  assert.equal(off.connection.active, false, 'выключенное создаётся и без адреса');
});

test('сообщения переведены', () => {
  for (const m of [...Object.values(SERVICE_MESSAGES), SITE_NAME]) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
