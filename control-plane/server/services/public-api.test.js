// PUBLIC_LICENCE_V1 — решения сервера лицензий для публичного сервера: какую
// лицензию выдать, какой ключ обмена принять, что видят партнёры.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, reissueEnrollmentCode, redeemEnrollmentCode } from './enrollment.js';
import {
  licenceTerms, noteSyncKey, acceptPendingSyncKey, syncKeyPending, partnersSee, recordIssued, isRevoked, isoSeconds,
  NEW_SYNC_KEY_NEEDS_CONFIRMATION, keyCode, normaliseKeyCode, syncKeyCandidates, replacedKeysSeen, keyOwner,
} from './public-api.js';

const FP1 = '11'.repeat(16);
const FP2 = '22'.repeat(16);
const FP3 = '33'.repeat(16);
/** Что клиника читает с экрана «Настройки → API» (сборщик Б): первые 8 hex, «xxxx-xxxx». */
const code = (fp) => fp.slice(0, 4) + '-' + fp.slice(4, 8);
const NOW = Date.parse('2026-10-12T10:00:00Z');
const LIVE = '2026-10-20T10:00:00.000Z';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  return db;
}
const row = (db) => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-1');

test('licenceTerms: оплачено — active, ключ только при включённом API; не оплачено — лицензии нет, как до 8c, даже если последняя выданная жива (Р14)', () => {
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: false, apiSyncKey: FP1 }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: FP1, lastIssuedAt: '2026-10-12T09:00:00.000Z' }),
    { subscription: 'active', apiSyncKey: FP1, issuedAfter: '2026-10-12T09:00:00.000Z' });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: 'не отпечаток' }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: false, apiSyncKey: null, lastIssuedAt: 'мусор' }), { subscription: 'active', apiSyncKey: null });
  for (const o of [
    { entitled: false, apiEnabled: true, apiSyncKey: FP1, lastIssuedAt: '2026-10-12T09:00:00.000Z', lastValidUntil: LIVE, now: NOW },
    { entitled: false, apiEnabled: false, apiSyncKey: null },
  ]) assert.equal(licenceTerms(o), null, JSON.stringify(o).slice(0, 60));
});

test('noteSyncKey: первый ключ принимается сам; тот же — без записи; другой — ждёт подтверждения', () => {
  assert.equal(NEW_SYNC_KEY_NEEDS_CONFIRMATION, true, 'вопрос владельцу 1 — построено с подтверждением');
  const db = freshDb();
  assert.deepEqual(noteSyncKey(db, row(db), '', NOW), { apiSyncKey: null, changed: false });
  assert.equal(row(db).api_sync_key_seen, null, 'нет ключа — ничего не пишется');
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: FP1, changed: true });
  let r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_accepted_at, r.api_sync_key_seen_at],
    [FP1, FP1, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z']);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW + 3600000), { apiSyncKey: FP1, changed: false });
  assert.equal(row(db).api_sync_key_seen_at, '2026-10-12T10:00:00Z', 'тот же ключ — «появился» не сдвигается');
  assert.deepEqual(noteSyncKey(db, row(db), FP2, NOW + 7200000), { apiSyncKey: FP1, changed: true });
  r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_seen_at], [FP1, FP2, '2026-10-12T12:00:00Z']);
  assert.equal(syncKeyPending(db, r), true);
});

test('noteSyncKey: отозванный ключ не принимается никогда — даже первым', () => {
  const db = freshDb();
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP1);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: null, changed: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_seen], [null, FP1]);
  assert.equal(syncKeyPending(db, row(db)), false, 'отозванный не «ждёт подтверждения»');
  assert.equal(isRevoked(db, 'sync_key', FP1), true);
  assert.equal(isRevoked(db, 'sync_key', FP2), false);
  assert.equal(isRevoked(db, 'sync_key', ''), false);
});

const states = (db, clinicId = 'c-1') => Object.fromEntries(
  db.prepare('SELECT fp, state FROM sync_keys_seen WHERE clinic_id = ?').all(clinicId).map((r) => [r.fp, r.state]));

