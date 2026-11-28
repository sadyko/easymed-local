// HR_RECRUIT_V1 (2026-11-27) — «HR → Подбор»: воронка найма (мигр. 303).
//
// Владелец: «build recruiting funnel for recruiters, and in hire status there
// should be button to create employee, which leads to setting place where we
// create employee».
//
// Воронка: Отклик → Отбор → Собеседование → Оффер → Нанят, и сбоку «Отказ».
// Кандидата двигают по колонкам; каждое движение пишется в журнал
// hr_candidate_events (кто, когда, откуда куда, причина отказа).
//
// «Создать сотрудника» на нанятом кандидате открывает обычную анкету в
// «Настройки → Сотрудники» (экран сам), а после её сохранения экран зовёт
// hr_candidate_link_employee: кандидат запоминает, кем стал, и кнопка второй
// раз не предлагается. Сотрудника здесь НЕ создают: анкета с логином, ролью,
// ставками и расписанием одна, и вторая — урезанная — разошлась бы с ней.
//
// КТО: строка «Ролей» `hr_recruiting` («HR · Подбор персонала»). Пока клиника
// её не настроила — только администратор, как остальной «HR»: рекрутеру роль
// открывают явно. Остальной «HR» (документы и техника сотрудников) рекрутеру
// этим НЕ открывается — там сканы паспортов (rpc/hr.js, только администратор).
import { grantAllowsAdminOr } from '../grants.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];
export const SOURCES = ['hh', 'telegram', 'referral', 'site', 'walk_in', 'other'];
export const VACANCY_STATUSES = ['open', 'paused', 'closed'];
const STAFF_TYPES = ['', 'doctor', 'admin_staff', 'mid_low'];
const GRANT_KEY = 'hr_recruiting';
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

function requireRecruiting(db, user, need) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  if (!grantAllowsAdminOr(db, user, GRANT_KEY, 'view')) {
    throw new RpcError('«Подбор персонала» недоступен вашей роли. Доступ выдаёт администратор в «Настройки → Роли» (строка «HR · Подбор персонала»).', 403);
  }
  if (need === 'edit' && !grantAllowsAdminOr(db, user, GRANT_KEY, 'edit')) {
    throw new RpcError('У вас доступ «Просмотр»: двигать кандидатов и править вакансии нельзя.', 403);
  }
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

function vacancyIdOrNull(db, v) {
  if (v == null || v === '') return null;
  const id = posInt(v, 'Вакансия не выбрана.');
  if (!db.prepare('SELECT id FROM hr_vacancies WHERE id = ?').get(id)) throw new RpcError('Вакансия не найдена.', 404);
  return id;
}

function departmentIdOrNull(db, v) {
  if (v == null || v === '') return null;
  const id = posInt(v, 'Отдел не выбран.');
  if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(id)) throw new RpcError('Отдел не найден.', 404);
  return id;
}

function candidateRow(db, id) {
  const row = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(id);
  if (!row) throw new RpcError('Кандидат не найден.', 404);
  return row;
}

const CANDIDATE_SELECT = `
  SELECT c.id, c.vacancy_id, c.full_name, c.phone, c.email, c.source, c.stage, c.note, c.reject_reason,
         c.interview_at, c.employee_id, c.created_at, c.stage_changed_at, c.updated_at,
         v.title AS vacancy_title, v.staff_type AS vacancy_staff_type, v.department_id AS vacancy_department_id,
         e.full_name AS employee_name, cb.full_name AS created_by_name
    FROM hr_candidates c
    LEFT JOIN hr_vacancies v ON v.id = c.vacancy_id
    LEFT JOIN users e ON e.id = c.employee_id
    LEFT JOIN users cb ON cb.id = c.created_by`;

/**
 * Доска воронки: кандидаты (фильтр по вакансии и поиску), вакансии с числами
 * по колонкам, отделы для формы вакансии и уровень доступа — экрану, чтобы не
 * рисовать кнопки, на которые сервер ответит 403.
 *   vacancy_id — число, 'none' (резерв: без вакансии) или пусто (все)
 *   q          — часть ФИО или телефона
 */
