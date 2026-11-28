// HR_STAFF_V1 (2026-11-26) — раздел «HR»: список сотрудников с фильтрами,
// документы каждого сотрудника и выданная ему техника (мигр. 302).
//
// Владелец: «list of workers with the filter based on what position, doctor,
// administrative or middle low, and based on what field, when hired, if hired
// documents uploading place for each staff, and place to assign using
// materials like laptop or phone or so on».
//
// КТО: только администратор клиники (isAdminUser — в том числе дополнительной
// ролью). Сканы паспортов и договоров — самые чувствительные бумаги о
// сотрудниках, а строки «HR» в «Ролях» пока нет: пока её не завели, раздел не
// открывается никому, кроме администратора, — ни списком, ни файлом
// (корзина `hr-docs` в routes/storage.js закрыта тем же правилом).
//
// Список своей таблицы не держит: категория, должность, специальность, отдел
// и дата приёма — колонки users, их правят в «Сотрудниках». Здесь их только
// читают и фильтруют.
import { isAdminUser } from '../grants.js';
import { today } from '../domain/day.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const STAFF_CATEGORIES = ['doctor', 'admin_staff', 'mid_low'];
export const DOC_KINDS = ['passport', 'diploma', 'contract', 'certificate', 'medical', 'order', 'other'];
export const ASSET_KINDS = ['laptop', 'desktop', 'phone', 'tablet', 'monitor', 'sim', 'uniform', 'key', 'other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireHr(user) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  if (!isAdminUser(user)) throw new RpcError('Раздел «HR» открыт администратору клиники.', 403);
}

function posInt(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new RpcError(what, 400);
  return n;
}

function text(v, max, what) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw new RpcError(`${what} — не длиннее ${max} символов.`, 400);
  return s;
}

function dateOrNull(v, what) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!DATE_RE.test(s)) throw new RpcError(`Дата «${what}» не разобрана.`, 400);
  return s;
}

// Категория сотрудника так же, как её показывает карточка в «Сотрудниках»:
// хранимая staff_type, а у врача без неё — «Врачи» по признаку is_doctor
// (15 врачей заведены до появления категории, и staff_type у них пуст).
const CATEGORY_SQL = `CASE WHEN COALESCE(u.staff_type, '') <> '' THEN u.staff_type
                           WHEN u.is_doctor = 1 THEN 'doctor' ELSE '' END`;

function staffExists(db, id) {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!row) throw new RpcError('Сотрудник не найден.', 404);
}

/**
 * Список сотрудников с фильтрами. Все фильтры необязательны:
 *   category      — 'doctor' | 'admin_staff' | 'mid_low' | 'none' (категория не указана)
 *   department_id — отдел
 *   specialty     — специальность (точное совпадение, из списка options)
 *   position      — должность (точное совпадение)
 *   hired_from / hired_to — дата приёма, включительно ('YYYY-MM-DD')
 *   q             — часть ФИО или телефона
 *   inactive      — true: показать и уволенных (is_active = 0)
 * options — значения для выпадающих списков фильтров, из самих данных.
 */
