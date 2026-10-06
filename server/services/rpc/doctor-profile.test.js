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
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';   // CLINIC_API_FIX_V1 — отказы переводятся

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

// DOCTOR_PUBLIC_PROFILE_V1 (мигр. 159) — колонки есть: всё из белого списка
// хранится, `not_stored` пуст, и экран больше не пишет «не хранятся».
test('врач сохраняет свой профиль — ВСЕ поля белого списка хранятся, not_stored пуст', () => {
  const db = seed();
  const p = {
    full_name_ru: 'Иванов Иван', full_name_uz: 'Ivanov Ivan', full_name_en: 'Ivan Ivanov',
    academic_title_ru: 'Кандидат медицинских наук', academic_title_uz: 'Tibbiyot fanlari nomzodi', academic_title_en: 'Candidate of Medical Sciences',
    bio_ru: 'Кардиолог', bio_uz: 'Kardiolog', bio_en: 'Cardiologist',
    education_entries: [{ ru: 'ТашМИ', year_from: '1995', year_to: '2001' }],
    experience_entries: [{ ru: 'Клиника', title: 'Врач' }],
    certifications_entries: [{ ru: 'ЭхоКГ', year: '2020' }],
    prof_dev_entries: [{ ru: 'Курс', year: '2024' }],
    experience_years: 12, instagram_url: 'https://instagram.com/doc', telegram_url: 'https://t.me/doc',
    photo_url: '/api/storage/doctor-photos/doctors/2/a.jpg',
  };
  const out = updateMyDoctorProfile(db, { p }, doc);
  assert.deepEqual(out.not_stored, []);
  assert.deepEqual(out.saved.sort(), Object.keys(p).sort());
  const row = db.prepare('SELECT * FROM users WHERE id = 2').get();
  assert.equal(row.bio_uz, 'Kardiolog');
  assert.equal(row.experience_years, 12);
  assert.equal(row.photo_url, '/api/storage/doctor-photos/doctors/2/a.jpg');
  assert.deepEqual(JSON.parse(row.certifications_entries), [{ ru: 'ЭхоКГ', year: '2020' }]);
  // каждая колонка белого списка есть в схеме
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const k of PROFILE_KEYS) assert.ok(cols.has(k), 'нет колонки users.' + k);
});

test('пишет в колонку и только в строку самого врача', () => {
  const db = seed();
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
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { experience_years: null, photo_url: '/api/storage/doctor-photos/doctors/2/a.jpg', telegram_url: 'https://t.me/x' } }, doc));
});

// DOCTOR_PUBLIC_PROFILE_V1, ревью M4 — фото только из своего хранилища: внешняя
// ссылка ушла бы партнёрам в API как чужая картинка, которую клиника не хранит
// и не контролирует; путь с «..» — выход из папки врача.
test('photo_url: только путь хранилища doctor-photos, внешние ссылки и выход из папки — отказ', () => {
  const db = seed();
  for (const bad of ['https://example.com/a.jpg', 'http://x/a.jpg', '/api/storage/patient-photos/p/1.jpg',
    '/api/storage/doctor-photos/../patient-photos/1.jpg', '/storage/v1/object/public/doctor-photos/doctors/2/a.jpg', '//evil/a.jpg']) {
    assert.throws(() => updateMyDoctorProfile(db, { p: { photo_url: bad } }, doc), (e) => e.status === 400, bad);
  }
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { photo_url: '' } }, doc), 'пусто — убрать фото');
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

