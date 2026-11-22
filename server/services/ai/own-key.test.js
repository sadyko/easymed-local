// AI_OWN_KEY_V1 — свой ключ OpenAI клиники и выключатели функций ИИ.
//
// Владелец: «first permission to use this block from settings.easymed.uz/cp, then key
// putting mirror should be opened with functions». Проверяется: модуль по-прежнему
// решает лицензия (ключ его не открывает), ключ хранится зашифрованным, неверный ключ
// не сохраняется, свой ключ ведёт ответ напрямую в ChatGPT, выключенная функция не
// берёт сообщения. Сеть подменена: ни один тест не ходит в OpenAI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { setAiEnabled, readAiSettings, setAiBlocked } from './settings.js';
import { enqueueChatJob } from './queue.js';
import { processOneJob } from './worker.js';
import {
  readFeatures, featureOn, saveFeatures, ownKeyInfo, hasOwnKey, readOwnKey, saveOwnKey, clearOwnKey,
  askOpenAiDirect, OwnKeyError,
} from './own-key.js';
import { checkOpenAiKey, DEFAULT_OPENAI_MODEL } from './openai.js';
import { aiSettingsGet, aiSettingsSave, aiKeySave, aiKeyClear } from '../rpc/ai.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-own-key-'));
setDataDir(DIR);   // файл ключа шифрования — во временном каталоге, не в data/
const KEY = 'sk-test_' + 'a'.repeat(40);
const ok = async () => 'ok';
const T0 = Date.parse('2026-11-18T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const withModule = { hasModule: () => true };
const noModule = { hasModule: () => false };

test('функции: по умолчанию все включены; выключается только названная; мусор не пишется', () => {
  const db = fresh();
  assert.deepEqual(readFeatures(db), { telegram: true, meta_dm: true, meta_comment: true, calls: false }, 'чаты — да, разбор звонков — нет');
  saveFeatures(db, { meta_dm: false, telegram: 'no', bogus: false });
  assert.deepEqual(readFeatures(db), { telegram: true, meta_dm: false, meta_comment: true, calls: false });
  assert.equal(featureOn(db, 'meta_dm'), false);
  assert.equal(featureOn(db, 'telegram'), true);
  assert.equal(featureOn(db, 'something_else'), true);
});

test('ключ: формат, отказ OpenAI и неизвестная модель не сохраняются; хранится зашифрованным', async () => {
  const db = fresh();
  await assert.rejects(saveOwnKey(db, { key: 'hello' }, { check: ok }), (e) => e instanceof OwnKeyError && e.code === 'bad_format');
  await assert.rejects(saveOwnKey(db, { key: KEY, model: 'gpt 4o!' }, { check: ok }), (e) => e.code === 'bad_model');
  await assert.rejects(saveOwnKey(db, { key: KEY }, { check: async () => 'bad_key' }), (e) => e.code === 'bad_key');
  await assert.rejects(saveOwnKey(db, { key: KEY }, { check: async () => 'bad_model' }), (e) => e.code === 'bad_model');
  assert.equal(hasOwnKey(db), false);

  const r = await saveOwnKey(db, { key: '  ' + KEY + ' ', model: 'gpt-5-mini' }, { check: ok, userId: 1 });
  assert.equal(r.check, 'ok');
  assert.deepEqual(r.info, { set: true, tail: 'aaaa', model: 'gpt-5-mini', default_model: DEFAULT_OPENAI_MODEL });
  const raw = db.prepare('SELECT openai_key_sealed FROM ai_settings').get().openai_key_sealed;
  assert.ok(raw.startsWith('v1.') && !raw.includes(KEY), 'в базе шифротекст, не ключ');
  assert.deepEqual(readOwnKey(db), { apiKey: KEY, model: 'gpt-5-mini' });

  assert.equal((await saveOwnKey(db, { key: KEY }, { check: async () => 'offline' })).check, 'offline', 'офлайн — сохраняем');
  assert.equal(ownKeyInfo(db).model, DEFAULT_OPENAI_MODEL, 'пустая модель — по умолчанию');
  clearOwnKey(db);
  assert.equal(hasOwnKey(db), false);
  assert.equal(readOwnKey(db), null);
});

test('«ключ не принят» снимается новым ключом и удалением ключа', async () => {
  const db = fresh();
  setAiBlocked(db, 'bad_key');
  await saveOwnKey(db, { key: KEY }, { check: ok });
  assert.equal(readAiSettings(db).blocked, '');
  setAiBlocked(db, 'bad_key');
  clearOwnKey(db);
  assert.equal(readAiSettings(db).blocked, '');
  setAiBlocked(db, 'limit');
  await saveOwnKey(db, { key: KEY }, { check: ok });
  assert.equal(readAiSettings(db).blocked, 'limit', 'чужая причина остановки не снимается');
});

test('прямой ответ: исход проходит проверку формы; ошибки OpenAI — понятные причины', async () => {
  const own = { apiKey: KEY, model: 'gpt-4o-mini' };
  const call = (result) => async () => ({ result });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: call({ outcome: 'reply', text: 'Да' }) }), { outcome: 'reply', text: 'Да' });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: call({ outcome: 'reply', text: '' }) }), { error: 'bad_response' });
  const fail = (status, type) => async () => { const e = new Error('x'); e.status = status; e.error = { type }; throw e; };
  assert.deepEqual(await askOpenAiDirect({}, own, { call: fail(401, 'invalid_api_key') }), { error: 'bad_key' });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: fail(429, 'insufficient_quota') }), { error: 'bad_key' });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: fail(429, 'rate_limit_exceeded') }), { error: 'network' });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: fail(500, 'server_error') }), { error: 'network' });
  assert.deepEqual(await askOpenAiDirect({}, own, { call: fail(400, 'invalid_request_error') }), { error: 'bad_response' });
});

