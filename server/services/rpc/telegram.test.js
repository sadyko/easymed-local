// TELEGRAM_BOT_V1 — раздел настроек бота.
//
// Главное, что здесь проверяется, — токен. Он не должен уходить в браузер ни
// одним ответом, не должен теряться при обычном сохранении формы и не должен
// быть доступен никому, кроме администратора. Предыдущая версия этой функции
// в клинике хранила семь живых токенов открытым текстом в конфиге, доступном
// на чтение кому угодно; эти тесты — про то, чтобы не повторить.
//
// Второй сюжет — «вставил токен, и всё заработало»: сохранение токена само
// проверяет связь и включает бота. Три раздельных шага (сохранить → проверить
// → включить) уже приводили к молча неработающему боту.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { REGISTRY } from '../../db/schema-registry.js';
import { telegramSettingsGet, telegramSettingsSave, telegramTokenClear, telegramTestConnection,
         telegramLinksList, telegramLinkRevoke } from './telegram.js';
import { getDecryptedToken } from '../telegram/settings.js';

const TOKEN = '1000000001:TESTONLYtestonlyTESTONLYtestonly123';
const OTHER = '1000000002:TESTONLYtestonlyTESTONLYtestonly456';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse', extra_roles: ['lab'] };

// Ключ шифрования — во временный каталог: тесты не трогают рабочий data/.
process.env.EASYMED_TELEGRAM_KEY_PATH =
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tg-rpc-')), '.telegram-key');

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  // telegram_settings.updated_by ссылается на users — «кто менял настройки
  // бота» должно быть реальным сотрудником, поэтому заводим их по-настоящему.
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  ins.run(1, 'boss', 'x', 'Админ', 'admin');
  ins.run(2, 'reg', 'x', 'Регистратор', 'registrar');
  ins.run(3, 'nurse', 'x', 'Медсестра', 'nurse');
  return db;
}

