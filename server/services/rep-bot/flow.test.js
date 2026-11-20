// REP_BOT_V1 — диалог бота для медпредставителей: подключение и анкета врача.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate, activeLink, findRepsByPhone, splitFio, specialtyMatches, cardDigits, T } from './flow.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const SP = (ru) => SPECIALTY_ROWS.findIndex((r) => r.ru === ru);

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (username, password_hash, role, full_name, phone, custom_role_code, is_active)
                        VALUES (?, 'x', 'callcenter', ?, ?, ?, ?)`);
  const rep = Number(u.run('rep1', 'Юсупов Акмал', '+998 90 310 65 70', 'medrep', 1).lastInsertRowid);
  u.run('rep-off', 'Уволенный Представитель', '+998901111111', 'medrep', 0);
  u.run('cashier', 'Кассир Клиники', '+998912098887', null, 1);
  return { db, rep };
}
function fakeApi() {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const method = String(url).split('/').pop();
    sent.push({ method, params: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  return { sent, deps: { fetchImpl, isLocked: () => false } };
}
const CHAT = 700;
const text = (t, chat = CHAT) => ({ message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: t } });
const contact = (phone, owner = CHAT) => ({ message: {
  chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'Акмал', username: 'akmal' },
  contact: { phone_number: phone, user_id: owner },
} });
const press = (data) => ({ callback_query: { id: 'cq', data, message: { chat: { id: CHAT } } } });
const lastText = (sent) => sent.filter((s) => s.method === 'sendMessage').at(-1).params.text;

async function connected() {
  const env = fresh();
  const api = fakeApi();
  await handleUpdate(env.db, 'tok', contact('+998903106570'), api.deps);
  env.db.prepare("UPDATE rep_bot_links SET status = 'confirmed'").run();
  return { ...env, ...api };
}
// Ответ анкеты — текст или нажатие инлайн-кнопки ({ press: 'sp:99' }).
async function fillDraft(db, deps, answers) {
  await handleUpdate(db, 'tok', text(T.addBtn), deps);
  for (const a of answers) await handleUpdate(db, 'tok', typeof a === 'string' ? text(a) : press(a.press), deps);
}
// REP_BOT_CLAIMS_V1 — полная анкета до сводки, оплата наличными.
const fullCash = (name, phone = '+998 90 765 43 21') =>
  [name, phone, 'тера', { press: 'sp:' + SP('Терапевт') }, 'Поликлиника № 5', 'Чиланзар', { press: 'pay:cash' }];
const draftRow = (db) => db.prepare('SELECT step, draft FROM rep_bot_drafts').get();

test('findRepsByPhone: только действующие сотрудники с ролью представителя, ключ — 9 цифр', () => {
  const { db, rep } = fresh();
  assert.deepEqual(findRepsByPhone(db, '903106570').map((u) => u.id), [rep]);
  assert.equal(findRepsByPhone(db, '+998901111111').length, 0, 'уволенный');
  assert.equal(findRepsByPhone(db, '+998912098887').length, 0, 'не представитель');
  assert.equal(findRepsByPhone(db, '3106570').length, 0, 'короче полного номера');
});

test('splitFio: фамилия, имя, отчество; одно слово — не ФИО', () => {
  assert.deepEqual(splitFio('  Каримов   Азиз Бахтиёр угли '), { last_name: 'Каримов', first_name: 'Азиз', middle_name: 'Бахтиёр угли', name: 'Каримов Азиз Бахтиёр угли' });
  assert.equal(splitFio('Каримов Азиз').middle_name, '');
  assert.equal(splitFio('Каримов'), null);
});

test('подключение: чужой контакт не принимается; свой — связка ждёт администратора, анкета до подтверждения не открывается', async () => {
  const { db, rep } = fresh();
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', text('/start'), deps);
  assert.equal(lastText(sent), T.greeting);

  await handleUpdate(db, 'tok', contact('+998903106570', 999), deps);
  assert.equal(lastText(sent), T.notOwn);
  assert.equal(activeLink(db, CHAT), null);

  await handleUpdate(db, 'tok', contact('+998903106570'), deps);
  const link = activeLink(db, CHAT);
  assert.equal(link.user_id, rep);
  assert.equal(link.status, 'pending');

  await handleUpdate(db, 'tok', text(T.addBtn), deps);
  assert.equal(lastText(sent), T.pending('Юсупов Акмал'), 'до подтверждения — только «заявка у клиники»');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_bot_drafts').get().n, 0);
});

test('номер, указанный у двух представителей, не подключается ни к кому', async () => {
  const { db } = fresh();
  db.prepare(`INSERT INTO users (username, password_hash, role, full_name, phone, custom_role_code) VALUES ('rep2','x','callcenter','Двойник','998903106570','medrep')`).run();
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', contact('+998903106570'), deps);
  assert.equal(lastText(sent), T.ambiguous);
  assert.equal(activeLink(db, CHAT), null);
});

test('specialtyMatches: без регистра, на трёх языках, сначала начинающиеся с написанного; меньше двух букв — ничего', () => {
  const tera = specialtyMatches('ТЕРА');
  assert.equal(tera[0], SP('Терапевт'), 'начинается с «тера» — первым');
  assert.ok(tera.includes(SP('Физиотерапевт')), 'внутри слова — тоже');
  assert.ok(specialtyMatches('jarroh').includes(SP('Хирург')), 'по-узбекски');
  assert.ok(specialtyMatches('cardiolog').includes(SP('Кардиолог')), 'по-английски');
  assert.deepEqual(specialtyMatches('т'), []);
  assert.deepEqual(specialtyMatches('абракадабра'), []);
});

test('cardDigits: ровно 16 цифр, пробелы и дефисы допустимы, буквы — нет', () => {
  assert.equal(cardDigits('8600 1234-5678 9012'), '8600123456789012');
  assert.equal(cardDigits('8600 1234 5678 901'), null);
  assert.equal(cardDigits('8600 1234 5678 90123'), null);
  assert.equal(cardDigits('8600 12x4 5678 9012'), null);
});

test('анкета: все шаги обязательны; специальность — поиском и кнопкой; «На карту» — номер карты; «Сохранить» пишет все поля', async () => {
  const { db, rep, sent, deps } = await connected();
  await fillDraft(db, deps, ['Каримов', 'Каримов Азиз Бахтиёрович', T.skipBtn, '12345', '90 123 45 67']);
  assert.ok(sent.some((s) => s.params.text === T.badName), 'одно слово — не ФИО');
  assert.ok(sent.some((s) => s.params.text.startsWith(T.required)), '«Пропустить» телефона — повтор вопроса');
  assert.ok(sent.some((s) => s.params.text === T.badPhone), 'короткий номер — не номер');
  assert.ok(!JSON.stringify(sent).includes(T.skipBtn), 'кнопки «Пропустить» больше нет ни на одном шаге');
  assert.equal(draftRow(db).step, 'specialty');

  // Поиск: ничего — просьба написать иначе; «тера» — кнопки (до 8), шаг не сдвинулся.
  await handleUpdate(db, 'tok', text('абракадабра'), deps);
  assert.equal(lastText(sent), T.noSpecialty);
  await handleUpdate(db, 'tok', text('тера'), deps);
  const kb = sent.at(-1).params.reply_markup.inline_keyboard;
  assert.equal(kb.length, 8, 'не больше восьми кнопок');
  assert.equal(kb[0][0].text, 'Терапевт');
  assert.equal(kb[0][0].callback_data, 'sp:' + SP('Терапевт'));
  assert.equal(lastText(sent), T.pickSpecialtyMore(specialtyMatches('тера').length));
  assert.equal(draftRow(db).step, 'specialty', 'текст специальности не сохраняется — только кнопка');
  await handleUpdate(db, 'tok', press('sp:' + SP('Терапевт')), deps);
  assert.equal(lastText(sent), T.askWorkplace);

  await handleUpdate(db, 'tok', text('/skip'), deps);
  assert.ok(lastText(sent).startsWith(T.required), '/skip — не место работы');
  assert.equal(JSON.parse(draftRow(db).draft).workplace, undefined);
  await handleUpdate(db, 'tok', text('Поликлиника № 5'), deps);
  await handleUpdate(db, 'tok', text('Чиланзар'), deps);
  assert.equal(lastText(sent), T.askPayment);
  assert.deepEqual(sent.at(-1).params.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ['pay:cash', 'pay:card', 'pay:transfer']);
  await handleUpdate(db, 'tok', text('карта'), deps);
  assert.equal(lastText(sent), T.askPayment, 'тип оплаты — только кнопкой');
  await handleUpdate(db, 'tok', press('pay:card'), deps);
  assert.equal(lastText(sent), T.askCard);
  await handleUpdate(db, 'tok', text('8600 1234'), deps);
  assert.equal(lastText(sent), T.badCard);
  await handleUpdate(db, 'tok', text('8600 1234 5678 9012'), deps);

  const sum = lastText(sent);
  for (const s of ['Каримов Азиз Бахтиёрович', '+998901234567', 'Терапевт', 'Поликлиника № 5', 'Чиланзар', 'На карту', '8600 1234 5678 9012']) {
    assert.ok(sum.includes(s), 'в сводке нет: ' + s);
  }
  assert.deepEqual(sent.at(-1).params.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['save', 'cancel']);

  await handleUpdate(db, 'tok', press('save'), deps);
  const src = db.prepare("SELECT * FROM referral_sources WHERE name = 'Каримов Азиз Бахтиёрович'").get();
  assert.ok(src, 'врач заведён');
  assert.equal(src.last_name, 'Каримов');
  assert.equal(src.first_name, 'Азиз');
  assert.equal(src.middle_name, 'Бахтиёрович');
  assert.equal(src.phone, '+998901234567');
  assert.equal(src.specialty, 'Терапевт');
  assert.equal(src.workplace, 'Поликлиника № 5');
  assert.equal(src.district, 'Чиланзар');
  assert.equal(src.payment_type, 'card');
  assert.equal(src.card_number, '8600123456789012');
  assert.equal(src.representative_id, rep);
  assert.equal(src.active, 1);
  assert.match(src.code, /^\d{4,}$/, 'номер выдал триггер справочника');
  assert.equal(lastText(sent), T.saved(src.name, src.code));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_bot_additions WHERE referral_source_id = ? AND user_id = ?').get(src.id, rep).n, 1);

  // Повторное нажатие на ту же кнопку — второго врача нет.
  await handleUpdate(db, 'tok', press('save'), deps);
  assert.equal(lastText(sent), T.nothingToSave);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE name = 'Каримов Азиз Бахтиёрович'").get().n, 1);

  await handleUpdate(db, 'tok', text(T.myBtn), deps);
  assert.match(lastText(sent), /Каримов Азиз Бахтиёрович/);
});

test('оплата наличными — номер карты не спрашивается и не пишется', async () => {
  const { db, sent, deps } = await connected();
  await fillDraft(db, deps, fullCash('Наличный Врач'));
  assert.equal(draftRow(db).step, 'confirm');
  assert.ok(!sent.some((s) => s.params.text === T.askCard));
  assert.ok(lastText(sent).includes('Наличные') && !lastText(sent).includes('Номер карты'));
  await handleUpdate(db, 'tok', press('save'), deps);
  const src = db.prepare("SELECT payment_type, card_number, specialty FROM referral_sources WHERE name = 'Наличный Врач'").get();
  assert.deepEqual({ ...src }, { payment_type: 'cash', card_number: null, specialty: 'Терапевт' });
});

test('кнопки анкеты снаружи: sp вне списка, sp/pay не на своём шаге, неизвестный pay — анкета не меняется', async () => {
  const { db, sent, deps } = await connected();
  await fillDraft(db, deps, ['Кнопочный Врач', '+998 90 765 43 21']);
  const before = draftRow(db);
  const n = sent.filter((s) => s.method === 'sendMessage').length;
  for (const d of ['sp:' + SPECIALTY_ROWS.length, 'sp:99999', 'sp:-1', 'pay:cash', 'pay:bitcoin', 'sp:abc']) {
    await handleUpdate(db, 'tok', press(d), deps);
  }
  assert.deepEqual(draftRow(db), before);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, n, 'ничего не отвечено');
  assert.ok(sent.filter((s) => s.method === 'answerCallbackQuery').length >= 6, 'каждое нажатие погашено');

  await handleUpdate(db, 'tok', press('sp:' + SP('Хирург')), deps);
  await handleUpdate(db, 'tok', press('sp:' + SP('Терапевт')), deps);   // старая кнопка — шаг уже другой
  assert.equal(JSON.parse(draftRow(db).draft).specialty, 'Хирург');
  assert.equal(draftRow(db).step, 'workplace');
});

test('анкета прежней версии бота: шага больше нет — в меню; сводка без обязательных полей — не сохраняется', async () => {
  const { db, link, sent, deps } = await (async () => { const c = await connected(); return { ...c, link: activeLink(c.db, CHAT) }; })();
  db.prepare("INSERT INTO rep_bot_drafts (chat_id, link_id, step, draft) VALUES (?, ?, 'category', '{}')").run(String(CHAT), link.id);
  await handleUpdate(db, 'tok', text('что-то'), deps);
  assert.equal(lastText(sent), T.menu);
  assert.equal(draftRow(db), undefined);

  // Дошла до сводки, когда всё, кроме ФИО, можно было пропустить.
  const old = { name: 'Старая Анкета', last_name: 'Старая', first_name: 'Анкета', phone: '', specialty: 'терапевт', workplace: '', district: '' };
  db.prepare("INSERT INTO rep_bot_drafts (chat_id, link_id, step, draft) VALUES (?, ?, 'confirm', ?)").run(String(CHAT), link.id, JSON.stringify(old));
  await handleUpdate(db, 'tok', press('save'), deps);
  assert.equal(lastText(sent), T.stale);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE name = 'Старая Анкета'").get().n, 0);
  assert.equal(draftRow(db), undefined);
});

test('врач с тем же номером уже есть — анкета прерывается, двойника нет', async () => {
  const { db, sent, deps } = await connected();
  db.prepare("INSERT INTO referral_sources (name, phone, active) VALUES ('Старый Врач', '998 90 123-45-67', 0)").run();
  await fillDraft(db, deps, ['Новый Врач', '+998901234567']);
  assert.match(lastText(sent), /Старый Врач/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_bot_drafts').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE name = 'Новый Врач'").get().n, 0);
});

test('«Отмена» и заблокированная лицензия: врач не заводится', async () => {
  const { db, sent, deps } = await connected();
  await fillDraft(db, deps, ['Отменённый Врач', T.cancelBtn]);
  assert.equal(lastText(sent), T.cancelled);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_bot_drafts').get().n, 0);

  await fillDraft(db, deps, fullCash('Запертый Врач'));
  await handleUpdate(db, 'tok', press('save'), { ...deps, isLocked: () => true });
  assert.equal(lastText(sent), T.locked);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE name = 'Запертый Врач'").get().n, 0);
});

test('сотрудника уволили или сменили номер — связка отозвана (триггер), бот больше не даёт заводить врачей', async () => {
  const { db, rep, sent, deps } = await connected();
  await fillDraft(db, deps, fullCash('Почти Врач'));
  db.prepare("UPDATE users SET phone = '+998 90 310 65 70' WHERE id = ?").run(rep);
  assert.ok(activeLink(db, CHAT), 'та же запись номера по цифрам — связка жива');
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(rep);
  assert.equal(activeLink(db, CHAT), null, 'уволен — связка отозвана');

  await handleUpdate(db, 'tok', press('save'), deps);
  assert.equal(lastText(sent), T.revoked);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE name = 'Почти Врач'").get().n, 0);
});

test('смена роли без триггера тоже ловится: перед действием сотрудник проверяется снова', async () => {
  const { db, rep, sent, deps } = await connected();
  db.exec('DROP TRIGGER rep_bot_links_user_changed');
  db.prepare("UPDATE users SET custom_role_code = NULL WHERE id = ?").run(rep);
  await handleUpdate(db, 'tok', text(T.addBtn), deps);
  assert.equal(lastText(sent), T.revoked);
  assert.equal(activeLink(db, CHAT), null);
});

test('сообщения из группы бот игнорирует', async () => {
  const { db, sent, deps } = await connected();
  const before = sent.length;
  await handleUpdate(db, 'tok', { message: { chat: { id: -5, type: 'group' }, from: { id: CHAT }, text: T.addBtn } }, deps);
  assert.equal(sent.length, before);
});
