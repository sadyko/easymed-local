// RPC_PORT_V1 — update_my_doctor_profile: врач правит СВОЮ публичную карточку.
//
// Экран «Мой профиль» (кабинет врача → doctor-profile.js) звал этот RPC первым
// шагом сохранения, а на сервере его не было: 501, и до специальностей и
// «болезней, которые я лечу» сохранение не доходило никогда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { updateMyDoctorProfile, PROFILE_KEYS } from './doctor-profile.js';
import { getRpc } from './index.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, is_doctor, full_name) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'admin1', 'x', 'admin', 0, 'Админ');
  ins.run(2, 'doc1', 'x', 'doctor', 1, 'Врач Один');
  ins.run(3, 'doc2', 'x', 'doctor', 1, 'Врач Два');
  ins.run(4, 'adoc', 'x', 'admin', 1, 'Админ-врач');
  ins.run(5, 'cash', 'x', 'cashier', 0, 'Кассир');
  return db;
}

const doc = { id: 2, role: 'doctor' };

test('зарегистрирован в карте RPC', () => {
  assert.equal(typeof getRpc('update_my_doctor_profile'), 'function');
});

test('врач сохраняет свой профиль — ответ перечисляет, что записано и что офлайн не хранится', () => {
  const db = seed();
  const out = updateMyDoctorProfile(db, { p: { bio_ru: 'Кардиолог', experience_years: 12, instagram_url: '' } }, doc);
  assert.ok(Array.isArray(out.saved));
  assert.ok(Array.isArray(out.not_stored));
  // Колонок публичного профиля в офлайн-схеме нет: непустые значения честно
  // перечислены как «не хранится», пустые — не шумят.
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const k of ['bio_ru', 'experience_years']) {
    assert.ok(cols.has(k) ? out.saved.includes(k) : out.not_stored.includes(k), k);
  }
  assert.ok(!out.not_stored.includes('instagram_url'));
});

test('пишет в колонку, когда она есть, и только в строку самого врача', () => {
  const db = seed();
  db.exec('ALTER TABLE users ADD COLUMN bio_ru TEXT');
  db.exec('ALTER TABLE users ADD COLUMN education_entries TEXT');
  const out = updateMyDoctorProfile(db, { p: { bio_ru: '  Терапевт  ', education_entries: [{ ru: 'ТашМИ', year: '2001' }] } }, doc);
  assert.deepEqual(out.saved.sort(), ['bio_ru', 'education_entries']);
  const me = db.prepare('SELECT bio_ru, education_entries FROM users WHERE id = 2').get();
  assert.equal(me.bio_ru, 'Терапевт');
  assert.deepEqual(JSON.parse(me.education_entries), [{ ru: 'ТашМИ', year: '2001' }]);
  const other = db.prepare('SELECT bio_ru FROM users WHERE id = 3').get();
  assert.equal(other.bio_ru, null);
});

test('чужой id в аргументах ничего не меняет — строка всегда своя', () => {
  const db = seed();
  db.exec('ALTER TABLE users ADD COLUMN bio_ru TEXT');
  updateMyDoctorProfile(db, { user_id: 3, id: 3, p: { bio_ru: 'X' } }, doc);
  assert.equal(db.prepare('SELECT bio_ru FROM users WHERE id = 3').get().bio_ru, null);
  assert.equal(db.prepare('SELECT bio_ru FROM users WHERE id = 2').get().bio_ru, 'X');
});

test('ключ вне белого списка — отказ 400, ничего не записано', () => {
  const db = seed();
  for (const bad of ['role', 'salary_percent', 'is_doctor', 'password_hash', 'full_name']) {
    assert.throws(() => updateMyDoctorProfile(db, { p: { [bad]: 'admin' } }, doc), (e) => e.status === 400, bad);
  }
  assert.equal(db.prepare('SELECT role FROM users WHERE id = 2').get().role, 'doctor');
});

test('не врач — 403; админ-врач (is_doctor) — можно', () => {
  const db = seed();
  assert.throws(() => updateMyDoctorProfile(db, { p: {} }, { id: 5, role: 'cashier' }), (e) => e.status === 403);
  assert.throws(() => updateMyDoctorProfile(db, { p: {} }, { id: 1, role: 'admin' }), (e) => e.status === 403);
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: {} }, { id: 4, role: 'admin' }));
  assert.throws(() => updateMyDoctorProfile(db, { p: {} }, null), (e) => e.status === 401 || e.status === 403);
});

test('проверка значений: стаж — целое 0..80 или пусто, ссылки — http(s) или путь хранилища', () => {
  const db = seed();
  assert.throws(() => updateMyDoctorProfile(db, { p: { experience_years: -3 } }, doc), (e) => e.status === 400);
  assert.throws(() => updateMyDoctorProfile(db, { p: { experience_years: 500 } }, doc), (e) => e.status === 400);
  assert.throws(() => updateMyDoctorProfile(db, { p: { instagram_url: 'javascript:alert(1)' } }, doc), (e) => e.status === 400);
  assert.throws(() => updateMyDoctorProfile(db, { p: { education_entries: 'nope' } }, doc), (e) => e.status === 400);
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { experience_years: null, photo_url: '/storage/v1/object/public/doctor-photos/doctors/2/a.jpg', telegram_url: 'https://t.me/x' } }, doc));
});

