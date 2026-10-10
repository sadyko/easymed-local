// TELEGRAM_GREETING_V1 / TELEGRAM_BOT_SETUP_V1 — первое, что видит пациент,
// и настройка бота из системы.
//
// Проверяется не «текст красивый», а три обещания: узбекский идёт первым,
// приветствие перечисляет РОВНО те документы, что разрешил администратор, и
// свободный текст пациента больше не превращается в список пациентов.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { greeting, handleUpdate } from './flow.js';
import { setupBot } from './setup.js';

function seed(kinds = 'lab,conclusion,diag,invoice,file') {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE doc_settings SET clinic_name = 'Novo Medics' WHERE id = 1").run();
  db.prepare('UPDATE telegram_settings SET doc_kinds = ?, enabled = 1 WHERE id = 1').run(kinds);
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиев А.','+998 90 111 22 33')").run();
  return db;
}

function harness() {
  const sent = [];
  return { sent, deps: { fetchImpl: async (url, opts) => {
    let p = {}; try { p = JSON.parse(opts.body); } catch { p = {}; }
    sent.push({ method: String(url).split('/').pop(), params: p });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  } } };
}

const link = (db) => db.prepare(
  "INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES ('100','998901112233','Алишер')").run();

test('узбекский идёт первым, русский следом', () => {
  const db = seed();
  const g = greeting(db);
  assert.ok(g.indexOf('Assalomu alaykum') < g.indexOf('Здравствуйте'), 'узбекская строка должна быть выше');
  assert.ok(g.indexOf('Bu yerda quyidagilarni') < g.indexOf('Здесь вы можете получить'));
  assert.ok(g.indexOf('Boshlash uchun telefon') < g.indexOf('Чтобы начать'));
  db.close();
});

test('приветствие называет клинику и перечисляет виды документов', () => {
  const db = seed();
  const g = greeting(db);
  assert.match(g, /Novo Medics/);
  for (const s of ['Tahlil natijalari', 'Shifokor xulosalari', 'Diagnostika', 'Hisob-fakturalar', 'Biriktirilgan fayllar']) {
    assert.ok(g.includes(s), 'нет строки: ' + s);
  }
  db.close();
});

test('запрещённый вид документа в приветствии не обещают', () => {
  const db = seed('lab');
  const g = greeting(db);
  assert.ok(g.includes('Tahlil natijalari'));
  // Обещать счета боту, которому их выдавать запретили, — соврать на первом экране.
  assert.ok(!g.includes('Hisob-fakturalar'), 'счета выключены — упоминать нельзя');
  assert.ok(!g.includes('Shifokor xulosalari'), 'заключения выключены — упоминать нельзя');
  db.close();
});

test('незнакомый чат получает приветствие и кнопку номера', async () => {
  const db = seed();
  const { sent, deps } = harness();
  await handleUpdate(db, 'tok', { message: { chat: { id: 1 }, from: { id: 1 }, text: '/start' } }, deps);
  const m = sent.at(-1).params;
  assert.match(m.text, /Assalomu alaykum/);
  assert.ok(m.reply_markup.keyboard[0][0].request_contact, 'кнопка отправки номера');
  db.close();
});

test('свободный текст больше НЕ печатает список пациентов', async () => {
  const db = seed();
  link(db);
  const { sent, deps } = harness();

  await handleUpdate(db, 'tok', { message: { chat: { id: 100 }, from: { id: 555 }, text: 'Когда будут анализы?' } }, deps);

  const m = sent.at(-1).params;
  // Раньше на любое слово приходило меню выбора пациента. Теперь — ответ.
  assert.match(m.text, /qabul qilindi|Сообщение принято/);
  assert.ok(!m.reply_markup.inline_keyboard, 'никакого списка пациентов в ответ на вопрос');
  assert.ok(m.reply_markup.keyboard, 'кнопки остаются под рукой');
  db.close();
});

test('кнопка «Мои документы» показывает документы', async () => {
  const db = seed();
  link(db);
  const { sent, deps } = harness();
  await handleUpdate(db, 'tok', {
    message: { chat: { id: 100 }, from: { id: 555 }, text: '📄 Hujjatlarim · Мои документы' },
  }, deps);
  // У пациента документов нет — но это ответ ПРО документы, а не про сообщение.
  assert.match(sent.at(-1).params.text, /tayyor hujjatlar|Готовых документов/);
  db.close();
});

test('команда /documents работает как кнопка', async () => {
  const db = seed();
  link(db);
  const { sent, deps } = harness();
  await handleUpdate(db, 'tok', { message: { chat: { id: 100 }, from: { id: 555 }, text: '/documents' } }, deps);
  assert.match(sent.at(-1).params.text, /tayyor hujjatlar|Готовых документов/);
  db.close();
});

