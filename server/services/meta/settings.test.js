// META_LEADS_V1_STORE — настройки подключения Meta: токен хранится ТОЛЬКО
// шифртекстом (secret-box, как ключи подключений API) и наружу не выходит —
// publicSettings отдаёт признак и хвост; правка настроек — заплаткой (отсутствующее
// поле = «оставить»); включить без токена нельзя; список форм помнит выбор.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { publicSettings, saveSettings, storeConnection, getTokens, clearToken, recordPoll, formsToPoll, SettingsError } from './settings.js';

const TOKEN = 'EAAGTESTONLYuserToken001';
const PAGE_TOKEN = 'EAAGTESTONLYpageToken002';
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const kek = () => ({ kekPath: path.join(tmpDir('em-meta-kek-'), '.api-secrets-key') });
const FORMS = [{ id: 'f1', name: 'Консультация', status: 'ACTIVE', leads_count: 12 }, { id: 'f2', name: 'УЗИ', status: 'ACTIVE', leads_count: 3 }];

test('publicSettings: без токена — выключено, token_set=false, токена нет нигде в ответе', () => {
  const db = fresh();
  const s = publicSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.token_set, false);
  assert.equal(s.token_tail, '');
  assert.equal(s.forms_mode, 'all');
  assert.deepEqual(s.forms, []);
  assert.equal(s.poll_minutes, 2);
  assert.ok(!('token_sealed' in s) && !('page_token_sealed' in s), 'шифртекст наружу не выходит');
});

test('storeConnection: токен и токен страницы — шифртекстом, хвост открыт, страница и формы записаны; getTokens расшифровывает', () => {
  const db = fresh(); const o = kek();
  storeConnection(db, { token: TOKEN, pageToken: PAGE_TOKEN, page: { id: '777', name: 'Клиника Нур' }, forms: FORMS, expiresAt: null }, o);
  const row = db.prepare('SELECT * FROM meta_settings WHERE id = 1').get();
  assert.ok(!row.token_sealed.includes(TOKEN) && row.token_sealed.startsWith('v1.'), 'запечатано, не открытый текст');
  assert.ok(!row.page_token_sealed.includes(PAGE_TOKEN));
  assert.equal(row.token_tail, TOKEN.slice(-4));
  assert.equal(row.page_id, '777');
  assert.equal(row.page_name, 'Клиника Нур');
  assert.match(row.token_checked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(getTokens(db, o), { token: TOKEN, pageToken: PAGE_TOKEN });
  const s = publicSettings(db);
  assert.equal(s.token_set, true);
  assert.equal(s.token_tail, TOKEN.slice(-4));
  assert.deepEqual(s.forms.map((f) => [f.id, f.name, f.selected, f.leads_count]), [['f1', 'Консультация', true, 12], ['f2', 'УЗИ', true, 3]]);
  assert.ok(!JSON.stringify(s).includes(TOKEN) && !JSON.stringify(s).includes(PAGE_TOKEN));
});

test('storeConnection: повторная проверка обновляет список форм, но помнит снятые галочки; пропавшая форма уходит из списка', () => {
  const db = fresh(); const o = kek();
  storeConnection(db, { token: TOKEN, pageToken: '', page: { id: '777', name: 'Клиника' }, forms: FORMS }, o);
  saveSettings(db, { forms_mode: 'selected', forms: [{ id: 'f1', selected: false }, { id: 'f2', selected: true }] }, 1);
  storeConnection(db, { token: TOKEN, pageToken: '', page: { id: '777', name: 'Клиника' },
    forms: [{ id: 'f2', name: 'УЗИ (новое имя)', status: 'ACTIVE', leads_count: 5 }, { id: 'f3', name: 'Анализы', status: 'ACTIVE', leads_count: 0 }] }, o);
  const s = publicSettings(db);
  assert.deepEqual(s.forms.map((f) => [f.id, f.name, f.selected]), [['f2', 'УЗИ (новое имя)', true], ['f3', 'Анализы', true]]);
  // getTokens без токена страницы — пустая строка, не ошибка.
  assert.deepEqual(getTokens(db, o), { token: TOKEN, pageToken: '' });
});

test('saveSettings: заплатка — меняется только присланное; период — целое не меньше 1; режим из двух слов', () => {
  const db = fresh(); const o = kek();
  storeConnection(db, { token: TOKEN, pageToken: '', page: { id: '1', name: 'P' }, forms: FORMS }, o);
  saveSettings(db, { poll_minutes: 5 }, 3);
  let s = publicSettings(db);
  assert.equal(s.poll_minutes, 5);
  assert.equal(s.forms_mode, 'all');
  assert.throws(() => saveSettings(db, { poll_minutes: 0 }, 3), SettingsError);
  assert.throws(() => saveSettings(db, { poll_minutes: 'abc' }, 3), SettingsError);
  assert.throws(() => saveSettings(db, { forms_mode: 'weird' }, 3), SettingsError);
  assert.equal(publicSettings(db).poll_minutes, 5, 'отказ ничего не записал');
  saveSettings(db, { enabled: true }, 3);
  s = publicSettings(db);
  assert.equal(s.enabled, true);
  assert.equal(db.prepare('SELECT updated_by FROM meta_settings WHERE id = 1').get().updated_by, 3);
  assert.ok(db.prepare('SELECT since_ts FROM meta_settings WHERE id = 1').get().since_ts > 0, 'включение ставит курсор «с этого момента»');
});

test('saveSettings: включить без токена нельзя — отказ 400 с понятным текстом', () => {
  const db = fresh();
  assert.throws(() => saveSettings(db, { enabled: true }, 1), (e) => e instanceof SettingsError && e.status === 400 && /токен/i.test(e.message));
  assert.equal(publicSettings(db).enabled, false);
});

test('formsToPoll: режим «все» — все формы страницы; «выбранные» — только с галочкой; без форм — пусто', () => {
  const db = fresh(); const o = kek();
  assert.deepEqual(formsToPoll(db), []);
  storeConnection(db, { token: TOKEN, pageToken: '', page: { id: '1', name: 'P' }, forms: FORMS }, o);
  assert.deepEqual(formsToPoll(db).map((f) => f.id), ['f1', 'f2']);
  saveSettings(db, { forms_mode: 'selected', forms: [{ id: 'f1', selected: false }] }, 1);
  assert.deepEqual(formsToPoll(db).map((f) => f.id), ['f2']);
  saveSettings(db, { forms_mode: 'all' }, 1);
  assert.deepEqual(formsToPoll(db).map((f) => f.id), ['f1', 'f2'], '«все» не смотрит на галочки');
});

test('clearToken: стирает оба токена, страницу и формы, выключает опрос', () => {
  const db = fresh(); const o = kek();
  storeConnection(db, { token: TOKEN, pageToken: PAGE_TOKEN, page: { id: '777', name: 'Клиника' }, forms: FORMS }, o);
  saveSettings(db, { enabled: true }, 1);
  clearToken(db, 1);
  const s = publicSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.token_set, false);
  assert.equal(s.page_id, '');
  assert.deepEqual(s.forms, []);
  assert.deepEqual(getTokens(db, o), { token: '', pageToken: '' });
});

