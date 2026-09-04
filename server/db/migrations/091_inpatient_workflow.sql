-- 091_inpatient_workflow.sql — INPATIENT_FLOW_V1: у госпитализации появляется
-- МАРШРУТ, а не одно состояние «лежит».
--
-- Что было. `admissions.status` знал четыре слова: 'requested' (заявка врача из
-- кабинета), 'active', 'discharged', 'cancelled'. Между заявкой и «лежит» не
-- было НИЧЕГО: пациент, которого медсестра положила на койку, и пациент,
-- которого главный врач уже осмотрел и передал лечащему, — для базы один и тот
-- же 'active'. Поэтому сервер не мог отказать в назначении до осмотра: ему
-- нечем было отличить одного от другого, и весь порядок держался на том, что
-- люди помнят порядок.
--
-- Что становится. Шесть состояний по решению владельца (2026-09-04):
--
--   ordered → admitted → examined → active → discharging → discharged
--   и из любого ДО active — cancelled
--
--   ordered      заявка оформлена (регистратура), койки нет
--   admitted     пациент на койке (медсестра) — койка занята, суточное идёт
--   examined     первичный осмотр проведён (главный врач)
--   active       лечащий врач назначен — открыты назначения, услуги, стол
--   discharging  заявка на выписку подана (лечащий врач)
--   discharged   выписан — койка уходит в 'cleaning'
--
-- 'requested' → 'ordered'. ЭТО ПЕРЕИМЕНОВАНИЕ, А НЕ ПОТЕРЯ. Задание к этой
-- миграции перечисляло три старых статуса; в живой базе их ЧЕТЫРЕ — 'requested'
-- добавила миграция 032, и `request_admission` пишет его каждый раз, когда врач
-- отправляет пациента в стационар из кабинета. Оставить это слово было нельзя
-- (новый CHECK его не знает, и INSERT такой строки упал бы прямо здесь, на
-- обновлении работающей клиники), а выбрасывать — тем более: за ним стоят
-- реальные направления. Смысл совпадает дословно: «заявка оформлена, койка не
-- занята» — это и есть 'ordered'. Код, который знал слово 'requested'
-- (inpatient.js, lifecycle.js, ward-beds.js), переведён на 'ordered' той же
-- правкой.
--
-- ПОЧЕМУ ПЕРЕСБОРКА БЕЗОПАСНА ДЛЯ СИНХРОНИЗАЦИИ ФИЛИАЛОВ. Предупреждение из
-- шапки 084/087 гласит: массовый UPDATE или пересборка таблицы — СЕТЕВОЕ
-- СОБЫТИЕ, каждая тронутая строка уедет соседям. Здесь этого не происходит,
-- и это проверено, а не предположено: `admissions` НЕТ в journal.js SHIPPED
-- (там только patients, visits, visit_services, lab_results, invoices,
-- invoice_items, payments), значит на ней нет ни uid, ни sync_origin, ни
-- триггеров *_journal_ins/upd/del — sqlite_master по admissions не отдаёт ни
-- одного триггера. Пересборка не пишет в sync_journal ни строки. Деньги
-- (invoices) в SHIPPED входят и здесь НЕ ТРОГАЮТСЯ вовсе: invoices.admission_id
-- остаётся тем же числом, потому что id госпитализаций сохраняются.
--
-- ИДИОМА ПЕРЕСБОРКИ — та же, что в 023 и 077, и три её места несущие:
--   (1) PRAGMA defer_foreign_keys=ON. foreign_keys включён (connection.js), а
--       DROP TABLE при нём делает неявный DELETE всех строк; на admissions
--       смотрят admission_services, admission_transfers, admission_prescriptions,
--       med_administrations (025) и invoices.admission_id (040). Отложенная
--       проверка жалуется только на КОММИТЕ — к нему строки уже вернулись под
--       теми же id, и каждая ссылка разрешается. Ни одна дочерняя строка не
--       удаляется: ни одна из этих ссылок не объявлена ON DELETE CASCADE
--       (проверено в 025 и 040) — в отличие от 077, где каскад пришлось
--       обходить копией.
--   (2) БЕЗ RENAME. ALTER TABLE ... RENAME переписывает REFERENCES в чужих
--       таблицах, и дочерние начали бы ссылаться на временное имя. Имя не
--       меняется вовсе: копия → DROP → CREATE под тем же именем → вернуть.
--   (3) sqlite_sequence. DROP уносит строку счётчика AUTOINCREMENT, и он
--       откатился бы к MAX(id): госпитализация, удалённая до миграции, отдала
--       бы свой id следующей новой, а AUTOINCREMENT существует ровно затем,
--       чтобы id не переиспользовался. Счётчик сохраняется и возвращается.
--
-- ЧТО ВИДИТ РАБОТАЮЩАЯ КЛИНИКА ПОСЛЕ ОБНОВЛЕНИЯ — ничего. id, номер, пациент,
-- койка, палата, врач, даты, скидка, сумма, счёт — переносятся как есть.
-- 'active' остаётся 'active', 'discharged' — 'discharged', 'cancelled' —
-- 'cancelled'; лежащий пациент продолжает лежать, суточное начисление считает
-- от того же admitted_at, выписка работает тем же RPC.
--
-- ЗАПОЛНЕНИЕ НОВЫХ КОЛОНОК У СТАРЫХ СТРОК:
--   attending_doctor_id := doctor_id   старое поле и было лечащим врачом;
--   ordered_at          := admitted_at заявки как события не существовало —
--                          ближайшая правда о том, «когда это началось»;
--   ordered_by          := created_by  кто завёл строку, тот её и оформил;
--   admitted_by         := created_by, НО ТОЛЬКО ЕСЛИ ПАЦИЕНТ ДЕЙСТВИТЕЛЬНО
--                          ПОСТУПАЛ. У строки, оставшейся заявкой ('requested'
--                          → 'ordered'), койки не было и класть на неё никто не
--                          ходил: поставить туда имя значило бы записать в базу
--                          событие, которого не было. Там NULL;
--   examined_at/by      := NULL у всех. Первичного осмотра как ЭТАПА до сих пор
--                          не существовало, и выдумывать его задним числом
--                          нельзя. Следствие названо вслух: у старых 'active'
--                          осмотр пуст, хотя состояние 'active' по новому
--                          маршруту означает «осмотрен и передан лечащему».
--                          Это правильный компромисс: альтернатива — сбросить
--                          лежащих пациентов в 'admitted' и потребовать от
--                          главного врача осмотреть заново всё отделение в день
--                          обновления.
--   admission_type/stay_mode — DEFAULT 'planned'/'round': плановая
--                          круглосуточная госпитализация, то есть ровно то,
--                          чем была КАЖДАЯ существующая запись.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE _admissions_bak AS SELECT * FROM admissions;
CREATE TABLE _admissions_seq_bak AS SELECT seq FROM sqlite_sequence WHERE name = 'admissions';