test('проверка ключа у OpenAI: 200 — ok, 401 — bad_key, 404 — bad_model, сеть — offline', async () => {
  const f = (status) => async () => ({ ok: status === 200, status });
  assert.equal(await checkOpenAiKey(KEY, '', { fetchImpl: f(200) }), 'ok');
  assert.equal(await checkOpenAiKey(KEY, '', { fetchImpl: f(401) }), 'bad_key');
  assert.equal(await checkOpenAiKey(KEY, 'nope', { fetchImpl: f(404) }), 'bad_model');
  assert.equal(await checkOpenAiKey(KEY, '', { fetchImpl: async () => { throw new Error('offline'); } }), 'offline');
});

function tgWorld() {
  const db = fresh();
  setAiEnabled(db, true, 1, iso(T0));
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_name, last_seen_at) VALUES ('100','+998901112233','u','Алишер',?)`).run(iso(T0));
  db.prepare("INSERT INTO telegram_messages (chat_id, direction, text, kind, tg_message_id) VALUES ('100','in','Сколько стоит УЗИ?','text','7')").run();
  return db;
}
const enqueue = (db) => enqueueChatJob(db, { channel: 'telegram', chatKey: '100', sourceId: '100:7', createdAt: iso(T0 + 1000), now: T0 + 2000 });

test('выключенная функция: новое сообщение не ставится; ждущее снимается, бот подтверждает сам', async () => {
  const db = tgWorld();
  saveFeatures(db, { telegram: false });
  assert.equal(enqueue(db), 'off');
  saveFeatures(db, { telegram: true });
  assert.equal(enqueue(db), 'queued');
  saveFeatures(db, { telegram: false });
  const acks = []; const asked = [];
  const r = await processOneJob(db, {
    now: () => T0 + 3000, telegramToken: () => 'tok', facts: () => ({}),
    ask: async (p) => { asked.push(p); return { outcome: 'reply', text: 'x' }; },
    ackTelegram: async (_db, _t, chatId) => { acks.push(chatId); },
  });
  assert.equal(r, 'dropped');
  assert.equal(asked.length, 0, 'ИИ не спрашивали');
  assert.deepEqual(acks, ['100']);
  assert.equal(db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'feature_off');
});

test('исполнитель передаёт базу в ask (по ней выбирается свой ключ); «ключ не принят» останавливает ИИ', async () => {
  const db = tgWorld();
  enqueue(db);
  let gotDb = null;
  const r = await processOneJob(db, {
    now: () => T0 + 3000, telegramToken: () => 'tok', facts: () => ({}),
    ask: async (_p, d) => { gotDb = d; return { error: 'bad_key' }; },
    ackTelegram: async () => {},
  });
  assert.equal(gotDb, db);
  assert.equal(r, 'blocked');
  assert.equal(readAiSettings(db).blocked, 'bad_key');
});

test('RPC: экран видит хвост ключа и функции; ключ — только администратор и только с модулем', async () => {
  const db = fresh();
  const v = aiSettingsGet(db, {}, admin, withModule);
  assert.deepEqual(v.own_key, { set: false, tail: '', model: DEFAULT_OPENAI_MODEL, default_model: DEFAULT_OPENAI_MODEL });
  assert.deepEqual(v.features, { telegram: true, meta_dm: true, meta_comment: true, calls: false });

  await assert.rejects(aiKeySave(db, { key: KEY }, registrar, { ...withModule, check: ok }), (e) => e.status === 403);
  await assert.rejects(aiKeySave(db, { key: KEY }, admin, { ...noModule, check: ok }), (e) => e.status === 402, 'сначала модуль от вендора');
  await assert.rejects(aiKeySave(db, { key: 'bad' }, admin, { ...withModule, check: ok }), (e) => e.status === 400 && e.code === 'bad_format');
  const saved = await aiKeySave(db, { key: KEY }, admin, { ...withModule, check: ok });
  assert.equal(saved.own_key.tail, 'aaaa');
  assert.equal(saved.key_check, 'ok');
  assert.ok(!JSON.stringify(saved).includes(KEY), 'ключ в ответ не уходит');
  assert.throws(() => aiKeyClear(db, {}, registrar, withModule), (e) => e.status === 403);
  assert.equal(aiKeyClear(db, {}, admin, withModule).own_key.set, false);
});

test('RPC: функции сохраняются без главного переключателя; без модуля — отказ', () => {
  const db = fresh();
  assert.throws(() => aiSettingsSave(db, { features: { meta_dm: false } }, admin, noModule), (e) => e.status === 402);
  const r = aiSettingsSave(db, { features: { meta_dm: false } }, admin, withModule);
  assert.equal(r.features.meta_dm, false);
  assert.equal(r.enabled, false, 'главный переключатель не тронут');
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* временный каталог */ } });
