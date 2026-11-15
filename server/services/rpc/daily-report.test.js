// DAILY_REPORT_BOT_V1 — «Отчёт в Telegram»: только администратор; бот — свой, не
// пациентский; расписание шлёт раз в день и не шлёт при настройке; отчёт берёт
// числа сводки руководителя.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  dailyReportSettingsGet, dailyReportSettingsSave, dailyReportFindChats, dailyReportPreview, dailyReportSendNow,
} from './daily-report.js';
import { repBotSettingsSave } from './rep-bot.js';
import { isDue, tick, groupHint } from '../daily-report/index.js';
import { buildReport, delta, money } from '../daily-report/report.js';
import { getRpc } from './index.js';
import { today } from '../domain/day.js';

const TOKEN = '1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456';
const OTHER = '9876543210:AAEabcdefghijklmnopqrstuvwxyz0123456';
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Админ');
  ins.run(2, 'reg', 'x', 'registrar', 'Регистратор');
  return db;
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
/** Поддельный Telegram: ответ по имени метода, запросы записываются. */
function fakeTg(results) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    calls.push({ method, body: JSON.parse(init.body) });
    const r = results[method];
    if (r instanceof Error) return { ok: false, status: 400, json: async () => ({ ok: false, description: r.message }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: r === undefined ? true : r }) };
  };
  return { fetchImpl, calls };
}

test('RPC зарегистрированы; всё — только администратору', async () => {
  for (const n of ['daily_report_settings_get', 'daily_report_settings_save', 'daily_report_token_clear',
    'daily_report_find_chats', 'daily_report_preview', 'daily_report_send_now']) assert.ok(getRpc(n), n);
  const db = fresh();
  assert.throws(() => dailyReportSettingsGet(db, {}, registrar), (e) => e.status === 403);
  await assert.rejects(dailyReportSettingsSave(db, { send_time: '09:00' }, registrar), (e) => e.status === 403);
  assert.throws(() => dailyReportPreview(db, {}, registrar), (e) => e.status === 403);
});

test('настройки: время ЧЧ:ММ, группа — номер, хоть один блок; включить без токена и группы нельзя', async () => {
  const db = fresh();
  await assert.rejects(dailyReportSettingsSave(db, { send_time: '25:00' }, admin), /ЧЧ:ММ/);
  await assert.rejects(dailyReportSettingsSave(db, { chat_id: 'board group' }, admin), /Номер группы/);
  await assert.rejects(dailyReportSettingsSave(db, { sections: [] }, admin), /хотя бы один/);
  await assert.rejects(dailyReportSettingsSave(db, { enabled: true }, admin), /токен/);
  const s = await dailyReportSettingsSave(db, { send_time: '08:30', period: 'yesterday', sections: ['crm', 'cash'], chat_id: '-1001234567890', chat_title: 'Совет' }, admin);
  assert.equal(s.send_time, '08:30');
  assert.equal(s.period, 'yesterday');
  assert.deepEqual(s.sections, ['cash', 'crm'], 'порядок блоков — как в отчёте');
  assert.equal(s.chat_title, 'Совет');
  assert.equal(s.has_token, false);
});

test('токен: проверяется getMe, наружу — только хвост; токен другого бота клиники — отказ', async () => {
  const db = fresh();
  const s = await dailyReportSettingsSave(db, { bot_token: TOKEN }, admin, fakeTg({ getMe: { id: 1234567890, username: 'board_report_bot' } }));
  assert.equal(s.has_token, true);
  assert.equal(s.bot_username, 'board_report_bot');
  assert.ok(!JSON.stringify(s).includes('AAEabcdef'), 'токен не уходит на экран');
  await repBotSettingsSave(fresh(), {}, admin);   // другая база — не мешает
  const db2 = fresh();
  await repBotSettingsSave(db2, { bot_token: OTHER }, admin, fakeTg({ getMe: { id: 9876543210, username: 'rep' } }));
  await assert.rejects(dailyReportSettingsSave(db2, { bot_token: OTHER }, admin), /медпредставителей/);
});