DROP TABLE admissions;

CREATE TABLE admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_no TEXT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  bed_id INTEGER REFERENCES beds(id),
  ward_id INTEGER REFERENCES wards(id),
  -- doctor_id остаётся: на него смотрят старые экраны и отчёты. Новый маршрут
  -- пишет attending_doctor_id, а RPC держат их согласованными.
  doctor_id INTEGER REFERENCES users(id),
  pathway TEXT NOT NULL DEFAULT 'therapy' CHECK (pathway IN ('therapy','surgical')),
  chief_complaint TEXT NOT NULL DEFAULT '',
  admission_diagnosis TEXT NOT NULL DEFAULT '',
  admitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  discharged_at TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN
    ('ordered','admitted','examined','active','discharging','discharged','cancelled')),
  accommodation_discount_percent REAL NOT NULL DEFAULT 0,
  charge_amount REAL,
  invoice_id INTEGER REFERENCES invoices(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- ---- маршрут: когда и кем сделан каждый шаг --------------------------------
  ordered_at   TEXT,
  ordered_by   INTEGER REFERENCES users(id),
  admitted_by  INTEGER REFERENCES users(id),
  examined_at  TEXT,
  examined_by  INTEGER REFERENCES users(id),
  -- Лечащий врач. Отдельно от doctor_id (кто НАПРАВИЛ) намеренно: направивший и
  -- лечащий — разные люди, и назначения подписывает второй.
  attending_doctor_id INTEGER REFERENCES users(id),

  admission_type TEXT NOT NULL DEFAULT 'planned' CHECK (admission_type IN ('planned','emergency')),
  stay_mode TEXT NOT NULL DEFAULT 'round' CHECK (stay_mode IN ('round','day')),
  planned_discharge_at TEXT,
  -- NOT NULL DEFAULT '' по образцу chief_complaint выше: «причины нет» и
  -- «причину не записали» в этой таблице не различают, а NULL заставлял бы
  -- каждый экран помнить про COALESCE.
  cancel_reason TEXT NOT NULL DEFAULT ''
);

