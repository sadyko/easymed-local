-- INPATIENT_BONUS_V1 (2026-09-26) — СТАЦИОНАРНОЕ ВОЗНАГРАЖДЕНИЕ И СТАВКИ СТАЦИОНАРА.
--
-- Владелец: «Referral partners: a referral bonus for stationary — from the
-- referral to the stationary and from the invoice of the patient (option for
-- selected partners). Employees: stationary bonuses separately.»
--
-- Решения владельца (26.09):
--   * у партнёра — переключатель «Вознаграждение за стационар»: % от
--     ОПЛАЧЕННОГО стационарного счёта (услуги и койко-дни, без медикаментов и
--     расходников) и/или фиксированная сумма за госпитализацию. Партнёр без
--     переключателя за стационар не получает НИЧЕГО (прежде строки счёта
--     госпитализации платились ему по обычным ставкам групп, если источник
--     стоял в карточке пациента);
--   * госпитализация ЗАПОМИНАЕТ, кто направил (admissions.referral_source_id);
--   * у сотрудника — вкладка «Стационар»: ставки по услугам (% или фикс)
--     ОТДЕЛЬНО от амбулаторных и бонус за направление в стационар (% и/или фикс).
--
-- ПО ФИЛИАЛАМ НИЧЕГО ИЗ ЭТОГО НЕ ЕЗДИТ, и это не пропуск:
--   * users: деньги сотрудника не едут вовсе (branch-sync/catalogue.js — там
--     же перечислены service_rates и referral_rates; в JSON лежат id УСЛУГ
--     этой установки);
--   * referral_sources и admissions справочником и журналом не передаются
--     (catalogue.js TABLES, journal.js SHIPPED) — как и прежде.

-- 1. Кто направил на госпитализацию. Источник удалили — госпитализация
--    остаётся, просто без направившего (как visits.referral_source_id).
ALTER TABLE admissions ADD COLUMN referral_source_id INTEGER
  REFERENCES referral_sources(id) ON DELETE SET NULL;

-- 2. Стационарное вознаграждение партнёра. 0 — не платится; переключатель
--    выключен — не платится ничего, какие бы числа ни стояли.
ALTER TABLE referral_sources ADD COLUMN inpatient_bonus_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (inpatient_bonus_enabled IN (0, 1));
ALTER TABLE referral_sources ADD COLUMN inpatient_pct REAL NOT NULL DEFAULT 0
  CHECK (inpatient_pct >= 0 AND inpatient_pct <= 100);
ALTER TABLE referral_sources ADD COLUMN inpatient_fixed REAL NOT NULL DEFAULT 0
  CHECK (inpatient_fixed >= 0);

-- 3. Сотрудник: стационарные ставки ОТДЕЛЬНО от «Услуг и ставок».
--    inpatient_rates — JSON-массив [{service_id, pct} | {service_id, fix}]
--    (как service_rates: '' — ставок нет). Бонус за направление в стационар —
--    два числа, 0 — не платится.
ALTER TABLE users ADD COLUMN inpatient_rates TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN inpatient_referral_pct REAL NOT NULL DEFAULT 0
  CHECK (inpatient_referral_pct >= 0 AND inpatient_referral_pct <= 100);
ALTER TABLE users ADD COLUMN inpatient_referral_fixed REAL NOT NULL DEFAULT 0
  CHECK (inpatient_referral_fixed >= 0);

-- 4. ПЕРЕНОС «Стационар, %» из service_rates (INPATIENT_SHARE_V1).
--
-- Было: ключ inpatient_pct внутри записи service_rates. Чтобы задать его,
-- услугу приходилось отмечать в «Услугах и ставках», и отметка писала
-- амбулаторную запись {pct: 0} — а записанный 0 перекрывает ставку по
-- умолчанию (service_rate_default): врач с 30 % по умолчанию за эту услугу
-- амбулаторно получал 0. Это и есть сцепка, которую переносом снимаем.
--
-- Перенос: каждая запись, где inpatient_pct — ЧИСЛО, даёт в inpatient_rates
-- {service_id, pct: inpatient_pct}; при двух записях на одну услугу берётся
-- бо́льшая (так её и читал отчёт — MAX в INPATIENT_RATE_SQL). Ключ
-- inpatient_pct из service_rates убирается у всех записей.
--
-- ЗАПИСЬ, ЖИВШАЯ ТОЛЬКО РАДИ СТАЦИОНАРА, удаляется из service_rates целиком.
-- Узнаётся так: стоит inpatient_pct, амбулаторный процент 0 (или его нет), нет
-- фикса (fix) и нет своей цены (price). Отличить её от сознательной записи
-- «оказывает, амбулаторно 0 %» по данным нельзя — поэтому каждая удалённая
-- запись целиком пишется в inpatient_rate_migration_log, и её можно вернуть.
-- Прочие записи (с процентом > 0, фиксом или своей ценой) остаются, только без
-- ключа inpatient_pct.
--
-- Повторный прогон ничего не делает: переносятся только строки, где ключ
-- inpatient_pct ещё есть, а после переноса его нет нигде.