export function hrStaffList(db, args, user) {
  requireHr(user);
  const a = args || {};
  const where = [];
  const p = {};
  if (!a.inactive) where.push('u.is_active = 1');
  if (a.category) {
    const c = String(a.category);
    if (c === 'none') where.push(`${CATEGORY_SQL} = ''`);
    else if (STAFF_CATEGORIES.includes(c)) { where.push(`${CATEGORY_SQL} = @category`); p.category = c; }
    else throw new RpcError('Неизвестная категория сотрудника.', 400);
  }
  if (a.department_id != null && a.department_id !== '') {
    p.department_id = posInt(a.department_id, 'Отдел не выбран.');
    where.push('u.department_id = @department_id');
  }
  if (a.specialty) { p.specialty = text(a.specialty, 200, 'Специальность'); where.push('u.specialty = @specialty'); }
  if (a.position) { p.position = text(a.position, 200, 'Должность'); where.push('u.position = @position'); }
  const from = dateOrNull(a.hired_from, 'Принят с');
  const to = dateOrNull(a.hired_to, 'Принят по');
  if (from) { p.from = from; where.push('substr(u.hire_date, 1, 10) >= @from'); }
  if (to) { p.to = to; where.push('substr(u.hire_date, 1, 10) <= @to'); }
  // Поиск — в JS, а не LIKE: lower() SQLite складывает только латиницу, и
  // «врачев» не находил «Врачев» (тест hr.test.js). Сотрудников — сотни, не
  // тысячи, так что отбор после запроса ничего не стоит.
  const q = text(a.q, 100, 'Поиск').toLowerCase();
  const rows = db.prepare(`
    SELECT u.id, u.full_name, u.phone, u.position, u.specialty, u.hire_date, u.employment_type,
           u.is_active, u.photo_url, u.department_id, d.name AS department,
           ${CATEGORY_SQL} AS category,
           (SELECT COUNT(*) FROM hr_staff_documents x WHERE x.user_id = u.id AND x.removed_at IS NULL) AS documents,
           (SELECT COUNT(*) FROM hr_assets x WHERE x.user_id = u.id AND x.returned_on IS NULL) AS assets
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY u.full_name COLLATE NOCASE, u.id`).all(p);
  const items = q
    ? rows.filter((u) => String(u.full_name || '').toLowerCase().includes(q) || String(u.phone || '').includes(q))
    : rows;

  const options = {
    departments: db.prepare(`SELECT DISTINCT d.id, d.name FROM departments d JOIN users u ON u.department_id = d.id
                              ORDER BY d.name COLLATE NOCASE`).all(),
    specialties: db.prepare(`SELECT DISTINCT specialty AS v FROM users WHERE COALESCE(specialty, '') <> ''
                              ORDER BY specialty COLLATE NOCASE`).all().map((r) => r.v),
    positions: db.prepare(`SELECT DISTINCT position AS v FROM users WHERE COALESCE(position, '') <> ''
                            ORDER BY position COLLATE NOCASE`).all().map((r) => r.v),
  };
  return { items, options };
}

/** Карточка сотрудника в «HR»: анкета (только чтение), документы, техника. */
export function hrStaffCard(db, args, user) {
  requireHr(user);
  const id = posInt(args && args.user_id, 'Сотрудник не выбран.');
  const staff = db.prepare(`
    SELECT u.id, u.full_name, u.phone, u.email, u.position, u.specialty, u.hire_date, u.employment_type,
           u.is_active, u.photo_url, d.name AS department, ${CATEGORY_SQL} AS category
      FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`).get(id);
  if (!staff) throw new RpcError('Сотрудник не найден.', 404);
  const documents = db.prepare(`
    SELECT x.id, x.kind, x.title, x.file_path, x.file_name, x.file_size, x.valid_until, x.uploaded_at,
           a.full_name AS uploaded_by_name
      FROM hr_staff_documents x LEFT JOIN users a ON a.id = x.uploaded_by
     WHERE x.user_id = ? AND x.removed_at IS NULL ORDER BY x.uploaded_at DESC, x.id DESC`).all(id);
  const assets = db.prepare(`
    SELECT x.id, x.kind, x.name, x.serial_no, x.inventory_no, x.note, x.issued_on, x.returned_on, x.return_note,
           a.full_name AS issued_by_name, r.full_name AS returned_by_name
      FROM hr_assets x LEFT JOIN users a ON a.id = x.issued_by LEFT JOIN users r ON r.id = x.returned_by
     WHERE x.user_id = ? ORDER BY (x.returned_on IS NULL) DESC, x.issued_on DESC, x.id DESC`).all(id);
  return { staff, documents, assets, today: today(db) };
}

/**
 * Приложить документ. Файл к этому моменту уже лежит в корзине `hr-docs`
 * (экран кладёт его PUT-ом в /api/storage), здесь — строка о нём. Путь обязан
 * быть папкой ЭТОГО сотрудника: иначе один и тот же скан можно было бы
 * «приложить» к чужой карточке.
 */
