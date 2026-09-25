-- 150_crm_tags.sql — CRM_HEAD_MERGE_TAGS_V1 (2026-09-25). Метки на карточках
-- заявок CRM.
--
-- Владелец: «adding tags to the cards of the crm». Решено (сказано владельцу):
-- список меток ведётся в «Настройки → CRM-канбан» (цвет у каждой, правит
-- администратор), на карточку их можно поставить несколько; метки видны на
-- доске, в окне заявки, служат фильтром доски, попадают в отчёт колл-центра
-- («По меткам») и в выгрузку Excel. При слиянии дублей метки объединяются.
--
-- crm_tags — справочник, устроен как crm_sources/crm_stages (миграция 077):
-- ключ — латиница (он уходит в фильтры и выгрузки), подпись — слова клиники,
-- цвет — из тех же токенов, что у колонок доски (никакого свободного hex:
-- метка рисуется классами .tag-*). Скрытая метка не предлагается, но на
-- карточках, где уже стоит, остаётся видна.
--
-- crm_request_tags — какие метки стоят на заявке. Удаление заявки уносит её
-- метки (CASCADE); удалить метку из справочника, пока она стоит на карточках,
-- нельзя — её можно только скрыть (services/crm/config.js saveTags), поэтому
-- у ссылки на справочник каскада нет.
--
-- В ОБМЕН МЕЖДУ ЗДАНИЯМИ НЕ ЕДЕТ: доски заявок в branch-sync нет вовсе
-- (SHIPPED), и request_id — id ЭТОЙ базы. Пришпилено в 150.test.js.
CREATE TABLE IF NOT EXISTS crm_tags (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 32 AND key NOT GLOB '*[^a-z0-9_]*'),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  color      TEXT NOT NULL DEFAULT '' CHECK (color IN ('info','warn','purple','teal','ok','crit','')),
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS crm_request_tags (
  request_id INTEGER NOT NULL REFERENCES crm_requests(id) ON DELETE CASCADE,
  tag_key    TEXT    NOT NULL REFERENCES crm_tags(key),
  PRIMARY KEY (request_id, tag_key)
);

-- Фильтр доски и отчёт «По меткам»: «заявки с этой меткой».
CREATE INDEX IF NOT EXISTS idx_crm_request_tags_tag ON crm_request_tags (tag_key);