CREATE TABLE IF NOT EXISTS inpatient_rate_migration_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  service_id    INTEGER,
  inpatient_pct REAL,
  entry         TEXT NOT NULL,          -- удалённая запись service_rates как была
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

DROP TABLE IF EXISTS temp.m155_entries;
CREATE TEMP TABLE m155_entries AS
SELECT u.id                                                   AS user_id,
       CAST(j.key AS INTEGER)                                 AS pos,
       j.value                                                AS value,
       CAST(json_extract(j.value, '$.service_id') AS INTEGER) AS service_id,
       CASE WHEN json_type(j.value, '$.inpatient_pct') IN ('integer', 'real')
            THEN CAST(json_extract(j.value, '$.inpatient_pct') AS REAL) END AS inpatient_pct,
       CASE WHEN json_type(j.value, '$.inpatient_pct') IN ('integer', 'real')
             AND COALESCE(CAST(json_extract(j.value, '$.pct') AS REAL), 0) = 0
             AND json_type(j.value, '$.fix') IS NULL
             AND json_type(j.value, '$.price') IS NULL
            THEN 1 ELSE 0 END                                 AS inpatient_only
  FROM users u, json_each(CASE WHEN json_valid(u.service_rates) THEN u.service_rates ELSE '[]' END) j
 WHERE u.service_rates IS NOT NULL AND u.service_rates <> ''
   AND json_valid(u.service_rates)
   AND json_type(u.service_rates) = 'array'
   AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(u.service_rates) THEN u.service_rates ELSE '[]' END) k
                WHERE json_type(k.value, '$.inpatient_pct') IS NOT NULL);

-- 4a. Стационарные ставки — в свою колонку (к тем, что там уже есть, если
--     колонку кто-то успел заполнить: своя запись колонки выигрывает).
UPDATE users
   SET inpatient_rates = (
     SELECT json_group_array(json(x.obj) ORDER BY x.service_id)
       FROM (
         SELECT e.service_id AS service_id,
                json_object('service_id', e.service_id, 'pct', MAX(e.inpatient_pct)) AS obj
           FROM m155_entries e
          WHERE e.user_id = users.id AND e.inpatient_pct IS NOT NULL AND e.service_id > 0
            AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(users.inpatient_rates) THEN users.inpatient_rates ELSE '[]' END) o
                             WHERE CAST(json_extract(o.value, '$.service_id') AS INTEGER) = e.service_id)
          GROUP BY e.service_id
         UNION ALL
         SELECT CAST(json_extract(o.value, '$.service_id') AS INTEGER), o.value
           FROM json_each(CASE WHEN json_valid(users.inpatient_rates) THEN users.inpatient_rates ELSE '[]' END) o
       ) x)
 WHERE id IN (SELECT user_id FROM m155_entries WHERE inpatient_pct IS NOT NULL);

-- 4b. Журнал удаляемых записей.
INSERT INTO inpatient_rate_migration_log (user_id, service_id, inpatient_pct, entry)
SELECT user_id, service_id, inpatient_pct, value
  FROM m155_entries
 WHERE inpatient_only = 1
 ORDER BY user_id, pos;

-- 4c. service_rates без ключа inpatient_pct и без записей «только ради стационара».
UPDATE users
   SET service_rates = COALESCE((
     SELECT json_group_array(json(json_remove(e.value, '$.inpatient_pct')) ORDER BY e.pos)
       FROM m155_entries e
      WHERE e.user_id = users.id AND e.inpatient_only = 0), '[]')
 WHERE id IN (SELECT user_id FROM m155_entries);

DROP TABLE IF EXISTS temp.m155_entries;