test('подтверждение номера сразу выдаёт постоянную клавиатуру', async () => {
  const db = seed();
  const { sent, deps } = harness();
  await handleUpdate(db, 'tok', {
    message: { chat: { id: 7 }, from: { id: 7, first_name: 'A' },
               contact: { phone_number: '+998 90 111 22 33', user_id: 7 } },
  }, deps);
  const kb = sent.find((s) => s.params.reply_markup && s.params.reply_markup.keyboard);
  assert.ok(kb, 'клавиатура должна появиться сразу после подтверждения');
  assert.match(JSON.stringify(kb.params.reply_markup), /Hujjatlarim/);
  db.close();
});

test('setup ставит команды, описание и кнопку меню', async () => {
  const db = seed();
  const { sent, deps } = harness();
  const res = await setupBot(db, 'tok', deps);

  assert.equal(res.ok, true, JSON.stringify(res.failed));
  const methods = sent.map((s) => s.method);
  assert.ok(methods.includes('setMyCommands'));
  assert.ok(methods.includes('setMyDescription'));
  assert.ok(methods.includes('setMyShortDescription'));
  assert.ok(methods.includes('setChatMenuButton'));

  // Команды ставятся отдельно для узбекского и русского интерфейса.
  const langs = sent.filter((s) => s.method === 'setMyCommands').map((s) => s.params.language_code || '');
  assert.deepEqual(langs.sort(), ['', 'ru', 'uz']);
  // Описание — тоже с узбекским впереди.
  const d = sent.find((s) => s.method === 'setMyDescription').params.description;
  assert.ok(d.indexOf('rasmiy boti') < d.indexOf('официальный бот'));
  assert.match(d, /Novo Medics/);
  db.close();
});

test('сбой оформления не считается сбоем настройки токена', async () => {
  const db = seed();
  const deps = { fetchImpl: async (url) => String(url).includes('setMyDescription')
    ? { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } };

  const res = await setupBot(db, 'tok', deps);
  assert.equal(res.ok, false);
  assert.equal(res.failed.length, 1, 'падает только описание');
  assert.ok(res.done.includes('menu_button'), 'остальные шаги всё равно выполняются');
  db.close();
});

// ---------------------------------------------------------------------------
// CLINIC_PROFILE_V1 — узбекское название клиники («Компания», name_uz) в
// узбекской строке приветствия и описания бота; русская — по-прежнему
// clinic_name. Описание бота следует за переименованием само.
// ---------------------------------------------------------------------------
test('приветствие: узбекская строка — name_uz, русская — clinic_name; без name_uz — как было', async () => {
  const db = seed();
  const plain = greeting(db);
  assert.match(plain, /Bu — «Novo Medics» klinikasining/);
  assert.match(plain, /бот клиники «Novo Medics»/);
  db.prepare("UPDATE doc_settings SET name_uz = 'Novo Medika' WHERE id = 1").run();
  const g = greeting(db);
  assert.match(g, /Bu — «Novo Medika» klinikasining/);
  assert.match(g, /бот клиники «Novo Medics»/);
  assert.ok(!/«Novo Medika»/.test(g.split('Здравствуйте')[1]), 'русская строка — с русским названием');
  db.close();
});

test('setup: описание бота — узбекская часть с name_uz, русская с clinic_name', async () => {
  const db = seed();
  db.prepare("UPDATE doc_settings SET name_uz = 'Novo Medika' WHERE id = 1").run();
  const { sent, deps } = harness();
  await setupBot(db, 'T', deps);
  const d = sent.find((s) => s.method === 'setMyDescription').params.description;
  const [uz, ru] = d.split('\n\n');
  assert.match(uz, /«Novo Medika» klinikasining/);
  assert.match(ru, /клиники «Novo Medics»/);
  db.close();
});

// CLINIC_PROFILE_V1 (ревью M5) — первый проход после обновления НЕ шлёт
// описание: у бота уже может стоять описание из @BotFather, и затирать его
// сгенерированным никто не просил. Отпечаток запоминается без отправки;
// описание уходит, только когда название клиники потом меняется.
test('первый проход без отпечатка: описание не отправляется, отпечаток запоминается; дальше — только при смене названия', async () => {
  const { syncBotDescription } = await import('./setup.js');
  const db = seed();
  const { sent, deps } = harness();

  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: false, adopted: true });
  assert.equal(sent.length, 0, 'описание из @BotFather не затирается');
  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: false });
  assert.equal(sent.length, 0, 'то же название — Telegram не спрашиваем');

  db.prepare("UPDATE doc_settings SET clinic_name = 'Другая' WHERE id = 1").run();
  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: true });
  assert.deepEqual(sent.map((s) => s.method).sort(), ['setMyDescription', 'setMyShortDescription']);
  assert.match(sent.find((s) => s.method === 'setMyDescription').params.description, /«Другая»/);

  sent.length = 0;
  db.prepare("UPDATE doc_settings SET name_uz = 'Boshqa' WHERE id = 1").run();
  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: true });
  assert.match(sent.find((s) => s.method === 'setMyDescription').params.description, /«Boshqa» klinikasining/);
  db.close();
});