// Поддельный транспорт: сеть в тестах не нужна.
const fakeFetch = (payload, { status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const okBot = (username = 'easymed_clinic_bot') =>
  ({ fetchImpl: fakeFetch({ ok: true, result: { id: 5125777202, username, first_name: 'Клиника' } }) });
const badToken = () => ({ fetchImpl: fakeFetch({ ok: false, description: 'Unauthorized' }, { status: 401 }) });

// Сохранить токен так, как это делает администратор из интерфейса.
const saveToken = (db, token = TOKEN, deps = okBot()) =>
  telegramSettingsSave(db, { bot_token: token }, admin, deps);

test('раздел закрыт для всех, кроме администратора', async () => {
  const db = freshDb();
  for (const user of [registrar, nurse, null, undefined, {}]) {
    assert.throws(() => telegramSettingsGet(db, {}, user), (e) => e.status === 403, 'чтение');
    assert.throws(() => telegramTokenClear(db, {}, user), (e) => e.status === 403, 'удаление токена');
    assert.throws(() => telegramLinksList(db, {}, user), (e) => e.status === 403, 'связанные чаты');
    assert.throws(() => telegramLinkRevoke(db, { id: 1 }, user), (e) => e.status === 403, 'отвязать');
    await assert.rejects(() => telegramSettingsSave(db, { bot_token: TOKEN }, user), (e) => e.status === 403, 'запись');
  }
  db.close();
});

test('сохранённый токен не возвращается наружу — только хвост', async () => {
  const db = freshDb();
  const saved = await saveToken(db);

  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes(TOKEN), 'токен целиком не должен попадать в ответ');
  assert.ok(!serialized.includes('AAFeAwoH'), 'секретная часть токена не должна попадать в ответ');
  assert.equal(saved.has_token, true);
  assert.equal(saved.token_hint, 'elf8');

  assert.ok(!JSON.stringify(telegramSettingsGet(db, {}, admin)).includes('AAFeAwoH'));
  db.close();
});

test('токен лежит в базе зашифрованным, а не открытым текстом', async () => {
  const db = freshDb();
  await saveToken(db);

  const row = db.prepare('SELECT * FROM telegram_settings WHERE id = 1').get();
  assert.ok(!JSON.stringify(row).includes('AAFeAwoH'), 'в строке БД не должно быть секрета');
  assert.ok(row.bot_token_enc.length > 0);
  assert.equal(getDecryptedToken(db), TOKEN, 'но сервер обязан уметь его прочитать');
  db.close();
});

test('один только ввод токена включает бота — без отдельных шагов', async () => {
  const db = freshDb();
  const res = await saveToken(db);

  // Ровно то, ради чего это переписано: администратор вставил токен — и всё.
  assert.equal(res.auto_enabled, true);
  assert.equal(res.enabled, true, 'бот включён сам');
  assert.equal(res.last_check_status, 'ok', 'связь проверена сама');
  assert.equal(res.bot_username, 'easymed_clinic_bot', '@username сохранён для ссылки t.me');
  assert.equal(res.bot.username, 'easymed_clinic_bot');
  db.close();
});

test('токен, отклонённый Telegram, НЕ включает бота', async () => {
  const db = freshDb();
  const res = await telegramSettingsSave(db, { bot_token: TOKEN }, admin, badToken());

  assert.equal(res.enabled, false, 'включённый бот с нерабочим токеном — враньё интерфейса');
  assert.equal(res.last_check_status, 'error');
  assert.match(res.check_error, /токен/i, 'администратору говорят, что не так');
  assert.equal(getDecryptedToken(db), TOKEN, 'но сам токен сохранён — опечатку можно исправить');
  db.close();
});

test('обычное сохранение формы не стирает уже сохранённый токен', async () => {
  const db = freshDb();
  await saveToken(db);

  // UI присылает токен только когда администратор ввёл новый. Сохранение
  // одних галочек не должно обнулять секрет — классическая ошибка таких форм.
  await telegramSettingsSave(db, { push_enabled: false }, admin);
  assert.equal(getDecryptedToken(db), TOKEN);

  await telegramSettingsSave(db, { bot_token: '' }, admin);
  assert.equal(getDecryptedToken(db), TOKEN, 'пустая строка — это «не менять»');

  await telegramSettingsSave(db, { bot_token: '   ' }, admin);
  assert.equal(getDecryptedToken(db), TOKEN, 'пробелы — тоже «не менять»');
  db.close();
});

test('новый токен заменяет старый и переопознаёт бота', async () => {
  const db = freshDb();
  await saveToken(db, TOKEN, okBot('old_bot'));

  const after = await saveToken(db, OTHER, okBot('new_bot'));
  assert.equal(getDecryptedToken(db), OTHER);
  // Новый токен — возможно, другой бот; интерфейс не должен показывать
  // прежний @username как текущий.
  assert.equal(after.bot_username, 'new_bot');
  assert.equal(after.token_hint, 'eYxs');
  db.close();
});

test('опечатка в токене ловится до сохранения и до похода в сеть', async () => {
  const db = freshDb();
  const noNet = { fetchImpl: async () => { throw new Error('сеть не должна вызываться'); } };
  await assert.rejects(() => telegramSettingsSave(db, { bot_token: 'мой токен' }, admin, noNet), /не похоже на токен/);
  await assert.rejects(() => telegramSettingsSave(db, { bot_token: '5125777202' }, admin, noNet), /не похоже на токен/);
  assert.equal(telegramSettingsGet(db, {}, admin).has_token, false, 'битый токен не сохраняется');
  db.close();
});

test('бота нельзя включить вручную, пока нет токена', async () => {
  const db = freshDb();
  await assert.rejects(() => telegramSettingsSave(db, { enabled: true }, admin), /Сначала введите токен/);
  assert.equal(telegramSettingsGet(db, {}, admin).enabled, false);
  db.close();
});

test('удаление токена выключает бота', async () => {
  const db = freshDb();
  await saveToken(db);
  assert.equal(telegramSettingsGet(db, {}, admin).enabled, true);

  const after = telegramTokenClear(db, {}, admin);
  assert.equal(after.has_token, false);
  assert.equal(after.enabled, false, 'включённый бот без токена — это враньё интерфейса');
  assert.equal(getDecryptedToken(db), '');
  db.close();
});

test('неизвестный вид документа не сохраняется', async () => {
  const db = freshDb();
  await assert.rejects(() => telegramSettingsSave(db, { doc_kinds: ['lab', 'рентген'] }, admin), /Неизвестный вид/);
  const ok = await telegramSettingsSave(db, { doc_kinds: ['lab', 'lab', 'invoice'] }, admin);
  assert.deepEqual(ok.doc_kinds, ['lab', 'invoice'], 'дубликаты схлопываются');
  db.close();
});

test('счета входят в выдачу по умолчанию', () => {
  // Пациент, у которого из документов только счета, не должен видеть
  // «готовых документов нет»: счета не рассылаются автоматически, но забрать
  // свой счёт из меню он вправе.
  const db = freshDb();
  assert.ok(telegramSettingsGet(db, {}, admin).doc_kinds.includes('invoice'));
  db.close();
});

test('проверка связи отдельной кнопкой по-прежнему работает', async () => {
  const db = freshDb();
  await saveToken(db);

  const res = await telegramTestConnection(db, {}, admin, okBot('checked_bot'));
  assert.equal(res.ok, true);
  assert.equal(res.settings.bot_username, 'checked_bot');
  assert.ok(!JSON.stringify(res).includes('AAFeAwoH'), 'проверка связи тоже не отдаёт токен');
  db.close();
});

test('отсутствие интернета объясняется человеческим языком', async () => {
  const db = freshDb();
  await saveToken(db);
  const res = await telegramTestConnection(db, {}, admin, {
    fetchImpl: async () => { const e = new Error('fetch failed'); e.name = 'TypeError'; throw e; },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /интернет/i, 'клиника без интернета должна понять причину');
  db.close();
});

test('проверка связи без токена — понятная ошибка, а не поход в сеть', async () => {
  const db = freshDb();
  await assert.rejects(
    () => telegramTestConnection(db, {}, admin, { fetchImpl: async () => { throw new Error('сеть не должна вызываться'); } }),
    /Токен бота не задан/);
  db.close();
});

test('связанный чат виден администратору вместе с числом открытых им карт', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиев А.','+998 90 111 22 33')").run();
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиева Н.','+998 90 111 22 33')").run();
  db.prepare("INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES ('77','998901112233','М А')").run();

  const list = telegramLinksList(db, {}, admin);
  assert.equal(list.length, 1);
  // Доступ по одному номеру открывает всю семью — администратор должен это видеть.
  assert.equal(list[0].patients.length, 2);
  assert.equal(list[0].revoked, false);

  const after = telegramLinkRevoke(db, { id: list[0].id }, admin);
  assert.equal(after[0].revoked, true, 'отвязанный чат остаётся в списке — журнал не теряет историю');
  db.close();
});

test('таблицы бота недостижимы через /api/db', () => {
  // Реестр — белый список; отсутствие в нём и есть защита. Тест ловит момент,
  // когда кто-нибудь добавит telegram_settings «чтобы UI было проще».
  for (const t of ['telegram_settings', 'telegram_links', 'telegram_deliveries', 'telegram_state']) {
    assert.equal(REGISTRY[t], undefined, t);
  }
});
