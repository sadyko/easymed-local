// PUBLIC_LICENCE_V1 — решения карточки «Online booking / API»: слова «что видят
// партнёры», короткий отпечаток, строка лицензии, разбор вставленного ключа и
// его SHA-256 в браузере — тот же, что считает клиника; новый ключ на доске.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  partnersSeeText, shortFp, licenceLine, revocationInput, sha256Hex, PARTNER_KEY_RE, attentionReasons, keyCode,
} from './panel-logic.js';
import { KEY_RE } from '../../public/js/shared/api-connections.js';
import { newApiKey, keyHash } from '../../server/services/api/secret-box.js';
import { keyCode as serverKeyCode } from '../server/services/public-api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('что видят партнёры: каждый код сервера — своя фраза и тон; незнакомый — «перезагрузите»', () => {
  assert.deepEqual(partnersSeeText('visible'), { label: 'Partners see this clinic', tone: 'ok' });
  for (const [code, tone] of [['off', 'muted'], ['no_key', 'warn'], ['unpaid', 'danger'], ['retired', 'danger']]) {
    assert.equal(partnersSeeText(code).tone, tone);
    assert.match(partnersSeeText(code).label, /^Hidden from partners/);
  }
  assert.match(partnersSeeText('unpaid').label, /temporarily unavailable/, 'слова партнёров — «временно недоступна», не «не оплатила»');
  assert.equal(partnersSeeText('что-то').tone, 'danger');
});

test('код ключа обмена: «xxxx-xxxx» — тот же, что считает сервер лицензий и показывает экран клиники «Настройки → API»', () => {
  const fp = '46de4fe9a62a7f1349bdd3658be1696a';
  assert.equal(keyCode(fp), '46de-4fe9');
  assert.equal(keyCode(fp), serverKeyCode(fp));
  assert.equal(keyCode(null), '—');
  assert.equal(shortFp(fp), '46de4fe9…696a', 'короткий отпечаток — для SHA-256 ключей партнёров');
  assert.equal(shortFp(null), '—');
});

// Ревью 8c, п. 2: по Р14 неоплаченной лицензия не выдаётся — карточка не должна
// говорить «клиника не сверялась», когда та сверяется каждый час.
test('строка лицензии: у неоплаченной — «не выдаётся, пока не оплачено», а не «не сверялась»; ключ — кодом «xxxx-xxxx»', () => {
  assert.match(licenceLine(null), /has not checked in since/);
  assert.match(licenceLine(null, 'visible'), /has not checked in since/);
  assert.equal(licenceLine(null, 'unpaid'), 'No licence is issued while the clinic is unpaid (the clinic keeps the one it has).');
  assert.equal(licenceLine(null, 'retired'), 'No licence is issued to a retired clinic.');
  const lic = { issued_at: '2026-10-12T10:05:00.000Z', subscription: 'active', api_sync_key: '46de4fe9a62a7f1349bdd3658be1696a' };
  assert.equal(licenceLine(lic, 'visible'), "Clinic's licence, issued 12 Oct 2026 10:05 UTC: online booking on (key 46de-4fe9).");
  assert.equal(licenceLine({ ...lic, api_sync_key: null }, 'off'), "Clinic's licence, issued 12 Oct 2026 10:05 UTC: online booking off.");
  assert.equal(licenceLine(lic, 'unpaid'),
    "Clinic's last licence, issued 12 Oct 2026 10:05 UTC: online booking on (key 46de-4fe9). No new licence is issued while the clinic is unpaid.");
});

test('вставленное: ключ партнёра — считать отпечаток здесь; отпечаток — как есть (строчными); прочее — нет', () => {
  const key = newApiKey();
  assert.deepEqual(revocationInput('  ' + key + ' '), { kind: 'key', value: key });
  assert.deepEqual(revocationInput('AB'.repeat(32)), { kind: 'hash', value: 'ab'.repeat(32) });
  for (const bad of ['', 'em_live_short', 'ab'.repeat(16), null, 42]) assert.deepEqual(revocationInput(bad), { kind: 'bad' });
  assert.equal(PARTNER_KEY_RE.source, KEY_RE.source, 'вид ключа в панели = вид ключа программы (shared/api-connections.js)');
});