// JOURNALS_V1_SPECIALTIES (владелец, 2026-10-02) — «иглотерапевт» и «нейрофизиолог»
// приняты каноном: слаг узнаётся, имена — из списка, а не от клиента.
test('специальности владельца 02.10: Иглотерапевт и Нейрофизиолог сохраняются по слагу канона', () => {
  const db = seed();
  const out = updateMyDoctorProfile(db, { p: {}, specialties: ['neyrofiziolog', 'igloterapevt'] }, doc);
  assert.deepEqual(out.specialties, ['neyrofiziolog', 'igloterapevt']);
  const rows = db.prepare('SELECT specialty_slug, name_ru, name_uz, is_primary FROM user_specialties WHERE user_id = 2 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.specialty_slug, r.name_ru, r.name_uz, r.is_primary]),
    [['neyrofiziolog', 'Нейрофизиолог', 'Neyrofiziolog', 1], ['igloterapevt', 'Иглотерапевт', 'Ignaterapevt', 0]]);
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

// CLINIC_API_FIX_V1 — «Мой профиль» шлёт только изменённые поля. Присланное
// пишется, остальное (в том числе правка администратора в карточке, сделанная
// после того, как врач открыл экран) остаётся; updated_at строки врача
// показывает, когда профиль менялся.
test('CLINIC_API_FIX_V1: частичный набор пишет только присланное, правка администратора цела', () => {
  const db = seed();
  db.prepare("UPDATE users SET bio_ru = 'Старое', bio_uz = 'Admin yozdi', full_name_ru = 'Иванов Иван' WHERE id = 2").run();
  const out = updateMyDoctorProfile(db, { p: { bio_ru: 'Новое' } }, doc);
  assert.deepEqual(out.saved, ['bio_ru']);
  const row = db.prepare('SELECT bio_ru, bio_uz, full_name_ru FROM users WHERE id = 2').get();
  assert.deepEqual({ ...row }, { bio_ru: 'Новое', bio_uz: 'Admin yozdi', full_name_ru: 'Иванов Иван' });
});

test('CLINIC_API_FIX_V1: сохранение профиля обновляет updated_at строки врача', () => {
  const db = seed();
  const OLD = '2000-01-01T00:00:00Z';
  const stamp = (id) => db.prepare('SELECT updated_at FROM users WHERE id = ?').get(id).updated_at;
  const reset = () => db.prepare('UPDATE users SET updated_at = ? WHERE id IN (2, 3)').run(OLD);

  reset();
  updateMyDoctorProfile(db, { p: { bio_ru: 'x' } }, doc);
  assert.notEqual(stamp(2), OLD, 'поля профиля сохранены, а updated_at прежний');
  assert.match(stamp(2), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(stamp(3), OLD, 'чужая строка не трогается');

  reset();
  updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog'] }, doc);
  assert.notEqual(stamp(2), OLD, 'специальности сохранены, а updated_at прежний');

  reset();
  updateMyDoctorProfile(db, { p: {}, conditions: [{ kind: 'disease', slug: 'a', name_ru: 'A' }] }, doc);
  assert.notEqual(stamp(2), OLD, 'болезни сохранены, а updated_at прежний');

  reset();
  updateMyDoctorProfile(db, { p: {} }, doc);
  assert.equal(stamp(2), OLD, 'ничего не прислано — строка не менялась');
});

// Ревью M7a — users.specialty (одна строка, которую читают списки врачей,
// отчёты по специальностям, бланки) обязана совпадать с основной
// специальностью, как её держит routes/users.js при правке сотрудника.
test('M7a: users.specialty = имя основной специальности, в той же транзакции', () => {
  const db = seed();
  updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog', 'kardiolog'] }, doc);
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, 'Невролог');
  updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog'] }, doc);
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, 'Кардиолог');
  updateMyDoctorProfile(db, { p: {}, specialties: [] }, doc);
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, '');
  updateMyDoctorProfile(db, { p: { bio_ru: 'x' } }, doc);   // без ключа specialties — не трогается
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, '');
});

