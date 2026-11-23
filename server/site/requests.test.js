import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { invalidateContentCache, publishedDoctors, publishedServices } from './content.js';
import { seedDoctor, seedService } from './test-seed.js';
import { handleRequest } from './requests.js';
import { firstStageKey } from '../services/crm/contact-window.js';
import { _setSender } from './notify.js'; // WEBSITE_V1 (задача W3-5)
import { encryptToken, loadOrCreateKey } from '../services/telegram/crypto.js';

import { startSite } from './app.test.js';

// Засев — через профили (как это делает администратор), не через website_doctors.
export function seedSite(db) {
  seedDoctor(db, { ru: 'Алиев Шерзод', specialty: 'Кардиолог' });
  seedDoctor(db, { ru: 'Скрытый Врач', shown: false });
  seedService(db, { ru: 'ЭКГ', uz: 'EKG', price: 50000 });
  seedService(db, { ru: 'Секретная услуга', uz: 'Maxfiy xizmat', price: 1, shown: false });
}
function freshDb() { const db = openDb(':memory:'); migrate(db); seedSite(db); invalidateContentCache(); return db; }
const slugs = (db) => ({ doctor: publishedDoctors(db)[0].slug, service: publishedServices(db)[0].slug });
const META = { ip: '1.2.3.4', ua: 't' };

// WEBSITE_V1 (задача W3-5) — уведомление в Telegram шлётся вне транзакции,
// через setImmediate: небольшая пауза даёт этому колбэку отработать до того,
// как тест проверит, сколько раз позвал стаб-отправитель.
const tick = () => new Promise((r) => setTimeout(r, 30));

const TG_TOKEN = encryptToken('5125777202:AAFeAwoH0y0S_cWGETLD1S_8qcXRxq7elf8', loadOrCreateKey());
function enableNotify(db, chatId = '-1001234567890') {
  db.prepare('UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1').run(TG_TOKEN);
  const row = db.prepare('SELECT settings FROM website_settings WHERE id = 1').get();
  let s = {};
  try { s = JSON.parse(row?.settings || '{}'); } catch {}
  s.notify = { telegram_chat_id: chatId };
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify(s));
  invalidateContentCache();
}

const NOW = Date.now();
function futureDay() { const d = new Date(); d.setUTCDate(d.getUTCDate() + 5); return d.toISOString().slice(0, 10); }
function goodBody(db, over = {}) {
  const sl = slugs(db);
  return { type: 'appointment', full_name: 'Test Bemor', phone: '+998 90 961 00 04',
           service: sl.service, doctor: sl.doctor, preferred_date: futureDay(),
           preferred_time: 'morning', message: 'Salom', lang: 'uz',
           website: '', ts: NOW - 10_000, ...over };
}
test.afterEach(() => _setSender(null));

// WEBSITE_V1 (Easy-Med) — карточка CRM от сайта выглядит как заведённая обычным путём:
// источник website в source И в sources, первая стадия воронки, номер в формате
// +998…, пациент найден по номеру тем же правилом, что у звонка.
test('заявка на приём → карточка CRM: source/sources = website, первая стадия, номер E.164, пациент по номеру', () => {
  const db = freshDb();
  const pid = Number(db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Пациент', '+998901234567')").run().lastInsertRowid);
  const out = handleRequest(db, { type: 'appointment', full_name: 'Пациент', phone: '90 123 45 67', ts: Date.now() - 10000 }, { ip: '1.2.3.4', ua: 't' });
  const wr = db.prepare('SELECT crm_request_id FROM website_requests WHERE id = ?').get(out.id);
  const crm = db.prepare('SELECT source, sources, status, phone, patient_id FROM crm_requests WHERE id = ?').get(wr.crm_request_id);
  assert.equal(crm.source, 'website');
  assert.deepEqual(JSON.parse(crm.sources), ['website']);
  assert.equal(crm.status, firstStageKey(db) || 'in_process');
  assert.equal(crm.phone, '+998901234567');
  assert.equal(crm.patient_id, pid);
  db.close();
});

test('заявка на приём: website_requests + crm_requests + строка услуг, всё связано', () => {
  const db = freshDb();
  const body = goodBody(db);
  const out = handleRequest(db, body, META);
  const wr = db.prepare('SELECT * FROM website_requests WHERE id = ?').get(out.id);
  assert.equal(wr.type, 'appointment');
  assert.equal(wr.status, 'new');
  assert.ok(wr.crm_request_id, 'мост в CRM создан');
  const crm = db.prepare('SELECT * FROM crm_requests WHERE id = ?').get(wr.crm_request_id);
  assert.equal(crm.source, 'website');
  assert.equal(crm.scheduled_date, body.preferred_date);
  const line = db.prepare('SELECT * FROM crm_request_services WHERE request_id = ?').get(crm.id);
  assert.equal(line.status, 'pending');
  assert.ok(wr.service_id, 'service_id разрешён из слага');
  assert.equal(line.service_id, wr.service_id, 'услуга в строке совпадает с заявкой');
  assert.ok(wr.doctor_id, 'doctor_id (user_id) разрешён из слага');
  assert.equal(line.doctor_id, wr.doctor_id, 'врач проставлен');
  assert.equal(wr.ip_hash.length > 0 && wr.ip_hash.includes('.') === false, true, 'ip хэширован, не хранится сырым');
  db.close();
});

test('contact/callback: только website_requests, без CRM', () => {
  const db = freshDb();
  handleRequest(db, goodBody(db, { type: 'callback', service: '', doctor: '' }), META);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM crm_requests').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM website_requests').get().c, 1);
  db.close();
});