export function hrDocumentAdd(db, args, user) {
  requireHr(user);
  const a = args || {};
  const userId = posInt(a.user_id, 'Сотрудник не выбран.');
  staffExists(db, userId);
  const kind = String(a.kind || 'other');
  if (!DOC_KINDS.includes(kind)) throw new RpcError('Неизвестный вид документа.', 400);
  const title = text(a.title, 200, 'Название');
  if (!title) throw new RpcError('Напишите название документа.', 400);
  const filePath = String(a.file_path || '');
  const prefix = `staff/${userId}/`;
  if (!filePath.startsWith(prefix) || filePath.length <= prefix.length || filePath.slice(prefix.length).includes('/')
      || filePath.includes('..') || filePath.length > 400) {
    throw new RpcError('Файл документа не найден в папке сотрудника.', 400);
  }
  const fileName = text(a.file_name, 200, 'Имя файла');
  const size = Number(a.file_size) > 0 ? Math.floor(Number(a.file_size)) : 0;
  const validUntil = dateOrNull(a.valid_until, 'Действует до');
  const r = db.prepare(`INSERT INTO hr_staff_documents (user_id, kind, title, file_path, file_name, file_size, valid_until, uploaded_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, kind, title, filePath, fileName, size, validUntil, user.id);
  return { id: Number(r.lastInsertRowid) };
}

/** Убрать документ из карточки: строка остаётся историей (removed_at), файл — на диске. */
export function hrDocumentRemove(db, args, user) {
  requireHr(user);
  const id = posInt(args && args.id, 'Документ не выбран.');
  const r = db.prepare(`UPDATE hr_staff_documents SET removed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), removed_by = ?
                         WHERE id = ? AND removed_at IS NULL`).run(user.id, id);
  return { id, removed: r.changes > 0 };
}

/** Выдать технику сотруднику. Дата выдачи по умолчанию — сегодня по дате клиники. */
export function hrAssetIssue(db, args, user) {
  requireHr(user);
  const a = args || {};
  const userId = posInt(a.user_id, 'Сотрудник не выбран.');
  staffExists(db, userId);
  const kind = String(a.kind || 'other');
  if (!ASSET_KINDS.includes(kind)) throw new RpcError('Неизвестный вид техники.', 400);
  const name = text(a.name, 200, 'Название');
  if (!name) throw new RpcError('Напишите, что выдано: модель или название.', 400);
  const serial = text(a.serial_no, 100, 'Серийный номер');
  const inv = text(a.inventory_no, 100, 'Инвентарный номер');
  const note = text(a.note, 1000, 'Примечание');
  const issuedOn = dateOrNull(a.issued_on, 'Дата выдачи') || today(db);
  const r = db.prepare(`INSERT INTO hr_assets (user_id, kind, name, serial_no, inventory_no, note, issued_on, issued_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, kind, name, serial, inv, note, issuedOn, user.id);
  return { id: Number(r.lastInsertRowid) };
}

/** Отметить возврат. Повторный возврат уже возвращённого — отказ, а не перезапись даты. */
export function hrAssetReturn(db, args, user) {
  requireHr(user);
  const a = args || {};
  const id = posInt(a.id, 'Запись не выбрана.');
  const row = db.prepare('SELECT issued_on, returned_on FROM hr_assets WHERE id = ?').get(id);
  if (!row) throw new RpcError('Запись о выдаче не найдена.', 404);
  if (row.returned_on) throw new RpcError('Техника уже отмечена как возвращённая.', 409);
  const on = dateOrNull(a.returned_on, 'Дата возврата') || today(db);
  if (on < row.issued_on) throw new RpcError('Дата возврата раньше даты выдачи.', 400);
  const note = text(a.return_note, 1000, 'Примечание');
  db.prepare('UPDATE hr_assets SET returned_on = ?, returned_by = ?, return_note = ? WHERE id = ?').run(on, user.id, note, id);
  return { id, returned_on: on };
}