// Ревью M7b — карточка сотрудника (routes/users.js parseSpecialties) пишет
// специальность без слага, одним названием. Такой врач не мог сохранить
// профиль вовсе, а его специальность нельзя терять.
test('M7b: специальность без слага из карточки сотрудника сохраняется, профиль сохраняется', () => {
  const db = seed();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (2, NULL, 'Семейный врач', 1)").run();
  db.prepare("UPDATE users SET specialty = 'Семейный врач' WHERE id = 2").run();
  // экран не видит её в своём списке и шлёт только то, что видит (null не шлёт,
  // но и присланный null не валит сохранение)
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: {}, specialties: ['kardiolog', null] }, doc));
  const rows = db.prepare('SELECT specialty_slug, name_ru, is_primary FROM user_specialties WHERE user_id = 2 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.specialty_slug, r.name_ru, r.is_primary]),
    [['kardiolog', 'Кардиолог', 1], [null, 'Семейный врач', 0]]);
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, 'Кардиолог');
  // пустой видимый список — старая специальность остаётся и становится основной
  updateMyDoctorProfile(db, { p: {}, specialties: [] }, doc);
  const rows2 = db.prepare('SELECT specialty_slug, name_ru, is_primary FROM user_specialties WHERE user_id = 2 ORDER BY id').all();
  assert.deepEqual(rows2.map((r) => [r.specialty_slug, r.name_ru, r.is_primary]), [[null, 'Семейный врач', 1]]);
  assert.equal(db.prepare('SELECT specialty FROM users WHERE id = 2').get().specialty, 'Семейный врач');
});

test('M7b: старая строка без слага с каноническим именем не дублируется, когда экран прислал её слаг', () => {
  const db = seed();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (2, NULL, 'Невролог', 1)").run();
  updateMyDoctorProfile(db, { p: {}, specialties: ['nevrolog'] }, doc);
  const rows = db.prepare('SELECT specialty_slug, name_ru FROM user_specialties WHERE user_id = 2').all();
  assert.deepEqual(rows.map((r) => [r.specialty_slug, r.name_ru]), [['nevrolog', 'Невролог']]);
});

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 — «МОЙ ПРОФИЛЬ» ВО ВТОРОМ ЗДАНИИ. Врач, чья строка приехала
// из главного здания (users.is_local = 0, STAFF_SYNC_V1), сохранял профиль,
// а ежечасная синхронизация справочника (branch-sync/catalogue.js — колонки
// публичного профиля едут вместе с сотрудником) молча переписывала правку.
// Карточка сотрудника такой строке уже отказывает 409 (routes/users.js,
// mainClinicRow); врач теперь слышит то же — отказ всему сохранению, без записи.
// ---------------------------------------------------------------------------
const MANAGED_MSG = 'Профиль врача меняется в главном здании.';
const managedRefusal = (e) => e.status === 409 && e.code === 'conflict' && e.message === MANAGED_MSG;