test('валидация: имя и телефон обязательны', () => {
  const db = freshDb();
  assert.throws(() => handleRequest(db, goodBody(db, { full_name: '  ' }), META), (e) => e.status === 400);
  assert.throws(() => handleRequest(db, goodBody(db, { phone: '12' }), META), (e) => e.status === 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM website_requests').get().c, 0);
  db.close();
});

test('мусорные слаги услуг/врача не валят заявку, а отбрасываются', () => {
  const db = freshDb();
  const out = handleRequest(db, goodBody(db, { service: 'DROP TABLE', doctor: 'nobody' }), META);
  const wr = db.prepare('SELECT service_id, doctor_id FROM website_requests WHERE id = ?').get(out.id);
  assert.equal(wr.service_id, null);
  assert.equal(wr.doctor_id, null);
  db.close();
});

test('скрытые из показа врач и услуга не принимаются по слагу (слаг — id)', () => {
  const db = freshDb();
  const hiddenDoc = db.prepare("SELECT id FROM users WHERE full_name = 'Скрытый Врач'").get().id;
  const hiddenSvc = db.prepare("SELECT id FROM services WHERE name = 'Секретная услуга'").get().id;
  const out = handleRequest(db, goodBody(db, { doctor: String(hiddenDoc), service: String(hiddenSvc) }), META);
  const wr = db.prepare('SELECT service_id, doctor_id FROM website_requests WHERE id = ?').get(out.id);
  assert.equal(wr.doctor_id, null);
  assert.equal(wr.service_id, null);
  db.close();
});

test('honeypot и слишком быстрая отправка тихо съедаются (spam, не в CRM)', () => {
  const db = freshDb();
  handleRequest(db, goodBody(db, { website: 'http://spam' }), META);
  handleRequest(db, goodBody(db, { ts: Date.now() - 500 }), META);
  const rows = db.prepare('SELECT status FROM website_requests').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'spam'), 'заявка помечена spam');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM crm_requests').get().c, 0, 'spam не попадает в CRM');
  db.close();
});

// W3-2 — связь заявки с сессией аналитики (кука wsid) + свёртка 'requests'.
test('заявка с wsid сохраняет session_id, невалидный wsid даёт NULL', () => {
  const db = freshDb();
  const good = 'a'.repeat(24);
  const cb = { type: 'callback', service: '', doctor: '' };
  handleRequest(db, goodBody(db, cb), { ...META, wsid: good });
  assert.equal(db.prepare('SELECT session_id FROM website_requests ORDER BY id DESC LIMIT 1').get().session_id, good);
  handleRequest(db, goodBody(db, cb), { ...META, wsid: 'not-a-valid-hex-id' });
  assert.equal(db.prepare('SELECT session_id FROM website_requests ORDER BY id DESC LIMIT 1').get().session_id, null);
  handleRequest(db, goodBody(db, cb), META);
  assert.equal(db.prepare('SELECT session_id FROM website_requests ORDER BY id DESC LIMIT 1').get().session_id, null);
  db.close();
});

