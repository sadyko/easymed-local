// WEBSITE_V1 — засев для тестов сайта (не для рабочего кода).
// Делает врача и услугу показанными ТАК ЖЕ, как это делает администратор в
// «Публичном профиле» и «Услугах для сайта и партнёров»: тесты сайта не должны
// duration_minutes — NOT NULL (по умолчанию 30), поэтому minutes = 30, а не null.
// знать про внутренности правил показа — только про этот помощник.
let seq = 0;

export function seedDoctor(db, { ru, uz = '', en = '', specialty = 'Терапевт', shown = true, active = 1, departmentId = null, bio = {} } = {}) {
  seq += 1;
  const id = Number(db.prepare(`INSERT INTO users (username, password_hash, full_name, role, is_doctor, is_active,
      is_public, full_name_ru, full_name_uz, full_name_en, bio_ru, bio_uz, bio_en, languages, department_id)
    VALUES (?, 'x', ?, 'doctor', 1, ?, ?, ?, ?, ?, ?, ?, ?, '["ru","uz"]', ?)`)
    .run('site-doc-' + seq, ru, active, shown ? 1 : 0, ru, uz, en, bio.ru || '', bio.uz || '', bio.en || '', departmentId).lastInsertRowid);
  db.prepare('INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, ?, ?, ?, 1)')
    .run(id, 'spec-' + seq, specialty, specialty);
  return id;
}

export function seedService(db, { ru, uz = '', en = '', price = 0, shown = true, departmentId = null, minutes = 30 } = {}) {
  return Number(db.prepare(`INSERT INTO services (name, name_uz, name_en, price, active, online_booking, department_id, duration_minutes)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(ru, uz, en, price, shown ? 1 : 0, departmentId, minutes).lastInsertRowid);
}

// WEBSITE_V1 — общий засев страниц сайта (в Chilla — seedSite из content.test.js,
// там строками website_doctors/website_services). Здесь тот же набор, но через
// профиль: врач «Алиев Шерзод» показан, «Скрытый Врач» скрыт в профиле
// (is_public=0), «ЭКГ» показана, «Секретная услуга» — online_booking=0.
// Логины doc1/doc2 оставлены как в Chilla: тесты дописывают врачу поля по
// username. Слаги теперь «<id>-<латиница>» — брать их из seededSlugs().
// Отделения в этой базе уже засеяны миграциями, поэтому «Кардиология» — НЕ id 1:
// её id отдаётся в ответе (cardiology) и ищется по слагу 'kardiologiya'.
export function seedSite(db) {
  const cardiology = Number(db.prepare("INSERT INTO departments (name, kind) VALUES ('Кардиология','clinical')").run().lastInsertRowid);
  const d1 = seedDoctor(db, { ru: 'Алиев Шерзод', uz: 'Aliyev Sherzod', specialty: 'Кардиолог', bio: { ru: 'Опытный кардиолог.' } });
  db.prepare("UPDATE users SET username = 'doc1', phone = '+998 90 111 22 33', experience_years = 12 WHERE id = ?").run(d1);
  db.prepare("UPDATE user_specialties SET name_uz = 'Kardiolog' WHERE user_id = ?").run(d1);
  const d2 = seedDoctor(db, { ru: 'Скрытый Врач', shown: false });
  db.prepare("UPDATE users SET username = 'doc2' WHERE id = ?").run(d2);
  const s1 = seedService(db, { ru: 'ЭКГ', uz: 'EKG', price: 50000, minutes: 15, departmentId: cardiology });
  const s2 = seedService(db, { ru: 'Секретная услуга', uz: 'Maxfiy xizmat', price: 1, shown: false });
  db.prepare(`INSERT INTO website_services (service_id, featured, content)
              VALUES (?, 1, '{"ru":{"short_desc":"Электрокардиограмма"}}')`).run(s1);
  db.prepare(`INSERT INTO website_departments (department_id, published, slug, content)
              VALUES (?, 1, 'kardiologiya', '{"ru":{"name":"Кардиология"}}')`).run(cardiology);
  db.prepare(`INSERT INTO website_faq (published, sort_order, content) VALUES (1, 1, '{"ru":{"q":"Как записаться?","a":"Через сайт."}}')`).run();
  db.prepare(`INSERT INTO website_testimonials (published, author_name, rating, content) VALUES (1, 'Малика', 5, '{"ru":{"text":"Отличная клиника."}}')`).run();
  db.prepare(`UPDATE website_settings SET settings = '{"hero":{"uz":{"title":"Salomatlik"},"ru":{"title":"Здоровье"}},"contact":{"phone":"+998 71 200 00 00"}}'`).run();
  return { d1, d2, s1, s2, cardiology };
}

/** Слаги засеянных seedSite врача и услуги — те, что сайт реально отдаёт. */
export function seededSlugs(db) {
  const d1 = db.prepare("SELECT id FROM users WHERE username = 'doc1'").get().id;
  const s1 = db.prepare("SELECT id FROM services WHERE name = 'ЭКГ'").get().id;
  return { doctor: `${d1}-aliyev-sherzod`, service: `${s1}-ekg`, d1, s1 };
}
