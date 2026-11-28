-- HR_RECRUIT_V1 (2026-11-27) — «HR → Подбор»: ВОРОНКА НАЙМА ДЛЯ РЕКРУТЕРОВ.
--
-- Владелец: «build recruiting funnel for recruiters, and in hire status there
-- should be button to create employee, which leads to setting place where we
-- create employee».
--
-- hr_vacancies — открытые позиции: «Медсестра в кардиологию, 2 места».
--   Категория и отдел вакансии потом подставляются в анкету нового
--   сотрудника, чтобы «Нанят → Создать сотрудника» не заставлял набирать их
--   второй раз. Вакансию не удаляют, а закрывают (status = 'closed'): у неё
--   есть кандидаты, и «кого мы смотрели на эту позицию в марте» — вопрос,
--   ради которого воронку и ведут.
-- hr_candidates — люди в воронке. stage — колонка доски. Кандидат без
--   вакансии допустим («резерв»: прислал резюме, позиции под него пока нет).
--   employee_id — сотрудник (users), заведённый из этого кандидата кнопкой
--   «Создать сотрудника»: по нему кнопка во второй раз не предлагается, а в
--   карточке видно, кем человек стал. ON DELETE SET NULL — удалённая учётка
--   не стирает историю найма.
-- hr_candidate_events — журнал движения по воронке: из какой колонки в какую,
--   кто и когда, с причиной отказа. Строки только добавляются. Без журнала
--   «сколько дней кандидат шёл от отклика до найма» не посчитать, а
--   updated_at кандидата хранит только последнее касание.
CREATE TABLE hr_vacancies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),
  staff_type     TEXT NOT NULL DEFAULT '' CHECK (staff_type IN ('', 'doctor', 'admin_staff', 'mid_low')),
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  headcount      INTEGER NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 999),
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closed_at      TEXT
);

CREATE TABLE hr_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  vacancy_id        INTEGER REFERENCES hr_vacancies(id) ON DELETE SET NULL,
  full_name         TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  phone             TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'other' CHECK (source IN ('hh', 'telegram', 'referral', 'site', 'walk_in', 'other')),
  stage             TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  note              TEXT NOT NULL DEFAULT '',
  reject_reason     TEXT NOT NULL DEFAULT '',
  interview_at      TEXT,
  employee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  stage_changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_hr_candidates_stage ON hr_candidates(stage, vacancy_id);
-- Один сотрудник — из одного кандидата: двойной щелчок «Создать сотрудника»
-- или вторая вкладка не привяжут ту же учётку ко второму человеку.
CREATE UNIQUE INDEX idx_hr_candidates_employee ON hr_candidates(employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE hr_candidate_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
  from_stage    TEXT,
  to_stage      TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  by_user       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_hr_candidate_events_cand ON hr_candidate_events(candidate_id, id);