test('белый список совпадает с тем, что шлёт экран', () => {
  for (const k of ['full_name_ru', 'full_name_uz', 'full_name_en', 'academic_title_ru', 'bio_en',
    'education_entries', 'experience_entries', 'certifications_entries', 'prof_dev_entries',
    'experience_years', 'instagram_url', 'telegram_url', 'photo_url']) {
    assert.ok(PROFILE_KEYS.includes(k), k);
  }
});

// RPC_PORT_V1 (доводка) — специальности и «болезни, которые я лечу» пишет
// тот же RPC, одной транзакцией. Раньше экран писал user_specialties и
// doctor_conditions напрямую: user_specialties в реестре — только admin, а
// оба insert несли company_id, которого в колонках реестра нет, — отказ был у
// ВСЕХ, включая администратора.
test('обычный врач (не админ) сохраняет специальности: до 4, первая — основная, имена из канона', () => {
  const db = seed();
  const out = updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog', 'kardiolog'] }, doc);
  assert.deepEqual(out.specialties, ['nevrolog', 'kardiolog']);
  const rows = db.prepare('SELECT specialty_slug, name_ru, name_uz, is_primary FROM user_specialties WHERE user_id = 2 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.specialty_slug, r.is_primary]), [['nevrolog', 1], ['kardiolog', 0]]);
  assert.equal(rows[0].name_ru, 'Невролог');
  assert.equal(rows[0].name_uz, 'Nevrolog');
  // повторное сохранение заменяет набор, а не дописывает
  updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog'] }, doc);
  assert.deepEqual(db.prepare('SELECT specialty_slug, is_primary FROM user_specialties WHERE user_id = 2').all()
    .map((r) => [r.specialty_slug, r.is_primary]), [['kardiolog', 1]]);
});

test('специальности: чужой набор не трогается, неизвестный слаг и больше 4 — отказ без записи', () => {
  const db = seed();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (3, 'onkolog', 'Онколог', 1)").run();
  updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog'] }, doc);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_specialties WHERE user_id = 3').get().n, 1);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, specialties: ['not-a-specialty'] }, doc), (e) => e.status === 400);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog', 'kardiolog', 'onkolog', 'androlog', 'genetik'] }, doc), (e) => e.status === 400);
  assert.deepEqual(db.prepare('SELECT specialty_slug FROM user_specialties WHERE user_id = 2').all().map((r) => r.specialty_slug), ['nevrolog']);
});

test('специальность не из канона, уже стоящая у самого врача, сохраняется (старые данные не запирают профиль)', () => {
  const db = seed();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (2, 'legacy-slug', 'Старая', 'Eski', 1)").run();
  updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog', 'legacy-slug'] }, doc);
  const rows = db.prepare('SELECT specialty_slug, name_ru, is_primary FROM user_specialties WHERE user_id = 2 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.specialty_slug, r.name_ru, r.is_primary]), [['nevrolog', 'Невролог', 1], ['legacy-slug', 'Старая', 0]]);
});

test('болезни и симптомы: свой набор заменяется, чужой цел, мусор — отказ', () => {
  const db = seed();
  db.prepare("INSERT INTO doctor_conditions (doctor_id, kind, slug, name_ru) VALUES (3, 'disease', 'x', 'X')").run();
  updateMyDoctorProfile(db, { p: {}, conditions: [
    { kind: 'disease', slug: 'gipertoniya', name_ru: 'Гипертония', name_uz: 'Gipertoniya' },
    { kind: 'symptom', slug: 'bol-golovy', name_ru: 'Головная боль' },
  ] }, doc);
  assert.deepEqual(db.prepare('SELECT kind, slug, name_ru FROM doctor_conditions WHERE doctor_id = 2 ORDER BY id').all()
    .map((r) => [r.kind, r.slug, r.name_ru]), [['disease', 'gipertoniya', 'Гипертония'], ['symptom', 'bol-golovy', 'Головная боль']]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_conditions WHERE doctor_id = 3').get().n, 1);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, conditions: [{ kind: 'drug', slug: 'a' }] }, doc), (e) => e.status === 400);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, conditions: [{ kind: 'disease', slug: '' }] }, doc), (e) => e.status === 400);
});

test('всё в одной транзакции: ошибка в болезнях не оставляет новые специальности', () => {
  const db = seed();
  updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog'] }, doc);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog'], conditions: 'nope' }, doc), (e) => e.status === 400);
  assert.deepEqual(db.prepare('SELECT specialty_slug FROM user_specialties WHERE user_id = 2').all().map((r) => r.specialty_slug), ['kardiolog']);
});

test('без ключей specialties / conditions наборы не трогаются', () => {
  const db = seed();
  updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog'], conditions: [{ kind: 'disease', slug: 'a', name_ru: 'A' }] }, doc);
  updateMyDoctorProfile(db, { p: { bio_ru: 'x' } }, doc);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_specialties WHERE user_id = 2').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_conditions WHERE doctor_id = 2').get().n, 1);
});
