// META_LEADS_V1_POLL (разбор и подшивка) — из сырой заявки Graph API делается
// карточка CRM тем же путём, что заявка партнёра из API (api/bookings.js
// createCard): имя, телефон в формате клиники, источник «Meta», первая открытая
// колонка, ответы формы — в комментарий. Повторы: leadgen_id в журнале один;
// открытая карточка с тем же телефоном получает ответы в комментарий, а не
// вторую карточку (правило окна повторного обращения CRM, как у звонков).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { parseLead, noteFor, fileLead, ensureMetaSource, META_SOURCE_KEY, META_SOURCE_LABEL } from './leads.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

const RAW = {
  id: '1234567890',
  created_time: '2026-10-16T09:05:00+0000',
  form_id: 'f1',
  ad_id: 'ad1', ad_name: 'Скидка 20% на УЗИ',
  campaign_id: 'c1', campaign_name: 'Осень 2026',
  platform: 'ig',
  field_data: [
    { name: 'full_name', values: ['Азиз Каримов'] },
    { name: 'phone_number', values: ['+998 90 123-45-67'] },
    { name: 'email', values: ['aziz@example.com'] },
    { name: 'какая_услуга_вас_интересует?', values: ['УЗИ брюшной полости'] },
    { name: 'удобное_время', values: ['Утро', 'Вечер'] },
  ],
};

test('parseLead: стандартные поля Meta — имя, телефон в формате клиники, e-mail; остальное — ответы с человеческими названиями', () => {
  const l = parseLead(RAW, { formName: 'Консультация' });
  assert.equal(l.leadgen_id, '1234567890');
  assert.equal(l.created_time, '2026-10-16T09:05:00+0000');
  assert.equal(l.form_id, 'f1');
  assert.equal(l.form_name, 'Консультация');
  assert.equal(l.platform, 'ig');
  assert.equal(l.full_name, 'Азиз Каримов');
  assert.equal(l.phone, '+998901234567');
  assert.equal(l.email, 'aziz@example.com');
  assert.deepEqual(l.answers, [
    { name: 'Какая услуга вас интересует?', value: 'УЗИ брюшной полости' },
    { name: 'Удобное время', value: 'Утро, Вечер' },
  ]);
  assert.deepEqual(l.field_data, RAW.field_data, 'сырые ответы сохраняются как есть');
});

test('parseLead: имя из first_name + last_name; без телефона — пусто; без имени — e-mail, телефон или «Заявка Meta»', () => {
  const a = parseLead({ id: '1', created_time: '', field_data: [{ name: 'first_name', values: ['Азиз'] }, { name: 'last_name', values: ['Каримов'] }, { name: 'phone', values: ['901234567'] }] });
  assert.equal(a.full_name, 'Азиз Каримов');
  assert.equal(a.phone, '+998901234567');
  const b = parseLead({ id: '2', created_time: '', field_data: [{ name: 'email', values: ['x@y.z'] }] });
  assert.equal(b.full_name, 'x@y.z');
  assert.equal(b.phone, '');
  const c = parseLead({ id: '3', created_time: '', field_data: [{ name: 'phone_number', values: ['+998911111111'] }] });
  assert.equal(c.full_name, '+998911111111');
  const d = parseLead({ id: '4', created_time: '', field_data: [] });
  assert.equal(d.full_name, 'Заявка Meta');
  assert.deepEqual(d.answers, []);
  const e = parseLead({ id: '5' });
  assert.equal(e.leadgen_id, '5');
  assert.deepEqual(e.field_data, []);
});

test('noteFor: шапка с площадкой и датой, строка формы/кампании/объявления, e-mail и ответы построчно', () => {
  const note = noteFor(parseLead(RAW, { formName: 'Консультация' }));
  const lines = note.split('\n');
  assert.match(lines[0], /^Заявка из рекламы Meta \(Instagram\) · \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/, lines[0]);
  assert.equal(lines[1], 'Форма: «Консультация» · Кампания: «Осень 2026» · Объявление: «Скидка 20% на УЗИ»');
  assert.equal(lines[2], 'E-mail: aziz@example.com');
  assert.equal(lines[3], 'Какая услуга вас интересует?: УЗИ брюшной полости');
  assert.equal(lines[4], 'Удобное время: Утро, Вечер');
  assert.equal(lines.length, 5);
  // Без кампании, e-mail и ответов — короче, без пустых строк и висячих разделителей.
  const bare = noteFor(parseLead({ id: '9', created_time: '2026-10-16T09:05:00+0000', platform: 'fb', field_data: [{ name: 'full_name', values: ['Имя'] }] }, { formName: 'Ф' }));
  const bl = bare.split('\n');
  assert.match(bl[0], /^Заявка из рекламы Meta \(Facebook\) · /);
  assert.equal(bl[1], 'Форма: «Ф»');
  assert.equal(bl.length, 2);
});

test('ensureMetaSource: источник «Meta» создаётся один раз, выключенный — включается обратно', () => {
  const db = fresh();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_sources WHERE key = ?').get(META_SOURCE_KEY).n, 0);
  assert.equal(ensureMetaSource(db), META_SOURCE_KEY);
  assert.equal(ensureMetaSource(db), META_SOURCE_KEY);
  const rows = db.prepare('SELECT key, label, is_active FROM crm_sources WHERE key = ?').all(META_SOURCE_KEY);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ key: META_SOURCE_KEY, label: META_SOURCE_LABEL, is_active: 1 }]);
  db.prepare('UPDATE crm_sources SET is_active = 0 WHERE key = ?').run(META_SOURCE_KEY);
  ensureMetaSource(db);
  assert.equal(db.prepare('SELECT is_active FROM crm_sources WHERE key = ?').get(META_SOURCE_KEY).is_active, 1);
});