test('«Найти группу»: группы из обновлений бота; убранного из группы бота там нет', async () => {
  const db = fresh();
  await dailyReportSettingsSave(db, { bot_token: TOKEN }, admin, fakeTg({ getMe: { id: 1234567890, username: 'b' } }));
  const tg = fakeTg({ getUpdates: [
    { update_id: 1, my_chat_member: { chat: { id: -1001, title: 'Совет директоров', type: 'supergroup' }, new_chat_member: { status: 'member' } } },
    { update_id: 2, message: { chat: { id: 55, type: 'private' }, text: 'hi' } },
    { update_id: 3, my_chat_member: { chat: { id: -2002, title: 'Старая группа', type: 'group' }, new_chat_member: { status: 'member' } } },
    { update_id: 4, my_chat_member: { chat: { id: -2002, title: 'Старая группа', type: 'group' }, new_chat_member: { status: 'left' } } },
  ] });
  const r = await dailyReportFindChats(db, {}, admin, tg);
  assert.deepEqual(r.chats, [{ id: '-1001', title: 'Совет директоров', type: 'supergroup' }]);
  assert.deepEqual(tg.calls[0].body.allowed_updates, ['message', 'my_chat_member'], 'событие «бота добавили в группу» запрошено');
});

test('расписание: не раньше времени, раз в день, после сбоя — через 10 минут', () => {
  const row = { enabled: 1, bot_token_enc: 'x', chat_id: '-1', send_time: '21:00', last_sent_day: null, last_attempt_at: null };
  const ms = Date.parse('2026-11-13T16:30:00Z');
  assert.equal(isDue(row, { day: '2026-11-13', hm: '20:59', ms }), false);
  assert.equal(isDue(row, { day: '2026-11-13', hm: '21:00', ms }), true);
  assert.equal(isDue({ ...row, last_sent_day: '2026-11-13' }, { day: '2026-11-13', hm: '23:00', ms }), false);
  assert.equal(isDue({ ...row, last_attempt_at: '2026-11-13T16:25:00Z' }, { day: '2026-11-13', hm: '21:30', ms }), false);
  assert.equal(isDue({ ...row, last_attempt_at: '2026-11-13T16:15:00Z' }, { day: '2026-11-13', hm: '21:30', ms }), true);
  assert.equal(isDue({ ...row, enabled: 0 }, { day: '2026-11-13', hm: '22:00', ms }), false);
  assert.equal(isDue({ ...row, chat_id: '' }, { day: '2026-11-13', hm: '22:00', ms }), false);
});

test('включили после часа отправки — сегодня не шлёт (настройка не пишет в группу); «Отправить сейчас» шлёт и расписание не трогает', async () => {
  const db = fresh();
  await dailyReportSettingsSave(db, { bot_token: TOKEN, chat_id: '-1001', send_time: '00:00' }, admin, fakeTg({ getMe: { id: 1234567890, username: 'b' } }));
  const s = await dailyReportSettingsSave(db, { enabled: true }, admin);
  assert.equal(s.enabled, true);
  assert.equal(s.last_sent_day, today(db), 'первый отчёт — завтра в 00:00, а не сразу');
  const tg = fakeTg({ sendMessage: { message_id: 7 } });
  assert.equal(await tick(db, tg), null, 'по расписанию сегодня не шлёт');
  assert.equal(tg.calls.length, 0);

  db.prepare('UPDATE daily_report_settings SET last_sent_day = NULL WHERE id = 1').run();
  const sent = await tick(db, tg);
  assert.equal(sent.ok, true, 'время настало, сегодня ещё не слали — шлёт');
  assert.equal(tg.calls[0].method, 'sendMessage');
  assert.equal(tg.calls[0].body.chat_id, '-1001');
  assert.equal(tg.calls[0].body.parse_mode, 'HTML');
  assert.equal(await tick(db, tg), null, 'второй раз за день — нет');

  const now = await dailyReportSendNow(db, {}, admin, tg);
  assert.equal(now.ok, true);
  assert.equal(tg.calls.length, 2);
});

test('сбой Telegram: текст на экран, «сегодня отправлено» не ставится', async () => {
  const db = fresh();
  await dailyReportSettingsSave(db, { bot_token: TOKEN, chat_id: '-1001' }, admin, fakeTg({ getMe: { id: 1234567890, username: 'b' } }));
  const r = await dailyReportSendNow(db, {}, admin, fakeTg({ sendMessage: new Error('Bad Request: chat not found') }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Группа не найдена/);
  assert.equal(r.settings.last_sent_day, null);
  assert.match(groupHint('Forbidden: bot was kicked from the supergroup chat'), /убрали из группы/);
});

test('отчёт: числа сводки руководителя за день, блоки — только отмеченные, суммы с пробелами', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Пациент', 'A-1')").run();
  const inv = db.prepare("INSERT INTO invoices (patient_id, invoice_number, total_amount, paid_amount, status) VALUES (1, 'INV-1', 1500000, 1500000, 'paid')").run().lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 1000000, 'cash', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(inv);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 500000, 'card', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(inv);
  // DAILY_REPORT_FORMAT_V2 — «Итог дня»: сумма в заголовке блока, строки «способ — число».
  const { text, day } = buildReport(db, { sections: ['cash'] });
  assert.equal(day, today(db));
  assert.match(text, /<b>Итог дня — \d+ [а-я]+, [а-я]+<\/b>/);
  assert.match(text, /<b>Принято за день: 1 500 000 сум( \([^)]*\))?<\/b>/);
  assert.match(text, /Наличные — 1 000 000\n/);
  assert.match(text, /Карта — 500 000\n/);
  assert.doesNotMatch(text, /<b>Колл-центр<\/b>/, 'колл-центр не отмечен — его нет');
  assert.ok(text.length <= 4096);
  assert.equal(money(1234567), '1 234 567 сум');
  assert.equal(delta(110, 100), ' (+10 %)');
  assert.equal(delta(5, 0), ' (было 0)');
  assert.equal(delta(3, 3), '');
});