test('SHA-256 в браузере — тот же отпечаток, по которому публичный сервер узнаёт ключ (keyHash клиники)', async () => {
  const key = newApiKey();
  assert.equal(await sha256Hex(key), keyHash(key));
});

test('доска: новый ключ обмена — причина «нужно внимание»', () => {
  const live = { last_seen_at: new Date().toISOString(), subscription: 'active', subscription_until: null, versions_behind: 0, active: true };
  assert.deepEqual(attentionReasons(live), []);
  assert.deepEqual(attentionReasons({ ...live, api_key_pending: true }), ['new API key waiting']);
  assert.deepEqual(attentionReasons({ ...live, api_key_pending: true, api_key_competing: true }), ['several new API keys — possible copy']);
});

// Таблица блокировок — table.t (min-width 760px). Колонка сетки страницы клиники
// по умолчанию (min-width: auto) раздвигалась под неё: на 360 px страница
// уезжала вбок до 828 px, на 1280 — карточка забирала 800 px, а «Modules» и
// «Unlock code» сжимались до 306. С min-width: 0 таблица прокручивается внутри
// .table-wrap (проверено браузером: 360 → 415 px, как без карточки; 1280 → 553/553).
test('таблица блокировок не раздвигает страницу клиники: колонки сетки сужаются, таблица прокручивается в своей рамке', () => {
  const css = fs.readFileSync(path.join(HERE, 'panel.css'), 'utf8');
  assert.match(css, /\.detail-grid > div\s*\{\s*min-width:\s*0;?\s*\}/);
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow:\s*auto/);
});

test('страница клиники подключает карточку; ключ партнёра не уходит на сервер — только sha256Hex', () => {
  const detail = fs.readFileSync(path.join(HERE, 'panel-clinic-detail.js'), 'utf8');
  assert.match(detail, /import \{ renderApiCard \} from '\.\/panel-api-card\.js'/);
  assert.match(detail, /id="dt-api-card"/);
  const card = fs.readFileSync(path.join(HERE, 'panel-api-card.js'), 'utf8');
  assert.match(card, /parsed\.kind === 'key' \? await sha256Hex\(parsed\.value\) : parsed\.value/);
  assert.doesNotMatch(card, /addRevocation\([^)]*parsed\.value\s*[,}]/, 'сырое значение не уходит в addRevocation');
});

// Ревью 8c, п. 1: «Accept new key» — только по коду, который клиника прочла;
// код нового ключа на экране панели не показывается; рядом — «Block this key»;
// несколько новых ключей — принять нечего.
test('карточка: принять новый ключ — только набранным кодом; кода нового ключа на экране нет; рядом «Block this key»; несколько новых — «possible copy»', () => {
  const card = fs.readFileSync(path.join(HERE, 'panel-api-card.js'), 'utf8');
  // Перепроверка 8c, F4: новый ключ — по непрозрачному id; отпечатка карточка не знает.
  assert.match(card, /cp\.acceptSyncKey\(clinic\.id, only\.id, codeInput\.value\)/);
  assert.match(card, /cp\.addRevocation\(clinic\.id, \{ kind: 'sync_key', key_id: k\.id/);
  assert.doesNotMatch(card, /\b(only|k|r)\.fp\b/, 'карточка не обращается к отпечатку нового или прежнего ключа');
  // Перепроверка 8c, F1: звонить по номеру из своих записей, а не по тому, что даёт звонящий.
  assert.match(card, /Phone the clinic on the number in your records \(not one the caller gives\) and ask them to read the key code from Settings → API; accept only if it matches\./);
  assert.match(card, /data-block-candidate/);
  assert.match(card, /possible copy/);
  assert.match(card, /previously replaced/);
  assert.doesNotMatch(card, /keyCode\((c|cand|only|k)\.fp\)[^\n]*candidates|candidates[^\n]*keyCode\(/, 'код кандидата не рисуется');
  assert.match(card, /licenceLine\(api\.licence, api\.partners_see\)/);
  const api = fs.readFileSync(path.join(HERE, 'panel-api.js'), 'utf8');
  assert.match(api, /acceptSyncKey: \(id, keyId, code\) => request\('POST', `[^`]*\/api\/accept-key`, \{ key_id: keyId, code \}\)/);
});