test('CLINIC_API_FIX_V1: врач из главного здания — 409 «Профиль врача меняется в главном здании», ничего не записано', () => {
  const db = seed();
  const OLD = '2000-01-01T00:00:00Z';
  db.prepare("UPDATE users SET is_local = 0, bio_ru = 'Старое', specialty = 'Терапевт', updated_at = ? WHERE id = 2").run(OLD);
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (2, 'terapevt', 'Терапевт', 1)").run();
  const before = { ...db.prepare('SELECT * FROM users WHERE id = 2').get() };
  assert.throws(() => updateMyDoctorProfile(db, {
    p: { bio_ru: 'Новое', photo_url: '/api/storage/doctor-photos/doctors/2/a.jpg' },
    specialties: ['kardiolog'], conditions: [{ kind: 'disease', slug: 'a', name_ru: 'A' }],
  }, doc), managedRefusal);
  assert.deepEqual({ ...db.prepare('SELECT * FROM users WHERE id = 2').get() }, before, 'строка врача изменилась');
  assert.deepEqual(db.prepare('SELECT specialty_slug FROM user_specialties WHERE user_id = 2').all().map((r) => r.specialty_slug), ['terapevt']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_conditions WHERE doctor_id = 2').get().n, 0);
  // Пустой вызов — тот же отказ: экран спрашивает его до загрузки фото, чтобы
  // не класть в хранилище файл, который сохранение не примет.
  assert.throws(() => updateMyDoctorProfile(db, { p: {} }, doc), managedRefusal);
  // Отказ — раньше проверки значений: врач слышит настоящую причину.
  assert.throws(() => updateMyDoctorProfile(db, { p: { experience_years: -1 } }, doc), managedRefusal);
  // Через карту RPC — тот же отказ (его отдаёт маршрут /api/rpc).
  assert.throws(() => getRpc('update_my_doctor_profile')(db, { p: { bio_ru: 'x' } }, doc), managedRefusal);
  const e = STRINGS[MANAGED_MSG];
  assert.ok(e && e.ru && e.uz && e.en, 'отказу нужен перевод в i18n-strings.js');
});

test('CLINIC_API_FIX_V1: свой врач филиала (is_local = 1) сохраняет как раньше, строка соседа из главного здания не мешает', () => {
  const db = seed();
  db.prepare('UPDATE users SET is_local = 0 WHERE id = 3').run();
  assert.equal(db.prepare('SELECT is_local FROM users WHERE id = 2').get().is_local, 1, 'заведён здесь — по умолчанию свой');
  const out = updateMyDoctorProfile(db, { p: { bio_ru: 'Новое' }, specialties: ['kardiolog'] }, doc);
  assert.deepEqual(out.saved, ['bio_ru']);
  assert.equal(db.prepare('SELECT bio_ru FROM users WHERE id = 2').get().bio_ru, 'Новое');
  assert.deepEqual(db.prepare('SELECT specialty_slug FROM user_specialties WHERE user_id = 2').all().map((r) => r.specialty_slug), ['kardiolog']);
});

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 — ФОТО ТОЛЬКО ИЗ СВОЕЙ ПАПКИ. Путь фото врача —
// doctor-photos/doctors/<id врача>/<ключ> (routes/storage.js photoTarget;
// экран кладёт туда же: views/doctor-profile.js photoPrefix), а проверка
// принимала любую папку корзины: врач 2 ставил себе фото врача 3 — и партнёрам
// уходило чужое лицо под его именем.
// ---------------------------------------------------------------------------
const OWN_PHOTO_MSG = 'Поставить можно только своё фото — загруженное в «Моём профиле».';

test('CLINIC_API_FIX_V1: photo_url — только из папки самого врача; чужая папка — 400 с переводом', () => {
  const db = seed();
  const P = '/api/storage/doctor-photos/doctors/';
  for (const bad of [P + '3/a.jpg', P + '7/1700000000000-abc123-portret.jpg', P + '22/a.jpg', P + '02/a.jpg']) {
    assert.throws(() => updateMyDoctorProfile(db, { p: { photo_url: bad } }, doc),
      (e) => e.status === 400 && e.message === OWN_PHOTO_MSG, bad);
  }
  assert.equal(db.prepare('SELECT photo_url FROM users WHERE id = 2').get().photo_url, null, 'чужое фото записано');
  const e = STRINGS[OWN_PHOTO_MSG];
  assert.ok(e && e.ru && e.uz && e.en, 'отказу нужен перевод в i18n-strings.js');
  // своя папка — как её строит экран: doctors/<id>/<время>-<случайное>-<имя файла>
  const own = P + '2/1700000000000-abc123-portret.jpg';
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { photo_url: own } }, doc));
  assert.equal(db.prepare('SELECT photo_url FROM users WHERE id = 2').get().photo_url, own);
});

test('CLINIC_API_FIX_V1: photo_url — выход из своей папки («..», закодированный %2e%2e, вложенная папка, пустой ключ) — отказ', () => {
  const db = seed();
  const P = '/api/storage/doctor-photos/doctors/2/';
  for (const bad of [P + '../3/a.jpg', P + '..', P + '%2e%2e/3/a.jpg', P + '%2E%2E%2F3%2Fa.jpg', P + '..%2F3%2Fa.jpg',
    P + 'sub/a.jpg', P, P + '.', P + '%zz.jpg']) {
    assert.throws(() => updateMyDoctorProfile(db, { p: { photo_url: bad } }, doc), (e) => e.status === 400, bad);
  }
  assert.equal(db.prepare('SELECT photo_url FROM users WHERE id = 2').get().photo_url, null);
});