test('«за вчера»: отчёт за вчерашний день, сравнение — с позавчера', async () => {
  const db = fresh();
  await dailyReportSettingsSave(db, { period: 'yesterday' }, admin);
  const r = dailyReportPreview(db, {}, admin);
  const y = new Date(Date.parse(today(db) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  assert.equal(r.day, y);
});

// DAILY_REPORT_FORMAT_V2 (2026-11-14, владелец: «first there should be total
// income then by cashier, then by coverage type») — порядок блоков и разбивки,
// каждая из которых сходится с «Принято за день».
test('«Итог дня»: принято → кассиры → покрытие → отделения → группы; разбивки сходятся с итогом', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (3, 'cas', 'x', 'cashier', 'Кассир Анна')").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Пациент', 'A-1')").run();
  const dep = db.prepare("INSERT INTO departments (name) VALUES ('Радиология')").run().lastInsertRowid;
  const st = db.prepare("INSERT INTO service_types (name) VALUES ('Диагностика')").run().lastInsertRowid;
  const svcA = db.prepare('INSERT INTO services (name, price, department_id, type_id) VALUES (?, ?, ?, ?)').run('МРТ', 300000, dep, st).lastInsertRowid;
  const svcB = db.prepare('INSERT INTO services (name, price) VALUES (?, ?)').run('Справка', 100000).lastInsertRowid;
  const payer = db.prepare("INSERT INTO payers (name, kind) VALUES ('Gross', 'insurance')").run().lastInsertRowid;
  const inv1 = db.prepare("INSERT INTO invoices (patient_id, invoice_number, total_amount, paid_amount, status, paid_at) VALUES (1, 'INV-1', 400000, 400000, 'paid', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run().lastInsertRowid;
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)').run(inv1, svcA, 'МРТ', 300000, 300000);
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)').run(inv1, svcB, 'Справка', 100000, 100000);
  const inv2 = db.prepare("INSERT INTO invoices (patient_id, invoice_number, total_amount, paid_amount, status, payer_id) VALUES (1, 'INV-2', 200000, 200000, 'partial', ?)").run(payer).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, 400000, 'cash', 3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(inv1);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, 200000, 'card', 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(inv2);

  const { text } = buildReport(db, { sections: ['cash', 'cashiers', 'coverage', 'departments', 'groups'] });
  const order = ['Принято за день', 'По кассирам', 'По типу покрытия', 'По отделениям', 'По группам услуг'].map((t) => text.indexOf('<b>' + t));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'блоки не в порядке владельца:\n' + text);
  assert.match(text, /<b>Принято за день: 600 000 сум( \([^)]*\))?<\/b>/);
  assert.match(text, /счетов закрыто — 1/);
  assert.match(text, /Кассир Анна — 400 000\nАдмин — 200 000/);
  assert.match(text, /Сам пациент — 400 000\nGross \(страховая\) — 200 000/);
  // Оплата счёта делится между его услугами по доле строки: 300 из 400 — МРТ.
  for (const line of ['(без отделения) — 300 000', 'Радиология — 300 000', '(без группы) — 300 000', 'Диагностика — 300 000']) {
    assert.ok((text + '\n').includes(line + '\n'), 'нет строки «' + line + '»:\n' + text);
  }
});

test('сохранённый список первого формата получает блоки «Итога дня» целиком', async () => {
  const { sectionsOf } = await import('../daily-report/settings.js');
  assert.deepEqual(sectionsOf(JSON.stringify(['methods', 'calls'])),
    ['cash', 'cashiers', 'coverage', 'departments', 'groups', 'patients', 'crm', 'calls']);
  assert.deepEqual(sectionsOf('[]').slice(0, 3), ['cash', 'cashiers', 'coverage'], 'новая установка: сначала принято, кассиры, покрытие');
});
