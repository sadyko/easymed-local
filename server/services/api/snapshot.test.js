// PUBLIC_API_V1 — снимок наружу: только показанное партнёрам и только поля
// белого списка; ни пациентов, ни визитов, ни телефонов и почты сотрудников, ни
// ключей; свободное время — «свободно / занято» без имён, удержание и визит
// закрывают окно; ключи — отпечатками.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed, localAt } from '../../test-helpers/api-booking-seed.js';
import { fakePng } from '../../test-helpers/fake-png.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { buildSnapshot, buildSlots, buildKeys, contentHash } from './snapshot.js';
import { calendarBook } from '../rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');

function clinic() {
  const s = bookingSeed();
  const storage = tmpDir('em-snap-storage-');
  fs.mkdirSync(path.join(storage, 'clinic-logos', 'square'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'clinic-logos', 'square', 'logo1.png'), fakePng(256, 256));
  fs.mkdirSync(path.join(storage, 'doctor-photos', 'doctors', '7'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'doctor-photos', 'doctors', '7', 'face.png'), fakePng(300, 400, { pad: 3 }));
  s.db.prepare(`UPDATE doc_settings SET name_uz = 'Shifo klinikasi', phone = '+998712000000', website = 'https://shifo.uz',
    logo_square_path = 'square/logo1.png', maps_url = 'https://yandex.uz/maps/?pt=69.2401,41.2995&z=17' WHERE id = 1`).run();
  s.db.prepare("UPDATE users SET photo_url = '/api/storage/doctor-photos/doctors/7/face.png', practice_since = 2020 WHERE id = 7").run();
  s.db.prepare("INSERT INTO branches (id, name, name_uz, region_code, district_code, street_ru, phone, working_hours, show_public) VALUES (11, 'Юнусабад', 'Yunusobod', 'tashkent-city', 'yunusobod', 'ул. Амира Темура, 5', '+998712000001', '{\"mon\":{\"on\":true,\"from\":\"08:00\",\"to\":\"20:00\"}}', 1)").run();
  s.db.prepare("INSERT INTO branches (id, name, show_public) VALUES (12, 'Склад', 0)").run();
  const pkg = s.db.prepare(`INSERT INTO service_templates (id, name, name_uz, service_ids, is_package, discount_mode, discount_value, discount_percent, show_public, active)
    VALUES (?, ?, ?, ?, 1, 'percent', 15, 15, 1, 1)`);
  pkg.run(4, 'Check-up', 'Check-up', '[301,302]');
  pkg.run(5, 'Со скрытой', 'Yashirin bilan', '[301,303]');
  // То, чего снаружи быть не должно.
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone, address) VALUES (1, 'P-MARK-1', 'ПАЦИЕНТ_МЕТКА', '+998909998877', 'АДРЕС_МЕТКА')").run();
  s.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, phone, email) VALUES (20, 'cashier', 'HASH_МЕТКА', 'КАССИР_МЕТКА', 'cashier', '+998905554433', 'kassa@clinic.local')").run();
  s.db.prepare("INSERT INTO crm_requests (full_name, phone, note) VALUES ('ЗАЯВКА_МЕТКА', '+998901110000', 'ЗАМЕТКА_МЕТКА')").run();
  return { ...s, storage };
}

const ALLOWED = new Set(['version', 'generated_at', 'slug', 'clinic', 'name', 'ru', 'uz', 'en', 'about', 'country', 'city', 'district',
  'street', 'phone', 'site', 'telegram_bot', 'telegram_channel', 'instagram', 'logo', 'square', 'portrait', 'map_url', 'route_url',
  'branches', 'id', 'landmark', 'hours', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'open_24_7', 'doctors', 'title', 'bio',
  'specialties', 'experience_years', 'languages', 'photo', 'branch_ids', 'reception', 'booking_days', 'consultations', 'type', 'price',
  'minutes', 'services', 'service_id', 'group', 'packages', 'price_full', 'discount_percent', 'valid_until', 'items']);
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) keysOf(x, out); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!/^\d+$/.test(k)) out.add(k); keysOf(x, out); }
  return out;
}