// CLINIC_PROFILE_V1 (ревью M5) — сбой Telegram не повторяется каждые 30 секунд
// цикла: пауза растёт вдвое (5 мин, 10, 20, …) и не больше 6 часов; удача —
// пауза снимается.
test('сбой: повтор не на каждом проходе — пауза растёт вдвое до 6 часов; удача её снимает', async () => {
  const { syncBotDescription } = await import('./setup.js');
  const db = seed();
  let now = Date.UTC(2026, 9, 10, 9, 0, 0);
  const MIN = 60 * 1000;
  const { sent, deps: okDeps } = harness();
  const ok = { ...okDeps, now: () => now };
  let failCalls = 0;
  const failing = { now: () => now, fetchImpl: async () => { failCalls++; return { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }; } };

  await syncBotDescription(db, 'T', ok);   // отпечаток запомнен
  db.prepare("UPDATE doc_settings SET clinic_name = 'Другая' WHERE id = 1").run();

  await assert.rejects(() => syncBotDescription(db, 'T', failing));
  assert.equal(failCalls, 1);
  now += 30 * 1000;
  assert.deepEqual(await syncBotDescription(db, 'T', failing), { changed: false, waiting: true });
  now += 4 * MIN;
  assert.deepEqual(await syncBotDescription(db, 'T', failing), { changed: false, waiting: true });
  assert.equal(failCalls, 1, 'в пределах паузы Telegram не спрашиваем');

  now += 1 * MIN;                                   // 5 мин прошло — повтор
  await assert.rejects(() => syncBotDescription(db, 'T', failing));
  assert.equal(failCalls, 2);
  now += 9 * MIN;
  assert.deepEqual(await syncBotDescription(db, 'T', failing), { changed: false, waiting: true }, 'вторая пауза — 10 мин');
  now += 1 * MIN;
  await assert.rejects(() => syncBotDescription(db, 'T', failing));
  assert.equal(failCalls, 3);

  for (let i = 0; i < 12; i++) { now += 7 * 60 * MIN; await assert.rejects(() => syncBotDescription(db, 'T', failing)); }
  const calls = failCalls;
  now += 6 * 60 * MIN - MIN;
  assert.deepEqual(await syncBotDescription(db, 'T', failing), { changed: false, waiting: true }, 'пауза не больше 6 часов');
  now += MIN;
  await assert.rejects(() => syncBotDescription(db, 'T', failing));
  assert.equal(failCalls, calls + 1, 'через 6 часов — повтор');

  now += 6 * 60 * MIN;
  assert.deepEqual(await syncBotDescription(db, 'T', ok), { changed: true });
  assert.ok(sent.some((s) => s.method === 'setMyDescription'));
  sent.length = 0;
  db.prepare("UPDATE doc_settings SET clinic_name = 'Третья' WHERE id = 1").run();
  assert.deepEqual(await syncBotDescription(db, 'T', ok), { changed: true }, 'после удачи пауза снята — новое название уходит сразу');
  db.close();
});

test('setup не смог поставить описание — цикл не принимает молча, а досылает', async () => {
  const { syncBotDescription } = await import('./setup.js');
  const db = seed();
  const failingDescription = { fetchImpl: async (url) => String(url).includes('Description')
    ? { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } };
  const res = await setupBot(db, 'T', failingDescription);
  assert.equal(res.ok, false);
  const { sent, deps } = harness();
  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: true });
  assert.ok(sent.some((s) => s.method === 'setMyDescription'));
  db.close();
});

test('setup после успешной настройки описания — синхронизация не повторяет его', async () => {
  const { syncBotDescription } = await import('./setup.js');
  const db = seed();
  const { sent, deps } = harness();
  await setupBot(db, 'T', deps);
  sent.length = 0;
  assert.deepEqual(await syncBotDescription(db, 'T', deps), { changed: false });
  assert.equal(sent.length, 0);
  db.close();
});

test('цикл бота зовёт синхронизацию описания на проходе рассылки', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ syncBotDescription \} from '\.\/setup\.js';/);
  const push = src.indexOf('runPushScan(db, cfg.token)');
  const sync = src.indexOf('syncBotDescription(db, cfg.token)');
  assert.ok(push > 0 && sync > push, 'синхронизация описания — сразу после прохода рассылки');
});