test('keyCode / normaliseKeyCode: договор с экраном клиники — первые 8 hex, «xxxx-xxxx»; набранное — без учёта регистра, пробелов и дефиса', () => {
  assert.equal(keyCode('46de4fe9a62a7f1349bdd3658be1696a'), '46de-4fe9');
  for (const bad of ['не отпечаток', '', null, 'AB'.repeat(16)]) assert.equal(keyCode(bad), '');
  for (const typed of ['46de-4fe9', ' 46DE4FE9 ', '46de 4fe9']) assert.equal(normaliseKeyCode(typed), '46de4fe9');
  for (const bad of ['', '46de-4fe', '46de-4fe9-0', 'xxxx-xxxx', null, undefined, 42]) assert.equal(normaliseKeyCode(bad), '', String(bad));
});

test('сверка помнит КАЖДЫЙ ключ, пришедший с установки: первый — принят, прочие — кандидаты по одному на ключ', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW + 1000);
  noteSyncKey(db, row(db), FP2, NOW + 5000);
  assert.deepEqual(states(db), { [FP1]: 'accepted', [FP2]: 'candidate' });
  const [c] = syncKeyCandidates(db, row(db));
  assert.deepEqual(c, { id: 2, fp: FP2, code: '2222-2222', first_seen: '2026-10-12T10:00:01Z', last_seen: '2026-10-12T10:00:05Z', revoked: false, other_clinic: null });
});

test('acceptPendingSyncKey: единственный новый ключ — только с кодом, который клиника прочла с экрана; принятый прежде становится «прежним», а не «новым»', () => {
  const db = freshDb();
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP1, code: code(FP1) }, NOW), { error: 'not_pending' });
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW + 1000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP1, code: code(FP1) }, NOW), { error: 'changed' }, 'на экране был не этот ключ');
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2 }, NOW), { error: 'bad_code' });
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP3) }, NOW), { error: 'code_mismatch' });
  assert.equal(row(db).api_sync_key, FP1, 'ничего не принято');
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2).toUpperCase() }, NOW + 2000), { ok: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_accepted_at], [FP2, '2026-10-12T10:00:02Z']);
  assert.deepEqual(states(db), { [FP1]: 'replaced', [FP2]: 'accepted' });
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW), { error: 'not_pending' });
  assert.deepEqual(acceptPendingSyncKey(db, 'c-нет', { fingerprint: FP2, code: code(FP2) }, NOW), { error: 'not_pending' });

  // Старый ПК ещё работает (или у кого-то копия) — его ключ «прежний», не «новый», и принять его кнопкой нельзя.
  noteSyncKey(db, row(db), FP1, NOW + 10_000);
  assert.deepEqual([syncKeyCandidates(db, row(db)), syncKeyPending(db, row(db))], [[], false]);
  assert.deepEqual(replacedKeysSeen(db, row(db)).map((k) => [k.fp, k.code, k.last_seen]), [[FP1, '1111-1111', '2026-10-12T10:00:10Z']]);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP1, code: code(FP1) }, NOW), { error: 'not_pending' });
});

test('ревью 8c: копия control.json прислала свой ключ после настоящего нового ПК — не принимается НИКАКОЙ, даже с верным кодом; новая регистрация установки очищает ожидающих', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);            // прежний ПК (принят сам)
  noteSyncKey(db, row(db), FP2, NOW + 1000);     // клиника в самом деле сменила ПК
  noteSyncKey(db, row(db), FP3, NOW + 2000);     // копия control.json — позже
  noteSyncKey(db, row(db), FP2, NOW + 3000);     // настоящий снова — последним, но кандидатов всё равно два
  assert.deepEqual(syncKeyCandidates(db, row(db)).map((c) => c.fp), [FP2, FP3]);
  for (const fp of [FP2, FP3]) {
    assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: fp, code: code(fp) }, NOW), { error: 'competing', count: 2 });
  }
  assert.equal(row(db).api_sync_key, FP1);
  // Повторная регистрация: новый код, старый install_token мёртв — у копии больше нет входа.
  assert.ok(redeemEnrollmentCode(db, { code: reissueEnrollmentCode(db, { clinicId: 'c-1' }) }));
  assert.deepEqual(syncKeyCandidates(db, row(db)), [], 'ожидающие ключи прежней установки сброшены');
  assert.equal(row(db).api_sync_key, FP1, 'принятый ключ остаётся');
  noteSyncKey(db, row(db), FP2, NOW + 4000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW + 5000), { ok: true });
});