export function hrRecruitBoard(db, args, user) {
  requireRecruiting(db, user, 'view');
  const a = args || {};
  const where = [];
  const p = {};
  if (a.vacancy_id === 'none') where.push('c.vacancy_id IS NULL');
  else if (a.vacancy_id != null && a.vacancy_id !== '') { p.vacancy_id = posInt(a.vacancy_id, 'Вакансия не выбрана.'); where.push('c.vacancy_id = @vacancy_id'); }
  const rows = db.prepare(`${CANDIDATE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                           ORDER BY c.stage_changed_at DESC, c.id DESC`).all(p);
  // Поиск — в JS: lower() SQLite не складывает кириллицу (тот же урок, что hr.js).
  const q = text(a.q, 100, 'Поиск').toLowerCase();
  const candidates = q
    ? rows.filter((c) => String(c.full_name).toLowerCase().includes(q) || String(c.phone).includes(q))
    : rows;

  const counts = db.prepare('SELECT vacancy_id, stage, COUNT(*) AS n FROM hr_candidates GROUP BY vacancy_id, stage').all();
  const vacancies = db.prepare(`
    SELECT v.id, v.title, v.staff_type, v.department_id, d.name AS department, v.headcount, v.description,
           v.status, v.created_at, v.closed_at
      FROM hr_vacancies v LEFT JOIN departments d ON d.id = v.department_id
     ORDER BY CASE v.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, v.created_at DESC, v.id DESC`).all()
    .map((v) => {
      const by = Object.fromEntries(STAGES.map((s) => [s, 0]));
      for (const c of counts) if (c.vacancy_id === v.id) by[c.stage] = c.n;
      const active = by.new + by.screening + by.interview + by.offer;
      return { ...v, stages: by, active, hired: by.hired };
    });
  const unassigned = counts.filter((c) => c.vacancy_id == null).reduce((s, c) => s + c.n, 0);

  return {
    candidates,
    vacancies,
    unassigned,
    departments: db.prepare('SELECT id, name FROM departments ORDER BY name COLLATE NOCASE').all(),
    can_edit: grantAllowsAdminOr(db, user, GRANT_KEY, 'edit'),
  };
}

/** Карточка кандидата с журналом движения по воронке. */
export function hrCandidateGet(db, args, user) {
  requireRecruiting(db, user, 'view');
  const id = posInt(args && args.id, 'Кандидат не выбран.');
  const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id);
  if (!candidate) throw new RpcError('Кандидат не найден.', 404);
  const events = db.prepare(`
    SELECT x.id, x.from_stage, x.to_stage, x.note, x.at, u.full_name AS by_name
      FROM hr_candidate_events x LEFT JOIN users u ON u.id = x.by_user
     WHERE x.candidate_id = ? ORDER BY x.id DESC`).all(id);
  // HR_CANDIDATE_DOCS_V1 — приложенные документы (убранные — не показываются).
  const documents = db.prepare(`
    SELECT d.id, d.kind, d.title, d.file_path, d.file_name, d.file_size, d.uploaded_at, u.full_name AS uploaded_by_name
      FROM hr_candidate_documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.candidate_id = ? AND d.removed_at IS NULL ORDER BY d.id DESC`).all(id);
  return { candidate, events, documents };
}

// HR_CANDIDATE_DOCS_V1 (мигр. 306) — документы кандидата: паспорт, резюме,
// диплом… Файл сначала ложится в hr-docs/candidate/<id>/ (routes/storage.js
// пускает туда того же рекрутера), затем эта строка его регистрирует.
export const CANDIDATE_DOC_KINDS = ['passport', 'resume', 'diploma', 'certificate', 'medical', 'recommendation', 'other'];
// В карточке сотрудника видов меньше: резюме и рекомендация переезжают как «Другое»
// со своим названием (миграция 302 — список видов сотрудника).
const STAFF_KIND_OF = { passport: 'passport', diploma: 'diploma', certificate: 'certificate', medical: 'medical' };

