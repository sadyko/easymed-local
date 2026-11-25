// WEBSITE_V1 — content.js: врачи и услуги сайта — это показанные в профиле.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedDoctor, seedService } from '../test-helpers/site-seed.js';
import { publishedDoctors, doctorBySlug, publishedServices, serviceBySlug, departmentDoctors,
  departmentServices, invalidateContentCache, configureContent } from './content.js';
import { pickContent } from './i18n.js';

function fresh() { invalidateContentCache(); const db = openDb(':memory:'); migrate(db); return db; }
const names = (rows, lang = 'ru') => rows.map((r) => JSON.parse(r.content)[lang]?.name);

test('на сайте — только врачи, показанные в профиле, и только активные', () => {
  const db = fresh();
  seedDoctor(db, { ru: 'Показан Врач', specialty: 'Кардиолог' });
  seedDoctor(db, { ru: 'Скрыт Врач', shown: false });
  seedDoctor(db, { ru: 'Уволен Врач', active: 0 });
  assert.deepEqual(names(publishedDoctors(db)), ['Показан Врач']);
  db.close();
});

test('врач — имя и специальность по языкам из профиля, слаг из id, по слагу находится', () => {
  const db = fresh();
  const id = seedDoctor(db, { ru: 'Иванов Иван', uz: 'Ivanov Ivan', en: 'Ivan Ivanov', specialty: 'Кардиолог', bio: { ru: 'Опыт', uz: 'Tajriba' } });
  const [d] = publishedDoctors(db);
  const c = JSON.parse(d.content);
  assert.equal(c.ru.name, 'Иванов Иван'); assert.equal(c.uz.name, 'Ivanov Ivan'); assert.equal(c.en.name, 'Ivan Ivanov');
  assert.equal(c.ru.specialty, 'Кардиолог'); assert.equal(c.ru.bio, 'Опыт');
  assert.match(d.slug, new RegExp('^' + id + '(-|$)'));
  assert.equal(doctorBySlug(db, d.slug).user_id, id);
  assert.equal(doctorBySlug(db, String(id)).user_id, id, 'по одному id тоже находится — слаг переживает смену имени');
  assert.equal(doctorBySlug(db, '999999'), undefined);
  assert.equal(doctorBySlug(db, '0' + id), undefined, 'ведущие нули — не тот же адрес');
  db.close();
});

test('скрытого врача по слагу не найти', () => {
  const db = fresh();
  const id = seedDoctor(db, { ru: 'Скрыт', shown: false });
  assert.equal(doctorBySlug(db, String(id)), undefined);
  db.close();
});

test('наружу у врача — только перечисленные поля, без пароля, роли, телефона', () => {
  const db = fresh();
  seedDoctor(db, { ru: 'Иванов' });
  const [d] = publishedDoctors(db);
  assert.deepEqual(Object.keys(d).sort(), ['content', 'experience_years', 'featured', 'id', 'langs_spoken', 'photo_path', 'slug', 'sort_order']);
  db.close();
});

test('услуги — только показанные; название из services, описание — из website_services', () => {
  const db = fresh();
  const a = seedService(db, { ru: 'УЗИ', uz: 'UZI', price: 120000, minutes: 30 });
  seedService(db, { ru: 'Скрытая', uz: 'Yashirin', shown: false });
  db.prepare("INSERT INTO website_services (service_id, featured, content) VALUES (?, 1, ?)").run(a, JSON.stringify({ ru: { short_desc: 'Кратко' } }));
  invalidateContentCache();
  const rows = publishedServices(db);
  assert.deepEqual(names(rows), ['УЗИ']);
  const s = rows[0];
  assert.equal(JSON.parse(s.content).uz.name, 'UZI');
  assert.equal(JSON.parse(s.content).ru.short_desc, 'Кратко');
  assert.equal(s.price, 120000); assert.equal(s.duration_minutes, 30); assert.equal(s.featured, 1);
  assert.equal(serviceBySlug(db, s.slug).service_id, a);
  assert.ok(!('service_id' in s), 'service_id наружу только через serviceBySlug');
  db.close();
});

test('врачи и услуги отделения', () => {
  const db = fresh();
  const dep = Number(db.prepare("INSERT INTO departments (name) VALUES ('Кардиология')").run().lastInsertRowid);
  seedDoctor(db, { ru: 'В отделении', departmentId: dep });
  seedDoctor(db, { ru: 'Вне отделения' });
  seedService(db, { ru: 'ЭКГ', uz: 'EKG', departmentId: dep });
  assert.deepEqual(names(departmentDoctors(db, dep)), ['В отделении']);
  assert.deepEqual(names(departmentServices(db, dep)), ['ЭКГ']);
  db.close();
});

test('пустое поле языка не затирает запасной язык: услуга без name_en', () => {
  const db = fresh();
  const a = seedService(db, { ru: 'УЗИ', uz: 'UZI' });
  db.prepare("INSERT INTO website_services (service_id, content) VALUES (?, ?)").run(a, JSON.stringify({ en: { short_desc: 'Short' } }));
  invalidateContentCache();
  const p = pickContent(publishedServices(db)[0].content, 'en');
  assert.ok(p.name, 'имя берётся из запасного языка');
  assert.equal(p.short_desc, 'Short');
  db.close();
});

test('пустое поле языка не затирает запасной язык: врач без bio_uz', () => {
  const db = fresh();
  seedDoctor(db, { ru: 'Иванов', uz: 'Ivanov', bio: { ru: 'Опыт врача' } });
  const [d] = publishedDoctors(db);
  assert.equal(pickContent(d.content, 'uz').bio, 'Опыт врача');
  db.close();
});

// WEBSITE_V1 — photo_url есть, а файла нет (стёрли с диска): photo_path пуст,
// иначе страница покажет сломанную картинку вместо аватара с инициалами.
test('photo_path — только если файл фото на диске; без файла пусто (аватар)', () => {
  const db = fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-content-'));
  try {
    const id = seedDoctor(db, { ru: 'Фото Врач' });
    db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run('/api/storage/doctor-photos/doctors/' + id + '/face.jpg', id);
    configureContent({ storageDir: tmp });
    assert.equal(publishedDoctors(db)[0].photo_path, '', 'файла нет — пути нет');
    const dir = path.join(tmp, 'doctor-photos', 'doctors', String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'face.jpg'), 'x');
    configureContent({ storageDir: tmp });   // сброс кэша
    assert.equal(publishedDoctors(db)[0].photo_path, 'doctor/' + id);
    configureContent({});
    assert.equal(publishedDoctors(db)[0].photo_path, 'doctor/' + id, 'без настройки каталога — по photo_url');
  } finally {
    configureContent({});
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  }
});