test('заблокированный кандидат не ждёт и не принимается — но СОРЕВНОВАЛСЯ: блокировка копии не открывает «Accept» без новой регистрации', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW);
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP2);
  assert.deepEqual(syncKeyCandidates(db, row(db)).map((c) => [c.fp, c.revoked]), [[FP2, true]]);
  assert.equal(syncKeyPending(db, row(db)), false);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW), { error: 'revoked' });
  noteSyncKey(db, row(db), FP3, NOW + 1000);
  assert.equal(syncKeyPending(db, row(db)), true);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP3, code: code(FP3) }, NOW), { error: 'competing', count: 2 });
});

// Перепроверка 8c, F1. Клиника, НЕ менявшая ПК, читает код своего принятого
// ключа. Копия install_token может подобрать ключ Ed25519 с теми же первыми
// 8 hex (2^32 попыток — часы на обычной машине) и стать единственным новым:
// совпадение с кодом принятого или прежнего ключа — отказ, а не «принято».
test('перепроверка 8c, F1: новый ключ с кодом принятого или прежнего ключа клиники не принимается, даже с этим кодом', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);
  const ground = FP1.slice(0, 8) + 'ab'.repeat(12);     // подобран под код FP1
  noteSyncKey(db, row(db), ground, NOW + 1000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: ground, code: code(FP1) }, NOW), { error: 'same_code' });
  assert.equal(row(db).api_sync_key, FP1);

  const db2 = freshDb();
  noteSyncKey(db2, row(db2), FP1, NOW);
  noteSyncKey(db2, row(db2), FP2, NOW + 1000);
  assert.deepEqual(acceptPendingSyncKey(db2, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW + 2000), { ok: true });
  const ground2 = FP1.slice(0, 8) + 'cd'.repeat(12);    // под код прежнего (сменённого) ключа
  noteSyncKey(db2, row(db2), ground2, NOW + 3000);
  assert.deepEqual(acceptPendingSyncKey(db2, 'c-1', { fingerprint: ground2, code: code(ground2) }, NOW), { error: 'same_code' });
  assert.equal(row(db2).api_sync_key, FP2);
});

// Перепроверка 8c, F3: клиника вернулась на прежний ПК (A → B → A). Файл ключа
// переживает новую регистрацию, а прежний ключ — «replaced», кнопкой его не
// принять. Новая регистрация установки начинает с чистого листа: её ключ —
// новый кандидат, принимается по своему коду; заблокированные остаются заблокированными.
test('перепроверка 8c, F3: новая регистрация стирает и ждущие, и прежние ключи — вернувшийся ПК принимается по своему коду; блокировки остаются', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);                        // ПК A
  noteSyncKey(db, row(db), FP2, NOW + 1000);                 // ПК B
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW + 2000), { ok: true });
  noteSyncKey(db, row(db), FP3, NOW + 2500);                 // чужой ключ — заблокирован
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP3);
  noteSyncKey(db, row(db), FP1, NOW + 3000);                 // B сломался, клиника снова на A
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP1, code: code(FP1) }, NOW), { error: 'not_pending' }, 'без новой регистрации — нет');
  assert.ok(redeemEnrollmentCode(db, { code: reissueEnrollmentCode(db, { clinicId: 'c-1' }) }));
  assert.deepEqual(states(db), { [FP2]: 'accepted' }, 'остался только принятый');
  noteSyncKey(db, row(db), FP1, NOW + 4000);
  noteSyncKey(db, row(db), FP3, NOW + 4000);
  assert.deepEqual(syncKeyCandidates(db, row(db)).map((k) => [k.fp, k.revoked]), [[FP1, false], [FP3, true]]);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP3, code: code(FP3) }, NOW), { error: 'revoked' }, 'блокировка пережила регистрацию');
});

test('перепроверка 8c, F3: после новой регистрации вернувшийся ПК — единственный новый ключ — принимается', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW + 1000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW + 2000), { ok: true });
  assert.ok(redeemEnrollmentCode(db, { code: reissueEnrollmentCode(db, { clinicId: 'c-1' }) }));
  noteSyncKey(db, row(db), FP1, NOW + 3000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP1, code: code(FP1) }, NOW + 4000), { ok: true });
  assert.deepEqual(states(db), { [FP1]: 'accepted', [FP2]: 'replaced' });
});