export function hrCandidateDocumentAdd(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const a = args || {};
  const id = posInt(a.candidate_id, 'Кандидат не выбран.');
  candidateRow(db, id);
  const kind = String(a.kind || 'other');
  if (!CANDIDATE_DOC_KINDS.includes(kind)) throw new RpcError('Неизвестный вид документа.', 400);
  const title = text(a.title, 200, 'Название');
  if (!title) throw new RpcError('Напишите название документа.', 400);
  const filePath = String(a.file_path || '');
  const prefix = `candidate/${id}/`;
  if (!filePath.startsWith(prefix) || filePath.length <= prefix.length || filePath.slice(prefix.length).includes('/')
      || filePath.includes('..') || filePath.length > 400) {
    throw new RpcError('Файл документа не найден в папке кандидата.', 400);
  }
  const fileName = text(a.file_name, 200, 'Имя файла');
  const size = Number(a.file_size) > 0 ? Math.floor(Number(a.file_size)) : 0;
  const r = db.prepare(`INSERT INTO hr_candidate_documents (candidate_id, kind, title, file_path, file_name, file_size, uploaded_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, kind, title, filePath, fileName, size, user.id);
  return { id: Number(r.lastInsertRowid) };
}

/** Убрать документ из карточки кандидата: строка остаётся историей, файл — на диске. */
export function hrCandidateDocumentRemove(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const id = posInt(args && args.id, 'Документ не выбран.');
  const r = db.prepare(`UPDATE hr_candidate_documents SET removed_at = ${NOW_SQL}, removed_by = ?
                         WHERE id = ? AND removed_at IS NULL`).run(user.id, id);
  return { id, removed: r.changes > 0 };
}

/** Создать или поправить вакансию. Закрытие — status 'closed' (с датой). */
export function hrVacancySave(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const a = args || {};
  const title = text(a.title, 200, 'Название вакансии');
  if (!title) throw new RpcError('Напишите название вакансии.', 400);
  const staffType = String(a.staff_type || '');
  if (!STAFF_TYPES.includes(staffType)) throw new RpcError('Неизвестная категория персонала.', 400);
  const departmentId = departmentIdOrNull(db, a.department_id);
  const headcount = a.headcount == null || a.headcount === '' ? 1 : Number(a.headcount);
  if (!Number.isInteger(headcount) || headcount < 1 || headcount > 999) throw new RpcError('Число мест — от 1 до 999.', 400);
  const description = text(a.description, 4000, 'Описание');
  const status = String(a.status || 'open');
  if (!VACANCY_STATUSES.includes(status)) throw new RpcError('Неизвестное состояние вакансии.', 400);

  if (a.id != null && a.id !== '') {
    const id = posInt(a.id, 'Вакансия не выбрана.');
    const prev = db.prepare('SELECT status FROM hr_vacancies WHERE id = ?').get(id);
    if (!prev) throw new RpcError('Вакансия не найдена.', 404);
    // closed_at — когда закрыли; повторное «закрыть» дату не сдвигает, открытие — стирает.
    db.prepare(`UPDATE hr_vacancies SET title = ?, staff_type = ?, department_id = ?, headcount = ?, description = ?, status = ?,
                  closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ${NOW_SQL}) ELSE NULL END
                WHERE id = ?`).run(title, staffType, departmentId, headcount, description, status, status, id);
    return { id };
  }
  const r = db.prepare(`INSERT INTO hr_vacancies (title, staff_type, department_id, headcount, description, status, created_by, closed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'closed' THEN ${NOW_SQL} END)`)
    .run(title, staffType, departmentId, headcount, description, status, user.id, status);
  return { id: Number(r.lastInsertRowid) };
}

function logEvent(db, candidateId, from, to, note, userId) {
  db.prepare('INSERT INTO hr_candidate_events (candidate_id, from_stage, to_stage, note, by_user) VALUES (?, ?, ?, ?, ?)')
    .run(candidateId, from, to, note || '', userId);
}

/**
 * Добавить кандидата (без id) или поправить его анкету (с id). Колонку здесь
 * не меняют — для этого hr_candidate_move с журналом и правилами.
 */
export function hrCandidateSave(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const a = args || {};
  const fullName = text(a.full_name, 200, 'ФИО');
  if (!fullName) throw new RpcError('Напишите ФИО кандидата.', 400);
  const phone = text(a.phone, 50, 'Телефон');
  const email = text(a.email, 200, 'Почта');
  const source = String(a.source || 'other');
  if (!SOURCES.includes(source)) throw new RpcError('Неизвестный источник кандидата.', 400);
  const note = text(a.note, 4000, 'Заметка');
  const vacancyId = vacancyIdOrNull(db, a.vacancy_id);
  let interviewAt = null;
  if (a.interview_at != null && a.interview_at !== '') {
    interviewAt = String(a.interview_at);
    if (!DATETIME_RE.test(interviewAt)) throw new RpcError('Дата собеседования не разобрана.', 400);
  }

  if (a.id != null && a.id !== '') {
    const id = posInt(a.id, 'Кандидат не выбран.');
    candidateRow(db, id);
    db.prepare(`UPDATE hr_candidates SET full_name = ?, phone = ?, email = ?, source = ?, note = ?, vacancy_id = ?, interview_at = ?,
                  updated_at = ${NOW_SQL} WHERE id = ?`).run(fullName, phone, email, source, note, vacancyId, interviewAt, id);
    return { id };
  }
  const create = db.transaction(() => {
    const r = db.prepare(`INSERT INTO hr_candidates (vacancy_id, full_name, phone, email, source, note, interview_at, created_by)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(vacancyId, fullName, phone, email, source, note, interviewAt, user.id);
    const id = Number(r.lastInsertRowid);
    logEvent(db, id, null, 'new', '', user.id);
    return id;
  });
  return { id: create() };
}

