-- META_INBOX_STATS_V1 (мигр. 264, 2026-10-31, владелец: «can you build
-- statistics page … how many comments arrived how many private masseges, how
-- many leads generated from chats and so on detailed stattistics»).
--
-- «Сколько лидов дал чат за период» нельзя честно посчитать по дате карточки
-- CRM: «Отметить как лид» с телефоном уже существующей открытой карточки
-- дописывает в неё (inbox-actions.js toCrm, правило повторного обращения), и у
-- такой карточки дата — давняя. Поэтому момент, сотрудник и исход связи
-- записываются на саму переписку / комментарий.
ALTER TABLE meta_conversations ADD COLUMN crm_linked_at TEXT;
ALTER TABLE meta_conversations ADD COLUMN crm_linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- 'created' — новая карточка, 'merged' — дописано в существующую
ALTER TABLE meta_conversations ADD COLUMN crm_link_kind TEXT NOT NULL DEFAULT '' CHECK (crm_link_kind IN ('', 'created', 'merged'));

ALTER TABLE meta_comments ADD COLUMN crm_linked_at TEXT;
ALTER TABLE meta_comments ADD COLUMN crm_linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE meta_comments ADD COLUMN crm_link_kind TEXT NOT NULL DEFAULT '' CHECK (crm_link_kind IN ('', 'created', 'merged'));

-- Связи, заведённые до этой миграции (тот же день): лучшее, что известно, —
-- дата карточки.
UPDATE meta_conversations SET crm_linked_at = (SELECT created_at FROM crm_requests r WHERE r.id = crm_request_id), crm_link_kind = 'created'
 WHERE crm_request_id IS NOT NULL;
UPDATE meta_comments SET crm_linked_at = (SELECT created_at FROM crm_requests r WHERE r.id = crm_request_id), crm_link_kind = 'created'
 WHERE crm_request_id IS NOT NULL;
