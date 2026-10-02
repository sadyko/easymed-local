-- 236 — CABINET_FIX_V1_R1 (2026-10-02): автор у старых шаблонов заключений.
--
-- С CABINET_FIX_V1_TPL личный шаблон читает только автор (author_id) и
-- администратор, а правит и удаляет — автор или администратор. У шаблонов,
-- сохранённых раньше, автора нет: редактор «Документов» author_id не писал
-- вовсе, кабинет — до TPL_AUTHOR_LOCAL_V1. Такой личный шаблон стал виден
-- одному администратору, а общий не мог поправить его же автор.
--
-- Автор берётся по author_name — только если это имя ровно у ОДНОГО
-- сотрудника. Нет совпадения или совпадений несколько — автор не выдумывается
-- (шаблон остаётся администратору). Строки с автором не трогаются, поэтому
-- повторный накат ничего не меняет. Только UPDATE, без перестройки таблицы.
UPDATE consultation_templates
   SET author_id = (SELECT u.id FROM users u WHERE u.full_name = consultation_templates.author_name)
 WHERE author_id IS NULL
   AND author_name IS NOT NULL
   AND TRIM(author_name) <> ''
   AND (SELECT COUNT(*) FROM users u WHERE u.full_name = consultation_templates.author_name) = 1;