INSERT INTO admissions (
  id, admission_no, patient_id, bed_id, ward_id, doctor_id, pathway,
  chief_complaint, admission_diagnosis, admitted_at, discharged_at, status,
  accommodation_discount_percent, charge_amount, invoice_id, created_by, created_at,
  ordered_at, ordered_by, admitted_by, examined_at, examined_by, attending_doctor_id,
  admission_type, stay_mode, planned_discharge_at, cancel_reason
)
SELECT
  id, admission_no, patient_id, bed_id, ward_id, doctor_id, pathway,
  chief_complaint, admission_diagnosis, admitted_at, discharged_at,
  CASE status WHEN 'requested' THEN 'ordered' ELSE status END,
  accommodation_discount_percent, charge_amount, invoice_id, created_by, created_at,
  admitted_at,                                              -- ordered_at
  created_by,                                               -- ordered_by
  CASE WHEN status = 'requested' THEN NULL ELSE created_by END,   -- admitted_by
  NULL, NULL,                                               -- examined_at, examined_by
  doctor_id,                                                -- attending_doctor_id
  'planned', 'round', NULL, ''
FROM _admissions_bak;

-- Счётчик AUTOINCREMENT на место (см. (3) в шапке). INSERT выше уже поднял его
-- до MAX(id); здесь возвращается сохранённое значение, которое может быть выше.
UPDATE sqlite_sequence
   SET seq = (SELECT seq FROM _admissions_seq_bak)
 WHERE name = 'admissions' AND EXISTS (SELECT 1 FROM _admissions_seq_bak);
INSERT INTO sqlite_sequence (name, seq)
SELECT 'admissions', (SELECT seq FROM _admissions_seq_bak)
 WHERE EXISTS (SELECT 1 FROM _admissions_seq_bak)
   AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'admissions');

DROP TABLE _admissions_bak;
DROP TABLE _admissions_seq_bak;

-- Те же два индекса, что были (015, пересозданы 032) — DROP TABLE уносит их
-- вместе с таблицей.
CREATE INDEX idx_admissions_status ON admissions(status);
CREATE INDEX idx_admissions_bed ON admissions(bed_id, status);
-- И новый: окно медсестры и очередь главного врача спрашивают «кто в этом
-- отделении в этом состоянии» — «Ждут размещения», «Ждут первичного осмотра»,
-- «В отделении». Без него это полный перебор таблицы на каждом открытии экрана,
-- а таблица растёт на каждую госпитализацию и никогда не чистится.
CREATE INDEX idx_admissions_status_ward ON admissions(status, ward_id);

-- ---------------------------------------------------------------------------
-- Роли: главный врач и старшая медсестра
-- ---------------------------------------------------------------------------
-- Обе — НАДСТРОЕЧНЫЕ: их носят через users.extra_roles (миграция 020), а не
-- вместо основной роли. Причина в решении владельца: «главный врач» — это роль,
-- которую держат НЕСКОЛЬКО врачей, и врач при этом остаётся врачом — ведёт
-- своих пациентов, свою очередь, свой кабинет. Сделай мы её основной, главный
-- врач потерял бы весь доступ врача разом: реестр таблиц (schema-registry.js)
-- раздаёт права по основной роли, и роли 'head_doctor' в его списках нет.
-- Сервер авторизует по ОБЪЕДИНЕНИЮ (roles.js effectiveRoles: основная +
-- extra_roles), поэтому доктор с надстройкой имеет и то, и другое.
--
-- Строка здесь нужна, чтобы роль вообще что-то видела: роль без записи в
-- role_permissions не получает ни одного раздела (тот же довод, что в 059).
-- Разделы взяты у базовой профессии — врача и медсестры соответственно:
-- надстройка добавляет ПРАВА В СТАЦИОНАРЕ (их проверяет inpatient-flow.js), а
-- не новые разделы меню.
--
-- INSERT OR IGNORE — против UNIQUE(role) при повторном прогоне и на случай
-- клиники, где эти роли уже завели вручную.
INSERT OR IGNORE INTO role_permissions (role, permissions) VALUES
 ('head_doctor',  '{"sections":["patients","labs","dashboard","patient-documents"],"levels":{"patients":"admin","labs":"editor","dashboard":"viewer","patient-documents":"editor"}}'),
 ('senior_nurse', '{"sections":["patients","labs","dashboard"],"levels":{"patients":"editor","labs":"viewer","dashboard":"viewer"}}');