/**
 * Передвинуть кандидата по воронке.
 *  - «Отказ» — только с причиной: «почему не взяли» — первое, что спросят,
 *    когда человек откликнется снова.
 *  - Нанятого, из которого уже завели сотрудника, назад не двигают: учётка
 *    существует, и доска врала бы, что человек ещё «на собеседовании».
 */
export function hrCandidateMove(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const a = args || {};
  const id = posInt(a.id, 'Кандидат не выбран.');
  const stage = String(a.stage || '');
  if (!STAGES.includes(stage)) throw new RpcError('Неизвестный этап воронки.', 400);
  const note = text(a.note, 1000, 'Комментарий');
  const c = candidateRow(db, id);
  if (c.stage === stage) return { id, stage, changed: false };
  if (c.employee_id != null) {
    throw new RpcError('Из кандидата уже создан сотрудник — этап больше не меняется.', 409);
  }
  if (stage === 'rejected' && !note) throw new RpcError('Напишите причину отказа.', 400);
  const move = db.transaction(() => {
    db.prepare(`UPDATE hr_candidates SET stage = ?, reject_reason = ?, stage_changed_at = ${NOW_SQL}, updated_at = ${NOW_SQL} WHERE id = ?`)
      .run(stage, stage === 'rejected' ? note : '', id);
    logEvent(db, id, c.stage, stage, note, user.id);
  });
  move();
  return { id, stage, changed: true };
}

/**
 * Данные для анкеты нового сотрудника — «Нанят → Создать сотрудника». Экран
 * «Сотрудники» открывает по ним обычную анкету. Отказывает, если кандидат не
 * нанят или сотрудник из него уже создан (кнопка «Назад» в браузере не
 * должна открыть анкету второй раз).
 */
export function hrCandidateHirePrefill(db, args, user) {
  requireRecruiting(db, user, 'view');
  const id = posInt(args && args.id, 'Кандидат не выбран.');
  const c = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id);
  if (!c) throw new RpcError('Кандидат не найден.', 404);
  if (c.stage !== 'hired') throw new RpcError('Сотрудника создают из кандидата в колонке «Нанят».', 409);
  if (c.employee_id != null) throw new RpcError('Сотрудник из этого кандидата уже создан.', 409);
  return {
    candidate_id: c.id,
    full_name: c.full_name,
    phone: c.phone,
    email: c.email,
    staff_type: c.vacancy_staff_type || '',
    department_id: c.vacancy_department_id ?? null,
    vacancy_title: c.vacancy_title || '',
  };
}

/**
 * Запомнить, какой сотрудник заведён из нанятого кандидата. Зовёт экран
 * «Сотрудники» сразу после сохранения анкеты.
 */
export function hrCandidateLinkEmployee(db, args, user) {
  requireRecruiting(db, user, 'edit');
  const a = args || {};
  const id = posInt(a.id, 'Кандидат не выбран.');
  const userId = posInt(a.user_id, 'Сотрудник не выбран.');
  const c = candidateRow(db, id);
  if (c.stage !== 'hired') throw new RpcError('Сотрудника привязывают к кандидату в колонке «Нанят».', 409);
  if (c.employee_id === userId) return { id, employee_id: userId, changed: false };
  if (c.employee_id != null) throw new RpcError('К этому кандидату уже привязан другой сотрудник.', 409);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new RpcError('Сотрудник не найден.', 404);
  if (db.prepare('SELECT id FROM hr_candidates WHERE employee_id = ?').get(userId)) {
    throw new RpcError('Этот сотрудник уже привязан к другому кандидату.', 409);
  }
  const link = db.transaction(() => {
    db.prepare(`UPDATE hr_candidates SET employee_id = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(userId, id);
    // «Нанят → Нанят» в журнале — отметка «создан сотрудник»: экран подписывает
    // её на языке читателя, а не хранит русскую фразу в базе.
    logEvent(db, id, 'hired', 'hired', '', user.id);
    // HR_CANDIDATE_DOCS_V1 — документы кандидата переезжают в карточку
    // сотрудника (HR → Сотрудники → Документы) тем же файлом: паспорт и
    // диплом, приложенные на отборе, второй раз не сканируют.
    const docs = db.prepare(`SELECT kind, title, file_path, file_name, file_size, uploaded_by, uploaded_at
                               FROM hr_candidate_documents WHERE candidate_id = ? AND removed_at IS NULL ORDER BY id`).all(id);
    const put = db.prepare(`INSERT INTO hr_staff_documents (user_id, kind, title, file_path, file_name, file_size, uploaded_by, uploaded_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const d of docs) {
      put.run(userId, STAFF_KIND_OF[d.kind] || 'other', d.title, d.file_path, d.file_name, d.file_size, d.uploaded_by, d.uploaded_at);
    }
  });
  link();
  return { id, employee_id: userId, changed: true };
}