test('fileLead: новая заявка — карточка CRM в первой открытой колонке с источником Meta и комментарием; журнал — created', () => {
  const db = fresh();
  const lead = parseLead(RAW, { formName: 'Консультация' });
  const r = fileLead(db, lead);
  assert.equal(r.status, 'created');
  const card = db.prepare('SELECT full_name, phone, source, sources, status, note FROM crm_requests WHERE id = ?').get(r.crm_request_id);
  assert.equal(card.full_name, 'Азиз Каримов');
  assert.equal(card.phone, '+998901234567');
  assert.equal(card.source, META_SOURCE_KEY);
  assert.deepEqual(JSON.parse(card.sources), [META_SOURCE_KEY]);
  const first = db.prepare("SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position, key LIMIT 1").get().key;
  assert.equal(card.status, first);
  assert.ok(card.note.startsWith('Заявка из рекламы Meta (Instagram)'));
  assert.ok(card.note.includes('УЗИ брюшной полости'));
  const j = db.prepare('SELECT leadgen_id, form_name, full_name, phone, email, status, crm_request_id, field_data_json FROM meta_leads').all();
  assert.equal(j.length, 1);
  assert.equal(j[0].leadgen_id, '1234567890');
  assert.equal(j[0].form_name, 'Консультация');
  assert.equal(j[0].phone, '+998901234567');
  assert.equal(j[0].status, 'created');
  assert.equal(j[0].crm_request_id, r.crm_request_id);
  assert.deepEqual(JSON.parse(j[0].field_data_json), RAW.field_data);
});

test('fileLead: та же заявка Meta второй раз — duplicate, ни карточки, ни строки журнала', () => {
  const db = fresh();
  const lead = parseLead(RAW, { formName: 'Консультация' });
  const first = fileLead(db, lead);
  const again = fileLead(db, lead);
  assert.equal(again.status, 'duplicate');
  assert.equal(again.crm_request_id, first.crm_request_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_leads').get().n, 1);
});

test('fileLead: открытая карточка с тем же телефоном — ответы дописываются в её комментарий, источник Meta добавляется; журнал — merged', () => {
  const db = fresh();
  const existing = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, sources, note) VALUES ('Азиз', '+998901234567', 'call', '[\"call\"]', 'Звонил вчера')").run().lastInsertRowid);
  const lead = parseLead({ ...RAW, id: '555' }, { formName: 'Консультация' });
  const r = fileLead(db, lead);
  assert.equal(r.status, 'merged');
  assert.equal(r.crm_request_id, existing);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1, 'второй карточки нет');
  const card = db.prepare('SELECT note, sources, source FROM crm_requests WHERE id = ?').get(existing);
  assert.ok(card.note.startsWith('Звонил вчера\n\nЗаявка из рекламы Meta'), card.note);
  assert.deepEqual(JSON.parse(card.sources), ['call', META_SOURCE_KEY]);
  assert.equal(card.source, 'call', 'главный источник карточки не переписывается');
  assert.equal(db.prepare("SELECT status FROM meta_leads WHERE leadgen_id = '555'").get().status, 'merged');
});

test('fileLead: без телефона — новая карточка без поиска повторов; давно закрытая карточка с тем же телефоном не мешает новой', () => {
  const db = fresh();
  const noPhone = parseLead({ id: '7', created_time: '', field_data: [{ name: 'full_name', values: ['Без телефона'] }] });
  assert.equal(fileLead(db, noPhone).status, 'created');
  const won = db.prepare("SELECT key FROM crm_stages WHERE kind = 'won' LIMIT 1").get().key;
  db.prepare("INSERT INTO crm_requests (full_name, phone, status, created_at, updated_at) VALUES ('Старый', '+998909999999', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(won);
  const lead = parseLead({ id: '8', created_time: '', field_data: [{ name: 'phone_number', values: ['+998909999999'] }] });
  const r = fileLead(db, lead);
  assert.equal(r.status, 'created');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_requests WHERE phone = '+998909999999'").get().n, 2);
});

// FIX_318_V1 (L3) — новая карточка из Meta находит пациента по номеру тем же
// правилом, что звонок (telephony/poller.js: findPatientsByPhone, активная
// карта первой): карточка открывается с картой пациента, как карточка звонка.
test('fileLead: новая карточка — пациент по номеру, правилом звонка; незнакомый номер — без пациента', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name, phone, active) VALUES (40, 'Архивная Карта', '+998 90 123 45 67', 0)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone, active) VALUES (41, 'Каримов Азиз', '+998 90 123 45 67', 1)").run();
  const r = fileLead(db, parseLead(RAW, { formName: 'Консультация' }));
  assert.equal(r.status, 'created');
  assert.equal(db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(r.crm_request_id).patient_id, 41, 'активная карта первой');
  const stranger = fileLead(db, parseLead({ ...RAW, id: '9', field_data: [{ name: 'phone_number', values: ['+998 99 000 00 01'] }] }));
  assert.equal(db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(stranger.crm_request_id).patient_id, null);
});