test('свёртка requests: увеличивается на не-спам, не увеличивается на спам', () => {
  const db = freshDb();
  const day = new Date().toISOString().slice(0, 10);
  const stat = () => (db.prepare('SELECT value FROM website_stats_daily WHERE day=? AND metric=? AND key=?')
    .get(day, 'requests', '') || {}).value || 0;
  handleRequest(db, goodBody(db, { website: 'http://spam' }), META);
  assert.equal(stat(), 0, 'спам не должен попадать в свёртку заявок');
  handleRequest(db, goodBody(db, { type: 'callback', service: '', doctor: '' }), META);
  assert.equal(stat(), 1, 'обычная заявка увеличивает свёртку на 1');
  db.close();
});

// WEBSITE_V1 (задача W3-5) — уведомление в Telegram о новой заявке.
test('W3-5: не-спам заявка шлёт ровно одно уведомление в настроенный чат', async () => {
  const db = freshDb(); enableNotify(db);
  const calls = [];
  _setSender(async (token, chatId, text) => { calls.push({ chatId, text }); });
  handleRequest(db, goodBody(db), META);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, '-1001234567890');
  assert.match(calls[0].text, /Test Bemor/);
  assert.match(calls[0].text, /Запись на приём/);
  db.close();
});

test('W3-5: спам-заявка не шлёт уведомление', async () => {
  const db = freshDb(); enableNotify(db);
  const calls = [];
  _setSender(async () => { calls.push(1); });
  handleRequest(db, goodBody(db, { website: 'http://spam' }), META);
  await tick();
  assert.equal(calls.length, 0);
  db.close();
});

test('W3-5: chat_id не настроен — уведомления нет', async () => {
  const db = freshDb();
  db.prepare('UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1').run(TG_TOKEN);
  const calls = [];
  _setSender(async () => { calls.push(1); });
  handleRequest(db, goodBody(db), META);
  await tick();
  assert.equal(calls.length, 0);
  db.close();
});

test('W3-5: бот выключен — уведомления нет, даже если чат указан', async () => {
  const db = freshDb();
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify({ notify: { telegram_chat_id: '-1001234567890' } }));
  invalidateContentCache();
  const calls = [];
  _setSender(async () => { calls.push(1); });
  handleRequest(db, goodBody(db), META);
  await tick();
  assert.equal(calls.length, 0);
  db.close();
});

test('W3-5: недоступный Telegram не портит заявку — id возвращён, необработанных отказов нет', async () => {
  const db = freshDb(); enableNotify(db);
  _setSender(async () => { throw new Error('Telegram не ответил за 10 секунд.'); });
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const out = handleRequest(db, goodBody(db), META);
    assert.ok(out.id);
    await tick();
    assert.equal(unhandled, null);
  } finally { process.off('unhandledRejection', onUnhandled); db.close(); }
});

// ---- Тесты ниже идут через HTTP-приложение сайта.
const post = (base, body, headers = {}) => fetch(base + '/api/requests', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('rate limit: шестая заявка за минуту с одного IP — 429', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await post(base, goodBody(db));
    assert.equal(last.status, 429);
  } finally { server.close(); }
});

test('HTTP: заявка с кукой wsid сохраняет session_id', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const good = 'a'.repeat(24);
    const res = await post(base, goodBody(db, { type: 'callback', service: '', doctor: '' }), { Cookie: `wsid=${good}` });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT session_id FROM website_requests').get().session_id, good);
  } finally { server.close(); }
});

test('страница записи: селекты только из опубликованного', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/appointment')).text();
    assert.match(html, /ЭКГ/);
    assert.ok(!html.includes('Секретная услуга'));
    assert.ok(!html.includes('Скрытый Врач'));
    assert.match(html, /name="website"/, 'honeypot на месте');
  } finally { server.close(); }
});

// Fix round 1 (security review): битый JSON и слишком большое тело обязаны падать
// в терминальный обработчик ошибок app.js и уходить JSON-конвертом, не 500.
test('битый JSON и слишком большое тело — 4xx JSON-конверт, не голая ошибка', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const bad = await post(base, '{not valid json');
    assert.ok(bad.status >= 400 && bad.status < 500);
    assert.match(bad.headers.get('content-type') || '', /application\/json/);
    const oversized = await post(base, goodBody(db, { message: 'x'.repeat(40_000) }));
    assert.ok(oversized.status >= 400 && oversized.status < 500);
    assert.match(oversized.headers.get('content-type') || '', /application\/json/);
  } finally { server.close(); }
});
