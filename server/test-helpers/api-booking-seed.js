// PUBLIC_API_V1 — стенд онлайн-записи из API: клиника со стенда подключений
// (шаг 7: администратор «Босс», адрес для партнёров, свой файл шифрования),
// имя в адресе, подключение партнёра med24.uz с настоящими ключом и секретом и
// уведомлениями; регистратура, колл-центр, медсестра; врач Петров — показан
// партнёрам, по записи; врач Каримова — живая очередь; первичный и повторный
// приём; две услуги на сайте. Пациентов нет — их заводит тест.
import { seed, PARTNER } from './api-connections-seed.js';
import { saveSlug, createConnection } from '../services/api/connections.js';
import { makeDraft } from '../services/api/drafts.js';

export const HOOK_EVENTS = Object.freeze(['request.accepted', 'appointment.created', 'booking.confirmed',
  'booking.offered_other_time', 'booking.declined', 'appointment.cancelled']);

export function bookingSeed({ kekPath = null } = {}) {
  const base = seed(kekPath ? { kekPath } : {});
  const { db, actor } = base;
  saveSlug(db, 'shifo', actor, { kekPath: base.kekPath });
  const draft = makeDraft(1);
  const made = createConnection(db, { ...PARTNER, webhook_events: [...HOOK_EVENTS] }, actor, { draftId: draft.draft_id, kekPath: base.kekPath });
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(2, 'reg', 'x', 'Регистратор Алиева', 'registrar', 0);
  u.run(3, 'cc', 'x', 'Оператор Ким', 'callcenter', 0);
  u.run(4, 'nurse', 'x', 'Медсестра Юсупова', 'nurse', 0);
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, is_public, full_name_ru, full_name_uz, full_name_en,
      scheduling_mode, booking_days, languages, phone, email)
    VALUES (7, 'doc', 'x', 'Петров Пётр Петрович', 'doctor', 1, 1, 'Петров Пётр Петрович', 'Petrov Pyotr', 'Petrov Pyotr',
      'schedulable', 14, '["ru","uz"]', '+998907770077', 'petrov@clinic.local')`).run();
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, is_public, full_name_ru, scheduling_mode, show_queue_count)
    VALUES (8, 'doc2', 'x', 'Каримова Нигора', 'doctor', 1, 1, 'Каримова Нигора', 'live_queue', 1)`).run();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (7, 'pediatr', 'Педиатр', 'Pediatr', 1)").run();
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (8, 'terapevt', 'Терапевт', 'Terapevt', 1)").run();
  const ct = db.prepare('INSERT INTO consultation_types (id, name, name_ru, name_uz, price, active, duration_minutes, api_kind, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)');
  ct.run(1, 'Первичный приём', 'Первичный приём', 'Birlamchi qabul', 150000, 30, 'initial', 1);
  ct.run(2, 'Повторный приём', 'Повторный приём', 'Takroriy qabul', 98000, 15, 'repeat', 2);
  const sv = db.prepare('INSERT INTO services (id, name, name_uz, name_en, price, type, is_lab, online_booking, active, duration_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)');
  sv.run(301, 'Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count', 45000, 'lab', 1, 1, 10);
  sv.run(302, 'УЗИ брюшной полости', 'Qorin bo‘shlig‘i UTT', '', 180000, 'imaging', 0, 1, 20);
  sv.run(303, 'Перевязка', '', '', 30000, 'procedure', 0, 0, 15);
  return {
    ...base, connId: made.connection.id, key: made.key, secret: made.secret,
    admin: { id: 1, role: 'admin' }, reg: { id: 2, role: 'registrar' }, cc: { id: 3, role: 'callcenter' }, nurse: { id: 4, role: 'nurse' },
  };
}

/** Местное мгновение дня day ('YYYY-MM-DD') в hh:mm — мс. */
export function localAt(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
}

/**
 * Элемент входящей очереди «онлайн-запись» (как его отдаёт публичный сервер, пациент уже вскрыт).
 * Срока держания в нём нет: его назначает клиника при приёме (решения владельца 18–19).
 */
export function apptItem({ publicId = 'rq_test0001', connId, startMs, receivedMs, doctorId = 7, consultation = 'initial', serviceId = null,
  externalId = 'med-1', name = 'Абдурахмонов Фаррух', phone = '+998 90 123 45 67', comment = 'Ребёнок 5 лет', cursor = '1' } = {}) {
  return {
    type: 'appointment.new', cursor, public_id: publicId, connection_id: connId, received_at: new Date(receivedMs).toISOString(),
    data: { external_id: externalId, doctor_id: doctorId, consultation, service_id: serviceId, start: new Date(startMs).toISOString(), lang: 'ru' },
    patient: { name, phone, comment },
  };
}