test('снимок: клиника, показанные здания, врачи, услуги и пакеты — по правилам показа шагов 4–6; файлы — ссылками по отпечатку', () => {
  const s = clinic();
  const { snapshot, media } = buildSnapshot(s.db, { storageDir: s.storage, now: NOW });
  assert.equal(snapshot.slug, 'shifo');
  assert.deepEqual(snapshot.clinic.name, { ru: 'Шифо', uz: 'Shifo klinikasi', en: 'Shifo Clinic' });
  assert.match(snapshot.clinic.logo.square, /^media\/[0-9a-f]{64}\.png$/);
  assert.equal(snapshot.clinic.logo.portrait, null);
  assert.equal(snapshot.clinic.route_url, 'https://yandex.uz/maps/?rtext=~41.2995,69.2401&rtt=auto');
  assert.deepEqual(snapshot.branches.map((b) => b.id), [1, 11], 'скрытое здание не уходит');
  assert.deepEqual([snapshot.branches[0].city, snapshot.branches[0].street.ru, snapshot.branches[0].phone],
    ['tashkent-city', 'ул. Мира, 1', '+998712000000'], 'своё здание — адрес и телефон из «Компании» (шаг 4)');
  assert.deepEqual(snapshot.branches[1].hours.mon, ['08:00', '20:00']);
  assert.deepEqual(snapshot.doctors.map((d) => [d.id, d.reception]), [[7, 'booking'], [8, 'live_queue']]);
  const petrov = snapshot.doctors[0];
  assert.deepEqual([petrov.specialties, petrov.languages, petrov.experience_years, petrov.booking_days], [['pediatr'], ['ru', 'uz'], 10, 14]);
  assert.match(petrov.photo, /^media\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(petrov.consultations.map((c) => [c.type, c.price, c.minutes]), [['initial', 150000, 30], ['repeat', 98000, 15]]);
  assert.deepEqual(snapshot.services.map((x) => [x.id, x.group, x.price]), [[301, 'lab', 45000], [302, 'diagnostics', 180000]]);
  assert.deepEqual(snapshot.services[1].name, { ru: 'УЗИ брюшной полости', uz: 'Qorin bo‘shlig‘i UTT', en: '' }, 'пустой перевод — пусто: русское подставит сервер');
  assert.deepEqual(snapshot.packages.map((p) => [p.id, p.price_full, p.price]), [[4, 225000, 191000]], 'пакет со скрытой услугой не уходит (решение 14)');
  assert.equal(snapshot.packages[0].items.reduce((sum, x) => sum + x.price, 0), 191000, 'строки дают ровно цену пакета');
  assert.equal(media.length, 2);
  assert.ok(media.every((m) => m.bytes > 0 && m.type === 'image/png' && fs.existsSync(m.file)));
  s.db.prepare('UPDATE users SET is_public = 0 WHERE id = 8').run();
  assert.deepEqual(buildSnapshot(s.db, { storageDir: s.storage, now: NOW }).snapshot.doctors.map((d) => d.id), [7]);
});

test('снимок и время: только поля белого списка; ни пациентов, ни сотрудников, ни их телефонов и почты, ни заявок', () => {
  const s = clinic();
  const { snapshot } = buildSnapshot(s.db, { storageDir: s.storage, now: NOW });
  const slots = buildSlots(s.db, { now: NOW });
  const extra = [...keysOf(snapshot)].filter((k) => !ALLOWED.has(k));
  assert.deepEqual(extra, [], 'поля вне белого списка');
  const all = JSON.stringify([snapshot, slots, buildKeys(s.db, { now: NOW })]);
  for (const mark of ['МЕТКА', '998909998877', '998905554433', '998907770077', 'petrov@clinic.local', 'kassa@clinic.local', 'HASH', 'Регистратор', 'Медсестра']) {
    assert.ok(!all.includes(mark), 'наружу ушло: ' + mark);
  }
});

test('свободное время: дни на срок записи врача; удержание и визит закрывают окна; живая очередь — часы и ожидающие', async () => {
  const s = clinic();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (2, 'P-2', 'Иванов', '+998901112233')").run();
  await calendarBook(s.db, { patient_id: 2, doctor_id: 7, start: new Date(localAt('2030-03-12', '11:00')).toISOString(), duration_minutes: 30 }, s.reg);
  const slots = buildSlots(s.db, { now: NOW });
  const d7 = slots.doctors[7];
  assert.equal(d7.reception, 'booking');
  assert.equal(d7.days.length, 14);
  const day = d7.days.find((d) => d.date === '2030-03-12');
  assert.deepEqual([day.from, day.to, day.starts[0], day.starts.length], ['09:00', '18:00', '09:00', 36]);
  const at = (hhmm) => day.free[day.starts.indexOf(hhmm)];
  assert.deepEqual([at('10:45'), at('11:00'), at('11:15'), at('11:30')], ['1', '0', '0', '1']);
  const later = buildSlots(s.db, { now: localAt('2030-03-11', '10:20') }).doctors[7].days.find((d) => d.date === '2030-03-11');
  assert.deepEqual([later.free[later.starts.indexOf('10:15')], later.free[later.starts.indexOf('10:30')]], ['0', '1'], 'прошедшее сегодня — не свободно');
  assert.ok(!JSON.stringify(slots).includes('Иванов'));
  assert.deepEqual(slots.doctors[8].reception, 'live_queue');
  assert.equal(typeof slots.doctors[8].queue_now, 'number');
  assert.equal(Object.keys(slots.doctors[8].hours).length, 7);
});

test('ключи: отпечаток, права, лимит, IP и адрес сайта; ни ключа, ни секрета; удалённые не уходят; отпечаток содержимого без даты', () => {
  const s = clinic();
  s.db.prepare("UPDATE api_connections SET ip_allow = '203.0.113.7\n203.0.113.0/24' WHERE id = ?").run(s.connId);
  const keys = buildKeys(s.db, { now: NOW });
  const partner = keys.connections.find((c) => c.id === s.connId);
  const row = s.db.prepare('SELECT key_hash FROM api_connections WHERE id = ?').get(s.connId);
  assert.deepEqual({ ...partner, scopes: partner.scopes.length }, { id: s.connId, kind: 'partner', active: true, key_hash: row.key_hash,
    scopes: 6, rate_limit: 60, key_expires_at: partner.key_expires_at, ip_allow: ['203.0.113.7', '203.0.113.0/24'], origins: ['https://med24.uz'] });
  const site = keys.connections.find((c) => c.kind === 'site');
  assert.deepEqual([site.active, site.origins], [false, ['https://shifo.uz']]);
  const raw = JSON.stringify(keys);
  assert.ok(!raw.includes(s.key) && !raw.includes(s.secret));
  s.db.prepare("UPDATE api_connections SET deleted_at = '2030-03-01T00:00:00Z', active = 0, key_hash = '', key_sealed = '', secret_sealed = '' WHERE id = ?").run(s.connId);
  assert.equal(buildKeys(s.db, { now: NOW }).connections.some((c) => c.id === s.connId), false);
  assert.equal(contentHash({ generated_at: 'a', x: 1 }), contentHash({ generated_at: 'b', x: 1 }));
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 2 }));
});
