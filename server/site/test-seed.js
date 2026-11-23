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