// Перепроверка 8c, раунд 2 (п. 1): новая регистрация стирала прежние ключи —
// и проверка «тот же код, что у ключа клиники» их забывала. История принятых
// ключей (sync_keys_history) не стирается никогда: вернувшийся ключ (тот же
// ПОЛНЫЙ отпечаток) принимается по своему коду, подобранный под тот же КОД —
// нет, и до регистрации, и после.
const history = (db, clinicId = 'c-1') => db.prepare('SELECT fp FROM sync_keys_history WHERE clinic_id = ? ORDER BY fp').all(clinicId).map((r) => r.fp);

test('перепроверка 8c, раунд 2: история принятых ключей переживает новую регистрацию — ключ, подобранный под код прежнего ключа, отклоняется и после неё', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);                        // ПК A — принят сам
  noteSyncKey(db, row(db), FP2, NOW + 1000);                 // ПК B
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: FP2, code: code(FP2) }, NOW + 2000), { ok: true });
  assert.deepEqual(history(db), [FP1, FP2]);
  assert.ok(redeemEnrollmentCode(db, { code: reissueEnrollmentCode(db, { clinicId: 'c-1' }) }));
  assert.deepEqual(history(db), [FP1, FP2], 'регистрация историю не трогает');
  const ground = FP1.slice(0, 8) + 'ef'.repeat(12);          // под код прежнего ключа A, отпечаток другой
  noteSyncKey(db, row(db), ground, NOW + 3000);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', { fingerprint: ground, code: code(FP1) }, NOW + 4000), { error: 'same_code' });
  assert.equal(row(db).api_sync_key, FP2);
});

test('ключ, принятый у другой клиники, сам не принимается и кнопкой тоже — один ключ, одна клиника', () => {
  const db = freshDb();
  noteSyncKey(db, row(db), FP1, NOW);

  createEnrollmentCode(db, { clinicId: 'c-2', name: 'Другая' });
  const row2 = () => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-2');
  assert.deepEqual(noteSyncKey(db, row2(), FP1, NOW), { apiSyncKey: null, changed: true }, 'ключ клиники c-1 у c-2 сам не принимается, даже первым');
  assert.equal(keyOwner(db, FP1, 'c-2'), 'c-1');
  assert.equal(keyOwner(db, FP1, 'c-1'), null);
  assert.deepEqual(syncKeyCandidates(db, row2()).map((c) => [c.fp, c.other_clinic]), [[FP1, 'c-1']]);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-2', { fingerprint: FP1, code: code(FP1) }, NOW), { error: 'shared', clinicId: 'c-1' });
});

test('partnersSee: снята, не оплачено, выключено, нет ключа — скрыта; иначе видна', () => {
  const c = { active: 1, api_enabled: 1, api_sync_key: FP1 };
  assert.equal(partnersSee(c, { entitled: true }), 'visible');
  assert.equal(partnersSee({ ...c, active: 0 }, { entitled: true }), 'retired');
  assert.equal(partnersSee(c, { entitled: false }), 'unpaid');
  assert.equal(partnersSee({ ...c, api_enabled: 0 }, { entitled: true }), 'off');
  assert.equal(partnersSee({ ...c, api_sync_key: null }, { entitled: true }), 'no_key');
});

test('recordIssued: запоминает выданное; испорченное или сбой базы — не бросает', () => {
  const db = freshDb();
  recordIssued(db, 'c-1', { issued_at: '2026-10-12T10:00:00.000Z', valid_until: LIVE, subscription: 'active', api_sync_key: FP1 });
  const r = row(db);
  assert.deepEqual([r.licence_issued_at, r.licence_valid_until, r.licence_subscription, r.licence_api_sync_key],
    ['2026-10-12T10:00:00.000Z', LIVE, 'active', FP1]);
  recordIssued(db, 'c-1', { issued_at: 5, valid_until: {} });
  assert.equal(row(db).licence_issued_at, null);
  assert.doesNotThrow(() => recordIssued({ prepare() { throw new Error('база закрыта'); } }, 'c-1', {}));
});