test('recordPoll: удача — last_ok_at и пустая ошибка и сдвиг курсора; отказ — слово ошибки; bad_token выключает опрос', () => {
  const db = fresh(); const o = kek();
  storeConnection(db, { token: TOKEN, pageToken: '', page: { id: '1', name: 'P' }, forms: FORMS }, o);
  saveSettings(db, { enabled: true }, 1);
  const startTs = publicSettings(db).since_ts;
  const ahead = startTs + 600;
  recordPoll(db, { ok: true, sinceTs: ahead });
  let s = publicSettings(db);
  assert.match(s.last_poll_at, /^\d{4}-/);
  assert.match(s.last_ok_at, /^\d{4}-/);
  assert.equal(s.last_error, '');
  assert.equal(s.since_ts, ahead);
  // Курсор только вперёд: более старая отметка (повтор окна, заявка из прошлого) его не откатывает.
  recordPoll(db, { ok: true, sinceTs: ahead - 300 });
  assert.equal(publicSettings(db).since_ts, ahead);
  recordPoll(db, { ok: false, error: 'offline' });
  s = publicSettings(db);
  assert.equal(s.last_error, 'offline');
  assert.equal(s.enabled, true, 'сеть пропала — опрос остаётся включённым');
  assert.equal(s.since_ts, ahead, 'курсор при отказе не двигается');
  recordPoll(db, { ok: false, error: 'bad_token' });
  s = publicSettings(db);
  assert.equal(s.enabled, false, 'недействительный токен выключает опрос, чтобы не долбить Meta');
  assert.equal(s.last_error, 'bad_token');
});
