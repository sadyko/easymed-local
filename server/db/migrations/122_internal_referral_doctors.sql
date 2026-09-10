-- INTERNAL_REFERRAL_V1 — пациента направил НАШ врач.
--
-- Владелец 2026-09-08: «в выпадающем списке категорий должны быть внутренние
-- врачи, тогда во втором списке выбирается врач; если категория другая — список
-- показывает врачей этой категории».
--
-- Ключевое решение: внутренний врач — это ОБЫЧНЫЙ источник направления, просто
-- связанный с сотрудником. Из этого следует всё остальное даром: двухшаговый
-- выбор в мастере записи работает как есть (категория → кто направил, и в этой
-- категории лежат наши врачи), номер 0001 присваивает тот же триггер, отчёт
-- «Рефералы» считает по тем же правилам, а ставка вознаграждения задаётся там
-- же, где у всех остальных, — стандартная на КАТЕГОРИИ, своя у врача.
--
-- Заводить строку источника лениво, в момент первого направления, было бы
-- сложнее и хуже: ставку врачу надо уметь задать ДО того, как он кого-то
-- направил, а «создать при сохранении визита» — это ещё и гонка на двух
-- регистратурах сразу.
-- ON DELETE SET NULL, и это не мелочь: главная клиника УДАЛЯЕТ уволенного из
-- ростера совсем (branch-sync/catalogue), а простая ссылка это удаление
-- запретила бы — приём справочника падал бы на FOREIGN KEY constraint. Каскад
-- был бы ещё хуже: он унёс бы карточку источника, на которую ссылаются визиты
-- и счета. Строка остаётся историческим партнёром со своей историей и своими
-- ставками, просто уже ни с кем не связанным. Тот же довод, что у кабинетов и
-- отделов в мигр. 108.
ALTER TABLE referral_sources ADD COLUMN doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Один источник на врача. Индекс частичный: у внешних партнёров doctor_id
-- пустой, и обычный UNIQUE запретил бы второго внешнего партнёра вовсе.
CREATE UNIQUE INDEX idx_referral_sources_doctor ON referral_sources(doctor_id) WHERE doctor_id IS NOT NULL;

-- Категория «внутренняя» ФЛАГОМ, а не названием. Тот же довод, по которому
-- ставки вознаграждения перестали искаться по имени (мигр. 120): клиника
-- вправе переименовать категорию, и переименование не должно менять поведение.
ALTER TABLE referral_source_categories ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;

INSERT INTO referral_source_categories (name, is_internal)
SELECT 'Внутренние врачи', 1
 WHERE NOT EXISTS (SELECT 1 FROM referral_source_categories WHERE is_internal = 1);

-- Действующим врачам заводим их источники. name — то же ФИО, которое видит
-- регистратор в остальных списках; first_name держит его же, потому что
-- редактор карточки источника собирает name из частей ФИО (мигр. 058), и
-- пустые части стёрли бы имя при первом же сохранении такой карточки.
INSERT INTO referral_sources (name, first_name, doctor_id, category_id, active)
SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.username),
       COALESCE(NULLIF(TRIM(u.full_name), ''), u.username),
       u.id,
       (SELECT id FROM referral_source_categories WHERE is_internal = 1 ORDER BY id LIMIT 1),
       u.is_active
  FROM users u
 WHERE u.role = 'doctor'
   AND NOT EXISTS (SELECT 1 FROM referral_sources rs WHERE rs.doctor_id = u.id);

-- Новый врач получает свой источник сразу: иначе его не было бы в списке «кто
-- направил» до тех пор, пока кто-нибудь не вспомнит завести его руками.
CREATE TRIGGER referral_sources_for_new_doctor
AFTER INSERT ON users
FOR EACH ROW WHEN NEW.role = 'doctor'
BEGIN
  INSERT INTO referral_sources (name, first_name, doctor_id, category_id, active)
  SELECT COALESCE(NULLIF(TRIM(NEW.full_name), ''), NEW.username),
         COALESCE(NULLIF(TRIM(NEW.full_name), ''), NEW.username),
         NEW.id,
         (SELECT id FROM referral_source_categories WHERE is_internal = 1 ORDER BY id LIMIT 1),
         NEW.is_active
   WHERE NOT EXISTS (SELECT 1 FROM referral_sources rs WHERE rs.doctor_id = NEW.id);
END;

-- Переименовали врача или уволили — его источник обязан пойти следом. Иначе в
-- списке «кто направил» осталось бы прежнее ФИО, а уволенный продолжал бы
-- предлагаться регистратору. Ставки (reward_mode / own_percent / own_rates) при
-- этом не трогаются: они принадлежат источнику, а не карточке сотрудника.
CREATE TRIGGER referral_sources_follow_doctor
AFTER UPDATE OF full_name, username, is_active ON users
FOR EACH ROW WHEN NEW.role = 'doctor'
BEGIN
  UPDATE referral_sources
     SET name   = COALESCE(NULLIF(TRIM(NEW.full_name), ''), NEW.username),
         active = NEW.is_active
   WHERE doctor_id = NEW.id;
END;
